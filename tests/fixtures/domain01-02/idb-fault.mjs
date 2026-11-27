// 域 1（Issue #362 / #367）集成用例共用的夹具：
//   1) 在页面里注入「IndexedDB 读失败」的可控故障（不改源码，只在浏览器里改写 IDBDatabase.prototype.transaction）；
//   2) 往 chat-demo 库里造历史会话（列表摘要 + 会话详情分开写，用来造「列表有、详情读不出来」）。
//
// 为什么在浏览器里注入而不是改 `src/`：
//   `db.loadSessionSummaries()` / `db.loadSession()` 最终都落到 `db.transaction(...)`，
//   在这里抛错就是「本机 IndexedDB 读不动」在真实运行时的形态；用例退出即消失，不污染源码。
//
// 故障只在显式开启后生效（策略放在 sessionStorage，**跨 reload 保留**）：
//   { store: 'sessionSummaries', times: 1 } → 下一次读列表失败一次，之后恢复正常（用来验「重试真的重读」）。
// 只按 store 名匹配：`sessionSummaries` = 会话列表读，`sessions` = 单条会话详情读，
// 两条链路互不影响，正好对上 F1-03 / F1-04 两条功能点。
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
  /** 该次 transaction 是否要失败；返回 true 时已扣掉一次配额 */
  const shouldFail = (storeNames) => {
    const policy = readPolicy()
    if (!policy || !policy.store) {
      return false
    }
    const list = Array.isArray(storeNames) ? storeNames : [storeNames]
    if (!list.includes(policy.store)) {
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
  const nativeTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
    if (shouldFail(storeNames)) {
      // 与真实 IndexedDB 失败同形：DOMException（idb 的 Promise 会据此 reject）
      throw new DOMException(
        `simulated IndexedDB failure while opening a transaction on ${String(storeNames)}`,
        'UnknownError'
      )
    }
    return nativeTransaction.call(this, storeNames, mode, options)
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

/** 只有摘要、没有详情的会话（被清掉 / 没来得及落盘的形态） */
export const orphanSummary = ({ id, title, at }) => ({
  session: null,
  summary: { id, title, createdAt: at, updatedAt: at, fileIds: [] },
})
