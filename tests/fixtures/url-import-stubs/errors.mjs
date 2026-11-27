// 测试替身：真实的 errors.ts 用了 TS 参数属性（node 的 strip-only 模式不支持），
// 这里给一个等价实现：key + params 原样带出，方便断言「终态可读」的字段。
export class BackupError extends Error {
  constructor(key, params) {
    super(key)
    this.name = 'BackupError'
    this.key = key
    this.params = params
  }
}

export const fail = (key, params) => {
  throw new BackupError(key, params)
}
