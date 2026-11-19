/**
 * buildType 单一真相源（Issue #330）。
 *
 * 这里放的是「发布渠道」，**不是** Gradle 构建类型（release/debug），也不是构建变体
 * （artifactVariant: internal|standard）。三者是不同维度：
 *
 *   Gradle 构建类型  →  manifest buildType
 *   release          →  stable（正式发布）
 *   （预发布）        →  prerelease
 *   debug            →  禁止发布（debuggable，见 #60）
 *
 * 纯 ESM、零依赖：客户端 TS（经 build-types.d.mts 拿类型）/ 发布脚本 mjs / 校验器
 * 三处共用同一份值。任何新的判定都必须 import 这里，不要再写一份字符串数组 ——
 * 2026-11-19 的 P0 事故就是 8 处各写一份、其中一处写成了 Gradle 的 "release"。
 */

/** 允许写进 releases.json 的 buildType 全量取值（顺序即文档顺序） */
/** @type {readonly ['stable', 'prerelease']} */
export const BUILD_TYPES = Object.freeze(['stable', 'prerelease']);

/** 版本号含 -alpha/-beta/-rc → prerelease；与 docs/dl-release-api.md 同口径 */
export const BUILD_TYPE_SUFFIX_RE = /-(?:alpha|beta|rc)/i;

/**
 * 从版本号判定 buildType（仅用于「没显式给值」时的默认值，不是白名单）
 * @param {string} version
 * @returns {'stable' | 'prerelease'}
 */
export function buildTypeFor(version) {
  return BUILD_TYPE_SUFFIX_RE.test(String(version)) ? 'prerelease' : 'stable';
}

/**
 * buildType 是否是合法枚举值（唯一判定入口）
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBuildType(value) {
  return typeof value === 'string' && BUILD_TYPES.includes(value);
}
