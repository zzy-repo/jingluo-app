/**
 * 设备指纹的**缓存位**与它**唯一的写入方**（#498 §二 第三项 / #484 §六 第 3 条）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 这一项原先是「只有读、没有写」：`collect.ts` 读 `chat-demo:ours-device-fp`，而全仓没有任何
 * 写入方 —— 于是生产请求体里的 `deviceFp` 常年缺失（服务端只能按 `oldApiKey` + `deviceId` 判）。
 * 本文件补的就是这一环：**登录成功后**（`src/services/auth/store.ts` 的 `applySession()` 里，
 * 调 `claimLegacyMigration()` **之前**）走一次
 *
 *     resolveDeviceFp()（原生插件现算） → 形状校验 → 写进 `chat-demo:ours-device-fp`
 *
 * 四条纪律（都对应真实事故，别「顺手简化」）：
 *   1. **绝不用常量 / 全零 / 占位冒充指纹**（#395 的事故正是这么来的）：落盘前必须过一次
 *      `normalizeDeviceFp()` —— 它是 #395 判据**唯一的那一份**（形状不对 / 全相同字符 /
 *      已知常量黑名单都返回 `''`）；拿到 `''` 就**什么都不写**，`collect.ts` 自然省略这个字段
 *      （服务端按可选处理）。别在这里自己写正则：两套判据迟早会有一处放宽。
 *   2. **永不抛**：隐私模式 / 配额满 / 老壳子没有原生插件 / 非浏览器环境（`node --test`）……
 *      一律静默降级。迁移少一条线索顶多让服务端回 `need_manual`，绝不许把用户挡在登录外面。
 *   3. **有超时**（{@link FP_RESOLVE_TIMEOUT_MS}）：这一段串在「登录成功之后、发迁移请求之前」，
 *      原生桥不响应时不能跟着一起卡住 —— 超时就当没有，登录 / 迁移该干嘛干嘛。
 *   4. **不写日志、不埋点**：与 `claim.ts` 同一条红线（指纹不是凭据，但本目录整体保持零输出，
 *      免得将来有人顺手把 `oldApiKey` 也打进去）。
 *
 * 为什么不改 `collect.ts` 的签名：那一层是**同步** API（`collectLegacyIdentity(): LegacyIdentity`
 * 直接拿去做请求体）。指纹解析是异步 + 要超时，属于「登录后的写入」，不是「采集时现算」——
 * 放进来会把一个纯读函数变成异步函数，牵连 `claim.ts` 与所有调用点。所以写入在这里，
 * 采集那边继续只认「缓存位里已有的那一份」。
 */

import { normalizeDeviceFp, resolveDeviceFp } from '../../services/invite/fingerprint.js'

/** 指纹的缓存位（读者是 `collect.ts`；本文件是**唯一**写入方） */
export const LEGACY_DEVICE_FP_SLOT = 'chat-demo:ours-device-fp'

/**
 * 解析指纹的上限（毫秒）。
 *
 * 1.5s 的理由：它在登录之后的那条链上（写指纹 → claim），**用户不等这一段**（`applySession`
 * 里是 `void` 掉的后台任务），但 `claim` 要等它 —— 太长等于「迁移永远在第一步堵着」。
 * 正常原生桥是毫秒级；1.5s 拿不到就是「这台设备今天拿不到」，当没有即可。
 */
export const FP_RESOLVE_TIMEOUT_MS = 1500

/**
 * 写缓存位。写不进去（隐私模式 / 配额满 / 无 localStorage）就静默放弃：
 * 采集层读不到 = 省略该字段，与「这台设备没有指纹」同义。
 */
const writeSlot = (fp: string): boolean => {
  try {
    localStorage.setItem(LEGACY_DEVICE_FP_SLOT, fp)
    return true
  } catch {
    return false
  }
}

/**
 * 「抢跑」超时：`task` 先完成就用它的结果，否则到时返回 `undefined`（**不 reject**）。
 *
 * 定时器一定要在两边都清掉：`applySession` 每次登录都会走这里，留着未清的 1.5s 定时器
 * 会把 `node --test` 的进程拖住，也会让「登录后马上退出」的路径多挂一个回调。
 */
const withTimeout = async <T>(task: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * 解析一次指纹并写进缓存位；**返回真正落盘的那个值**，任何一步失败都返回 `''`（不抛）。
 *
 * `resolve` 可注入（单测不必造原生插件）：默认就是既有那份 `resolveDeviceFp()`
 * —— 它自己已经保证「拿不到返回 `''`、不抛」，这里再包一层是因为它是 I/O 边界。
 */
export const ensureLegacyDeviceFp = async (
  resolve: () => Promise<string> = () => resolveDeviceFp()
): Promise<string> => {
  try {
    const raw = await withTimeout(resolve(), FP_RESOLVE_TIMEOUT_MS)
    // 形状不对 / 常量 / 全零 / 原生那边改了口径 → `normalizeDeviceFp()` 返回 '' → 一个字节都不写（#395）
    const fp = normalizeDeviceFp(raw)
    if (fp === '') {
      return ''
    }
    return writeSlot(fp) ? fp : ''
  } catch {
    return ''
  }
}
