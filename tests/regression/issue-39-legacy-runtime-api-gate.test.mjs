// [layer: regression | 依赖: 无（纯 Node，临时产物目录） | Issue #39（关联 #13 / #79 / #95）]
//
// 回归对象：运行时 API 门禁 checkRuntimeApis —— 产物里出现 WebView 83 没有的内置 API 时，
//   **必须**有 src/polyfills/legacy.ts 的补丁，且补丁必须落在 index.html 直接加载的入口脚本里。
//
// 修复前症状（#39）：WebView 83 上产物调 Object.hasOwn / .at( / structuredClone 之类直接
//   TypeError，白屏；门禁只看语法不看运行时 API，polyfill 打了没打没人管。
// 修复后预期：
//   - 入口脚本带 __DEEPSEEK_LEGACY_POLYFILL__ 标记 → 覆盖 API 放行；
//   - 补丁只在懒加载 chunk 里 → 报违规（懒加载 chunk 里补等于没补）；
//   - 产物里根本没有标记 → 报违规；
//   - Promise.any / Object.groupBy / AggregateError 这类没有补丁的 → 无条件报违规。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { checkRuntimeApis, POLYFILL_FLAG } = await import('../../scripts/check-bundle-syntax.mjs')

const tempDirs = []
// 临时产物目录放系统 temp（不放 /tmp：git-bash 的 /tmp 在 Node 里会落到 D:\tmp 并 ENOENT）
const distFixture = ({ indexHtml, files }) => {
  const root = mkdtempSync(join(tmpdir(), 'regress39-'))
  tempDirs.push(root)
  if (indexHtml !== null) writeFileSync(join(root, 'index.html'), indexHtml)
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), code)
  }
  return { root, jsFiles: Object.keys(files).map((name) => join(root, name)) }
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const entryHtml = (src) => `<!doctype html><html><body><script src="${src}"></script></body></html>`
const usesReplaceAll = "const s = 'a-b'.replaceAll('-', '+')"

test('#39 入口脚本带补丁标记时，覆盖列表里的 API 放行', () => {
  const dist = distFixture({
    indexHtml: entryHtml('/static/js/main.js'),
    files: { 'static/js/main.js': `/* ${POLYFILL_FLAG} */\n${usesReplaceAll}\n` },
  })
  const result = checkRuntimeApis(dist.root, dist.jsFiles)
  assert.deepEqual(result.violations, [], 'replaceAll 有补丁且在入口脚本里，不该报违规')
  assert.equal(result.entryScripts.length, 1)
  assert.equal(result.polyfillInEntries.length, 1, '入口脚本应被认成带补丁')
  assert.ok(
    result.usage.some((hit) => hit.id === 'string-replaceAll'),
    '用法要能定位到具体 API，否则违规原因无法解释'
  )
})

test('#39 补丁只落在懒加载 chunk 里必须报违规（懒加载 chunk 里补等于没补）', () => {
  const dist = distFixture({
    indexHtml: entryHtml('/static/js/main.js'),
    files: {
      'static/js/main.js': 'export const boot = () => 1\n',
      'static/js/lazy-7.js': `/* ${POLYFILL_FLAG} */\n${usesReplaceAll}\n`,
    },
  })
  const result = checkRuntimeApis(dist.root, dist.jsFiles)
  assert.equal(result.polyfillInEntries.length, 0)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0].reason, /不在入口脚本里/)
})

test('#39 产物里根本没有补丁标记必须报违规', () => {
  const dist = distFixture({
    indexHtml: entryHtml('/static/js/main.js'),
    files: { 'static/js/main.js': usesReplaceAll },
  })
  const result = checkRuntimeApis(dist.root, dist.jsFiles)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0].reason, /根本没有 polyfill 标记/)
})

test('#39 Promise.any / AggregateError / Object.groupBy 没有补丁，出现即拦', () => {
  const dist = distFixture({
    indexHtml: entryHtml('/static/js/main.js'),
    files: {
      'static/js/main.js': `/* ${POLYFILL_FLAG} */
const first = await Promise.any([1])
throw new AggregateError([first], 'x')
const grouped = Object.groupBy([1, 2], (n) => n % 2)
`,
    },
  })
  const result = checkRuntimeApis(dist.root, dist.jsFiles)
  const ids = result.violations.map((hit) => hit.id).sort()
  assert.deepEqual(ids, ['aggregate-error', 'object-groupBy', 'promise-any'])
  for (const violation of result.violations) {
    assert.match(violation.reason, /没有补丁覆盖/)
  }
})

test('#39 产物里没有 index.html 时不能默默放行（无法确认补丁在入口）', () => {
  const dist = distFixture({ indexHtml: null, files: { 'static/js/main.js': usesReplaceAll } })
  const result = checkRuntimeApis(dist.root, dist.jsFiles)
  assert.equal(result.entryScripts, null)
  assert.equal(result.violations.length, 1)
  assert.match(result.violations[0].reason, /index\.html/)
})
