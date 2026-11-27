// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1 分钟]
//
// N6 设置重载 + 来源凭证隔离（域 9）—— #362 / #367
//
// N2 证明了「模块层读回」（写进去、重启后 store 读得到），但那只证明**键被读到了**，
// 证不到**界面真的消费了它**。本用例补的是这一层：seed 一张表 → reload → 断言界面。
//
// 覆盖：F9-01 主题（深/浅/跟随系统）· F9-02 阅读三档 · F9-03 思考显示 · F9-05 回车行为
// · F9-06 界面语言 · F9-09 生效来源 · F9-10 来源之间的凭证隔离
//
// 表在 `tests/fixtures/domain08-09/reload-matrix.mjs`。每行都在独立上下文里跑：
// 清存储 → seed → reload → 断言。
//
// ## 断言的是「凭证不串」，不是「渠道下拉」（裁决 2026-11-26，docs/testing/product-debt.md）
//
// 改版前的写法按 `getByRole('button', { name: '渠道' })` 找下拉、读它的值 —— #807 之后来源页
// 是三行**单层手风琴**（内置 / 第三方 / 官方），那个下拉不存在了，于是整条用例卡在第一步、
// 后面「重载后凭证隔离」一条断言都没跑到。意图本身没变，落点改成界面现在真实表达这两件事的地方：
//
//   1. **当前生效来源仍是同一行**：重载后打勾的那一行（`settings-source-current`）必须还是 seed 的
//      `chat-demo:provider-kind` 对应的那一行 —— 重载不许把来源挪走、也不许「谁都打勾」；
//   2. **别的行的凭证没有被合并/丢失**：第三方行的草稿里只有它自己那一份地址/模型
//      （不出现另一槽位的值，也不出现老的共享 `chat-demo:model` 残留）；官方服务的地址/模型仍然
//      不可编辑（它本来就没有那两格）。
//
//   node --test tests/integration/domain09-settings-reload.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { chromium } from 'playwright'
import { defaultDist, serveDir, verifyDist } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate, openSettingsPage, openSourceRow, SETTINGS_ROW } from '../helpers/helpers.mjs'
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
  const tab = page.getByTestId('settings-row-general')
  if ((await tab.count()) > 0) await tab.first().click()
  await settle(page, 400)
}

/** 打开「设置 → 账户与消费 → 模型来源」（#807 起渠道/Key 字段都在这一页） */
const openSourceSection = async (page) => {
  await openSettingsPage(page, SETTINGS_ROW.consume)
  if ((await page.locator('[data-testid="settings-source-accordion"]').count()) === 0) {
    await page.getByTestId('account-consume-source').first().click()
    await page.locator('[data-testid="settings-source-accordion"]').first().waitFor({ state: 'visible' })
  }
}

/** 打勾的那一行（`settings-source-current` 所在的行头）；一行都没打勾时返回 null */
const currentSourceRow = async (page) =>
  page.evaluate(() => {
    const check = document.querySelector('[data-testid="settings-source-current"]')
    const header = check?.closest('button[data-testid^="settings-source-"]')
    return header?.getAttribute('data-testid')?.replace(/^settings-source-/, '') ?? null
  })

/** 当前展开的那一行里某个草稿字段的值（没这一格返回 null） */
const draftValue = async (page, field) => {
  const input = page.getByTestId(`settings-source-draft-${field}`)
  return (await input.count()) === 0 ? null : input.first().inputValue()
}

const readSelectLabel = async (page, ariaLabel) => {
  const trigger = page.getByRole('button', { name: ariaLabel, exact: true })
  if ((await trigger.count()) === 0) return null
  return (await trigger.first().innerText()).trim()
}

/**
 * 每个 probe 返回「失败说明数组」。
 * 断言对象是**界面**（body 类名 / 根 data-* / 手风琴打勾行 / 输入框真实值），不是 store。
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

  /**
   * 来源页：生效来源那一行 + 两行草稿里的凭证。
   *
   * `expect.currentRow`：打勾的那一行必须是它（重载不许挪来源，也不许两个都打勾）。
   * `expect.third`：第三方行草稿的地址/模型（`''` = 它自己那一份还没填）。
   * `expect.thirdForbids`：不许出现在第三方行里的值（另一槽位 / 老的共享残留）。
   * `expect.official`：官方服务的地址/模型是否可编辑（那条路的产品定义是「地址固定，只填 Key」）。
   */
  async source(page, expect) {
    const failures = []
    await openSourceSection(page)

    const checked = await currentSourceRow(page)
    if (expect.currentRow !== undefined && checked !== expect.currentRow) {
      const all = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid$="-status"]')].map(
          (node) => `${node.getAttribute('data-testid')}=${node.getAttribute('data-status')}`
        )
      )
      failures.push(`重载后打勾的行 = ${JSON.stringify(checked)}，期望 ${JSON.stringify(expect.currentRow)}（行状态：${all.join('、')}）`)
    }

    if (expect.third) {
      await openSourceRow(page, 'third')
      const baseUrl = await draftValue(page, 'baseUrl')
      const model = await draftValue(page, 'model')
      if (baseUrl !== expect.third.baseUrl) {
        failures.push(`第三方行的地址草稿=${JSON.stringify(baseUrl)}，期望 ${JSON.stringify(expect.third.baseUrl)}`)
      }
      if (model !== expect.third.model) {
        failures.push(`第三方行的模型草稿=${JSON.stringify(model)}，期望 ${JSON.stringify(expect.third.model)}`)
      }
      const panelText = await page.locator('[data-testid="settings-source-third-panel"]').innerText()
      const leaked = (expect.thirdForbids ?? []).filter((value) => panelText.includes(value))
      if (leaked.length > 0) failures.push(`第三方行串进了别的凭证：${leaked.join(' / ')}`)
    }

    if (expect.official) {
      await openSourceRow(page, 'official')
      const panel = page.locator('[data-testid="settings-source-official-panel"]')
      const editableBaseUrl = (await panel.getByTestId('settings-source-draft-baseUrl').count()) > 0
      const editableModel = (await panel.getByTestId('settings-source-draft-model').count()) > 0
      if (editableBaseUrl !== expect.official.editableBaseUrl) {
        failures.push(`官方行地址可编辑=${editableBaseUrl}，期望 ${expect.official.editableBaseUrl}`)
      }
      if (editableModel !== expect.official.editableModel) {
        failures.push(`官方行模型可编辑=${editableModel}，期望 ${expect.official.editableModel}`)
      }
      // 「地址固定」必须看得见，否则用户会以为漏了一格（#807）
      if ((await panel.getByTestId('settings-source-base-url-fixed').count()) === 0) {
        failures.push('官方行没有「地址固定」那一行（用户看不到生效地址）')
      }
    }

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

test('N6 设置重载 + 来源凭证隔离：seed 一张表 → reload → 界面真的跟着变', async () => {
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
        // #686：改用 `installEgressGate()`（与其余文件同一份总闸），白名单收成精确 host:port ——
        // 被测产物自身 + 两条探针桩的 host；不再用 `allowLoopback: true` 那种「回环随便哪个端口」的宽口径。
        await installEgressGate(page, {
          appUrl: served.url,
          allowHosts: [new URL(served.url).host],
          stubs: [ANTHROPIC_HOST, OPENAI_HOST].map((host) => ({
            name: `${host}/v1/models`,
            host,
            path: '/v1/models',
            method: 'GET',
            respond: () => ({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: [] }),
            }),
          })),
        })
        await page.goto(served.url, { waitUntil: 'domcontentloaded' })
        const values = typeof row.seed === 'function' ? await row.seed() : row.seed
        await seed(page, values)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await settle(page, 900)
        const rowFailures = await PROBES[row.probe](page, row.expect)
        // #673 / #686：本行跑完，断言「请求一条都没漏出白名单」——漏出照样记进本行失败
        assertNoEgress(rowFailures)
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
  console.log(`  ·  ${RELOAD_CASES.length} 行 seed → reload → 界面断言（FAKE_KEY=${FAKE_KEY.slice(0, 6)}…）`)
  assert.deepEqual(failures, [])
})

test('N6 覆盖账：7 个功能点 / 13 行', () => {
  const fns = [...new Set(RELOAD_CASES.map((row) => row.fn))].sort()
  assert.deepEqual(fns, ['F9-01', 'F9-02', 'F9-03', 'F9-05', 'F9-06', 'F9-09', 'F9-10'])
  assert.equal(RELOAD_CASES.length, 13)
})
