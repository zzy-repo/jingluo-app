/**
 * 由已注册的 `StorageRuntime` 构造路由 / 编排器的依赖（#910）。
 * 平台判断只经 `getFs().supported` 与 `runtime.isSqliteAvailable()`，这里不碰平台。
 */
import { getFs } from '../../fs/index.js'
import { sha256Hex } from '../../attachments/sha256.js'
import type { RouterDeps } from '../router.js'
import type { MigrationDeps, Sha256Text } from './ports.js'
import { isMigrationRunning, type StorageRuntime } from './runtime.js'

const encoder = new TextEncoder()

export const sha256Text: Sha256Text = async (text) => {
  const bytes = encoder.encode(text)
  return sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

const systemClock = { now: () => Date.now() }

export const buildRouterDeps = (runtime: StorageRuntime): RouterDeps => ({
  fs: getFs(),
  isSqliteAvailable: () => runtime.isSqliteAvailable(),
  openSqlite: runtime.openSqlite,
  sqliteFileExists: () => runtime.sqliteFileExists(),
  sha256: sha256Text,
  clock: systemClock,
  migrationRunning: isMigrationRunning,
})

export const buildMigrationDeps = (
  runtime: StorageRuntime,
  extra: Pick<MigrationDeps, 'signal' | 'onProgress'> = {},
): MigrationDeps => ({
  fs: getFs(),
  openSqlite: runtime.openSqlite,
  createTarget: (db) => runtime.createTarget(db),
  source: runtime.openIdbSource(),
  engine: runtime.engine,
  clock: systemClock,
  sha256: sha256Text,
  sqliteFileExists: () => runtime.sqliteFileExists(),
  ...(runtime.bumpLegacyIdbVersion ? { bumpLegacyIdbVersion: runtime.bumpLegacyIdbVersion } : {}),
  ...extra,
})
