// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 类别 3（平台与宿主能力）审计器的口径测试。
//
// 这个文件存在的意义不是「覆盖率好看」，而是把 `docs/capabilities/host.md` 里那四类结论
// **钉在代码上**：谁把判定链改宽或改窄，这里必须一起红。
// 所以每条用例都用真实代码片段（或它在仓里的等价写法）当输入，断言结论、风险与处置，
// 而不是断言内部实现细节 —— 内部怎么分组、怎么排序随时可以改，结论不许悄悄变。
//
// 特别地：`fetch 是本尊` 这一族必须是「真实漏洞（高）」，而且**探测不能把它洗白**（见 forceVerdict 用例）。
// 这是全仓唯一一条「引信已装好、还没扣扳机」的高危假设（`collector.ts:980`），
// 只要它被降级成「已有兜底」，本文件必须失败。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_RULES,
  DISPOSITIONS,
  VERDICTS,
  WEBVIEW_MAX_CHROME,
  auditHostCapabilities,
} from '../../scripts/lib/hostCapabilityAudit.mjs'

/** 单文件扫描，返回命中列表 */
const scan = (text, file = 'src/demo.ts') => auditHostCapabilities([{ file, text }]).hits

/** 「能力=结论」的可读快照，用来看整体口径 */
const pairs = (hits) => hits.map((hit) => `${hit.capability}=${hit.verdict}`).sort()

test('兼容基线写死 WebView 83，四类结论的顺序固定', () => {
  assert.equal(WEBVIEW_MAX_CHROME, 83)
  assert.deepEqual(VERDICTS, ['已有兜底', '无风险', '真实漏洞', '需动态验证'])
  // 处置是结论的投影：真实漏洞一律先按「不存在」处理，必须探测
  assert.deepEqual(DISPOSITIONS, {
    已有兜底: '已有兜底',
    无风险: '已有兜底',
    真实漏洞: '需探测',
    需动态验证: '需动态验证',
  })
})

test('一次扫描里四类结论都要出现：兜底 / 无风险 / 真实漏洞 / 需动态验证', () => {
  const text = [
    'const write = navigator.clipboard?.writeText',
    'const text = await blob.text()',
    'window.fetch = patched',
    'canvas.toBlob(resolve, "image/jpeg", 0.9)',
  ].join('\n')

  assert.deepEqual(pairs(scan(text)), [
    'Body.text/arrayBuffer=无风险',
    'canvas.toBlob=需动态验证',
    'fetch 页面级拦截=真实漏洞',
    'navigator.clipboard=已有兜底',
  ])
})

test('已有兜底：调用点自己用可选链探测过，不算漏洞', () => {
  const [hit] = scan('const write = navigator.clipboard?.writeText')
  assert.equal(hit.capability, 'navigator.clipboard')
  assert.equal(hit.verdict, '已有兜底')
  assert.equal(hit.guard, 'optional-chaining')
  assert.equal(hit.guarded, true)
  assert.equal(hit.disposition, '已有兜底')
  assert.equal(hit.risk, '低')
})

test('已有兜底：src/index.html 的启动守卫探过的能力，调用点可以直接裸写', () => {
  const { hits, summary } = auditHostCapabilities([
    {
      file: 'src/index.html',
      text: [
        'var REQUIRED = [',
        "  ['AbortController', function () { return window.AbortController }],",
        "  ['ResizeObserver', function () { return window.ResizeObserver }]",
        ']',
      ].join('\n'),
    },
    { file: 'src/services/api/client.ts', text: 'const controller = new AbortController()' },
  ])

  assert.deepEqual(summary.bootGated, ['AbortController', 'ResizeObserver'])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].capability, 'AbortController')
  assert.equal(hits[0].verdict, '已有兜底')
  assert.equal(hits[0].guard, 'index.html REQUIRED')
  assert.equal(hits[0].guarded, true)
})

test('无风险：引入版本 ≤ 83 的裸调用不判漏洞，只看版本号说话', () => {
  const [hit] = scan('const text = await blob.text()')
  assert.equal(hit.capability, 'Body.text/arrayBuffer')
  assert.equal(hit.verdict, '无风险')
  assert.equal(hit.risk, '低')
  assert.equal(hit.disposition, '已有兜底')
  assert.equal(hit.guarded, false)
})

test('真实漏洞（高）：页面级替换 window.fetch，等于宣告「依赖 fetch 是本尊」', () => {
  const [hit] = scan('window.fetch = patched as unknown as typeof window.fetch')
  assert.equal(hit.capability, 'fetch 页面级拦截')
  assert.equal(hit.verdict, '真实漏洞')
  assert.equal(hit.risk, '高')
  assert.equal(hit.disposition, '需探测')
  assert.match(hit.reason, /依赖 fetch 是本尊/u)
})

test('真实漏洞：探测洗不白 fetch —— try…catch 里替换 window.fetch 仍然是真实漏洞', () => {
  const text = ['try {', '  window.fetch = patched', '} catch {', '  // 忽略了也不影响结论', '}'].join('\n')
  const [hit] = scan(text)
  assert.equal(hit.capability, 'fetch 页面级拦截')
  assert.equal(hit.guard, 'try-catch')
  assert.equal(hit.guarded, true)
  // 探测信号在，但 forceVerdict 优先级最高：包一层 try 并不能让 fetch 变回本尊
  assert.equal(hit.verdict, '真实漏洞')
  assert.equal(hit.risk, '高')
})

test('真实漏洞（中）：clone() 之后读 body 也算依赖 fetch 是本尊', () => {
  const hits = scan('const text = await response.clone().text()')
  const clone = hits.find((hit) => hit.capability === 'fetch 响应体 clone')
  assert.ok(clone, 'clone().text() 必须被识别为 fetch 响应体 clone')
  assert.equal(clone.verdict, '真实漏洞')
  assert.equal(clone.risk, '中')
  assert.equal(clone.disposition, '需探测')
  assert.match(clone.reason, /依赖 fetch 是本尊/u)
  assert.match(clone.reason, /流式响应/u)
})

test('真实漏洞：高于 WebView 83 的裸调用按「可能不存在」处理（AbortSignal.timeout 是 103）', () => {
  const [hit] = scan('const signal = AbortSignal.timeout(1000)')
  assert.equal(hit.capability, 'AbortSignal.timeout')
  assert.equal(hit.verdict, '真实漏洞')
  assert.equal(hit.risk, '高')
  assert.equal(hit.disposition, '需探测')
})

test('需动态验证：API 在但行为只能上真机看（canvas.toBlob 回调）', () => {
  const [hit] = scan('canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)')
  assert.equal(hit.capability, 'canvas.toBlob')
  assert.equal(hit.verdict, '需动态验证')
  assert.equal(hit.risk, '中')
  assert.equal(hit.disposition, '需动态验证')
  assert.equal(hit.guarded, false)
})

test('无风险：@capacitor/core 的 isNativePlatform / getPlatform 随包发布，裸调用不判漏洞', () => {
  const hits = scan(
    ['if (!Capacitor.isNativePlatform()) throw new Error("NATIVE_EXPORT_UNAVAILABLE")', 'const os = Capacitor.getPlatform()'].join('\n')
  )
  assert.deepEqual(pairs(hits), ['Capacitor.getPlatform=无风险', 'Capacitor.isNativePlatform=无风险'])
})

test('注释里的能力名不算调用点：块注释与行注释都不进表格', () => {
  const text = [
    '/**',
    ' * 不要用 navigator.share(...)，WebView 里根本没有',
    ' */',
    '// navigator.share({ url }) 也不要写',
    'const keep = 1',
  ].join('\n')
  assert.deepEqual(scan(text), [])
})

test('探测窗口跨行有效：try…catch 包住的 localStorage 写入算已有兜底', () => {
  const text = [
    'const run = () => {',
    '  try {',
    '    localStorage.setItem("k", "v")',
    '  } catch {',
    '    return null',
    '  }',
    '}',
  ].join('\n')
  const [hit] = scan(text)
  assert.equal(hit.capability, 'localStorage')
  assert.equal(hit.guard, 'try-catch')
  assert.equal(hit.verdict, '已有兜底')
})

test('汇总口径：命中按文件与行号排序，byCapability 按命中数降序分组', () => {
  const { hits, summary } = auditHostCapabilities([
    { file: 'src/b.ts', text: 'const write = navigator.clipboard?.writeText' },
    { file: 'src/a.ts', text: ['const one = await blob.text()', 'const two = await blob.text()'].join('\n') },
  ])

  assert.equal(summary.files, 2)
  assert.equal(summary.total, 3)
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line}`),
    ['src/a.ts:1', 'src/a.ts:2', 'src/b.ts:1']
  )
  assert.deepEqual(summary.byVerdict, { 已有兜底: 1, 无风险: 2, 真实漏洞: 0, 需动态验证: 0 })
  assert.deepEqual(summary.byRisk, { 高: 0, 中: 0, 低: 3 })
  assert.deepEqual(
    summary.byCapability.map((item) => `${item.capability}:${item.total}`),
    ['Body.text/arrayBuffer:2', 'navigator.clipboard:1']
  )
  assert.deepEqual(summary.realVulnerabilities, [])
  assert.deepEqual(summary.needsDynamic, [])
})

test('入参兼容 file/path 与 text/content，并把 Windows 反斜杠规范化成正斜杠', () => {
  const { hits } = auditHostCapabilities([
    { path: 'src\\services\\exportText.ts', content: 'const write = navigator.clipboard?.writeText' },
  ])
  assert.equal(hits[0].file, 'src/services/exportText.ts')
})

test('入参不合法时抛中文 TypeError，不静默跳过', () => {
  assert.throws(() => auditHostCapabilities(null), { name: 'TypeError', message: /需要一个数组/u })
  assert.throws(() => auditHostCapabilities([{ text: 'x' }]), { name: 'TypeError', message: /缺少 file\/path/u })
  assert.throws(() => auditHostCapabilities([{ file: 'src/a.ts' }]), { name: 'TypeError', message: /缺少 text\/content/u })
})

test('规则表自身可自检：id 唯一、正则带 g、版本号显式（数字或 null）、风险等级合法', () => {
  assert.ok(CAPABILITY_RULES.length >= 20)
  for (const rule of CAPABILITY_RULES) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(rule.id.length > 0)
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} 的 pattern 不是正则`)
    assert.ok(rule.pattern.global, `${rule.id} 的 pattern 缺 g 标志`)
    // chrome 必须显式写出：数字=浏览器引入版本；null=不是浏览器 API（随包发布 / 只有显式结论的家族）
    assert.ok('chrome' in rule, `${rule.id} 没写 chrome 字段`)
    assert.ok(rule.chrome === null || typeof rule.chrome === 'number', `${rule.id} 的 chrome 既不是数字也不是 null`)
    assert.ok(['高', '中', '低'].includes(rule.risk), `${rule.id} 的风险等级不合法`)
  }
  assert.equal(new Set(CAPABILITY_RULES.map((rule) => rule.id)).size, CAPABILITY_RULES.length)

  // forceVerdict 只给 fetch 家族用：它意味着「无视探测直接定性」，不能随便扩散
  const forced = CAPABILITY_RULES.filter((rule) => rule.forceVerdict)
  assert.ok(forced.length > 0)
  for (const rule of forced) {
    assert.equal(rule.forceVerdict, '真实漏洞')
    assert.match(rule.id, /^fetch /u)
  }
})
