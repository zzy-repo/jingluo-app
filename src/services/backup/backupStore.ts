import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * 备份记录的**本机存放处**（#993 任务 3）。
 *
 * 与 chat 主库分开一个库：备份是「整包快照」，体积与主库同量级，混进主库会让主库的
 * 读写事务、清理路径、体积统计全部跟着变重；而备份自己的增删完全独立，失败也不该影响
 * 主库的一致性。库名与主库共用 `chat-demo` 前缀，方便用户与诊断日志一眼归位。
 *
 * 三个表（**只加表才升版本**，与 chat 主库的 `DB_VERSION` 毫无关系）：
 *   meta  —— 一份备份的元数据（时间 / 体积 / 会话数 / 摘要），列表页只读它，不碰大块字节；
 *   blobs —— 备份字节本体，按 id 单独取（列表页读它会把几百 MB 一起搬进内存）；
 *   kv     —— 两格状态：最近一次成功的时刻、上一次失败的原因分类。
 *
 * 为什么拆 meta / blobs：`getAll()` 在 IndexedDB 里是**整条记录**读出来的。合并成一张表时，
 * 「打开备份页」这一下会把所有备份的体积（累计可能几百 MB）都读进内存，手机上直接卡死。
 */

const BACKUP_DB_NAME = 'chat-demo-backup'
/** 备份库结构版本：本库自己的，只在给**备份库**加表 / 加索引时 +1 */
const BACKUP_DB_VERSION = 1
const STORE_META = 'meta'
const STORE_BLOBS = 'blobs'
const STORE_KV = 'kv'

/** 一份备份的元数据。`digest` 是写入时算的摘要，只在恢复前自检时用，**不进界面**。 */
export type BackupMeta = {
  id: string
  createdAtUtc: string
  sizeBytes: number
  /** 这份备份里有几个会话；核心侧拿不到时可以给 null（界面就不显示条数） */
  sessionCount: number | null
  trigger: 'auto' | 'manual' | 'safety'
  digest: string | null
  /** 现在还能不能用于恢复（摘要对不上时会被改成 false） */
  checksumOk: boolean
}

/** 状态格里两个键：只存字符串，语义由 `backupApi.ts` 解释 */
export type BackupKvKey = 'lastSuccess' | 'lastError'

interface BackupDB extends DBSchema {
  meta: { key: string; value: BackupMeta }
  blobs: { key: string; value: ArrayBuffer }
  kv: { key: string; value: { key: string; value: string } }
}

let opening: Promise<IDBPDatabase<BackupDB>> | null = null

const getDb = (): Promise<IDBPDatabase<BackupDB>> => {
  opening ??= openDB<BackupDB>(BACKUP_DB_NAME, BACKUP_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS)
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' })
      }
    },
  })
  return opening
}

/** 测试收尾用：关掉连接并清掉缓存，下次调用会重新打开 */
export const closeBackupDb = async (): Promise<void> => {
  const pending = opening
  opening = null
  if (pending) {
    try {
      ;(await pending).close()
    } catch {
      // 关不掉就交给下一次 openDB，不抛
    }
  }
}

/** 存一份备份（元数据 + 字节）。同一 id 重复写等于覆盖。 */
export const saveBackup = async (meta: BackupMeta, bytes: ArrayBuffer): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction([STORE_META, STORE_BLOBS], 'readwrite')
  await Promise.all([
    tx.objectStore(STORE_META).put(meta),
    tx.objectStore(STORE_BLOBS).put(bytes, meta.id),
  ])
  await tx.done
}

/** 全部备份的元数据，**按时间倒序**（最新的在前）。列表页与状态统计都只看这个。 */
export const listBackupMeta = async (): Promise<BackupMeta[]> => {
  const db = await getDb()
  const all = await db.getAll(STORE_META)
  return all.sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))
}

/** 取一份备份的字节本体；没有就 null。 */
export const readBackupBytes = async (id: string): Promise<ArrayBuffer | null> => {
  const db = await getDb()
  const bytes = await db.get(STORE_BLOBS, id)
  return bytes ?? null
}

/** 把某份备份标成「不能用于恢复」（摘要对不上时用） */
export const markBackupUnusable = async (meta: BackupMeta): Promise<void> => {
  const db = await getDb()
  await db.put(STORE_META, { ...meta, checksumOk: false })
}

export const readBackupKv = async (key: BackupKvKey): Promise<string | null> => {
  const db = await getDb()
  const row = await db.get(STORE_KV, key)
  return row?.value ?? null
}

export const writeBackupKv = async (key: BackupKvKey, value: string | null): Promise<void> => {
  const db = await getDb()
  if (value === null) {
    await db.delete(STORE_KV, key)
    return
  }
  await db.put(STORE_KV, { key, value })
}

/**
 * 字节摘要（恢复前自检「这份包还是不是当初那一份」）。
 *
 * 只用 WebCrypto：拿不到就返回 null —— 那时备份照常存、照常列，只是不做摘要自检。
 * 摘要**永远不进界面**（用户看到的是「完整性检查：通过 / 未通过」）。
 */
export const sha256Hex = async (bytes: ArrayBuffer): Promise<string | null> => {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) {
      return null
    }
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}
