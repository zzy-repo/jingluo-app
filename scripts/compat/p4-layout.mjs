#!/usr/bin/env node
/**
 * P4 · 390 / 360 排版抽查（#57 在 WebView 83 上竖排 + 横向溢出；#159 设置页三列截断的回归）。
 *
 * 判定不用眼睛猜：每处都取 window.innerWidth / document.scrollingElement.scrollWidth
 * 与逐个元素的 getBoundingClientRect().right，列出真的越过视口右边界的元素（文案 + class + 越界像素）。
 * 「有没有溢出」是实测值；「好不好看」才由人看截图。
 *
 * 密度与 CSS 宽度的对应（1080 物理宽）：443 → 390css、480 → 360css，reset → 411css。
 *
 * 用法：node scripts/compat/p4-layout.mjs --api 26 [--session]
 */
import { ensureDir, environment, evidenceDir, now, screencap, shell, sleep } from './lib/device.mjs'
import { attach } from './lib/cdp.mjs'
import { click, visibleTexts } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}
const API = option('api')
if (!API) {
  console.error('用法：node scripts/compat/p4-layout.mjs --api <NN> [--session]')
  process.exit(2)
}

const PROFILES = [
  { name: '390css', density: '443' },
  { name: '360css', density: '480' },
]

/** 版式体检：视口宽、可滚动宽、越界元素清单、可见文案。 */
const layoutReport = (cdp) =>
  cdp.evaluate(
    `(() => {
      const viewport = window.innerWidth
      const scrolling = document.scrollingElement || document.documentElement
      const out = []
      const nodes = document.querySelectorAll('body *')
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const over = Math.round(rect.right - viewport)
        if (over <= 1) continue
        out.push({
          tag: node.tagName.toLowerCase(),
          over,
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
          className: String(node.className || '').slice(0, 90),
        })
        if (out.length >= 25) break
      }
      return {
        innerWidth: viewport,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollWidth: scrolling ? scrolling.scrollWidth : null,
        horizontalOverflow: scrolling ? scrolling.scrollWidth - viewport : null,
        overflowElements: out,
        bodyTextLength: document.body ? (document.body.innerText || '').length : 0,
      }
    })()`,
    30_000
  )

const main = async () => {
  const outDir = ensureDir(evidenceDir(API))
  ensureDir(`${outDir}/shots`)
  const result = {
    phase: 'p4-layout',
    api: Number(API),
    startedAt: new Date().toISOString(),
    device: environment(),
    views: [],
  }
  const { cdp } = await attach()

  for (const profile of PROFILES) {
    shell('wm', 'density', profile.density)
    await sleep(2500)
    // 重载一次，确保按新密度重新排版（不重载的话跨密度切换可能留着旧布局）
    await cdp.evaluate('location.reload()').catch(() => {})
    await sleep(5000)
    console.log(`[${now()}] 密度 ${profile.density}（${profile.name}）`)

    const record = { profile: profile.name, density: profile.density, screens: [] }
    const capture = async (label) => {
      const shot = `${outDir}/shots/p4-${profile.name}-${label}.png`
      screencap(shot)
      const report = await layoutReport(cdp).catch((error) => ({ error: error.message }))
      const texts = await visibleTexts(cdp).catch(() => [])
      record.screens.push({ label, shot, report, texts: texts.slice(0, 40) })
      console.log(
        `  ${label}: innerWidth=${report.innerWidth} scrollWidth=${report.scrollWidth} 越界元素=${report.overflowElements?.length ?? '?'}`
      )
      return report
    }

    // 1) 主界面
    await capture('main')

    // 2) 会话页（有会话才测；没有就如实标未测，不拿主界面冒充）
    const hasSession = await cdp
      .evaluate(
        `(() => {
          const items = document.querySelectorAll('[data-session-id], [class*="sessionItem"]')
          if (items.length > 0) { items[0].click(); return true }
          return false
        })()`,
        15_000
      )
      if (hasSession) {
        await sleep(3000)
        await capture('session')
      } else {
        record.screens.push({ label: 'session', skipped: '侧栏没有会话条目（本次设备上没有可打开的会话）' })
        console.log('  session：没有会话可打开，标未测')
      }

    // 3) 设置页（#159 的回归点）：开 → 截 general → 切 Data 再截 → 再截导入弹层
    // 实测 aria：侧栏开关是 "Open sidebar"（不是 Expand sidebar）；设置页两个分区是
    // role=tab 的纯文本按钮 General / Data（无 aria-label），只能按文本点。
    // 注意：主界面的 Fast/Expert 模式切换也用 role="tablist"，不能用 tablist 判断设置页是否已开。
    // 所以下面的判据只认 "General" + "Data" 两颗 tab 同时在场（那是设置页独有的组合）。
    // 开机没配 API Key 时设置页会自己弹出来，先按 Close 关掉，流程才是确定的一条路：
    // Close（aria）→ Open sidebar（aria）→ Settings（文本）→ Data（文本）。
    const settingsVisible = await cdp
      .evaluate(
        `(() => {
          const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((n) => (n.textContent || '').trim())
          return labels.includes('General') && labels.includes('Data')
        })()`,
        10_000
      )
      .catch(() => false)
    if (settingsVisible) {
      record.dismiss = await click(cdp, { aria: 'Close' })
      await sleep(900)
    }
    if (!(await cdp
      .evaluate(
        `(() => {
          const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((n) => (n.textContent || '').trim())
          return labels.includes('General') && labels.includes('Data')
        })()`,
        10_000
      )
      .catch(() => false))) {
      const open = await click(cdp, { aria: 'Open sidebar' })
      const openFallback = open.clicked ? open : await click(cdp, { aria: 'Expand sidebar' })
      record.sidebar = openFallback
      await sleep(800)
    }
    let settingsOpen = await click(cdp, { tag: 'button', text: 'Settings' })
    if (!settingsOpen.clicked) {
      settingsOpen = await click(cdp, { aria: 'Settings' })
    }
    if (!settingsOpen.clicked) {
      settingsOpen = await cdp.evaluate(
        `(() => {
          const nodes = Array.from(document.querySelectorAll('button'))
          for (const node of nodes) {
            const rect = node.getBoundingClientRect()
            const hint = [node.className, node.getAttribute('aria-label'), node.innerHTML.slice(0, 200)].join(' ')
            if (rect.width > 0 && rect.height > 0 && /settings|gear|Set/i.test(hint)) { node.click(); return { clicked: true, hint: hint.slice(0, 120) } }
          }
          return { clicked: false }
        })()`,
        10_000
      )
    }
    record.settingsOpen = settingsOpen
    if (settingsOpen.clicked) {
      await sleep(1200)
      await capture('settings-general')
      const dataTab = await click(cdp, { tag: 'button', text: '^(Data|数据|存储)$', regex: true })
      if (dataTab.clicked) {
        await sleep(900)
        await capture('settings-data')
        // 4) 导入弹层：数据分区里的链接导入表单 + 确认弹层
        const form = await cdp
          .evaluate(
            `(() => {
              const input = Array.from(document.querySelectorAll('input')).find((node) =>
                /https/.test(node.getAttribute('placeholder') || '')
              )
              return { urlInputPresent: Boolean(input) }
            })()`,
            10_000
          )
          .catch((error) => ({ error: error.message }))
        record.importForm = form
        if (form.urlInputPresent) {
          await capture('import-form')
          const startImport = await click(cdp, { tag: 'button', text: '^(Import link|从链接导入)$', regex: true })
          record.importStart = startImport
          if (startImport.clicked) {
            await sleep(1000)
            await capture('import-confirm')
            await click(cdp, { tag: 'button', text: '^(Cancel|取消)$', regex: true })
            await sleep(600)
          } else {
            record.screens.push({ label: 'import-confirm', skipped: '没找到 Import link 按钮' })
          }
        } else {
          record.screens.push({ label: 'import-form', skipped: 'Data 分区里没有链接输入框' })
        }
      } else {
        record.screens.push({ label: 'settings-data', skipped: '没找到 Data 分区按钮' })
      }
      // 关掉设置，避免后面被遮罩挡住
      await click(cdp, { tag: 'button', text: '^Close$', regex: true })
      await sleep(800)
    } else {
      record.screens.push({ label: 'settings-general', skipped: '设置打不开（入口没找到）' })
    }

    result.views.push(record)
  }

  shell('wm', 'density', 'reset')
  await sleep(2000)
  result.finishedAt = new Date().toISOString()
  const file = `${outDir}/result-p4.json`
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
  cdp.close()
  console.log(`证据：${file}`)
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  shell('wm', 'density', 'reset')
  process.exit(1)
})
