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
 *   - `consume.baseUrl` **统一网关 BASE**（#869）：登录 / 推理 / 购买链接都走它，App 只配置这一个 BASE。
 *                     `ours.defaults.baseUrl` 从它派生（`services/api/environment.ts` 的 `inferenceBaseUrl`，#812）——
 *                     推理必须与登录同环境，同环境是构造出来的，不是靠人记的纪律。
 *                     `chatBaseUrl` / `inviteBaseUrl` 已随 #869 删除。
 *   - `feedbackUrl`   反馈上传（diagnostics/config.ts 的 LEGACY_FEEDBACK_URL）
 *   - `legacyHosts`   已下线主机重写表（apiConfig.ts 的 LEGACY_HOSTS）
 *   - `dlPrimaryBase` / `dlFallbackBase` 分发首选机 / 回退机（updateManifest.ts 的
 *     PRIMARY_RELEASE_BASE / FALLBACK_RELEASE_BASE，Issue #269）
 *   - `consume`       消费侧（sub2api）：base / 两套路径前缀 / 三档超时（services/consume，Issue #484）
 *   - `pay`           支付侧（apia）：base / 两档超时（只负责买卡，Issue #482 定调）
 * 源码里不许再出现地址字面量：`pnpm check:ip` / `pnpm check:endpoints` / `pnpm check:consume-api` 会拦。
 * 非打包环境（`node --test` 直接 import .ts）由 tests/helpers/injected.mjs 兜底注入。
 */
declare const __ENDPOINTS__: {
  /**
   * 明文联调包标记（Issue #601 守卫的补正面 / #651）：构建期 `ALLOW_INSECURE_CONSUME=true` 时为 true。
   * **这是运行时的唯一判据** —— `services/consume/http.ts` 只在它为 true 时才肯接受非回环的明文
   * `http://` base（否则抛 `ConsumeConfigError`，而 `src/main.tsx` 是模块级调用 → 冷启动白屏）。
   * 与原生侧的 `BuildConfig.INSECURE_CONSUME` / APK 里的 `INSECURE_CONSUME` meta-data 同源。
   * 默认 false；为 true 的产物是 staging-only，禁止公开分发（`pnpm verify:apk` 会拦）。
   */
  readonly insecureConsume: boolean
  readonly feedbackUrl: string
  readonly legacyHosts: readonly string[]
  readonly dlPrimaryBase: string
  readonly dlFallbackBase: string
  /**
   * 消费侧（sub2api，Issue #484 / #487 W1-A）：`services/consume/**` 的**唯一**地址来源。
   * `baseUrl` 同时承载两套路由：`apiV1Prefix`（JWT 通道）与 `gatewayPrefix`（sk- Key 通道），
   * 两者之间**没有重写规则**，不许把 `/api/v1` 当 `/v1` 用。
   * 超时也只从这里取（调用点不许写死毫秒数）。
   */
  readonly consume: {
    readonly baseUrl: string
    readonly apiV1Prefix: string
    readonly gatewayPrefix: string
    readonly timeoutMs: { readonly read: number; readonly write: number; readonly redeem: number }
  }
  /** 支付侧（apia）：套餐 / 收款页 / 订单 / 卡密溯源，只负责买卡（Issue #482 定调） */
  readonly pay: {
    readonly baseUrl: string
    readonly timeoutMs: { readonly read: number; readonly write: number }
  }
  /**
   * 老账号额度迁移（Issue #498 的**临时尾巴**，`src/legacy/migration/README.md` 有 @remove-after
   * 与删除方法）：一个开关 + 一次调用。`enabled` 默认 `false` —— 关掉时客户端不采集、不请求、
   * 不显示按钮。`baseUrl` 只有 `enabled:true` 时才有意义，那时构建期会强制它非空且 https
   * （`rspack.config.ts` 的 `assertMigrationConfig`）。
   *
   * 非打包环境（`node --test`）取不到这一段，运行时按「关闭」处理（`claim.ts` 自己判）。
   */
  readonly migration: {
    readonly enabled: boolean
    readonly baseUrl: string
    readonly endpoint: string
    readonly timeoutMs: number
  }
  /**
   * 私有清单（Issue #622）：`GET /api/v1/releases/internal`（#621 的令牌鉴权读端点）。
   *
   * `enabled` 默认 `false` —— 关掉时**一个字节都不请求**；只有 `enabled:true` **且**本机是
   * internal 变体（`__INTERNAL_BUILD__`）时才优先读它，失败静默回退公网 `releases.json`。
   *
   * `token` 是**构建期从 `tokenEnv` 指名的环境变量读到并注入的令牌原文**，只用于
   * `X-DL-Token` 请求头：不进 URL、不进日志、不进埋点。它在 `standard` 构建里恒为空串
   * （rspack.config.ts 的 `privateManifestInjection` 整段按关闭注入），
   * 所以 public / standard 产物里连端点地址都不出现。
   *
   * 非打包环境（`node --test`）取不到这一段，运行时按「关闭」处理（updateManifest.ts 自己判）。
   */
  readonly update?: {
    readonly privateManifest?: {
      readonly enabled: boolean
      readonly url: string
      readonly token: string
    }
  }
}

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

/**
 * PDF 解析用的 pdfjs 静态资源描述（Issue #480）。
 *
 * 唯一来源是仓库根 `config/pdfjs.json`（路径）与 `package.json` 里实际安装的 `pdfjs-dist`（版本），
 * 由 rspack.config.ts 的 DefinePlugin 在构建期注入：
 *   - `version`   进 `ParsedDocument.parserVersion`，与内容指纹一起做解析缓存键
 *   - `assetDir`  `dist` 下的静态目录（`static/pdfjs`），运行期用 `document.baseURI` 拼绝对地址
 *   - `script` / `worker` / `cmapsDir` 由 CopyRspackPlugin 原样拷进去
 * 非打包环境（`node --test` 直接 import .ts）没有注入，pdfLoader.ts 用 `typeof` 判 undefined 兜底。
 */
declare const __PDFJS_ASSET__: {
  readonly version: string
  readonly assetDir: string
  readonly script: string
  readonly worker: string
  readonly cmapsDir: string
}
