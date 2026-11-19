// Issue #190 取证脚本：量「设置 → 数据」页每一行的 text 列宽度。
//
// 用法（App 必须已安装；一次只开一台模拟器）：
//   node docs/ui/190-backup-row/measure.mjs <tag>            # 默认 390 / 360 / 412
//   node docs/ui/190-backup-row/measure.mjs after 390
//
// 产出：docs/ui/190-backup-row/<tag>-wv<内核>-<宽度>.{json,png}
//
// 截图走 adb exec-out screencap -p（headless 的 Page.captureScreenshot 会返回重复帧，
// 见本仓库既有结论），所以这里只从 CDP 取数值，不取画面。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { attach, sh, sleep } from '../173-flex-gap/cdp.mjs'

const OUT = path.resolve(import.meta.dirname)
const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'

// 三档 CSS 宽度：innerWidth 391 / 360 / 412（物理 1080x1920 @ density 420 ≈ 411.4）
const WIDTHS = {
  390: { size: '585x1300', density: '240' },
  360: { size: '540x1200', density: '240' },
  412: { size: 'reset', density: 'reset' },
}

const Q = `window.__q = (re) => [...document.querySelectorAll('button,[role="tab"],[role="radio"],[role="button"],[role="menuitem"],a')]
  .filter((el) => el.offsetParent !== null)
  .find((el) => [el.getAttribute('aria-label') || '', el.title || '', (el.textContent || '').slice(0, 32)].some((s) => re.test(s.trim())))`

const OPEN_SETTINGS = [
  `(() => { ${Q}; const bar = window.__q(/^(Open sidebar|打开侧边栏)$/); if (bar) bar.click(); return 'ok' })()`,
  `(() => { ${Q}; const entry = window.__q(/^(Settings|设置)$/); if (entry) entry.click(); return 'ok' })()`,
  `(() => { ${Q}; const tab = window.__q(/^\\s*(Data|数据管理)\\s*$/); if (tab) tab.click(); return 'ok' })()`,
]

const READY = `!!document.querySelector('[role="tabpanel"] [class*="cell-"]')`

/** 逐行取测量值：行容器 + 每个 flex 子元素的尺寸与关键计算样式 + 祖先链宽度 */
const PROBE = `(() => {
  const panel = document.querySelector('[role="tabpanel"]')
  if (!panel) return { error: 'no tabpanel' }
  const pick = (el, props) => { const cs = getComputedStyle(el); const o = {}; for (const p of props) o[p] = cs.getPropertyValue(p); return o }
  const rows = [...panel.children].map((el, index) => {
    const cls = (el.className || '').toString()
    const r = el.getBoundingClientRect()
    const kid = (child) => {
      const b = child.getBoundingClientRect()
      return {
        cls: (child.className || '').toString(),
        tag: child.tagName.toLowerCase(),
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
        clientHeight: child.clientHeight,
        rectWidth: Math.round(b.width * 10) / 10,
        rectHeight: Math.round(b.height * 10) / 10,
        css: pick(child, ['display','flex','flex-basis','flex-grow','flex-shrink','flex-wrap','min-width','width','max-width','word-break','overflow-wrap','white-space','gap','row-gap','column-gap','padding-right','writing-mode']),
        text: (child.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        // 一个字（最大号汉字）的宽度，用来判「列宽 < 一个汉字」
        charWidth: (() => {
          const probe = document.createElement('span')
          probe.textContent = '汉'
          probe.style.cssText = 'position:absolute;visibility:hidden;font-size:14px'
          child.appendChild(probe)
          const w = probe.getBoundingClientRect().width
          probe.remove()
          return Math.round(w * 10) / 10
        })(),
      }
    }
    // 祖先链：每层的 display 与可用宽度
    const chain = []
    let p = el
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      chain.push({
        cls: (p.className || '').toString(),
        display: cs.display,
        clientWidth: p.clientWidth,
        rectWidth: Math.round(p.getBoundingClientRect().width * 10) / 10,
      })
      p = p.parentElement
    }
    return {
      index,
      cls,
      rectWidth: Math.round(r.width * 10) / 10,
      rectHeight: Math.round(r.height * 10) / 10,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      children: [...el.children].map(kid),
      chain,
    }
  })
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowOffenders: [...document.querySelectorAll('body *')].filter((el) => {
      const b = el.getBoundingClientRect()
      return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1)
    }).length,
    ua: navigator.userAgent,
    rows,
  }
})()`

const shot = (file) => {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20 })
  writeFileSync(file, png)
}

const setWidth = (width) => {
  const cfg = WIDTHS[width]
  if (cfg.size === 'reset') sh('shell', 'wm', 'size', 'reset')
  else sh('shell', 'wm', 'size', cfg.size)
  if (cfg.density === 'reset') sh('shell', 'wm', 'density', 'reset')
  else sh('shell', 'wm', 'density', cfg.density)
}

const restart = async () => {
  sh('shell', 'am', 'force-stop', 'com.example.deepseekchat')
  await sleep(800)
  sh('shell', 'monkey', '-p', 'com.example.deepseekchat', '-c', 'android.intent.category.LAUNCHER', '1')
  await sleep(2500)
}

const run = async () => {
  const tag = process.argv[2] || 'before'
  const widths = process.argv.slice(3).length ? process.argv.slice(3) : ['390', '360', '412']
  mkdirSync(OUT, { recursive: true })
  for (const [i, width] of widths.entries()) {
    // 单台模拟器：每档都要换 size/density 并重启 App，WebView 才会按新视口布局
    setWidth(width)
    await sleep(1200)
    if (i > 0 || true) await restart()
    const cdp = await attach()
    const major = (await cdp.evaluate('navigator.userAgent')).match(/Chrome\/(\d+)/)?.[1] ?? 'x'
    for (const step of OPEN_SETTINGS) await cdp.evaluate(step)
    await sleep(1200)
    const ready = await cdp.evaluate(READY)
    if (!ready) {
      console.error(`[${tag} ${width}] 设置面板没打开，跳过（不静默出图）`)
      cdp.close()
      continue
    }
    const data = await cdp.evaluate(PROBE)
    data.tag = tag
    data.width = width
    data.wmSize = sh('shell', 'wm', 'size')
    data.wmDensity = sh('shell', 'wm', 'density')
    const base = `${tag}-wv${major}-${width}`
    writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(data, null, 1))
    shot(path.join(OUT, `${base}.png`))
    console.log(`[${tag} ${width}] innerWidth=${data.innerWidth} scrollWidth=${data.scrollWidth} rowCount=${data.rows.length}`)
    for (const row of data.rows) {
      for (const c of row.children) {
        if (c.clientWidth < 60 && (c.text || '').length > 6) {
          console.log(`  窄列: row#${row.index} "${row.text.slice(0, 24)}" | ${c.cls} clientWidth=${c.clientWidth} h=${c.clientHeight} char=${c.charWidth} flex=${c.css.flex} minWidth=${c.css['min-width']}`)
        }
      }
    }
    cdp.close()
  }
}

run()
