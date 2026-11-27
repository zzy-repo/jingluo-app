// 存储写失败的**分级**（纯函数：不碰 DOM、不碰 IndexedDB、不 import 任何模块）。
//
// 为什么单独一个文件（#937 / #938）：这套判定有两个调用方 ——
//  · 存储层自己（`chat/db.ts` 的 `writeSessionRecord()` / 各 repo，把 `error` 转成可落库的
//    `StorageFailure` 交给调用方）；
//  · `chat/store.ts` 的 `failureOfThrown()`（落盘过程**抛出**而不是返回 `outcome.failure` 的那条路）。
// 后者原先自己写了一份「只认 name、kind 硬编码 unknown」的简化版 —— 于是同一个满盘错误，
// 走 `outcome.failure` 时还能分类，走抛出路径就一律变成「可重试」（#938 的现场）。
// 留在一个 1400+ 行的 IndexedDB 模块里还有个副作用：`chat/store.ts` 的单元测试把 `./db.js`
// 整个换成内存假库（这是这个仓库既有的 L0 手法：断言打在 store 状态机上），一旦 store 从
// `./db.js` 里多要一个导出，就得同步改所有假库；分类规则本身又恰恰是 #938 的被测对象，
// 最不该被替身挡住。所以它单独成文件：真假库都能直接 import 真实现。
//
// 依赖方向：谁都不依赖本文件以外的东西（`storageFailure.ts` ← 其余全部），改这里不会牵连 IDB 代码。

// ---------------------------------------------------------------- 存储写失败分级（P0 事故修复）

/**
 * 本机写失败的**四类**。判定先认 `error.name`（`message` 各引擎写法不一致，靠它猜必错），
 * **再补一道只认「满盘」字样的兜底**（#938，见 `isSpaceFullError`：磁盘满时 Chromium 报的是
 * `UnknownError`，名字不可信）。分类决定两件事：**要不要重试 / 要不要自愈**、以及**横幅说什么**。
 *
 * | kind | 触发 | 自愈动作 | 用户能做什么 |
 * | --- | --- | --- | --- |
 * | `quota` | `QuotaExceededError`（超配额）、Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED`、文案含 ENOSPC / full disk / no space left（#938）、基础设施层已判成 `quota` 的 `InfraError`（#949 透传） | 清孤儿 blob 后重试一次 | 清理 / 导出备份后重试 |
 * | `clone` | `DataCloneError`：会话里混进了函数 / symbol 等不可结构化克隆的值 | 剔除坏字段后重试一次 | 重试（程序自己会修） |
 * | `unavailable` | 宿主没有 IndexedDB（`StorageUnavailableError`）、WebKit 写 blob 抛的 `UnknownError`（文案不含满盘字样）、`NotSupportedError`、`StorageVersionTooNewError` | 无 | 换 App / 换环境，重试没用 |
 * | `unknown` | 其余，含 `InvalidStateError`（连接正在关闭，重连后能再试）与 `StorageBlockedError` | 重连后再试 | 重试 |
 *
 * 为什么 `UnknownError` 归 `unavailable` 而不是 `unknown`：WebKit 在写 blob 时抛
 * `UnknownError`（配额 / 权限 / 沙箱三者它都不区分），实测**同一份数据重试一万次也一样失败**，
 * 把它当「可重试」只会让用户反复点重试。这正是「清后台后记录消失、Web 端与手表端同时复现」的
 * 现场：写不进去 + 库被系统淘汰，两个原因叠在一起。
 */
export type StorageFailureKind = 'quota' | 'clone' | 'unavailable' | 'unknown'

/** 一次写失败的结构化描述（**只含元数据**：分类 / error.name / message / store，不含会话内容）。 */
export type StorageFailure = {
  kind: StorageFailureKind
  /** 原始 `error.name`（`DataCloneError` / `QuotaExceededError` / `UnknownError` …） */
  name?: string
  /** 原始 `error.message`，截断到 200 字符；引擎给的都是固定句式，不带用户正文 */
  message?: string
  /** 失败涉及的 object store（逗号分隔）：定级时「哪一段没写进去」比「失败了」有用 */
  stores?: string
  at?: number
}

export const STORAGE_FAILURE_KINDS: readonly StorageFailureKind[] = [
  'quota',
  'clone',
  'unavailable',
  'unknown',
]

export const isStorageFailureKind = (value: unknown): value is StorageFailureKind =>
  typeof value === 'string' && (STORAGE_FAILURE_KINDS as readonly string[]).includes(value)

export const errorNameOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) {
      return name
    }
  }
  return undefined
}

export const errorMessageOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return undefined
}

/**
 * 基础设施层已经判好的 `kind`（`InfraError.kind`，见 `capability/errors.ts`）。
 * #949 之前原生桥的 `code` 在中途被拍平成 `UNKNOWN`，这个信号传不上来；现在能了，
 * 所以「原生侧明确说了 quota」就**不必**再靠文案猜（文案可能是 `database or disk is full`，也可能什么都没有）。
 */
const infraKindOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const kind = (error as { kind?: unknown }).kind
    if (typeof kind === 'string' && kind.length > 0) {
      return kind
    }
  }
  return undefined
}

/**
 * 「满盘」文案的特征（#938）。只收**明确的空间不足字样**，宁窄勿宽：
 * 多认一条无关错误后果是「把能重试的失败说成空间不足」，那会把用户赶去清空间却不解决问题。
 * 注意**不收** `QuotaExceededError` 这几个字 —— 名字由 `classifyStorageFailure` 的 name 分支判定，
 * 只在文案里出现（`new Error('QuotaExceededError')`）不足以说明它就是配额错误（原有口径，`A5` 用例钉住）。
 */
const SPACE_FULL_PATTERN =
  /(no space left|not enough space|insufficient (?:disk )?space|out of (?:disk )?space|full disk|disk (?:is )?full|SQLITE_FULL|ENOSPC)/iu

/** 纯函数：这条错误的文案是不是「磁盘写满」类（不看 `name`，见上）。 */
export const isSpaceFullError = (error: unknown): boolean => {
  const message = errorMessageOf(error)
  return message !== undefined && SPACE_FULL_PATTERN.test(message)
}

/** 纯函数（L0 可单测）：`error` → 四类之一。不碰 DOM、不碰 IndexedDB，只看 `name` 与满盘文案。 */
export const classifyStorageFailure = (error: unknown): StorageFailureKind => {
  const name = errorNameOf(error)
  switch (name) {
    case 'DataCloneError':
      return 'clone'
    case 'QuotaExceededError':
    case 'NS_ERROR_DOM_QUOTA_REACHED':
      return 'quota'
  }
  // #938：磁盘写满时 `name` **不可信** —— Chromium 把「写不进去」报成 `UnknownError`，真正的证据在
  // 文案里（实测 `Encountered full disk while opening backing store for indexedDB.open.`）；
  // 插件 / 原生侧还会把 `ENOSPC: no space left on device` 原样抛出来（普通 `Error`，name 是 Error）。
  // 只在 name 没定案（不是 clone / 配额）时兜底：与空间无关的 `UnknownError`（WebKit 写 blob 那条）
  // 不会被误升级成 quota。
  if (isSpaceFullError(error)) {
    return 'quota'
  }
  // 基础设施层已经判成 quota 的（`InfraError(kind='quota')`，原生桥 reject 的 `QUOTA` / `SQLITE_FULL`
  // 经 #949 透传上来）直接认：满盘时文案未必带得出证据，`kind` 带得出。
  // **只认 `quota`** —— `unavailable` / `unsupported` 等仍走下面的 name 分支，不在这里顺手放宽档位。
  if (infraKindOf(error) === 'quota') {
    return 'quota'
  }
  switch (name) {
    // WebKit 写 Blob 失败：不区分配额 / 权限 / 沙箱，只能整体判成「这个环境写不进去」
    case 'UnknownError':
    case 'NotSupportedError':
    case 'SecurityError':
    case 'StorageUnavailableError':
    case 'StorageVersionTooNewError':
      return 'unavailable'
    default:
      // 含 InvalidStateError（连接正在关闭：重连后可以再试）与 StorageBlockedError（另一标签页占着：
      // 关掉它再试就行）—— 两者都**不是**环境缺能力，别拿「建议用 App 打开」赶人
      return 'unknown'
  }
}

const FAILURE_MESSAGE_MAX = 200

/** `error` → 可直接落库 / 进诊断包的 `StorageFailure`（纯函数）。 */
export const storageFailureOf = (error: unknown, stores?: string): StorageFailure => {
  const failure: StorageFailure = { kind: classifyStorageFailure(error), at: Date.now() }
  const name = errorNameOf(error)
  if (name) {
    failure.name = name
  }
  const message = errorMessageOf(error)
  if (message) {
    failure.message = message.slice(0, FAILURE_MESSAGE_MAX)
  }
  if (stores) {
    failure.stores = stores
  }
  return failure
}

/**
 * 读旧值兼容：P0 之前的 `sessionSaveErrors` 是 `Record<id, boolean>`，
 * `true` 只表示「这条会话没存上」，没有分类。**旧值一律当可重试档**（`unknown`）读 ——
 * 不能因为「不知道原因」就把用户的会话判成「当前环境无法保存」（那个档位不给重试按钮）。
 */
export const normalizeStorageFailure = (value: unknown): StorageFailure | undefined => {
  if (value === true) {
    return { kind: 'unknown' }
  }
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Partial<StorageFailure>
  return {
    ...candidate,
    kind: isStorageFailureKind(candidate.kind) ? candidate.kind : 'unknown',
  } as StorageFailure
}
