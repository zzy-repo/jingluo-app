// Issue #133 弱网/超时兜底取证（宿主机整形，Android 模拟器 API33）。
// 场景由 shape-server.mjs 按 URL 首段区分：
//   /ok      正常 200 SSE
//   /hold    收下请求后一个字节都不写（模拟「连上了但不回」）
//   /cut     吐两个 delta 后直接 destroy socket（模拟半死连接）
//   /trickle 每 3s 一个 delta，共 8 个（模拟龟速但活着）
//   5398     没有进程监听（模拟不可达）
// 每个场景：改 localStorage 的 openai baseUrl → 重载 → 发一条消息 → 逐帧记录
// 「转圈还在不在 / 停止按钮还在不在 / 有没有可解释的失败文案」，最后 screencap 截图。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { attach, sleep, OUT } from './cdp.mjs'

const ADB = process.env.ADB || 'D:/android-sdk/platform-tools/adb.exe'
const KEY = 'chat-demo:base-url:openai'

const snap = (name) => {
  mkdirSync(`${OUT}screens`, { recursive: true })
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(`${OUT}screens/${name}.png`, png)
  console.log('  截图:', `${OUT}screens/${name}.png`)
}

const setBaseUrl = (cdp, url) =>
  cdp.evaluate(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(url)}); return localStorage.getItem(${JSON.stringify(KEY)}) })()`)

const runScenario = async (cdp, baseUrl, budgetMs) => {
  await setBaseUrl(cdp, baseUrl)
  await cdp.evaluate("location.reload()").catch(() => {})
  await sleep(3500)
  return cdp.evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const deadline = performance.now() + 20000
    while (performance.now() < deadline) {
      await frame()
      if (!document.querySelector('[role="status"]') && document.querySelector('textarea')) break
    }
    const textarea = document.querySelector('textarea')
    if (!textarea) return { error: '没有输入框' }
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setValue.call(textarea, '弱网兜底自测')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    await frame()
    const sendButton = [...document.querySelectorAll('button[aria-label]')].find((node) => /^(send|发送)/i.test(node.getAttribute('aria-label') || ''))
    if (!sendButton) return { error: '没有发送按钮' }
    const sentAt = performance.now()
    sendButton.click()

    const spinnerSeen = []
    let firstTextMs = null
    let errorAtMs = null
    let errorText = null
    let spinnerGoneAtMs = null
    let stopSeenAtMs = null
    let stopGoneAtMs = null
    const timeline = []
    let lastSampleAt = -1000
    const errorPattern = /timed out|timeout|超时|Network Error|网络|interrupted|中断|went wrong|failed|失败|错误/i

    while (performance.now() - sentAt < ${budgetMs}) {
      await frame()
      const elapsed = Math.round(performance.now() - sentAt)
      const spinner = Boolean(document.querySelector('[role="status"]'))
      const stop = [...document.querySelectorAll('button[aria-label]')].some((node) => /stop|停止/i.test(node.getAttribute('aria-label') || ''))
      const rows = [...document.querySelectorAll('[data-row-id]')]
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null
      const body = lastRow ? lastRow.innerText.trim() : ''
      if (spinner && spinnerSeen.length === 0) spinnerSeen.push(elapsed)
      if (spinner && spinnerGoneAtMs === null && spinnerSeen.length > 0) {
        // 连续两帧都没转圈才算消失（下面单独判断）
      }
      if (stop && stopSeenAtMs === null) stopSeenAtMs = elapsed
      if (spinnerSeen.length > 0 && !spinner && spinnerGoneAtMs === null) spinnerGoneAtMs = elapsed
      if (stopSeenAtMs !== null && !stop && stopGoneAtMs === null) stopGoneAtMs = elapsed
      if (firstTextMs === null && body.length > 0) firstTextMs = elapsed
      if (errorAtMs === null && errorPattern.test(body)) {
        errorAtMs = elapsed
        errorText = body.slice(0, 400)
        timeline.push({ at: elapsed, body: body.slice(0, 200), spinner, stop })
        break
      }
      if (elapsed - lastSampleAt >= 1000) {
        lastSampleAt = elapsed
        timeline.push({ at: elapsed, body: body.slice(0, 160), spinner, stop })
      }
    }
    const rows = [...document.querySelectorAll('[data-row-id]')]
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null
    return {
      spinnerFirstMs: spinnerSeen.length > 0 ? spinnerSeen[0] : null,
      spinnerGoneMs: spinnerGoneAtMs,
      stopSeenMs: stopSeenAtMs,
      stopGoneMs: stopGoneAtMs,
      firstTextMs,
      errorAtMs,
      errorText,
      finalBody: lastRow ? lastRow.innerText.trim().slice(0, 600) : null,
      finalSpinner: Boolean(document.querySelector('[role="status"]')),
      finalStop: [...document.querySelectorAll('button[aria-label]')].some((node) => /stop|停止/i.test(node.getAttribute('aria-label') || '')),
      rows: rows.length,
      timeline,
    }
  })()`)
}

const SCENARIOS = [
  { name: 's0-ok', url: 'http://10.0.2.2:5399/ok/v1', budget: 25000, expect: '正常流式完成，转圈与停止按钮都在结束时消失' },
  { name: 's1-hold', url: 'http://10.0.2.2:5399/hold/v1', budget: 40000, expect: '15s 请求超时 → 可解释失败文案，转圈与停止按钮消失' },
  { name: 's2-cut', url: 'http://10.0.2.2:5399/cut/v1', budget: 25000, expect: '半死连接 → 正文中断提示，不残留半句为已完成' },
  { name: 's3-trickle', url: 'http://10.0.2.2:5399/trickle/v1', budget: 45000, expect: '龟速但活着 → 观察是否无限等待（体相阶段无超时）' },
  { name: 's4-unreachable', url: 'http://10.0.2.2:5398/v1', budget: 20000, expect: '连接被拒 → 网络错误文案' },
]

const main = async () => {
  const { cdp } = await attach()
  const results = []
  for (const scenario of SCENARIOS) {
    console.log(`=== ${scenario.name} ${scenario.url}`)
    const result = await runScenario(cdp, scenario.url, scenario.budget)
    results.push({ scenario: scenario.name, url: scenario.url, expect: scenario.expect, ...result })
    console.log('  ', JSON.stringify({ ...result, timeline: undefined }))
    for (const item of result.timeline || []) console.log(`     t=${item.at}ms spinner=${item.spinner} stop=${item.stop} body=${JSON.stringify(item.body)}`)
    await sleep(500)
    snap(`133-weaknet-${scenario.name}-360dp`)
  }
  writeFileSync(`${OUT}weaknet-results.json`, JSON.stringify(results, null, 2))
  cdp.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
