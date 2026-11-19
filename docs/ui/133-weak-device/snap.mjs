// Issue #133：长会话截图（360dp / 390dp）。
// 用 firstscreen.mjs 已跑通的点击路径进会话，截图改用设备侧 `adb exec-out screencap -p`
// （无 GPU 的 headless 模拟器上，WebView 的 Page.captureScreenshot 会复用到旧帧）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { attach, sleep, sh, PACKAGE, OUT } from './cdp.mjs'

const ADB = process.env.ADB || 'adb' // 默认走 PATH；换机器请设 ADB=<绝对路径>（#302 去掉写死盘符）
const [title, totalArg] = process.argv.slice(2)
const total = Number(totalArg)

const HOST = `(() => {
  const queue = [document.body]
  let best = null
  while (queue.length) {
    const element = queue.shift()
    if (/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight - element.clientHeight > 0) {
      if (!best || element.scrollHeight > best.scrollHeight) best = element
    }
    for (const child of element.children) queue.push(child)
  }
  return best
})()`

const snap = (name) => {
  mkdirSync(`${OUT}screens`, { recursive: true })
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  const file = `${OUT}screens/${name}.png`
  writeFileSync(file, png)
  console.log('  截图:', file, png.length, 'bytes')
  return file
}

const openSession = async (cdp) => cdp.evaluate(`(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const deadline = performance.now() + 60000
  while (performance.now() < deadline) {
    await frame()
    if (!document.querySelector('[role="status"]') && document.querySelector('button[aria-label]')) break
  }
  const menu = [...document.querySelectorAll('button[aria-label]')].find((node) => !node.closest('[role="dialog"]'))
  if (!menu) return { error: '没有菜单按钮' }
  menu.click()
  let target = null
  while (performance.now() < deadline) {
    await frame()
    target = [...document.querySelectorAll('div')].find((node) => node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(title)})
    if (target) break
  }
  if (!target) return { error: '抽屉里没有目标会话' }
  await frame()
  target.click()
  const host = ${HOST}
  while (performance.now() < deadline) {
    await frame()
    const last = document.querySelector('[data-row-index="${total - 1}"]')
    if (last && last.textContent.trim().length > 0) {
      return { ok: true, scrollTop: host ? host.scrollTop : -1, rows: document.querySelectorAll('[data-row-id]').length }
    }
  }
  return { error: '最后一条没出现' }
})()`)

const main = async () => {
  const suffix = process.argv[4] || '360dp'
  const { cdp } = await attach()
  const opened = await openSession(cdp)
  console.log('打开:', JSON.stringify(opened))
  if (opened.error) throw new Error(opened.error)
  await sleep(1500)
  snap(`133-long-${total}-last-${suffix}`)
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button[aria-label]')].find((node) => /回到首条|first message/i.test(node.getAttribute('aria-label') || ''))
    if (!button) return false
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  await sleep(2000)
  console.log('  首条 scrollTop:', await cdp.evaluate(`(() => { const host = ${HOST}; return host ? host.scrollTop : -1 })()`))
  snap(`133-long-${total}-first-${suffix}`)
  cdp.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
