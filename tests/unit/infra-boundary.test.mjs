// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 客户端基础设施规范 §2/§8：原生调用只经各模块 native/ Adapter。
// - src/services/{capability,fs,storage,protection}/ 下 native/ 以外的文件：不 import @capacitor/*、
//   不含 isNativePlatform / getPlatform / registerPlugin；
// - src/services/{fs,storage}/** 不 import react、zustand、components、app、i18n。
// 目录不存在（该模块还没合进当前分支）时跳过该目录并明说，不当作通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers/dom-env.mjs'

const MODULES = ['capability', 'fs', 'storage', 'protection']
const PURE_MODULES = ['fs', 'storage']

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const sourceFiles = (module) => {
  const dir = path.join(ROOT, 'src/services', module)
  return existsSync(dir) ? walk(dir).filter((file) => /\.(ts|tsx)$/u.test(file)) : undefined
}

const insideNative = (file) => file.split(path.sep).includes('native')

/** 去掉注释，避免文档里提到 `getPlatform` 被误判；只看代码 */
const code = (file) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')

const importSpecifiers = (text) =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)].map((match) => match[1])

const FORBIDDEN_CALLS = /\b(isNativePlatform|getPlatform|registerPlugin)\b/u
const FORBIDDEN_UI = /(^|\/)(react|react-dom|zustand)(\/|$)|(^|\/)(components|app|i18n)(\/|$)/u

for (const module of MODULES) {
  test(`${module}/：native/ 以外不碰 @capacitor/* 与平台判断`, (context) => {
    const files = sourceFiles(module)
    if (!files) {
      context.diagnostic(`src/services/${module}/ 不存在，跳过（未验证）`)
      return
    }
    const offenders = []
    for (const file of files.filter((candidate) => !insideNative(candidate))) {
      const text = code(file)
      const rel = path.relative(ROOT, file)
      if (importSpecifiers(text).some((spec) => spec.startsWith('@capacitor/'))) {
        offenders.push(`${rel}: import @capacitor/*`)
      }
      const hit = text.match(FORBIDDEN_CALLS)
      if (hit) {
        offenders.push(`${rel}: ${hit[0]}`)
      }
    }
    assert.deepEqual(offenders, [])
  })
}

for (const module of PURE_MODULES) {
  test(`${module}/：不 import react / zustand / components / app / i18n`, (context) => {
    const files = sourceFiles(module)
    if (!files) {
      context.diagnostic(`src/services/${module}/ 不存在，跳过（未验证）`)
      return
    }
    const offenders = []
    for (const file of files) {
      for (const spec of importSpecifiers(code(file))) {
        if (FORBIDDEN_UI.test(spec)) {
          offenders.push(`${path.relative(ROOT, file)}: ${spec}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })
}

test('自检：扫描器能抓到违规（负向对照）', () => {
  assert.ok(importSpecifiers(`import { x } from '@capacitor/core'`).some((spec) => spec.startsWith('@capacitor/')))
  assert.ok(FORBIDDEN_CALLS.test('if (Capacitor.getPlatform() === "android") {}'))
  assert.ok(FORBIDDEN_UI.test('../../components/Foo.js'))
  assert.ok(FORBIDDEN_UI.test('react'))
  assert.ok(!FORBIDDEN_UI.test('./types.js'))
  assert.ok(!FORBIDDEN_CALLS.test(code(path.join(ROOT, 'src/services/fs/index.ts'))))
})
