/**
 * Storage Protection 的诊断出口（唯一一处）。
 * 只记阶段 / 分类 / 数量，不记会话正文。上报本身绝不能抛：保护层的故障不许打断主流程。
 * 同一 `stage|kind` 只记一次：每次保存都会走到的路径（高水位写入、快照）失败时不刷屏。
 */
import { record, recordError } from '../diagnostics/collector.js'

type Meta = Record<string, string | number | boolean>

const seen = new Set<string>()

/** 仅测试用 */
export const resetProtectionDiagnosticsForTests = (): void => {
  seen.clear()
}

export const kindOf = (error: unknown): string => {
  const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : undefined
  return typeof kind === 'string' ? kind : 'unknown'
}

export const reportProtectionFailure = (stage: string, error: unknown, meta: Meta = {}): void => {
  const key = `${stage}|${kindOf(error)}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  try {
    recordError(`protection.${stage} failed`, { 'protection.stage': stage, 'protection.kind': kindOf(error), ...meta }, error)
  } catch {
    // 诊断自己坏了也不能再抛
  }
}

/** 一次性事件（如「检测到库从有到无」）：不去重，调用点本身就是低频 */
export const noteProtection = (stage: string, meta: Meta = {}): void => {
  try {
    record('warning', 'warn', `protection.${stage}`, { 'protection.stage': stage, ...meta })
  } catch {
    // 同上
  }
}
