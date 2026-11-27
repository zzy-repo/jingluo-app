/**
 * 迁移失败分类器（#940）。**纯函数**：无 React、无副作用、不读全局、不碰平台。
 *
 * 它不是「某一条报错的文案表」，而是一条**全域兜底**的判定管道：任何东西（`Error` / 字符串 /
 * `undefined` / 陌生 code / 循环引用的 `cause` / 抛异常的 getter）被扔进来，都必须得到一个
 * 安全结论，**绝不抛**。四条性质由它承载：
 *
 *  1. 停止不安全操作、保护已有数据 —— 每个档位都带显式 `safeAction`；无法识别时默认就是
 *     「不再写新存储、原存储继续当真源」（`keep-source`），不是「重试 / 继续写入 / 当作成功」。
 *  2. 按实际状态决定入口 —— 给不给「重试」看 `dataTruth`（真源在谁手里、是否已部分写入、
 *     是否越过了旧库升版屏障），不看错误文案好不好看。
 *  3. 不暴露原始技术异常、不虚报成功或数据完整 —— 用户可见文案只由 `copyPlanOf()` 产出的
 *     i18n key 决定，原始 `code` / `message` / 类名只进 `diagnostics`；`canPromiseSourceIntact`
 *     是「敢不敢说原数据没问题」的唯一开关，不确认就是 `false`。
 *  4. 保留完整诊断信息 —— `diagnostics` 一个字段不少（code / 原始 message / 类名 / 阶段 /
 *     store / 数据状态快照），交给 `src/services/diagnostics` 的 `recordError`。
 *
 * 为什么必须同时看 code、类名和原始 message（三条实测事实，决定了这个文件长成现在这样）：
 *
 *  - **`retryable` 在 TS 侧已经丢了**：Java 侧对 primary code 5/6 报 `kind=unavailable, retryable=true`，
 *    但 `sqlite/native/driver.ts` 的 `errorShapeOf` 只保留 `kind/code/message`。所以「可不可重试」
 *    只能由本文件自己判，底层不给信号。
 *  - **`error.name` 会被抹平**：`sqlite/repos/errors.ts` 现在把 `kind=unavailable` 一律换成
 *    `StorageUnavailableError`，把 CORRUPT / NOTADB / BUSY / LOCKED 一起盖住。**光看类名分不出
 *    「磁盘坏了」和「库被别人占着」** —— 必须继续读 `code`，以及 `code` 被抹掉后仍留在
 *    message 前缀里的 `SQLITE_xxx:`。
 *  - **`judgePreflight` 用同一个 `unsupported` 码承载三种处境**（源太大 / 可用空间读不到 /
 *    真不支持），只能靠 message 前缀区分。这三条是**本仓库内自产的稳定前缀**，属于 code 契约的一部分，
 *    不是对外部噪声的猜测。
 */
import type { TranslationKey } from '../../../i18n/index.js'

// ------------------------------------------------------------------ 档位

/** 有限档位。新增档位必须同时补 `TIER_ACTION` / `TIER_COPY`（Record 类型会强制）。 */
export const FAILURE_TIERS = ['space', 'too-large', 'corrupt', 'io', 'unsupported', 'interrupted', 'unknown'] as const
export type FailureTier = (typeof FAILURE_TIERS)[number]

/**
 * 默认安全动作。
 *  - `retry`：可以再跑一次迁移（旧库没被改动，写入是幂等 upsert）。
 *  - `recheck`：不直接再写，先重新判定真源，判定不出来就必须停下（路由会报 blocked）。
 *  - `keep-source`：不再自动写任何东西，原存储保持为真源，只能继续使用 + 报诊断。
 */
export type SafeAction = 'retry' | 'recheck' | 'keep-source'

/** 用户可见入口，一次失败只给一个主入口。 */
export type FailureAction = 'retry' | 'recheck' | 'continue'

// ------------------------------------------------------------------ 数据状态

/**
 * 旧库（IndexedDB）还是真源吗？由调用方（启动闸门）用**路由结论**填：
 * 路由在失败后重新收敛过双见证，它说 `idb` 才敢填 `idb`；说不清就是 `unknown`。
 */
export type FailureTruthSource = 'idb' | 'sqlite' | 'unknown'

/**
 * 「我的数据现在怎么样」的判定输入。**只收状态，不收错误**：错误决定「出了什么事」，
 * 状态决定「敢不敢说数据没事、要不要给重试」——两者混在一起就是上一版文案乱承诺的根因。
 */
export type FailureStateSnapshot = {
  truthSource?: FailureTruthSource
  /** 状态机 phase（`idle` / `copying` / `verified` / `committed` …） */
  phase?: string
  /** 目标库是否已有写入（部分写入）；`undefined` = 不知道 */
  targetWritten?: boolean
  /** 是否已越过「旧库升版」屏障（旧库被改过，不能再承诺「旧数据完好」） */
  legacyBumped?: boolean
}

/** 数据真相结论：决定 `canPromiseSourceIntact` 与「继续使用」是否成立。 */
export type DataTruth = 'source-intact' | 'partial-write' | 'committed' | 'unknown'

export type FailureInput = {
  /** 底层错误本体，任何值都可能（含 `undefined` / 字符串 / 循环引用对象） */
  error?: unknown
  /** 调用方已经知道的 code（优先于从 error 里抠） */
  code?: unknown
  /** 迁移阶段，仅进诊断 */
  stage?: string
  /** 出问题的 store，仅进诊断 */
  store?: string
  state?: FailureStateSnapshot
}

/** 诊断字段：全是字符串，可直接当 `LogMeta` 用（用户看不到）。 */
export type FailureDiagnostics = {
  code: string
  name: string
  message: string
  stage: string
  store: string
  tier: string
  dataTruth: string
  truthSource: string
  phase: string
  targetWritten: string
  legacyBumped: string
}

export type FailureEvidenceSource = 'code+message' | 'code' | 'name' | 'message' | 'none'

export type FailureClassification = {
  tier: FailureTier
  /** 凭什么归到这一档（只进诊断 / PR 表格） */
  evidence: { source: FailureEvidenceSource; value: string }
  /** 保守的默认动作 */
  safeAction: SafeAction
  /** 本次失败该给的那一个主入口 */
  primaryAction: FailureAction
  allowRetry: boolean
  allowContinue: boolean
  /** **唯一**允许说「原数据仍然可用」的开关 */
  canPromiseSourceIntact: boolean
  dataTruth: DataTruth
  diagnostics: FailureDiagnostics
}

// ------------------------------------------------------------------ 档位 → 动作

const TIER_ACTION: Record<FailureTier, { safeAction: SafeAction; primaryAction: FailureAction }> = {
  // 可重试：旧库没被改动，重跑一遍是幂等 upsert
  space: { safeAction: 'retry', primaryAction: 'retry' },
  'too-large': { safeAction: 'retry', primaryAction: 'retry' },
  io: { safeAction: 'retry', primaryAction: 'retry' },
  interrupted: { safeAction: 'retry', primaryAction: 'retry' },
  // 不可重试：重试只会再撞一次同一面墙，明确让用户留在原存储
  corrupt: { safeAction: 'keep-source', primaryAction: 'continue' },
  unsupported: { safeAction: 'keep-source', primaryAction: 'continue' },
  // 无法归类：默认不写、不承诺，先重新判定
  unknown: { safeAction: 'keep-source', primaryAction: 'recheck' },
}

// ------------------------------------------------------------------ 档位 → 文案

const TIER_COPY: Record<FailureTier, { title: TranslationKey; body: TranslationKey }> = {
  space: { title: 'storageMigrationFailureSpaceTitle', body: 'storageMigrationFailureSpaceBody' },
  'too-large': { title: 'storageMigrationFailureTooLargeTitle', body: 'storageMigrationFailureTooLargeBody' },
  corrupt: { title: 'storageMigrationFailureCorruptTitle', body: 'storageMigrationFailureCorruptBody' },
  io: { title: 'storageMigrationFailureIoTitle', body: 'storageMigrationFailureIoBody' },
  unsupported: { title: 'storageMigrationFailureUnsupportedTitle', body: 'storageMigrationFailureUnsupportedBody' },
  interrupted: { title: 'storageMigrationFailureInterruptedTitle', body: 'storageMigrationFailureInterruptedBody' },
  unknown: { title: 'storageMigrationFailureUnknownTitle', body: 'storageMigrationFailureUnknownBody' },
}

const DATA_COPY: Record<DataTruth, TranslationKey> = {
  'source-intact': 'storageMigrationDataIntact',
  'partial-write': 'storageMigrationDataPartial',
  committed: 'storageMigrationDataCommitted',
  unknown: 'storageMigrationDataUnknown',
}

const NEXT_COPY: Record<FailureAction, TranslationKey> = {
  retry: 'storageMigrationNextRetry',
  recheck: 'storageMigrationNextRecheck',
  continue: 'storageMigrationNextContinue',
}

const ACTION_LABEL: Record<FailureAction, TranslationKey> = {
  retry: 'storageMigrationRetry',
  recheck: 'storageMigrationRecheck',
  continue: 'storageMigrationKeepOriginal',
}

/** 一次失败要渲染的**全部**文案 key（界面只认它，不再自己拼句子）。 */
export type FailureCopyPlan = {
  tier: FailureTier
  titleKey: TranslationKey
  bodyKey: TranslationKey
  dataKey: TranslationKey
  nextKey: TranslationKey
  primaryAction: FailureAction
  primaryLabelKey: TranslationKey
  /** 主入口之外还允许出现的次入口（永远不含「同一件事的两个主按钮」） */
  showRetry: boolean
  showRecheck: boolean
  showContinue: boolean
  /** 复制诊断信息（`corrupt` / `unknown` 这类必须能带走证据的场合） */
  showDiagnostics: boolean
  /** `interrupted` 附带「不要卸载 / 不要清数据」的硬提醒 */
  showUninstallWarning: boolean
}

export const copyPlanOf = (classification: FailureClassification): FailureCopyPlan => {
  const tier = classification.tier
  const primaryAction = classification.primaryAction
  return {
    tier,
    titleKey: TIER_COPY[tier].title,
    bodyKey: TIER_COPY[tier].body,
    dataKey: DATA_COPY[classification.dataTruth],
    nextKey: NEXT_COPY[primaryAction],
    primaryAction,
    primaryLabelKey: ACTION_LABEL[primaryAction],
    showRetry: classification.allowRetry,
    showRecheck: primaryAction === 'recheck',
    showContinue: classification.allowContinue,
    showDiagnostics: tier === 'corrupt' || tier === 'unsupported' || tier === 'unknown',
    showUninstallWarning: tier === 'interrupted',
  }
}

// ------------------------------------------------------------------ 诊断负载

/**
 * 「复制诊断」的剪贴板负载：**原始信息给开发看**，只进剪贴板 / 导出日志，不上屏幕。
 *
 * 与 `diagnostics` 同源，但保留成多行文本，用户粘贴进反馈就能定位到是哪一档、哪一步、
 * 哪个 store、原始错误原文是什么。界面文案不受它影响（性质 3 只约束屏幕上的字）。
 */
export const diagnosticTextOf = (classification: FailureClassification): string => {
  const d = classification.diagnostics
  return [
    'storage-migration-failure',
    `tier=${d.tier}`,
    `code=${d.code}`,
    `name=${d.name}`,
    `stage=${d.stage}`,
    `store=${d.store}`,
    `dataTruth=${d.dataTruth}`,
    `truthSource=${d.truthSource}`,
    `phase=${d.phase}`,
    `targetWritten=${d.targetWritten}`,
    `legacyBumped=${d.legacyBumped}`,
    `message=${d.message}`,
  ].join('\n')
}

// ------------------------------------------------------------------ 信号提取（全部带 try/catch）
const MAX_SIGNAL_LENGTH = 300

const textOf = (value: unknown): string | undefined => {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    default:
      return undefined
  }
}

/** 读属性：getter / Proxy 抛异常一律当作「没有这个字段」。**刻意不看 `cause`**（可能是循环引用）。 */
const propOf = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const entriesOf = (value: unknown): readonly unknown[] => {
  try {
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

type Extracted = {
  /** 归一后的码（大写），只用于分档 */
  codes: readonly string[]
  /** 第一个码的**原样**写法（诊断日志要保留原始写法，不能被我改写大小写） */
  rawCode: string
  name: string
  message: string
}

const extractSignal = (input: FailureInput): Extracted => {
  const codes: string[] = []
  let rawCode = ''
  const addCode = (value: unknown): void => {
    const text = textOf(value)
    if (text === undefined) {
      return
    }
    const trimmed = text.trim()
    if (trimmed !== '') {
      if (rawCode === '') {
        rawCode = trimmed
      }
      codes.push(trimmed.toUpperCase())
    }
  }
  const error = input.error
  addCode(input.code)
  addCode(propOf(error, 'code'))
  addCode(propOf(error, 'sqliteCode'))
  // `kind` 是基础设施口径（quota / unavailable / unsupported）；底层不给 retryable，只有这个还留着信息
  addCode(propOf(error, 'kind'))
  const name = textOf(propOf(error, 'name')) ?? ''
  const message = textOf(propOf(error, 'message')) ?? textOf(error) ?? ''
  return {
    codes,
    rawCode: rawCode.slice(0, MAX_SIGNAL_LENGTH),
    name: name.slice(0, MAX_SIGNAL_LENGTH),
    message: message.slice(0, MAX_SIGNAL_LENGTH),
  }
}

// ------------------------------------------------------------------ 码表

/** code → 档位。**全大写、连字符换成下划线**后查（`insufficient-space` → `INSUFFICIENT_SPACE`）。 */
const CODE_TIER: Record<string, FailureTier> = {
  // 空间
  SQLITE_FULL: 'space',
  QUOTA: 'space',
  QUOTA_EXCEEDED: 'space',
  QUOTA_EXCEEDED_ERR: 'space',
  QUOTAEXCEEDEDERROR: 'space',
  STORAGE_QUOTA_EXCEEDED: 'space',
  ENOSPC: 'space',
  ENOBUFS: 'space',
  DISK_FULL: 'space',
  NO_SPACE: 'space',
  NO_SPACE_LEFT: 'space',
  INSUFFICIENT_SPACE: 'space',
  NOT_ENOUGH_SPACE: 'space',
  // 单次读写量过大（>4 MiB 那条就是这里；分页在 #940 的另一半）
  RESULT_TOO_LARGE: 'too-large',
  // 分页/分块没取全（#949 的另一个稳定码）：宁可报错不给半截数据 → 当作「这次没搬全」，可重试
  RESULT_INCOMPLETE: 'io',
  ROW_TOO_LARGE: 'too-large',
  VALUE_TOO_LARGE: 'too-large',
  PAYLOAD_TOO_LARGE: 'too-large',
  SQLITE_TOOBIG: 'too-large',
  TOOBIG: 'too-large',
  E_TOOBIG: 'too-large',
  // 损坏 / 不是数据库文件
  SQLITE_CORRUPT: 'corrupt',
  SQLITE_CORRUPT_VTAB: 'corrupt',
  SQLITE_NOTADB: 'corrupt',
  CORRUPT: 'corrupt',
  CORRUPTED: 'corrupt',
  DATA_CORRUPT: 'corrupt',
  STATE_CORRUPT: 'corrupt',
  NOTADB: 'corrupt',
  MALFORMED: 'corrupt',
  // 读写失败（含 busy / locked / unavailable：底层「可重试」信号已丢，这里按「重跑一次」处置）
  SQLITE_BUSY: 'io',
  SQLITE_LOCKED: 'io',
  SQLITE_IOERR: 'io',
  SQLITE_READONLY: 'io',
  SQLITE_CANTOPEN: 'io',
  IO_ERROR: 'io',
  IOERR: 'io',
  EIO: 'io',
  UNAVAILABLE: 'io',
  SQLITE_UNAVAILABLE: 'io',
  // orchestrator/types.ts 自产的 MigrationFailure.code
  COPY_FAILED: 'io',
  BACKUP_FAILED: 'io',
  VERIFY_FAILED: 'io',
  // 本包 / 本平台无迁移能力（含「源数据总量超硬上界」，重试必然同失败，所以不给重试）
  UNSUPPORTED: 'unsupported',
  NOT_SUPPORTED: 'unsupported',
  NOT_IMPLEMENTED: 'unsupported',
  ENOTSUP: 'unsupported',
  ENOSYS: 'unsupported',
  // 中断
  INTERRUPTED: 'interrupted',
  ABORT: 'interrupted',
  ABORTED: 'interrupted',
  ABORT_ERR: 'interrupted',
  KILLED: 'interrupted',
  PROCESS_KILLED: 'interrupted',
  SQLITE_INTERRUPT: 'interrupted',
  CANCELLED: 'interrupted',
  CANCELED: 'interrupted',
}

/**
 * code 的第二种写法：干掉所有分隔符再查一次。真实链路里同一个码会被写成 `copy-failed`、
 * `COPY_FAILED`、`copyFailed` 三种样子（后者来自 `Error.name` 风格的驼峰类名），
 * 逐个登记等于给自己挖坑，这里一次性归一。
 */
const CODE_TIER_STRIPPED: Record<string, FailureTier> = {}
for (const [code, tier] of Object.entries(CODE_TIER)) {
  const key = code.replace(/[^A-Z0-9]/gu, '')
  if (CODE_TIER_STRIPPED[key] === undefined) {
    CODE_TIER_STRIPPED[key] = tier
  }
}

const tierOfCode = (code: string): FailureTier | undefined =>
  CODE_TIER[code] ?? CODE_TIER[code.replace(/-/gu, '_')] ?? CODE_TIER_STRIPPED[code.replace(/[^A-Z0-9]/gu, '')]

/**
 * 这些类名**不能用来分档**：`sqlite/repos/errors.ts` 在 `kind === 'unavailable'` 时一律换成
 * `StorageUnavailableError`，CORRUPT / NOTADB / BUSY / LOCKED 全被它盖住；`SqliteError` /
 * `SqliteFailure` / `UnexpectedFailure` 同理（原始码在里面，类名本身没有信息）。
 * 命中这些名字时跳过类名规则，让后面的 message 兜底来判断。
 */
const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
  'StorageUnavailableError',
  'SqliteStorageError',
  'SqliteError',
  'SqliteFailure',
  'UnexpectedFailure',
  'InfraError',
  'Error',
])

/** 类名规则。**只能在 code 全都没有信息时兜底**——`StorageUnavailableError` 把四种病都盖住了。 */
const NAME_RULES: ReadonlyArray<{ pattern: RegExp; tier: FailureTier }> = [
  { pattern: /corrupt|notadb|malformed/iu, tier: 'corrupt' },
  { pattern: /quota|enospc|nospace|full/iu, tier: 'space' },
  { pattern: /toolarge|toobig|overlimit/iu, tier: 'too-large' },
  { pattern: /interrupt|abort|cancel|kill/iu, tier: 'interrupted' },
  { pattern: /busy|locked/iu, tier: 'io' },
  { pattern: /unavailable|ioerr|readonly|readerror|writeerror/iu, tier: 'io' },
  { pattern: /unsupported|notsupported|notimplemented/iu, tier: 'unsupported' },
]

/** 原始 message 关键词：**最后一道兜底**，匹配不到就安全降级到 `unknown`（不崩、不猜）。 */
const MESSAGE_RULES: ReadonlyArray<{ pattern: RegExp; tier: FailureTier }> = [
  { pattern: /result exceeds\s*[\d\s.,]*bytes/iu, tier: 'too-large' },
  { pattern: /sqlite_toobig|string or blob too big/iu, tier: 'too-large' },
  { pattern: /too (?:big|large)|exceeds .*?(?:limit|max|cap)/iu, tier: 'too-large' },
  { pattern: /no space left|disk (?:is )?full|sqlite_full|not enough (?:free )?space/iu, tier: 'space' },
  { pattern: /insufficient (?:disk |storage )?space|storage quota/iu, tier: 'space' },
  { pattern: /malformed|not a database|file is encrypted|database disk image/iu, tier: 'corrupt' },
  { pattern: /i\/o error|read-?only|unable to open database/iu, tier: 'io' },
  { pattern: /sqlite_busy|database is locked|sqlite_locked/iu, tier: 'io' },
  { pattern: /not supported|unsupported|not implemented/iu, tier: 'unsupported' },
  { pattern: /abort|interrupt|killed|cancel+ed|sigkill|sigterm/iu, tier: 'interrupted' },
]

/** message 里还活着的原生错误码（`mapSqlError` 会把 code 拼进 message 前缀：`SQLITE_CORRUPT: ...`）。 */
const SQLITE_CODE_IN_MESSAGE = /(SQLITE_[A-Z][A-Z_]*)/u

/**
 * 包装码：`copy-failed` / `backup-failed` / `verify-failed` 只说明「哪一步炸了」，**不说明病因**。
 * 真实链路里 `migration/orchestrator.ts` 会把底层异常统一包成 `copy-failed`（病因只在
 * `message` 里还留着，例如 `SQLITE_CORRUPT: ...`）。所以这几个码排在最后兜底，
 * 不能因为它们先撞上就把「数据损坏」误判成「读写失败」（= 误给一个必然失败的重试）。
 */
const WRAPPER_TIERS: Readonly<Record<string, FailureTier>> = {
  COPYFAILED: 'io',
  BACKUPFAILED: 'io',
  VERIFYFAILED: 'io',
}

const strippedCodeOf = (code: string): string => code.replace(/[^A-Z0-9]/gu, '')

const resolveTier = (extracted: Extracted): { tier: FailureTier; source: FailureEvidenceSource; value: string } => {
  const { codes, name, message } = extracted
  const has = (code: string): boolean => codes.includes(code)
  const wrapperCode = codes.find((code) => WRAPPER_TIERS[strippedCodeOf(code)] !== undefined)

  // 1) code + message 必须同时成立：`judgePreflight` 用同一个 `unsupported` 装三种病
  if (has('UNSUPPORTED')) {
    if (/source-too-large/u.test(message)) {
      // 源数据总量超硬上界：重试必然同失败 → 归「本包无迁移能力」，不给重试
      return { tier: 'unsupported', source: 'code+message', value: 'unsupported/source-too-large' }
    }
    if (/free disk space is unknown/iu.test(message)) {
      // 连可用空间都读不到：不是「不支持」，是「这次判不出来」→ 重新检测
      return { tier: 'unknown', source: 'code+message', value: 'unsupported/free-space-unknown' }
    }
  }

  // 2) code（含 sqliteCode / kind）。包装码跳过：它们只说「哪一步」，病因在下一步找
  for (const code of codes) {
    if (WRAPPER_TIERS[strippedCodeOf(code)] !== undefined) {
      continue
    }
    const tier = tierOfCode(code)
    if (tier !== undefined) {
      return { tier, source: 'code', value: code }
    }
  }

  // 3) message 里残留的原生码（类名与 code 都被抹平后，这里是唯一还带信息的地方）
  const inMessage = SQLITE_CODE_IN_MESSAGE.exec(message)?.[1]
  if (inMessage !== undefined) {
    const tier = tierOfCode(inMessage)
    if (tier !== undefined) {
      return { tier, source: 'code', value: inMessage }
    }
  }

  // 4) 类名（**模糊名字直接跳过**：它说不清是坏了还是只是被占着）
  if (name !== '' && !AMBIGUOUS_NAMES.has(name)) {
    for (const rule of NAME_RULES) {
      if (rule.pattern.test(name)) {
        return { tier: rule.tier, source: 'name', value: name }
      }
    }
  }

  // 5) 原始 message 关键词
  for (const rule of MESSAGE_RULES) {
    if (rule.pattern.test(message)) {
      return { tier: rule.tier, source: 'message', value: message.slice(0, 80) }
    }
  }

  // 6) 包装码兜底：病因一个字都没留下时，就按「哪一步炸了」给最保守的可用结论（io = 可重试一次）
  if (wrapperCode !== undefined) {
    return { tier: WRAPPER_TIERS[strippedCodeOf(wrapperCode)] as FailureTier, source: 'code', value: wrapperCode }
  }

  return { tier: 'unknown', source: 'none', value: '' }
}

// ------------------------------------------------------------------ 数据状态

const TRUTH_SOURCES: readonly FailureTruthSource[] = ['idb', 'sqlite', 'unknown']

const truthOf = (value: unknown): FailureTruthSource =>
  TRUTH_SOURCES.includes(value as FailureTruthSource) ? (value as FailureTruthSource) : 'unknown'

const boolOf = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/** 目标库里可能已经有行（复制 / 校验阶段）。 */
const TARGET_WRITTEN_PHASES: readonly string[] = ['copying', 'verifying', 'verified']
/** 还停在「没往目标写过东西」的阶段。 */
const TARGET_UNTOUCHED_PHASES: readonly string[] = ['idle', 'preflight', 'backing-up', 'backup-verified']

/** 已写进目标库的检查点数（`done` 或有 `lastKey` 就算写过）。 */
const writtenCheckpointCount = (value: unknown): number => {
  let count = 0
  for (const entry of entriesOf(value)) {
    if (propOf(entry, 'done') === true || typeof propOf(entry, 'lastKey') === 'string') {
      count += 1
    }
  }
  return count
}

/**
 * 从编排器状态（或任何形状差不多的对象）里读出数据状态快照。**读不出来就是 `undefined`（未知）**，
 * 不当成 `false`——「不知道」与「确定没写过」在结论上是两回事。
 */
/**
 * 这两组码是**已落盘的迁移状态**（`state.failure.code`）的一部分，不是「读错误文案猜病情」：
 * 它们记录的是「哪一步报的失败」，也就是机器自己在失败那一刻知道自己走到哪了。
 *  · 写之前就会失败的：预检不通过、本机不支持、备份没成 —— 主目标库一行都没写过；
 *  · 写之后才会失败的：复制 / 校验 / 目标库打不开 —— 目标库可能已经有行。
 * 其它码（interrupted / source-changed / unknown …）一律**不下结论**（保持未知）。
 */
const PRE_WRITE_FAILURE_CODES: readonly string[] = ['INSUFFICIENT-SPACE', 'UNSUPPORTED', 'BACKUP-FAILED']
const POST_WRITE_FAILURE_CODES: readonly string[] = ['COPY-FAILED', 'VERIFY-FAILED', 'SQLITE-UNAVAILABLE']

/**
 * 把「编排器状态 + 失败码」折成分类器要的状态快照。**所有判断都基于状态**，
 * 唯一读的字符串是机器自己写下的 `failure.code`（阶段标签），不是异常原文。
 */
export const dataStateOf = (input: {
  truthSource?: unknown
  phase?: unknown
  checkpoints?: unknown
  legacyBarrier?: unknown
  targetWritten?: unknown
  failureCode?: unknown
}): FailureStateSnapshot => {
  try {
    const phase = typeof input.phase === 'string' ? input.phase : undefined
    const written = writtenCheckpointCount(input.checkpoints)
    const explicit = boolOf(input.targetWritten)
    const code = typeof input.failureCode === 'string' ? input.failureCode.toUpperCase() : ''
    const byCode = PRE_WRITE_FAILURE_CODES.includes(code)
      ? false
      : POST_WRITE_FAILURE_CODES.includes(code)
        ? true
        : undefined
    const derived =
      explicit ??
      (written > 0
        ? true
        : phase === undefined
          ? undefined
          : TARGET_WRITTEN_PHASES.includes(phase)
            ? true
            : TARGET_UNTOUCHED_PHASES.includes(phase)
              ? false
              : byCode)
    return {
      truthSource: truthOf(input.truthSource),
      ...(phase !== undefined ? { phase } : {}),
      ...(derived !== undefined ? { targetWritten: derived } : {}),
      // legacyBarrier 存在（上次升版可能已生效）= 旧库被动过，不能再承诺旧数据完好
      ...(input.legacyBarrier !== undefined ? { legacyBumped: true } : {}),
    }
  } catch {
    return {}
  }
}

/** 外部传进来的状态快照也做一次校验：JS 调用方可能给 `undefined` / 字符串 / 缺字段。 */
const normalizeState = (state: FailureStateSnapshot | undefined): FailureStateSnapshot => {
  if (typeof state !== 'object' || state === null) {
    return { truthSource: 'unknown' }
  }
  const targetWritten = boolOf(state.targetWritten)
  return {
    truthSource: truthOf(state.truthSource),
    ...(typeof state.phase === 'string' ? { phase: state.phase } : {}),
    ...(targetWritten !== undefined ? { targetWritten } : {}),
    ...(state.legacyBumped === true ? { legacyBumped: true } : {}),
  }
}

const dataTruthOf = (state: FailureStateSnapshot): DataTruth => {  if (state.truthSource === 'sqlite') {
    // 真源已经是新存储：旧库是过期副本
    return 'committed'
  }
  if (state.truthSource !== 'idb') {
    return 'unknown'
  }
  if (state.legacyBumped === true) {
    // 旧库升过版 / 说不清升没升：不许承诺「旧数据完好」
    return 'unknown'
  }
  if (state.targetWritten === true) {
    return 'partial-write'
  }
  if (state.targetWritten === false) {
    return 'source-intact'
  }
  return 'unknown'
}

// ------------------------------------------------------------------ 分类

const diagnosticsOf = (
  extracted: Extracted,
  input: FailureInput,
  tier: FailureTier,
  state: FailureStateSnapshot,
  dataTruth: DataTruth,
): FailureDiagnostics => ({
  code: extracted.rawCode,
  name: extracted.name,
  message: extracted.message,
  stage: typeof input.stage === 'string' ? input.stage : '',
  store: typeof input.store === 'string' ? input.store : '',
  tier,
  truthSource: state.truthSource ?? 'unknown',
  phase: state.phase ?? '',
  targetWritten: state.targetWritten === undefined ? 'unknown' : state.targetWritten ? 'true' : 'false',
  legacyBumped: state.legacyBumped === true ? 'true' : state.legacyBumped === false ? 'false' : 'unknown',
  dataTruth,
})

/** 最保守的结论：不认识的东西一律走这里（也是内部异常时的兜底返回值）。 */
const fallbackClassification = (input: FailureInput): FailureClassification => ({
  tier: 'unknown',
  evidence: { source: 'none', value: '' },
  safeAction: 'keep-source',
  primaryAction: 'recheck',
  allowRetry: false,
  allowContinue: false,
  canPromiseSourceIntact: false,
  dataTruth: 'unknown',
  diagnostics: {
    code: '',
    name: '',
    message: '',
    stage: typeof input.stage === 'string' ? input.stage : '',
    store: typeof input.store === 'string' ? input.store : '',
    tier: 'unknown',
    truthSource: 'unknown',
    phase: '',
    targetWritten: 'unknown',
    legacyBumped: 'unknown',
    dataTruth: 'unknown',
  },
})

/**
 * 分类入口。**total function**：任何输入都有结论，任何内部异常都被吞成最保守的结论。
 */
export const classifyFailure = (input: FailureInput = {}): FailureClassification => {
  let extracted: Extracted = { codes: [], rawCode: '', name: '', message: '' }
  let state: FailureStateSnapshot = { truthSource: 'unknown' }
  let resolved: { tier: FailureTier; source: FailureEvidenceSource; value: string } = {
    tier: 'unknown',
    source: 'none',
    value: '',
  }
  try {
    extracted = extractSignal(input)
    state = normalizeState(input.state)
    resolved = resolveTier(extracted)
  } catch {
    return fallbackClassification(input)
  }

  const tier = resolved.tier
  const dataTruth = dataTruthOf(state)
  const spec = TIER_ACTION[tier]

  // 状态优先于文案：先按数据实际状态改写入口，再决定要不要给按钮（性质 2）
  let primaryAction: FailureAction = spec.primaryAction
  if (dataTruth === 'committed') {
    // 真源已切到新存储：这次失败不能「重试迁移」，也不存在「原数据可用」。
    // 入口给「重新检测」（重走路由 → 真源是 sqlite 就直接进 App），
    // 不给「继续使用原来的存储」—— 那句话在已提交之后是假的。
    primaryAction = 'recheck'
  } else if (dataTruth === 'unknown' && primaryAction !== 'recheck') {
    // 数据状态说不清：不直接再写一次，先重新判定真源
    primaryAction = 'recheck'
  }

  const allowRetry = primaryAction === 'retry'
  const allowContinue =
    primaryAction === 'continue' || dataTruth === 'source-intact' || dataTruth === 'partial-write'

  return {
    tier,
    evidence: { source: resolved.source, value: resolved.value },
    safeAction: spec.safeAction,
    primaryAction,
    allowRetry,
    allowContinue,
    canPromiseSourceIntact: dataTruth === 'source-intact',
    dataTruth,
    diagnostics: diagnosticsOf(extracted, input, tier, state, dataTruth),
  }
}
