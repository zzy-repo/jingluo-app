#!/usr/bin/env node
/**
 * #898 的浏览器取证：**控制面失败（claim / stale）但本地有 Key 时，发送不被拦**。
 *
 *   APP_URL=http://127.0.0.1:8122 node scripts/shot-send-degrade-898.mjs
 *
 * 做什么（390 / 360 各跑一遍，共 4 张）：
 *   1. 种 localStorage：`provider-kind=ours` + 一把本地 Key +（stale 那张）一条**不一致**的
 *      服务端下发标记 → 判成 `stale` / `claim`；
 *   2. 输入一句话并点「发送」；
 *   3. 断言：**设置层没有被自动打开**（产品决定 2026-11-25），且出现一条 `role=status` 的
 *      **保守**提示（含「试发」），不是红色错误条；
 *   4. 截两张：整页（看提示在页面上的位置）+ 提示本身。
 *
 * 端口一律走 `APP_URL`（`check-hardcoded-ports` 的口径）：不写死。
 *
 * ## ⚠ 当前状态：**红**（2026-11-26 实测，不要当成「已验证」）
 *
 * 在 `ours + 未登录` 的环境里，消息**仍然发不出去**，但拦住它的**不是** `ensureApiKey()`
 * 了（#898 已改），而是它的下一道闸门 `ensureSendConfig()` / `checkSendPrerequisites()`（#793）：
 * 提示是「I don't know you yet — Choose provider」。也就是说 #898 的验收
 * 「控制面失败时有本地 Key 的用户仍能正常发消息」**还差一步**，第二步在这个脚本里被卡住。
 *
 * 保留这个脚本（而不是删掉）的理由：它把那条第二步**跑给你看**了 —— 改前改后截图一模一样，
 * 恰恰证明「只改 `ensureApiKey` 不够」。见 issue #898 的评论。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:8122'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/send-degrade-898'
const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}

/** 本地那把（用户在手上的 Key）与「服务端记着的那把」刻意不同 → 判 stale */
const LOCAL_KEY = 'sk-3c5local-0123456789abcdefghij'
const SERVER_FINGERPRINT_STALE = 'ffffffffffffffffffffffffffffffff'

/** 注意：`addInitScript` 会把这个函数**序列化**后丢进页面，闭包里的 Node 变量读不到 —— 一切走入参 */
const seed = ({ mode, localKey, staleFingerprint }) => {
  // `apiConfig` 的 read/write 是**裸字符串**存取（不 JSON.parse），所以这里也写裸值
  localStorage.setItem('chat-demo:provider-kind', 'ours')
  localStorage.setItem('chat-demo:api-key', localKey)
  if (mode === 'stale') {
    localStorage.setItem(
      'chat-demo:ours-server-key',
      JSON.stringify({
        f: staleFingerprint,
        tail: 'wxyz',
        at: Date.now(),
        id: 7,
      })
    )
  } else {
    localStorage.removeItem('chat-demo:ours-server-key')
  }
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const failures = []
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    for (const mode of ['stale', 'claim']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error)))
      // 记录所有出现过的 `role=status` 文案：降级提示可能被随后到达的 401 通知很快顶掉，
      // 只靠「点完 250ms 再看一眼」会漏（实测就是这样漏的）。
      await page.addInitScript(() => {
        window.__toasts998 = []
        const collect = () => {
          for (const node of document.querySelectorAll('[role="status"]')) {
            const text = node.textContent ?? ''
            if (text.trim() !== '' && !window.__toasts998.includes(text)) window.__toasts998.push(text)
          }
        }
        const start = () => {
          const root = document.body ?? document.documentElement
          if (!root) return
          new MutationObserver(collect).observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
          })
        }
        // `addInitScript` 在 document-start 执行：那时 `documentElement` 还可能是 null
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start)
        } else {
          start()
        }
      })
      await page.addInitScript(seed, {
        mode,
        localKey: LOCAL_KEY,
        staleFingerprint: SERVER_FINGERPRINT_STALE,
      })
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1200)

      /**
       * 首次进入会弹「公告栏」强制已读层（与本次改动无关，但会挡住输入区）。
       * 它是**延迟出现**的（实测 1.2s 时还没渲染），所以这里轮询点掉，而不是点一次就完事。
       */
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const gotIt = page.getByRole('button', { name: /Got it|知道了|我已知晓/u }).first()
        if ((await gotIt.count()) > 0 && (await gotIt.isVisible().catch(() => false))) {
          await gotIt.click({ timeout: 3_000 }).catch(() => {})
          await page.waitForTimeout(300)
          continue
        }
        if ((await page.locator('[class*="overlay"]').count()) === 0 && attempt > 2) break
        await page.waitForTimeout(400)
      }

      const input = page.locator('textarea').first()
      await input.waitFor({ timeout: 10_000 })
      await input.fill('这条消息能发出去吗')
      // 「发送」按钮：`ChatInput` 里按 aria-label 取（zh 文案来自 i18n，不硬编码按钮位置）
      const send = page.locator('button[aria-label="发送"], button[aria-label="Send"]').first()
      await send.click({ timeout: 10_000 })
      // 降级提示是 toast：点完立刻抓一张（能抓到就存图），同时靠 MutationObserver 兜底
      await page.waitForTimeout(200)
      const toast = page.locator('[role="status"]').first()
      if ((await toast.count()) > 0) {
        await toast
          .screenshot({ path: path.join(OUT_DIR, `send-degrade-898-toast-${mode}-${label}.png`) })
          .catch(() => {})
      }
      const seenToasts = await page.evaluate(() => window.__toasts998 ?? [])
      const hasToast = seenToasts.length > 0
      const toastText = seenToasts.join(' | ')
      // 再等一拍：这时 401 已经回来，页面要显示「Key 无效 / 去换 Key」，而不是静默停在转圈
      await page.waitForTimeout(2000)

      // 断言 1：设置层**没有**被自动打开
      const settingsOpen = await page.locator('[role="dialog"]').count()
      const bodyText = await page.locator('body').innerText()
      // 断言 3：消息真的发出去了（用户气泡出现在消息流里）
      const sent = bodyText.includes('这条消息能发出去吗')
      // 断言 4：失败被明说（不是静默转圈）—— 401 文案必须点名 Key 无效
      const explicit = /API Key|Key 无效|无效或已被删除/u.test(bodyText)

      const tag = `${mode}-${label}`
      await page.screenshot({ path: path.join(OUT_DIR, `send-degrade-898-${tag}.png`) })

      // 文案随界面语言（默认 en）：两种写法都认，但必须是「先试发一次」这个意思
      const okToast = /试发|Sending once/u.test(toastText)
      console.log(
        `${tag}: sent=${sent} settingsOpen=${settingsOpen} toast=${hasToast} 含「试发」=${okToast} 明说失败=${explicit} 文案=${JSON.stringify(toastText.slice(0, 100))} pageerrors=${errors.length}`
      )
      if (settingsOpen > 0) failures.push(`${tag}: 设置层被自动打开了`)
      if (!sent) failures.push(`${tag}: 消息没有发出去（还是被拦住了）`)
      if (!okToast) failures.push(`${tag}: 没有出现保守的「试发」提示`)
      if (!explicit) failures.push(`${tag}: 失败没有被明说（不许静默转圈）`)
      if (errors.length > 0) failures.push(`${tag}: pageerror ${errors.join(' | ')}`)
      await context.close()
    }
  }
  await browser.close()
  if (failures.length > 0) {
    console.error('FAIL:\n' + failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`OK —— 4 张截图在 ${OUT_DIR}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
