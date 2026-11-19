/**
 * 脱敏与文本截断：**纯函数，零依赖**（不 import idb / Capacitor / 业务代码）。
 *
 * 单独成文件的原因：错误页（`src/app/errorReport.ts`）也要用同一套脱敏规则把
 * 错误信息复制给用户，而采集层 collector 带着 IndexedDB / Capacitor 依赖，
 * 不该被一个纯文本工具倒拖进来（也让这套规则可以被零依赖单测直接覆盖）。
 *
 * 两条维度（#387 补齐第二条）：
 * 1. **键维度**（`fields.ts` 的 `SECRET_SEGMENTS`）：键名像密钥就整条丢弃 —— 只对结构化 meta 有效；
 * 2. **值维度**（本文件的 `REDACTION_RULES` + `SENSITIVE_VALUE_RULES`）：自由文本里的密钥、
 *    设备码、卡密、卡号、订单号、手机号 —— 日志正文、导出文件、错误页里出现的都是这一类。
 *    以前只有第 1 条，「值写在正文里」就完全没人管（#387 的 15 格红就是这么来的）。
 */

/** 敏感值类别（值维度能认出来的三种「有固定形状」的账号 / 资损字段） */
export type SensitiveKind = 'deviceId' | 'card' | 'phone'

/**
 * 尾号保留口径：与 `src/services/ours/mask.ts` 的 `maskTail` **完全一致**（四个实心点 + 尾 N 位）。
 *
 * 为什么抄两行而不 import 那一份：本文件是**零依赖**纯模块（采集层 / 错误页 / `scripts/check-redact.mjs`
 * 门禁都直接加载它，不经过 `.js → .ts` 解析钩子），而 `ours/mask.ts` 的说明符是 `.js`，
 * 裸 node 加载 redact.ts 时会解析不到。口径一致性由
 * `tests/unit/domain08-redact-negative.test.mjs` 直接对比两边的输出钉住（不一致就是红）。
 */
const maskTail = (value: string, tail = 4): string =>
  value.length <= tail ? '••••' : `••••${value.slice(-tail)}`

/** 导出边界的呈现形态：不留尾号，只留「这是什么类别」（导出文件会被贴进工单） */
export const SENSITIVE_MARKS: Record<SensitiveKind, string> = {
  deviceId: '[DEVICE_ID]',
  card: '[CARD]',
  phone: '[PHONE]',
}

type RedactionRule = {
  pattern: RegExp
  replacement: string
}

/**
 * 「键=值」形态的密钥规则：值整段打成 `***`。
 *
 * 顺序有意义：`order_token=` 必须排在 `token=` 之前 —— 后者带 `\b`，理论上不会吃到
 * `order_token=` 里的 `token`（`_` 是词内字符），但排前面能避免以后有人把 `\b` 去掉时静默漏掉。
 */
const REDACTION_RULES: RedactionRule[] = [
  // API Key（DeepSeek / OpenAI 风格）
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-***' },
  // Authorization: Bearer xxx
  { pattern: /Bearer\s+\S+/g, replacement: 'Bearer ***' },
  // 对象存储 / 网盘的签名参数
  { pattern: /Signature=[^&]*/g, replacement: 'Signature=***' },
  { pattern: /AccessKeyId=[^&]*/g, replacement: 'AccessKeyId=***' },
  // 订单 token / 商户单号（#387）：值等同于「可调起支付的凭证」，与 `token=` 同级整段打码
  { pattern: /\border_token=[^\s&]*/g, replacement: 'order_token=***' },
  { pattern: /\bout_trade_no=[^\s&]*/g, replacement: 'out_trade_no=***' },
  // token 可能出现在 query（?token= / &token=）也可能直接写在日志文本里（access token=xxx）
  { pattern: /\btoken=[^&\s]*/g, replacement: 'token=***' },
]

/**
 * 值形状规则（#387）：三段都写成「前置边界 + 值」两个捕获组。
 *
 * 为什么必须带前置边界组：这四类都是**纯数字 / 纯字母数字**，没有前缀可依赖。
 * 只写 `1[3-9]\d{9}` 会把 13 位毫秒时间戳 `1732051200000` 的**前 11 位**当成手机号打掉
 * （剩一个 `00` 尾巴），日志里的时间戳就全废了 —— 这正是 #387 要求写负例的那类误伤。
 * 前置边界被一起吃掉（否则 `phone=138…` 里的 `=` 会漏掉一个），replacement 里原样放回。
 *
 * `accept`：形状像但**语义不算**的放行（目前只有卡号的 BIN / Luhn 判定）。
 */
type SensitiveValueRule = {
  kind: SensitiveKind
  pattern: RegExp
  accept?: (value: string) => boolean
}

/** 卡组织首码：2（MasterCard 2 系）/ 3（Amex・JCB・Diners）/ 4（Visa）/ 5（MasterCard）/ 6（UnionPay・Discover） */
const CARD_BIN = /^[2-6]/

/** Luhn 校验（银行卡号的国际通行自校验）：拿到任意 BIN 的真卡也能认出来 */
const luhnOk = (digits: string): boolean => {
  let sum = 0
  let doubled = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48
    if (doubled) {
      digit *= 2
      if (digit > 9) {
        digit -= 9
      }
    }
    sum += digit
    doubled = !doubled
  }
  return sum % 10 === 0
}

/**
 * 16–19 位纯数字里，哪些才算**卡号**：
 *   - 首码落在卡组织 BIN（2–6）→ 算；
 *   - 或者 Luhn 校验通过（任意 BIN 的真卡）→ 算；
 *   - 其余（1 / 7 / 8 / 9 / 0 开头的长数字）**不打码** —— 那是纳秒时间戳、雪花 ID、
 *     订单流水号这类东西，打掉只会让日志没法对齐（#387 的「19 位但非卡号」负例）。
 *
 * 口径的取舍：宁可放过「形状像卡号但不是」的极少数，也不要误伤日志里的时间与 ID；
 * 反过来，真卡号的形状由 BIN + Luhn 两道保证，漏不掉。
 */
const isCardNumber = (digits: string): boolean => CARD_BIN.test(digits) || luhnOk(digits)

const SENSITIVE_VALUE_RULES: SensitiveValueRule[] = [
  // 设备码：`d-` + 32 位 hex（与 `ours/mask.ts` 的 maskDeviceId 同口径，只留尾 4 位）
  { kind: 'deviceId', pattern: /(^|[^0-9A-Za-z-])(d-[0-9a-f]{32})(?![0-9A-Za-z-])/gi },
  // 卡密：4 组 4 位大写字母数字，横杠分隔（`MUSE-3CYP-5NA3-AHSE-A3SR`）
  { kind: 'card', pattern: /(^|[^0-9A-Za-z-])([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3,4})(?![0-9A-Za-z-])/g },
  // 卡号：16–19 位连续数字（前后不许再挨着数字或小数点，否则那是一个更长的数）
  {
    kind: 'card',
    pattern: /(^|[^0-9.])([0-9]{16,19})(?![0-9.])/g,
    accept: isCardNumber,
  },
  // 手机号：11 位大陆号（`1[3-9]` 开头），两侧不许挨着别的数字
  { kind: 'phone', pattern: /(^|[^0-9])(1[3-9][0-9]{9})(?![0-9])/g },
]

/**
 * 把自由文本里的敏感**值**按 `render` 指定的形态替换掉。
 * 日志 / 错误页传「留尾 4 位」，导出传「类别标记」—— 同一份模式，只换呈现。
 */
const replaceSensitiveValues = (
  text: string,
  render: (kind: SensitiveKind, value: string) => string
): string =>
  SENSITIVE_VALUE_RULES.reduce(
    (out, rule) =>
      out.replace(rule.pattern, (match: string, lead: string, value: string) => {
        const accepted = rule.accept ? rule.accept(value) : true
        return accepted ? `${lead}${render(rule.kind, value)}` : match
      }),
    text
  )

/** 把一段文本里可能出现的密钥 / 签名 / 设备码 / 卡密 / 卡号 / 订单号 / 手机号统一脱敏 */
export const redact = (text: string): string => {
  const withoutSecrets = REDACTION_RULES.reduce(
    (out, rule) => out.replace(rule.pattern, rule.replacement),
    text
  )
  // 日志与错误页口径：账号 / 资损字段**留尾 4 位**（与 maskCard / maskDeviceId 一致）
  return replaceSensitiveValues(withoutSecrets, (_kind, value) => maskTail(value, 4))
}

/**
 * 导出边界的值维度脱敏（#387）：**不留尾号**，只留类别标记（`[DEVICE_ID]` / `[CARD]` / `[PHONE]`）。
 *
 * 为什么导出比日志更狠：导出文件是用户自己下载、会贴进工单与聊天窗口的，尾 4 位也能和其他
 * 渠道拼回去；类别标记足以让排查知道「这里原本是设备码」。
 */
export const markSensitiveValues = (text: string): string =>
  replaceSensitiveValues(text, (kind) => SENSITIVE_MARKS[kind])

/**
 * URL 脱敏：只保留 path，query / hash / host 全部丢掉（签名参数、token 都在 query 里）。
 * 解析失败时退化成「去 query 后再过一遍脱敏规则」。
 */
export const redactUrl = (value: string): string => {
  try {
    const url = new URL(value, 'http://redacted.local')
    return redact(url.pathname) || '/'
  } catch {
    return redact(value.split(/[?#]/)[0] ?? value) || '/'
  }
}

export const truncate = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, limit) : text

/** 任意值转字符串：错误对象取 message，其余尽量 JSON，最后兜底 String() */
export const safeString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return value.message || value.name
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
