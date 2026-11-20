declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/**
 * 是否内测构建（固定服务地址与模型，见 src/services/api/internalBuild.ts）。
 * 由 rspack.config.ts 的 DefinePlugin 注入；非打包环境取不到，代码里用 try/catch 兜底成 false。
 */
declare const __INTERNAL_BUILD__: boolean

/** 应用版本号（package.json 的 version），由 rspack 的 DefinePlugin 注入；诊断信息里用它上报 */
declare const __APP_VERSION__: string

/** Android versionCode（取自 package.json 的 androidVersionCode），由 rspack 的 DefinePlugin 注入 */
declare const __APP_VERSION_CODE__: number

/**
 * 服务端端点表，唯一来源是仓库根的 `config/endpoints.json`（Issue #274），
 * 由 rspack.config.ts 的 DefinePlugin 在构建期注入：
 *   - `chatBaseUrl`   对话上游（providers.ts 的 ours.defaults.baseUrl）
 *   - `inviteBaseUrl` 邀请 / 额度 / 卡密服务（invite/api.ts 的 INVITE_API_BASE）
 *   - `feedbackUrl`   反馈上传（diagnostics/config.ts 的 LEGACY_FEEDBACK_URL）
 *   - `legacyHosts`   已下线主机重写表（apiConfig.ts 的 LEGACY_HOSTS）
 *   - `dlPrimaryBase` / `dlFallbackBase` 分发首选机 / 回退机（updateManifest.ts 的
 *     PRIMARY_RELEASE_BASE / FALLBACK_RELEASE_BASE，Issue #269）
 * 源码里不许再出现地址字面量：`pnpm check:ip` / `pnpm check:endpoints` 会拦。
 * 非打包环境（`node --test` 直接 import .ts）由 tests/helpers/injected.mjs 兜底注入。
 */
declare const __ENDPOINTS__: {
  readonly chatBaseUrl: string
  readonly inviteBaseUrl: string
  readonly feedbackUrl: string
  readonly legacyHosts: readonly string[]
  readonly dlPrimaryBase: string
  readonly dlFallbackBase: string
}

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
