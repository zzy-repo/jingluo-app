import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSessionResult, type ImportSkip } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

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
 */
const archiveFailure = (index: number, path: string | undefined): BackupError =>
  path === undefined
    ? new BackupError('backupArchiveUnreadable')
    : new BackupError('backupArchiveDamaged', { index, entry: path })

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
    throw error instanceof ArchiveError ? archiveFailure(index, path) : error
  }
  fail('backupEmptyArchive')
}

/** 导入进度：已处理会话数 / 会话总数（总数拿不到时不传，界面退化为只显示已处理数）。 */
export type ImportArchiveProgress = { sessions: number; totalSessions?: number; images?: number }

/** 导入可选项：signal 用于取消（条目边界中断，暂存由调用方清理），onProgress 用于 n/总数 进度。 */
export type ImportArchiveOptions = {
  signal?: AbortSignal
  totalSessions?: number
  onProgress?: (progress: ImportArchiveProgress) => void
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
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

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
    options.onProgress?.({ sessions: imported.size, totalSessions: options.totalSessions, images: stored.size })
  }

  try {
    for await (const entry of readArchive(file)) {
      // 取消只在条目边界生效：已写入暂存的条目会被调用方清空，正式数据一个字节都不动。
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
      } else if (sessionId !== null && !index) {
        // #49：坏会话不再让整包失败。整会话都构造不出来时只跳过它，跳过的条目逐条带进 skipped。
        const result = toLocalSessionResult(readSessionFile(await readJson(entry)))
        if (imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        handled.add(sessionId)
        currentSessionId = sessionId
        skipped.push(...result.skipped)
        if (!result.ok) {
          options.onProgress?.({ sessions: imported.size, totalSessions: options.totalSessions })
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
        options.onProgress?.({ sessions: imported.size, totalSessions: options.totalSessions })
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
    throw error instanceof ArchiveError ? archiveFailure(entryIndex, entryPath) : error
  }
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
