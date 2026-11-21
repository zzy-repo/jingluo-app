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
import type { Sub2ApiError } from './errors.js'
import { emptyRawResponse, type ConsumeCallResult, type ConsumeEmpty, type ConsumeHttp } from './http.js'

/**
 * 绑定邮箱的验证码（JWT）。
 * 返回体是空 / `{message}`，这里不猜字段，`pending: true` 表示「已发出，去查收」。
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
 */
export const unbindProvider = (http: ConsumeHttp, provider: string): Promise<ConsumeCallResult<ConsumeUser>> => {
  const name = provider.trim()
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    return Promise.resolve({
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
    })
  }
  return http
    .call<unknown>({ method: 'DELETE', path: `/api/v1/user/account-bindings/${name}`, timeout: 'write' })
    .then((result) => (result.ok ? { ...result, data: toConsumeUser(result.data) } : result))
}
