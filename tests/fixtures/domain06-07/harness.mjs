/**
 * 域 6+7（额度与卡密 / 购买与订单）组件级用例的公共夹具。
 *
 * 职责只有三件：
 *  1. **模块钩子**：让 Node 能直接 import 生产 `.ts` / `.tsx`（`.js` 说明符 → `.ts(x)`、
 *     `.tsx` 走 fixtures/jsx-transform.mjs、类型交给 `stripTypeScriptTypes()`），并把
 *     「外部世界」的说明符换成本目录下的替身（见 stubs/）。
 *  2. **假传输 / 假 App 内浏览器**：记下每个请求（method / path / headers / body），
 *     由用例按表给响应；`Browser.open` 的关闭回调也能手动触发。
 *  3. **挂载真组件**：mini-react 渲染 + settle，返回一个能按 `data-testid` 读文案、点按钮的句柄。
 *
 * **不产生任何真实网络请求**：所有 `httpTransport` 调用都落在 ctx.responder 里；
 * 没有 responder 就直接抛错（宁可红，也不许悄悄打到生产服务）。
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  allowedHosts,
  chatBaseUrl,
  downloadFallbackBase,
  downloadPrimaryBase,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
} from '../../../scripts/lib/endpoints.mjs'
import { transformJsx } from './jsx-transform.mjs'
import { createRoot, settle, unmount, toHtml, textOf, byTestId, findAll } from './mini-react.mjs'

// 构建期注入值（rspack DefinePlugin 的 __ENDPOINTS__）在 Node 里的兜底：
// `services/invite/api.ts` 模块顶层就在读它。取值只有一个来源：config/endpoints.json（#274）。
// 用 `??=`：真正由 runner 的 --import 预加载注入时以那份为准。
globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl,
  feedbackUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
  // 分发地址（Issue #269）：本 harness 不测更新链路，但要与真实注入的形状一致
  dlPrimaryBase: downloadPrimaryBase,
  dlFallbackBase: downloadFallbackBase,
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')

const url = (relative) => new URL(relative, import.meta.url).href

/** 裸说明符（第三方包 / 别名）→ 替身模块 */
const SPECIFIER_STUBS = [
  [/^react$/, url('./mini-react.mjs')],
  [/^react\/jsx-runtime$/, url('./mini-react.mjs')],
]

/**
 * **解析后的绝对路径** → 替身模块。
 *
 * 必须按解析结果匹配（而不是按源码里写的说明符）：同一份 `settingsDialogState` 在不同组件里
 * 分别写成 `'./settingsDialogState.js'`、`'../settings/settingsDialogState.js'`，
 * 只有落到文件路径上才是同一个模块，映射才不会漏。
 */
const RESOLVED_STUBS = [
  [/\/src\/components\/base\/Button\.tsx?$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/components\/base\/Modal\.tsx?$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/components\/base\/toastState\.ts$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/services\/api\/apiConfig\.ts$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/i18n\/index\.ts$/, url('./stubs/i18n.mjs')],
  [/\/src\/services\/ours\/transport\.ts$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/utils\/clipboard\.ts$/, url('./stubs/app-stubs.mjs')],
  [/\/src\/components\/settings\/settingsDialogState\.ts$/, url('./stubs/app-stubs.mjs')],
]

/** CSS Modules → 空对象代理：`styles.foo` → `'C_foo'`（样式值不参与断言） */
const CSS_STUB = `data:text/javascript,${encodeURIComponent(
  "export default new Proxy({}, { get: (_, key) => (typeof key === 'string' ? 'C_' + key : undefined) })"
)}`

const stubForSpecifier = (specifier) => {
  for (const [pattern, target] of SPECIFIER_STUBS) {
    if (pattern.test(specifier)) {
      return target
    }
  }
  return null
}

const stubForResolved = (resolvedUrl) => {
  for (const [pattern, target] of RESOLVED_STUBS) {
    if (pattern.test(resolvedUrl)) {
      return target
    }
  }
  return null
}

const stubFor = (specifier) => {
  for (const [pattern, target] of SPECIFIER_STUBS) {
    if (pattern.test(specifier)) {
      return target
    }
  }
  return null
}

const compile = (filename) => {
  const source = readFileSync(filename, 'utf8')
  const withoutJsx = filename.endsWith('.tsx') ? transformJsx(source) : source
  return stripTypeScriptTypes(withoutJsx, { mode: 'transform' })
}

let hooksInstalled = false

/** `stripTypeScriptTypes` 每次进程启动会打一条 Experimental 警告；测试输出里不该有噪音 */
const silenceExperimentalWarning = () => {
  const original = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '')
    if (text.includes('stripTypeScriptTypes')) {
      return
    }
    return original.call(process, warning, ...rest)
  }
}

const installHooks = () => {
  if (hooksInstalled) {
    return
  }
  hooksInstalled = true
  silenceExperimentalWarning()
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const direct = stubForSpecifier(specifier)
      if (direct !== null) {
        return { url: direct, shortCircuit: true }
      }
      if (specifier.endsWith('.css')) {
        return { url: CSS_STUB, shortCircuit: true }
      }
      let resolved = null
      try {
        resolved = nextResolve(specifier, context)
      } catch (error) {
        // 与打包器一致：源码内部用 .js 说明符指向 .ts / .tsx 文件
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
          for (const extension of ['.ts', '.tsx']) {
            try {
              resolved = nextResolve(specifier.slice(0, -3) + extension, context)
              break
            } catch {
              resolved = null
            }
          }
        }
        if (resolved === null) {
          throw error
        }
      }
      const stub = stubForResolved(resolved.url)
      return stub === null ? resolved : { url: stub, shortCircuit: true }
    },
    load(filename, context, nextLoad) {
      if (filename.startsWith('file:') && /\.tsx?$/u.test(filename)) {
        return { format: 'module', source: compile(fileURLToPath(filename)), shortCircuit: true }
      }
      return nextLoad(filename, context)
    },
  })
}

/** 内存版 localStorage：设备码 / 备份提示这类「跨会话」断言要用它，且不许碰真实存储 */
const installStorage = () => {
  if (globalThis.localStorage !== undefined) {
    return
  }
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value))
    },
    removeItem: (key) => {
      store.delete(String(key))
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

const createContext = () => {
  const context = {
    // 渠道配置 store（替换 apiConfig）
    apiKey: '',
    keyWrites: [],
    // 设置页
    oursOpen: false,
    settingsClosed: 0,
    // 剪贴板 / toast
    copied: [],
    copyFails: false,
    toasts: [],
    // 请求
    requests: [],
    responder: null,
    // 假 App 内浏览器
    browser: { opens: [], onClosed: null, rejectOpen: false },
    reset() {
      this.apiKey = ''
      this.keyWrites = []
      this.oursOpen = false
      this.settingsClosed = 0
      this.copied = []
      this.copyFails = false
      this.toasts = []
      this.requests = []
      this.responder = null
      this.browser = { opens: [], onClosed: null, rejectOpen: false }
      globalThis.localStorage?.clear()
    },
    /** 按表给响应：handler 收 { method, path, headers, body, json }，返回传输层结果 */
    reply(handler) {
      this.responder = handler
    },
    get paths() {
      return this.requests.map((request) => `${request.method} ${request.path}`)
    },
  }
  globalThis.__domain0607 = context
  return context
}

export const createHarness = () => {
  installHooks()
  installStorage()
  const ctx = createContext()
  return {
    ctx,
    /** import 一份生产源码（相对仓库根） */
    async importSource(relative) {
      if (relative.endsWith('.css')) {
        return import(CSS_STUB)
      }
      // Windows：`import('D:\...')` 不是合法 ESM 说明符（ERR_UNSUPPORTED_ESM_URL_SCHEME），
      // 必须转成 file:// URL。Linux/macOS 上 pathToFileURL 同样是幂等的正解。
      return import(pathToFileURL(path.join(ROOT, relative)).href)
    },
    /**
     * 挂载真组件并等状态稳定。
     *
     * `props` 里给的 onClose 由用例自己传（断言「关弹层」用）。
     */
    async mount(Component, props = {}) {
      const root = createRoot(Component, props)
      await settle(root)
      const handle = {
        root,
        async settle() {
          await settle(root)
          return handle
        },
        text(testId) {
          const node = byTestId(root.tree, testId)
          if (node === null) {
            throw new Error(`找不到 data-testid="${testId}"；当前界面：${handle.html()}`)
          }
          return textOf(node).trim()
        },
        has(testId) {
          return byTestId(root.tree, testId) !== null
        },
        node(testId) {
          return byTestId(root.tree, testId)
        },
        /** 点一个 data-testid 按钮（真的调用组件传下来的 onClick） */
        async click(testId) {
          const node = byTestId(root.tree, testId)
          if (node === null) {
            throw new Error(`点不到 data-testid="${testId}"；当前界面：${handle.html()}`)
          }
          const onClick = node.props.onClick ?? (node.type === 'button' ? node.props.onClick : null)
          if (typeof onClick !== 'function') {
            throw new Error(`data-testid="${testId}" 上没有 onClick`)
          }
          if (node.props.disabled === true) {
            throw new Error(`data-testid="${testId}" 是禁用态，用户点不到`)
          }
          await onClick({ preventDefault() {}, stopPropagation() {} })
          await handle.settle()
          return handle
        },
        /** 往一个 data-testid 输入框里打字（走组件的 onChange） */
        async type(testId, value) {
          const node = byTestId(root.tree, testId)
          if (node === null) {
            throw new Error(`找不到输入框 data-testid="${testId}"`)
          }
          const onChange = node.props.onChange
          if (typeof onChange !== 'function') {
            throw new Error(`data-testid="${testId}" 上没有 onChange`)
          }
          onChange({ target: { value } })
          await handle.settle()
          return handle
        },
        html() {
          return toHtml(root.tree)
        },
        findAll(predicate) {
          return findAll(root.tree, predicate)
        },
        unmount() {
          unmount(root)
        },
      }
      return handle
    },
  }
}

export const TRANSPORT = {
  json(status, body) {
    return { kind: 'response', status, text: JSON.stringify(body) }
  },
  text(status, body) {
    return { kind: 'response', status, text: body }
  },
  timeout() {
    return { kind: 'timeout' }
  },
  network() {
    return { kind: 'network' }
  },
}
