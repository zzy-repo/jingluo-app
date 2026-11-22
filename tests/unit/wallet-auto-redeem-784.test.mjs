// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + 可编程假 transport，零浏览器、零真实网络） | 耗时: <1s]
//
// Issue #784 ——「付款回来 → 自动把卡密兑进账号余额」的**仓库内单测**。
//
// 为什么补这一份：`grep -rln "walletAutoRedeem" tests/` 在本文件之前是**空的** ——
// 这条链路上跑的是钱（`POST /api/v1/redeem` 服务端没有 request_id 之类的重放保护），实现里每一条取舍（只在该触发点触发 /
// 数据源只能是 `/api/orders` / 本地按单去重 / 打码卡不兑 / 处理中不算失败 / 绝不自动第二枪 /
// 成功才刷余额 / 未登录零请求）此前**一条断言都没有**，任何改动都能悄悄把它弄坏而不被发现。
//
// 被测对象（不重写一行兑换逻辑，本文件也不重写）：
//   · `src/components/consume/walletAutoRedeem.ts`（纯逻辑，裸 Node 可 import）；
//   · 接线点 `AccountConsumePage.tsx` 的 `backToCards`（`.tsx` 裸 Node import 不了 → 读源码断言）；
//   · 它复用的 `services/consume/redeem.ts` / `myCardsModel.ts:afterRedeemed()` —— 这里**不**替身掉，
//     而是给真客户端塞一个可编程假 transport：断言的端点（`POST /api/v1/redeem`、`GET /user/profile`）
//     与请求体都是**真发出来的那一份**，不是平行真理。
//
// 覆盖（每条一个 test，编号与票面验收表一致）：
//   ① 唯一触发点：全仓 `src/` 只有 `backToCards` 调 `runWalletAutoRedeem(...)`；
//      挂载 / 进钱包页 / 进卡密页都碰不到（源码接线断言 + 「装载零副作用」逻辑断言双保险）
//   ② 数据源是 `GET /api/orders`：`redeemState:'issued'` 的 `cardNo` 原样进 POST body 的 `code`；
//      `/redeem/history` **一次都不打**（假 transport 对它直接抛错，读了就红）
//   ③ 去重：同一 `orderNo` 第二次「付款回来」→ 0 次 POST；落盘只有指纹 + 尾 4 位，**没有卡密原文**
//   ④ 打码卡密（`*` / `•`）→ 0 次请求，outcome = masked（给手动入口那一种）
//   ⑤ 409 `REDEEM_CODE_LOCKED` → processing：不是失败、不核对 history、不重试
//   ⑥ 超时 / 5xx → 只有一发 POST，outcome = failed；再来一次也不打第二枪
//   ⑦ 成功 → credited（面值 + 重拉来的余额），且 `/user/profile` **在兑换之后**
//   ⑧ 未登录 / 没注入 `loadOrders`（= 没 apiKey）→ 一个请求都不发，未登录 reason = not-signed-in
//
// 负向对照（人工，非本文件；命令与输出见 PR 正文）：
//   ① 去掉 `wasAutoSubmitted()` 那一段判断 → ③ 必须红（第二次也发 POST）；
//   ② 去掉打码跳过（`isPendingOrder` 只在 `*` 判断前后删）→ ④ 必须红（拿打码码去打 POST）。
//
//   node --test tests/unit/wallet-auto-redeem-784.test.mjs
//   node --test --test-reporter=tap --import ./tests/helpers/injected.mjs tests/unit/wallet-auto-redeem-784.test.mjs
//   node tests/run-layer.mjs unit --only wallet-auto-redeem-784
import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, test } from 'node:test'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

// 原生桥（`@capacitor/core`）+ 诊断写入口替身：`http.ts` 顶层挑 transport、`walletAutoRedeem` 会调 `record()`
installChatBridge()
// 构建期注入值（`__ENDPOINTS__`）：`http.ts` 读消费侧地址（下面的假 transport 把网络整段短路）
installEndpointsGlobals()
// localStorage（Node 22 没有这个全局）：自动兑现的去重表落在它上面
const dom = setupDom()

// 诊断写入口替身（`tests/fixtures/chat-stubs/collector.mjs`）把 `record()` 写进这个缓冲
globalThis.__log = { records: [], events: [], actions: [] }

const autoRedeem = await import('../../src/components/consume/walletAutoRedeem.ts')
const { createConsumeClient } = await import('../../src/services/consume/index.ts')

test.after(() => dom.restore())

/** 每个用例从「没记住过任何卡」开始（去重表是进程级 localStorage，隔离靠这里） */
beforeEach(() => {
  autoRedeem.forgetAutoSubmitted()
  globalThis.__log.records.length = 0
})

// ------------------------------------------------------------------ 常量与现场

/** 登录态 JWT（一眼假；只用来断言请求确实带着凭据） */
const JWT = 'jwt-784-not-real'
/** 服务端发的**完整**卡号（真实形态：带分隔符的大写串，尾 4 位是 1234 → 这里用 A3SR 同形状） */
const CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
/** 订单号（`outTradeNo`：去重的第一优先键） */
const ORDER_NO = 'T784-0001-ABCD'

const REDEEM_POST = 'POST /api/v1/redeem'
const HISTORY_GET = 'GET /api/v1/redeem/history'
const PROFILE_GET = 'GET /api/v1/user/profile'

/** 一条订单（只造实现真的会读的字段；`PurchaseOrder` 的其余字段与本节无关） */
const order = (over = {}) => ({
  outTradeNo: ORDER_NO,
  cardNo: CARD,
  redeemState: 'issued',
  paidAt: 1763000000,
  createdAt: 1763000000,
  ...over,
})

/** 兑换成功体（`redeem_handler.go` 的 `{message,type,value}`：面值 10 元进余额） */
const REDEEM_OK = panelOk({ message: 'success', type: 'balance', value: 10 })
/** `/user/profile`（余额口径是 `balance`，单位元） */
const PROFILE_OK = panelOk({ id: 7, email: 'u784@example.com', balance: 12 })

/**
 * 一次「付款回来」的现场：**真** `consume` 客户端 + **假** transport（零网络）。
 *
 * `replies` 里没登记过的端点被打到 → 直接抛错：这是本文件「不该发的请求一次都发不出去」的硬保证
 * （例：② 里 `GET /api/v1/redeem/history` 根本没登记 —— 实现若去读它的结果，用例当场红）。
 */
const scene = (replies, { orders = [order()], signedIn = true, injectOrders = true } = {}) => {
  const recorder = recordingTransport((request) => {
    const key = `${request.method} ${pathOf(request.url).split('?')[0]}`
    if (!Object.hasOwn(replies, key)) {
      throw new Error(`没有预期的端点被打到：${key}`)
    }
    const reply = replies[key]
    return typeof reply === 'function' ? reply(request) : reply
  })
  const client = createConsumeClient({ accessToken: () => JWT, transport: recorder.transport })
  // `loadOrders` = 接线点里的 `fetchPurchases(...).then(page => page.orders)`（这里换成固定一页）
  const loadOrders = async () => {
    loadOrders.calls += 1
    return orders
  }
  loadOrders.calls = 0
  return {
    recorder,
    loadOrders,
    calls: recorder.calls,
    sequence: recorder.sequence,
    countOf: recorder.countOf,
    run: () =>
      autoRedeem.runWalletAutoRedeem({
        client,
        signedIn,
        ...(injectOrders ? { loadOrders } : {}),
      }),
    /** 某一方法的那一发请求（用例只有一发时用它断 body / URL） */
    only: (method) => {
      const hits = recorder.calls.filter((request) => request.method === method)
      assert.equal(hits.length, 1, `期望恰好一发 ${method}，实际 ${hits.length}`)
      return hits[0]
    },
  }
}

// ------------------------------------------------------------------ 源码体检的小工具（.tsx 裸 Node 读不了，接线只能这样断）

const PAGE = 'src/components/consume/AccountConsumePage.tsx'
const BUY_TAB = 'src/components/consume/BuyTab.tsx'
const MY_CARDS_TAB = 'src/components/consume/MyCardsTab.tsx'

const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

const countOfText = (haystack, needle) => haystack.split(needle).length - 1

/** 去掉整行注释与块注释：注释里提到某个名字**不算**接线（否则改一句注释就假红） */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')

/** 从 `from`（指向 `(`）开始按括号配平取出整段 `(...)` —— `useEffect(...)` / `openPayLinkInApp(...)` 用 */
const balancedFrom = (text, from) => {
  assert.equal(text[from], '(', `配平起点必须是左括号：${JSON.stringify(text.slice(from, from + 12))}`)
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '{' || char === '[') {
      depth += 1
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        return text.slice(from, index + 1)
      }
    }
  }
  throw new Error(`括号没有配平（起点 ${from}）`)
}

/** 包住 `keyword` 之后那个括号组（keyword 自身也算在里面，方便断言整段调用） */
const blockAfter = (text, keyword, offset = 0) => {
  const at = text.indexOf(keyword, offset)
  assert.notEqual(at, -1, `源码里找不到 ${keyword}`)
  return balancedFrom(text, text.indexOf('(', at))
}

/** `src/` 下所有 `.ts` / `.tsx` 文件（递归；断言「全仓只有一处调用点」靠它，不是靠手抄文件名） */
const srcFiles = () => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return found
}

/** 全仓 `runWalletAutoRedeem(` 的出现位置（定义处是 `= async (deps`，不带 `(`，所以只会命中调用点） */
const callSites = () =>
  srcFiles().flatMap((file) => {
    const text = stripComments(readFileSync(file, 'utf8'))
    const hits = []
    let at = text.indexOf('runWalletAutoRedeem(')
    while (at !== -1) {
      hits.push({ file: path.relative(ROOT, file), at })
      at = text.indexOf('runWalletAutoRedeem(', at + 1)
    }
    return hits
  })

// ------------------------------------------------------------------ ① 唯一触发点

test('① 唯一触发点：全仓只有 backToCards 会调 runWalletAutoRedeem，挂载 / 进钱包页 / 进卡密页都不触发', () => {
  const sites = callSites()
  assert.equal(sites.length, 1, `调用点必须只有一处（多一处就是「进页面也兑现」的入口）：${JSON.stringify(sites)}`)
  assert.equal(sites[0].file, PAGE, '那唯一一处调用在 AccountConsumePage.tsx')

  const page = stripComments(sourceOf(PAGE))
  // 它是 backToCards 的**函数体**里的语句，不是模块顶层、也不是某个 effect 里
  const callback = blockAfter(page, 'const backToCards = useCallback(')
  assert.ok(callback.includes('void runWalletAutoRedeem({'), '#784 那一枪就在 backToCards 的 useCallback 体里')
  assert.ok(callback.includes('landAfterPayReturn(onNavigate)'), '同一段里先换页（#817 落点 = 卡密页）')

  // 挂载 / 进页：这个文件里每一个 useEffect 的括号里都碰不到它（真实存在的 effect 才有意义）
  let at = page.indexOf('useEffect(')
  let effects = 0
  while (at !== -1) {
    effects += 1
    const effect = balancedFrom(page, page.indexOf('(', at))
    assert.equal(effect.includes('runWalletAutoRedeem'), false, `第 ${effects} 个 useEffect（挂载 / 进页）里不许触发自动兑现`)
    assert.equal(effect.includes('landAfterPayReturn'), false, `第 ${effects} 个 useEffect 里也不许换页到卡密`)
    at = page.indexOf('useEffect(', at + 1)
  }
  assert.ok(effects >= 5, `这个页面确实有挂载 / 进页用的 effect（实际 ${effects} 个），上一条不是空转`)

  // 接线只剩一条：backToCards 作为 onPurchased 交给 BuyTab（定义 + 传参 = 2 处，没有第三条路）
  assert.equal(countOfText(page, 'backToCards'), 2, 'backToCards 只在「定义」和「传给 BuyTab」各出现一次')
  assert.equal(countOfText(page, '<BuyTab onPurchased={backToCards}'), 1, '唯一的接线：付款回来 → backToCards')

  // BuyTab 侧：onPurchased 只在 openPayLinkInApp 的 onClosed（= 收款页关掉）里被调一次
  const buyTab = stripComments(sourceOf(BUY_TAB))
  assert.equal(countOfText(buyTab, 'onPurchased?.()'), 1, 'onPurchased 的调用点只能有一处')
  assert.equal(countOfText(buyTab, 'onPurchased('), 0, '没有第二条「直接调用」的写法')
  assert.equal(countOfText(buyTab, 'openPayLinkInApp('), 1, 'BuyTab 里只有一处打开收款页')
  assert.ok(
    blockAfter(buyTab, 'openPayLinkInApp(').includes('onPurchased?.()'),
    '它就在 openPayLinkInApp 的 onClosed 回调里（= 收款页关掉那一下）'
  )

  // 卡密页只拿「结局」的类型来渲染，不拿函数：进卡密页不可能触发兑现
  const cards = stripComments(sourceOf(MY_CARDS_TAB))
  assert.match(cards, /import type \{[^}]*WalletAutoRedeemOutcome[^}]*\} from '\.\/walletAutoRedeem\.js'/)
  assert.equal(cards.includes('runWalletAutoRedeem'), false, '卡密页里连名字都不许出现')
})

test('①-b 逻辑双保险：只装载 / 只建客户端 = 零请求；真调用才有且只有一发', async () => {
  // import 已经发生过（文件顶部）：模块顶层没有任何「装载即兑现」的副作用
  assert.equal(
    globalThis.localStorage.getItem(autoRedeem.AUTO_REDEEM_STORAGE_KEY),
    null,
    'import 不该往去重表里写东西'
  )
  assert.equal(globalThis.__log.records.length, 0, 'import 也不该打日志')

  const s = scene({ [REDEEM_POST]: REDEEM_OK, [PROFILE_GET]: PROFILE_OK }, { orders: [order()] })
  // 「进钱包页 / 进卡密页 / 挂载组件」在实现里等价于「没有调用 runWalletAutoRedeem」
  assert.equal(s.recorder.calls.length, 0, '建客户端本身零请求')
  assert.equal(s.loadOrders.calls, 0, '没调用就一次订单都不拉（任何请求都会被假 transport 抛出来）')

  // 反向对照：同一份现场真的调一次 → 有且只有一发（证明上面那两个 0 不是空转）
  const outcome = await s.run()
  assert.equal(s.countOf('POST'), 1, '真调用就发一发')
  assert.equal(s.loadOrders.calls, 1, '真调用才拉订单')
  assert.equal(outcome.kind, 'credited')
})

// ------------------------------------------------------------------ ② 数据源是 /api/orders

test('② 数据源是 GET /api/orders：issued 订单的 cardNo 原样进 POST body 的 code，且一次 /redeem/history 都不打', async () => {
  // 只登记「兑换」与「资料」两个端点：history 没登记 → 一旦被读到就抛错（不因它的结果做决定）
  const s = scene({ [REDEEM_POST]: REDEEM_OK, [PROFILE_GET]: PROFILE_OK })
  const outcome = await s.run()

  assert.equal(s.loadOrders.calls, 1, '待兑来源只有订单接口：拉一次 GET /api/orders')
  assert.deepEqual(
    s.sequence(),
    [REDEEM_POST, PROFILE_GET],
    '第一发就是兑换；`GET /api/v1/redeem/history` 一次都没被打到（它是「已兑换流水」，不是待兑来源）'
  )
  assert.equal(
    s.sequence().some((endpoint) => endpoint.includes('orders')),
    false,
    '订单走的是 ours 传输（`fetchPurchases`），不许借道消费侧客户端 —— 现场里它已经被 loadOrders 注入替代'
  )

  const post = s.only('POST')
  assert.equal(post.body, JSON.stringify({ code: CARD }), 'body.code 就是订单上的完整 cardNo（不打码、不改写、不加别的键）')
  assert.equal(post.url.includes(CARD), false, '卡密原文不进 URL / query')
  assert.ok(String(post.headers.authorization ?? '').includes(JWT), '兑换带的是登录态 JWT')
  assert.equal(outcome.kind, 'credited')
})

// ------------------------------------------------------------------ ③ 去重

test('③ 去重：同一 orderNo 第二次「付款回来」→ 0 次 POST；落盘的只有指纹 + 尾 4 位，没有卡密原文', async () => {
  const s = scene({ [REDEEM_POST]: REDEEM_OK, [PROFILE_GET]: PROFILE_OK })

  const first = await s.run()
  assert.equal(first.kind, 'credited', '第一枪正常到账（这样「第二个 0」才有对比意义）')
  assert.equal(s.countOf('POST'), 1)

  const raw = globalThis.localStorage.getItem(autoRedeem.AUTO_REDEEM_STORAGE_KEY)
  assert.equal(typeof raw, 'string', '发请求之前就落盘（中途崩了也不会因为「忘了」再打一枪）')
  const stored = JSON.parse(raw)
  assert.equal(stored.v, 1, '存储格式带版本号，便于以后迁移')
  assert.equal(stored.codes.length, 1, '只记住这一张')
  const token = stored.codes[0]
  assert.match(token, /^order:[0-9a-f]{8}-[0-9A-Z]{4}$/, '落盘形状 = order + FNV-1a 指纹 + 尾 4 位')
  assert.equal(token, autoRedeem.orderFingerprint({ outTradeNo: ORDER_NO }), '键就是这一单的指纹（可复现、可对账）')
  assert.ok(token.endsWith('ABCD'), '尾 4 位来自 orderNo（大写、去分隔符后取尾）')

  // #484 §7 红线：卡密原文一个字都不许进 localStorage，也不许进日志
  const normalized = CARD.replace(/[^0-9A-Z]/g, '')
  assert.equal(raw.includes(CARD), false, '卡密原文绝不进 localStorage')
  assert.equal(raw.toUpperCase().includes(normalized), false, '去掉分隔符后的卡密同样不许进')
  assert.equal(JSON.stringify(globalThis.__log.records).includes(normalized), false, '日志里也只有尾 4 位')
  assert.equal(JSON.stringify(globalThis.__log.records).includes(CARD), false)

  // 第二次「付款回来」：同一单 → 一发都不许再打
  const second = await s.run()
  assert.equal(s.countOf('POST'), 1, '第二次调用一次 POST 都不许发')
  assert.equal(s.loadOrders.calls, 2, '订单照拉（要知道「还有没有别的待兑」），但这一单已经记过了')
  assert.deepEqual(second, { kind: 'skipped', reason: 'duplicate' })
})

// ------------------------------------------------------------------ ④ 打码卡密不兑

test('④ 打码卡密（* / •）→ 0 次请求，outcome = masked（只给手动入口）', async () => {
  // 现场里**一个端点都不登记**：任何请求都会当场抛错
  for (const masked of ['MUSE-****-A3SR', '••••A3SR']) {
    autoRedeem.forgetAutoSubmitted()
    const s = scene({}, { orders: [order({ cardNo: masked })] })
    const outcome = await s.run()

    assert.equal(s.recorder.calls.length, 0, `打码卡密（${masked}）不许发任何请求，实际：${JSON.stringify(s.sequence())}`)
    assert.equal(s.loadOrders.calls, 1, '订单照拉 —— 打码这个事实本身也来自订单')
    assert.equal(outcome.kind, 'masked', '结局是「打码」那一种，不是 failed、也不是 skipped')
    assert.equal(outcome.code, masked, '原样把服务端打的码交给界面（可以显示，不是密文）')
    assert.equal(outcome.i18nKey, 'walletAutoRedeemMasked')
    assert.equal(
      globalThis.localStorage.getItem(autoRedeem.AUTO_REDEEM_STORAGE_KEY),
      null,
      '没提交就不该记忆：用户补全卡密之后还要能兑'
    )
  }
})

// ------------------------------------------------------------------ ⑤ 处理中不算失败

test('⑤ 409 REDEEM_CODE_LOCKED → processing（不是失败、不核对 history、不重试）', async () => {
  const s = scene({
    [REDEEM_POST]: jsonReply(409, { code: 409, message: 'code is locked', reason: 'REDEEM_CODE_LOCKED' }),
  })
  const outcome = await s.run()

  assert.deepEqual(s.sequence(), [REDEEM_POST], '锁住就是「正在处理」：不查 history、不拉 profile、不重发')
  assert.equal(s.countOf('POST'), 1)
  assert.equal(outcome.kind, 'processing', '处理中 ≠ 失败（#484 §4.4：禁止提示换卡）')
  assert.equal(outcome.tail, 'A3SR', '界面只拿得到尾 4 位')
  assert.equal(outcome.i18nKey, 'consumeRedeemProcessing')
  assert.equal(outcome.message, 'code is locked', '服务端原句留给卡片副标题')
})

// ------------------------------------------------------------------ ⑥ 不自动重试

test('⑥ 超时 / 5xx 都只发一次 POST，outcome = failed；再回来一次也不打第二枪', async () => {
  // 6a 传输层超时：兑换层的补偿是「先查 history 核对」，核对未命中 → pending → 自动路径结论是 failed
  const timedOut = scene(
    { [REDEEM_POST]: { kind: 'timeout' }, [HISTORY_GET]: panelOk({ items: [], total: 0 }) },
    { orders: [order({ outTradeNo: 'T784-TIMEOUT-AAAA' })] }
  )
  const timeoutOutcome = await timedOut.run()
  assert.deepEqual(
    timedOut.sequence(),
    [REDEEM_POST, HISTORY_GET],
    '首发 + 一次核对，第二发一次都没有（核对是用来看「是不是已经到账」，不是重发理由）'
  )
  assert.equal(timedOut.countOf('POST'), 1)
  assert.equal(timeoutOutcome.kind, 'failed', 'pending 在自动路径上就是「没兑成」，绝不自动补一枪')
  assert.equal(timeoutOutcome.tail, 'A3SR')

  // 6b 服务端 5xx：同一个形状（retryable → 核对 → 没到账 → failed）
  const errored = scene(
    { [REDEEM_POST]: jsonReply(500, { code: 500, message: 'boom' }), [HISTORY_GET]: panelOk({ items: [], total: 0 }) },
    { orders: [order({ outTradeNo: 'T784-5XX-BBBB' })] }
  )
  const errorOutcome = await errored.run()
  assert.equal(errored.countOf('POST'), 1, '5xx 也只有一发')
  assert.equal(errored.sequence().filter((endpoint) => endpoint === REDEEM_POST).length, 1, '没有第二次 POST')
  assert.equal(errorOutcome.kind, 'failed')

  // 6c 失败同样会被记住：「失败」不是「可以再打一枪」的理由
  const before = errored.countOf('POST')
  const again = await errored.run()
  assert.equal(errored.countOf('POST'), before, '失败之后再「付款回来」也不许重发')
  assert.deepEqual(again, { kind: 'skipped', reason: 'duplicate' })
})

// ------------------------------------------------------------------ ⑦ 成功刷新余额

test('⑦ 成功 → credited（面值 + 重拉来的余额），且 /user/profile 确实在兑换之后', async () => {
  const s = scene({
    [REDEEM_POST]: panelOk({ message: 'success', type: 'balance', value: 30 }),
    [PROFILE_GET]: panelOk({ id: 7, email: 'u784@example.com', balance: 130.5 }),
  })
  const outcome = await s.run()

  assert.deepEqual(s.sequence(), [REDEEM_POST, PROFILE_GET], '兑换在前、重拉资料在后 —— 顺序就是契约')
  assert.equal(outcome.kind, 'credited')
  assert.equal(outcome.tail, 'A3SR')
  assert.equal(outcome.amount, 30, '面值来自这次兑换的 type/value')
  assert.equal(outcome.balance, 130.5, '余额来自**重拉的** GET /api/v1/user/profile（不是本地推算）')
  assert.equal(outcome.message, 'success')

  const profile = s.only('GET')
  assert.ok(String(profile.headers.authorization ?? '').includes(JWT), 'profile 带的是登录态 JWT')
  assert.equal(s.countOf('POST'), 1, '成功路径也只发过一发 POST')
})

// ------------------------------------------------------------------ ⑧ 未登录 / 没有 apiKey

test('⑧ 未登录 / 没有 apiKey（loadOrders 未注入）→ 一个请求都不发', async () => {
  // 8a 未登录：连订单都不拉（空 JWT 打出去只会 401）
  const anonymous = scene({}, { signedIn: false })
  assert.deepEqual(await anonymous.run(), { kind: 'skipped', reason: 'not-signed-in' })
  assert.equal(anonymous.recorder.calls.length, 0, '未登录时一个请求都不发')
  assert.equal(anonymous.loadOrders.calls, 0, '未登录时订单也不拉')

  // 8b 登录了但没有 apiKey：接线点不注入 loadOrders（`apiKey.trim() === ''`），自动兑现直接 skipped
  const noKey = scene({}, { injectOrders: false })
  assert.deepEqual(await noKey.run(), { kind: 'skipped', reason: 'no-key' })
  assert.equal(noKey.recorder.calls.length, 0, '没有 Key 就不打任何接口')

  // 反向对照：同一份现场补上 loadOrders 就会发请求（证明前面两个 0 不是「场景本来就发不出去」）
  const withKey = scene({ [REDEEM_POST]: REDEEM_OK, [PROFILE_GET]: PROFILE_OK })
  assert.equal((await withKey.run()).kind, 'credited')
  assert.equal(withKey.countOf('POST'), 1)
})
