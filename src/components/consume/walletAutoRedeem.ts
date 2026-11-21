/**
 * #784「付款回来 → 自动兑现卡密进账号余额」的**最小闭环**（纯逻辑 + 本地去重 + 埋点，裸 Node 可测）。
 *
 * 触发点只有一个：`openPayLinkInApp(url, onClosed)` 的 `onClosed`（= 用户从联动小铺收款页回到 App）。
 * 进钱包页 / 进卡密页 / 挂载组件**都不许触发** —— 那不是「付款回来」，只是「用户在看余额」。
 *
 * 兑换本身**一行都不重写**：四态判定、超时先查 `/redeem/history` 核对、`409 REDEEM_CODE_LOCKED` = 处理中、
 * `202` / `status:accepted` = 受理未到账、到账后重拉 `/user/profile` 刷新 `balance` ——
 * 全部复用 `services/consume/redeem.ts` 与 `myCardsModel.ts:afterRedeemed()`。
 * 本文件只做「**该不该发这一枪**」和「发完以后告诉界面什么」。
 *
 * 四条硬约束（钱相关，逐条对应 #784）：
 *
 *  1. **本地按 code 去重**：同一张卡第二次进入不再提交。落盘的是**指纹**（FNV-1a + 尾 4 位），
 *     不是卡密原文 —— 卡密全文不进 localStorage（#484 §7 红线）。
 *  2. **不自动重试**：`redeemCode()` 的 `retryAfterConfirm` 永远不传 true。sub2api 的兑换没有幂等键，
 *     第二枪只能由用户在那个手动「去兑换」入口里自己按下去。
 *  3. **打码卡密不自动兑**：`/redeem/history` 的 `code` 契约是「可能全码也可能打码（`MUSE-****-1234`）」，
 *     所以拿到 code **先判**（无 `*` 且形如 32 位 hex）才自动兑；判不过就只给手动入口。
 *  4. **只在付款回来触发**（见上）+ 日志 `stage: 'wallet.auto-redeem'`，只记 code 后 4 位与结果码。
 *
 * 还有两条与「不确定」有关的取舍：
 *  - **历史条目的待兑判定宁严勿宽**：`/redeem/history` 语义上是「兑换记录」，查得出来通常意味着已经兑过。
 *    只有条目上出现**明确**的「未使用」标记（`used: false` / `status: 'unused'` …）才算待兑，
 *    认不出来一律**不发**（多发一枪的代价是用户看到「这张卡已被使用」，比少发一枪贵得多）。
 *  - 历史接口不通 / 读不出来 → `skipped`，不猜、不重试。
 */

import type { TranslationKey } from '../../i18n/index.js'
import type { ConsumeClient, ConsumeRedeemHistoryItem } from '../../services/consume/index.js'
import { record } from '../../services/diagnostics/collector.js'
import { buildMeta } from '../../services/diagnostics/fields.js'
import { afterRedeemed } from './myCardsModel.js'

/** 埋点阶段（`services/diagnostics/fields.ts` 的 `Stage` 里登记过，写错编译期就红） */
export const AUTO_REDEEM_STAGE = 'wallet.auto-redeem'

/** 本地去重表：只存指纹，**不存卡密原文** */
export const AUTO_REDEEM_STORAGE_KEY = 'chat-demo:wallet-auto-redeem'

/** 最多记多少张：够挡住「反复从收款页回来」，又不会把 localStorage 撑大 */
export const MAX_REMEMBERED = 50

/** 全码形状：32 位 hex，且**带 `*` 的一律不算**（打码形态 `MUSE-****-1234` 会被这条挡掉） */
const FULL_CODE = /^[0-9a-f]{32}$/i

/** 一张历史条目上，「已使用」的各种说法（小写化后比较） */
const USED_WORDS = new Set([
  'used',
  'redeemed',
  'consumed',
  'claimed',
  'already_used',
  'already-used',
  '已使用',
  '已兑换',
])

/** 一张历史条目上，「未使用」的各种说法 */
const UNUSED_WORDS = new Set(['unused', 'pending', 'available', 'valid', 'active', '未使用', '待兑换'])

/** 允许出现的状态字段名（服务端字段名会漂，这里按名字逐个试） */
const STATUS_FIELDS = ['status', 'state', 'card_status', 'redeem_status'] as const
/** 允许出现的布尔字段名 */
const BOOL_FIELDS = ['used', 'redeemed', 'is_used', 'is_redeemed', 'consumed'] as const
/** 出现这些时间字段 = 已经兑过（有兑换时间就不可能是「待兑」） */
const REDEEMED_AT_FIELDS = ['redeemed_at', 'used_at', 'redeem_time', 'redeemed_at_iso'] as const

/**
 * 判定「这一条还能兑吗」。
 *
 * 只有当条目上出现**明确**的未使用标记时才回 true：这不是保守，而是钱的语义 —— 把「不知道」当成
 * 「没兑过」，最坏结果是自动打出第二枪，用户看到 `REDEEM_CODE_USED`（「卡被别人用了」）。
 */
export const isPendingHistoryItem = (item: ConsumeRedeemHistoryItem): boolean => {
  const raw = item.raw
  for (const field of BOOL_FIELDS) {
    const value = raw[field]
    if (typeof value === 'boolean') {
      return value === false
    }
  }
  for (const field of REDEEMED_AT_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value.trim() !== '') {
      return false
    }
  }
  for (const field of STATUS_FIELDS) {
    const value = raw[field]
    if (typeof value !== 'string') {
      continue
    }
    const word = value.trim().toLowerCase()
    if (word === '') {
      continue
    }
    if (UNUSED_WORDS.has(word)) {
      return true
    }
    if (USED_WORDS.has(word)) {
      return false
    }
    // 认不出来的状态字：既不当作待兑，也不当已用（继续看下一个字段），最后落到「不发」
  }
  // 也可能整条记录只有一个 `value`（兑换面值）+ `type`：那是「已经兑过、额度已到账」的形状，不发
  return false
}

/**
 * 能不能自动兑这张卡。
 *
 * 打码的（含水 `*`）、不是 32 位 hex 的（例如旧的 `MUSE-XXXX-…` 分隔形态、全角字符、空白里藏东西）
 * 一律 false —— 自动兑的判据必须**只看形状**，不去猜内容。
 */
export const isAutoRedeemableCode = (code: string): boolean => {
  const text = code.trim()
  if (text === '' || text.includes('*')) {
    return false
  }
  return FULL_CODE.test(text)
}

/** 只取尾 4 位：日志 / 界面能用的最大信息量（`mask.ts` 同一口径） */
export const codeTail = (code: string): string => {
  const text = code.trim()
  return text.length <= 4 ? text : text.slice(-4)
}

/**
 * 去重指纹：FNV-1a 32 位 + 尾 4 位。
 *
 * 为什么不是原文：卡密等于钱，落进 localStorage 就等于落进了「任何一个能读 localStorage 的地方」。
 * 指纹对同一张卡是稳定的（去重要的就是这个），但**反推不出**卡密。
 */
export const codeFingerprint = (code: string): string => {
  const text = code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${codeTail(text)}`
}

const readMemory = (): string[] => {
  try {
    const raw = localStorage.getItem(AUTO_REDEEM_STORAGE_KEY)
    if (raw === null) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null
        ? (parsed as { codes?: unknown }).codes
        : []
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    // 存储不可用 / 内容坏了：当作「没记住过」。反正这只是去重，坏了最坏是多发一枪
    return []
  }
}

/** 这张卡是不是**已经自动提交过**（不论成败）。存储不可用时返回 false */
export const wasAutoSubmitted = (code: string): boolean => readMemory().includes(codeFingerprint(code))

/** 记住这张卡（**发请求之前**写）：中途崩了也不会因为「忘了」再打一枪 */
export const rememberAutoSubmitted = (code: string): void => {
  const fingerprint = codeFingerprint(code)
  const kept = readMemory().filter((item) => item !== fingerprint)
  kept.push(fingerprint)
  try {
    localStorage.setItem(
      AUTO_REDEEM_STORAGE_KEY,
      JSON.stringify({ v: 1, codes: kept.slice(-MAX_REMEMBERED) })
    )
  } catch {
    // 写不进去就算了：这次已经发出去了，下次最多重发一次（比抛错打断流程好）
  }
}

/** 测试 / 排查用：清空去重表 */
export const forgetAutoSubmitted = (): void => {
  try {
    localStorage.removeItem(AUTO_REDEEM_STORAGE_KEY)
  } catch {
    // 同上
  }
}

/** 跳过原因：每种都对应一句「为什么不发」，排查时不用从现象倒推 */
export type WalletAutoRedeemSkipReason =
  | 'not-signed-in'
  | 'busy'
  | 'history-failed'
  | 'no-pending'
  | 'no-code'
  | 'duplicate'

/** 一次自动兑现的结局（界面只按它的 `kind` 分支，不自己推断） */
export type WalletAutoRedeemOutcome =
  /** 没发任何请求。`not-signed-in` 要给「登录后自动到账」，其余静默 */
  | { kind: 'skipped'; reason: WalletAutoRedeemSkipReason }
  /** 打码卡密：**没有**发 redeem，只给手动入口（`code` 是服务端打的码，可以原样显示） */
  | { kind: 'masked'; code: string; i18nKey: TranslationKey }
  /** 到账（余额已重拉过一次 `/user/profile`） */
  | {
      kind: 'credited'
      tail: string
      /** 面值（元）；服务端只说了「success」没给 type 时缺席 */
      amount?: number
      /** 兑换后的账户余额（元）；profile 读不到就缺席 */
      balance?: number
      /** 服务端原句（成功时通常就是 "success"，只作卡片副标题） */
      message: string
    }
  /** 受理未到账（`202` / `LOCKED`）：**不是失败**，不给重试，只给手动入口 */
  | { kind: 'processing'; tail: string; i18nKey: TranslationKey; message: string }
  /** 明确失败：不重试，只给手动入口 */
  | { kind: 'failed'; tail: string; i18nKey: TranslationKey; message: string }

/** 依赖：只认「查历史 / 兑换 / 读资料」三件事，测试给假实现即可 */
export type WalletAutoRedeemDeps = {
  client: Pick<ConsumeClient, 'redeem' | 'auth'>
  /** 登录态（未登录时**一个请求都不发**：拿空 JWT 打只会 401） */
  signedIn: boolean
}

/** 同一时刻只允许一次自动兑现（连点「去支付 → 回来」不会叠出两条流水线） */
let running = false

const logInfo = (result: string, tail?: string): void => {
  record('nav', 'info', 'wallet auto redeem', {
    ...buildMeta({ stage: AUTO_REDEEM_STAGE }),
    result,
    ...(tail === undefined || tail === '' ? {} : { 'card.tail': tail }),
  })
}

const logWarn = (result: string, tail?: string): void => {
  record('warning', 'warn', 'wallet auto redeem', {
    ...buildMeta({ stage: AUTO_REDEEM_STAGE }),
    result,
    ...(tail === undefined || tail === '' ? {} : { 'card.tail': tail }),
  })
}

/**
 * 付款回来之后的自动兑现（**最多一个 POST**）。
 *
 * 顺序：登录态 → 查 `/redeem/history` → 找到第一条明确「未使用」的 → 判形状（打码的不兑）
 * → 判本地去重 → **先落盘再发** → 复用 `redeemCode()` → 到账则 `afterRedeemed()` 刷 `balance`。
 *
 * 所有异常都在这里收口成 `failed` / `skipped`：这个函数**永远不抛**，因为它跑在 UI 回调里，
 * 抛出去只会变成一条 unhandled rejection，而用户什么也看不到。
 */
export const runWalletAutoRedeem = async (deps: WalletAutoRedeemDeps): Promise<WalletAutoRedeemOutcome> => {
  if (!deps.signedIn) {
    logInfo('skipped:not-signed-in')
    return { kind: 'skipped', reason: 'not-signed-in' }
  }
  if (running) {
    logInfo('skipped:busy')
    return { kind: 'skipped', reason: 'busy' }
  }
  running = true
  try {
    return await run(deps)
  } catch {
    // 传输层之外的意外（配置缺失、解析炸了……）：结论是「没兑成」，绝不因此再打一枪
    logWarn('failed:threw')
    return { kind: 'failed', tail: '', i18nKey: 'walletAutoRedeemFailed', message: '' }
  } finally {
    running = false
  }
}

const run = async (deps: WalletAutoRedeemDeps): Promise<WalletAutoRedeemOutcome> => {
  const history = await deps.client.redeem.history({ page: 1, pageSize: 20 })
  if (!history.ok) {
    // 历史读不到 = 「不知道有没有待兑」→ 不发、不猜、不重试
    logInfo(`skipped:history-failed:${history.error.code}`)
    return { kind: 'skipped', reason: 'history-failed' }
  }
  const pending = history.data.items.find(isPendingHistoryItem)
  if (pending === undefined) {
    logInfo('skipped:no-pending')
    return { kind: 'skipped', reason: 'no-pending' }
  }
  const code = (pending.code ?? '').trim()
  if (code === '') {
    logInfo('skipped:no-code')
    return { kind: 'skipped', reason: 'no-code' }
  }
  const tail = codeTail(code)
  if (!isAutoRedeemableCode(code)) {
    // 契约：#784 第 3 条 —— 打码卡密**不自动兑**，只给手动入口
    logInfo('masked', tail)
    return { kind: 'masked', code, i18nKey: 'walletAutoRedeemMasked' }
  }
  if (wasAutoSubmitted(code)) {
    logInfo('skipped:duplicate', tail)
    return { kind: 'skipped', reason: 'duplicate' }
  }
  // 先落盘再发：这一枪无论结果如何，都不会被下一次「付款回来」重打
  rememberAutoSubmitted(code)

  // 不传 `retryAfterConfirm`：自动路径**只发一次**（sub2api 没有幂等键）
  const outcome = await deps.client.redeem.redeem({ code })
  if (outcome.kind === 'redeemed') {
    // 到账后重拉 `/user/profile`：余额在 `user.balance`，不是某把 Key 的 quota（#676 §五）
    const aftermath = await afterRedeemed(outcome, deps.client.auth)
    logInfo('credited', tail)
    return {
      kind: 'credited',
      tail,
      ...(outcome.result.type === 'balance' ? { amount: outcome.result.value } : {}),
      ...(aftermath.refresh && aftermath.balance !== undefined ? { balance: aftermath.balance } : {}),
      message: outcome.result.message,
    }
  }
  if (outcome.kind === 'processing') {
    // 409 LOCKED / 202 受理：**正在处理**，不是失败 —— 文案交给 `error.i18nKey`
    logWarn('processing', tail)
    return { kind: 'processing', tail, i18nKey: outcome.error.i18nKey, message: outcome.error.message }
  }
  // `pending`（超时 + 核对未到账）与 `failed`（业务失败）在自动路径上是同一句话：
  // **不重试**，卡片给「去兑换」，用户自己决定要不要再按一次
  logWarn(outcome.kind === 'pending' ? 'failed:pending' : 'failed', tail)
  return { kind: 'failed', tail, i18nKey: outcome.error.i18nKey, message: outcome.error.message }
}
