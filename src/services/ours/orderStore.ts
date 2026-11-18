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
    } else {
      storage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order))
    }
  } catch {
    // 存不进去只影响「重开设置后自动续查」，不影响本次轮询
    return
  }
  notifyStoredOrder()
}

/**
 * 存档变化通知（Issue #157）。
 *
 * 为什么需要它：存档是**单一真相**，但写它的地方不止一个（原生 /buy 的 startCheckout、
 * 网页版付款回跳的 returnParams、另一个标签页的回跳）。轮询如果只在挂载时读一次，
 * 就会抱着旧单号一直查下去 —— 那正是「付了款还显示等待支付」的第二个成因。
 * 订阅后，任何一次写入都会让正在轮询的那一处重新读存档、必要时换单。
 */
type StoredOrderListener = () => void

const listeners = new Set<StoredOrderListener>()

const notifyStoredOrder = (): void => {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者出错不许影响写入方（写存档是主流程）
    }
  }
}

/**
 * 订阅存档变化：进程内写入（writeStoredOrder）+ 跨标签页写入（storage 事件）都算。
 * `win` 可注入（Node 单测传假 window）；不传就只订阅进程内通知。
 */
export const subscribeStoredOrder = (
  listener: StoredOrderListener,
  win?: { addEventListener?: (type: string, fn: (event: { key?: string | null }) => void) => void; removeEventListener?: (type: string, fn: (event: { key?: string | null }) => void) => void } | null
): (() => void) => {
  listeners.add(listener)
  const onStorage = (event: { key?: string | null }): void => {
    // key === null 是 localStorage.clear()：也当作存档可能变了
    if (event.key === undefined || event.key === null || event.key === ORDER_STORAGE_KEY) {
      listener()
    }
  }
  const canListen = typeof win?.addEventListener === 'function'
  if (canListen) {
    win?.addEventListener?.('storage', onStorage)
  }
  return () => {
    listeners.delete(listener)
    if (canListen) {
      win?.removeEventListener?.('storage', onStorage)
    }
  }
}
