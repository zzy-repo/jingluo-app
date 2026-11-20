/** #173 的机械审计：flex gap 兜底是否覆盖到了每一条规则，以及有没有人再用假阳性探测。
 *
 * 被两处使用：
 *  - `scripts/check-css-gap-fallback.mjs`（`pnpm run check:gap`，给人和 CI 看）
 *  - `tests/unit/flex-gap-fallback.test.mjs`（进 pnpm test 基线，改归零就红）
 *
 * 扫描范围（#217 起）：`src/**` 下**全部** `.css`，含非 CSS Module 的普通 CSS。
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { SKIP, gapFallbackRequirement, parseRules, readGap } from './flexGapRules.mjs'
import { isVendored } from './vendoredPaths.mjs'

const START = '#173-fallback:start'
const END = '#173-fallback:end'

const walk = async (dir, match) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // vendored 第三方目录不参与本守卫（#417）：上游 CSS 的 gap 不该由我们补兜底，
    // 名单与理由见 scripts/lib/vendoredPaths.mjs / src/services/memory/README.md。
    if (isVendored(full)) continue
    if (entry.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

/** 假阳性探测：WebView 83 上这些写法都为 true，但 flex gap 不生效 */
const FORBIDDEN = [
  { re: /CSS\.supports\(\s*['"`](?:flex-)?(?:row-|column-)?gap/gu, why: "CSS.supports('gap') 在 WebView 83 上返回 true（grid 支持、flex 不生效）" },
  { re: /@supports\s*\([^)]*(?:flex-)?(?:row-|column-)?gap\s*:/gu, why: '@supports (gap: …) 在 WebView 83 上判定为真，兜底分支不会命中' },
]

/** 注释里写着「不要用 CSS.supports('gap')」也是对的，所以匹配前先把注释去掉 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

export const auditFlexGap = async (srcDir) => {
  // #217：扫描范围是**全部** `.css`，不再只扫 `*.module.css`。
  // 当初只扫 module 是因为兜底块用 `:global(html[data-flex-gap-fallback])` 包裹（CSS Module 语法），
  // 但「守卫只看 module」等于「非 module 的普通 CSS 完全没有守卫」：`markdown.css:350` 的
  // `.md-code-block-switch` 就躲在这里，实测命中 0 次兜底而 `check:gap` 照样报 OK。
  // 普通 CSS 的兜底块不写 `:global()`（那个伪类在非 module 文件里非法、整条规则会被丢掉），
  // 直接写 `html[data-flex-gap-fallback] 选择器 > *:not(:last-child)` 即可，本文件只认
  // 「块里出现 `<选择器> > *:not(:last-child>`」，两种写法都能认。
  const cssFiles = await walk(srcDir, (name) => name.endsWith('.css'))
  const codeFiles = await walk(srcDir, (name) => /\.(?:css|tsx?|jsx?)$/u.test(name))
  const missing = []
  const covered = []
  const skipped = []
  const forbidden = []
  for (const path of codeFiles) {
    const text = stripComments(readFileSync(path, 'utf8'))
    for (const rule of FORBIDDEN) {
      if (rule.re.test(text)) forbidden.push({ file: short(path), why: rule.why })
      rule.re.lastIndex = 0
    }
  }
  for (const path of cssFiles) {
    const raw = readFileSync(path, 'utf8')
    const text = stripComments(raw)
    const start = raw.indexOf(START)
    const end = raw.indexOf(END)
    const section = start === -1 ? '' : raw.slice(start, end === -1 ? undefined : end)
    const { rules } = parseRules(text)
    const flexSelectors = new Set()
    for (const rule of rules) {
      const display = rule.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/i)
      if (display && /flex/u.test(display[1])) for (const part of rule.selector.split(',')) flexSelectors.add(part.trim())
    }
    const name = short(path).split('/').pop()
    for (const rule of rules) {
      const gap = readGap(rule)
      if (gap === null || gap.grid) continue
      // #217：不再「主轴 gap 为空就整条跳过」。走 gapFallbackRequirement，
      // 只有「主轴没有 gap，且交叉轴 gap 落在不换行的容器上」才算真的不需要兜底。
      const requirement = gapFallbackRequirement(gap)
      if (!requirement.required) continue
      const main = requirement.main ?? requirement.cross
      if (SKIP[`${name}:${rule.selector}`]) {
        skipped.push(`${name} ${rule.selector}`)
        continue
      }
      if (!flexSelectors.has(rule.selector.trim())) {
        skipped.push(`${name} ${rule.selector}（非 flex 容器，gap 不生效）`)
        continue
      }
      const anchor = rule.selector
        .split(',')
        .map((part) => part.trim())
        .find((part) => section.includes(`${part} > *:not(:last-child)`) || section.includes(`${part}> *:not(:last-child)`))
      if (anchor === undefined) {
        const axis = requirement.main === null ? '交叉轴（flex-wrap）' : '主轴'
        missing.push(`${short(path)} ${rule.selector}（${axis} gap: ${main}）`)
      } else covered.push(`${name} ${rule.selector}`)
    }
  }
  const cssModules = cssFiles.filter((path) => path.endsWith('.module.css')).length
  return { cssFiles: cssFiles.length, cssModules, covered, missing, skipped, forbidden }
}

const short = (path) => relative(process.cwd(), path).split(sep).join('/')
