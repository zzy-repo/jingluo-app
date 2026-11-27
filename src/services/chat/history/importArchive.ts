import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkImportSpace, insufficientSpaceParams } from './quotaPrecheck.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSessionResult, type ImportSkip } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readArchiveLayout,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/**
 * 取消后的清理：清空导入暂存（`sessionsStaging` + `filesStaging`）。
 *
 * 走的是**既有** `db.clearStaging()` —— 与 `store.importHistoryInto` 在失败分支上调的是同一个出口
 * （那里还会在下次导入前再清一次，两次都清是幂等的）。两件事刻意不做：
 * - 不动正式数据：正式库一个字节都没有被这次导入碰过，这正是「暂存 + 一次性提交」的意义；
 * - 不把清理失败变成导入失败：清不掉时调用方还会再清，用户的取消不应该变成一条「导入失败」。
 */
const clearStagingAfterCancel = async (): Promise<void> => {
  try {
    await db.clearStaging()
  } catch {
    // 见上：清理是尽力而为，取消本身必须照常结束。
  }
}

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 首个条目必须是 manifest：把「实际是什么 / 期望是什么」带进提示，不再只说「无法识别」（#40）。 */
const requireManifestFirst = (found: string): never =>
  fail('backupManifestNotFirst', { found, expected: MANIFEST_PATH })

/**
 * ZIP 层失败（ArchiveError）要带出真实原因（#40）：能定位到条目就给条目名与序号，
 * 连目录都读不到就说文件被截断/被重新打包，不再一律折叠成 backupIncomplete。
 * 同名条目（#153 缺口 2）按原因单列错误码，提示点名重复的那条路径。
 */
const archiveFailure = (index: number, path: string | undefined, error: ArchiveError): BackupError => {
  if (error.reason === 'duplicate') {
    return new BackupError('backupEntryDuplicated', { entry: error.target ?? path ?? '' })
  }
  return path === undefined
    ? new BackupError('backupArchiveUnreadable')
    : new BackupError('backupArchiveDamaged', { index, entry: path })
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  /** 已交给调用方的条目序号（1 起）与条目名，仅在报错时用于说明「哪一段校验失败」。 */
  let index = 0
  let path: string | undefined
  try {
    for await (const entry of readArchive(file)) {
      index += 1
      path = entry.path
      if (entry.path !== MANIFEST_PATH) {
        requireManifestFirst(entry.path)
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? archiveFailure(index, path, error) : error
  }
  fail('backupEmptyArchive')
}

/**
 * 导入阶段（本单 ②）：读取/预检 → 逐会话入库 → 收尾。
 *
 * 为什么「读取」与「解压」不各占一段：实现上是**同一遍**——`readArchive` 逐条目解压，
 * `importArchive` 拿到一条就立刻把会话写进暂存（单遍流式，见下面的函数头注释），
 * 中间没有「全读完再入库」的停顿。把它们拆成两段只能靠定时器编，那就是假进度。
 * 所以这里的 `reading` 指的是真独立的那一小段：读中央目录 + 剩余空间预检。
 */
export type ImportStage = 'reading' | 'importing' | 'finalizing'

/**
 * 导入进度：已处理会话数 / 会话总数（总数拿不到时不传，界面退化为只显示已处理数）。
 *
 * 两个数字都是**真实推进**，没有任何定时器：
 * - `sessions` 只在 `db.addStagingSession()` 真的返回之后 +1（被整会话跳过的也会推进 `entries`）；
 * - `entries / totalEntries` 是「已经消费完的中央目录条目数」，`percent` 直接由它换算。
 *   条目总数来自中央目录；读不到就**不给百分比**（`percent` 缺省），而不是猜一个。
 */
export type ImportArchiveProgress = {
  sessions: number
  totalSessions?: number
  images?: number
  stage: ImportStage
  /** 已消费的中央目录条目数（含 manifest / index / 图片 / 被跳过的条目） */
  entries?: number
  totalEntries?: number
  /** 0~100，由 `entries / totalEntries` 换算；拿不到条目总数时缺省 */
  percent?: number
}

/**
 * 导入可选项：signal 用于取消（条目边界中断，已写入的暂存由本函数清掉、正式数据一个字节不动），
 * onProgress 用于「阶段 + n/总数 + 百分比」进度。
 */
export type ImportArchiveOptions = {
  signal?: AbortSignal
  totalSessions?: number
  onProgress?: (progress: ImportArchiveProgress) => void
}

/**
 * 流式导入：manifest 首条，其余条目按物理顺序单遍处理（user 不导入，会话 JSON 立即暂存，
 * index 与图片顺序无关）。也支持会话与图片交错排列、index 位于末尾或位于会话之前的顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 *
 * 容错（#49）：单个会话里的坏消息截断跳过、坏到整个会话都构造不出来时跳过整个会话，
 * 都只记进返回的 `skipped`（界面据此列出「跳过了哪几条、为什么」），其余会话照常导入；
 * 只有「一条会话都没写成」才算整包失败。
 */
export const importArchive = async (
  file: File,
  options: ImportArchiveOptions = {}
): Promise<{ skipped: ImportSkip[] }> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  /** 会话文件读到了的会话（成功暂存或整会话跳过），它们的图片目录不算「无主条目」。 */
  const handled = new Set<string>()
  /** 本次导入被跳过的条目（损坏消息 / 损坏会话），调用方带进 state.importSkipped 给界面展示。 */
  const skipped: ImportSkip[] = []
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  /** 已交给调用方的条目序号（1 起）与条目名，仅在报错时用于说明「哪一段校验失败」。 */
  let entryIndex = 0
  let entryPath: string | undefined
  /** 当前阶段与「已消费的条目数 / 中央目录里的条目总数」——百分比只由这两个数换算（②）。 */
  let stage: ImportStage = 'reading'
  let processedEntries = 0
  let totalEntries: number | undefined

  /**
   * 进度上报：阶段 + 会话数 + 条目数 + 百分比。百分比只由**真实消费掉的条目数**换算，
   * 拿不到条目总数就整个缺省 —— 界面上宁可没有进度条，也不许用定时器把数字凑上去。
   */
  const emitProgress = (images?: number): void => {
    if (options.onProgress === undefined) {
      return
    }
    const percent =
      totalEntries !== undefined && totalEntries > 0
        ? Math.min(100, Math.round((processedEntries / totalEntries) * 100))
        : undefined
    options.onProgress({
      sessions: imported.size,
      totalSessions: options.totalSessions,
      ...(images === undefined ? {} : { images }),
      stage,
      entries: processedEntries,
      ...(totalEntries === undefined ? {} : { totalEntries }),
      ...(percent === undefined ? {} : { percent }),
    })
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
    emitProgress(stored.size)
  }

  try {
    // ① 读中央目录（不读条目数据）+ 剩余空间预检：**在写第一条会话之前**。
    // 解压后总量才是真正要落盘的量（归档字节数只是下载体积），见 quotaPrecheck.ts。
    const layout = await readArchiveLayout(file)
    totalEntries = layout.entries
    emitProgress()
    const space = await checkImportSpace(layout.inflatedBytes)
    if (!space.ok) {
      fail('historyImportInsufficientSpace', insufficientSpaceParams(space))
    }
    stage = 'importing'
    emitProgress()

    for await (const entry of readArchive(file)) {
      // 上一条条目已经处理完（解压 + 暂存都落地了）才推进进度：这就是「真实推进」的来源。
      if (processedEntries > 0) {
        emitProgress()
      }
      processedEntries += 1
      // 取消只在条目边界生效：已写入暂存的条目会被本函数的 catch 清掉，正式数据一个字节都不动。
      if (options.signal?.aborted) {
        fail('historyImportCancelled')
      }
      const { path } = entry
      entryIndex += 1
      entryPath = path
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          requireManifestFirst(path)
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null) {
        // #153 缺口 1：会话文件与 index 的先后不是导出格式的一部分，index 先到也要照常导入；
        // 目录里多出来的 / 缺掉的会话由末尾的完整性校验负责。
        // #49：坏会话不再让整包失败。整会话都构造不出来时只跳过它，跳过的条目逐条带进 skipped。
        const result = toLocalSessionResult(readSessionFile(await readJson(entry)))
        if (imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        handled.add(sessionId)
        currentSessionId = sessionId
        skipped.push(...result.skipped)
        if (!result.ok) {
          emitProgress()
          continue
        }
        const local = result.session
        if (local.session.id !== sessionId) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        await db.addStagingSession(local.session)
        emitProgress()
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? handled.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else if (index) {
        // 索引已读到：条目既不是会话文件，也不在任何已导入会话的图片目录下（#32）。
        fail('backupEntryUnreferenced', { index: entryIndex, entry: path })
      } else {
        // 索引还没读到，条目又不属于刚读到的那个会话的图片目录（#32：图片排在会话之前时走到这里）。
        fail('backupEntryOutOfOrder', {
          index: entryIndex,
          entry: path,
          session: currentSessionId ?? '',
        })
      }
    }
  } catch (error) {
    const failure = error instanceof ArchiveError ? archiveFailure(entryIndex, entryPath, error) : error
    // ② 取消收尾：**用户主动取消**时把已写入的暂存清掉，不留半截数据。
    // 走的是既有 `db.clearStaging()`（与 store 的失败清理同一个出口，也就是 staging/孤儿清理那条路径）。
    // 只在取消时做：部分成功（带 skipped 的错误）由调用方按「能导入的先导入」提交，这里不许抢着清。
    if (failure instanceof BackupError && failure.key === 'historyImportCancelled') {
      await clearStagingAfterCancel()
    }
    throw failure
  }
  // 结尾再查一次取消：最后一条条目处理完之后、提交之前点取消，同样一个字节都不许提交。
  if (options.signal?.aborted) {
    await clearStagingAfterCancel()
    fail('historyImportCancelled')
  }
  // 收尾阶段：条目已经全部消费完（percent 因此自然到 100，不靠补齐数字），
  // 剩下的真实工作是回填图片 MIME 与完整性校验。
  stage = 'finalizing'
  emitProgress()
  if (!manifest) {
    fail('backupEmptyArchive')
  }
  // index 列出包里全部会话：暂存成功的、被整会话跳过的（#49）都算「读到了」；
  // 索引里有却没读到会话文件、或暂存了却不在索引里，才是文件真的缺内容。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    [...listed].some((id) => !imported.has(id) && !handled.has(id)) ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
  return { skipped }
}
