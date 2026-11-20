// 设备指纹：客户端这一半（Issue #243）。
//
// 背景 —— `POST /apply` 按 device_id 送 100 积分（≈¥1，立刻能花），而 device_id 是客户端
// 自己生成、存在 localStorage 里的一个字符串（见 services/invite/device.ts）。清应用数据 /
// 改 localStorage / 脚本随机值，都能无限领。真正的止血在服务端：按「指纹 ∪ IP」双维度限流 +
// 历史数据迁移绑定。客户端唯一能做、也只该做的是：**如实上报一个用户改不动的设备指纹**。
//
// 六条纪律（#243 的 1–6 条，逐条对应）：
//   1. 只读 `Settings.Secure.ANDROID_ID`（原生侧 DeviceFingerprintPlugin.deviceFingerprint），
//      MediaDrm 仅当可选增强位；不碰 IMEI / 序列号（既非必要，也拿不到）。
//   2. 先哈希再出去：原生侧算 `sha256(ANDROID_ID + 包名)`，只把 64 位十六进制交过来；
//      明文标识根本不过 JS，也就不可能进日志 / 诊断上传 / 错误文案。
//   3. 挂在 `POST /apply` 与 `GET /me` 上，头名 `X-Device-Fp`。
//   4. **只上报，不判定。** 这里没有任何「这台机器领过了」的逻辑：判「新人」是服务端的事。
//   5. 拿不到指纹就**照常注册**（绝不阻塞），只留一条可诊断的「无指纹」信号
//      （{@link describeFingerprintSignal}）。
//   6. 指纹不进日志 / 诊断上传 / 错误文案；对外最多露哈希前 8 位（{@link fpPrefix}）。
//
// **服务端现状（2026-11-19 复测，证据贴在本 Issue 里）：**
//   - 2026-11 上旬：`OPTIONS` 的允许头清单只有 `Content-Type, X-Device-Id`，本头被无视；
//     同一枚指纹连换 3 个全新 device_id，照样 201 + 各 100 分。
//   - 2026-11-19 复测（#261）：`OPTIONS /apply` 的允许头里已经有 `X-Device-Fp`（本次自测）；
//     同一枚指纹换 device_id 不再发第二份 100 分（#261 记录的实测矩阵，本文件不重复抄）。
//     但「认出指纹之后给哪个账号」仍需服务端修 —— 见 #264：应返回原账号 200，
//     而不是静默新建一个 0 额度账号。
//   - 同一 device_id 重复 /apply 是 200 幂等（这一点始终没变）。
// 客户端这一半（本文件）因此仍是「只上报、不判定」：结论只从响应字段读（见 api.ts 的 classifyClaim）。
//
// **Issue #395（全零 / 常量指纹被当成有效身份）：形状合法 ≠ 可信。**
//   线上现象：多台毫无关系的设备写着同一个 device_id、共用一把 Key 与余额。根因不是碰撞，
//   而是客户端上报了一枚**常量**指纹（模拟器 / 部分 ROM / 指纹读取失败后的兜底），服务端把它
//   当「这台机器」的唯一身份 → 第一台注册后，其后每一台都命中「指纹还原原账号」分支，拿到同一个账号。
//   本文件因此把「形状校验」升级成「形状 + 内容校验」：
//     · 全相同字符（`0`×64 / `f`×64 …）  —— 见 {@link isConstantDeviceFp}
//     · 已知常量摘要（空 ANDROID_ID / 老设备常量 ANDROID_ID 的固定哈希）—— 见 CONSTANT_DEVICE_FP_VALUES
//     命中即**当作没有指纹**：不上报任何占位值，`X-Device-Fp` 这个头干脆不出现。
//   状态语义（第 2 条）：{@link FingerprintReport} 用判别联合把「有可信指纹」与「没有可信指纹」
//     分成两种状态；线缆层同样只用「头在不在」表达，**绝不用全零/常量值代表「没有」**。
//   服务端仍需配合（本文件改不了、也不该由客户端假装解决）：收到无效/常量指纹时必须视同
//     「无指纹」降级为纯 device_id 行为，并且**不得**把多个 device_id 绑定到同一账号。

/** 上报用的头名。服务端目前忽略它（见文件头），改服务端契约时只改这里。 */
export const DEVICE_FP_HEADER = 'X-Device-Fp'

/** 指纹形状：64 位小写十六进制（sha256 的十六进制写法）。 */
export const DEVICE_FP_PATTERN = /^[0-9a-f]{64}$/

/**
 * 「没有指纹」的原因。**只描述环境，不含任何标识内容**，因此可以安全地进诊断日志。
 *
 * 单一来源（issue #276）：运行时白名单 {@link NO_FINGERPRINT_REASONS} 由下面的
 * {@link REASON_TABLE} 的键派生，而 REASON_TABLE 用 `satisfies Record<NoFingerprintReason, true>`
 * 焊在这个联合类型上 —— 两边任何一边加/减一个值，`pnpm type` 立刻红。
 * 以前类型写一份、`new Set<string>([...])` 手抄一份，漏改的表现是：诊断里那个 reason 被
 * `:118` 静默改写成 `plugin-unavailable`，排查方向直接跑偏，而且没有任何东西会报错。
 */
export type NoFingerprintReason =
  /** Web / 未打包进原生壳：浏览器里没有用户改不动的稳定标识 */
  | 'not-native'
  /** 原生插件没注册（旧壳子没这个版本）或调用抛错 */
  | 'plugin-unavailable'
  /** 系统没给 ANDROID_ID */
  | 'android_id_missing'
  /** ANDROID_ID 是老设备上那个人人相同的常量 */
  | 'android_id_placeholder'
  /** 原生侧哈希失败 */
  | 'hash_failed'
  /** 原生回来的东西不是 64 位十六进制：宁可不报，也不乱报 */
  | 'invalid-shape'
  /** 形状对但值是常量（全零 / 全 F / 空 ANDROID_ID 的固定哈希）：看着像身份，其实所有设备都一样（#395） */
  | 'constant_fp'

/** 指纹拿到的强度：base = 只有 ANDROID_ID；strong = 另外 MediaDrm 也拿得到设备级 ID。 */
export type FingerprintStrength = 'base' | 'strong'

export type DeviceFingerprint =
  | { available: true; fp: string; strength: FingerprintStrength }
  | { available: false; reason: NoFingerprintReason }

/**
 * 运行时白名单的**唯一一份**。键集由 `satisfies` 焊在 {@link NoFingerprintReason} 上：
 * 类型里加一个值而这里漏加 → 少一个必需键，类型检查红；这里多写一个 → 对象字面量的
 * 多余属性检查红。所以「两份列表」不存在，也就不可能漂移。
 */
const REASON_TABLE = {
  'not-native': true,
  'plugin-unavailable': true,
  'android_id_missing': true,
  'android_id_placeholder': true,
  'hash_failed': true,
  'invalid-shape': true,
  'constant_fp': true,
} satisfies Record<NoFingerprintReason, true>

/** 全部「无指纹」原因（顺序即上表顺序，可直接用于诊断页/DTO 枚举）。 */
export const NO_FINGERPRINT_REASONS: readonly NoFingerprintReason[] = Object.keys(
  REASON_TABLE
) as readonly NoFingerprintReason[]

const REASONS: ReadonlySet<string> = new Set<string>(NO_FINGERPRINT_REASONS)

/**
 * 全相同字符（`0`×64 / `f`×64 / `a`×64 …）。
 *
 * sha256 的输出是 256 bit 伪随机数，落成「64 位全都一样」的概率是 16^-63 —— 这个形状只可能
 * 来自**兜底常量**，不可能来自真实摘要。模拟器、部分 ROM、以及「读不到就先填个默认值」的实现
 * 都会产出它（#395 的线上样本是 64 个 0）。
 */
const ALL_SAME_CHAR_PATTERN = /^([0-9a-f])\1{63}$/

/**
 * 已知常量指纹黑名单（#395）。
 *
 * 与「全相同字符」不同：这些值看起来像正常摘要，但**对所有同环境设备都相同** —— 原生侧把
 * 空 `ANDROID_ID`（等于 `sha256('' + 包名)`）或老设备那个人人相同的 `9774d56d682e549c`
 * 直接算进摘要时就是这个结果。它们同样是假身份，不能上报。
 *
 * 值由 `config/appIdentity.json` 的 `applicationId`（包名唯一来源，见 scripts/check-identity.mjs）
 * 算出；包名一改这里就失效 —— `tests/unit/invite-fp-invalid.test.mjs` 会用当前
 * applicationId 现算一遍再与本表比对，漏改立刻红，不靠人记。
 * （注释里刻意不写包名本身：`pnpm run check:identity` 把包名字面量当违规副本。）
 */
export const CONSTANT_DEVICE_FP_VALUES: readonly string[] = [
  // sha256(空 ANDROID_ID + 包名)：ANDROID_ID 读成空串时的固定摘要
  '3ec4ea9c0c4f2a1e8243ba65d25bb88a329b6091d600852a506cf241af3923c2',
  // sha256(老设备那个常量 ANDROID_ID + 包名)：人人相同
  '5e68c9f07ffafb4141e33037339c420621b45df53d3043c2cddfc6b1c6fcf5b3',
]

const CONSTANT_DEVICE_FPS: ReadonlySet<string> = new Set<string>(CONSTANT_DEVICE_FP_VALUES)

/**
 * 形状合法、但内容是「常量」的指纹：全相同字符，或命中已知常量黑名单。
 *
 * 这是 #395 判据的**唯一一份**：{@link normalizeDeviceFp} 与 {@link interpretFingerprint}
 * 都走它，杜绝「一处拦、另一处放」。形状本身就不对的返回 `false`（那是 invalid-shape 的事）。
 */
export const isConstantDeviceFp = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false
  }
  const fp = value.trim().toLowerCase()
  if (!DEVICE_FP_PATTERN.test(fp)) {
    return false
  }
  return ALL_SAME_CHAR_PATTERN.test(fp) || CONSTANT_DEVICE_FPS.has(fp)
}

/**
 * 规范化一枚指纹：去空白、转小写，**形状或内容**不对就当没有（返回 `''`）。
 *
 * 两道闸：
 *   1. 形状：不是 64 位十六进制就丢掉 —— 万一上游把 ANDROID_ID 明文当指纹传进来，
 *      它过不了这里，不会出现在请求头里；
 *   2. 内容：形状对但是常量（全零 / 全 F / 空 ANDROID_ID 的固定哈希）也丢掉 ——
 *      上报常量等于告诉服务端「这些设备是同一台」，会把无关设备串成一个账号（#395）。
 */
export const normalizeDeviceFp = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  const fp = value.trim().toLowerCase()
  if (!DEVICE_FP_PATTERN.test(fp)) {
    return ''
  }
  // 形状对、值是常量 → 当作**没有**指纹：不返回占位值，调用方就不会发出这个头
  return isConstantDeviceFp(fp) ? '' : fp
}

/** 是不是一枚**可信**指纹（形状对 + 不是常量）。 */
export const isDeviceFp = (value: unknown): boolean => normalizeDeviceFp(value) !== ''

/** 对外展示最多露哈希前 8 位（诊断 / 排障用；不合法就是空串，绝不含明文）。 */
export const fpPrefix = (value: unknown): string => normalizeDeviceFp(value).slice(0, 8)

/** 原生侧 deviceFingerprint() 的返回形状：一律当不可信数据，逐字段校验。 */
export type RawDeviceFingerprint = {
  available?: unknown
  deviceFp?: unknown
  strength?: unknown
  reason?: unknown
}

/**
 * 原生桥（只用到这一个方法）。插件名 `DeviceFingerprint` 对应
 * `android/.../DeviceFingerprintPlugin.java` —— 刻意与诊断插件 `DiagnosticsDevice` 分开：
 * 那个插件按契约不读任何标识，指纹是身份，不该混进诊断上传的口子。
 */
export type FingerprintBridge = { deviceFingerprint(): Promise<RawDeviceFingerprint> }

/** 读一次原始返回。测试注入假实现，生产用 {@link readFromNative}。 */
export type FingerprintReader = () => Promise<unknown>

/**
 * 把原生返回的解释成 {@link DeviceFingerprint}。纯函数：不碰 Capacitor、不碰日志，可单测。
 */
export const interpretFingerprint = (raw: unknown): DeviceFingerprint => {
  if (raw === null || typeof raw !== 'object') {
    return { available: false, reason: 'plugin-unavailable' }
  }
  const record = raw as RawDeviceFingerprint
  if (record.available !== true) {
    const reason = typeof record.reason === 'string' ? record.reason : ''
    return {
      available: false,
      reason: REASONS.has(reason) ? (reason as NoFingerprintReason) : 'plugin-unavailable',
    }
  }
  const fp = normalizeDeviceFp(record.deviceFp)
  if (fp === '') {
    // 「形状不对」与「形状对但是常量」必须分得开：只看 reason 才知道该去修原生读取还是修兜底逻辑
    return {
      available: false,
      reason: isConstantDeviceFp(record.deviceFp) ? 'constant_fp' : 'invalid-shape',
    }
  }
  return { available: true, fp, strength: record.strength === 'strong' ? 'strong' : 'base' }
}

/**
 * 生产实现：走原生插件。
 *
 * 动态 import 是刻意的 —— api.ts / openFlow.ts 这些纯逻辑模块会被 Node 单测直接 import，
 * 不能在模块顶层把 @capacitor/core 拖进来。
 */
const readFromNative = async (): Promise<unknown> => {
  const { Capacitor } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    // Web / iOS 没有「用户改不动的稳定标识」：直接认「无指纹」，别去退化成浏览器指纹
    return { available: false, reason: 'not-native' }
  }
  const bridge = Capacitor.registerPlugin<FingerprintBridge>('DeviceFingerprint')
  return await bridge.deviceFingerprint()
}

/** 最近一次上报结论。只存「有没有」，**绝不存指纹本身**。 */
let lastSignal: { available: boolean; reason?: NoFingerprintReason } | null = null

/** 读一次指纹，并记下「有没有指纹」这条信号。永不抛。 */
export const readDeviceFingerprint = async (
  read: FingerprintReader = readFromNative
): Promise<DeviceFingerprint> => {
  let raw: unknown = null
  try {
    raw = await read()
  } catch {
    // 旧壳子没有这个方法 / 插件崩了：都不该挡住注册，按「插件不可用」降级
    raw = null
  }
  const result = interpretFingerprint(raw)
  lastSignal = result.available
    ? { available: true }
    : { available: false, reason: result.reason }
  return result
}

/**
 * 「有没有可信指纹」的**两种状态**（#395 第 2 条）。
 *
 * 以前这两种状态只靠一个字符串表达，于是「没有」只能退化成空串、而兜底实现干脆填了全零 ——
 * 服务端看到全零就当成一枚真指纹。现在状态是判别联合：`reported: false` 带原因，
 * `reported: true` 才有一个可信值。线缆层同样只用「`X-Device-Fp` 这个头在不在」表达，
 * **绝不用占位值代表「没有」**（见 api.ts 的 withDeviceFp）。
 */
export type FingerprintReport =
  | { reported: true; fp: string }
  | { reported: false; reason: NoFingerprintReason }

/**
 * 读一次指纹并给出**带状态**的结论：要么「有可信指纹」，要么「没有 + 原因」。
 * 永不抛；拿不到就不上报，而不是上报一个假值。
 */
export const resolveDeviceFpReport = async (
  read: FingerprintReader = readFromNative
): Promise<FingerprintReport> => {
  const result = await readDeviceFingerprint(read)
  return result.available
    ? { reported: true, fp: result.fp }
    : { reported: false, reason: result.reason }
}

/**
 * 界面 / 流程直接用这个：拿到**可信**指纹就返回哈希，拿不到（含常量 / 形状不对）返回 `''`。
 * **绝不抛异常，也绝不因为拿不到而返回错误** —— 调用方照常发请求即可。
 */
export const resolveDeviceFp = async (read: FingerprintReader = readFromNative): Promise<string> => {
  const report = await resolveDeviceFpReport(read)
  return report.reported ? report.fp : ''
}

/** 最近一次「有没有指纹」的结论（未读过就是 null）。不含指纹内容。 */
export const getFingerprintSignal = (): { available: boolean; reason?: NoFingerprintReason } | null =>
  lastSignal

/**
 * 一行可诊断的「无指纹」信号，专供诊断日志 / 排障用。
 *
 * 例：`device-fp:reported` / `device-fp:none(not-native)`。
 * 只有状态与原因枚举，**没有任何标识内容**（第 6 条纪律）。
 */
export const describeFingerprintSignal = (): string => {
  if (lastSignal === null) {
    return 'device-fp:unreported'
  }
  if (lastSignal.available) {
    return 'device-fp:reported'
  }
  return `device-fp:none(${lastSignal.reason ?? 'unknown'})`
}

/** 仅供单测复位模块内信号（生产代码不调用）。 */
export const resetFingerprintSignalForTest = (): void => {
  lastSignal = null
}
