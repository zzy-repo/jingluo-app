#!/usr/bin/env node
/**
 * publish-private-apk.mjs —— 私有（internal）包「一条命令发布」
 *
 * 背景（Issue #566 问题 1 的 **B 方案**）：
 *   私有包要进 `releases.json`（这样装了 internal 变体的客户端能收到自动更新，顺带解 #377），
 *   但**不许改公共 `latest`**（公共渠道仍然停在 standard 那条）。同时包必须用**不可猜测的文件名**
 *   —— 清单是公开的，靠「没人知道链接」不是真私有，但至少不能让 `deepseek-chat-1.4.2.apk`
 *   这种可枚举的名字被人顺着版本号扫下来（见 docs/RELEASE-MANUAL.md「私有（internal）包发布」）。
 *
 * 为什么**不用** `POST /api/v1/release`：
 *   1. 服务端 `server.mjs` §8 会把 `latest` 改成这次发布的版本 —— 那是公共渠道语义，私有包不能用；
 *   2. 它还要一枚按人发放的发布令牌，而私有包只有维护者自己在签名机上发。
 *   所以私有包走 SSH 直写站点根：`scp` 传包（先 `.tmp` 再 `mv`，原子）+ 原子替换 `releases.json`。
 *   公共发布继续走 `pnpm run release:upload`（那条路一行没改）。
 *
 * 用法（全部参数都能用环境变量给，见 §「参数」）：
 *
 *   # 演练：只看要做什么，不落地
 *   node scripts/publish-private-apk.mjs --apk app-release.apk --version 1.4.2 --versionCode 21 --dry-run
 *
 *   # 真发布
 *   node scripts/publish-private-apk.mjs --apk app-release.apk --version 1.4.2 --versionCode 21
 *
 *   # 用假文件把「上传 + 清单改动 + 回滚」三条全跑一遍（发完立刻全量回滚，线上不留残留）
 *   node scripts/publish-private-apk.mjs --apk /tmp/fake.apk --version 0.0.0 --versionCode 9999 \
 *     --skip-apk-validation --exercise
 *
 * 参数：
 *   --apk <path>              必填。APK 路径（环境变量 DL_PRIVATE_APK）
 *   --version <x.y.z>         必填。versionName，必须与 APK 内一致（DL_PRIVATE_VERSION）
 *   --versionCode <n>         必填。正整数，必须与 APK 内一致（DL_PRIVATE_VERSION_CODE）
 *   --variant internal        默认 internal，只能是 internal|standard（DL_PRIVATE_VARIANT）
 *   --changes <text>          清单里的 changes 条目，可重复给多条；不给就用一行默认说明
 *   --dry-run                 默认关闭（不传就是真发布）。只打印动作与清单条目，不落地
 *   --exercise                演练：真上传 + 真加清单条目 + 立刻全量回滚（要求 version 形如 0.0.0）
 *   --skip-apk-validation     **仅供演练**：跳过 aapt2 校验（假文件过不了 aapt2）
 *   --force                   演练时允许 version 不是 0.0.0 开头（危险，别用）
 *   --ssh-host <host>         默认 aliyun（DL 主机，见 ~/.ssh/config）
 *   --site-root <dir>         默认 /var/www/dl
 *   --public-base <url>       默认 https://dl.rose7.cn/
 *   --aapt2 <path>            指定 aapt2（默认找 $AAPT2 / $ANDROID_HOME/build-tools/<ver>/aapt2 / PATH）
 *   --help
 *
 * 退出码：0 成功（含 dry-run / 演练回滚干净）；1 校验或执行失败；2 环境/参数问题（一个字节都没发）
 *
 * 设计原则（照 docs/RELEASE-MANUAL.md §0 那两条来）：
 *   - **不做「跑到一半」的自动化**：真上传之前把所有能本地判定的都判完（APK 属性、文件名、清单合并、
 *     schema 校验、备份是否成功），判不过就 exit 2，一个字节都不发；
 *   - **每一步都能单独重跑**：`--dry-run` 打印的就是真执行的那几步；回滚命令在失败信息里直接给。
 *   - **不猜**：判不出来的（aapt2 缺失、变体标记缺失、清单读不到）一律按失败处理，不许「先发后修」。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_APK_BYTES,
  PACKAGE_NAME,
  RE_MD5,
  RE_SHA256,
  RE_VERSION,
  buildTypeFor,
  hashFile,
  log,
  parseArgs,
  VARIANT_META_NAME,
} from './release-common.mjs';
// schema 校验只有一份实现（Issue #330）：这里 import 校验器本体，不再写第二份枚举
import { validate as validateReleasesSchema } from './validate-releases-manifest.mjs';
// 变体标记的解析只有一份实现：aapt2 dump xmltree 的输出由它来判
import { parseVariantFromXmltree } from '../deploy/dl-release/variant.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 清单里允许的变体（与 deploy/dl-release/variant.mjs、校验器同口径） */
export const VARIANTS = Object.freeze(['internal', 'standard']);
/** 文件名前缀：与既有的 19 个 APK 同构（`apk/<prefix>-<version>...apk`） */
export const FILE_PREFIX = 'deepseek-chat';
/** DL 主机：`ssh aliyun`（Tailscale 内网，公网 22 打不通） */
export const DEFAULT_SSH_HOST = 'aliyun';
/** 站点根：Caddy 本地直服（/var/www/dl/releases.json、/var/www/dl/apk/*.apk） */
export const DEFAULT_SITE_ROOT = '/var/www/dl';
/** 对外基址：拼直链用 */
export const DEFAULT_PUBLIC_BASE = 'https://dl.rose7.cn/';
/** APK 子目录（清单里的 `file` 是 `apk/<name>.apk` 相对路径） */
export const APK_SUBDIR = 'apk';
/** 不可猜测文件名的随机段：5 字节 = 40 bit = 8 个 base32 字符 */
export const RANDOM_BYTES = 5;
export const RANDOM_CHARS = 8;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 演练用的假版本号前缀（只有 `0.0.0` 开头才允许 --exercise，除非 --force） */
const FAKE_VERSION_RE = /^0\.0\.0(?:-|$)/;
/** APK 下载时的 Content-Type（Caddy 由 mime 表给，实测如此） */
const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';

/** 参数/环境不满足 → exit 2（不是发布失败，是还没开始就做不了） */
export class PublishEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishEnvError';
    this.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// 纯函数区（可单测，不碰网络、不碰磁盘）
// ---------------------------------------------------------------------------

/**
 * 不可猜测的随机段：**必须**来自 crypto.randomBytes，不许用时间戳/进程号
 * （时间戳可枚举：知道大致发布时间就能把 36^8 的搜索空间压成几百万）。
 *
 * @param {number} bytes 随机字节数；默认 5 → 40 bit → 8 个 base32 字符
 * @returns {string} 8 个 base32 字符（A-Z2-7，无易混字符 0/1）
 */
export function randomSuffix(bytes = RANDOM_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 4) throw new PublishEnvError('随机段至少要 4 字节（32 bit）');
  const buf = crypto.randomBytes(bytes);
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/**
 * 生成不可猜测的文件名（不含目录）：`deepseek-chat-<version>-<variant>-<8位随机>.apk`
 * @param {{version:string, variant:string, suffix:string}} p
 */
export function buildFileName({ version, variant, suffix }) {
  if (!RE_VERSION.test(String(version))) throw new PublishEnvError(`version 格式非法：${version}`);
  if (!VARIANTS.includes(variant)) throw new PublishEnvError(`variant 只能是 ${VARIANTS.join('|')}：${variant}`);
  if (!/^[A-Z2-7]{8}$/.test(String(suffix))) throw new PublishEnvError(`随机段必须正好 8 个 base32 字符：${suffix}`);
  return `${FILE_PREFIX}-${version}-${variant}-${suffix}.apk`;
}

/** 清单里的 file 字段（相对站点根的路径，与既有 19 条同构） */
export function fileField(fileName) {
  return `${APK_SUBDIR}/${fileName}`;
}

/**
 * ISO8601 +08:00 时间戳（校验器要求 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$`）
 * @param {Date} [date]
 */
export function shanghaiTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/**
 * 构造清单条目。字段顺序与线上既有条目一致（人读 diff 时最省事），
 * `buildType` 由版本号决定（`shared/build-types.mjs` 是唯一判定来源）。
 */
export function buildEntry({ version, versionCode, variant, fileName, size, md5, sha256, changes, releasedAt }) {
  return {
    version,
    versionCode,
    releasedAt: releasedAt || shanghaiTimestamp(),
    file: fileField(fileName),
    size,
    md5,
    sha256,
    changes: Array.isArray(changes) && changes.length ? changes : [`私有（${variant}）构建 ${version}（versionCode ${versionCode}）`],
    buildType: buildTypeFor(version),
    breaking: false,
    artifactVariant: variant,
    artifactVariantSource: 'apk-manifest',
  };
}

/**
 * 把条目并进清单：`latest` **原样带过**（这是本脚本与 /api/v1/release 的核心差别）。
 *
 * 合并规则：
 *   - 同 `version` + 同 `artifactVariant` → **替换**（重发同一个包是允许的，与 API 的幂等覆盖同口径）；
 *   - 否则按 `versionCode` **降序插入**（清单契约要求全表严格降序，校验器会复核）。
 *
 * @param {{latest:string, releases:object[]}} manifest
 * @param {object} entry
 * @returns {{latest:string, releases:object[]}}
 */
export function mergeEntry(manifest, entry) {
  if (!manifest || typeof manifest !== 'object') throw new PublishEnvError('线上清单不是对象');
  if (!Array.isArray(manifest.releases)) throw new PublishEnvError('线上清单没有 releases 数组');
  const version = String(entry.version);
  const variant = entry.artifactVariant;
  const kept = manifest.releases.filter(
    (r) => !(r && String(r.version) === version && (r.artifactVariant ?? null) === (variant ?? null)),
  );
  const at = kept.findIndex((r) => Number(r.versionCode) < Number(entry.versionCode));
  const releases = at < 0 ? [...kept, entry] : [...kept.slice(0, at), entry, ...kept.slice(at)];
  return { ...manifest, releases };
}

/**
 * 写回前的自检（比校验器更严的那几条「私有包特有」的约束）：
 *   1. 公共 `latest` **逐字节不变**；
 *   2. 发布前的每一条既有记录**原样还在**（不许顺手改别人）；
 *   3. 合并后的整份清单仍满足 schema（复用 scripts/validate-releases-manifest.mjs）；
 *   4. 新条目真的在清单里，且 sha256/size/file 与本次产物一致。
 *
 * @returns {{errors:string[], warnings:string[]}}
 */
export function verifyMerge({ before, after, entry }) {
  const errors = [];
  const warnings = [];

  if (after.latest !== before.latest) {
    errors.push(`latest 被改了：发布前 ${JSON.stringify(before.latest)} → 发布后 ${JSON.stringify(after.latest)}（私有包不许动公共 latest）`);
  }

  for (const old of before.releases) {
    const still = after.releases.find((r) => r && r.version === old.version && (r.artifactVariant ?? null) === (old.artifactVariant ?? null));
    if (!still) {
      errors.push(`既有条目丢了：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
      continue;
    }
    if (JSON.stringify(still) !== JSON.stringify(old)) {
      errors.push(`既有条目被改了：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
    }
  }

  const added = after.releases.find((r) => r && r.version === entry.version && r.artifactVariant === entry.artifactVariant);
  if (!added) {
    errors.push(`新条目没进清单：${entry.version}（${entry.artifactVariant}）`);
  } else {
    if (added.sha256 !== entry.sha256) errors.push(`新条目 sha256 与产物不一致：${added.sha256} != ${entry.sha256}`);
    if (added.size !== entry.size) errors.push(`新条目 size 与产物不一致：${added.size} != ${entry.size}`);
    if (added.file !== entry.file) errors.push(`新条目 file 与预期不一致：${added.file} != ${entry.file}`);
  }

  const { errors: schemaErrors, warnings: schemaWarnings } = validateReleasesSchema(after);
  errors.push(...schemaErrors.map((m) => `清单 schema：${m}`));
  warnings.push(...schemaWarnings);

  return { errors, warnings };
}

/**
 * 解析 `aapt2 dump badging` 的首行（package / versionCode / versionName）
 * @param {string} text
 */
export function parseBadging(text) {
  const lines = String(text).split('\n');
  const first = lines.find((l) => l.trimStart().startsWith('package:')) || '';
  const grab = (re) => {
    const m = re.exec(first);
    return m ? m[1] : null;
  };
  const rawCode = grab(/versionCode='([^']*)'/);
  return {
    packageName: grab(/name='([^']*)'/),
    // 解析不出来必须是 null（调用方按「没测到」处理），不许变成 0 蒙过去
    versionCode: rawCode === null || !/^\d+$/.test(rawCode) ? null : Number(rawCode),
    versionName: grab(/versionName='([^']*)'/),
    debuggableLines: lines.filter((l) => l.includes('application-debuggable')).length,
  };
}

/** 把 errors 汇总成可读的一段并退出（exit 1 = 校验/执行失败） */
function die(errors, hint) {
  console.error('\n发布中止（一个字节都没有发出去）：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

/** 环境/参数不满足：exit 2 */
function dieEnv(message) {
  console.error(`\n环境/参数不满足，未开始发布：\n  ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 外部命令（ssh / scp / curl / aapt2）
// ---------------------------------------------------------------------------

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

function run(bin, argv, opts = {}) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, input: opts.input });
  if (r.error) throw new CliError(`${bin} 跑不起来：${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 800);
    throw new CliError(`${bin} ${argv.join(' ')} 失败（exit=${r.status}）${detail ? `：\n${detail}` : ''}`);
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sshExec(host, script) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, script]);
}

function scpTo(host, localFile, remotePath) {
  return run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', localFile, `${host}:${remotePath}`], {
    timeout: 300_000,
  });
}

/** 找 aapt2：显式 → $AAPT2 → $ANDROID_HOME → ~/android-sdk → PATH */
export function findAapt2(explicit) {
  const candidates = [];
  const push = (p) => p && candidates.push(p);
  push(explicit);
  push(process.env.AAPT2);
  for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'android-sdk')]) {
    if (!home) continue;
    const dir = path.join(String(home), 'build-tools');
    try {
      for (const v of fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        push(path.join(dir, v, 'aapt2'));
      }
    } catch {
      /* 没这个 SDk 目录就跳过 */
    }
  }
  const onPath = spawnSync('sh', ['-c', 'command -v aapt2'], { encoding: 'utf8' });
  if (onPath.status === 0) push(onPath.stdout.trim());
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* 权限之类，继续下一个 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// APK 校验（任一不符直接退出）
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:boolean, errors:string[], facts:object}}
 */
export function validateApk({ apk, version, versionCode, variant, aapt2 }) {
  const errors = [];
  const facts = { aapt2: aapt2 || null, packageName: null, versionCode: null, versionName: null, debuggable: null, variant: null, variantReason: null };

  if (!aapt2) {
    return { ok: false, errors: ['找不到 aapt2（$AAPT2 / $ANDROID_HOME/build-tools/<ver>/aapt2 都没有）；用 --aapt2 指定，或演练时加 --skip-apk-validation'], facts };
  }

  let badging;
  try {
    badging = run(aapt2, ['dump', 'badging', apk]).stdout;
  } catch (e) {
    return { ok: false, errors: [`aapt2 dump badging 失败（不是合法 APK？）：${e.message}`], facts };
  }
  const parsed = parseBadging(badging);
  facts.packageName = parsed.packageName;
  facts.versionCode = parsed.versionCode;
  facts.versionName = parsed.versionName;
  facts.debuggable = parsed.debuggableLines === 0 ? false : true;

  if (parsed.packageName !== PACKAGE_NAME) errors.push(`包名不符：APK 里是 ${parsed.packageName}，要求 ${PACKAGE_NAME}`);
  if (parsed.versionCode !== Number(versionCode)) errors.push(`versionCode 不符：APK 里是 ${parsed.versionCode}，--versionCode 给的是 ${versionCode}`);
  if (parsed.versionName !== String(version)) errors.push(`versionName 不符：APK 里是 ${JSON.stringify(parsed.versionName)}，--version 给的是 ${version}`);
  if (parsed.debuggableLines !== 0) errors.push('APK 是 debuggable 构建（application-debuggable 出现）——发布完整性的硬门禁，绝对不发');

  let xmltree = '';
  try {
    xmltree = run(aapt2, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']).stdout;
  } catch (e) {
    errors.push(`aapt2 dump xmltree 失败（读不到变体标记）：${e.message}`);
  }
  if (xmltree) {
    const v = parseVariantFromXmltree(xmltree, VARIANT_META_NAME);
    facts.variant = v.variant;
    facts.variantReason = v.reason;
    if (!v.variant) {
      errors.push(`APK 里读不到变体标记 ${VARIANT_META_NAME}（reason=${v.reason}）——重新出包：./gradlew assembleRelease -PartifactVariant=${variant}`);
    } else if (v.variant !== variant) {
      errors.push(`变体标记不符：APK 里是 ${v.variant}，--variant 给的是 ${variant}`);
    }
  }

  return { ok: errors.length === 0, errors, facts };
}

// ---------------------------------------------------------------------------
// 发布主流程
// ---------------------------------------------------------------------------

function help() {
  console.log(
    [
      '私有（internal）包发布：node scripts/publish-private-apk.mjs --apk <path> --version <x.y.z> --versionCode <n>',
      '',
      '  --apk <path>           必填（DL_PRIVATE_APK）',
      '  --version <x.y.z>      必填（DL_PRIVATE_VERSION）',
      '  --versionCode <n>      必填（DL_PRIVATE_VERSION_CODE）',
      '  --variant <v>          internal（默认）| standard（DL_PRIVATE_VARIANT）',
      '  --changes <text>       清单 changes 条目，可重复',
      '  --dry-run              只打印动作与清单条目，不落地（默认是真发布）',
      '  --exercise             真上传 + 真加清单条目 + 立刻全量回滚（要求 version 形如 0.0.0）',
      '  --skip-apk-validation  仅演练：跳过 aapt2 校验',
      '  --force                演练时允许非 0.0.0 版本（危险）',
      '  --ssh-host <host>      aliyun（默认）',
      '  --site-root <dir>      /var/www/dl（默认）',
      '  --public-base <url>    https://dl.rose7.cn/（默认）',
      '  --aapt2 <path>         aapt2 路径',
    ].join('\n'),
  );
}

function readArg(args, flag, envName) {
  if (args[flag] !== undefined && args[flag] !== true) return String(args[flag]);
  if (envName && process.env[envName]) return String(process.env[envName]);
  return null;
}

function parseCli(argv) {
  const args = parseArgs(argv, {
    flags: ['dry-run', 'exercise', 'skip-apk-validation', 'force', 'help'],
    multi: ['changes'],
  });
  if (args.help) {
    help();
    process.exit(0);
  }
  const apk = readArg(args, 'apk', 'DL_PRIVATE_APK');
  const version = readArg(args, 'version', 'DL_PRIVATE_VERSION');
  const versionCodeRaw = readArg(args, 'versionCode', 'DL_PRIVATE_VERSION_CODE');
  const variant = readArg(args, 'variant', 'DL_PRIVATE_VARIANT') || 'internal';
  const sshHost = readArg(args, 'ssh-host', 'DL_PRIVATE_SSH_HOST') || DEFAULT_SSH_HOST;
  const siteRoot = readArg(args, 'site-root', 'DL_PRIVATE_SITE_ROOT') || DEFAULT_SITE_ROOT;
  const publicBase = (readArg(args, 'public-base', 'DL_PRIVATE_PUBLIC_BASE') || DEFAULT_PUBLIC_BASE).replace(/\/+$/, '') + '/';

  const missing = [];
  if (!apk) missing.push('--apk（或 DL_PRIVATE_APK）');
  if (!version) missing.push('--version（或 DL_PRIVATE_VERSION）');
  if (!versionCodeRaw) missing.push('--versionCode（或 DL_PRIVATE_VERSION_CODE）');
  if (missing.length) dieEnv(`缺必填参数：${missing.join('、')}（--help 看全部参数）`);

  if (!RE_VERSION.test(version)) dieEnv(`--version 格式非法（要 x.y.z 或 x.y.z-beta.N）：'${version}'`);
  const versionCode = Number(versionCodeRaw);
  if (!Number.isInteger(versionCode) || versionCode <= 0) dieEnv(`--versionCode 必须是正整数：'${versionCodeRaw}'`);
  if (!VARIANTS.includes(variant)) dieEnv(`--variant 只能是 ${VARIANTS.join('|')}：'${variant}'`);
  if (!/^\/[A-Za-z0-9._/-]+$/.test(siteRoot)) dieEnv(`--site-root 必须是绝对路径且不含空格/引号：'${siteRoot}'`);
  if (!/^https?:\/\//.test(publicBase)) dieEnv(`--public-base 必须是 http(s) URL：'${publicBase}'`);

  const exercise = args.exercise === true;
  const force = args.force === true;
  if (exercise && !FAKE_VERSION_RE.test(version) && !force) {
    dieEnv(`--exercise 只允许演练用的假版本号（0.0.0 开头），拿到的是 '${version}'。真版本走正常发布，别拿来演练。`);
  }
  if (!fs.existsSync(apk)) dieEnv(`APK 不存在：${apk}`);

  const changes = Array.isArray(args.changes) ? args.changes.filter((c) => typeof c === 'string' && c.trim()) : [];

  return {
    apk: path.resolve(apk),
    version,
    versionCode,
    variant,
    changes,
    dryRun: args['dry-run'] === true,
    exercise,
    skipApkValidation: args['skip-apk-validation'] === true,
    sshHost,
    siteRoot,
    publicBase,
    aapt2: readArg(args, 'aapt2', 'AAPT2'),
  };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const remoteApkDir = `${opts.siteRoot}/${APK_SUBDIR}`;
  const remoteManifest = `${opts.siteRoot}/releases.json`;
  const stamp = Math.floor(Date.now() / 1000);

  log.head('私有包发布：参数');
  log.info(`APK          ${opts.apk}`);
  log.info(`version      ${opts.version}（versionCode ${opts.versionCode}）`);
  log.info(`variant      ${opts.variant}（buildType 由版本号判定 = ${buildTypeFor(opts.version)}）`);
  log.info(`目标         ${opts.sshHost}:${remoteApkDir}/`);
  log.info(`公共基址     ${opts.publicBase}`);
  log.info(`模式         ${opts.dryRun ? 'dry-run（不落地）' : opts.exercise ? 'exercise（真上传 + 真改清单 + 立刻回滚）' : '真发布'}`);

  // ---- 1. APK 校验 ----
  log.head('1/6 校验 APK（aapt2）');
  let facts = { skipped: true };
  let hashes;
  if (opts.skipApkValidation) {
    log.warn('已跳过 aapt2 校验（--skip-apk-validation，只允许演练用）');
  } else {
    const aapt2 = findAapt2(opts.aapt2);
    const res = validateApk({ apk: opts.apk, version: opts.version, versionCode: opts.versionCode, variant: opts.variant, aapt2 });
    facts = res.facts;
    if (!res.ok) die(res.errors, 'APK 属性不符 → 停止。改代码重出包，不要「先发后修」。');
    log.ok(`package=${facts.packageName} versionCode=${facts.versionCode} versionName=${facts.versionName}`);
    log.ok(`application-debuggable: 0 处（无属性）`);
    log.ok(`变体标记 ${VARIANT_META_NAME} = ${facts.variant}（source=apk-manifest）`);
  }

  // ---- 2. hash ----
  log.head('2/6 算 sha256 / md5 / size');
  hashes = hashFile(opts.apk);
  if (hashes.size > MAX_APK_BYTES) die([`APK ${hashes.size} 字节，超过服务端上限 ${MAX_APK_BYTES} 字节`]);
  log.ok(`size      ${hashes.size} 字节`);
  log.ok(`sha256    ${hashes.sha256}`);
  log.ok(`md5       ${hashes.md5}`);

  // ---- 3. 文件名 ----
  log.head('3/6 生成不可猜测文件名');
  const fileName = buildFileName({ version: opts.version, variant: opts.variant, suffix: randomSuffix() });
  const fileUrl = `${opts.publicBase}${fileField(fileName)}`;
  log.ok(`文件名    ${fileName}`);
  log.ok(`直链      ${fileUrl}`);

  // ---- 4. 读线上清单 + 预演合并（不发任何字节） ----
  log.head('4/6 读线上清单并预演合并（latest 必须不变）');
  let remoteOk = false;
  let beforeText = '';
  let beforeManifest = null;
  let beforeSha = '';
  let afterManifest = null;
  let entry = null;
  let backupPath = '';

  try {
    const probe = sshExec(opts.sshHost, `test -r ${quote(remoteManifest)} && test -w ${quote(remoteApkDir)} && sha256sum ${quote(remoteManifest)}`);
    remoteOk = true;
    beforeSha = probe.stdout.trim().split(/\s+/)[0] || '';
    log.ok(`ssh ${opts.sshHost} 可达；清单 sha256 = ${beforeSha}`);
  } catch (e) {
    if (!opts.dryRun) dieEnv(`连不上 ${opts.sshHost} 或清单/目录不可读写：${e.message}`);
    log.warn(`ssh 不可用（dry-run 继续，只打印动作）：${e.message.split('\n')[0]}`);
  }

  if (remoteOk) {
    beforeText = sshExec(opts.sshHost, `cat ${quote(remoteManifest)}`).stdout;
    try {
      beforeManifest = JSON.parse(beforeText);
    } catch (e) {
      die([`线上清单不是合法 JSON：${e.message}`]);
    }
    // 往返一致性：写回时用同一份序列化口径，若原文件不是「2 空格缩进 + 末尾换行」就拒绝写回，
    // 免得整份重排（那会让 diff 里全是无关改动，也让「回滚后逐字节一致」无法验证）
    const canonical = JSON.stringify(beforeManifest, null, 2) + '\n';
    if (canonical !== beforeText) {
      die([
        '线上清单的排版不是「2 空格缩进 + 末尾换行」，写回会整份重排。拒绝执行。',
        `原始 ${beforeText.length} 字符，规范化后 ${canonical.length} 字符 —— 请先用 node -e 检查 formatting 再手工发。`,
      ]);
    }
    log.ok(`线上清单 ${beforeManifest.releases.length} 条，latest = ${beforeManifest.latest}（往返序列化逐字节一致）`);

    entry = buildEntry({
      version: opts.version,
      versionCode: opts.versionCode,
      variant: opts.variant,
      fileName,
      size: hashes.size,
      md5: hashes.md5,
      sha256: hashes.sha256,
      changes: opts.changes,
    });
    afterManifest = mergeEntry(beforeManifest, entry);
    const verdict = verifyMerge({ before: beforeManifest, after: afterManifest, entry });
    // 既有 19 条的历史 warning（缺 sha256 / 缺 artifactVariant / 旧命名）不是本次发布的事，
    // 只显示**本条**相关的；其余折叠成一行计数，免得刷屏盖掉真正要看的东西。
    const mine = verdict.warnings.filter((w) => w.includes(`(${entry.version})`) || w.includes(`latest(${entry.version})`));
    const others = verdict.warnings.length - mine.length;
    for (const w of mine) log.warn(`清单 warning：${w}`);
    if (others > 0) log.info(`（另有 ${others} 条历史 warning，属于既有条目，未改动）`);
    if (verdict.errors.length) die(verdict.errors, '合并后的清单不合法 → 停止（线上一个字节都没动）。');
    log.ok(`合并后 ${afterManifest.releases.length} 条；latest 仍是 ${afterManifest.latest}（未改）；既有 ${beforeManifest.releases.length} 条原样保留`);
  } else {
    entry = buildEntry({
      version: opts.version,
      versionCode: opts.versionCode,
      variant: opts.variant,
      fileName,
      size: hashes.size,
      md5: hashes.md5,
      sha256: hashes.sha256,
      changes: opts.changes,
    });
  }

  // ---- 5. 打印计划 / 执行 ----
  const afterText = afterManifest ? JSON.stringify(afterManifest, null, 2) + '\n' : '';
  const plan = [
    `scp ${opts.apk} ${opts.sshHost}:${remoteApkDir}/${fileName}.tmp-${stamp}`,
    `ssh ${opts.sshHost} 'chown www-data:www-data <tmp> && chmod 644 <tmp> && mv <tmp> ${remoteApkDir}/${fileName}'   # 原子改名`,
    `ssh ${opts.sshHost} 'cp ${remoteManifest} ${remoteManifest}.bak-private-${stamp}'` +
      `   # 清单先备份`,
    `scp releases.json → ${opts.sshHost}:${remoteManifest}.tmp-${stamp} && ssh ${opts.sshHost} 'chown www-data:www-data … && mv … ${remoteManifest}'   # 原子替换`,
    `curl -I ${fileUrl}                    # 期望 200 + ${APK_CONTENT_TYPE} + content-length=${hashes.size}`,
    `curl ${fileUrl} | sha256sum            # 期望 ${hashes.sha256}`,
    `curl ${opts.publicBase}releases.json   # 期望 latest 与发布前逐字节相同（${beforeManifest ? beforeManifest.latest : '<上线后才知道>'})`,
  ];

  log.head(opts.dryRun ? '5/6 dry-run：将要执行的动作（一个字节都没发）' : '5/6 执行');
  if (opts.dryRun) {
    plan.forEach((line, i) => log.info(`(${i + 1}) ${line}`));
    log.head('清单里将要加入的条目');
    console.log(JSON.stringify(entry, null, 2));
    if (afterManifest) {
      log.info(`（合并位置：releases[${afterManifest.releases.findIndex((r) => r.version === entry.version && r.artifactVariant === entry.artifactVariant)}]，按 versionCode 降序）`);
    }
    log.head('回滚方法（真发布后要撤时）');
    log.info(`ssh ${opts.sshHost} 'mv ${remoteManifest}.bak-private-${stamp} ${remoteManifest}'   # 恢复清单`);
    log.info(`ssh ${opts.sshHost} 'rm -f ${remoteApkDir}/${fileName}'                            # 删包`);
    log.ok('dry-run 结束：没有上传、没有改清单');
    return;
  }

  // 上传前再确认文件名没被占用（随机撞车概率可忽略，但撞了就必须换一个）
  const exists = sshExec(opts.sshHost, `test -e ${quote(`${remoteApkDir}/${fileName}`)} && echo EXISTS || echo FREE`).stdout.trim();
  if (exists === 'EXISTS') die([`远端已存在同名文件：${fileName}（撞车了，重跑一次即可）`]);

  const state = { uploaded: false, manifestWritten: false, backupPath: '', remoteTmpFiles: [] };

  try {
    // 5a. 上传（先 .tmp 再原子 mv）
    const remoteTmp = `${remoteApkDir}/${fileName}.tmp-${stamp}`;
    state.remoteTmpFiles.push(remoteTmp);
    log.info(`scp → ${opts.sshHost}:${remoteTmp}`);
    scpTo(opts.sshHost, opts.apk, remoteTmp);
    sshExec(
      opts.sshHost,
      `chown www-data:www-data ${quote(remoteTmp)} && chmod 644 ${quote(remoteTmp)} && mv -f ${quote(remoteTmp)} ${quote(`${remoteApkDir}/${fileName}`)}`,
    );
    state.uploaded = true;
    log.ok(`上传完成（原子改名）：${remoteApkDir}/${fileName}`);

    // 5b. 清单：备份 → 写 tmp → 原子 mv
    backupPath = `${remoteManifest}.bak-private-${stamp}`;
    sshExec(opts.sshHost, `cp -p ${quote(remoteManifest)} ${quote(backupPath)} && sha256sum ${quote(backupPath)}`);
    state.backupPath = backupPath;
    log.ok(`清单已备份：${backupPath}`);

    const tmpLocal = path.join(os.tmpdir(), `releases-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(tmpLocal, afterText, 'utf8');
    const remoteManifestTmp = `${remoteManifest}.tmp-${stamp}`;
    state.remoteTmpFiles.push(remoteManifestTmp);
    scpTo(opts.sshHost, tmpLocal, remoteManifestTmp);
    sshExec(
      opts.sshHost,
      `chown www-data:www-data ${quote(remoteManifestTmp)} && chmod 644 ${quote(remoteManifestTmp)} && mv -f ${quote(remoteManifestTmp)} ${quote(remoteManifest)}`,
    );
    fs.rmSync(tmpLocal, { force: true });
    state.manifestWritten = true;
    log.ok(`清单已原子替换（${beforeManifest.releases.length} → ${afterManifest.releases.length} 条，latest 仍是 ${afterManifest.latest}）`);

    // 6. 验证（失败也要先把演练现场收拾干净，再决定退出码）
    log.head('6/6 验证（直链 / 校验和 / latest）');
    let verifyError = null;
    try {
      verifyLive({ opts, fileName, fileUrl, hashes, beforeManifest, entry });
    } catch (e) {
      verifyError = e;
    }

    if (opts.exercise) {
      log.head('exercise：全量回滚');
      rollback({ opts, state, fileName, remoteManifest, remoteApkDir, beforeSha, beforeManifest });
      state.rolledBack = true;
      if (verifyError) throw verifyError;
      log.ok('演练完成：上传 / 清单改动 / 回滚三条都真的走了一遍，线上无残留');
    } else if (verifyError) {
      throw verifyError;
    } else {
      log.head('发布成功 —— 清单条目');
      console.log(JSON.stringify(entry, null, 2));
      log.info(`回滚：ssh ${opts.sshHost} 'mv ${backupPath} ${remoteManifest}' && ssh ${opts.sshHost} 'rm -f ${remoteApkDir}/${fileName}'`);
      log.info(`证据：见上方「验证」段；五项核对全部通过`);
    }
  } catch (e) {
    console.error(`\n执行失败：${e.message}`);
    if (state.rolledBack) {
      console.error('\n（本次是 --exercise，线上现场已经全量回滚 —— 上面的失败只是演练本身没通过。）');
    } else if (state.uploaded || state.manifestWritten) {
      console.error('\n线上可能已半改，按下面顺序回滚（先清单、再文件）：');
      if (state.backupPath) console.error(`  ssh ${opts.sshHost} 'mv -f ${quote(state.backupPath)} ${quote(remoteManifest)}'`);
      console.error(`  ssh ${opts.sshHost} 'rm -f ${quote(`${remoteApkDir}/${fileName}`)}'`);
      for (const t of state.remoteTmpFiles) console.error(`  ssh ${opts.sshHost} 'rm -f ${quote(t)}'`);
    }
    process.exit(1);
  }
}

/**
 * 发布后验证（就是 PR 里要贴的那五项证据）：
 *   1. `curl -I` 直链 → 200 + 正确 Content-Type + Content-Length == 本地 size
 *   2. 下载回来 sha256 == 本地产物 sha256 == 清单里的 sha256
 *   3. `curl releases.json` 的 latest 与发布前**逐字节相同**
 *   4. 线上清单里能读到这条新记录，且 file/size/sha256 与本次一致
 *   5. 既有 19 条原样（逐条 JSON 相同）
 */
function verifyLive({ opts, fileName, fileUrl, hashes, beforeManifest, entry }) {
  const errors = [];

  const head = run('curl', ['-sS', '-I', fileUrl], { timeout: 60_000 }).stdout;
  const status = Number((/^HTTP\/[\d.]+ (\d{3})/m.exec(head) || [])[1] || 0);
  const contentType = ((/\r?\ncontent-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim();
  const contentLength = Number(((/\r?\ncontent-length:\s*(\d+)/i.exec(head) || [])[1] || 0));
  log.info(`curl -I ${fileUrl}`);
  log.info(`  → HTTP ${status}  content-type: ${contentType}  content-length: ${contentLength}`);
  if (status !== 200) errors.push(`直链不是 200（拿到 ${status}）`);
  if (contentType !== APK_CONTENT_TYPE) errors.push(`Content-Type 不对：${contentType || '(缺)'}，要求 ${APK_CONTENT_TYPE}`);
  if (contentLength !== hashes.size) errors.push(`Content-Length ${contentLength} != 本地 size ${hashes.size}`);

  const dl = path.join(os.tmpdir(), `verify-${fileName}`);
  run('curl', ['-sS', fileUrl, '-o', dl], { timeout: 300_000 });
  const got = hashFile(dl);
  fs.rmSync(dl, { force: true });
  log.info(`curl ${fileUrl} | sha256sum`);
  log.info(`  → ${got.sha256}（本地 ${hashes.sha256}）`);
  if (got.sha256 !== hashes.sha256) errors.push(`下载件的 sha256 与本地不一致：${got.sha256} != ${hashes.sha256}`);

  // latest 逐字节比较：抓线上文本里 `"latest": "<x>"` 那一行，与发布前文本的同一行逐字节比
  const liveText = run('curl', ['-sS', `${opts.publicBase}releases.json`], { timeout: 60_000 }).stdout;
  const latestLine = (text) => (/"latest"\s*:\s*("[^"]*")/.exec(text) || [])[1] || '';
  const beforeLine = latestLine(JSON.stringify(beforeManifest, null, 2) + '\n');
  const afterLine = latestLine(liveText);
  log.info(`curl ${opts.publicBase}releases.json | grep latest`);
  log.info(`  → 发布前 ${beforeLine} / 发布后 ${afterLine}`);
  if (beforeLine !== afterLine) errors.push(`latest 变了：${beforeLine} → ${afterLine}`);
  if (afterLine !== JSON.stringify(beforeManifest.latest)) {
    errors.push(`latest 不是发布前的 ${JSON.stringify(beforeManifest.latest)}：${afterLine}`);
  }

  let live = null;
  try {
    live = JSON.parse(liveText);
  } catch (e) {
    errors.push(`线上清单读不出来了：${e.message}`);
  }
  if (live) {
    const rec = live.releases.find((r) => r.version === entry.version && r.artifactVariant === entry.artifactVariant);
    if (!rec) errors.push(`线上清单里没有本次条目：${entry.version}（${entry.artifactVariant}）`);
    else {
      if (rec.sha256 !== entry.sha256) errors.push(`清单里的 sha256 与产物不一致：${rec.sha256}`);
      if (rec.file !== entry.file) errors.push(`清单里的 file 与产物不一致：${rec.file}`);
      if (rec.size !== entry.size) errors.push(`清单里的 size 与产物不一致：${rec.size}`);
      log.info(`线上条目：${rec.version} code=${rec.versionCode} variant=${rec.artifactVariant} file=${rec.file} sha256=${rec.sha256}`);
    }
    for (const old of beforeManifest.releases) {
      const still = live.releases.find(
        (r) => r && r.version === old.version && (r.artifactVariant ?? null) === (old.artifactVariant ?? null),
      );
      if (!still || JSON.stringify(still) !== JSON.stringify(old)) {
        errors.push(`既有条目被动过：${old.version}${old.artifactVariant ? `（${old.artifactVariant}）` : ''}`);
      }
    }
    log.info(`既有 ${beforeManifest.releases.length} 条逐条比对：${errors.length ? '有差异' : '全部原样'}`);
  }

  if (errors.length) throw new CliError(`发布后验证失败：\n  - ${errors.join('\n  - ')}`);
  log.ok('五项验证通过：200 + Content-Type + Content-Length / 下载 sha256 一致 / latest 未变 / 条目在清单里 / 既有条目原样');
  return true;
}

/**
 * 全量回滚：恢复清单 → 删包 → 再验证（直链 404、清单 sha256 与演练前逐字节一致）
 */
function rollback({ opts, state, fileName, remoteManifest, remoteApkDir, beforeSha, beforeManifest }) {
  const remoteFile = `${remoteApkDir}/${fileName}`;

  if (state.backupPath) {
    sshExec(opts.sshHost, `mv -f ${quote(state.backupPath)} ${quote(remoteManifest)}`);
    log.ok(`清单已从备份恢复：${state.backupPath}`);
  }
  sshExec(opts.sshHost, `rm -f ${quote(remoteFile)}`);
  log.ok(`已删除上传的文件：${remoteFile}`);
  for (const t of state.remoteTmpFiles) sshExec(opts.sshHost, `rm -f ${quote(t)}`);

  const afterRollbackSha = sshExec(opts.sshHost, `sha256sum ${quote(remoteManifest)}`).stdout.trim().split(/\s+/)[0];
  log.info(`清单 sha256：演练前 ${beforeSha} / 回滚后 ${afterRollbackSha}`);
  const errors = [];
  if (afterRollbackSha !== beforeSha) errors.push(`回滚后清单 sha256 与演练前不一致：${afterRollbackSha} != ${beforeSha}`);

  const remoteText = sshExec(opts.sshHost, `cat ${quote(remoteManifest)}`).stdout;
  const line = (text) => (/"latest"\s*:\s*("[^"]*")/.exec(text) || [])[1] || '';
  if (line(remoteText) !== line(JSON.stringify(beforeManifest, null, 2) + '\n')) {
    errors.push(`回滚后 latest 与演练前不一致：${line(remoteText)}`);
  }
  try {
    const back = JSON.parse(remoteText);
    if (back.releases.length !== beforeManifest.releases.length) {
      errors.push(`回滚后条目数 ${back.releases.length} != 演练前 ${beforeManifest.releases.length}`);
    }
    if (JSON.stringify(back) !== JSON.stringify(beforeManifest)) errors.push('回滚后的清单内容与演练前不是同一份');
  } catch (e) {
    errors.push(`回滚后清单读不出来：${e.message}`);
  }

  const status = Number(
    (/^HTTP\/[\d.]+ (\d{3})/m.exec(run('curl', ['-sS', '-I', `${opts.publicBase}${APK_SUBDIR}/${fileName}`], { timeout: 60_000 }).stdout) || [])[1] || 0,
  );
  log.info(`curl -I 直链 → HTTP ${status}（期望 404 = 文件确实删了）`);
  if (status !== 404) errors.push(`回滚后直链不是 404（拿到 ${status}）——文件还在`);

  // 备份文件已被上面的 `mv` 消耗掉（这才是「零残留」）；逐个确认没留下东西
  const residue = sshExec(
    opts.sshHost,
    [
      `test -e ${quote(remoteFile)} && echo FILE_LEFT || echo FILE_GONE`,
      `test -e ${quote(state.backupPath || `${remoteManifest}.never`)} && echo BAK_LEFT || echo BAK_GONE`,
      ...state.remoteTmpFiles.map((t) => `test -e ${quote(t)} && echo TMP_LEFT || echo TMP_GONE`),
    ].join('; '),
  ).stdout.trim().split('\n');
  log.info(`残留检查：${residue.join(' / ')}`);
  if (residue.some((l) => l.endsWith('_LEFT'))) errors.push(`回滚后还有残留：${residue.filter((l) => l.endsWith('_LEFT')).join('、')}`);

  if (errors.length) throw new CliError(`回滚没干净：\n  - ${errors.join('\n  - ')}`);
  log.ok(`回滚验证：直链 404、清单 sha256 与演练前逐字节一致（${beforeSha}）、latest 未变、无残留`);
}

// 被 import（单测）时不要跑 cli：只有直接执行才进 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n[${e.name || 'Error'}] ${e.message}`);
    process.exit(e.exitCode || 1);
  });
}

export { ROOT, run, sshExec, scpTo };
