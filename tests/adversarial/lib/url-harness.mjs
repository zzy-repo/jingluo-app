// 「从链接导入」类用例的公共装置：
// 只替换 Capacitor 原生桥 / diagnostics / backup / errors（沿用 tests/fixtures/url-import-stubs），
// urlImport.ts 的真实代码（分块、重试、分类、心跳、预算、清理定时器）原样运行。
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../../src/services/chat/history/importLimit.ts', import.meta.url).href

let installed = false

export const installUrlHooks = () => {
  if (installed) {
    return
  }
  installed = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@capacitor/core') {
        return { url: stub('capacitor.mjs'), shortCircuit: true }
      }
      if (specifier === '../../diagnostics/collector.js') {
        return { url: stub('collector.mjs'), shortCircuit: true }
      }
      if (specifier === '../backup.js') {
        return { url: stub('backup.mjs'), shortCircuit: true }
      }
      if (specifier === './errors.js') {
        return { url: stub('errors.mjs'), shortCircuit: true }
      }
      if (specifier === './importLimit.js') {
        return { url: limitModule, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

export const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

/** 合法 ZIP 头 + 填充字节，长度真实。 */
export const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

export const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

export const rangeResponse = (source, from, to) => {
  const end = Math.min(to, source.length - 1)
  const slice = source.slice(from, end + 1)
  return {
    status: 206,
    url: URL_OK,
    headers: {
      'Content-Range': `bytes ${from}-${end}/${source.length}`,
      'Content-Length': String(slice.length),
    },
    data: slice.buffer,
  }
}

export const useNative = (get) => {
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}

/** 按 Range 回字节，每块固定延迟；onCall 用于在指定次数后做手脚（改时钟、断流）。 */
export const slowNative = (source, { delayMs = 0, failWhen, onCall } = {}) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    const attemptIndex = globalThis.__native.calls.length
    onCall?.({ from, to, attemptIndex })
    const failure = failWhen?.({ from, to, attemptIndex })
    const run = () => {
      if (failure) {
        throw failure
      }
      return rangeResponse(source, from, to)
    }
    if (delayMs === 0) {
      try {
        return Promise.resolve(run())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(run())
        } catch (error) {
          reject(error)
        }
      }, delayMs)
    })
  })

export const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

export const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)
export const events = (message) => globalThis.__log.events.filter((entry) => entry.message === message)

/** 跑一次导入：返回终态错误、耗时、trace（永不因为挂死而在用例里等超时）。 */
export const runUrlImport = async (importer, url, options = {}) => {
  const trace = []
  const startedAt = Date.now()
  const error = await importer(url, { onTrace: (entry) => trace.push(entry), ...options }).then(
    () => null,
    (reason) => reason
  )
  return { error, elapsed: Date.now() - startedAt, trace, key: error?.key ?? error?.name ?? null }
}
