/** #173 的机械审计：flex gap 兜底是否覆盖到了每一条规则，以及有没有人再用假阳性探测。
 *
 * 被两处使用：
 *  - `scripts/check-css-gap-fallback.mjs`（`pnpm run check:gap`，给人和 CI 看）
 *  - `tests/unit/flex-gap-fallback.test.mjs`（进 pnpm test 基线，改归零就红）
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { SKIP, parseRules, readGap } from './flexGapRules.mjs'

const START = '#173-fallback:start'
const END = '#173-fallback:end'

const walk = async (dir, match) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
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
  const cssFiles = await walk(srcDir, (name) => name.endsWith('.module.css'))
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
      const main = gap.column ? gap.rowGap : gap.colGap
      if (main === null || /^0(?:px|rem|em)?$/u.test(main)) continue
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
      if (anchor === undefined) missing.push(`${short(path)} ${rule.selector}（gap: ${main}）`)
      else covered.push(`${name} ${rule.selector}`)
    }
  }
  return { cssFiles: cssFiles.length, covered, missing, skipped, forbidden }
}

const short = (path) => relative(process.cwd(), path).split(sep).join('/')
