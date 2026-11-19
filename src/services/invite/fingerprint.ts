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
// **服务端现状（2026-11 实测，证据贴在本 Issue 里）：不认识这个头。**
//   - 响应头 / `OPTIONS` 的允许头清单只有 `Content-Type, X-Device-Id`，没有 `X-Device-Fp`；
//   - 同一枚指纹连换 3 个全新 device_id，照样 201 + 各 100 分，响应里没有任何回显字段；
//   - 把 `device_fp` 塞进 JSON body 同样被无视；
//   - 同一 device_id 重复 /apply 是 200 幂等 —— 服务端的身份键**只有 device_id**。
// 所以本文件交付的是「客户端能力就绪」，不是「漏洞已堵」。止血仍缺服务端那一半。

/** 上报用的头名。服务端目前忽略它（见文件头），改服务端契约时只改这里。 */
export const DEVICE_FP_HEADER = 'X-Device-Fp'

/** 指纹形状：64 位小写十六进制（sha256 的十六进制写法）。 */
export const DEVICE_FP_PATTERN = /^[0-9a-f]{64}$/

/**
 * 「没有指纹」的原因。**只描述环境，不含任何标识内容**，因此可以安全地进诊断日志。
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

/** 指纹拿到的强度：base = 只有 ANDROID_ID；strong = 另外 MediaDrm 也拿得到设备级 ID。 */
export type FingerprintStrength = 'base' | 'strong'

export type DeviceFingerprint =
  | { available: true; fp: string; strength: FingerprintStrength }
  | { available: false; reason: NoFingerprintReason }

const REASONS: ReadonlySet<string> = new Set<NoFingerprintReason>([
  'not-native',
  'plugin-unavailable',
  'android_id_missing',
  'android_id_placeholder',
  'hash_failed',
  'invalid-shape',
])

/**
 * 规范化一枚指纹：去空白、转小写，形状不对就当没有（返回 `''`）。
 *
 * 这一步是「明文绝不外发」的第二道闸：万一上游把 ANDROID_ID 明文当指纹传进来，
 * 它不是 64 位十六进制，会被这里丢掉，不会出现在请求头里。
 */
export const normalizeDeviceFp = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  const fp = value.trim().toLowerCase()
  return DEVICE_FP_PATTERN.test(fp) ? fp : ''
}

/** 是不是一枚合法指纹。 */
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
    return { available: false, reason: 'invalid-shape' }
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
 * 界面 / 流程直接用这个：拿到指纹就返回哈希，拿不到返回 `''`。
 * **绝不抛异常，也绝不因为拿不到而返回错误** —— 调用方照常发请求即可。
 */
export const resolveDeviceFp = async (read: FingerprintReader = readFromNative): Promise<string> => {
  const result = await readDeviceFingerprint(read)
  return result.available ? result.fp : ''
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
