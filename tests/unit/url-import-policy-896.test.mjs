// [layer: unit | 依赖: 无（纯 Node：不发请求） | 耗时: <2s]
//
// Issue #896 **3c-5**：`chat/history/urlImport.ts` 的下载失败 reason 表与 `data` 类对齐。
//
// ## 改前真有的「两份判定叠加」
//
// `recordDownloadFailure()` 写下 `retryable` 时走的是一个三元：
//   `isLogReason(reason) ? retryableFor(reason) : RETRYABLE_FAILURES.has(reason)`
// 也就是说：**同一个问题（这次失败还值不值得重试）由两张表分别回答**，
// 而 `RETRYABLE_FAILURES` 那份名单只能靠注释约束「只能缩不能涨」。
//
// 改后只有一条链：`reason → RequestFailureKind → retryableFailure()`（全仓唯一判据），
// 且导入链路明确属于 **`data` 类**（幂等下载）。
//
// ## 本文件钉两件事
//   R1 **口径逐格不变**：改前会走到的每一个 reason，改后的 `retryable` 与改前一致
//      （迁移不改行为；任何一格变了就是迁移踩了产品口径）；
//   R2 **平行名单已经不存在**：源码里没有 `RETRYABLE_FAILURES`、不再 import `retryableFor`。
//
//   node --test tests/unit/url-import-policy-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

// urlImport 这条链会读到 apiConfig / providers 的构建期注入值（`__API_ORIGIN__` 等），
// 单测里没有打包器，先给兜底（与 `request-class-policy-896` 同一套写法）。
globalThis.__API_ORIGIN__ ??= 'https://api.test.invalid'
globalThis.INTERNAL_BUILD ??= false
globalThis.__log ??= { records: [], events: [], actions: [] }

const { importDownloadRetryableOf } = await import('../../src/services/chat/history/urlImport.ts')
const { REASON } = await import('../../src/services/diagnostics/reasons.ts')
const { retryableFailure } = await import('../../src/services/net/failureKind.ts')
const { requestPolicyOf, canAutoRetry } = await import('../../src/services/net/requestPolicy.ts')

const codeOf = (path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/**
 * 改前会走到 `recordDownloadFailure()` 的每一个 reason，以及**改前的结论**。
 * 「改前的结论」是照抄旧实现算出来的（字典项走 `reasons.ts`，其余走旧名单），
 * 不是照抄新实现 —— 否则这个表什么也没证明。
 */
const BEFORE = {
  [REASON.timeout]: true,
  [REASON.stalled]: true,
  [REASON.deadline]: true,
  [REASON.network]: true,
  [REASON.offline]: true,
  [REASON.refused]: true,
  [REASON.empty]: true,
  [REASON.incomplete]: true,
  interrupted: true,
  unreachable: true,
  // 下面这些改前就是 false（不在任何一张「可重试」表里）
  signature: false,
  expired: false,
  forbidden: false,
  permanent: false,
  'not-zip': false,
  'http-404': false,
  'http-500': false,
}

test('[R1] 改前会走到的每一个 reason，改后结论逐格相等（迁移不改行为）', () => {
  for (const [reason, before] of Object.entries(BEFORE)) {
    assert.equal(
      importDownloadRetryableOf(reason),
      before,
      `${reason}：改前 retryable=${before}，改后变成 ${importDownloadRetryableOf(reason)}`
    )
  }
})

test('[R2] 平行名单已经删掉，判据只剩 `net/failureKind.ts` 一处', () => {
  const code = codeOf('../../src/services/chat/history/urlImport.ts')
  assert.equal(code.includes('RETRYABLE_FAILURES'), false, '旧的 RETRYABLE_FAILURES 名单必须删掉')
  assert.equal(code.includes('retryableFor'), false, '不许再 import 第二份判据（retryableFor）')
  assert.equal(
    code.includes("from '../../net/failureKind.js'"),
    true,
    '可重试性必须读全仓唯一判据'
  )
})

test('[R3] reason → 失败类型的映射与统一判据一致（不是另一套布尔表）', () => {
  // 逐档对照：等待类、连不上类、内容不完整、其余
  assert.equal(importDownloadRetryableOf(REASON.timeout), retryableFailure('timeout'))
  assert.equal(importDownloadRetryableOf(REASON.stalled), retryableFailure('timeout'))
  assert.equal(importDownloadRetryableOf('interrupted'), retryableFailure('timeout'))
  assert.equal(importDownloadRetryableOf(REASON.offline), retryableFailure('offline'))
  assert.equal(importDownloadRetryableOf('unreachable'), retryableFailure('offline'))
  assert.equal(importDownloadRetryableOf(REASON.empty), retryableFailure('empty'))
  assert.equal(importDownloadRetryableOf(REASON.incomplete), retryableFailure('empty'))
  assert.equal(importDownloadRetryableOf('signature'), retryableFailure('client4xx'))
  // 未知 reason 不许「默认可重试」：#313 的教训是别劝用户再点一次
  assert.equal(importDownloadRetryableOf('never-heard-of-this'), false)
})

test('[R4] 导入属于 data 类：允许分块自动补传，但不许重发整段（control 语义才谈「不重发」）', () => {
  // 分块补传读的是 data 类策略（幂等下载）
  assert.equal(canAutoRetry({ cls: 'data', failure: 'timeout', attempt: 0 }), true)
  assert.equal(canAutoRetry({ cls: 'data', failure: 'offline', attempt: 0 }), true)
  // 已经吐过内容就不补（data 与 stream 共用 requiresNoContent 这条）
  assert.equal(canAutoRetry({ cls: 'data', failure: 'timeout', attempt: 0, receivedContent: true }), false)
  assert.equal(requestPolicyOf('data').retry, 2, '补传上限沿用 #105 的通用档，没有被本单改掉')
})
