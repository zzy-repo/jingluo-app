// Issue #133：给报告补一组「真正的最后一条 / 第一条」截图。
// 首屏耗时脚本里两次 captureScreenshot 拿到同一帧（无 GPU 的 headless 模拟器上
// WebView 合成器复用了旧帧），所以这里加显式等待与两段独立的 capture。
//
// 用法：node shoot.mjs <会话标题> <消息数> <文件后缀，如 360dp / 390dp>
import { attach, shot, sleep, sh, PACKAGE } from './cdp.mjs'

const [title, totalArg, suffix] = process.argv.slice(2)
const total = Number(totalArg)

const findHost = `(() => {
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

const menu = `(() => {
  const node = [...document.querySelectorAll('button[aria-label]')].find((item) => !item.closest('[role="dialog"]'))
  if (node) node.click()
  return Boolean(node)
})()`

const main = async () => {
  // 先重启 App 再挂 CDP：反过来会连着已被 force-stop 杀掉的页面，evaluate 永远不返回
  sh('shell', 'am', 'force-stop', PACKAGE)
  sh('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
  await sleep(3000)
  const { cdp } = await attach()

  const lastSeen = await cdp.evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const started = performance.now()
    const deadline = started + 60000
    // 等 App 就绪（loading 视图消失）
    while (performance.now() < deadline) {
      await frame()
      if (!document.querySelector('[role="status"]') && document.querySelector('button[aria-label]')) break
    }
    // 打开抽屉并等会话项出现
    let node = null
    while (performance.now() < deadline) {
      const menu = [...document.querySelectorAll('button[aria-label]')].find((item) => !item.closest('[role="dialog"]'))
      if (menu) menu.click()
      await frame()
      node = [...document.querySelectorAll('div')].find((item) => item.children.length === 0 && item.textContent.trim() === ${JSON.stringify(title)})
      if (node) break
    }
    if (!node) return { error: '没找到会话项' }
    await frame()
    node.click()
    const openedAt = performance.now()
    const host = ${findHost}
    while (performance.now() < deadline) {
      await frame()
      const last = document.querySelector('[data-row-index="${total - 1}"]')
      if (last && last.textContent.trim().length > 0) {
        return { lastRowMs: Math.round(performance.now() - openedAt), scrollTop: host ? host.scrollTop : -1 }
      }
    }
    return { error: '最后一条没出现' }
  })()`)
  console.log('打开结果:', JSON.stringify(lastSeen))
  await sleep(800)
  const lastFile = await shot(cdp, `133-long-${total}-last-${suffix}`)
  console.log('最后一条截图:', lastFile)

  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button[aria-label]')].find((node) =>
      /回到首条|first message/i.test(node.getAttribute('aria-label') || '')
    )
    if (!button) return false
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  await sleep(1500)
  console.log('回到首条后 scrollTop:', await cdp.evaluate(`(() => { const host = ${findHost}; return host ? host.scrollTop : -1 })()`))
  const firstFile = await shot(cdp, `133-long-${total}-first-${suffix}`)
  console.log('第一条截图:', firstFile)
  cdp.close()
}

main().catch((error) => {
  console.error('失败:', error)
  process.exit(1)
})
