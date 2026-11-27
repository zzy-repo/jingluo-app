// [layer: unit | 依赖: 无（纯 Node；IndexedDB 边界用假 db 替身，navigator.storage 由用例装） | 耗时: <30s]
//
// 导入配额预检 + 进度/取消 + 上限（母单：会话归档导入上限 200MiB → 500MiB）。
//
// 顺序必须是「先补两个短板，再提上限」，所以本文件的断言也是这个顺序：
//   ① 导入前剩余空间预检：不够就**在写第一条会话之前**拒绝，一个会话都不许入库；
//      （#1002 第二轮）可信来源只有原生 `freeBytes`，`estimate()` 只作否决；空间未知时按负载分级——
//   ② 进度与取消：进度只由真实条目/会话计数推进（不许定时器），取消后不留半截数据；
//   ③ 上限常量：500MiB、导出上限自动跟随、解压闸 ≥ 4 倍。
//
// 每条正向断言都配反向用例（不许为了加固把正常包误杀）：空间充足照常导入、探测不到就放行。
//
//   node tests/unit/import-quota-progress.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等），单跑本文件不会 ReferenceError。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineModule } from '../helpers/dom-env.mjs'
import { installImportEnv } from '../helpers/import-env.mjs'

/**
 * 假存储：IndexedDB 在裸 Node 里不存在，只替换 `../db.js` 这个边界，
 * `importArchive` / `quotaPrecheck` 全是真实代码。
 *
 * `counts` 是本文件的观测点：`clearStaging` 被调了几次（取消收尾的断言）、
 * `addStagingSession` 被调了几次（「一个会话都没入库」的断言）。
 */
const fakeDB = inlineModule(`
export const stagingSessions = []
export const stagingFiles = new Map()
export const stagingFileTypes = new Map()
export const counts = { clearStaging: 0, addStagingSession: 0, saveStagingFiles: 0 }
export const clearStaging = async () => {
  counts.clearStaging += 1
  stagingSessions.length = 0
  stagingFiles.clear()
  stagingFileTypes.clear()
}
export const addStagingSession = async (session) => {
  counts.addStagingSession += 1
  stagingSessions.push(session)
}
export const saveStagingFiles = async (files) => {
  counts.saveStagingFiles += 1
  for (const file of files) {
    stagingFiles.set(file.id, file.blob)
  }
}
export const updateStagingFileTypes = async (types) => {
  for (const [id, type] of types) {
    stagingFileTypes.set(id, type)
  }
}
globalThis.__quotaProgressDB = { stagingSessions, stagingFiles, stagingFileTypes, counts }
`)

installImportEnv({ db: fakeDB })

const { message, sessionBytes, manifestBytes, indexBytes, zipFileOf } = await import(
  '../helpers/archive-builder.mjs'
)
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { readArchiveLayout } = await import('../../src/services/chat/history/zipReader.ts')
const { setImportSpaceNoteSink, setNativeFreeBytesReader, SMALL_IMPORT_PAYLOAD_BYTES } = await import(
  '../../src/services/chat/history/quotaPrecheck.ts'
)
const { WRITE_AMPLIFICATION_FACTOR } = await import('../../src/services/storage.ts')
const { translate } = await import('../../src/i18n/index.ts')
const {
  DEFAULT_MAX_IMPORT_BYTES,
  IMPORT_QUOTA_SAFETY_FACTOR,
  formatImportBytes,
  maxImportMegabytes,
} = await import('../../src/services/chat/history/importLimit.ts')
const { MAX_EXPORT_BYTES } = await import('../../src/services/chat/history/zipWriter.ts')

const db = globalThis.__quotaProgressDB
const MB = 1024 * 1024

/** manifest → 会话若干 → index，与真实导出同形（条目顺序就是导入端看到的顺序）。 */
const archiveOf = (ids, { compress = false, content } = {}) =>
  zipFileOf(
    [
      ['manifest.json', manifestBytes()],
      ...ids.map((id) => [`chat_sessions/${id}.json`, sessionBytes(id, content)]),
      ['chat_session_index.json', indexBytes(ids)],
    ],
    { compress }
  )

// ------------------------------------------------------------------ navigator.storage 装拆

/**
 * 装一个 `navigator.storage`。`storage === undefined` = 模拟「老 WebView / 隐私模式」：
 * 整个 `storage` 对象都没有（不是「有 API 但返回空」—— 那是另一条分支，见 T4）。
 */
const withStorage = (storage) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: storage === undefined ? {} : { storage },
    configurable: true,
    writable: true,
  })
  return () => {
    if (saved === undefined) {
      delete globalThis.navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', saved)
    }
  }
}

/** 返回固定配额的 `estimate()`；`quota - usage` 就是「当前可用」。 */
const estimateOf = ({ quota, free }) => ({
  estimate: async () => ({ quota, usage: quota - free }),
})

/**
 * 装原生 `freeBytes()` 的读数口（**唯一可信来源**）。`bytes === null` = 原生读不到。
 * 不装的时候默认走动态 import（裸 Node 里 `availableBytes()` 返回 null = 未知）。
 */
const withNativeFree = (bytes) => {
  setNativeFreeBytesReader(async () => bytes)
  return () => setNativeFreeBytesReader(undefined)
}

/** 每次用例前把暂存与计数器清干净（假 db 是进程级单例）。 */
const resetStaging = () => {
  db.stagingSessions.length = 0
  db.stagingFiles.clear()
  db.stagingFileTypes.clear()
  db.counts.clearStaging = 0
  db.counts.addStagingSession = 0
  db.counts.saveStagingFiles = 0
}

/** 跑一次导入并把「抛出的错误」结构化带出（成功时 error 为 null）。 */
const runImport = async (file, options = {}) => {
  try {
    const result = await importArchive(file, options)
    return { error: null, result }
  } catch (error) {
    return { error, result: null }
  }
}

// ------------------------------------------------------------------ ① 空间不足 → 导入前拒绝

test('① 空间不足：在写第一个会话之前拒绝，一个会话都没入库', async (t) => {
  resetStaging()
  const notes = []
  const seen = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))

  const file = archiveOf(['s1', 's2', 's3'])
  const layout = await readArchiveLayout(file)
  // 需求 = 解压总量 × 安全系数 × 写放大（暂存 + 提交两份），见 storage.WRITE_AMPLIFICATION_FACTOR
  const need = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  // 只留一半的余量：需要的空间一定大于它
  const free = Math.floor(need / 2)
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free })))

  const { error } = await runImport(file, { onProgress: (p) => seen.push(p) })

  assert.equal(error?.name, 'BackupError', '必须是一次明确的失败，而不是静默跳过')
  assert.equal(error.key, 'historyImportInsufficientSpace', '错误码要能分辨「空间不足」和「包太大」')

  // 文案：三个数字都是插值出来的，一个写死的 MB 数都不许有
  assert.equal(error.params.need, formatImportBytes(need), '需要多少（解压后总量 × 安全系数 × 写放大）')
  assert.equal(error.params.free, formatImportBytes(free), '当前可用多少')
  assert.equal(error.params.short, formatImportBytes(need - free), '还差多少')
  assert.match(error.message, /还差/, '文案要说出「还差多少」')
  assert.ok(error.message.includes(error.params.free), '文案要带上当前可用空间（数字插值）')
  assert.notEqual(
    error.params.need,
    formatImportBytes(DEFAULT_MAX_IMPORT_BYTES),
    'need 是「解压后总量 × 系数」算出来的，不是把上限抄进文案'
  )

  // 时机：拒绝发生在**任何入库动作之前**
  assert.equal(db.counts.addStagingSession, 0, '一个会话都不许进暂存')
  assert.equal(db.stagingSessions.length, 0)
  assert.equal(db.counts.saveStagingFiles, 0, '原件也不许写')
  assert.equal(db.counts.clearStaging, 0, '什么都没写，就不需要清理')

  // 进度：只走到 reading（读目录 / 预检），没有进入 importing
  assert.ok(seen.length > 0, '预检阶段就要有进度回调，界面才知道在动')
  assert.deepEqual(
    seen.map((p) => p.stage).filter((stage) => stage !== 'reading'),
    [],
    '被拒绝时进度不许宣称已经进入逐会话入库'
  )

  // 诊断里留一条（拒绝的原因与三个数字）
  const rejected = notes.find((note) => note.fields['import.quota.state'] === 'insufficient')
  assert.ok(rejected, '空间不足要在诊断里留一条')
  assert.equal(rejected.fields['import.need.bytes'], need)
  assert.equal(rejected.fields['import.free.bytes'], free)
  assert.equal(rejected.fields['import.space.decidedBy'], 'estimate', '这一档的否决来自 estimate（原生读不到）')
})

test('① 反向：空间充足 → 正常导入（预检不许把正常包误杀）', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))

  const file = archiveOf(['s1', 's2', 's3'])
  const layout = await readArchiveLayout(file)
  // 原生读数恰好等于需求：边界不缩水（写成 > 就会误拒）
  const free = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  t.after(withNativeFree(free))
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free })))

  const { error, result } = await runImport(file)

  assert.equal(error, null, `恰好够用必须放行（实际 ${error?.key}）`)
  assert.deepEqual(result.skipped, [])
  assert.equal(db.stagingSessions.length, 3, '三条会话都要进暂存')
  assert.deepEqual(
    db.stagingSessions.map((session) => session.id),
    ['s1', 's2', 's3']
  )
})

// ------------------------------------------------------------------ ③ 探测不到就放行

test('③ navigator.storage 不存在（老 WebView / 隐私模式）→ 放行，不误拦', async (t) => {
  resetStaging()
  const notes = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))
  // 整个 storage 对象都不存在
  t.after(withStorage(undefined))

  const { error } = await runImport(archiveOf(['s1', 's2']))

  assert.equal(error, null, '估不出来就把人拦住 = 老 WebView 完全不能导入，比空间不足更糟')
  assert.equal(db.stagingSessions.length, 2)
  const skippedNote = notes.find((note) => note.fields['import.quota.state'] === 'unmeasurable')
  assert.ok(skippedNote, '探测不到要在诊断里记一条（能力缺失要可见）')
  assert.match(skippedNote.message, /skipped|unavailable/i)
})

test('③b 有 storage 但 estimate 缺失 / 抛错 / 字段不合法 → 同样放行', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))

  const cases = [
    ['没有 estimate 方法', { persist: async () => true }],
    ['estimate 抛错', {
      estimate: async () => {
        throw new Error('SecurityError: storage estimate blocked')
      },
    }],
    ['quota 字段缺失', { estimate: async () => ({ usage: 1024 }) }],
    ['quota 为 0', { estimate: async () => ({ quota: 0, usage: 0 }) }],
  ]
  for (const [label, storage] of cases) {
    resetStaging()
    const restore = withStorage(storage)
    try {
      const { error } = await runImport(archiveOf(['s1']))
      assert.equal(error, null, `${label}：必须放行（不能因为估不出来就拦住）`)
      assert.equal(db.stagingSessions.length, 1, `${label}：正常导入`)
    } finally {
      restore()
    }
  }
})

// ------------------------------------------- ③c 脏值：读不到 ≠ 没空间（#1002，设备实测）

/**
 * 现场：模拟器上把盘写满 → 清空填充文件 → **不重启 App**，`estimate()` 返回
 * `usage = 18446744073709552000`（接近 UINT64_MAX 的脏值）。旧实现算出「当前可用 0B」，
 * 于是**拒绝一切导入**；同一时刻 `stat -f` 实测可用 4.8GB，重启 App 后 `usage = 161084`。
 *
 * 契约：这些输入一律判成**未知**（`unmeasurable`），并按「未知不阻断」放行 ——
 * 绝不许折成「0 字节可用」，也不许拿 `quota` 顶上冒充。
 */
test('③c 脏值（UINT64_MAX usage / usage>quota / NaN / Infinity / 负数 / quota≤0）→ 判未知，放行', async (t) => {
  const notes = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))

  const quota = 1000 * MB
  // 设备实测的原值：`Number` 里它是 1.8446744073709552e19，远超 2^53-1
  const uint64Max = 18_446_744_073_709_552_000
  const cases = [
    ['usage = UINT64_MAX（设备实测脏值）', { quota, usage: uint64Max }],
    ['usage > quota', { quota, usage: quota + 1 }],
    ['usage = NaN', { quota, usage: Number.NaN }],
    ['usage = Infinity', { quota, usage: Number.POSITIVE_INFINITY }],
    ['usage = -1', { quota, usage: -1 }],
    ['usage 字段缺失', { quota }],
    ['quota = 0', { quota: 0, usage: 0 }],
    ['quota = -1', { quota: -1, usage: 0 }],
    ['quota = UINT64_MAX', { quota: uint64Max, usage: 0 }],
    ['quota = NaN', { quota: Number.NaN, usage: 0 }],
  ]

  for (const [label, value] of cases) {
    resetStaging()
    const restore = withStorage({ estimate: async () => value })
    try {
      const { error } = await runImport(archiveOf(['d1', 'd2']))
      assert.equal(
        error,
        null,
        `${label}：脏值必须判成「未知」并放行，不许算成「当前可用 0B」再拒绝（实际 ${error?.key}）`
      )
      assert.equal(db.stagingSessions.length, 2, `${label}：正常导入`)
    } finally {
      restore()
    }
  }

  // 诊断口径：每一次都是 unmeasurable；一次 `insufficient` 都不许出现
  const states = notes.map((note) => note.fields['import.quota.state'])
  assert.ok(states.length >= cases.length, `每个脏值用例都要留一条诊断（实际 ${states.length} 条）`)
  assert.deepEqual(
    states.filter((state) => state !== 'unmeasurable'),
    [],
    `脏值只许记 unmeasurable，不许记成 insufficient（实际 ${JSON.stringify(states)}）`
  )
})

// ------------------------------------------------------------------ ④ 需求按解压后总量算

test('④ 需求按「解压后总量 × 系数」算，不是归档字节数', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))

  // 高度可压缩的包：归档几 KB，解压后几百 KB（`MAX_INFLATE_RATIO` 只对 ≥16MiB 的条目生效，不误伤）
  const file = archiveOf(['big'], { compress: true, content: 'A'.repeat(400_000) })
  const layout = await readArchiveLayout(file)
  assert.ok(
    layout.inflatedBytes > file.size * 4,
    `前置：这个包的解压后总量（${layout.inflatedBytes}）必须远大于归档字节数（${file.size}）`
  )

  // 可用空间 = 归档字节数的 2 倍：按**归档字节数**估需求会放行，按解压后总量估必须拒绝
  const free = file.size * 2
  const restore = withStorage(estimateOf({ quota: 1000 * MB, free }))
  try {
    const { error } = await runImport(file)
    assert.equal(
      error?.key,
      'historyImportInsufficientSpace',
      '拿压缩体当需求会算出假余量 —— 这正是 ④ 要挡的错误做法'
    )
    assert.equal(
      error.params.need,
      formatImportBytes(
        Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
      ),
      'need 必须来自解压后总量 × 系数（含写放大）'
    )
    assert.notEqual(error.params.need, formatImportBytes(Math.ceil(file.size * IMPORT_QUOTA_SAFETY_FACTOR)))
    assert.equal(db.counts.addStagingSession, 0)
  } finally {
    restore()
  }

  // 反向：给够解压后总量对应的余量 → 同一个包放行
  resetStaging()
  const restore2 = withStorage(
    estimateOf({
      quota: 1000 * MB,
      free: Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR),
    })
  )
  try {
    const { error } = await runImport(file)
    assert.equal(error, null, '空间够就要能导入这个高压缩比的合法包')
    assert.equal(db.stagingSessions.length, 1)
  } finally {
    restore2()
  }
})

// ------------------------------------------------------------------ ⑤ 进度

test('⑤ 进度单调不减、最后到达 100%，已处理会话数正确', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free: 900 * MB })))

  const ids = ['p1', 'p2', 'p3', 'p4']
  const file = archiveOf(ids)
  const layout = await readArchiveLayout(file)
  const seen = []
  const { error } = await runImport(file, {
    totalSessions: ids.length,
    onProgress: (progress) => seen.push({ ...progress }),
  })
  assert.equal(error, null)

  // 百分比：单调不减、以 100 收尾，且只在有真实条目数时出现
  const percents = seen.filter((p) => p.percent !== undefined).map((p) => p.percent)
  assert.ok(percents.length >= 3, `百分比要给够多次（实际 ${percents.length} 次）`)
  for (let index = 1; index < percents.length; index += 1) {
    assert.ok(
      percents[index] >= percents[index - 1],
      `百分比必须单调不减：第 ${index} 次 ${percents[index]} < 上一次 ${percents[index - 1]}`
    )
  }
  assert.equal(percents.at(-1), 100, '最后一次必须是 100%')
  // 100% 只能来自「条目全部消费完」，不能来自补齐
  assert.equal(seen.at(-1).entries, layout.entries, '收尾时报的已消费条目数必须等于中央目录条目总数')
  assert.equal(seen.at(-1).totalEntries, layout.entries)

  // 会话数：单调不减，最大值 == 真实入库数，且中途停在某个中间值（真的在推进而不是一步到顶）
  const sessions = seen.map((p) => p.sessions)
  for (let index = 1; index < sessions.length; index += 1) {
    assert.ok(sessions[index] >= sessions[index - 1], '已处理会话数必须单调不减')
  }
  assert.equal(Math.max(...sessions), ids.length, '已处理会话数要与包里的会话数一致')
  assert.equal(db.stagingSessions.length, ids.length)
  assert.ok(
    sessions.some((value) => value > 0 && value < ids.length),
    '必须存在 0 < n < 总数 的中间态 —— 一步跳到总数说明进度是假的'
  )

  // 阶段顺序：reading → importing → finalizing，一个都不许跳
  const stages = seen.map((p) => p.stage)
  assert.equal(stages[0], 'reading', '第一阶段是读目录 + 预检')
  assert.ok(stages.includes('importing'), '必须有逐会话入库阶段')
  assert.equal(stages.at(-1), 'finalizing', '最后是收尾')
  assert.ok(
    stages.indexOf('reading') < stages.indexOf('importing') &&
      stages.indexOf('importing') < stages.lastIndexOf('finalizing'),
    '阶段顺序必须是 reading → importing → finalizing'
  )
})

test('⑤ 对照：百分比按「条目」推进，不是按会话数凑（只有一个会话也有中间值）', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free: 900 * MB })))

  // 只有 1 条会话：如果百分比是按会话数算的，序列只可能是 0 → 100（中间没有任何值）。
  // 按已消费条目算则是 0 → 20 → … → 100（manifest / 会话 / index 共 3 条，加上重复上报）。
  const seen = []
  const { error } = await runImport(archiveOf(['only']), { onProgress: (p) => seen.push({ ...p }) })
  assert.equal(error, null)

  const percents = [...new Set(seen.map((p) => p.percent).filter((value) => value !== undefined))]
  assert.ok(
    percents.some((value) => value > 0 && value < 100),
    `必须出现 0 < percent < 100 的中间值（实际 ${percents.join('/')}）—— 否则进度就是按会话数一步到顶`
  )
  // 没有条目总数的进度一律不许带百分比（宁可不画，也不猜）
  for (const progress of seen) {
    if (progress.totalEntries === undefined) {
      assert.equal(progress.percent, undefined, '没有条目总数就不许给百分比')
    }
  }
})

// ------------------------------------------------------------------ ⑥ 取消

test('⑥ 取消：停止导入、清理被调用、不留半截数据', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free: 900 * MB })))

  const ids = ['c1', 'c2', 'c3', 'c4', 'c5']
  const file = archiveOf(ids)
  const controller = new AbortController()
  const seen = []
  const { error } = await runImport(file, {
    signal: controller.signal,
    totalSessions: ids.length,
    onProgress: (progress) => {
      seen.push({ ...progress })
      // 第 2 条会话进暂存之后点取消：此时暂存里确实已经有东西了，
      // 「取消后不留残留」才是一条有内容的断言（空着手取消证明不了清理）。
      if (progress.sessions === 2) {
        controller.abort()
      }
    },
  })

  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportCancelled', '取消是独立的一档，不是「导入失败」')
  assert.equal(controller.signal.aborted, true, '前置：确实是用户取消')

  // 停止了：没有把 5 条全导完
  assert.ok(db.counts.addStagingSession < ids.length, '取消后不许继续处理剩余会话')
  assert.ok(Math.max(...seen.map((p) => p.sessions)) < ids.length)

  // 清理被调用，且真的清空了（走既有 db.clearStaging()）
  assert.equal(db.counts.clearStaging, 1, '取消必须调用一次清理（且只调一次）')
  assert.equal(db.stagingSessions.length, 0, '已写入的暂存会话必须被清掉')
  assert.equal(db.stagingFiles.size, 0, '暂存原件也要清掉')
  assert.equal(db.stagingFileTypes.size, 0)
})

test('⑥ 反向：没取消时不清理暂存（不许在正常路径上顺手清数据）', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withStorage(estimateOf({ quota: 1000 * MB, free: 900 * MB })))

  const controller = new AbortController()
  const { error } = await runImport(archiveOf(['n1', 'n2']), { signal: controller.signal })

  assert.equal(error, null)
  assert.equal(db.counts.clearStaging, 0, '正常导入不许清暂存（清了就等于导了个空）')
  assert.equal(db.stagingSessions.length, 2)
})

// ------------------------------------------------------------------ ⑦ 上限常量

/** 从源码文本读模块私有常量（`MAX_INFLATE_TOTAL_BYTES` 不导出 —— 导出就等于允许别人改这一处）。 */
const readNumberConst = async (relative, name) => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const text = await readFile(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
  const matched = text.match(new RegExp(`const ${name} = ([0-9_\\s*]+)\\n`))
  assert.ok(matched, `${relative} 里找不到 \`const ${name} = <算式>\`（被改名 / 搬走了？）`)
  return Number(new Function(`return (${matched[1].replace(/_/g, '')})`)())
}

test('⑦ 上限：导入 500MiB、导出自动跟随、解压闸 ≥ 4 倍、压缩比闸不动', async () => {
  assert.equal(DEFAULT_MAX_IMPORT_BYTES, 500 * 1024 * 1024, '导入上限 = 500MiB')
  assert.equal(maxImportMegabytes(), 500, '文案里的 MB 数由上限推导（没有第二份数字）')

  // 导出上限是同一个常量的转出：导得出就必须导得回
  assert.equal(MAX_EXPORT_BYTES, DEFAULT_MAX_IMPORT_BYTES, '导出上限自动跟随，不许另写一个数字')

  const MAX_INFLATE_TOTAL_BYTES = await readNumberConst('src/services/chat/history/zipReader.ts', 'MAX_INFLATE_TOTAL_BYTES')
  const MAX_INFLATE_RATIO = await readNumberConst('src/services/chat/history/zipReader.ts', 'MAX_INFLATE_RATIO')

  assert.equal(MAX_INFLATE_TOTAL_BYTES, 2 * 1024 * 1024 * 1024, '解压总量闸同比放大到 2GiB')
  assert.ok(
    MAX_INFLATE_TOTAL_BYTES / DEFAULT_MAX_IMPORT_BYTES >= 4,
    `解压闸 ÷ 导入上限必须 ≥ 4（现值 ${MAX_INFLATE_TOTAL_BYTES / DEFAULT_MAX_IMPORT_BYTES}）`
  )
  assert.equal(MAX_INFLATE_RATIO, 200, 'zip bomb 比值闸与上限无关，绝对不许跟着动')
  assert.ok(IMPORT_QUOTA_SAFETY_FACTOR >= 1, '安全系数必须 ≥ 1（小于 1 等于按「刚好塞满」判定）')
})

test('⑦ 直链导入的时间预算按新上限重算（≥ 60 分钟，且与上限仍自洽）', async () => {
  const { LIMITS, MIN_ACCEPTABLE_BYTES_PER_SEC, isImportBudgetConsistent } = await import(
    '../../src/services/limits.ts'
  )
  assert.equal(LIMITS.importMaxBytes, DEFAULT_MAX_IMPORT_BYTES, 'LIMITS 只做转出')
  assert.ok(LIMITS.importMaxTotalMs >= 60 * 60_000, '500MiB 的预算至少要 60 分钟（原 30 分钟是按 200MiB 推的）')
  assert.equal(isImportBudgetConsistent(), true, '上限 ÷ 总预算仍要满足最低带宽门槛（#152）')
  const required = LIMITS.importMaxBytes / (LIMITS.importMaxTotalMs / 1000)
  assert.ok(
    required >= MIN_ACCEPTABLE_BYTES_PER_SEC,
    `所需最低带宽 ${Math.round(required)}B/s 低于门槛 ${MIN_ACCEPTABLE_BYTES_PER_SEC}`
  )
})

// ---------------------------------- ⑥ 空间判据分级（#1002 第二轮：estimate 不证明写盘安全）

/**
 * 设备二次事故：`estimate()` 报着**正常值**（quota 3.7GB / usage 45.6MB），真实剩余只有 6MB；
 * 20MB 包一路写到底 → LevelDB 半条记录（`Corruption: partial record`）→ Chromium 判损坏并重建 →
 * 43MB 附件、48 个会话全丢。所以判据改成：
 *
 *  - **唯一可信来源** = 原生 `freeBytes`（`setNativeFreeBytesReader` 注入的就是它那条链）；
 *  - `estimate()` 只做否决（说「不够」可信，说「够」不作数）；
 *  - 空间未知 → 小负载放行（≤ `SMALL_IMPORT_PAYLOAD_BYTES`，16MiB）、大负载拒绝，
 *    且拒绝文案**不许**说「空间不足」。
 *
 * 大负载用「未压缩 + 20MB 正文」的包造（现场那个包就是 20MB）：解压后 ~20MB，落在分级线之上。
 * 不能再用「高压缩比 + 400 万字节」那招：4MB 的正文没有超过 16MiB 的负载线
 * （那是 Issue #153 负向对照要求「照常导入」的量级，见 `import-hardening.test.mjs`）；
 * 而 20MB 全同一字符 + 压缩会撞上解压闸的比值上限（`RATIO_MIN_OUTPUT_RATIO`），造不出合法包。
 */
const largeArchive = () => archiveOf(['big1'], { compress: false, content: 'A'.repeat(20 * 1024 * 1024) })

test('⑥a 大负载 + 空间未知 → 拒绝，文案是「无法确认剩余空间」而不是「空间不足」', async (t) => {
  resetStaging()
  const notes = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withNativeFree(null))
  // 连 estimate 都没有：两个来源全未知
  t.after(withStorage(undefined))

  const file = largeArchive()
  const layout = await readArchiveLayout(file)
  const need = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  assert.ok(
    layout.inflatedBytes > SMALL_IMPORT_PAYLOAD_BYTES,
    `前置：解压量（${formatImportBytes(layout.inflatedBytes)}）必须落在大负载档（> ${formatImportBytes(SMALL_IMPORT_PAYLOAD_BYTES)}）`
  )

  const { error } = await runImport(file)

  assert.equal(error?.name, 'BackupError', '必须明确失败，不许静默跳过')
  assert.equal(
    error.key,
    'historyImportSpaceUnverifiable',
    '错误码要能分辨「读不到空间」与「空间不足」'
  )
  assert.equal(error.params.size, formatImportBytes(need), '文案要说清这次大约要多少（插值）')
  // 文案纪律：这一档**不许**说成空间不足
  assert.doesNotMatch(error.message, /空间不足|还差|请先清理/, `读不到空间 ≠ 没空间（实际：${error.message}）`)
  assert.match(error.message, /无法确认|重启应用/, '要给出可照做的下一步')
  assert.doesNotMatch(
    translate('historyImportSpaceUnverifiable', { size: '10MB' }),
    /空间不足|还差/,
    '文案资源本身也不许出现「空间不足」'
  )

  // 一个会话都不许落盘
  assert.equal(db.counts.addStagingSession, 0)
  assert.equal(db.stagingSessions.length, 0)
  assert.equal(db.counts.saveStagingFiles, 0)

  const note = notes.find((item) => item.fields['import.quota.state'] === 'unverifiable')
  assert.ok(note, '这一档要留痕')
  assert.equal(note.fields['import.space.tier'], 'large')
  assert.equal(note.fields['import.space.source'], 'none')
})

test('⑥b 大负载 + 原生明确不足 → 拒绝，文案**才是**「空间不足」（真数字来自原生）', async (t) => {
  resetStaging()
  const notes = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))

  const file = largeArchive()
  const layout = await readArchiveLayout(file)
  const need = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  // 现场值：盘里只剩 6MB
  const free = 6 * MB
  t.after(withNativeFree(free))
  // estimate 同时报着「很宽裕」，也不许影响判定
  t.after(withStorage(estimateOf({ quota: 3700 * MB, free: 3650 * MB })))

  const { error } = await runImport(file)

  assert.equal(error?.key, 'historyImportInsufficientSpace')
  assert.equal(error.params.need, formatImportBytes(need))
  assert.equal(error.params.free, formatImportBytes(free), '报的可用空间必须是原生真数字')
  assert.equal(error.params.short, formatImportBytes(need - free))
  assert.match(error.message, /空间不足|还差/, '可信来源说不够时要说实话')
  assert.equal(db.counts.addStagingSession, 0)

  const note = notes.find((item) => item.fields['import.quota.state'] === 'insufficient')
  assert.ok(note)
  assert.equal(note.fields['import.space.decidedBy'], 'native', '这一档是原生下的判断')
  assert.equal(note.fields['import.free.bytes'], free)
})

test('⑥c 大负载 + 原生够用 → 放行（原生说够就是够，estimate 说什么都不影响）', async (t) => {
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))

  const file = largeArchive()
  const layout = await readArchiveLayout(file)
  const need = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  t.after(withNativeFree(need))
  // estimate 是脏值：原生可信时不许把它带坏
  t.after(withStorage({ estimate: async () => ({ quota: 1000 * MB, usage: 18_446_744_073_709_552_000 }) }))

  const { error } = await runImport(file)
  assert.equal(error, null, `原生说够就必须能导（实际 ${error?.key}）`)
  assert.equal(db.stagingSessions.length, 1)
})

test('⑥d 小负载 + 空间未知 → 放行（试错代价可控），诊断记 small 档', async (t) => {
  resetStaging()
  const notes = []
  setImportSpaceNoteSink((note) => notes.push(note))
  t.after(() => setImportSpaceNoteSink(undefined))
  t.after(withNativeFree(null))
  t.after(withStorage(undefined))

  const { error } = await runImport(archiveOf(['s1', 's2']))
  assert.equal(error, null, '小包不该被「读不到空间」拦住')
  assert.equal(db.stagingSessions.length, 2)
  const note = notes.find((item) => item.fields['import.quota.state'] === 'unmeasurable')
  assert.ok(note)
  assert.equal(note.fields['import.space.tier'], 'small')
})

test('⑥e estimate 脏值 + 原生可信 → 以原生为准（两个方向都不许被 estimate 翻盘）', async (t) => {
  const file = largeArchive()
  const layout = await readArchiveLayout(file)
  const need = Math.ceil(layout.inflatedBytes * IMPORT_QUOTA_SAFETY_FACTOR * WRITE_AMPLIFICATION_FACTOR)
  const dirty = { estimate: async () => ({ quota: 1000 * MB, usage: 18_446_744_073_709_552_000 }) }

  // 方向一：原生够 + estimate 脏 → 放行
  resetStaging()
  setImportSpaceNoteSink(() => {})
  t.after(() => setImportSpaceNoteSink(undefined))
  const restoreEnough = withNativeFree(need)
  const restoreDirty = withStorage(dirty)
  try {
    const { error } = await runImport(file)
    assert.equal(error, null, 'estimate 脏值不许把可信的原生读数带成「拒绝」')
    assert.equal(db.stagingSessions.length, 1)
  } finally {
    restoreEnough()
    restoreDirty()
  }

  // 方向二：原生不够 + estimate 看着很宽裕 → 仍然拒绝
  resetStaging()
  const restoreShort = withNativeFree(MB)
  const restorePlenty = withStorage(estimateOf({ quota: 3700 * MB, free: 3650 * MB }))
  try {
    const { error } = await runImport(file)
    assert.equal(error?.key, 'historyImportInsufficientSpace', 'estimate 说够不作数，原生说不够就是不够')
    assert.equal(db.counts.addStagingSession, 0)
  } finally {
    restoreShort()
    restorePlenty()
  }
})
