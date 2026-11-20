// [layer: unit | 依赖: 无（纯 Node，实测响应体 + 假 transport + 存储探针，零网络） | 耗时: <0.2s]
//
// C12 —— 余额 / 额度**只来自后端**（对外契约；#487 阶段③，对应 #484 §4.5 第 10 条 / §七 第 6 条）
//
// 契约原文只有三句，但每句都被一次真实事故验证过：
//   ① 额度只有一个来源：sk- 通道 `GET /v1/usage`，JWT 通道 `GET /api/v1/user/profile`。
//      读不到就是「查不到」，**不是 0**（把兜底改成 0 → 界面显示「你好穷/你无限」两种假答案）。
//   ② 「已用」只取 `usage.total.actual_cost`。实测里 `quota.used` **恒为 0**（同一个 Key
//      `used:0` 而 `actual_cost:0.0514`），拿它当已用等于永远显示「一分钱没用过」。
//   ③ 客户端**不写**任何余额 / 额度持久化，也不存在「本地账本 → 判断能不能发送」这条路径。
//
// ②的机械证据（`pnpm check:refactor-direction` 的 A4：`remaining_points` / `pointsCache` 零命中）
// 由门禁提供；本文件只断言**行为**（调用方真的读不到第二份真值），两边不重复。
//
// 负向验证（本单实测）：把 `toGatewayUsage` 的 `spent` 改成 `num(quota.used)` → Z2 红；
// 把 `call()` 失败分支改成返回 `data: {}`（或让 `getGatewayUsage` 兜 `spent: 0`）→ Z1 红；
// 在读路径里加一次 `localStorage.setItem('balance', …)` → Z3 红。
//
//   node --test tests/unit/contract-c12-balance-from-backend.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { jsonReply, loadFixture, panelOk, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { getGatewayUsage, listUsage } = await import('../../src/services/consume/usage.ts')
const { getProfile } = await import('../../src/services/consume/auth.ts')
const { listKeys } = await import('../../src/services/consume/keys.ts')

/** 记忆型存储探针：任何写入都会被记下来（`0 次写入` 才是契约要的结果） */
const storageProbe = () => {
  const writes = []
  const make = (label) => ({
    getItem: () => null,
    setItem: (key) => writes.push(`${label}.setItem(${key})`),
    removeItem: (key) => writes.push(`${label}.removeItem(${key})`),
    clear: () => writes.push(`${label}.clear()`),
    key: () => null,
    get length() {
      return 0
    },
  })
  return { writes, localStorage: make('localStorage'), sessionStorage: make('sessionStorage') }
}

const ROWS = [
  {
    id: 'Z1',
    what: '读不到额度 → 结论是「查不到」（`ok:false` + 归一化错误），**不许**兜成 0',
    run: async () => {
      const gateway = recordingTransport(jsonReply(503, { code: 503, message: 'usage unavailable' }))
      const gatewayHttp = createConsumeHttp({ apiKey: () => 'sk-c12', transport: gateway.transport })
      const usage = await getGatewayUsage(gatewayHttp)
      assert.equal(usage.ok, false)
      assert.equal(usage.data, undefined, '失败时不许给 data（给 {} 或 spent:0 就等于告诉界面「余额是 0」）')
      assert.equal(usage.error.kind, 'server')
      assert.equal(usage.error.i18nKey, 'consumeErrServerUnavailable')

      const panel = recordingTransport(jsonReply(500, { code: 500, message: 'profile unavailable' }))
      const panelHttp = createConsumeHttp({ accessToken: () => 'jwt-c12', transport: panel.transport })
      for (const call of [() => getProfile(panelHttp), () => listUsage(panelHttp)]) {
        const result = await call()
        assert.equal(result.ok, false, '面板通道失败同样是「查不到」')
        assert.equal(result.data, undefined)
      }
    },
  },
  {
    id: 'Z2',
    what: '「已用」只取 `usage.total.actual_cost`：实测 `quota.used` 恒 0，不许拿它当已用',
    run: async () => {
      const { body } = loadFixture('usage-gateway.json')
      assert.equal(body.quota.used, 0, '实测：quota.used 不随消耗增长')
      assert.ok(body.usage.total.actual_cost > 0)

      const recorder = recordingTransport(jsonReply(200, body))
      const http = createConsumeHttp({ apiKey: () => 'sk-c12', transport: recorder.transport })
      const result = await getGatewayUsage(http)
      assert.equal(result.ok, true)
      assert.equal(result.data.spent, body.usage.total.actual_cost, 'spent = actual_cost（这是「已用」的唯一来源）')
      assert.ok(result.data.spent > 0, '真实花费 > 0：显示「已用 0」就是读错了字段')
      assert.notEqual(result.data.spent, result.data.quota.used, 'quota.used 原样保留但绝不当已用')
      assert.equal(result.data.usageTotal.actualCost, result.data.spent)
    },
  },
  {
    id: 'Z3',
    what: '没有本地账本：整个读路径**零存储写入**，源码里也没有第二份真值（额度只在响应里）',
    run: async () => {
      const { body: gatewayBody } = loadFixture('usage-gateway.json')
      const { body: profileBody } = loadFixture('local-user-profile-200.json')
      const { body: keysBody } = loadFixture('local-keys-list-200.json')

      const probe = storageProbe()
      const saved = { local: globalThis.localStorage, session: globalThis.sessionStorage }
      globalThis.localStorage = probe.localStorage
      globalThis.sessionStorage = probe.sessionStorage
      try {
        const recorder = recordingTransport((request) => {
          const p = request.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
          if (p === '/v1/usage') {return jsonReply(200, gatewayBody)}
          if (p === '/api/v1/user/profile') {return panelOk(profileBody.data)}
          if (p === '/api/v1/keys') {return panelOk(keysBody.data)}
          throw new Error(`没有预期的端点被打到：${p}`)
        })
        const http = createConsumeHttp({ accessToken: () => 'jwt-c12', apiKey: () => 'sk-c12', transport: recorder.transport })
        const usage = await getGatewayUsage(http)
        const profile = await getProfile(http)
        const keys = await listKeys(http)
        assert.equal(usage.ok, true)
        assert.equal(profile.ok, true)
        assert.equal(keys.ok, true)
        // 面板通道的余额也是「服务端给什么就是什么」：不推导、不缓存
        assert.equal(profile.data.balance, profileBody.data.balance, 'profile.balance 原样透传（后端是唯一真值）')
        assert.notEqual(
          profile.data.balance,
          usage.data.remaining,
          '两条通道各读各的：客户端不会拿 sk- 通道的 remaining 去凑 profile 的 balance'
        )
      } finally {
        globalThis.localStorage = saved.local
        globalThis.sessionStorage = saved.session
      }
      assert.deepEqual(probe.writes, [], '读额度不许落任何本地存储（本地账本回来的第一信号）')

      // 源码级：这一层不许出现存储 API，也不许出现旧链路的账本字段
      const dir = path.join(ROOT, 'src/services/consume')
      for (const name of readdirSync(dir).filter((item) => item.endsWith('.ts'))) {
        const code = readFileSync(path.join(dir, name), 'utf8')
        assert.equal(
          /(?:localStorage|sessionStorage|indexedDB)\s*[.[(]/.test(code),
          false,
          `${name} 引用了本地存储：余额的第二份真值就是这么长出来的`
        )
        for (const banned of ['remaining_points', 'pointsCache', 'balanceCache', 'localLedger']) {
          assert.equal(code.includes(banned), false, `${name} 出现旧链路账本字段 ${banned}`)
        }
      }
    },
  },
]

test('C12 余额只来自后端：查不到就是查不到，没有第二份真值', tableTest('C12', ROWS, async (row) => row.run()))
