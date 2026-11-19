/**
 * textLines.mjs —— 逐行扫描用的小工具（无依赖，谁都能 import）。
 *
 * 为什么单独一个文件：`scripts/check-endpoints.mjs` 要在**配置不合法时**仍然能跑起来
 * 给出可读的报错（它得先知道哪一行是注释），而 `scripts/lib/endpoints.mjs` 是在 import
 * 时就校验并抛错的（fail fast）。把「这一行是不是注释」抽出来，门禁就不必为了拿一个正则
 * 去触发那份会抛错的模块求值。
 */

/**
 * 整行只有注释（`//` `*` `/*` `#` 开头）—— 注释里的地址是说明文字，不参与运行。
 * 注释行里的**线上地址**在门禁里放过；非白名单地址写在注释里照样要报。
 */
export const isCommentOnlyLine = (line) => /^\s*(?:\/\/|\/\*|\*|#)/.test(line)
