// [layer: unit | 原生备份与恢复核心（#993 任务 2）：原子写入 / 校验 / 空库保护 / 保留策略，注入替身，无设备]
//
// 这一层只钉**行为**，不读源码做断言：
//   [1] 原子写入失败不破坏上一份有效备份（临时文件没有变成备份，旧档逐字节不变）；
//   [2] 校验失败拒绝恢复（内容与清单不符时恢复前就拒，且一个字节都不动现有数据）；
//   [3] 异常空库不覆盖历史备份（空库既不写新份，也不清理任何旧份）；
//   [4] 恢复前必须先做安全备份，安全备份失败就中止（`safety-backup-failed`）；
//   [5] 保留策略：份数上限、最新一份永不删、唯一有效备份不许删。
//   [7] 状态文件写入失败时，盘上旧 `status.json` 原文仍在且可解析（不会整份消失）。
//
// 替身范围：`@capacitor/core`（能力探测 + 插件桥）、`BackupFile` 桥（内存文件系统，语义照抄
// `BackupFilePlugin.java`：`<name>.part` → 校验 → rename）、以及 `chat/backup.js`
// （`exportHistory` / `importHistory`）—— 真实实现要 IndexedDB + zustand，不在 L0 里跑。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { installTsResolve, inlineModule, loadTsModule } from '../helpers/dom-env.mjs'

/* ------------------------------------------------------------------ 原生桥替身（内存文件系统） */

/** 已提交的文件：name → 字节 */
const committed = new Map()
/** 正在写的临时文件 */
let pending = null
let freeBytesValue = 1024 * 1024 * 1024
/**
 * 唯一允许同名替换的文件（原生侧白名单，见 `BackupFilePlugin.OVERWRITABLE_NAME`）。
 * 这里写死一份，测试里再与 `core.STATUS_FILE_NAME` 对齐 —— 两边一旦漂开必须红。
 */
const STATUS_NAME = 'status.json'

/** 失败注入：'chunk' 写块失败 / 'verify' 收尾校验失败 / null 正常 */
let failMode = null
/** 只让这一个文件名的写块失败（null = 不限文件）：用来单独打挂 `status.json` 那一笔 */
let failName = null

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

const codedError = (code, message = code) => Object.assign(new Error(message), { code })

const pendingBytes = () => Buffer.concat(pending ? pending.chunks : [])

const bridge = {
  begin: async ({ name, allowOverwrite }) => {
    // 语义照抄原生 `begin`：默认拒绝同名覆盖，唯一例外是「调用方明确要求 + 名字在白名单里」
    const mayOverwrite = allowOverwrite === true && name === STATUS_NAME
    if (committed.has(name) && !mayOverwrite) {
      throw codedError('TARGET_EXISTS')
    }
    pending = { name, chunks: [], mayOverwrite }
    return { name }
  },
  writeChunk: async ({ data }) => {
    if (failMode === 'chunk' && (failName === null || pending?.name === failName)) {
      throw codedError('WRITE_FAILED', '写入备份失败')
    }
    pending.chunks.push(Buffer.from(data, 'base64'))
  },
  finish: async ({ name }) => {
    if (!pending) {
      throw codedError('NO_WRITE')
    }
    if (failMode === 'verify') {
      pending = null
      throw codedError('CHECKSUM_MISMATCH', '校验值与落盘内容不一致')
    }
    const bytes = pendingBytes()
    const mayOverwrite = pending.mayOverwrite
    pending = null
    // 原生 `finish` 在 rename 之前还会再查一次：非白名单目标即使走到这里也不许覆盖
    if (committed.has(name) && !mayOverwrite) {
      throw codedError('TARGET_EXISTS', '同名备份已存在')
    }
    committed.set(name, bytes)
    return { name, sizeBytes: bytes.length, sha256: hex(bytes) }
  },
  abort: async () => {
    pending = null
  },
  list: async () => ({
    files: [...committed.entries()].map(([name, bytes]) => ({
      name,
      sizeBytes: bytes.length,
      mtimeMs: Date.now(),
    })),
  }),
  readChunk: async ({ name, offset, length }) => {
    const bytes = committed.get(name)
    if (!bytes) {
      throw codedError('NOT_FOUND')
    }
    const slice = bytes.subarray(offset, Math.min(offset + length, bytes.length))
    return { data: Buffer.from(slice).toString('base64'), eof: offset + slice.length >= bytes.length }
  },
  hash: async ({ name }) => {
    const bytes = committed.get(name)
    if (!bytes) {
      throw codedError('NOT_FOUND')
    }
    return { sha256: hex(bytes), sizeBytes: bytes.length }
  },
  remove: async ({ name }) => {
    committed.delete(name)
  },
  freeBytes: async () => ({ bytes: freeBytesValue }),
}

globalThis.__bridge = bridge
globalThis.__native = true

/* ------------------------------------------------------------------ chat 侧替身（导出 / 导入） */

/** 下一次 `exportHistory` 返回的会话数 */
let nextSessions = 3
/** 归档正文：跟着会话数变，便于断言「这份备份里有几条会话」 */
const archiveBytes = (sessions) => Buffer.from(`archive:${sessions}:${'x'.repeat(64)}`)
/** `exportHistory` 是否抛错（模拟打包阶段失败） */
let exportFails = false
/** `importHistory` 调用记录 */
const importCalls = []
let importFails = false

const chatStub = inlineModule(`
export const exportHistory = async () => {
  if (globalThis.__exportFails) { throw Object.assign(new Error('export boom'), { code: 'X' }) }
  const sessions = globalThis.__nextSessions
  return { name: 'deepseek_data-test.zip', blob: new Blob([globalThis.__archiveBytes(sessions)]), sessions }
}
export const importHistory = async (file, options) => {
  globalThis.__importCalls.push({ size: file.size, mode: options && options.mode })
  if (globalThis.__importFails) { throw new Error('import boom') }
  return { count: 1, mode: 'overwrite', added: 1, overwritten: 0, skipped: 0 }
}
`)

globalThis.__nextSessions = nextSessions
globalThis.__archiveBytes = archiveBytes
globalThis.__importCalls = importCalls
globalThis.__exportFails = false
globalThis.__importFails = false

installTsResolve({
  stubs: [
    [
      /^@capacitor\/core$/,
      inlineModule(
        'export const Capacitor = { isNativePlatform: () => globalThis.__native === true }; export const registerPlugin = () => globalThis.__bridge;'
      ),
    ],
  ],
  onResolve: (specifier, context) => {
    if (specifier === '../chat/backup.js') {
      return chatStub
    }
    if (specifier === '../attachments/store.js') {
      return inlineModule('export const listAttachments = async () => []; export const readAttachmentBlob = async () => undefined; export const putAttachment = async () => {};')
    }
    if (specifier === '../diagnostics/collector.js') {
      return inlineModule('export const record = () => ({}); export const recordError = () => ({}); export const recordAction = () => ({});')
    }
    if (context?.parentURL?.includes('/services/backup/') && /^\.\.\/(chat|chat\/history)\//.test(specifier)) {
      return inlineModule('export const writeArchive = async () => new Blob([]); export const readArchive = async function* () {}; export const readEntry = async () => new Blob([]); export const saveFiles = async () => {};')
    }
    return undefined
  },
})

const core = await loadTsModule('src/services/backup/backupCore.ts')
const api = await loadTsModule('src/services/backup/backupApi.ts')

const reset = () => {
  committed.clear()
  pending = null
  failMode = null
  failName = null
  freeBytesValue = 1024 * 1024 * 1024
  globalThis.__nextSessions = 3
  globalThis.__exportFails = false
  globalThis.__importFails = false
  importCalls.length = 0
}

const filesOf = (id) => ({
  archive: committed.get(core.archiveFileName(id)),
  manifest: committed.get(core.manifestFileName(id)),
})

const backupsWithPrefix = () =>
  [...committed.keys()].filter((name) => name.startsWith(core.BACKUP_ID_PREFIX))

/* ------------------------------------------------------------------ [0] 纯逻辑 */

test('[0] 备份 id / 文件名 / 清单往返 / 失败分类', async () => {
  const date = new Date(Date.UTC(2026, 10, 27, 10, 5, 0, 123))
  const id = core.backupIdOf(date)
  assert.equal(id, 'b-20261127T100500123Z')
  assert.equal(core.parseManifestFileName(core.manifestFileName(id)), id)
  assert.equal(core.parseManifestFileName('status.json'), null)

  const manifest = {
    backup_format_version: core.BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: date.toISOString(),
    archive: { name: core.archiveFileName(id), sizeBytes: 10, sha256: 'a'.repeat(64) },
    attachments: null,
    data_summary: { sessions: 4, attachments: 0 },
    verified: true,
  }
  const parsed = core.parseManifest(JSON.parse(core.manifestToJson(manifest)))
  assert.deepEqual(parsed, manifest)
  // 版本不对 / 摘要长度不对：一律当读不懂（恢复前就该判 corrupt）
  assert.equal(core.parseManifest({ ...manifest, backup_format_version: 99 }), null)
  assert.equal(
    core.parseManifest({ ...manifest, archive: { ...manifest.archive, sha256: 'abc' } }),
    null
  )

  assert.equal(core.classifyFailure({ code: 'NO_SPACE' }), 'space')
  assert.equal(core.classifyFailure({ code: 'CHECKSUM_MISMATCH' }), 'corrupt')
  assert.equal(core.classifyFailure({ code: 'BUSY' }), 'interrupted')
  assert.equal(core.classifyFailure(new Error('boom')), 'unknown')
})

test('[0b] 保留策略：最新一份永不删、唯一有效备份不许删', async () => {
  /** hour 越大越新（UTC 同一天的整点） */
  const item = (id, hour, checksumOk = true) => ({
    id,
    createdAtUtc: new Date(Date.UTC(2026, 10, 27, hour, 0, 0)).toISOString(),
    sizeBytes: 10,
    checksumOk,
  })
  // 4 份、上限 3：删最旧那份（h0 是 0 点，最老）
  assert.deepEqual(core.selectPrunable([item('b-0', 0), item('b-1', 1), item('b-2', 2), item('b-3', 3)], 3), ['b-0'])
  // 只有最新一份校验通过：删到只剩它
  assert.deepEqual(
    core.selectPrunable([item('b-0', 0, false), item('b-1', 1, false), item('b-2', 2, true), item('b-3', 3, false)], 1),
    ['b-1', 'b-0']
  )
  // 所有份都损坏：不把「唯一（最新的）」那份当成超出的份数删掉
  assert.deepEqual(core.selectPrunable([item('b-0', 0, false), item('b-1', 1, false)], 1), ['b-0'])
})

/* ------------------------------------------------------------------ [1] 原子写入失败不破坏旧档 */

test('[1] 写块失败：旧备份逐字节不变，失败分类为 interrupted', async () => {
  reset()
  const first = await api.runBackup('manual')
  const before = filesOf(first.id)
  assert.ok(before.archive && before.manifest)
  assert.equal(first.checksumOk, true)
  assert.equal(first.sessionCount, 3)

  failMode = 'chunk'
  await assert.rejects(api.runBackup('manual'), (error) => {
    assert.equal(error.name, 'BackupError')
    assert.equal(error.code, 'interrupted')
    // 备份失败不动现有数据
    assert.equal(error.currentDataIntact, true)
    assert.equal(error.stage, 'write')
    return true
  })

  // 旧档一个字节都没变；失败的那一份没有留下任何「看着像备份」的文件
  assert.deepEqual(filesOf(first.id), before)
  const names = backupsWithPrefix()
  assert.equal(names.filter((name) => name.endsWith(core.MANIFEST_SUFFIX)).length, 1)
  const items = await api.listBackups()
  assert.equal(items.length, 1)
  assert.equal(items[0].id, first.id)
  assert.equal(items[0].checksumOk, true)

  // 状态里留的是分类，不是异常原文
  const status = await api.getStatus()
  assert.equal(status.lastError, 'interrupted')
  assert.equal(status.lastSuccessAtUtc, first.createdAtUtc)
})

test('[1b] 收尾校验失败：不产出新备份，旧档仍在', async () => {
  reset()
  const first = await api.runBackup('manual')
  const before = filesOf(first.id)
  failMode = 'verify'
  await assert.rejects(api.runBackup('auto'), (error) => {
    assert.equal(error.code, 'corrupt')
    assert.equal(error.currentDataIntact, true)
    return true
  })
  assert.deepEqual(filesOf(first.id), before)
  assert.equal((await api.listBackups()).length, 1)
})

/* ------------------------------------------------------------------ [2] 校验失败拒绝恢复 */

test('[2] 归档内容与清单不符：恢复前就拒，不动现有数据', async () => {
  reset()
  const first = await api.runBackup('manual')
  // 模拟「盘上的字节被改过」：清单还是旧的，摘要对不上
  committed.set(core.archiveFileName(first.id), Buffer.from('tampered'))

  await assert.rejects(api.restoreBackup(first.id), (error) => {
    assert.equal(error.code, 'corrupt')
    assert.equal(error.currentDataIntact, true)
    assert.equal(error.stage, 'verify')
    return true
  })
  // 没有进入导入，也没有先做安全备份（目标都不可用，不该白写一份）
  assert.equal(importCalls.length, 0)
  assert.equal((await api.listBackups()).length, 1)
  // 列表里这条从此不能点恢复
  assert.equal((await api.listBackups())[0].checksumOk, false)
})

/* ------------------------------------------------------------------ [3] 空库不覆盖历史备份 */

test('[3] 空库：拒绝备份，历史备份一条不删不变', async () => {
  reset()
  const first = await api.runBackup('manual')
  const before = filesOf(first.id)
  globalThis.__nextSessions = 0
  await assert.rejects(api.runBackup('auto'), (error) => {
    assert.equal(error.code, 'empty')
    assert.equal(error.currentDataIntact, true)
    return true
  })
  assert.deepEqual(filesOf(first.id), before)
  assert.equal((await api.listBackups()).length, 1)
  // 空库拒绝备份这件事由上面抛出的 `empty` 承担；`getStatus()` **不再**把这条历史结论
  // 当「当前状态」播报（设备实测：用户后来写了对话，设置页仍显示「当前没有可备份的聊天记录」）
  assert.equal((await api.getStatus()).lastError, null)
})

/* ------------------------------------------------- [6] 丢库的机器：空库也要能恢复 */

test('[6] 本机 0 会话时恢复必须能进行（安全备份遇空库只跳过，不中止）', async () => {
  reset()
  const first = await api.runBackup('manual')
  // 模拟丢库：本机一条会话都没有
  globalThis.__nextSessions = 0
  await assert.rejects(api.runBackup('auto'), (error) => {
    assert.equal(error.code, 'empty')
    return true
  })
  // 这正是恢复功能存在的理由：空库时不能因为「没有数据可做安全备份」就拒绝恢复
  await api.restoreBackup(first.id)
  assert.equal(importCalls.length, 1)
  assert.equal(importCalls[0].mode, 'overwrite')
  // 空库没东西可保护，所以不该多出一份空的安全备份
  assert.equal((await api.listBackups()).length, 1)
  assert.equal((await api.getStatus()).lastError, null)
})

/* ------------------------------------------------------------------ [4] 恢复前必须先安全备份 */

test('[4a] 安全备份失败 ⇒ 中止恢复，现有数据一个字节都不动', async () => {
  reset()
  const first = await api.runBackup('manual')
  const before = filesOf(first.id)
  globalThis.__exportFails = true
  await assert.rejects(api.restoreBackup(first.id), (error) => {
    assert.equal(error.code, 'safety-backup-failed')
    assert.equal(error.currentDataIntact, true)
    assert.equal(error.stage, 'safety')
    return true
  })
  assert.equal(importCalls.length, 0)
  assert.deepEqual(filesOf(first.id), before)
  assert.equal((await api.listBackups()).length, 1)
})

test('[4b] 正常恢复：先落一份安全备份，再走导入，两份都在', async () => {
  reset()
  const first = await api.runBackup('manual')
  // 恢复前数据已经变了（3 → 5 条会话）：安全备份必须记录的是「现在」这份
  globalThis.__nextSessions = 5
  await new Promise((resolve) => setTimeout(resolve, 5))
  await api.restoreBackup(first.id)

  assert.equal(importCalls.length, 1)
  assert.equal(importCalls[0].mode, 'overwrite')
  const items = await api.listBackups()
  assert.equal(items.length, 2)
  const safety = items.find((item) => item.id !== first.id)
  assert.ok(safety, '恢复前必须留下一份安全备份')
  assert.equal(safety.sessionCount, 5)
  assert.equal(safety.checksumOk, true)
  assert.equal((await api.getStatus()).lastError, null)
})

/* ------------------------------------------------------------------ [5] 份数上限（跑通全链路） */

test('[5] 第 4 份成功后才清理旧份，最新一份保留', async () => {
  reset()
  const made = []
  for (let index = 0; index < 4; index += 1) {
    made.push(await api.runBackup('manual'))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const items = await api.listBackups()
  assert.equal(items.length, core.RETENTION_KEEP)
  assert.equal(items[0].id, made[3].id, '最新一份不能被清理')
  assert.deepEqual(
    items.map((item) => item.id),
    [...made.slice(1)].reverse().map((item) => item.id)
  )
  // 被清理的那份文件也真的从盘上消失（不是只从列表里藏起来）
  assert.equal(filesOf(made[0].id).archive, undefined)
  assert.equal(filesOf(made[0].id).manifest, undefined)
})

/* --------------------------------------- [7] 状态文件写入失败不整份消失（#993 回归） */

test('[7] 状态文件写入失败：盘上旧 status.json 原文仍在且可解析', async () => {
  reset()
  assert.equal(STATUS_NAME, core.STATUS_FILE_NAME, '替身的白名单名字必须与真实状态文件名一致')

  const first = await api.runBackup('manual')
  const beforeBytes = committed.get(STATUS_NAME)
  assert.ok(beforeBytes, '一次成功备份后应留下 status.json')
  const beforeText = beforeBytes.toString('utf8')
  const beforeParsed = core.parseStatusFile(beforeText)
  assert.equal(beforeParsed.last_success_at_utc, first.createdAtUtc)
  assert.equal(beforeParsed.last_error, null)

  // 只打挂 status.json 这一笔写块：备份本体照常成功，坏掉的只有状态这一份小文件
  await new Promise((resolve) => setTimeout(resolve, 5))
  failMode = 'chunk'
  failName = STATUS_NAME
  const second = await api.runBackup('manual')
  failMode = null
  failName = null
  assert.notEqual(second.createdAtUtc, first.createdAtUtc, '两次时间戳相同会让下面的「文本没变」变成空断言')

  // 断言必须看**盘上的原始文本**：`readStatusFile` 会与内存镜像 `memoryStatus` 合并，
  // `getStatus()` 在状态文件已经消失的情况下照样报得出来（假绿），所以这里不碰它。
  const afterBytes = committed.get(STATUS_NAME)
  assert.ok(afterBytes, '状态文件写入失败后，旧 status.json 不该从盘上消失')
  const afterText = afterBytes.toString('utf8')
  assert.equal(afterText, beforeText, '旧状态文本应逐字节不变')
  assert.equal(
    core.parseStatusFile(afterText).last_success_at_utc,
    first.createdAtUtc,
    '盘上旧文本必须仍可解析成上一份有效状态'
  )

  // 反向验证：状态写入这条路确实会覆盖同一个文件 —— 否则上面「文本没变」只是因为它根本没写过
  await new Promise((resolve) => setTimeout(resolve, 5))
  const third = await api.runBackup('manual')
  const overwritten = committed.get(STATUS_NAME)
  assert.ok(overwritten, '成功写入后 status.json 应在盘上')
  const overwrittenText = overwritten.toString('utf8')
  assert.notEqual(overwrittenText, beforeText, '状态文件必须能被同名替换成新内容')
  assert.equal(core.parseStatusFile(overwrittenText).last_success_at_utc, third.createdAtUtc)
})

/* --------------------- [8] 空间类过时结论自愈（设备实测：腾出空间后仍说「没空间」） */

// 场景：压盘 → 点「立即备份」→ `last_error:"space"`；把盘清干净之后，状态行必须不再念
// 「存储空间不足」。但**盘上是事实**：`status.json` 里那笔 `space` 允许留着（用户确实
// 在那一刻失败过），归零只发生在「播报层」（`getStatus()`），不改写盘上记录。

test('[8a] 空间真的不够：`space` 照报（不许因为「想自愈」把真话吞掉）', async () => {
  reset()
  await api.runBackup('manual')
  freeBytesValue = 0
  await assert.rejects(api.runBackup('manual'), (error) => {
    assert.equal(error.code, 'space')
    return true
  })
  // 盘上记的是事实分类
  assert.equal(core.parseStatusFile(committed.get(STATUS_NAME).toString('utf8')).last_error, 'space')

  const status = await api.getStatus()
  assert.equal(status.enoughForNext, false)
  assert.equal(status.lastError, 'space', '当前实际空间不够时，必须继续报 space')
})

test('[8b] 盘已腾出空间：过时的 `space` 结论不再播报，且不改写盘上事实', async () => {
  reset()
  await api.runBackup('manual')
  freeBytesValue = 0
  await assert.rejects(api.runBackup('manual'), (error) => {
    assert.equal(error.code, 'space')
    return true
  })

  // 用户清理了空间（设备实测里这一步之后状态行仍然显示「空间不足」）
  freeBytesValue = 1024 * 1024 * 1024
  const status = await api.getStatus()
  assert.equal(status.enoughForNext, true)
  assert.equal(status.lastError, null, '空间已经够用时，`space` 不是当前状态')

  // 诚实性：盘上的记录没被改写成「一切正常」
  assert.equal(
    core.parseStatusFile(committed.get(STATUS_NAME).toString('utf8')).last_error,
    'space',
    '盘上应保留那次失败的事实，归零只发生在播报层'
  )
})

test('[8c] `empty` 的过时判定不变：与当前空间无关，仍然不播报', async () => {
  reset()
  await api.runBackup('manual')
  globalThis.__nextSessions = 0
  await assert.rejects(api.runBackup('auto'), (error) => {
    assert.equal(error.code, 'empty')
    return true
  })
  assert.equal((await api.getStatus()).lastError, null)
  // 盘不够时也不该把 `empty` 退化成「一条当前状态」（不该和 space 绑在一起）
  freeBytesValue = 0
  const status = await api.getStatus()
  assert.equal(status.enoughForNext, false)
  assert.equal(status.lastError, null)
})
