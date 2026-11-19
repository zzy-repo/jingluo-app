// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #314
//
// 缺 key 不再抛 TypeError（以前是 `Cannot read properties of undefined (reading 'replace')`，
// 错误里没有 key 名，整页还会被 ErrorBoundary 换掉），并且必须留下**带 key 名**的结构化日志。
//
//   node tests/unit/i18n-missing-key.test.mjs
//
// 覆盖：
//   [1] 缺 key：不抛错、返回中文兜底（不借 en 原文）、一条 warning + i18nKey/locale/reason
//   [2] 30 分钟去重：同一 key 连调 50 次只留 1 条
//   [3] 缺占位符：保留 {total} 不崩，记 missing_param，只记参数名不记值
//   [4] 不可信来源（跨版本 localMessage / 归档 reason / 注入 toast）：先校验再查表
//   [5] 导入跳过明细：未知 reason 不再 `as TranslationKey` 直接查表，给专用兜底文案
import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { MISSING_TEXT, translate, translateUntrusted, whenI18nReportsReady } =
  await import('../../src/i18n/index.ts')
const { clearLogs, getSnapshot } = await import('../../src/services/diagnostics/collector.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { ImportSkippedDetails } = await import('../../src/components/settings/importSkipped.ts')
const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

useSettings.setState({ locale: 'zh-CN' })

/** 触发一次记录之后等懒加载的采集通道落地（i18n 刻意不在顶层静态 import collector） */
const settle = async () => {
  await whenI18nReportsReady()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const hitsOf = (predicate) => getSnapshot().logs.filter(predicate)
const missingKeyHits = (key) =>
  hitsOf((entry) => entry.meta?.reason === 'missing_key' && entry.meta?.i18nKey === key)

test('缺 key 不抛错：返回中文兜底，并留下带 key 名的 warning', async () => {
  await clearLogs()
  let output = ''
  assert.doesNotThrow(() => {
    output = translate('noSuchKeyFromOldBuild')
  })
  assert.equal(output, MISSING_TEXT)
  // 正式包不许把 key 名端给用户，也不许借 en 原文顶上
  assert.ok(!output.includes('⟦missing:'), `正式包不应出现内测占位：${output}`)
  assert.notEqual(output, 'Cancel')

  await settle()
  const hits = missingKeyHits('noSuchKeyFromOldBuild')
  assert.equal(hits.length, 1, '缺 key 必须有且只有一条记录')
  const entry = hits[0]
  assert.equal(entry.kind, 'warning')
  assert.equal(entry.level, 'warn')
  assert.equal(entry.msg, 'i18n key missing')
  assert.equal(entry.meta.stage, 'i18n')
  assert.equal(entry.meta.locale, 'zh-CN')
  assert.ok(
    Object.keys(entry.meta).length >= 2,
    `meta 至少 2 个键（MIN_META_KEYS），实际 ${JSON.stringify(entry.meta)}`
  )
})

test('30 分钟去重：同一个 key 连调 50 次只留 1 条', async () => {
  await clearLogs()
  for (let index = 0; index < 50; index += 1) {
    assert.equal(translate('noSuchKeySpam'), MISSING_TEXT)
  }
  await settle()
  assert.equal(missingKeyHits('noSuchKeySpam').length, 1)
})

test('缺占位符：保留 {total} 不崩，只记参数名不记值', async () => {
  await clearLogs()
  const output = translate('oursTrailCount', {})
  // zh 的 oursTrailCount 是 `共 {total} 笔`：没传参会原样保留占位符，而不是静默变成空串
  assert.equal(output, '共 {total} 笔')
  await settle()
  const hits = hitsOf((entry) => entry.meta?.reason === 'missing_param')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].msg, 'i18n param missing')
  assert.equal(hits[0].meta.i18nKey, 'oursTrailCount')
  assert.equal(hits[0].meta.param, 'total')
  assert.ok(!JSON.stringify(hits[0].meta).includes('undefined'))
})

test('不可信 key 先校验：认识的照常翻译，不认识的兜底 + 上报', async () => {
  await clearLogs()
  assert.equal(translateUntrusted('cancel'), '取消')
  const output = translateUntrusted('legacyReasonFromArchive')
  assert.equal(output, MISSING_TEXT)
  await settle()
  assert.equal(missingKeyHits('legacyReasonFromArchive').length, 1)
})

test('导入跳过明细：未知 reason 不再当 key 查表，给专用兜底文案', async () => {
  await clearLogs()
  const entry = {
    scope: 'message',
    sessionId: 's1',
    sessionTitle: '会话',
    messageId: 'm1',
    parentId: null,
    reason: 'reasonFromAnotherVersion',
  }
  let html = ''
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup(
      createElement(ImportSkippedDetails, {
        skipped: [entry],
        t: (key, params) => translate(key, params),
      })
    )
  })
  assert.match(html, /未识别的跳过原因/)
  await settle()
  assert.equal(missingKeyHits('reasonFromAnotherVersion').length, 1)
})
