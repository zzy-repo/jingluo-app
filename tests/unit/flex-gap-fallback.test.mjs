// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #173 的防回归：flex gap 在 WebView 83 上是 0，而 CSS.supports('gap') 返回 true，
// 于是「探测说支持、间距是 0」。这里把两条规则钉进测试：
//  1. 仓库里不许出现 CSS.supports(...gap) / @supports (gap: …) —— 那种探测在 83 上假阳性；
//  2. 每条 flex 容器上的非零 gap 必须有兜底规则，否则以后新写的 gap 又会静默失效。
// 另外钉住兜底生成器的形状：只写 margin，绝不写 gap（否则支持 gap 的内核上会双份间距）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { auditFlexGap } from '../../scripts/lib/flexGapAudit.mjs'
import { parseRules, readGap, renderFallback } from '../../scripts/lib/flexGapRules.mjs'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

const gapsOf = (css) => {
  const { rules } = parseRules(css)
  return rules.map((rule) => ({ selector: rule.selector, gap: readGap(rule) })).filter((item) => item.gap !== null)
}

test('#173 兜底只写 margin，不重复声明 gap', () => {
  const [row] = gapsOf('.row { display: flex; gap: 8px; }')
  const css = renderFallback(row.selector, row.gap)
  assert.match(css, /margin-right: 8px;/u)
  assert.doesNotMatch(css, /[^-]gap:/u)
  assert.match(css, /html\[data-flex-gap-fallback\]/u)
})

test('#173 竖向 flex 兜底加在 margin-bottom 上', () => {
  const [col] = gapsOf('.col { display: flex; flex-direction: column; row-gap: 12px; }')
  const css = renderFallback(col.selector, col.gap)
  assert.match(css, /margin-bottom: 12px;/u)
})

test('#173 会换行的 flex 两个方向都补', () => {
  const [wrap] = gapsOf('.wrap { display: flex; flex-wrap: wrap; gap: 6px 10px; }')
  const css = renderFallback(wrap.selector, wrap.gap)
  assert.match(css, /margin-right: 10px;/u)
  assert.match(css, /margin-bottom: 6px;/u)
})

test('#173 不许用 CSS.supports / @supports 探测 flex gap', async () => {
  const audit = await auditFlexGap(SRC)
  assert.deepEqual(audit.forbidden, [])
})

test('#173 每条 flex gap 都有兜底或写明跳过原因', async () => {
  const audit = await auditFlexGap(SRC)
  assert.deepEqual(audit.missing, [])
  assert.ok(audit.covered.length > 50, `兜底规则太少（${audit.covered.length}），生成器是不是没跑`)
})
