// [layer: integration | isolated mobile viewport; no device or real backend]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = 5397
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', path.join(root, 'dist')], { stdio: 'ignore' })
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, deviceScaleFactor: 1, locale: 'zh-CN', acceptDownloads: true })
  await context.route(/feedback\.rose7\.cn/, route => route.abort())
  const page = await context.newPage()
  for (let tries = 0; ; tries++) {
    try { await page.goto(`http://127.0.0.1:${port}/?diag-debug`); break } catch (error) { if (tries > 10) throw error }
  }
  await page.waitForFunction(() => !!window.__diagnostics)
  await page.evaluate(() => {
    // Focused legacy-engine capability test: export must not rely on these APIs.
    Array.prototype.toSorted = undefined
    Array.prototype.toReversed = undefined
    Blob.prototype.stream = undefined
    window.TextEncoder = undefined
    window.__diagnostics.setFeedbackTransport({ name: 'offline-test', send: async () => ({ ok: false, error: 'network' }) })
    window.__diagnostics.recordError('offline-test marker', { 'http.status': 503, token: 'PRIVATE_TOKEN', content: 'PRIVATE_CHAT' })
  })
  if (await page.getByRole('dialog').count() === 0) {
    await page.getByRole('button', { name: /侧边栏|菜单|sidebar|menu/i }).first().click()
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  const form = page.getByRole('dialog').last()
  const save = form.getByRole('button', { name: '保存日志文件' })
  await save.waitFor({ state: 'visible' })
  const out = path.join(root, 'docs/ui')
  await mkdir(out, { recursive: true })
  await page.screenshot({ path: path.join(out, 'feedback-export-mobile.png') })
  // Blank description is valid for local export; HTTP is entirely offline from here.
  await context.setOffline(true)
  const firstDownload = page.waitForEvent('download')
  await save.click()
  const first = await firstDownload
  assert.match(first.suggestedFilename(), /deepseek-feedback-.*v1\.4\.0-beta\.6\.json$/)
  const firstText = await readFile(await first.path(), 'utf8')
  assert.ok(!firstText.includes('PRIVATE_TOKEN'))
  assert.ok(!firstText.includes('PRIVATE_CHAT'))
  assert.equal(JSON.parse(firstText).delivery, 'local-only-not-submitted')
  await form.locator('#feedback-description').fill('Form text stays local on failed upload')
  await form.locator('#feedback-contact').fill('private@example.org')
  await form.getByRole('button', { name: /^提交$/ }).click()
  await form.getByRole('alert').waitFor()
  assert.ok(await save.isEnabled())
  await page.screenshot({ path: path.join(out, 'feedback-export-after-upload-failure-mobile.png') })
  const nextDownload = page.waitForEvent('download')
  await save.click()
  const downloaded = await nextDownload
  const text = await readFile(await downloaded.path(), 'utf8')
  const data = JSON.parse(text)
  assert.equal(data.lastSubmissionFailure.code, 'network')
  assert.ok(!text.includes('Form text stays local'))
  assert.ok(!text.includes('private@example.org'))
  assert.equal(await form.locator('#feedback-description').inputValue(), 'Form text stays local on failed upload')
  assert.ok(await form.getByRole('alert').isVisible())
  const snapshot = await page.evaluate(() => window.__diagnostics.getDiagnosticsSnapshot())
  assert.ok(snapshot.logs.length > 0)
  assert.ok(!snapshot.logs.some(entry => entry.msg.includes('feedback-accepted')))
  await writeFile(path.join(out, 'feedback-export-sample.json'), text)
  console.log('PASS: mobile offline blank export + upload failure export; privacy; description/logs retained; no accepted event')
} finally { await browser.close(); server.kill('SIGTERM') }
