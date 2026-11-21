#!/usr/bin/env node
/**
 * audit-release.mjs —— 一条命令把「某个已发布 tag 是否合格」全部查完。
 *
 * ## 为什么要有它（今天手工跑了两遍，每遍 10+ 分钟）
 *
 * 2026-11-21 这天，`v1.4.7` 与 `v1.4.8` 各被**手工**审计了一遍，每次都是同一串动作：
 *
 *     下载资产 → sha256（三工具）→ debuggable（三判据）→ 证书 → verify:apk
 *     → tag 是否 ∈ main → 正文禁词 → 包内端点 grep → UI/功能是否真在包里
 *
 * 单看每一条都有脚本或命令，**但没有任何一条把它们串起来**。后果不是「某条不会跑」，而是：
 *   · 顺序靠人记（先下包再算 hash，还是先看正文？漏了哪一步没有任何提示）；
 *   · 判据散在 `docs/RELEASE-MANUAL.md` 的表格与 `docs/release/staging-release-runbook.md` 的手打命令里，
 *     换个 lane、换个人就会少做一项 —— 而「少做了一项」与「这一项通过了」在输出里长得一模一样；
 *   · 两次审计的结论没法逐字对比（一次贴 sha256、一次贴表格）。
 *
 * 所以这里把**十项判据 + 一条只报告不判红的端点清单**折成一张表、一个退出码。
 *
 * ## 判据表（任一 FAIL → exit 1；判不了 → exit 2）
 *
 * | # | id | 检查 | 判据 |
 * |---|----|------|------|
 * | 1 | `release-published` | release 存在且**已发布** | `isDraft === true` → 判不了（exit 2）：draft 不是发布物，先 publish 再来审计 |
 * | 2 | `assets` | **资产恰好 1 个** | 多于 1 个 → exit 1 并**点名多出来的**；0 个 → 判不了（exit 2） |
 * | 3 | `ancestry` | tag 指向的提交是 `origin/main` 的祖先 | 复用 `scripts/check-release-traceability.mjs` 的 `resolveTagCommit` / `ancestry`（**不重写第二份**） |
 * | 4 | `sha256` | 正文声明的 SHA-256 == 资产实际字节重算 | 正文没写 → WARN 并点名（「没声明」不等于「声明错了」）；三工具（node:crypto / sha256sum / openssl）互相不一致 → exit 1 |
 * | 5 | `size` | 正文声明的大小 == 资产元数据 == 本地实际字节 | 同上：正文没写 → WARN |
 * | 6 | `debuggable` | `apkanalyzer` + `aapt` 双判据，且与 `check-apk-debuggable.mjs` 的判定三方交叉 | 缺 `aapt` / `apkanalyzer` → 判不了（exit 2），不回落到单判据 |
 * | 7 | `cert` | `apksigner verify --print-certs` 的 SHA-256 == `config/appIdentity.json` 的 `expectedCertSha256` | 比较逻辑复用 `scripts/lib/certFingerprint.mjs`（唯一读取实现，**不留内置默认值**） |
 * | 8 | `verify-apk` | `scripts/verify-release-apk.mjs --variant standard` **五项全过** | 包内 `INSECURE_CONSUME=true` 且没带 `--allow-insecure` → exit 1，并给出「加 `--allow-insecure` 只用于 staging 联调」的提示 |
 * | 9 | `forbidden-words` | 正文里不得出现内网 IP 段 / webroot 路径 / 内部清单名 / `primaryBase` / `token` | 命中 → exit 1 并**点名行号**（只印行号与命中的禁词，不印整行 —— 否则审计报告自己就成了新的泄漏面） |
 * | 10 | `endpoints` | 包内 bundle 里出现的 http(s) 主机去重清单（**只报告，不判红**） | 供人眼核对「连的是谁」；解析不了 → WARN |
 * | 11 | `expect-version` | `--expect-version X.Y.Z` 与包内 `versionName` 一致（**传了才查**） | 不一致 → exit 1；这是「拿错包 / 拿错 tag」的负向对照 |
 *
 * ## 不重复实现（本文件只做「编排 + 判据表」，判定一律 import）
 *
 *   · 证书读取/断言 → `scripts/lib/certFingerprint.mjs`（`resolveExpectedCertSha256` 等）
 *   · 溯源判定     → `scripts/check-release-traceability.mjs` 导出的 `resolveTagCommit` / `ancestry` / `deriveRepo`
 *   · 五件套       → `scripts/verify-release-apk.mjs` 的 `verifyReleaseApk`（它自己又复用了 `check-apk-debuggable` / `variant`）
 *   · 证书摘要解析 → `scripts/verify-release-apk.mjs` 导出的 `parseCertDigests`
 *   · zip / AXML   → `deploy/dl-release/apk-manifest.mjs` 的 `listZipEntries` / `readZipEntryRecord`
 *   · SDK 定位     → `scripts/lib/androidTools.mjs` 的 `resolveBuildTools` / `findTool` / `resolveAndroidHome`
 *
 * 为什么溯源要**动态 import**：`scripts/check-release-traceability.mjs` 在 #738 落地前不在所有分支上。
 * 「文件不在」必须写成**判不了（exit 2）并点名 #738**，而不是在这里抄一份 `merge-base --is-ancestor`
 * —— 抄一份的后果是两处判据迟早给出相反结论（这正是 `check-apk-debuggable.mjs` 文件头警告过的失效模式）。
 *
 * ## 只读
 *
 * 本脚本**只读 GitHub**：`gh release view` / `gh release download`。不 publish、不删、不改 release，
 * 也不动 `config/endpoints.json` 与任何业务代码。要改正文 / 删多余资产，人自己去 GitHub 改（报告里点名该去哪个单）。
 *
 * ## 用法
 *
 *   node scripts/audit-release.mjs v1.4.8
 *   node scripts/audit-release.mjs v1.4.8 --expect-version 1.4.8
 *   node scripts/audit-release.mjs v1.4.8-staging --allow-insecure     # 明文联调包
 *   node scripts/audit-release.mjs v1.4.8 --json                       # 机器可读
 *   node scripts/audit-release.mjs v1.4.8 --repo zzy-repo/deepseek-app  # 显式仓库（默认从 origin 派生）
 *   node scripts/audit-release.mjs v1.4.8 --keep                       # 保留下载的资产（排查用）
 *   pnpm audit:release v1.4.8
 *
 * ## 退出码
 *
 *   0  所有判据 PASS（WARN 不算红：比如正文没写 sha256）
 *   1  有判据**明确不过**（正文与实际不一致 / 资产多于 1 个 / tag 不在 main / debuggable / 证书 / 五件套 / 禁词 / 版本号）
 *   2  **判不了**（release 不存在或是 draft / 资产下不下来 / 缺 SDK 工具 / 缺溯源脚本 / 参数错）
 *      —— 与 `check-apk-debuggable` / `verify-release-apk` 同口径：判不了同样禁止宣布「这版合格」。
 *
 * 退出码取**优先级**：有 FAIL 就是 1（哪怕同时有判不了的项），否则有 UNKNOWN 就是 2，否则 0。
 *
 * ## 边界（别夸大）
 *
 *   · 不验「UI/功能是否真在包里」——那要看界面，属于烟测（`docs/RELEASE-MANUAL.md` 的模拟器章节）；
 *     本脚本只证明「这个包里连的是谁 / 签名是谁 / 摘要对不对 / tag 在不在主线」。
 *   · 端点清单是**报告**，不是门禁：内网地址该不该出现由 #745 的 `check:public-artifact-redaction` 判，
 *     这里重复判一遍只会制造第二份判据。
 *   · 不下载时（`--no-download` 仅用于离线排查正文层判据）4/5/6/7/8/10 一律判不了，绝不「跳过当通过」。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateApkDebuggable } from './check-apk-debuggable.mjs';
import { parseCertDigests, verifyReleaseApk } from './verify-release-apk.mjs';
import { resolveExpectedCertSha256 } from './lib/certFingerprint.mjs';
import { findTool, loadBuildEnv, resolveBuildTools } from './lib/androidTools.mjs';
import { listZipEntries, readZipEntryRecord } from '../deploy/dl-release/apk-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GH_BIN = process.env.GH_BIN || 'gh';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_UNKNOWN = 2;

/** 判据状态：pass 通过 / fail 明确不过 / warn 有瑕疵但不算红 / skip 上游已红没判 / unknown 判不了（fail-closed） */
export const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  WARN: 'warn',
  SKIP: 'skip',
  UNKNOWN: 'unknown',
});

/** `gh release view --json` 要取的字段（少取一个字段就等于少一条判据，所以写死在常量里） */
export const RELEASE_JSON_FIELDS = 'tagName,isDraft,isPrerelease,targetCommitish,publishedAt,body,assets';

/** 报告里判据的固定顺序（表格、`--json`、结论都以它为准） */
export const CHECK_ORDER = Object.freeze([
  'release-published',
  'assets',
  'ancestry',
  'sha256',
  'size',
  'debuggable',
  'cert',
  'verify-apk',
  'forbidden-words',
  'endpoints',
  'expect-version',
]);

/**
 * 正文禁词表。
 *
 * **大小写敏感**（一律按字面量匹配，不用正则）：`REFRESH_TOKEN_EXPIRED` 是 v1.4.7 正文里合法的
 * 接口错误码，用不区分大小写的 `token` 去判会把它判红 —— 而禁词治的是**小写字面量泄漏**
 * （`token=…` / `?token=` 这种贴进正文的凭据样式）。
 */
export const FORBIDDEN_NEEDLES = Object.freeze([
  { needle: '140.210.', why: '生产消费机 IP 段' },
  { needle: '62.106.', why: '迁移前旧机 IP 段' },
  { needle: '123.207.', why: '第三方历史 IP 段' },
  { needle: '/var/www', why: '分发机 webroot 绝对路径' },
  { needle: 'releases.json', why: '内部清单文件名（不该出现在用户可见正文）' },
  { needle: 'primaryBase', why: '分发配置内部字段名' },
  { needle: 'token', why: '凭据字样（小写字面量）' },
]);

/**
 * 出问题时「该去哪个单跟进」——报告最后一段用。
 * 这不是装饰：审计的意义在于把红变成一件**有人认领**的事。
 */
export const FOLLOW_UPS = Object.freeze({
  'release-published': { ref: '#652（发布单）', why: 'release 不存在或仍是 draft：先 publish（draft 不算发布物，无从审计）' },
  assets: { ref: '#652（发布单）', why: '资产不唯一：多余资产要在 GitHub 上手工删（本脚本只读，不替你删）' },
  ancestry: { ref: '#651 / #738（发布溯源门禁）', why: 'tag 指向的提交不在 origin/main 历史里：重指 tag 再重建，或按豁免清单登记到期复审' },
  sha256: { ref: '#652（发布单）', why: '正文声明的 SHA-256 与资产实际字节不一致：先确认下到的是发布物，再改正文（不要改期望值去凑绿）' },
  size: { ref: '#652（发布单）', why: '正文声明的字节数与资产实际大小不一致：正文重写' },
  debuggable: { ref: '#60（debug 包闸门）', why: '包里带 android:debuggable：用 assembleRelease 重新出包，这条没有放行通道' },
  cert: { ref: '#702 / #705（证书指纹单一来源）', why: '签名证书与 config/appIdentity.json 的 expectedCertSha256 不一致：换签名是发布级迁移，先停手' },
  'verify-apk': { ref: '#607 / #601（发布五件套）', why: '五项产物校验有项不过：按 verify:apk 打印的那一项修（变体 / 回环 / 明文标记）' },
  'forbidden-words': { ref: '#745（公开产物脱敏）', why: '正文含内网地址 / 内部字段名：改正文重发 notes（用户看得见的那份不许带这些）' },
  endpoints: { ref: '#745（只报告，不判红）', why: '包内端点清单供人眼核对；内网地址该不该出现在正式包里由 check:public-artifact-redaction 判' },
  'expect-version': { ref: '#652（发布单）/ 阶段 A 版本号', why: '期望版本与包内 versionName 不一致：多半是拿错了包或 tag' },
});

// ------------------------------------------------------------------ 小工具

/** 跑一个外部命令；永不抛（超时 / 缺文件都折成 error），调用方按 status/error 判定 */
export function run(cmd, args, { timeoutMs = 180_000 } = {}) {
  const shell = /\.(bat|cmd)$/i.test(cmd);
  const result = spawnSync(shell ? `"${cmd}"` : cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
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

const firstLine = (text) => String(text ?? '').trim().split('\n')[0] ?? '';

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

/** 字节数 → 人话（正文里写 MiB 的版本要能对上，所以两种都给） */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '未知';
  }
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(2)} MiB（${bytes} 字节）` : `${(bytes / 1024).toFixed(1)} KiB（${bytes} 字节）`;
}

// ------------------------------------------------- 正文解析（声明值 / 禁词）

const HEX64_G = /\b[0-9a-f]{64}\b/gi;

/**
 * 从 Release 正文里抠出「这个包是什么」的两条声明：SHA-256 与字节数。
 *
 * 正文格式在历史上换过两次（1.4.5 是 Markdown 表格、1.4.8 是 bullet 列表），所以解析必须
 * **按标签找值**而不是按位置找：
 *   · SHA-256：先排掉「签名证书 SHA-256」那一行（那是**证书**指纹，不是 APK 字节摘要 ——
 *     两者混在一张表里，按「第一个 64 位 hex」去取会偶尔取到证书）；
 *   · 大小：找 `大小 / size / 体积` 标签行里的第一个 4 位以上整数（`6.57 MiB` 那种小数不会被当成字节数）。
 *
 * 解析不出来**不是红**：返回 `null`，由调用方记 WARN 并点名（WARN 的语义是「正文该补，但不影响这次结论」）。
 */
export function parseBodyClaims(body) {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split(/\r?\n/);
  const claims = { sha256: null, size: null };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (claims.sha256 || !/sha-?256/i.test(line)) {
      continue;
    }
    if (/证书|签名|certificate|cert\b|apksigner/i.test(line)) {
      continue;
    }
    const matched = HEX64_G.exec(line);
    HEX64_G.lastIndex = 0;
    if (matched) {
      claims.sha256 = { value: matched[0].toLowerCase(), line: i + 1 };
      continue;
    }
    // 值写在下一行的形态（表格里标题与值被空行/换行切开时）
    const next = lines[i + 1] ?? '';
    const nextMatch = HEX64_G.exec(next);
    HEX64_G.lastIndex = 0;
    if (nextMatch) {
      claims.sha256 = { value: nextMatch[0].toLowerCase(), line: i + 2 };
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/大小|\bsize\b|体积/i.test(line)) {
      continue;
    }
    const matched = /(\d{4,})/.exec(line);
    if (matched) {
      claims.size = { value: Number(matched[1]), line: i + 1 };
      break;
    }
  }

  return claims;
}

/**
 * 正文禁词扫描。命中只回**行号 + 禁词**，不回整行文本：
 * 审计报告会被贴进 Issue / CI 日志，把内网 IP 整行抄出来等于让这份报告变成新的泄漏面。
 *
 * @returns {{hits: Array<{needle: string, why: string, line: number}>}}
 */
export function scanForbiddenWords(body) {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const entry of FORBIDDEN_NEEDLES) {
      if (lines[i].includes(entry.needle)) {
        hits.push({ needle: entry.needle, why: entry.why, line: i + 1 });
      }
    }
  }
  return { hits };
}

// --------------------------------------------------------- 包内端点清单（报告）

/** APK 里可能带构建期注入地址的 Web 产物条目（原生 dex 不扫：那里只有裸字符串，分不清是哪个 key） */
const APK_BUNDLE_ENTRY_RE = /^assets\/.*\.(?:js|mjs)$/i;

/** 单个条目的体积上限：超过就跳过（40MB 的 pdf.worker 之类不必进内存） */
const MAX_BUNDLE_ENTRY_BYTES = 8 * 1024 * 1024;

const PRIVATE_IPV4 = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 把 APK 里 bundle 出现的 http(s) 主机去重列出来。
 *
 * **只报告，不判红**：内网地址该不该出现由 `check-public-artifact-redaction` 判（#745），
 * 这里再判一遍就是第二份判据。这里回答的是「这个包到底连谁」——审计时要能一眼看到。
 *
 * @returns {{ok: boolean, hosts: Array<{url: string, count: number, note: string|null}>,
 *            scanned: string[], skipped: Array<{name: string, why: string}>, reason?: string}}
 */
export function extractEndpointHosts(apkFile, options = {}) {
  let buf;
  try {
    buf = fs.readFileSync(apkFile);
  } catch (error) {
    return { ok: false, hosts: [], scanned: [], skipped: [], reason: `读不到 APK（${error.code ?? error.message}）` };
  }

  let entries;
  try {
    entries = listZipEntries(buf);
  } catch (error) {
    return { ok: false, hosts: [], scanned: [], skipped: [], reason: `不是可读的 ZIP/APK：${error.message}` };
  }

  const maxBytes = options.maxEntryBytes ?? MAX_BUNDLE_ENTRY_BYTES;
  const scanned = [];
  const skipped = [];
  const counts = new Map();

  for (const entry of entries.filter((item) => APK_BUNDLE_ENTRY_RE.test(item.name))) {
    if (entry.plainSize === 0) {
      skipped.push({ name: entry.name, why: '空条目' });
      continue;
    }
    if (entry.plainSize > maxBytes) {
      skipped.push({ name: entry.name, why: `超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限，未扫` });
      continue;
    }
    let text;
    try {
      text = readZipEntryRecord(buf, entry, maxBytes).toString('utf8');
    } catch (error) {
      skipped.push({ name: entry.name, why: `读不出来：${error.message}` });
      continue;
    }
    scanned.push(entry.name);
    for (const match of text.matchAll(/https?:\/\/[A-Za-z0-9._%+-]+(?::\d+)?/g)) {
      const url = match[0];
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
  }

  const hosts = [...counts.entries()]
    .map(([url, count]) => {
      const host = url.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      const note = LOOPBACK_HOSTS.has(host)
        ? '回环'
        : PRIVATE_IPV4.test(host)
          ? '私网/本机地址段'
          : null;
      return { url, count, note };
    })
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));

  return { ok: true, hosts, scanned, skipped };
}

// ------------------------------------------------------------- SDK 工具定位

/** `apkanalyzer` 在 cmdline-tools 里（不在 build-tools），候选取 `latest` 再取已装最高档 */
function findApkanalyzer(androidHome) {
  const candidates = [path.join(androidHome, 'cmdline-tools', 'latest', 'bin', 'apkanalyzer')];
  const cmdlineDir = path.join(androidHome, 'cmdline-tools');
  try {
    for (const entry of fs.readdirSync(cmdlineDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(cmdlineDir, entry.name, 'bin', 'apkanalyzer'));
      }
    }
  } catch {
    // cmdline-tools 不存在 = 没有 apkanalyzer，交给下面统一报
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 审计要用的四个工具：`aapt2` / `apksigner`（来自 build-tools）+ `aapt`（老工具，独立实现）
 * + `apkanalyzer`（cmdline-tools）。
 *
 * 缺任何一个都**不降级**：`aapt` / `apkanalyzer` 是 debuggable 的**独立实现**交叉验证，
 * 少了它们就只剩仓库自带的判定器一条腿 —— 一台机器上 zip 解析被绕过时就没有第二条腿兜底了。
 */
export function resolveAuditTools(options = {}) {
  const root = options.root ?? ROOT;
  const env = options.env ?? process.env;
  const base = resolveBuildTools({
    env,
    buildEnv: loadBuildEnv(root),
    buildToolsVersion: options.buildToolsVersion ?? null,
  });
  if (!base.ok) {
    return { ok: false, detail: base.detail, missing: ['build-tools'], base };
  }
  const aapt = findTool(base.dir, 'aapt');
  const apkanalyzer = findApkanalyzer(base.androidHome);
  const missing = [];
  if (!aapt) {
    missing.push('aapt');
  }
  if (!apkanalyzer) {
    missing.push('apkanalyzer');
  }
  return {
    ok: missing.length === 0,
    missing,
    detail: missing.length
      ? `缺工具：${missing.join(' / ')}（aapt 在 $ANDROID_HOME/build-tools/<版本>/，apkanalyzer 在 $ANDROID_HOME/cmdline-tools/<版本>/bin/）。`
        + '这两个是 debuggable 的独立实现交叉验证，缺了不降级、只判「判不了」。'
      : null,
    aapt2: base.tools.aapt2,
    apksigner: base.tools.apksigner,
    aapt,
    apkanalyzer,
    version: base.version,
    source: base.source,
    dir: base.dir,
    androidHome: base.androidHome,
    base,
  };
}

// --------------------------------------------------------------- 摘要（三工具）

/**
 * 三工具算同一个文件的 sha256：`node:crypto` + `sha256sum` + `openssl`。
 *
 * 为什么不是一个就够：手工审计那天的第一步就是「三行必须逐字相同」——
 * 不同就说明你比的**不是同一个文件**（传输损坏 / 缓存命中错文件 / 磁盘上的是旧包）。
 * 缺那两个二进制（Windows / 精简环境）时只用 node 算，并在报告里写清「只用了一个实现」。
 */
export function computeDigests(file, deps = {}) {
  const runner = deps.run ?? run;
  const results = [];
  try {
    const value = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    results.push({ tool: 'node:crypto', value });
  } catch (error) {
    results.push({ tool: 'node:crypto', value: null, error: error.message });
  }

  const sum = runner('sha256sum', [file]);
  if (!sum.error && sum.status === 0) {
    const value = (sum.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(value)) {
      results.push({ tool: 'sha256sum', value });
    }
  }

  const openssl = runner('openssl', ['dgst', '-sha256', file]);
  if (!openssl.error && openssl.status === 0) {
    const matched = /=\s*([0-9a-f]{64})/i.exec(openssl.stdout);
    if (matched) {
      results.push({ tool: 'openssl', value: matched[1].toLowerCase() });
    }
  }

  const values = new Set(results.filter((item) => item.value).map((item) => item.value));
  return { results, agree: values.size <= 1, value: results[0]?.value ?? null };
}

// ------------------------------------------------------------------ 默认依赖

/** 溯源模块：缺文件 = 判不了（点名 #738），**绝不**在这里抄一份 `merge-base --is-ancestor` */
async function loadTraceability() {
  try {
    return await import('./check-release-traceability.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

function getRelease(repo, tag, { runner = run } = {}) {
  const result = runner(GH_BIN, ['release', 'view', tag, '--repo', repo, '--json', RELEASE_JSON_FIELDS]);
  if (result.error) {
    return { ok: false, reason: `gh 起不来（${result.error.message}）：审计要读 release 元数据，判不了` };
  }
  if (result.status !== 0) {
    const why = firstLine(result.stderr || result.stdout);
    if (/not found|could not resolve|404/i.test(why)) {
      return { ok: false, notFound: true, reason: `仓库 ${repo} 里没有 release \`${tag}\`：${why}` };
    }
    return { ok: false, reason: `\`${result.cmd}\` 退出码 ${result.status}：${why}` };
  }
  try {
    return { ok: true, release: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, reason: `gh 输出不是 JSON（${error.message}）` };
  }
}

function downloadAsset({ repo, tag, asset, dir, runner = run }) {
  fs.mkdirSync(dir, { recursive: true });
  const result = runner(GH_BIN, [
    'release', 'download', tag,
    '--repo', repo,
    '--pattern', asset.name,
    '--dir', dir,
    '--clobber',
  ]);
  if (result.error) {
    return { ok: false, reason: `gh release download 起不来（${result.error.message}）` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `\`${result.cmd}\` 退出码 ${result.status}：${firstLine(result.stderr || result.stdout)}` };
  }
  const file = path.join(dir, asset.name);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `gh 说成功了，但 ${file} 不存在` };
  }
  return { ok: true, file };
}

const defaultDeps = {
  run,
  getRelease: ({ repo, tag }) => getRelease(repo, tag),
  downloadAsset: (options) => downloadAsset(options),
  computeDigests: (file) => computeDigests(file),
  resolveTools: (options) => resolveAuditTools(options),
  evaluateDebuggable: evaluateApkDebuggable,
  verifyApk: verifyReleaseApk,
  loadTraceability,
  expectedCert: null,
  now: () => new Date().toISOString(),
  mktemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-release-')),
};

// ------------------------------------------------------------------ 审计主体

const item = (id, status, detail) => ({ id, status, detail });

const EXIT_BY_STATUS = { [STATUS.FAIL]: EXIT_FAIL, [STATUS.UNKNOWN]: EXIT_UNKNOWN };

/**
 * 审计一个 tag。
 *
 * 所有外部依赖都能注入（`deps`）：单测用桩数据跑判据表，**不下载任何 GitHub 资产**
 * （见 `tests/unit/audit-release.test.mjs`）。
 *
 * @param {{tag: string, expectVersion?: string|null, allowInsecure?: boolean, repo?: string|null,
 *          root?: string, keepTemp?: boolean, deps?: object}} options
 * @returns {Promise<object>} 结构化结果（`--json` 原样打印它）
 */
export async function auditRelease(options = {}) {
  const deps = { ...defaultDeps, ...(options.deps ?? {}) };
  const tag = String(options.tag ?? '').trim();
  const root = options.root ?? ROOT;
  const expectVersion = options.expectVersion ? String(options.expectVersion).replace(/^v/, '').trim() : null;
  const allowInsecure = options.allowInsecure === true;
  const checks = [];
  const push = (id, status, detail) => checks.push(item(id, status, detail));

  // ── 溯源模块 + 仓库定位（两者都是后面的前提）
  const traceability = await deps.loadTraceability();
  let repo = options.repo ?? null;
  let repoSource = options.repo ? '--repo' : null;
  if (!repo && traceability?.deriveRepo) {
    const derived = traceability.deriveRepo(null);
    repo = derived.repo;
    repoSource = derived.source;
  }

  // ── 1. release 存在且已发布
  let release = null;
  if (!repo) {
    push('release-published', STATUS.UNKNOWN, '判不了：仓库名没确定（没有 --repo、origin 也不是 GitHub 地址）');
  } else {
    const fetched = await deps.getRelease({ repo, tag });
    if (!fetched.ok) {
      push('release-published', STATUS.UNKNOWN, fetched.reason);
    } else {
      release = fetched.release;
      if (release.isDraft) {
        push(
          'release-published',
          STATUS.UNKNOWN,
          `release \`${tag}\` 还是 draft（isDraft=true）：draft 不是发布物，先 publish 再来审计`,
        );
      } else {
        push(
          'release-published',
          STATUS.PASS,
          `publishedAt=${release.publishedAt ?? '—'}`
            + `${release.isPrerelease ? '（预发布 prerelease）' : ''}`
            + `${release.targetCommitish ? ` targetCommitish=${release.targetCommitish}` : ''}`,
        );
      }
    }
  }

  // ── 2. 资产恰好 1 个
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.length === 1 ? assets[0] : null;
  if (!release) {
    push('assets', STATUS.UNKNOWN, '判不了：没拿到 release 元数据');
  } else if (assets.length === 0) {
    push('assets', STATUS.UNKNOWN, 'release 上没有资产：没有包可审计（判不了，不是「通过」）');
  } else if (assets.length > 1) {
    const extras = assets.map((item2) => `${item2.name}（${item2.size} 字节）`);
    push('assets', STATUS.FAIL, `${assets.length} 个资产，多出来的：${extras.join(' / ')} —— 发布物应该恰好 1 个`);
  } else {
    push('assets', STATUS.PASS, `${asset.name}（${asset.size} 字节）`);
  }

  // ── 下载（4/5/6/7/8/10 都以「实际的字节」为准，不是以 GitHub 元数据为准）
  let apkFile = null;
  let downloadError = null;
  let tmpDir = null;
  const needApk = Boolean(asset);
  if (needApk && options.noDownload !== true) {
    tmpDir = deps.mktemp();
    try {
      const downloaded = await deps.downloadAsset({ repo, tag, asset, dir: tmpDir });
      if (downloaded.ok) {
        apkFile = downloaded.file;
      } else {
        downloadError = downloaded.reason;
      }
    } catch (error) {
      downloadError = `下载资产抛异常：${error.message}`;
    }
  } else if (needApk) {
    downloadError = '跳过了下载（--no-download）：资产层判据无从校验';
  }

  const apkMissing = (id) => {
    push(id, STATUS.UNKNOWN, `判不了：${downloadError ?? '没有可审计的资产'}`);
  };

  // ── 3. tag 指向的提交 ∈ origin/main（复用溯源门禁，见文件头「不重复实现」）
  if (!traceability) {
    push(
      'ancestry',
      STATUS.UNKNOWN,
      '判不了：仓库里没有 scripts/check-release-traceability.mjs（#738）。'
        + '这条判据只允许有一个实现，本脚本不会抄第二份 —— #738 落地后重跑。',
    );
  } else {
    try {
      const resolved = traceability.resolveTagCommit(tag);
      const verdict = traceability.ancestry(resolved.commit);
      const short = resolved.commit.slice(0, 8);
      if (verdict.ancestor) {
        push('ancestry', STATUS.PASS, `${tag} → ${short}（${resolved.objectType} tag）是 ${traceability.MAIN_REF} 的祖先`);
      } else {
        push(
          'ancestry',
          STATUS.FAIL,
          `${tag} → ${short}（${resolved.objectType} tag）**不是** ${traceability.MAIN_REF} 的祖先`
            + `（共同祖先 ${verdict.commonAncestor ? verdict.commonAncestor.slice(0, 8) : '无 —— 两棵树独立'}）：`
            + '「从 tag 复现问题」拿到的是一棵不在主线上的树',
        );
      }
    } catch (error) {
      push('ancestry', STATUS.UNKNOWN, `判不了：${firstLine(error?.message ?? String(error))}`);
    }
  }

  // ── 4. sha256：正文声明 == 资产实际字节（三工具互校）
  const claims = parseBodyClaims(release?.body);
  let digests = null;
  if (!apkFile) {
    apkMissing('sha256');
  } else {
    digests = deps.computeDigests(apkFile);
    const actual = digests.value;
    if (!digests.agree) {
      push(
        'sha256',
        STATUS.FAIL,
        `三个独立实现算出的 sha256 不一致（${digests.results.map((entry) => `${entry.tool}=${entry.value ?? '失败'}`).join(' / ')}）`
          + '：说明比的不是同一个文件（传输损坏 / 磁盘上的是另一份）',
      );
    } else if (!claims.sha256) {
      push('sha256', STATUS.WARN, `${actual}（${digests.results.map((entry) => entry.tool).join(' + ')}）——**正文没声明 SHA-256**：补一条，否则下载的人无从核对`);
    } else if (claims.sha256.value !== actual) {
      push(
        'sha256',
        STATUS.FAIL,
        `正文声明 ${claims.sha256.value}（正文第 ${claims.sha256.line} 行）≠ 资产实际 ${actual}（${digests.results.map((entry) => entry.tool).join(' + ')}）`,
      );
    } else {
      push('sha256', STATUS.PASS, `${actual}（正文第 ${claims.sha256.line} 行 == ${digests.results.map((entry) => entry.tool).join(' + ')} 重算）`);
    }
  }

  // ── 5. size：正文声明 == 资产元数据 == 本地实际字节
  if (!apkFile) {
    apkMissing('size');
  } else {
    const diskSize = fs.statSync(apkFile).size;
    const metaSize = Number(asset?.size);
    if (!claims.size) {
      push('size', STATUS.WARN, `正文没声明字节数（资产元数据 ${metaSize} 字节 / 本地 ${diskSize} 字节）：补一条大小，下载的人要靠它判断有没有被截断`);
    } else if (claims.size.value !== metaSize || claims.size.value !== diskSize) {
      push(
        'size',
        STATUS.FAIL,
        `正文声明 ${claims.size.value} 字节（正文第 ${claims.size.line} 行）≠ 资产元数据 ${metaSize} ≠ 本地实际 ${diskSize}`,
      );
    } else {
      push('size', STATUS.PASS, `${claims.size.value} 字节（正文第 ${claims.size.line} 行 == 资产元数据 == 本地实际）`);
    }
  }

  // ── 6. debuggable：aapt + apkanalyzer 双判据 + check-apk-debuggable 三判据交叉
  const tools = await deps.resolveTools({ root });
  if (!apkFile) {
    apkMissing('debuggable');
  } else if (!tools.ok) {
    push('debuggable', STATUS.UNKNOWN, `判不了：${tools.detail}`);
  } else {
    const judges = [];
    // 判据 1/3：apkanalyzer 打印出来的 manifest 里有没有 android:debuggable
    const manifest = deps.run(tools.apkanalyzer, ['manifest', 'print', apkFile]);
    if (manifest.error || manifest.status !== 0) {
      judges.push({ name: 'apkanalyzer', status: STATUS.UNKNOWN, detail: firstLine(manifest.stderr || manifest.stdout) || '运行失败' });
    } else {
      const count = manifest.stdout.split(/\r?\n/).filter((line) => line.includes('android:debuggable')).length;
      judges.push({ name: 'apkanalyzer', status: count === 0 ? STATUS.PASS : STATUS.FAIL, detail: `android:debuggable 行数=${count}` });
    }
    // 判据 2/3：aapt dump badging 里的 application-debuggable
    const badging = deps.run(tools.aapt, ['dump', 'badging', apkFile]);
    if (badging.error || badging.status !== 0) {
      judges.push({ name: 'aapt', status: STATUS.UNKNOWN, detail: firstLine(badging.stderr || badging.stdout) || '运行失败' });
    } else {
      const count = badging.stdout.split(/\r?\n/).filter((line) => /application-debuggable/i.test(line)).length;
      judges.push({ name: 'aapt', status: count === 0 ? STATUS.PASS : STATUS.FAIL, detail: `application-debuggable 行数=${count}` });
    }
    // 判据 3/3：仓库自带判定器（唯一判定入口，零依赖）
    const verdict = deps.evaluateDebuggable(apkFile);
    const repoStatus = verdict.verdict === 'clean'
      ? STATUS.PASS
      : verdict.verdict === 'debuggable' ? STATUS.FAIL : STATUS.UNKNOWN;
    judges.push({
      name: 'check-apk-debuggable',
      status: repoStatus,
      detail: verdict.verdict === 'clean' ? '无 android:debuggable' : verdict.reason,
    });

    const failed = judges.filter((judge) => judge.status === STATUS.FAIL);
    const unknown = judges.filter((judge) => judge.status === STATUS.UNKNOWN);
    const summary = judges.map((judge) => `${judge.name}=${judge.status === STATUS.PASS ? 'clean' : judge.status}（${judge.detail}）`).join(' / ');
    if (failed.length) {
      push('debuggable', STATUS.FAIL, `有判据说这是 debuggable 包：${summary}`);
    } else if (unknown.length) {
      push('debuggable', STATUS.UNKNOWN, `判不了（有判据没跑成）：${summary}`);
    } else {
      push('debuggable', STATUS.PASS, summary);
    }
  }

  // ── 7. 证书：apksigner 的 SHA-256 == config/appIdentity.json 的 expectedCertSha256
  if (!apkFile) {
    apkMissing('cert');
  } else if (!tools.ok) {
    push('cert', STATUS.UNKNOWN, `判不了：${tools.detail}`);
  } else {
    const expected = deps.expectedCert ?? resolveExpectedCertSha256(root);
    if (!expected?.value) {
      push('cert', STATUS.UNKNOWN, `判不了：${expected?.source ?? 'config/appIdentity.json'} 里读不到 expectedCertSha256（${expected?.invalid ?? '缺失'}）`);
    } else {
      const verify = deps.run(tools.apksigner, ['verify', '--print-certs', apkFile]);
      const printed = parseCertDigests(`${verify.stdout}\n${verify.stderr}`);
      if (verify.error) {
        push('cert', STATUS.UNKNOWN, `判不了：apksigner 起不来（${verify.error.message}）`);
      } else if (verify.status !== 0) {
        push('cert', STATUS.FAIL, `签名无效 / 未签名（apksigner verify 退出码 ${verify.status}）：${firstLine(verify.stderr || verify.stdout)}`);
      } else if (!printed.length) {
        push('cert', STATUS.UNKNOWN, '判不了：apksigner 没打印任何 SHA-256 指纹');
      } else if (printed.some((digest) => digest !== expected.value)) {
        push('cert', STATUS.FAIL, `包签名 ${printed.join(', ')} ≠ 期望 ${expected.value}（来源 ${expected.source}）`);
      } else {
        push('cert', STATUS.PASS, `${expected.value}（来源 ${expected.source}；apksigner --print-certs 一致）`);
      }
    }
  }

  // ── 8. 五件套（直接调用 verify-release-apk.mjs，不重写判定）
  let verifyResult = null;
  if (!apkFile) {
    apkMissing('verify-apk');
  } else {
    verifyResult = await deps.verifyApk({ apk: apkFile, variant: 'standard', allowInsecure, root });
    const failing = Array.isArray(verifyResult.failing) ? verifyResult.failing : [];
    if (verifyResult.exitCode === EXIT_OK) {
      push('verify-apk', STATUS.PASS, '五项全过（debuggable / 变体 / 回环 / 证书 / 明文标记）');
    } else if (verifyResult.exitCode === EXIT_FAIL) {
      const insecure = verifyResult.insecure === true || failing.includes('insecure');
      const hint = insecure
        ? ' —— 包内 INSECURE_CONSUME=true（明文联调包）：确认只做 staging 联调就显式加 --allow-insecure，'
          + '要公开发布请换 https 重新出包'
        : '';
      push('verify-apk', STATUS.FAIL, `不过的项：${failing.join(' / ') || '（未点名）'}${hint}`);
    } else {
      push('verify-apk', STATUS.UNKNOWN, `判不了：${firstLine(verifyResult.error ?? 'verify:apk 返回 2')}`);
    }
  }

  // ── 11. 期望版本（传了才查；这是「拿错包」的负向对照）
  if (expectVersion) {
    const actualVersion = verifyResult?.info?.versionName ?? null;
    if (!actualVersion) {
      push('expect-version', STATUS.UNKNOWN, `判不了：读不到包内 versionName（--expect-version ${expectVersion}）`);
    } else if (String(actualVersion).trim() !== expectVersion) {
      push('expect-version', STATUS.FAIL, `包内 versionName=${actualVersion} ≠ 期望 ${expectVersion}：多半是拿错了包或 tag`);
    } else {
      push('expect-version', STATUS.PASS, `包内 versionName=${actualVersion}（versionCode=${verifyResult?.info?.versionCode ?? '—'}）`);
    }
  }

  // ── 9. 正文禁词
  {
    const { hits } = scanForbiddenWords(release?.body);
    if (!release) {
      push('forbidden-words', STATUS.UNKNOWN, '判不了：没拿到正文');
    } else if (hits.length) {
      const named = hits.map((hit) => `${hit.needle}（第 ${hit.line} 行，${hit.why}）`);
      push('forbidden-words', STATUS.FAIL, `正文命中 ${hits.length} 处禁词：${named.join(' / ')}`);
    } else {
      push('forbidden-words', STATUS.PASS, `${FORBIDDEN_NEEDLES.length} 个禁词全未命中（大小写敏感，行号见 --json）`);
    }
  }

  // ── 10. 包内端点清单（只报告，不判红）
  let endpoints = null;
  if (!apkFile) {
    apkMissing('endpoints');
  } else {
    endpoints = deps.extractEndpoints ? deps.extractEndpoints(apkFile) : extractEndpointHosts(apkFile);
    if (!endpoints.ok) {
      push('endpoints', STATUS.WARN, `判不了（清单缺失，不影响其它结论）：${endpoints.reason}`);
    } else {
      const privateCount = endpoints.hosts.filter((host) => host.note).length;
      push(
        'endpoints',
        STATUS.PASS,
        `${endpoints.hosts.length} 个主机（扫了 ${endpoints.scanned.length} 个 bundle 条目`
          + `${endpoints.skipped.length ? `，跳过 ${endpoints.skipped.length} 个` : ''}）`
          + `${privateCount ? `；其中 ${privateCount} 个是回环/RFC1918 地址（只报告，标注见清单）` : ''}`,
      );
    }
  }

  // ── 结论
  checks.sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id));
  const failing = checks.filter((entry) => entry.status === STATUS.FAIL).map((entry) => entry.id);
  const unknown = checks.filter((entry) => entry.status === STATUS.UNKNOWN).map((entry) => entry.id);
  const warnings = checks.filter((entry) => entry.status === STATUS.WARN).map((entry) => entry.id);
  const exitCode = failing.length ? EXIT_FAIL : unknown.length ? EXIT_UNKNOWN : EXIT_OK;
  const verdict = failing.length ? 'FAIL' : unknown.length ? 'UNKNOWN' : 'PASS';

  const result = {
    tool: 'audit-release',
    tag,
    repo,
    repoSource,
    verdict,
    exitCode,
    expectVersion,
    allowInsecure,
    checks: checks.map((entry) => ({
      ...entry,
      title: CHECK_TITLES[entry.id] ?? entry.id,
      followUp: EXIT_BY_STATUS[entry.status] ? FOLLOW_UPS[entry.id] ?? null : null,
    })),
    failing,
    unknown,
    warnings,
    followUps: [...failing, ...unknown]
      .map((id) => ({ id, ...(FOLLOW_UPS[id] ?? { ref: '#652（发布单）', why: '未登记的判据，先贴到 #652 让人认领' }) }))
      .filter((entry) => entry.ref),
    release: release
      ? {
        tagName: release.tagName ?? tag,
        isDraft: release.isDraft === true,
        isPrerelease: release.isPrerelease === true,
        publishedAt: release.publishedAt ?? null,
        targetCommitish: release.targetCommitish ?? null,
        bodyLines: String(release.body ?? '').split(/\r?\n/).length,
        sha256Claim: claims.sha256,
        sizeClaim: claims.size,
      }
      : null,
    asset: asset ? { name: asset.name, size: Number(asset.size), url: asset.url ?? null } : null,
    assets: assets.map((entry) => ({ name: entry.name, size: Number(entry.size), url: entry.url ?? null })),
    info: verifyResult?.info ?? null,
    digests: digests ? digests.results : null,
    tools: tools.ok
      ? { ok: true, aapt2: tools.aapt2, aapt: tools.aapt, apkanalyzer: tools.apkanalyzer, apksigner: tools.apksigner, version: tools.version, source: tools.source }
      : { ok: false, missing: tools.missing ?? null, detail: tools.detail ?? null },
    endpoints: endpoints?.ok ? { hosts: endpoints.hosts, scanned: endpoints.scanned, skipped: endpoints.skipped } : null,
    generatedAt: deps.now(),
  };

  if (tmpDir && options.keepTemp !== true) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉不影响结论；报告里不留路径，避免下次误以为是缓存
    }
  }

  return result;
}

// ------------------------------------------------------------------ 报告

const STATUS_LABEL = {
  [STATUS.PASS]: 'PASS   ',
  [STATUS.FAIL]: 'FAIL   ',
  [STATUS.WARN]: 'WARN   ',
  [STATUS.SKIP]: 'SKIP   ',
  [STATUS.UNKNOWN]: 'UNKNOWN',
};

const CHECK_TITLES = {
  'release-published': '已发布（draft=false）',
  assets: '资产恰好 1 个',
  ancestry: 'tag ∈ origin/main',
  sha256: 'sha256 正文 == 实际字节',
  size: '大小 正文 == 实际字节',
  debuggable: 'debuggable 三判据',
  cert: '证书 == appIdentity',
  'verify-apk': 'verify:apk 五项全过',
  'forbidden-words': '正文禁词',
  endpoints: '包内端点清单（只报告）',
  'expect-version': '包内 versionName == 期望',
};

/** 结构化结果 → 人看的报告（表格 + 端点清单 + 结论 + 该去哪个单跟进） */
export function formatReport(result) {
  const lines = [];
  lines.push(`[audit:release] ${result.tag}${result.repo ? ` · ${result.repo}` : ''}${result.repoSource ? `（repo 来自 ${result.repoSource}）` : ''}`);
  if (result.asset) {
    lines.push(`资产  : ${result.asset.name} · ${humanSize(result.asset.size)}`);
  }
  if (result.tools?.ok) {
    // `source` 可能是 `auto-max（$ANDROID_HOME；未钉住 BUILD_TOOLS_VERSION…）`，表格里只留前半段；
    // 完整来源在 `--json` 的 `tools.source` 里
    const source = String(result.tools.source ?? '').split('（')[0];
    lines.push(`工具  : build-tools ${result.tools.version} · ${source} + cmdline-tools 的 apkanalyzer`);
  }
  lines.push('');

  const width = Math.max(...result.checks.map((entry) => displayWidth(CHECK_TITLES[entry.id] ?? entry.id)));
  lines.push(`${pad('#', 1)}  ${pad('检查', width)}  结果     摘要`);
  lines.push(`${'-'.repeat(1)}  ${'-'.repeat(width)}  --------  ${'-'.repeat(20)}`);
  result.checks.forEach((entry, index) => {
    lines.push(`${pad(String(index + 1), 1)}  ${pad(CHECK_TITLES[entry.id] ?? entry.id, width)}  ${STATUS_LABEL[entry.status]}  ${entry.detail}`);
  });

  if (result.endpoints) {
    lines.push('');
    lines.push(`端点清单（只报告，不判红）：${result.endpoints.hosts.length} 个主机，来自 ${result.endpoints.scanned.length} 个 bundle 条目`);
    for (const host of result.endpoints.hosts) {
      lines.push(`  ×${String(host.count).padStart(3)}  ${host.url}${host.note ? `  ← ${host.note}` : ''}`);
    }
    if (result.endpoints.skipped.length) {
      for (const skipped of result.endpoints.skipped) {
        lines.push(`  （跳过 ${skipped.name}：${skipped.why}）`);
      }
    }
  }

  lines.push('');
  const counted = (status) => result.checks.filter((entry) => entry.status === status).length;
  const summaryBits = [
    `PASS ${counted(STATUS.PASS)}`,
    `WARN ${counted(STATUS.WARN)}`,
    counted(STATUS.FAIL) ? `FAIL ${counted(STATUS.FAIL)}` : null,
    counted(STATUS.UNKNOWN) ? `UNKNOWN ${counted(STATUS.UNKNOWN)}` : null,
  ].filter(Boolean).join(' / ');

  if (result.verdict === 'PASS') {
    lines.push(`结论: PASS —— ${result.tag} 合格（${summaryBits}）`);
    if (result.warnings.length) {
      lines.push(`  提醒：${result.warnings.join(' / ')} 是 WARN 不是红（正文声明缺项该补，但不影响这次结论）`);
    }
    lines.push('  无阻塞项。端点清单请人眼核对「连的是谁」；包里该不该有内网地址由 #745 的 check:public-artifact-redaction 判。');
  } else {
    const head = result.verdict === 'FAIL' ? '不合格' : '判不了（结论只能是「不知道」，不能当成合格）';
    lines.push(`结论: ${result.verdict} —— ${result.tag} ${head}（${summaryBits}）`);
    lines.push('该去哪个单跟进：');
    for (const follow of result.followUps) {
      lines.push(`  · ${CHECK_TITLES[follow.id] ?? follow.id} → ${follow.ref}`);
      lines.push(`    ${follow.why}`);
    }
    if (result.verdict === 'UNKNOWN') {
      lines.push('  判不了 ≠ 不合格：补齐工具 / 权限后重跑同一条命令再下结论。');
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI

export function parseArgs(argv) {
  const options = {
    tag: null,
    expectVersion: null,
    allowInsecure: false,
    json: false,
    repo: null,
    keepTemp: false,
    noDownload: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--allow-insecure') {
      options.allowInsecure = true;
    } else if (arg === '--keep') {
      options.keepTemp = true;
    } else if (arg === '--no-download') {
      options.noDownload = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--expect-version') {
      options.expectVersion = argv[++i];
      if (!options.expectVersion) {
        throw new Error('--expect-version 需要一个版本号（如 1.4.8）');
      }
    } else if (arg === '--repo') {
      options.repo = argv[++i];
      if (!options.repo || !options.repo.includes('/')) {
        throw new Error('--repo 需要 owner/name');
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else if (!options.tag) {
      options.tag = arg;
    } else {
      throw new Error(`多余的参数：${arg}（一次只审计一个 tag）`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/audit-release.mjs <tag> [--allow-insecure] [--expect-version X.Y.Z] [--repo owner/name] [--json]',
    '',
    '  <tag>                要审计的已发布 tag（如 v1.4.8）',
    '  --expect-version     断言包内 versionName == X.Y.Z（拿错包 / 拿错 tag 的负向对照）',
    '  --allow-insecure     明确认可这是明文联调包（INSECURE_CONSUME=true，staging-only）',
    '  --repo owner/name    显式指定仓库（默认从 origin remote 派生）',
    '  --json               输出机器可读结果（不打印表格）',
    '  --keep               保留下载的资产（排查用；默认跑完即删）',
    '  --no-download        不下载资产（只查正文层判据；4/5/6/7/8/10 会判「判不了」）',
    '',
    '退出码: 0 全部合格（WARN 不算红）/ 1 有判据明确不过 / 2 判不了（draft、缺工具、缺溯源脚本…）',
  ].join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[ENV] ${error.message}\n${usage()}`);
    return EXIT_UNKNOWN;
  }
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  if (!options.tag) {
    console.error(usage());
    return EXIT_UNKNOWN;
  }
  if (!options.json) {
    console.error(`[audit:release] 审计 ${options.tag} …（下载资产 + 三判据 debuggable + 五件套，约需十几秒）`);
  }
  try {
    const result = await auditRelease({
      tag: options.tag,
      expectVersion: options.expectVersion,
      allowInsecure: options.allowInsecure,
      repo: options.repo,
      keepTemp: options.keepTemp,
      noDownload: options.noDownload,
      root: ROOT,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    return result.exitCode;
  } catch (error) {
    console.error(`[ERROR] ${error?.stack ?? error?.message ?? error}`);
    return EXIT_UNKNOWN;
  }
}

export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
