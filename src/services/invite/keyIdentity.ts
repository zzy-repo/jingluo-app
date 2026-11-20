/**
 * 「这把 Key 是什么时候到我手上的、最后一次还能用是什么时候」（Issue #451 第 1 点）。
 *
 * ## 为什么要它
 *
 * #374 已经能把一次失败说清是哪把 Key（尾号）、是哪种失效（format / notFound / rotated / rejected），
 * 但用户真正要判断的那句话还缺两个时间：
 *
 *   「这把 Key 是刚绑的、一直好好的，今天突然不行」——**Key 被动过了**；
 *   「绑了一个月，最近一次成功是三天前」——**大概率是这几天出的事**。
 *
 * 没有这两个时间，用户只能凭记忆猜，我们和客服也没法从截图里看出时间线。
 *
 * ## 服务端给不了，所以这是**本机记账**
 *
 * 邀请 / 额度服务（`services/invite/api.ts` 的 `/apply` 与 `/me`）只回额度档案
 * （`quota_points` / `used_points` / `remaining_points` / `key_status` …），
 * **没有** `bound_at` 与 `last_used_at` 这类字段；今天（2026-11-20）也不打算为它改服务端契约。
 * 所以本文件只在客户端记两件事：
 *
 *   - `boundAt`       这把 Key **第一次**被写进本机配置的时间（再次保存同一把 Key 不刷新）；
 *   - `lastSuccessAt` 本机最后一次**确认这把 Key 可用**的时间。
 *
 * ## 为什么按「指纹」存
 *
 * 记录挂在 Key 的短指纹（`fingerprint`）上，不是挂在设备码或全局一个格子里：
 * 换一把 Key，指纹就变了，旧记录自然对不上 —— 界面于是显示「本机没有这把 Key 的记录」，
 * 而不是把上一把 Key 的绑定时间安到新 Key 头上（那比不显示更糟）。
 * 指纹只留哈希，Key 原文一个字都不落盘（与 `services/api/keyRejection.ts` 同一条线）。
 *
 * ## 「最近一次成功使用」的写入时机（如实说明）
 *
 * 本单只在本机能观测到的成功点上记：设置里校验 Key、连通性测试、我们的渠道 Key 探测、
 * 重置额度、兑换卡密成功 —— 这五处都真的用当前 Key 打了上游并拿到了成功应答。
 * **聊天成功那一轮没有接**：那条路径在 `services/chat/*`，不在本单允许改动的文件范围内
 * （改动面见 issue #451 正文）。所以这里的语义是「本机最后一次确认这把 Key 可用」，
 * 界面文案也按这个口径写，不写成「最后一次对话成功」。
 *
 * 纯逻辑（不碰 localStorage）：存储读写只在 `services/api/apiConfig.ts` 里，
 * 与本仓「宿主能力只在一个文件里」的口径一致。
 */
import { keyTail } from '../api/keyFailure.js'

/** 一条 Key 身份记录。时间一律毫秒时间戳（与 localStorage 里的写法一致，跨版本可读） */
export type KeyIdentity = {
  /** Key 的短指纹（哈希，不是 Key 本身） */
  fingerprint: string
  /** 这把 Key 第一次被写进本机的时间 */
  boundAt: number
  /** 本机最后一次确认这把 Key 可用的时间；`null` = 还没有过成功记录 */
  lastSuccessAt: number | null
}

/**
 * 短指纹：同一把 Key 恒定、换一把必变，且**不可反推**（只留哈希）。
 *
 * 与 `services/api/keyRejection.ts` 的 shortHash 同一套 djb2，另外带上长度：
 * 长度是 Key 的一个真实特征（粘贴时少了几个字符是最常见的错），叠上去能少一批碰撞。
 */
export const keyFingerprint = (apiKey: string | undefined | null): string => {
  const value = (apiKey ?? '').trim()
  if (value === '') {
    return ''
  }
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return `${(hash >>> 0).toString(16)}-${value.length}`
}

/** 存储形态：键名短一点（只在 localStorage 里用，不进日志、不进界面） */
type Stored = { f: string; b: number; s: number | null }

const isFiniteTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * 解析存储值。**坏数据一律当没有**（返回 null），不猜、不补默认时间：
 * 一条「1970-01-01 绑定」的记录比「没有记录」更容易把排查带到沟里。
 */
export const parseKeyIdentity = (raw: string | null): KeyIdentity | null => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Partial<Stored>
  if (typeof record.f !== 'string' || record.f === '' || !isFiniteTime(record.b)) {
    return null
  }
  return {
    fingerprint: record.f,
    boundAt: record.b,
    lastSuccessAt: isFiniteTime(record.s) ? record.s : null,
  }
}

export const serializeKeyIdentity = (identity: KeyIdentity): string => {
  const stored: Stored = {
    f: identity.fingerprint,
    b: identity.boundAt,
    s: identity.lastSuccessAt,
  }
  return JSON.stringify(stored)
}

/**
 * 写 Key 时的身份记录：
 *  - 清空 Key（`''`）→ null（连记录一起删，留下的旧时间只会误导）；
 *  - 同一把 Key 重复保存 → **原样返回**（绑定时间不刷新：用户点两次保存不等于换了两次 Key）；
 *  - 换了 Key → 新记录，绑定时间 = 这次写入时间，成功时间清空（新 Key 还没有成功过）。
 */
export const identityOnKeyWrite = (
  current: KeyIdentity | null,
  apiKey: string,
  at: number
): KeyIdentity | null => {
  const fingerprint = keyFingerprint(apiKey)
  if (fingerprint === '') {
    return null
  }
  if (current !== null && current.fingerprint === fingerprint) {
    return current
  }
  return { fingerprint, boundAt: at, lastSuccessAt: null }
}

/**
 * 记一次「这把 Key 刚刚被确认可用」。
 *
 * 指纹对得上 → 只更新成功时间；对不上（本机记录还是上一把 Key 的，或压根没有记录）→
 * 以这次成功为起点建一条记录：绑定时间只能取「这次」—— 更早的时间我们不知道，编一个更糟。
 */
export const identityOnSuccess = (
  current: KeyIdentity | null,
  apiKey: string,
  at: number
): KeyIdentity | null => {
  const fingerprint = keyFingerprint(apiKey)
  if (fingerprint === '') {
    return null
  }
  if (current !== null && current.fingerprint === fingerprint) {
    return { ...current, lastSuccessAt: at }
  }
  return { fingerprint, boundAt: at, lastSuccessAt: at }
}

/**
 * 界面要展示的形态（三态，与 `InviteProfile.hasEmail` 那套写法一致）：
 *  - `none`：本机没有这把 Key 的记录（从没写过 / 存储被清 / 记录坏了）→ 整行说明，不编时间；
 *  - `record`：有记录 → 尾号 + 绑定时间 + 最近成功时间（后者可能为 null = 还没有成功过）。
 *
 * 指纹对不上当前 Key 时同样是 `none`：那是上一把 Key 的时间，挂到这把上就是假信息。
 */
export type KeyIdentityView =
  | { kind: 'none' }
  | {
      kind: 'record'
      /** Key 尾 4 位（太短的不回显，见 `keyTail`） */
      tail: string
      boundAt: number
      lastSuccessAt: number | null
    }

export const keyIdentityView = (
  record: KeyIdentity | null,
  apiKey: string | undefined | null
): KeyIdentityView => {
  const fingerprint = keyFingerprint(apiKey)
  if (record === null || fingerprint === '' || record.fingerprint !== fingerprint) {
    return { kind: 'none' }
  }
  return {
    kind: 'record',
    tail: keyTail(apiKey),
    boundAt: record.boundAt,
    lastSuccessAt: record.lastSuccessAt,
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 时间戳 → `YYYY-MM-DD HH:mm`（本机时区）。
 *
 * 刻意不用 `toLocaleString`：这里只想要一个稳定、可单测的串，而 locale 数据在
 * Capacitor WebView / Node 之间并不一致。用户看的是「哪天几点」这件事本身，不是本地化格式。
 * 非法 / 缺失时间返回空串（调用方据此隐藏该行，而不是显示 `NaN`）。
 */
export const formatIdentityTime = (at: number | null | undefined): string => {
  if (!isFiniteTime(at)) {
    return ''
  }
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
