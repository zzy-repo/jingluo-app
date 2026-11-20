import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'
import { assertBrowserslist } from './scripts/lib/compatBaseline.mjs'
import { SEAM_FLAG, SEAM_SESSION, seamEnabled } from './scripts/lib/testAuthSeam.mjs'

const dev = process.env.NODE_ENV !== 'production'
const root = path.dirname(fileURLToPath(import.meta.url))
// 版本号唯一来源：仓库根 package.json
//   version            → App versionName（也注入 __APP_VERSION__，诊断上报用）
//   androidVersionCode → App versionCode
// android/app/build.gradle 的 versionName / versionCode 就是从这里读的，发版只改这一处。
//   browserslist       → 构建语法下限（数字来源是 config/compat.json，swc 与 lightningcss 都吃这一份）
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
  androidVersionCode?: number
  browserslist?: string[]
}

/**
 * 构建语法下限。**数字的唯一来源是 `config/compat.json` 的 `baselineChromium`**；落到构建期的载体是
 * package.json 的 `browserslist`（rspack / swc / lightningcss 只吃这一份），两者由 `assertBrowserslist()`
 * 在每次构建时对齐。issue #276：以前这个数字在 6 处各写一份，抬下限时漏改任何一处都不会红，
 * 只会**假绿** —— 门禁还在跑，但它量的不是线上那份产物。
 *
 * 为什么是 chrome 83（issue #13「低内核白屏」）：Android WebView 版本跟系统镜像走，App 管不了；
 * Android 11 出厂镜像停在 WebView 83.0.4103.106（Chromium 83）。之前是 chrome >= 105，swc 于是把
 * `||=` / `&&=` / `??=` 原样留在产物里 —— 那是 ES2021 语法（Chrome 85），WebView 83 解析 main.js
 * 第一行就抛 `Uncaught SyntaxError: Unexpected token '='`，整包不执行 = 静默白屏。
 * 降到 83 后产物只含 ES2020 语法（可选链/nullish 是 Chrome 80，能过）。
 * 运行时 API（Object.hasOwn / at / structuredClone …）不是语法问题，靠 src/polyfills/legacy.ts 补。
 */
const targets = pkg.browserslist ?? []
// tsc 只是类型检查（noEmit），不参与产物语法；产物语法只由这里的 targets + 下面的 output 环境决定。
// 断言里**不再自带数字**（issue #276）：老写法 `targets.some(t => /^chrome\s*>=\s*83$/.test(t))` 自带 83，
// 于是它只可能回答「package.json 里那条字符串是不是还写着 83」，永远回答不了「它是否还等于唯一来源」；
// 而且 targets 为空时代码会先塞 fallback `['chrome >= 83']` 再去断言 —— 断言被自己塞进去的值满足，
// 等于恒真，「browserslist 被人删了」这种最该拦的情形反而通过。
assertBrowserslist(targets)

/**
 * 登录接缝（Issue #487 W1-B 后半，#510）：**构建期常量**，与运行期开关无关。
 *
 * 只有测试构建（`TEST_AUTH_SEAM=1`，CI 的黄金回归 / L1 那两步）注入真值；其余构建（含
 * `pnpm build` 与发版构建）一律注入字符串 `'undefined'`，于是 AuthGate 里
 * `typeof __TEST_AUTH_STATE__ !== 'undefined' ? __TEST_AUTH_STATE__ : undefined` 会折叠成
 * `undefined`、守卫整段被死代码消除 —— 线上产物里**没有这条路**。
 *
 * 为什么不用「运行期读 globalThis / URL 参数 / localStorage 标记」：那种写法会把「读到某个值就
 * 放行」的分支原样留在线上 bundle 里，等于给出一条可被利用的旁路。取值、标记与安全论证的唯一
 * 出处是 `scripts/lib/testAuthSeam.mjs`（构建后扫描与 CI 门禁读同一份标记）。
 */
const testAuthSeam = seamEnabled()
if (testAuthSeam) {
  process.stderr.write(`[rspack][WARN] ${SEAM_FLAG}=1：正在构建**测试接缝**产物（内联假会话），绝不能用于发版\n`)
}

/** Android versionCode（诊断上报用，读不到记 0） */
const readVersionCode = (): number => Number(pkg.androidVersionCode ?? 0) || 0

/** App 版本名（诊断上报用） */
const readVersionName = (): string => pkg.version?.trim() ?? ''

/**
 * 服务端端点表：**唯一事实来源是仓库根的 `config/endpoints.json`**（Issue #274）。
 *
 * 为什么在构建期注入而不是让源码 import：这份 JSON 同时被门禁（`scripts/lib/endpoints.mjs`）、
 * 脚本与测试读取，前端只需要其中一个子集（三份地址 + 旧域名重写表 + 两个分发 base），注入成 `__ENDPOINTS__`
 * 之后源码里就不存在任何地址字面量 —— 换机器只改那一份 JSON，`pnpm check:endpoints` 负责校验
 * 它与主机/端口白名单自洽。这里只读、只注入，不做任何改写。
 */
const endpoints = JSON.parse(readFileSync(new URL('./config/endpoints.json', import.meta.url), 'utf8')) as {
  chatBaseUrl: string
  inviteBaseUrl: string
  feedbackUrl: string
  legacyHosts: string[]
  download: { primaryBase: string; fallbackBase: string }
  // 消费侧（sub2api，#484 W1-A）：账号/额度/卡密兑换/Key 管理。
  // 这里只读、只注入；形状与 fail-fast 校验在 scripts/lib/consumeEndpoints.mjs（build.mjs 打包前跑）。
  consume: {
    baseUrl: string
    apiV1Prefix: string
    gatewayPrefix: string
    timeoutMs: { read: number; write: number; redeem: number }
  }
  // 支付侧（apia）：只负责买卡，不迁（#482 定调）
  pay: { baseUrl: string; timeoutMs: { read: number; write: number } }
  // 老账号额度迁移（sub2api 之前的旧账号，#498 的**临时尾巴**，@remove-after 1.6.0）。
  // 默认 `enabled:false`：关掉时客户端不采集、不请求、不显示按钮（三处判定见 src/legacy/migration/）。
  // 这里只读、只注入；`enabled:true` 时形状不对会在下面 assertMigrationConfig 直接中止构建。
  migration: { enabled: boolean; baseUrl: string; endpoint: string; timeoutMs: number }
}

/**
 * PDF 文本解析（Issue #480）：pdfjs 产物**不是**由打包器编译进来的（要经典 `<script src>` 才能过
 * Chromium 79/83，见 src/services/attachments/parsers/pdfLoader.ts），所以这里做两件事：
 *   1. 把 `pdfjs-dist` 的 `legacy/build/pdf.min.js`、`pdf.worker.min.js` 与 `cmaps/` 原样拷进
 *      `static/pdfjs/`（`dist` 根下的静态目录；不放进 `static/js` 是因为语法门禁
 *      `scripts/check-bundle-syntax.mjs` 扫的是 `static/js`，而这份产物的语法下限已由 #480 的
 *      静态扫描 + 真机矩阵单独背书）；
 *   2. 把「版本 + 静态路径」注入成 `__PDFJS_ASSET__`，运行期只从这一个常量读（换版本改 package.json）。
 * 文件清单/目录名的唯一来源是 `config/pdfjs.json`。
 */
const pdfjsAsset = JSON.parse(readFileSync(new URL('./config/pdfjs.json', import.meta.url), 'utf8')) as {
  packagePath: string
  assetDir: string
  script: string
  worker: string
  cmapsDir: string
}

/** pdfjs 版本以**实际安装的包**为准（单一来源是 package.json 的依赖版本），读不到时记 unknown */
const readPdfjsVersion = (): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL(`./${pdfjsAsset.packagePath}/package.json`, import.meta.url), 'utf8')
    ) as { version?: string }
    return manifest.version?.trim() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 老账号额度迁移（#498）的**构建期 fail-fast**。
 *
 * 只拦一种情况：**开关打开了，但请求发不出去**。因为运行时对配置的态度是「不合法就当关闭」，
 * 一个空的 / 拼错的 `baseUrl` 在运行时只会表现为「什么都没发生」—— 那是本项目最贵的一类假红
 * （配置生效了没？没人答得上来）。所以把「开了就必须能发」提前到构建期，报错里带键名。
 *
 * 开关关着（默认）时**一条都不校验**：`baseUrl: ""` 是配档里的默认值，不该拦住正常出包。
 * 这段与 `src/legacy/migration/claim.ts` 的 `readMigrationConfig` 判据同源（那边是运行时收窄，
 * 这里是构建期拦截）；删这条尾巴时，这一段与 DefinePlugin 里的 `migration` 字段一起删。
 */
const assertMigrationConfig = (migration: { enabled: boolean; baseUrl: string; endpoint: string; timeoutMs: number }): void => {
  if (migration.enabled !== true) {
    return
  }
  const problems: string[] = []
  const baseUrl = typeof migration.baseUrl === 'string' ? migration.baseUrl.trim() : ''
  if (baseUrl === '') {
    problems.push('migration.baseUrl 为空：migration.enabled=true 时必须给出迁移服务的地址')
  } else {
    let parsed: URL | null = null
    try {
      parsed = new URL(baseUrl)
    } catch {
      parsed = null
    }
    if (parsed === null) {
      problems.push(`migration.baseUrl 不是合法的绝对 URL：${JSON.stringify(migration.baseUrl)}`)
    } else {
      // 生产必须 https（#498 §六 第 2 条）；唯一例外是本机回环，给本地联调自建的迁移服务用
      const loopback =
        parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        problems.push(`migration.baseUrl 必须是 https（明文 http 只允许本机回环）：${baseUrl}`)
      }
      if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
        problems.push(`migration.baseUrl 只能是「协议://主机[:端口]」，路径由 endpoint 拼：${baseUrl}`)
      }
    }
  }
  if (typeof migration.endpoint !== 'string' || !migration.endpoint.startsWith('/')) {
    problems.push(`migration.endpoint 必须以 / 开头：${JSON.stringify(migration.endpoint)}`)
  }
  if (!Number.isInteger(migration.timeoutMs) || migration.timeoutMs <= 0) {
    problems.push(`migration.timeoutMs 必须是正整数（毫秒）：${JSON.stringify(migration.timeoutMs)}`)
  }
  if (problems.length > 0) {
    throw new Error(`config/endpoints.json 的 migration 段不合法：\n  - ${problems.join('\n  - ')}`)
  }
}

assertMigrationConfig(endpoints.migration)

/**
 * 构建期注入的版本号优先级：环境变量 APP_VERSION > package.json 的 version。
 * 环境变量留给出包脚本（CI 传 tag 名）覆盖，本地构建直接吃 package.json —— 这是唯一权威来源。
 */
const appVersion = process.env.APP_VERSION?.trim() || readVersionName()

/**
 * 产物自述文件（build-info.json）：写进输出目录的 variant / main hash / 构建时间 / 版本。
 *
 * 为什么需要：测试（tests/helpers/env.mjs）要能判断「dist 里这份产物是标准包还是内测包、
 * 是不是比源码旧、端口上 serve 的是不是同一份」。没有它就只能靠猜，于是出现
 * 「拿标准包跑内测用例」「5181 端口 serve 的是别的分支产物」这类假红（Issue #19）。
 * 只写一个静态 JSON，不影响运行时代码与部署。
 */
const buildInfoPlugin = (variant: 'standard' | 'internal', version: string, outPath: string) => ({
  apply(compiler: {
    hooks: { afterEmit: { tapAsync: (name: string, handler: (compilation: unknown, callback: () => void) => void) => void } }
  }) {
    compiler.hooks.afterEmit.tapAsync('BuildInfoPlugin', (_compilation: unknown, callback: () => void) => {
      try {
        const out = path.resolve(root, outPath)
        const mainFile =
          readdirSync(path.join(out, 'static', 'js')).find((name) => /^main\.[a-z0-9]+\.js$/.test(name)) ?? ''
        writeFileSync(
          path.join(out, 'build-info.json'),
          `${JSON.stringify(
            {
              variant,
              main: mainFile,
              hash: /^main\.([a-z0-9]+)\.js$/.exec(mainFile)?.[1] ?? null,
              version,
              builtAt: new Date().toISOString(),
            },
            null,
            2
          )}\n`
        )
      } catch {
        // 写不出来不影响构建（测试会按「没有自述文件」降级判断）
      }
      callback()
    })
  },
})

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /**
   * 内测构建：注入 __INTERNAL_BUILD__=true，服务地址 / 模型 / 服务类型由
   * src/services/api/internalBuild.ts 的常量钉死（设置页不再暴露这三项的编辑入口）。
   * 默认 false：正式构建行为与之前完全一致。
   */
  internalBuild?: boolean
  /** 输出目录（默认 dist；cap sync 只认 dist） */
  outputPath?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  internalBuild = process.env.INTERNAL_BUILD === '1',
  // 默认 dist；测试要在不影响部署产物（dist）的前提下另起一份标准构建时用 DIST_OUT 指定
  outputPath = process.env.DIST_OUT || 'dist',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  // 运行时代码（chunk 加载、模块注册表）按 browserslist 的目标生成，不能比业务代码更“新”
  target: 'browserslist',
  output: {
    path: path.resolve(root, outputPath),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      {
        // 第三方依赖默认按原样进产物。唯一例外是 mermaid（含 @mermaid-js/*）：它的 dist 是 ES2022 产物，含
        // `static {}` 类静态块（Chrome 94+），WebView 83 一加载它的异步 chunk 就 SyntaxError，
        // 所有图表全挂（issue #13 的次生问题）。这里只对 mermaid 做同样的语法降级。
        test: /\.m?js$/,
        // 注意 @mermaid-js/parser 也带类静态块（langium 生成的语法文件），别漏
        include: /[\\/]node_modules[\\/](@mermaid-js[\\/]|mermaid[\\/])/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'ecmascript' },
            // 内联 helper：异步 chunk 里不额外 import @swc/helpers
            externalHelpers: false,
          },
          env: { targets },
        },
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': appVersion },
    }),
    new rspack.DefinePlugin({
      // 登录接缝（#510）：默认注入 `undefined` —— 见上方 `testAuthSeam` 的说明；
      // 真值只在 `TEST_AUTH_SEAM=1` 的测试构建里出现（假 token 是产物扫描的拦截标记）。
      __TEST_AUTH_STATE__: testAuthSeam ? JSON.stringify(SEAM_SESSION) : 'undefined',
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __INTERNAL_BUILD__: JSON.stringify(internalBuild),
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_VERSION_CODE__: JSON.stringify(readVersionCode()),
      // 服务端端点（config/endpoints.json）：源码里只用 __ENDPOINTS__.chatBaseUrl 这类写法
      __ENDPOINTS__: JSON.stringify({
        chatBaseUrl: endpoints.chatBaseUrl,
        inviteBaseUrl: endpoints.inviteBaseUrl,
        feedbackUrl: endpoints.feedbackUrl,
        legacyHosts: endpoints.legacyHosts,
        // 分发地址（Issue #269）：源码只写 __ENDPOINTS__.dlPrimaryBase，打包前替换一次
        dlPrimaryBase: endpoints.download.primaryBase,
        dlFallbackBase: endpoints.download.fallbackBase,
        // 消费侧 / 支付侧（#484 W1-A）：src/services/consume/** 只从这两组里取地址、前缀与超时，
        // 源码里不许再出现任何后端地址或毫秒数（pnpm check:consume-api 会拦）。
        consume: {
          baseUrl: endpoints.consume.baseUrl,
          apiV1Prefix: endpoints.consume.apiV1Prefix,
          gatewayPrefix: endpoints.consume.gatewayPrefix,
          timeoutMs: endpoints.consume.timeoutMs,
        },
        pay: {
          baseUrl: endpoints.pay.baseUrl,
          timeoutMs: endpoints.pay.timeoutMs,
        },
        // 老账号额度迁移（#498 的临时尾巴）：整组原样注入（开关 + base + endpoint + 超时），
        // 客户端只从 __ENDPOINTS__.migration 读，源码里不许出现迁移服务的地址或毫秒数。
        // 删这条尾巴时删掉这一行（README 的「删除方法」第 3 步）。
        migration: endpoints.migration,
      }),
      // PDF 文本解析（#480）：版本 + 静态路径注入，运行期只读 __PDFJS_ASSET__（见 pdfLoader.ts）
      //
      // `script` / `worker` 注入的是**产物里的文件名**（`path.basename`），不是包装内的相对路径。
      // 运行期按 `assetDir/script` 拼地址（`pdfAssetUrl`），而下面 CopyRspackPlugin 拷的正是
      // `path.basename(...)` —— 两边口径必须一致，否则浏览器会去取
      // `static/pdfjs/legacy/build/pdf.min.js`（404），PDF 解析在真产物里整篇失败：
      // 脚本 404 → `libUnavailable`；worker 404 → pdfjs 退回 fake worker → `openFailed`。
      // 这条链路只在**真产物**里才走得通（L0 用例换的是 node 侧加载口），所以由
      // `docs/ui/480-attachments` 的浏览器截图首次发现，见 acceptance-480.md「未覆盖项 / 已修」。
      __PDFJS_ASSET__: JSON.stringify({
        version: readPdfjsVersion(),
        assetDir: pdfjsAsset.assetDir,
        script: path.basename(pdfjsAsset.script),
        worker: path.basename(pdfjsAsset.worker),
        cmapsDir: pdfjsAsset.cmapsDir,
      }),
    }),
    buildInfoPlugin(internalBuild ? 'internal' : 'standard', appVersion, outputPath),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        // pdfjs 产物按原样进静态目录（不做语法降级：它是已降级过的 ES2018 UMD，见 pdfLoader.ts）
        {
          from: path.resolve(root, pdfjsAsset.packagePath, pdfjsAsset.script),
          to: `${pdfjsAsset.assetDir}/${path.basename(pdfjsAsset.script)}`,
          toType: 'file',
        },
        {
          from: path.resolve(root, pdfjsAsset.packagePath, pdfjsAsset.worker),
          to: `${pdfjsAsset.assetDir}/${path.basename(pdfjsAsset.worker)}`,
          toType: 'file',
        },
        // 中文 PDF 的预定义 CMap（1.7 MB）：缺了取不到 CJK 文本，换不来就别省
        {
          from: path.resolve(root, pdfjsAsset.packagePath, pdfjsAsset.cmapsDir),
          to: `${pdfjsAsset.assetDir}/${pdfjsAsset.cmapsDir}`,
        },
      ],
    }),
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
