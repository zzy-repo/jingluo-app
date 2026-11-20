// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 类别 2（CSS 特性）能力盘点的判定逻辑单测 —— 对应 #209。
// 真的调用 scripts/lib/cssAssumptionAudit.mjs，不是抄一份判定表。
//
// 覆盖：五类判定各至少 1 例，其中必含 #173 那一类
// 「探测通过但布局不生效、且没有实测回读」的假阳性，
// 以及它的正确姿态对照（同一文件里有实测回读 → 不算假阳性）。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { auditCssAssumptions, collectSources } from '../../scripts/lib/cssAssumptionAudit.mjs'

const file = (path, content) => ({ path, content })

/** 跑一遍判定，只返回命中数组。 */
const hitsOf = (files) => auditCssAssumptions(files).hits

/** 取某个特性的命中。 */
const pick = (hits, feature) => hits.filter((hit) => hit.feature === feature)

/** 单文件单特性判定的快捷方式。 */
const judge = (path, content, feature) => {
  const hits = pick(hitsOf([file(path, content)]), feature)
  assert.equal(hits.length, 1, `期望 ${feature} 命中 1 处，实际 ${hits.length} 处`)
  return hits[0]
}

// ---------------------------------------------------------------- 已有兜底

test('@supports (max-height: 100dvh) 前面有等价的 vh 基座 → 已有兜底', () => {
  const hit = judge(
    'components/base/Modal.module.css',
    `.dialog {
  max-height: calc(var(--app-viewport-height, 100vh) - 120px);
  @supports (max-height: 100dvh) {
    max-height: calc(var(--app-viewport-height, 100dvh) - 120px);
  }
}
`,
    '@supports',
  )
  assert.equal(hit.verdict, 'covered')
  assert.equal(hit.hasFallback, true)
  assert.equal(hit.risk, '低')
})

test('@supports (max-height: 100dvh) 前面没有 vh 基座 → 兜底不等价，记真实缺陷', () => {
  const hit = judge(
    'components/base/Modal.module.css',
    `.dialog {
  @supports (max-height: 100dvh) {
    max-height: 100dvh;
  }
}
`,
    '@supports',
  )
  assert.equal(hit.verdict, 'defect')
  // 风险档位跟着特性走：@supports 内 dvh 的兜底缺失记「中」（整条声明消失）；
  // 裸用 dvh（没有任何 @supports 包裹）才是「高」（#13 已确认会把能用的 vh 打成 initial）。
  assert.equal(hit.risk, '中')
})

test('inset 由构建期 lightningcss 降级为物理属性 → 已有兜底', () => {
  const hits = pick(hitsOf([file('app/App.module.css', '.screen { inset: 0; }\n')]), 'inset')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].verdict, 'covered')
  assert.equal(hits[0].hasFallback, true)
})

// ---------------------------------------------------------------- 无风险

test('touch-action / overscroll-behavior / min() 首支持 ≤ Chromium 83 → 无风险', () => {
  for (const [path, css, feature] of [
    ['a/x.module.css', '.list { touch-action: pan-y; }', 'touch-action'],
    ['a/y.module.css', '.list { overscroll-behavior-y: contain; }', 'overscroll-behavior'],
    ['a/z.module.css', '.list { width: min(100%, 480px); }', 'min()/max()'],
  ]) {
    const hit = judge(path, css, feature)
    assert.equal(hit.verdict, 'no-risk', `${feature} 应记无风险`)
    assert.equal(hit.risk, '低')
  }
})

// ---------------------------------------------------------------- 可接受降级

test(':where() 首支持 88 > 83，但只丢一层动画 → 可接受降级', () => {
  const hit = judge(
    'components/base/Modal.module.css',
    `:where(.content)[data-motion-state='closed'] { opacity: 0; }\n`,
    ':where()/:is()',
  )
  assert.equal(hit.verdict, 'degraded')
  assert.equal(hit.risk, '低')
})

// ---------------------------------------------------------------- 真实缺陷

test(':has() 无兜底 → 低内核整条选择器列表被丢，记真实缺陷', () => {
  const hit = judge('components/markdown/markdown.css', 'h4:has(+ ul) { margin-bottom: 0; }\n', ':has()')
  assert.equal(hit.verdict, 'defect')
  assert.equal(hit.risk, '中')
})

test('@container / container-type 无兜底 → 整块被丢，两处都记真实缺陷', () => {
  const hits = hitsOf([
    file(
      'components/messages/MessageFile.module.css',
      `.thumb {
  container-type: inline-size;
}
@container (max-width: 63px) {
  .reason { display: none; }
}
`,
    ),
  ])
  for (const feature of ['container-type', '@container']) {
    const list = pick(hits, feature)
    assert.equal(list.length, 1, `${feature} 应命中 1 处`)
    assert.equal(list[0].verdict, 'defect')
    assert.equal(list[0].risk, '中')
  }
})

// ------------------------------------------------- 假阳性（#209 验收项 / #173 同形）

test("CSS.supports('gap', '12px') 探测通过但 flex gap 不生效 → 假阳性（#173 同形）", () => {
  const hit = judge(
    'src/app/probe.ts',
    `const ok = CSS.supports('gap', '12px')\nexport const supported = ok\n`,
    'CSS.supports',
  )
  assert.equal(hit.verdict, 'false-positive')
  assert.equal(hit.risk, '高')
  assert.match(hit.reason, /gap/u)
})

test('@supports (gap: 12px) 与 CSS.supports 同罪 → 也是假阳性', () => {
  const hit = judge(
    'src/app/probe.module.css',
    `@supports (gap: 12px) {\n  .row { display: flex; }\n}\n`,
    '@supports',
  )
  assert.equal(hit.verdict, 'false-positive')
  assert.equal(hit.risk, '高')
})

test('同一个 gap 探测，但文件里有实测回读 → 降级为已有兜底，不误报假阳性', () => {
  const hit = judge(
    'src/utils/flexGap.ts',
    `const declared = CSS.supports('gap', '12px')
const box = probe.getBoundingClientRect()
export const effective = declared && box.right - box.left >= 7.5
`,
    'CSS.supports',
  )
  assert.equal(hit.verdict, 'covered')
  assert.equal(hit.risk, '低')
})

test('getComputedStyle 只读声明值判「能滚」→ 假阳性；带实测回读 → 正确姿态', () => {
  const readOnly = judge(
    'src/app/viewport.ts',
    `const style = getComputedStyle(element)
const canScroll = /auto|scroll/.test(style.overflowY)
`,
    'getComputedStyle',
  )
  assert.equal(readOnly.verdict, 'false-positive')
  assert.equal(readOnly.risk, '高')

  const measured = judge(
    'src/components/session/scrollToFirstMessage.ts',
    `const style = getComputedStyle(element)
const canScroll = /auto|scroll/.test(style.overflowY) && element.scrollHeight - element.clientHeight > 0
`,
    'getComputedStyle',
  )
  assert.equal(measured.verdict, 'covered')
  assert.equal(measured.risk, '低')
})

// ---------------------------------------------------------------- 注释不算命中

test('注释里提到的特性不算命中（CSS 与脚本两种注释都要跳过）', () => {
  const css = `/* h4:has(+ ul) 在 WebView 83 上会被整条丢弃，这里只是说明 */
.card { color: red; }
`
  assert.deepEqual(hitsOf([file('a/comment.module.css', css)]), [])

  const script = `// CSS.supports('gap', '1px') 在 WebView 83 上是假阳性，别再用了
export const noop = () => {}
`
  assert.deepEqual(hitsOf([file('a/comment.ts', script)]), [])
})

// ------------------------------------------------------- 真实仓库的不变量

test('真实 src 盘点：@supports 全部有等价兜底，#218 之后不再有声明回读假阳性', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url))
  const { hits, summary } = auditCssAssumptions(collectSources(src))

  assert.ok(summary.files > 200, `扫描文件数应 > 200，实际 ${summary.files}`)
  assert.ok(summary.hits > 300, `命中数应 > 300，实际 ${summary.hits}`)

  // dvh 的每一处都在 @supports 里，块外必有等价 vh 基座（#13 之后的既有纪律）
  const supports = summary.byFeature['@supports']
  assert.ok(supports.count >= 9, `@supports 至少 9 处，实际 ${supports.count}`)
  assert.equal(supports.covered, supports.count, '@supports 必须全部有等价兜底')
  assert.equal(supports.falsePositive, 0)

  // flex gap 的假阳性探测已由 #173 清零，守卫 check:gap 负责持续盯
  assert.equal(summary.byFeature['flex-gap'].falsePositive, 0)

  // #209 验收要求的那个假阳性原本就落在 viewport.ts 的声明回读上；#218 修完之后它必须变成
  // 「已有兜底」—— 检测能力还在、现场缺陷没了。检测能力由上面的合成用例守，这里守现场：
  // 那一处不许被静默跳过，也不许还留在假阳性名单里。
  const viewportHit = hits.find((hit) => hit.file === 'app/viewport.ts' && /overflowY/u.test(hit.probe))
  assert.ok(viewportHit, 'app/viewport.ts 的 overflowY 声明回读必须仍被盘点器看到（不能静默跳过）')
  assert.equal(viewportHit.verdict, 'covered', '#218 之后 viewport.ts 的可滚判定必须带实测回读')
  assert.equal(summary.falsePositives.length, 0, '真实 src 不应再有「只读声明、无回读」的假阳性')

  // 修复前的形态仍必须判成假阳性，否则等于顺手把检测能力一起删了
  const preFix = judge(
    'src/app/viewport.ts',
    `const style = getComputedStyle(element)
const canScroll = /auto|scroll/.test(style.overflowY)
`,
    'getComputedStyle',
  )
  assert.equal(preFix.verdict, 'false-positive')
  assert.equal(preFix.risk, '高')

  assert.ok(
    hits.some(
      (hit) => hit.file === 'components/session/scrollToFirstMessage.ts' && hit.verdict === 'covered',
    ),
    '同一手法的正确姿态应被判为已有兜底，不能被误报',
  )

  // 真实缺陷必须落在已知的几类特性上，防止判定逻辑退化成「全报缺陷」
  const defectFeatures = new Set(summary.defects.map((hit) => hit.feature))
  assert.ok(defectFeatures.has('scrollbar-gutter'), '真实缺陷应包含 scrollbar-gutter')

  // #215 之后 :focus-visible 各处都补上了 `:focus` 兜底：检测能力必须还在（命中数不许减少），
  // #499（登录/注册页 AuthPages.module.css）新增 1 处 → 13 → 14；W1-C1/W1-C2 面板（#502/#505）再 +2 → 16；
  // #562 旧 `settings/OursServices.module.css` 随支付弹层退役 −1 → 15。
  // docs/capabilities/css.md 同步口径。
  // 但结论从「已知缺陷」换成更强的「不许回流」不变量（与上面 :has() 同一手法）。
  const focusHits = summary.byFeature[':focus-visible']
  assert.ok(focusHits, ':focus-visible 的命中必须仍被盘点器看到（不能静默跳过）')
  assert.equal(focusHits.count, 16, ':focus-visible 命中数变了就要同步 docs/capabilities/css.md')
  assert.equal(focusHits.defect, 0, 'src 里不应再有「无 `:focus` 兜底」的 :focus-visible（#215）')
  assert.equal(focusHits.covered, 16, ':focus-visible 的每一处都该判成「已有兜底」')
  // #213 之后 :has() 在 src 里已清零（改由渲染期显式状态类承载），
  // 从「已知缺陷清单」换成更强的「不许回流」不变量。
  assert.equal(summary.byFeature[':has()']?.count ?? 0, 0, 'src 里不应再有 :has()')
  assert.ok(summary.byVerdict.defect < summary.hits / 5, '缺陷占比过高，判定可能过硬')
})

// -------------------------------------------------- #215 :focus-visible 兜底判据

// 修复前的形态仍必须判成真实缺陷，否则等于顺手把检测能力一起删了。
test('#215：只有 :focus-visible、没有同选择器 :focus 兜底 → 真实缺陷', () => {
  const hit = judge(
    'components/base/Button.module.css',
    `.button {
  outline: none;

  &:focus-visible {
    box-shadow: 0 0 0 2px var(--dsw-alias-button-primary-fill);
  }
}
`,
    ':focus-visible',
  )
  assert.equal(hit.hasFallback, false)
  assert.equal(hit.verdict, 'defect')
  assert.equal(hit.risk, '中')
})

test('#215：`:focus` 兜底 + `:focus:not(:focus-visible)` 收回 → 已有兜底', () => {
  const hit = judge(
    'components/base/Button.module.css',
    `.button {
  outline: none;

  &:focus {
    box-shadow: 0 0 0 2px var(--dsw-alias-button-primary-fill);
  }

  &:focus:not(:focus-visible) {
    box-shadow: none;
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px var(--dsw-alias-button-primary-fill);
  }
}
`,
    ':focus-visible',
  )
  assert.equal(hit.hasFallback, true)
  assert.equal(hit.verdict, 'covered')
})

// 只写 `outline: none` 的 `:focus` 不算兜底 —— 那正是 13 处修复前本来就有（或极易被误加）的坑。
test('#215：`:focus` 只写 outline: none 不算兜底', () => {
  const hit = judge(
    'components/base/Button.module.css',
    `.button {
  &:focus {
    outline: none;
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px var(--dsw-alias-button-primary-fill);
  }
}
`,
    ':focus-visible',
  )
  assert.equal(hit.hasFallback, false)
  assert.equal(hit.verdict, 'defect')
})
