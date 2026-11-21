/**
 * 写操作的**效果确认**（Issue #679）—— 「2xx 不等于生效」的**唯一**落点。
 *
 * 病灶（#660 排查出来、#679 收口）：`bindEmail` 曾把 `200 + 空响应体` 当成功，界面显示「已绑定」
 * 而脱敏邮箱是空的；同类点在 consume 层还有 6 处。根因同一个：**判据只看 HTTP 状态，不看效果是否可确认**。
 *
 * 本文件把 #660 在 `email.ts` 里手写的那套三段逻辑固化成一个小工具：
 *
 *   ① `accept(response)`  —— 响应体里有**可显示的实体证据**（如 `email_masked`）→ 已确认，省一次请求；
 *   ② `probe()`          —— 否则**回查一次**（如 `GET /user/profile`），拿到证据 → 已确认；
 *   ③ 否则               —— `confirmed: false`。**不猜、不假装成功**，由调用点按语义给文案。
 *
 * 三条硬约束（每条都对应一次真实事故）：
 *   - **回查最多一次**：`confirmEffect` 内部只调一次 `probe`，没有循环、没有重试。写操作之后的查询
 *     一旦被放大，就会变成「一次失败 → 多个写请求」或「重复扣额度」（#484 §4.3 最贵的教训）。
 *   - **不认识证据就当没证据**：`accept` 返回 `undefined` 表示「这个响应体里没有可信证据」，
 *     **不是**「大概成了」。`identities.email.bound === true` 这类**间接字段**不算证据（#660 的原始病灶）。
 *   - **回查失败 ≠ 没生效，也 ≠ 生效**：回查本身报错时结论是「未知」（`probe-failed`），文案要给出
 *     下一步（重试 / 换设备核对），绝不升格成成功。
 *
 * 与面板的分工：本文件只回「确认了没有 / 为什么没确认」，**不拼文案**（`i18nKey` 由调用点给，
 * 文案在 `src/i18n/*.ts`）。
 */

import type { ConsumeMessageKey, Sub2ApiError } from './errors.js'
import type { ConsumeCallResult, ConsumeRawResponse } from './http.js'

/** 一次回查的结论：确认 / 反证 / 不知道（三种都要能表达，别用 `undefined` 混着表示） */
export type ConfirmProbeResult<T> =
  | { verdict: 'confirmed'; value: T }
  /** 回查拿到了**反证**：效果没发生（实体还在 / 字段仍是旧值 / 旧凭据仍有效） */
  | { verdict: 'negative' }
  /** 回查本身失败，或者回查到了但里面没有能判定的字段 */
  | { verdict: 'unknown'; error?: Sub2ApiError }

/** 回查函数：**调用方保证它只查一次**，`confirmEffect` 保证它只被调一次 */
export type ConfirmProbe<T> = () => Promise<ConfirmProbeResult<T>>

/** 没确认成功的原因（调用点据此选文案，别把四种情况混成一句「失败」） */
export type ConfirmFailureReason =
  /** `accept` 没认出证据，且调用点没给回查手段 */
  | 'no-evidence'
  /** 响应体里没有证据，回查也没拿到证据 */
  | 'no-probe'
  /** 回查请求自己失败了（网络 / 401 / 5xx）—— 结论是未知 */
  | 'probe-failed'
  /** 回查成功并给出了反证：效果没发生 */
  | 'probe-negative'

export type ConfirmEffectOutcome<T> =
  | { confirmed: true; value: T; via: 'response' | 'probe' }
  | { confirmed: false; reason: ConfirmFailureReason; probeError?: Sub2ApiError }

export type ConfirmEffectInput<T> = {
  /**
   * 首次响应的**成功体**（调用方已把 `ok: false` 按既有错误处理掉了：非 2xx 不需要确认，
   * 它本来就是失败）。
   */
  response: { data: unknown; raw: ConsumeRawResponse }
  /**
   * 从响应体判定「已确认」：返回实体 = 已确认；返回 `undefined` = 这个体里没有可信证据。
   * 省略 = 「这个端点的成功体不可能有证据」（例如实测只回 `{message}` 的 DELETE）。
   */
  accept?: (data: unknown, raw: ConsumeRawResponse) => T | undefined
  /** 可选：回查**一次**。省略 = 这个点没有可回查的手段（此时只能走例外，见表）。 */
  probe?: ConfirmProbe<T>
}

/**
 * 判定顺序（**固定**，不要在各调用点重排）：
 *   `accept(response)` → `probe()` → `confirmed: false`。
 */
export const confirmEffect = async <T>(
  input: ConfirmEffectInput<T>
): Promise<ConfirmEffectOutcome<T>> => {
  const { accept, probe, response } = input
  if (accept !== undefined) {
    const hit = accept(response.data, response.raw)
    if (hit !== undefined) {
      return { confirmed: true, value: hit, via: 'response' }
    }
  }
  if (probe === undefined) {
    return { confirmed: false, reason: accept === undefined ? 'no-evidence' : 'no-probe' }
  }
  // 回查**只到这里一次**：没有 for / while、没有 catch 后重试（见文件头的三条硬约束）
  const probed = await probe()
  if (probed.verdict === 'confirmed') {
    return { confirmed: true, value: probed.value, via: 'probe' }
  }
  if (probed.verdict === 'negative') {
    return { confirmed: false, reason: 'probe-negative' }
  }
  if (probed.error !== undefined) {
    return { confirmed: false, reason: 'probe-failed', probeError: probed.error }
  }
  return { confirmed: false, reason: 'no-probe' }
}

/**
 * 「回查一次 + 两条判据」的常见形态（4/6 个调用点都是这个形状）：
 *
 * ```ts
 * probe: probeOnce(() => getKey(http, id), (data) => match(toConsumeApiKey(data)) ? key : undefined, (data) => !match(key))
 * ```
 *
 * `fetchProbe` 失败（网络 / 401 / 5xx）→ `unknown`（结论未知，不升格成成功）；
 * `accept` 命中 → `confirmed`；`negative` 命中 → `negative` 反证；都不命中 → `unknown`。
 */
export const probeOnce =
  <T>(
    fetchProbe: () => Promise<ConsumeCallResult<unknown>>,
    accept: (data: unknown) => T | undefined,
    negative?: (data: unknown) => boolean
  ): ConfirmProbe<T> =>
  async () => {
    const probed = await fetchProbe()
    if (!probed.ok) {
      return { verdict: 'unknown', error: probed.error }
    }
    const hit = accept(probed.data)
    if (hit !== undefined) {
      return { verdict: 'confirmed', value: hit }
    }
    if (negative !== undefined && negative(probed.data)) {
      return { verdict: 'negative' }
    }
    return { verdict: 'unknown' }
  }

/**
 * 「未确认」→ 归一化错误（形状与 `errors.ts` 的一致，界面只认 `i18nKey`）。
 *
 * 回查本身失败时**沿用它的 `kind` / `code` / `status` / `envelope`**：界面据此还能给出
 * 「登录已过期」这类更具体的下一步；`i18nKey` 仍是本调用点的「结果未确认」。
 */
export const unconfirmedEffectError = (input: {
  /** 本调用点的文案 key（必须是 `consumeErr*` 一族里的具体一条，不要用兜底） */
  i18nKey: ConsumeMessageKey
  /** 排查用（不上屏）：确认失败的那句事实描述 */
  message: string
  /** 服务端没给码时用这个（如 `REVOKE_UNCONFIRMED`） */
  code: string
  /** 首次响应的状态码（排查用） */
  status: number
  outcome: Extract<ConfirmEffectOutcome<never>, { confirmed: false }>
}): Sub2ApiError => {
  const upstream = input.outcome.probeError
  return {
    kind: upstream === undefined ? 'unknown' : upstream.kind,
    code: upstream === undefined ? input.code : upstream.code,
    message:
      upstream === undefined ? input.message : `${input.message}（回查失败：${upstream.message}）`,
    status: upstream === undefined ? input.status : upstream.status,
    retryable: true,
    envelope: upstream === undefined ? 'none' : upstream.envelope,
    i18nKey: input.i18nKey,
  }
}

/**
 * 一个调用点的判据（**表驱动**，#679 第 3 条要求）。
 *
 * 这张表是**给人看的规格**，也是 `tests/unit/consume-confirm-effect-679.test.mjs` 的 drift 守卫：
 * 用例会读源码，断言「表里 `exception` 之外的点都真的用了 `confirmEffect`」、
 * 「标了 `exception` 的点必须写清理由」。新增写操作时**先在这张表里加一行**，再写代码。
 */
export type ConsumeEffectPolicy = {
  /** 调用点符号（与源码导出名一致，drift 用例按名字对） */
  point: string
  /** 写操作端点（只用于文档，不参与请求） */
  endpoint: string
  /** 判据：什么叫「已确认」 */
  criterion: string
  /** 为什么这个点**必须**确认 / 为什么可以只信 2xx（例外必须有理由，不能空着） */
  why: string
  /** 例外：允许「只看 2xx」（必须写明 `why`，且不得有 `probe`） */
  exception?: true
  /** 回查手段（例外点必须没有） */
  probe?: string
}

export const CONSUME_EFFECT_POLICIES: readonly ConsumeEffectPolicy[] = [
  {
    point: 'revokeAllSessions',
    endpoint: 'POST /api/v1/auth/revoke-all-sessions',
    criterion:
      '回查 GET /user/profile 用**同一个** JWT 打过去：401/403（会话类错误）= 凭据确实被撤销了',
    why:
      '安全语义，本单最严重的一处：撤销失败却告诉用户「已退出所有设备」，等于让用户以为公用设备 / 丢失设备上的会话没了。' +
      '服务端不给实体（实测形态是空体或 `{message}`），所以唯一能自证的手段是「旧凭据还能不能用」。' +
      '回查 200（凭据仍有效）= 未确认，文案必须说「已提交但未确认」，不许显示「已退出所有设备」。',
    probe: 'GET /api/v1/user/profile（同一个 JWT）',
  },
  {
    point: 'unbindProvider',
    endpoint: 'DELETE /api/v1/user/account-bindings/:provider',
    criterion: '回查 GET /user/profile 里 `identities[provider].bound === false`',
    why:
      '解绑不生效意味着账号仍挂着一个第三方登录入口（别人还能用那个身份进来）。' +
      '2xx 只说明「服务端收下了请求」；`identities` 是服务端自述的真相，所以只认它。' +
      '`bound` 字段整个缺失 = 不知道（不是「已解绑」），照旧判未确认。',
    probe: 'GET /api/v1/user/profile',
  },
  {
    point: 'updateKey',
    endpoint: 'PUT /api/v1/keys/:id',
    criterion:
      '回查 GET /api/v1/keys/:id，请求里带的每个可验证字段都与实体一致（name / group_id / status / quota / ip_* / expires_at）',
    why:
      '2xx + 空体时界面会显示新值而服务端还是旧值（改额度改错了会直接错算钱）。' +
      '`reset_quota` 是**命令**不是状态（不可验证），只带它的请求按「响应体里有实体就认」处理，见代码注释。',
    probe: 'GET /api/v1/keys/:id',
  },
  {
    point: 'deleteKey',
    endpoint: 'DELETE /api/v1/keys/:id',
    criterion: '回查 GET /api/v1/keys/:id 回 404 → 真的没了；回 200（实体还在）→ 反证，判未生效',
    why:
      '有额度 / 计费含义：列表里消失了但服务端那把 Key 还活着，就等于「用户以为吊销了、实际还能继续烧额度」。' +
      'DELETE 实测只回 `{code:0,data:{message}}`（没有实体），所以只能回查。',
    probe: 'GET /api/v1/keys/:id',
  },
  {
    point: 'sendBindEmailCode',
    endpoint: 'POST /api/v1/user/account-bindings/email/send-code',
    criterion: '响应体带受理证据（`expires_in` / `resend_after` / `retry_after`）时按证据确认',
    why:
      '**例外（允许只信 2xx）**：服务端没有「这个邮箱有没有收到码」的查询端点（profile 里没有待发验证码），' +
      '回查无从谈起；且重发本身无副作用（只是再发一封邮件，服务端 5/min 频控兜底，429 还带 `retry_after`）。' +
      '所以这里不发明假回查，而是靠「频控 + 用户没收到就再发」自洽。',
    exception: true,
  },
  {
    point: 'sendVerifyCode',
    endpoint: 'POST /api/v1/auth/send-verify-code',
    criterion: '响应体带受理证据（`expires_in` / `resend_after` / `retry_after`）时按证据确认',
    why:
      '**例外（允许只信 2xx）**：与 `sendBindEmailCode` 同形（纯通知类，无实体、无可回查状态、重发无副作用，' +
      '服务端 5/min 频控 + 429 `retry_after` 即受理证据）。',
    exception: true,
  },
  {
    point: 'forgotPassword',
    endpoint: 'POST /api/v1/auth/forgot-password',
    criterion: '响应体带受理证据（`expires_in` / `resend_after` / `retry_after`）时按证据确认',
    why:
      '**例外（允许只信 2xx）**：纯通知类（发一封重置邮件），匿名接口、无会话可回查，也不该回查' +
      '（否则等于给「这个邮箱存不存在」提供了客户端侧探测手段，服务端刻意不区分）。重发无副作用。',
    exception: true,
  },
  {
    point: 'resetPassword',
    endpoint: 'POST /api/v1/auth/reset-password',
    criterion: '响应体带受理证据（`expires_in` / `resend_after` / `retry_after`）时按证据确认',
    why:
      '**例外（允许只信 2xx）**：匿名流程（`token` / `code`），**没有会话**可回查（`GET /user/profile` 打不了），' +
      '接口也不回实体。真正的确认只能是「用新密码登录一次」，那是登录流程的事，不是本接口能拿到的证据。' +
      '所以只信 2xx，但界面**必须**写「重置请求已提交，请用新密码登录验证」，不许写「密码已改」。',
    exception: true,
  },
]

/** 按符号名查一条策略（drift 用例与排查用；找不到返回 `undefined`，不抛错） */
export const effectPolicyOf = (point: string): ConsumeEffectPolicy | undefined =>
  CONSUME_EFFECT_POLICIES.find((item) => item.point === point)
