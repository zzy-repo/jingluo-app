// Issue #209「能力探测替代一切假设」类别 4（行为 / 布局假设）取证脚本。
//
// 这类假设静态检测测不出来，只能设置后读回实际值。所以这里量的是「真实浏览器算出来的数」，
// 不是 grep 出来的 CSS：
//
//   假设 1「窄屏按钮会换行」       → 按钮行按 top 分组，量每行子元素宽度和 vs 行容器可用宽度，
//                                   以及每个按钮被压到多窄（换行 vs 挤压 vs 溢出三选一）
//   假设 2「弹窗内容超出会滚动」   → 真实滚动宿主 clientHeight / scrollHeight / scrollTop，
//                                   加 overflow-y / min-height / flex 计算值，加「末端内容能不能到达」
//   假设 3「触摸滑动会滚容器」     → adb shell input swipe 打真实触摸事件，比 scrollTop 前后值
//                                   （CDP 合成 wheel 不算：#30 就死在这里）
//   假设 4「100vh 等于可视高度」   → 100vh 实测高度 vs innerHeight vs visualViewport.height，
//                                   静息态与软键盘弹出态各测一次
//
// 用法（App 必须已安装；一次只开一台模拟器）：
//   node docs/ui/209-behavior/measure.mjs <tag>            # 默认 390 / 360 / 412
//   node docs/ui/209-behavior/measure.mjs after 360
//
// 产出：docs/ui/209-behavior/<tag>-wv<内核>-<宽度>.{json,png}
//
// 截图走 adb exec-out screencap -p（headless 的 Page.captureScreenshot 返回重复帧，
// 见本仓库既有结论），所以这里只从 CDP 取数值，不取画面。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { attach, sh, sleep } from '../173-flex-gap/cdp.mjs'

const OUT = path.resolve(import.meta.dirname)
const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'
const PKG = 'com.example.deepseekchat'

// 三档 CSS 宽度：innerWidth 360 / 390 / 412（物理 1080x1920 @ density 420 ≈ 411.4）
const WIDTHS = {
  390: { size: '585x1300', density: '240' },
  360: { size: '540x1200', density: '240' },
  412: { size: 'reset', density: 'reset' },
}

// ---------------------------------------------------------------- 页面内探针

/** 找可见可点元素（含图标按钮的空文本，靠 aria-label / title 认） */
const Q = `window.__q = (re) => [...document.querySelectorAll('button,[role="tab"],[role="radio"],[role="button"],[role="menuitem"],a')]
  .filter((el) => el.offsetParent !== null)
  .find((el) => [el.getAttribute('aria-label') || '', el.title || '', (el.textContent || '').slice(0, 32)].some((s) => re.test(s.trim())))`

const OPEN_SETTINGS = [
  `(() => { ${Q}; const bar = window.__q(/^(Open sidebar|打开侧边栏)$/); if (bar) bar.click(); return 'ok' })()`,
  `(() => { ${Q}; const entry = window.__q(/^(Settings|设置)$/); if (entry) entry.click(); return 'ok' })()`,
]

const SETTINGS_READY = `!!document.querySelector('[role="dialog"] [class*="navItem-"]')`

/**
 * 一次把「行为/布局」这四个假设要的数全读回来。
 *
 * 只读计算值，不猜：换行靠子元素 top 分组 + 宽度和，滚动靠 client/scroll 对比，
 * 视口靠 100vh 实测（插一个 height:100vh 的探针元素量出来，而不是读 CSS 文本）。
 */
const PROBE = `(() => {
  const round = (n) => Math.round(n * 10) / 10
  const cs = (el, props) => {
    const style = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = style.getPropertyValue(p)
    return out
  }
  const vhProbe = () => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    const height = probe.getBoundingClientRect().height
    probe.remove()
    return round(height)
  }
  const viewport = () => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    measured100vh: vhProbe(),
    visualViewport: window.visualViewport
      ? {
          width: round(window.visualViewport.width),
          height: round(window.visualViewport.height),
          offsetTop: round(window.visualViewport.offsetTop),
          scale: round(window.visualViewport.scale),
        }
      : null,
    dvhSupported: CSS.supports('height', '100dvh'),
    imeOpen: window.innerHeight !== (document.documentElement.clientHeight || 0),
  })

  /** 按钮行：按 top 分组 → 同行子元素宽度和 vs 行容器可用宽度 */
  const buttonRows = (root) => {
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter((el) => el.offsetParent !== null)
    const rows = new Map()
    for (const el of buttons) {
      const rect = el.getBoundingClientRect()
      const key = Math.round(rect.top)
      if (!rows.has(key)) rows.set(key, [])
      rows.get(key).push({ el, rect })
    }
    return [...rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([top, group]) => {
        group.sort((a, b) => a.rect.left - b.rect.left)
        const parent = group[0].el.parentElement
        const parentStyle = cs(parent, [
          'display',
          'flex-wrap',
          'justify-content',
          'gap',
          'column-gap',
          'row-gap',
          'overflow-x',
          'padding-left',
          'padding-right',
        ])
        const parentRect = parent.getBoundingClientRect()
        const inset = parseFloat(parentStyle['padding-left']) + parseFloat(parentStyle['padding-right'])
        // 行容器真正能用的宽度（border-box 减去左右内边距）
        const available = round(parentRect.width - inset)
        const children = group.map(({ el, rect }) => ({
          text: (el.textContent || '').trim().slice(0, 28) || el.getAttribute('aria-label') || '',
          width: round(rect.width),
          height: round(rect.height),
          left: round(rect.left),
          right: round(rect.right),
          // 文字被裁：内容比盒子宽
          textClipped: el.scrollWidth > el.clientWidth + 1,
          css: cs(el, ['min-width', 'flex', 'white-space', 'overflow', 'text-overflow', 'padding-left', 'padding-right']),
        }))
        const span = round(children.at(-1).right - children[0].left)
        // 两行及以上 = 真的换行了；一行但 span 超过可用宽度 = 溢出；一行且明显被压缩 = 挤压
        const wrapped = new Set(group.map(({ rect }) => rect.top)).size > 1
        return {
          top,
          parentClass: (parent.className || '').toString().slice(0, 60),
          parentStyle,
          available,
          childCount: children.length,
          children,
          span,
          overflowPx: round(Math.max(0, span - available)),
          wrapped,
          narrowest: children.reduce((min, c) => Math.min(min, c.width), Infinity),
          shortest: children.reduce((min, c) => Math.min(min, c.height), Infinity),
          anyTextClipped: children.some((c) => c.textClipped),
        }
      })
  }

  /** 真实可滚动容器：scrollHeight/clientHeight 现测出来的溢出（不是 CSS 声明） */
  const scrollHosts = (root) => {
    const list = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue
      const rect = el.getBoundingClientRect()
      list.push({
        cls: (el.className || '').toString().slice(0, 60),
        tag: el.tagName.toLowerCase(),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        scrollTop: el.scrollTop,
        overflowingY: el.scrollHeight > el.clientHeight + 1,
        overflowingX: el.scrollWidth > el.clientWidth + 1,
        // 「能不能滚」按声明判，与 viewport.ts findScrollableAncestor 同一口径
        css: cs(el, [
          'overflow-y',
          'overflow-x',
          'min-height',
          'flex',
          'display',
          'flex-direction',
          'touch-action',
          'overscroll-behavior-y',
          '-webkit-overflow-scrolling',
          'max-height',
          'height',
        ]),
        rect: { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height), width: round(rect.width) },
      })
    }
    return list
  }

  /** 弹窗卡片本身：max-height 链到底算出多少、内容有没有被裁掉 */
  const card = (dialog) => {
    const rect = dialog.getBoundingClientRect()
    const style = cs(dialog, ['max-height', 'height', 'overflow-y', 'overflow-x', 'display', 'flex-direction', 'padding-top', 'padding-bottom'])
    return {
      cls: (dialog.className || '').toString().slice(0, 60),
      rect: { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height), width: round(rect.width) },
      style,
      clientHeight: dialog.clientHeight,
      scrollHeight: dialog.scrollHeight,
      withinViewport: rect.top >= -0.5 && rect.bottom <= window.innerHeight + 0.5,
      bottomGap: round(window.innerHeight - rect.bottom),
    }
  }

  /** 末端内容可到达：滚到底以后，最后一个叶子元素的下沿有没有落进滚动宿主的可视区 */
  const reachability = (host) => {
    if (!host) return null
    const hostRect = host.getBoundingClientRect()
    const leaves = [...host.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && (el.textContent || '').trim().length > 0
    )
    if (leaves.length === 0) return { leafCount: 0 }
    const last = leaves.at(-1)
    const lastRect = last.getBoundingClientRect()
    return {
      leafCount: leaves.length,
      lastText: (last.textContent || '').trim().slice(0, 40),
      lastBottom: round(lastRect.bottom),
      hostBottom: round(hostRect.bottom),
      // 滚到底以后还露不出来 = 内容不可达
      lastVisible: lastRect.top >= hostRect.top - 0.5 && lastRect.bottom <= hostRect.bottom + 0.5,
      atEnd: host.scrollTop + host.clientHeight >= host.scrollHeight - 1,
      remainingScroll: host.scrollHeight - host.clientHeight - host.scrollTop,
    }
  }

  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((el) => el.offsetParent !== null)
  const top = dialogs.at(-1) || null
  const topCardEl = top ? top.closest('[class*="content-"], [role="dialog"]') || top : null
  const scrollHostList = top ? scrollHosts(top) : []
  // 纵向滚动的首选宿主：溢出的里面最高的那个
  const primary = scrollHostList.filter((item) => item.overflowingY).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null

  return {
    ua: navigator.userAgent,
    viewport: viewport(),
    dialogCount: dialogs.length,
    dialog: top ? card(top) : null,
    dialogInner: topCardEl && topCardEl !== top ? card(topCardEl) : null,
    scrollHosts: scrollHostList,
    scrollHostIndex: primary ? top.querySelectorAll('*').length && scrollHostList.indexOf(primary) : -1,
    primaryScrollHost: primary,
    hasScrollableOverflow: Boolean(primary),
    reachability: null,
    emptyStateHints: top ? ((top.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || '') : '',
    buttonRows: top ? buttonRows(top) : [],
    pageButtonRows: dialogs.length ? [] : buttonRows(document.body),
  }
})()`

/**
 * 选中「首选滚动宿主」并滚到底，好让 reachability 有意义。
 * 选择器用同一套判定：溢出的里面 scrollHeight 最大的那个。
 */
const SELECT_HOST = `(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((el) => el.offsetParent !== null)
  const root = dialogs.at(-1) || document.body
  const candidates = [root, ...root.querySelectorAll('*')].filter(
    (el) => el.scrollHeight > el.clientHeight + 1
  )
  candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)
  const host = candidates[0]
  if (!host) return null
  window.__host = host
  return { cls: (host.className || '').toString().slice(0, 60), scrollTop: host.scrollTop, clientHeight: host.clientHeight, scrollHeight: host.scrollHeight }
})()`

const HOST_REACH = `(() => {
  const host = window.__host
  if (!host) return null
  const round = (n) => Math.round(n * 10) / 10
  const hostRect = host.getBoundingClientRect()
  const leaves = [...host.querySelectorAll('*')].filter(
    (el) => el.children.length === 0 && (el.textContent || '').trim().length > 0
  )
  if (leaves.length === 0) return { leafCount: 0 }
  const last = leaves.at(-1)
  const lastRect = last.getBoundingClientRect()
  return {
    leafCount: leaves.length,
    lastText: (last.textContent || '').trim().slice(0, 40),
    lastTop: round(lastRect.top),
    lastBottom: round(lastRect.bottom),
    hostTop: round(hostRect.top),
    hostBottom: round(hostRect.bottom),
    lastVisible: lastRect.top >= hostRect.top - 0.5 && lastRect.bottom <= hostRect.bottom + 0.5,
    atEnd: host.scrollTop + host.clientHeight >= host.scrollHeight - 1,
    remainingScroll: host.scrollHeight - host.clientHeight - host.scrollTop,
  }
})()`

/** 只读宿主 scrollTop —— 滑动前后各读一次，用来判「触摸有没有真的滚起来」 */
const HOST_TOP = `(() => {
  const host = window.__host
  return host ? { scrollTop: host.scrollTop, clientHeight: host.clientHeight, scrollHeight: host.scrollHeight } : null
})()`

// ---------------------------------------------------------------- 动作

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
  sh('shell', 'am', 'force-stop', PKG)
  await sleep(800)
  sh('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
  await sleep(2800)
}

/**
 * 软键盘：焦点进输入框后等键盘动画落下，再读 100vh / visualViewport。
 * 这是「100vh 等于可视高度」唯一能被打脸的场景，所以必须真的弹一次键盘。
 */
const keyboardRound = async (cdp) => {
  const rest = await cdp.evaluate('JSON.parse(JSON.stringify(window.__viewportSnapshot))')
  const focused = await cdp.evaluate(`(() => {
    const el = document.querySelector('textarea, input[type="text"]')
    if (!el) return false
    el.focus()
    el.click()
    return true
  })()`)
  if (!focused) return { rested: rest, focused: false }
  await sleep(1600)
  const open = await cdp.evaluate(`(() => {
    const round = (n) => Math.round(n * 10) / 10
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden'
    document.body.appendChild(probe)
    const measured100vh = round(probe.getBoundingClientRect().height)
    probe.remove()
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      measured100vh,
      visualViewport: window.visualViewport
        ? { width: round(window.visualViewport.width), height: round(window.visualViewport.height), offsetTop: round(window.visualViewport.offsetTop) }
        : null,
      dvhSupported: CSS.supports('height', '100dvh'),
    }
  })()`)
  await sleep(200)
  const imeShown = /mInputShown=true/u.test(sh('shell', 'dumpsys', 'input_method'))
  // 收键盘：只有确认键盘真的弹了才发返回键，否则返回键会去关页面/退 App
  if (imeShown) {
    sh('shell', 'input', 'keyevent', '4')
    await sleep(1000)
  } else {
    await cdp.evaluate(`(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true })()`)
    await sleep(600)
  }
  const closed = await cdp.evaluate(`JSON.parse(JSON.stringify(window.__viewportSnapshot))`)
  return { rested: rest, focused: true, imeShown, withKeyboard: open, afterClose: closed }
}

/** 真实触摸滑动：scrollTop 前后各读一次，delta 就是「触摸有没有把容器滚起来」的唯一证据 */
const swipeRound = async (cdp, tag) => {
  const host = await cdp.evaluate(SELECT_HOST)
  if (!host) return { host: null, note: '没有溢出的滚动宿主，滑不动也无从证伪' }
  const before = await cdp.evaluate(HOST_REACH)
  // getBoundingClientRect 是 CSS px，adb shell input swipe 吃的是显示像素：
  // 必须乘 devicePixelRatio（= density/160，也等于 wm 宽度 / innerWidth）再送给 adb，
  // 否则手势落点整个偏掉 —— 上一版就是这么在 412 档量出「滑不动」的假结论。
  const rect = await cdp.evaluate(`(() => {
    const r = window.__host.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    return {
      dpr,
      x: Math.round((r.left + r.width / 2) * dpr),
      fromY: Math.round((r.top + r.height * 0.75) * dpr),
      toY: Math.round((r.top + r.height * 0.3) * dpr),
      cssRect: { left: Math.round(r.left), top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) },
    }
  })()`)
  const { x, fromY, toY } = rect
  sh('shell', 'input', 'swipe', String(x), String(fromY), String(x), String(toY), '320')
  await sleep(1400)
  const afterUp = await cdp.evaluate(HOST_TOP)
  const reachMid = await cdp.evaluate(HOST_REACH)
  // 再连滑两次到底，量「末端内容到底能不能露出来」
  for (let i = 0; i < 3; i += 1) {
    sh('shell', 'input', 'swipe', String(x), String(fromY), String(x), String(toY), '320')
    await sleep(700)
  }
  const atEnd = await cdp.evaluate(HOST_REACH)
  const shotFile = path.join(OUT, `${tag}-swiped.png`)
  shot(shotFile)
  return {
    host,
    swipeGesture: { x, fromY, toY, durationMs: 320, dpr: rect.dpr, cssRect: rect.cssRect },
    before,
    afterFirstSwipe: { ...afterUp, reach: reachMid },
    atEnd,
    scrollTopBefore: host.scrollTop,
    scrollTopAfterFirstSwipe: afterUp ? afterUp.scrollTop : null,
    scrollTopDelta: afterUp ? afterUp.scrollTop - host.scrollTop : null,
    firstSwipeMoved: Boolean(afterUp) && afterUp.scrollTop > host.scrollTop,
    scrolledBy: before && reachMid ? Math.round(((before.remainingScroll ?? 0) - (reachMid.remainingScroll ?? 0)) * 10) / 10 : null,
    reachableAtEnd: atEnd ? atEnd.lastVisible === true : null,
  }
}

// ---------------------------------------------------------------- 主流程

const run = async () => {
  const tag = process.argv[2] || 'before'
  const widths = process.argv.slice(3).length ? process.argv.slice(3) : ['390', '360', '412']
  mkdirSync(OUT, { recursive: true })
  const results = []
  for (const width of widths) {
    setWidth(width)
    await sleep(1200)
    await restart()
    const cdp = await attach()
    const major = (await cdp.evaluate('navigator.userAgent')).match(/Chrome\/(\d+)/u)?.[1] ?? 'x'
    const base = `${tag}-wv${major}-${width}`

    // 0) 视口快照落到 window 上，键盘轮次里前后对比
    await cdp.evaluate(`(() => {
      const round = (n) => Math.round(n * 10) / 10
      const probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden'
      document.body.appendChild(probe)
      const measured100vh = round(probe.getBoundingClientRect().height)
      probe.remove()
      window.__viewportSnapshot = {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        measured100vh,
        visualViewport: window.visualViewport
          ? { width: round(window.visualViewport.width), height: round(window.visualViewport.height), offsetTop: round(window.visualViewport.offsetTop), scale: round(window.visualViewport.scale) }
          : null,
        dvhSupported: CSS.supports('height', '100dvh'),
      }
      return window.__viewportSnapshot
    })()`)

    // 1) 假设 4：静息态 / 软键盘弹出态
    shot(path.join(OUT, `${base}-home.png`))
    const keyboard = await keyboardRound(cdp)

    // 2) 打开设置页
    for (const step of OPEN_SETTINGS) await cdp.evaluate(step)
    await sleep(1600)
    const ready = await cdp.evaluate(SETTINGS_READY)
    if (!ready) {
      console.error(`[${tag} ${width}] 设置面板没打开，跳过（不静默出图）`)
      cdp.close()
      continue
    }
    const settings = await cdp.evaluate(PROBE)
    // 3) 假设 2 + 3：真实触摸滑动
    const swipe = await swipeRound(cdp, `${base}-settings`)
    shot(path.join(OUT, `${base}-settings.png`))
    const settingsAfter = await cdp.evaluate(PROBE)

    // 4) 假设 1：确认弹窗的按钮行（Modal .footer 没有 flex-wrap，是最危险的一档）
    const openedConfirm = await cdp.evaluate(`(() => { ${Q}
      const target = window.__q(/^(Delete|删除)$/)
      if (!target) return false
      target.click()
      return true
    })()`)
    await sleep(1200)
    const confirm = openedConfirm ? await cdp.evaluate(PROBE) : null
    if (confirm) shot(path.join(OUT, `${base}-confirm.png`))
    if (confirm) {
      // 关掉确认弹窗，别让它影响下一档（取消，绝不点确认）
      await cdp.evaluate(`(() => { ${Q}
        const cancel = window.__q(/^(Cancel|取消)$/)
        if (cancel) cancel.click()
        return 'ok'
      })()`)
      await sleep(800)
    }

    const data = {
      tag,
      width,
      webviewMajor: major,
      ua: settings.ua,
      wmSize: sh('shell', 'wm', 'size'),
      wmDensity: sh('shell', 'wm', 'density'),
      keyboard,
      settingsDialog: {
        probe: settings,
        swipe,
        afterSwipe: settingsAfter,
      },
      confirmDialog: confirm,
    }
    writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(data, null, 1))
    results.push({
      width,
      innerWidth: settings.viewport.innerWidth,
      settingsScrollHost: settings.primaryScrollHost?.cls ?? null,
      settingsScrollable: settings.hasScrollableOverflow,
      swipeDelta: swipe.scrolledBy,
      reachableAtEnd: swipe.reachableAtEnd,
      vhRest: keyboard.rested?.measured100vh,
      vvRest: keyboard.rested?.visualViewport?.height,
      vhKeyboard: keyboard.withKeyboard?.measured100vh,
      vvKeyboard: keyboard.withKeyboard?.visualViewport?.height,
      imeShown: keyboard.imeShown,
      confirmRows: confirm?.buttonRows?.length ?? 0,
    })
    console.log(`[${tag} ${width}] innerWidth=${settings.viewport.innerWidth} 宿主=${settings.primaryScrollHost?.cls ?? '无'} 滑动位移=${swipe.scrolledBy} 末端可达=${swipe.reachableAtEnd} 100vh(静息)=${keyboard.rested?.measured100vh} vv=${keyboard.rested?.visualViewport?.height} 键盘态 100vh=${keyboard.withKeyboard?.measured100vh} vv=${keyboard.withKeyboard?.visualViewport?.height}`)
    for (const row of settings.buttonRows) {
      if (row.childCount > 1) {
        console.log(`  按钮行 top=${row.top} n=${row.childCount} span=${row.span} avail=${row.available} 溢出=${row.overflowPx} 换行=${row.wrapped} 最窄=${row.narrowest} 最矮=${row.shortest} 文字被裁=${row.anyTextClipped} · ${row.children.map((c) => c.text).join(' / ')}`)
      }
    }
    if (confirm) {
      for (const row of confirm.buttonRows) {
        if (row.childCount > 1) {
          console.log(`  确认弹窗按钮行 top=${row.top} n=${row.childCount} span=${row.span} avail=${row.available} 溢出=${row.overflowPx} 换行=${row.wrapped} 最窄=${row.narrowest} · ${row.children.map((c) => c.text).join(' / ')}`)
        }
      }
    }
    cdp.close()
  }
  writeFileSync(path.join(OUT, `${tag}-summary.json`), JSON.stringify(results, null, 1))
  console.log('\n汇总已写入', path.join(OUT, `${tag}-summary.json`))
}

run()
