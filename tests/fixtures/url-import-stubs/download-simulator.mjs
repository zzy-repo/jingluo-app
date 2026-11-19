// 原生下载模拟器：给 `url-import-stubs/nativeArchive.mjs` 提供行为。
//
// 为什么这样模拟：改成流式落盘之后（#34），JS 侧能看到的东西**只有**「已写入文件的字节数」
// 和「状态」。所以这里不再模拟 HTTP 分块响应，而是直接按假时钟推进一个字节计数——
// 恰恰就是 HistoryArchivePlugin 侧 `Download.bytes` 的语义。真实网络行为（Range、Content-Range、
// 建连失败）由 Java 侧负责，靠模拟器验收（模拟器上跑真服务器的用例见验收记录）。
//
// 一个模拟器实例的生命周期与一次导入一致：`start()` 之后用例推进假时钟，`progress()` 跟着变。

/** 临时文件路径：与 Java 侧 `cacheDir/import-<uuid>.part` 同形（用例里只当不透明字符串用）。 */
export const TEMP_PATH = '/data/user/0/com.example.deepseekchat/cache/import-test.part'

/**
 * @param {object} spec
 * @param {Uint8Array} [spec.source] 包体：`read()` 从这里取字节，默认 `total = source.length`
 * @param {number} [spec.bytesPerSecond] 推进速率（字节/秒，按假时钟算）；不传 = 永不推进
 * @param {number} [spec.bytesPerPoll] 改成「每次被问进度就推进这么多字节」——与墙钟无关，
 *   用来验证「墙钟跳变不得影响健康链路」（见 import-clock-monotonic 用例）
 * @param {(pollIndex: number) => void} [spec.onPoll] 每被问一次进度回调一次（可用来注入墙钟偏移）
 * @param {(requestIndex: number) => void} [spec.onRequest] 每被 start 一次回调一次
 * @param {number} [spec.stallAfter] 到这个字节就不再推进（模拟「真停滞」）
 * @param {number|null} [spec.total] 上报给 JS 的总量；`null` = 未知（服务端没给总量）
 * @param {number} [spec.completeAtBytes] 到这个字节就 `state=done`（默认 = total）
 * @param {'downloading'|'tooLarge'|'http'|'failed'} [spec.startState]
 * @param {number} [spec.declared] `tooLarge` 时声明出来的总量
 * @param {number} [spec.status] `http` 时的状态码
 * @param {string} [spec.body] `http` 时的错误体（OBS 的 XML）
 * @param {string} [spec.startError] `failed` 时的原生异常原文
 * @param {{ afterMs: number, error: string }} [spec.failAt] 开工若干毫秒后原生侧报错
 */
export const simulate = (spec) => {
  const {
    source,
    bytesPerSecond = 0,
    bytesPerPoll,
    onPoll,
    onRequest,
    stallAfter,
    total = source === undefined ? null : source.length,
    completeAtBytes,
    startState = 'downloading',
    declared,
    status,
    body = '',
    startError,
    failAt,
    path = TEMP_PATH,
  } = spec

  const limit = stallAfter ?? total ?? Number.POSITIVE_INFINITY
  const completeAt = completeAtBytes ?? total ?? Number.POSITIVE_INFINITY
  const startedAt = Date.now()

  /** 已经写进文件的字节数：只会增长（与 Java 侧的 `Download.bytes` 同语义）。 */
  let written = 0
  let finished = false
  const simulator = {
    /** 已经交给模拟器的请求参数（用例据此断言上限 / 超时被正确传下去） */
    requests: [],
    /** 模拟器「写盘」的总字节数：超限那条路径必须保持 0 */
    get served() {
      return written
    },
    /** 进度被问了几次：立刻失败的路径一次都不该问 */
    polls: 0,
    released: 0,
    discarded: 0,
    removed: [],
    reads: 0,

    start(request) {
      simulator.requests.push(request)
      onRequest?.(simulator.requests.length)
      if (startState === 'tooLarge') {
        return Promise.resolve({ state: 'tooLarge', declared })
      }
      if (startState === 'http') {
        return Promise.resolve({ state: 'http', status, body })
      }
      if (startState === 'failed') {
        return Promise.resolve({ state: 'failed', error: startError ?? 'java.io.IOException: boom' })
      }
      return Promise.resolve({
        state: 'downloading',
        path,
        bytes: 0,
        ...(total === null ? {} : { total }),
      })
    },

    progress() {
      simulator.polls += 1
      onPoll?.(simulator.polls)
      const elapsed = Date.now() - startedAt
      if (failAt !== undefined && elapsed >= failAt.afterMs) {
        return Promise.resolve({ state: 'failed', bytes: written, error: failAt.error })
      }
      if (!finished) {
        const grown = bytesPerPoll === undefined ? Math.floor((elapsed * bytesPerSecond) / 1000) : written + bytesPerPoll
        const target = Math.min(grown, limit)
        if (target > written) {
          written = target
        }
        if (written >= completeAt) {
          written = completeAt
          finished = true
        }
      }
      return Promise.resolve({
        state: finished ? 'done' : 'downloading',
        bytes: written,
        ...(total === null ? {} : { total }),
        ...(finished ? { path } : {}),
      })
    },

    release() {
      simulator.released += 1
      return Promise.resolve()
    },

    discard() {
      simulator.discarded += 1
      // 真实现是「返回前同步删掉」，这里等价地把字节归零，后面 read() 拿不到数据。
      written = 0
      return Promise.resolve()
    },

    remove(target) {
      simulator.removed.push(target)
      return Promise.resolve()
    },

    size() {
      return Promise.resolve(written === 0 ? -1 : written)
    },

    read(_path, offset, length) {
      simulator.reads += 1
      const bytes = source ?? new Uint8Array(0)
      return Promise.resolve(bytes.subarray(offset, offset + length))
    },
  }
  return simulator
}
