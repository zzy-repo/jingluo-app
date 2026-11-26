/**
 * 宿主没有应用私有文件系统（Web / iOS / 插件缺失）时的实现。
 *
 * 不假装可用，更**不降级到内存**（规范 §4：拿不到持久化能力就抛 unsupported，不能返回成功）。
 * 路径照样先校验：调用方 bug 在任何宿主上都要暴露。
 */
import { FsError, validateFsPath, type AppFileSystem } from './types.js'

export const createUnsupportedFs = (reason = 'not-native'): AppFileSystem => {
  const unsupported = (action: string): never => {
    throw new FsError('unsupported', `${action}: app file system is not available on this host (${reason})`)
  }
  return {
    supported: false,
    writeAtomic: async (path) => {
      validateFsPath(path)
      return unsupported('writeAtomic')
    },
    read: async (path) => {
      validateFsPath(path)
      return unsupported('read')
    },
    readText: async (path) => {
      validateFsPath(path)
      return unsupported('readText')
    },
    list: async (dir) => {
      validateFsPath(dir, true)
      return unsupported('list')
    },
    remove: async (path) => {
      validateFsPath(path)
      return unsupported('remove')
    },
    freeBytes: async () => undefined,
  }
}
