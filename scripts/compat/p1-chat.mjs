#!/usr/bin/env node
/**
 * P1 · 聊天冒烟：进主界面后真发一条消息，确认真实出字（不是只看 DOM 有没有 textarea）。
 *
 * 判据（全部原始值进 result-chat.json）：
 *   - 发送后 [data-row-id] 行数是否增加
 *   - 首字时间 firstTextMs（最后一行文字从 0 变非 0 的时刻）
 *   - finalBody 完整正文原文 + 是否命中失败/重试文案
 *   - 进程是否还活着、页面是否已 __DEEPSEEK_BOOTED__、截图
 *
 * 用法（设备已在跑）：node scripts/compat/p1-chat.mjs --api 34 [--text "你好"] [--budget 60]
 */
import { writeFileSync } from 'node:fs'
import { ensureDir, environment, evidenceDir, now, pidOf, saveJson, screencap, sleep } from './lib/device.mjs'
import { BOOT_STATE, attach } from './lib/cdp.mjs'
import { visibleTexts } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? true) : fallback
}

const API = option('api')
const TEXT = option('text', '你好，请只回一句话。')
const BUDGET = Number(option('budget', 60)) * 1000
/** 真上游冒烟：给了就先把渠道切成 openai 兼容并写进地址/模型/Key（Key 只进 localStorage，绝不落证据） */
const BASE_URL = option('base-url')
const MODEL = option('model', 'deepseek-v4.1-flash')
const KEY = option('key')
if (!API) {
  console.error('用法：node scripts/compat/p1-chat.mjs --api <NN> [--text ...] [--budget 60]')
  process.exit(2)
}

const main = async () => {
  const outDir = ensureDir(evidenceDir(API))
  const result = {
    phase: 'p1-chat',
    api: Number(API),
    startedAt: new Date().toISOString(),
    text: TEXT,
    baseUrlKey: null,
    baseUrl: null,
    device: environment(),
  }
  console.log(`[${now()}] WebView：${result.device.webViewVersionLine}`)

  const { cdp } = await attach()
  try {
    const boot = await cdp.evaluate(BOOT_STATE, 20_000)
    result.boot = { booted: boot.booted, boxText: boot.boxText, bodyTextHead: boot.bodyTextHead }

    if (BASE_URL) {
      const configured = await cdp.evaluate(
        `(() => {
          localStorage.setItem('chat-demo:provider-kind', 'openai')
          localStorage.setItem('chat-demo:base-url:openai', ${JSON.stringify(BASE_URL)})
          localStorage.setItem('chat-demo:model:openai', ${JSON.stringify(MODEL)})
          localStorage.setItem('chat-demo:api-key', ${JSON.stringify(KEY ?? '')})
          return { kind: localStorage.getItem('chat-demo:provider-kind'), baseUrl: localStorage.getItem('chat-demo:base-url:openai'), model: localStorage.getItem('chat-demo:model:openai'), keyLength: (localStorage.getItem('chat-demo:api-key') || '').length }
        })()`,
        15_000
      )
      result.config = configured
      console.log(`[${now()}] 渠道配置：${JSON.stringify(configured)}`)
      await cdp.evaluate('location.reload()', 15_000).catch(() => {})
      const readyAt = Date.now()
      for (;;) {
        const ready = await cdp
          .evaluate(`(() => ({ hasTextarea: Boolean(document.querySelector('textarea')), booted: window.__DEEPSEEK_BOOTED__ === true }))()`, 15_000)
          .catch(() => ({ hasTextarea: false, booted: false }))
        if (ready.hasTextarea) break
        if (Date.now() - readyAt > 25_000) break
        await sleep(1000)
      }
      await sleep(1500)
    }
    result.baseUrlKey = 'chat-demo:base-url:openai'
    result.baseUrl = await cdp.evaluate(
      `(() => ({ legacy: localStorage.getItem('chat-demo:base-url'), openai: localStorage.getItem('chat-demo:base-url:openai'), model: localStorage.getItem('chat-demo:model:openai'), kind: localStorage.getItem('chat-demo:provider-kind'), keySet: Boolean(localStorage.getItem('chat-demo:api-key')) }))()`,
      10_000
    )
    // 首次启动（还没配置渠道）会自动弹设置页，挡住聊天输入区 —— 先关掉再发消息
    result.closedSettings = await cdp.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]')
        if (!dialog) return { closed: false, reason: 'no-dialog' }
        const close = [...dialog.querySelectorAll('button[aria-label]')].find((node) => /^close|关闭|done|完成$/i.test((node.getAttribute('aria-label') || '').trim()))
        if (!close) return { closed: false, reason: 'no-close-button', labels: [...dialog.querySelectorAll('button[aria-label]')].map((n) => n.getAttribute('aria-label')) }
        close.click()
        return { closed: true, label: close.getAttribute('aria-label') }
      })()`,
      15_000
    )
    console.log(`[${now()}] 关设置弹层：${JSON.stringify(result.closedSettings)}`)
    await sleep(1200)

    result.before = await cdp.evaluate(
      `(() => ({ rows: document.querySelectorAll('[data-row-id]').length, hasTextarea: Boolean(document.querySelector('textarea')) }))()`,
      10_000
    )
    if (!result.before.hasTextarea) {
      result.verdict = 'NO_MAIN_UI'
      saveJson(`${outDir}/result-chat.json`, result)
      console.log('没有输入框，主界面没起来')
      cdp.close()
      return
    }

    const typed = await cdp.evaluate(`(() => {
      const textarea = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(TEXT)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return { value: textarea.value }
    })()`, 20_000)
    result.typed = typed
    await sleep(600)

    const clicked = await cdp.evaluate(`(() => {
      const send = [...document.querySelectorAll('button[aria-label]')].find((node) => /^(send|发送)/i.test(node.getAttribute('aria-label') || ''))
      if (!send) return { clicked: false, labels: [...document.querySelectorAll('button[aria-label]')].map((n) => n.getAttribute('aria-label')) }
      if (send.disabled) return { clicked: false, reason: 'disabled' }
      send.click()
      return { clicked: true }
    })()`, 20_000)
    result.clicked = clicked
    console.log(`[${now()}] 发送：${JSON.stringify(clicked)}`)

    const sentAt = Date.now()
    result.samples = []
    let firstTextMs = null
    let lastBody = ''
    while (Date.now() - sentAt < BUDGET) {
      const sample = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-row-id]')]
        const last = rows.length ? rows[rows.length - 1].innerText.trim() : ''
        const stop = [...document.querySelectorAll('button[aria-label]')].some((n) => /stop|停止/i.test(n.getAttribute('aria-label') || ''))
        return { rows: rows.length, last: last.slice(0, 600), stop }
      })()`, 20_000).catch((error) => ({ error: error.message }))
      const elapsed = Date.now() - sentAt
      if (sample.last && firstTextMs === null && sample.rows > (result.before.rows ?? 0)) {
        firstTextMs = elapsed
      }
      if (sample.last) lastBody = sample.last
      if (result.samples.length === 0 || elapsed - (result.samples.at(-1)?.at ?? 0) > 3000) {
        result.samples.push({ at: elapsed, rows: sample.rows, stop: sample.stop, lastTail: (sample.last ?? '').slice(-200), error: sample.error ?? null })
        console.log(`  +${Math.round(elapsed / 1000)}s rows=${sample.rows} stop=${sample.stop} ${JSON.stringify((sample.last ?? '').slice(-80))}`)
      }
      if (firstTextMs !== null && !sample.stop && !/Retrying|retry/i.test(sample.last ?? '')) break
      await sleep(500)
    }

    result.firstTextMs = firstTextMs
    result.finalBody = lastBody
    result.finalRows = await cdp.evaluate(`document.querySelectorAll('[data-row-id]').length`, 10_000).catch(() => null)
    result.texts = await visibleTexts(cdp).catch(() => [])
    result.failureText = result.texts.find((text) =>
      /Retrying|timed out|Network Error|went wrong|Something went wrong|failed|Invalid|Unauthorized|401|余额|积分/i.test(text)
    ) ?? null
    result.pidAlive = pidOf()
    result.verdict =
      firstTextMs !== null && result.finalRows > (result.before.rows ?? 0)
        ? result.failureText
          ? 'TEXT_WITH_FAILURE_TEXT'
          : 'TEXT_OK'
        : 'NO_TEXT'
    screencap(`${outDir}/shots/chat-api${API}.png`)
    result.finishedAt = new Date().toISOString()
    saveJson(`${outDir}/result-chat.json`, result)
    console.log('\n=== 结论 ===')
    console.log(JSON.stringify({ verdict: result.verdict, firstTextMs, finalBody: result.finalBody.slice(0, 300), failureText: result.failureText }, null, 2))
  } finally {
    cdp.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`失败：${error.message}`)
    process.exit(1)
  })
