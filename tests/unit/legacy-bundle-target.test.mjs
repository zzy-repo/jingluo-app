// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s（dist 存在时多几秒）]
// GitHub issue #13「低内核白屏」的**构建**那一半：把语法下限焊死在构建配置上，并且在产物层面自证。
//
// 关键点（这几条任何一条被改回去，用户就是白屏，而且在 Chrome/Playwright 上永远测不出来）：
//   A package.json 的 browserslist 必须含 chrome 83（构建 target 的唯一来源）
//   B rspack.config.ts 不许再写死 chrome >= 105，且读的是 package.json 的 browserslist
//   C 入口第一行必须是运行时补齐（要比 React 早）
//   D 所有 dvh 声明都有同值 vh 回退（Chrome 108+ 才有 dvh）
//   E 产物自检（dist 存在时跑）：每个 JS 文件都能被 Chrome 83 解析，且没有裸 dvh —— 用
//     scripts/check-bundle-syntax.mjs 的同一套判定，release 前 `npm run check:legacy` 跑的就是它
//   F 闸门自证（issue #95）：用一个自造的坏产物 fixture 证明 E 的判定**真的会红**，再来一个合规
//     fixture 证明它**不是恒定红**
//
// issue #95：E-1/E-2 以前在缺 dist 时是 `if (无产物) { test.skip?.(); return }` —— 用例体一个断言都不跑，
// 但外层用例仍被 node:test 记为 `ok`（`test.skip` 在用例体内只会新注册一条匿名子测试，不跳过当前用例）。
// 于是「产物自检通过」和「产物自检根本没跑」在报告里、在只看 `# fail`/退出码的 CI 里完全一样。
// 现在改为**声明期跳过**：缺产物时 E-1/E-2 自己那条就是 `# SKIP`，`# skipped` 计数直接对着它们；
// 需要在缺产物时硬红的 CI（release 前置）可以置 `LEGACY_REQUIRE_DIST=1`，本文件加载即失败。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  checkCssUnits,
  checkJavaScript,
  checkRuntimeApis,
  findForbiddenSyntax,
  POLYFILL_FLAG,
  stripLiterals,
} from '../../scripts/check-bundle-syntax.mjs'
import {
  BASELINE_CHROMIUM,
  assertBrowserslist,
  browserslistChromeTarget,
} from '../../scripts/lib/compatBaseline.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))
const rspackConfig = read('rspack.config.ts')
// 只看代码，不看注释：注释里会提到旧的 chrome >= 105（说明为什么改成 83）
const rspackCode = rspackConfig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const walk = (dir, suffix) => {
  if (!existsSync(dir)) {
    return []
  }
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, suffix))
    } else if (entry.name.endsWith(suffix)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 产物自检的判定内核（E-1/E-2/F-1 共用同一份逻辑，闸门被测的就是它）。
 * 返回三层结果；`problems` 为空数组 = 合格。
 */
const auditDist = (distDir) => {
  const jsFiles = walk(path.join(distDir, 'static/js'), '.js')
  const cssFiles = walk(path.join(distDir, 'static/css'), '.css')
  const js = checkJavaScript(jsFiles)
  const css = checkCssUnits(cssFiles)
  const runtime = checkRuntimeApis(distDir, jsFiles)
  return {
    jsFiles,
    cssFiles,
    js,
    css,
    runtime,
    problems: [...js.lexical, ...js.ast, ...css.problems, ...runtime.violations],
  }
}

const DIST = path.join(ROOT, 'dist')
const hasBundle = (distDir) =>
  walk(path.join(distDir, 'static/js'), '.js').length > 0 &&
  walk(path.join(distDir, 'static/css'), '.css').length > 0

// 缺产物：默认**显式跳过**（报告里 E-1/E-2 自己那条是 `# SKIP`，`# skipped` 直接对着它们），
// 而不是以前那种「用例体 return、外层仍记 ok」的假绿。
const NO_DIST_REASON =
  'dist/ 没有产物（dist/static/js 或 dist/static/css 为空）：先跑 `pnpm run build:internal`（或 `pnpm run build`）再来核对产物'
const DIST_READY = hasBundle(DIST)
// 需要「缺产物即红」的 CI（release 前置）置 LEGACY_REQUIRE_DIST=1：跳过不再是一种可能。
if (!DIST_READY && process.env.LEGACY_REQUIRE_DIST === '1') {
  throw new Error(`LEGACY_REQUIRE_DIST=1，但${NO_DIST_REASON}`)
}
const DIST_SKIP = DIST_READY ? false : NO_DIST_REASON

test('A browserslist 以 chrome 83 为下限（产物语法唯一来源）', () => {
  assert.ok(Array.isArray(pkg.browserslist), 'package.json 必须有 browserslist 字段')
  const chromeFloor = pkg.browserslist
    .map((entry) => /^chrome\s*>=\s*(\d+)$/.exec(entry))
    .filter(Boolean)
    .map((match) => Number(match[1]))
  assert.equal(chromeFloor.length, 1, `browserslist 里应有且只有一条 chrome 下限，实际：${pkg.browserslist.join(', ')}`)
  // issue #276：唯一来源是 config/compat.json 的 baselineChromium，package.json 只是它的载体
  // （rspack / lightningcss 只吃 browserslist）。两份可以共存，但必须有东西保证它们相等 ——
  // 这里就是那个「东西」之一（另一个是构建期的 assertBrowserslist）。
  assert.equal(
    chromeFloor[0],
    BASELINE_CHROMIUM,
    `browserslist 的 chrome 下限必须等于 config/compat.json:baselineChromium=${BASELINE_CHROMIUM}，实际 chrome >= ${chromeFloor[0]}`
  )
  assert.ok(chromeFloor[0] <= 83, `chrome 下限必须覆盖 WebView 83（Android 11 出厂镜像），实际 chrome >= ${chromeFloor[0]}`)
})

test('B rspack 目标来自唯一来源，且断言是行为级的（不是「源码里有这句话」）', () => {
  // package.json 只解析一次：版本号（#21 的单一来源）与 browserslist 共用同一个对象
  assert.match(rspackCode, /const pkg = JSON\.parse\(/, 'package.json 必须只解析一次')
  assert.match(rspackCode, /const targets = pkg\.browserslist/, 'targets 必须从 package.json 的 browserslist 读，别再写第二份')
  assert.doesNotMatch(rspackCode, /chrome\s*>=\s*105/, '不允许再出现 chrome >= 105 这种写死的高下限')
  assert.match(rspackCode, /target:\s*'browserslist'/, 'rspack 运行时（chunk 加载等）也要按 browserslist 生成')
  assert.match(rspackCode, /assertBrowserslist\(/, '下限断言必须走 assertBrowserslist（唯一来源在 scripts/lib/compatBaseline.mjs）')
  assert.doesNotMatch(rspackCode, /chrome\s*>=\s*\d+/, 'rspack.config.ts 不许再自带 chrome 下限数字（那就是恒真断言的来源）')

  // ── issue #276：这里以前是 `assert.match(rspackCode, /throw new Error\(`browserslist 缺少 Chrome 83 下限/)`。
  // 断言「源码里存在这句话」永远不会因为条件失效而失败 —— 把条件改成 `if (false)` 它照样绿，
  // 也就是说它恒真、证明不了「下限被改回去时构建会叫停」。现在改成**行为级**：伪造一份错的下限，
  // 断言必须抛。下面每一条都是「把它改坏就会红」的负向用例。
  assert.throws(
    () => assertBrowserslist(['chrome >= 105']),
    /config\/compat\.json:baselineChromium/,
    '写死一个更高的下限时必须抛（老写法只比字符串，改成 91 也照样通过）'
  )
  assert.throws(
    () => assertBrowserslist([]),
    /应有且只有一条/,
    'browserslist 为空时必须抛 —— 老写法会先塞 fallback 再断言，等于断言被自己满足（恒真）'
  )
  assert.throws(
    () => assertBrowserslist(['chrome >= 83', 'chrome >= 91']),
    /应有且只有一条/,
    '两条 chrome 下限时必须抛（否则抬下限时留一条旧的就能混过去）'
  )
  assert.equal(
    assertBrowserslist([browserslistChromeTarget(), 'edge >= 83']),
    BASELINE_CHROMIUM,
    '唯一来源那一份必须放行'
  )

  // 第三方依赖里唯一需要跟着降级的是 mermaid（它的 dist 带类静态块）
  assert.match(rspackCode, /include: \/\[\\\\\/\]node_modules\[\\\\\/\]\(@mermaid-js/, 'mermaid 的语法降级规则不能丢')
})

test('C 入口第一件事就是运行时补齐，比 React 早', () => {
  const main = read('src/main.tsx')
  const imports = main.match(/^import .*$/gm)
  assert.ok(imports, 'main.tsx 应有 import')
  assert.match(imports[0], /^import '\.\/polyfills\/legacy\.js'$/, `第一个 import 必须是 polyfill，实际：${imports[0]}`)
  assert.ok(
    main.indexOf("import './polyfills/legacy.js'") < main.indexOf("from 'react-dom/client'"),
    'polyfill 必须在 react-dom 之前求值'
  )
  const polyfill = read('src/polyfills/legacy.ts')
  for (const api of ['hasOwn', "'at'", 'toSorted', 'toReversed', 'toSpliced', "'with'", 'structuredClone', 'randomUUID']) {
    assert.ok(polyfill.includes(api), `polyfill 里应覆盖 ${api}`)
  }
  assert.match(polyfill, /installLegacyPolyfills\(\)\n$/, '模块自身要自动安装（入口不需要记得调）')
})

/** 与开括号配对的闭括号位置（忽略字符串里的括号：这里的 CSS 都是声明，够用） */
const matchingBrace = (css, open) => {
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') {
      depth += 1
    } else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

/**
 * 全部 @supports 的两段区间：condition = 括号里的能力查询，block = 查询成立的规则体。
 * 统一写法的关键就在这里 —— dvh 只许出现在这两处：
 *   @supports (prop: 100dvh) { prop: ...100dvh }  ← 条件与值都在能力查询范围内
 * 低内核（WebView 83 = Chromium 83）不认 dvh，条件不成立 → 整块规则不存在，回退到基线 vh。
 */
const supportsRanges = (css) => {
  const ranges = []
  for (const match of css.matchAll(/@supports\s*\(/g)) {
    const conditionOpen = match.index + match[0].length - 1
    const conditionClose = css.indexOf(')', conditionOpen)
    const blockOpen = conditionClose > 0 ? css.indexOf('{', conditionClose) : -1
    const blockClose = blockOpen > 0 ? matchingBrace(css, blockOpen) : -1
    if (conditionClose > conditionOpen && blockClose > blockOpen) {
      ranges.push({ condition: [conditionOpen, conditionClose], block: [blockOpen, blockClose] })
    }
  }
  return ranges
}

const inside = (range, index) => index > range[0] && index < range[1]

/** 声明块的起止（往前最近的 '{'，配对到它的 '}'） */
const blockRange = (css, index) => {
  const open = css.lastIndexOf('{', index)
  const close = open >= 0 ? matchingBrace(css, open) : -1
  return { open, close }
}

/** 当前这段值属于哪个属性；顺带判断是不是还在 var( 的缺省值里 */
const declarationContext = (css, index) => {
  const open = Math.max(css.lastIndexOf('{', index), css.lastIndexOf(';', index))
  const head = css.slice(open + 1, index)
  const prop = [...head.matchAll(/(?:^|[;{])\s*([-a-zA-Z]+)\s*:/g)].at(-1)?.[1]
  const value = head.slice(head.lastIndexOf(':') + 1)
  const unclosedVar = (value.match(/var\(/g) ?? []).length > (value.match(/\)/g) ?? []).length
  return { prop, inVarDefault: unclosedVar }
}

test('D 每处 dvh 都有同值 vh 回退（统一写法：变量/字面量 + dvh 只放在 @supports 里）', () => {
  const cssFiles = walk(path.join(ROOT, 'src'), '.css')
  assert.ok(cssFiles.length > 0)
  let dvhCount = 0
  for (const file of cssFiles) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const relative = path.relative(ROOT, file)
    const ranges = supportsRanges(css)
    const inSupportsBlock = (index) => ranges.some((range) => inside(range.block, index))
    for (const match of css.matchAll(/\d+(?:\.\d+)?dvh/g)) {
      const index = match.index ?? 0
      const fallback = match[0].replace('dvh', 'vh')
      const fallbackPattern = new RegExp(`(^|[^\\d.])${fallback.replace('.', '\\.')}(?![\\d.])`)
      // 能力查询本身（@supports (prop: 100dvh)）不是「用」dvh，83 上只是一句恒假的判断
      if (ranges.some((range) => inside(range.condition, index))) {
        continue
      }
      dvhCount += 1
      const { prop, inVarDefault } = declarationContext(css, index)
      assert.ok(prop, `${relative}: 认不出 ${match[0]} 属于哪个属性`)
      if (inVarDefault && !inSupportsBlock(index)) {
        assert.fail(
          `${relative}: ${prop} 的 var() 缺省值里带了 ${match[0]}，但不在 @supports 里 —— ` +
            'WebView 83 会在**计算值阶段**才失败，把已经生效的 vh 值打成 initial，比没有回退更糟'
        )
      }
      if (inSupportsBlock(index)) {
        // @supports 里的覆盖声明：必须有块外的同属性 vh 基线兜底（否则条件为真时 dvh 生效，
        // 条件为假时该属性就什么都不剩）
        const base = [...css.matchAll(new RegExp(`[;{]\\s*${prop}\\s*:\\s*([^;}]*${fallback}(?![\\d.]))`, 'g'))]
          .find((hit) => !inSupportsBlock(hit.index ?? 0))
        assert.ok(
          base,
          `${relative}: ${match[0]} 在 @supports 里，但找不到块外同属性的 ${fallback} 基线（83 上会整条失效）`
        )
        continue
      }
      // 经典双声明：同一声明块内 vh 必须写在 dvh 之前（保证低内核至少留下前一条）
      const { open, close } = blockRange(css, index)
      assert.ok(open >= 0 && close > open, `${relative}: ${match[0]} 不在任何声明块里？`)
      const block = css.slice(open, close)
      assert.ok(
        fallbackPattern.test(block),
        `${relative}: ${match[0]} 缺 ${fallback} 回退（WebView 83 上会整条声明失效）`
      )
      assert.ok(
        block.indexOf(fallback) < block.indexOf(match[0]),
        `${relative}: 顺序错了，vh 回退必须写在 dvh 之前`
      )
    }
  }
  assert.ok(dvhCount >= 6, `预期至少 6 处 dvh 声明（App/ChatInput/OursServices/Settings），实际 ${dvhCount}`)
})

test('E-1 产物自检：全部 JS 能用 Chrome 83 的语法解析（无 ||= / &&= / ??= / 类静态块）', { skip: DIST_SKIP }, () => {
  const audit = auditDist(DIST)
  const all = [...audit.js.lexical, ...audit.js.ast]
  assert.deepEqual(all, [], `产物里有低内核解析不了的语法：\n${JSON.stringify(all.slice(0, 5), null, 2)}`)
  assert.ok(audit.js.files >= 40, `产物 JS 文件数异常：${audit.js.files}`)
  // 运行时 API 层（issue #39）：语法过了不代表低内核能跑 —— replaceAll 这类内置 API 缺失是 TypeError。
  // 产物里出现 Chrome 83 没有的 API 时，必须能在入口脚本里找到 polyfill 标记，否则低内核必白屏。
  assert.deepEqual(
    audit.runtime.violations,
    [],
    `产物里有 Chrome 83 没有、又没在入口脚本里补上的内置 API：\n${JSON.stringify(audit.runtime.violations.slice(0, 5), null, 2)}`
  )
  assert.ok(
    audit.runtime.polyfillInEntries.length > 0,
    '产物入口脚本里找不到 legacy polyfill 标记（懒加载 chunk 里补等于没补）'
  )

  // 主包单独再确认一遍：三个逻辑赋值运算符在**剥掉字面量之后**一次都不出现
  // 路径匹配不能写死分隔符：walk() 走 path.join，Windows 上产出的是
  // `D:\...\dist\static\js\main.<hash>.js`，写死 /\/main\./ 会恒定匹配不到（假红）。
  // 用 basename 比较，等价于把 [\\/] 写进正则，但也不受 walk() 的拼接方式影响；
  // 反过来只认反斜杠会在 POSIX 上把这条测回假红，所以两边都不写死。
  const mainFile = audit.jsFiles.find((file) => /^main\.[0-9a-f]+\.js$/.test(path.basename(file)))
  assert.ok(mainFile, '找不到 main 包')
  const main = readFileSync(mainFile, 'utf8')
  const stripped = stripLiterals(main)
  for (const token of ['||=', '&&=', '??=']) {
    assert.equal(stripped.includes(token), false, `main 包里还有 ${token}`)
  }
  // 裸 grep 仍会命中 prismjs 语法高亮定义里的正则（/--|\+\+|\*\*=?|=>|&&=?|\|\|=?/），正常：
  assert.ok(findForbiddenSyntax(main).length === 0, 'main 包词法层应为空')
  const hash = createHash('sha256').update(main).digest('hex')
  console.log(`    main=${path.basename(mainFile)} sha256=${hash}`)
})

test('E-2 产物自检：CSS 里没有裸 dvh，且守卫在业务包之前', { skip: DIST_SKIP }, () => {
  const audit = auditDist(DIST)
  assert.ok(audit.jsFiles.length > 0, 'dist/static/js 里没有产物 JS')
  assert.ok(audit.cssFiles.length > 0, 'dist/static/css 里没有产物 CSS')
  assert.deepEqual(audit.css.problems, [])
  assert.ok(audit.css.dvhTotal >= 6, `产物里 dvh 声明应有 6 处，实际 ${audit.css.dvhTotal}`)
  assert.equal(audit.css.fallbackTotal, audit.css.dvhTotal, '每处 dvh 都要有配对 vh 回退')

  const html = read('dist/index.html')
  assert.ok(html.indexOf('compatibility-error') >= 0, '产物 HTML 里应有守卫的提示容器')

  // 执行顺序的保证不是「源码顺序」而是「defer」：inline 守卫在解析 body 时就跑了，
  // defer 的业务包要等解析完才执行 —— 所以包解析失败时守卫已经装好 error 监听。
  const bundleTag = html.match(/<script[^>]*src="[^"]*static\/js\/main\.[0-9a-f]+\.js"[^>]*>/)
  assert.ok(bundleTag, '产物 HTML 里应引用 main 包')
  assert.match(bundleTag[0], /\bdefer\b/, 'main 包必须是 defer，否则会和 inline 守卫抢执行顺序')
  const inlineTags = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((match) => match[0])
  assert.ok(inlineTags.length >= 1, '产物 HTML 里应有 inline 守卫脚本')
  for (const tag of inlineTags) {
    assert.doesNotMatch(tag, /\b(?:async|defer)\b/, 'inline 守卫必须是同步执行的（不能带 async/defer）')
  }
})

// ── F 闸门自证（issue #95）──────────────────────────────────────────────────
// E-1/E-2 以前有一个「缺产物就静默 return」的假绿路径，而它们本身从没被验证过：没有任何用例证明
// 这两个闸门在**真的有产物且产物违规**时会红。这里用临时目录自造一份极简 dist（入口 + 一个带违规
// API 的 JS + 一段裸 dvh 的 CSS），走 E-1/E-2 用的同一个 auditDist()，断言坏产物必红、合规产物必绿。
// 用后清理：临时目录在 finally 里删掉，不落进仓库。

/** 按 { 相对路径: 内容 } 写出一份最小产物 */
const writeFixture = (dir, files) => {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

const fixtureHtml = (entry) => `<!doctype html>\n<html><body><script src="${entry}" defer></script></body></html>\n`

test('F-1 自造产物 fixture：E-1/E-2 的判定在「有产物且含违规」时真的会红（闸门不是摆设）', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'legacy-bundle-'))
  try {
    // 坏产物：main 包用逻辑赋值 + 裸 replaceAll（入口没有 polyfill 标记），CSS 用裸 dvh
    const badDir = path.join(temp, 'bad')
    writeFixture(badDir, {
      'index.html': fixtureHtml('static/js/main.0badf00d.js'),
      'static/js/main.0badf00d.js':
        "var label = 'x'\nlabel ||= 'y'\nvar slug = '-'.replaceAll('-', '_')\nconsole.log(label, slug)\n",
      'static/css/app.css': '.hero { height: 100dvh; }\n',
    })
    const bad = auditDist(badDir)
    assert.ok(
      bad.js.lexical.some((finding) => finding.kind === 'logical-assignment'),
      `语法层应命中 ||=（实际：${JSON.stringify(bad.js.lexical)}）`
    )
    assert.ok(
      bad.runtime.violations.some((violation) => violation.id === 'string-replaceAll'),
      `运行时 API 层应拦下裸 replaceAll（实际：${JSON.stringify(bad.runtime.violations)}）`
    )
    assert.ok(
      bad.css.problems.some((problem) => problem.kind === 'missing-vh-fallback'),
      `CSS 层应命中裸 dvh（实际：${JSON.stringify(bad.css.problems)}）`
    )
    // E-1/E-2 用的就是这三条断言：在坏产物上必须炸
    assert.throws(() => assert.deepEqual([...bad.js.lexical, ...bad.js.ast], []), '语法层断言在坏产物上必须失败')
    assert.throws(() => assert.deepEqual(bad.runtime.violations, []), '运行时 API 层断言在坏产物上必须失败')
    assert.throws(() => assert.deepEqual(bad.css.problems, []), 'CSS 层断言在坏产物上必须失败')

    // 对照产物：同样有 replaceAll，但入口脚本带 polyfill 标记；dvh 有同值 vh 回退 —— 必须全部放行，
    // 否则「闸门会红」只说明它恒定红，不能说明它认得对错。
    const goodDir = path.join(temp, 'good')
    writeFixture(goodDir, {
      'index.html': fixtureHtml('static/js/main.0feedbee.js'),
      'static/js/main.0feedbee.js':
        `var label = 'x'\nvar slug = '-'.replaceAll('-', '_')\nwindow.${POLYFILL_FLAG} = true\nconsole.log(label, slug)\n`,
      'static/css/app.css': '.hero { height: 100vh; height: 100dvh; }\n',
    })
    const good = auditDist(goodDir)
    assert.deepEqual([...good.js.lexical, ...good.js.ast], [], '合规产物的语法层应放行')
    assert.deepEqual(good.runtime.violations, [], '入口脚本带 polyfill 标记时运行时 API 层应放行')
    assert.deepEqual(good.css.problems, [], 'vh 回退齐全时 CSS 层应放行')
    assert.ok(good.runtime.polyfillInEntries.length > 0, '入口脚本应被认出带 polyfill 标记')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
