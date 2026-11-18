// Issue #173 取证脚本：在 WebView 上量相邻 flex 子元素的实际间距。
//
// 用法（App 必须已安装并能在前台启动；一次只开一台模拟器）：
//   node docs/ui/173-flex-gap/scan.mjs before            # 默认 390 与 360 两个宽度
//   node docs/ui/173-flex-gap/scan.mjs after 390         # 只跑 390
//
// 产出：docs/ui/173-flex-gap/<tag>-wv<内核主版本>-<宽度>-<页面>.{json,png}
//
// 为什么不用 CSS.supports 判定：WebView 83 上 CSS.supports('gap','12px') 与
// @supports (gap: 12px) 都返回 true（grid 的 gap 是支持的），但 flex 容器的 gap
// 完全不生效。所以「支持性」只能靠量：gap 声明值 vs 相邻子元素实际间距。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { attach, sh, sleep } from './cdp.mjs'

const OUT = path.resolve(import.meta.dirname)
const WIDTHS = { 390: { size: '585x1300', density: '240' }, 360: { size: '540x1200', density: '240' } }

/** 页面里可复用的取元素助手：按 aria-label / title / 文本匹配第一个可见**可点元素**。
 *  只收 button / [role] / a：把 div 也算进来会先命中包着文字的布局容器
 *  （例如侧栏底部 div.bottom 的 textContent 就是「Settings」），点了等于没点。
 *  三个来源分别整段匹配（aria-label="Data" 且 textContent="Data" 拼起来匹配不上）。 */
const Q = `window.__q = (re) => [...document.querySelectorAll('button,[role="tab"],[role="radio"],[role="button"],[role="menuitem"],a')]
  .filter((el) => el.offsetParent !== null)
  .find((el) => [el.getAttribute('aria-label') || '', el.title || '', (el.textContent || '').slice(0, 32)].some((s) => re.test(s.trim())))`

/** 打开设置弹窗：窄屏没有常驻侧栏，先开抽屉，再点抽屉里的「Settings」入口 */
const OPEN_SETTINGS = [
  `(() => { ${Q}; const bar = window.__q(/^(Open sidebar|打开侧边栏)$/); if (bar) bar.click(); return 'ok' })()`,
  `(() => { ${Q}; const entry = window.__q(/^(Settings|设置)$/); if (entry) entry.click(); return 'ok' })()`,
]

/** 每页：进入步骤 + 就位判据（判据不成立就记 fail，不静默出图） */
const PAGES = [
  {
    id: 'chat',
    label: '聊天页（欢迎态输入区）',
    steps: [`${Q}; (window.__q(/^(Close|关闭)$/) || {click(){}}).click(); 'ok'`],
    ready: `!!document.querySelector('textarea')`,
    waitMs: 900,
  },
  {
    id: 'settings-general',
    label: '设置 → 通用',
    steps: [
      ...OPEN_SETTINGS,
      `(() => { ${Q}; const t = window.__q(/^\\s*(General|通用)\\s*$/); if (t) t.click(); return 'ok' })()`,
    ],
    ready: `!!document.querySelector('[class*="themeOptions-"]')`,
    waitMs: 900,
  },
  {
    id: 'settings-data',
    label: '设置 → 数据',
    steps: [
      ...OPEN_SETTINGS,
      `(() => { ${Q}; const t = window.__q(/^\\s*(Data|数据)\\s*$/); if (t) t.click(); return 'ok' })()`,
    ],
    ready: `!!window.__q(/^(Check log coverage|检查日志覆盖)/)`,
    waitMs: 1200,
  },
]

/** 量「声明的 gap」与「实测的相邻子元素间距」的差 */
const AUDIT = `(() => {
  const name = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).map((c) => c.replace(/-[a-z0-9]{6}$/, '')).join(' ')
  const box = (el) => el.getBoundingClientRect()
  // 只按 display 判可见：空占位子元素（.toggles 这种 0 尺寸容器）也是参与 gap 的项，
  // 用尺寸过滤会把整条记录丢掉，得到「declared 8px 但没有任何 gap 容器」的假结论。
  const visible = (el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'
  const und = (v) => (v === 'normal' || v === '' ? 0 : parseFloat(v) || 0)
  const round = (n) => Math.round(n * 10) / 10
  let scanned = 0
  const rows = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (!cs.display.includes('flex')) continue
    scanned += 1
    const kids = [...el.children].filter(visible)
    if (kids.length < 2) continue
    const dir = cs.flexDirection.startsWith('column') ? 'column' : 'row'
    const rowGap = und(cs.rowGap)
    const colGap = und(cs.columnGap)
    if (rowGap === 0 && colGap === 0) continue
    const axes = dir === 'row' ? [colGap, rowGap] : [rowGap, colGap]
    const gaps = []
    for (let i = 1; i < kids.length; i += 1) {
      const a = box(kids[i - 1])
      const b = box(kids[i])
      if ((a.width === 0 && a.height === 0) || (b.width === 0 && b.height === 0)) { gaps.push(null); continue }
      if (dir === 'row') {
        // 同一行 = 竖向有重叠；用 top 相等判定会误杀 align-items:center 的行
        if (a.bottom <= b.top + 1 || b.bottom <= a.top + 1) { gaps.push(null); continue }
        gaps.push(round(b.left - a.right))
      } else {
        if (a.right <= b.left + 1 || b.right <= a.left + 1) { gaps.push(null); continue }
        gaps.push(round(b.top - a.bottom))
      }
    }
    const known = gaps.filter((g) => g !== null)
    rows.push({
      cls: name(el),
      tag: el.tagName.toLowerCase(),
      dir,
      wrap: cs.flexWrap === 'wrap',
      rowGap,
      colGap,
      mainGap: axes[0],
      measured: gaps,
      minMeasured: known.length === 0 ? null : Math.min(...known),
    })
  }
  const zeroed = rows.filter((r) => r.mainGap > 0 && r.minMeasured === 0)
  return {
    url: location.href,
    viewport: innerWidth + 'x' + innerHeight,
    chrome: (navigator.userAgent.match(/Chrome\\/([\\d.]+)/) || [])[1] || '',
    ua: navigator.userAgent,
    flexContainers: scanned,
    gapContainers: rows.length,
    zeroedContainers: zeroed.length,
    zeroed: zeroed.map((r) => ({ cls: r.cls, dir: r.dir, gap: r.mainGap })),
    rows,
  }
})()`

/** 每页都从「刚启动的 App」开始：不 reload 的话上一页打开的设置弹窗会带到下一页，
 *  页面归属就说不清了。 */
const reload = async (cdp) => {
  await cdp.send('Page.reload', {})
  for (let i = 0; i < 75; i += 1) {
    await sleep(200)
    try {
      if (await cdp.evaluate(`document.readyState === 'complete' && !!document.querySelector('#root > *')`)) {
        await sleep(700)
        return
      }
    } catch {
      // 页面正在换文档，evaluate 会短暂失败，重试即可
    }
  }
  throw new Error('reload 后页面未就绪')
}

const run = async (tag, widths) => {
  sh('shell', 'am', 'start', '-n', 'com.example.deepseekchat/.MainActivity')
  await sleep(2500)
  const cdp = await attach()
  const chrome = ((await cdp.evaluate('navigator.userAgent')).match(/Chrome\/([\d.]+)/) || [])[1] || 'x'
  const major = chrome.split('.')[0]
  mkdirSync(OUT, { recursive: true })
  const summary = []
  for (const width of widths) {
    const { size, density } = WIDTHS[width]
    sh('shell', 'wm', 'size', size)
    sh('shell', 'wm', 'density', density)
    await sleep(1800)
    for (const page of PAGES) {
      await reload(cdp)
      for (const step of page.steps) await cdp.evaluate(step)
      await sleep(page.waitMs)
      const ready = await cdp.evaluate(page.ready)
      const data = await cdp.evaluate(AUDIT)
      const base = `${tag}-wv${major}-${width}-${page.id}`
      const png = await cdp.shot()
      writeFileSync(path.join(OUT, `${base}.png`), Buffer.from(png, 'base64'))
      writeFileSync(
        path.join(OUT, `${base}.json`),
        `${JSON.stringify({ tag, page: page.label, ready, ...data }, null, 1)}\n`
      )
      summary.push({
        file: `${base}.json`,
        page: page.label,
        ready,
        viewport: data.viewport,
        gapContainers: data.gapContainers,
        zeroedContainers: data.zeroedContainers,
      })
      console.log(`[${base}] ready=${ready} viewport=${data.viewport} 声明gap容器=${data.gapContainers} 实测为0=${data.zeroedContainers}`)
    }
  }
  cdp.close()
  console.log(`\nChrome/WebView 内核：${chrome}`)
  console.log(JSON.stringify(summary, null, 1))
}

const [tag = 'before', ...rest] = process.argv.slice(2)
const widths = rest.length > 0 ? rest : ['390', '360']
await run(tag, widths)
