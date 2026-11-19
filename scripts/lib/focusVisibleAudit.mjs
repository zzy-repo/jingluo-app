/** #215 的机械审计：`*:focus-visible` 首支持 Chromium 86，运行时下限是 WebView 83（Chromium 83）。
 *
 * 背景：`:focus-visible` 是**未知伪类**，出现在选择器里时 83 把整条选择器判为无效 → **整条规则被丢弃**。
 * 这些规则承载的正是「键盘走到这里时看得见焦点」，丢掉之后键盘用户在当前元素上什么都看不到
 * （a11y 缺陷，不是视觉小瑕疵）。
 *
 * 合格形状（每一处 `:focus-visible` 都要有三段，缺一不可）：
 *  ① `:focus` 兜底：**同一个选择器**（`<sel>:focus`）写一份等价的焦点环（`outline` 或 `box-shadow`）。
 *     83 上只有这一段生效 —— 于是鼠标点击也会出环，这是**可接受的降级**（宁可多一圈，不可没有）。
 *  ② `:focus:not(:focus-visible)` 收回：现代内核里鼠标点击时把①的环收回，键盘走查时不管。
 *     83 上 `:not(:focus-visible)` 同样是未知伪类 → 这条整条失效 → ①的环保留，正好是想要的。
 *  ③ `:focus-visible` 覆盖：现代内核键盘态由它接管（与①同形；顺序在①之后）。
 *
 * 判「不算兜底」的几种写法（#215 的红就长这样）：
 *  - 只有 `:focus-visible`，没有 `:focus` → 83 上零反馈；
 *  - 有了 `:focus`，但里面写 `outline: none` 却没给别的可见标记 → 等于把环也一起关掉；
 *  - 给的是**别的选择器**的 `:focus`（例如 `.input:focus` 之于 `.plan:focus-visible`）→ 不构成兜底；
 *  - 兜底只在 `@media (hover: hover)` 之类条件下成立 → 触屏/键鼠混用时可能整段不生效（本审计要求
 *    兜底的 at-rule 上下文不得比 `:focus-visible` 更窄）。
 *
 * 被两处使用：
 *  - `scripts/check-focus-visible-fallback.mjs`（`pnpm run check:focus`，给人和 CI 看）
 *  - `tests/unit/focus-visible-fallback.test.mjs`（进 pnpm test 基线，回退就红）
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { parseCssBlocks } from './scrollbarGutterAudit.mjs'

const FOCUS_VISIBLE_RE = /:focus-visible\b/gu
const BOX_SHADOW_RE = /(?:^|[;{\s])box-shadow\s*:\s*([^;}]+)/dgiu
const OUTLINE_RE = /(?:^|[;{\s])outline\s*:\s*([^;}]+)/dgiu
/** 写死了「看得见的描边」：`outline: 2px solid …` / `outline: auto` / `outline: revert` */
const OUTLINE_VISIBLE_RE = /(?:^|[;{\s])outline\s*:[^;}]*\b(?:solid|dashed|dotted|double|auto|revert)\b/iu

/** 注释换成等长空白（保留换行）：后面要按 index 换算行号，长度一改行号就全歪 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))

const short = (root, file) => relative(root, file).split(sep).join('/')

const lineOf = (text, index) => text.slice(0, index).split('\n').length

const normalize = (selector) => selector.trim().replace(/\s+/gu, ' ')

const isAtRule = (prelude) => prelude.startsWith('@')

/**
 * `parseCssBlocks` 的 prelude 从「上一个块的 `}`」开始切，所以**块内第一条嵌套规则**的前面会粘着
 * 父块的声明（`.titleButton` 里第一条 `&:focus-visible` 就会变成
 * `display: flex; …; &:focus-visible`）。这里只取最后一个 `;` 之后的部分，把声明剥掉。
 */
const cleanPrelude = (raw) => normalize(raw.slice(raw.lastIndexOf(';') + 1))

/**
 * 把「祖先规则 + 本规则」还原成一条可比较的完整选择器（CSS 嵌套的 `&` 在这里就地展开）。
 * at-rule（`@media` / `@supports`）不进选择器，单独记在 `atRules` 里比上下文。
 */
const resolveSelector = (chain) => {
  let out = ''
  for (const prelude of chain) {
    const own = normalize(prelude)
    if (out === '') out = own.replace(/&/gu, '').trim()
    else if (own.includes('&')) out = own.replace(/&/gu, out)
    else out = `${out} ${own}`
  }
  return out
}

/** 这一段声明里有没有「看得见的焦点环」 */
const showsRing = (ownText) => {
  if (OUTLINE_VISIBLE_RE.test(ownText)) return true
  for (const [, value] of ownText.matchAll(BOX_SHADOW_RE)) {
    const text = value.trim().toLowerCase()
    if (text !== '' && text !== 'none') return true
  }
  return false
}

/** 这一段声明是不是在「把焦点环收回」 */
const clearsRing = (ownText) => {
  for (const [, value] of ownText.matchAll(BOX_SHADOW_RE)) {
    if (/^none\b/iu.test(value.trim())) return true
  }
  for (const [, value] of ownText.matchAll(OUTLINE_RE)) {
    if (/^(?:none|0(?:px)?)\b/iu.test(value.trim())) return true
  }
  return false
}

/** 审计单个 CSS 文件正文：返回每处 `:focus-visible` 及其①兜底 / ②收回的落实情况 */
export const auditCssText = (text) => {
  const clean = stripComments(text)
  const blocks = parseCssBlocks(clean)
  const rules = []

  for (const block of blocks) {
    const prelude = cleanPrelude(block.prelude)
    if (isAtRule(prelude)) continue
    const chain = block.ancestors.map(cleanPrelude).filter((item) => !isAtRule(item))
    rules.push({
      selector: resolveSelector([...chain, prelude]),
      atRules: block.ancestors.map(cleanPrelude).filter(isAtRule),
      ownText: block.ownText,
      line: lineOf(clean, block.open),
    })
  }

  const occurrences = []

  for (const rule of rules) {
    // `:focus:not(:focus-visible)` 是②那一段收回，它本身当然带 `:focus-visible` 字样，不算一处「要兜底的」
    if (rule.selector.includes(':not(:focus-visible)')) continue
    if (!FOCUS_VISIBLE_RE.test(rule.selector)) continue
    FOCUS_VISIBLE_RE.lastIndex = 0

    const { selector, atRules, line } = rule
    const fallbackSelector = selector.replace(FOCUS_VISIBLE_RE, ':focus')
    FOCUS_VISIBLE_RE.lastIndex = 0
    const resetSelector = selector.replace(FOCUS_VISIBLE_RE, ':focus:not(:focus-visible)')
    FOCUS_VISIBLE_RE.lastIndex = 0

    const problems = []

    // ①：同选择器的 `:focus` 必须给一个看得见的环，且不能在同一个块里又 outline: none 了事
    const fallbackCandidates = rules.filter(
      (item) => item.selector === fallbackSelector && item.atRules.length <= atRules.length,
    )
    const fallback = fallbackCandidates.find((item) => showsRing(item.ownText)) ?? null
    if (fallback === null) {
      problems.push(
        fallbackCandidates.length === 0
          ? `缺少 \`${fallbackSelector}\` 兜底：Chromium 83 上整条 \`:focus-visible\` 被丢弃，键盘走到这里没有任何焦点反馈`
          : `\`${fallbackSelector}\` 兜底没给出可见的焦点环（只有 \`outline: none\` 之类）：83 上等于没兜底`,
      )
    }

    // ②：现代内核要把鼠标点击的环收回，否则高内核上点一下就多一圈（回归）
    const reset = rules.find(
      (item) => item.selector === resetSelector && clearsRing(item.ownText),
    ) ?? null
    if (reset === null) {
      problems.push(
        `缺少 \`${resetSelector}\`：兜底会让现代内核的鼠标点击也出焦点环（回归）`,
      )
    }

    if (showsRing(rule.ownText) === false) {
      problems.push('`:focus-visible` 自身没写任何可见的焦点环（outline / box-shadow）')
    }

    occurrences.push({
      line,
      selector,
      atRules,
      fallback: fallback === null ? null : { line: fallback.line, selector: fallback.selector },
      reset: reset === null ? null : { line: reset.line, selector: reset.selector },
      problems,
    })
  }

  return { occurrences, problems: occurrences.flatMap((item) => item.problems.map((why) => ({ ...item, why }))) }
}

/** 递归列出 `src/**` 下的文件 */
const walk = async (dir) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

/** 审计整个 `src/`：`*.css` 逐条查；其它文件（内联 style / 字符串模板）里出现 `:focus-visible` 也要报出来 */
export const auditFocusVisible = async (srcRoot) => {
  const files = (await walk(srcRoot)).sort()
  const occurrences = []
  const problems = []
  let scannedCss = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!file.endsWith('.css')) {
      if (FOCUS_VISIBLE_RE.test(text)) {
        FOCUS_VISIBLE_RE.lastIndex = 0
        problems.push({
          file: short(srcRoot, file),
          line: lineOf(text, text.search(FOCUS_VISIBLE_RE)),
          selector: '(非 CSS 文件)',
          atRules: [],
          fallback: null,
          reset: null,
          why: '`:focus-visible` 出现在非 CSS 文件里，本审计只认 `*.css`：请挪进 CSS 或在此登记',
        })
      }
      FOCUS_VISIBLE_RE.lastIndex = 0
      continue
    }
    scannedCss += 1
    const result = auditCssText(text)
    const file_ = short(srcRoot, file)
    for (const item of result.occurrences) {
      occurrences.push({ file: file_, ...item, problems: item.problems })
    }
    for (const item of result.problems) problems.push({ file: file_, ...item })
  }

  occurrences.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { files: files.length, scannedCss, occurrences, problems }
}
