/**
 * #727 演示数据：「我的卡密」/「历史消费」两屏照原型 `服务Tab.html` 落版时用的**假数据**。
 *
 * 为什么要有它：这两屏的真实数据一个来自 apia（`GET /api/orders`）、一个来自 sub2api
 * （`/api/v1/usage`），维护者在 8099 上想看一眼版式就得先登录 + 真买一张卡 + 真跑一次模型。
 * 这份数据只为「看得见最终效果」存在，**不进生产**。
 *
 * 三条铁律（改这个文件时别破）：
 *
 *  1. **只 dev**：唯一引用方是 `MyCardsTab` / `HistoryView` 里那段
 *     `if (process.env.NODE_ENV !== 'production') { … await import('./__mock__/walletDemo.js') }`。
 *     生产构建时那句 `process.env.NODE_ENV` 被 DefinePlugin 折成字面量 → 分支是死的 →
 *     动态 `import()` 不注册 → 本文件不进产物。判据：`pnpm build` 之后
 *     `grep -r "RRQY\|JP9Q" dist/` 必须 0 命中（只做静态 import 做不到这一点：
 *     `sideEffects` 没在 package.json 里声明，摇不掉）。
 *  2. **不进真链路**：本文件只被 `import()` 到组件里当「视图数据」，不发请求、不写 localStorage、
 *     不碰 `services/consume/**` 与 `services/ours/**`（那两处各有别的单子在改）。
 *  3. **卡号是完整的**：列表上屏只露后 4 位（`maskCardNo`），但「复制卡密」复制的是完整卡号 ——
 *     所以这里的 `cardNo` 必须是完整串，且末 4 位就是原型里那四个字符（RRQY / A3SR / JP9Q）。
 *
 * 与原型的两点对齐说明：
 *  - 原型里消费记录的日期分组是写死的「今天 / 11月20日 / 11月19日」；这里按「相对今天」生成时间戳，
 *    于是分组标题永远落在「今天 / 昨天 / M月D日」这三档上（`HistoryView` 的 `dayLabel()` 口径），
 *    换一天打开也不会变成一串旧日期。
 *  - 原型里每条记录的名字都是「模型调用」（那是原型的占位文案）；真实数据里这一格是模型名，
 *    所以这里也写「模型调用」，让 mock 上屏与原型逐字一致。
 */
import type { PurchaseOrder } from '../../../services/ours/purchases.js'
import type { QuotaUsageRow } from '../quotaPanelModel.js'

/** 补齐两位（时间戳是拼给人看的，不是给 `Date` 解析的） */
const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))

/** `daysAgo` 天前的 `HH:mm` → `YYYY-MM-DD HH:mm`（`HistoryView` 按前 10 位分组、11–16 位取时间） */
const stamp = (daysAgo: number, hour: number, minute: number): string => {
  const at = new Date()
  at.setDate(at.getDate() - daysAgo)
  at.setHours(hour, minute, 0, 0)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 某个本地日期的 10:00 对应的 unix 秒（`PurchaseOrder.createdAt` 是秒，不是毫秒） */
const dayAt = (year: number, month: number, day: number): number =>
  Math.floor(new Date(year, month - 1, day, 10, 0, 0, 0).getTime() / 1000)

/**
 * 三张卡，与原型逐字一致：
 *
 *   `••••RRQY` 已兑换 入门包 5 元额度 2026-11-18
 *   `••••A3SR` 已兑换 新人特惠 1 元额度 2026-11-18
 *   `••••JP9Q` 未兑换 入门包 5 元额度 2026-11-17
 *
 * 「已兑换 / 未兑换」在界面上的判据是 `cardIsUsed()`（`redeemState === 'redeemed' || cardStatus === 'used'`），
 * 所以已兑换那两张两种字段都给足，未兑换那张给 `issued / leased`。
 */
export const DEMO_CARDS: PurchaseOrder[] = [
  {
    outTradeNo: 'DEMO-727-0001',
    planId: 'demo-basic-5',
    planName: '入门包 5 元额度',
    planPoints: 500,
    amountYuan: 5,
    status: 'fulfilled',
    statusText: '已完成',
    cardNo: 'K7M4-2VQD-9XTB-RRQY',
    cardStatus: 'used',
    redeemState: 'redeemed',
    createdAt: dayAt(2026, 11, 18),
    paidAt: dayAt(2026, 11, 18),
  },
  {
    outTradeNo: 'DEMO-727-0002',
    planId: 'demo-newbie-1',
    planName: '新人特惠 1 元额度',
    planPoints: 100,
    amountYuan: 1,
    status: 'fulfilled',
    statusText: '已完成',
    cardNo: 'P3HN-8RJW-6YCF-A3SR',
    cardStatus: 'used',
    redeemState: 'redeemed',
    createdAt: dayAt(2026, 11, 18),
    paidAt: dayAt(2026, 11, 18),
  },
  {
    outTradeNo: 'DEMO-727-0003',
    planId: 'demo-basic-5',
    planName: '入门包 5 元额度',
    planPoints: 500,
    amountYuan: 5,
    status: 'fulfilled',
    statusText: '已完成',
    cardNo: 'T9WB-5LXA-2DMK-JP9Q',
    cardStatus: 'leased',
    redeemState: 'issued',
    createdAt: dayAt(2026, 11, 17),
    paidAt: dayAt(2026, 11, 17),
  },
]

/**
 * 五条消费记录，与原型一致（`模型调用 · HH:mm · −¥x.xx`）：
 *
 *   今天   14:32 −¥0.12 / 11:08 −¥0.20
 *   昨天   21:08 −¥0.36 / 09:41 −¥0.05
 *   前天   09:15 −¥0.08
 *
 * 顺序即服务端顺序（时间倒序），`HistoryView` 只切段、不重排。
 */
export const DEMO_USAGE: QuotaUsageRow[] = [
  { id: 'DEMO-727-U1', model: '模型调用', at: stamp(0, 14, 32), requests: 1, cost: 0.12 },
  { id: 'DEMO-727-U2', model: '模型调用', at: stamp(0, 11, 8), requests: 1, cost: 0.2 },
  { id: 'DEMO-727-U3', model: '模型调用', at: stamp(1, 21, 8), requests: 1, cost: 0.36 },
  { id: 'DEMO-727-U4', model: '模型调用', at: stamp(1, 9, 41), requests: 1, cost: 0.05 },
  { id: 'DEMO-727-U5', model: '模型调用', at: stamp(2, 9, 15), requests: 1, cost: 0.08 },
]
