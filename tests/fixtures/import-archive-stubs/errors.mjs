
// 测试替身：真实的 errors.ts 用了 TS 参数属性（node 的 strip-only 模式不支持），
// 这里给一个等价实现：key + params 原样带出，message 用真实 zh 文案做占位符替换，
// 这样断言「用户看到的文案指出了具体原因」时读的仍是 src/i18n/zh.ts 的真实字符串。
import { zh } from '../../../src/i18n/zh.ts'

const render = (key, params) =>
  String(zh[key] ?? key).replace(/\{(\w+)\}/g, (placeholder, name) =>
    typeof params?.[name] === 'string' || typeof params?.[name] === 'number' ? String(params[name]) : placeholder
  )

export class BackupError extends Error {
  constructor(key, params) {
    super(render(key, params))
    this.name = 'BackupError'
    this.key = key
    this.params = params
  }
}

export const fail = (key, params) => {
  throw new BackupError(key, params)
}
