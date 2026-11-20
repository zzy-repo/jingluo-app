// [layer: unit | 依赖: 无（纯 Node，假 transport，零网络） | 耗时: <1s]
//
// L0（#487 阶段③ 并行补基准）：**余额只来自后端**的字段口径（`usage.ts`）+ **Key 创建去重**（`keys.ts`）。
//
// 这一层两处错法都不是「报错」，而是「静默显示错的数」：
//   ① `GET /v1/usage` 实测（2026-11-20，实例 0.2.22）里 `quota.used` **恒为 0**，真实花费在
//      `usage.total.actual_cost`（同一个 Key：`used:0` 而 `actual_cost:0.0514`）。把 `quota.used`
//      当「已用」→ 界面永远显示「一分钱没用过」；
//   ② `POST /api/v1/keys` 没有幂等键（`routes/user.go:85,87`）。超时后直接重发 → 同名 Key 多出一把，
//      用户的钱包入口被污染成一片。所以「重试前先 `GET /api/v1/keys?search=<name>`」写在
//      `createKey` 里，而不是指望调用点记得（#484 §4.3）。
//
// 输入：`usage-gateway.json` / `local-usage-gateway-200.json` / `local-keys-list-200.json` 都是实测 200。
// 真实实例没有采到钱包模式（`mode:"unrestricted"`，实测只有 `quota_limited`），该行由真实体
// **删掉 `quota` 键**派生，形状按 #484 §3.3「unrestricted = 订阅组或钱包余额」——行内注明，不假装是实测。
//
// 覆盖：
//   U1 `spent = usage.total.actual_cost`，`quota.used` 不被当已用     U2 没有 `quota` 键的模式 → 不伪造零额度
//   U3 `rate_limits` 键整个不存在 → 空数组（不是 undefined.map 崩）
//   K1 dedupe 默认：搜到同名 → **不发 POST**，直接回那把            K2 `dedupe:false`：显式要第二把才 POST
//   K3 dedupe 的查询本身失败（可重试）→ 报错且**不发 POST**（宁可不创建）
//
//   node --test tests/unit/consume-usage-keys.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { jsonReply, loadFixture, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { getGatewayUsage } = await import('../../src/services/consume/usage.ts')
const { createKey } = await import('../../src/services/consume/keys.ts')

/** 用一份实测 200 体造 http（sk- Key 通道：`/v1/usage` 只认 Authorization 头里的 Key） */
const usageHttp = (body) => {
  const recorder = recordingTransport(jsonReply(200, body))
  return { http: createConsumeHttp({ apiKey: () => 'sk-l0-fixture', transport: recorder.transport }), ...recorder }
}

/** 用「按端点应答」造 keys 通道（JWT） */
const keysHttp = (handler) => {
  const recorder = recordingTransport(handler)
  return { http: createConsumeHttp({ accessToken: () => 'jwt-l0', transport: recorder.transport }), ...recorder }
}

const ROWS = [
  {
    id: 'U1',
    what: '「已用」只取 `usage.total.actual_cost`；实测 `quota.used` 恒 0，不许拿它当已用',
    run: async () => {
      const { body } = loadFixture('usage-gateway.json')
      assert.equal(body.quota.used, 0, '实测：quota.used 不随消耗增长')
      assert.ok(body.usage.total.actual_cost > 0, '同一个 Key 的 actual_cost 非 0 —— 这就是「已用」的真值')

      const scene = usageHttp(body)
      const result = await getGatewayUsage(scene.http)
      assert.equal(result.ok, true)
      assert.equal(result.data.spent, body.usage.total.actual_cost, 'spent 是下发给界面的「已用」')
      assert.notEqual(result.data.spent, result.data.quota.used, '两个字段实测不等：混用会永远显示 0')
      assert.equal(result.data.quota.used, 0, 'quota.used 原样保留（排查用），但**不当已用**')
      assert.equal(result.data.usageTotal.actualCost, result.data.spent)
      assert.equal(result.data.mode, 'quota_limited')
    },
  },
  {
    id: 'U2',
    what: '钱包 / 订阅模式（响应里没有 `quota` 键）→ `quota` 不存在，**不许**伪造 `{limit:0,used:0}`',
    run: async () => {
      const { body } = loadFixture('usage-gateway.json')
      const wallet = { ...body, mode: 'unrestricted', planName: '钱包余额', balance: 12.5 }
      delete wallet.quota

      const scene = usageHttp(wallet)
      const result = await getGatewayUsage(scene.http)
      assert.equal(result.ok, true)
      assert.equal(result.data.mode, 'unrestricted')
      assert.equal(result.data.quota, undefined, '没有 quota 就是没有：伪造会让界面显示「额度 0 / 不限」两种错答案')
      assert.equal(result.data.balance, 12.5, '钱包模式读 balance')
      assert.equal(result.data.spent, body.usage.total.actual_cost, '已用仍然只来自 actual_cost')
      assert.equal(result.data.remaining, body.remaining)
    },
  },
  {
    id: 'U3',
    what: '`rate_limits` 键整个不存在（实测）→ 空数组，不是 undefined；也不是「读取失败」',
    run: async () => {
      const { body } = loadFixture('local-usage-gateway-200.json')
      assert.equal(body.rate_limits, undefined, '该 Key 没配速率限制 → 响应里整键缺失')
      const scene = usageHttp(body)
      const result = await getGatewayUsage(scene.http)
      assert.equal(result.ok, true)
      assert.deepEqual(result.data.rateLimits, [])
      assert.equal(result.data.quota.limit, 1, 'quota.limit 来自创建 Key 时给的 1 USD')
      assert.equal(result.data.spent, 0, '新 Key 没消耗 → actual_cost 0（0 是**真的** 0，不是读不到）')
    },
  },
  {
    id: 'K1',
    what: 'createKey 默认去重：搜到同名 → **不发 POST**，直接把已有那把返回',
    run: async () => {
      const { body } = loadFixture('local-keys-list-200.json')
      const scene = keysHttp((request) =>
        pathOf(request.url).startsWith('/api/v1/keys?') ? panelOk(body.data) : jsonReply(500, { code: 500, message: '不该走到这里' })
      )
      const result = await createKey(scene.http, { name: 'qa-fixture-key', quota: 5 })
      assert.deepEqual(scene.sequence(), ['GET /api/v1/keys'], '只查一次，不发 POST')
      assert.match(scene.calls[0].url, /search=qa-fixture-key/, '查询必须按 name 搜（不是拉全表再本地猜）')
      assert.equal(result.ok, true)
      assert.equal(result.data.name, 'qa-fixture-key')
      assert.equal(result.data.id, 1, '返回的是**已有的**那把，不是新建的')
    },
  },
  {
    id: 'K2',
    what: '`dedupe:false`（确实要第二把同名 Key）：跳过查询直接 POST，且请求体里没有 `key` 字段',
    run: async () => {
      const scene = keysHttp(() => panelOk({ id: 9, name: 'qa-dup-key', key: 'sk-l0-created', status: 'active', quota: 5, quota_used: 0 }, 201))
      const result = await createKey(scene.http, { name: 'qa-dup-key', quota: 5 }, { dedupe: false })
      assert.deepEqual(scene.sequence(), ['POST /api/v1/keys'], '显式选择：不查、直接建')
      const sent = JSON.parse(scene.calls[0].body)
      assert.deepEqual(Object.keys(sent).sort(), ['name', 'quota'], '只发明文参数；不存在 `key` 字段（Key 值由服务端生成）')
      assert.equal(result.ok, true)
      assert.equal(result.data.key, 'sk-l0-created', 'Key 明文只在创建响应里出现一次')
    },
  },
  {
    id: 'K3',
    what: '去重查询本身失败（5xx，可重试）→ 报错且**不发 POST**：查不到 ≠ 确认不存在',
    run: async () => {
      const scene = keysHttp(() => jsonReply(500, { code: 500, message: 'db down' }))
      const result = await createKey(scene.http, { name: 'qa-fixture-key' })
      assert.deepEqual(scene.sequence(), ['GET /api/v1/keys'], '查询失败就不许再 POST（那正是重复创建的来源）')
      assert.equal(result.ok, false)
      assert.equal(result.error.retryable, true, '可重试的是这条**只读**查询，不是创建')
      assert.equal(result.error.kind, 'server')
      assert.equal(result.error.i18nKey, 'consumeErrServerUnavailable')
    },
  },
]

test('L0 usage 字段 + keys 创建去重', tableTest('consume-usage-keys', ROWS, async (row) => row.run()))
