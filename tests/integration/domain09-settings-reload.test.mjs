// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1 分钟]
//
// N6 设置重载 + 渠道凭证隔离（域 9）—— #362 / #367
//
// N2 证明了「模块层读回」（写进去、重启后 store 读得到），但那只证明**键被读到了**，
// 证不到**界面真的消费了它**。本用例补的是这一层：seed 一张表 → reload → 断言界面。
//
// 覆盖：F9-01 主题（深/浅/跟随系统）· F9-02 阅读三档 · F9-03 思考显示 · F9-05 回车行为
// · F9-06 界面语言 · F9-09 渠道选择 · F9-10 切渠道凭证隔离（A 的地址/模型不带进 B、Key 共用不丢）
//
// 表在 `tests/fixtures/domain08-09/reload-matrix.mjs`。每行都在独立上下文里跑：
// 清存储 → seed → reload → 断言。
//
//   node --test tests/integration/domain09-settings-reload.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { chromium } from 'playwright'
import { defaultDist, serveDir, verifyDist } from '../helpers/env.mjs'
import { withStubbedBackends } from '../helpers/golden.mjs'
import { ANTHROPIC_HOST, FAKE_KEY, OPENAI_HOST, RELOAD_CASES } from '../fixtures/domain08-09/reload-matrix.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = defaultDist()

const settle = (page, ms = 500) => page.waitForTimeout(ms)

const seed = async (page, values) => {
  await page.evaluate((entries) => {
    window.localStorage.clear()
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value)
  }, values)
}

const openSettings = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await settle(page)
  return page.getByRole('dialog').last()
}

const openGeneralTab = async (page) => {
  const tab = page.getByRole('tab', { name: /通用设置|General/ })
  if ((await tab.count()) > 0) await tab.first().click()
  await settle(page, 400)
}

const openDataTab = async (page) => {
  const tab = page.getByRole('tab', { name: /数据管理|Data/ })
  if ((await tab.count()) > 0) await tab.first().click()
  await settle(page, 400)
}

const readSelectLabel = async (page, ariaLabel) => {
  const trigger = page.getByRole('button', { name: ariaLabel, exact: true })
  if ((await trigger.count()) === 0) return null
  return (await trigger.first().innerText()).trim()
}

const inputValue = async (page, ariaLabel) => {
  const input = page.getByLabel(ariaLabel)
  if ((await input.count()) === 0) return null
  return input.first().inputValue()
}

/**
 * 每个 probe 返回「失败说明数组」。
 * 断言对象是**界面**（body 类名 / 根 data-* / 选择器文案 / 输入框真实值），不是 store。
 */
const PROBES = {
  async theme(page, expect) {
    const state = await page.evaluate(() => ({
      dark: document.body.classList.contains('dark'),
      light: document.body.classList.contains('light'),
    }))
    const failures = []
    if (state.dark !== expect.dark) failures.push(`body.dark=${state.dark}，期望 ${expect.dark}`)
    if (state.light !== expect.light) failures.push(`body.light=${state.light}，期望 ${expect.light}`)
    return failures
  },

  async reading(page, expect) {
    const state = await page.evaluate(() => ({
      size: document.documentElement.getAttribute('data-ds-reading-size'),
      weight: document.documentElement.getAttribute('data-ds-reading-weight'),
      line: document.documentElement.getAttribute('data-ds-reading-line'),
    }))
    const failures = []
    for (const key of ['size', 'weight', 'line']) {
      if (state[key] !== expect[key]) failures.push(`根元素 data-ds-reading-${key}=${state[key]}，期望 ${expect[key]}`)
    }
    return failures
  },

  async select(page, expect) {
    await openSettings(page)
    await openGeneralTab(page)
    const label = await readSelectLabel(page, expect.ariaLabel)
    if (label === null) return [`设置页找不到「${expect.ariaLabel}」选择器`]
    if (!label.includes(expect.label)) return [`选择器显示「${label}」，期望包含「${expect.label}」`]
    return []
  },

  async 'enter-key'(page, expect) {
    const failures = []
    const hint = await page.locator('textarea').first().getAttribute('enterKeyHint')
    if (hint !== expect.enterKeyHint) failures.push(`输入框 enterKeyHint=${hint}，期望 ${expect.enterKeyHint}`)
    await openSettings(page)
    await openGeneralTab(page)
    const label = await readSelectLabel(page, expect.ariaLabel)
    if (label === null || !label.includes(expect.label)) {
      failures.push(`回车行为选择器显示「${label}」，期望包含「${expect.label}」`)
    }
    return failures
  },

  async channel(page, expect) {
    await openSettings(page)
    await openDataTab(page)
    const failures = []
    const channelLabel = await readSelectLabel(page, '渠道')
    if (!channelLabel || !channelLabel.includes(expect.channelLabel)) {
      failures.push(`渠道选择器显示「${channelLabel}」，期望「${expect.channelLabel}」`)
    }
    if (expect.hasBaseUrl !== undefined) {
      const present = (await page.getByLabel('服务地址').count()) > 0
      if (present !== expect.hasBaseUrl) failures.push(`服务地址行 present=${present}，期望 ${expect.hasBaseUrl}`)
    }
    if (expect.hasModel !== undefined) {
      const present = (await page.getByLabel('模型').count()) > 0
      if (present !== expect.hasModel) failures.push(`模型行 present=${present}，期望 ${expect.hasModel}`)
    }
    if (expect.baseUrl !== undefined) {
      const actual = await inputValue(page, '服务地址')
      if (actual !== expect.baseUrl) failures.push(`服务地址输入框=${actual}，期望 ${expect.baseUrl}`)
    }
    if (expect.model !== undefined) {
      const actual = await inputValue(page, '模型')
      if (actual !== expect.model) failures.push(`模型输入框=${actual}，期望 ${expect.model}`)
    }
    return failures
  },

  async 'switch-keep-key'(page, expect) {
    await openSettings(page)
    await openDataTab(page)
    const failures = []
    const masked = '*'.repeat(FAKE_KEY.length)
    const hasMask = (await page.getByText(masked, { exact: true }).count()) > 0
    if (hasMask !== expect.masked) failures.push(`Key 掩码 present=${hasMask}，期望 ${expect.masked}`)
    // 切到另一个渠道：Key 必须还在（共用一把），并给出「请确认 Key 是否适用」的提示
    await page.getByRole('button', { name: '渠道', exact: true }).first().click()
    await settle(page, 300)
    await page.getByRole('option', { name: 'OpenAI 兼容' }).first().click()
    await settle(page, 500)
    const stillMasked = (await page.getByText(masked, { exact: true }).count()) > 0
    if (stillMasked !== expect.masked) failures.push('切渠道后 Key 掩码消失了（Key 应四渠道共用）')
    const hint = page.getByText('切换渠道后，请确认 API Key 是否适用')
    const hintVisible = (await hint.count()) > 0
    if (hintVisible !== expect.hint) failures.push(`切渠道提示 present=${hintVisible}，期望 ${expect.hint}`)
    return failures
  },

  async locale(page, expect) {
    const dialog = await openSettings(page)
    const title = (await dialog.innerText()).split('\n')[0]?.trim() ?? ''
    if (title !== expect.settingsTitle) {
      return [`设置弹窗标题「${title}」，期望「${expect.settingsTitle}」（locale 没被界面消费）`]
    }
    return []
  },
}

test('N6 设置重载 + 渠道凭证隔离：seed 一张表 → reload → 界面真的跟着变', async () => {
  verifyDist(DIST, { variant: 'standard' })
  const served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist' })
  const browser = await chromium.launch()
  const failures = []
  try {
    for (const row of RELOAD_CASES) {
      const context = await browser.newContext({
        locale: row.expect.settingsTitle ? 'en-US' : 'zh-CN',
        viewport: { width: 1280, height: 900 },
        ...(row.context ?? {}),
      })
      try {
        const page = await context.newPage()
        /**
         * #673：出站总闸 + 探针桩，**都在打开页面之前**装上。
         * 改前这两条自填渠道的 `GET {base}/v1/models` 探针是真打到外网的
         * （实测 `GET relay-a.example.com/v1/models` ×2、`GET relay-o.example.com/v1/models` ×2），
         * 用例里没有任何一处校验它们没连出去。
         */
        const guard = await withStubbedBackends(page, { appUrl: served.url, allowLoopback: true })
        for (const host of [ANTHROPIC_HOST, OPENAI_HOST]) {
          guard.stub({
            name: `${host}/v1/models`,
            host,
            path: '/v1/models',
            method: 'GET',
            respond: () => ({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: [] }),
            }),
          })
        }
        await page.goto(served.url, { waitUntil: 'domcontentloaded' })
        await seed(page, row.seed)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await settle(page, 900)
        const rowFailures = await PROBES[row.probe](page, row.expect)
        // #673：本行跑完，断言「请求一条都没漏出白名单」——漏出照样记进本行失败
        guard.assertNoLeak({
          expect: (label, pass, { expected, actual }) => {
            if (!pass) rowFailures.push(`${label} · 期望=${expected} · 实际=${actual}`)
          },
        })
        if (rowFailures.length === 0) {
          console.log(`  ok   ${row.id} ${row.fn} ${row.label}`)
        } else {
          for (const failure of rowFailures) failures.push(`${row.id} ${row.label}：${failure}`)
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    served.kill()
  }
  console.log(`  ·  ${RELOAD_CASES.length} 行 seed → reload → 界面断言`)
  assert.deepEqual(failures, [])
})

test('N6 覆盖账：7 个功能点 / 13 行', () => {
  const fns = [...new Set(RELOAD_CASES.map((row) => row.fn))].sort()
  assert.deepEqual(fns, ['F9-01', 'F9-02', 'F9-03', 'F9-05', 'F9-06', 'F9-09', 'F9-10'])
  assert.equal(RELOAD_CASES.length, 13)
})
