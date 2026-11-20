// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #276：兼容下限「单一来源」门禁的自证。
//
// 单里那句「一处绕开唯一来源且断言恒真」有两张脸，本文件各钉一条：
//   · 恒真断言：老的 `targets.some(t => /^chrome\s*>=\s*83$/.test(t))` 自带 83，只可能比字符串；
//     `targets` 为空时还会先塞 fallback 再断言 → 断言被自己塞进去的值满足。**恒真**。
//     改成 `assertBrowserslist()` 后，「伪造一个错误值」必须抛（用例 B 逐条钉住）。
//   · 绕开唯一来源：`build-fixtures.mjs` 曾经自己写死 `['chrome >= 83']`，于是抬下限时
//     产品按 91 构建、夹具还按 83 构建 —— `check:legacy` 照样绿，但它量的不是线上那个东西。
//     用例 C 把那个写法塞回去，扫不出来就是红。
//
//   A 真实仓库：check-compat-baseline 合格（门禁本体，不是抄一份数字进测试）
//   B 口径自证：伪造错误下限 → 断言必须失败
//   C 写死的副本：夹具里写回字面量 → 必须被扫出来并指到行号
//   D 档位单源：probe 的 PRESET_TARGETS 与 matrix-scan 的 WEBVIEW_TARGETS 都等于 probeTiers
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  checkCompatBaseline,
  scanHardcodedFloors,
} from '../../scripts/check-compat-baseline.mjs'
import {
  BASELINE_CHROMIUM,
  PROBE_TIERS,
  assertBrowserslist,
  browserslistChromeTarget,
} from '../../scripts/lib/compatBaseline.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

test('A 真实仓库：全部派生点都等于 config/compat.json', async () => {
  const { problems, notes } = await checkCompatBaseline()
  assert.deepEqual(problems, [], `门禁应合格，实际：\n${JSON.stringify(problems, null, 2)}`)
  assert.ok(notes.length >= 5, `报告应逐项列出唯一来源与派生点，实际 ${notes.length} 条`)
})

test('B 口径自证：伪造一个错误的下限，断言必须失败（不是恒真）', () => {
  // 产线写 105（有人把下限改回去了）：必须抛，并点名唯一来源
  assert.throws(
    () => assertBrowserslist(['chrome >= 105']),
    /config\/compat\.json:baselineChromium/,
    '写死更高下限时必须抛'
  )
  // 伪造「唯一来源说 91、产线还是 83」这一档：这正是抬下限漏改一处的现场
  assert.throws(
    () => assertBrowserslist([browserslistChromeTarget()], BASELINE_CHROMIUM + 8),
    /baselineChromium = 91/,
    '两份不相等时必须抛，并把两边的数字都打出来'
  )
  // 空列表：老写法会被自己塞进去的 fallback 满足（恒真），新写法必须抛
  assert.throws(() => assertBrowserslist([]), /应有且只有一条/, 'browserslist 为空时必须抛')
  // 两条 chrome 下限：留一条旧的就能混过去，所以必须抛
  assert.throws(
    () => assertBrowserslist(['chrome >= 83', 'chrome >= 91']),
    /应有且只有一条/,
    '两条 chrome 下限时必须抛'
  )
  // 反过来：唯一来源那一份必须放行（证明这条闸门不是恒定红）
  assert.equal(assertBrowserslist([browserslistChromeTarget(), 'edge >= 83']), BASELINE_CHROMIUM)
})

test('C 夹具写死：build-fixtures 里写回字面量必须被扫出来（负向 2）', () => {
  const fixture = read('scripts/fixtures/legacy-api-gate/build-fixtures.mjs')
  assert.deepEqual(
    scanHardcodedFloors(fixture, 'build-fixtures.mjs'),
    [],
    '修好之后夹具里不该再有写死的下限副本'
  )
  // 把 issue #276 里那个原始写法塞回去 —— 必须命中，且指到具体行号
  const regressed = fixture.replace('env: { targets: TARGETS },', "env: { targets: ['chrome >= 83'] },")
  assert.notEqual(regressed, fixture, '替换点必须真的存在（否则这条负向用例本身失效了）')
  const hits = scanHardcodedFloors(regressed, 'build-fixtures.mjs')
  assert.ok(hits.length > 0, '写回字面量必须被扫出来，否则夹具又绕开了唯一来源')
  assert.equal(hits[0].id, 'chrome-floor-literal')
  assert.ok(hits[0].line > 0, '要指到具体行号')
  // 注释里的 83 不算（那是文档价值）：只有代码里的副本才是漂移源
  assert.deepEqual(
    scanHardcodedFloors('// 为什么是 chrome >= 83：Android 11 出厂镜像\nconst keep = 1\n', 'demo.mjs'),
    [],
    '注释里的数字不该被当成副本'
  )
})

test('D 档位单源：探针与矩阵的档位都派生自 probeTiers', async () => {
  const probe = await import('../../scripts/compat/probe.mjs')
  assert.equal(probe.BASELINE_CHROMIUM, BASELINE_CHROMIUM, 'probe 的下限必须来自唯一来源')
  assert.deepEqual(
    Object.values(probe.PRESET_TARGETS),
    PROBE_TIERS,
    `probe 的预设档位必须等于 probeTiers，实际 ${Object.keys(probe.PRESET_TARGETS).join(' / ')}`
  )
  const matrix = await import('../../scripts/compat/matrix-scan.mjs')
  assert.deepEqual(matrix.WEBVIEW_TARGETS, PROBE_TIERS, 'matrix 的档位必须等于 probeTiers')
})
