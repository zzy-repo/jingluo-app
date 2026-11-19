// [layer: unit | dependencies: none | no build, browser, network or Android]
/**
 * #310：检查更新失败的分类与文案。
 *
 * 这一层是纯函数，所以文案可以被真正钉住：**哪一类失败说哪一句话**、**可重试 / 不可重试**、
 * **不许把内部细节（地址 / 堆栈 / 上游大段 message）漏进用户能看到的那句话**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})
const { classifyUpdateError, describeUpdateFailure, describeUpToDate, updateFailureOf } =
  await import('../../src/services/updateFailure.ts')
const { buildUpdateReport, hostOf, releaseHosts } = await import(
  '../../src/services/updateReport.ts'
)

const ctx = { channel: '稳定版与预发布版', version: '1.4.0-beta.10' }
const view = (error) => describeUpdateFailure(classifyUpdateError(error), ctx)

test('断网 / 分发机不可达 → network，且文案说可重试', () => {
  for (const error of [
    new TypeError('fetch failed'),
    new TypeError('Failed to fetch'),
    new Error('MANIFEST_NETWORK'),
    Object.assign(new Error('x'), { name: 'TimeoutError' }),
  ]) {
    const result = view(error)
    assert.equal(result.kind, 'network', String(error))
    assert.equal(result.retryable, true)
    assert.match(result.text, /更新服务不可达/)
    assert.match(result.text, /重新检查/)
    assert.equal(result.code === 'MANIFEST_NETWORK' || result.code === 'NETWORK_UNREACHABLE' || result.code === 'TIMEOUT', true, result.code)
  }
})

test('更新服务回 404 / 502 → service：状态码进文案，但 4xx 不引导重试、5xx 才引导', () => {
  const missing = view(new Error('MANIFEST_HTTP_404'))
  assert.equal(missing.kind, 'service')
  assert.equal(missing.retryable, false)
  assert.match(missing.text, /更新服务返回错误/)
  assert.match(missing.text, /HTTP 404/)
  assert.match(missing.text, /复制诊断信息/)

  const broken = view(new Error('MANIFEST_HTTP_502'))
  assert.equal(broken.kind, 'service')
  assert.equal(broken.retryable, true, '5xx 是分发机临时出错，重试有意义')
  assert.match(broken.text, /HTTP 502/)
  assert.match(broken.text, /重新检查/)
  // 与「连不上」必须能分开：这正是 issue #310 验收里的 404 用例
  assert.notEqual(missing.text, view(new TypeError('fetch failed')).text)
})

test('清单 200 但不是合法 JSON / 记录不合法 → manifest，且文案明说不会靠重试好转', () => {
  let thrown
  try {
    JSON.parse('{"releases": [ {"version": "1.5.0", ')
  } catch (error) {
    thrown = error
  }
  for (const [error, code] of [
    [thrown, 'INVALID_JSON'],
    [new Error('INVALID_MANIFEST'), 'INVALID_MANIFEST'],
    [new Error('INVALID_RELEASE'), 'INVALID_RELEASE'],
    [new Error('INVALID_APK_URL'), 'INVALID_APK_URL'],
  ]) {
    const result = view(error)
    assert.equal(result.kind, 'manifest', code)
    assert.equal(result.code, code)
    assert.equal(result.retryable, false)
    assert.match(result.text, /版本信息无法解析/)
    assert.match(result.text, /复制诊断信息/, '不可重试时要给出反馈出口')
  }
  // 断网（network）与数据坏了（manifest）必须是两句话：这是本单的核心区别
  assert.notEqual(view(new TypeError('fetch failed')).text, view(thrown).text)
})

test('签名 / 校验不符 → integrity；下载中断 → download，两者可重试性不同', () => {
  for (const code of ['HASH_MISMATCH', 'SIZE_MISMATCH', 'SIGNATURE_MISMATCH', 'PACKAGE_MISMATCH']) {
    const result = view(new Error(code))
    assert.equal(result.kind, 'integrity', code)
    assert.equal(result.retryable, false, `${code} 不该引导用户反复重下`)
    assert.match(result.text, /安装包校验未通过/)
  }
  for (const code of ['DOWNLOAD_INTERRUPTED', 'DOWNLOAD_HTTP', 'INSUFFICIENT_STORAGE']) {
    const result = view(new Error(code))
    assert.equal(result.kind, 'download', code)
    assert.equal(result.retryable, true, `${code} 属于传输问题`)
    assert.match(result.text, /下载未完成/)
  }
})

test('无可用版本 / 已取消 / 环境缺渠道 各有独立说法，且不冒充故障', () => {
  const upToDate = describeUpToDate({ ...ctx, incomplete: 0 })
  assert.equal(upToDate.kind, 'no-version')
  assert.match(upToDate.text, /暂无可用版本/)
  assert.match(upToDate.text, /1\.4\.0-beta\.10/, '无新版必须显示当前版本号')
  assert.doesNotMatch(upToDate.text, /重新检查|反馈/, '没新版不是故障，不该引导重试或反馈')

  const partial = describeUpToDate({ ...ctx, incomplete: 3 })
  assert.match(partial.text, /3 条发布记录缺少渠道或 SHA256/, partial.text)
  assert.doesNotMatch(partial.text, /」\s/, '中文之间不要出现多余空格')

  const cancelled = view(Object.assign(new Error('Cancelled'), { name: 'AbortError' }))
  assert.equal(cancelled.kind, 'cancelled')
  assert.match(cancelled.text, /已取消/)

  const env = view(new Error('VARIANT_MISSING'))
  assert.equal(env.kind, 'env')
  assert.equal(env.retryable, false)
  assert.match(env.text, /缺少渠道标识/)
})

test('表外的异常归 unknown（不许猜成网络或数据问题）', () => {
  assert.equal(classifyUpdateError(undefined).kind, 'unknown')
  assert.equal(classifyUpdateError('随便一句中文').kind, 'unknown')
  assert.equal(classifyUpdateError(new RangeError('boom')).kind, 'unknown')
  assert.equal(updateFailureOf('NOT_A_REAL_CODE').kind, 'unknown')
  assert.equal(updateFailureOf('HASH_MISMATCH').kind, 'integrity')
})

test('用户可见的那句话里不许出现地址、协议头、堆栈或 Error 前缀', () => {
  const errors = [
    new TypeError('fetch failed: http://62.106.70.167:8888/releases.json'),
    new Error('INVALID_RELEASE'),
    new Error('HASH_MISMATCH'),
    new Error('下载失败 https://dl.rose7.cn/apk/x.apk?token=secret'),
  ]
  for (const error of errors) {
    const result = view(error)
    for (const banned of ['http://', 'https://', '62.106.70.167', 'dl.rose7.cn', 'token=', '    at ', 'Error:']) {
      assert.equal(result.text.includes(banned), false, `${result.kind} 文案里出现了 ${banned}`)
    }
  }
})

test('诊断文本：字段齐、地址只到 host、上游短码与可重试性可判读', () => {
  const report = buildUpdateReport({
    version: '1.4.0-beta.10',
    versionCode: 17,
    channel: '稳定版与预发布版',
    native: false,
    checkedAt: Date.UTC(2026, 10, 19, 11, 2, 33),
    outcome: view(new Error('MANIFEST_NETWORK')).text,
    code: 'MANIFEST_NETWORK',
    base: 'https://dl.rose7.cn/apk/deepseek-chat-1.5.0.apk?token=leak',
  })
  for (const line of ['DeepSeek 应用内更新诊断', '版本: 1.4.0-beta.10 (17)', '渠道: 稳定版与预发布版', '通道: 网页预览', '上游短码: MANIFEST_NETWORK']) {
    assert.ok(report.includes(line), `缺少「${line}」\n${report}`)
  }
  assert.match(report, /2026-11-19T11:02:33\.000Z/)
  assert.match(report, /本次生效: dl\.rose7\.cn/, 'base 只保留 host')
  for (const banned of ['/apk/', 'releases.json', 'token=', '?']) {
    assert.equal(report.includes(banned), false, `诊断文本里出现了 ${banned}\n${report}`)
  }
  assert.equal(hostOf(undefined), 'unknown')
  assert.equal(hostOf('not a url'), 'unknown')
  assert.equal(releaseHosts(), '62.106.70.167:8888 → dl.rose7.cn')
})
