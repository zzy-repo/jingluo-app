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
 * ⚠️ 仅测试构建：把邀请服务 / 卡密支付服务的 base URL 覆盖成指定值（真机联调本地 mock 用）。
 * 由 rspack.config.ts 从环境变量 TEST_INVITE_API_BASE / TEST_OURS_API_BASE 注入；
 * 非测试构建是空串，源码回落硬编码地址。Node 单测取不到该常量，用 typeof 兜底。
 */
declare const __TEST_INVITE_API_BASE__: string
declare const __TEST_OURS_API_BASE__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
