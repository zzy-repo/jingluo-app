/**
 * 「宿主报了多少空间」的**唯一收口**（#1002）。
 *
 * ## 为什么要有一处收口
 *
 * 设备实测（Android 虚拟设备）：把盘写满 → 清空填充文件 → **不重启 App**，WebView 的
 * `estimate()` 会返回 `usage = 18446744073709552000`（接近无符号 64 位最大值，明显是脏值）。
 * 导入预检按 `quota - usage` 一减，得到「当前可用 0 字节」，于是**拒绝一切导入**，
 * 报「当前可用 0B，还差 23.9MB」；同一时刻 `stat -f` 实测可用 4.8GB，
 * 重启 App 后 `usage` 立刻恢复成 161084 —— 脏值只活在当前 WebView 进程里。
 *
 * 这个缺陷的本质不是「减法算错」，而是**把「读不到」当成了「没空间」**。所以这里只做一件事：
 * 把宿主给的原始数字收口成「可信测量」或「未知」，并让每一条调用链在「未知」时都**不阻断用户**。
 *
 * | 输入 | 判定 |
 * | --- | --- |
 * | `quota` 与 `usage` 都有限、非负、≤ 2^53-1，且 `quota > 0`、`usage ≤ quota` | **可信测量** |
 * | 其它一切（NaN / Infinity / 负数 / UINT64_MAX / `usage > quota` / `quota ≤ 0` / 字段缺失） | **未知** |
 *
 * 「未知」不是「0 字节可用」，也不是「quota 那么多可用」——两个方向都在撒谎：
 * 折成 0 就是本单的 bug（一次脏读变成「拒绝一切导入」），折成 quota 会让人在真的满盘时白等十几分钟。
 * 正确的做法是**允许尝试**，失败时按真实原因报（原生 `NO_SPACE` / 写入异常 / 预检里另有的可信来源）。
 *
 * 为什么上界是 2^53-1：JS 的 `number` 无法精确表示更大的整数，超过它的一律是**编码错误**
 * （UINT64_MAX、把无符号数按有符号解释、单位换算溢出），而不是「真的有这么多字节」——
 * 2^53-1 字节 ≈ 8PB，比任何一台设备的磁盘大一个数量级以上。
 *
 * 调用方：导入预检（`chat/history/quotaPrecheck.ts`）、原生备份目录的可用字节
 * （`backup/nativeBackupFs.ts` → `backup/backupCore.ts`）、诊断快照（`diagnostics/collector.ts`）、
 * 配额兜底留痕（`chat/db.ts`）。
 */

/** 可信字节数的上界：`Number.MAX_SAFE_INTEGER`（≈8PB，比任何真实设备大一个数量级以上）。 */
export const MAX_TRUSTWORTHY_BYTES = Number.MAX_SAFE_INTEGER

/** 一次**可信**的空间测量：三个数都算好了，可以直接进判定与文案。 */
export type StorageSpace = { quota: number; usage: number; free: number }

/** 单个字节数是否可信：`floor ≤ value ≤ 2^53-1` 的有限数。`floor` 用来区分「可以是 0」与「必须 > 0」。 */
const isTrustworthyBytes = (value: unknown, floor: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= floor &&
  value <= MAX_TRUSTWORTHY_BYTES

/**
 * 把 `estimate()` 的原始返回收口成**可信测量**或 `undefined`（= 未知）。
 *
 * 任何一条不满足都返回 `undefined`，**绝不**用 0 或 `quota` 去补：「读不到」与「没空间」是两件事。
 */
export const normalizeStorageEstimate = (raw: unknown): StorageSpace | undefined => {
  const source = (raw ?? undefined) as { quota?: unknown; usage?: unknown } | undefined
  const { quota, usage } = source ?? {}
  // quota 必须是正数：0 / 负数 / 缺失都说明这次读到的不是可用额度（老宿主、隐私模式、脏值）。
  if (!isTrustworthyBytes(quota, 1)) {
    return undefined
  }
  // usage 可以是 0（空库），但 NaN / Infinity / 负数 / 超过 2^53-1 都是错误编码。
  if (!isTrustworthyBytes(usage, 0)) {
    return undefined
  }
  // 用了的比总量还多：设备实测就是这一档（脏值）。按未知处理，不按「0 可用」处理。
  if (usage > quota) {
    return undefined
  }
  return { quota, usage, free: quota - usage }
}

/**
 * 已经算好的测量是否可信（调用方自己拼的对象也要过同一把尺子）。
 *
 * `free` 必须自洽（`free === quota - usage`）：一份自己都对不上的测量，比没有测量更危险。
 */
export const isTrustworthySpace = (space: unknown): space is StorageSpace => {
  const candidate = (space ?? undefined) as Partial<StorageSpace> | undefined
  if (candidate === undefined) {
    return false
  }
  const { quota, usage, free } = candidate
  return (
    isTrustworthyBytes(quota, 1) &&
    isTrustworthyBytes(usage, 0) &&
    isTrustworthyBytes(free, 0) &&
    usage <= quota &&
    free === quota - usage
  )
}

/**
 * 原生 `freeBytes()` 的收口：只信有限、非负、≤ 2^53-1 的数，其余一律 `null`（= 未知）。
 *
 * 备份侧读的是**原生目录的可用字节**（`BackupFilePlugin.freeBytes`），不是 `estimate()` ——
 * 这条路径上的「未知」表现为 `null`，上层（`hasRoomForNext`）必须按「允许尝试」处理。
 */
export const normalizeFreeBytes = (raw: unknown): number | null =>
  isTrustworthyBytes(raw, 0) ? raw : null
