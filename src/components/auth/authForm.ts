/**
 * 登录 / 注册表单的**纯校验**（W1-B 前半，Issue #487）——没有 React、没有请求，只有判定。
 *
 * 口径（与 sub2api 的注册要求对齐，但只做本地能判的那部分）：
 *  - 邮箱：单 `@` + 有域名后缀。**不做黑名单 / 一次性邮箱判定** —— 那规则在服务端
 *    （`registration_email_suffix_whitelist` 之类），本地抄一份就是第二份真值；
 *  - 密码：只判长度下限（8 位）。服务端没有公开的强度规则，本地不自己发明一套更严的，
 *    否则「本地过不了、服务端其实接受」会变成纯拦路；
 *  - 确认密码：必须与密码完全一致（含大小写与空格，不 trim）。
 *
 * 文案：邮箱格式错误直接对上已经合并的 `sub2authEmailInvalid`（`issueMessageKey`）；
 * 密码长度 / 两次不一致**在已合并的 `sub2auth*` 里没有对应词条**，所以这里返回原因码、
 * 不拼文案 —— UI 只做「红框 + aria-invalid + 阻止提交」。
 *
 * TODO(W1-B 后半)：补两条词条（`sub2authPasswordTooShort` / `sub2authPasswordMismatch`）后，
 * 把 `issueMessageKey` 的 null 分支填上。不在本单顺手加 key：i18n 骨架是别人的单子，加字要一起过 R1/R2/R4。
 */

/** 服务端注册密码下限（sub2api 校验 8 位）；本地同口径 */
export const MIN_PASSWORD_LENGTH = 8

/** 出问题的字段 */
export type AuthField = 'email' | 'password' | 'confirmPassword' | 'verifyCode' | 'invitationCode'

/** 为什么出问题（reason 不直接上屏，上屏走 `issueMessageKey`） */
export type AuthIssueReason =
  | 'required'
  | 'email_format'
  | 'password_too_short'
  | 'password_mismatch'

export type AuthIssue = { field: AuthField; reason: AuthIssueReason }

/**
 * 邮箱格式判定。
 *
 * 刻意**宽松且无状态**：`a@b.c` 起步、整体不带空白、只有一段 `@`。
 * 不追 RFC 5322（那个正则既读不懂也拦不住真正的问题），真正的判定在服务端。
 */
export const isValidEmail = (email: string): boolean => {
  const value = email.trim()
  if (value === '' || /\s/.test(value)) {
    return false
  }
  const parts = value.split('@')
  if (parts.length !== 2) {
    return false
  }
  const [local, domain] = parts
  if (local === '' || domain === '') {
    return false
  }
  const labels = domain.split('.')
  if (labels.length < 2) {
    return false
  }
  return labels.every((label) => label !== '')
}

export type LoginValues = { email: string; password: string }

export type RegisterValues = {
  email: string
  password: string
  confirmPassword: string
  verifyCode?: string
  invitationCode?: string
}

/** 登录只需要非空 + 邮箱格式（密码长度由服务端判，本地拦下来只会让「老账号短密码」登不进去） */
export const validateLogin = (values: LoginValues): AuthIssue[] => {
  const issues: AuthIssue[] = []
  if (values.email.trim() === '') {
    issues.push({ field: 'email', reason: 'required' })
  } else if (!isValidEmail(values.email)) {
    issues.push({ field: 'email', reason: 'email_format' })
  }
  if (values.password === '') {
    issues.push({ field: 'password', reason: 'required' })
  }
  return issues
}

/**
 * 注册：邮箱格式 + 密码长度 + 两次一致。
 *
 * **不校验验证码 / 邀请码是否为空**：验证码由服务端判（填错会给 `sub2authCodeInvalid`），
 * 邀请码本来就是可选的；本地多拦一层只会让「服务端说没问题、客户端不让提交」这种情况出现。
 */
export const validateRegister = (values: RegisterValues): AuthIssue[] => {
  const issues = validateLogin({ email: values.email, password: values.password })
  if (values.password !== '' && values.password.length < MIN_PASSWORD_LENGTH) {
    issues.push({ field: 'password', reason: 'password_too_short' })
  }
  if (values.password !== values.confirmPassword) {
    issues.push({ field: 'confirmPassword', reason: 'password_mismatch' })
  }
  return issues
}

/** 本地校验结果里**唯一有现成词条**的那一类；其余返回 null（见文件头的 TODO） */
export const issueMessageKey = (issue: AuthIssue): 'sub2authEmailInvalid' | null =>
  issue.reason === 'email_format' ? 'sub2authEmailInvalid' : null
