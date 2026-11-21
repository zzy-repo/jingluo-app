// [layer: unit | 纯 Node（子进程 + acorn + 临时目录），无浏览器无网络 | 耗时: <2s]
// GitHub issue #104：两条补上来的门禁。
//
// A `scripts/check-bundle-syntax.mjs`（check:legacy）现在也扫 **Capacitor 注入脚本**
//   （`node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js`）。
//   它不在 `dist/` 里，所以「扫产物目录下全部 *.js」天生扫不到它；它却和产物跑在同一个 WebView 上，
//   而且**先于**页面脚本执行 —— 语法超限时不是「桥接功能缺失」，是页面脚本之前就抛错。
// B `scripts/compat/check-syntax-floor.mjs`（check:syntax-floor）把「声明的最低内核」
//   （config/compat.json 的 syntaxFloorChromium）和「产物真实语法下限」放在一起比。
//   缺了它，`check:legacy` 永远不会因为 `?.` / `??` 变红（它们在 Chrome 83 的能力集里），
//   于是「线上白屏、门禁全绿」可以反复发生。
//
// 每条门禁都带**负向对照**：注入必须让它红，且红的位置要点到注入的那一处。
// 只跑正例的步骤算「绿灯空跑」（#369）。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import {
  CAPACITOR_BRIDGE_RELATIVE,
  checkJavaScript,
  loadAcorn,
} from '../../scripts/check-bundle-syntax.mjs'
import { judge, measureEntry } from '../../scripts/compat/check-syntax-floor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BRIDGE = path.join(ROOT, CAPACITOR_BRIDGE_RELATIVE)
const FLOOR_SCRIPT = path.join(ROOT, 'scripts/compat/check-syntax-floor.mjs')
const LEGACY_SCRIPT = path.join(ROOT, 'scripts/check-bundle-syntax.mjs')

const tmpDirs = []
const mktmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-gate-'))
  tmpDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** 造一个最小产物目录：index.html + 一个入口 chunk（内容由用例给） */
const fakeDist = (entrySource, name = 'main.probe.js') => {
  const dir = mktmp()
  mkdirSync(path.join(dir, 'static', 'js'), { recursive: true })
  writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><script defer src="static/js/${name}"></script>`
  )
  writeFileSync(path.join(dir, 'static', 'js', name), entrySource)
  return dir
}

const runNode = (script, args) =>
  spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' })

// ── A. Capacitor 注入脚本进扫描范围 ─────────────────────────────────────────

test('#104 Capacitor 注入脚本在扫描范围内，且当前版本（8.6.2）没有越线语法', () => {
  // 位置写死在这里是为了「升级后换了目录」时这条会红 —— 那时脚本里的
  // CAPACITOR_BRIDGE_RELATIVE 也要一起改（门禁本身会 exit 2 而不是跳过）。
  assert.match(CAPACITOR_BRIDGE_RELATIVE.split(path.sep).join('/'), /@capacitor\/android\/.*native-bridge\.js$/)
  const code = readFileSync(BRIDGE, 'utf8')
  assert.ok(code.length > 10_000, `native-bridge.js 不该这么小：${code.length} B`)

  const result = checkJavaScript([BRIDGE])
  assert.equal(result.files, 1)
  assert.deepEqual(
    result.lexical.map((finding) => `${finding.kind}@${finding.line}:${finding.column}`),
    [],
    'Capacitor 注入脚本不该有 Chrome 83 解析不了的语法'
  )
  assert.deepEqual(result.ast.map((finding) => `${finding.kind}@${finding.line}:${finding.column}`), [])
})

test('#104 负向对照：往 Capacitor 注入脚本里塞 `??=` 必须被门禁判红，并点到那一处', () => {
  const dir = mktmp()
  const probe = path.join(dir, 'native-bridge.js')
  copyFileSync(BRIDGE, probe)
  const before = readFileSync(probe, 'utf8')
  writeFileSync(probe, `${before}\nvar __gateProbe = (window.Capacitor ||= {})\n`)

  const result = checkJavaScript([probe])
  const lexical = result.lexical.map((finding) => finding.kind)
  const ast = result.ast.map((finding) => finding.kind)
  assert.ok(
    lexical.includes('logical-assignment') || ast.includes('logical-assignment'),
    `注入了 ??= 之后门禁必须报 logical-assignment，实际：lexical=${JSON.stringify(lexical)} ast=${JSON.stringify(ast)}`
  )
  // 红的文件必须是注入的那个文件（扫描范围被改窄 / 报错点跑到别处都不算数）
  for (const finding of [...result.lexical, ...result.ast]) {
    assert.match(finding.file.split(path.sep).join('/'), /native-bridge\.js$/)
  }
})

test('#104 注入了可选链（`?.`）时 check:legacy 不会红 —— 这是它的契约，不是漏检', () => {
  // 记在这里，免得下一个人以为「塞 ?. 不红 = 门禁坏了」又去加一条 repeating 规则：
  // `?.` / `??` 是 ES2020 / Chrome 80，本来就在「Chromium 83 能力集」里。
  // 「产物真实下限是 80、而声明是 83」这条缝由 check:syntax-floor + 兜底页文案负责（见 B 组）。
  const dir = mktmp()
  const probe = path.join(dir, 'native-bridge.js')
  copyFileSync(BRIDGE, probe)
  writeFileSync(probe, `${readFileSync(probe, 'utf8')}\nvar __gateProbe = window?.location\n`)
  const result = checkJavaScript([probe])
  assert.deepEqual(result.lexical, [], '`?.` 属于 83 能力集，词法层不该报')
  assert.deepEqual(result.ast, [], '`?.` 属于 83 能力集，AST 层不该报')
  // 但它确实把「真实语法下限」抬到了 80 —— 这正是要声明出来、并写进用户文案的那个数
  const acorn = loadAcorn()
  const measured = measureEntry(acorn, probe)
  assert.equal(measured.chromeFloor, 80)
  assert.deepEqual(measured.drivers, ['optional-chaining'])
})

// ── B. 声明下限 vs 产物真实下限 ─────────────────────────────────────────────

test('#104 judge()：真实下限高于/等于/低于声明值分别是红/绿/绿', () => {
  assert.deepEqual(judge({ chromeFloor: 85, unparsable: false }, 80), { ok: false, code: 'higher' })
  assert.deepEqual(judge({ chromeFloor: 80, unparsable: false }, 80), { ok: true, code: 'match' })
  assert.deepEqual(judge({ chromeFloor: 79, unparsable: false }, 80), { ok: true, code: 'lower' })
  assert.deepEqual(judge({ chromeFloor: null, unparsable: true }, 80), { ok: false, code: 'unparsable' })
})

test('#104 正向：入口只用 ES2020（`??`）时，真实下限 80 = 声明值 → exit 0', () => {
  const dist = fakeDist('const a = null; const b = a ?? 1; window.__x = b;\n')
  const result = runNode(FLOOR_SCRIPT, ['--dist', dist])
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /真实下限 Chrome 80/)
  assert.match(result.stdout, /= 声明值/)
})

test('#104 负向对照：入口塞了 `||=`（Chrome 85）→ 必须 exit 1 且点到卡点', () => {
  const dist = fakeDist('let a = 0;\na ||= 1;\nwindow.__x = a;\n')
  const result = runNode(FLOOR_SCRIPT, ['--dist', dist])
  assert.equal(result.status, 1, `塞了 ||= 必须判红：${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /真实下限 Chrome 85/)
  assert.match(result.stderr, /高于.*声明值 80/)
  assert.match(result.stderr, /首个卡点 \d+:\d+/)
})

test('#104 负向对照：声明值被调低到 79（产物仍是 80）→ 必须 exit 1', () => {
  const dist = fakeDist('const a = null; window.__x = a ?? 1;\n')
  const result = runNode(FLOOR_SCRIPT, ['--dist', dist, '--floor', '79'])
  assert.equal(result.status, 1, `声明值低于产物真实下限必须判红：${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /声明值 79/)
})

test('#104 产物缺失时 exit 2（环境不具备 ≠ 合格）', () => {
  const empty = mktmp()
  const result = runNode(FLOOR_SCRIPT, ['--dist', empty])
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /读不到入口脚本/)
})

test('#104 真产物的入口下限与声明值一致（有 dist 才跑，没 dist 就跳过并说明）', (t) => {
  const distEntry = path.join(ROOT, 'dist')
  let hasDist = true
  try {
    readFileSync(path.join(distEntry, 'index.html'), 'utf8')
  } catch {
    hasDist = false
  }
  if (!hasDist) {
    t.diagnostic('没有 dist/（未构建）→ 跳过这条；入口下限由 check:syntax-floor 在 CI 里对真产物跑')
    return
  }
  const result = runNode(FLOOR_SCRIPT, [])
  assert.equal(result.status, 0, `真产物不该红：${result.stdout}${result.stderr}`)
})

// ── C. check:legacy 的 CLI 仍然认旧的调用方式（别把扩范围做成回归） ──────────

test('#104 check:legacy 的 CLI 仍接受位置参数，`--bridge` 缺文件时 exit 2 而不是跳过', () => {
  const dist = fakeDist('window.__x = 1;\n')
  const ok = runNode(LEGACY_SCRIPT, [dist])
  assert.equal(ok.status, 0, `合法的假产物应合格：${ok.stdout}${ok.stderr}`)
  assert.match(ok.stdout, /Capacitor 注入脚本 1 个/)
  // 位置参数必须真的被当成产物目录：往这个假产物里塞越线语法 → 必须红。
  // （少了这一拍，「目录参数被实现丢掉、退回默认 dist」也会绿 —— CI 上因为没有 dist 才暴露过一次。）
  const dirty = fakeDist('var a = 1; a ??= 2;\n')
  const red = runNode(LEGACY_SCRIPT, [dirty])
  assert.equal(red.status, 1, `位置参数指向的产物里有 ??= 必须判红：${red.stdout}${red.stderr}`)
  assert.match(red.stdout + red.stderr, /logical-assignment/)
  assert.match(red.stdout + red.stderr, new RegExp(dirty))

  const missing = runNode(LEGACY_SCRIPT, [dist, '--bridge', path.join(dist, 'nope.js')])
  assert.equal(missing.status, 2, `注入脚本不存在必须 exit 2：${missing.stdout}${missing.stderr}`)
  assert.match(missing.stderr, /找不到 Capacitor 注入脚本/)
})
