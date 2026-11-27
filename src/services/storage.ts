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
 * 把宿主给的原始数字收口成「可信测量」或「未知」。
 *
 * ## 2026-11-27 追加：`estimate()` 的 quota **不等于**磁盘余量
 *
 * 后来在设备上又抓到一次更基本的问题：`estimate()` 报的是**正常值**（quota 3.7GB / usage 45.6MB），
 * 真实剩余只有 6MB；导入 20MB 包把盘写到底 → LevelDB 写出半条记录
 * （`leveldb_factory.cc: Failed to open LevelDB … Corruption: partial record`）→ Chromium 判定库损坏
 * 并重建，43MB 附件与 48 个会话全丢。所以「`estimate()` 通过」不能证明写盘安全：
 *
 * - **可信来源只有一个**：原生 `freeBytes`（`backup/nativeBackupFs.ts` 的 `availableBytes()`）；
 * - `estimate()` 的读数只做**辅助否决**（说「不够」可信，说「够」不作数），见 `judgeWriteSpace`；
 * - 空间未知时**按负载分级**：小负载（≤ `SMALL_WRITE_BYTES`）允许尝试，大负载拒绝，
 *   且文案必须是「暂时无法确认剩余空间」而**不是**「空间不足」。
 *
 * | 输入 | 判定 |
 * | --- | --- |
 * | `quota` 与 `usage` 都有限、非负、≤ 2^53-1，且 `quota > 0`、`usage ≤ quota` | **可信测量** |
 * | 其它一切（NaN / Infinity / 负数 / UINT64_MAX / `usage > quota` / `quota ≤ 0` / 字段缺失） | **未知** |
 *
 * 「未知」不是「0 字节可用」，也不是「quota 那么多可用」——两个方向都在撒谎：
 * 折成 0 就是本单的 bug（一次脏读变成「拒绝一切导入」），折成 quota 会让人在真的满盘时白等十几分钟。
 * 正确的做法是**分级**：小负载允许尝试、大负载拒绝并说清「读不到空间」，失败时按真实原因报
 * （原生 `NO_SPACE` / 写入异常 / 可信来源给出的真数字）。
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
 * 这条路径上的「未知」表现为 `null`，上层（`hasRoomForNext` → `judgeWriteSpace`）据此**分级**：
 * 小负载允许尝试，大负载拒绝（并说「读不到空间」，不说「空间不足」）。
 */
export const normalizeFreeBytes = (raw: unknown): number | null =>
  isTrustworthyBytes(raw, 0) ? raw : null

/**
 * 「小负载」的界线：**≤ 这个量才允许在空间未知时拿试错换机会**。
 *
 * 取值不是新造的：它原本叫 `MIN_ESTIMATE_BYTES`（`backup/backupCore.ts` 的「一份备份的预估下限，
 * 没有历史时按 8MB 算」），现在把数放这里当**唯一来源**，那一处改为引用本常量。
 * 依据是同一个量级判断 —— **8MiB 的写入失败代价可控**（一条会话 / 一次不完整暂存，清得掉、
 * 重试一次就好），而 43MB 附件的失败现场是 LevelDB 半条记录 + 整库重建（见文件头的 #1002 事故）。
 */
export const SMALL_WRITE_BYTES = 8 * 1024 * 1024

/**
 * 写放大：判断「够不够」时**不能只按负载大小算**。
 *
 * 同一份字节在一次导入 / 恢复里至少落两处：暂存（staging）+ 提交后的正式库；恢复还要把
 * 归档解到内存再写附件。所以需要的空间 = 负载 × 2（#1002 的事故里，20MB 包 + 43MB 解压量
 * 把 6MB 余量的盘写到底，正是只按单份体积估的结果）。
 */
export const WRITE_AMPLIFICATION_FACTOR = 2

/**
 * 一次「写盘够不够」判定的输入。**可信来源只有一个：原生 `freeBytes`**（`nativeFree`）。
 *
 * `estimateFree` 只是**辅助信号**，而且只能往「否决」方向用：设备实测（#1002）里
 * `estimate()` 报的是漂亮数字（quota 3.7GB / usage 45.6MB），真实剩余却只有 6MB ——
 * 它「看起来够」什么也证明不了。所以：
 *
 * - 原生 `freeBytes` 可信 → 由它定生死；
 * - 原生读不到（`null`/`undefined`/脏值）→ 看 `estimateFree` 是否**明确不够**（够不够都不作数，
 *   只有「不够」算证据），再按负载大小分级。
 */
export type WriteSpaceProbe = {
  /** 原生 `freeBytes()` 的读数（脏值 / 读不到一律 `null`）。**唯一可信来源。** */
  nativeFree?: number | null
  /** `estimate()` 的 `quota - usage`（`normalizeStorageEstimate` 判可信后才填）。只用于否决。 */
  estimateFree?: number | null
}

/**
 * 一次判定的结论。四个分支互不替代，`need` 已含写放大余量：
 *
 * | reason | ok | 含义 | 上层该做什么 |
 * | --- | --- | --- | --- |
 * | `sufficient` | true | 可信来源说够了 | 照常写 |
 * | `unmeasurable-small` | true | 读不到空间，但负载小到试错代价可控 | 照常写，留痕 |
 * | `insufficient` | false | **可信**来源说不够（`source` 指出是谁说的） | 拒绝，文案要说「空间不足」+ 三个真数字 |
 * | `unverifiable` | false | 读不到空间、负载又大 | 拒绝，但文案**不许**说「空间不足」（那是另一回事） |
 */
export type WriteSpaceVerdict =
  | { ok: true; reason: 'sufficient'; need: number; free: number }
  | { ok: true; reason: 'unmeasurable-small'; need: number }
  | { ok: false; reason: 'insufficient'; need: number; free: number; short: number; source: 'native' | 'estimate' }
  | { ok: false; reason: 'unverifiable'; need: number }

/**
 * 纯函数（L0 可单测）：这次写入要多少 + 现在知道多少 → 放行 / 拒绝，以及**为什么**。
 *
 * 顺序刻意如此：
 *  1. 原生 `freeBytes` 可信 → 只看它（`estimate()` 说什么都不影响）；
 *  2. 原生读不到，但 `estimate()` **明确不够** → 也拒绝：那个上限本身也是硬顶，
 *     即便磁盘还有空，越过去照样写不进去（这一档是保守方向，不会把人误拦住）；
 *  3. 都读不到（或 `estimate()` 说够，但它证明了不什么）→ 按负载分级：小的放行，大的拒绝。
 *
 * 第 3 条里「`estimate()` 说够」不算证据，正是 #1002 设备现场的直接结论。
 */
export const judgeWriteSpace = (
  needBytes: number,
  probe: WriteSpaceProbe,
  smallCapBytes: number = SMALL_WRITE_BYTES
): WriteSpaceVerdict => {
  const need = Number.isFinite(needBytes) && needBytes > 0 ? Math.ceil(needBytes) : 0
  const cap = Number.isFinite(smallCapBytes) && smallCapBytes >= 0 ? smallCapBytes : SMALL_WRITE_BYTES
  const nativeFree = normalizeFreeBytes(probe?.nativeFree)
  if (nativeFree !== null) {
    return nativeFree >= need
      ? { ok: true, reason: 'sufficient', need, free: nativeFree }
      : { ok: false, reason: 'insufficient', need, free: nativeFree, short: need - nativeFree, source: 'native' }
  }
  const estimateFree = normalizeFreeBytes(probe?.estimateFree)
  if (estimateFree !== null && estimateFree < need) {
    return {
      ok: false,
      reason: 'insufficient',
      need,
      free: estimateFree,
      short: need - estimateFree,
      source: 'estimate',
    }
  }
  if (need <= cap) {
    return { ok: true, reason: 'unmeasurable-small', need }
  }
  return { ok: false, reason: 'unverifiable', need }
}
