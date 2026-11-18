// [layer: integration | 依赖: playwright + chromium + 本地静态服务（dist/）；不连后端、不读真机]
// Issue #31 定向回归：反馈表单「取消后重开保留已填内容」+ 主动清空（二次确认）+ 提交成功后清空草稿。
// 两档宽度各出两张 390 / 360 截图：回填状态、清空确认。
//
//   node tests/run-layer.mjs integration --case feedback-draft.test.mjs --timeout-ms 300000
//
// 需要先有标准包产物：npm run build（本用例不自己编译）。
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(root, 'docs/ui/feedback-draft')
// 端口不写死 5399：撞到无关服务时页面能打开但 __diagnostics 不存在，表现成「等 30s 超时」的假红
let port = Number(process.env.PORT || 0)
const DESCRIPTION = '草稿保留回归：输入后点取消'
const CONTACT = 'draft@example.org'
const SHOTS = []

await mkdir(out, { recursive: true })
// 进程内静态服务（不再 spawn python3 http.server）
const server = await serveDist(path.join(root, 'dist'), { port })
port = Number(new URL(server.url).port)
const browser = await chromium.launch({ headless: true })

/** 打开设置 → 数据管理 → 写反馈，返回表单元件 */
const openFeedback = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /边栏|菜单|sidebar|menu/i }).first().click()
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  // 设置弹窗也在 DOM 里，按「含反馈描述框」锁定反馈这一个对话框，别用 .last()
  const form = page.locator('[role="dialog"]:has(#feedback-description)')
  await form.locator('#feedback-description').waitFor({ state: 'visible' })
  return form
}

/** 读表单当前状态：描述 / 联系方式 / 分类文案 / 是否有回填提示 */
const readForm = (form) =>
  form.evaluate((dialog) => {
    const description = dialog.querySelector('#feedback-description')
    const contact = dialog.querySelector('#feedback-contact')
    const category = [...dialog.querySelectorAll('button[aria-haspopup="listbox"]')]
      .map((button) => button.textContent?.trim() ?? '')
      .join('|')
    const restored = dialog.querySelector('[data-testid="feedback-draft-restored"]')
    const clearButton = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '清空已填内容'
    )
    return {
      description: description ? description.value : null,
      contact: contact ? contact.value : null,
      category,
      restoredHint: Boolean(restored),
      clearDisabled: clearButton ? clearButton.disabled : null,
      body: dialog.textContent ?? '',
    }
  })

const closeDialog = async (form) => {
  await form.getByRole('button', { name: '取消', exact: true }).first().click()
  await form.waitFor({ state: 'detached', timeout: 10000 })
}

try {
  for (const [width, height] of [
    [390, 844],
    [360, 780],
  ]) {
    const tag = String(width)
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    })
    await context.addInitScript(() => localStorage.setItem('chat-demo:api-key', 'sk-draft-fixture'))
    const consoleErrors = []
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))

    await page.goto(`http://127.0.0.1:${port}/?diag-debug`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__diagnostics)
    await page.evaluate(() => {
      window.__diagnostics.setFeedbackTransport({
        name: 'draft-fixture',
        send: async () => ({ ok: true, id: 'FB-DRAFT-0001' }),
      })
      window.__diagnostics.recordError('feedback draft regression fixture')
    })

    console.log(`\n[${tag}] 1. 填写 → 取消`)
    let form = await openFeedback(page)
    let state = await readForm(form)
    assert.equal(state.description, '', '首次打开应为空白表单（无旧草稿）')
    assert.equal(state.restoredHint, false, '首次打开不应显示回填提示')
    await form.locator('#feedback-description').fill(DESCRIPTION)
    await form.locator('#feedback-contact').fill(CONTACT)
    await form.getByRole('button', { name: '分类' }).click()
    await page.getByRole('option', { name: '功能建议' }).click()
    state = await readForm(form)
    assert.match(state.category, /功能建议/, `分类应切到「功能建议」，实际 ${state.category}`)
    await closeDialog(form)

    console.log(`[${tag}] 2. 重新打开：内容仍在（取消不丢草稿）`)
    form = await openFeedback(page)
    state = await readForm(form)
    assert.equal(state.description, DESCRIPTION, '取消后重开：问题描述应保留')
    assert.equal(state.contact, CONTACT, '取消后重开：联系方式应保留')
    assert.match(state.category, /功能建议/, `取消后重开：分类应保留，实际 ${state.category}`)
    assert.equal(state.restoredHint, true, '取消后重开：应提示「已恢复上次未提交的内容」')
    const refilled = path.join(out, `${tag}-refilled.png`)
    await page.screenshot({ path: refilled })
    SHOTS.push(refilled)
    console.log(`  ok   截图 ${refilled}`)

    console.log(`[${tag}] 3. 主动清空：二次确认后才清`)
    await form.getByRole('button', { name: '清空已填内容' }).click()
    state = await readForm(form)
    assert.match(state.body, /确定清空已填内容/, '点「清空已填内容」应先出二次确认')
    assert.equal(state.description, DESCRIPTION, '确认前不应清内容')
    const confirmShot = path.join(out, `${tag}-clear-confirm.png`)
    await page.screenshot({ path: confirmShot })
    SHOTS.push(confirmShot)
    console.log(`  ok   截图 ${confirmShot}`)
    await form.getByRole('button', { name: '确定', exact: true }).click()
    state = await readForm(form)
    assert.equal(state.description, '', '确认清空后描述应为空')
    assert.equal(state.contact, '', '确认清空后联系方式应为空')
    assert.match(state.category, /问题反馈/, `确认清空后分类回到默认「问题反馈」，实际 ${state.category}`)
    assert.equal(state.clearDisabled, true, '没有内容时「清空已填内容」应禁用')
    await closeDialog(form)

    console.log(`[${tag}] 4. 清空后再打开：不再回填`)
    form = await openFeedback(page)
    state = await readForm(form)
    assert.equal(state.description, '', '清空后重开应为空表单')
    assert.equal(state.contact, '', '清空后重开联系方式应为空')
    assert.equal(state.restoredHint, false, '清空后重开不应显示回填提示')

    console.log(`[${tag}] 5. 提交成功 → 草稿作废`)
    await form.locator('#feedback-description').fill('已提交的内容不该再回填')
    await form.getByRole('button', { name: '提交', exact: true }).click()
    await form.getByText(/已提交，工单号/).waitFor({ timeout: 15000 })
    assert.match(await form.textContent(), /FB-DRAFT-0001/, '应显示 mock 通道返回的工单号')
    await form.getByRole('button', { name: '完成', exact: true }).click()
    await form.waitFor({ state: 'detached', timeout: 10000 })
    form = await openFeedback(page)
    state = await readForm(form)
    assert.equal(state.description, '', '提交成功后重开应为空表单（已送达的草稿不再回填）')
    assert.equal(state.restoredHint, false, '提交成功后重开不应显示回填提示')
    await closeDialog(form)

    assert.deepEqual(consoleErrors, [], `console error 应为 0：${consoleErrors.join(' | ')}`)
    await context.close()
  }
  console.log('\nPASS: #31 草稿 取消保留 / 主动清空（二次确认）/ 提交成功清空 —— 390、360 两档通过')
} finally {
  await browser.close()
  await server.close()
}
