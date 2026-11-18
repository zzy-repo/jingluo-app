/**
 * 低内核 WebView 运行时补齐（GitHub issue #13「低内核白屏」）。
 *
 * 背景：Android 的 WebView 版本跟系统镜像走，不受 App 控制。Android 11 出厂镜像停在
 * Chromium 83（WebView 83.0.4103.106），它之后的 API 全部缺失：
 *
 *   Object.hasOwn                Chrome 93
 *   Array/String.prototype.at    Chrome 92
 *   structuredClone              Chrome 98
 *   Array.prototype.toSorted 等  Chrome 110（ES2023）
 *   crypto.randomUUID            Chrome 92
 *   Array.prototype.findLast      Chrome 97
 *
 * 这些是**运行时 API**，构建降级语法（rspack target=chrome83）救不了，只能在这里手写补。
 * 三条硬约束：
 *   1. 必须是应用入口的第一个 import —— 在任何 React / 业务模块求值之前装好（main.tsx）；
 *   2. 幂等：只在缺失时定义，绝不覆盖原生实现（新版 WebView 上等于什么都没做）；
 *   3. 不引第三方包（core-js 体积/语义都太重），本文件自包含、不 import 任何东西。
 *
 * 语法兼容：本文件本身也按 chrome 83 编译（swc env.targets），所以这里不用任何 ES2021+ 语法。
 */

/** 装上后挂在 globalThis 上的标记，诊断/测试用来确认补丁真的跑过 */
export const LEGACY_POLYFILL_FLAG = '__DEEPSEEK_LEGACY_POLYFILL__'

/** 补丁版本号，便于诊断上报里区分 */
export const LEGACY_POLYFILL_VERSION = 1

/** 装过的 API 名字（诊断用；不含覆盖原生的情况） */
const installed: string[] = []

/** 无法深拷贝、按引用降级透传的次数（structuredClone 的降级计数） */
let degradedClones = 0

/** 补丁记录：{ flag, version, installed, degradedClones } */
export const legacyPolyfillReport = (): {
  installed: string[]
  degradedClones: number
} => ({ installed: installed.slice(), degradedClones })

/** 定义不可枚举的方法（与原生内建方法一致：不出现在 for..in / Object.keys 里） */
const define = (owner: object, name: string, value: unknown): void => {
  try {
    Object.defineProperty(owner, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    ;(owner as Record<string, unknown>)[name] = value
  }
  if (installed.indexOf(name) < 0) {
    installed.push(name)
  }
}

/** 规范 ToLength：负数/NaN → 0，超出安全整数上限则截断 */
const toLength = (value: unknown): number => {
  const number = Number(value)
  if (!(number > 0)) {
    return 0
  }
  if (number === Infinity) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER)
}

/** 规范 ToInteger：负数保留（at/with 需要负下标语义） */
const toInteger = (value: unknown): number => {
  const number = Number(value)
  if (Number.isNaN(number)) {
    return 0
  }
  if (number === Infinity || number === -Infinity) {
    return number
  }
  return Math.trunc(number)
}

/** 归一化下标：负数从尾部数；越界由调用方判断 */
const relativeIndex = (index: unknown, length: number): number => {
  const key = toInteger(index)
  return key < 0 ? key + length : key
}

/** Object.hasOwn —— Chrome 93。用 hasOwnProperty.call 的等价语义（含 null/undefined 抛 TypeError） */
const installObjectHasOwn = (): void => {
  if (typeof Object.hasOwn === 'function') {
    return
  }
  define(Object, 'hasOwn', function hasOwn(target: object, key: PropertyKey): boolean {
    if (target === null || target === undefined) {
      throw new TypeError('Object.hasOwn called on null or undefined')
    }
    return Object.prototype.hasOwnProperty.call(target, key)
  })
}

/** Array.prototype.at / String.prototype.at —— Chrome 92 */
const installAt = (): void => {
  if (typeof Array.prototype.at !== 'function') {
    define(Array.prototype, 'at', function at(this: ArrayLike<unknown>, index: number) {
      const length = toLength(this.length)
      const key = relativeIndex(index, length)
      if (key < 0 || key >= length) {
        return undefined
      }
      return this[key]
    })
  }
  // String.prototype.at 在 Chromium 83 同样缺失；代理对（emoji）这里按 UTF-16 码元取值，
  // 与原生按 code point 取值不同 —— 应用里只用来取首字符，够用（见已知边界）。
  if (typeof String.prototype.at !== 'function') {
    define(String.prototype, 'at', function at(this: string, index: number) {
      const length = toLength(this.length)
      const key = relativeIndex(index, length)
      if (key < 0 || key >= length) {
        return undefined
      }
      return this[key]
    })
  }
}

/** Array.prototype.findLast / findLastIndex —— Chrome 97（应用自身没用，防第三方依赖） */
const installFindLast = (): void => {
  if (typeof Array.prototype.findLast !== 'function') {
    define(
      Array.prototype,
      'findLast',
      function findLast(
        this: unknown[],
        predicate: (value: unknown, index: number, array: unknown[]) => boolean,
        thisArg?: unknown
      ) {
        const length = toLength(this.length)
        for (let index = length - 1; index >= 0; index -= 1) {
          const value = this[index]
          if (predicate.call(thisArg, value, index, this)) {
            return value
          }
        }
        return undefined
      }
    )
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    define(
      Array.prototype,
      'findLastIndex',
      function findLastIndex(
        this: unknown[],
        predicate: (value: unknown, index: number, array: unknown[]) => boolean,
        thisArg?: unknown
      ) {
        const length = toLength(this.length)
        for (let index = length - 1; index >= 0; index -= 1) {
          if (predicate.call(thisArg, this[index], index, this)) {
            return index
          }
        }
        return -1
      }
    )
  }
}

/** ES2023 不可变数组方法 —— Chrome 110。语义按规范实现（不改入参、返回新数组） */
const installImmutableArrayMethods = (): void => {
  if (typeof Array.prototype.toSorted !== 'function') {
    define(
      Array.prototype,
      'toSorted',
      function toSorted(this: unknown[], compareFn?: (a: unknown, b: unknown) => number) {
        const copy = Array.prototype.slice.call(this) as unknown[]
        return copy.sort(compareFn as (a: unknown, b: unknown) => number)
      }
    )
  }
  if (typeof Array.prototype.toReversed !== 'function') {
    define(Array.prototype, 'toReversed', function toReversed(this: unknown[]) {
      return (Array.prototype.slice.call(this) as unknown[]).reverse()
    })
  }
  if (typeof Array.prototype.toSpliced !== 'function') {
    define(
      Array.prototype,
      'toSpliced',
      function toSpliced(
        this: unknown[],
        start: number,
        deleteCount?: number,
        ...items: unknown[]
      ) {
        const copy = Array.prototype.slice.call(this) as unknown[]
        if (arguments.length <= 1) {
          copy.splice(relativeIndex(start, copy.length))
        } else if (arguments.length === 2) {
          copy.splice(relativeIndex(start, copy.length), toLength(deleteCount))
        } else {
          copy.splice(relativeIndex(start, copy.length), toLength(deleteCount), ...items)
        }
        return copy
      }
    )
  }
  if (typeof Array.prototype.with !== 'function') {
    define(
      Array.prototype,
      'with',
      function withMethod(this: unknown[], index: number, value: unknown) {
        const length = toLength(this.length)
        const key = relativeIndex(index, length)
        if (key < 0 || key >= length) {
          throw new RangeError('Invalid index : ' + String(index))
        }
        const copy = Array.prototype.slice.call(this) as unknown[]
        copy[key] = value
        return copy
      }
    )
  }
}

/** 结构化克隆不支持、只能按引用透传的值类型（降级而不是抛错，见 cloneValue） */
const isOpaqueObject = (value: object): boolean => {
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return true
  }
  if (typeof Promise !== 'undefined' && value instanceof Promise) {
    return true
  }
  if (typeof WeakMap !== 'undefined' && value instanceof WeakMap) {
    return true
  }
  if (typeof WeakSet !== 'undefined' && value instanceof WeakSet) {
    return true
  }
  if (typeof WeakRef !== 'undefined' && value instanceof WeakRef) {
    return true
  }
  return false
}

const cloneArrayBuffer = (buffer: ArrayBuffer): ArrayBuffer => buffer.slice(0)

/** 深拷贝一份（支持环引用/Map/Set/Date/RegExp/TypedArray/Error/类实例） */
const cloneValue = (value: unknown, seen: Map<object, unknown>): unknown => {
  if (value === null || typeof value !== 'object') {
    // 函数、Symbol 无法结构化克隆：**降级**为按引用透传（旧内核上宁可共享引用，也不要抛错
    // 打断整条发送/渲染链路）。计数暴露在 legacyPolyfillReport() 里。
    if (typeof value === 'function' || typeof value === 'symbol') {
      degradedClones += 1
    }
    return value
  }

  const object = value as object
  const cached = seen.get(object)
  if (cached !== undefined) {
    return cached
  }

  if (isOpaqueObject(object)) {
    degradedClones += 1
    return object
  }

  if (object instanceof Date) {
    return new Date(object.getTime())
  }
  if (object instanceof RegExp) {
    return new RegExp(object.source, object.flags)
  }
  if (typeof ArrayBuffer !== 'undefined' && object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object)
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView
    if (view instanceof DataView) {
      return new DataView(
        cloneArrayBuffer(view.buffer as ArrayBuffer),
        view.byteOffset,
        view.byteLength
      )
    }
    const TypedArray = (view as unknown as { constructor: new (buffer: ArrayBuffer) => unknown })
      .constructor
    const cloned = new TypedArray(cloneArrayBuffer(view.buffer as ArrayBuffer)) as ArrayBufferView
    // 只保留本视图那一段（buffer 可能被多个视图共享）
    const bytes = new Uint8Array(
      (view as unknown as { buffer: ArrayBuffer }).buffer,
      view.byteOffset,
      view.byteLength
    )
    new Uint8Array(cloned.buffer as ArrayBuffer).set(bytes)
    return cloned
  }
  if (object instanceof Error) {
    const copy = new Error(object.message)
    copy.name = object.name
    if (typeof object.stack === 'string') {
      copy.stack = object.stack
    }
    return copy
  }
  if (object instanceof Map) {
    const copy = new Map()
    seen.set(object, copy)
    object.forEach((mapValue, mapKey) => {
      copy.set(cloneValue(mapKey, seen), cloneValue(mapValue, seen))
    })
    return copy
  }
  if (object instanceof Set) {
    const copy = new Set()
    seen.set(object, copy)
    object.forEach((item) => copy.add(cloneValue(item, seen)))
    return copy
  }
  if (Array.isArray(object)) {
    const copy: unknown[] = []
    seen.set(object, copy)
    for (let index = 0; index < object.length; index += 1) {
      copy[index] = cloneValue(object[index], seen)
    }
    return copy
  }

  // 普通对象 / 类实例：保留原型链，只拷自有可枚举属性
  const copy = Object.create(Object.getPrototypeOf(object)) as Record<string, unknown>
  seen.set(object, copy)
  const keys = Object.keys(object) as string[]
  for (let index = 0; index < keys.length; index += 1) {
    copy[keys[index]] = cloneValue((object as Record<string, unknown>)[keys[index]], seen)
  }
  return copy
}

/** structuredClone —— Chrome 98 */
const installStructuredClone = (): void => {
  if (typeof (globalThis as { structuredClone?: unknown }).structuredClone === 'function') {
    return
  }
  define(globalThis, 'structuredClone', function structuredClone<
    T,
  >(value: T, options?: { transfer?: unknown[] }): T {
    const transfer = options && options.transfer
    if (transfer && transfer.length) {
      // 无原生 ArrayBuffer 转移能力：明确抛错（与原生 DataCloneError 同类别，调用方能 try/catch），
      // 不做静默丢语义的“假转移”。
      const error = new Error('structuredClone: transfer list is not supported on this engine')
      error.name = 'DataCloneError'
      throw error
    }
    return cloneValue(value, new Map()) as T
  })
}

/** crypto.randomUUID —— Chrome 92（应用 update 检查直接用，缺了会抛 TypeError） */
const installRandomUUID = (): void => {
  const crypto = (globalThis as { crypto?: Crypto }).crypto
  if (!crypto) {
    return
  }
  if (typeof (crypto as { randomUUID?: unknown }).randomUUID === 'function') {
    return
  }
  if (typeof crypto.getRandomValues !== 'function') {
    return
  }
  define(crypto, 'randomUUID', function randomUUID(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    // RFC 4122 v4：版本位 0100、变体位 10
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    let out = ''
    for (let index = 0; index < bytes.length; index += 1) {
      const hex = bytes[index].toString(16)
      out += hex.length === 1 ? '0' + hex : hex
      if (index === 3 || index === 5 || index === 7 || index === 9) {
        out += '-'
      }
    }
    return out
  })
}

/**
 * 装上全部低内核补丁。幂等：每个补丁自己判断「原生是否已存在」，重复调用不会重复定义。
 * 本模块 import 时自动执行一次（见文件尾），入口不需要额外调用。
 */
export const installLegacyPolyfills = (): void => {
  installObjectHasOwn()
  installAt()
  installFindLast()
  installImmutableArrayMethods()
  installStructuredClone()
  installRandomUUID()
  if ((globalThis as Record<string, unknown>)[LEGACY_POLYFILL_FLAG] === undefined) {
    define(globalThis, LEGACY_POLYFILL_FLAG, LEGACY_POLYFILL_VERSION)
  }
}

installLegacyPolyfills()
