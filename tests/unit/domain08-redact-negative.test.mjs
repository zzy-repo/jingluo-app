// [layer: unit | 纯 Node，零浏览器，不发网络请求 | 耗时: <1s]
//
// N1-e 脱敏的「误伤」负例 + 口径一致性（#387）。
//
// 为什么单独一个文件（不与 domain08-sensitive-fields.test.mjs 合成一处）：
// 那张表回答的是「**该打码的打了没有**」；这里回答的是它的反面 —— **不该打码的打了没有**，
// 以及「三种形态的口径是否来自同一份定义」。两类断言的失败含义相反（一处放宽 / 一处收紧），
// 混在一张表里会让「一格红」到底是泄漏还是误伤分不清。
//
// 覆盖：
//   1. 时间戳 / 长 ID / 非卡号的长数字串**不许**被打码（11 位号码规则最容易在这里误伤：
//      `1732051200000` 的**前 11 位**恰好长得像手机号，旧写法会把日志里的 timestamp 打成 `••••0000`）；
//   2. 日志 / 错误页的尾号形态 = `src/services/ours/mask.ts` 的 `maskDeviceId` / `maskCard`（同一份口径）；
//   3. 导出边界只留类别标记（`[DEVICE_ID]` / `[CARD]` / `[PHONE]`），不留尾号；
//   4. 订单 / 商户单号与 `token=` 同级打码，且 `order_token=` 不会被 `token=` 规则重复改写。
//
//   node --test tests/unit/domain08-redact-negative.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureUrl, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

// 导出层（export.ts）只用到 `redactExportText`：采集层换成空替身，保证零浏览器依赖
installTsResolve({
  stubs: [[/collector\.js$/, fixtureUrl('domain08-09/collector-stub.mjs')]],
})

const { SENSITIVE_MARKS, markSensitiveValues, redact } = await loadTsModule(
  'src/services/diagnostics/redact.ts'
)
const { redactExportText } = await loadTsModule('src/services/diagnostics/export.ts')
const { maskCard, maskDeviceId } = await loadTsModule('src/services/ours/mask.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const CARD_DASHED = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const CARD_DIGITS = '6222021234567890123'
const PHONE = '13812345678'

/** 这些串**必须原样留下**：打掉它们等于把日志里的时间 / ID 抹平成 `••••`，排查直接失效 */
const NOT_SECRETS = [
  { label: '13 位毫秒时间戳', text: 'ts=1732051200000' },
  { label: '19 位纳秒时间戳（1 开头）', text: 'at=1700000000000000000' },
  { label: '19 位雪花 ID', text: 'id=1234567890123456789' },
  { label: '11 位普通流水号（非手机号段）', text: 'orderNo=20261119001' },
  { label: '16 位非卡号长数字', text: 'seq=1234567890123456' },
  { label: '19 位订单流水（0 开头）', text: 'trace=0622021234567890123' },
]

test('N1-e1 误伤负例：时间戳 / 长 ID / 非卡号数字在三个边界都不许被打码', () => {
  const failures = []
  for (const item of NOT_SECRETS) {
    const logged = redact(item.text)
    if (logged !== item.text)
      failures.push(`日志：${item.label} 被改写 → ${JSON.stringify(logged)}`)
    const exported = redactExportText(item.text)
    if (exported !== item.text) {
      failures.push(`导出：${item.label} 被改写 → ${JSON.stringify(exported)}`)
    }
  }
  assert.deepEqual(failures, [], '误伤：这些串里没有敏感字段，打码只会毁掉可排查性')
})

test('N1-e2 时间戳里「藏着」的 11 位不会被当成手机号截断', () => {
  // 反例的机理：`1732051200000` 的前 11 位是 `17320512000`，正好满足 `1[3-9]\d{9}`。
  // 只有「两侧不许再挨着数字」这条边界能挡住它 —— 写死这条，防以后有人把边界放宽回去。
  assert.equal(redact('1732051200000'), '1732051200000', '13 位毫秒时间戳必须原样留下')
  assert.equal(redact('1700000000000000000'), '1700000000000000000', '19 位纳秒时间戳必须原样留下')
  // 同样 11 个字符，但**两侧真的是边界**（空格）→ 按手机号处理，这是既定取舍（宁可漏打时间，不漏打手机号）
  assert.equal(redact('签名时间 17320512000 结束'), '签名时间 ••••2000 结束')
})

test('N1-e3 尾号形态与 ours/mask.ts 同口径（日志 / 错误页）', () => {
  assert.equal(
    redact(`bind failed device_id=${DEVICE_ID}`),
    `bind failed device_id=${maskDeviceId(DEVICE_ID)}`,
    '设备码必须与 maskDeviceId 完全一致'
  )
  assert.equal(
    redact(`兑换失败 card=${CARD_DASHED}`),
    `兑换失败 card=${maskCard(CARD_DASHED)}`,
    '卡密必须与 maskCard 完全一致'
  )
  assert.equal(redact(`支付失败 cardNo=${CARD_DIGITS}`), '支付失败 cardNo=••••0123')
  assert.equal(redact(`联系方式解析失败 phone=${PHONE}`), '联系方式解析失败 phone=••••5678')
})

test('N1-e4 导出边界只留类别标记，不留尾号', () => {
  assert.equal(markSensitiveValues(`device_id=${DEVICE_ID}`), 'device_id=[DEVICE_ID]')
  assert.equal(SENSITIVE_MARKS.card, '[CARD]')
  assert.equal(SENSITIVE_MARKS.phone, '[PHONE]')
  const exported = redactExportText(
    `device_id=${DEVICE_ID} card=${CARD_DASHED} cardNo=${CARD_DIGITS} phone=${PHONE}`
  )
  for (const secret of [DEVICE_ID, CARD_DASHED, CARD_DIGITS, PHONE]) {
    assert.ok(!exported.includes(secret), `导出里不该出现原文 ${secret}（实际：${exported}）`)
  }
  // 也不许留尾号：导出文件会被贴进工单，尾 4 位能和其他渠道拼回去
  for (const tail of ['cdef', 'A3SR', '0123', '5678']) {
    assert.ok(!exported.includes(tail), `导出里不该留尾号 ${tail}（实际：${exported}）`)
  }
  for (const mark of ['[DEVICE_ID]', '[CARD]', '[PHONE]']) {
    assert.ok(exported.includes(mark), `导出里缺少类别标记 ${mark}（实际：${exported}）`)
  }
})

test('N1-e5 订单号 / 商户单号与 token= 同级；order_token 不被重复改写', () => {
  assert.equal(redact('下单失败 order_token=ORDERSECRET123'), '下单失败 order_token=***')
  assert.equal(redact('下单失败 out_trade_no=OUTTRADE2026111900001'), '下单失败 out_trade_no=***')
  assert.equal(
    redact('GET /v1/x?token=TOKENVALUE99'),
    'GET /v1/x?token=***',
    'token= 的老口径不许变'
  )
  assert.equal(
    redactExportText('下单失败 order_token=ORDERSECRET123 out_trade_no=OUTTRADE2026111900001'),
    '下单失败 order_token=[REDACTED] out_trade_no=[REDACTED]'
  )
})
