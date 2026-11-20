#!/usr/bin/env node
/**
 * check-apk-debuggable.mjs —— 发布完整性关卡：APK 不得是 debuggable 构建。
 *
 * 背景（GitHub Issue #60）：`1.0.0` ～ `1.4.0-beta.8` 共 15 个已发布包全部是 debug 变体产物，
 * APK 里编译进了 `android:debuggable="true"`，任何已授权 adb 的机器都能 `run-as` 读私有目录
 * （shared_prefs / WebView 存储里的服务地址、API Key、会话缓存）或挂 JDWP 调试。
 * 根因是发布路径本身（用 `assembleDebug` 出包），所以关卡必须挂在「产物 → 发布」之间，
 * 而不是指望人记得手敲 aapt2。
 *
 * 判据：解 APK 的 zip，取 `AndroidManifest.xml`（二进制 AXML），读 application 元素的
 *       `android:debuggable`（属性名 debuggable 或资源 id 0x0101000f）。
 *
 * 用法：
 *   node scripts/check-apk-debuggable.mjs <apk> [更多.apk ...] [--json] [--quiet]
 *
 * 退出码：
 *   0  全部通过（无 debuggable 标记）→ 允许发布
 *   1  发现 debuggable 包        → 禁止发布
 *   2  判不出来（不是 APK / 损坏 / 用法错误）→ 同样禁止发布（fail-closed）
 *
 * 复用（Issue #607）：判定本身是 `evaluateApkDebuggable(file)` —— 纯函数、可 import，
 * `scripts/verify-release-apk.mjs`（四件套一条命令）调的就是它。**不要另抄一份判定**：
 * 「哪份 aapt2/代码算 debuggable」只允许有一个答案，否则两处判定迟早给出相反结论
 * （#289 的 zip.mjs 就是这么分叉的）。CLI 只在被直接执行时跑（`import` 不会触发 `process.exitCode`）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectApkDebugState } from '../deploy/dl-release/apk-manifest.mjs';

const EXIT_OK = 0;
const EXIT_DEBUGGABLE = 1;
const EXIT_UNKNOWN = 2;

/** 判定口径（供 --json 与复用方判断）：`clean` 可发 / `debuggable` 禁发 / `unknown` 同样禁发 */
export const VERDICT = Object.freeze({ CLEAN: 'clean', DEBUGGABLE: 'debuggable', UNKNOWN: 'unknown' });

/**
 * 对单个 APK 做 debuggable 判定（**唯一判定入口**，CLI 与 verify-release-apk.mjs 共用）。
 *
 * @param {string} file APK 路径
 * @returns {{file: string, verdict: 'clean'|'debuggable'|'unknown', debuggable: true|false|null,
 *            reason: string, info: {packageName?: string, versionName?: string, versionCode?: number}}}
 */
export function evaluateApkDebuggable(file) {
  const r = inspectApkDebugState(file);
  const verdict = r.debuggable === true
    ? VERDICT.DEBUGGABLE
    : r.debuggable === false
      ? VERDICT.CLEAN
      : VERDICT.UNKNOWN;
  return { file, verdict, debuggable: r.debuggable, reason: r.reason, info: r.info ?? {} };
}

function usage() {
  return [
    '用法: node scripts/check-apk-debuggable.mjs <apk> [更多.apk ...] [--json] [--quiet]',
    '',
    '退出码: 0 通过 / 1 发现 debuggable 包（禁止发布）/ 2 判不出来（同样禁止发布）',
  ].join('\n');
}

function main(argv) {
  const files = [];
  let json = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--quiet' || arg === '-q') quiet = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      console.error(`未知参数: ${arg}\n${usage()}`);
      return EXIT_UNKNOWN;
    } else files.push(arg);
  }
  if (!files.length) {
    console.error(usage());
    return EXIT_UNKNOWN;
  }

  const results = files.map((file) => evaluateApkDebuggable(file));

  if (json) {
    console.log(JSON.stringify(results.map((r) => ({
      file: r.file,
      verdict: r.verdict,
      debuggable: r.debuggable,
      reason: r.reason,
      packageName: r.info.packageName ?? null,
      versionName: r.info.versionName ?? null,
      versionCode: r.info.versionCode ?? null,
    })), null, 2));
  } else if (!quiet) {
    for (const r of results) {
      const tag = r.verdict === 'clean' ? '[OK]  ' : r.verdict === 'debuggable' ? '[FAIL]' : '[??]  ';
      const ident = [
        r.info.packageName ? `package=${r.info.packageName}` : null,
        r.info.versionName ? `versionName=${r.info.versionName}` : null,
        r.info.versionCode !== undefined ? `versionCode=${r.info.versionCode}` : null,
      ].filter(Boolean).join(' ');
      const state = r.debuggable === true ? 'true' : r.debuggable === false ? 'false' : 'unknown';
      console.log(`${tag} ${path.basename(r.file)}  ${ident} debuggable=${state} (${r.reason})`);
    }
  }

  const bad = results.filter((r) => r.verdict !== 'clean');
  if (!bad.length) {
    if (!quiet) console.log(`\n通过：${results.length} 个 APK 均无 android:debuggable 标记，可以发布。`);
    return EXIT_OK;
  }

  const dbg = bad.filter((r) => r.verdict === 'debuggable');
  const unknown = bad.filter((r) => r.verdict === 'unknown');
  if (!json) {
    console.error('');
    if (dbg.length) {
      console.error(`禁止发布：${dbg.length} 个 APK 是 debuggable 构建（android:debuggable="true"）。`);
      console.error('  这些包可被任何已授权 adb 的机器 run-as 读私有数据 / 挂 JDWP 调试（Issue #60）。');
      console.error('  正确处理：用 ./gradlew :app:assembleRelease -PartifactVariant=internal 重新出包，不要上传这个文件。');
    }
    if (unknown.length) {
      console.error(`判不出来：${unknown.length} 个文件无法确认 debuggable 状态（按禁止发布处理）。`);
    }
  }
  return dbg.length ? EXIT_DEBUGGABLE : EXIT_UNKNOWN;
}

/**
 * 只有「被直接执行」时才跑 CLI：`import { evaluateApkDebuggable } from './check-apk-debuggable.mjs'`
 * 的复用方（verify-release-apk.mjs、单测）不许顺带触发一次 `process.exitCode = 2`（无参数）。
 */
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
