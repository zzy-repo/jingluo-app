#!/usr/bin/env node
/**
 * check-private-publish-root.mjs —— 「默认发布根」门禁（Issue #601 的结构根因）。
 *
 * ## 为什么要有它
 *
 * #601 事故链（2026-11-20 22:14:56，已取证）：
 *
 *   会话跑 `node scripts/publish-private-apk.mjs --version 1.4.2 --variant internal`
 *     → 老版本 `:87  DEFAULT_SITE_ROOT = '/var/www/dl'`   ← **私有发布默认写进公网 webroot**
 *     → `:662` 备份 `.bak-private-<stamp>`
 *     → `:670-674` scp + `mv -f` 原子替换**公网**清单
 *     → internal 条目进了公网 `releases.json`、APK 落到 `/var/www/dl/apk/`，被 6 个外部 IP 下载
 *
 * 结论很刺人：**任何人按默认参数跑这个脚本都能复现 #601**。那不是误操作，是**脚本默认值错**。
 * 所以修法不能只是「发布前多看两眼」，得让**默认值本身**不可能落到公网，并且用门禁把这条钉死
 * —— 否则下一个人（或下一次重构）把它改回去，谁都不会注意到。
 *
 * ## 判据（静态 + 行为，两组都跑）
 *
 * 静态（读 `scripts/publish-private-apk.mjs` 的源码文本）：
 *   R1 `DEFAULT_SITE_ROOT`（默认站点根）**必须**等于私有根 `DEFAULT_PRIVATE_ROOT`；
 *   R2 默认站点根 / 私有根的字面量**不得是 webroot 形态**（`/var/www/**`、`www-dl`、`public_html` 等）；
 *   R3 `--target` 的默认值必须是 `private`（默认走公网清单 = 同样的病）；
 *   R4 `--allow-public-webroot` 确认开关必须存在（flags 里有它）；
 *   R5 `webroot` / `siteRoot` 的**默认值**不许回落到 `DEFAULT_WEBROOT`（「显式才算数」）。
 *
 * 行为（import 那个脚本，调它导出的纯函数 —— 纯文本正则挡不住「常量改了但用法没改」）：
 *   B1 默认参数解析出的根 = `/opt/dl-private`，且 `isWebrootPath()` 判假；
 *   B2 `isWebrootPath()` 对 `/var/www/dl`、`/var/www/dl-private` 判真，对 `/opt/dl-private` 判假；
 *   B3 `gatePublishRoot()` 拒 internal × 公网根（#601 文案）、拒 `/var/www/dl-private`（防第三处）、
 *      拒公网目标缺 `--site-root`/缺 `--allow-public-webroot`；
 *   B4 `gatePublishRoot()` 放行「默认参数（私有根 + internal）」与「显式双开关的公网 standard」；
 *   B5 `targetPaths({target:'public'})` 不给根必须抛错（公网根没有默认值）；
 *       `targetPaths({target:'private'})` 的落点必须是 `/opt/dl-private/**`。
 *
 * ## 负向对照（`--selftest`，也是 CI 那一步）
 *
 * 把源码文本改回**违规形态**，逐个确认门禁会红：
 *   ① `DEFAULT_PRIVATE_ROOT` 改回 `/var/www/dl`（= 复现 #601 的默认值）；
 *   ② `--target` 默认值改成 `public`；
 *   ③ 删掉 `--allow-public-webroot`；
 *   ④ 让 webroot 默认值回落到 `DEFAULT_WEBROOT`。
 * 四条都必须被判红，且**正本源码必须判绿** —— 只证明「门禁会红」不够（恒红的门禁等于没有门禁）。
 *
 * ## 用法
 *
 *   node scripts/check-private-publish-root.mjs              # 门禁（CI 跑这条）
 *   pnpm run check:private-publish-root
 *   node scripts/check-private-publish-root.mjs --selftest   # 自带负向对照（改回 /var/www/dl 必须红）
 *   node scripts/check-private-publish-root.mjs --verbose    # 打印每条判据的通过情况
 *
 * 退出码：0 全部判据通过 / 1 有违规 / 2 用法或环境错误
 *
 * 纯静态 + 纯函数：不连 ssh、不碰 `/var/www`、不发布任何包。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 被守的那个脚本（相对仓库根） */
export const TARGET_REL = 'scripts/publish-private-apk.mjs';
const TARGET = path.join(ROOT, TARGET_REL);

/** 规则代码 → 人话（报告与 ci.yml 的 grep 用这套标签，别随便改） */
export const RULES = Object.freeze({
  R1: 'R1 默认站点根不等于私有根（默认发布可能落到别处）',
  R2: 'R2 默认站点根 / 私有根是 webroot 形态（= #601 的默认值）',
  R3: 'R3 --target 的默认值不是 private',
  R4: 'R4 缺 --allow-public-webroot 确认开关（写公网 webroot 没有二次确认）',
  R5: 'R5 webroot/siteRoot 的默认值回落到 DEFAULT_WEBROOT（公网根又变成缺省）',
});

/** 常量字面量（`export const NAME = '...'`） */
function constLiteral(text, name) {
  const m = new RegExp(`export const ${name} = '([^']*)'`).exec(text);
  return m ? m[1] : null;
}

/**
 * 静态判据：只看源码文本，不执行它。
 *
 * 拆成纯函数是为了让 `--selftest` 能拿**改坏的文本**喂进来（不必真的改磁盘上的文件）。
 *
 * @param {string} text `scripts/publish-private-apk.mjs` 的源码
 * @param {(p:string)=>boolean} isWebrootPath 与脚本同口径的 webroot 判定（从脚本 import）
 * @returns {{code:string, message:string}[]} 违规列表（空 = 通过）
 */
export function analyzeSource(text, isWebrootPath) {
  const violations = [];
  const push = (code, detail) => violations.push({ code, message: `${RULES[code]}：${detail}` });

  const privateRoot = constLiteral(text, 'DEFAULT_PRIVATE_ROOT');
  // 默认站点根：字面量，或指向另一个常量的标识符（`= DEFAULT_PRIVATE_ROOT`）
  const siteMatch = /export const DEFAULT_SITE_ROOT = ('[^']*'|[A-Za-z_$][\w$]*)/.exec(text);
  let siteRoot = null;
  let siteSiteRaw = '<未找到>';
  if (siteMatch) {
    siteSiteRaw = siteMatch[1];
    siteRoot = siteMatch[1].startsWith("'") ? siteMatch[1].slice(1, -1) : constLiteral(text, siteMatch[1]);
  }

  if (!privateRoot) {
    push('R2', '源码里找不到 `export const DEFAULT_PRIVATE_ROOT = \'...\'`（常量被改名/删除了？门禁判不了就不放行）');
  } else if (isWebrootPath(privateRoot)) {
    push('R2', `DEFAULT_PRIVATE_ROOT = ${JSON.stringify(privateRoot)} 是 webroot 形态（webroot 会被公网直出）`);
  }

  if (!siteMatch) {
    push('R1', '源码里找不到 `export const DEFAULT_SITE_ROOT = ...`（#601 的默认根必须有名字、可被门禁判）');
  } else if (siteRoot === null) {
    push('R1', `DEFAULT_SITE_ROOT = ${siteSiteRaw} 解析不出字面量（要么写字面量，要么指向另一个 export const）`);
  } else {
    if (isWebrootPath(siteRoot)) {
      push('R2', `DEFAULT_SITE_ROOT 的落点是 ${JSON.stringify(siteRoot)}（webroot 形态）= #601 事故的默认值`);
    }
    if (privateRoot && siteRoot !== privateRoot) {
      push('R1', `DEFAULT_SITE_ROOT（${JSON.stringify(siteRoot)}）≠ DEFAULT_PRIVATE_ROOT（${JSON.stringify(privateRoot)}）`);
    }
  }

  const targetDefault = /readArg\(args,\s*'target',\s*'DL_PRIVATE_TARGET'\)\s*\|\|\s*'([a-z]+)'/.exec(text);
  if (!targetDefault) {
    push('R3', '找不到 `--target` 的默认值（`readArg(args, \'target\', ...) || \'...\'`）—— 判不了就红');
  } else if (targetDefault[1] !== 'private') {
    push('R3', `--target 默认值是 ${JSON.stringify(targetDefault[1])}（默认走公网清单 = 和 #601 同一个病）`);
  }

  const flagList = /flags:\s*\[([^\]]*)\]/.exec(text);
  if (!/['"]?allow-public-webroot['"]?/.test(text)) {
    push('R4', '源码里没有 `allow-public-webroot` 确认开关');
  } else if (flagList && !/allow-public-webroot/.test(flagList[1])) {
    push('R4', '`allow-public-webroot` 出现在源码里但没进 parseArgs 的 flags 列表（传进来也不认）');
  }

  // R5：只判「默认值回落」这一种形态（`const webroot = ... || DEFAULT_WEBROOT`）
  for (const line of text.split('\n')) {
    if (/(?:const|let)\s+(?:webroot|siteRoot)[\w]*\s*=.*DEFAULT_WEBROOT/.test(line)) {
      push('R5', `webroot 的默认值回落到 DEFAULT_WEBROOT：${line.trim()}`);
    }
  }

  return violations;
}

/** 读源码 + 跑静态判据 */
export async function analyzeFile(file = TARGET) {
  const text = fs.readFileSync(file, 'utf8');
  const mod = await import(pathToFileURL(TARGET).href);
  return analyzeSource(text, mod.isWebrootPath);
}

/** 行为判据（import 真模块，调它的纯函数） */
export async function checkBehavior() {
  const problems = [];
  const mod = await import(pathToFileURL(TARGET).href);
  const { DEFAULT_PRIVATE_ROOT, DEFAULT_SITE_ROOT, gatePublishRoot, isWebrootPath, targetPaths } = mod;
  const fail = (m) => problems.push(m);

  // B1 默认根 = 私有根，且不是 webroot 形态
  if (DEFAULT_PRIVATE_ROOT !== '/opt/dl-private') {
    fail(`B1 DEFAULT_PRIVATE_ROOT 应为 /opt/dl-private，实际 ${JSON.stringify(DEFAULT_PRIVATE_ROOT)}（#637 线上唯一私有根）`);
  }
  if (DEFAULT_SITE_ROOT !== DEFAULT_PRIVATE_ROOT) {
    fail(`B1 默认站点根（${JSON.stringify(DEFAULT_SITE_ROOT)}）不是私有根（${JSON.stringify(DEFAULT_PRIVATE_ROOT)}）`);
  }
  if (isWebrootPath(DEFAULT_SITE_ROOT)) fail(`B1 默认站点根 ${JSON.stringify(DEFAULT_SITE_ROOT)} 被判成 webroot 形态`);

  // B2 webroot 形态判定
  for (const p of ['/var/www/dl', '/var/www', '/var/www/dl-private', '/srv/www-dl', '/srv/site/public_html']) {
    if (!isWebrootPath(p)) fail(`B2 ${p} 应判为 webroot 形态（兄弟目录也要算，见 #637）`);
  }
  for (const p of ['/opt/dl-private', '/opt/dl-private/apk']) {
    if (isWebrootPath(p)) fail(`B2 ${p} 不该判为 webroot 形态（否则默认发布会自己拒绝自己）`);
  }

  // B3 该拒的必须拒
  const mustReject = [
    ['B3 internal × 公网 webroot（#601 事故形态）',
      { target: 'private', variant: 'internal', buildType: 'stable', privateRoot: '/var/www/dl' }, /#601/],
    ['B3 internal × webroot 兄弟目录（/var/www/dl-private）',
      { target: 'private', variant: 'internal', buildType: 'stable', privateRoot: '/var/www/dl-private' }, /webroot 形态/],
    ['B3 第三处私有根（/srv/dl-private）',
      { target: 'private', variant: 'internal', buildType: 'stable', privateRoot: '/srv/dl-private', transport: 'ssh' }, /第三处/],
    ['B3 公网目标没给 --site-root',
      { target: 'public', variant: 'standard', buildType: 'stable' }, /没有默认根/],
    ['B3 公网目标没给 --allow-public-webroot',
      { target: 'public', variant: 'standard', buildType: 'stable', webroot: '/var/www/dl', siteRootExplicit: true }, /allow-public-webroot/],
    ['B3 公网目标给了根但不算「显式」',
      { target: 'public', variant: 'standard', buildType: 'stable', webroot: '/var/www/dl', allowPublicWebroot: true }, /显式/],
    ['B3 internal × 公网目标（双开关齐全也不行）',
      { target: 'public', variant: 'internal', buildType: 'stable', webroot: '/var/www/dl', siteRootExplicit: true, allowPublicWebroot: true }, /#601/],
  ];
  for (const [label, opts, re] of mustReject) {
    const errors = gatePublishRoot(opts);
    if (!errors.length) fail(`${label} 必须被拒，实际放行了`);
    else if (!re.test(errors.join('\n'))) fail(`${label} 拒了但没给对的理由（期望匹配 ${re}）：${errors.join(' | ')}`);
  }

  // B4 该放的必须放（正例；否则门禁等于「恒红」）
  const mustPass = [
    ['B4 默认参数（私有根 + internal）', { target: 'private', variant: 'internal', buildType: 'stable' }],
    ['B4 显式私有根 + internal', { target: 'private', variant: 'internal', buildType: 'stable', privateRoot: '/opt/dl-private' }],
    ['B4 公网 standard + 显式根 + 确认开关',
      { target: 'public', variant: 'standard', buildType: 'stable', webroot: '/var/www/dl', siteRootExplicit: true, allowPublicWebroot: true }],
    ['B4 本地演练（--transport local）用临时私有根', { target: 'private', variant: 'internal', buildType: 'stable', privateRoot: '/tmp/x/dl-private', transport: 'local' }],
  ];
  for (const [label, opts] of mustPass) {
    const errors = gatePublishRoot(opts);
    if (errors.length) fail(`${label} 不该被拒，实际拒了：${errors.join(' | ')}`);
  }

  // B5 targetPaths：公网根没有默认值；私有落点必须在私有根下
  let threw = false;
  try {
    targetPaths({ target: 'public' });
  } catch {
    threw = true;
  }
  if (!threw) fail('B5 targetPaths({target:"public"}) 不给 webroot 时没抛错 —— 公网根又变成缺省了（#601）');
  const priv = targetPaths({ target: 'private' });
  if (priv.root !== '/opt/dl-private' || priv.manifestPath !== '/opt/dl-private/releases.internal.json') {
    fail(`B5 targetPaths({target:"private"}) 的默认落点是 ${priv.manifestPath}（应为 /opt/dl-private/releases.internal.json）`);
  }
  if (priv.publiclyReadable !== false) fail('B5 私有目标的 publiclyReadable 应为 false');

  return problems;
}

/** 把源码改成违规形态（负向对照用；只改内存里的文本） */
const MUTATIONS = Object.freeze([
  ['DEFAULT_PRIVATE_ROOT 改回 /var/www/dl（复现 #601 的默认值）',
    (t) => t.replace(/export const DEFAULT_PRIVATE_ROOT = '\/opt\/dl-private'/, "export const DEFAULT_PRIVATE_ROOT = '/var/www/dl'"), 'R2'],
  ['DEFAULT_SITE_ROOT 直接指向公网 webroot',
    (t) => t.replace(/export const DEFAULT_SITE_ROOT = DEFAULT_PRIVATE_ROOT;/, "export const DEFAULT_SITE_ROOT = '/var/www/dl';"), 'R2'],
  ['--target 默认值改成 public',
    (t) => t.replace(/(readArg\(args, 'target', 'DL_PRIVATE_TARGET'\) \|\| )'private'/, "$1'public'"), 'R3'],
  ['删掉 --allow-public-webroot 确认开关',
    (t) => t.replace(/, 'allow-public-webroot'\]/, ']').replace(/ --allow-public-webroot/g, '').replace(/allow-public-webroot/g, 'ALLOW_FLAG_REMOVED'), 'R4'],
  ['webroot 默认值回落 DEFAULT_WEBROOT',
    (t) => t.replace(
      "const webroot = webrootArg;",
      'const webroot = webrootArg || DEFAULT_WEBROOT;',
    ), 'R5'],
]);

/**
 * 负向对照：改坏 → 必须红；正本 → 必须绿。
 * @returns {string[]} 问题列表（空 = 对照通过）
 */
export async function selftest() {
  const problems = [];
  const text = fs.readFileSync(TARGET, 'utf8');
  const mod = await import(pathToFileURL(TARGET).href);

  const canonical = analyzeSource(text, mod.isWebrootPath);
  if (canonical.length) {
    problems.push(`正本源码就没过静态判据（恒红的门禁等于没有门禁）：${canonical.map((v) => v.message).join(' | ')}`);
  }

  for (const [label, mutate, expectCode] of MUTATIONS) {
    const mutated = mutate(text);
    if (mutated === text) {
      problems.push(`负向对照注入失败（源码形态变了？）：${label}`);
      continue;
    }
    const got = analyzeSource(mutated, mod.isWebrootPath);
    if (!got.length) {
      problems.push(`负向对照失败：${label} 之后门禁仍然通过（说明这条判据没生效）`);
      continue;
    }
    if (!got.some((v) => v.code === expectCode)) {
      problems.push(`负向对照：${label} 红了，但不是 ${expectCode} 判据判的（实际 ${[...new Set(got.map((v) => v.code))].join('/')}）`);
    }
  }
  return problems;
}

async function main(argv) {
  const selftestOnly = argv.includes('--selftest');
  const verbose = argv.includes('--verbose');
  const unknown = argv.filter((a) => a !== '--selftest' && a !== '--verbose');
  if (unknown.length) {
    console.error(`check:private-publish-root 用法错误：未知参数 ${unknown.join(' ')}\n用法：node scripts/check-private-publish-root.mjs [--selftest] [--verbose]`);
    process.exit(2);
  }
  if (!fs.existsSync(TARGET)) {
    console.error(`check:private-publish-root 环境错误：找不到 ${TARGET_REL}`);
    process.exit(2);
  }

  const problems = [];
  const staticViolations = await analyzeFile();
  problems.push(...staticViolations.map((v) => `${v.code} ${v.message}`));
  if (verbose && !staticViolations.length) console.log('静态判据 R1–R5：通过');

  const behavior = await checkBehavior();
  problems.push(...behavior);
  if (verbose && !behavior.length) console.log('行为判据 B1–B5：通过');

  if (problems.length) {
    console.error(`\ncheck:private-publish-root 失败：${problems.length} 条\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      '\n修法：默认站点根必须是私有根（/opt/dl-private，webroot 之外）；要写公网 webroot 必须\n'
        + '显式 --site-root + --allow-public-webroot。理由见 #601（任何人按默认参数跑都能复现的事故）。\n',
    );
    process.exit(1);
  }

  if (selftestOnly) {
    const st = await selftest();
    if (st.length) {
      console.error(`\ncheck:private-publish-root 负向对照失败：${st.length} 条\n`);
      for (const p of st) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log(`负向对照通过：${MUTATIONS.length} 种改坏方式全部判红，正本判绿`);
  }

  console.log(
    `check:private-publish-root OK —— 默认站点根 = 私有根 ${JSON.stringify((await import(pathToFileURL(TARGET).href)).DEFAULT_SITE_ROOT)}`
      + '（webroot 之外）；公网 webroot 需显式 --site-root + --allow-public-webroot；'
      + `静态 R1–R5 + 行为 B1–B5 全过（#601）`,
  );
}

// 被 import（单测 / selftest）时不要跑 CLI：只有直接执行才进 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
