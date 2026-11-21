// [layer: integration | isolated mobile viewport; no device or real backend]
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyDist } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// 需要**标准包**（本用例要能打开反馈弹窗，内测包把入口钉死）。默认用 dist-standard，
// 与「dist 里放内测包」的用例互不干扰；按 main 的约定不隐式构建，缺产物就 SKIP(env) 并给出构建命令。
const STANDARD = process.env.DIST_STANDARD_DIR || path.join(root, 'dist-standard')
// 环境守卫：产物缺失 / 陈旧 / 种类不对 → SKIP(env)，不产生假红（Issue #19）
await verifyDist(STANDARD, { variant: 'standard' })
// 端口自动发现（PORT 可注入），避免固定端口撞车
const served = await serveDir(STANDARD, { port: process.env.PORT, label: '标准产物 dist-standard' })
const port = served.port
/** #686：出站总闸的失败会收进这里，再下面用一条 assert 定成红 */
const failures = []
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, deviceScaleFactor: 1, locale: 'zh-CN', acceptDownloads: true })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   *
   * 以前这里还有一条 `context.route(/feedback\.rose7\.cn/, abort)` —— 只认 host 的连接级拦截，
   * **没有任何断言**：别的 host 漏出去照样绿，连「它到底拦到过东西没有」都无从判断。
   * 接上总闸后实测：本用例的出站**一次都没到过 `feedback.rose7.cn`**（传输层已被
   * `setFeedbackTransport` 换成 offline 桩），那条 abort 是死代码，已由总闸取代 —— 真有人
   * 开始往那儿发，总闸会**记录 + abort + 断言点名**，比静默 abort 严格，不是放宽。
   */
  await installEgressGate(page, { appUrl: `http://127.0.0.1:${port}` })
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
  // 版本号取自构建产物本身（rspack 注入的 meta[name=application-version]），
  // 不再硬编码：以前写死 v1.4.0-beta.6，发到 beta.7 就假红（Issue #19）。
  const buildVersion = await page.evaluate(
    () => document.querySelector('meta[name="application-version"]')?.content ?? '',
  )
  assert.ok(buildVersion, '构建产物缺少 meta[name=application-version]（产物陈旧或不是本仓库构建）')
  assert.match(
    first.suggestedFilename(),
    new RegExp(`deepseek-feedback-.*v${buildVersion.replace(/\./g, '\\.')}\\.json$`),
  )
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
  // #686：收尾断言「漏出 = 0」—— 本用例把传输层换成了 offline 桩，一次都不该真发出去
  assertNoEgress(failures)
  assert.deepEqual(failures, [], `出站总闸未通过：${failures.join('；')}`)
  console.log('PASS: mobile offline blank export + upload failure export; privacy; description/logs retained; no accepted event')
} finally { await browser.close(); served.kill() }
