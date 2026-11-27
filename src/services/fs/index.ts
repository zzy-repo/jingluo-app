/**
 * 应用内部文件系统入口（#907）。
 *
 * `getFs()` 返回进程内单例，选择**依赖能力探测结果，不依赖平台字符串**：
 * `probeStatic('AppFileSystem')` 通过（原生壳且插件已注册）→ 原生实现（首次 I/O 前再做方法清单与
 * ping 探测）；否则 → `supported=false` 的实现，I/O 抛 `FsError('unsupported')`。
 * 生产路径**绝不**返回 memoryFs：它只能经 `setFsForTests()` 注入。
 */
import { probeStatic } from '../capability/probe.js'
import { APP_FS_PLUGIN_NAME, createNativeFs, getNativeBridge } from './native/nativeFs.js'
import { createUnsupportedFs } from './unsupportedFs.js'
import type { AppFileSystem } from './types.js'

export { FsError, FsPathError } from './types.js'
export type { AppFileSystem, FsEntry, FsErrorKind } from './types.js'

let instance: AppFileSystem | undefined

const createFs = (): AppFileSystem => {
  const probe = probeStatic(APP_FS_PLUGIN_NAME)
  return probe.available ? createNativeFs(getNativeBridge()) : createUnsupportedFs(probe.reason)
}

export const getFs = (): AppFileSystem => {
  if (!instance) {
    instance = createFs()
  }
  return instance
}

/** 仅测试用：注入替身（含 memoryFs）；传 undefined 清空单例，下次 `getFs()` 重新探测 */
export const setFsForTests = (fs: AppFileSystem | undefined): void => {
  instance = fs
}
