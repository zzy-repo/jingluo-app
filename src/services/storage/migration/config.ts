/**
 * 迁移总开关与固定名字（#910）。
 *
 * `NATIVE_SQLITE_MIGRATION_ENABLED` 默认 `false`：合并不改变线上行为。何时开启是发布决策（计划 O1），由用户定。
 * 关闭时路由恒为 IndexedDB；**例外**：状态已是 `committed` 的用户仍走 SQLite（已迁用户不得被开关拉回旧库）。
 */
export const NATIVE_SQLITE_MIGRATION_ENABLED: boolean = false

/** 迁移引擎/库结构版本，写进状态与 SQLite `meta.engine_version`。 */
export const MIGRATION_ENGINE_VERSION = 1

export const STATE_DIR = 'storage-engine'
export const STATE_PATH = `${STATE_DIR}/state.json`
/**
 * SQLite 真源库名（由 `OpenSqlDatabase` 解析到应用私有目录）。
 * **不带 `.db`**：原生插件的库名白名单是 `[a-z0-9-]+`，后缀由插件补。
 */
export const MAIN_DB_NAME = 'deepseek-app'

/** 备份库文件名前缀：`storage-engine/backup-<ts>.db`。 */
export const BACKUP_PREFIX = 'backup-'
