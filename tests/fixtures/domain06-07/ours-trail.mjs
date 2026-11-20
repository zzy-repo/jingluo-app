// Issue #189「支付记录：订单 / 卡密全程时间线」的响应 fixture —— 只有一处定义，单测与截图共用。
//
// 形状按 https://apia.ecsafe.cn 的契约（issue #189 里记录的字段），时间一律**秒**（与 /api/orders 一致）。
// 2026-11-19 本机实测的错误形状（无凭据，只能实测错误分支）：
//   GET /api/trail（无 / 假 Key）           → 401 {"code":"UNAUTHORIZED","message":"需要 Bearer API Key"/"API Key 无效"}
//   GET /api/order/trail（缺 out_trade_no） → 400 {"code":"BAD_INPUT","message":"缺少 out_trade_no"}
//   GET /api/order/trail（单号不存在）      → 404 {"code":"ORDER_NOT_FOUND","message":"订单不存在"}
//   GET /api/card/trail（无 / 假 Key）      → 401 {"code":"UNAUTHORIZED",…}
// 成功响应（200）本机没有可用真实凭据，字段按 issue 契约实现；未核对的边界写进 PR。
//
// ⚠️ 卡号一律是**演示用假卡号**（MUSE- 前缀 + 随机段），不是任何真实卡密。

/** 账号级 customer_id：时间线按 Key 归属，跨用户单号必须 404 */
export const TRAIL_CUSTOMER_ID = 10

/** 秒级时间基准：2026-11-19T09:33:00+08:00 */
const T = 1795051980
const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/** [1] 已下单未支付：只有一条 order_created，card 为 null */
export const trailOrderCreated = {
  out_trade_no: 'CP20261119093300001',
  plan_id: 'newbie',
  amount_yuan: 1,
  status: 'CREATED',
  status_text: '待支付',
  created_at: T,
  paid_at: null,
  expire_at: T + 15 * MINUTE,
  card: null,
  timeline: [
    {
      at: T,
      event: 'order_created',
      text: '已下单，等待支付',
      detail: { plan_id: 'newbie', amount_yuan: 1 },
    },
  ],
  next_step: '完成支付后卡密会立即发放',
}

/** [2] 已支付、发卡中（发卡是异步的，这一步可能停留几秒）：没有 card，next_step 给「等」 */
export const trailOrderPaid = {
  out_trade_no: 'CP20261119081600002',
  plan_id: 'starter',
  amount_yuan: 3,
  status: 'PAID',
  status_text: '已支付',
  created_at: T - HOUR,
  paid_at: T - HOUR + MINUTE,
  expire_at: T - HOUR + 15 * MINUTE,
  card: null,
  timeline: [
    { at: T - HOUR, event: 'order_created', text: '已下单，等待支付', detail: {} },
    { at: T - HOUR + 40, event: 'notify_ok', text: '收到支付平台通知', detail: {} },
    { at: T - HOUR + MINUTE, event: 'paid_confirmed', text: '支付已确认', detail: { amount_yuan: 3 } },
    { at: T - HOUR + MINUTE + 2, event: 'issue_waiting_stock', text: '已付款，正在准备卡密', detail: {} },
  ],
  next_step: '正在准备卡密，通常几秒内完成',
}

/** [3] 已发卡且已兑换：card 带 state=redeemed + 兑换人 / 兑换时间 / Key 尾号 */
export const trailOrderFulfilled = {
  out_trade_no: 'CP20261119063300003',
  plan_id: 'pro',
  amount_yuan: 29.9,
  status: 'FULFILLED',
  status_text: '已完成',
  created_at: T - 3 * HOUR,
  paid_at: T - 3 * HOUR + MINUTE,
  expire_at: T - 3 * HOUR + 15 * MINUTE,
  card: {
    card_no: 'MUSE-3CYP-5NA3-AHSE-A3SR',
    points: 3000,
    state: 'redeemed',
    redeemed_at: T - 3 * HOUR + 420,
    redeemed_by_customer_id: TRAIL_CUSTOMER_ID,
    redeemed_key_tail: '013812',
  },
  timeline: [
    { at: T - 3 * HOUR, event: 'order_created', text: '已下单，等待支付', detail: {} },
    { at: T - 3 * HOUR + 40, event: 'notify_ok', text: '收到支付平台通知', detail: {} },
    { at: T - 3 * HOUR + MINUTE, event: 'paid_confirmed', text: '支付已确认', detail: { amount_yuan: 29.9 } },
    { at: T - 3 * HOUR + 65, event: 'card_issued', text: '已发放卡密', detail: { points: 3000 } },
    { at: T - 3 * HOUR + 420, event: 'card_redeemed', text: '卡密已兑换，积分到账', detail: { points: 3000 } },
  ],
  next_step: '',
}

/** [4] 超时关闭：**不是失败**（24h 内付款会自动救回），事件是 order_expired */
export const trailOrderExpired = {
  out_trade_no: 'CP20261118151100004',
  plan_id: 'starter',
  amount_yuan: 3,
  status: 'EXPIRED',
  status_text: '已关闭',
  created_at: T - DAY,
  paid_at: null,
  expire_at: T - DAY + 15 * MINUTE,
  card: null,
  timeline: [
    { at: T - DAY, event: 'order_created', text: '已下单，等待支付', detail: {} },
    { at: T - DAY + 15 * MINUTE, event: 'order_expired', text: '订单超时未支付，已关闭', detail: {} },
  ],
  next_step: '关闭后 24 小时内收到付款会自动补发卡密；如已付款请联系客服',
}

/** [5] 失败：支付金额与订单不符，服务端拒绝发卡 */
export const trailOrderFailed = {
  out_trade_no: 'CP20261117230000005',
  plan_id: 'standard',
  amount_yuan: 9.9,
  status: 'FAILED',
  status_text: '支付异常',
  created_at: T - 2 * DAY,
  paid_at: T - 2 * DAY + MINUTE,
  expire_at: T - 2 * DAY + 15 * MINUTE,
  card: null,
  timeline: [
    { at: T - 2 * DAY, event: 'order_created', text: '已下单，等待支付', detail: {} },
    { at: T - 2 * DAY + 40, event: 'notify_ok', text: '收到支付平台通知', detail: {} },
    {
      at: T - 2 * DAY + MINUTE,
      event: 'notify_bad_amount',
      text: '支付金额与订单不符，已拒绝发卡',
      detail: { paid_yuan: 0.1, order_yuan: 9.9 },
    },
  ],
  next_step: '请联系客服核对金额与订单号',
}

/**
 * [6] 长链路：9 个事件（截图「长列表可滚动」用），含
 *  - 关闭后补发的救回链路（order_expired → late_paid_recovered）；
 *  - App 不认识的新事件 `amount_reconciled`：**必须原样展示服务端 text，不许被白名单丢掉**；
 *  - detail.backfilled=true 的历史事件（时间只是补录，不精确）。
 */
export const trailOrderLong = {
  out_trade_no: 'CP20261117092200006',
  plan_id: 'pro',
  amount_yuan: 29.9,
  status: 'FULFILLED',
  status_text: '已完成',
  created_at: T - 2 * DAY + 300,
  paid_at: T - 2 * DAY + 2400,
  expire_at: T - 2 * DAY + 300 + 15 * MINUTE,
  card: {
    card_no: 'MUSE-7QKD-2MPR-9XCE-B8TW',
    points: 3000,
    state: 'redeemed',
    redeemed_at: T - DAY,
    redeemed_by_customer_id: TRAIL_CUSTOMER_ID,
    redeemed_key_tail: '884210',
  },
  timeline: [
    { at: T - 2 * DAY + 300, event: 'order_created', text: '已下单，等待支付', detail: {} },
    { at: T - 2 * DAY + 300 + 15 * MINUTE, event: 'order_expired', text: '订单超时未支付，已关闭', detail: {} },
    { at: T - 2 * DAY + 2400, event: 'notify_ok', text: '收到支付平台通知', detail: {} },
    {
      at: T - 2 * DAY + 2400,
      event: 'late_paid_recovered',
      text: '关闭后收到付款，已补发卡密',
      detail: { card_no: 'MUSE-7QKD-2MPR-9XCE-B8TW' },
    },
    { at: T - 2 * DAY + 2405, event: 'card_issued', text: '已发放卡密', detail: { points: 3000 } },
    {
      at: T - 2 * DAY + 2500,
      event: 'amount_reconciled',
      text: '对账完成，金额一致',
      detail: { backfilled: true },
    },
    { at: T - 2 * DAY + 3600, event: 'notify_ok', text: '收到支付平台通知', detail: { backfilled: true } },
    { at: T - 2 * DAY + 7200, event: 'paid_confirmed', text: '支付已确认', detail: { backfilled: true } },
    { at: T - DAY - 600, event: 'card_redeemed', text: '卡密已兑换，积分到账', detail: { points: 3000 } },
  ],
  next_step: '',
}

/** 五个状态各一条，顺序与列表一致（新的在前） */
export const trailOrders = [
  trailOrderCreated,
  trailOrderPaid,
  trailOrderFulfilled,
  trailOrderExpired,
  trailOrderFailed,
]

/** 完整一页：total = 6（含长链路那条） */
export const trailPage = {
  customer_id: TRAIL_CUSTOMER_ID,
  total: 6,
  limit: 20,
  offset: 0,
  total_paid_yuan: 72.7,
  orders: [...trailOrders, trailOrderLong],
}

/** 空列表：新账号一条订单都没有（这不是错误） */
export const trailPageEmpty = {
  customer_id: TRAIL_CUSTOMER_ID,
  total: 0,
  limit: 20,
  offset: 0,
  total_paid_yuan: 0,
  orders: [],
}

/** 单个订单的响应（GET /api/order/trail）就是订单对象本身 */
export const orderTrailResponse = trailOrderFulfilled

/** GET /api/card/trail：卡->订单->兑换三段，purchase 复用一个订单对象 */
export const cardTrailRedeemed = {
  card_no: 'MUSE-3CYP-5NA3-AHSE-A3SR',
  purchase: trailOrderFulfilled,
  redemption: {
    redeemed: true,
    at: T - 3 * HOUR + 420,
    points: 3000,
    key_tail: '013812',
    by_me: true,
    source: 'in_app',
  },
}

export const cardTrailUnredeemed = {
  card_no: 'MUSE-9TTM-1ZQK-4RBV-H7ND',
  purchase: {
    ...trailOrderFulfilled,
    out_trade_no: 'CP20261119063300007',
    card: {
      card_no: 'MUSE-9TTM-1ZQK-4RBV-H7ND',
      points: 1800,
      state: 'issued',
      redeemed_at: null,
      redeemed_by_customer_id: null,
      redeemed_key_tail: '',
    },
  },
  redemption: { redeemed: false },
}

/** 服务端错误体（形状是 2026-11-19 实测的 { code, message, request_id }） */
export const errorBodies = {
  unauthorized: { code: 'UNAUTHORIZED', message: 'API Key 无效', request_id: '14eeb6e9b811' },
  badInput: { code: 'BAD_INPUT', message: '缺少 out_trade_no', request_id: 'baa8bdf8dfa9' },
  orderNotFound: { code: 'ORDER_NOT_FOUND', message: '订单不存在', request_id: '7637526b4e89' },
  unavailable: { code: 'UNAVAILABLE', message: '服务暂时不可用，请稍后重试', request_id: 'c0ffee123456' },
}

/** 503 停服：**不能显示成「没有记录」** */
export const unavailableBody = errorBodies.unavailable
