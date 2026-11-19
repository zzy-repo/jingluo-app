// Issue #133 弱网兜底第二轮：第一轮发现「15s 超时会自动重试 2 次」，40s 预算看不到最终结论，
// 且 trickle 场景的错误正则把正文里的「网络」误判成错误文案。这里收紧正则、拉长预算，
// 只补三个场景：hold 长等、trickle 长等、不可达长等。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { attach, sleep, OUT } from './cdp.mjs'

const ADB = process.env.ADB || 'adb' // 默认走 PATH；换机器请设 ADB=<绝对路径>（#302 去掉写死盘符）
const KEY = 'chat-demo:base-url:openai'

const snap = (name) => {
  mkdirSync(`${OUT}screens`, { recursive: true })
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(`${OUT}screens/${name}.png`, png)
  console.log('  截图:', `${OUT}screens/${name}.png`)
}

const runScenario = async (cdp, baseUrl, budgetMs) => {
  await cdp.evaluate(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(baseUrl)}); return true })()`)
  await cdp.evaluate('location.reload()').catch(() => {})
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
    setValue.call(textarea, '弱网长等自测')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    await frame()
    const sendButton = [...document.querySelectorAll('button[aria-label]')].find((node) => /^(send|发送)/i.test(node.getAttribute('aria-label') || ''))
    if (!sendButton) return { error: '没有发送按钮' }
    const sentAt = performance.now()
    sendButton.click()

    // 只认真正的失败/中断/重试文案，避免把正文里的「网络」当错误
    const failurePattern = /Retrying|retrying|timed out|Request timed out|connection was interrupted|Network Error|went wrong|Something went wrong|failed to|Request failed/i
    const stopAlive = () =>
      [...document.querySelectorAll('button[aria-label]')].some((node) => /stop|停止/i.test(node.getAttribute('aria-label') || ''))
    const lastBody = () => {
      const rows = [...document.querySelectorAll('[data-row-id]')]
      return rows.length > 0 ? rows[rows.length - 1].innerText.trim() : ''
    }

    const timeline = []
    let lastSampleAt = -1000
    let retryCount = 0
    let lastRetryText = null
    let failureAtMs = null
    let failureText = null
    let settledAtMs = null
    let streamingSeen = false

    while (performance.now() - sentAt < ${budgetMs}) {
      await frame()
      const elapsed = Math.round(performance.now() - sentAt)
      const body = lastBody()
      const stop = stopAlive()
      if (stop) streamingSeen = true
      if (/Retrying/i.test(body) && body !== lastRetryText) {
        retryCount += 1
        lastRetryText = body
        timeline.push({ at: elapsed, kind: 'retry', body: body.slice(0, 120) })
      }
      if (failureAtMs === null && failurePattern.test(body) && !/Retrying/i.test(body)) {
        failureAtMs = elapsed
        failureText = body.slice(0, 500)
      }
      if (streamingSeen && !stop && settledAtMs === null) settledAtMs = elapsed
      if (elapsed - lastSampleAt >= 2000) {
        lastSampleAt = elapsed
        const bodyNow = lastBody()
        timeline.push({ at: elapsed, kind: 'sample', stop, body: bodyNow.slice(-160) })
      }
      if (settledAtMs !== null && failureAtMs !== null) break
      if (settledAtMs !== null && !failurePattern.test(lastBody())) break
    }
    return {
      retryCount,
      failureAtMs,
      failureText,
      settledAtMs,
      finalBody: lastBody().slice(0, 600),
      finalStop: stopAlive(),
      rows: document.querySelectorAll('[data-row-id]').length,
      timeline,
    }
  })()`)
}

const SCENARIOS = [
  { name: 's1-hold-long', url: 'http://10.0.2.2:5399/hold/v1', budget: 100000 },
  { name: 's3-trickle-long', url: 'http://10.0.2.2:5399/trickle/v1', budget: 70000 },
  { name: 's4-unreachable-long', url: 'http://10.0.2.2:5398/v1', budget: 100000 },
]

const main = async () => {
  const { cdp } = await attach()
  const results = []
  for (const scenario of SCENARIOS) {
    console.log(`=== ${scenario.name} ${scenario.url}`)
    const result = await runScenario(cdp, scenario.url, scenario.budget)
    results.push({ scenario: scenario.name, url: scenario.url, ...result })
    console.log('  ', JSON.stringify({ ...result, timeline: undefined }))
    for (const item of result.timeline || []) console.log(`     t=${item.at}ms ${item.kind} stop=${item.stop} body=${JSON.stringify(item.body)}`)
    await sleep(500)
    snap(`133-weaknet-${scenario.name}-360dp`)
  }
  writeFileSync(`${OUT}weaknet-results-long.json`, JSON.stringify(results, null, 2))
  cdp.close()
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exit(1)
})
