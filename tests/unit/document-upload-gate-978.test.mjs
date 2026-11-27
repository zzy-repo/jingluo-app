// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #978：默认内置渠道下所有文档附件必然上传失败 —— 发送路径上补「文档闸」的证据。
//
// **本文件不证明「文档能正常发出去」** —— 它只钉「闸装对了、判据只来自能力表」。端到端
// （默认渠道挂 DOCX 发送成功、出站 `paths.files` 命中 0 次）**未自动化，由设备侧 `AC-DOCX` 补**。
// 6/6 绿只说明这两件事成立，别把它读成「#978 已验证修好」。
//
// 本文件只钉两件事：能力表是唯一判据、闸确实装在上传循环里。
//   [绿 1] 四个已登记渠道 + 未知渠道 `documents.nativeFile` 全为 false
//          —— 「上传文档」这条通路在任何渠道都不存在，`ours` 只是唯一「放行文档又尝试上传」的组合
//   [绿 2] `ours`：`acceptsDocuments()` 为 true（发送闸放行）、`textInjection` 为 true（照旧注入）
//          —— 加闸之后文档不是被丢掉，而是走注入正常发出去
//   [绿 3] 接线：`prepareFiles` 从 `docInjectionFor()` 读文档能力，上传循环里有早退
//   [红→绿] 早退必须**排在 `ensureServerId()` 之前** —— 删掉闸这条件立刻不成立
//   [绿 4] 闸的判据里没有第二套渠道判断（不许 `=== 'ours'` 这类硬编码）
//   [绿 5] 修法没有顺手关掉注入：`textInjection` 分支与 `withRequestDocuments()` 都还在
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/document-upload-gate-978.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href)
    }
    return nextResolve(specifier, context)
  },
})

const { acceptsDocuments, docInjectionFor } = await import(
  '../../src/services/attachments/providerCapability.ts'
)

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/** 取 `[from, to)` 之间的源码；缺任一端直接失败，避免切片悄悄变空导致断言空转 */
const slice = (text, from, to) => {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  assert.ok(start >= 0, `切片起点不存在：${from}`)
  assert.ok(end > start, `切片终点不存在：${to}`)
  return text.slice(start, end)
}

const STORE = read('src/services/chat/store.ts')

/** 上传循环本体：从 `Promise.allSettled` 到 `Promise.race`，只含「本轮新文件要不要上传」的判定 */
const UPLOAD_LOOP = slice(
  STORE,
  'const uploads = Promise.allSettled(',
  'const results = await Promise.race('
)

test('[绿 1] 没有任何渠道支持「上传文档」—— nativeFile 全表为 false', () => {
  for (const kind of ['deepseek', 'anthropic', 'openai', 'ours']) {
    assert.equal(
      docInjectionFor(kind).nativeFile,
      false,
      `${kind} 的 documents.nativeFile 必须是 false：本仓库没有可用的原生文档上传实现`
    )
  }
  // 未知渠道 fail-closed，两条都不支持（原生上传同样为 false）
  assert.equal(docInjectionFor('unknown-channel').nativeFile, false)
})

test('[绿 2] ours：放行文档（注入）但绝不具备原生上传能力', () => {
  const caps = docInjectionFor('ours')
  assert.equal(caps.textInjection, true, 'ours 走文本注入')
  assert.equal(caps.nativeFile, false, 'ours 没有原生文档上传 —— 这就是 #978 的爆点')
  assert.equal(
    acceptsDocuments('ours'),
    true,
    'acceptsDocuments 为 true，所以发送闸放行、必然走到上传循环'
  )
})

test('[绿 3] 接线：能力从 docInjectionFor 读，上传循环里有文档早退', () => {
  assert.match(
    STORE,
    /const documents = docInjectionFor\(getCurrentSpec\(\)\.kind\)/,
    'prepareFiles 必须从能力表读文档能力，而不是自己判类型'
  )
  assert.match(
    UPLOAD_LOOP,
    /if \(!file\.isImage && !documents\.nativeFile\) \{\s*return\s*\}/,
    '上传循环必须有「本渠道没有原生文档上传实现 ⇒ 不上传」的早退'
  )
})

test('[红→绿] 文档早退必须排在 ensureServerId 之前（删掉闸即失败）', () => {
  const gate = UPLOAD_LOOP.indexOf('if (!file.isImage && !documents.nativeFile)')
  const upload = UPLOAD_LOOP.indexOf('await ensureServerId(')
  const imageSkip = UPLOAD_LOOP.indexOf('if (file.isImage && vision.base64)')
  assert.ok(gate >= 0, '文档闸不在上传循环里')
  assert.ok(upload > 0, '上传循环里找不到 ensureServerId 调用')
  assert.ok(imageSkip >= 0 && imageSkip < gate, '文档闸要写在图片豁免之后（顺序即读法）')
  assert.ok(
    gate < upload,
    `文档闸必须在上传之前：gate=${gate} upload=${upload}（闸在后面等于没装）`
  )
})

test('[绿 4] 闸的判据里没有第二套渠道判断', () => {
  // 允许出现渠道名（注释里解释历史时会提到），但**不允许**用它们做等值判断
  assert.doesNotMatch(
    UPLOAD_LOOP,
    /(===|!==)\s*'(deepseek|anthropic|openai|ours)'/,
    '不许在上传循环里按渠道名硬编码 —— 判据只能是能力表'
  )
  assert.doesNotMatch(
    UPLOAD_LOOP,
    /kind\s*===\s*'|kind\s*!==\s*'/,
    '不许在上传循环里按 kind 直接比较字符串'
  )
})

test('[绿 5] 修法没有顺手关掉文档注入', () => {
  assert.match(
    STORE,
    /const documentInjection = docInjectionFor\(spec\.kind\)\.textInjection/,
    '注入闸仍在：文本注入渠道的文档照旧注入'
  )
  assert.match(
    STORE,
    /const injected = documentInjection\s*\?\s*await withRequestDocuments\(/,
    'withRequestDocuments 调用仍在，且仍由 documentInjection 决定'
  )
})
