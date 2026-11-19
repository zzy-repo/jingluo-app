// [layer: unit | 纯 Node（undici 的 Response / ReadableStream），无浏览器无网络 | 耗时: <1s]
// GitHub issue #211「readBytesOf 靠 Number('') === 0 巧合避开 clone().text()」的回归用例。
//
// 两个独立缺陷，本文件各用一组断言钉住：
//
//  A 缺 Content-Length 时 bytes 恒为 0：`headers.get()` 返回 null，`?? ''` → `Number('') === 0`
//    （空串不是 NaN），`Number.isFinite(0) && 0 >= 0` 成立 → 直接 return 0。于是 chunked 响应的
//    `net_response.bytes` 全是 0，「0 字节」和「量不出来」被合成同一个值。
//
//  B 谁把 A 修「对」了，`response.clone().text()` 就会把流式响应读到关闭才 resolve —— 而
//    `collector.ts:950` 是 await 之后才把 response 交还调用方，等于把 SSE 首字节推迟到回答结束。
//    所以修复必须按 Content-Type 判定：流式响应直接放弃精确体积（报「不可测」），不碰 body。
//
// 断言分四块：
//   ① 无 Content-Length 的普通响应 → 真实 UTF-8 字节数（红：恒为 0）
//   ② 有 Content-Length 时按声明值取（老行为，不许放宽）
//   ③ Content-Length 是空串 / 非数字 / 负数 → 视为缺失（空串不许当 0）
//   ④ text/event-stream → 报「不可测」、一次都不 clone、立刻返回（不阻塞）
//   ⑤ 对照实验：同一条流上直接 clone().text() 确实会等到流关闭 —— ④ 的取舍不是臆测
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const collector = await import('../../src/services/diagnostics/collector.ts')
const { readBytesOf } = collector
/** `bytes` 的「不可测」取值（0 表示真的零字节，两者不许混） */
const UNMEASURABLE = collector.BYTES_UNMEASURABLE
/** 「立刻返回」的判定上限：正常应 <5ms，200ms 足够区分「立刻」与「等流关闭」 */
const IMMEDIATE_MS = 200

const utf8 = new TextEncoder()
const bytesOf = (text) => utf8.encode(text).length

/** 没有 Content-Length 的普通响应（chunked 场景的最小复现） */
const plainResponse = (body, contentType = 'application/json') =>
  new Response(body, { headers: { 'content-type': contentType } })

/** 一条「没人关就一直挂着」的流式响应（SSE 的最小复现）：分块能推、真能推完就不关 */
const streamingResponse = (contentType = 'text/event-stream') => {
  let controller
  const body = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const response = new Response(body, { headers: { 'content-type': contentType } })
  return {
    response,
    push: (chunk) => controller.enqueue(utf8.encode(chunk)),
    close: () => controller.close(),
  }
}

/** 给真实 Response 套一层 clone() 计数器（其余字段透传） */
const withCloneSpy = (response) => {
  const spy = { calls: 0 }
  const realClone = response.clone.bind(response)
  const proxy = {
    headers: response.headers,
    body: response.body,
    clone: () => {
      spy.calls += 1
      return realClone()
    },
  }
  return { proxy, spy }
}

const raceWithTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms))])

assert.equal(typeof readBytesOf, 'function', 'readBytesOf 应可被单测直接调用')

test('① 无 Content-Length 的普通响应：bytes 是真实字节数，不是 0', async () => {
  // 带中文：按 UTF-8 字节算（字符数 != 字节数），能区分「算错了」和「没算」
  const body = '{"msg":"诊断体积","n":1}'
  const response = plainResponse(body)
  assert.equal(
    response.headers.get('Content-Length'),
    null,
    '前置条件：这个响应确实没有 Content-Length（chunked / 无声明体积）'
  )
  const bytes = await readBytesOf(response)
  console.log(
    `  · 无 Content-Length + application/json → bytes=${bytes}；期望 ${bytesOf(body)} 字节（UTF-8；字符数 ${body.length}）`
  )
  assert.equal(bytes, bytesOf(body), `bytes 应为真实 UTF-8 字节数 ${bytesOf(body)}，实际 ${bytes}`)
  assert.notEqual(bytes, 0, 'bytes=0 是「确实是零字节」；「量不出来」不许伪装成 0')
})

test('② 有 Content-Length 时按声明值取（老行为不许放宽）', async () => {
  const response = new Response('hello', {
    headers: { 'content-type': 'text/plain', 'content-length': '512' },
  })
  const bytes = await readBytesOf(response)
  console.log(`  · Content-Length: 512（body 5 字节）→ bytes=${bytes}`)
  assert.equal(bytes, 512, '有 Content-Length 时应直接采信声明值，不去读 body')
})

test('③ Content-Length 空串 / 非数字 / 负数 → 视为缺失，走实测', async () => {
  const body = '{"ok":true}'
  for (const raw of ['', '   ', 'abc', '-1']) {
    const response = new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': raw },
    })
    const bytes = await readBytesOf(response)
    console.log(`  · Content-Length=${JSON.stringify(raw)} → bytes=${bytes}（期望 ${bytesOf(body)}）`)
    assert.equal(bytes, bytesOf(body), `Content-Length=${JSON.stringify(raw)} 应视为缺失，实际 ${bytes}`)
  }
})

test('④ text/event-stream：报「不可测」、不 clone、立刻返回（不阻塞流）', async () => {
  const stream = streamingResponse()
  stream.push('data: 第一块\n\n')
  const { proxy, spy } = withCloneSpy(stream.response)
  const startedAt = Date.now()
  const pending = readBytesOf(proxy)
  const raced = await raceWithTimeout(pending, IMMEDIATE_MS)
  const elapsed = Date.now() - startedAt
  console.log(
    `  · text/event-stream（流未关闭）→ bytes=${JSON.stringify(raced === 'TIMEOUT' ? pending : raced)}，耗时 ${elapsed}ms，clone 调用 ${spy.calls} 次`
  )
  assert.notEqual(raced, 'TIMEOUT', `流式响应把读取卡住了：${IMMEDIATE_MS}ms 内没返回（等症状见 ⑤）`)
  assert.equal(spy.calls, 0, 'streaming 响应一次都不该 clone：clone().text() 要等整条流关闭才 resolve')
  assert.equal(raced, UNMEASURABLE, `流式响应的 bytes 应明确报「不可测」，实际 ${JSON.stringify(raced)}`)
  stream.close()
  await pending.catch(() => {})
})

test('④b text/event-stream 带 charset 参数也按类型判定（不被参数骗）', async () => {
  const stream = streamingResponse('text/event-stream; charset=utf-8')
  stream.push('data: x\n\n')
  const { proxy, spy } = withCloneSpy(stream.response)
  const pending = readBytesOf(proxy)
  const raced = await raceWithTimeout(pending, IMMEDIATE_MS)
  console.log(`  · ${stream.response.headers.get('content-type')} → bytes=${JSON.stringify(raced)}，clone ${spy.calls} 次`)
  assert.equal(spy.calls, 0, 'media type 判定要去掉参数：text/event-stream; charset=utf-8 仍是流')
  assert.equal(raced, UNMEASURABLE, `期望「不可测」，实际 ${JSON.stringify(raced)}`)
  stream.close()
  await pending.catch(() => {})
})

test('⑤ 对照：直接在流式响应上 clone().text() 会一直等到流关闭（④ 的取舍依据）', async () => {
  const stream = streamingResponse()
  stream.push('data: 第一块\n\n')
  const cloned = stream.response.clone().text()
  const raced = await raceWithTimeout(cloned.then(() => 'RESOLVED'), IMMEDIATE_MS)
  console.log(`  · 分块已到、流未关闭 → clone().text() 在 ${IMMEDIATE_MS}ms 内 ${raced}`)
  assert.equal(raced, 'TIMEOUT', '若这里能立刻 resolve，④ 的「放弃精确字节数」就没有必要了')
  stream.close()
  await cloned.catch(() => {})
})
