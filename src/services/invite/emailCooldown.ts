/**
 * 发验证码按钮的**逐秒倒计时**（Issue #421 第 4 点 / 验收 D3）。
 *
 * 为什么单独一个纯函数文件：倒计时最容易写成「一秒钟减一」的副作用堆在组件里，
 * 结果既没法断言（要真等 60 秒）、又在后台标签页被节流时越走越慢。
 * 这里只做两件事 —— **把服务端给的秒数变成一个截止时刻**、**按当前时刻算还剩几秒**：
 * 组件只负责每秒 tick 一次（`setInterval`）并渲染结果，剩下的都是可单测的纯函数。
 *
 * 口径（谁说了算）：
 *  - `resend_after`（发码成功后）/ `retry_after`（429 频控）都是**服务端**给的秒数，原样用，
 *    客户端不自己算窗口（#421：频控由服务端判定）；
 *  - 服务端一个字都没回（老部署 / 异常）→ 不倒计时，按钮维持原样（不假装有频控）；
 *  - 秒数超过 {@link EMAIL_COOLDOWN_MAX_SECONDS}（小时级限流，例如 `retry_after: 3600`）
 *    → 不做秒级倒计时，界面给「稍后再试」的静态文案（#421 验收：小时级限流显示「稍后再试」，
 *    一小时的秒级数字对用户没有意义）。
 */

/** 超过这个秒数就不再逐秒倒计时（小时级限流交给静态文案） */
export const EMAIL_COOLDOWN_MAX_SECONDS = 300

/** 倒计时精度：就是 1 秒（验收要求「逐秒递减」） */
export const EMAIL_COOLDOWN_TICK_MS = 1000

export type EmailCooldown = {
  /** 截止时刻（epoch ms）：tick 时只比较这个，不累加，所以后台节流也不会走慢 */
  untilMs: number
  /** 起始总秒数（界面要显示「还剩 N 秒」时用得上，也方便断言） */
  totalSeconds: number
}

/**
 * 从服务端给的秒数起一个倒计时。
 *
 * 返回 null 的三种情况**都是「不倒计时」**，语义一致但原因不同：
 *  - 没给（null / undefined）= 服务端没说多久能再发；
 *  - 不是正数（0 / 负数 / NaN）= 服务端说现在就还能发；
 *  - 超过 {@link EMAIL_COOLDOWN_MAX_SECONDS} = 小时级限流，改用静态「稍后再试」。
 */
export const startEmailCooldown = (
  seconds: number | null | undefined,
  nowMs: number
): EmailCooldown | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  if (seconds > EMAIL_COOLDOWN_MAX_SECONDS) {
    return null
  }
  const total = Math.ceil(seconds)
  return { untilMs: nowMs + total * EMAIL_COOLDOWN_TICK_MS, totalSeconds: total }
}

/**
 * 还剩几秒（向上取整，0 = 已经能再发）。
 *
 * 用 ceil 而不是 floor：`resend_after: 60` 的瞬间必须显示 60（而不是 59），
 * 59.2 秒时显示 60 也符合「还要等一会儿」的直觉；归零才是真的能点。
 */
export const emailCooldownRemaining = (
  cooldown: EmailCooldown | null,
  nowMs: number
): number => {
  if (cooldown === null) {
    return 0
  }
  const leftMs = cooldown.untilMs - nowMs
  if (leftMs <= 0) {
    return 0
  }
  return Math.ceil(leftMs / EMAIL_COOLDOWN_TICK_MS)
}
