// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #275：超时 / 限量 / 阈值收敛到单一配置（src/services/limits.ts）。
//
// 本单只搬位置、不改数值，所以这里的断言分四组：
// 1. [硬表] LIMITS 逐项等于迁移前的原值 —— 表里的期望值是**手写的原始字面量**，
//    故意不引用 LIMITS 自己，任何数字被改动、或新增一项没登记，都会红；
// 2. [零改动] 各调用方原来的导出名还在，且值就是 LIMITS 里的那一项（调用方不需要改 import）；
// 3. [可查] 每个 LIMITS 叶子都被生产代码引用（避免「表里写了一个没人用的值」），
//    `bootDeadlineMs` / `importMaxBytes` 两项豁免，各自的单一来源见断言里的说明；
// 4. [关系] 导入上限与导入总预算之间的不等式（#152 / #275）成了断言：
//    上限 200MB ÷ 总时限 1800s ≈ 114KB/s 必须 ≥ 最低可接受带宽，单独调其中一个就会红。
//
// 另外把三个「无生产调用者」的 setter 各验一次「调用后生效值真的变了」（#275 负向 3）：
// 本单不删它们（删 = 行为变更），但至少不能是「看起来可配置、改了没反应」。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import。
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false

const { LIMITS, MIN_ACCEPTABLE_BYTES_PER_SEC, isImportBudgetConsistent } = await import(
  '../../src/services/limits.ts'
)
const client = await import('../../src/services/api/client.ts')
const contextBudget = await import('../../src/services/chat/contextBudget.ts')
const store = await import('../../src/services/chat/store.ts')
const autoTitle = await import('../../src/services/chat/autoTitle.ts')
const autoTitleQueue = await import('../../src/services/chat/autoTitleQueue.ts')
const attachments = await import('../../src/services/attachments.ts')
const importLimit = await import('../../src/services/chat/history/importLimit.ts')

/**
 * 迁移前的原值（`origin/main` = 59e13c2 时的裸字面量，逐个人工抄下来）。
 * 这是本单唯一允许「重新写一遍数字」的地方：它的作用就是证明搬家前后一模一样。
 */
const ORIGINAL_VALUES = {
  requestTimeoutMs: 15000,
  streamIdleTimeoutMs: 45000,
  streamRetryLimit: 2,
  retryBaseDelayMs: 1000,
  contextBudget: { maxTokens: 120_000, maxRounds: 200 },
  importMaxBytes: 200 * 1024 * 1024,
  importConnectMs: 10_000,
  importChunkReadMs: 12_000,
  importStallMs: 40_000,
  importMaxTotalMs: 30 * 60_000,
  importHeartbeatMs: 5_000,
  clockJumpMs: 2 * 60_000,
  autoTitle: { timeoutMs: 8000, maxOutputTokens: 32, maxInputBytes: 2048, concurrency: 2, maxQueue: 6 },
  attachments: {
    maxSizeMb: 64,
    maxUserDataSizeMb: 32,
    maxCount: 50,
    maxConcurrent: 3,
    /**
     * #562：「附件/内容限制只有一份」—— #480 写在 `attachments/limits.ts` 的
     * `ATTACHMENT_LIMITS` 搬进了 `LIMITS.attachments.doc`（**值一个没改**）。
     * 手抄一份的作用就是证明搬家前后一模一样；那个文件已经改成逐字段转出。
     */
    doc: {
      txtMaxBytes: 5 * 1024 * 1024,
      docxMaxBytes: 20 * 1024 * 1024,
      pdfMaxBytes: 50 * 1024 * 1024,
      maxExtractedChars: 400_000,
      docBudgetTokens: 32_000,
      minInjectableChars: 200,
      maxFilesPerMessage: 10,
      maxZipEntries: 2000,
      maxZipUncompressedBytes: 100 * 1024 * 1024,
      pdfMinCharsPerPage: 20,
    },
  },
  /**
   * #551 新增的一组（不是「搬家」的那批数字）：图片内联通路的阈值，取值依据 `ref-vision.md` 5.3。
   * 手写一遍是为了让「改了阈值必须同时改这里」，别让这组数字悄悄漂。
   */
  images: {
    maxEdge: 1568,
    maxPixels: 1_150_000,
    passThroughBytes: Math.round(3.5 * 1024 * 1024),
    webpQuality: 0.85,
    jpegFallbackQuality: 0.9,
    maxSourceBytes: 16 * 1024 * 1024,
    maxEncodedBytes: 5 * 1024 * 1024,
    maxCanvasArea: 4096 * 4096,
    maxCount: 20,
    maxTotalBytes: 20 * 1024 * 1024,
    cacheEntries: 24,
    maxHeadBytes: 262_144,
  },
  bootDeadlineMs: 12000,
}

/** LIMITS 的叶子（点分路径），用于「每项都有人用」的检查 */
const leaves = (value, prefix = '') =>
  Object.entries(value).flatMap(([key, item]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return typeof item === 'object' && item !== null ? leaves(item, next) : [next]
  })

/** 生产代码全文（不含 limits.ts 自己）：引用检查用 */
const readSrcText = () => {
  const out = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, name.name)
      if (name.isDirectory()) walk(abs)
      else if (/\.(ts|tsx|html)$/.test(name.name) && abs !== path.join(ROOT, 'src/services/limits.ts')) {
        out.push(fs.readFileSync(abs, 'utf8'))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return out.join('\n')
}

test('LIMITS 逐项等于迁移前的原值（只搬位置、数值一个不许变）', () => {
  assert.deepEqual(LIMITS, ORIGINAL_VALUES)
})

test('调用方原导出名不变，且值就是 LIMITS 里的那一项（调用方零改动）', () => {
  assert.equal(client.DEFAULT_REQUEST_TIMEOUT_MS, LIMITS.requestTimeoutMs)
  assert.equal(client.STREAM_IDLE_TIMEOUT_MS, LIMITS.streamIdleTimeoutMs)
  assert.equal(store.STREAM_RETRY_LIMIT, LIMITS.streamRetryLimit)
  assert.deepEqual(contextBudget.DEFAULT_CONTEXT_BUDGET, LIMITS.contextBudget)
  assert.equal(autoTitle.AUTO_TITLE_TIMEOUT_MS, LIMITS.autoTitle.timeoutMs)
  assert.equal(autoTitle.AUTO_TITLE_MAX_OUTPUT_TOKENS, LIMITS.autoTitle.maxOutputTokens)
  assert.equal(autoTitle.AUTO_TITLE_MAX_INPUT_BYTES, LIMITS.autoTitle.maxInputBytes)
  assert.equal(autoTitleQueue.AUTO_TITLE_MAX_CONCURRENCY, LIMITS.autoTitle.concurrency)
  assert.equal(autoTitleQueue.AUTO_TITLE_MAX_QUEUE, LIMITS.autoTitle.maxQueue)
  assert.deepEqual(autoTitleQueue.AUTO_TITLE_DEFAULT_LIMITS, {
    concurrency: LIMITS.autoTitle.concurrency,
    maxQueue: LIMITS.autoTitle.maxQueue,
  })
  assert.equal(attachments.MAX_SIZE_MB, LIMITS.attachments.maxSizeMb)
  assert.equal(attachments.MAX_USER_DATA_SIZE_MB, LIMITS.attachments.maxUserDataSizeMb)
  assert.equal(attachments.MAX_COUNT, LIMITS.attachments.maxCount)
})

test('导入上限仍只有一个来源：importLimit.ts 的 200MB，LIMITS 只是转出', () => {
  assert.equal(importLimit.DEFAULT_MAX_IMPORT_BYTES, LIMITS.importMaxBytes)
  // 不接受「无上限」的解析规则没被这次搬家碰到
  assert.equal(importLimit.resolveMaxImportBytes(0), importLimit.DEFAULT_MAX_IMPORT_BYTES)
  assert.equal(importLimit.resolveMaxImportBytes(Number.NaN), importLimit.DEFAULT_MAX_IMPORT_BYTES)
  assert.equal(importLimit.resolveMaxImportBytes(1024), 1024)
})

test('每个 LIMITS 叶子都被生产代码引用（表里不许有没人用的值）', () => {
  /** 两个豁免：都不是「漏接」，而是单一来源在别处，见每个理由 */
  const exempt = {
    bootDeadlineMs: '内联脚本 src/index.html 在 bundle 之前执行，import 不到模块；由本文件断言两处相等',
    importMaxBytes: '单一来源仍在 importLimit.ts（#34 的纪律），消费方经由 DEFAULT_MAX_IMPORT_BYTES 使用',
    // #552 接线完成：`images.maxCount` / `images.maxTotalBytes` 已由 `store.prepareInlineImages()`
    // 真正使用（#562 暂押的那两条豁免到此删除）；`images.sniffHeadBytes` 随选图预检并入
    // `toImagePart()` 的 magic-bytes 探测一并删除 —— 选图阶段不再单独读一遍头部。
  }
  const text = readSrcText()
  const missing = leaves(LIMITS).filter((leaf) => !exempt[leaf] && !text.includes(`LIMITS.${leaf}`))
  assert.deepEqual(missing, [], `这些叶子没人引用（搬回常量或用 LIMITS.xxx 引用）：${missing.join(', ')}`)
})

test('启动兜底：index.html 内联脚本的 BOOT_DEADLINE_MS 与 LIMITS.bootDeadlineMs 相等', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  const matched = html.match(/var BOOT_DEADLINE_MS = (\d+)/)
  assert.ok(matched, 'index.html 里找不到 BOOT_DEADLINE_MS（被改名了？同步改本断言）')
  assert.equal(Number(matched[1]), LIMITS.bootDeadlineMs)
})

test('关系断言：导入上限 ÷ 总预算 ≥ 最低可接受带宽（#152 的不等式不再是注释）', () => {
  assert.equal(MIN_ACCEPTABLE_BYTES_PER_SEC, 100_000)
  assert.equal(isImportBudgetConsistent(), true, '现行 200MB / 1800s 必须满足 ≥100KB/s 门槛')
  // 现值的推导：200MB ÷ 1800s ≈ 114KB/s
  const required = LIMITS.importMaxBytes / (LIMITS.importMaxTotalMs / 1000)
  assert.ok(required >= MIN_ACCEPTABLE_BYTES_PER_SEC, `现值只够 ${Math.round(required)}B/s`)
  // 反证：只把上限降到 20MB、总时限不动 → 门槛不成立（这正是本断言要能变红的样子）
  assert.equal(isImportBudgetConsistent(20 * 1024 * 1024, LIMITS.importMaxTotalMs), false)
})

test('三个 setter 调用后真的生效（不是「看起来可配置」）', () => {
  try {
    client.setRequestTimeout(1234)
    assert.equal(client.getRequestTimeout(), 1234)
    client.setRequestTimeout(0)
    assert.equal(client.getRequestTimeout(), LIMITS.requestTimeoutMs, '非法值回到默认')

    client.setStreamIdleTimeout(2222)
    assert.equal(client.getStreamIdleTimeout(), 2222)
    client.setStreamIdleTimeout(Number.NaN)
    assert.equal(client.getStreamIdleTimeout(), LIMITS.streamIdleTimeoutMs, '非法值回到默认')

    contextBudget.setContextBudget({ maxRounds: 7 })
    assert.equal(contextBudget.getContextBudget().maxRounds, 7)
    assert.equal(contextBudget.getContextBudget().maxTokens, LIMITS.contextBudget.maxTokens, '缺省字段保持原值')
    contextBudget.setContextBudget({ maxTokens: 0 })
    assert.equal(contextBudget.getContextBudget().maxTokens, LIMITS.contextBudget.maxTokens, '非法值回落默认')
  } finally {
    client.setRequestTimeout(LIMITS.requestTimeoutMs)
    client.setStreamIdleTimeout(LIMITS.streamIdleTimeoutMs)
    contextBudget.resetContextBudget()
  }
  assert.equal(client.getRequestTimeout(), LIMITS.requestTimeoutMs)
  assert.equal(client.getStreamIdleTimeout(), LIMITS.streamIdleTimeoutMs)
  assert.deepEqual(contextBudget.getContextBudget(), LIMITS.contextBudget)
})
