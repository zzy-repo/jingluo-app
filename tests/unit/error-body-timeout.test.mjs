// [layer: unit | dependencies: none | no build, browser, network or Android]
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installChatEnv, installEndpointsGlobals } from '../helpers/dom-env.mjs'

installChatEnv()
installEndpointsGlobals({ apiOrigin: 'https://api.test.invalid', internalBuild: true })
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const client = await import('../../src/services/api/client.ts')
const { LIMITS } = await import('../../src/services/limits.ts')
const config = await import('../../src/services/api/apiConfig.ts')
const { isRetryableApiError } = await import('../../src/services/api/errors.ts')
const originalFetch = globalThis.fetch
const originalBodyMs = LIMITS.requestTimeouts.errorBodyMs
LIMITS.requestTimeouts.errorBodyMs = 40
const encoder = new TextEncoder()

test.after(() => {
  globalThis.fetch = originalFetch
  LIMITS.requestTimeouts.errorBodyMs = originalBodyMs
})

function hangingResponse({
  status = 502,
  contentType = 'application/json',
  text = '',
  trickle = false,
} = {}) {
  let bodyController
  let timer
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      bodyController = controller
      if (text) controller.enqueue(encoder.encode(text))
      if (trickle) timer = setInterval(() => controller.enqueue(encoder.encode(' ')), 5)
    },
    cancel() {
      cancelled = true
      clearInterval(timer)
    },
  })
  return {
    response: new Response(stream, { status, headers: { 'Content-Type': contentType } }),
    get cancelled() {
      return cancelled
    },
    cleanup() {
      clearInterval(timer)
      if (!cancelled) bodyController.close()
    },
  }
}

async function failureWithinBudget(promise, fixture) {
  let guard
  try {
    const outcome = await Promise.race([
      promise.then(
        () => ({ resolved: true }),
        (error) => ({ error })
      ),
      new Promise((resolve) => {
        guard = setTimeout(() => resolve({ pending: true }), 250)
      }),
    ])
    assert.equal(outcome.pending, undefined, 'error body must settle within its total budget')
    assert.ok(
      outcome.error instanceof client.ApiError,
      `preserve API error classification: ${outcome.error?.stack}`
    )
    return outcome.error
  } finally {
    clearTimeout(guard)
    fixture.cleanup()
  }
}

const request = (signal) =>
  client.request('https://api.test.invalid/v1/chat/completions', { signal })
const collect = async (generator) => {
  for await (const _event of generator) {
    /* consume stream */
  }
}

test('502 with unfinished body times out, cancels reading and remains retryable HTTP 502', async () => {
  const fixture = hangingResponse({ text: '{"error":' })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.kind, 'http')
  assert.equal(error.status, 502)
  assert.equal(isRetryableApiError(error), true)
  assert.equal(fixture.cancelled, true)
  assert.match(error.detail, /timeout/)
})

test('complete JSON without EOF still preserves upstream message and code', async () => {
  const fixture = hangingResponse({
    text: '{"error":{"message":"Upstream overloaded","code":"overloaded"}}',
  })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.message, 'Upstream overloaded')
  assert.equal(error.upstreamCode, 'overloaded')
  assert.match(error.detail, /timeout/)
})

test('continuous error-body bytes cannot extend the total deadline', async () => {
  const fixture = hangingResponse({ trickle: true })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.status, 502)
  assert.match(error.detail, /timeout/)
  assert.equal(fixture.cancelled, true)
})

test('unfinished HTML retains the existing HTML protocol error', async () => {
  const fixture = hangingResponse({ status: 200, contentType: 'text/html', text: '<html>gateway' })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.kind, 'protocol')
  assert.equal(error.code, 'upstream_returned_html')
  assert.match(error.detail, /content-type: text\/html/)
  assert.match(error.detail, /timeout/)
})

for (const provider of ['openai', 'anthropic']) {
  test(`200 non-SSE body is bounded for ${provider}`, async () => {
    config.setProviderKind(provider)
    config.setBaseUrl('https://api.test.invalid')
    config.setModel('test-model')
    const fixture = hangingResponse({ status: 200, text: '{"error":' })
    globalThis.fetch = async () => fixture.response
    const error = await failureWithinBudget(
      collect(
        client.streamMessage(
          'sk-test',
          {
            model: 'test-model',
            system: '',
            messages: [],
            thinking: { type: 'disabled' },
            max_tokens: 100,
          },
          new AbortController().signal
        )
      ),
      fixture
    )
    assert.equal(error.kind, 'protocol')
    assert.equal(error.status, 200)
    assert.equal(fixture.cancelled, true)
  })
}

test('caller abort wins even when body.read itself ignores the fetch signal', async () => {
  const fixture = hangingResponse()
  globalThis.fetch = async () => fixture.response
  const controller = new AbortController()
  const reason = new DOMException('User stopped', 'AbortError')
  const pending = request(controller.signal).then(
    () => null,
    (error) => error
  )
  setTimeout(() => controller.abort(reason), 5)
  let guard
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        guard = setTimeout(() => resolve('still pending'), 200)
      }),
    ])
    assert.equal(result, reason)
    assert.equal(fixture.cancelled, true)
  } finally {
    clearTimeout(guard)
    fixture.cleanup()
  }
})

test('normal short errors keep their message, machine code and status', async () => {
  globalThis.fetch = async () =>
    new Response('{"error":{"message":"Invalid model","code":"model_not_found"}}', { status: 400 })
  await assert.rejects(request(), (error) => {
    assert.equal(error.message, 'Invalid model')
    assert.equal(error.upstreamCode, 'model_not_found')
    assert.equal(error.status, 400)
    return true
  })
})

test('a single oversize chunk is capped before decoding, without broken UTF-8', async () => {
  const { readErrorBody } = await import('../../src/services/api/errorBody.ts')
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('鲸'.repeat(50_000)))
      },
      cancel() {
        cancelled = true
      },
    })
  )
  const result = await readErrorBody(response)
  assert.equal(result.reason, 'size_limit')
  assert.equal(result.retainedBytes, 64 * 1024)
  assert.ok(encoder.encode(result.text).byteLength <= 64 * 1024)
  assert.equal(result.text.includes('\uFFFD'), false)
  assert.equal(cancelled, true)
  assert.equal(response.body.locked, false)
})

test('already-aborted signals reject before acquiring a reader', async () => {
  const { readErrorBody } = await import('../../src/services/api/errorBody.ts')
  const controller = new AbortController()
  controller.abort()
  const response = new Response('unused')
  await assert.rejects(
    readErrorBody(response, { signal: controller.signal }),
    (error) => error === controller.signal.reason
  )
  assert.equal(response.body.locked, false)
})

test('bounded reading never waits for a stuck cancel promise', async () => {
  const { readErrorBody } = await import('../../src/services/api/errorBody.ts')
  const response = new Response(
    new ReadableStream({
      start() {},
      cancel() {
        return new Promise(() => {})
      },
    })
  )
  const result = await readErrorBody(response)
  assert.equal(result.reason, 'timeout')
  assert.equal(response.body.locked, false)
})

test('complete JSON at the byte cap is still parsed and diagnostics stay short', async () => {
  const payload = JSON.stringify({
    error: { message: 'Overloaded', code: 'overloaded' },
    padding: 'x'.repeat(100_000),
  })
  const fixture = hangingResponse({ text: payload })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.localMessage.key, 'upstreamErrorBodyIncomplete')
  assert.ok(error.detail.length < 600)
  assert.match(error.detail, /size_limit/)
  const complete = '{"error":{"message":"Overloaded","code":"overloaded"}}'
  const padded = hangingResponse({ text: complete + ' '.repeat(100_000) })
  globalThis.fetch = async () => padded.response
  const parsed = await failureWithinBudget(request(), padded)
  assert.equal(parsed.message, 'Overloaded')
  assert.equal(parsed.upstreamCode, 'overloaded')
})

test('HTML uses its smaller byte limit and keeps a bounded diagnostic snippet', async () => {
  const fixture = hangingResponse({
    status: 200,
    contentType: 'text/html',
    text: '<html>' + 'x'.repeat(10_000),
  })
  globalThis.fetch = async () => fixture.response
  const error = await failureWithinBudget(request(), fixture)
  assert.equal(error.code, 'upstream_returned_html')
  assert.match(error.detail, /retainedBytes=4096/)
  assert.ok(error.detail.length < 400)
})

test('a network read failure is distinct from user abort and preserves valid JSON', async () => {
  const { readErrorBody } = await import('../../src/services/api/errorBody.ts')
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":{"message":"failed"}}'))
        setTimeout(() => controller.error(new TypeError('network disconnected')), 5)
      },
    })
  )
  const result = await readErrorBody(response)
  assert.equal(result.reason, 'read_error')
  assert.equal(JSON.parse(result.text).error.message, 'failed')
  assert.equal(response.body.locked, false)
})
