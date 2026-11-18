// [layer: regression | 依赖: 无（纯 Node，transport / storage 都是假对象） | Issue #135（关联 #115 / #7）]
//
// 回归对象：下单（startCheckout）对 **cid（客户归属）** 的硬约束——src/services/ours/api.ts。
//
// 修复前症状（#135 / #115）：没有 cid 也照样 GET /buy，服务端按匿名建单，
//   用户付完钱 App 查不到自己的单（"付了钱还显示等待支付"），甚至把单建到别人名下。
// 修复后预期：拿不到 cid 就**一次请求都不发**，直接返回 CUSTOMER_ID_MISSING；
//   缓存里的脏值（'' / '0' / 负数 / 非数字）不能被当成有效 cid；有 cid 时 URL 必须带 &cid=。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

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

const { startCheckout, OURS_API_BASE } = await import('../../src/services/ours/api.ts')
const { CUSTOMER_ID_STORAGE_KEY, resetCustomerIdCache, setCustomerIdProvider } = await import(
  '../../src/services/ours/customerId.ts'
)

/** 内存 storage 替身（只实现 api.ts 用到的三件事）。 */
const memoryStorage = (seed) => {
  const map = new Map()
  if (seed !== undefined) map.set(CUSTOMER_ID_STORAGE_KEY, seed)
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

const recordingTransport = (response) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return response
  }
  return { calls, transport }
}

const ready = () => {
  resetCustomerIdCache()
  // provider 交回 null = 「服务端也没给出 cid」，避免真去打 /profile
  setCustomerIdProvider(async () => null)
}

const CHECKOUT = {
  kind: 'response',
  status: 302,
  location: 'https://alipay.example.test/cashier?out_trade_no=T1&return_url=' + encodeURIComponent('app://cb?order_token=tok'),
  headers: {},
}

test('#135 显式 null（已知没有 cid）时一次 /buy 都不发', async () => {
  ready()
  const { calls, transport } = recordingTransport(CHECKOUT)
  const result = await startCheckout('p1', transport, { customerId: null, storage: memoryStorage() })
  assert.equal(result.kind, 'error')
  assert.equal(result.code, 'CUSTOMER_ID_MISSING')
  assert.equal(result.messageKey, 'oursErrCustomerNeedsKey')
  assert.equal(calls.length, 0, '没有 cid 的下单会把单建到别人名下，一次都不能发')
})

test('#135 显式传进来的 0 / 负数 / NaN 也不算 cid，同样不发请求', async () => {
  for (const invalid of [0, -3, Number.NaN]) {
    ready()
    const { calls, transport } = recordingTransport(CHECKOUT)
    const result = await startCheckout('p1', transport, { customerId: invalid, storage: memoryStorage() })
    assert.equal(result.kind, 'error', `显式传入 ${String(invalid)} 不该被当成有效 cid`)
    assert.equal(result.code, 'CUSTOMER_ID_MISSING')
    assert.equal(calls.length, 0)
  }
})

test('#135 缓存里是脏值时不认（空串 / 0 / 负数 / 非数字），照样不发请求', async () => {
  for (const poisoned of ['', '0', '-3', 'abc', '  ', 'NaN']) {
    ready()
    const { calls, transport } = recordingTransport(CHECKOUT)
    const result = await startCheckout('p1', transport, { storage: memoryStorage(poisoned) })
    assert.equal(result.kind, 'error', `缓存值 ${JSON.stringify(poisoned)} 不该被当成有效 cid`)
    assert.equal(result.code, 'CUSTOMER_ID_MISSING')
    assert.equal(calls.length, 0)
  }
})

test('#135 缓存里有合法 cid 时下单 URL 必须带 &cid=', async () => {
  ready()
  const { calls, transport } = recordingTransport(CHECKOUT)
  await startCheckout('p1', transport, { storage: memoryStorage('42') })
  assert.equal(calls.length, 1, '有 cid 时正常下一单（且只一单）')
  assert.equal(calls[0].url, `${OURS_API_BASE}/buy?plan=p1&cid=42`)
  assert.equal(calls[0].followRedirects, false, '302 要自己读 Location，不能让原生桥跟随')
})

test('#135 显式传入 cid 时同样拼进 URL（provider 不参与）', async () => {
  ready()
  setCustomerIdProvider(async () => 999)
  const { calls, transport } = recordingTransport(CHECKOUT)
  await startCheckout('p1', transport, { customerId: 7, storage: memoryStorage() })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /[?&]cid=7(&|$)/)
})

test('#135 空 plan 走 PLAN_MISSING，不会拿 cid 去掩盖参数错误', async () => {
  ready()
  const { calls, transport } = recordingTransport(CHECKOUT)
  const result = await startCheckout('   ', transport, { customerId: 7, storage: memoryStorage() })
  assert.equal(result.kind, 'error')
  assert.equal(result.code, 'PLAN_MISSING')
  assert.equal(calls.length, 0)
})
