// [layer: unit | 依赖: 无（纯 Node，假 transport + 配置注入，零网络） | 耗时: <0.2s]
//
// C13 —— base / 超时**只能来自配置**（对外契约；#487 阶段③，对应 #484 §6.1/6.2/6.3）
//
// 契约只有三句：
//   ① 消费侧 base 与两套前缀只来自构建期注入的 `__ENDPOINTS__.consume`（唯一来源
//      `config/endpoints.json` 的 `consume` 段）。换一份注入 → 请求 URL 前缀跟着换；
//   ② 注入缺失 / 字段为空 → **fail-fast 抛错并点名缺哪个键**；绝不静默回落到 `pay`、
//      回落到空串、或回落到某个「默认地址」（错地址跑起来比启动失败贵得多）；
//   ③ 超时三档（read / write / redeem）也只能来自配置：调用点不许写死毫秒数。
//
// 机械证据（`src/` 零域名 / 零 IP）由 `scripts/check-refactor-direction.mjs` 的 A6 提供；
// 本文件补的是**行为**：注入变 → 请求变，注入缺 → 抛错，外加一条源码级「没有硬编码毫秒」。
//
// 负向验证（本单实测）：把 `createConsumeHttp` 的 `endpoints.baseUrl` 换成字面量 → V1 红；
// 删掉 `readConsumeEndpoints` 的 `if (!consume) throw` → V2 红（变成读到 undefined 后静默跑）；
// 把 `endpoints.timeoutMs[class]` 写死成 10000 → V3 红。
//
//   node --test tests/unit/contract-c13-base-from-config.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installResolveHooks, readJson, tableTest } from '../helpers/contract.mjs'
import { jsonReply, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { ConsumeConfigError, createConsumeHttp, readConsumeEndpoints } = await import('../../src/services/consume/http.ts')

/** `config/endpoints.json` 里的两组地址（本文件所有断言的比对基准） */
const CONFIG = readJson('config/endpoints.json')

/** 造一套注入端点（测试用假地址，形状与 `__ENDPOINTS__.consume` 一致） */
const endpointsOf = (baseUrl, timeouts = CONFIG.consume.timeoutMs) => ({
  baseUrl,
  apiV1Prefix: CONFIG.consume.apiV1Prefix,
  gatewayPrefix: CONFIG.consume.gatewayPrefix,
  timeoutMs: timeouts,
})

const ROWS = [
  {
    id: 'V1',
    what: 'base 来自注入：换一份注入 → 请求前缀跟着换；不注入时读到的是 `config/endpoints.json` 的 consume 段',
    run: async () => {
      assert.equal(typeof CONFIG.consume?.baseUrl, 'string', 'config 里必须有 consume 段（#484 §6.1）')
      assert.equal(typeof CONFIG.pay?.baseUrl, 'string', 'pay 段也要在（两组齐备，不许只剩一组）')

      const fromConfig = readConsumeEndpoints()
      assert.equal(fromConfig.baseUrl, CONFIG.consume.baseUrl.replace(/\/+$/, ''), '默认来源就是配置文件')
      assert.equal(fromConfig.apiV1Prefix, CONFIG.consume.apiV1Prefix)
      assert.equal(fromConfig.gatewayPrefix, CONFIG.consume.gatewayPrefix)

      for (const base of ['https://consume-a.example', 'https://consume-b.example']) {
        const recorder = recordingTransport(jsonReply(200, {}))
        const http = createConsumeHttp({ endpoints: endpointsOf(base), transport: recorder.transport })
        await http.request({ method: 'GET', path: '/v1/usage' })
        await http.request({ method: 'GET', path: `${CONFIG.consume.apiV1Prefix}/user/profile` })
        assert.equal(recorder.calls[0].url, `${base}/v1/usage`, '网关通道的 URL 前缀必须跟着注入变（写死就红）')
        assert.equal(recorder.calls[1].url, `${base}${CONFIG.consume.apiV1Prefix}/user/profile`)
        assert.equal(http.endpoints.baseUrl, base)
      }
    },
  },
  {
    id: 'V2',
    what: '注入缺失 / 字段为空 / 明文 http → **fail-fast 抛 `ConsumeConfigError` 并点名缺哪个键**，不回落',
    run: () => {
      const saved = globalThis.__ENDPOINTS__
      const configError = (fn) => {
        try {
          fn()
        } catch (error) {
          return error
        }
        return null
      }
      try {
        globalThis.__ENDPOINTS__ = { pay: saved?.pay }
        const missingAll = configError(() => readConsumeEndpoints())
        assert.ok(missingAll, '没有 consume 段时必须抛错，不许静默跑')
        assert.equal(missingAll.name, 'ConsumeConfigError')
        assert.ok(missingAll instanceof ConsumeConfigError)
        assert.deepEqual(missingAll.missing, ['consume'], '报错要点名缺的是 consume（不是含糊的「配置错误」）')

        globalThis.__ENDPOINTS__ = { ...saved, consume: { ...saved.consume, baseUrl: '' } }
        const emptyBase = configError(() => readConsumeEndpoints())
        assert.ok(emptyBase, 'baseUrl 为空同样抛错')
        assert.ok(emptyBase.missing.includes('consume.baseUrl'), '空字段要单独点名')

        globalThis.__ENDPOINTS__ = { ...saved, consume: { ...saved.consume, baseUrl: 'http://consume.example.com' } }
        const plaintext = configError(() => readConsumeEndpoints())
        assert.ok(plaintext, '非回环的明文 http 一律拒绝（#484 §6.3）')
        assert.ok(plaintext.missing.includes('consume.baseUrl'))

        globalThis.__ENDPOINTS__ = saved
        assert.equal(readConsumeEndpoints().baseUrl, CONFIG.consume.baseUrl.replace(/\/+$/, ''), '还原后照旧从配置读')
      } finally {
        globalThis.__ENDPOINTS__ = saved
      }
    },
  },
  {
    id: 'V3',
    what: '超时三档只来自配置：注入什么就是什么；源码里没有硬编码毫秒数、没有 base 字面量',
    run: async () => {
      const injected = { read: 1111, write: 2222, redeem: 3333 }
      const recorder = recordingTransport(jsonReply(200, {}))
      const http = createConsumeHttp({ endpoints: endpointsOf('https://consume-timeouts.example', injected), transport: recorder.transport })
      await http.request({ method: 'GET', path: '/v1/usage' })
      await http.request({ method: 'POST', path: '/api/v1/keys', body: { name: 'x' } })
      await http.request({ method: 'POST', path: '/api/v1/redeem', body: { code: 'X' }, timeout: 'redeem' })
      assert.deepEqual(
        recorder.calls.map((request) => request.timeoutMs),
        [injected.read, injected.write, injected.redeem],
        'GET 走 read / 写接口走 write / 兑换走 redeem —— 三档都必须是注入值'
      )

      const dir = path.join(ROOT, 'src/services/consume')
      const timeouts = Object.values(CONFIG.consume.timeoutMs)
      for (const name of readdirSync(dir).filter((item) => item.endsWith('.ts'))) {
        const code = readFileSync(path.join(dir, name), 'utf8')
        for (const value of timeouts) {
          assert.equal(code.includes(String(value)), false, `${name} 出现硬编码毫秒数 ${value}（超时只能来自配置）`)
        }
        assert.equal(code.includes(CONFIG.consume.baseUrl), false, `${name} 出现 base 字面量 ${CONFIG.consume.baseUrl}（地址只能来自配置）`)
        assert.equal(/timeoutMs\s*[:=]\s*\d/.test(code), false, `${name} 有 timeoutMs 字面量赋值`)
      }
    },
  },
]

test('C13 base/超时只能来自配置：注入变就变，注入缺就抛', tableTest('C13', ROWS, async (row) => row.run()))
