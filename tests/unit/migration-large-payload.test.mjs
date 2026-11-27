// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <5s]
// Issue #940（发版主线）：**超过 4 MiB 也不能丢一个字节** —— A 组：过桥字节口径。
//
// 内测用户实测炸点原文：`result exceeds 4194304 bytes; refusing to truncate`
// 来源：`AppSqlitePlugin.java:60` `MAX_RESULT_BYTES = 4*1024*1024` + `:638-641` `queryOn()` 逐行累加后直接抛。
//
// 本文件只钉一件事：**两侧的「4 MiB」不是同一个东西**，而分批预算必须按「真的过桥多大」来算。
//   - 原生 `queryOn()` 计数：BLOB 记 `blob.length`（base64 膨胀不算）、TEXT 记 `String.length()`
//     （UTF-16 码元，UTF-8 多字节不算）→ **低估**；
//   - 真的过桥形态：BLOB 是 `{"$b64":"…"}`（≈4/3），TEXT 是 JSON 字符串，再加列名与行标点。
//
//   A1 事实基线：4 MiB 的 BLOB 一行，原生计数器就已顶到上限；而真实过桥体积 ≥ 原始 × 4/3（两者相差 ~1.3 MiB）
//   A2 【红→绿护栏】`estimateRowBytes` 必须覆盖真实过桥体积（含 base64 膨胀 + 列名 + 行标点）——
//      当前实现按 `blob.size + 64` 记，比真实过桥体积小 1/4 以上 → 现在红，等 #940 修估算器转绿
//   A3 不许倒退：`estimateRowBytes` 不得低于原生计数器（修 A2 时别把它修成更小的口径）
//   A4 文本列 / 长列名 / 中文键：本来就在估算里，修 BLOB 时不许退化
//   A5 集成：`copyAll` 交出的**每一批**，真实过桥字节都不许超过 4 MiB（拿 1.6 MiB × 3 行把当前实现打红）
//   A6 边界：3.2 MiB 的 BLOB —— 原生计数器判「没超」，真实过桥（×4/3≈4.27 MiB）已经超了；
//      估算器若还把这一行判成「没超」，就是把必炸的一批当成合法批次交出去
//
//   node tests/run-layer.mjs unit --case migration-large-payload
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { createMem } from '../helpers/migration-engine/mem.mjs'
import {
  MAX_RESULT_BYTES,
  bridgeJsonBytes,
  blobRow,
  deterministicBytes,
  nativeResultBytes,
  nativeValueBytes,
} from '../helpers/migration-large-payload/bridge-bytes.mjs'

installTsResolve()
const { estimateRowBytes, estimateValueBytes, pageLimitFor, BLOB_PAGE_ROWS } = await loadTsModule(
  'src/services/storage/migration/hash.ts'
)
const { copyAll, DEFAULT_MAX_BATCH_BYTES } = await loadTsModule('src/services/storage/migration/copy.ts')

const MiB = 1024 * 1024
const row = (key, value) => ({ key, value })

test('A1 事实基线：同一个 4194304 在两侧含义不同（原生计数器低估真实过桥体积）', () => {
  const raw = 4 * MiB
  const bytes = deterministicBytes(raw, 940)
  const value = { id: 'f-big', size: raw, blob: new Blob([bytes]) }
  // 过桥形态里 BLOB 是 base64：一行 4 MiB 的 BLOB → ≥ 4 MiB × 4/3
  const bridge = bridgeJsonBytes([value])
  assert.ok(
    bridge >= Math.ceil((raw * 4) / 3),
    `一行 ${raw} 字节的 BLOB，真实过桥体积应 ≥ 原始 × 4/3 = ${Math.ceil((raw * 4) / 3)}，实测 ${bridge}`
  )
  // 原生计数器只认 blob.length → 已经顶到 4 MiB 上限（一行都过不去），但它对 base64 膨胀一无所知
  const native = nativeResultBytes([{ id: 'f-big', blob: bytes }])
  assert.ok(
    native > MAX_RESULT_BYTES,
    `按原生 queryOn() 口径，单个 4 MiB BLOB 行就已经 ${native} > ${MAX_RESULT_BYTES}（连一行都过不去）`
  )
  assert.ok(
    bridge > native,
    `真实过桥体积（含 base64）${bridge} 应大于原生计数器 ${native}：差额 ${bridge - native} 字节就是被漏算的膨胀`
  )
  // 数量级：膨胀 ≈ 1/3，不是舍入误差
  assert.ok(bridge - native > MiB, `base64 膨胀应达到 MiB 量级，实测只差 ${bridge - native}`)
})

test('A2【红→绿护栏】estimateRowBytes 必须覆盖真实过桥体积（base64 膨胀 + 列名 + 行标点）', () => {
  const raw = 4 * MiB
  const item = row('f-big', { id: 'f-big', size: raw, blob: new Blob([deterministicBytes(raw, 7)]) })
  const estimated = estimateRowBytes(item)
  const bridge = bridgeJsonBytes([item.value])
  // 这条是给 #940 修估算器的护栏：修好之前 estimateRowBytes 按 blob.size 记，必然小于真实过桥体积。
  assert.ok(
    estimated >= bridge,
    [
      `过桥体积口径不一致（#940 的坑）：`,
      `  真实过桥 ${bridge} 字节（BLOB 是 base64 ≈4/3 + 列名 + 行标点）`,
      `  估算器只给 ${estimated} 字节（差额 ${bridge - estimated}，占 ${((100 * (bridge - estimated)) / bridge).toFixed(1)}%）`,
      `  于是「估算 4 MiB 以内」的一批，真的过桥时已经超了原生 ${MAX_RESULT_BYTES} 上限。`,
      `  修法：estimateValueBytes 对 Blob / ArrayBuffer / TypedArray 记 ≥ base64 长度（4*ceil(n/3)）。`,
    ].join('\n')
  )
  // 同样按「原始字节 × 4/3」这一条独立表述一遍（不依赖 bridgeJsonBytes 的实现细节）
  assert.ok(
    estimated >= Math.ceil((raw * 4) / 3),
    `估算 ${estimated} 应 ≥ 原始 ${raw} × 4/3 = ${Math.ceil((raw * 4) / 3)}`
  )
  // 大小不变的单行：估算本身就是「这一批带不带得动」的唯一依据，偏小 1/4 就等于预算虚报 1/4
  assert.ok(estimated >= raw, `估算 ${estimated} 连原始 ${raw} 都没到`)
  // 值一级同样要对：Blob / Uint8Array / ArrayBuffer 过桥都是 base64
  for (const blob of [new Blob([new Uint8Array(1024)]), new Blob([new Uint8Array(3 * MiB)])]) {
    const size = blob.size
    assert.ok(
      estimateValueBytes(blob) >= Math.ceil((size * 4) / 3),
      `Blob(${size}) 估值 ${estimateValueBytes(blob)} 应 ≥ base64 长度 ${Math.ceil((size * 4) / 3)}`
    )
  }
  assert.ok(
    estimateValueBytes(new Uint8Array(MiB)) >= Math.ceil((MiB * 4) / 3),
    `Uint8Array(1 MiB) 估值 ${estimateValueBytes(new Uint8Array(MiB))} 应 ≥ base64 长度 ${Math.ceil((MiB * 4) / 3)}（同样要 base64 过桥）`
  )
})

test('A6 边界：3.2 MiB 的 BLOB —— 原生计数器说「没超」，真实过桥已经超了 4 MiB', () => {
  // 这行是整套护栏里最阴的一条：3.2 MiB × 4/3 ≈ 4.27 MiB，**刚好越过**原生上限。
  // 原生 queryOn() 只把 blob.length 记成 3.2 MiB，于是它「以为」这条结果合法、放行；
  // 真过桥时 base64 一展开就超了 —— 这就是 #940 里最难靠肉眼发现的那种失败。
  const raw = Math.floor(3.2 * MiB)
  const bytes = deterministicBytes(raw, 11)
  const item = row('f-edge', { id: 'f-edge', size: raw, blob: new Blob([bytes]) })

  const native = nativeResultBytes([{ id: 'f-edge', blob: bytes }])
  assert.ok(
    native < MAX_RESULT_BYTES,
    `原生计数器这边必须「没超」（3.2 MiB 量级），实测 ${native} —— 否则这条用例不说明问题`
  )

  const bridge = bridgeJsonBytes([item.value])
  assert.ok(
    bridge >= Math.ceil((raw * 4) / 3),
    `真实过桥体积 ${bridge} 应 ≥ 原始 × 4/3 = ${Math.ceil((raw * 4) / 3)}`
  )
  assert.ok(
    bridge > MAX_RESULT_BYTES,
    `真实过桥 ${bridge} 必须已经超过原生上限 ${MAX_RESULT_BYTES}（超 ${bridge - MAX_RESULT_BYTES}），这才是那个坑`
  )

  // 估算器必须站在「过桥」这一侧：现有实现按 blob.size 记，于是把这一行判成「没超」（红）
  const estimated = estimateRowBytes(item)
  assert.ok(
    estimated > MAX_RESULT_BYTES,
    [
      `3.2 MiB 的 BLOB，估算器给 ${estimated} 字节，判成「没超 ${MAX_RESULT_BYTES}」；`,
      `可真实过桥是 ${bridge} 字节（已超 ${bridge - MAX_RESULT_BYTES}）。`,
      `于是这一批会被原样交给原生桥 → 「result exceeds ${MAX_RESULT_BYTES} bytes; refusing to truncate」。`,
    ].join('')
  )
  assert.ok(
    estimated >= bridge,
    `估算 ${estimated} 必须 ≥ 真实过桥 ${bridge}（差额 ${bridge - estimated}）`
  )
})

test('A3 不许倒退：估算不得低于原生计数器（BLOB / TEXT / 数字 / null 混排）', () => {
  const cases = [
    row('k1', { blob: new Blob([deterministicBytes(300 * 1024, 11)]) }),
    row('会话', { 标题: '中文标题'.repeat(1000), 备注: null, 计数: 42, 比率: 0.25 }),
    row('k3', { text: 'x'.repeat(2 * MiB) }),
    row('k4', { nested: { a: [1, 2, 3], b: { c: 'd' } }, blob: new Blob([new Uint8Array(64)]) }),
    row('k5', { bytes: new Uint8Array(2 * MiB) }),
  ]
  for (const item of cases) {
    const estimated = estimateRowBytes(item)
    const native = nativeValueBytes(item.value)
    assert.ok(
      estimated >= native,
      `${item.key}: 估算 ${estimated} 低于原生计数器 ${native}（估算器不能比原生口径还小）`
    )
  }
})

test('A4 文本列 / 长列名 / 中文键：不发生退化（修 BLOB 时不许把这些改小）', () => {
  const cjk = '会话内容'.repeat(500)
  const value = { 很长的中文列名: cjk, ascii: 'y'.repeat(5000) }
  const estimated = estimateRowBytes(row('中文主键', value))
  assert.ok(
    estimated >= bridgeJsonBytes([value]),
    `中文/长列名的估算也要覆盖过桥体积：估算 ${estimated} vs 过桥 ${bridgeJsonBytes([value])}`
  )
})

test('A5 集成：copyAll 交出的每一批，真实过桥字节都不许超过 4 MiB', async () => {
  // 三行各 1.6 MiB：单行过桥 ≈2.13 MiB（自己一批装得下），两行就 ≈4.27 MiB（已经超了）
  const each = Math.floor(1.6 * MiB)
  const mem = createMem({
    files: ['f1', 'f2', 'f3'].map((id) => blobRow(id, deterministicBytes(each, id.charCodeAt(1)))),
  })
  assert.equal(pageLimitFor('files', 200), BLOB_PAGE_ROWS, 'Blob store 的页大小仍是 BLOB_PAGE_ROWS（8）')
  const batches = []
  const sink = {
    writeBatch: async (store, rows) => {
      batches.push({ store, rows: rows.map((item) => ({ ...item })) })
      await mem.sink.writeBatch(store, rows)
    },
    clearAll: () => mem.sink.clearAll(),
  }
  const result = await copyAll({ source: mem.source, sink })
  assert.equal(result.completed, true)
  assert.equal(mem.size('files'), 3, '三行都要落到位（一批都不许丢）')
  assert.ok(batches.length >= 1)
  assert.equal(DEFAULT_MAX_BATCH_BYTES, MAX_RESULT_BYTES, 'TS 的批上限与原生上限是同一个数字（这正是坑所在）')

  const worst = batches
    .map((batch) => ({ batch, bytes: bridgeJsonBytes(batch.rows.map((item) => item.value)) }))
    .reduce((max, item) => (item.bytes > max.bytes ? item : max), { bytes: 0, batch: undefined })
  assert.ok(
    worst.bytes <= MAX_RESULT_BYTES,
    [
      `copyAll 交出的一批，真实过桥 ${worst.bytes} 字节 > 原生上限 ${MAX_RESULT_BYTES}（超 ${worst.bytes - MAX_RESULT_BYTES}）。`,
      `  这一批 ${worst.batch.rows.length} 行、每行原始 ${each} 字节；估算器按 blob.size 记，以为 ${(worst.batch.rows.length * each) / MiB} MiB 以内。`,
      `  真机上这一批要么被原生拒（超 4 MiB 直接抛、迁移失败），要么把一份被低估的内存/JSON 塞进 WebView。`,
      `  修法：估算口径改成过桥形态（见 A2），批自然被切到 1 行。`,
    ].join('\n')
  )
  // 每一批都单独过一遍（不只是最大那批）
  for (const [index, batch] of batches.entries()) {
    const bytes = bridgeJsonBytes(batch.rows.map((item) => item.value))
    assert.ok(
      bytes <= MAX_RESULT_BYTES,
      `第 ${index + 1} 批（${batch.rows.length} 行）过桥 ${bytes} > ${MAX_RESULT_BYTES}`
    )
  }
})
