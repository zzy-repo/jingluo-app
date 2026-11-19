// 产物门禁 E-1/E-2 的**唯一**判定内核（GitHub issue #298，承 #95 / #287）。
//
// 为什么抽到这里：E-1/E-2 原先只活在 `tests/unit/legacy-bundle-target.test.mjs` 里，而单测层跑在
// `build` 之前 —— `dist/` 还不存在，于是这两条用例只能声明期跳过（`# SKIP`），CI 的 `Total N:
// PASS N, NODE-SKIP 2` 里那 2 条就是它们。「跳过」等于这两条门禁**根本不存在**：产物违规也不会红。
//
// 现在拆成两层：
//   1) 判定内核（本文件）：`auditDist()` 采集三层结果，`assertBundleTargetJs()` / `assertBundleTargetCss()`
//      就是 E-1 / E-2 的断言，抛 assert 错误 = 不合格。
//   2) 两个入口，共用同一份断言，**没有第二套实现**：
//      - `tests/unit/legacy-bundle-target.test.mjs`（有 dist 时真跑；无 dist 时声明期 SKIP 并具名上报）
//      - `scripts/check-bundle-target.mjs`（`pnpm check:bundle-target`：无 dist 直接 exit 1，不跳过）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkCssUnits,
  checkJavaScript,
  checkRuntimeApis,
  findForbiddenSyntax,
  stripLiterals,
} from '../check-bundle-syntax.mjs'

/** 递归收集 dir 下所有以 suffix 结尾的文件；目录不存在时返回 []（不抛） */
export const walk = (dir, suffix) => {
  if (!existsSync(dir)) {
    return []
  }
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, suffix))
    } else if (entry.name.endsWith(suffix)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 产物自检的判定内核（E-1/E-2/F-1 共用同一份逻辑，闸门被测的就是它）。
 * 返回三层结果；`problems` 为空数组 = 合格。
 */
export const auditDist = (distDir) => {
  const jsFiles = walk(path.join(distDir, 'static/js'), '.js')
  const cssFiles = walk(path.join(distDir, 'static/css'), '.css')
  const js = checkJavaScript(jsFiles)
  const css = checkCssUnits(cssFiles)
  const runtime = checkRuntimeApis(distDir, jsFiles)
  return {
    jsFiles,
    cssFiles,
    js,
    css,
    runtime,
    problems: [...js.lexical, ...js.ast, ...css.problems, ...runtime.violations],
  }
}

/** 产物「算不算构建过」：JS 与 CSS 两边都得有东西，只有一边等于没构建完整 */
export const hasBundle = (distDir) =>
  walk(path.join(distDir, 'static/js'), '.js').length > 0 &&
  walk(path.join(distDir, 'static/css'), '.css').length > 0

/** 缺产物时唯一的一句话（测试的 SKIP 原因与门禁脚本的报错都用它，不许各写一份） */
export const NO_DIST_REASON =
  'dist/ 没有产物（dist/static/js 或 dist/static/css 为空）：先跑 `pnpm run build:internal`（或 `pnpm run build`）再来核对产物'

/**
 * E-1：全部 JS 能用 Chrome 83 的语法解析，且运行时 API 层有 polyfill 兜底。
 * `audit` 来自 auditDist()。不合格直接抛 assert 错误。
 */
export const assertBundleTargetJs = (audit) => {
  const all = [...audit.js.lexical, ...audit.js.ast]
  assert.deepEqual(all, [], `产物里有低内核解析不了的语法：\n${JSON.stringify(all.slice(0, 5), null, 2)}`)
  assert.ok(audit.js.files >= 40, `产物 JS 文件数异常：${audit.js.files}`)
  // 运行时 API 层（issue #39）：语法过了不代表低内核能跑 —— replaceAll 这类内置 API 缺失是 TypeError。
  // 产物里出现 Chrome 83 没有的 API 时，必须能在入口脚本里找到 polyfill 标记，否则低内核必白屏。
  assert.deepEqual(
    audit.runtime.violations,
    [],
    `产物里有 Chrome 83 没有、又没在入口脚本里补上的内置 API：\n${JSON.stringify(audit.runtime.violations.slice(0, 5), null, 2)}`
  )
  assert.ok(
    audit.runtime.polyfillInEntries.length > 0,
    '产物入口脚本里找不到 legacy polyfill 标记（懒加载 chunk 里补等于没补）'
  )

  // 主包单独再确认一遍：三个逻辑赋值运算符在**剥掉字面量之后**一次都不出现
  // 路径匹配不能写死分隔符：walk() 走 path.join，Windows 上产出的是
  // `D:\...\dist\static\js\main.<hash>.js`，写死 /\/main\./ 会恒定匹配不到（假红）。
  // 用 basename 比较，等价于把 [\\/] 写进正则，但也不受 walk() 的拼接方式影响；
  // 反过来只认反斜杠会在 POSIX 上把这条测回假红，所以两边都不写死。
  const mainFile = audit.jsFiles.find((file) => /^main\.[0-9a-f]+\.js$/.test(path.basename(file)))
  assert.ok(mainFile, '找不到 main 包')
  const main = readFileSync(mainFile, 'utf8')
  const stripped = stripLiterals(main)
  for (const token of ['||=', '&&=', '??=']) {
    assert.equal(stripped.includes(token), false, `main 包里还有 ${token}`)
  }
  // 裸 grep 仍会命中 prismjs 语法高亮定义里的正则（/--|\+\+|\*\*=?|=>|&&=?|\|\|=?/），正常：
  assert.ok(findForbiddenSyntax(main).length === 0, 'main 包词法层应为空')
  const hash = createHash('sha256').update(main).digest('hex')
  console.log(`    main=${path.basename(mainFile)} sha256=${hash}`)
}

/**
 * E-2：CSS 里没有裸 dvh（都有同值 vh 回退），且产物 HTML 里守卫在业务包之前。
 * `distDir` 必须与 auditDist() 用的是同一个目录。
 */
export const assertBundleTargetCss = (audit, distDir) => {
  assert.ok(audit.jsFiles.length > 0, 'dist/static/js 里没有产物 JS')
  assert.ok(audit.cssFiles.length > 0, 'dist/static/css 里没有产物 CSS')
  assert.deepEqual(audit.css.problems, [])
  assert.ok(audit.css.dvhTotal >= 6, `产物里 dvh 声明应有 6 处，实际 ${audit.css.dvhTotal}`)
  assert.equal(audit.css.fallbackTotal, audit.css.dvhTotal, '每处 dvh 都要有配对 vh 回退')

  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8')
  assert.ok(html.indexOf('compatibility-error') >= 0, '产物 HTML 里应有守卫的提示容器')

  // 执行顺序的保证不是「源码顺序」而是「defer」：inline 守卫在解析 body 时就跑了，
  // defer 的业务包要等解析完才执行 —— 所以包解析失败时守卫已经装好 error 监听。
  const bundleTag = html.match(/<script[^>]*src="[^"]*static\/js\/main\.[0-9a-f]+\.js"[^>]*>/)
  assert.ok(bundleTag, '产物 HTML 里应引用 main 包')
  assert.match(bundleTag[0], /\bdefer\b/, 'main 包必须是 defer，否则会和 inline 守卫抢执行顺序')
  const inlineTags = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((match) => match[0])
  assert.ok(inlineTags.length >= 1, '产物 HTML 里应有 inline 守卫脚本')
  for (const tag of inlineTags) {
    assert.doesNotMatch(tag, /\b(?:async|defer)\b/, 'inline 守卫必须是同步执行的（不能带 async/defer）')
  }
}

/** E-1 + E-2 一起跑（门禁入口用的就是这两条，不另写判定） */
export const assertBundleTarget = (audit, distDir) => {
  assertBundleTargetJs(audit)
  assertBundleTargetCss(audit, distDir)
}
