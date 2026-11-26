// Run after pnpm build. All requests are served from dist or blocked.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: process.env.CHROMIUM_CHANNEL })
try {
  for (const [android, width] of [[true, 360], [true, 390], [false, 390]]) {
    const page = await browser.newPage({
      viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    })
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== 'https://sider.test') return route.abort()
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      await route.fulfill({ path: fileURLToPath(new URL('../../dist/' + path, import.meta.url)) })
    })
    await page.addInitScript(isAndroid => {
      if (isAndroid) window.androidBridge = {}
      localStorage.setItem('chat-demo:api-key', 'sk-local-sider-fixture')
    }, android)
    await page.goto('https://sider.test/')
    await page.locator('main textarea').first().waitFor()
    const cdp = await page.context().newCDPSession(page)
    async function swipe(x, y, dx, dy) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let i = 1; i <= 5; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: x + dx * i / 5, y: y + dy * i / 5 }],
        })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    const drawer = page.locator('[data-motion-state="open"][data-sider-swipe]')
    await swipe(120, 180, 10, 90)
    await swipe(120, 180, 20, 0)
    await swipe(180, 180, -100, 0)
    assert.equal(await drawer.count(), 0)
    await swipe(100, 180, 115, 5)
    if (android) {
      await drawer.waitFor({ timeout: 2500 })
      await drawer.evaluate(el => {
        window.siderClicks = 0
        el.addEventListener('click', () => window.siderClicks++, true)
      })
      await swipe(180, 180, -110, 4)
      await drawer.waitFor({ state: 'detached', timeout: 2500 })
      assert.equal(await page.evaluate(() => window.siderClicks), 0)
      await swipe(100, 180, 115, 5)
      await drawer.waitFor({ timeout: 2500 })
      await swipe(width - 12, 200, -90, 0)
      await drawer.waitFor({ state: 'detached', timeout: 2500 })
    } else {
      assert.equal(await drawer.count(), 0)
    }
    await page.close()
    console.log('PASS', android ? 'Android platform emulation' : 'mobile web', width)
  }
} finally {
  await browser.close()
}
