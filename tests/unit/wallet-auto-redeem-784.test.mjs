// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + 可编程假 transport，零浏览器、零真实网络） | 耗时: <1s]
//
// Issue #784 ——「付款回来 → 自动把卡密兑进账号余额」的**仓库内单测**。
// #834 之后**数据源与去重键都换了**（见下），本文件跟着改到新契约；断言一条没删、没有放宽、没有 skip。
//
// 为什么补这一份：`grep -rln "walletAutoRedeem" tests/` 在本文件之前是**空的** ——
// 这条链路上跑的是钱（`POST /api/v1/redeem` 服务端没有 request_id 之类的重放保护），实现里每一条取舍（只在该触发点触发 /
// 本地按单去重 / 打码卡不兑 / 处理中不算失败 / 绝不自动第二枪 / 成功才刷余额 / 未登录零请求）此前
// **一条断言都没有**，任何改动都能悄悄把它弄坏而不被发现。
//
// ## #834 的契约变更（本文件逐条跟进，PR 里说明为什么是「等价断言」）
//
//  1. **数据源**：`GET /api/orders`（apia，Bearer sk- Key）→ `GET /api/v1/payment/orders/my`
//     （sub2api，JWT）。旧接口在账号迁移后**恒 401**，自动兑现一个请求都发不出去且不报错 ——
//     所以 ② 里「订单从哪来」的断言改到新契约上，并且多了一条「换数据源之后仍然只发一枪」的等价证明。
//  2. **待兑判据**：`redeemState === 'issued'` → `status === 'COMPLETED'` 且 `recharge_code` 非空且未打码
//     （新接口没有「卡是否已兑换」这个字段）。
//  3. **已兑跳过**：新接口不回答「兑没兑过」，改用既有 `GET /api/v1/redeem/history` 按卡号交叉比对 ——
//     因此 ② 原来那条「history 一次都不打」必须改成「兑换**之前**先打一次 history」，
//     并且新增 ⑨ 专门钉住「历史里有这张卡 → 0 次 POST」。
//  4. **去重键**：`orderNo` → `out_trade_no`（语义等价：标识的是「这一单」，不是「这一张卡」）。
//
// 被测对象（不重写一行兑换逻辑，本文件也不重写）：
//   · `src/components/consume/walletAutoRedeem.ts`（纯逻辑，裸 Node 可 import）；
//   · 接线点 `AccountConsumePage.tsx` 的 `backToCards`（`.tsx` 裸 Node import 不了 → 读源码断言）；
//   · 它复用的 `services/consume/redeem.ts` / `myCardsModel.ts:afterRedeemed()` —— 这里**不**替身掉，
//     而是给真客户端塞一个可编程假 transport：断言的端点（`POST /api/v1/redeem`、
//     `GET /api/v1/redeem/history`、`GET /user/profile`）与请求体都是**真发出来的那一份**，不是平行真理。
//   · 订单对象由**新契约的解析函数**（`services/consume/orders.ts: parseMyOrder`）从 snake_case 造出来，
//     所以字段名一旦被改回去，本文件当场红。
//
// 覆盖（每条一个 test，编号与票面验收表一致）：
//   ① 唯一触发点：全仓 `src/` 只有 `backToCards` 调 `runWalletAutoRedeem(...)`；
//      挂载 / 进钱包页 / 进卡密页都碰不到（源码接线断言 + 「装载零副作用」逻辑断言双保险）
//   ② 数据源是 `GET /api/v1/payment/orders/my`：`COMPLETED` 订单的 `recharge_code` 原样进 POST body 的 `code`，
//      且兑换**之前**先打一次 `/redeem/history` 做交叉比对（#834 的「已兑跳过」）
//   ③ 去重：同一 `out_trade_no` 第二次「付款回来」→ 0 次 POST；落盘只有指纹 + 尾 4 位，**没有卡密原文**
//   ④ 打码卡密（`*` / `•`）→ 0 次请求，outcome = masked（给手动入口那一种）
//   ⑤ 409 `REDEEM_CODE_LOCKED` → processing：不是失败、不核对 history、不重试
//   ⑥ 超时 / 5xx → 只有一发 POST，outcome = failed；再来一次也不打第二枪
//   ⑦ 成功 → credited（面值 + 重拉来的余额），且 `/user/profile` **在兑换之后**
//   ⑧ 未登录 / 没有可用会话（`loadOrders` 未注入）→ 一个请求都不发
//   ⑨ 已兑过就跳过：历史里有这张卡（全码或打码形态都算）→ 0 次 POST；历史读不到 → 也不猜（0 次 POST）
//
// 负向对照（人工，非本文件；命令与输出见 PR 正文）：
//   ① 去掉 `wasAutoSubmitted()` 那一段判断 → ③ 必须红（第二次也发 POST）；
//   ② 去掉打码跳过（`isPendingOrder` 里的 `MASK_MARKERS` 判断）→ ④ 必须红（拿打码码去打 POST）；
//   ③ 去掉「已兑跳过」（`dropAlreadyRedeemed` 恒返回全部候选）→ ⑨ 必须红（拿已兑的卡再打一枪）。
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
const ordersApi = await import('../../src/services/consume/orders.ts')
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
/** 服务端发的**完整**卡号（真实形态：带分隔符的大写串，尾 4 位 A3SR） */
const CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
/** 订单号（新契约的 `out_trade_no`：去重的第一优先键） */
const ORDER_NO = 'T784-0001-ABCD'

const REDEEM_POST = 'POST /api/v1/redeem'
const HISTORY_GET = 'GET /api/v1/redeem/history'
const PROFILE_GET = 'GET /api/v1/user/profile'
/** 新契约的数据源端点（只在源码断言里用；本文件把 `loadOrders` 注入成固定一页） */
const ORDERS_MY = '/api/v1/payment/orders/my'

/**
 * 一条订单：**服务端真实形状**（snake_case）进 `parseMyOrder`，出来的就是实现真的会读的那份对象。
 *
 * `status` / `recharge_code` 是 #834 的待兑判据；`paid_at` / `created_at` 决定「挑最新一条」。
 */
const order = (over = {}) => {
  const parsed = ordersApi.parseMyOrder({
    out_trade_no: ORDER_NO,
    status: 'COMPLETED',
    amount: 10,
    pay_amount: 9.9,
    payment_type: 'legacy_cardpay',
    recharge_code: CARD,
    created_at: '2026-11-13T10:00:00+08:00',
    paid_at: '2026-11-13T10:01:00+08:00',
    ...over,
  })
  assert.notEqual(parsed, null, '订单 fixture 必须能按新契约解析出来')
  return parsed
}

/** 兑换历史里的一条记录（服务端可能把中间打码，尾 4 位保留） */
const historyItem = (over = {}) => ({ code: CARD, type: 'balance', value: 10, ...over })

/** 兑换成功体（`redeem_handler.go` 的 `{message,type,value}`：面值 10 元进余额） */
const REDEEM_OK = panelOk({ message: 'success', type: 'balance', value: 10 })
/** `/user/profile`（余额口径是 `balance`，单位元） */
const PROFILE_OK = panelOk({ id: 7, email: 'u784@example.com', balance: 12 })
/** 空历史（这一单还没兑过）：交叉比对的默认现场 */
const HISTORY_EMPTY = panelOk({ items: [], total: 0 })

/**
 * 一次「付款回来」的现场：**真** `consume` 客户端 + **假** transport（零网络）。
 *
 * `replies` 里没登记过的端点被打到 → 直接抛错：这是本文件「不该发的请求一次都发不出去」的硬保证
 * （例：⑤ 里 `GET /user/profile` 根本没登记 —— 实现若在「处理中」时去拉资料，用例当场红）。
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
  // `loadOrders` = 接线点里的 `consume.orders.my(...)`（#834；这里换成固定一页，端点由源码断言钉住）
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

  const s = scene({ [REDEEM_POST]: REDEEM_OK, [HISTORY_GET]: HISTORY_EMPTY, [PROFILE_GET]: PROFILE_OK }, { orders: [order()] })
  // 「进钱包页 / 进卡密页 / 挂载组件」在实现里等价于「没有调用 runWalletAutoRedeem」
  assert.equal(s.recorder.calls.length, 0, '建客户端本身零请求')
  assert.equal(s.loadOrders.calls, 0, '没调用就一次订单都不拉（任何请求都会被假 transport 抛出来）')

  // 反向对照：同一份现场真的调一次 → 有且只有一发 POST（证明上面那两个 0 不是空转）
  const outcome = await s.run()
  assert.equal(s.countOf('POST'), 1, '真调用就发一发')
  assert.equal(s.loadOrders.calls, 1, '真调用才拉订单')
  assert.equal(outcome.kind, 'credited')
})

// ------------------------------------------------------------------ ② 数据源是新接口

test('② 数据源是 GET /api/v1/payment/orders/my：COMPLETED 订单的 recharge_code 原样进 POST body 的 code，且兑换前先查一次历史', async () => {
  // 登记「历史 / 兑换 / 资料」三个端点：`GET /api/v1/redeem/history` 现在是**必需**的交叉比对（#834）
  const s = scene({ [REDEEM_POST]: REDEEM_OK, [HISTORY_GET]: HISTORY_EMPTY, [PROFILE_GET]: PROFILE_OK })
  const outcome = await s.run()

  assert.equal(s.loadOrders.calls, 1, '待兑来源只有订单接口：拉一次（新接口 `consume.orders.my()`）')
  assert.deepEqual(
    s.sequence(),
    [HISTORY_GET, REDEEM_POST, PROFILE_GET],
    '顺序 = 先按卡号查已兑换流水（新接口不回答「兑没兑过」）→ 再发兑换 → 最后重拉资料'
  )
  assert.equal(
    s.sequence().indexOf(HISTORY_GET) < s.sequence().indexOf(REDEEM_POST),
    true,
    '交叉比对必须在兑换**之前**（兑完再查就变成「事后解释」，拦不住重复提交）'
  )
  assert.equal(
    s.sequence().some((endpoint) => endpoint.includes('orders')),
    false,
    '订单不借道兑换 / 资料的传输：接线点把 `consume.orders.my()` 注入成 loadOrders（端点由下面的源码断言钉住）'
  )

  // 数据源换了，但「待兑判据」仍然是「服务端说这张卡能兑」：status=COMPLETED + recharge_code 非空
  const parsed = order()
  assert.equal(parsed.status, 'COMPLETED')
  assert.equal(parsed.rechargeCode, CARD, '订单上的 recharge_code 就是完整卡号（打码只发生在展示层）')

  const post = s.only('POST')
  assert.equal(post.body, JSON.stringify({ code: CARD }), 'body.code 就是订单上的完整 recharge_code（不打码、不改写、不加别的键）')
  assert.equal(post.url.includes(CARD), false, '卡密原文不进 URL / query')
  assert.ok(String(post.headers.authorization ?? '').includes(JWT), '兑换带的是登录态 JWT')
  assert.equal(outcome.kind, 'credited')

  // 接线：页面注入的正是新接口（旧 apia 端点在这条链路上一个字都不许出现）
  const page = stripComments(sourceOf(PAGE))
  assert.ok(page.includes('consume.orders.my('), '接线点的 loadOrders 打的是 `GET /api/v1/payment/orders/my`')
  assert.equal(page.includes('fetchPurchases'), false, '不再走旧的 `fetchPurchases`（#834 的连带修复）')
  assert.equal(page.includes('/api/orders'), false, '不再出现旧端点字面量')
  assert.ok(sourceOf('src/services/consume/orders.ts').includes(ORDERS_MY), '新端点由消费层唯一实现')
})

// ------------------------------------------------------------------ ③ 去重

test('③ 去重：同一 out_trade_no 第二次「付款回来」→ 0 次 POST；落盘的只有指纹 + 尾 4 位，没有卡密原文', async () => {
  const s = scene({ [REDEEM_POST]: REDEEM_OK, [HISTORY_GET]: HISTORY_EMPTY, [PROFILE_GET]: PROFILE_OK })

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
  assert.equal(token, autoRedeem.orderFingerprint({ outTradeNo: ORDER_NO }), '键就是这一单的指纹（#834：去重键 = out_trade_no）')
  assert.equal(token, autoRedeem.orderFingerprint(order()), '订单对象上的 `outTradeNo` 就是那份 `out_trade_no`')
  assert.ok(token.endsWith('ABCD'), '尾 4 位来自 out_trade_no（大写、去分隔符后取尾）')

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
  assert.equal(
    s.sequence().filter((endpoint) => endpoint === HISTORY_GET).length,
    2,
    '两次都查了历史（历史是空的 → 拦住第二次的是**本地去重**，不是历史命中）'
  )
  assert.deepEqual(second, { kind: 'skipped', reason: 'duplicate' })
})

// ------------------------------------------------------------------ ④ 打码卡密不兑

test('④ 打码卡密（* / •）→ 0 次请求，outcome = masked（只给手动入口）', async () => {
  // 现场里**一个端点都不登记**：任何请求都会当场抛错
  for (const masked of ['MUSE-****-A3SR', '••••A3SR']) {
    autoRedeem.forgetAutoSubmitted()
    const s = scene({}, { orders: [order({ recharge_code: masked })] })
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

  // 打码判据挂在 COMPLETED 之后：未完成的订单即便带打码串也不是「打码待兑」，就是「没有待兑」
  const notCompleted = scene({}, { orders: [order({ status: 'PENDING', recharge_code: 'MUSE-****-A3SR' })] })
  assert.deepEqual(await notCompleted.run(), { kind: 'skipped', reason: 'no-pending' })
  assert.equal(notCompleted.recorder.calls.length, 0)
})

// ------------------------------------------------------------------ ⑤ 处理中不算失败

test('⑤ 409 REDEEM_CODE_LOCKED → processing（不是失败、不核对 history、不重试）', async () => {
  const s = scene({
    [HISTORY_GET]: HISTORY_EMPTY,
    [REDEEM_POST]: jsonReply(409, { code: 409, message: 'code is locked', reason: 'REDEEM_CODE_LOCKED' }),
  })
  const outcome = await s.run()

  assert.deepEqual(
    s.sequence(),
    [HISTORY_GET, REDEEM_POST],
    '锁住就是「正在处理」：兑换前的那一次历史比对之后，不再查 history、不拉 profile、不重发'
  )
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
    { orders: [order({ out_trade_no: 'T784-TIMEOUT-AAAA' })] }
  )
  const timeoutOutcome = await timedOut.run()
  assert.deepEqual(
    timedOut.sequence(),
    [HISTORY_GET, REDEEM_POST, HISTORY_GET],
    '兑换前一次交叉比对 + 超时后一次核对 = 两次 history，第二发 POST 一次都没有'
  )
  assert.equal(timedOut.countOf('POST'), 1)
  assert.equal(timeoutOutcome.kind, 'failed', 'pending 在自动路径上就是「没兑成」，绝不自动补一枪')
  assert.equal(timeoutOutcome.tail, 'A3SR')

  // 6b 服务端 5xx：同一个形状（retryable → 核对 → 没到账 → failed）
  const errored = scene(
    { [REDEEM_POST]: jsonReply(500, { code: 500, message: 'boom' }), [HISTORY_GET]: panelOk({ items: [], total: 0 }) },
    { orders: [order({ out_trade_no: 'T784-5XX-BBBB' })] }
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
    [HISTORY_GET]: HISTORY_EMPTY,
    [PROFILE_GET]: panelOk({ id: 7, email: 'u784@example.com', balance: 130.5 }),
  })
  const outcome = await s.run()

  assert.deepEqual(s.sequence(), [HISTORY_GET, REDEEM_POST, PROFILE_GET], '比对 → 兑换 → 重拉资料（顺序就是契约）')
  assert.equal(outcome.kind, 'credited')
  assert.equal(outcome.tail, 'A3SR')
  assert.equal(outcome.amount, 30, '面值来自这次兑换的 type/value')
  assert.equal(outcome.balance, 130.5, '余额来自**重拉的** GET /api/v1/user/profile（不是本地推算）')
  assert.equal(outcome.message, 'success')

  // 这一场里有两发 GET（历史 + 资料）：分别断，别用「唯一一发 GET」蒙过去
  const gets = s.calls.filter((request) => request.method === 'GET')
  assert.equal(gets.length, 2, 'GET 共两发：兑换前查历史、兑换后拉资料')
  assert.equal(`${gets[0].method} ${pathOf(gets[0].url).split('?')[0]}`, HISTORY_GET, '第一发 GET 是历史比对')
  const profile = gets[1]
  assert.equal(`${profile.method} ${pathOf(profile.url).split('?')[0]}`, PROFILE_GET, '最后一发 GET 是资料（在兑换之后）')
  assert.ok(String(profile.headers.authorization ?? '').includes(JWT), 'profile 带的是登录态 JWT')
  assert.equal(s.countOf('POST'), 1, '成功路径也只发过一发 POST')
})

// ------------------------------------------------------------------ ⑧ 未登录 / 没有可用会话

test('⑧ 未登录 / 没有可用会话（loadOrders 未注入）→ 一个请求都不发', async () => {
  // 8a 未登录：连订单都不拉（空 JWT 打出去只会 401）
  const anonymous = scene({}, { signedIn: false })
  assert.deepEqual(await anonymous.run(), { kind: 'skipped', reason: 'not-signed-in' })
  assert.equal(anonymous.recorder.calls.length, 0, '未登录时一个请求都不发')
  assert.equal(anonymous.loadOrders.calls, 0, '未登录时订单也不拉')

  // 8b 登录了但接线点没注入订单来源（没有可用会话 / 客户端）：自动兑现直接 skipped，且一次请求都不发
  const noSession = scene({}, { injectOrders: false })
  assert.deepEqual(await noSession.run(), { kind: 'skipped', reason: 'no-session' }, '#834 之后没有「没填 Key」这一态，改叫「没有可用会话」')
  assert.equal(noSession.recorder.calls.length, 0, '没有会话就不打任何接口（含 history）')
  assert.equal(noSession.loadOrders.calls, 0, '连订单都不拉')

  // 反向对照：同一份现场补上 loadOrders 就会发请求（证明前面两个 0 不是「场景本来就发不出去」）
  const withSession = scene({ [REDEEM_POST]: REDEEM_OK, [HISTORY_GET]: HISTORY_EMPTY, [PROFILE_GET]: PROFILE_OK })
  assert.equal((await withSession.run()).kind, 'credited')
  assert.equal(withSession.countOf('POST'), 1)
})

// ------------------------------------------------------------------ ⑨ 已兑过就跳过（#834 的核心补丁）

test('⑨ 已兑过就跳过：历史里有这张卡（全码或打码形态）→ 0 次 POST；历史读不到 → 也不猜', async () => {
  // 9a 历史里是同一条全码：这张卡已经在账号里了 → 一次 POST 都不许发
  const fullCode = scene({ [HISTORY_GET]: panelOk({ items: [historyItem()], total: 1 }) }, { orders: [order()] })
  const fullOutcome = await fullCode.run()
  assert.deepEqual(fullCode.sequence(), [HISTORY_GET], '只查历史就够：命中即跳过，不发兑换、不拉资料')
  assert.equal(fullCode.countOf('POST'), 0, '已兑过的卡绝不再打一枪（新接口没有「已兑换」字段，只能这样交叉比对）')
  assert.deepEqual(fullOutcome, { kind: 'skipped', reason: 'already-redeemed' })
  assert.equal(
    globalThis.localStorage.getItem(autoRedeem.AUTO_REDEEM_STORAGE_KEY),
    null,
    '跳过发生在「落盘」之前：这条链一次都没提交过，去重表不该被写脏'
  )

  // 9b 服务端在流水里把中间打码（`MUSE-****-A3SR`）：尾 4 位对得上就算同一张卡
  autoRedeem.forgetAutoSubmitted()
  const maskedHistory = scene(
    { [HISTORY_GET]: panelOk({ items: [historyItem({ code: 'MUSE-****-A3SR' })], total: 1 }) },
    { orders: [order()] }
  )
  assert.deepEqual(await maskedHistory.run(), { kind: 'skipped', reason: 'already-redeemed' })
  assert.equal(maskedHistory.countOf('POST'), 0, '打码形态的流水同样能认出来（`matchesRedeemCode` 的口径）')

  // 9c 历史是**别**的卡：不算已兑，照常提交（证明 9a/9b 不是「历史一有内容就跳过」）
  autoRedeem.forgetAutoSubmitted()
  const otherCard = scene(
    {
      [HISTORY_GET]: panelOk({ items: [historyItem({ code: 'MUSE-7ZXQ-1K2M-9PPP-BBBB' })], total: 1 }),
      [REDEEM_POST]: REDEEM_OK,
      [PROFILE_GET]: PROFILE_OK,
    },
    { orders: [order()] }
  )
  assert.equal((await otherCard.run()).kind, 'credited')
  assert.deepEqual(otherCard.sequence(), [HISTORY_GET, REDEEM_POST, PROFILE_GET], '历史里是别的卡 → 该兑就兑')

  // 9d 历史读不到（5xx）：**不可知** → 不猜、不发（重复提交一张已兑的卡只会换来一句「失败」）
  autoRedeem.forgetAutoSubmitted()
  const historyDown = scene(
    { [HISTORY_GET]: jsonReply(500, { code: 500, message: 'boom' }) },
    { orders: [order()] }
  )
  assert.deepEqual(await historyDown.run(), { kind: 'skipped', reason: 'history-unknown' })
  assert.equal(historyDown.countOf('POST'), 0, '历史读不到就不发兑换')
  assert.equal(
    globalThis.localStorage.getItem(autoRedeem.AUTO_REDEEM_STORAGE_KEY),
    null,
    '没提交就不落盘'
  )
})
