/**
 * vendored 第三方代码的目录名单（相对仓库根）——统一说明见 src/services/memory/README.md。
 *
 * 为什么需要这份名单（#417）：`src/services/memory/` 不是自研代码，是 SillyTavern 扩展
 * *Summaryception* 的原型（AGPL-3.0，由 #396 / #397 搬进仓库，尚未接进 app 运行时）。
 * 它保留上游写法、以后要整块同步上游，所以：
 *
 * 1. 风格类门禁（lint / 格式化）不覆盖它 —— 见 `.oxlintrc.json` 的 `ignorePatterns`；
 * 2. 判定类 / 统计类口径（flex gap 兜底守卫、生成器、CSS 能力盘点、API/host 能力快照）
 *    只统计「我们自己的」代码，vendored 目录整体排除。否则上游 CSS 的 21 条 flex gap
 *    会要求我们给不可维护的第三方文件补 `@supports` 兜底，上游 JS 的 `Object.hasOwn`
 *    之类也会被算进我们的能力盘点。
 *
 * 名单只放**目录**，不要用宽泛模式（`**\/*.js` 那种）—— 排除范围必须能一眼看清。
 */

import path from 'node:path'

export const VENDORED_DIRS = Object.freeze(['src/services/memory'])

/**
 * 该路径是否落在 vendored 目录里。接受绝对路径或相对仓库根的路径（两种都判），
 * 这样扫描函数不用关心自己拿到的是哪一种。
 *
 * @param {string} target 文件或目录路径
 * @returns {boolean}
 */
export function isVendored(target) {
  const posix = target.split(path.sep).join('/').replace(/\/{2,}/gu, '/')
  return VENDORED_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`) || posix.includes(`/${dir}/`) || posix.endsWith(`/${dir}`))
}
