import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const root = path.dirname(fileURLToPath(import.meta.url))
// 版本号唯一来源：仓库根 package.json
//   version            → App versionName（也注入 __APP_VERSION__，诊断上报用）
//   androidVersionCode → App versionCode
// android/app/build.gradle 的 versionName / versionCode 就是从这里读的，发版只改这一处。
//   browserslist       → 构建语法下限（唯一来源，swc 与 lightningcss 都吃这一份，见下面 targets）
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
  androidVersionCode?: number
  browserslist?: string[]
}

/**
 * 构建语法下限，**唯一来源是 package.json 的 browserslist**，swc 与 lightningcss 都吃这一份。
 *
 * 为什么是 chrome 83（issue #13「低内核白屏」）：Android WebView 版本跟系统镜像走，App 管不了；
 * Android 11 出厂镜像停在 WebView 83.0.4103.106（Chromium 83）。之前是 chrome >= 105，swc 于是把
 * `||=` / `&&=` / `??=` 原样留在产物里 —— 那是 ES2021 语法（Chrome 85），WebView 83 解析 main.js
 * 第一行就抛 `Uncaught SyntaxError: Unexpected token '='`，整包不执行 = 静默白屏。
 * 降到 83 后产物只含 ES2020 语法（可选链/nullish 是 Chrome 80，能过）。
 * 运行时 API（Object.hasOwn / at / structuredClone …）不是语法问题，靠 src/polyfills/legacy.ts 补。
 */
const targets = pkg.browserslist?.length ? pkg.browserslist : ['chrome >= 83']
// tsc 只是类型检查（noEmit），不参与产物语法；产物语法只由这里的 targets + 下面的 output 环境决定。
if (!targets.some((target) => /^chrome\s*>=\s*83$/.test(target))) {
  // 有人把下限改回去了却没跑低内核验证 —— 构建时直接叫停，别等用户白屏才发现。
  throw new Error(`browserslist 缺少 Chrome 83 下限（当前：${targets.join(', ')}），见 issue #13`)
}

/** Android versionCode（诊断上报用，读不到记 0） */
const readVersionCode = (): number => Number(pkg.androidVersionCode ?? 0) || 0

/** App 版本名（诊断上报用） */
const readVersionName = (): string => pkg.version?.trim() ?? ''

/**
 * 构建期注入的版本号优先级：环境变量 APP_VERSION > package.json 的 version。
 * 环境变量留给出包脚本（CI 传 tag 名）覆盖，本地构建直接吃 package.json —— 这是唯一权威来源。
 */
const appVersion = process.env.APP_VERSION?.trim() || readVersionName()

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
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __INTERNAL_BUILD__: JSON.stringify(internalBuild),
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_VERSION_CODE__: JSON.stringify(readVersionCode()),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
