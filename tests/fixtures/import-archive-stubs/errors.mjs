
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

// ---- 以下是 `src/services/capability/errors.ts` 的等价替身（#910） ----
// 为什么需要：本替身被按「说明符」而非「父模块」劫持（见各用例的 resolve hook），
// 于是 `capability/probe.ts` 里的 `import { InfraError } from './errors.js'` 也会落到这里。
// 缺了这些导出，凡是从 fs / protection / migration 传进来 capability 的用例都会在
// 模块实例化阶段报「does not provide an export named 'InfraError'」。
// 语义按真实现逐条抄：kind 五档、name 固定 'InfraError'、cause 原样带出。
export const INFRA_ERROR_KINDS = ['unsupported', 'permission', 'quota', 'unavailable', 'unknown']

export class InfraError extends Error {
  constructor(kind, message, options) {
    super(message)
    this.name = 'InfraError'
    this.kind = kind
    if (options && options.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

export const isInfraError = (value) => value instanceof InfraError

export const infraKindOfRejection = (error) => {
  const code = typeof error === 'object' && error !== null ? error.code : undefined
  switch (code) {
    case 'QUOTA':
      return 'quota'
    case 'PERMISSION':
      return 'permission'
    case 'UNAVAILABLE':
      return 'unavailable'
    case 'UNIMPLEMENTED':
      return 'unsupported'
    default:
      return 'unknown'
  }
}
