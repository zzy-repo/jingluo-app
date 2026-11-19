// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #209 类别 4 的防回归。判定逻辑本身没法靠「再跑一次模拟器」保证正确，
// 所以这里用真实采集回来的测量 JSON 当输入（docs/ui/209-behavior/before-wv83-*.json，
// 模拟器 Android Emulator API30 / WebView 83.0.4103.106 上读出来的原样数据），
// 再逐条把「成立」改成「不成立」，钉住三件事：
//  1. 真数据上四条假设都判成立（万一采集脚本退化、读出全 0，这里会先炸）；
//  2. 每个证伪条件都能真的触发不成立（否则「成立」可能只是判据写漏了）；
//  3. 没有溢出 / 没有键盘读数时判「未测」而不是「成立」—— 未测就该显示未测，
//     不能拿静息态的漂亮数字冒充全部场景（100vh 最经典的失灵就在键盘态）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ASSUMPTIONS,
  VERDICT,
  auditBehaviorAssumptions,
  judgeButtonWrap,
  judgeDialogScroll,
  judgeTouchScroll,
  judgeViewportHeight,
} from '../../scripts/lib/behaviorAssumptionAudit.mjs'

const load = (width) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../docs/ui/209-behavior/before-wv83-${width}.json`, import.meta.url)), 'utf8'))

const FIXTURES = [load(360), load(390), load(412)]

const clone = (value) => structuredClone(value)
const findingFor = (findings, assumption) => findings.find((finding) => finding.assumption === assumption)

test('#209 真实测量数据上四条假设都成立', () => {
  const { findings, summary } = auditBehaviorAssumptions(FIXTURES)
  assert.equal(findings.length, 4)
  for (const finding of findings) {
    assert.equal(finding.verdict, VERDICT.holds, `${finding.assumption} 在真实数据上被判成 ${finding.verdict}`)
  }
  assert.equal(summary.holds, 4)
  assert.equal(summary.falsified, 0)
  // 复现不出就不要开单：全成立时没有待开单条目
  assert.deepEqual(summary.issuesToOpen, [])
})

test('#209 测量数据里带的是真值，不是空壳', () => {
  const [m360] = FIXTURES
  // 这三个数字是 WebView 83 在 360×728 上的实测结果，退化成 0 就说明采集脚本坏了
  assert.equal(m360.settingsDialog.probe.viewport.measured100vh, 728)
  assert.equal(m360.settingsDialog.probe.viewport.visualViewport.height, 728)
  assert.equal(m360.settingsDialog.probe.viewport.dvhSupported, false)
  assert.ok(m360.settingsDialog.swipe.scrollTopDelta > 0, '真实触摸必须真的把容器滚起来')
  const host = m360.settingsDialog.probe.primaryScrollHost
  assert.ok(host.scrollHeight > host.clientHeight, '设置弹窗的滚动宿主必须有实际溢出')
  assert.match(host.css['overflow-y'], /auto|scroll/u)
})

test('#209 假设 1：按钮行溢出 ⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  const row = measurement.settingsDialog.probe.buttonRows.find((item) => item.childCount > 1)
  row.overflowPx = 12
  const result = judgeButtonWrap(measurement)
  assert.equal(result.verdict, VERDICT.falsified)
  assert.equal(result.evidence.overflowingRows.length, 1)
})

test('#209 假设 1：文字被裁 ⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  const row = measurement.settingsDialog.probe.buttonRows.find((item) => item.childCount > 1)
  row.anyTextClipped = true
  assert.equal(judgeButtonWrap(measurement).verdict, VERDICT.falsified)
})

test('#209 假设 1：按钮被压到窄于 44px ⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  const row = measurement.settingsDialog.probe.buttonRows.find((item) => item.childCount > 1)
  row.narrowest = 38
  const result = judgeButtonWrap(measurement)
  assert.equal(result.verdict, VERDICT.falsified)
  assert.equal(result.evidence.squashedRows[0].narrowest, 38)
})

test('#209 假设 1：没有多按钮行 ⇒ 未测（不拿单按钮冒充通过）', () => {
  const measurement = clone(FIXTURES[0])
  measurement.settingsDialog.probe.buttonRows = []
  measurement.confirmDialog = null
  assert.equal(judgeButtonWrap(measurement).verdict, VERDICT.untested)
})

test('#209 假设 2：溢出但没有任何可滚容器 ⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  for (const host of measurement.settingsDialog.probe.scrollHosts) {
    host.css['overflow-y'] = 'visible'
    host.css['overflow-x'] = 'visible'
  }
  if (measurement.confirmDialog) {
    for (const host of measurement.confirmDialog.scrollHosts) {
      host.css['overflow-y'] = 'visible'
      host.css['overflow-x'] = 'visible'
    }
  }
  const result = judgeDialogScroll(measurement)
  assert.equal(result.verdict, VERDICT.falsified)
  assert.ok(result.evidence.perSample.some((sample) => sample.hasOverflow && !sample.scrollableHost))
})

test('#209 假设 2：内容没超出 ⇒ 未测（记成立会把「没测到」说成「测过了」）', () => {
  const measurement = clone(FIXTURES[0])
  for (const host of measurement.settingsDialog.probe.scrollHosts) host.overflowingY = false
  if (measurement.confirmDialog) for (const host of measurement.confirmDialog.scrollHosts) host.overflowingY = false
  assert.equal(judgeDialogScroll(measurement).verdict, VERDICT.untested)
})

test('#209 假设 3：#30 的场景（事件全到、scrollTop 纹丝不动）⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  measurement.settingsDialog.swipe.scrollTopDelta = 0
  measurement.settingsDialog.swipe.scrollTopAfterFirstSwipe = 0
  measurement.settingsDialog.swipe.reachableAtEnd = false
  const result = judgeTouchScroll(measurement)
  assert.equal(result.verdict, VERDICT.falsified)
  assert.match(result.evidence.gestureSource, /input swipe/u)
})

test('#209 假设 3：没有可滚宿主 ⇒ 未测', () => {
  const measurement = clone(FIXTURES[0])
  measurement.settingsDialog.swipe.host = null
  assert.equal(judgeTouchScroll(measurement).verdict, VERDICT.untested)
})

test('#209 假设 4：静息成立但键盘态不跟随 ⇒ 不成立', () => {
  const measurement = clone(FIXTURES[0])
  assert.ok(measurement.keyboard.withKeyboard, '测量数据里必须有键盘态读数')
  // 模拟 adjustPan：100vh 仍是 728，而可视高度被键盘吃掉
  measurement.keyboard.withKeyboard.measured100vh = 728
  const result = judgeViewportHeight(measurement)
  assert.equal(result.verdict, VERDICT.falsified)
  assert.equal(result.evidence.rest.delta, 0)
  assert.ok(result.evidence.withKeyboard.delta > 1)
})

test('#209 假设 4：缺键盘读数 ⇒ 未测', () => {
  const measurement = clone(FIXTURES[0])
  delete measurement.keyboard.withKeyboard
  assert.equal(judgeViewportHeight(measurement).verdict, VERDICT.untested)
})

test('#209 假设 4：dvh 在 WV83 上不支持，但 100vh 已经等于可视高度', () => {
  const result = judgeViewportHeight(FIXTURES[0])
  assert.equal(result.verdict, VERDICT.holds)
  assert.equal(result.evidence.dvhSupported, false)
  assert.equal(result.evidence.rest.delta, 0)
  assert.equal(result.evidence.withKeyboard.delta, 0)
  assert.match(result.evidence.mechanism, /adjustResize/u)
})

test('#209 多宽度合并：任一宽度证伪即整体不成立', () => {
  const broken = clone(FIXTURES[1])
  broken.settingsDialog.swipe.scrollTopDelta = 0
  const { findings, summary } = auditBehaviorAssumptions([FIXTURES[0], broken])
  const touch = findingFor(findings, ASSUMPTIONS.touchScroll)
  assert.equal(touch.verdict, VERDICT.falsified)
  assert.deepEqual(touch.evidence.falsifiedAt, [broken.width])
  assert.deepEqual(touch.evidence.holdsAt, [FIXTURES[0].width])
  assert.deepEqual(summary.issuesToOpen, [ASSUMPTIONS.touchScroll])
})

test('#209 没有测量数据 ⇒ 四条全未测，不开单', () => {
  const { findings, summary } = auditBehaviorAssumptions([])
  assert.equal(findings.length, 4)
  assert.ok(findings.every((finding) => finding.verdict === VERDICT.untested))
  assert.deepEqual(summary.issuesToOpen, [])
})
