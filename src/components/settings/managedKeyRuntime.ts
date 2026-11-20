/**
 * 「我们的渠道」Key 的**运行时接线**（Issue #596）：把纯逻辑（`services/api/managedKey.ts`）
 * 接到真实的三样东西上 —— 消费层客户端、本机存储、设备码。
 *
 * 为什么单独一个文件而不是写在组件里：
 *   - 组件（`.tsx`）在单测里 import 不了，而这里有三条关键顺序（先取旧标记 → 再领取 → 落盘 +
 *     写标记 → 停用旧 Key），值得被读被改；写成 `.ts` 后至少能被源码断言钉住；
 *   - 启动对齐（App）与设置页按钮用的是**同一份**实现，不允许各写一套（那正是 #596 第 3 条
 *     「界面显示的尾号必须来自实际请求那把」最容易破的地方）。
 *
 * 三条边界：
 *  1. 这里不拼 URL、不发原始请求：路径白名单在 `services/consume/**`（#484）；
 *  2. Key 原文只在内存里过一手，落盘只走 `applyManagedKey`（写 Key + 写标记，同一处）；
 *  3. 日志只记「尾号 / 动作 / 结果」，**不记 Key 原文**（与 #484 §7 同一条红线）。
 */
import { applyManagedKey, getApiKey, getServerKeyMark } from '../../services/api/apiConfig.js'
import {
  claimManagedKey,
  retireManagedKey,
  syncManagedKey,
  type ManagedKeyClaim,
  type ManagedKeySource,
} from '../../services/api/managedKey.js'
import type { ConsumeCallResult } from '../../services/consume/index.js'
import { getConsumeClient } from '../../services/consumeClient.js'
import { getAccessToken } from '../../services/auth/store.js'
import { recordAction } from '../../services/diagnostics/collector.js'
import { ensureDeviceId } from '../../services/invite/device.js'

/** 真实客户端 → 领取链路要的那一小撮能力（结构化取子集，换实现不用改判定） */
const managedKeySource = (): ManagedKeySource => {
  const client = getConsumeClient()
  return {
    keys: {
      list: client.keys.list,
      create: client.keys.create,
      update: client.keys.update,
    },
  }
}

/** 有没有登录态：领取/对齐都要 JWT，没有就不发请求（未登录只会拿回 401） */
export const canClaimManagedKey = (): boolean => getAccessToken() !== undefined

/**
 * 领取（`rotate: false`）/ 重新领取（`rotate: true`）。
 *
 * 成功时**同一个函数里**完成三件事，顺序不能换：
 *  1. 先取旧标记里的 Key id（重新领取之后要停用的是**这一把**）；
 *  2. `applyManagedKey` 一次写 Key + 写标记 —— 不允许出现「Key 换了、标记还是旧的」中间态；
 *  3. 停用旧那把（`retireManagedKey`，失败不算领取失败：新 Key 已经到手且可用）。
 */
export const claimManagedKeyForDevice = async (
  options: { rotate: boolean }
): Promise<ConsumeCallResult<ManagedKeyClaim>> => {
  const previousId = getServerKeyMark()?.id
  const result = await claimManagedKey(managedKeySource(), {
    deviceId: ensureDeviceId(),
    rotate: options.rotate,
  })
  if (!result.ok) {
    recordAction('config_change', 'ours-managed-key', {
      result: 'failed',
      rotate: options.rotate,
      code: result.error.code,
      status: result.error.status,
    })
    return result
  }
  applyManagedKey(result.data.key, result.data.id)
  if (result.data.rotated) {
    void retireManagedKey(managedKeySource(), previousId)
  }
  recordAction('config_change', 'ours-managed-key', {
    result: 'saved',
    rotate: result.data.rotated,
    length: result.data.key.length,
  })
  return result
}

/**
 * 启动时对齐：服务端那把与本机不一样就覆盖本地（Issue #596 第 3 条，「以服务端为准」）。
 *
 * 跳过条件都写在返回值的字符串里，别让它变成静默失败：
 *  - `signed-out`：没有登录态，领取链路要 JWT（此时本机那把只能等用户登录后再领）；
 *  - `failed`：网络/服务端失败 —— 保持本机现状，发送前那道闸会用标记判出「旧 Key」并拦下。
 */
export type ManagedKeySyncOutcome = 'updated' | 'unchanged' | 'signed-out' | 'failed'

export const syncManagedKeyFromServer = async (): Promise<ManagedKeySyncOutcome> => {
  if (!canClaimManagedKey()) {
    return 'signed-out'
  }
  const result = await syncManagedKey(managedKeySource(), { deviceId: ensureDeviceId() })
  if (!result.ok) {
    recordAction('config_change', 'ours-managed-key-sync', {
      result: 'failed',
      code: result.error.code,
      status: result.error.status,
    })
    return 'failed'
  }
  const changed = result.data.key.trim() !== getApiKey().trim()
  if (changed) {
    applyManagedKey(result.data.key, result.data.id)
    recordAction('config_change', 'ours-managed-key-sync', {
      result: 'updated',
      length: result.data.key.length,
    })
    return 'updated'
  }
  return 'unchanged'
}
