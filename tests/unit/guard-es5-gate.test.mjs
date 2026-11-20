// [layer: unit | 纯 Node（子进程 + acorn），无浏览器无网络 | 耗时: <1s]
// GitHub issue #104：`scripts/check-guard-es5.mjs` —— 兜底页内联守卫的 ES5 门禁。
//
// 这条门禁守的是「守卫自己也得能在老内核上解析」。它必须满足两件事，缺一条就是摆设：
//   A 正向：现在的 src/index.html 能通过（否则门禁一上线就红，人会把它注释掉）；
//   B 负向：临时注入 `?.` 之后必须**真的** exit 1（证明它不是空跑）。
// 另外顺手把「为什么不用三条正则」记在这里：正则只能拦住眼熟的写法，acorn 是解析器，
// 它说不行的语法，WebView 79 一定也解析不了。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { checkInlineScripts, inlineScripts } from '../../scripts/check-guard-es5.mjs'
import { loadAcorn } from '../../scripts/check-bundle-syntax.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-guard-es5.mjs')
const HTML = path.join(ROOT, 'src/index.html')
const html = readFileSync(HTML, 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const acorn = loadAcorn()

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })

test('#104 ES5 门禁：默认入口（src/index.html）通过，且报出守卫字节数', () => {
  const result = run([])
  assert.equal(result.status, 0, `门禁不该红：${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /src\/index\.html/)
  assert.match(result.stdout, /ecmaVersion 5/)
})

test('#104 ES5 门禁的负向对照：注入 `?.` 必须 exit 1 并指出行号', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-es5-'))
  const target = path.join(dir, 'index.html')
  copyFileSync(HTML, target)
  const broken = readFileSync(target, 'utf8').replace(
    'var startedAt = Date.now()',
    'var startedAt = Date.now(); var __neg = window?.location'
  )
  assert.notEqual(broken, readFileSync(target, 'utf8'), '注入点没命中（守卫被改过结构？）')
  writeFileSync(target, broken)

  const result = run([target])
  assert.equal(result.status, 1, `注入了 ?. 的守卫必须被拦下：${result.stdout}`)
  assert.match(result.stderr, /index\.html:\d+:\d+/)
  assert.match(result.stderr, /Unexpected token/)
})

test('#104 ES5 门禁的负向对照：`??` / 箭头函数 / 模板串同样被拦下', () => {
  assert.ok(acorn, 'acorn 不在 node_modules 里（先 pnpm install）')
  for (const snippet of ['var a = b ?? 1', 'var f = () => 1', 'var t = `x`']) {
    const findings = checkInlineScripts(acorn, `<script>${snippet}</script>`)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].ok, undefined, `这段不该被当成合格：${snippet}`)
  }
  // 单纯把 var 换成箭头函数才是真 ES6；`??` 与模板串是 Chrome 80/41 的语法，同一个门禁一起拦
  const arrow = checkInlineScripts(acorn, '<script>var f = () => 1</script>')
  assert.match(arrow[0].message, /Unexpected token/)
})

test('#104 ES5 门禁：抽内联脚本时跳过带 src 的标签与空段', () => {
  const scripts = inlineScripts('<script src="/main.js"></script><script>\nvar a = 1\n</script>')
  assert.equal(scripts.length, 2)
  assert.equal(scripts[0].source.trim(), '')
  const findings = checkInlineScripts(acorn, '<script src="/main.js"></script><script>var a = 1</script>')
  assert.equal(findings.length, 1, '带 src 的空段不该算一段脚本')
  assert.equal(findings[0].ok, true)
})

test('#104 ES5 门禁：没有内联脚本的 HTML 说明入口变了，CLI 按环境错误退出', () => {
  const result = run(['package.json'])
  assert.notEqual(result.status, 0, '拿一个没有 <script> 的文件跑，必须失败（否则门禁是空转）')
})

test('#104 守卫本体仍然只用 ES5 写法（正则层补一道，报错更快）', () => {
  assert.doesNotMatch(guardSource, /\b(?:const|let|class|async|await)\b/)
  assert.doesNotMatch(guardSource, /=>/)
  assert.doesNotMatch(guardSource, /\?\.|\?\?/)
  assert.doesNotMatch(guardSource, /`/)
  const findings = checkInlineScripts(acorn, html)
  assert.equal(findings.filter((finding) => !finding.ok).length, 0)
  assert.equal(findings[0].bytes, Buffer.byteLength(guardSource, 'utf8'))
})
