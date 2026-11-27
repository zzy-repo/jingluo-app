// 域 1（Issue #362 / #367）集成用例共用的夹具：
//   1) 在页面里注入「IndexedDB 读失败」的可控故障（不改源码，只在浏览器里改写读操作）；
//   2) 往 chat-demo 库里造历史会话（列表摘要 + 会话详情分开写，用来造「列表有、详情读不出来」）。
//
// 为什么在浏览器里注入而不是改 `src/`：
//   `db.loadSessionSummaries()` 走 `store.getAll()`、`db.loadSession()` 走 `store.get(id)`，
//   在这两个读操作上抛错就是「本机 IndexedDB 读不动」在真实运行时的形态；用例退出即消失，不污染源码。
//
// 故障只在显式开启后生效（策略放在 sessionStorage，**跨 reload 保留**）：
//   { store: 'sessionSummaries', op: 'getAll', times: 1 } → 下一次读列表失败一次，之后恢复正常；
//   { store: 'sessions', op: 'get', times: 1 }            → 下一次读单条详情失败一次。
// 按 **store + 读操作** 匹配，而不是「任意一次触及该 store 的事务」：
//   #909 之后，启动期摘要自愈（`protection/heal.ts` 的 `countSessions`）会在后台用 `getAll`
//   把 `sessions` 数一遍；它和「用户点开会话时那条 `get`」共用同一个 store、不同操作。
//   按事务匹配会把「下一次详情读失败」的配额扣在自愈的计数上（#933 的 F1-04 假红），
//   按操作匹配才等于「下一次详情读失败」。
export const FAULT_KEY = '__domain01_02_idb_fault'

/**
 * 交给 `page.addInitScript` 的自包含函数（必须自包含：Playwright 会把它序列化后注入每个文档）。
 * 必须在文档脚本之前执行，所以只能放在 addInitScript 里。
 */
export const installFaultPatch = () => {
  const KEY = '__domain01_02_idb_fault'
  const readPolicy = () => {
    try {
      return JSON.parse(window.sessionStorage.getItem(KEY) || 'null')
    } catch {
      return null
    }
  }
  /**
   * 文档是否已进入卸载 / 隐藏阶段（#933）。
   *
   * 故障配额存在 sessionStorage，**跨 reload 保留**，目的是让「下一次启动读」失败一次。
   * 但 #909 之后，旧文档在 `pagehide` / `visibilitychange(hidden)` 里会 fire-and-forget 地写一份快照
   * （`protectionFlushSnapshot`），它要读 `sessionSummaries` / `sessions` —— 于是这一次配额被
   * **即将销毁的旧文档**抢先用掉，新文档启动时故障已经是 `times: 0`，F1-03 / F1-04 全部「读成功」而假红。
   * 卸载阶段的读不属于「启动读」，既不该失败、也不该扣配额。
   */
  let leaving = false
  window.addEventListener('pagehide', () => (leaving = true), true)
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') {
        leaving = true
      }
    },
    true
  )
  /** 该次读操作是否要失败；返回 true 时已扣掉一次配额 */
  const shouldFail = (storeName, operation) => {
    if (leaving) {
      return false
    }
    const policy = readPolicy()
    if (!policy || !policy.store || policy.store !== storeName) {
      return false
    }
    if (policy.op !== undefined && policy.op !== operation) {
      return false
    }
    if (typeof policy.times === 'number') {
      if (policy.times <= 0) {
        return false
      }
      policy.times -= 1
      try {
        window.sessionStorage.setItem(KEY, JSON.stringify(policy))
      } catch {
        /* 配额满就当没扣 */
      }
    }
    return true
  }
  const simulatedFailure = (storeName, operation) => {
    // 与真实 IndexedDB 失败同形：DOMException（idb 的 Promise 会据此 reject）
    throw new DOMException(
      `simulated IndexedDB failure on ${storeName}.${operation}`,
      'UnknownError'
    )
  }
  const nativeGet = IDBObjectStore.prototype.get
  const nativeGetAll = IDBObjectStore.prototype.getAll
  IDBObjectStore.prototype.get = function (query) {
    if (shouldFail(this.name, 'get')) {
      simulatedFailure(this.name, 'get')
    }
    return nativeGet.call(this, query)
  }
  IDBObjectStore.prototype.getAll = function (...args) {
    if (shouldFail(this.name, 'getAll')) {
      simulatedFailure(this.name, 'getAll')
    }
    return nativeGetAll.apply(this, args)
  }
}

/** 开启 / 关闭故障（写 sessionStorage，reload 后仍生效） */
export const setFault = (page, fault) =>
  page.evaluate(
    ([key, value]) => {
      if (value === null) {
        window.sessionStorage.removeItem(key)
      } else {
        window.sessionStorage.setItem(key, JSON.stringify(value))
      }
    },
    [FAULT_KEY, fault ?? null]
  )

/**
 * 造历史会话。必须在 App 首次启动（`initChat` 已建库）之后调用：
 * 这里用不带版本号的 open，直接拿到 App 建好的库，不触发 upgrade。
 */
export const seedSessions = (page, entries) =>
  page.evaluate(async (list) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const db = await open()
    if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('sessionSummaries')) {
      db.close()
      throw new Error('chat-demo 库里缺少 sessions / sessionSummaries 存储，App 还没初始化完')
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      for (const entry of list) {
        // 只写摘要 = 「列表里看得见，但详情读不出来 / 已经丢了」（F1-04 的缺失分支）
        if (entry.session) {
          tx.objectStore('sessions').put(entry.session)
        }
        if (entry.summary) {
          tx.objectStore('sessionSummaries').put(entry.summary)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('种子事务被中止'))
    })
    db.close()
  }, entries)

/**
 * 删掉一条会话的**正文**、保留摘要 —— 造「列表里还有这一条，详情已经读不出来」。
 *
 * 必须在启动完成之后调用：`#909` 的摘要自愈（`protection/heal.ts`）会在启动时按 sessions
 * 重建一次摘要、并删掉「没有对应会话」的幽灵摘要；在启动前造孤儿摘要，会被自愈在首屏后清掉，
 * 用户根本没有机会点它（#933）。正文在启动后丢失是真实存在的情形（存储损坏 / 被系统清掉），
 * F1-04 要守的正是「这时给出可读错误 + 重试出口」。
 */
export const dropSessionDetail = (page, id) =>
  page.evaluate(async (sessionId) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const db = await open()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').delete(sessionId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('删除会话正文的事务被中止'))
    })
    db.close()
  }, id)

/** 一条「用户问 + 回答完」的会话，形状与 `store.saveSession` 落盘的一致 */
export const sessionEntry = ({ id, title, question, answer, at }) => ({
  session: {
    id,
    title,
    createdAt: at,
    updatedAt: at,
    // 故意**不写** rootMessageId：字段缺省表示「线性消息列表」，
    // 写成 null 会变成「空会话 / 没有根节点」，`getVisibleMessages` 于是返回空数组（消息一条都不渲染）。
    messages: [
      { id: `${id}-u`, role: 'user', content: question, files: [], createdAt: at },
      {
        id: `${id}-a`,
        role: 'assistant',
        createdAt: at + 1,
        model: 'deepseek-flash',
        thinking: false,
        search: false,
        prefix: true,
        status: 'done',
        blocks: [{ type: 'text', text: answer }],
      },
    ],
  },
  summary: { id, title, createdAt: at, updatedAt: at, fileIds: [] },
})

/**
 * 只有摘要、没有详情的会话（被清掉 / 没来得及落盘的形态）。
 *
 * #933 起没有用例再用它造 F1-04 的「详情已丢失」：`#909` 的启动期摘要自愈会把这种幽灵摘要
 * 当垃圾清掉，造在启动前的孤儿摘要根本活不到用户点击。留作夹具原语，将来若要验证「自愈之前的
 * 中间态」可以直接用；F1-04 现在走 `dropSessionDetail()`（启动后抽掉正文）。
 */
export const orphanSummary = ({ id, title, at }) => ({
  session: null,
  summary: { id, title, createdAt: at, updatedAt: at, fileIds: [] },
})
