// [layer: regression | 依赖: 无（纯 Node，无浏览器/网络/模拟器） | Issue #480（关联 #13 / #39）]
//
// 回归对象：`scripts/check-bundle-syntax.mjs`（`pnpm check:legacy`）的**覆盖范围**。
//
// 修复前症状（#480 集成轮调研）：门禁只扫 `dist/static/js`，而 pdfjs 的两份经典脚本被
// `rspack.config.ts` 拷到 `dist/static/pdfjs/`（当时写的理由正是「避开语法门禁」）——
// 于是这道门对 pdfjs **等于不存在**：往里塞一个 `||=`，门禁照样 exit 0 报「合格」。
// 1.3 MB 的运行期脚本在 WebView 83 上解析失败一样是整包白屏。
//
// 覆盖（每条都是真跑 CLI，断言的是退出码与输出，不是源码正则）：
//   [绿 1] vendored（static/pdfjs）里的违禁语法必须拦下，并点名那个文件；
//   [绿 2] 懒加载 chunk（static/js/async）里的违禁语法仍然拦下（原有覆盖，防回退）；
//   [绿 3] 全部干净时 exit 0，且输出里报出「vendored 经典脚本 N 个」——证明它真的扫了；
//   [绿 4] `?.` / `??` 在 vendored 里必须放行：门禁语义是「Chromium 83 能力集」，
//          不是「ES2017 规范」（这两个是 Chrome 80，pdfjs legacy build 实测就在用）。
//
//   node --test --import ./tests/helpers/injected.mjs tests/regression/issue-480-legacy-gate-covers-vendored.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'scripts', 'check-bundle-syntax.mjs')

/** 造一个最小 dist：入口 chunk + 一个懒加载 chunk + 两个 vendored 经典脚本 */
const makeDist = ({ entry = 'var a = 1\n', lazy = 'var b = 2\n', pdf = 'var c = 3\n', worker = 'var d = 4\n' } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-gate-'))
  mkdirSync(path.join(dir, 'static', 'js', 'async'), { recursive: true })
  mkdirSync(path.join(dir, 'static', 'pdfjs'), { recursive: true })
  // 运行时 API 层要入口脚本里有 polyfill 标记；本夹具不触发任何「Chrome 83 缺的 API」，
  // 但把标记写上是真实产物的形状，免得将来夹具一加 API 就假红。
  writeFileSync(
    path.join(dir, 'index.html'),
    '<script defer src="static/js/main.js"></script>\n'
  )
  writeFileSync(path.join(dir, 'static', 'js', 'main.js'), `${entry}\n__DEEPSEEK_LEGACY_POLYFILL__\n`)
  writeFileSync(path.join(dir, 'static', 'js', 'async', '1234.chunk.js'), lazy)
  writeFileSync(path.join(dir, 'static', 'pdfjs', 'pdf.min.js'), pdf)
  writeFileSync(path.join(dir, 'static', 'pdfjs', 'pdf.worker.min.js'), worker)
  return dir
}

/** 跑真 CLI，返回 {code, output} */
const run = (dir) => {
  try {
    const output = execFileSync(process.execPath, [GATE, dir], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const withDist = (fixture, body) => {
  const dir = makeDist(fixture)
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('[绿 1] vendored（static/pdfjs）里的 ||= 必须拦下，并点名那个文件', () => {
  withDist({ pdf: 'var x; x ||= 1;\n' }, (dir) => {
    const { code, output } = run(dir)
    assert.equal(code, 1, `vendored 里的逻辑赋值必须判红（exit 1），实际 ${code}：\n${output}`)
    assert.ok(
      output.includes('static/pdfjs/pdf.min.js'),
      `报告必须点名 pdfjs 那个文件（修复前它根本不在扫描范围里）：\n${output}`
    )
    assert.ok(output.includes('logical-assignment'), `报告必须点出违规类型：\n${output}`)
  })
})

test('[绿 2] 懒加载 chunk（static/js/async）里的 ||= 仍然拦下', () => {
  withDist({ lazy: 'var y; y ??= 1;\n' }, (dir) => {
    const { code, output } = run(dir)
    assert.equal(code, 1, `懒加载 chunk 里的逻辑赋值必须判红，实际 ${code}：\n${output}`)
    assert.ok(output.includes('static/js/async/1234.chunk.js'), output)
  })
})

test('[绿 3] 全部干净 → exit 0，且输出里报出 vendored 的扫描份数（证明真的扫了）', () => {
  withDist({}, (dir) => {
    const { code, output } = run(dir)
    assert.equal(code, 0, `干净产物必须合格：\n${output}`)
    assert.ok(
      output.includes('vendored 经典脚本 2 个'),
      `扫描范围必须报出 vendored 份数（否则「扫了没扫」无法自证）：\n${output}`
    )
    assert.ok(output.includes('static/pdfjs/pdf.min.js'), output)
    // #104：覆盖范围又多了一组 —— Capacitor 注入脚本（不在 dist/ 里，旧实现天生扫不到），
    // 所以份数从 4 变 5，并且必须在报告里点名它（同样要能「自证扫了」）。
    assert.ok(output.includes('全部 *.js 共 5 个'), output)
    assert.ok(output.includes('Capacitor 注入脚本 1 个'), output)
    assert.ok(output.includes('native-bridge.js'), output)
  })
})

test('[绿 4] ?. / ?? 在 vendored 里放行（门禁是 Chromium 83 能力集，不是 ES2017 规范）', () => {
  const code = 'var o = { a: { b: 1 } }; var v = o?.a?.b ?? 0;\n'
  withDist({ pdf: code, worker: code }, (dir) => {
    const { output, code: exit } = run(dir)
    assert.equal(exit, 0, `?. / ?? 是 Chrome 80 的能力，pdfjs legacy build 实测在用，不该判红：\n${output}`)
  })
})

// ── #543：运行时 API 层漏了 `Promise.withResolvers`（Chrome 119）────────────────
//
// 这一条不是语法错，是**运行期** TypeError（`Promise.withResolvers is not a function`）：
// 词法层与 AST 层对它完全无感，只有第三层（运行时 API 表）能拦。修复前同一个产物
// 门禁照样 exit 0 报「合格」——「现在绿」只说明还没人用它，不说明门禁拦得住。
//
// 四拍（#369 模板）：干净 → exit 0；注入 → exit 1 且点名 `文件:行`；还原 → 再 exit 0。
test('[绿 5] 懒加载 chunk 里的 Promise.withResolvers 必须拦下，并点名 文件:行（#543）', () => {
  const inject = 'var a = 1\nvar d = Promise.withResolvers()\n'
  withDist({ lazy: inject }, (dir) => {
    const red = run(dir)
    assert.equal(red.code, 1, `chunk 里的 Promise.withResolvers 必须判红（exit 1），实际 ${red.code}：\n${red.output}`)
    assert.ok(
      red.output.includes('static/js/async/1234.chunk.js:2:9'),
      `报告必须点名 文件:行:列（不是只说「有 API 缺失」）：\n${red.output}`
    )
    assert.ok(red.output.includes('promise-withResolvers'), `报告必须点出规则 id：\n${red.output}`)
    assert.ok(red.output.includes('Chrome 119+'), `报告必须点出版本依据：\n${red.output}`)

    // 还原：同一个目录写回干净内容，门禁必须重新 exit 0
    // （没有这一拍，「红」可能只是门禁恒红 / 注入物没清干净）
    writeFileSync(path.join(dir, 'static', 'js', 'async', '1234.chunk.js'), 'var b = 2\n')
    const green = run(dir)
    assert.equal(green.code, 0, `还原后必须回到 exit 0：\n${green.output}`)
  })
})

test('[绿 6] Array.fromAsync（Chrome 121）同款：vendored 经典脚本里出现也拦（#543）', () => {
  withDist({ pdf: 'async function f(){ return Array.fromAsync([1]) }\n' }, (dir) => {
    const { code, output } = run(dir)
    assert.equal(code, 1, `vendored 里的 Array.fromAsync 必须判红，实际 ${code}：\n${output}`)
    assert.ok(output.includes('static/pdfjs/pdf.min.js:1:'), `必须点名 vendored 文件与行号：\n${output}`)
    assert.ok(output.includes('array-fromAsync'), output)
  })
})
