/**
 * 原生插件能力探测（客户端基础设施规范 §3）：不只看平台，五步逐层判定。
 *
 *   1. 宿主是不是原生壳          `isNative()`                         → not-native
 *   2. 插件注册了没有            `hasPlugin(name)`                    → plugin-unregistered
 *   3. 需要的方法在不在          插件的 `capabilities()` 方法清单     → method-missing
 *   4. 必要权限                  插件有 `checkPermissions` 才调       → permission-denied
 *   5. 运行时可用（轻量 ping）   例如私有目录可写                     → runtime-failed
 *
 * 缓存：只有**结论性**的（not-native / plugin-unregistered）按插件名缓存；
 * runtime-failed、permission-denied、method-missing 与成功都不缓存 —— 瞬时失败不能把一个
 * 本来能用的宿主钉成「永远不可用」（磁盘一时写不进去、用户稍后授权，都要能自己恢复）。
 *
 * 本文件**不 import `@capacitor/*`**：桥对象（`registerPlugin` 的返回值）由各模块的
 * `native/` Adapter 构造后经 `opts.bridge` 传进来；平台与注册表的判断复用 `utils/capabilities.ts`。
 */
import { hasPlugin, isNative } from '../../utils/capabilities.js'
import { InfraError } from './errors.js'

export type ProbeReason =
  | 'not-native'
  | 'plugin-unregistered'
  | 'method-missing'
  | 'permission-denied'
  | 'runtime-failed'

export type ProbeResult = { available: true } | { available: false; reason: ProbeReason; detail?: string }

/** 探测用到的桥面：全部可选，插件没有就跳过对应步骤（`capabilities` 除外，见下） */
export interface ProbeBridge {
  capabilities?: () => Promise<{ methods?: unknown }>
  checkPermissions?: () => Promise<Record<string, unknown>>
}

export type ProbeOptions = {
  bridge?: ProbeBridge
  /** 必须出现在 `capabilities().methods` 里的方法名；非空时桥必须提供 `capabilities()` */
  methods?: readonly string[]
  /** 轻量运行时探针；抛错 → runtime-failed */
  ping?: () => Promise<unknown>
}

const conclusive = new Map<string, ProbeResult>()

/** 仅测试用：清空结论缓存 */
export const resetProbeCache = (): void => {
  conclusive.clear()
}

const detailOf = (error: unknown): string => {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined
  return typeof message === 'string' && message.length > 0 ? message.slice(0, 200) : String(error).slice(0, 200)
}

/** 同步部分（第 1、2 步）：不碰插件，供 `supported` 这类同步属性使用。结论性结果走缓存。 */
export const probeStatic = (name: string): ProbeResult => {
  const hit = conclusive.get(name)
  if (hit) {
    return hit
  }
  if (!isNative()) {
    const result: ProbeResult = { available: false, reason: 'not-native' }
    conclusive.set(name, result)
    return result
  }
  if (!hasPlugin(name)) {
    const result: ProbeResult = { available: false, reason: 'plugin-unregistered' }
    conclusive.set(name, result)
    return result
  }
  return { available: true }
}

export const probeNativePlugin = async (name: string, options: ProbeOptions = {}): Promise<ProbeResult> => {
  const staticResult = probeStatic(name)
  if (!staticResult.available) {
    return staticResult
  }
  const { bridge, methods = [], ping } = options

  if (methods.length > 0) {
    if (!bridge || typeof bridge.capabilities !== 'function') {
      return { available: false, reason: 'method-missing', detail: 'capabilities() not provided' }
    }
    let listed: unknown
    try {
      listed = (await bridge.capabilities()).methods
    } catch (error) {
      return { available: false, reason: 'method-missing', detail: `capabilities() failed: ${detailOf(error)}` }
    }
    const have = Array.isArray(listed) ? (listed as unknown[]) : []
    const missing = methods.filter((method) => !have.includes(method))
    if (missing.length > 0) {
      return { available: false, reason: 'method-missing', detail: missing.join(',') }
    }
  }

  if (bridge && typeof bridge.checkPermissions === 'function') {
    try {
      const permissions = await bridge.checkPermissions()
      const refused = Object.keys(permissions).filter((key) => permissions[key] !== 'granted')
      if (refused.length > 0) {
        return { available: false, reason: 'permission-denied', detail: refused.join(',') }
      }
    } catch (error) {
      return { available: false, reason: 'runtime-failed', detail: `checkPermissions() failed: ${detailOf(error)}` }
    }
  }

  if (ping) {
    try {
      await ping()
    } catch (error) {
      return { available: false, reason: 'runtime-failed', detail: detailOf(error) }
    }
  }
  return { available: true }
}

/** 探测失败 → 标准错误（`kind` 映射只在这里一份）：没这个能力 → unsupported，没权限 → permission，瞬时 → unavailable */
export const infraErrorOfProbe = (
  result: Extract<ProbeResult, { available: false }>,
  subject: string
): InfraError => {
  const suffix = result.detail ? ` (${result.detail})` : ''
  const message = `${subject}: ${result.reason}${suffix}`
  switch (result.reason) {
    case 'permission-denied':
      return new InfraError('permission', message)
    case 'runtime-failed':
      return new InfraError('unavailable', message)
    default:
      return new InfraError('unsupported', message)
  }
}
