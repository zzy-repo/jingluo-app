/**
 * 「我们的渠道」Key 的**运行时接线**（Issue #596；触发时机与重试是 #803）：把纯逻辑
 * （`services/api/managedKey.ts`）接到真实的三样东西上 —— 消费层客户端、本机存储、设备码。
 *
 * 为什么单独一个文件而不是写在组件里：
 *   - 组件（`.tsx`）在单测里 import 不了，而这里有三条关键顺序（先取旧标记 → 再领取 → 落盘 +
 *     写标记 → 停用旧 Key），值得被读被改；写成 `.ts` 后至少能被源码断言钉住；
 *   - 启动对齐（App）、登录 / 注册后的自动领取（`setSessionEstablishedHook`）、账号页的
 *     幂等对齐、设置页按钮用的是**同一份**实现，不允许各写一套（那正是 #596 第 3 条
 *     「界面显示的尾号必须来自实际请求那把」最容易破的地方）。
 *
 * #803 补的是**触发时机与重试**，不是另写一条领 Key 的链路：
 *  1. 登录 / 注册**成功、拿到新 access token 之后**立刻执行一次（`ensureManagedKeyAfterAuth`）；
 *     以前只有「启动 + ours 渠道 + 已登录」那一个 effect，而「先未登录进 App 再注册」时
 *     `signedIn` 全程没变过，effect 不会重跑 —— 于是注册完一次 `/api/v1/keys` 都没有；
 *  2. 领取本身走 {@link ensureManagedKey}：先查重（同名就用，不重复创建）→ 没有才建 →
 *     **失败自动重试一次** → 401 先换凭据；
 *  3. 两次都失败时把原因与状态码**写进可见状态**（`managedKeyEnsureState`：界面出提示 + 「重试」）
 *     与诊断日志，绝不静默；
 *  4. 并发幂等：本文件的「进行中」标记是**进程级单飞** —— 注册后 profile 与建 Key 同时触发时，
 *     它们等的是同一个 promise，服务端只会看到一次 `POST /api/v1/keys`。
 *
 * 三条边界：
 *  1. 这里不拼 URL、不发原始请求：路径白名单在 `services/consume/**`（#484）；
 *  2. Key 原文只在内存里过一手，落盘只走 `applyManagedKey`（写 Key + 写标记，同一处）；
 *  3. 日志只记「尾号 / 动作 / 结果 / 状态码」，**不记 Key 原文**（与 #484 §7 同一条红线）。
 */
import {
  applyManagedKey,
  getApiKey,
  getProviderKind,
  getServerKeyMark,
  markServerKey,
} from '../../services/api/apiConfig.js'
import {
  claimManagedKey,
  retireManagedKey,
  syncManagedKey,
  usesManagedKey,
  type ManagedKeyClaim,
  type ManagedKeyEnsureFailure,
  type ManagedKeySource,
} from '../../services/api/managedKey.js'
import type { ConsumeCallResult } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { getAccessToken, refreshSessionOnce } from '../../services/auth/store.js'
import { registerSessionCache } from '../../services/auth/sessionCache.js'
import { recordAction } from '../../services/diagnostics/collector.js'
import { ensureDeviceId } from '../../services/invite/device.js'
import {
  markManagedKeyEnsureFailed,
  markManagedKeyEnsureOk,
  markManagedKeyEnsureRunning,
  resetManagedKeyEnsure,
} from './managedKeyEnsureState.js'

/** 真实客户端 → 领取链路要的那一小撮能力（结构化取子集，换实现不用改判定） */
const managedKeySource = (): ManagedKeySource => {
  const client = getConsumeClient()
  return {
    keys: {
      list: client.keys.list,
      create: client.keys.create,
      update: client.keys.update,
    },
  }
}

/** 有没有登录态：领取/对齐都要 JWT，没有就不发请求（未登录只会拿回 401） */
export const canClaimManagedKey = (): boolean => getAccessToken() !== undefined

/**
 * 领取（`rotate: false`）/ 重新领取（`rotate: true`）。
 *
 * 成功时**同一个函数里**完成三件事，顺序不能换：
 *  1. 先取旧标记里的 Key id（重新领取之后要停用的是**这一把**）；
 *  2. `applyManagedKey` 一次写 Key + 写标记 —— 不允许出现「Key 换了、标记还是旧的」中间态；
 *  3. 停用旧那把（`retireManagedKey`，失败不算领取失败：新 Key 已经到手且可用）。
 *
 * 这是**用户主动**「重新领取」那条路（设置页 / 账号页的显式按钮）。后台自动那条走
 * {@link ensureManagedKeyForDevice}：它多了查重、单飞与失败重试，但落盘仍然是同一个
 * `applyManagedKey`（不出现第二条写 Key 的路）。
 */
export const claimManagedKeyForDevice = async (
  options: { rotate: boolean }
): Promise<ConsumeCallResult<ManagedKeyClaim>> => {
  const previousId = getServerKeyMark()?.id
  const result = await claimManagedKey(managedKeySource(), {
    deviceId: ensureDeviceId(),
    rotate: options.rotate,
  })
  if (!result.ok) {
    recordAction('config_change', 'ours-managed-key', {
      result: 'failed',
      rotate: options.rotate,
      code: result.error.code,
      status: result.error.status,
    })
    return result
  }
  applyManagedKey(result.data.key, result.data.id)
  if (result.data.rotated) {
    void retireManagedKey(managedKeySource(), previousId)
  }
  recordAction('config_change', 'ours-managed-key', {
    result: 'saved',
    rotate: result.data.rotated,
    length: result.data.key.length,
  })
  return result
}

/**
 * 一次「确保有 Key」的结局。四种都有人用，别折成布尔：
 *  - `updated`    ：拿到的与服务端那把一致，本机被（重新）写成服务端那把；
 *  - `unchanged`  ：本机早就是那一把、标记也在 —— 什么都没动（幂等命中的常态）；
 *  - `signed-out` ：没有登录态（领取链路要 JWT，此时发请求只会拿 401）；
 *  - `failed`     ：两次尝试都没拿到 —— 原因在 `managedKeyEnsureState` 与诊断日志里，界面必须说话。
 */
export type ManagedKeySyncOutcome = 'updated' | 'unchanged' | 'signed-out' | 'failed'

/**
 * 「进行中」标记（#803 第 8 条）：**进程级单飞**。
 *
 * 注册成功后有两条独立的触发路径会同时跑（`profile` 那条页面 effect + 登录钩子里的建 Key），
 * 各跑一遍就是两次 `POST /api/v1/keys`（服务端允许同名，于是长出两把 Key）。
 * 这里让后来的调用**等同一个 promise**：只发一轮请求，两边拿到同一个结局。
 */
let ensureInFlight: Promise<ManagedKeySyncOutcome> | null = null

/** 真正的执行体（只从 {@link ensureManagedKeyForDevice} 进，否则单飞就漏了） */
const runManagedKeyEnsure = async (): Promise<ManagedKeySyncOutcome> => {
  if (!canClaimManagedKey()) {
    // 未登录不该留下「失败」提示：那不是用户能修的错，登录之后这条流程会自己再跑一次
    return 'signed-out'
  }
  markManagedKeyEnsureRunning()
  const result = await syncManagedKey(managedKeySource(), {
    deviceId: ensureDeviceId(),
    // #803 第 6 条：401 时**先换凭据再重试**。这里注入的是身份层的单飞刷新（同一个时刻只发一次
    // `/auth/refresh`），换不到就以 `refresh-failed` 收场，绝不拿旧 token 再打一次。
    refresh: refreshSessionOnce,
  })
  if (!result.ok) {
    return recordEnsureFailure(result)
  }
  const changed = result.key.trim() !== getApiKey().trim()
  if (changed) {
    applyManagedKey(result.key, result.id)
  } else if (getServerKeyMark() === null) {
    // Key 对得上但标记不在（老版本留下的 / 标记被清掉的）：补写标记，
    // 否则发送前那道闸会永远判 `unclaimed`（#800 起没有「重新领取」按钮可点）
    markServerKey(result.key, result.id)
  }
  markManagedKeyEnsureOk(result.attempts)
  recordAction('config_change', 'ours-managed-key-ensure', {
    result: changed ? 'updated' : 'unchanged',
    attempts: result.attempts,
    created: result.created,
    length: result.key.length,
  })
  return changed ? 'updated' : 'unchanged'
}

/**
 * 两次都失败：写诊断（**带状态码**，这是 #803 第 5 条的原文要求）与可见状态，然后返回 `failed`。
 *
 * 失败原因只留「性质 + 状态码 + 码」，不留响应体原文（里面可能有别的账号的信息）。
 */
const recordEnsureFailure = (result: ManagedKeyEnsureFailure): 'failed' => {
  const last = result.failures[result.failures.length - 1]
  if (last !== undefined) {
    recordAction('config_change', 'ours-managed-key-ensure', {
      result: 'failed',
      attempts: result.attempts,
      stop: result.stop,
      kind: last.kind,
      status: last.status,
      code: last.code || 'UNKNOWN',
      step: last.step,
      refreshed: result.refreshed,
    })
    markManagedKeyEnsureFailed(last, result.attempts)
  }
  return 'failed'
}

/**
 * 「确保这台设备此刻有一把可用的 Key」——**所有自动路径的唯一入口**（登录 / 注册后、
 * 启动对齐、账号页的幂等对齐、界面的「重试」按钮）。
 *
 * 单飞（见 `ensureInFlight`）：并发调用只跑一轮请求；结束后立刻放槽，
 * 下一次真需要（例如用户点「重试」）会重新跑一次完整的「查重 → 建 → 重试一次」。
 */
export const ensureManagedKeyForDevice = (): Promise<ManagedKeySyncOutcome> => {
  if (ensureInFlight !== null) {
    return ensureInFlight
  }
  ensureInFlight = runManagedKeyEnsure().finally(() => {
    ensureInFlight = null
  })
  return ensureInFlight
}

/**
 * 登录 / 注册成功后的自动领取（#803 第 1 条）。由 `main.tsx` 挂进身份层的会话钩子。
 *
 * 为什么只认 `ours` 渠道：其它三个渠道的 Key 是**用户自己的**（同一格 `chat-demo:api-key`），
 * 自动下发会把用户手填的那把覆盖掉 —— 那正是 #608「只拿一把自己的 Key 也能用」的反面。
 * 内置服务（内测包默认渠道）才是「Key 由服务端下发」的那一个。
 *
 * 渠道不对时**不留失败提示**：这不是失败，是这条流程不适用于当前渠道。
 */
export const ensureManagedKeyAfterAuth = (reason: string): Promise<ManagedKeySyncOutcome> => {
  if (!usesManagedKey(getProviderKind())) {
    return Promise.resolve('unchanged')
  }
  recordAction('config_change', 'ours-managed-key-ensure', {
    result: 'triggered',
    trigger: `auth-${reason}`,
    attempts: 0,
  })
  return ensureManagedKeyForDevice()
}

/**
 * 对齐入口（#596 的老名字，保留给 `App` / 账号页 / 发送前拦截那三处）：
 * 语义已经由 {@link ensureManagedKeyForDevice} 承担（查重 → 建 → 失败重试一次），
 * 这里只做一层转发，避免出现「启动走一套、登录后走另一套」的两份实现。
 *
 * 跳过条件都写在返回值的字符串里，别让它变成静默失败：
 *  - `signed-out`：没有登录态，领取链路要 JWT（此时本机那把只能等用户登录后再领）；
 *  - `failed`：网络/服务端失败 —— 保持本机现状，发送前那道闸会用标记判出「旧 Key」并拦下，
 *    同时界面上有可见提示 + 「重试」（#803 第 5 条）。
 *
 * #800 起这条对齐是**唯一的恢复入口**（内置服务子页不再渲染 Key 行与「重新领取」）：
 * 所以它必须真的能把两种异常状态都收干净 —— Key 不一致（`stale`）与**标记缺失**
 * （`unclaimed`：本机有一把、但没有下发标记，例如老版本留下的、或标记被清掉的）。
 * 两者都由 `runManagedKeyEnsure` 收尾（`applyManagedKey` / `markServerKey`）。
 */
export const syncManagedKeyFromServer = (): Promise<ManagedKeySyncOutcome> =>
  ensureManagedKeyForDevice()

/**
 * 切号清态（#803 第 7 条的后半）：整块「进行中 / 失败」状态属于**当前账号**，
 * A 的失败提示不许留在 B 的界面上。登记在 `sessionCache` 里 → `store.clearSession`
 * 退出登录 / 会话失效时统一清（Key 与 token 本身由 `accountCaches` 那一条清）。
 *
 * 放在**模块初始化**而不是某个组件的 effect 里：这条状态只有本文件会写，
 * 而本文件一旦被 import 就已经可能写过它了。
 */
registerSessionCache({ name: 'ours-managed-key-ensure', purge: resetManagedKeyEnsure })
