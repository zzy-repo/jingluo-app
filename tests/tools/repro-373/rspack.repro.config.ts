/**
 * REPRO ONLY（Issue #373）：只构建 repro harness（不存在于产品产物里）。
 *
 *   node_modules/.bin/rspack build -c tests/tools/repro-373/rspack.repro.config.ts
 *
 * 与仓库主配置的差别只有三处：单一 entry、输出到 tests/tools/repro-373/out、
 * `@capacitor/core` 被 alias 到本目录里的 mock。其它（swc / CSS Modules / Define）照抄，
 * 否则组件源码（模块 CSS、诊断字段）编译不过。
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
}

const config: Configuration = {
  mode: 'development',
  entry: path.join(here, 'harness.tsx'),
  target: 'web',
  output: {
    path: path.join(here, 'out'),
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
      }),
    }),
  ],
  performance: { hints: false },
}

export default config
