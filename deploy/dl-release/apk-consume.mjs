/**
 * 从 APK 二进制里读**构建期注入的 `consume.baseUrl`**，并判定它是不是本机回环。
 *
 * ## 为什么非要读 APK（Issue #601 事故的直接教训）
 *
 * 2026-11-20 22:14 被发到公网分发机的 `1.4.2` internal 包，`consume.baseUrl` 是
 * `http://127.0.0.1:18000` —— 那只能配 `adb reverse` 做本地联调，**在任何真机上连不上后端**。
 * 当时唯一的构建期拦截只拦「release 变体用回环」，`-PartifactVariant=internal` 正好绕过去，
 * 而发布脚本只信命令行参数、不看产物字节。裁决 #614 决定 3 因此要求：**发布脚本里要有一条
 * 以 APK 为准的硬闸**（「上传侧兜底」的本地版）—— 判据必须是产物里真实编译进去的值，
 * 不能是 `config/endpoints.json`（那是仓库里的值，`-PconsumeBase=` 可以覆盖它）。
 *
 * ## 值在哪、怎么读（不依赖 aapt2 / 不依赖 Android SDK）
 *
 * `consume.baseUrl` 有两条注入路径，产物里对应两处字节：
 *   1. Web 侧：rspack 的 `DefinePlugin` 把 `__ENDPOINTS__` 整块替换成对象字面量
 *      （`rspack.config.ts`）→ 打包进 `assets/public/static/js/main.<hash>.js`，
 *      形态是 `consume:{baseUrl:"http://…",apiV1Prefix:"/api/v1",…}`（生产构建会被压成不带引号的键）；
 *   2. 原生侧：`BuildConfig.CONSUME_BASE`（`android/app/build.gradle`）→ 进 `classes*.dex` 的字符串表。
 *
 * 本模块**首选 (1)**：它带键名，能把「哪个地址是 consume 的」判死（dex 里只有裸字符串，
 * `consume` 与 `pay` 两个地址分不开）。两处都没有 → 判**判不出来**，调用方必须按失败处理
 * （与 `apk-manifest.mjs` / `publish-private-apk.mjs` 同一条原则：不猜，也不「先放行后补证」）。
 *
 * ## 可信边界（别夸大）
 *
 * 读的是 APK 里真实编译进去的字节，所以「客户端声明」改不了它；但本模块**不验签名**，
 * 也不保证「这就是 dex 里那个常量」—— 它回答的问题是「这个包里有没有一个回环的 consume base」，
 * 多命中一处就足以拒绝（宁可误杀，不可误发：回环包在真机上等于全功能不可用）。
 */

import { listZipEntries, readZipEntryRecord } from './apk-manifest.mjs';

/** 回环主机名（与 `android/app/build.gradle` 的 isLoopback、`scripts/lib/consumeEndpoints.mjs` 同口径） */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/** 扫哪些条目：Web 产物 bundle + 原生 dex（只有这两处可能带构建期注入的地址） */
const BUNDLE_ENTRY_RE = /^assets\/.*\.js$/i;
const DEX_ENTRY_RE = /^classes\d*\.dex$/i;

/** 单个条目最多解压多少字节（防御畸形包把内存吃光） */
const MAX_ENTRY_BYTES = 48 * 1024 * 1024;

/**
 * 键名 → 地址：两种书写都认（压过的生产产物 / 没压过的调试产物）。
 * 用 `[^{}]*` 而不是 `.*?`：`consume` 对象里字段多于两个，跨对象匹配会张冠李戴。
 */
const CONSUME_PATTERNS = [
  /"consume"\s*:\s*\{[^{}]*?"baseUrl"\s*:\s*"([^"]*)"/,
  /\bconsume\s*:\s*\{[^{}]*?baseUrl\s*:\s*"([^"]*)"/,
];

/** 从一段文本里抽出所有 consume baseUrl 候选（去重、保序） */
export function findConsumeBases(text) {
  const found = [];
  for (const re of CONSUME_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    for (const m of String(text).matchAll(global)) {
      if (m[1] && !found.includes(m[1])) found.push(m[1]);
    }
  }
  return found;
}

/**
 * 判定一个 base URL 是不是本机回环。
 * 判不出来（不是合法 URL）按 **true** 处理？—— 不：这里只回答「是不是回环」，
 * 非法 URL 由调用方按「地址不可用」另判（见 `describeConsumeBase`）。保持函数单一职责。
 */
export function isLoopbackBase(rawUrl) {
  const s = String(rawUrl ?? '').trim();
  if (!s) return false;
  let host = '';
  try {
    host = new URL(s).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    // 不是合法 URL（例如 `127.0.0.1:18000` 少了 scheme）：退化成字符串判断，
    // 宁可多拦 —— 一个解析不了的「地址」本身就不该被发出去。
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^/:?#]+)/i.exec(s);
    host = (m ? m[1] : s).toLowerCase().replace(/^\[|\]$/g, '');
  }
  if (LOOPBACK_HOSTS.includes(host)) return true;
  // 127.0.0.0/8 全段都是回环（含 127.0.0.2 这类），别只认 127.0.0.1
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * 扫一份 APK 字节，返回 consume baseUrl 的取证结果。
 *
 * @param {Buffer} apkBuf
 * @returns {{found:string[], sources:string[], reason:string|null}}
 *   `found` 空 + `reason` 非空 = **判不出来**（调用方必须拒绝，不许默认放行）
 */
export function inspectConsumeBase(apkBuf) {
  let entries;
  try {
    entries = listZipEntries(apkBuf);
  } catch (e) {
    return { found: [], sources: [], reason: `not_a_zip: ${e.message}` };
  }

  const found = [];
  const sources = [];
  const problems = [];
  let scanned = 0;
  // 说明：`classes*.dex` 刻意**不用** —— dex 里只有裸字符串，`consume` 与 `pay` 两个地址分不开，
  // 拿它当证据会把「pay 是回环」误判成 consume。键名证据只在 Web bundle（assets 下的 *.js）里找。
  const hasDex = entries.some((e) => DEX_ENTRY_RE.test(e.name));
  for (const entry of entries) {
    if (!BUNDLE_ENTRY_RE.test(entry.name)) continue;
    if (entry.plainSize > MAX_ENTRY_BYTES) {
      problems.push(`${entry.name} 超过 ${MAX_ENTRY_BYTES} 字节，未扫描`);
      continue;
    }
    let text;
    try {
      text = readZipEntryRecord(apkBuf, entry, MAX_ENTRY_BYTES).toString('utf8');
    } catch (e) {
      problems.push(`${entry.name} 解压失败: ${e.message}`);
      continue;
    }
    scanned++;
    for (const base of findConsumeBases(text)) {
      if (!found.includes(base)) {
        found.push(base);
        sources.push(entry.name);
      }
    }
  }

  if (found.length) return { found, sources, reason: null };
  if (!scanned) {
    return {
      found,
      sources,
      reason: problems.length
        ? `没有可扫描的 bundle 条目（${problems.join('；')}）`
        : 'APK 里没有任何 assets/**/*.js bundle（不是本项目的包？）',
    };
  }
  return {
    found,
    sources,
    reason:
      `扫了 ${scanned} 个 bundle${hasDex ? '（包里有 classes.dex，但它只有裸字符串，不足以证明哪个地址是 consume 的）' : ''}` +
      ' 但没找到 consume:{baseUrl:"…"} 键名证据' +
      (problems.length ? `（${problems.join('；')}）` : '（注入形态变了？以 APK 为准，判不出来就不发）'),
  };
}

/**
 * 把取证结果翻成「能不能发」的判决。
 *
 * @param {{found:string[], sources:string[], reason:string|null}} report
 * @returns {{ok:boolean, loopback:string[], bases:string[], message:string}}
 */
export function judgeConsumeBase(report) {
  const bases = report.found ?? [];
  const loopback = bases.filter(isLoopbackBase);
  if (!bases.length) {
    return {
      ok: false,
      loopback: [],
      bases,
      message:
        `读不出 APK 里的 consume.baseUrl（${report.reason ?? '未知原因'}）——` +
        '判不出来就不发（回环包在真机上等于全功能不可用，宁可阻断）',
    };
  }
  if (loopback.length) {
    return {
      ok: false,
      loopback,
      bases,
      message:
        `APK 里的 consume.baseUrl 是本机回环：${loopback.join('、')}` +
        '（只能配 adb reverse 做本地联调，真机上连不上后端 —— #601 事故形态），拒绝发布',
    };
  }
  return { ok: true, loopback: [], bases, message: `consume.baseUrl = ${bases.join('、')}（非回环）` };
}
