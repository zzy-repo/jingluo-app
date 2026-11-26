/**
 * Storage Protection（#909）的全部阈值与路径集中在这里：改数字只改这一处。
 */

/** 高水位标记：原生端写应用私有目录，Web 端写 localStorage（见 highwater.ts）。 */
export const HIGHWATER_PATH = 'protection/highwater.json'
export const HIGHWATER_LOCAL_KEY = 'chat-demo:protection:highwater'
export const HIGHWATER_FORMAT_VERSION = 1

/** 快照：应用私有目录下的目录、保留份数、自动快照最短间隔、文件格式版本。 */
export const SNAPSHOT_DIR = 'snapshots'
export const SNAPSHOT_KEEP = 5
export const SNAPSHOT_MIN_INTERVAL_MS = 15_000
export const SNAPSHOT_FORMAT_VERSION = 1
