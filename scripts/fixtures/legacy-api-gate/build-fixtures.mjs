#!/usr/bin/env node
// 用真实 rspack + chrome 83 目标构建 issue #39 的对照产物（不跑整包 build，内存友好）。
//
// 产物形状与 dist 一致：<out>/<fixture>/static/js/<name>.js + <out>/<fixture>/index.html，
// 这样 scripts/check-bundle-syntax.mjs 的入口脚本判定逻辑是被真实验证的，不是桩。
//
//   node scripts/fixtures/legacy-api-gate/build-fixtures.mjs .repro39/fixtures
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'
import { productBrowserslist } from '../../lib/compatBaseline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..', '..')

/**
 * 语法下限：**直接吃真实构建用的那一份** package.json browserslist（`productBrowserslist()`
 * 顺带断言它没和唯一来源 config/compat.json 漂开）。
 *
 * 以前这里写死 `['chrome >= 83']`（issue #276）：夹具绕开唯一来源自己写一份数字，于是抬下限时
 * 产品按 91 构建、夹具还按 83 构建 —— `check:legacy` 照样绿，但它量的不是线上那个东西。
 */
const TARGETS = productBrowserslist()

/** 四个对照产物：干净 / 有 polyfill 的裸调用 / 漏打 polyfill / 没有补丁覆盖的 API */
export const FIXTURES = [
  { name: 'clean', entry: 'clean.ts' },
  { name: 'covered-with-polyfill', entry: 'covered-with-polyfill.ts' },
  { name: 'covered-without-polyfill', entry: 'covered-without-polyfill.ts' },
  { name: 'uncovered-replaceall', entry: 'uncovered-replaceall.ts' },
]

const createCompiler = (fixture, outDir) =>
  rspack({
    mode: 'production',
    context: ROOT,
    devtool: false,
    entry: { [fixture.name]: path.join(HERE, fixture.entry) },
    // 与 rspack.config.ts 一致：语法下限只由 package.json 的 browserslist 决定（见上面的 TARGETS）
    target: 'browserslist',
    output: {
      path: path.join(outDir, fixture.name),
      filename: 'static/js/[name].js',
      chunkFilename: 'static/js/async/[name].js',
      publicPath: 'auto',
      clean: true,
    },
    optimization: { minimize: false, splitChunks: false, runtimeChunk: false },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      rules: [
        {
          test: /\.(j|t)sx?$/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: { parser: { syntax: 'typescript', tsx: false } },
            env: { targets: TARGETS },
          },
          type: 'javascript/auto',
        },
      ],
    },
  })

const buildOne = (fixture, outDir) =>
  new Promise((resolve, reject) => {
    const compiler = createCompiler(fixture, outDir)
    compiler.run((error, stats) => {
      const close = () => {
        if (error) return reject(error)
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
        const dir = path.join(outDir, fixture.name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          path.join(dir, 'index.html'),
          `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${fixture.name}</title></head>\n<body><div id="root"></div>\n<script src="/static/js/${fixture.name}.js"></script>\n</body></html>\n`
        )
        resolve({ name: fixture.name, dir })
      }
      compiler.close(() => close())
    })
  })

/** 构建全部对照产物，返回 [{name, dir}] */
export const buildFixtures = async (outDir) => {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const built = []
  for (const fixture of FIXTURES) built.push(await buildOne(fixture, outDir))
  return built
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const outDir = path.resolve(ROOT, process.argv[2] ?? '.repro39/fixtures')
  const built = await buildFixtures(outDir)
  for (const item of built) console.log(`${item.name} -> ${path.relative(ROOT, item.dir)}`)
}
