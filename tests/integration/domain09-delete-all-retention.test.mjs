// [layer: integration | 依赖: playwright + chromium + 本地静态服务 + 打桩上游 | 耗时: ~1 分钟]
//
// N7 「删除所有对话」与清数据后的保留口径（域 9 · F9-12）—— #362 / #367
//
// 为什么必须单列：这是**破坏性动作**，删错了不可回滚，而且最贵的一条是
// **设备码被清 = 丢账号**（#261）。现状 `deleteAllSessions` 在 `tests/**` 里 0 命中 ——
// 「点了删除之后到底还剩什么」没有任何断言。
//
// 流程：真发一条消息（上游打桩）造出一个会话 → 记下删除前的存储 / 日志 / 会话计数 →
//       设置 → 数据管理 → 删除所有对话 → 二次确认 → 逐行对账（表在
//       `tests/fixtures/domain08-09/delete-retention.mjs`）。
//
//   node --test tests/integration/domain09-delete-all-retention.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { chromium } from 'playwright'
import { defaultDist, serveDir, verifyDist } from '../helpers/env.mjs'
import { RETENTION_ROWS, SENTINEL_LOG, SEED_STORAGE } from '../fixtures/domain08-09/delete-retention.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = defaultDist()

/** 上游打桩：一条最小可用的 Messages SSE（只为造出「一条真实会话」，不校验内容） */
const MESSAGES_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_n7","type":"message","role":"assistant","content":[],"model":"deepseek-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好呀"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const settle = (page, ms = 600) => page.waitForTimeout(ms)

/** 读 IndexedDB 里某个库 / 若干 store 的记录数 */
const idbCounts = (page, db, stores) =>
  page.evaluate(
    async ({ db, stores }) => {
      const connection = await new Promise((resolve) => {
        const request = indexedDB.open(db)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      })
      if (!connection) return null
      const counts = {}
      for (const store of stores) {
        counts[store] = await new Promise((resolve) => {
          const tx = connection.transaction(store, 'readonly')
          const request = tx.objectStore(store).count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(-1)
        })
      }
      connection.close()
      return counts
    },
    { db, stores }
  )

const storageSnapshot = (page) =>
  page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))

test('N7 删除所有对话：只清会话与附件，设置 / 设备码 / 诊断日志一个都不许动', async () => {
  verifyDist(DIST, { variant: 'standard' })
  const served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist' })
  const browser = await chromium.launch()
  const failures = []
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.route('**/anthropic/v1/messages', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: MESSAGES_SSE })
    )
    await page.route('**/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 'deepseek-flash' }] }),
      })
    )

    // ---------- 1) 造一个真实会话 ----------
    await page.goto(`${served.url}?diag-debug`, { waitUntil: 'domcontentloaded' })
    await page.evaluate((seed) => {
      window.localStorage.clear()
      for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value)
    }, SEED_STORAGE)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page, 1200)
    const openDialogClose = page.getByRole('dialog').last().getByRole('button', { name: /关闭|Close/ })
    if ((await openDialogClose.count()) > 0) {
      await openDialogClose.first().click()
      await settle(page, 400)
    }
    const composer = page.locator('textarea').first()
    await composer.fill('请回复你好')
    // seed 里把回车设成了「修饰键发送」，所以这里用 Ctrl+Enter（也顺便证明档位真的生效）
    await composer.press('Control+Enter')
    await settle(page, 4000)

    const before = {
      sessions: await idbCounts(page, 'chat-demo', ['sessionSummaries', 'sessions', 'files']),
      diagnostics: await idbCounts(page, 'chat-diagnostics', ['logs']),
      storage: await storageSnapshot(page),
    }
    // 哨兵日志：删除之后必须还读得到
    await page.evaluate((message) => window.__diagnostics.recordLog('info', message), SENTINEL_LOG)
    await page.evaluate(() => window.__diagnostics.flushDiagnostics?.())
    await settle(page, 400)

    if (!before.sessions || before.sessions.sessionSummaries < 1 || before.sessions.sessions < 1) {
      assert.fail(`前置条件不成立：会话没有被创建（${JSON.stringify(before.sessions)}）`)
    }
    if (Object.keys(before.storage).length < Object.keys(SEED_STORAGE).length) {
      assert.fail(`前置条件不成立：seed 没落盘（${JSON.stringify(Object.keys(before.storage))}）`)
    }
    // 未发送的输入草稿（清会话时应一并丢弃）
    await composer.fill('这条草稿还没发出去')

    // ---------- 2) 设置 → 数据管理 → 删除所有对话 → 二次确认 ----------
    if ((await page.getByRole('dialog').count()) === 0) {
      await page.getByRole('button', { name: /设置|Settings/ }).last().click()
    }
    await settle(page)
    const dataTab = page.getByRole('tab', { name: /数据管理|Data/ })
    if ((await dataTab.count()) > 0) await dataTab.first().click()
    await settle(page, 400)
    await page.getByRole('button', { name: '删除', exact: true }).first().click()
    await settle(page, 400)
    const confirm = page.getByRole('button', { name: '删除所有对话', exact: true }).last()
    if ((await confirm.count()) === 0) assert.fail('没有弹出删除确认（破坏性动作必须二次确认）')
    await confirm.click()
    await settle(page, 2500)

    // ---------- 3) 逐行对账 ----------
    const after = {
      sessions: await idbCounts(page, 'chat-demo', ['sessionSummaries', 'sessions', 'files', 'filesStaging', 'sessionsStaging']),
      diagnostics: await idbCounts(page, 'chat-diagnostics', ['logs']),
      storage: await storageSnapshot(page),
      composer: await composer.inputValue().catch(() => ''),
      sentinel: await page.evaluate(
        (message) =>
          (window.__diagnostics?.getDiagnosticsSnapshot?.().logs ?? []).some((entry) => entry.msg === message),
        SENTINEL_LOG
      ),
      toast: (await page.locator('[role="status"]').allInnerTexts()).map((text) => text.trim()),
    }

    for (const row of RETENTION_ROWS) {
      if (row.probe === 'idb-count') {
        const actual = after.sessions?.[row.store] ?? -1
        const was = before.sessions?.[row.store] ?? -1
        if (row.expect === 'cleared' && actual !== 0) {
          failures.push(`${row.id} ${row.label}：删除后还剩 ${actual} 条（删除前 ${was} 条）`)
        }
        if (row.expect === 'kept' && actual !== was) {
          failures.push(`${row.id} ${row.label}：删除前 ${was} 条，删除后 ${actual} 条`)
        }
      }
      if (row.probe === 'idb-count-multi') {
        for (const store of row.stores) {
          const actual = after.sessions?.[store] ?? -1
          if (row.expect === 'cleared' && actual !== 0) {
            failures.push(`${row.id} ${row.label}：${store} 删除后还剩 ${actual} 条`)
          }
        }
      }
      if (row.probe === 'storage-keep') {
        const value = after.storage[row.key] ?? null
        if (value !== before.storage[row.key]) {
          failures.push(`${row.id} ${row.label}：${row.key} 从 ${JSON.stringify(before.storage[row.key])} 变成 ${JSON.stringify(value)}`)
        }
      }
      if (row.probe === 'storage-keep-many') {
        for (const key of row.keys) {
          const value = after.storage[key] ?? null
          if (value !== before.storage[key]) {
            failures.push(`${row.id} ${row.label}：${key} 从 ${JSON.stringify(before.storage[key])} 变成 ${JSON.stringify(value)}`)
          }
        }
      }
      if (row.probe === 'diagnostics-kept') {
        const was = before.diagnostics?.logs ?? 0
        const now = after.diagnostics?.logs ?? 0
        if (now < was) failures.push(`${row.id} ${row.label}：日志从 ${was} 条掉到 ${now} 条`)
        if (!after.sentinel) failures.push(`${row.id} ${row.label}：删除前写入的哨兵日志不见了`)
      }
      if (row.probe === 'composer-cleared') {
        if (after.composer !== '') failures.push(`${row.id} ${row.label}：输入框还留着「${after.composer}」`)
      }
    }

    if (!after.toast.some((text) => text.includes('删除成功'))) {
      failures.push(`没看到「删除成功」提示，实际 ${JSON.stringify(after.toast)}`)
    }
    console.log(
      `  ·  删除前：会话 ${before.sessions.sessionSummaries} 条 / 日志 ${before.diagnostics.logs} 条；` +
        `删除后：会话 ${after.sessions.sessionSummaries} 条 / 日志 ${after.diagnostics.logs} 条 / 存储键 ${Object.keys(after.storage).length} 个`
    )
    console.log(`  ·  ${RETENTION_ROWS.length} 行保留口径（清会话 / 保设置 / 保设备码 / 保日志 / 清草稿）`)
  } finally {
    await browser.close()
    served.kill()
  }
  assert.deepEqual(failures, [])
})
