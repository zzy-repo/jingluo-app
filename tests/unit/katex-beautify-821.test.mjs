// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
//
// Issue #821：「美化规则」用 \scalebox / \raisebox / \rotatebox 画聊天气泡，KaTeX 不认，整条消息退化成源码（B 类）。
// 渲染效果（形状 / 配色 / 390·360 截图）由 `docs/ui/821-katex-beautify` 验收；这里钉死纯逻辑：
//
//   T1 两份规则文件里的 10 个「完整示例」逐字喂给 `MathFormula` 用的同一组选项：不抛、不出 `katex-error`
//   T2 改写不碰普通公式（没有这三个命令时原样返回），也不改写没有这些命令的文本
//   T3 `trust` 白名单：只放行改写自己生成的样式；用户手写的定位 / 外联 / 超大字号一律拒绝
//   T4 手写 \\htmlStyle / \\href 不会进 style / href 属性（trust 没有被绕开；被拒命令只以红色源码文本回显）
//   T5 `◖ ◗ ◣ ◢` 不再作为文字字形输出（各机型回退字体不一致，是气泡对不齐的根因）
//   T6 `MathFormula` 确实走了 normalizeBeautifyMath + isTrustedMathCommand（接线断言：有没有第二套实现只能看代码）
//
// 负向对照：把 MathFormula 里的 normalizeBeautifyMath 摘掉 → T6 红；把 `\scalebox` 的改写关掉 → T1 红。
//
//   node tests/run-layer.mjs unit --only katex-beautify-821
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installEndpointsGlobals()
installTsResolve()

const require = createRequire(import.meta.url)
const katex = require('katex')
const { normalizeBeautifyMath, isTrustedMathCommand } = await loadTsModule('src/services/markdown/mathCompat.ts')

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
const fixture = (name) => JSON.parse(read(`tests/fixtures/katex-beautify-821/${name}.json`)).examples
const DARK = fixture('avatar-bubble-dark')
const LIGHT = fixture('user-bubble-light')

/** 与 MathFormula.tsx 同一组选项；throwOnError 打开：抛了就是退化成源码，红字则看 katex-error */
const OPTIONS = { throwOnError: true, strict: 'ignore', trust: isTrustedMathCommand, displayMode: true }
const render = (tex) => katex.renderToString(normalizeBeautifyMath(tex), OPTIONS)

for (const [name, examples] of [['深色头像气泡', DARK], ['用户气泡', LIGHT]]) {
  test(`T1 ${name}：5 个完整示例都能渲染，不抛、无 katex-error`, () => {
    assert.equal(examples.length, 5, 'fixture 应有 5 个示例')
    examples.forEach((tex, index) => {
      let html = ''
      assert.doesNotThrow(() => {
        html = render(tex)
      }, `示例 ${index + 1} 抛错（= 页面上整条消息退化成源码）`)
      assert.ok(!html.includes('katex-error'), `示例 ${index + 1} 出现红字`)
      assert.ok(html.includes('class="katex"'), `示例 ${index + 1} 没有渲染出公式`)
    })
  })
}

test('T1b 修复前的行为：不改写直接渲染，两份规则全部抛 Undefined control sequence', () => {
  for (const tex of [...DARK, ...LIGHT]) {
    assert.throws(() => katex.renderToString(tex, { throwOnError: true, strict: false, displayMode: true }), /Undefined control sequence/)
  }
})

test('T2 没有 scalebox / raisebox / rotatebox 的普通公式原样返回', () => {
  for (const tex of ['x^2+\\frac{1}{2}', '\\begin{array}{l}a\\\\b\\end{array}', '\\colorbox{#fff}{\\text{x}}', '']) {
    assert.equal(normalizeBeautifyMath(tex), tex)
  }
})

test('T3 trust 白名单：只放行自己生成的样式与固定 class', () => {
  const style = (value) => isTrustedMathCommand({ command: '\\htmlStyle', style: value })
  assert.equal(style('font-size:1.2em'), true)
  assert.equal(style('display:inline-block;transform:rotate(-90deg)'), true)
  for (const bad of [
    'position:fixed;top:0;left:0;width:100vw;height:100vh',
    'background:url(http://evil.example/x.png)',
    'font-size:99em',
    'display:inline-block;transform:rotate(9999deg)',
    'font-size:1em;position:fixed',
  ]) {
    assert.equal(style(bad), false, `不该放行：${bad}`)
  }
  assert.equal(isTrustedMathCommand({ command: '\\htmlClass', class: 'md-cap-l' }), true)
  assert.equal(isTrustedMathCommand({ command: '\\htmlClass', class: 'evil' }), false)
  for (const command of ['\\href', '\\url', '\\includegraphics', '\\htmlData', '\\htmlId']) {
    assert.equal(isTrustedMathCommand({ command, style: 'font-size:1em', class: 'md-cap-l' }), false, `${command} 不能放行`)
  }
})

test('T4 用户手写的 \\htmlStyle / \\href 不能借改写绕过 trust', () => {
  // 被拒的命令会以红色源码文本回显（KaTeX 的标准降级），所以只查**属性**：style / href 里不能带出去
  const attacks = ['\\htmlStyle{position:fixed;top:0}{X}', '\\htmlStyle{background:url(http://evil.example/a.png)}{X}', '\\href{http://evil.example}{X}']
  const attrs = (html) => [...html.matchAll(/\s(style|href)="([^"]*)"/gu)].map((m) => `${m[1]}=${m[2]}`)
  for (const tex of attacks) {
    const html = katex.renderToString(normalizeBeautifyMath(tex), { ...OPTIONS, throwOnError: false })
    const bad = attrs(html).filter((a) => /position|url\(|http|^href=/u.test(a))
    assert.deepEqual(bad, [], `被放行：${tex}`)
  }
  for (const tex of [...DARK, ...LIGHT]) {
    const bad = attrs(render(tex)).filter((a) => /position|url\(|http|^href=/u.test(a))
    assert.deepEqual(bad, [], '改写结果的属性里不该带出定位 / 外联')
  }
})

test('T5 ◖ ◗ ◣ ◢ 不再作为文字字形输出，改成 \\rule 形状', () => {
  for (const tex of [...DARK, ...LIGHT]) {
    const html = render(tex)
    assert.ok(!/[◖◗◣◢]/u.test(html.slice(html.indexOf('class="katex-html"'))), '可见区里还有形状字符（回退字体会各画各的）')
  }
  const html = render(LIGHT[0])
  assert.ok(html.includes('md-cap-l') && html.includes('md-cap-r') && html.includes('md-tail-bl'))
})

test('T5b 零宽占位词、撑宽的 \\rule 和块首负 \\hspace 被去掉（它们会让公式块出现 600px 横向滚动）', () => {
  const out = normalizeBeautifyMath(LIGHT[0])
  assert.ok(!out.includes('0.00001'))
  assert.ok(!/\\rule\s*\{30em\}/.test(out))
  assert.ok(!/^\s*\\hspace\s*\{-/.test(out))
})

test('T6 接线：MathFormula 走 normalizeBeautifyMath + isTrustedMathCommand，样式表被引入', () => {
  const source = read('src/components/markdown/MathFormula.tsx')
  assert.ok(source.includes('normalizeBeautifyMath('))
  assert.ok(source.includes('trust: isTrustedMathCommand'))
  assert.ok(source.includes("import './beautifyMath.css'"))
  assert.ok(!/trust:\s*true/.test(source), '不允许 trust:true（等于放开 \\htmlStyle / \\href 全部能力）')
})
