// 域 5 用例的模块替换层（node:module registerHooks）。
//
// 本域所有 L0 用例都跑**真实源码**：urlImport / importArchive / zipReader / exportArchive /
// zipWriter / backup / store 都是真的，只替换「进程边界」——
//   - @capacitor/core：原生桥（真机上才有；Node 里要能逐次控制响应）
//   - diagnostics：写在进程内的日志桩（用来断言心跳 / 失败终态字段）
//   - db（IndexedDB）：Node 里没有 IndexedDB，只替换存储边界
// 这样断言的仍然是线上跑的那段逻辑。
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`；node 不会自己改后缀。 */
export const asTypescript = (specifier, parentURL) => {
  if (!parentURL || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return null
  }
  const target = fileURLToPath(new URL(specifier, parentURL)).replace(/\.js$/, '.ts')
  return existsSync(target) ? pathToFileURL(target).href : null
}

/**
 * 装一层解析钩子。
 * @param {(specifier: string, parentURL: string) => string|null} resolveStub
 *   返回要替换成的模块 URL（null = 不替换）。parentURL 用来区分同名导入
 *   （`./db.js` 在 store.ts 与 backup.ts 里要换成不同的替身）。
 */
export const installHooks = (resolveStub) =>
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolveStub(specifier, String(context.parentURL ?? ''))
      if (url !== null && url !== undefined) {
        return { url, shortCircuit: true }
      }
      const typescript = asTypescript(specifier, context.parentURL)
      if (typescript !== null) {
        return { url: typescript, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })

/** 目录内某个替身模块的 URL。 */
export const stubOf = (relative) => new URL(relative, import.meta.url).href

/** 把 BackupError（key + params）渲染成用户真正看到的文案。 */
export const render = (messages, error) =>
  String(messages[error.key] ?? error.key).replace(/\{(\w+)\}/g, (raw, name) =>
    error.params?.[name] === undefined ? raw : String(error.params[name])
  )

/** i18n 里一条文案的占位符名（排序后），用于 zh / en 成对断言。 */
export const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

/**
 * 打包期 DefinePlugin 常量：裸 Node 里没有，而域 5 的导出 / 存储链路会经 diagnostics 读到它们。
 * 与其它单测同一套做法（值从 scripts/lib/endpoints.mjs 取，不在测试里另写一份地址）。
 */
export const installBuildDefines = async () => {
  const { consumeBaseUrl, downloadFallbackBase, downloadPrimaryBase, legacyHosts } = await import(
    '../../../scripts/lib/endpoints.mjs'
  )
  globalThis.__ENDPOINTS__ ??= Object.freeze({
    consume: Object.freeze({ baseUrl: consumeBaseUrl }),
    feedbackUrl: 'https://feedback.test.invalid',
    legacyHosts: Object.freeze([...legacyHosts]),
    // 分发地址（Issue #269）：域 5 不测更新链路，只保持注入形状与真实构建一致
    dlPrimaryBase: downloadPrimaryBase,
    dlFallbackBase: downloadFallbackBase,
  })
  globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
  globalThis.__INTERNAL_BUILD__ ??= false
}
