/** #214 的机械审计：`@container` / `container-type`（首支持 Chromium 105）不算「写了就没事」的特性。
 *
 * 背景：运行时下限是 WebView 83（Chromium 83）。`container-type` 在那里是**未知声明**（整条丢弃，
 * 无副作用），`@container` 是**未知 at-rule**（整块丢弃，块内规则一条都不生效）。也就是说：
 * 低内核上「按容器宽度改布局」这条语义会**静默消失**，既没有报错，也没有任何可见提示。
 *
 * 什么算合格：
 *  - **首选：根本不写容器查询**。容器宽度如果由我们自己写的类 / 自定义属性决定（例如缩略图宽度就是
 *    `--message-file-image-size`），那就把判据翻成那条类 / 属性本身，别让浏览器去量（#214 走的就是这条）；
 *  - **次选：容器块里的每条声明，同一选择器在所有 `@container` 之外都有基线声明**，即低内核上丢掉
 *    整块之后仍有一个「默认态就能用」的布局。此时 `@container` 只做增强。
 *
 * 明确**不算**合格（#173 教育过的错法）：
 *  - `@container` 块里写了新属性，块外同一选择器什么都不留；
 *  - 把 `@container` 整块塞进 `@supports (container-type: inline-size)` 里，外面照样空着；
 *  - `container-type` 写了却没有任何 `@container`（死声明），或 `@container` 写了却没有任何
 *    `container-type` / `container-name`（永远不会命中，低内核与现代内核上都是死代码）。
 *
 * 被两处使用：
 *  - `scripts/check-container-query-fallback.mjs`（`pnpm run check:container`，给人和 CI 看）
 *  - `tests/unit/container-query-fallback.test.mjs`（进 pnpm test 基线，改归零就红）
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { parseCssBlocks } from './scrollbarGutterAudit.mjs'

/** `container-type: inline-size` / `container: card / inline-size`（简写里带尺寸容器） */
const CONTAINER_TYPE_RE = /(?:^|[;\s])container-type\s*:\s*([^;}]+)/gu
const CONTAINER_SHORTHAND_RE = /(?:^|[;\s])container\s*:\s*([^;}]+)/gu
/** 一条声明：`prop: value` */
const DECL_RE = /(?:^|[;\s])(--?[a-z][\w-]*|[a-z][\w-]*)\s*:\s*([^;}]+)/gu

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, ' ')

const short = (root, path) => relative(root, path).split(sep).join('/')

const lineOf = (text, index) => text.slice(0, index).split('\n').length

const normalizeSelector = (prelude) => prelude.trim().replace(/\s+/gu, ' ')

const isAtRule = (prelude) => prelude.startsWith('@')

const isContainerAtRule = (prelude) => /^@container\b/u.test(prelude)

/** 容器块里声明的属性名（跳过自定义属性与非声明文本） */
const declaredProps = (ownText) => {
  const props = new Set()
  for (const [, prop] of ownText.matchAll(DECL_RE)) props.add(prop.toLowerCase())
  return props
}

/** 同一文件里、位于所有 `@container` 之外的、同一选择器的规则正文 */
const baselineText = (blocks, selector) =>
  blocks
    .filter((block) => !isAtRule(block.prelude))
    .filter((block) => !block.ancestors.some(isContainerAtRule))
    .filter((block) => normalizeSelector(block.prelude) === selector)
    .map((block) => block.ownText)
    .join('\n')

/** 审计单个文件正文：返回 `@container` / `container-type` 的每一处及其判定形状 */
export const auditCssText = (text) => {
  const clean = stripComments(text)
  const blocks = parseCssBlocks(clean)
  const occurrences = []
  const missing = []

  const typeDecls = []
  for (const block of blocks) {
    for (const regex of [CONTAINER_TYPE_RE, CONTAINER_SHORTHAND_RE]) {
      for (const match of block.ownText.matchAll(regex)) {
        typeDecls.push({
          line: lineOf(clean, block.open + 1 + block.ownText.indexOf(match[0])),
          selector: normalizeSelector(block.prelude),
          value: match[1].trim().replace(/\s+/gu, ' '),
        })
      }
    }
  }

  const containerRules = blocks.filter((block) => isContainerAtRule(block.prelude))

  // ① 容器块里的每条规则：声明的每个属性都必须在块外同一选择器上有基线
  const orphaned = typeDecls.length === 0
  const rulesInContainer = blocks
    .filter((block) => !isAtRule(block.prelude))
    .filter((block) => block.ancestors.some(isContainerAtRule))

  for (const rule of rulesInContainer) {
    const selector = normalizeSelector(rule.prelude)
    const containerPrelude = rule.ancestors.find(isContainerAtRule)
    const occurrence = {
      line: lineOf(clean, rule.open),
      selector,
      container: containerPrelude,
      shape: '',
    }

    if (orphaned) {
      missing.push({
        ...occurrence,
        why: '`@container` 找不到任何 `container-type`（或带尺寸的 `container` 简写）：'
          + '没有容器查询容器，这条规则在现代内核上也永远不会命中 —— 死代码',
      })
      occurrences.push({ ...occurrence, shape: 'orphan-container' })
      continue
    }

    const outsideProps = declaredProps(baselineText(blocks, selector))
    const uncovered = [...declaredProps(rule.ownText)].filter((prop) => !outsideProps.has(prop))
    if (uncovered.length > 0) {
      missing.push({
        ...occurrence,
        why: '`@container` 块里的 '
          + uncovered.map((prop) => `\`${prop}\``).join(' / ')
          + ' 在块外同一选择器上没有基线声明：Chromium 83 整块丢弃后这条布局决策静默消失'
          + '（#173 的错法：只在特性分支里写，外面什么都不留）',
      })
      occurrences.push({ ...occurrence, shape: 'missing' })
      continue
    }
    occurrences.push({ ...occurrence, shape: 'baseline-plus-container' })
  }

  // 容器块里一条规则都没有（例如只剩空块）：同样记一处，避免「删了规则忘了删 at-rule」
  if (rulesInContainer.length === 0) {
    for (const rule of containerRules) {
      const occurrence = {
        line: lineOf(clean, rule.open),
        selector: normalizeSelector(rule.prelude),
        container: rule.prelude,
        shape: 'empty-container',
      }
      missing.push({
        ...occurrence,
        why: '`@container` 块里没有任何规则：容器查询已经不起作用，at-rule 应该一并删掉',
      })
      occurrences.push(occurrence)
    }
  }

  // ② 每处 `container-type`：没有 `@container` 就是死声明（更常见的是容器查询被删了、声明忘删）
  for (const decl of typeDecls) {
    if (containerRules.length === 0) {
      missing.push({
        ...decl,
        why: '`container-type` / `container` 简写建立了容器，但同一文件里没有任何 `@container`：'
          + '低内核丢掉它等于没写，现代内核多建一层包含块（`container-type` 会带来 layout/style 包含）',
      })
      occurrences.push({ ...decl, shape: 'dead-container-type' })
      continue
    }
    occurrences.push({ ...decl, shape: 'paired-container-type' })
  }

  return {
    occurrences: occurrences.sort((a, b) => a.line - b.line),
    missing: missing.sort((a, b) => a.line - b.line),
  }
}

const walk = async (dir, match) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

/** 扫描 `src/**`（含内联样式与 `.html`），返回汇总 */
export const auditContainerQuery = async (srcDir) => {
  const files = await walk(srcDir, (name) => /\.(?:css|html|tsx?|jsx?|mjs)$/u.test(name))
  const occurrences = []
  const missing = []
  let scannedWithHit = 0
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    const clean = stripComments(text)
    if (!/@container\b|\bcontainer-type\s*:|\bcontainer\s*:/u.test(clean)) continue
    scannedWithHit += 1
    const result = auditCssText(text)
    for (const item of result.occurrences) occurrences.push({ ...item, file: short(srcDir, path) })
    for (const item of result.missing) missing.push({ ...item, file: short(srcDir, path) })
  }
  return { files: files.length, scannedWithHit, occurrences, missing }
}
