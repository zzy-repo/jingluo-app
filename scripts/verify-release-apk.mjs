#!/usr/bin/env node
/**
 * verify-release-apk.mjs —— **发布 APK 四件套**一条命令校验（Issue #607 沉淀，#630 的 workflow 内联版）。
 *
 * ## 为什么要有它（今天真踩过）
 *   · `v1.4.3` 发出去之后，是靠人**手打 5 条命令**（aapt2 badging / xmltree / apksigner / sha256 /
 *     unzip grep baseUrl）才确认它干净 —— 换个 lane、换个人、换个心情就会漏一项；
 *   · 更早的 19 个已发布 APK 里 **15 个是 debug 包**（Issue #60），`v1.0.0`~`v1.3.0` 那些「正式版」
 *     全在内：漏的不是某一次操作，是「没有一条能一键复算的判据」；
 *   · 现有 `scripts/check-apk-debuggable.mjs` 只查 debuggable，其余三项（变体 / 回环标记 / 证书）
 *     散在 `docs/RELEASE-MANUAL.md` 的手打命令和 `.github/workflows/release.yml` 里，**别人用不上**。
 * 所以这里把四项做成同一张表：任何 lane、任何 APK，一条命令、一个退出码。
 *
 * ## 用法
 * ```
 * node scripts/verify-release-apk.mjs <apk> [--variant standard] [--expect-cert <sha256>] [--json]
 * ```
 *   --variant       期望的构建变体（默认 `standard`，可选 `internal`）
 *   --expect-cert   期望的签名证书 SHA-256（默认取下面的 `EXPECTED_CERT_SHA256`，与仓库那份一致）
 *   --json          输出结构化结果（workflow / 脚本消费；此时不打印表格）
 *
 * ## 四项 + 附加输出
 * | # | 检查 | 判据 |
 * |---|------|------|
 * | 1 | `debuggable` 不存在或 false | 复用 `check-apk-debuggable.mjs` 的 `evaluateApkDebuggable`（**不重写判定**） |
 * | 2 | `ARTIFACT_VARIANT == --variant` | `aapt2 dump xmltree --file AndroidManifest.xml` 的 meta-data |
 * | 3 | `LOOPBACK_CONSUME` 不存在或 false | 同上；**缺失视为通过**（老包没有这个标记，#601 的闸 2 同口径） |
 * | 4 | 签名证书 SHA-256 == `--expect-cert` | `apksigner verify --print-certs` |
 * | 5 | 附加输出（不算失败项） | `versionName` / `versionCode` / `sha256` / `md5` / `size`，供 Release 正文直用 |
 *
 * ## 退出码（与 `check-apk-debuggable` 同一口径）
 *   0  四项全过 → 可以发布
 *   1  有项目**明确不过**（读到值、值不对）→ 禁止发布，报告点名是哪一项
 *   2  判不出来（缺 aapt2 / apksigner、SDK 没装、不是 APK、清单读不出）→ **同样禁止发布**（fail-closed）
 *
 * ## 边界（别夸大）
 *   · 不依赖网络、不修改 APK（只读 + `fs.statSync`）；
 *   · 证书指纹是「这次出包用的是不是那把已发布 key」，不等于「包里的 JS 没被人改过」——
 *     那属于产物审计，不在这张表里；
 *   · 第 2/3 项要 `aapt2`，第 4 项要 `apksigner`，两者都从 `$ANDROID_HOME/build-tools/<版本>/` 取
 *     （优先级见 `scripts/lib/androidTools.mjs`：钉住的版本 > 已装最高档），找不到就 exit 2。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateApkDebuggable } from './check-apk-debuggable.mjs';
import {
  DEFAULT_LOOPBACK_MARKER,
  DEFAULT_MARKER,
  VARIANTS,
  parseMetaDataFromXmltree,
} from '../deploy/dl-release/variant.mjs';
import { loadBuildEnv, resolveBuildTools, toolchainHint } from './lib/androidTools.mjs';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_UNKNOWN = 2;

/**
 * 已发布证书指纹（= `/root/.android/debug.keystore`，全历史版本都用它签名）。
 * 与 `android/app/build.gradle` 的 `EXPECTED_CERT_SHA256`、`docs/RELEASE-MANUAL.md` §4.3 是同一个值：
 * 换证书会让已装用户无法覆盖升级，所以这里**默认就查**，不靠人记得传 --expect-cert。
 */
export const EXPECTED_CERT_SHA256 = 'e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1';

/** 检查项状态：pass 通过 / fail 明确不过 / unknown 判不出来（fail-closed） */
export const STATUS = Object.freeze({ PASS: 'pass', FAIL: 'fail', UNKNOWN: 'unknown' });

/** 四项检查的固定顺序与标题（表格、--json、报错点名都以它为准） */
export const CHECKS = Object.freeze([
  { id: 'debuggable', title: '1 debuggable 不存在或 false' },
  { id: 'variant', title: '2 ARTIFACT_VARIANT 与期望一致' },
  { id: 'loopback', title: '3 LOOPBACK_CONSUME 不存在或 false' },
  { id: 'cert', title: '4 签名证书 SHA-256 与期望一致' },
]);

const SCRIPT = path.basename(fileURLToPath(import.meta.url));

const EXIT_LABEL = { [EXIT_OK]: 'PASS', [EXIT_FAIL]: 'FAIL', [EXIT_UNKNOWN]: 'UNKNOWN' };

/** 跑一个外部命令；永不抛（超时 / 缺文件都折成 error），调用方按 status/error 判定 */
function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  const shell = /\.(bat|cmd)$/i.test(cmd);
  const result = spawnSync(shell ? `"${cmd}"` : cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    shell,
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    cmd: [cmd, ...args].join(' '),
  };
}

/** 一条检查结果 */
function check(id, status, expected, actual, detail) {
  const meta = CHECKS.find((item) => item.id === id);
  return { id, title: meta ? meta.title : id, status, expected, actual, detail };
}

/** 判不出来时的统一结果（exit 2）：四项都记 unknown，报告里写清为什么 */
function unknownResult(base, error) {
  return {
    ...base,
    ok: false,
    exitCode: EXIT_UNKNOWN,
    conclusion: EXIT_LABEL[EXIT_UNKNOWN],
    checks: CHECKS.map((item) => check(item.id, STATUS.UNKNOWN, '—', '未校验', error)),
    failing: [],
    error,
  };
}

/** 从 `aapt2 dump badging` 的首行取版本号；取不到返回 {} */
export function parseBadgingVersion(text) {
  if (typeof text !== 'string') return {};
  const line = text.split('\n').find((item) => item.startsWith('package:')) ?? '';
  const versionName = /versionName='([^']*)'/.exec(line);
  const versionCode = /versionCode='(\d+)'/.exec(line);
  const packageName = /name='([^']*)'/.exec(line);
  return {
    ...(packageName ? { packageName: packageName[1] } : {}),
    ...(versionName ? { versionName: versionName[1] } : {}),
    ...(versionCode ? { versionCode: Number(versionCode[1]) } : {}),
  };
}

/** 从 `apksigner verify --print-certs` 的输出里取出全部 signer 的 SHA-256（统一成小写） */
export function parseCertDigests(text) {
  if (typeof text !== 'string') return [];
  const digests = [];
  for (const line of text.split('\n')) {
    const match = /certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/.exec(line);
    if (match) digests.push(match[1].toLowerCase());
  }
  return digests;
}

/** 人类可读体积 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(2)} MiB（${bytes} 字节）` : `${(bytes / 1024).toFixed(1)} KiB（${bytes} 字节）`;
}

/** 展示宽度：CJK / 全角算 2 列，否则 1 列（表格对齐用） */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

const pad = (text, width) => String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));

/** 状态 → 表格里的标签（PASS / FAIL / UNKNOWN，宽度一致便于眼睛扫） */
const STATUS_LABEL = {
  [STATUS.PASS]: 'PASS   ',
  [STATUS.FAIL]: 'FAIL   ',
  [STATUS.UNKNOWN]: 'UNKNOWN',
};

/**
 * 校验一个 APK。
 *
 * @param {{apk: string, variant?: string, expectCert?: string, env?: NodeJS.ProcessEnv,
 *          buildToolsVersion?: string|null}} options
 * @returns {object} 结构化结果（形状见文件头；`--json` 直接打印它）
 */
export function verifyReleaseApk(options) {
  const env = options.env ?? process.env;
  const expectedVariant = options.variant ?? 'standard';
  const expectCert = String(options.expectCert ?? EXPECTED_CERT_SHA256).toLowerCase();
  const apkArg = typeof options.apk === 'string' ? options.apk : '';
  const base = {
    apk: apkArg,
    variant: expectedVariant,
    expectedCert: expectCert,
    buildTools: null,
    info: {},
  };

  if (!VARIANTS.includes(expectedVariant)) {
    return unknownResult(base, `--variant 只能是 ${VARIANTS.join(' / ')}，收到 "${expectedVariant}"`);
  }

  const apk = path.resolve(apkArg);
  base.apk = apk;
  let stat;
  try {
    stat = fs.statSync(apk);
  } catch (error) {
    return unknownResult(base, `读不到 APK：${apk}（${error.code ?? error.message}）`);
  }
  if (!stat.isFile()) return unknownResult(base, `不是普通文件：${apk}`);

  const tools = resolveBuildTools({
    env,
    buildEnv: loadBuildEnv(),
    buildToolsVersion: options.buildToolsVersion ?? null,
  });
  if (!tools.ok) return unknownResult(base, `${tools.detail}\n${toolchainHint()}`);
  base.buildTools = { version: tools.version, source: tools.source, dir: tools.dir, androidHome: tools.androidHome };

  const checks = [];

  // ── 1. debuggable：复用 check-apk-debuggable 的判定（零依赖、直接读二进制 AXML） ───────────
  const debug = evaluateApkDebuggable(apk);
  // 「根本不是可读的 APK」是**判不出来**（exit 2），不是「某一项不过」（exit 1）：
  // 后者会让人以为是发版参数错了，而实际是拿到了错文件 / 下载被截断。判据沿用 check-apk-debuggable 的 reason 前缀。
  const structural = ['read_failed', 'zip_failed', 'manifest_absent'];
  if (debug.verdict === 'unknown' && structural.some((prefix) => String(debug.reason).startsWith(prefix))) {
    return unknownResult(base, `这个文件不是可读的 APK（${debug.reason}）—— 按判不出来处理，exit 2`);
  }
  if (debug.verdict === 'clean') {
    checks.push(check('debuggable', STATUS.PASS, '无 android:debuggable（或 false）', debug.reason, null));
  } else if (debug.verdict === 'debuggable') {
    checks.push(check(
      'debuggable', STATUS.FAIL, '无 android:debuggable（或 false）', 'android:debuggable="true"',
      'debug 变体产物：可被任何已授权 adb 的机器 run-as 读私有数据 / 挂 JDWP。改用 assembleRelease 重新出包（Issue #60）',
    ));
  } else {
    checks.push(check('debuggable', STATUS.UNKNOWN, '无 android:debuggable（或 false）', '判不出来', debug.reason));
  }

  // ── 2 / 3. 变体标记与回环标记：同一份 xmltree（aapt2 dump badging 不输出 meta-data） ────────
  const xmltree = run(tools.tools.aapt2, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']);
  const xmltreeOk = xmltree.status === 0 && !xmltree.error;
  const meta = xmltreeOk ? parseMetaDataFromXmltree(xmltree.stdout) : new Map();
  const xmltreeWhy = xmltreeOk
    ? ''
    : `aapt2 dump xmltree 失败（${xmltree.error ? xmltree.error.message : `退出码 ${xmltree.status}`}）：${(xmltree.stderr || xmltree.stdout).trim().split('\n').slice(0, 3).join(' / ')}`;

  const variantMarker = meta.get(DEFAULT_MARKER);
  if (!xmltreeOk) {
    checks.push(check('variant', STATUS.UNKNOWN, expectedVariant, '判不出来', xmltreeWhy));
  } else if (!variantMarker) {
    checks.push(check(
      'variant', STATUS.FAIL, expectedVariant, '标记缺失',
      `AndroidManifest 里没有 ${DEFAULT_MARKER} —— 出包时没传 -PartifactVariant 或包是历史产物；自动更新会推错包`,
    ));
  } else if (variantMarker.typed || typeof variantMarker.value !== 'string') {
    checks.push(check('variant', STATUS.FAIL, expectedVariant, '非字符串取值', '标记被编成 android:resource / 布尔 / 整数，读不出变体名'));
  } else if (variantMarker.value.trim() !== expectedVariant) {
    checks.push(check(
      'variant', STATUS.FAIL, expectedVariant, variantMarker.value.trim(),
      '构建变体与 web 构建不同源（build:internal ↔ internal，build ↔ standard），自动更新会推错包',
    ));
  } else {
    checks.push(check('variant', STATUS.PASS, expectedVariant, variantMarker.value.trim(), null));
  }

  const loopbackMarker = meta.get(DEFAULT_LOOPBACK_MARKER);
  const loopbackRaw = loopbackMarker && typeof loopbackMarker.value === 'string'
    ? loopbackMarker.value.trim().toLowerCase()
    : (loopbackMarker ? '<非字符串>' : null);
  if (!xmltreeOk) {
    checks.push(check('loopback', STATUS.UNKNOWN, '不存在或 false', '判不出来', xmltreeWhy));
  } else if (!loopbackMarker) {
    // 老包没有这个标记：#601 的闸 2 也是「读不到就放行」，这里同口径，避免误伤历史包
    checks.push(check('loopback', STATUS.PASS, '不存在或 false', '标记缺失（视为 false）', null));
  } else if (loopbackRaw === 'false' || loopbackRaw === '0') {
    checks.push(check('loopback', STATUS.PASS, '不存在或 false', loopbackRaw, null));
  } else if (loopbackRaw === 'true' || loopbackRaw === '1') {
    checks.push(check(
      'loopback', STATUS.FAIL, '不存在或 false', loopbackRaw,
      '回环 consume 构建（-PallowLoopbackConsume=true）：consume.baseUrl 指向 127.0.0.1 / localhost，任何真机都连不上后端（Issue #601）',
    ));
  } else {
    // 只认 true/false 两种语义；其余一律按不过处理（发布闸门不做「可能是 false」的猜测）
    checks.push(check('loopback', STATUS.FAIL, '不存在或 false', String(loopbackRaw), '标记值不是布尔（gradle 只写 true/false），fail-closed'));
  }

  // ── 4. 签名证书 ────────────────────────────────────────────────────────────────────────
  const certs = run(tools.tools.apksigner, ['verify', '--print-certs', apk]);
  const digests = parseCertDigests(`${certs.stdout}\n${certs.stderr}`);
  if (certs.error) {
    checks.push(check('cert', STATUS.UNKNOWN, expectCert, '判不出来', `apksigner 起不来：${certs.error.message}`));
  } else if (certs.status !== 0) {
    const why = (certs.stderr || certs.stdout).trim().split('\n')[0] ?? '';
    checks.push(check('cert', STATUS.FAIL, expectCert, '签名无效 / 未签名', `apksigner verify 退出码 ${certs.status}${why ? `：${why}` : ''}`));
  } else if (!digests.length) {
    checks.push(check('cert', STATUS.UNKNOWN, expectCert, '判不出来', 'apksigner 没打印任何 SHA-256 指纹'));
  } else if (digests.some((digest) => digest !== expectCert)) {
    checks.push(check('cert', STATUS.FAIL, expectCert, digests.join(', '), '换证书会让已装用户无法覆盖升级；不要为了过闸门改 EXPECTED_CERT_SHA256'));
  } else {
    checks.push(check('cert', STATUS.PASS, expectCert, digests.join(', '), null));
  }

  // ── 5. 附加输出（不算失败项）：Release 正文直接用 ──────────────────────────────────────
  const badging = run(tools.tools.aapt2, ['dump', 'badging', apk]);
  const fromBadging = badging.status === 0 && !badging.error ? parseBadgingVersion(badging.stdout) : {};
  const info = {
    packageName: fromBadging.packageName ?? debug.info.packageName ?? null,
    versionName: fromBadging.versionName ?? debug.info.versionName ?? null,
    versionCode: fromBadging.versionCode ?? debug.info.versionCode ?? null,
  };
  try {
    const bytes = fs.readFileSync(apk);
    info.sha256 = createHash('sha256').update(bytes).digest('hex');
    info.md5 = createHash('md5').update(bytes).digest('hex');
    info.size = stat.size;
    info.sizeHuman = humanSize(stat.size);
  } catch (error) {
    info.sha256 = null;
    info.md5 = null;
    info.size = stat.size;
    info.sizeHuman = humanSize(stat.size);
    info.note = `读文件算摘要失败：${error.message}`;
  }
  base.info = info;

  const failing = checks.filter((item) => item.status === STATUS.FAIL).map((item) => item.id);
  const unknown = checks.filter((item) => item.status === STATUS.UNKNOWN).map((item) => item.id);
  const exitCode = failing.length ? EXIT_FAIL : unknown.length ? EXIT_UNKNOWN : EXIT_OK;
  return {
    ...base,
    ok: exitCode === EXIT_OK,
    exitCode,
    conclusion: EXIT_LABEL[exitCode],
    checks,
    failing,
    unknown,
    error: null,
  };
}

/** 表格 + 附加信息 → 人看的报告 */
export function formatReport(result) {
  const lines = [];
  lines.push(`APK   : ${result.apk}`);
  if (result.buildTools) {
    lines.push(`工具  : build-tools ${result.buildTools.version} · ${result.buildTools.source}`);
  }
  lines.push(`期望  : variant=${result.variant}  cert=${result.expectedCert}`);
  lines.push('');
  const titleWidth = Math.max(...CHECKS.map((item) => displayWidth(item.title.replace(/^\d+ /, ''))));
  lines.push(`${pad('#', 1)}  ${pad('检查', titleWidth)}  结果     实际`);
  lines.push(`${'-'.repeat(1)}  ${'-'.repeat(titleWidth)}  --------  ${'-'.repeat(24)}`);
  for (const item of result.checks) {
    const index = CHECKS.findIndex((meta) => meta.id === item.id) + 1;
    lines.push(`${pad(String(index), 1)}  ${pad(item.title.replace(/^\d+ /, ''), titleWidth)}  ${STATUS_LABEL[item.status]}  ${item.actual}`);
  }
  const info = result.info ?? {};
  lines.push('');
  lines.push('附加输出（Release 正文可直接用，不算失败项）');
  lines.push(`  packageName : ${info.packageName ?? '—'}`);
  lines.push(`  versionName : ${info.versionName ?? '—'}`);
  lines.push(`  versionCode : ${info.versionCode ?? '—'}`);
  lines.push(`  sha256      : ${info.sha256 ?? '—'}`);
  lines.push(`  md5         : ${info.md5 ?? '—'}`);
  lines.push(`  size        : ${info.sizeHuman ?? '—'}`);
  lines.push('');
  if (result.conclusion === 'PASS') {
    lines.push(`结论：PASS（${result.checks.length}/${result.checks.length} 项通过）—— 可以发布。`);
  } else if (result.conclusion === 'FAIL') {
    const detail = result.checks.filter((item) => item.status === STATUS.FAIL);
    lines.push(`结论：FAIL（${result.failing.join(' / ')} 不通过）—— 禁止发布。`);
    for (const item of detail) {
      if (item.detail) lines.push(`  · ${item.title}：${item.detail}`);
    }
  } else {
    lines.push('结论：UNKNOWN（判不出来）—— 按禁止发布处理（fail-closed）。');
    if (result.error) {
      for (const line of result.error.split('\n')) lines.push(`  ${line}`);
    } else {
      for (const item of result.checks.filter((entry) => entry.status === STATUS.UNKNOWN)) {
        lines.push(`  · ${item.title}：${item.detail}`);
      }
    }
  }
  return lines.join('\n');
}

function usage() {
  return [
    `用法: node scripts/${SCRIPT} <apk> [--variant standard|internal] [--expect-cert <sha256>] [--json]`,
    '',
    '四项校验：debuggable 不存在或 false / ARTIFACT_VARIANT 与 --variant 一致 /',
    '          LOOPBACK_CONSUME 不存在或 false / 签名证书 SHA-256 与 --expect-cert 一致',
    '附加输出：versionName / versionCode / sha256 / md5 / size（Release 正文直接用）',
    '',
    '退出码: 0 四项全过 / 1 有项目明确不过（报告点名） / 2 判不出来（缺 SDK 工具等，同样禁止发布）',
    `默认证书: ${EXPECTED_CERT_SHA256}`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apk: '', variant: 'standard', expectCert: null, json: false, help: false, buildToolsVersion: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${arg} 缺少取值`);
      return next;
    };
    // `pnpm run verify:apk -- <apk>` 会把 `--` 原样透传过来（npm 会吞掉）；两种都接受
    if (arg === '--') continue;
    else if (arg === '--json') options.json = true;
    else if (arg === '--variant') options.variant = value();
    else if (arg === '--expect-cert') options.expectCert = value();
    else if (arg === '--build-tools') options.buildToolsVersion = value();
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 1) throw new Error(`一次只验一个 APK（收到 ${rest.length} 个参数）`);
  options.apk = rest[0] ?? '';
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    return EXIT_UNKNOWN;
  }
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  if (!options.apk) {
    console.error(usage());
    return EXIT_UNKNOWN;
  }

  const result = verifyReleaseApk({
    apk: options.apk,
    variant: options.variant,
    expectCert: options.expectCert ?? undefined,
    buildToolsVersion: options.buildToolsVersion,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }
  // 非 JSON 模式下把「为什么不过」同时写到 stderr，方便 workflow 的 ::error:: 与 grep 抓
  if (result.exitCode !== EXIT_OK && !options.json) {
    const reason = result.conclusion === 'FAIL'
      ? `发布校验不通过：${result.failing.join(' / ')}`
      : '发布校验判不出来（fail-closed）';
    console.error(reason);
  }
  return result.exitCode;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
