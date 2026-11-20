// 消费侧（`src/services/consume/**`）L0 / 契约用例的共享装配 —— 只放「六份文件必须一模一样」的四件事：
//   ① 读**实测**响应体（`tests/fixtures/consume/*.json`，每份文件自带 `_meta` 采集记录）；
//   ② 把实测体包成 `ConsumeRawResponse`（content-type / 状态码取 `_meta` 里的真值，
//      纯文本那份（未知路径 404）走 `_raw_text_body`，**绝不 JSON.parse**）；
//   ③ 可编程假 transport（记录每次请求 → 断言「调用序列」，不只数次数）；
//   ④ 三种回应工厂（JSON / 纯文本 / 传输层失败）。
//
// 为什么不各抄一份：`check:test-duplication` 的 R1（逐字 ≥20 行）会把第 7 份样板当场判红；
// 而且「怎么读 fixture」一旦抄岔，两份用例就会对着不同的字节断言（历史上真发生过）。
//
// 本文件**不含任何断言**：断言全部留在各自的 `*.test.mjs`（一行 = 一条覆盖）。
// 它也不 import `src/**` —— `.js → .ts` 的解析钩子由各用例先 `installResolveHooks()` 装好再动态 import，
// 免得 helper 被静态加载时钩子还没生效（那是这套测试跑不起来的最常见原因）。
import './injected.mjs'

import { readFileSync } from 'node:fs'

/** `tests/fixtures/consume/` —— 2026-11-20 从 sub2api 实例只读探测抓到的**真实**响应体 */
const DIR = new URL('../fixtures/consume/', import.meta.url)

/** 读一份实测 fixture：`{meta, body, file}`（`body` 去掉 `_meta` / `_note` / `_raw_text_body` 这类说明键） */
export const loadFixture = (name) => {
  const file = JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))
  const meta = file._meta ?? {}
  const body = {}
  for (const [key, value] of Object.entries(file)) {
    if (!key.startsWith('_')) {body[key] = value}
  }
  return { meta, body, file }
}

/**
 * 实测体 → `ConsumeRawResponse`。
 * 纯文本响应（未知路径 404 / 边缘反代 401）按 `_meta.content_type` 判定，`json` 一律 `null`
 * —— 与生产路径一致（`http.ts` 先看 content-type 再决定要不要 parse）。
 */
export const rawFromFixture = (name, overrides = {}) => {
  const { meta, body, file } = loadFixture(name)
  const status = overrides.status ?? meta.http_status ?? 200
  const contentType = overrides.contentType ?? meta.content_type ?? 'application/json'
  const nonJson = typeof meta.content_type === 'string' && meta.content_type.includes('text')
  const text = overrides.text ?? (nonJson ? String(file._raw_text_body ?? '') : JSON.stringify(body))
  return {
    status,
    ok: status >= 200 && status < 300,
    text,
    json: overrides.json !== undefined ? overrides.json : nonJson ? null : body,
    headers: overrides.headers ?? {},
    contentType,
  }
}

/** 手搓 JSON 响应（`_meta` 里没采到的组合，例如 admin 侧 401 的 message 变体） */
export const jsonRaw = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: JSON.stringify(body),
  json: body,
  headers,
  contentType: 'application/json',
})

/** 纯文本响应（HTML 502 页 / `404 page not found` / `authentication required`） */
export const textRaw = (status, text, contentType = 'text/plain') => ({
  status,
  ok: status >= 200 && status < 300,
  text,
  json: null,
  headers: { 'content-type': contentType },
  contentType,
})

/** 传输层失败（`status === 0`）：超时 / 连不上 / 非原生平台 */
export const failureRaw = (failure = 'timeout') => ({
  status: 0,
  ok: false,
  text: '',
  json: null,
  headers: {},
  contentType: '',
  failure,
})

/** 传输层回应：面板成功信封 `{code:0,message,data}` */
export const panelOk = (data, status = 200) => ({
  kind: 'response',
  status,
  text: JSON.stringify({ code: 0, message: 'success', data }),
  headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 传输层回应：任意 JSON 体（错误信封 / 网关扁平体） */
export const jsonReply = (status, body) => ({
  kind: 'response',
  status,
  text: JSON.stringify(body),
  headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 传输层回应：纯文本体（**不是** JSON） */
export const textReply = (status, text, contentType = 'text/plain') => ({
  kind: 'response',
  status,
  text,
  headers: { 'content-type': contentType },
})

/** 绝对 URL → 路径 + 查询（断言「打的是哪个端点」时不受注入 base 影响） */
export const pathOf = (url) => url.replace(/^https?:\/\/[^/]+/, '')

/**
 * 可编程假 transport：`handler(request)` 决定这次回什么，同时把请求按顺序记进 `calls`。
 *   · `sequence()` → `['POST /api/v1/redeem', 'GET /api/v1/redeem/history']`（**顺序**断言用）
 *   · `countOf('POST')` → 次数断言用
 * 契约 C11 要求「第二次 POST 之前一定有一次 history 查询」，只数次数是证明不了的，所以两个都给。
 */
export const recordingTransport = (handler) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof handler === 'function' ? handler(request) : handler
  }
  return {
    calls,
    transport,
    sequence: () => calls.map((request) => `${request.method} ${pathOf(request.url).split('?')[0]}`),
    countOf: (method) => calls.filter((request) => request.method === method).length,
  }
}
