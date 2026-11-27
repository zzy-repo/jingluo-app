import { LIMITS } from '../limits.js'
import { useSettings } from '../settings.js'
import { getStatus, runBackup, type Progress } from './backupApi.js'

/**
 * 自动备份调度（#993 任务 3）：数据就绪后调用一次即可。
 *
 * 三条都成立才真跑：开关开着 → 空间够 → 距上次成功超过阈值。
 * 首次没有任何备份时直接建初始备份（不受间隔限制）。
 * **永不抛错**：失败分类由核心侧写进 `lastError`，界面翻译成人话。
 */
export const maybeAutoBackup = async (onProgress?: Progress): Promise<void> => {
  try {
    if (!useSettings.getState().autoBackup) {
      return
    }
    const status = await getStatus()
    if (status.running || !status.enoughForNext) {
      return
    }
    if (status.count > 0 && status.lastSuccessAtUtc !== null) {
      const last = Date.parse(status.lastSuccessAtUtc)
      if (Number.isFinite(last) && Date.now() - last < LIMITS.backup.autoIntervalMs) {
        return
      }
    }
    await runBackup('auto', onProgress)
  } catch {
    // 失败分类已记进 lastError，界面会显示成一句人话；这里不打断首屏
  }
}
