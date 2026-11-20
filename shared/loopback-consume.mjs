/**
 * loopback-consume.mjs —— 「`consume.baseUrl` 是本机回环」的**唯一判定**（Issue #601 技术兜底）。
 *
 * 为什么单独一个文件：
 *   2026-11-20 事故里，一个 `consume.baseUrl = http://127.0.0.1:18000` 的 internal 包被发到了公网
 *   分发机（`dl.rose7.cn`），公网可见约 30 分钟。回环地址的包**在任何真机上都连不上后端**
 *   （`127.0.0.1` 指向手机自己），它只对「`adb reverse` 的本机联调」有意义 —— 却和普通包长得一模一样。
 *   判定这件事的出口不止一个（构建期 Web / 构建期 Gradle / 上传接口 / 私有包脚本），
 *   每处各写一份正则必然漂移：事故本身就是「一处判据没覆盖到所有出口」。
 *   所以判据只此一份，别的地方 import 它。
 *
 * 谁读它：
 *   - `scripts/lib/consumeEndpoints.mjs`（复用 `isLoopbackHost`，并再导出给老调用方）
 *   - `scripts/build.mjs`（`__ENDPOINTS__` 注入前的构建期闸门）
 *   - `deploy/dl-release/apk-manifest.mjs`（从 APK 的 JS bundle 里抽出 baseUrl 后判定）
 *   - `deploy/dl-release/server.mjs`（`POST /api/v1/release` 的 400 `BAD_CONSUME_BASE`）
 *   - `scripts/publish-private-apk.mjs`（SSH 直写前的闸门）
 *   - `android/app/build.gradle`：Groovy 侧无法 import 本文件，`LOOPBACK_BASE_PATTERN` 是**对照实现**，
 *     改这里必须同步改那边（gradle 注释里也写着这一条）。
 *
 * 注意（别夸大）：回环**不等于**违法 —— 本地联调（本机 sub2api + `adb reverse`）是合法用法。
 * 这个模块只回答「这个 baseUrl 是不是回环」，要不要拦由调用方按变体决定。
 */

/** 显式放行回环出包的开关（构建期：环境变量；gradle：同名 gradle 属性） */
export const ALLOW_LOOPBACK_ENV = 'ALLOW_LOOPBACK_CONSUME';
export const ALLOW_LOOPBACK_GRADLE_PROP = 'allowLoopbackConsume';

/**
 * 允许明文 http 的回环主机（与 `scripts/lib/consumeEndpoints.mjs` 的历史口径逐字一致）。
 * 带方括号的 `[::1]` 是 `new URL()` 之外常见的写法（gradle 侧手写正则时会带括号），两种都收。
 */
export const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 是不是回环主机名。
 * @param {unknown} hostname `new URL(...).hostname` 或裸主机名
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTNAMES.includes(host);
}

/**
 * baseUrl 是不是回环（解析不出来 = **不是**回环：形状错误由各自的 schema 校验去报，
 * 这里不兼任「URL 合不合法」的判定 —— 两件事的判断理由不同，混在一起会互相掩盖）。
 *
 * @param {unknown} value 例如 `http://127.0.0.1:18000`
 * @returns {boolean}
 */
export function isLoopbackBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return isLoopbackHost(url.hostname);
}

/**
 * 构建期 / 发布脚本用的开关解析：`ALLOW_LOOPBACK_CONSUME=1` 才算打开。
 *
 * 为什么不用 `'true'` 也算：出包这件事上的「差不多」会变成线上事故，
 * 只认文档写的那一个值，写错就等于没写（宁可多拦一次，让人回来看文档）。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function allowLoopbackFromEnv(env = process.env) {
  return String(env?.[ALLOW_LOOPBACK_ENV] ?? '').trim() === '1';
}

/** 给报错/日志用的统一措辞：一句话说清「这包能干什么、不许干什么」 */
export const LOOPBACK_PACKAGE_HINT =
  '回环 baseUrl 的包只能用于本机 adb reverse 联调，禁止上传到任何分发站（Issue #601）';
