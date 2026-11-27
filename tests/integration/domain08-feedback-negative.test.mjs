// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1 分钟]
//
// N5 反馈弹窗负向表（域 8 · F8-04 / F8-05 / F8-07）—— #362 / #367
//
// 正向路径（选到图 → 预览 → 随提交上传）已有 L0/L1 覆盖；本用例只打**失败分支**：
// 选错文件、相册读不出来、压缩环境坏掉、剪贴板不可用、描述为空。
// 这些分支以前一条断言都没有，坏掉时表现为「点了没反应」或「静默失败」，最难被用户说清。
//
// 表在 `tests/fixtures/domain08-09/feedback-negative-cases.mjs`；一行一个场景，
// 每行都在**全新的浏览器上下文**里跑（存储清空 + 单独注入故障），场景之间互不污染。
//
// 现状：**全绿，`KNOWN_GAPS` 为空**。#388 修掉了原 U1（`.txt` 被静默当成截图收下）：
// `prepareScreenshot` 现在先校验 `file.type`、再真解一次确认能解码，非图片与解不开的假图
// 都被明确拒绝（U1 / U7 分别断言「只收图片」与「这张图打不开」两句提示，且不留预览）。
// 口径与 N1 相同：已登记缺口继续红 → 报告放行；已登记缺口变绿 → 失败（提示转严格）；
// 表外变红 → 失败（真实回归）。
//
//   node --test tests/integration/domain08-feedback-negative.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { chromium } from 'playwright'
import { defaultDist, serveDir, verifyDist } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
import { KNOWN_GAPS, NEGATIVE_CASES, TOAST } from '../fixtures/domain08-09/feedback-negative-cases.mjs'
import { BUILTIN_KEY_CLAIM_STUB } from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = defaultDist()

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const SVG_LARGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="4000"><rect width="5000" height="4000" fill="#2b6cb0"/></svg>',
  'utf8'
)

const fileFor = (file) => {
  if (file.kind === 'text') return { ...file, buffer: Buffer.from('this is not an image', 'utf8') }
  if (file.kind === 'svg-large') return { ...file, buffer: SVG_LARGE }
  return { ...file, buffer: PNG_1X1 }
}

/** 页面内故障注入：必须在应用代码加载前生效（addInitScript 在 goto / reload 之前注册） */
const PATCHES = {
  none: () => {},
  'reader-deny': () => {
    const original = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function readAsDataURL(blob) {
      if (blob && blob.name && blob.name.includes('denied')) {
        setTimeout(() => this.onerror && this.onerror(new Event('error')), 0)
        return
      }
      return original.call(this, blob)
    }
  },
  'canvas-broken': () => {
    HTMLCanvasElement.prototype.toDataURL = () => {
      throw new Error('canvas unavailable')
    }
  },
  'clipboard-deny': () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    })
    document.execCommand = () => false
  },
}

// 负向表里所有「本该报错」的文案：#388 之后选图失败分成了三种（非图片 / 解不开 / 其它），
// 三句都算错误提示 —— 不然「不该有提示」的行会漏掉新加的那两句。
const ERROR_TOASTS = [
  TOAST.screenshotFailed,
  TOAST.notImage,
  TOAST.undecodable,
  TOAST.copyFailed,
  TOAST.descriptionRequired,
]

const settle = (page) => page.waitForTimeout(900)

/** 打开「设置 → 数据管理 → 写反馈」，返回反馈弹窗 */
const openFeedbackDialog = async (page, appUrl) => {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await settle(page)
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await settle(page)
  const dataTab = page.getByTestId('settings-row-data')
  if ((await dataTab.count()) > 0) await dataTab.first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  await settle(page)
  return page.getByRole('dialog').last()
}

const toastTexts = async (page) =>
  (await page.locator('[role="status"]').allInnerTexts()).map((text) => text.trim()).filter(Boolean)

/** 跑一行场景，返回失败说明（空数组 = 通过） */
const runCase = async (browser, appUrl, row) => {
  const failures = []
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  try {
    const page = await context.newPage()
    /**
     * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
     * 本用例只在本地造图 / 读相册 / 点剪贴板，**一次都不该往反馈后端发**（写反馈的提交通路归
     * `feedback-export` 与 L0 的单测）；白名单里只有被测产物自己的 origin —— 一旦界面背地里
     * 往 `feedback.rose7.cn` 之类的地方发东西，这一行的失败就会点名那个 host。
     */
    await installEgressGate(page, { stubs: [BUILTIN_KEY_CLAIM_STUB], appUrl })
    await page.addInitScript(PATCHES[row.patch])
    const form = await openFeedbackDialog(page, appUrl)

    if (row.action === 'pick') {
      await form.locator('input[type="file"]').setInputFiles(fileFor(row.file))
      await settle(page)
    }
    if (row.action === 'copy-log') {
      await form.getByRole('button', { name: /日志预览/ }).first().click().catch(() => {})
      await page.waitForTimeout(400)
      const copyButton = form.getByRole('button', { name: /复制|Copy/ }).first()
      if ((await copyButton.count()) === 0) {
        failures.push('日志预览里没有「复制」按钮，无法验证剪贴板失败分支')
      } else {
        await copyButton.click()
        await settle(page)
      }
    }
    if (row.action === 'submit-empty') {
      const submit = form.getByRole('button', { name: /^提交$/ }).first()
      const disabled = await submit.isDisabled()
      if (disabled !== row.expect.submitDisabled) {
        failures.push(`空描述时提交键 disabled=${disabled}，期望 ${row.expect.submitDisabled}`)
      }
      // 就算被点了也不许发请求 / 不许出现工单号
      if (!disabled) {
        await submit.click().catch(() => {})
        await settle(page)
      }
    }

    const toasts = await toastTexts(page)
    if (row.expect.toast) {
      if (!toasts.some((text) => text.includes(row.expect.toast))) {
        failures.push(`期望提示「${row.expect.toast}」，实际 ${JSON.stringify(toasts)}`)
      }
    } else if (toasts.some((text) => ERROR_TOASTS.includes(text))) {
      failures.push(`不该出现错误提示，实际 ${JSON.stringify(toasts)}`)
    }

    if (row.expect.preview !== undefined) {
      const preview = form.locator('img').first()
      const hasPreview = (await form.locator('img').count()) > 0
      if (hasPreview !== row.expect.preview) {
        failures.push(`预览 ${hasPreview}，期望 ${row.expect.preview}`)
      } else if (hasPreview && row.expect.maxEdge) {
        await preview.evaluate((img) => img.decode?.().catch(() => {}))
        const naturalWidth = await preview.evaluate((img) => img.naturalWidth)
        const naturalHeight = await preview.evaluate((img) => img.naturalHeight)
        const longest = Math.max(naturalWidth, naturalHeight)
        if (longest > row.expect.maxEdge) {
          failures.push(`压缩后最长边 ${longest} > ${row.expect.maxEdge}`)
        }
      }
    }
    // #686：收尾断言「漏出 = 0」—— 与这一行自己的断言同一条判决（表外变红就是真实回归）
    assertNoEgress(failures)
    return failures
  } finally {
    await context.close()
  }
}

test('N5 反馈弹窗负向表：七种失败分支各自的提示与后果', async () => {
  verifyDist(DIST, { variant: 'standard' })
  const served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist' })
  const browser = await chromium.launch()
  const known = new Set(KNOWN_GAPS.map((gap) => gap.row))
  const red = []
  try {
    for (const row of NEGATIVE_CASES) {
      const failures = await runCase(browser, served.url, row)
      if (failures.length === 0) {
        console.log(`  ok   ${row.id} ${row.fn} ${row.label}`)
        continue
      }
      const registered = known.has(row.id)
      console.log(`  RED  ${row.id} ${row.fn} ${row.label} → ${registered ? '已知缺口（已登记 #367）' : '**未登记**'}`)
      for (const failure of failures) console.log(`       - ${failure}`)
      if (!registered) assert.fail(`${row.id} 未登记的失败：${failures.join('；')}`)
      red.push(row.id)
    }
  } finally {
    await browser.close()
    served.kill()
  }

  const unexpectedGreen = [...known].filter((rowId) => !red.includes(rowId))
  assert.deepEqual(
    unexpectedGreen,
    [],
    '已登记的缺口意外变绿 = 已经修好了：请把对应行从 KNOWN_GAPS 删掉（自动转严格）'
  )
  console.log(`  ·  ${NEGATIVE_CASES.length} 行负向场景，现状红 ${red.length} 行（${red.join(',') || '无'}）`)
})

test('N5 覆盖账：负向表落在 F8-04 / F8-05 / F8-07', () => {
  const fns = [...new Set(NEGATIVE_CASES.map((row) => row.fn))].sort()
  assert.deepEqual(fns, ['F8-04', 'F8-05', 'F8-07'], 'N5 覆盖三个功能点的失败分支')
  for (const row of NEGATIVE_CASES) {
    assert.ok(row.label && row.action, `${row.id} 缺 label / action`)
  }
})
