// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
//
// Issue #486 的 P0 四条里，纯逻辑的那几块在这里钉死（渲染与交互由 `docs/ui/486-markdown-render`
// 的 390 / 360 截图验收）：
//
//   T1 代码块行号开关的默认值 = 改造前的现状（关）            —— 默认开就会改掉所有存量代码块
//   T2 自动换行开关的默认值 = 改造前的现状（开，`pre-wrap`）  —— 反过来同样会改掉存量排版
//   T3 两个开关**刷新后仍生效**（写盘 → 冷启动读回）          —— 走既有 `chat-demo:*` 键，不另造存储
//   T4 行号切行：跨行 token 在行尾闭合、下一行按原属性重开     —— 逐行高亮会把 token 切成两半
//   T5 下载文件名按语言猜扩展名（未知语言回落 .txt）
//   T6 表格 → GFM：从真 AST 序列化（强调 / 行内代码 / 对齐 / 缺列补齐 / `|` 转义）
//   T7 公式源码：只从 `.katex-mathml annotation[encoding="application/x-tex"]` 取，且是纯 TeX
//
// 负向对照见文件末（人工各跑一次，结论写进 PR）：把行号默认值改成 true → T1 红；
// 把 annotation 选择器改成 `.katex-html` → T7 红。
//
//   node tests/run-layer.mjs unit --only markdown-render-486
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  installEndpointsGlobals,
  installTsResolve,
  loadTsModule,
  moduleUrl,
  setupDom,
} from '../helpers/dom-env.mjs'

installEndpointsGlobals()
installTsResolve()
const dom = setupDom()

const settingsUrl = moduleUrl('src/services/settings.ts')
/** 冷启动：同一个模块换一个 URL 再导入一次 = 应用重启后重新初始化 store（#102 同一套办法） */
const coldStart = (tag) => import(`${settingsUrl}?cold=${tag}`)
/** 读源码做接线断言（「有没有第二套实现」这种结论只能看代码，跑起来看不出来） */
const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/** 只读 localStorage（settings.ts 的 `read` 走 `localStorage.getItem`） */
const stored = (key) => globalThis.localStorage.getItem(key)

const settings = await loadTsModule('src/services/settings.ts')
const { splitHighlightedLines, codeFileName } = await loadTsModule('src/services/markdown/codeLines.ts')
const { tableToGfm } = await loadTsModule('src/services/markdown/toGfm.ts')
const { MATH_TEX_SELECTOR, readMathTexSource, stripMathDelimiters } = await loadTsModule(
  'src/services/markdown/mathSource.ts'
)
const { toMdAst } = await loadTsModule('src/services/markdown/parse.ts')

/** 取正文里第一张表，交给 GFM 序列化 —— 走真解析器，不手搓 mdast 节点 */
const gfmOfFirstTable = (markdown) => {
  const ast = toMdAst(markdown, { sources: undefined, disableLink: false })
  const table = ast.children.find((node) => node.type === 'table')
  assert.ok(table, `解析结果里没有表格节点：${JSON.stringify(ast.children.map((n) => n.type))}`)
  return tableToGfm(table)
}

test('T1 行号开关默认关（改造前没有行号），换行开关默认开（改造前就是 pre-wrap）', () => {
  const state = settings.useSettings.getState()
  assert.equal(state.codeLineNumbers, false, '默认就打开行号会改掉所有存量代码块的截图基线')
  assert.equal(state.codeWrap, true, '改造前 .md-code-block > pre 是 pre-wrap，默认关掉等于改排版')
})

test('T2 两个开关落既有 chat-demo:* 键，冷启动（刷新）后读回同一个值', async () => {
  settings.setCodeLineNumbers(true)
  settings.setCodeWrap(false)
  assert.equal(stored('chat-demo:code-line-numbers'), 'true')
  assert.equal(stored('chat-demo:code-wrap'), 'false')
  // 同一份 store 里的值也要立刻变（组件订阅的是它，不是 localStorage）
  assert.equal(settings.useSettings.getState().codeLineNumbers, true)
  assert.equal(settings.useSettings.getState().codeWrap, false)

  const reloaded = await coldStart('line-numbers-on')
  assert.equal(reloaded.useSettings.getState().codeLineNumbers, true, '刷新后行号开关丢了')
  assert.equal(reloaded.useSettings.getState().codeWrap, false, '刷新后换行开关丢了')

  // 脏值：读不出来一律回落默认（行号关 / 换行开），不能因为一个坏字符串就翻转外观
  globalThis.localStorage.setItem('chat-demo:code-line-numbers', 'yes')
  globalThis.localStorage.setItem('chat-demo:code-wrap', '0')
  const dirty = await coldStart('dirty')
  assert.equal(dirty.useSettings.getState().codeLineNumbers, false)
  assert.equal(dirty.useSettings.getState().codeWrap, true)

  // 复原，别把状态漏给同进程的下一个文件
  settings.setCodeLineNumbers(false)
  settings.setCodeWrap(true)
})

test('T3 行号切行：跨行 token 行尾闭合、下一行按原属性重开，拼回去与整段等价', () => {
  const html =
    '<span class="token comment">/* a\nb */</span><span class="token keyword">const</span> x = 1\nplain'
  const lines = splitHighlightedLines(html)
  assert.equal(lines.length, 3, `行数不对：${JSON.stringify(lines)}`)
  assert.equal(lines[0], '<span class="token comment">/* a</span>')
  assert.equal(
    lines[1],
    '<span class="token comment">b */</span><span class="token keyword">const</span> x = 1'
  )
  assert.equal(lines[2], 'plain')

  // 空行也要占一行，否则行号会跳号
  assert.deepEqual(splitHighlightedLines('a\n\nb'), ['a', '', 'b'])
  // 嵌套 token：闭合顺序必须与打开顺序相反，否则 HTML 结构非法
  const nested = splitHighlightedLines('<em><strong>a\nb</strong></em>')
  assert.equal(nested[0], '<em><strong>a</strong></em>')
  assert.equal(nested[1], '<em><strong>b</strong></em>')
  // 没有换行时原样返回（关闭行号走的是整段 innerHTML，这条保证两条路径同一份输入）
  assert.deepEqual(splitHighlightedLines('<span>x</span>'), ['<span>x</span>'])
})

test('T4 下载文件名按语言猜扩展名，未知语言回落 .txt', () => {
  assert.equal(codeFileName('python'), 'snippet.py')
  assert.equal(codeFileName('py'), 'snippet.py')
  assert.equal(codeFileName('TypeScript'), 'snippet.ts')
  assert.equal(codeFileName('tsx'), 'snippet.tsx')
  assert.equal(codeFileName('shell'), 'snippet.sh')
  assert.equal(codeFileName('mermaid'), 'snippet.mmd')
  assert.equal(codeFileName('python title=示例'), 'snippet.py')
  assert.equal(codeFileName(''), 'snippet.txt')
  assert.equal(codeFileName('brainfuck'), 'snippet.txt')
  // 不允许出现路径分隔符之类会把文件名变成路径的东西
  assert.ok(!codeFileName('../etc/passwd').includes('/'))
})

test('T5 表格复制为 GFM：对齐行 / 行内代码 / 强调 / 缺列补齐', () => {
  const gfm = gfmOfFirstTable(
    ['| 名称 | 数量 | 备注 |', '| :--- | ---: | :---: |', '| `a\\|b` | 12 | **粗** |', '| 缺列 |'].join('\n')
  )
  assert.equal(
    gfm,
    ['| 名称 | 数量 | 备注 |', '| :--- | ---: | :---: |', '| `a\\|b` | 12 | **粗** |', '| 缺列 |  |  |'].join(
      '\n'
    ),
    `GFM 序列化不对：\n${gfm}`
  )
  // 单元格里的 | 必须转义，否则粘回去会多出一列
  for (const line of gfm.split('\n')) {
    assert.ok(line.startsWith('| ') && line.endsWith(' |'), `不是标准 GFM 行：${line}`)
  }
})

test('T6 公式源码：从 katex-mathml 的 annotation 取纯 TeX，不带 $ 定界符', () => {
  assert.equal(MATH_TEX_SELECTOR, '.katex-mathml annotation[encoding="application/x-tex"]')
  const annotation = { textContent: '\\frac{a}{b}' }
  const host = { querySelector: (selector) => (selector === MATH_TEX_SELECTOR ? annotation : null) }
  assert.equal(readMathTexSource(host), '\\frac{a}{b}')
  // 只有可见字形（没有 MathML 子树）时取不到 —— 这正是「框选复制得到排版碎片」的原因
  assert.equal(
    readMathTexSource({ querySelector: () => null }),
    null
  )
  assert.equal(readMathTexSource(null), null)
  assert.equal(stripMathDelimiters('$$x^2$$'), 'x^2')
  assert.equal(stripMathDelimiters('$x^2$'), 'x^2')
  assert.equal(stripMathDelimiters('x^2'), 'x^2')
  // 单个 $ 是合法 TeX 字符时不能被误剥
  assert.equal(stripMathDelimiters('\\$5'), '\\$5')
})

test('T7 接线：开关走既有 settings store，代码下载走既有落盘出口（没有第二套实现）', () => {
  const codeBlockSource = readSource('src/components/markdown/CodeBlock.tsx')
  // 开关：读 / 写都来自 services/settings.ts 的那两个 setter，组件自己不碰 localStorage
  assert.match(codeBlockSource, /from '\.\.\/\.\.\/services\/settings\.js'/)
  assert.match(codeBlockSource, /setCodeLineNumbers\(/)
  assert.match(codeBlockSource, /setCodeWrap\(/)
  assert.doesNotMatch(codeBlockSource, /localStorage\.(getItem|setItem|removeItem)/)
  // 下载：复用 savePlainText（Android 走 ExportText 原生桥，Web 走 Blob），组件里不许再写一套落盘
  assert.match(codeBlockSource, /from '\.\.\/\.\.\/utils\/savePlainText\.js'/)
  assert.match(codeBlockSource, /savePlainText\(/)
  assert.doesNotMatch(codeBlockSource, /createObjectURL|createElement\('a'\)/)
  // 出口本身只有一份：`saveTextFile` 仍是 services/exportText.ts 里那个
  const exportText = readSource('src/services/exportText.ts')
  assert.match(exportText, /export const saveTextFile = async/)
  assert.match(exportText, /'NATIVE_EXPORT_UNAVAILABLE'/)
  // 表格复制：从 AST 序列化，不读 innerText
  const rendererSource = readSource('src/components/markdown/MarkdownAstRenderer.tsx')
  assert.match(rendererSource, /tableToGfm\(node\)/)
  assert.doesNotMatch(rendererSource, /\.innerText\b/)
  // 公式复制：选择器只有一处定义，组件引用它而不是自己写字面量
  const mathSource = readSource('src/components/markdown/MathFormula.tsx')
  assert.match(mathSource, /readMathTexSource/)
  assert.doesNotMatch(mathSource, /querySelector/)
})

test.after(() => {
  dom.restore()
})
