// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #173 的防回归：flex gap 在 WebView 83 上是 0，而 CSS.supports('gap') 返回 true，
// 于是「探测说支持、间距是 0」。这里把两条规则钉进测试：
//  1. 仓库里不许出现 CSS.supports(...gap) / @supports (gap: …) —— 那种探测在 83 上假阳性；
//  2. 每条 flex 容器上的非零 gap 必须有兜底规则，否则以后新写的 gap 又会静默失效。
// 另外钉住兜底生成器的形状：只写 margin，绝不写 gap（否则支持 gap 的内核上会双份间距）。
//
// #217 补的是「守卫的覆盖面」，不是新机制：扫描范围从 `*.module.css` 扩到全部 `.css`，
// 并把 `flex-wrap` 的交叉轴 gap 从「一律排除」改成「不换行才排除」。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditFlexGap } from '../../scripts/lib/flexGapAudit.mjs'
import { isVendored } from '../../scripts/lib/vendoredPaths.mjs'
import { parseRules, readGap, renderFallback } from '../../scripts/lib/flexGapRules.mjs'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

const gapsOf = (css) => {
  const { rules } = parseRules(css)
  return rules.map((rule) => ({ selector: rule.selector, gap: readGap(rule) })).filter((item) => item.gap !== null)
}

/** 造一个临时 src 目录跑审计：单独验判定逻辑，不碰仓库真实文件。 */
const auditOf = async (files) => {
  const root = await mkdtemp(join(tmpdir(), 'gap-audit-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    return await auditFlexGap(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const countCss = async (dir) => {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // 与 auditFlexGap 同一口径：vendored 第三方目录不计（#417）
    if (isVendored(full)) continue
    if (entry.isDirectory()) total += await countCss(full)
    else if (entry.name.endsWith('.css')) total += 1
  }
  return total
}

test('#173 兜底只写 margin，不重复声明 gap', () => {
  const [row] = gapsOf('.row { display: flex; gap: 8px; }')
  const css = renderFallback(row.selector, row.gap)
  assert.match(css, /margin-right: 8px;/u)
  assert.doesNotMatch(css, /[^-]gap:/u)
  assert.match(css, /html\[data-flex-gap-fallback\]/u)
})

test('#173 竖向 flex 兜底加在 margin-bottom 上', () => {
  const [col] = gapsOf('.col { display: flex; flex-direction: column; row-gap: 12px; }')
  const css = renderFallback(col.selector, col.gap)
  assert.match(css, /margin-bottom: 12px;/u)
})

test('#173 会换行的 flex 两个方向都补', () => {
  const [wrap] = gapsOf('.wrap { display: flex; flex-wrap: wrap; gap: 6px 10px; }')
  const css = renderFallback(wrap.selector, wrap.gap)
  assert.match(css, /margin-right: 10px;/u)
  assert.match(css, /margin-bottom: 6px;/u)
})

test('#173 不许用 CSS.supports / @supports 探测 flex gap', async () => {
  const audit = await auditFlexGap(SRC)
  assert.deepEqual(audit.forbidden, [])
})

test('#173 每条 flex gap 都有兜底或写明跳过原因', async () => {
  const audit = await auditFlexGap(SRC)
  assert.deepEqual(audit.missing, [])
  assert.ok(audit.covered.length > 50, `兜底规则太少（${audit.covered.length}），生成器是不是没跑`)
})

// ---------------------------------------------------------------- #217 守卫范围

// #217 的两个盲区都是「守卫报 OK 但实际没兜底」，所以这里钉的是**报不报**，
// 不是兜底样式长什么样。

test('#217 非 module 的普通 .css 也在扫描范围内', async () => {
  const audit = await auditOf({
    'plain.css': `.md-code-block-switch {
  display: flex;
  gap: 4px;
}
`,
  })
  assert.equal(audit.cssFiles, 1)
  assert.equal(audit.cssModules, 0)
  assert.equal(audit.missing.length, 1, '普通 CSS 没进扫描就等于没有守卫')
  assert.match(audit.missing[0], /\.md-code-block-switch/u)
})

test('#217 普通 .css 里裸写 html[data-flex-gap-fallback] 兜底块也算已兜底', async () => {
  const audit = await auditOf({
    'plain.css': `.md-code-block-switch {
  display: flex;
  gap: 4px;
}

/* #173-fallback:start */
html[data-flex-gap-fallback] .md-code-block-switch > *:not(:last-child) {
  margin-right: 4px;
}
/* #173-fallback:end */
`,
  })
  assert.deepEqual(audit.missing, [])
  assert.equal(audit.covered.length, 1, ':global() 在非 module 文件里非法，裸写的作用域必须被认')
})

test('#217 flex-wrap 容器上的 row-gap 必须报，不能按「交叉轴一律排除」放行', async () => {
  const audit = await auditOf({
    'ReplyArea.module.css': `.toolBody {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  row-gap: 6px;
}
`,
  })
  assert.equal(audit.missing.length, 1, '换行后的行间距完全靠 row-gap，排除即等于无兜底')
  assert.match(audit.missing[0], /flex-wrap/u)
})

test('#217 flex-flow: row wrap 同样算会换行', async () => {
  const [rule] = gapsOf('.toolBody { display: flex; flex-flow: row wrap; row-gap: 8px; }')
  assert.equal(rule.gap.wrap, true, 'wrap 事实要看 flex-flow，否则这类写法会被当成单行容器放行')
})

test('#217 不换行的 flex 容器上单独的 row-gap 仍按设计排除', async () => {
  const audit = await auditOf({
    'X.module.css': `.row {
  display: flex;
  row-gap: 6px;
}
`,
  })
  assert.deepEqual(audit.missing, [], '单行 flex 上 row-gap 本就不生效，低内核丢了没有差别')
  assert.deepEqual(audit.skipped, [], '不需要兜底的形态不该污染跳过计数')
})

test('#217 只有 flex-wrap 交叉轴 gap 时兜底只写 margin-bottom', () => {
  const [wrap] = gapsOf('.toolBody { display: flex; flex-wrap: wrap; row-gap: 6px; }')
  const css = renderFallback(wrap.selector, wrap.gap)
  assert.match(css, /margin-bottom: 6px;/u)
  assert.doesNotMatch(css, /margin-right/u, '没有 column-gap 就不该凭空加横向边距')
  assert.doesNotMatch(css, /[^-]gap:/u)
})

test('#217 真实仓库的扫描文件数等于 src 下 .css 文件数', async () => {
  const audit = await auditFlexGap(SRC)
  assert.equal(audit.cssFiles, await countCss(SRC), '扫描口径必须和真实文件数一致，否则守卫报的 OK 不可信')
  assert.equal(
    audit.cssModules,
    44,
    'CSS Module 数（#209 口径 38 + #386 ScrollToBottomButton + #499 AuthPages + #502 四面板 + #505 账户消费页 − #487 删掉三个旧弹层 + #480 附件卡片/解析进度 − #562 删掉 OursServices.module.css + #517 UpdateDialog + #818 ImagePreview + #831 SessionBranch + 公告栏 Announcements.module.css + PersonaDrawer.module.css + 聊天设置 ChatSettings.module.css）变了就要同步 docs/capabilities/css.md'
  )
})
