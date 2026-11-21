// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #104 / #275 / #276：兜底页里那几个「内联脚本不得不写死」的数字与键，
// 必须和唯一来源逐个相等 —— 它们没法 import，只能靠一条测试把两边钉住。
//
// 与 tests/unit/compat-baseline.test.mjs 的分工：那份测**门禁本体**（唯一来源的派生点是否一致），
// 这份测**守卫那份字面量副本**（src/index.html 内联脚本里的 4 个常量/键）。
//
// 为什么值得单开一个文件：这几个数字一旦漂移，表现都不是红，而是**假绿** ——
//   - BASELINE_CHROMIUM 比 config/compat.json 大：内核过旧的用户看不到升级指引（#104 白做）；
//   - BASELINE_CHROMIUM 比 config/compat.json 小：WebView 83 本来能跑却被判「内核过旧」；
//   - MAX_COPY_CHARS 与 MAX_REPORT_CHARS 不一致：一张卡片复制出来两个上限，反馈时被截一半；
//   - DEVICE_ID_KEY / DEVICE_ID_PATTERN 与业务侧不一致：脱敏读到的是空值或非法值，
//     要么整行消失（看不出问题），要么把不该露的形态当成合法设备码。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const ROOT = new URL('../../', import.meta.url)
const html = readFileSync(new URL('src/index.html', ROOT), 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const compat = JSON.parse(readFileSync(new URL('config/compat.json', ROOT), 'utf8'))

const literal = (pattern, label) => {
  const matched = guardSource.match(pattern)
  assert.ok(matched, `src/index.html 里找不到 ${label}（被改名了？同步改本断言）`)
  return matched[1]
}

test('#104 守卫的 BASELINE_CHROMIUM 等于 config/compat.json 的 baselineChromium', () => {
  assert.equal(Number(literal(/var BASELINE_CHROMIUM = (\d+)/, 'BASELINE_CHROMIUM')), compat.baselineChromium)
  // 阈值只拿来判「主版本 < baseline」：多一个等号就会把 83 本身也判旧（WebView 83 是下限，能用）
  assert.match(guardSource, /engine\.major < BASELINE_CHROMIUM/)
  assert.doesNotMatch(guardSource, /engine\.major <= BASELINE_CHROMIUM/)
  assert.deepEqual(compat.probeTiers, [...compat.probeTiers].sort((a, b) => a - b))
  assert.ok(compat.probeTiers.includes(compat.baselineChromium), 'probeTiers 要含下限档')
})

test('#104 守卫的 MIN_ENGINE_CHROMIUM 等于 config/compat.json 的 syntaxFloorChromium', () => {
  // 语法下限（产物真实能被解析的最低内核）与承诺下限（baselineChromium）是两件事：
  // 构建目标 chrome>=83 的能力集包含 ES2020，`?.` / `??` 因此原样留在产物里，
  // 真实语法下限是 80（见 config/compat.json 与 scripts/lib/compatBaseline.mjs 的注释）。
  const literalFloor = Number(literal(/var MIN_ENGINE_CHROMIUM = (\d+)/, 'MIN_ENGINE_CHROMIUM'))
  assert.equal(literalFloor, compat.syntaxFloorChromium)
  assert.ok(
    literalFloor <= compat.baselineChromium,
    `语法下限（${literalFloor}）不能高于承诺下限（${compat.baselineChromium}）`
  )
  // 判据必须是「主版本 < 下限」：80 本身能解析 ES2020，把它判成「解析不了」就是误报
  assert.match(guardSource, /engine\.major < MIN_ENGINE_CHROMIUM/)
  assert.doesNotMatch(guardSource, /engine\.major <= MIN_ENGINE_CHROMIUM/)
})

test('#104 守卫的复制文本上限与 errorReport.ts 的 MAX_REPORT_CHARS 相等', async () => {
  const { MAX_REPORT_CHARS } = await import('../../src/app/errorReport.ts')
  assert.equal(Number(literal(/var MAX_COPY_CHARS = (\d+)/, 'MAX_COPY_CHARS')), MAX_REPORT_CHARS)
})

test('#104 守卫的设备码键与形态与 src/services/invite/device.ts 一致（脱敏读的就是这一个键）', async () => {
  const { DEVICE_ID_STORAGE_KEY, DEVICE_ID_PATTERN } = await import('../../src/services/invite/device.ts')
  assert.equal(literal(/var DEVICE_ID_KEY = '([^']+)'/, 'DEVICE_ID_KEY'), DEVICE_ID_STORAGE_KEY)
  const patternSource = literal(/var DEVICE_ID_PATTERN = \/(.+)\/\n/, 'DEVICE_ID_PATTERN')
  assert.equal(patternSource, DEVICE_ID_PATTERN.source)
  // 设备码只留尾 4 位：与 src/services/ours/mask.ts 的 maskDeviceId 同口径
  assert.match(guardSource, /'••••' \+ code\.slice\(-4\)/)
})

test('#104 守卫不读凭据：代码里（注释不算）根本没有 chat-demo:api-key 这个词', () => {
  const stripComments = (text) =>
    text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/[^\n]*/gm, ' ')
  assert.doesNotMatch(stripComments(guardSource), /chat-demo:api-key/)
  assert.doesNotMatch(stripComments(html), /chat-demo:api-key/)
  // 注释里那句「守卫不读它」要留着：它是给下一个人的规矩，不是可执行代码
  assert.match(html, /chat-demo:api-key/)
})
