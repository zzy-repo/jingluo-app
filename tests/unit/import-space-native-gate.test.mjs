// [layer: unit | 依赖: fake-indexeddb + idb（纯 Node 内存 IndexedDB） | 耗时: <30s]
//
// P0（设备实测：ENOSPC 把本地库写坏，48 个会话全丢）—— 导入前的空间闸门必须用**可信来源**。
//
// 现场（模拟器 emulator-5554，UTC 12:12–12:19）：
//   1. `navigator.storage.estimate()` 报 `{usage:45 621 038, quota:3 736 869 273}` —— **看起来**还有 3.6GB；
//      同一时刻 `stat -f` 的真实可用 ≈ 6MB；
//   2. 从链接导入一个 20MB 的导出包 → 盘被写到底（剩 ≈0.5MB）→ 报「已经下载完成，但本机无法读取」；
//   3. logcat：`leveldb_factory.cc(88) … Corruption: partial record without end(1)`；
//   4. Chromium 判定 IDB 损坏 → 重建：leveldb 剩 64K，43MB 的 `indexeddb.blob` 目录整个消失。
//
// 所以本文件的断言不是「estimate 脏值要当未知」，而是**更根本的一条**：
//   `estimate()` 的 quota 不等于磁盘余量，**预检通过本身就不构成写盘安全的证据**；
//   落盘前必须用原生 `freeBytes()`（`backup/nativeBackupFs.ts` 的 `availableBytes()` 那条链）交叉校验。
//
// 四条契约（都在**真** IndexedDB 上核对活动库，不是替身）：
//   T1 空间不足（现场基线：可用 6MB / 载荷 20MB）→ **在任何写入之前**拒绝，`sessions`/`files`/`attachments`
//      的内容与计数一字未变，staging 无残留；
//   T2 写库过程中抛 ENOSPC → 同上（活动库一字未变）；
//   T3 空间未知 + 大负载 → 拒绝，且文案**不许**说成「空间不足」（那是在撒谎，用户会去清无用空间）；
//   T4 空间未知 + 小负载（≤ 现有量级阈值 16MiB，见 `SMALL_IMPORT_PAYLOAD_BYTES`）→ 允许尝试
//      （不许因为估不出来就让人完全不能导入；这一条同时是 Issue #153 那个「10MB 合法包」的负向对照）。
//
// 为什么用真 `chat/db.ts`（与 memory-session-scope-399 同一理由）：被测的是「活动库有没有被碰过」，
// 给 db 打桩等于把被测物换成替身 —— 断言再绿也说明不了「一字节未变」。
//
//   node tests/unit/import-space-native-gate.test.mjs
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { openDB } from 'idb'
import { chatStub, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'
import { importErrorsStub } from '../helpers/import-env.mjs'

// 合并批次里其它文件可能已经装过；这里是幂等的（#513）。
installFakeIdbGlobals()
installMinimalLocalStorage()

// 装配：`./errors.js` 等价替身（真 errors.ts 用了 TS 参数属性，strip-only 跑不了）+
// Capacitor 替身（`isNativePlatform()` 恒 false —— 默认的原生探测因此返回 `null`，见 T3/T4）。
installTsResolve({
  stubs: [
    ['./errors.js', importErrorsStub()],
    ['@capacitor/core', chatStub('capacitor.mjs')],
  ],
})

const { sessionBytes, manifestBytes, indexBytes, zipFileOf } = await import(
  '../helpers/archive-builder.mjs'
)
const { formatImportBytes } = await import('../../src/services/chat/history/importLimit.ts')
const chatDb = await loadTsModule('src/services/chat/db.ts')
const quota = await import('../../src/services/chat/history/quotaPrecheck.ts')
const { setImportSpaceNoteSink } = quota
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { readArchiveLayout } = await import('../../src/services/chat/history/zipReader.ts')

const MB = 1024 * 1024

/**
 * 注入「原生可用字节」。**打成可选**：这条注入点就是本单要新增的能力，未打补丁的代码上没有它 ——
 * 用例在没有它的时候照样跑到底，红在断言上（而不是红在一个 TypeError 上）。
 */
const setNativeFreeBytesProbe = (probe) => {
  if (typeof quota.setNativeFreeBytesReader === 'function') {
    quota.setNativeFreeBytesReader(probe)
  }
}

// ---------------------------------------------------------------- 活动库快照（不经被测代码）

/**
 * 记录 → 可深比较的规范形：`Blob` 折成 `{type,size,sha256}`。
 * 不折的话 `assert.deepStrictEqual` 会把两个**内容不同**的 Blob 判成相等（Blob 没有自有可枚举属性），
 * 「一字节未变」这句话就假了。
 */
const canon = async (value) => {
  if (value instanceof Blob) {
    const bytes = Buffer.from(await value.arrayBuffer())
    return {
      __blob: true,
      type: value.type,
      size: value.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(canon))
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = await canon(value[key])
    }
    return out
  }
  return value
}

/** 活动库 + 暂存的整库快照（三个活动 store + 两个暂存 store）。 */
const snapshot = async () => {
  const conn = await openDB(chatDb.DB_NAME, chatDb.DB_VERSION)
  try {
    const read = async (store) =>
      conn.objectStoreNames.contains(store) ? canon(await conn.getAll(store)) : []
    return {
      sessions: await read('sessions'),
      files: await read('files'),
      attachments: await read('attachments'),
      sessionsStaging: await read('sessionsStaging'),
      filesStaging: await read('filesStaging'),
    }
  } finally {
    conn.close()
  }
}

/** 直接写活动库（不经 `saveSession`）：要断言的就是「这几条到底有没有被动过」。 */
const seedActiveLibrary = async () => {
  const conn = await openDB(chatDb.DB_NAME, chatDb.DB_VERSION)
  try {
    const tx = conn.transaction(['sessions', 'files', 'attachments'], 'readwrite')
    await tx.objectStore('sessions').put({
      id: 'keep-1',
      title: '本地已有会话',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', content: '不许动我', createdAt: 1 }],
    })
    await tx.objectStore('files').put({
      id: 'img-keep',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
    })
    await tx
      .objectStore('attachments')
      .put({ id: 'att-keep', sha256: 'x', mimeType: 'application/pdf', sizeBytes: 4 })
    await tx.done
  } finally {
    conn.close()
  }
}

const clearStagingStores = async () => {
  const conn = await openDB(chatDb.DB_NAME, chatDb.DB_VERSION)
  try {
    const tx = conn.transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
    await tx.objectStore('sessionsStaging').clear()
    await tx.objectStore('filesStaging').clear()
    await tx.done
  } finally {
    conn.close()
  }
}

// ---------------------------------------------------------------- navigator.storage 装拆

/** 装一个 `navigator.storage`；`undefined` = 整个对象都没有（老 WebView / 隐私模式）。 */
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

/** 现场基线：`estimate()` 报 3.7GB 总量 / 已用 45.6MB（健康值，正是这次「看起来够」的那份读数）。 */
const fieldEstimate = () => ({
  estimate: async () => ({ usage: 45_621_038, quota: 3_736_869_273 }),
})

// ---------------------------------------------------------------- 归档夹具

/** manifest → 会话 → index，与真实导出同形。`content` 决定解压后总量。 */
const archiveOf = (ids, content) =>
  zipFileOf([
    ['manifest.json', manifestBytes()],
    ...ids.map((id) => [`chat_sessions/${id}.json`, sessionBytes(id, content)]),
    ['chat_session_index.json', indexBytes(ids)],
  ])

const runImport = async (file, options = {}) => {
  try {
    return { error: null, result: await importArchive(file, options) }
  } catch (error) {
    return { error, result: null }
  }
}

/** 每个用例前：清暂存 + 装现场活动库 + 还原注入点。 */
const prepare = async (t) => {
  setImportSpaceNoteSink(() => {})
  t.after(() => {
    setImportSpaceNoteSink(undefined)
    setNativeFreeBytesProbe(undefined)
  })
  await chatDb.loadSessionSummaries()
  await clearStagingStores()
  const conn = await openDB(chatDb.DB_NAME, chatDb.DB_VERSION)
  try {
    const tx = conn.transaction(['sessions', 'files', 'attachments'], 'readwrite')
    await Promise.all([
      tx.objectStore('sessions').clear(),
      tx.objectStore('files').clear(),
      tx.objectStore('attachments').clear(),
    ])
    await tx.done
  } finally {
    conn.close()
  }
  await seedActiveLibrary()
}

// ---------------------------------------------------------------- T1 现场基线

test('T1 可用 6MB / 载荷 20MB：写入之前就拒绝，活动库一字未变', async (t) => {
  await prepare(t)
  // 原生的可信读数：真实可用 6MB（现场 `stat -f` Available ≈ 6MB）
  setNativeFreeBytesProbe(async () => 6 * MB)
  // 同一时刻 estimate() 报的是「健康」的 3.6GB —— 关键：它通过**不构成**写盘安全的证据
  t.after(withStorage(fieldEstimate()))

  // 20MB 的导出包（现场那个包的体积）
  const file = archiveOf(['s1'], 'A'.repeat(20 * MB))
  const layout = await readArchiveLayout(file)
  assert.ok(
    layout.inflatedBytes >= 20 * MB,
    `前置：载荷要 ≥20MB，实际 ${layout.inflatedBytes}`
  )

  const before = await snapshot()
  const { error } = await runImport(file)
  const after = await snapshot()

  assert.equal(error?.name, 'BackupError', `必须拒绝，实际 ${error === null ? '导入成功' : error.name}`)
  assert.equal(
    error.key,
    'historyImportInsufficientSpace',
    `可信余量明显不够时必须报「空间不足」（实际 ${error.key}）`
  )
  // 三个数字都插值出来：需要多少 / 当前可用多少 / 还差多少
  assert.equal(error.params.free, formatImportBytes(6 * MB), '文案里的「当前可用」必须是原生读数')
  // need = 解压总量 × 安全系数 × 写放大（同一套系数，不在这里另算一套）
  const need = Math.ceil(layout.inflatedBytes * 1.25 * 2)
  assert.equal(error.params.need, formatImportBytes(need), 'need 是「载荷 × 安全系数 × 写放大」')
  assert.equal(error.params.short, formatImportBytes(need - 6 * MB), '还差多少也要给')

  // 活动库：三个 store 的内容与计数一字未变
  assert.deepEqual(after.sessions, before.sessions, 'sessions 一个字节都不许变')
  assert.deepEqual(after.files, before.files, 'files 一个字节都不许变')
  assert.deepEqual(after.attachments, before.attachments, 'attachments 一个字节都不许变')
  assert.equal(after.sessions.length, 1, '本地那条会话还在')
  assert.deepEqual(after.sessionsStaging, [], '暂存里不许有残留')
  assert.deepEqual(after.filesStaging, [], '暂存原件里不许有残留')
})

// ---------------------------------------------------------------- T2 写库过程中 ENOSPC

test('T2 写暂存时抛 ENOSPC：活动库一字未变，不留半截', async (t) => {
  await prepare(t)
  // 空间判定这一层先放行（余量充足），让失败发生在**写库那一步** —— 这才是 ENOSPC 的真实形状
  setNativeFreeBytesProbe(async () => 1024 * MB)
  t.after(withStorage(fieldEstimate()))

  const proto = globalThis.IDBObjectStore.prototype
  const originalAdd = proto.add
  // 只让「写暂存会话」这一个动作失败：其余（清暂存、种子数据、快照读取）照常
  proto.add = function patchedAdd(...args) {
    if (this?.name === 'sessionsStaging') {
      throw new DOMException('The disk is full (ENOSPC)', 'QuotaExceededError')
    }
    return originalAdd.apply(this, args)
  }
  t.after(() => {
    proto.add = originalAdd
  })

  const file = archiveOf(['s1', 's2'])
  const before = await snapshot()
  const { error } = await runImport(file)
  const after = await snapshot()

  assert.notEqual(error, null, '写库失败必须抛出，不许静默「成功」')
  assert.deepEqual(after.sessions, before.sessions, '写库失败后 sessions 一字未变')
  assert.deepEqual(after.files, before.files, '写库失败后 files 一字未变')
  assert.deepEqual(after.attachments, before.attachments, '写库失败后 attachments 一字未变')
  assert.deepEqual(
    after.sessionsStaging,
    [],
    '失败的写入不许在暂存里留下半截会话（要么没写进去，要么被清掉）'
  )
})

// ---------------------------------------------------------------- T3 空间未知 + 大负载

test('T3 空间未知 + 大负载 → 拒绝，且文案不许说成「空间不足」', async (t) => {
  await prepare(t)
  setNativeFreeBytesProbe(async () => null)
  // 拿不到任何可信读数：没有原生出口，estimate 也不可用
  t.after(withStorage(undefined))

  const file = archiveOf(['s1'], 'A'.repeat(20 * MB))
  const before = await snapshot()
  const { error } = await runImport(file)
  const after = await snapshot()

  assert.notEqual(error, null, '大负载 + 空间无法确认 → 必须拒绝（宁可拒绝导入，也不能赌整库）')
  assert.equal(
    error.key,
    'historyImportSpaceUnverifiable',
    `要能和「空间不足」分开（实际 ${error.key}）`
  )
  assert.doesNotMatch(
    error.message,
    /空间不足|空间不够|还差/,
    '拿不到读数不等于没空间：文案不许说成「空间不足」，否则用户会去清无用空间还是失败'
  )
  assert.match(error.message, /无法确认|暂时无法/, '文案要说清是「确认不了」')
  assert.match(error.message, /重启/, '文案要给一个用户能照做的动作')
  assert.deepEqual(after.sessions, before.sessions, 'sessions 一字未变')
  assert.deepEqual(after.sessionsStaging, [], '暂存无残留')
})

// ---------------------------------------------------------------- T4 空间未知 + 小负载

test('T4 空间未知 + 10MB 合法包（Issue #153 负向对照）→ 允许尝试，不误拦', async (t) => {
  await prepare(t)
  setNativeFreeBytesProbe(async () => null)
  t.after(withStorage(undefined))

  // 10MB 的合法包：高压缩比但体量小，既有契约（import-hardening #153）要求照常导入
  const file = archiveOf(['s1', 's2'], 'A'.repeat(5 * MB))
  const layout = await readArchiveLayout(file)
  console.log(`    -> inflated=${layout.inflatedBytes} 分级线=${quota.SMALL_IMPORT_PAYLOAD_BYTES}`)
  assert.ok(
    layout.inflatedBytes <= quota.SMALL_IMPORT_PAYLOAD_BYTES,
    `前置：这一档要落在分级线以内（实际 ${layout.inflatedBytes} > ${quota.SMALL_IMPORT_PAYLOAD_BYTES}）`
  )

  const { error } = await runImport(file)

  assert.equal(error, null, `小包不许因为「估不出来」被拦住（实际 ${error?.key}）`)
  const after = await snapshot()
  assert.equal(after.sessionsStaging.length, 2, '两条会话照常进暂存')
  assert.equal(after.sessions.length, 1, '小负载放行不代表动了活动库（提交另有事务）')
})
