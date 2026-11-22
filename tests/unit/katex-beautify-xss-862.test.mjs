// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
//
// #862 合入后的安全回归：美化规则给 KaTeX 开了 `trust: isTrustedMathCommand`，这个回调一旦放宽，
// 模型输出的公式就能产生 <a href=javascript:>、background:url(外链)、position:fixed 遮罩、<img>、任意 class / id / data-*。
// 这里用与 `MathFormula.tsx` 完全相同的选项 + `planMathRender`（页面真实路径）逐个渲染危险输入，
// 断言输出 HTML 里没有链接 / 外联 / 定位 / 非白名单 class，并断言 strict:'ignore' 没有把写坏的公式吞成乱码。
//
//   X1 危险输入一律不产生 <a> / href= / javascript: / url( / position / <img / id= / data-* / 非白名单 class
//   X2 受限放行：scalebox / rotatebox 的极端数值被夹到 ≤10em / ≤360deg
//   X3 trust 回调：\href \url \includegraphics \htmlId \htmlData 恒 false；样式与 class 严格白名单
//   X4 strict:'ignore' 不吞坏公式：未闭合花括号、未知环境仍然抛错 / 降级，不会渲染成「成功」的乱码
//   X5 宏展开 / \text 嵌套 / 被改写命令内部夹带，同样拿不到权限
//
// 负向对照：把 mathCompat.ts 的 isTrustedMathCommand 改成恒 true → X1 / X3 红。
//
//   node tests/run-layer.mjs unit --only katex-beautify-xss-862
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installEndpointsGlobals()
installTsResolve()

const require = createRequire(import.meta.url)
const katex = require('katex')
const { normalizeBeautifyMath, isTrustedMathCommand } = await loadTsModule('src/services/markdown/mathCompat.ts')
const { planMathRender } = await loadTsModule('src/services/markdown/mathBlocks.ts')

/** 与 MathFormula.tsx 同一组选项 */
const renderer = (displayMode) => (tex) =>
  katex.renderToString(normalizeBeautifyMath(tex), { throwOnError: true, strict: 'ignore', trust: isTrustedMathCommand, displayMode })

/** 页面真实路径：整块渲染，失败则逐块降级；返回所有会被 dangerouslySetInnerHTML 写进页面的 HTML */
const pageHtml = (tex, displayMode) => {
  const plan = planMathRender(tex, renderer(displayMode))
  return plan.mode === 'katex' ? plan.html : plan.parts.filter((p) => p.kind === 'rendered').map((p) => p.html).join('\n')
}

const ATTACKS = {
  'href javascript': '\\href{javascript:alert(1)}{x}',
  'url javascript': '\\url{javascript:alert(1)}',
  'url http': '\\url{http://evil.example/a}',
  'htmlStyle background url': '\\htmlStyle{background:url(http://evil.example/a.png)}{x}',
  'htmlClass evil': '\\htmlClass{evil}{x}',
  'htmlClass 白名单 + evil': '\\htmlClass{md-cap-l evil}{x}',
  'htmlStyle position fixed': '\\htmlStyle{position:fixed;top:0;left:0;width:100vw;height:100vh}{x}',
  'htmlStyle font-size 999em': '\\htmlStyle{font-size:999em}{x}',
  'htmlStyle font-size 合法 + 夹带': '\\htmlStyle{font-size:1em;position:fixed}{x}',
  'htmlStyle rotate 99999deg': '\\htmlStyle{display:inline-block;transform:rotate(99999deg)}{x}',
  htmlData: '\\htmlData{evil=1}{x}',
  htmlId: '\\htmlId{evil}{x}',
  includegraphics: '\\includegraphics{http://evil.example/a.png}',
  'scalebox 内夹带': '\\scalebox{2}{\\htmlStyle{position:fixed}{x}}',
  'rotatebox 内夹带 href': '\\rotatebox{30}{\\href{javascript:alert(1)}{x}}',
  'raisebox 内夹带 url': '\\raisebox{1em}[0pt][0pt]{\\url{http://evil.example}}',
  '宏展开出 href': '\\def\\x{\\href{javascript:alert(1)}{y}}\\x',
  '\\text 内 href': '\\text{\\href{javascript:alert(1)}{y}}',
}

const FORBIDDEN = {
  '<a 标签': /<a[\s>]/iu,
  'href=': /href\s*=/iu,
  'javascript:': /javascript:/iu,
  'url(': /url\(/iu,
  position: /position/iu,
  '<img': /<img/iu,
  'id 属性': /\sid\s*=/iu,
  'data-* 属性': /\sdata-[a-z]/iu,
}
const classesOf = (html) => [...html.matchAll(/class="([^"]*)"/gu)].flatMap((m) => m[1].split(/\s+/u))
const stylesOf = (html) => [...html.matchAll(/style="([^"]*)"/gu)].map((m) => m[1])

test('X1 危险输入渲染后没有链接 / 外联 / 定位 / 图片 / id / data-* / evil class', () => {
  for (const [name, tex] of Object.entries(ATTACKS)) {
    for (const displayMode of [true, false]) {
      const html = pageHtml(tex, displayMode)
      for (const [label, re] of Object.entries(FORBIDDEN)) {
        assert.ok(!re.test(html), `${name}（${displayMode ? '块' : '行内'}）输出里出现 ${label}`)
      }
      assert.deepEqual(classesOf(html).filter((c) => /evil/u.test(c)), [], `${name} 带出了 evil class`)
      assert.deepEqual(stylesOf(html).filter((s) => /position|url\(|999|99999/u.test(s)), [], `${name} 带出了危险 style`)
    }
  }
})

test('X2 scalebox / rotatebox 的极端数值被夹住', () => {
  const big = pageHtml('\\scalebox{999}{x}', true)
  assert.ok(stylesOf(big).includes('font-size:10em'), '999 应夹到 10em')
  assert.ok(!stylesOf(big).some((s) => /font-size:999/u.test(s)))
  const rot = pageHtml('\\rotatebox{99999}{x}', true)
  assert.ok(stylesOf(rot).includes('display:inline-block;transform:rotate(360deg)'), '99999 应夹到 360deg')
  const neg = pageHtml('\\rotatebox{-99999}{x}', true)
  assert.ok(stylesOf(neg).includes('display:inline-block;transform:rotate(-360deg)'), '-99999 应夹到 -360deg')
})

test('X3 trust 回调：危险命令恒 false，样式 / class 严格白名单', () => {
  for (const command of ['\\href', '\\url', '\\includegraphics', '\\htmlId', '\\htmlData', '\\htmlStyle', '\\htmlClass', undefined]) {
    if (command === '\\htmlStyle' || command === '\\htmlClass') {
      continue
    }
    assert.equal(isTrustedMathCommand({ command, url: 'javascript:1', style: 'font-size:1em', class: 'md-cap-l' }), false, `${String(command)} 不能放行`)
  }
  const style = (value) => isTrustedMathCommand({ command: '\\htmlStyle', style: value })
  assert.equal(style('font-size:10em'), true)
  assert.equal(style('font-size:10.1em'), false)
  assert.equal(style('font-size:99em'), false)
  assert.equal(style('display:inline-block;transform:rotate(360deg)'), true)
  assert.equal(style('display:inline-block;transform:rotate(-360deg)'), true)
  assert.equal(style('display:inline-block;transform:rotate(361deg)'), false)
  assert.equal(style('font-size:1em\n'), false)
  assert.equal(style('font-size:1em;position:fixed'), false)
  assert.equal(style('background:url(http://evil.example)'), false)
  assert.equal(isTrustedMathCommand({ command: '\\htmlStyle' }), false)
  for (const cls of ['md-cap-l', 'md-cap-r', 'md-tail-bl', 'md-tail-br']) {
    assert.equal(isTrustedMathCommand({ command: '\\htmlClass', class: cls }), true)
  }
  for (const cls of ['evil', 'md-cap-l evil', 'md-cap-l ', '', undefined]) {
    assert.equal(isTrustedMathCommand({ command: '\\htmlClass', class: cls }), false, `class ${JSON.stringify(cls)} 不能放行`)
  }
})

test("X4 strict:'ignore' 没有把写坏的公式吞成乱码：仍然抛错 / 走降级", () => {
  for (const bad of ['\\frac{1}{2', '\\begin{foo}x\\end{foo}', 'x^{', '\\left( x']) {
    assert.throws(() => renderer(true)(bad), katex.ParseError, `${bad} 应抛 ParseError`)
    const plan = planMathRender(bad, renderer(true))
    assert.equal(plan.mode, 'degraded', `${bad} 应走降级`)
    assert.ok(plan.parts.some((p) => p.kind === 'unsupported'), `${bad} 应有 unsupported 块`)
    assert.ok(!plan.parts.some((p) => p.kind === 'rendered' && /katex-error/u.test(p.html)), `${bad} 不该渲染红字`)
  }
})

test('X5 普通公式、合法美化写法不受影响', () => {
  assert.equal(planMathRender('x^2+\\frac{1}{2}', renderer(true)).mode, 'katex')
  assert.equal(planMathRender('\\scalebox{1.5}{\\text{ok}}', renderer(true)).mode, 'katex')
  assert.equal(planMathRender('\\rotatebox{90}{\\text{ok}}', renderer(true)).mode, 'katex')
})
