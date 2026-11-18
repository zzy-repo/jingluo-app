// 在真实老内核（compat31 / WebView 91.0.4472.114）上量「反馈与日志」这一行的实际布局。
// WebView 91 不支持 Playwright 的 connectOverCDP（无 Browser context 管理），
// 这里直接用 page 级 CDP：Runtime.evaluate 读 computed style、Input.dispatchTouchEvent 点按钮、
// Page.captureScreenshot 截图。全程只读页面状态 + 真实触摸，不做任何 CSS 能力模拟。
// 用法: node repro/webview91-measure.mjs <tag> <outDir>
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const tag = process.argv[2] || 'run'
const out = process.argv[3] || '/root/shots/scf-wv91'
// 第 3 个参数：可选 in-app 语言（zh-CN / en-US）。走 App 自己的语言设置（localStorage 键 chat-demo:locale），
// 不是 CSS/能力模拟；英文按钮更长，正是 #57 报告里的界面语言。
const locale = process.argv[4] || ''
await mkdir(out, { recursive: true })

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!target) throw new Error('no page target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
const send = (method, params = {}, timeoutMs = 25000) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (fnSource, arg, timeoutMs = 25000) => {
  const res = await send(
    'Runtime.evaluate',
    {
      expression: `(${fnSource})(${JSON.stringify(arg ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    },
    timeoutMs,
  )
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.error('[step]', name)

if (tag === 'locale') {
  // 只切 App 自己的语言设置后退出（换语言会整页重载，单独一次跑，避免后续 CDP 调用撞上重载）
  const value = process.argv[3] || 'zh-CN'
  const applied = await evaluate((v) => {
    localStorage.setItem('chat-demo:locale', v)
    return localStorage.getItem('chat-demo:locale')
  }, value)
  await send('Page.reload', {})
  console.log('locale set to', applied)
  await wait(4000)
  ws.close()
  process.exit(0)
}

if (locale) {
  await evaluate((value) => {
    localStorage.setItem('chat-demo:locale', value)
    return localStorage.getItem('chat-demo:locale')
  }, locale)
  await send('Page.reload', {})
  await wait(6000)
}
step('connected')
const pageInfo = await evaluate(() => ({
  url: location.href,
  title: document.title,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  webviewVersion: navigator.userAgent,
}))

/**
 * 真实触摸点按：CDP 求元素中心的 CSS 坐标，换算成设备像素后用 `adb shell input tap` 点（WebView 91 的
 * Input.dispatchTouchEvent 在这里 touchEnd 不返回响应，绕开它；点按仍是真实触摸，不是 JS 合成）。
 */
const tap = async (matcher) => {
  const point = await evaluate((m) => {
    const re = new RegExp(m.source, m.flags)
    const els = [...document.querySelectorAll('button,[role="tab"],[role="button"]')].filter((el) => {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim()
      return re.test(name) && el.getBoundingClientRect().width > 0
    })
    const el = els[els.length - 1]
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
      name: (el.textContent || '').trim(),
      dpr: window.devicePixelRatio,
      offsetY: window.screenY || 0,
    }
  }, matcher)
  if (!point) throw new Error('tap target not found: ' + matcher)
  const dx = Math.round(point.x * point.dpr)
  const dy = Math.round(point.y * point.dpr + point.offsetY)
  execFileSync('adb', ['shell', 'input', 'tap', String(dx), String(dy)], { stdio: 'ignore' })
  await wait(1200)
  return { ...point, dx, dy }
}

const collect = () =>
  evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10
    const box = (el) => {
      const b = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return {
        w: round(b.width),
        h: round(b.height),
        x: round(b.x),
        y: round(b.y),
        flex: `${s.flexGrow} ${s.flexShrink} ${s.flexBasis}`,
        minWidth: s.minWidth,
        flexWrap: s.flexWrap,
        padRight: s.paddingRight,
        wordBreak: s.wordBreak,
        overflowWrap: s.overflowWrap,
      }
    }
    const rows = [...document.querySelectorAll('[class*=" row-"]')].map((row) => {
      const t = row.querySelector('[class*="text-"]')
      const a = row.querySelector('[class*="cellActions-"]')
      const l = t?.querySelector('[class*="label-"]')
      const lh = l ? parseFloat(getComputedStyle(l).lineHeight) : 0
      return {
        label: (l?.textContent || '').slice(0, 20),
        row: box(row),
        text: t ? box(t) : null,
        actions: a ? box(a) : null,
        labelLines: l && lh ? Math.round(l.getBoundingClientRect().height / lh) : null,
        buttons: [...(a?.querySelectorAll('button') || [])].map((b) => ({
          text: (b.textContent || '').trim(),
          w: round(b.getBoundingClientRect().width),
          x: round(b.getBoundingClientRect().x),
          y: round(b.getBoundingClientRect().y),
        })),
      }
    })
    const panel = document.querySelector('[role="tabpanel"]')
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      panelW: panel ? round(panel.getBoundingClientRect().width) : null,
      panelOverflowX: panel ? Math.round(panel.scrollWidth - panel.clientWidth) : null,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rows,
    }
  })

step('pageInfo')
// --- 进入 设置 → 数据管理 ---
let dialogs = await evaluate(() => document.querySelectorAll('[role="dialog"]').length)
if (!dialogs) {
  await tap({ source: '边栏|菜单|sidebar|menu', flags: 'i' })
  await tap({ source: '设置|Settings', flags: '' })
  dialogs = await evaluate(() => document.querySelectorAll('[role="dialog"]').length)
  if (!dialogs) throw new Error('settings dialog did not open')
}
step('settings open')
await tap({ source: '数据管理|Data', flags: '' })
await wait(500)
await evaluate(() => {
  const panel = document.querySelector('[role="tabpanel"]')
  if (panel) panel.scrollTop = panel.scrollHeight
  window.scrollTo(0, document.body.scrollHeight)
})
await wait(700)

step('tab + scroll')
const metrics = await collect()
step('collected')
const shot = await send('Page.captureScreenshot', { format: 'png' })
step('screenshot')
await writeFile(`${out}/${tag}.png`, Buffer.from(shot.data, 'base64'))
await writeFile(`${out}/${tag}.json`, JSON.stringify({ page: pageInfo, metrics }, null, 2))
console.log(JSON.stringify({ page: pageInfo, metrics }, null, 2))
ws.close()
