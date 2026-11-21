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
 * 这条门禁回答两个问题：**webroot 里有没有不该在的东西**（文件系统，R1–R3），以及
 * **公网清单里还有没有 internal 条目**（R4，#620 加的常驻断言）。结构性的字段校验
 * （versionCode 降序 / sha256 形态 / buildType 枚举……）仍然只由
 * `scripts/validate-releases-manifest.mjs` 管，这里不重复造一套规则。
 *
 * 为什么 R4 必须落在这条门禁里（而不是只留在校验器里）：校验器只在**仓库里的 fixture**
 * 上跑，没人拿它扫线上那份 `releases.json`。#601 的病根是「清单里可以出现 internal 条目」，
 * 而线上唯一能把这份清单与它的目录一起看到的地方，就是这条门禁（`DL_WEBROOT=/var/www/dl`）。
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
 * | R2 | 非 `apk/` 的顶层目录（`private/` 尤其） | webroot 的合法形状只有「顶层文件 + `apk/`」；`private/` 必须在 webroot **之外**（`/opt/dl-private`） |
 * | R2 | webroot 里任何**符号链接**（顶层 / `apk/` / 目录内） | `Dirent.isDirectory()` 对 symlink 返回 **false**：只判「目录名字」时，`private -> /opt/dl-private` 或 `apk -> /opt/dl-private/apk` 会整棵躲过检查，而 Caddy `file_server` 默认顺着 symlink 发文件 —— 等价于把私有根直接挂到公网（#623 复核出的真缺口，正是 #621「私链裸奔」的形状） |
 * | R3 | `apk/` **或 `private/` 子树**里文件名含 `internal` 或 `dev` | 内部包**绝不**出现在公网静态目录（#609 的核心）。#623 起从「只扫 `apk/` 一层」扩到「`apk/` + 每个非 `apk/` 顶层目录向下 3 层」——`/var/www/dl/private/<16hex>/…-internal-….apk` 这种 #621 现场的形态要能**被点名**，而不是只报一句「多了个目录」 |
 * | R4 | `releases.json` 里 `artifactVariant !== "standard"` 的条目（含 internal） | 公网清单里的 `file` 字段等于把内部包直链广播出去（#601 事故形态）；`internal` 条目数**必须为 0**（#620） |
 * | R4 | `releases.json` 不存在 / 读不出 / 不是合法清单 | 证明不了「internal 条目 = 0」时不许判绿（fail-closed） |
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

// 「公网清单允许哪种变体」只有一份定义（#609 裁决 → #620 接口层）：
//   校验器 MODE_VARIANT（离线口径）/ 发布脚本 TARGET_VARIANT（写之前）/ 本门禁 R4（写完之后的巡检）。
// 三处必须同值，由 tests/unit/release-api-variant-gate.test.mjs 钉住。
import { MODE_VARIANT } from './validate-releases-manifest.mjs';
import { findMismatchedVariants } from '../deploy/dl-release/release-target.mjs';

/** 默认 webroot（分发机上的站点根；Caddy 本地直服） */
export const DEFAULT_WEBROOT = '/var/www/dl';
/** webroot 里唯一允许存在的子目录 */
export const ALLOWED_TOP_DIRS = Object.freeze(['apk']);
/** `releases.json.<suffix>` 的白名单（空 = 除正本外一律红） */
export const RELEASES_JSON_SUFFIX_ALLOWLIST = Object.freeze([]);
/** 内部包在文件名里的标记（`apk/` 下出现即红） */
export const INTERNAL_NAME_MARKERS = Object.freeze(['internal', 'dev']);

/**
 * 非 `apk/` 顶层目录（`private/` 是唯一现实存在过的那个）向下扫几层（#623）。
 *
 * 3 层够覆盖线上与历史三种形状：`private/<file>.apk`、`private/<16hex>/<file>.apk`
 * （#601 取证归档的摆法）、`private/<ver>/<abi>/<file>.apk`。再深就不是人摆得出来的了，
 * 而**目录本身**已经由 R2 判红 —— 这里深扫只为「点名到文件」，不是判红的唯一依据。
 */
export const DIR_DEEP_SCAN_DEPTH = 3;
/** 深扫的条目上限（防止有人把 webroot 指向一个巨大目录时门禁卡死） */
export const DIR_DEEP_SCAN_MAX_ENTRIES = 5000;

/** 规则代码 → 人话（报告与 ci.yml 的 grep 都用这套标签，别随便改） */
export const RULES = Object.freeze({
  R1: 'R1 事故/备份残留（*.bak* / *LEAKED* / _withdrawn* / releases.json.* / *.tmp-*）',
  R2: 'R2 webroot 内出现非 apk/ 的目录或任何符号链接（private/ 必须在 webroot 之外）',
  R3: 'R3 apk/ 或 private/ 子树里出现 internal|dev 字样的文件',
  R4: 'R4 公网 releases.json 里出现非 standard 条目（internal 条目数必须为 0）/ 清单读不出来',
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
 * R4：读 webroot 里的公网清单，数出「不属于公网口径」的条目（`artifactVariant !== "standard"`）。
 *
 * 判据复用 `deploy/dl-release/release-target.mjs` 的 `findMismatchedVariants` —— 与
 * `server.mjs` 写盘前的整份清单校验、`validat-release-manifest.mjs` 的 public 口径是**同一份**
 * 实现（#620 要求「与 #619 已有的 public/private 双口径接上」，不是再抄一条 if）。
 *
 * @param {string} manifestFile
 * @returns {{violations:Array<{rule:string, at:string, why:string}>, records:number|null}}
 */
export function scanManifest(manifestFile) {
  const violations = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (e) {
    violations.push({
      rule: 'R4',
      at: path.basename(manifestFile),
      why:
        e.code === 'ENOENT'
          ? 'webroot 里没有 releases.json —— 证明不了「internal 条目数 = 0」，不许判绿（#620）'
          : `releases.json 读不出来/不是合法 JSON（${e.message}）—— 判不了就必须红，不许当作"没有 internal 条目"`,
    });
    return { violations, records: null };
  }
  const list = Array.isArray(data && data.releases) ? data.releases : null;
  if (!list) {
    violations.push({
      rule: 'R4',
      at: path.basename(manifestFile),
      why: 'releases.json 没有 releases 数组 —— 无法枚举条目，也就无法证明 internal 条目数 = 0',
    });
    return { violations, records: null };
  }
  for (const bad of findMismatchedVariants(data, 'public')) {
    violations.push({
      rule: 'R4',
      at: `releases.json:releases[${bad.index}](${bad.version})`,
      why:
        `公网清单只允许 artifactVariant="${MODE_VARIANT.public}"，这条是 ${JSON.stringify(bad.variant)}`
        + ' —— `file` 字段等于把内部包直链广播出去（#601 事故形态 / #620）',
    });
  }
  return { violations, records: list.length };
}

/**
 * 符号链接判定（#623）。为什么要单独一条：
 *
 * `fs.readdirSync(withFileTypes)` 给的 `Dirent.isDirectory()` 在 symlink 上是 **false**，
 * 所以只按「名字是不是允许的目录」去判时，`private -> /opt/dl-private` 既不是目录、名字也不命中
 * R1 的任何后缀 —— 它会**静默通过**。而 Caddy 的 `file_server` 默认跟随 symlink，等于把整个私有根
 * 挂到公网（`https://dl.rose7.cn/private/apk/…internal….apk` 直接 200）。这就是 #621 的形态。
 *
 * @param {fs.Dirent} entry
 * @param {string} absPath 该条目的绝对路径（读链接目标用）
 * @param {string} rel 报告里用的相对路径
 * @returns {string|null}
 */
export function symlinkViolation(entry, absPath, rel) {
  if (!entry.isSymbolicLink()) return null;
  let target = '?';
  try {
    target = fs.readlinkSync(absPath);
  } catch {
    // 读不出目标也不放行：链接本身就违规
  }
  return `${rel}：webroot 里出现符号链接（→ ${target}）—— file_server 会顺着它把 webroot 外的目录直出，`
    + '私有根/内部包挂链接等于没移出 webroot（#623）';
}

/**
 * 深扫一个**非 apk/** 的顶层目录（只有 `private/` 真出现过，但判据不写死名字）。
 *
 * 目录本身已由 R2 判红；这里往下走最多 `DIR_DEEP_SCAN_DEPTH` 层，为了把 #621 现场的
 * `private/<16hex>/<…>-internal-….apk` **逐条点名**（R3），顺带把私有清单备份
 * `releases.internal.json.bak-private-<epoch>` 按 R1 点出来。不是判红的替代品，是证据。
 *
 * @param {string} absDir 绝对目录
 * @param {string} relDir 报告用的相对前缀（`private`、`private/<16hex>`）
 * @param {Array<{rule:string, at:string, why:string}>} out
 * @param {{count:number, truncated:boolean}} stats
 */
function scanDirDeep(absDir, relDir, out, stats) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (stats.count >= DIR_DEEP_SCAN_MAX_ENTRIES) {
      stats.truncated = true;
      return;
    }
    stats.count++;
    const rel = `${relDir}/${entry.name}`;
    const whyLink = symlinkViolation(entry, path.join(absDir, entry.name), rel);
    if (whyLink) {
      out.push({ rule: 'R2', at: rel, why: whyLink });
      continue;
    }
    if (entry.isDirectory()) {
      const depth = rel.split('/').length - 1; // `private` 的第二层起算 2
      if (depth < DIR_DEEP_SCAN_DEPTH) scanDirDeep(path.join(absDir, entry.name), rel, out, stats);
      else out.push({ rule: 'R2', at: rel, why: '目录层数超过深扫上限（嵌套成这样已经是「在 webroot 里搭了个站点」）' });
      continue;
    }
    // R3 只对 `.apk` 判：`private/` 里还有私有清单本身（`releases.internal.json`），
    // 它名字里带 "internal" 但不是包 —— 把它报成「内部包」会让报告失去可信度。
    // 清单副本/备份由 R1 判（`*.bak*` / `releases.json.*`），判据各管各的。
    if (/\.apk$/i.test(entry.name)) {
      const whyInternal = internalNameViolation(entry.name);
      if (whyInternal) out.push({ rule: 'R3', at: rel, why: whyInternal });
    }
    const whyDirt = fileViolation(entry.name);
    if (whyDirt) out.push({ rule: 'R1', at: rel, why: whyDirt });
  }
}

/**
 * 扫一个 webroot。形状本来只有两层（顶层 + `apk/`），所以：
 *
 * - 顶层：任何非 `apk/` 的目录 → R2；**任何符号链接** → R2（#623，symlink 的 `isDirectory()` 是 false）；
 *   顶层与 `apk/` 里的文件按 R1 判名字。
 * - `apk/`：扁平文件，内部包名字 → R3；子目录/符号链接 → R2。
 * - 非 `apk/` 的顶层目录（现实中只有 `private/`）：目录本身 R2，另**向下深扫 3 层**把里面的
 *   internal APK（R3）与清单备份（R1）逐条点名（#623 —— #621 那种「私链裸奔」必须能拦到文件）。
 * - 顶层清单做一次 R4 体检（#620）。
 *
 * @param {string} root
 * @returns {{violations:Array<{rule:string, at:string, why:string}>, scanned:{top:number, apk:number, deep:number, manifestRecords:number|null}}}
 */
export function scanWebroot(root) {
  const violations = [];
  const scanned = { top: 0, apk: 0, deep: 0, manifestRecords: null };
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    scanned.top++;
    const rel = entry.name;
    // ① 符号链接先判：symlink 的 isDirectory() 是 false，落到下面任何分支都会被放行（#623）
    const whyLink = symlinkViolation(entry, path.join(root, entry.name), rel);
    if (whyLink) {
      violations.push({ rule: 'R2', at: rel, why: whyLink });
      continue;
    }
    if (entry.isDirectory()) {
      if (!ALLOWED_TOP_DIRS.includes(entry.name)) {
        violations.push({
          rule: 'R2',
          at: rel,
          why:
            entry.name === 'private'
              ? 'webroot 里出现 private/ —— 私有清单与内部包必须在 webroot 之外（/opt/dl-private，#609/#623）'
              : `webroot 里出现非 apk/ 的目录（只允许 ${ALLOWED_TOP_DIRS.join('、')}）`,
        });
        // ② #623：扩到 private/ 子树 —— 把里面的 internal 包逐条点名（R3），不是只说「多了个目录」
        const stats = { count: 0, truncated: false };
        scanDirDeep(path.join(root, entry.name), rel, violations, stats);
        scanned.deep += stats.count;
        if (stats.truncated) {
          violations.push({
            rule: 'R2',
            at: rel,
            why: `深扫条目数达到上限 ${DIR_DEEP_SCAN_MAX_ENTRIES}（已截断）—— 这个目录不该出现在 webroot 里，整棵搬走`,
          });
        }
      }
      continue;
    }
    const why = fileViolation(entry.name);
    if (why) violations.push({ rule: 'R1', at: rel, why });
  }

  // R4（#620）：公网清单里的 internal 条目必须为 0
  const manifest = scanManifest(path.join(root, 'releases.json'));
  violations.push(...manifest.violations);

  const apkDir = path.join(root, 'apk');
  // lstat（不跟随 symlink）：`apk -> /opt/dl-private/apk` 这种链接在顶层已经报了 R2，
  // 这里不能再顺着它把私有包当公网包扫一遍（也避免把私有根的内容混进 scanned 计数）
  if (fs.existsSync(apkDir) && fs.lstatSync(apkDir).isDirectory()) {
    for (const entry of fs.readdirSync(apkDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      scanned.apk++;
      const rel = `apk/${entry.name}`;
      const whyLink = symlinkViolation(entry, path.join(apkDir, entry.name), rel);
      if (whyLink) {
        violations.push({ rule: 'R2', at: rel, why: whyLink });
        continue;
      }
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

  return { violations, scanned: { ...scanned, manifestRecords: manifest.records } };
}

/** 打印一份扫描结果 */
function report(root, { violations, scanned }) {
  console.log(`webroot  ${root}`);
  console.log(
    `扫了     顶层 ${scanned.top} 项 / apk/ ${scanned.apk} 项`
      + ` / 非 apk 目录深处 ${scanned.deep} 项`
      + ` / releases.json ${scanned.manifestRecords === null ? '读不出' : `${scanned.manifestRecords} 条`}`,
  );
  if (!violations.length) {
    console.log('干净     没有 R1/R2/R3/R4 命中（清单里 internal 条目数 = 0）');
    return;
  }
  console.log(`命中     ${violations.length} 处（每条都会让门禁 exit 1）`);
  for (const v of violations) console.log(`  ✗ [${RULES[v.rule]}] ${v.at}\n      ${v.why}`);
}

// ---------------------------------------------------------------------------
// 演练（本地临时目录；不碰任何生产机）
// ---------------------------------------------------------------------------

/** 干净公网清单的正本（R4 的正例：条目全是 standard） */
export function cleanManifest() {
  return {
    latest: '1.4.1',
    releases: [
      {
        version: '1.4.1',
        versionCode: 19,
        releasedAt: '2026-11-20T10:00:00+08:00',
        file: 'apk/deepseek-chat-1.4.1.apk',
        size: 4096,
        md5: '0'.repeat(32),
        sha256: 'a'.repeat(64),
        changes: ['标准包'],
        buildType: 'stable',
        breaking: false,
        artifactVariant: 'standard',
        artifactVariantSource: 'apk-manifest',
      },
    ],
  };
}

/** 造一个干净 webroot：顶层 releases.json（只有 standard 条目）+ apk/ 两个正常包 */
export function makeCleanWebroot(root) {
  fs.mkdirSync(path.join(root, 'apk'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'releases.json'),
    `${JSON.stringify(cleanManifest(), null, 2)}\n`,
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
  /** 符号链接用例指向的「webroot 外目录」（每条的 undo 里一起清掉，避免留下临时垃圾） */
  const symlinkTargets = [];

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
      // #623：门禁扩到 private/ 子树 —— 只报「多了个目录」不够，必须**点名那个 internal 包**
      id: 'private-internal-apk',
      rule: 'R3',
      what: 'private/ 下放 deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk（#621 现场的直下形态）',
      make: () => {
        fs.mkdirSync(path.join(root, 'private'), { recursive: true });
        fs.writeFileSync(path.join(root, 'private', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8');
      },
      undo: () => fs.rmSync(path.join(root, 'private'), { recursive: true, force: true }),
    },
    {
      // #621/#601 取证归档的摆法：private/<16hex>/<file>.apk —— 第二层也要扫到
      id: 'private-hex-archive',
      rule: 'R3',
      what: 'private/0f3a9c1d2b4e5f60/deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk（历史归档目录形状）',
      make: () => {
        fs.mkdirSync(path.join(root, 'private', '0f3a9c1d2b4e5f60'), { recursive: true });
        fs.writeFileSync(
          path.join(root, 'private', '0f3a9c1d2b4e5f60', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'),
          'x',
          'utf8',
        );
      },
      undo: () => fs.rmSync(path.join(root, 'private'), { recursive: true, force: true }),
    },
    {
      // 私有清单的备份也是可直下的记录（R1），扩到 private/ 之后同样要点出来
      id: 'private-manifest-backup',
      rule: 'R1',
      what: 'private/ 下放 releases.internal.json.bak-private-1795185887',
      make: () => {
        fs.mkdirSync(path.join(root, 'private'), { recursive: true });
        fs.writeFileSync(path.join(root, 'private', 'releases.internal.json.bak-private-1795185887'), '{}', 'utf8');
      },
      undo: () => fs.rmSync(path.join(root, 'private'), { recursive: true, force: true }),
    },
    {
      // #623 复核出的真缺口：symlink 的 isDirectory() 为 false，只判「目录名字」时
      // `private -> /opt/dl-private` 会静默通过，而 file_server 会顺着它把私有根直出公网。
      id: 'private-symlink',
      rule: 'R2',
      what: 'webroot 里建符号链接 private -> <webroot 外的私有根>（里面是真 internal 包）',
      make: () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-private-root-'));
        fs.mkdirSync(path.join(outside, 'apk'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'apk', 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8');
        fs.symlinkSync(outside, path.join(root, 'private'), 'dir');
        symlinkTargets.push(outside);
      },
      undo: () => {
        fs.rmSync(path.join(root, 'private'), { force: true });
        for (const t of symlinkTargets) fs.rmSync(t, { recursive: true, force: true });
        symlinkTargets.length = 0;
      },
    },
    {
      id: 'apk-symlink',
      rule: 'R2',
      what: 'apk/ 下放一个符号链接（指向 webroot 外）—— 同样是 file_server 的越界口子',
      make: () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-apk-root-'));
        fs.writeFileSync(path.join(outside, 'deepseek-chat-1.4.2-internal-HJ5NWRHQ.apk'), 'x', 'utf8');
        fs.symlinkSync(outside, path.join(root, 'apk', 'ext'), 'dir');
        symlinkTargets.push(outside);
      },
      undo: () => {
        fs.rmSync(path.join(root, 'apk', 'ext'), { force: true });
        for (const t of symlinkTargets) fs.rmSync(t, { recursive: true, force: true });
        symlinkTargets.length = 0;
      },
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
    {
      // #620：R4 —— 清单里出现 internal 条目（#601 泄漏的那一条的形状）
      id: 'internal-in-manifest',
      rule: 'R4',
      what: '把 releases.json 里的 1.4.1 改成 artifactVariant="internal"（#601 事故的那一条）',
      make: () =>
        fs.writeFileSync(
          path.join(root, 'releases.json'),
          `${JSON.stringify(
            (() => {
              const data = cleanManifest();
              data.releases[0].artifactVariant = 'internal';
              data.releases[0].artifactVariantSource = 'apk-manifest';
              return data;
            })(),
            null,
            2,
          )}\n`,
          'utf8',
        ),
      undo: () =>
        fs.writeFileSync(path.join(root, 'releases.json'), `${JSON.stringify(cleanManifest(), null, 2)}\n`, 'utf8'),
    },
    {
      // #620：R4 fail-closed —— 清单读不出来时**不许**当作「没有 internal 条目」
      id: 'manifest-unreadable',
      rule: 'R4',
      what: '把 releases.json 截断成不可解析的字节（证明不了就该红）',
      make: () => fs.writeFileSync(path.join(root, 'releases.json'), '{"latest": "1.4.1", "releases": [', 'utf8'),
      undo: () =>
        fs.writeFileSync(path.join(root, 'releases.json'), `${JSON.stringify(cleanManifest(), null, 2)}\n`, 'utf8'),
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

  // 空目录（没有 releases.json、也没有任何文件）不是 webroot，只是「恰好有同名的空目录」
  // —— 例如开发机上残留的 /var/www/dl。这时和「没有 webroot」一样走内置演练，并把事实说出来，
  // 而不是报一个谁都看不懂的 R4（「清单读不出来」）。一旦目录里有任何东西，就必须按 webroot 判。
  const emptyWebroot = fs.existsSync(root) && fs.statSync(root).isDirectory()
    && fs.readdirSync(root).length === 0;

  if (!fs.existsSync(root) || emptyWebroot) {
    // 这台机器不是分发机（CI runner / 开发机）：**不能**判绿了事 —— 那样这一步就是「什么都没检查还全绿」。
    // 改成跑内置演练：证明门禁本身咬得住（等价于 --selftest），并把「真 webroot 没扫」明说出来。
    console.log(
      emptyWebroot
        ? `SKIP(empty-webroot)  ${root} 是空目录（没有 releases.json、也没有任何文件）—— 不是 webroot，改为内置演练（--selftest）`
        : `SKIP(no-webroot)  ${root} 不存在 —— 本机不是分发机，改为内置演练（--selftest）`,
    );
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
    if (emptyWebroot) {
      console.log('（空目录不算 webroot：目录里一旦有 releases.json / apk/ 等任何东西，就按真 webroot 判 R1–R4）');
    }
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
        'R2 的目录整棵搬走（私有包/私有清单的合法位置是 webroot 之外、且只有一个私有根 /opt/dl-private/）；R3 的内部包移出 webroot；' +
        'R4 的 internal 条目从公网清单里删掉（先确认它已经在私有清单里，再删 —— 顺序反了就等于丢包）。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
