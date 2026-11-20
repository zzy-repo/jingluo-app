// 采集层替身（域 8/9 单测共用）：让只依赖「写出入口」的模块在纯 Node 里可测。
//
// 为什么单独一份而不是复用 tests/fixtures/chat-stubs/collector.mjs：
// 那份只有写入口（record / recordAction / captureStateSnapshot），而域 8/9 的用例还要
// **喂**快照（N1 的整份导出、N4 的日志自检表），所以这里额外提供可注入的读入口。
// 真正的 collector 依赖 DOM + IndexedDB，单测不该为了读一个快照把浏览器拖进来。
const store = () => globalThis.__log

/** N1 用：导出层的入参由用例自己构造，读快照一律返回空（导出边界不读快照） */
export const emptySnapshot = () => ({
  schemaVersion: 1,
  app: { version: '1.4.0-beta.10', versionCode: 17, platform: 'android', buildType: 'standard' },
  device: {},
  client: { clientId: 'stub-client', sessionId: 'stub-session' },
  logs: [],
})

/** N4 用：由用例设置 `globalThis.__snapshot` 决定 `getSnapshot()` 返回什么 */
export const getSnapshot = () => globalThis.__snapshot ?? emptySnapshot()
export const getLogCount = () => getSnapshot().logs.length
export const getActionTrail = () => globalThis.__actions ?? []

export const record = (kind, level, message, fields = {}) => {
  store().records.push({ kind, level, message, fields })
}

export const recordEvent = (kind, message, fields = {}) => {
  store().events.push({ kind, message, fields })
}

export const recordAction = (kind, action, fields = {}) => {
  store().actions.push({ kind, action, fields })
}

export const errorMeta = (error) => ({
  'error.name': error instanceof Error ? error.name : typeof error,
  'error.msg': error instanceof Error ? error.message : String(error),
})

/** N4 的 `validatePayload` 在缺 state_snapshot 时会补一条：返回的 entry 必须能被断言 */
export const captureStateSnapshot = async (reason = 'auto') => ({
  t: Date.now(),
  kind: 'state_snapshot',
  level: 'info',
  msg: `snapshot:${reason}`,
})

export const flushLogs = async () => {}
export const initCollector = async () => {}
export const clearLogs = async () => {}
export const captureUiNotice = () => {}
export const readNetworkStatus = () => ({ onLine: true, effectiveType: '4g', downlink: 10, rtt: 50, saveData: false })
export const readRenderedNotice = () => null
export const recordError = () => {}
export const recordUserAction = () => {}
export const captureStateSnapshotSync = () => {}
export const setSnapshotFactsProvider = () => {}
export const redact = (text) => text
export const redactHost = (value) => value
export const redactUrl = (value) => value
