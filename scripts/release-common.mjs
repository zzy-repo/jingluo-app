#!/usr/bin/env node
/**
 * release-common.mjs —— 发布脚本共用的零依赖工具（Issue #107）
 *
 * 这里只放「三个 release-*.mjs 都要用、且必须口径一致」的东西：
 *   - package.json 读版本号（唯一来源）
 *   - CHANGELOG.md 抽 changes（dl 的 meta.changes 与 Release notes 的同一来源）
 *   - 文件 sha256 / md5 / size
 *   - 发布令牌的解析（**只返回来源，绝不返回、打印内容**）
 *   - APK 内元信息（versionName / versionCode / 包名 / 变体标记），零依赖解二进制 AndroidManifest
 *
 * 设计原则：缺 key、缺文件、格式不对时**在发请求之前**就报清楚并退出 2，
 * 不允许「跑到一半失败」留下半个状态（这是 release-apk.sh 被删掉的原因，见 RELEASE.md）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { inspectApkDebugState, parseBinaryXml, readZipEntry } from '../deploy/dl-release/apk-manifest.mjs';
import { loadAppIdentity } from './lib/appIdentity.mjs';

/**
 * 应用包名（服务端白名单，写错直接 400 INVALID_APK）
 * 唯一来源：仓库根 config/appIdentity.json（Issue #271）。以前这里是第 3 份副本，
 * 和 android/app/build.gradle 的 applicationId 之间没有任何门禁 —— 改了包名就发一个
 * 服务端不认的包，或者校验一个打包时根本没用上的名字。
 */
export const PACKAGE_NAME = loadAppIdentity().applicationId;
/** 服务端硬上限（docs/dl-release-api.md §2） */
export const MAX_APK_BYTES = 50 * 1024 * 1024;
/** versionName 格式（与 android/app/build.gradle、docs/releases-manifest.md 同口径） */
export const RE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
export const RE_SHA256 = /^[0-9a-f]{64}$/;
export const RE_MD5 = /^[0-9a-f]{32}$/;
/** 变体标记的 meta-data 名（APK 内，受签名覆盖） */
export const VARIANT_META_NAME = `${PACKAGE_NAME}.ARTIFACT_VARIANT`;

export const DEFAULT_ENDPOINT = 'https://dl.rose7.cn/api/v1/release';
export const DEFAULT_MANIFEST = 'https://dl.rose7.cn/releases.json';
export const DEFAULT_BASE_URL = 'https://dl.rose7.cn/';

/** 环境/前置条件不满足（不是发布失败，是还没开始就做不了） */
export class ReleaseEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseEnvError';
  }
}

/**
 * 逐个试候选路径，返回第一个存在的（不抛错）
 * @param {...string} candidates
 * @returns {string|null}
 */
export function firstExisting(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略权限等异常，继续下一个候选 */
    }
  }
  return null;
}

/** 读 JSON；失败抛 ReleaseEnvError（带路径，不含内容） */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ReleaseEnvError(`读不了 JSON：${file}（${e.message}）`);
  }
}

/**
 * 读 package.json 的版本号（唯一来源：version → versionName，androidVersionCode → versionCode）
 * @param {string} root 仓库根
 * @returns {{file:string, version:string|null, versionCode:number|null, errors:string[]}}
 */
export function readPackageVersion(root) {
  const file = path.join(root, 'package.json');
  const errors = [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, version: null, versionCode: null, errors: [`读不了 ${file}: ${e.message}`] };
  }
  const rawVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  const rawCode = pkg.androidVersionCode;
  let versionCode = null;
  if (typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode > 0) versionCode = rawCode;
  else if (typeof rawCode === 'string' && /^\d+$/.test(rawCode.trim()) && Number(rawCode.trim()) > 0) {
    versionCode = Number(rawCode.trim());
  }
  if (!rawVersion) errors.push('package.json 缺 version');
  else if (!RE_VERSION.test(rawVersion)) {
    errors.push(`package.json 的 version 格式非法（期望 x.y.z 或 x.y.z-beta.N）：'${rawVersion}'`);
  }
  if (versionCode === null) {
    errors.push(`package.json 的 androidVersionCode 缺失或非法（必须是正整数）：'${String(rawCode)}'`);
  }
  return { file, version: rawVersion || null, versionCode, errors };
}

/**
 * 从 CHANGELOG.md 的 `## <version> (...)` 段抽用户可见的 `- ` 条目。
 * 只取该段、遇到下一个 `## ` 就停；跳过 `>` 引用的内部验收记录。
 * @param {string} text
 * @param {string} version
 * @returns {{found:boolean, changes:string[]}}
 */
export function changesFromChangelog(text, version) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l.trim()));
  if (start < 0) return { found: false, changes: [] };
  const changes = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (/^>\s?/.test(line.trim())) continue; // 内部验收记录不算用户可见变更
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) changes.push(m[1]);
  }
  return { found: true, changes };
}

/** CHANGELOG.md 是否存在 `## <version>` 段 */
export function changelogHasVersion(text, version) {
  return changesFromChangelog(text, version).found;
}

/**
 * 流式算 size / sha256 / md5（APK 约 6 MB，分块只为不把大文件整块读两遍）
 * @param {string} file
 * @returns {{path:string,size:number,sha256:string,md5:string}}
 */
export function hashFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new ReleaseEnvError(`产物不存在：${file}`);
  }
  if (!st.isFile()) throw new ReleaseEnvError(`不是文件：${file}`);
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      sha.update(buf.subarray(0, read));
      md5.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { path: path.resolve(file), size: st.size, sha256: sha.digest('hex'), md5: md5.digest('hex') };
}

/**
 * APK 内的真实元信息（零依赖解二进制 AndroidManifest.xml，不需要 aapt2 / Android SDK）。
 * 判不出来的字段返回 null —— 调用方必须按「没测到」处理，不许当成通过。
 * @param {string} file
 * @returns {{packageName:string|null, versionName:string|null, versionCode:number|null,
 *            debuggable:true|false|null, debuggableReason:string, variant:string|null, note:string|null}}
 */
export function inspectApk(file) {
  const out = {
    packageName: null,
    versionName: null,
    versionCode: null,
    debuggable: null,
    debuggableReason: 'unknown',
    variant: null,
    note: null,
  };
  const dbg = inspectApkDebugState(file);
  out.debuggable = dbg.debuggable;
  out.debuggableReason = dbg.reason;
  const info = dbg.info || {};
  if (typeof info.packageName === 'string') out.packageName = info.packageName;
  if (typeof info.versionName === 'string') out.versionName = info.versionName;
  if (typeof info.versionCode === 'number') out.versionCode = info.versionCode;
  if (!out.versionName && info.versionName === undefined) {
    out.note = 'versionName 解析不出来（可能是资源引用），用 aapt2 dump badging 复核';
  }

  // 变体标记：<meta-data android:name="…ARTIFACT_VARIANT" android:value="internal|standard">
  try {
    const axml = readZipEntry(fs.readFileSync(file), 'AndroidManifest.xml');
    const doc = parseBinaryXml(axml);
    const str = (a) => {
      if (!a) return null;
      if (typeof a.rawValue === 'string') return a.rawValue;
      if (a.dataType === 0x03 && Array.isArray(doc.strings)) return doc.strings[a.data] ?? null;
      return null;
    };
    for (const el of doc.elements) {
      if (el.name !== 'meta-data') continue;
      const nameAttr = el.attrs.find((a) => a.name === 'name');
      if (str(nameAttr) !== VARIANT_META_NAME) continue;
      const valueAttr = el.attrs.find((a) => a.name === 'value');
      const v = str(valueAttr);
      if (v === 'internal' || v === 'standard') out.variant = v;
      break;
    }
  } catch (e) {
    out.note = `${out.note ? `${out.note}；` : ''}变体标记读不到：${e.message}`;
  }
  return out;
}

/** 平台相关的默认令牌文件位置：~/.config/dl-release/token（Windows 落在 %USERPROFILE%） */
export function defaultTokenFile() {
  return path.join(os.homedir(), '.config', 'dl-release', 'token');
}

/**
 * 解析发布令牌。**返回值只带来源，带内容的那一半只交给调用方发请求，任何地方都不许打印。**
 *
 * 优先级：--token-file → $DL_RELEASE_TOKEN_FILE → $DL_RELEASE_TOKEN → ~/.config/dl-release/token
 *
 * @param {{tokenFile?: string|null, required?: boolean, env?: NodeJS.ProcessEnv}} opts
 * @returns {{token:string|null, source:string, warning:string|null}}
 */
export function resolveReleaseToken(opts = {}) {
  const env = opts.env || process.env;
  const required = opts.required !== false;
  const candidates = [
    { source: '--token-file', file: opts.tokenFile || null },
    { source: '$DL_RELEASE_TOKEN_FILE', file: env.DL_RELEASE_TOKEN_FILE ? String(env.DL_RELEASE_TOKEN_FILE) : null },
    { source: '~/.config/dl-release/token', file: defaultTokenFile() },
  ];
  const warnings = [];

  const fromEnv = env.DL_RELEASE_TOKEN ? String(env.DL_RELEASE_TOKEN).trim() : '';
  if (fromEnv) {
    if (fromEnv.length < 16) {
      throw new ReleaseEnvError(
        `环境变量 DL_RELEASE_TOKEN 只有 ${fromEnv.length} 个字符，明显不是一个发布令牌（内容不打印）。\n` +
          '  正确做法见 docs/RELEASE-CHECKLIST.md §4；令牌值永远不要贴进 Issue / 聊天 / 提交。',
      );
    }
    return { token: fromEnv, source: '$DL_RELEASE_TOKEN', warning: null };
  }

  for (const c of candidates) {
    if (!c.file) continue;
    if (!fs.existsSync(c.file)) {
      if (c.source.startsWith('--')) {
        throw new ReleaseEnvError(`--token-file 指向的文件不存在：${c.file}`);
      }
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(c.file, 'utf8');
    } catch (e) {
      throw new ReleaseEnvError(`读不了令牌文件 ${c.file}（${e.code || e.message}）；不要用 root 建给别人读不了的文件`);
    }
    const token = raw.trim();
    if (!token) throw new ReleaseEnvError(`令牌文件是空的：${c.file}`);
    if (token.length < 16) {
      throw new ReleaseEnvError(`令牌文件 ${c.file} 里只有 ${token.length} 个字符，不像一个发布令牌（内容不打印）`);
    }
    if (process.platform !== 'win32') {
      try {
        const mode = fs.statSync(c.file).mode;
        if (mode & 0o077) warnings.push(`${c.file} 权限是 ${(mode & 0o777).toString(8)}，建议 chmod 600（同组/其他用户能读）`);
      } catch {
        /* 权限查不到就算了，不影响发布 */
      }
    }
    return { token, source: c.source === '--token-file' ? c.file : c.source, warning: warnings[0] || null };
  }

  if (!required) return { token: null, source: '(未提供)', warning: null };

  throw new ReleaseEnvError(
    [
      '拿不到发布令牌（dl-release token），上传不会开始。',
      '',
      '任选一种注入方式（详见 docs/RELEASE-CHECKLIST.md §4）：',
      '  1) 环境变量：export DL_RELEASE_TOKEN=<release-token>     # 只在当前 shell 生效，不落盘',
      '  2) 令牌文件：mkdir -p ~/.config/dl-release && printf %s <release-token> > ~/.config/dl-release/token',
      '              chmod 600 ~/.config/dl-release/token',
      '  3) 显式指定：node scripts/release-upload.mjs --token-file /path/to/token',
      '',
      '令牌从哪来：找持有 dl-release 服务的维护者按人发放（一人一枚、可单独轮换撤销），',
      '不要自己猜、不要去 ECS 上 cat、更不要把它贴进 Issue / 聊天 / 仓库。',
      '令牌泄露的止损流程见 docs/RELEASE-CHECKLIST.md §4.4（先轮换令牌，再查审计日志）。',
    ].join('\n'),
  );
}

/**
 * buildType 的唯一来源是 `shared/build-types.mjs`（Issue #330）。
 * 对外继续导出 buildTypeFor / BUILD_TYPES / isBuildType，4 处调用点（release-upload /
 * release-verify / release-check / 本文件内部）一行都不用改 —— 唯一改动是「谁定义」。
 * 以前这里内联 `-(alpha|beta|rc)` 判定 + 两个字面量，那就是 8 份副本里的一份。
 */
export { BUILD_TYPES, BUILD_TYPE_SUFFIX_RE, buildTypeFor, isBuildType } from '../shared/build-types.mjs';

/** 读 android/app/build.gradle 的 EXPECTED_CERT_SHA256（避免指纹在文档里再抄一份） */
export function expectedCertSha256(root) {
  const file = path.join(root, 'android', 'app', 'build.gradle');
  try {
    const m = /EXPECTED_CERT_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 解析命令行：--flag value / --flag=value / --bool / 位置参数 */
export function parseArgs(argv, { flags = [], multi = [] } = {}) {
  const out = { _: [] };
  for (const f of multi) out[f] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm 会把 `pnpm run x -- --flag` 里的 `--` 原样转发给脚本；它不是参数也不是结束符。
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    if (flags.includes(key)) {
      out[key] = inline === null ? true : inline !== 'false';
      continue;
    }
    if (multi.includes(key)) {
      const value = inline === null ? argv[++i] : inline;
      if (value === undefined) throw new ReleaseEnvError(`--${key} 缺参数值`);
      out[key].push(value);
      continue;
    }
    const value = inline === null ? argv[++i] : inline;
    if (value === undefined) throw new ReleaseEnvError(`--${key} 缺参数值`);
    out[key] = value;
  }
  return out;
}

/** 输出进度行（三种前缀与仓库其它校验脚本同口径） */
export const log = {
  ok: (m) => console.log(`  ok    ${m}`),
  warn: (m) => console.log(`  warn  ${m}`),
  fail: (m) => console.log(`  FAIL  ${m}`),
  info: (m) => console.log(`  ---- ${m}`),
  head: (m) => console.log(`\n[${m}]`),
};
