/**
 * 域 6+7 用例共用的假传输与「表驱动」小工具。
 *
 * 只做两件事：把服务端响应写成一行（`json(200, {...})`），以及把每次请求压成
 * `'POST /redeem-card'` 这种可断言的形状 —— 用例里的期望因此能写成一张表。
 */

export const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

export const rawText = (status, text) => ({ kind: 'response', status, text })

export const timeout = () => ({ kind: 'timeout' })

export const network = () => ({ kind: 'network' })

/**
 * 假传输：按顺序消费 `responses`（最后一条会一直复用），同时记录真实发出的请求。
 *
 * 断言对象永远是「服务层真发出去的请求」：method / path / headers / body 都是真的，
 * 只有「服务端怎么回」是假数据 —— 这也是本域禁止打真实生产服务时的口径。
 */
export const createRecorder = (responses = []) => {
  const queue = [...responses]
  const requests = []
  const transport = async (request) => {
    requests.push(request)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (typeof next === 'function') {
      return next(request)
    }
    if (next === undefined) {
      throw new Error(`没有为 ${request.method} ${request.url} 准备响应`)
    }
    return next
  }
  return {
    transport,
    requests,
    /** `['POST /redeem-card', …]`：只保留 path，断言不受 baseUrl 变化影响 */
    get paths() {
      return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)
    },
    get last() {
      return requests.at(-1)
    },
    /** 最后一个请求的 body（JSON 已解析） */
    get lastBody() {
      return requests.at(-1)?.body ? JSON.parse(requests.at(-1).body) : null
    },
  }
}

/** 内存 localStorage：`services/**` 里的存储入口在没有 DOM 时也能真跑 */
export const createMemoryStorage = (seed = {}) => {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    dump: () => Object.fromEntries(store),
  }
}
