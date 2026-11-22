// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <2s]
//
// Issue #821：气泡美化包（#486 第五节）让模型用排版宏把气泡「画」出来，而 KaTeX 0.16 缺
// `\scalebox` / `\rotatebox` / `\resizebox` / `\parbox` / `\vspace` 等命令。改动前的行为是
// **一个未定义命令 → 整块 ParseError → 整块换成 TeX 原文**，用户看到一屏反斜杠（判定：源码外露）。
//
// 这里钉死修复后的契约（纯逻辑，DOM/截图由 docs/ui/821-katex-macros 的 390 / 360 验收）：
//
//   T1 宏支持矩阵：票面点名的宏里哪些 KaTeX 真的支持（防止以后升级 KaTeX 时这张表悄悄失效）
//   T2 顶层的 `\\` 才分块；`\text{a\\b}` 里的 `\\` 不分；`\\[2pt]` 的间距参数被吃掉
//   T3 逐块降级：含 `\scalebox` 的块失败**不影响**其它块，失败的块给原文 + 可读原因
//   T4 A 方案等价映射：丢缩放/旋转/宽度，保留内容；纯位置指令直接删
//   T5 正常公式仍是「整块一次渲染」——行为与改动前完全一致（aligned 里的 `\\` 不许被拆）
//   T6 C 兜底：整段都渲染不了时也只给「可读提示 + 原文」，不再整块甩 TeX
//   T7 任意垃圾输入都不抛错（降级路径是最后一道防线，它自己不能炸）
//
//   node tests/run-layer.mjs unit --only math-blocks-821
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import katex from 'katex'
import { loadTsModule } from '../helpers/dom-env.mjs'

const {
  planMathRender,
  splitMathBlocks,
  downgradeMathSource,
  hasRenderLeak,
  probeUnsupportedCommands,
  resetCapabilityCache,
} = await loadTsModule('src/services/markdown/mathBlocks.ts')

/** 与组件里 `MathFormula.tsx` 完全相同的选项：throwOnError 开、strict 关、displayMode 开 */
const render = (tex) =>
  katex.renderToString(tex, { throwOnError: true, strict: false, displayMode: true })

const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/** 真探测出来的「不可用命令」集合（不是按版本号猜的） */
const UNSUPPORTED = probeUnsupportedCommands(render)

/**
 * 票面那段「美化4.1（安卓深色）」的输出：`\sf` + 4 个用 `\\[2pt]` 隔开的模块，
 * 头像用 `\text{◖◗}` 画、气泡底色用 `\colorbox`、分隔线用 `\rule{30em}{0pt}`、
 * 名字缩放用 `\scalebox`、时间戳上用 `\raisebox` + `\rotatebox` 叠一个角标。
 */
const BEAUTY = [
  '\\sf',
  '\\colorbox{#1e1e20}{\\textcolor{#e6e6e6}{\\text{  DeepSeek  }}}\\hspace{-0.33em}\\raisebox{70pt}[0pt][0pt]{\\text{◖◗}}\\hspace{-2em}\\rule{30em}{0pt}',
  '\\\\[2pt]',
  '\\scalebox{1.2}[1.2]{\\text{小助手}}\\hspace{-0.33em}\\colorbox{#2b2b2b}{\\text{\\textcolor{#fff}{ 今天 14:02 }}}',
  '\\\\[6pt]',
  '\\smash{\\text{◖◗}}\\hspace{-0.33em}\\colorbox{#2b2b2b}{\\text{\\textcolor{#e6e6e6}{ 你好，我是助手 }}}\\raisebox{70pt}[0pt][0pt]{\\rotatebox{15}{\\text{o}}}',
  '\\\\[2pt]',
  '\\rule{30em}{0pt}\\hspace{-2em}\\text{\\textcolor{#888}{已读}}',
].join('\n')

/** 票面点名的宏：实测结论（支持 / 不支持）在这里固定下来 */
const MACRO_MATRIX = [
  ['\\scalebox', '\\scalebox{1.2}[1.2]{A}', false],
  ['\\rotatebox', '\\rotatebox{15}{A}', false],
  ['\\hspace', 'a\\hspace{-2em}b', true],
  ['\\raisebox', '\\raisebox{70pt}[0pt][0pt]{A}', true],
  ['\\rule', '\\rule{30em}{0pt}', true],
  ['\\colorbox', '\\colorbox{#2b2b2b}{\\text{hi}}', true],
  ['\\smash', '\\smash{A}', true],
  ['\\sf', '{\\sf A}', true],
  ['\\text', '\\text{◖◗}', true],
]

test('T1 票面宏的支持矩阵与实测一致（KaTeX 0.16，strict: false）', () => {
  for (const [name, tex, supported] of MACRO_MATRIX) {
    let ok = true
    try {
      render(tex)
    } catch {
      ok = false
    }
    assert.equal(ok, supported, `${name} 的支持结论变了：期望 ${supported ? '支持' : '不支持'}`)
  }
})

test('T1b 探测结果就是「真渲染失败/出残渣」的那些命令，raisebox 靠残渣被识破', () => {
  // 不认识的命令：抛 ParseError
  for (const name of ['scalebox', 'rotatebox', 'resizebox', 'parbox', 'vspace']) {
    assert.ok(UNSUPPORTED.includes(name), `${name} 应当被探测判为不可用`)
  }
  // `\raisebox` 是「认识但读错参数」：不抛错，靠残渣探测才抓得到
  assert.ok(UNSUPPORTED.includes('raisebox'), '`\\raisebox{1pt}[0pt][0pt]{x}` 会打出 `[0pt][0pt]`，必须判为不可用')
  // 票面里明确支持的宏不该出现在集合里（探测没误伤）
  for (const name of ['text', 'textcolor', 'colorbox', 'rule', 'hspace', 'smash', 'sf']) {
    assert.ok(!UNSUPPORTED.includes(name), `${name} 是支持的，不该被降级`)
  }
})

test('T1d 判定跟着实现走，不跟着版本号走：换一个「认识 \\scalebox」的渲染器就不该再降级它', () => {
  resetCapabilityCache()
  /** 假装未来的 KaTeX 支持了 `\\scalebox`：把它当普通分组渲染 */
  const futureRender = (tex) => render(tex.replace(/\\scalebox\{[^{}]*\}(\[[^\]]*\])?/gu, ''))
  const futureUnsupported = probeUnsupportedCommands(futureRender)
  assert.ok(!futureUnsupported.includes('scalebox'), '实现支持了就不该再列进「不可用」')
  // 于是也不再改写它
  assert.equal(
    downgradeMathSource('\\scalebox{1.2}[1.2]{A}', futureUnsupported).tex,
    '\\scalebox{1.2}[1.2]{A}',
    '探测说可用，就不许动用户源码'
  )
  // 恢复真实探测结果，后面的用例不受影响
  resetCapabilityCache()
  assert.ok(probeUnsupportedCommands(render).includes('scalebox'), '换回真渲染器后仍是不可用（KaTeX 0.16）')
})

test('T1c 探测缓存生效：第二次调用不再重新渲染（#209：运行期只探一次）', () => {
  let calls = 0
  const countingRender = (tex) => {
    calls += 1
    return render(tex)
  }
  resetCapabilityCache()
  probeUnsupportedCommands(countingRender)
  const firstPass = calls
  calls = 0
  probeUnsupportedCommands(countingRender)
  assert.equal(calls, 0, '第二次调用必须直接读缓存，不再渲染')
  assert.ok(firstPass > 10, '第一次要把每个可疑命令都真渲染一遍')
})

test('T2 只在顶层 `\\\\` 分块，`\\text{a\\\\b}` 与 `\\\\[2pt]` 的间距参数都不影响分块', () => {
  assert.deepEqual(splitMathBlocks('a\\\\b\\\\c'), ['a', 'b', 'c'], '顶层 `\\\\` 要分块')
  assert.deepEqual(splitMathBlocks('a\\\\[2pt]b'), ['a', 'b'], '`\\\\[2pt]` 的间距参数要被吃掉')
  assert.deepEqual(
    splitMathBlocks('\\text{a\\\\b}\\\\c'),
    ['\\text{a\\\\b}', 'c'],
    '`\\text{…}` 里的 `\\\\` 是文字里的换行，不能当成模块分隔'
  )
  assert.deepEqual(splitMathBlocks('a\\\\\\\\b'), ['a', 'b'], '连续 `\\\\` 产生的空模块要丢掉')
  assert.deepEqual(splitMathBlocks('   '), [], '纯空白没有模块')
})

test('T3 A 方案把整段救回来：四个模块各占一行，整段不再炸成原文', () => {
  const plan = planMathRender(BEAUTY, render)
  // 多模块 + 动过源码 → 逐模块渲染（整块渲染会把四行叠在同一个基线上，见 preferBlocks 注释）
  assert.equal(plan.mode, 'degraded')
  assert.equal(plan.parts.length, 4, '四个模块各一项、各占一行')
  assert.equal(
    plan.parts.filter((part) => part.kind === 'rendered').length,
    4,
    '映射掉 `\\scalebox` / `\\rotatebox` 之后四块都该渲染出来'
  )
  assert.deepEqual(
    [...plan.approximated].sort(),
    ['\\raisebox', '\\rotatebox', '\\scalebox'],
    '丢过缩放/旋转/绝对位移都要记下来'
  )
  for (const part of plan.parts) {
    assert.equal(part.kind, 'rendered')
    assert.equal(hasRenderLeak(part.html), false, '每块都不许带 `[0pt][0pt]` 这类残渣')
  }
})

test('T3c 单块公式也能被救回来：映射后渲染成功，并给出「已简化」提示', () => {
  const plan = planMathRender('\\raisebox{70pt}[0pt][0pt]{\\text{A}}', render)
  assert.equal(plan.mode, 'degraded', '需要改写源码时走降级视图（提示与原文开关都在这里）')
  assert.equal(plan.parts.length, 1, '只有一块')
  assert.equal(plan.parts[0].kind, 'rendered', '映射之后应当渲染成功')
  assert.equal(hasRenderLeak(plan.parts[0].html), false)
  assert.deepEqual(plan.approximated, ['\\raisebox'], '要告诉界面「已简化」')
})

test('T3b 关掉 A 方案（不映射）时，也只有失败的那一块降级，其余照常渲染', () => {
  // `downgrade: false` = 负向对照：只留 B（逐块降级），看它单独能不能撑住
  const plan = planMathRender(BEAUTY, render, { downgrade: false })
  assert.equal(plan.mode, 'degraded')
  const rendered = plan.parts.filter((part) => part.kind === 'rendered')
  const failed = plan.parts.filter((part) => part.kind === 'unsupported')
  // 只剩模块 4（`\rule` + `\hspace` + 纯文字）能干净渲染：
  // 模块 2 缺 `\scalebox`（抛错），模块 1/3 的 `\raisebox{..}[..][..]` 会被 KaTeX 当文字打出来（残渣）
  assert.equal(rendered.length, 1, '只有完全干净的那一块能渲染')
  assert.equal(failed.length, 3, '其余三块各自降级，互不牵连')
  for (const part of failed) {
    assert.ok(part.source.length > 0, '降级块要带上自己的原文，便于「查看原文」')
    assert.ok(!part.source.includes('已读'), '降级块只包含自己那一块，不许把整段原文甩出来')
    assert.ok(
      part.reason === '' || /Undefined control sequence/u.test(part.reason),
      '降级块要么带 KaTeX 的原因，要么留空由界面用本地化文案（残渣路径没有抛错）'
    )
  }
})

test('T4 A 方案等价映射：丢缩放/旋转/宽度保留内容，纯位置指令删掉，环境改名', () => {
  const cases = [
    ['\\scalebox{1.2}[1.2]{A}', '{A}', '\\scalebox'],
    ['\\rotatebox{15}{o}', '{o}', '\\rotatebox'],
    ['\\resizebox{1em}{!}{A}', '{A}', '\\resizebox'],
    ['\\parbox{3em}{A}', '{A}', '\\parbox'],
    ['\\vspace{1em}a', 'a', '\\vspace'],
    ['\\setlength{\\x}{0pt}a', 'a', '\\setlength'],
    ['\\fontsize{20}{24}\\selectfont a', ' a', '\\fontsize'],
    ['\\begin{center}x\\end{center}', 'x', '\\center'],
    ['\\begin{tabular}{c}a\\end{tabular}', '\\begin{array}{c}a\\end{array}', '\\tabular'],
    ['\\hfill a', ' a', '\\hfill'],
    // KaTeX 认 `\\raisebox` 但不认它的可选参数（会被当文字打出来），且 70pt 是美化包的绝对定位
    // —— 可选参数剥掉、超大位移丢掉，内容留在原地
    ['\\raisebox{70pt}[0pt][0pt]{A}', '{A}', '\\raisebox'],
    // 嵌套：外层命令会整段吞掉参数，必须递归进内容里再映射
    ['\\raisebox{70pt}[0pt][0pt]{\\rotatebox{15}{o}}', '{{o}}', '\\rotatebox'],
  ]
  for (const [source, expected, name] of cases) {
    const result = downgradeMathSource(source, UNSUPPORTED)
    assert.equal(result.tex, expected, `${name} 的映射结果不对`)
    assert.ok(result.approximated.includes(name), `${name} 要出现在 approximated 里`)
  }
  // 小位移是正常微调，必须原样保留（不能被「夹断」误伤）
  const micro = downgradeMathSource('\\raisebox{2pt}{A}', UNSUPPORTED)
  assert.equal(micro.tex, '\\raisebox{2pt}{A}', '2pt 的微调不该被当成绝对定位')
  assert.deepEqual(micro.approximated, [], '没有改写的就不该报「已简化」')
  // 表外的命令原样保留（宁可不救，也不改坏内容）
  const untouched = '\\frac{1}{2}+\\hspace{-1em}'
  assert.equal(downgradeMathSource(untouched, UNSUPPORTED).tex, untouched)
  assert.deepEqual(downgradeMathSource(untouched, UNSUPPORTED).approximated, [])
})

test('T5 正常公式仍走整块一次渲染，aligned 里的 `\\\\` 不许被拆开', () => {
  const normal = '\\int_0^1 x^2\\,\\mathrm{d}x = \\frac{1}{3}'
  const plan = planMathRender(normal, render)
  assert.equal(plan.mode, 'katex', '普通公式必须仍是一次渲染（行为与改动前一致）')
  assert.equal(plan.html, render(normal))

  const aligned = '\\begin{aligned}a&=1\\\\b&=2\\end{aligned}'
  const alignedPlan = planMathRender(aligned, render)
  assert.equal(alignedPlan.mode, 'katex', 'aligned 的 `\\\\` 是行分隔，整块渲染成功就不能拆')
})

test('T6 整段都渲染不了时给可读降级（原文 + 原因），不再整块甩 TeX', () => {
  const plan = planMathRender('\\undefinedcmd{a}', render)
  assert.equal(plan.mode, 'degraded')
  assert.equal(plan.parts.length, 1)
  const [part] = plan.parts
  assert.equal(part.kind, 'unsupported')
  assert.equal(part.source, '\\undefinedcmd{a}', '这一块要原样交给「查看原文」')
  assert.match(part.reason, /Undefined control sequence/u, '要带 KaTeX 的原始原因，便于折叠里解释')
})

test('T7 垃圾输入不抛错（降级路径自己不能炸）', () => {
  const junk = ['', '   ', '\\\\', '\\\\[2pt]', '{', '}', '\\', 'a\\{b', '\\scalebox{', '\\vspace{}']
  for (const source of junk) {
    const plan = planMathRender(source, render)
    assert.ok(plan.mode === 'katex' || plan.mode === 'degraded', `${JSON.stringify(source)} 也要有结果`)
    if (plan.mode === 'degraded') {
      assert.ok(plan.parts.length > 0, `${JSON.stringify(source)} 不能给出空视图`)
    }
  }
  // 整段只剩间距指令：映射后什么都不剩，渲染成空即可，不报错也不留残渣
  const spacingOnly = planMathRender('\\vspace{1em}\\\\[2pt]\\hfill', render)
  const spacingHtml =
    spacingOnly.mode === 'katex' ? spacingOnly.html : spacingOnly.parts.map((part) => (part.kind === 'rendered' ? part.html : '')).join('')
  assert.equal(hasRenderLeak(spacingHtml), false, '只剩间距指令时不许留下残渣')
  assert.ok(spacingHtml.trim() === '' || !spacingHtml.includes('\\\\'), '不剩内容就渲染成空')
})

test('T8 契约：组件接线（整块原文的兜底已撤掉，降级路径与文案都接上了）', () => {
  const component = readSource('src/components/markdown/MathFormula.tsx')
  assert.ok(component.includes('planMathRender'), 'MathFormula 必须走 planMathRender')
  assert.ok(
    !component.includes('previousResultRef.current ?? { html: input'),
    '改动前的「整块换原文」兜底必须已经撤掉'
  )
  for (const key of [
    'mathUnsupportedBlock',
    'mathSourceToggle',
    'mathUnsupportedReason',
    'mathSimplified',
  ]) {
    assert.ok(component.includes(`t('${key}')`), `组件要用上 ${key}`)
  }
  const zh = readSource('src/i18n/zh.ts')
  const en = readSource('src/i18n/en.ts')
  for (const key of [
    'mathUnsupportedBlock',
    'mathSourceToggle',
    'mathUnsupportedReason',
    'mathSimplified',
  ]) {
    assert.ok(zh.includes(`${key}:`), `中文缺 ${key}`)
    assert.ok(en.includes(`${key}:`), `英文缺 ${key}`)
  }
})

test('T9 残渣探测：`\\raisebox` 的可选参数会被 KaTeX 当文字打出来，必须被判成没渲染好', () => {
  // 关键事实：KaTeX **不报错**，只是把 `[0pt][0pt]` 原样打出来（#821 浏览器验收抓到的第二类问题）
  const leaky = render('\\raisebox{70pt}[0pt][0pt]{\\text{A}}')
  assert.equal(hasRenderLeak(leaky), true, '`[0pt][0pt]` 必须被判成残渣')
  const clean = render('\\raisebox{70pt}{\\text{A}}')
  assert.equal(hasRenderLeak(clean), false, '正常 `\\raisebox` 不是残渣')
  // 走完 plan：整段只有这一处，映射后应当渲染成功、且结果干净
  const plan = planMathRender('\\raisebox{70pt}[0pt][0pt]{\\text{A}}', render)
  assert.equal(plan.mode, 'degraded')
  assert.equal(hasRenderLeak(plan.parts[0].html), false)
  // 映射关掉时不能把残渣当成功：应当降级成原文 + 可读提示
  const raw = planMathRender('\\raisebox{70pt}[0pt][0pt]{\\text{A}}', render, { downgrade: false })
  assert.equal(raw.mode, 'degraded', '残渣不许当渲染成功端给用户')
  assert.equal(raw.parts[0].kind, 'unsupported')
})
