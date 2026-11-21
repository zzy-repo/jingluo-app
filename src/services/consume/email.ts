/**
 * 邮箱绑定 —— Issue #484 §3.1c，W1-A。
 *
 *   POST   /api/v1/user/account-bindings/email/send-code   JWT：绑定 / 换绑邮箱发码
 *   POST   /api/v1/user/account-bindings/email             JWT：提交 `{email, code}` 完成绑定
 *   DELETE /api/v1/user/account-bindings/:provider         JWT：解绑（`provider` 如 `email`）
 *
 * 与「注册验证码」的区别：注册走 `POST /api/v1/auth/send-verify-code`（公共，见 auth.ts），
 * 这里走的是**已登录账号**的身份绑定（`user/account-bindings/**`）。
 *
 * 频控：服务端限流，429 时按 `Retry-After` 秒数倒计时（错误对象里的 `retryAfterMs`），
 * **不要**自己另算间隔（sub2api 没有旧服务的 `resend_after` 字段，#484 §4.4）。
 *
 * 旧语义（`action: bound|login`、`choice: use_email|keep_device`、「用邮箱接管设备」）在 sub2api
 * **不存在**：它本来就是账号体系，邮箱只是账号的一个绑定项。#484 §3.2 已判定整条降级为原生登录。
 */

import { getProfile, toConsumeUser, type ConsumeUser } from './auth.js'
import { confirmEffect, probeOnce, unconfirmedEffectError } from './confirmEffect.js'
import type { Sub2ApiError } from './errors.js'
import { emptyRawResponse, type ConsumeCallResult, type ConsumeEmpty, type ConsumeHttp } from './http.js'

/**
 * 绑定邮箱的验证码（JWT）。
 * 返回体是空 / `{message}`，这里不猜字段，`pending: true` 表示「已发出，去查收」。
 *
 * 成功判据（#679 第 1 处）：**例外，只信 2xx** —— 依据见 `CONSUME_EFFECT_POLICIES.sendBindEmailCode`。
 * 服务端没有「这个邮箱有没有收到码」的查询端点（`/user/profile` 里没有待发验证码之类的状态），
 * 回查无从谈起；重发本身无副作用（只是再发一封），频控 5/min + 429 的 `retry_after` 即受理证据。
 * 所以这里不发明一次假回查；但也**不许**在文案上写得比事实更硬（没收到就再发）。
 */
export const sendBindEmailCode = (http: ConsumeHttp, email: string): Promise<ConsumeCallResult<ConsumeEmpty>> =>
  http.call<ConsumeEmpty>({
    method: 'POST',
    path: '/api/v1/user/account-bindings/email/send-code',
    body: { email },
    timeout: 'write',
  })

/**
 * **可显示的脱敏邮箱**——绑定成功的唯一证据（#660）。
 *
 * 服务端两种下发形态都认：`email_masked`（已脱敏，优先原样用）与 `email`（完整值，界面本地打码）。
 * 两个都空 = 拿不到证据：`identities.email.bound === true` **不算**，因为那正是本单的病灶
 * ——「已绑定 ****」，用户无法自证是哪个邮箱，换机也取不回账号。
 */
const confirmableEmail = (user: ConsumeUser): string => {
  const masked = user.emailMasked === undefined ? '' : user.emailMasked.trim()
  return masked !== '' ? masked : user.email.trim()
}

/**
 * 「HTTP 200 但证据不足」→ 归一化失败（**结果未知**，不是成功）。
 *
 * 回查 `/user/profile` 本身报错时（网络 / 401 / 5xx）沿用它的 `kind` / `code` / `status`：
 * 界面据此还能给出「登录已过期」这类更具体的下一步，而 `i18nKey` 仍是「结果未确认」。
 */
const unconfirmedBindError = (profile: ConsumeCallResult<ConsumeUser>): Sub2ApiError => {
  const upstream = profile.ok ? undefined : profile.error
  return {
    kind: upstream === undefined ? 'unknown' : upstream.kind,
    code: upstream === undefined ? 'BIND_UNCONFIRMED' : upstream.code,
    message:
      upstream === undefined
        ? '绑定响应 2xx 但没有脱敏邮箱；回查 /user/profile 也拿不到 email_masked'
        : upstream.message,
    status: upstream === undefined ? 200 : upstream.status,
    retryable: true,
    envelope: upstream === undefined ? 'none' : upstream.envelope,
    i18nKey: 'consumeErrBindUnconfirmed',
  }
}

/**
 * 提交 `{email, code}` 完成绑定：成功后回账号主体（邮箱已更新）。
 *
 * **成功判据不是 HTTP 200**（#660）：绑定接口 200 + 空响应体时服务端可能根本没落库，
 * 而界面已经显示「已绑定」—— 用户换机就取不回账号。所以必须拿到**可显示的脱敏邮箱**：
 *   1. 响应体里有 `email_masked`（或 `email`）→ 直接判成功，省一次请求；
 *   2. 否则**回查一次** `GET /api/v1/user/profile`，它有 → 判成功；
 *   3. 回查也没有 / 回查失败 → 判失败（`consumeErrBindUnconfirmed`），**不许**显示「已绑定」。
 *
 * 回查**只做一次**、不循环：一次失败不能放大成多次写后查询（写操作重复请求是这仓库最贵的教训）。
 */
export const bindEmail = async (
  http: ConsumeHttp,
  input: { email: string; code: string }
): Promise<ConsumeCallResult<ConsumeUser>> => {
  const result = await http.call<unknown>({
    method: 'POST',
    path: '/api/v1/user/account-bindings/email',
    body: { email: input.email, code: input.code },
    timeout: 'write',
  })
  if (!result.ok) {
    return result
  }
  const user = toConsumeUser(result.data)
  if (confirmableEmail(user) !== '') {
    return { ...result, data: user }
  }
  const profile = await getProfile(http)
  if (profile.ok && confirmableEmail(profile.data) !== '') {
    // 以回查到的账号主体为准（比空响应体多一层身份明细），但状态码 / 原始体仍留绑定这一次的
    return { ok: true, data: profile.data, status: result.status, raw: result.raw }
  }
  return { ok: false, error: unconfirmedBindError(profile), raw: result.raw }
}

/**
 * 解绑某个身份（`provider`：`email` / `linuxdo` / `github` / …）。
 *
 * `provider` 只允许**路径段**：拼进 URL 前做一次白名单校验，避免把 `../` 或查询串拼进路径。
 *
 * 成功判据（#679 第 2 处）：**2xx 不算数**。解绑不生效意味着账号上仍挂着一个第三方登录入口
 * （别人还能用那个身份进来），而 DELETE 的 2xx 只说明「服务端收下了请求」。所以：
 *   1. 响应体里就带回了账号主体，且 `identities[provider].bound === false` → 已确认（省一次请求）；
 *   2. 否则**回查一次** `GET /user/profile`，同上判据；
 *   3. 回查说 `bound === true` → 反证（没生效）；回查失败 / 字段缺失 → 未知。
 * 2/3 两种都返回 `ok: false`（`consumeErrUnbindUnconfirmed`）：界面不许显示「已解绑」。
 *
 * `bound` 字段整个缺失 = **不知道**，不是「未绑定」—— 拿「不知道」当证据是 #660 记下的那类错。
 */
export const unbindProvider = async (http: ConsumeHttp, provider: string): Promise<ConsumeCallResult<ConsumeUser>> => {
  const name = provider.trim()
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    return {
      ok: false,
      error: {
        kind: 'bad_request',
        code: 'BAD_PROVIDER',
        message: `绑定项名称不合法：${provider}`,
        status: 0,
        retryable: false,
        envelope: 'none',
        i18nKey: 'consumeErrBadRequest',
      },
      raw: emptyRawResponse(),
    }
  }
  const result = await http.call<unknown>({ method: 'DELETE', path: `/api/v1/user/account-bindings/${name}`, timeout: 'write' })
  if (!result.ok) {
    return result
  }
  /** 账号主体里这个 provider 是否**明确**未绑定（`undefined` = 服务端没说，不算证据） */
  const unbound = (value: unknown): ConsumeUser | undefined => {
    const user = toConsumeUser(value)
    return user.identities?.[name]?.bound === false ? user : undefined
  }
  const stillBound = (value: unknown): boolean => toConsumeUser(value).identities?.[name]?.bound === true
  const outcome = await confirmEffect<ConsumeUser>({
    response: { data: result.data, raw: result.raw },
    accept: unbound,
    probe: probeOnce(() => getProfile(http), unbound, stillBound),
  })
  if (outcome.confirmed) {
    return { ok: true, data: outcome.value, status: result.status, raw: result.raw }
  }
  return {
    ok: false,
    error: unconfirmedEffectError({
      i18nKey: 'consumeErrUnbindUnconfirmed',
      code: 'UNBIND_UNCONFIRMED',
      message:
        outcome.reason === 'probe-negative'
          ? `解绑接口回了 2xx，但回查 /user/profile 里 identities.${name}.bound 仍是 true：解绑没有生效`
          : `解绑接口回了 2xx，但没能确认 identities.${name}.bound 已变成 false`,
      status: result.status,
      outcome,
    }),
    raw: result.raw,
  }
}
