// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `pnpm run check:ip` 的判定规则自测（scripts/check-hardcoded-ip.mjs + scripts/lib/hardcodedIpAudit.mjs）。
//
// 背景：四段点分十进制的**版本号**（模拟器 35.1.2.0、Chrome 120.0.6099.230）和 IPv4 语法上完全一样，
// 段范围校验也救不了，所以门禁加了一条「版本语境豁免」。这条豁免最容易走宽成漏报，所以这里两头都钉：
//   1. 版本号不该报（注释 / 字符串 / 文档风格三种位置）；
//   2. 真写死的公网地址必须照报 —— 包括写在注释里的，以及「版本号 + 真地址」混写在一行的。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isVersionContext, scanText } from '../../scripts/lib/hardcodedIpAudit.mjs'

const ips = (text) => scanText(text).map((hit) => `${hit.line}:${hit.ip}`)

test('check:ip 版本号不算写死 IP：模拟器版本号写在注释里', () => {
  // 这一行就是当初把门禁打红的原文（scripts/compat/lib/device.mjs 第 7 行）
  const line =
    '//   - 模拟器固定用 SDK 里现有的 35.1.2.0（不要升级，`emulator-37.2.13.bak` 是留给别人的备份）；'
  assert.deepEqual(ips(line), [])
})

test('check:ip 版本号不算写死 IP：字符串字面量与模板串', () => {
  assert.deepEqual(ips("export const EMULATOR_VERSION = '35.1.2.0'"), [])
  assert.deepEqual(ips('const CHROME_VERSION = "120.0.6099.230"'), [])
  assert.deepEqual(ips('const label = `WebView version ${WEBVIEW_VERSION ?? "35.1.2.0"}`'), [])
})

test('check:ip 版本号不算写死 IP：README 风格的注释与 AVD 名', () => {
  assert.deepEqual(ips('<!-- 模拟器版本 35.1.2.0，取证矩阵见下 -->'), [])
  // AVD 名（compat-api26 …）不是四段点分十进制，本来就不该进候选
  assert.deepEqual(ips('SERIAL=emulator-5554 AVD=compat-api26/28/29/30/31'), [])
})

test('check:ip 版本语境有主机/地址语义词时作废：注释里的真 IP 照报', () => {
  assert.deepEqual(ips('// 生产环境 62.106.70.167'), ['1:62.106.70.167'])
  assert.deepEqual(ips('// 服务器版本 1.2.3.4'), ['1:1.2.3.4'])
  assert.deepEqual(ips('// host: 62.106.70.167'), ['1:62.106.70.167'])
  assert.deepEqual(ips('// 62.106.70.167 -> 140.210.13.146 迁移'), ['1:62.106.70.167'])
  assert.deepEqual(ips('// 旧机 8.8.8.8 已下线，webview 版本另说'), ['1:8.8.8.8'])
  // 代价（明知并接受）：「迁移 + 版本号」混写的行，版本号也会被一并报出来，用 check-ip-allow 拆开
  assert.deepEqual(ips('// 迁移：模拟器版本 35.1.2.0'), ['1:35.1.2.0'])
})

test('check:ip 代码里写死的地址照报（版本语境豁免不能放过它）', () => {
  assert.deepEqual(ips("const HOST = '1.2.3.4'"), ['1:1.2.3.4'])
  assert.deepEqual(ips("const API = '62.106.70.167'"), ['1:62.106.70.167'])
  assert.deepEqual(ips('fetch("http://62.106.70.167/v1/chat")'), ['1:62.106.70.167'])
  assert.deepEqual(ips("export const BASE_URL = '8.8.8.8'"), ['1:8.8.8.8'])
})

test('check:ip 一行里列两个版本号不误报（版本区间 / 差分）', () => {
  assert.deepEqual(ips('// build 35.1.2.0 → 37.2.13.0 的差分只看渲染'), [])
  assert.deepEqual(ips('// 模拟器版本 35.1.2.0 / 37.2.13.0 两档'), [])
})

test('check:ip ALLOWED_HOSTS 与保留段的豁免没被削弱', () => {
  assert.deepEqual(ips("const host = '140.210.13.146'"), [])
  assert.deepEqual(ips("const HOST = '127.0.0.1'"), [])
  assert.deepEqual(ips("const HOST = '192.168.1.10'"), [])
  assert.deepEqual(ips("const HOST = '169.254.1.1'"), [])
  assert.deepEqual(ips("const HOST = '100.64.0.1'"), [])
  assert.deepEqual(ips("const HOST = '203.0.113.9'"), []) // RFC 5737 TEST-NET-3：保留测试段
  assert.deepEqual(ips("const HOST = '198.51.100.7'"), []) // RFC 5737 TEST-NET-2
})

test('check:ip 行内 check-ip-allow 豁免仍然生效（本行与上一行）', () => {
  assert.deepEqual(ips("const OLD = '62.106.70.167' // check-ip-allow：已下线主机名单"), [])
  assert.deepEqual(ips('// check-ip-allow：下面是下线主机名单\n  "62.106.70.167",'), [])
})

test('check:ip 行号从 1 起、按出现顺序', () => {
  const text = ['export const A = 1', "const x = '8.8.8.8'", '', "const y = '9.9.9.9'"].join('\n')
  assert.deepEqual(ips(text), ['2:8.8.8.8', '4:9.9.9.9'])
})

test('check:ip 二进制（含 NUL）与空文本不产生命中', () => {
  assert.deepEqual(ips("const x = '8.8.8.8'\u0000"), [])
  assert.deepEqual(ips(''), [])
})

test('check:ip 版本语境判定：版本词有、主机词无', () => {
  assert.equal(isVersionContext('// 模拟器版本 35.1.2.0'), true)
  assert.equal(isVersionContext('const EMULATOR_VERSION = "35.1.2.0"'), true)
  assert.equal(isVersionContext('// 生产环境 62.106.70.167'), false)
  assert.equal(isVersionContext('// version 62.106.70.167 (server)'), false)
  // 上一行是版本行、本行只有一个候选时也算版本语境
  assert.equal(isVersionContext('  35.1.2.0', '// 模拟器版本：'), true)
})
