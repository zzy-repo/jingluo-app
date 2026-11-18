#!/usr/bin/env node
/**
 * P3 · 网络异常（老内核）：把 #133 的弱网取证手法搬到 WebView 83 / 91 上重跑一遍，跟 109 的既有结论对照。
 *
 * 手法原样照抄 docs/ui/133-weak-device/weaknet.mjs 与 weaknet2.mjs：
 *   只改 localStorage 的 openai baseUrl（chat-demo:base-url:openai）→ 重载 → 发一条消息 → 逐帧记录
 *   「转圈还在不在 / 停止按钮还在不在 / 有没有可解释的失败文案 / 自动重试几次」。
 * 上游形态由 lib/shape-server.mjs 按 URL 首段决定（ok / hold / cut / trickle），不可达用没人监听的端口。
 *
 * 与 109 的既有基线（#133 / #150 / #154）对照：
 *   109：hold → 15s 超时后自动重试 2 次、最终可解释；trickle → 永不超时、无限 streaming（#150）；
 *        offline → 被误判成普通「网络异常」（#154）。
 * 这里只做「同不一致」的判定：一致就把严重度按 109 的结论抄；不一致就是新发现。
 *
 * 用法：node scripts/compat/p3-net.mjs --api 26 [--scenario s1-hold] [--port 5419]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { ADB, ensureDir, environment, evidenceDir, now, screencap, shell, sleep } from './lib/device.mjs'
import { attach } from './lib/cdp.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}

const API = option('api')
const PORT = Number(option('port', 5419))
const ONLY = option('scenario')
const DEAD_PORT = Number(option('dead-port', 5418))
if (!API) {
  console.error('用法：node scripts/compat/p3-net.mjs --api <NN> [--scenario <name>]')
  process.exit(2)
}

const KEY = 'chat-demo:base-url:openai'

const runScenario = async (cdp, baseUrl, budgetMs) => {
  await cdp.evaluate(
    `(() => { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(baseUrl)}); return true })()`
  )
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
    if (!textarea) return { error: '没有输入框（主界面没起来）' }
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setValue.call(textarea, '弱网兜底自测')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    await frame()
    const sendButton = [...document.querySelectorAll('button[aria-label]')].find((node) => /^(send|发送)/i.test(node.getAttribute('aria-label') || ''))
    if (!sendButton) return { error: '没有发送按钮' }
    const sentAt = performance.now()
    sendButton.click()

    // 只认真正的失败/中断/重试文案，避免把正文里的「网络」当错误（#133 第二轮踩过这个坑）
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
    let firstTextMs = null

    while (performance.now() - sentAt < ${budgetMs}) {
      await frame()
      const elapsed = Math.round(performance.now() - sentAt)
      const body = lastBody()
      const stop = stopAlive()
      if (body.length > 0 && firstTextMs === null) firstTextMs = elapsed
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
        timeline.push({ at: elapsed, kind: 'sample', stop, body: lastBody().slice(-160) })
      }
      if (settledAtMs !== null && failureAtMs !== null) break
      if (settledAtMs !== null && !failurePattern.test(lastBody())) break
    }
    return {
      retryCount,
      firstTextMs,
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
  { name: 's0-ok', url: `http://10.0.2.2:${PORT}/ok/v1`, budget: 30_000 },
  { name: 's1-hold', url: `http://10.0.2.2:${PORT}/hold/v1`, budget: 100_000 },
  { name: 's2-cut', url: `http://10.0.2.2:${PORT}/cut/v1`, budget: 40_000 },
  { name: 's3-trickle', url: `http://10.0.2.2:${PORT}/trickle/v1`, budget: 70_000 },
  { name: 's4-unreachable', url: `http://10.0.2.2:${DEAD_PORT}/v1`, budget: 100_000 },
]

const main = async () => {
  const outDir = ensureDir(evidenceDir(API))
  ensureDir(`${outDir}/shots`)
  const result = {
    phase: 'p3-net',
    api: Number(API),
    startedAt: new Date().toISOString(),
    device: environment(),
    shapePort: PORT,
    scenarios: [],
  }

  const server = spawn(process.execPath, [new URL('./lib/shape-server.mjs', import.meta.url).pathname], {
    env: { ...process.env, SHAPE_PORT: String(PORT) },
    stdio: 'ignore',
    detached: false,
  })
  await sleep(1200)

  const { cdp } = await attach()
  try {
    for (const scenario of SCENARIOS.filter((item) => !ONLY || item.name === ONLY)) {
      console.log(`[${now()}] === ${scenario.name} ${scenario.url}`)
      const outcome = await runScenario(cdp, scenario.url, scenario.budget)
      result.scenarios.push({ scenario: scenario.name, url: scenario.url, budgetMs: scenario.budget, ...outcome })
      console.log(
        `  ${JSON.stringify({
          retryCount: outcome.retryCount,
          failureAtMs: outcome.failureAtMs,
          settledAtMs: outcome.settledAtMs,
          finalStop: outcome.finalStop,
        })}`
      )
      for (const item of (outcome.timeline ?? []).slice(-8)) {
        console.log(`     t=${item.at}ms ${item.kind} stop=${item.stop} ${JSON.stringify(item.body)}`)
      }
      screencap(`${outDir}/shots/p3-${scenario.name}.png`)
      await sleep(500)
    }

    // offline：#154 在 109 上是「断网被误判成普通网络异常」，这里看老内核是否同样
    if (!ONLY || ONLY === 's5-offline') {
      console.log(`[${now()}] === s5-offline`)
      shell('cmd', 'connectivity', 'airplane-mode', 'enable')
      await sleep(3000)
      const outcome = await runScenario(cdp, `http://10.0.2.2:${PORT}/ok/v1`, 60_000)
      result.scenarios.push({ scenario: 's5-offline', url: 'http://10.0.2.2/ok/v1 (airplane-mode)', budgetMs: 60_000, ...outcome })
      console.log(`  offline: ${JSON.stringify({ failureAtMs: outcome.failureAtMs, failureText: outcome.failureText })}`)
      screencap(`${outDir}/shots/p3-s5-offline.png`)
      shell('cmd', 'connectivity', 'airplane-mode', 'disable')
      await sleep(3000)
    }
  } finally {
    cdp.close()
    server.kill()
  }

  writeFileSync(`${outDir}/result-p3.json`, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`证据：${outDir}/result-p3.json`)
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exit(1)
})
