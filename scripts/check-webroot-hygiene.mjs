#!/usr/bin/env node
/**
 * check-webroot-hygiene.mjs —— 分发站点根（webroot）卫生门禁（Issue #609 / 裁决 #614 决定 3）
 *
 * ## 为什么需要它（#601 事故的第 4 类口子）
 *
 * 2026-11-20 的泄漏里，「从 `releases.json` 里删掉那条 internal 条目」**并不够**：
 * 文件还躺在 `/var/www/dl/apk/` 下，而那是 Caddy 直接 file_server 的静态目录 ——
 * 猜到 URL 就能下载。当时的处置是「清单恢复 + 文件删掉」，两件事必须一起做；
 * 之后再没人机械化地检查过「目录里有没有不该在的文件」。
 *
 * 这条门禁只回答一个问题：**webroot 里有没有不该在的东西**。它不看清单内容
 * （那是 `scripts/validate-releases-manifest.mjs` 的活），只看文件系统。
 *
 * ## 判据（命中任一即 exit 1）
 *
 * | 规则 | 命中物 | 为什么 |
 * | --- | --- | --- |
 * | R1 | `*.bak*` | 备份文件（`releases.json.bak-private-<epoch>` 之类）会被公网直出，等于把旧清单/旧记录公开 |
 * | R1 | `*LEAKED*` | #601 现场就是 `releases.json.LEAKED-1795185887`：证据文件先留在原地，但**不许**留在 webroot |
 * | R1 | `_withdrawn*` | 撤回标记：配套文件通常已经不该公开 |
 * | R1 | `releases.json.*`（白名单外） | 只允许正本 `releases.json`；任何后缀都是「有人手工改过」的痕迹 |
 * | R1 | `*.tmp-*` | 发布协议的半成品（`<name>.apk.tmp-<stamp>` / `releases*.json.tmp-<stamp>`）：说明有一次发布没跑完 |
 * | R2 | 非 `apk/` 的顶层目录 | webroot 的合法形状只有「顶层文件 + `apk/`」；`private/` 尤其必须在 webroot **之外** |
 * | R3 | `apk/` 下文件名含 `internal` 或 `dev` | 内部包**绝不**出现在公网静态目录（#609 的核心） |
 *
 * ## 演练（不许拿生产机当试验田）
 *
 * `--selftest` 在**本地临时目录**里造一个干净 webroot，然后把上面每一类脏东西逐个注入，
 * 断言「注入 → exit 1 且点到那条规则、还原 → exit 0」。CI 里没有 webroot（不是分发机），
 * 所以裸跑时会自动走这条路 —— 那一步永远不会是「什么都没检查还全绿」。
 *
 * 用法：
 *   node scripts/check-webroot-hygiene.mjs                     # 扫 $DL_WEBROOT（默认 /var/www/dl）
 *   DL_WEBROOT=/tmp/fake node scripts/check-webroot-hygiene.mjs # 演练/CI 用临时目录
 *   node scripts/check-webroot-hygiene.mjs --selftest           # 内置正反演练（本地临时目录）
 *   node scripts/check-webroot-hygiene.mjs --json report.json   # 机器可读结果
 *
 * 退出码：0 干净（或演练全过）/ 1 命中脏东西（或演练没咬住）/ 2 用法或环境错误
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 默认 webroot（分发机上的站点根；Caddy 本地直服） */
export const DEFAULT_WEBROOT = '/var/www/dl';
/** webroot 里唯一允许存在的子目录 */
export const ALLOWED_TOP_DIRS = Object.freeze(['apk']);
/** `releases.json.<suffix>` 的白名单（空 = 除正本外一律红） */
export const RELEASES_JSON_SUFFIX_ALLOWLIST = Object.freeze([]);
/** 内部包在文件名里的标记（`apk/` 下出现即红） */
export const INTERNAL_NAME_MARKERS = Object.freeze(['internal', 'dev']);

/** 规则代码 → 人话（报告与 ci.yml 的 grep 都用这套标签，别随便改） */
export const RULES = Object.freeze({
  R1: 'R1 事故/备份残留（*.bak* / *LEAKED* / _withdrawn* / releases.json.* / *.tmp-*）',
  R2: 'R2 webroot 内出现非 apk/ 的目录（private/ 必须在 webroot 之外）',
  R3: 'R3 apk/ 下出现 internal|dev 字样的文件',
});

/**
 * 单个文件名的 R1 判定（纯函数，可单测）。
 * @param {string} name 文件名（不含目录）
 * @returns {string|null} 命中则返回「为什么」，否则 null
 */
export function fileViolation(name) {
  const lower = name.toLowerCase();
  if (lower.includes('.bak')) return `${name}：备份残留（*.bak*）—— 公网会直接把它发出去`;
  if (lower.includes('leaked')) return `${name}：事故取证残留（*LEAKED*）—— 证据留在 webroot 等于继续泄漏`;
  if (lower.startsWith('_withdrawn')) return `${name}：撤回标记（_withdrawn*）—— 它配套的文件本就不该公开`;
  if (lower.includes('.tmp-')) return `${name}：发布半成品（*.tmp-*）—— 说明有一次发布没跑完`;
  // `releases.json.<suffix>`：只允许正本（白名单为空）
  if (lower.startsWith('releases.json.') || lower.startsWith('releases.internal.json.')) {
    const suffix = name.slice(name.indexOf('.json.') + '.json.'.length);
    if (!RELEASES_JSON_SUFFIX_ALLOWLIST.includes(suffix)) {
      return `${name}：清单副本（releases.json.*）—— 只允许正本 releases.json，副本一律清出 webroot`;
    }
  }
  return null;
}

/** `apk/` 下的文件名是不是内部包（internal / dev 字样） */
export function internalNameViolation(name) {
  const lower = name.toLowerCase();
  const hit = INTERNAL_NAME_MARKERS.find((m) => lower.includes(m));
  return hit ? `${name}：文件名含 "${hit}" —— 内部包绝不进公网静态目录（#609）` : null;
}

/**
 * 扫一个 webroot。**只扫两层**（顶层 + `apk/`）：webroot 的形状就这两层，
 * 更深的东西本身就是「有人在 webroot 里搭了个目录」（已由 R2 判红）。
 *
 * @param {string} root
 * @returns {{violations:Array<{rule:string, at:string, why:string}>, scanned:{top:number, apk:number}}}
 */
export function scanWebroot(root) {
  const violations = [];
  const scanned = { top: 0, apk: 0 };
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    scanned.top++;
    const rel = entry.name;
    if (entry.isDirectory()) {
      if (!ALLOWED_TOP_DIRS.includes(entry.name)) {
        violations.push({
          rule: 'R2',
          at: rel,
          why:
            entry.name === 'private'
              ? 'webroot 里出现 private/ —— 私有清单与内部包必须在 webroot 之外（#609）'
              : `webroot 里出现非 apk/ 的目录（只允许 ${ALLOWED_TOP_DIRS.join('、')}）`,
        });
      }
      continue;
    }
    const why = fileViolation(entry.name);
    if (why) violations.push({ rule: 'R1', at: rel, why });
  }

  const apkDir = path.join(root, 'apk');
  if (fs.existsSync(apkDir) && fs.statSync(apkDir).isDirectory()) {
    for (const entry of fs.readdirSync(apkDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      scanned.apk++;
      const rel = `apk/${entry.name}`;
      if (entry.isDirectory()) {
        violations.push({ rule: 'R2', at: rel, why: 'apk/ 下出现目录（apk/ 只放扁平的文件）' });
        continue;
      }
      const whyInternal = internalNameViolation(entry.name);
      if (whyInternal) violations.push({ rule: 'R3', at: rel, why: whyInternal });
      const whyDirt = fileViolation(entry.name);
      if (whyDirt) violations.push({ rule: 'R1', at: rel, why: whyDirt });
    }
  }

  return { violations, scanned };
}

/** 打印一份扫描结果 */
function report(root, { violations, scanned }) {
  console.log(`webroot  ${root}`);
  console.log(`扫了     顶层 ${scanned.top} 项 / apk/ ${scanned.apk} 项`);
  if (!violations.length) {
    console.log('干净     没有 R1/R2/R3 命中');
    return;
  }
  console.log(`命中     ${violations.length} 处（每条都会让门禁 exit 1）`);
  for (const v of violations) console.log(`  ✗ [${RULES[v.rule]}] ${v.at}\n      ${v.why}`);
}

// ---------------------------------------------------------------------------
// 演练（本地临时目录；不碰任何生产机）
// ---------------------------------------------------------------------------

/** 造一个干净 webroot：顶层 releases.json + apk/ 两个正常包 */
export function makeCleanWebroot(root) {
  fs.mkdirSync(path.join(root, 'apk'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'releases.json'),
    `${JSON.stringify({ latest: '1.4.1', releases: [] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'apk', 'deepseek-chat-1.4.1.apk'), 'apk', 'utf8');
  fs.writeFileSync(path.join(root, 'apk', 'deepseek-chat-1.4.0.apk'), 'apk', 'utf8');
  return root;
}

/**
 * 内置正反演练：每一类脏东西 = 一条「注入 → 必红且点到规则 → 还原 → 必绿」。
 * @returns {{ok:boolean, failures:string[], rows:Array<{id:string, rule:string, why:string}>}}
 */
export function selftest() {
  const failures = [];
  const rows = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webroot-hygiene-'));

  /** 每条脏东西：id / 期望规则 / 怎么造 / 怎么还原 */
  const CASES = [
    {
      id: 'bak',
      rule: 'R1',
      what: '顶层放 releases.json.bak-private-1795185887',
      make: () => fs.writeFileSync(path.join(root, 'releases.json.bak-private-1795185887'), '{}', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'releases.json.bak-private-1795185887'), { force: true }),
    },
    {
      id: 'leaked',
      rule: 'R1',
      what: '顶层放 releases.json.LEAKED-1795185887（#601 现场那个文件）',
      make: () => fs.writeFileSync(path.join(root, 'releases.json.LEAKED-1795185887'), '{}', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'releases.json.LEAKED-1795185887'), { force: true }),
    },
    {
      id: 'withdrawn',
      rule: 'R1',
      what: '顶层放 _withdrawn-1.4.2.json',
      make: () => fs.writeFileSync(path.join(root, '_withdrawn-1.4.2.json'), '{}', 'utf8'),
      undo: () => fs.rmSync(path.join(root, '_withdrawn-1.4.2.json'), { force: true }),
    },
    {
      id: 'releases-copy',
      rule: 'R1',
      what: '顶层放 releases.json.old',
      make: () => fs.writeFileSync(path.join(root, 'releases.json.old'), '{}', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'releases.json.old'), { force: true }),
    },
    {
      id: 'tmp-leftover',
      rule: 'R1',
      what: 'apk/ 下放一个发布半成品 xxx.apk.tmp-1795185887',
      make: () => fs.writeFileSync(path.join(root, 'apk', 'deepseek-chat-1.4.1.apk.tmp-1795185887'), 'x', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'apk', 'deepseek-chat-1.4.1.apk.tmp-1795185887'), { force: true }),
    },
    {
      id: 'private-dir',
      rule: 'R2',
      what: 'webroot 里建 private/ 目录（并放一份私有清单）',
      make: () => {
        fs.mkdirSync(path.join(root, 'private'), { recursive: true });
        fs.writeFileSync(path.join(root, 'private', 'releases.internal.json'), '{}', 'utf8');
      },
      undo: () => fs.rmSync(path.join(root, 'private'), { recursive: true, force: true }),
    },
    {
      id: 'internal-apk',
      rule: 'R3',
      what: 'apk/ 下放 deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk（#601 泄漏的那个包名）',
      make: () => fs.writeFileSync(path.join(root, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), { force: true }),
    },
    {
      id: 'dev-apk',
      rule: 'R3',
      what: 'apk/ 下放 deepseek-chat-1.4.2-dev.apk',
      make: () => fs.writeFileSync(path.join(root, 'apk', 'deepseek-chat-1.4.2-dev.apk'), 'x', 'utf8'),
      undo: () => fs.rmSync(path.join(root, 'apk', 'deepseek-chat-1.4.2-dev.apk'), { force: true }),
    },
  ];

  try {
    makeCleanWebroot(root);
    // ① 正例：干净 webroot 必须 exit 0（否则门禁是恒红，没人敢开）
    const clean = scanWebroot(root);
    if (clean.violations.length) {
      failures.push(`干净 webroot 被误判：${clean.violations.map((v) => `${v.rule} ${v.at}`).join('、')}`);
    }
    for (const c of CASES) {
      c.make();
      const hit = scanWebroot(root);
      c.undo();
      const matched = hit.violations.filter((v) => v.rule === c.rule);
      const after = scanWebroot(root);
      rows.push({ id: c.id, rule: c.rule, why: c.what });
      if (!matched.length) {
        failures.push(`${c.id}（${c.what}）：注入后没有命中 ${c.rule}，门禁没咬住`);
      }
      if (after.violations.length) {
        failures.push(`${c.id}：还原后仍然红（${after.violations.map((v) => v.at).join('、')}）`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { ok: failures.length === 0, failures, rows };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const wantsSelftest = argv.includes('--selftest');
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
  const rootFlag = argv.indexOf('--webroot');
  const root = path.resolve(
    (rootFlag >= 0 ? argv[rootFlag + 1] : null) || process.env.DL_WEBROOT || DEFAULT_WEBROOT,
  );

  let failed = 0;

  if (wantsSelftest) {
    const st = selftest();
    console.log(`演练     本地临时目录（${st.rows.length} 类脏东西，逐个注入 → 必红 → 还原）`);
    for (const row of st.rows) console.log(`  · ${row.id} [${RULES[row.rule]}] — ${row.why}`);
    if (!st.ok) {
      failed++;
      console.log('\n演练失败：');
      for (const f of st.failures) console.log(`  ✗ ${f}`);
    } else {
      console.log('演练通过：干净 → exit 0；每类脏东西 → 命中对应规则；还原 → exit 0');
    }
    if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ selftest: st }, null, 2)}\n`, 'utf8');
    process.exit(failed ? 1 : 0);
  }

  if (!fs.existsSync(root)) {
    // 这台机器不是分发机（CI runner / 开发机）：**不能**判绿了事 —— 那样这一步就是「什么都没检查还全绿」。
    // 改成跑内置演练：证明门禁本身咬得住（等价于 --selftest），并把「真 webroot 没扫」明说出来。
    console.log(`SKIP(no-webroot)  ${root} 不存在 —— 本机不是分发机，改为内置演练（--selftest）`);
    const st = selftest();
    for (const row of st.rows) console.log(`  · ${row.id} [${RULES[row.rule]}] — ${row.why}`);
    if (!st.ok) {
      failed++;
      console.log('\n演练失败：');
      for (const f of st.failures) console.log(`  ✗ ${f}`);
    } else {
      console.log('演练通过：干净 → exit 0；每类脏东西 → 命中对应规则；还原 → exit 0');
    }
    console.log(
      '\n注意：真实 webroot 没有被扫（本机没有）。部署后必须在分发机上跑一次：' +
        `DL_WEBROOT=/var/www/dl node scripts/check-webroot-hygiene.mjs`,
    );
    if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ skipped: true, selftest: st }, null, 2)}\n`, 'utf8');
    process.exit(failed ? 1 : 0);
  }

  if (!fs.statSync(root).isDirectory()) {
    console.error(`--webroot 不是目录：${root}`);
    process.exit(2);
  }

  const result = scanWebroot(root);
  report(root, result);
  if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ root, ...result }, null, 2)}\n`, 'utf8');
  if (result.violations.length) {
    console.log(
      '\n处置：R1 的备份/取证文件移到 webroot 之外（例如 /var/lib/dl-quarantine/）；' +
        'R2 的目录整棵搬走（私有清单的合法位置是 /var/lib/dl-private/）；R3 的内部包移出 webroot 并从公网清单里确认没有登记。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
