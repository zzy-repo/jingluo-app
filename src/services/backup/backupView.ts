import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { LIMITS } from '../limits.js'
import type { BackupItem, BackupStatus } from './backupApi.js'

/**
 * 「数据备份与恢复」的**纯视图层**（#993 任务 3）。
 *
 * 为什么单独一层：界面里**禁止出现技术词**（存储实现名 / 表结构与版本 / 文件路径 /
 * 完整性校验的算法名 / 原始英文报错），而「一个状态该说哪句话」「一个错误该分到哪一档」是
 * 最容易散进 JSX 里各写一份的东西。全部收在这里之后：
 *   · 文案映射能被行为级单测直接钉住（`tests/unit/backup-ui-993.test.mjs`）；
 *   · 想加一句新文案只有一处入口，不会漏掉某个分支。
 *
 * 这一层不碰 React、不碰存储、不发请求 —— 入参是数据，出参是「说什么 / 能不能点」。
 */

/** 备份占用到这个量就主动提醒（阈值的唯一来源是 `LIMITS.backup.spaceWarnBytes`） */
export const SPACE_WARN_BYTES = LIMITS.backup.spaceWarnBytes

/** 界面上的三段：空转 / 正在备份 / 正在恢复 */
export type BackupPhase = 'idle' | 'backup' | 'restore'

/** 失败分类：与 `BackupError.code` 同一套取值，另加本层兜底的 `unknown` */
export type BackupFailureKind =
  | 'safety-backup-failed'
  | 'corrupt'
  | 'space'
  /** 读不到剩余空间、负载又大：**不是**「空间不足」，文案必须分开（#1002 第二轮） */
  | 'space-unverifiable'
  | 'interrupted'
  /** 没有可备份的记录：**正常状态**，不是失败，别标红 */
  | 'empty'
  /** 当前环境不支持备份：不是失败，是把「立即备份」置灰的理由 */
  | 'unsupported'
  | 'unknown'

export type BackupFailure = {
  kind: BackupFailureKind
  /** 能不能说「原有数据仍然保存在设备上」—— 只有明确 true 时才允许说 */
  currentDataIntact: boolean
}

/**
 * 一次交互留下的失败：除了分类，还记着它发生在哪一段（备份 / 恢复的文案完全不同），
 * 以及**它发生在什么时候** —— 后来成功过就说明这句话成了旧话（见 `failureIsStale`，#1007）。
 */
export type FailureRecord = BackupFailure & {
  action: Exclude<BackupPhase, 'idle'>
  /** 这次失败发生在什么时候（UTC ISO）。解析不出来按「还没被成功覆盖」处理 */
  atUtc: string
}

export type ActionText = { key: TranslationKey; params?: TranslationParams; error?: boolean }

export type StatusView = ActionText & {
  /** 有进度条时给 0–100，没有就 null */
  percent: number | null
}

const KNOWN: readonly BackupFailureKind[] = [
  'safety-backup-failed',
  'corrupt',
  'space',
  'space-unverifiable',
  'interrupted',
  'empty',
  'unsupported',
  'unknown',
]

/**
 * 把任意异常收敛成「分类 + 当前数据是否完好」。
 *
 * `currentDataIntact` **只在明确 `true` 时才算数**：认错方向会说出「数据还在」这种
 * 用户会当真的承诺，所以拿不准一律按 false（界面改成「请检查当前数据」）。
 */
export const failureOf = (error: unknown): BackupFailure => {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    const intact = (error as { currentDataIntact?: unknown }).currentDataIntact
    if (typeof code === 'string' && KNOWN.includes(code as BackupFailureKind)) {
      return { kind: code as BackupFailureKind, currentDataIntact: intact === true }
    }
  }
  return { kind: 'unknown', currentDataIntact: false }
}

/**
 * 失败要说哪句话。分档依据只有两条：**在哪一段失败的**（备份 / 恢复），以及
 * **当前数据有没有被动过**（`currentDataIntact`）。三档文案互不替代：
 *
 *  · `safety-backup-failed` → 中止，不是失败（数据一个字节都没动）；
 *  · `currentDataIntact`   → 才可以说「原有数据仍然保存在设备上」；
 *  · 其余                 → 不承诺安全，引导用户去页面里自查。
 */
export const failureText = (failure: BackupFailure, phase: Exclude<BackupPhase, 'idle'>): StatusView => {
  if (phase === 'backup') {
    // `empty` / `unsupported` 不是失败：一个是没有记录可备，一个是这台环境备不了，
    // 都不标红（标红等于告诉用户「出错了」，而那两件事用户无能为力、也不代表数据有问题）
    if (failure.kind === 'empty') {
      return { key: 'backupStatusEmpty', percent: null }
    }
    if (failure.kind === 'unsupported') {
      return { key: 'backupStatusUnsupported', percent: null }
    }
    const key: TranslationKey =
      failure.kind === 'space'
        ? 'backupStatusSpace'
        : failure.kind === 'space-unverifiable'
          ? 'backupStatusSpaceUnverifiable'
          : failure.kind === 'interrupted'
            ? 'backupStatusInterrupted'
            : 'backupStatusUnavailable'
    return { key, error: true, percent: null }
  }
  if (failure.kind === 'unsupported') {
    return { key: 'backupStatusUnsupported', percent: null }
  }
  if (failure.kind === 'safety-backup-failed') {
    return { key: 'backupStatusAborted', error: true, percent: null }
  }
  // 备份包本身坏了要说「这份备份用不了」，这是**动作层面的结论**，优先于「当前数据还在不在」
  if (failure.kind === 'corrupt') {
    return { key: 'backupStatusCorrupt', error: true, percent: null }
  }
  // 读不到空间 ≠ 空间不足：这一档要告诉用户「没法确认」，并说清**这次什么都没动**
  if (failure.kind === 'space-unverifiable') {
    return { key: 'backupStatusRestoreSpaceUnverifiable', error: true, percent: null }
  }
  if (failure.currentDataIntact) {
    return { key: 'backupStatusRestoreFailedIntact', error: true, percent: null }
  }
  return { key: 'backupStatusRestoreFailedUnknown', error: true, percent: null }
}

/** 进度条百分比：`total` 还没定下来时返回 null（不画一条假的 0%） */
export const progressPercent = (done: number, total: number): number | null => {
  if (!Number.isFinite(total) || total <= 0) {
    return null
  }
  const ratio = Math.min(Math.max(done, 0) / total, 1)
  return Math.round(ratio * 100)
}

/**
 * 那次交互失败**还算不算当前状态**（#1007 缺陷 2）。
 *
 * 判据只有一条：**失败之后有没有一次成功的操作**。有 → 盘上事实已经好了，那句话是旧话；
 * 没有 → 一个字节都不许少说（「存储空间不足」这类真话必须继续报）。
 *
 * 为什么"成功过"就算数，而不看 `status.json`：恢复成功**不改写** `status.json` 的
 * `last_error`（`backupApi.ts` 恢复分支只推进 `last_restore_at_utc`），所以盘上会长期留着
 * 一条早已不成立的失败分类；设备现场就是「盘上事实是好的，UI 在说旧话」。**盘上一个字节都
 * 不改**：那次失败确实发生过，归零只发生在播报层。
 *
 * 与 `backupApi.getStatus` 里 `isStaleErrorCode` 是**同一条口径的两半**，别混用、别互相替代：
 *   · `isStaleErrorCode` 拿**当前实际空间**复核盘上 `last_error` 里的 `space`（盘真的够用了 → 不播报）；
 *   · 这里拿**之后真的成功过**复核界面记着的那次失败（操作真的成了 → 不播报）。
 * 本条只在「盘上事实好转之后」收声：成功时间必须**不早于**失败时间；时间戳读不出来一律
 * 按「还该报」处理 —— 宁可多说一句，也不静默吞掉一条真失败。
 */
export const failureIsStale = (
  failure: FailureRecord | null,
  succeededAtUtc: string | null
): boolean => {
  if (failure === null || succeededAtUtc === null) {
    return false
  }
  const succeededAt = Date.parse(succeededAtUtc)
  const failedAt = Date.parse(failure.atUtc)
  if (!Number.isFinite(succeededAt) || !Number.isFinite(failedAt)) {
    return false
  }
  return succeededAt >= failedAt
}

/**
 * 恢复列表「露几条 / 还有几条」（#1007 缺陷 1）。
 *
 * 为什么不是直接 `slice(0, 5)`：设置页「备份占用空间」一格显示的是**盘上真实份数**
 * （`spaceValue` 的 `count`，来自核心侧扫描），列表被静默截断之后，多出来的那几份在界面上
 * **看起来消失了** —— 设备实测：盘上 7 份、恢复列表 5 条，用户以为丢了两份。对备份功能来说，
 * "看起来丢了"比"多显示一行"糟得多。
 *
 * 所以截断只能发生在「露几条」上，**不能发生在「有没有」上**：`hiddenCount > 0` 时界面必须
 * 给一个能点开的入口，且 `shown + hiddenCount === 盘上份数` 是这条不变量。
 * 「共 N 份」那个真实数字**一个字节都不改** —— 迁就列表去改它，等于承认列表才是权威。
 */
export const BACKUP_LIST_PREVIEW = 5

export type RestoreListWindow = {
  /** 当前状态下露出来的那几条（默认前 `BACKUP_LIST_PREVIEW` 条，展开后是全部） */
  shown: readonly BackupItem[]
  /** 还没露出来、必须靠入口说出来的份数 */
  hiddenCount: number
}

export const restoreListWindow = (
  items: readonly BackupItem[],
  expanded: boolean
): RestoreListWindow =>
  expanded || items.length <= BACKUP_LIST_PREVIEW
    ? { shown: items, hiddenCount: 0 }
    : { shown: items.slice(0, BACKUP_LIST_PREVIEW), hiddenCount: items.length - BACKUP_LIST_PREVIEW }

/**
 * 「当前状态」那一行说什么。
 *
 * 优先级：正在跑（带进度）> 这次交互的失败 > 上次失败（来自 `lastError`）> 从没备份过 > 一切正常。
 * 上次失败要看得出分类（空间不足 / 没做完 / 读取不到），**不能只写「失败」**。
 *
 * `succeededAtUtc` = 本会话里**最近一次成功操作**的时间（备份成功 / 恢复成功都算）。它只做一件事：
 * 把早于它的那次交互失败判成旧话（见 `failureIsStale`），免得「存储空间不足」和「已恢复完成」
 * 在同一行里并存。**它不影响盘上 `lastError` 的播报** —— 那条归 `getStatus` 的 `isStaleErrorCode`。
 */
export const statusView = ({
  status,
  phase,
  done,
  total,
  failure,
  succeededAtUtc = null,
}: {
  status: BackupStatus | null
  phase: BackupPhase
  done: number
  total: number
  failure: FailureRecord | null
  succeededAtUtc?: string | null
}): StatusView => {
  if (phase !== 'idle') {
    const percent = progressPercent(done, total)
    const key: TranslationKey =
      phase === 'backup'
        ? percent === null
          ? 'backupStatusRunningNoPercent'
          : 'backupStatusRunning'
        : percent === null
          ? 'backupStatusRestoringNoPercent'
          : 'backupStatusRestoring'
    return { key, params: percent === null ? undefined : { percent }, percent }
  }
  if (failure !== null && !failureIsStale(failure, succeededAtUtc)) {
    return failureText(failure, failure.action)
  }
  if (status === null) {
    // 「读不到状态」与「上次备份没成功」是两件事，混用一句话会让用户以为状态坏了
    return { key: 'backupStatusReadFailed', error: true, percent: null }
  }
  if (status.lastError !== null) {
    return failureText({ kind: lastErrorKind(status.lastError), currentDataIntact: false }, 'backup')
  }
  if (status.lastSuccessAtUtc === null) {
    return { key: 'backupStatusNever', percent: null }
  }
  return { key: 'backupStatusIdle', percent: null }
}

/** `lastError` 是核心侧写下的分类字符串；认不出来就按「读取不到」处理 */
const lastErrorKind = (raw: string): BackupFailureKind => {
  const value = raw.trim()
  return (KNOWN as readonly string[]).includes(value) ? (value as BackupFailureKind) : 'unknown'
}

/**
 * 空间提醒：先看「还够不够再存一份」（用户更关心这个），再看「占得是不是多了」。
 * 两条都不满足就不提醒 —— 常驻一条提示等于没有提示。
 */
export const spaceView = (
  status: BackupStatus | null
): { key: TranslationKey; params?: TranslationParams; level: 'blocked' | 'nudge' } | null => {
  if (status === null) {
    return null
  }
  if (status.count > 0 && !status.enoughForNext) {
    return { key: 'backupSpaceBlocked', level: 'blocked' }
  }
  if (status.totalBytes >= SPACE_WARN_BYTES) {
    return { key: 'backupSpaceNudge', level: 'nudge', params: { size: formatSize(status.totalBytes) } }
  }
  return null
}

/** 「立即备份」能不能点：正在跑任何一段、状态读不到、空间不够时都不让点 */
export const canRunBackup = (status: BackupStatus | null, phase: BackupPhase): boolean =>
  phase === 'idle' &&
  status !== null &&
  !status.running &&
  status.enoughForNext &&
  // 这台环境备不了就**别留一个点了会报错的按钮**：置灰 + 状态行给原因
  status.lastError !== 'unsupported'

/** 「恢复备份」能不能点：至少要有一份**能用**的备份（列表还没读回来时按状态里的份数判） */
export const canRestoreBackup = (
  status: BackupStatus | null,
  phase: BackupPhase,
  items: readonly BackupItem[] | null
): boolean => {
  if (phase !== 'idle') {
    return false
  }
  // 状态读不到**不能连恢复一起否掉**：状态文件坏掉往往和数据出事同时发生，而恢复要的
  // 证据是「这份备份校验过」，不是「状态文件还读得出来」。设备实测的丢库现场里，
  // 这条判断会让最该用的那个按钮变成灰的。
  if (status !== null && status.running) {
    return false
  }
  if (items === null) {
    return status !== null && status.count > 0
  }
  return items.some((item) => item.checksumOk)
}

/**
 * 体积 → 人话。只给界面用，不参与任何判断。
 * 单位用 B / KB / MB / GB（业界通行的读法，用户不需要知道背后的换算）。
 */
export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${Math.max(1, Math.round(kb))} KB`
  }
  const mb = kb / 1024
  if (mb < 1024) {
    return `${round1(mb)} MB`
  }
  return `${round1(mb / 1024)} GB`
}

const round1 = (value: number): string => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 时间 → 人话（**本机时区**，`2026-11-27 14:05`）。
 *
 * 不用 `toLocaleString`：不同 WebView 的中文格式差异很大（有的给「下午2:05」），
 * 而这一行要和「备份时间 / 最近一次备份」并排显示，固定形状更稳。解析失败给空串。
 */
export const formatWhen = (isoUtc: string | null): string => {
  if (isoUtc === null) {
    return ''
  }
  const time = Date.parse(isoUtc)
  if (!Number.isFinite(time)) {
    return ''
  }
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 恢复列表里一行：时间 · 大小 · 几个对话（核心侧给不出条数时就不显示条数） */
export const itemLine = (item: BackupItem): ActionText => {
  const params = { time: formatWhen(item.createdAtUtc), size: formatSize(item.sizeBytes) }
  return item.sessionCount > 0
    ? { key: 'backupRestoreItemLine', params: { ...params, count: item.sessionCount } }
    : { key: 'backupRestoreItemLineNoCount', params }
}

/** 「最近一次备份」那一格的值：有时间就显示时间，没有就是「还没有备份」 */
export const lastBackupText = (status: BackupStatus | null): { key: TranslationKey } | { text: string } =>
  status === null || status.lastSuccessAtUtc === null
    ? { key: 'backupLastNone' }
    : { text: formatWhen(status.lastSuccessAtUtc) }

/** 「备份占用空间」那一格的值 */
export const spaceValue = (
  status: BackupStatus | null
): { key: TranslationKey; params?: TranslationParams } => {
  if (status === null || status.count === 0) {
    return { key: 'backupSpaceNone' }
  }
  return {
    key: 'backupSpaceValue',
    params: { size: formatSize(status.totalBytes), count: status.count },
  }
}
