/**
 * 脱敏规则（卡密/支付服务与邀请服务共用）。
 *
 * 硬性约束：日志、错误提示、诊断快照里都不出现完整 Key、完整 device_id、完整卡密，
 * 只保留尾部若干位（Key 6 位、卡密 4 位、device_id 4 位）。
 * 这里只有纯函数，不碰 DOM、不碰存储，Node 单测可直接 import。
 */

/** 脱敏：只保留尾部若干位，前面统一四个实心点 */
export const maskTail = (value: string, tail = 6): string => {
  const text = value.trim()
  if (text.length <= tail) {
    return '••••'
  }
  return `••••${text.slice(-tail)}`
}

/** Key 脱敏（尾 6 位） */
export const maskKey = (key: string): string => maskTail(key, 6)

/** 卡密脱敏（尾 4 位） */
export const maskCard = (cardNo: string): string => maskTail(cardNo, 4)

/**
 * 卡号**展示**口径：`null` → `''`，其余只留尾 4 位（`MUSE-3CYP-5NA3-AHSE-A3SR` → `••••A3SR`）。
 *
 * 与 `maskCard` 的唯一区别就是「没有卡号」这一态：列表里没有 `recharge_code` 的订单不该被渲染成
 * `••••`（那看着像「有卡但打码了」）。实现只有这一份 —— `services/ours/purchases.ts` 从这里再导出
 * （#158 的旧口径不许出现第二份拷贝）。
 */
export const maskCardNo = (cardNo: string | null): string => (cardNo === null ? '' : maskCard(cardNo))

/**
 * 设备码脱敏（尾 4 位）。
 * 设备码只在用户自己的设置页里完整可见（他能复制、能备份）；
 * 一旦要进日志、诊断或错误文案，就只能用这个。
 */
export const maskDeviceId = (deviceId: string): string => maskTail(deviceId, 4)
