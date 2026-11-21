// [layer: golden | 依赖: tools/mock-sub2api（自起，端口 0）+ playwright（仅复用 golden 装配） | 预算: 每条 ≤60s]
//
// 黄金回归 · 域「账户与消费」（Issue #487 阶段③；替代已随 W1-D 删掉的 `g07-quota-purchase`）：
//   ① **登录 → 读到余额 → 兑换卡密 → 余额变化**（`MOCK-OK-0001`）；
//   ② **冷启动恢复 → 续期换新 token → 仍能读到余额**（身份层的启动主路径）。
//
// 为什么这一条打的是**真 HTTP + 真客户端代码**，而不是「dist + 浏览器点按钮」：
// 四个面板此刻还没有外壳（页面归 W1-C1，`src/main.tsx` 也还没挂 `AuthGate`），dist 里根本
// 没有能点到的登录/兑换入口。黄金层的判据是「主路径别断」，那就把**链路**端到端跑通：
// 真 `createConsumeClient` + 真 `createAuthTransport` + 真 `store`，对面是契约 mock（信封、扁平平
// `/v1/usage`、`409` 全是真形状）。等页面外壳合并后，这条用例只需把「调客户端」换成「点按钮」，
// 断言与步骤名可以原样留下。
//
// 硬约束（本单「不连真实实例」）：
//   · 端点**显式注入**为本次自起的 mock（`MOCK_SUB2API_PORT=0`，内核分配端口），
//     不读 `__ENDPOINTS__`（那份默认值指向 127.0.0.1:18000 的真实例）；
//   · 每次请求都记 URL，结尾断言全部落在 mock 上 —— 谁把 base 写回默认值，这条当场红。
//
// 跑法（仓库根目录）：
//   node --test tests/golden/g12-consume.test.mjs      # 单跑（本文件自己起 mock）
//   node tests/run-golden.mjs --only g12               # 走黄金 runner（并行 + 耗时 + 一句话失败）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { createEgressGuard, runGolden, brief } from '../helpers/golden.mjs'
import { installEndpointsGlobals, installTsResolve, setupDom } from '../helpers/dom-env.mjs'
import { consumeApiV1Prefix, consumeGatewayPrefix, consumeTimeouts } from '../../scripts/lib/endpoints.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** mock 启动时就有的种子 Key（`/v1/usage` 开箱可用，见 tools/mock-sub2api/README.md §4） */
const SEEDED_API_KEY = `sk-${'c0ffee'.repeat(10)}c0ff`
/** mock 的可用卡密（+10 USD） */
const GOOD_CODE = 'MOCK-OK-0001'
/** 真实实例的端口：任何请求打到这里都算「测试连了真服务」= 红 */
const REAL_INSTANCE_PORT = 18000

installTsResolve()
setupDom()
installEndpointsGlobals()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { createAuthTransport } = await import('../../src/services/auth/transport.ts')
const { getAccessToken, setAuthTokenStorage, setAuthTransport, useAuthStore, getAuthSnapshot } = await import(
  '../../src/services/auth/store.ts'
)

/**
 * 起一个契约 mock（端口 0 = 内核分配），返回 base 与停止函数。
 *
 * 端口被占也不怕：内核分配不会撞车；**也不读 `MOCK_SUB2API_PORT` 的默认 18080** ——
 * 那台可能正被别的排查占着，用别人进程跑出来的绿是最坏的一种绿。
 */
const startMock = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools/mock-sub2api/server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, MOCK_SUB2API_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`mock 10s 内没起来：${brief(buffer)}`))
    }, 10_000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(buffer)
      if (!match) {
        return
      }
      clearTimeout(timer)
      resolve({ base: match[1], stop: () => child.kill('SIGTERM') })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => {
      buffer += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock 提前退出（code=${code}）：${brief(buffer)}`))
    })
  })

/**
 * 真 HTTP transport（只给测试用）：`ConsumeTransport` 的形状是
 * `{kind:'response'|'timeout'|'network'|'unsupported'}`，这里用 Node 的 fetch 实现。
 *
 * 同时记下每次请求的 URL —— 结尾那条「一条都没打到真实例」的断言就靠它；并且每发一次都交给
 * 出站总闸（`createEgressGuard`，#667 跟进）记 host —— 这条用例没有浏览器、没有 `page.route`，
 * 但「host 必须在白名单里」这件事一样要机械判。
 */
const createNodeTransport = (egress) => {
  const urls = []
  const transport = async ({ method, url, headers, body, timeoutMs }) => {
    urls.push(`${method} ${url}`)
    egress.note(method, url)
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return {
        kind: 'response',
        status: response.status,
        text: await response.text(),
        headers: Object.fromEntries([...response.headers.entries()]),
      }
    } catch (error) {
      const name = error?.name ?? ''
      return { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
    }
  }
  return { transport, urls }
}

/** 内存凭据存储（与 L1 同一个口子：`setAuthTokenStorage` 就是为此留的） */
const createTokenStorage = () => {
  const box = { value: null, writes: [] }
  return {
    get value() {
      return box.value
    },
    get parsed() {
      return box.value === null ? null : JSON.parse(box.value)
    },
    get writes() {
      return box.writes
    },
    storage: {
      read: () => box.value,
      write: (value) => {
        box.writes.push(value)
        box.value = value
      },
    },
    seed: (token, user = null) => {
      box.writes.length = 0
      box.value = JSON.stringify({ v: 1, token, user })
    },
    reset: () => {
      box.value = null
      box.writes.length = 0
    },
  }
}

/** 装配「真客户端 + 真身份层」，端点显式指向 mock */
const wire = ({ base }, egress) => {
  const { transport, urls } = createNodeTransport(egress)
  const consume = createConsumeClient({
    transport,
    endpoints: {
      baseUrl: base,
      apiV1Prefix: consumeApiV1Prefix,
      gatewayPrefix: consumeGatewayPrefix,
      timeoutMs: consumeTimeouts,
    },
    // JWT 每次现取：续期之后立刻生效（与 src/main.tsx 的接线一致）
    accessToken: getAccessToken,
    // 网关 `/v1/**` 只认 sk- Key
    apiKey: () => SEEDED_API_KEY,
  })
  setAuthTransport(createAuthTransport(consume))
  return { consume, urls }
}

/** 每条都用同一个起点：干净 store + 干净凭据存储 */
const resetState = (storage) => {
  storage.reset()
  setAuthTokenStorage(storage.storage)
  useAuthStore.setState({
    state: 'unauthenticated',
    user: null,
    token: null,
    error: null,
    restored: false,
    submitting: false,
    sendingCode: false,
  })
}

/** 请求 URL 里不许出现真实例端口（本单硬要求：不连 127.0.0.1:18000） */
const assertOnlyMock = (urls, base) => {
  for (const entry of urls) {
    assert.equal(entry.includes(`:${REAL_INSTANCE_PORT}`), false, `打到了真实实例：${entry}`)
    assert.equal(entry.includes(base), true, `请求没落在本次 mock 上：${entry}`)
  }
}

test('G12 账户与消费：登录 → 读到余额 → 兑换卡密 → 余额变化', async () => {
  const mock = await startMock()
  try {
    const storage = createTokenStorage()
    const result = await runGolden(
      { id: 'G12', domain: '账户与消费', title: '登录 → 读到余额 → 兑换卡密 → 余额变化' },
      async (ctx) => {
        resetState(storage)
        // 出站总闸（#667 跟进）：只放行本次自起的 mock（host 精确匹配）
        const egress = createEgressGuard({ allowHosts: [new URL(mock.base).host], label: 'G12 consume' })
        const { consume, urls } = wire(mock, egress)

        // ── 1. 启动读开关：入口显隐的唯一来源 ────────────────────────────────
        ctx.begin('读 settings/public')
        const settings = await consume.settings.get()
        if (!settings.ok) {
          ctx.abort('开关读得到', 'ok:true', `${settings.error.code} ${settings.error.message}`)
        }
        ctx.expect('注册开关来自服务端（mock 全开）', settings.data.registrationEnabled === true, {
          expected: 'registrationEnabled=true',
          actual: String(settings.data.registrationEnabled),
        })

        // ── 2. 登录：token 进凭据存储、放行主界面 ─────────────────────────────
        ctx.begin('登录')
        const signed = await useAuthStore.getState().signIn({ email: 'ui@mock.local', password: 'mock-password' })
        if (!signed.ok) {
          ctx.abort('登录成功', 'ok:true', `${signed.error.code} ${signed.error.messageKey}`)
        }
        ctx.expect('登录后 token 落盘', storage.parsed?.token?.accessToken === getAuthSnapshot().token.accessToken, {
          expected: '落盘 token == 内存 token',
          actual: storage.parsed === null ? '（没落盘）' : '不一致',
        })
        ctx.expect('登录后放行主界面（state=authenticated）', getAuthSnapshot().state === 'authenticated', {
          expected: 'authenticated',
          actual: getAuthSnapshot().state,
        })

        // ── 3. 读到余额（钱包余额，单位元）─────────────────────────────────────
        ctx.begin('读余额')
        const before = await consume.auth.profile()
        if (!before.ok) {
          ctx.abort('余额读得到', 'ok:true', `${before.error.code} ${before.error.i18nKey}`)
        }
        const initialBalance = before.data.balance
        ctx.expect('余额是服务端给的数字（不是客户端默认 0）', typeof initialBalance === 'number', {
          expected: 'number',
          actual: String(initialBalance),
        })

        // ── 4. 兑换卡密 → 余额变化 ────────────────────────────────────────────
        ctx.begin('兑换卡密')
        const outcome = await consume.redeem.redeem({ code: GOOD_CODE })
        if (outcome.kind !== 'redeemed') {
          ctx.abort('兑换成功', 'kind=redeemed', `${outcome.kind}${outcome.error ? `/${outcome.error.code}` : ''}`)
        }
        ctx.expect('兑换结论是「已到账」（不是「待确认」）', outcome.kind === 'redeemed' && outcome.credited === 'response', {
          expected: 'credited=response',
          actual: `${outcome.kind}/${outcome.credited}`,
        })

        const after = await consume.auth.profile()
        if (!after.ok) {
          ctx.abort('兑换后再读余额', 'ok:true', `${after.error.code}`)
        }
        ctx.expect('余额真的变了（+10）', after.data.balance === initialBalance + 10, {
          expected: `${initialBalance + 10}`,
          actual: String(after.data.balance),
        })
        ctx.expect('客户端不自己算余额：展示值等于服务端回包', outcome.result.newBalance === after.data.balance, {
          expected: String(after.data.balance),
          actual: String(outcome.result.newBalance),
        })

        // ── 5. 额度通道（面板「我的额度」那条路）也通 ──────────────────────────
        ctx.begin('读 /v1/usage')
        const usage = await consume.usage.gateway()
        ctx.expect('sk- Key 通道读得到额度', usage.ok === true, {
          expected: 'ok:true',
          actual: usage.ok ? 'ok' : `${usage.error.code}/${usage.error.i18nKey}`,
        })
        ctx.expect('额度三件套里至少有一个数字', usage.ok && typeof (usage.data.remaining ?? usage.data.balance) === 'number', {
          expected: 'remaining/balance 是数字',
          actual: usage.ok ? JSON.stringify(usage.data.quota ?? null) : '（没读到）',
        })

        // ── 6. 全程只打本次 mock（不连真实例）──────────────────────────────────
        ctx.begin('端点守卫')
        const guarded = (() => {
          try {
            assertOnlyMock(urls, mock.base)
            return null
          } catch (error) {
            return error.message
          }
        })()
        ctx.expect('所有请求都落在本次 mock 上', guarded === null, {
          expected: `全部以 ${mock.base} 开头`,
          actual: guarded ?? brief(urls.join(' | '), 200),
        })
        // 共享总闸：出站 host ⊆ 白名单（未登记的请求会被点名成 `METHOD host+path`）
        egress.assertNoLeak(ctx)
      }
    )
    // runGolden 只记失败、不抛：这里抬成 node:test 的失败（`node --test` 单跑也才算真红）
    assert.equal(result.status, 'PASS', result.failures.join(' | '))
  } finally {
    mock.stop()
  }
})

test('G12b 身份恢复：冷启动过期 → 续期换新 token → 仍能读到余额', async () => {
  const mock = await startMock()
  try {
    const storage = createTokenStorage()
    const result = await runGolden(
      { id: 'G12b', domain: '账户与消费', title: '冷启动恢复 → 续期 → 再读余额' },
      async (ctx) => {
        resetState(storage)
        // 出站总闸（#667 跟进）：只放行本次自起的 mock（host 精确匹配）
        const egress = createEgressGuard({ allowHosts: [new URL(mock.base).host], label: 'G12 consume' })
        const { consume, urls } = wire(mock, egress)

        // ── 1. 先真登录一次，拿到一对可续期的 token ───────────────────────────
        ctx.begin('先登录拿 token')
        const signed = await useAuthStore.getState().signIn({ email: 'restore@mock.local', password: 'mock-password' })
        if (!signed.ok) {
          ctx.abort('登录成功', 'ok:true', `${signed.error.code}`)
        }
        const firstToken = getAuthSnapshot().token
        ctx.expect('拿到 refresh_token', typeof firstToken.refreshToken === 'string', {
          expected: '有 refresh_token',
          actual: String(firstToken.refreshToken),
        })

        // ── 2. 模拟「上次启动留下的、已经过期的」凭据，再走一次冷启动 ──────────
        ctx.begin('冷启动恢复')
        storage.seed({ ...firstToken, expiresAt: Date.now() - 60_000 }, getAuthSnapshot().user)
        useAuthStore.setState({ state: 'unauthenticated', token: null, user: null, error: null, restored: false })
        await useAuthStore.getState().restore()

        const snapshot = getAuthSnapshot()
        if (snapshot.state !== 'authenticated') {
          ctx.abort('续期后放行', 'authenticated', `${snapshot.state}/${snapshot.error?.messageKey ?? ''}`)
        }
        ctx.expect('过期 token 续上了（换了一颗新的）', snapshot.token.accessToken !== firstToken.accessToken, {
          expected: '新 access_token',
          actual: '还是旧的那颗',
        })
        ctx.expect('新 token 落盘（下次启动直接用）', storage.parsed?.token?.accessToken === snapshot.token.accessToken, {
          expected: '落盘 == 内存',
          actual: storage.parsed === null ? '（没落盘）' : '不一致',
        })
        ctx.expect(
          '续期只发一次（不静默重试）',
          urls.filter((entry) => entry.includes('/api/v1/auth/refresh')).length === 1,
          {
            expected: '1 次',
            actual: `${urls.filter((entry) => entry.includes('/api/v1/auth/refresh')).length} 次`,
          }
        )

        // ── 3. 新 token 能继续读余额（身份层与消费层共用同一颗 token）───────────
        ctx.begin('续期后读余额')
        const profile = await consume.auth.profile()
        ctx.expect('续期后仍读得到余额', profile.ok === true, {
          expected: 'ok:true',
          actual: profile.ok ? 'ok' : `${profile.error.code}/${profile.error.i18nKey}`,
        })
        ctx.begin('端点守卫')
        const guarded = (() => {
          try {
            assertOnlyMock(urls, mock.base)
            return null
          } catch (error) {
            return error.message
          }
        })()
        ctx.expect('所有请求都落在本次 mock 上', guarded === null, {
          expected: `全部以 ${mock.base} 开头`,
          actual: guarded ?? brief(urls.join(' | '), 200),
        })
        // 共享总闸：出站 host ⊆ 白名单（未登记的请求会被点名成 `METHOD host+path`）
        egress.assertNoLeak(ctx)
      }
    )
    assert.equal(result.status, 'PASS', result.failures.join(' | '))
  } finally {
    mock.stop()
  }
})
