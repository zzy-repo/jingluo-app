/**
 * 域10 N5 harness 的构建配置（**不进产品产物**）。
 *
 *   HARNESS_DIST=<输出目录> node node_modules/@rspack/cli/bin/rspack.js build -c tests/fixtures/domain10/rspack.harness.config.ts
 *
 * 与仓库主配置（rspack.config.ts）的差别只有三处：
 *   1. 单一 entry —— 只挂 `AppUpdateField`，不是整站；
 *   2. `@capacitor/core` alias 到本目录的 `capacitor-mock.ts`（原生 AppUpdate 插件 → 可编排的桥）；
 *   3. 输出目录由 HARNESS_DIST 指定（用例给一个 mkdtemp 目录，跑完即删，仓库里不留 dist-*）。
 * 其余（swc / CSS Modules / Define）照抄主配置，否则组件里的模块 CSS 与诊断字段编译不过。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack, type Configuration } from '@rspack/core'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: string
  androidVersionCode?: number
  browserslist?: string[]
}
const endpoints = JSON.parse(readFileSync(path.join(root, 'config/endpoints.json'), 'utf8')) as {
  chatBaseUrl: string
  inviteBaseUrl: string
  feedbackUrl: string
  legacyHosts: string[]
  /** 分发地址（Issue #269）：updateManifest.ts 顶层读 __ENDPOINTS__.dl*，缺了就是 undefined base */
  download: { primaryBase: string; fallbackBase: string }
}

const config: Configuration = {
  mode: 'development',
  entry: path.join(here, 'harness.tsx'),
  target: 'web',
  output: {
    path: process.env.HARNESS_DIST || path.join(root, 'dist-domain10-harness'),
    publicPath: 'auto',
    filename: 'harness.js',
    cssFilename: 'harness.css',
    clean: true,
  },
  devtool: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    alias: { '@capacitor/core': path.join(here, 'capacitor-mock.ts') },
  },
  module: {
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module' },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css' },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: true } },
            externalHelpers: true,
          },
          env: { targets: pkg.browserslist?.length ? pkg.browserslist : ['chrome >= 83'] },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    new rspack.HtmlRspackPlugin({ template: path.join(here, 'index.html'), scriptLoading: 'defer' }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify('https://api.deepseek.com'),
      __INTERNAL_BUILD__: JSON.stringify(false),
      __APP_VERSION__: JSON.stringify(pkg.version ?? '1.4.0-beta.10'),
      __APP_VERSION_CODE__: JSON.stringify(Number(pkg.androidVersionCode ?? 17)),
      __ENDPOINTS__: JSON.stringify({
        chatBaseUrl: endpoints.chatBaseUrl,
        inviteBaseUrl: endpoints.inviteBaseUrl,
        feedbackUrl: endpoints.feedbackUrl,
        legacyHosts: endpoints.legacyHosts,
        dlPrimaryBase: endpoints.download.primaryBase,
        dlFallbackBase: endpoints.download.fallbackBase,
      }),
    }),
  ],
  performance: { hints: false },
}

export default config
