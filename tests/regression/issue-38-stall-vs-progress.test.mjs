// [layer: regression | 依赖: 无（原生桥用替身，计时用真定时器） | Issue #38（关联 #9 / #41）]
//
// 回归对象：直链导入的**判死口径**——src/services/chat/history/urlImport.ts。
//
// 修复前症状（#38）：按"总耗时"判死，慢但在推进的链路（164MB 慢包）被当成卡死中止，
//   用户看到的是一句不明所以的失败；重试又从 0 开始。
// 修复后预期：只有"连续一段时间没有新字节"才算停滞——慢但在推进的下载必须跑完；
//   而总时间预算必须从下载开始算，不能被"每块都有进展"重置（否则无限续命）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') return { url: stub('capacitor.mjs'), shortCircuit: true }
    if (specifier === '../../diagnostics/collector.js') return { url: stub('collector.mjs'), shortCircuit: true }
    if (specifier === '../backup.js') return { url: stub('backup.mjs'), shortCircuit: true }
    if (specifier === './errors.js') return { url: stub('errors.mjs'), shortCircuit: true }
    if (specifier === './importLimit.js') return { url: limitModule, shortCircuit: true }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')

/** 合法 ZIP 头 + 填充，保证长度真实（urlImport 会校验 PK\x03\x04）。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) bytes[index] = index % 251
  return bytes
}

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(options.headers?.Range ?? ''))
  if (match === null) throw new Error(`意料之外的 Range：${options.headers?.Range}`)
  return { from: Number(match[1]), to: Number(match[2]) }
}

const rangeResponse = (url, source, from, to) => {
  const end = Math.min(to, source.length - 1)
  const slice = source.slice(from, end + 1)
  return {
    status: 206,
    url,
    headers: { 'Content-Range': `bytes ${from}-${end}/${source.length}`, 'Content-Length': String(slice.length) },
    data: slice.buffer,
  }
}

/** 每块都成功、但每块之前先等一会儿的链路（模拟慢但在推进）。 */
const slowButSteady = (source, delayMs) => async (options) => {
  const { from, to } = rangeOf(options)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return rangeResponse(options.url, source, from, to)
}

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
}

const run = async (url, get, options = {}) => {
  resetEnv()
  globalThis.__native = { native: true, calls: [], get }
  try {
    const count = await importHistoryFromUrl(url, options)
    return { count, error: null }
  } catch (error) {
    return { count: 0, error }
  }
}

test('#38 慢但在推进的下载不许判死（每块都有新字节 = 不是停滞）', async () => {
  const source = zipBytes(64 * 1024)
  const { count, error } = await run('https://obs.example.test/reg38-slow.zip', slowButSteady(source, 40), {
    downloadStallMs: 500,
  })
  assert.equal(error, null, `慢链路被误判成停滞：${error?.key ?? ''}`)
  assert.equal(count, 1)
  assert.equal(globalThis.__imported.length, 1, '下完必须真的交给导入流程')
})

test('#38 总时间预算从下载开始算，不会因为"一直有进展"被无限续命', async () => {
  const source = zipBytes(8 * 1024 * 1024)
  const { error } = await run('https://obs.example.test/reg38-budget.zip', slowButSteady(source, 50), {
    downloadMaxTotalMs: 300,
  })
  assert.ok(error !== null, '预算用完必须结束，而不是无限等下去')
  assert.match(String(error?.key), /Deadline/, `应报总时限而非网络错误，实际：${error?.key}`)
})
