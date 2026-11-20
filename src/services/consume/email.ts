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

import { toConsumeUser, type ConsumeUser } from './auth.js'
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

/** 提交 `{email, code}` 完成绑定：成功后回账号主体（邮箱已更新） */
export const bindEmail = (
  http: ConsumeHttp,
  input: { email: string; code: string }
): Promise<ConsumeCallResult<ConsumeUser>> =>
  http
    .call<unknown>({
      method: 'POST',
      path: '/api/v1/user/account-bindings/email',
      body: { email: input.email, code: input.code },
      timeout: 'write',
    })
    .then((result) => (result.ok ? { ...result, data: toConsumeUser(result.data) } : result))

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
