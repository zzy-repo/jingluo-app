/**
 * 未完成订单的本地存档（只存单号与 order_token，**不存卡密**）。
 *
 * order_token 是查单的唯一凭据：付款在别的标签页 / 系统浏览器里完成，
 * 回来时如果拿不出它就查不到这笔单（/api/order 一律 403），所以必须落盘。
 *
 * 为什么要单独一个文件：付款回跳解析（returnParams.ts）与应用启动（main.tsx）都要写这份存档，
 * 而弹层组件本身不方便被 Node 单测直接 import（它依赖 React / DOM）。
 * storage 可注入，单测里传一个假 localStorage 就能断言「存了什么、坏数据怎么兜」。
 */

export const ORDER_STORAGE_KEY = 'chat-demo:ours-order'

/** 超过这个时间的存档不再自动续查（订单本身 15 分钟就过期了） */
export const ORDER_RESUME_MAX_AGE_MS = 30 * 60 * 1000

export type StoredOrder = {
  outTradeNo: string
  orderToken: string
  /** 下单时选中的套餐；回跳带回来的单没有这一项，就是空串 */
  planId: string
  startedAt: number
}

/** 只用到 localStorage 的三个方法：注入假的实现即可在 Node 里测 */
export type OrderStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** 浏览器里的 localStorage；没有（Node / 隐私模式抛错）就返回 null，调用方按「没有存档」处理 */
export const browserStorage = (): OrderStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const readStoredOrder = (storage: OrderStorage | null = browserStorage()): StoredOrder | null => {
  if (storage === null) {
    return null
  }
  try {
    const raw = storage.getItem(ORDER_STORAGE_KEY)
    if (raw === null) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return null
    }
    const record = parsed as Partial<StoredOrder>
    if (
      typeof record.outTradeNo !== 'string' ||
      typeof record.orderToken !== 'string' ||
      record.outTradeNo === '' ||
      record.orderToken === ''
    ) {
      return null
    }
    return {
      outTradeNo: record.outTradeNo,
      orderToken: record.orderToken,
      planId: typeof record.planId === 'string' ? record.planId : '',
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    }
  } catch {
    return null
  }
}

export const writeStoredOrder = (
  order: StoredOrder | null,
  storage: OrderStorage | null = browserStorage()
): void => {
  if (storage === null) {
    return
  }
  try {
    if (order === null) {
      storage.removeItem(ORDER_STORAGE_KEY)
      return
    }
    storage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // 存不进去只影响「重开设置后自动续查」，不影响本次轮询
  }
}
