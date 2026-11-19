// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// C5 —— 脱敏**规则集**的语义断言（Issue #407 / 防 #387）
//
// 历史事故 #387（P0 账号 / 资损）：`REDACTION_RULES` 里只有 `sk-` / `Bearer` / `token=` / 签名参数，
// 设备码 / 卡密 / 卡号 / 订单号 / 手机号**一条规则都没有**。这类漏洞的形状很特殊：
// 删掉一条规则不会编译失败，也不会让别的用例变红 —— 只有当有人顺手把域 8 那张表也放宽时才看得见。
//
// 已有 `pnpm check:redact` 做**静态**检查（规则类别的清单还在不在）。本契约补的是**语义**那一半：
//   R1 5 类必填类别齐备，且门禁脚本的清单与用例表指向同一份类别（两处漂移 = 一处零边际）；
//   R2 喂**样例值**（真实形状：d- + 32hex / 4×4 卡密 / 19 位卡号 / 订单 token / 11 位手机号）
//      过真实脱敏函数 → 原文不出现 + 打码形态出现（只留尾 4 位或 `***`）；
//   R3 误伤负例：时间戳 / 雪花 ID / 普通流水号必须**原样通过**（规则写宽了在这里红）。
//
// 数据源复用 `tests/fixtures/domain08-09/sensitive-cases.mjs` 的 `VALUE_CASES`（域 8 既有夹具，
// 不另造一份样例值）；导出边界的对照组在 `tests/unit/domain08-sensitive-fields.test.mjs`，
// 这里只跑日志 / 错误页共用的那一个 `redact()`，不重复抄三个边界。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, readText, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { redact } = await import('../../src/services/diagnostics/redact.ts')
const { VALUE_CASES } = await import('../fixtures/domain08-09/sensitive-cases.mjs')

/** 5 类必填值规则（#387 的关闭条件；顺序即文档顺序） */
const REQUIRED_CATEGORIES = ['device_id', 'card_key', 'card_no', 'order_token', 'phone']

/** 类别 → 夹具里承担这一类的行（V6–V10，一一对应，不多不少） */
const CATEGORY_CASE_ID = {
  device_id: 'V6',
  card_key: 'V7',
  card_no: 'V8',
  order_token: 'V9',
  phone: 'V10',
}

const caseOf = (id) => {
  const found = VALUE_CASES.find((item) => item.id === id)
  assert.ok(found, `夹具里没有 ${id}（表被裁剪了？类别要重新对齐）`)
  return found
}

const CATEGORY_ROWS = REQUIRED_CATEGORIES.map((category) => ({
  id: category,
  what: `「${category}」这一类必须有规则，且喂样例值后原文不再出现`,
  case: caseOf(CATEGORY_CASE_ID[category]),
}))

test('C5 五类必填值的脱敏规则真的生效（防 #387）', tableTest('C5', CATEGORY_ROWS, (row) => {
  const { text, secrets, expect } = row.case
  const output = redact(text)
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `原文没被脱敏：${secret}\n实际输出：${output}`)
  }
  for (const mark of expect.log.includes) {
    assert.ok(output.includes(mark), `打码形态「${mark}」没有出现（规则被删或被改窄）：${output}`)
  }
}))

test('C5 规则集与门禁清单是同一份：脚本里的 REQUIRED_CATEGORIES 不许与本契约漂移（防 #387 复发）', () => {
  const script = readText('scripts/check-redact.mjs')
  const matched = script.match(/export const REQUIRED_CATEGORIES = \[([^\]]*)\]/)
  assert.ok(matched, 'scripts/check-redact.mjs 里找不到 REQUIRED_CATEGORIES（门禁的清单被搬走/改名了？）')
  const declared = matched[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  assert.deepEqual(declared, REQUIRED_CATEGORIES, '门禁清单与契约清单不一致：删/加一类必须两处同步')
  // 夹具里也必须真有这五类的样例值（清单写了但没人验 = 假绿）
  for (const id of Object.values(CATEGORY_CASE_ID)) caseOf(id)
})

/** 误伤负例：这些值**不是**敏感信息，规则写宽了就会把正常日志打成马赛克（#387 的反向代价） */
const SAFE_ROWS = [
  { id: 'N1', what: '毫秒时间戳原样通过', text: 'at=1732000000000 done' },
  { id: 'N2', what: '雪花 ID（19 位纯数字）原样通过', text: 'session snowflake=1234567890123456789' },
  { id: 'N3', what: '普通流水号（前缀 + 数字）原样通过', text: 'trace=REQ202611190001234 finished' },
  { id: 'N4', what: '版本号与构建号原样通过', text: 'version=1.4.0-beta.10 versionCode=17' },
]

test('C5 误伤负例：时间戳 / 雪花 ID / 流水号必须原样通过（防规则写宽）', tableTest('C5-safe', SAFE_ROWS, (row) => {
  assert.equal(redact(row.text), row.text, '这条不是敏感信息，却被脱敏器改写了')
}))
