// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #214 的防回归：`@container` 容器查询与 `container-type` 首支持 Chromium 105，
// 运行时下限是 WebView 83（Chromium 83）。
//   低内核上 `container-type` 是未知声明 → 整条丢弃（无副作用）；
//   `@container` 是未知 at-rule → **整块丢弃**，块内规则一条都不生效。
// 结果是「按容器宽度改布局」这条语义静默消失：没有报错，只有视觉损坏。
//
// 这里把判定口径钉死：
//  1. `src/**` 里不许再有 `@container` / `container-type`——布局决策必须由我们自己的类或
//     自定义属性承载（Chromium 49+ 就有自定义属性，83 上照常生效）；
//  2. 如果将来确实需要容器查询，块内每条声明都必须在 `@container` 之外有同一选择器的基线，
//     否则审计判红（`@supports (container-type: …)` 包着、外面空着的写法同样判红）；
//  3. #214 的两处具体处置要能对得上：`.imageThumb` 不再建容器，`.reason` 的显隐由
//     `--message-file-reason-display` 决定，且默认值是 `flex`（低内核上就是原样显示）；
//  4. 触发条件仍然只有「缩略图宽度 = 64px」这一档（`--message-file-image-size` 的唯一窄档），
//     与原来的 `@container (max-width: 63px)` 等价：64px 盒 + `box-sizing: border-box` +
//     两侧 1px 边框 → 内容盒 62px ≤ 63px。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditCssText, auditContainerQuery } from '../../scripts/lib/containerQueryAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** 注释不是规则：注释里允许出现 `@container` 字样（说明「这里为什么不用它」） */
const stripComments = (content) => content.replace(/\/\*[\s\S]*?\*\//g, ' ')

const findContainerHits = () => {
  const hits = []
  for (const file of walk(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    text.split(/\r?\n/).forEach((line, index) => {
      if (/@container\b|\bcontainer-type\s*:/.test(line)) {
        hits.push({ file: rel(file), line: index + 1, text: line.trim() })
      }
    })
  }
  return hits
}

const css = (file) => stripComments(readFileSync(path.join(ROOT, file), 'utf8'))

test('① src/** 不含 @container / container-type：WebView 83 上整块规则被丢弃（#214）', async () => {
  const hits = findContainerHits()
  const detail = hits.map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`).join('\n')
  assert.equal(
    hits.length,
    0,
    `src 里仍有 ${hits.length} 处容器查询，Chromium 83 上整块规则会被丢弃：\n${detail}`,
  )

  const result = await auditContainerQuery(SRC)
  assert.equal(result.occurrences.length, 0, '审计口径与上面的字面扫描必须一致')
  assert.deepEqual(result.missing, [])
})

test('② 裸 @container 没有块外基线 → 判红（低内核整块丢弃后布局决策消失）', () => {
  const cssText = [
    '.thumb { container-type: inline-size; }',
    '@container (max-width: 63px) {',
    '  .reason { display: none; }',
    '}',
  ].join('\n')
  const result = auditCssText(cssText)
  assert.equal(result.missing.length, 1)
  assert.equal(result.occurrences.find((item) => item.shape === 'missing')?.selector, '.reason')
  assert.match(result.missing[0].why, /没有基线声明/u)
})

test('③ @container + 块外同一选择器基线 → 合法（容器查询只做增强）', () => {
  const cssText = [
    '.thumb { container-type: inline-size; }',
    '.reason { display: flex; }',
    '@container (max-width: 63px) {',
    '  .reason { display: none; }',
    '}',
  ].join('\n')
  const result = auditCssText(cssText)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(
    result.occurrences.map((item) => item.shape),
    ['paired-container-type', 'baseline-plus-container'],
  )
})

test('④ 只在 @supports 里写容器查询、外面什么都不留 → 判红（#173 的错法）', () => {
  const cssText = [
    '@supports (container-type: inline-size) {',
    '  .thumb { container-type: inline-size; }',
    '  @container (max-width: 63px) {',
    '    .reason { display: none; }',
    '  }',
    '}',
  ].join('\n')
  const result = auditCssText(cssText)
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].selector, '.reason')
  assert.ok(result.occurrences.some((item) => item.shape === 'missing'), '容器块里的规则必须判红')
})

test('⑤ container-type 没有配套 @container → 死声明判红；@container 没有容器也判红', () => {
  assert.deepEqual(
    auditCssText('.thumb { container-type: inline-size; }').occurrences.map((item) => item.shape),
    ['dead-container-type'],
  )
  const orphan = auditCssText('@container (max-width: 63px) { .reason { display: none; } }')
  assert.equal(orphan.occurrences[0].shape, 'orphan-container')
  assert.equal(orphan.missing.length, 1)
})

test('⑥ 两处处置对得上：不建容器，显隐由自定义属性决定且默认就是可用状态', () => {
  const file = css('src/components/messages/MessageFile.module.css')
  const user = css('src/components/messages/UserMessage.module.css')

  // ① .imageThumb 不再建立容器；规则本体只剩定位
  const thumb = file.match(/\.imageThumb \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(thumb.includes('position: relative'), '.imageThumb 的定位必须保留（.reason 绝对定位依赖它）')
  assert.ok(!thumb.includes('container'), '.imageThumb 不该再声明 container-type')

  // ② .reason 的 display 走自定义属性，默认值 flex = 低内核上原样显示（基线可用）
  const reason = file.match(/\.reason \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(
    reason.includes('display: var(--message-file-reason-display, flex)'),
    '.reason 的 display 必须以 flex 为兜底读 --message-file-reason-display',
  )

  // ③ 唯一的窄档（64px）与「隐藏原因」由同一条规则协同给出
  const narrow = user.match(/\.filesWithDocuments \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(narrow.includes('--message-file-image-size: 64px'), '.filesWithDocuments 仍是唯一的窄档来源')
  assert.ok(
    narrow.includes('--message-file-reason-display: none'),
    '.filesWithDocuments 必须同时把 --message-file-reason-display 置为 none',
  )
})

test('⑦ 等价性：窄档内容盒 = 64 - 2×1px = 62px ≤ 原阈值 63px，且没有别的窄档来源', () => {
  const file = css('src/components/messages/MessageFile.module.css')
  // .image 仍是 border-box + 1px 边框 + 固定宽度，flex-shrink: 0 → 宽度不被视口/换行压缩
  assert.ok(/box-sizing: border-box/u.test(file.match(/\.image \{[^}]*\}/u)?.[0] ?? ''))
  assert.ok(/border: 1px solid/u.test(file.match(/\.image \{[^}]*\}/u)?.[0] ?? ''))
  assert.ok(/flex-shrink: 0/u.test(file.match(/\.image \{[^}]*\}/u)?.[0] ?? ''))
  assert.ok(
    (file.match(/--message-file-image-size, 120px\)/gu) ?? []).length === 2,
    '缩略图宽度默认档是 120px（宽 + 高各一处）',
  )

  // `--message-file-image-size` 的非默认值只出现在一处，就是 64px 的窄档
  const overrides = []
  for (const item of walk(SRC)) {
    if (!/\.(?:css|tsx?)$/u.test(item)) continue
    for (const [, value] of stripComments(readFileSync(item, 'utf8')).matchAll(/--message-file-image-size:\s*([^;}]+)/gu)) {
      overrides.push({ file: rel(item), value: value.trim() })
    }
  }
  assert.deepEqual(overrides, [{ file: 'src/components/messages/UserMessage.module.css', value: '64px' }])

  const contentBox = (box) => box - 2 * 1
  assert.ok(contentBox(64) <= 63, '64px 盒的内容盒（62px）必须落在原来的 63px 阈值里')
  assert.ok(contentBox(120) > 63, '120px 档的内容盒（118px）不该落在阈值里')
})

test('⑧ 门禁接上了：package.json 有 check:container', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['check:container'], 'node scripts/check-container-query-fallback.mjs')
})
