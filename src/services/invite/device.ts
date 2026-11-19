/**
 * 设备码（device_id）：生成、校验、持久化。
 *
 * 为什么单独一个文件：
 *  - 生成与校验是纯函数（可注入随机源、可注入存储），Node 单测零浏览器就能跑；
 *  - 存储只有这一份实现，避免「某个入口读到了另一个 key」导致同一个用户算出两个账号。
 *
 * 硬性约定（产品要求 1）：
 *  - 长度 8–128，字符集 `[A-Za-z0-9._:-]`
 *  - 首次启动生成后持久化，**不因切渠道 / 改 Key / 清对话而丢失**（只在清站点数据时丢）
 *  - 「设备码丢失等于丢账号」：设置里完整可见、可复制、可备份
 *  - device_id 是账号凭据的一部分：**不进日志、不进诊断、不进错误文案**（要用只用尾 4 位）
 */

/** localStorage 的 key：和其它配置同前缀，但**不属于**渠道配置，切渠道不会动它 */
export const DEVICE_ID_STORAGE_KEY = 'chat-demo:ours-device-id'

/** 服务端约束：8–128 位，字符集 [A-Za-z0-9._:-] */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

export const isDeviceId = (value: string): boolean => DEVICE_ID_PATTERN.test(value.trim())

/** 随机字节源：默认用 WebCrypto，取不到时退回 Math.random（老 WebView 兜底） */
export type RandomBytes = (length: number) => Uint8Array

const defaultRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length)
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes)
    return bytes
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  return bytes
}

const HEX = '0123456789abcdef'

/**
 * 生成设备码：`d-` + 32 位小写十六进制（共 34 位，落在 8–128 内）。
 * 前缀 `d-` 让人一眼看出这是设备码；字符集只用 [0-9a-f]，天然满足服务端白名单。
 */
export const createDeviceId = (randomBytes: RandomBytes = defaultRandomBytes): string => {
  const bytes = randomBytes(16)
  let text = 'd-'
  for (const byte of bytes) {
    text += HEX[(byte >> 4) & 0xf]
    text += HEX[byte & 0xf]
  }
  return text
}

/** 允许注入的最小存储接口（localStorage / 内存假对象都满足） */
export type DeviceIdStorage = {
  read: () => string | null
  write: (value: string) => void
}

export type DeviceIdState = {
  deviceId: string
  /** true = 本次新建（首次启动 / 存的值非法被重建） */
  created: boolean
}

/**
 * 读取或创建设备码。
 *
 * 已存的值**必须**通过字符集与长度校验才复用：老版本/手工改坏的值继续用会让服务端
 * 一直报参数错误，而且用户没法自救。非法值当作没有，重新生成并覆盖。
 */
export const loadOrCreateDeviceId = (
  storage: DeviceIdStorage,
  randomBytes: RandomBytes = defaultRandomBytes
): DeviceIdState => {
  const stored = (storage.read() ?? '').trim()
  if (isDeviceId(stored)) {
    return { deviceId: stored, created: false }
  }
  const deviceId = createDeviceId(randomBytes)
  storage.write(deviceId)
  return { deviceId, created: true }
}

/** localStorage 存储：读写失败（隐私模式 / 配额满）只当没有，不抛错、不写日志 */
export const localStorageDeviceIdStorage = (): DeviceIdStorage => ({
  read: () => {
    try {
      return localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (value: string) => {
    try {
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, value)
    } catch {
      // 存不进去时仍然返回本次生成的设备码，用户可复制备份；下次启动会重新生成
    }
  },
})

/** 界面用的一次性入口：拿到（必要时新建）设备码 */
export const ensureDeviceId = (): string =>
  loadOrCreateDeviceId(localStorageDeviceIdStorage()).deviceId

// ---------------------------------------------------------- 服务端回填（Issue #261）

/**
 * 把服务端在 `/apply` 响应里下发的 `device_id` 写回本地（Issue #261）。
 *
 * 为什么必须有这一步：服务端按**设备指纹**认「有没有领过」，命中的那一侧可能给回
 * **另一个** device_id（原账号的，或本次被分配的新账号的）。客户端如果继续用自己手里
 * 那个被服务端忽略的 device_id，后续 `/me`、兑换、下单全都会查到一个不存在的设备，
 * 用户看到的就是「账号变了、额度清零」。
 *
 * 三条约束：
 *  - 只认形状合法的值（{@link isDeviceId}）：服务端回一个坏值当没回，绝不把本地写坏；
 *  - 与本地相同就原样返回（不写存储），避免无意义的写；
 *  - 返回**最终应当使用的** device_id：调用方拿它去 `setState`，持久化在本函数里做。
 */
export const adoptServerDeviceId = (
  storage: DeviceIdStorage,
  current: string,
  serverDeviceId: string
): string => {
  const next = serverDeviceId.trim()
  if (!isDeviceId(next) || next === current.trim()) {
    return current.trim()
  }
  storage.write(next)
  return next
}

// ------------------------------------------------------------------ 备份提示（Issue #72）

/**
 * 「设备码=账号，复制备份好」的一次性提示。
 *
 * 只提示一次（用户点了「我知道了」就不再出现）：这类提示每次弹都会变成噪音，
 * 但一次都不提示，用户清站点数据后就没有任何线索知道自己丢过什么。
 */
export const DEVICE_BACKUP_HINT_KEY = 'chat-demo:ours-device-backup-hint-seen'

/** 只需要一个布尔标记的最小存储接口（localStorage / 内存假对象都满足） */
export type DeviceFlagStorage = {
  readFlag: () => string | null
  writeFlag: (value: string) => void
}

/**
 * true = 还没提示过（首次进入设置页要提示一次）。
 *
 * `hasEmail`（Issue #421 第 5 点）：已绑邮箱的用户**不再提示**「复制设备码备份」——
 * 那条提示的前提是「设备码 = 账号，丢了就找不回」，绑过邮箱之后账号可以靠邮箱找回，
 * 再催他备份设备码就是错的前提。三态照旧：
 *  - `true`  → 不提示（前提已变）；
 *  - `false` → 照旧按「提示过没有」判定（邮箱已开启但没绑，设备码仍是唯一凭据）；
 *  - `null`  → 邮箱功能未开启 / 老服务端，行为与 #421 之前完全一致。
 */
export const shouldShowDeviceBackupHint = (
  storage: DeviceFlagStorage,
  options: { hasEmail?: boolean | null } = {}
): boolean => (options.hasEmail === true ? false : (storage.readFlag() ?? '').trim() !== '1')

/** 用户已确认（或已经复制过设备码）：以后不再提示 */
export const markDeviceBackupHintSeen = (storage: DeviceFlagStorage): void => {
  storage.writeFlag('1')
}

/** localStorage 存储：读写失败（隐私模式 / 配额满）当没有，不抛错、不写日志 */
export const localStorageFlagStorage = (): DeviceFlagStorage => ({
  readFlag: () => {
    try {
      return localStorage.getItem(DEVICE_BACKUP_HINT_KEY)
    } catch {
      return null
    }
  },
  writeFlag: (value: string) => {
    try {
      localStorage.setItem(DEVICE_BACKUP_HINT_KEY, value)
    } catch {
      // 存不进去只意味着下次还会提示一次，不影响设备码本身
    }
  },
})
