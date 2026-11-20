// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #233：生成器没跟上 #217 扩大的扫描口径。
//
// #217（merge 69cca04）把 `check:gap` 的扫描范围从 `*.module.css` 扩到全部 `*.css`，
// 判定层 `gapFallbackRequirement()` 本来就不区分文件类型；但 `gen-flex-gap-fallback.mjs`
// 的 `walk()` 仍然只收 `*.module.css`。于是普通 CSS 的 flex gap 守卫看得见、生成器看不见，
// 兜底只能人工落笔 —— `src/components/markdown/markdown.css` 里那块带 `#173-fallback:` 标记的
// 手写块就是这么来的。这里把生成器的口径钉住：
//  1. 普通 `.css` 也要生成兜底块，作用域**裸写**（`:global()` 在非 module 文件里是非法伪类，
//     整条规则会被浏览器丢掉）；生成结果必须能被 `check:gap` 认出来；
//  2. 幂等：重复跑不叠加、不重排；
//  3. 与人工 `#173-fallback:` 块共存：已手写的选择器不重复生成；
//  4. `.module.css` 的既有产物**逐字节不变**（`:global()` 写法一个字节都不能动）。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { auditFlexGap } from '../../scripts/lib/flexGapAudit.mjs'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const GEN_URL = pathToFileURL(fileURLToPath(new URL('../../scripts/gen-flex-gap-fallback.mjs', import.meta.url))).href

/** 动态导入，顺带证明「导入生成器没有副作用」（CLI 只在直接执行时跑） */
const loadGenerate = async () => (await import(GEN_URL)).generateGapFallback

const PLAIN = `.md-code-block-switch {
  display: flex;
  gap: 4px;
}
`

/** 造一个临时 src 目录，返回目录路径与清理函数 */
const tmpSrc = async (files) => {
  const root = await mkdtemp(join(tmpdir(), 'gap-gen-'))
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content)
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const snapshot = async (dir) => {
  const out = new Map()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue
    const full = join(entry.parentPath ?? entry.path, entry.name)
    out.set(full, await readFile(full, 'utf8'))
  }
  return out
}

test('#233 普通 .css 的 flex gap 会被生成器补上，且作用域裸写不带 :global()', async () => {
  const generate = await loadGenerate()
  assert.equal(
    typeof generate,
    'function',
    '生成器要把「对某个 src 目录跑一遍」暴露成函数：否则普通 CSS 这条路径无法单独验证，只能靠跑真实仓库',
  )
  const { root, cleanup } = await tmpSrc({ 'plain.css': PLAIN })
  try {
    const result = await generate(root)
    assert.equal(result.touched, 1, '普通 CSS 里写了 flex gap 却没被生成器改动 —— 这就是 #233 的原始 bug')
    const css = await readFile(join(root, 'plain.css'), 'utf8')
    assert.match(
      css,
      /html\[data-flex-gap-fallback\] \.md-code-block-switch > \*:not\(:last-child\) \{\n  margin-right: 4px;\n\}/u,
      '普通 CSS 的兜底块必须裸写作用域',
    )
    assert.doesNotMatch(css, /:global\(/u, ':global() 在普通 CSS 里是非法伪类，整条规则会被丢掉')
    const audit = await auditFlexGap(root)
    assert.deepEqual(audit.missing, [], '生成出来的块要被 check:gap 认出来，否则「生成完还是红」')
    assert.equal(audit.covered.length, 1)
  } finally {
    await cleanup()
  }
})

test('#233 普通 .css 重复跑不叠加、不重排', async () => {
  const generate = await loadGenerate()
  assert.equal(typeof generate, 'function')
  const { root, cleanup } = await tmpSrc({ 'plain.css': PLAIN })
  try {
    await generate(root)
    const once = await readFile(join(root, 'plain.css'), 'utf8')
    const second = await generate(root)
    const twice = await readFile(join(root, 'plain.css'), 'utf8')
    assert.equal(twice, once, '第二次跑改动了文件：幂等被破坏（叠加或多插了空行）')
    assert.equal(second.touched, 0)
    assert.equal((twice.match(/data-flex-gap-fallback/gu) ?? []).length, 1, '兜底块只该有一份')
  } finally {
    await cleanup()
  }
})

test('#233 与人工 #173-fallback 块共存：已手写的选择器不重复生成', async () => {
  const generate = await loadGenerate()
  assert.equal(typeof generate, 'function')
  const handwritten = `${PLAIN}
/* #173-fallback:start —— issue #217。markdown.css 是普通 CSS（不是 CSS Module），
   :global() 在这里是非法伪类、整条规则会被丢掉，所以作用域直接裸写。 */
html[data-flex-gap-fallback] .md-code-block-switch > *:not(:last-child) {
  margin-right: 4px;
}
/* #173-fallback:end */
`
  const { root, cleanup } = await tmpSrc({ 'markdown.css': handwritten })
  try {
    const result = await generate(root)
    const css = await readFile(join(root, 'markdown.css'), 'utf8')
    assert.equal(css, handwritten, '人工块的写法一个字节都不该被生成器碰')
    assert.equal(result.touched, 0)
    assert.equal((css.match(/margin-right: 4px;/gu) ?? []).length, 1, '同一选择器生成了两份兜底 = 双份间距')
  } finally {
    await cleanup()
  }
})

test('#233 .module.css 的既有产物逐字节不变', async () => {
  const generate = await loadGenerate()
  assert.equal(typeof generate, 'function')
  const root = await mkdtemp(join(tmpdir(), 'gap-gen-mods-'))
  try {
    await cp(SRC, join(root, 'src'), { recursive: true })
    const before = await snapshot(join(root, 'src'))
    const result = await generate(join(root, 'src'))
    const after = await snapshot(join(root, 'src'))
    assert.equal(result.touched, 0, `已经有产物了，再跑不该改文件：${result.changed.join(', ')}`)
    for (const [path, css] of after) assert.equal(css, before.get(path), `${path} 字节变了`)
    assert.ok(before.size > 40, `CSS 文件太少（${before.size}），拷贝是不是没成功`)
    const app = after.get(join(root, 'src', 'app', 'App.module.css'))
    assert.match(app, /:global\(html\[data-flex-gap-fallback\]\) \.saveError > \*:not\(:last-child\)/u, 'module 里必须继续用 :global() 逃逸')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
