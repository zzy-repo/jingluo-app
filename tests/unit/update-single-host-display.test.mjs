// [layer: unit | 依赖: 无（纯 Node + 真 updateManifest/updateReport + 源码接线断言，零网络） | 耗时: <1s]
/**
 * 「检查更新」界面只呈现一个（主）更新地址；备用地址（旧版本只认的那台）不上界面，只留在诊断报告里。
 *
 * 这条只管「显示什么」。真实地址与回退顺序不许动：RELEASE_BASES 的内容与顺序在这里钉死，
 * 失败回退的行为由既有用例（app-update / private-manifest-622 / releases-manifest-buildtype 等）继续钉。
 * 取值全部来自 __ENDPOINTS__（config/endpoints.json 经构建注入），不写死字面量。
 */
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

const { RELEASE_BASES, PRIMARY_RELEASE_BASE, FALLBACK_RELEASE_BASE } = await import(
  '../../src/services/updateManifest.ts'
)
const { buildUpdateReport, hostOf, releaseHosts, primaryReleaseHost } = await import(
  '../../src/services/updateReport.ts'
)

const primaryHost = new URL(__ENDPOINTS__.dlPrimaryBase).host
const fallbackHost = new URL(__ENDPOINTS__.dlFallbackBase).host

test('① RELEASE_BASES 内容与顺序未改：长度 2，先主后备，值来自 __ENDPOINTS__', () => {
  assert.equal(RELEASE_BASES.length, 2)
  assert.equal(RELEASE_BASES[0], __ENDPOINTS__.dlPrimaryBase)
  assert.equal(RELEASE_BASES[1], __ENDPOINTS__.dlFallbackBase)
  assert.equal(PRIMARY_RELEASE_BASE, __ENDPOINTS__.dlPrimaryBase)
  assert.equal(FALLBACK_RELEASE_BASE, __ENDPOINTS__.dlFallbackBase)
  assert.notEqual(primaryHost, fallbackHost, '主备必须是两台不同的机器，否则这组断言没有意义')
  // releaseHosts() 的签名与返回值保持原样（旧用例依赖）
  assert.equal(releaseHosts(), `${primaryHost} → ${fallbackHost}`)
})

test('② 界面用的函数只返回主机名一个，不含备用主机名', () => {
  const shown = primaryReleaseHost()
  assert.equal(shown, primaryHost)
  assert.equal(shown.includes(fallbackHost), false)
  assert.equal(shown.includes('→'), false)
})

test('③ AppUpdateField 接线：界面改用 primaryReleaseHost，不再直接渲染 releaseHosts()，页面文案无备用主机名', () => {
  const src = readFileSync(new URL('../../src/components/settings/AppUpdateField.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('<dd>{primaryReleaseHost()}</dd>'), '「更新服务」一行应渲染 primaryReleaseHost()')
  assert.equal(/\breleaseHosts\b/.test(src), false, '组件里不许再引用 releaseHosts（它会把主备并排）')
  assert.equal(src.includes('RELEASE_BASES'), false, '组件不直接遍历 RELEASE_BASES 来显示')
  assert.equal(src.includes(fallbackHost), false, '组件源码里不写备用主机名字面量')
  assert.equal(src.includes('FALLBACK_RELEASE_BASE'), false, '组件不引用备用地址常量')
  // 失败提示（updateFailure 的用户可见句子）不拼主机名
  const failure = readFileSync(new URL('../../src/services/updateFailure.ts', import.meta.url), 'utf8')
  assert.equal(failure.includes(fallbackHost), false)
  assert.equal(failure.includes('RELEASE_BASES'), false)
})

test('④ 诊断报告里主与备都在，且写明备是兼容旧版本', () => {
  const report = buildUpdateReport({ version: '1.0.0', channel: 'stable', native: false })
  assert.ok(report.includes(primaryHost), report)
  assert.ok(report.includes(fallbackHost), report)
  assert.ok(report.includes(`主 ${primaryHost}`), report)
  assert.ok(report.includes(`备（兼容旧版本）${fallbackHost}`), report)
  assert.equal(report.includes('→'), false, '不再用箭头把两个写成并列')
  assert.ok(report.indexOf(primaryHost) < report.indexOf(fallbackHost), '主在前')
  assert.equal(hostOf(PRIMARY_RELEASE_BASE), primaryHost)
})
