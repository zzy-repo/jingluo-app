/**
 * 老账号线索的**采集**（Issue #498 §二 前三项 / §六 第 3 条）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 这一层只有一条纪律：**能拿到多少算多少，任何一步失败都不许抛**。
 * 迁移是登录之后顺带做的事，采集失败顶多是「少一条线索 → 服务端回 need_manual」，
 * 绝不允许把用户挡在登录外面（#498 §六 第 3 条）。所以每个槽位单独 try/catch，
 * 读不到就省掉那个字段，`JSON.stringify` 时自然不出现（服务端也按可选处理）。
 *
 * 三个槽位为什么自己读 localStorage，而不 import 那些业务模块：
 *   - `chat-demo:api-key` 的所有者是 `services/api/apiConfig.ts` 的 `CONFIG_KEYS.apiKey`，
 *     但那个模块顶层读 `__API_ORIGIN__` 并挂着 zustand store —— 为了读一个字符串把它拉进
 *     这条**将来要整目录删掉**的临时债里，得不偿失（也会让 `node --test` 直接 import 本文件时
 *     多一个未注入的全局）。槽位名在这一行注释里点明来源，改那边命名时看这里。
 *   - 设备码复用 `services/invite/device.ts` 的常量 / 校验 / 只读存储适配器（它没有顶层副作用，
 *     读失败也已经是「当没有」的语义，与这里的要求一致）。
 *   - 指纹的形状校验复用 `services/invite/fingerprint.ts` 的 `DEVICE_FP_PATTERN`（同样纯函数，
 *     没有顶层副作用），但**指纹本身在本仓库是每次现算的**（原生插件 + `resolveDeviceFp()`），
 *     并不落盘；所以这里只认「曾经写进缓存位的那一份」，没有就省略 —— 绝不拿常量 / 全零 /
 *     占位值冒充指纹（#395 的事故就是这么来的）。
 */

import { DEVICE_FP_PATTERN } from '../../services/invite/fingerprint.js'
import { isDeviceId, localStorageDeviceIdStorage } from '../../services/invite/device.js'
import type { LegacyIdentity } from './types.js'

/** 旧 Key 的槽位（所有者：`services/api/apiConfig.ts` 的 `CONFIG_KEYS.apiKey`） */
const LEGACY_API_KEY_SLOT = 'chat-demo:api-key'

/**
 * 设备指纹的**缓存位**（约定的写入方是接线点，见 ./README.md「指纹怎么带」）。
 * 当前仓库没有任何写入方 —— 这一项因此通常是 `undefined`，属于设计内的正常结果。
 */
const LEGACY_DEVICE_FP_SLOT = 'chat-demo:ours-device-fp'

/** 读一个 localStorage 槽位；隐私模式 / 配额 / 非浏览器环境一律当没有（不抛、不写日志） */
const readSlot = (key: string): string => {
  try {
    return (localStorage.getItem(key) ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * 设备码：只认形状合法的存量值（`isDeviceId` 与老服务端同一套字符集 / 长度约束）。
 * 槽位名（`DEVICE_ID_STORAGE_KEY` = `chat-demo:ours-device-id`）由那个适配器持有，这里不重抄；
 * 而且**只读不建**：`ensureDeviceId()` 会在缺失时新建并落盘，那是「造一个老账号」，
 * 采集阶段绝不能做（迁移只认真的存在过的东西）。
 */
const collectDeviceId = (): string | undefined => {
  try {
    const stored = (localStorageDeviceIdStorage().read() ?? '').trim()
    return isDeviceId(stored) ? stored : undefined
  } catch {
    return undefined
  }
}

/** 指纹：只认 64 位小写十六进制的缓存值；形状不对（全零 / 常量 / 手工改过）当没有 */
const collectDeviceFp = (): string | undefined => {
  const stored = readSlot(LEGACY_DEVICE_FP_SLOT)
  return DEVICE_FP_PATTERN.test(stored) ? stored : undefined
}

/**
 * 收集这台设备上还留着的老账号线索。
 *
 * 返回对象里**只出现真的读到的字段**（缺的键完全不出现），调用方直接拿去当请求体用。
 * 注意 `oldApiKey` 是明文凭据：调用方只许把它放进请求体，不许打印 / 上报 / 渲染
 * （见 ./README.md「安全红线」与 claim.ts 的禁令注释）。
 */
export const collectLegacyIdentity = (): LegacyIdentity => {
  const identity: LegacyIdentity = {}

  const oldApiKey = readSlot(LEGACY_API_KEY_SLOT)
  if (oldApiKey !== '') {
    identity.oldApiKey = oldApiKey
  }

  const deviceId = collectDeviceId()
  if (deviceId !== undefined) {
    identity.deviceId = deviceId
  }

  const deviceFp = collectDeviceFp()
  if (deviceFp !== undefined) {
    identity.deviceFp = deviceFp
  }

  return identity
}

/** 三个字段全空 = 这台设备没有任何可识别的老账号痕迹（`claim.ts` 据此直接返回 `no_legacy`） */
export const isIdentityEmpty = (identity: LegacyIdentity): boolean =>
  identity.oldApiKey === undefined && identity.deviceId === undefined && identity.deviceFp === undefined
