// [layer: unit | 依赖: 无（纯 Node；只调 src 里的收口纯函数，不装 navigator、不碰设备） | 耗时: <30s]
//
// 宿主报的空间**脏值收口**（#1002 设备实测）。
//
// 现场：模拟器上把盘写满 → 清空填充文件 → **不重启 App**，WebView 的 `estimate()` 返回
// `usage = 18446744073709552000`（接近 UINT64_MAX）。导入预检据此算出「当前可用 0B，
// 还差 23.9MB」→ **拒绝一切导入**；同一时刻 `stat -f` 实测可用 4.8GB，重启 App 后立刻正常。
// 备份侧的表象是另一头：盘已经腾出来了，界面/状态行仍说空间不足。
//
// 本文件钉的是**判据本身**，一条比一条贵：
//   [1] `normalizeStorageEstimate()`：只放行「有限、非负、≤2^53-1、usage ≤ quota、quota > 0」，
//       其它一律 `undefined`（= 未知）——**不许**折成 0，也不许拿 quota 顶上；
//   [2] 原生 `freeBytes()` 的收口同一把尺子（备份侧读的是它，不是 `estimate()`）；
//   [3] `judgeImportSpace()`：可信来源说不够 → 照报 `insufficient`（不吞真话）；
//   [4] `judgeWriteSpace()` 的**分级**（2026-11-27 第二轮，设备二次事故）：空间未知时
//       小负载放行、大负载拒绝，而 `estimate()` 即便报着正常值也**不能**单独证明「够用」；
//   [5] `hasRoomForNext()` / `restoreNeedBytes()`：备份与恢复共用同一把尺子（含写放大 2×）。
import { installTsResolve } from '../helpers/dom-env.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'

// 源码里的相对说明符写的是 `.js`（NodeNext 约定），裸 node 不会自己换后缀 —— 先装解析 hook，
// 再动态 import 被测模块。顺序不能反（静态 import 会被提升到 hook 之前求值）。
installTsResolve({})

const {
  normalizeStorageEstimate,
  normalizeFreeBytes,
  isTrustworthySpace,
  judgeWriteSpace,
  SMALL_WRITE_BYTES,
} = await import('../../src/services/storage.ts')
const { judgeImportSpace } = await import('../../src/services/chat/history/quotaPrecheck.ts')
const { hasRoomForNext, MIN_ESTIMATE_BYTES, restoreNeedBytes, spaceForWrite } = await import(
  '../../src/services/backup/backupCore.ts'
)

const MB = 1024 * 1024
/** 设备实测的脏值（`Number` 里是 1.8446744073709552e19，远大于 2^53-1） */
const UINT64_MAX = 18_446_744_073_709_552_000
/** 重启 App 后同一个模拟器回报的正常值 */
const HEALTHY_USAGE = 161_084
const HEALTHY_QUOTA = 1000 * MB

/* ------------------------------------------------------------------ [1] estimate() 收口 */

test('[1a] 正常值：三个数都算好（free = quota - usage）', () => {
  const space = normalizeStorageEstimate({ quota: HEALTHY_QUOTA, usage: HEALTHY_USAGE })
  assert.ok(space, '正常值必须收下')
  assert.equal(space.quota, HEALTHY_QUOTA)
  assert.equal(space.usage, HEALTHY_USAGE)
  assert.equal(space.free, HEALTHY_QUOTA - HEALTHY_USAGE, 'free 必须是 quota - usage')
})

test('[1b] usage = 0 是合法值（空库）：free = quota，不收成「未知」', () => {
  const space = normalizeStorageEstimate({ quota: HEALTHY_QUOTA, usage: 0 })
  assert.ok(space)
  assert.equal(space.free, HEALTHY_QUOTA)
})

test('[1c] 脏值一律判「未知」：UINT64_MAX / usage>quota / NaN / Infinity / 负数 / 超 2^53-1', () => {
  const dirty = [
    ['usage = UINT64_MAX（设备实测）', { quota: HEALTHY_QUOTA, usage: UINT64_MAX }],
    ['usage > quota', { quota: HEALTHY_QUOTA, usage: HEALTHY_QUOTA + 1 }],
    ['usage = NaN', { quota: HEALTHY_QUOTA, usage: Number.NaN }],
    ['usage = Infinity', { quota: HEALTHY_QUOTA, usage: Number.POSITIVE_INFINITY }],
    ['usage = -Infinity', { quota: HEALTHY_QUOTA, usage: Number.NEGATIVE_INFINITY }],
    ['usage = -1', { quota: HEALTHY_QUOTA, usage: -1 }],
    ['usage 缺失', { quota: HEALTHY_QUOTA }],
    ['usage = 2^53（比 2^53-1 大 1）', { quota: HEALTHY_QUOTA, usage: 2 ** 53 }],
  ]
  for (const [label, raw] of dirty) {
    const space = normalizeStorageEstimate(raw)
    assert.equal(
      space,
      undefined,
      `${label}：必须判成「未知」，不许算出 free（尤其不许算出 0 可用）`
    )
  }
})

test('[1d] quota 不可信一律判「未知」：0 / 负数 / NaN / Infinity / 缺失 / 超 2^53-1', () => {
  const dirty = [
    ['quota = 0', { quota: 0, usage: 0 }],
    ['quota = -1', { quota: -1, usage: 0 }],
    ['quota = NaN', { quota: Number.NaN, usage: 0 }],
    ['quota = Infinity', { quota: Number.POSITIVE_INFINITY, usage: 0 }],
    ['quota 缺失', { usage: 0 }],
    ['quota = UINT64_MAX', { quota: UINT64_MAX, usage: 0 }],
  ]
  for (const [label, raw] of dirty) {
    assert.equal(normalizeStorageEstimate(raw), undefined, `${label}：必须判成「未知」`)
  }
})

test('[1e] 边界：quota = usage = 2^53-1 是可表示的，照收（free = 0 是真的 0，不是未知）', () => {
  const max = Number.MAX_SAFE_INTEGER
  const space = normalizeStorageEstimate({ quota: max, usage: max })
  assert.ok(space)
  assert.equal(space.free, 0)
})

test('[1f] 返回值不是对象（null / undefined / 字符串 / 数字）→ 未知，不抛错', () => {
  for (const raw of [null, undefined, 'quota=1', 42, true]) {
    assert.equal(normalizeStorageEstimate(raw), undefined, `${String(raw)} 必须判成「未知」`)
  }
})

test('[1g] isTrustworthySpace：已经算好的对象按同一把尺子复核（含 free 与 quota-usage 不一致）', () => {
  assert.equal(isTrustworthySpace(undefined), false)
  assert.equal(isTrustworthySpace(null), false)
  assert.equal(isTrustworthySpace({ quota: HEALTHY_QUOTA, usage: 1, free: HEALTHY_QUOTA - 1 }), true)
  assert.equal(
    isTrustworthySpace({ quota: HEALTHY_QUOTA, usage: UINT64_MAX, free: 0 }),
    false,
    'usage 是脏值时，外面套一层对象也不能变成可信'
  )
  assert.equal(
    isTrustworthySpace({ quota: HEALTHY_QUOTA, usage: 1, free: HEALTHY_QUOTA }),
    false,
    'free 与 quota - usage 对不上：这份测量不自洽，按未知处理'
  )
})

/* ------------------------------------------ [2] 原生 freeBytes()（备份侧读的是它） */

test('[2a] 原生 freeBytes：正常值收下，脏值一律 null（= 未知）', () => {
  assert.equal(normalizeFreeBytes(4.8 * 1024 * MB), 4.8 * 1024 * MB, '设备实测 4.8GB 可用')
  assert.equal(normalizeFreeBytes(0), 0, '0 字节是可信的「真的没空间」，不能被吞成未知')
  for (const [label, raw] of [
    ['UINT64_MAX', UINT64_MAX],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-1', -1],
    ['字符串', '1024'],
    ['缺失', undefined],
  ]) {
    assert.equal(normalizeFreeBytes(raw), null, `${label}：必须判成「未知」（null）`)
  }
})

/* ------------------------------------------------- [3] 导入预检：真话照报 */

const NEED = 24 * MB

test('[3] 可信来源说不够 → 照报 insufficient（真的不够时必须说实话）', () => {
  const verdict = judgeImportSpace(NEED, { nativeFree: MB, estimateFree: null })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'insufficient')
  assert.equal(verdict.source, 'native', '原生是唯一可信来源，判定要说明是谁下的')
  assert.equal(verdict.free, MB, '报的可用字节必须来自原生读数')
  assert.equal(verdict.short, verdict.need - verdict.free, '还差多少 = need - free')
  assert.ok(verdict.need > NEED, 'need 含安全系数与写放大，必然大于负载本身')
})

/* ------------------- [4] 分级：未知时小负载放行、大负载拒绝；estimate 不能证明「够」 */

const SMALL = 512 * 1024

test('[4a] 大负载 + 空间未知 → 拒绝，且理由与「空间不足」是两回事（unverifiable）', () => {
  for (const [label, probe] of [
    ['原生读不到、estimate 也没有', { nativeFree: null, estimateFree: null }],
    ['原生读不到、estimate 是脏值', { nativeFree: null, estimateFree: normalizeFreeBytes(UINT64_MAX) }],
    ['两个来源都缺字段', {}],
  ]) {
    const verdict = judgeWriteSpace(NEED, probe)
    assert.equal(verdict.ok, false, `${label}：大负载不能拿试错换`)
    assert.equal(verdict.reason, 'unverifiable', `${label}：拒绝理由必须是「读不到空间」`)
    assert.equal(verdict.need, NEED)
  }
})

test('[4b] 大负载 + estimate 报着「够」（甚至看着很宽裕）→ 仍然拒绝：quota 不是磁盘余量', () => {
  // 设备现场：estimate 报 quota 3.7GB / usage 45.6MB（即 free ≈ 3.65GB），真实只剩 6MB
  const verdict = judgeWriteSpace(NEED, { nativeFree: null, estimateFree: 3.65 * 1024 * MB })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'unverifiable', 'estimate「看着够」不构成证据（#1002 第二轮根因）')
})

test('[4c] 小负载 + 空间未知 → 放行（失败代价可控），并标成 unmeasurable-small', () => {
  for (const need of [0, 1, SMALL, SMALL_WRITE_BYTES]) {
    const verdict = judgeWriteSpace(need, { nativeFree: null, estimateFree: null })
    assert.equal(verdict.ok, true, `小负载（${need}）必须放行`)
    assert.equal(verdict.reason, 'unmeasurable-small')
  }
  // 边界：超过 8MiB 就进入大负载档（同一个数字既是备份预估下限，也是分级线）
  const over = judgeWriteSpace(SMALL_WRITE_BYTES + 1, { nativeFree: null })
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'unverifiable')
})

test('[4d] estimate 可信且明确不够 → 拒绝，并说明是 estimate 下的判断（保守方向）', () => {
  const verdict = judgeWriteSpace(NEED, { nativeFree: null, estimateFree: MB })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'insufficient')
  assert.equal(verdict.source, 'estimate')
  assert.equal(verdict.free, MB)
})

test('[4e] 原生可信时以原生为准：estimate 脏值 / 说够 / 说不够都不影响判定', () => {
  const enough = judgeWriteSpace(NEED, { nativeFree: 30 * MB, estimateFree: normalizeFreeBytes(UINT64_MAX) })
  assert.equal(enough.ok, true, 'estimate 脏值不许把一次可信的原生读数带坏')
  assert.equal(enough.reason, 'sufficient')
  assert.equal(enough.free, 30 * MB)

  const plentyEstimateButNativeShort = judgeWriteSpace(NEED, { nativeFree: MB, estimateFree: 100 * 1024 * MB })
  assert.equal(plentyEstimateButNativeShort.ok, false, 'estimate 说够不作数，原生说不够就是不够')
  assert.equal(plentyEstimateButNativeShort.source, 'native')
})

/* ------------------------- [5] 备份 / 恢复：未知不再一律按「够」，且余量含写放大 */

test('[5a] hasRoomForNext：小负载未知放行，大负载未知拦；真·0 字节照样拦', () => {
  assert.equal(hasRoomForNext(null, MIN_ESTIMATE_BYTES), true, '等于分级线 → 小负载 → 放行')
  assert.equal(hasRoomForNext(normalizeFreeBytes(UINT64_MAX), MIN_ESTIMATE_BYTES), true, '脏值 = 未知')
  assert.equal(hasRoomForNext(UINT64_MAX, MIN_ESTIMATE_BYTES), true, '脏值直接传进来也按未知分级')
  assert.equal(hasRoomForNext(-1, MIN_ESTIMATE_BYTES), true, '负数不是「没空间」，是未知')
  assert.equal(hasRoomForNext(Number.NaN, MIN_ESTIMATE_BYTES), true, 'NaN 是未知')
  assert.equal(hasRoomForNext(null, MIN_ESTIMATE_BYTES + 1), false, '大负载 + 未知 → 不再放行（旧口径在这里炸过）')
  assert.equal(hasRoomForNext(0, MIN_ESTIMATE_BYTES), false, '真的 0 字节：照拦（不吞真话）')
  assert.equal(hasRoomForNext(MIN_ESTIMATE_BYTES - 1, MIN_ESTIMATE_BYTES), false, '差一个字节也不够')
  assert.equal(hasRoomForNext(MIN_ESTIMATE_BYTES, MIN_ESTIMATE_BYTES), true, '恰好够就是够')
})

test('[5b] spaceForWrite 给出完整结论（备份预检据此选「空间不足」还是「读不到空间」）', () => {
  assert.equal(spaceForWrite(null, MIN_ESTIMATE_BYTES + 1).reason, 'unverifiable')
  assert.equal(spaceForWrite(MB, MIN_ESTIMATE_BYTES).reason, 'insufficient')
  assert.equal(spaceForWrite(50 * MB, MIN_ESTIMATE_BYTES).reason, 'sufficient')
})

test('[5c] restoreNeedBytes：归档 + 附件都要落，余量按写放大 2× 算', () => {
  const manifest = {
    archive: { name: 'a.zip', sizeBytes: 20 * MB, sha256: 'x' },
    attachments: { name: 'a.attachments.zip', sizeBytes: 23 * MB, sha256: 'y' },
  }
  assert.equal(restoreNeedBytes(manifest), (20 + 23) * MB * 2, '恢复要写的两处都要算进去')
  assert.equal(
    restoreNeedBytes({ ...manifest, attachments: null }),
    40 * MB,
    '没有附件时只算归档，但仍乘写放大'
  )
})

