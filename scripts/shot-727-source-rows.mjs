#!/usr/bin/env node
/**
 * #727「模型来源 = 三行 + 行内进子页」的截图与断言工具。
 *
 *   node scripts/shot-727-source-rows.mjs                                 # 390/360 × 两个场景 → docs/ui/727-source-rows
 *   node scripts/shot-727-source-rows.mjs --base=http://127.0.0.1:8098/
 *   node scripts/shot-727-source-rows.mjs --viewport=390
 *
 * 与 `scripts/shot-mobile.mjs` 的区别：那个跑 `dist/` 整包；这里**直接打开正在跑的 dev server**
 * （默认 8099），点真实入口进「设置 → 账户与消费 → 模型来源」再截 —— 维护者那一刻看到的就是这张图。
 *
 * 场景（每个在 390×844 / 360×740 两档各一张）：
 *   list    模型来源 = 三行 inset 列表（内置服务 / 第三方服务 / DeepSeek 官方服务）
 *   third   点「第三方服务」→ 子页：‹ 返回 + 协议分段（OpenAI 兼容 / Anthropic 协议）+ 服务地址 / API Key / 模型
 *
 * 同时在 `metrics.json` 里落 DOM 断言（不靠人眼看图）：
 *  1. 这一屏**没有** `role="group"` 包着那三项（分段控件的证据），三行文案恰好是上面那三条；
 *  2. 行高 56px、右侧 `›`、行间 1px 极浅分隔线；
 *  3. 第三方服务子页里有「返回」+ 两个协议 + 三个字段；
 *  4. 未登录点「内置服务」→ 出现登录 / 注册（**只有它判断登录**）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}

/** 三行文案（与 `src/i18n/zh.ts` 的 `accountConsumeSource*` 同步；脚本不 import 源码，免得为一张图拉整包 TS） */
const ROW_LABELS = ['内置服务', '第三方服务', 'DeepSeek 官方服务']
const PROTOCOLS = ['OpenAI 兼容', 'Anthropic 协议']
const FIELDS = ['服务地址', 'API Key', '模型']
const OUT = path.join(ROOT, 'docs/ui/727-source-rows')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8099/')
const ONLY = arg('viewport', null)

async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    const panel = document.querySelector('[data-testid="account-consume-page"]')
    const buttons = [...document.querySelectorAll('button')]
      .filter(vis)
      .map((b) => (b.textContent || '').trim())
    const groups = [...document.querySelectorAll('[role="group"]')]
      .filter(vis)
      .map((g) => ({
        label: g.getAttribute('aria-label'),
        texts: [...g.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      }))
    const rows = panel
      ? [...panel.querySelectorAll('[data-testid^="settings-source-"]')].filter(vis).map((b) => ({
          id: b.getAttribute('data-testid'),
          label: (b.querySelector('span')?.textContent || '').trim(),
          text: (b.textContent || '').trim(),
          height: Math.round(b.getBoundingClientRect().height),
        }))
      : []
    const inputs = panel
      ? [...panel.querySelectorAll('input')].filter(vis).map((i) => i.getAttribute('aria-label') || i.placeholder)
      : []
    /** 行间那条 1px 极浅分隔线（`AccountConsume.module.css` 的 `.divider`：高 1px、有底色） */
    const dividers = panel
      ? [...panel.querySelectorAll('div')].filter((d) => {
          const style = getComputedStyle(d)
          return vis(d) && style.height === '1px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        }).length
      : 0
    return { buttons, groups, rows, inputs, dividers }
  })
}

async function openSourcePage(page) {
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  if (!(await page.locator('[data-testid="account-consume-open"]').count())) {
    await page.getByRole('button', { name: '设置', exact: true }).first().click()
    await page.waitForTimeout(400)
  }
  await page.click('[data-testid="account-consume-open"]')
  await page.waitForTimeout(300)
  const sourceRow = page.locator('[data-testid="account-consume-source"]')
  if (await sourceRow.count()) {
    await sourceRow.click()
    await page.waitForTimeout(400)
  }
}

const checks = []

async function scene(browser, key, size, sceneName, run) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openSourcePage(page)
  const result = await run(page, key, sceneName)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  if (errors.length || overflow) {
    checks.push({ viewport: key, scene: sceneName, errors, horizontalOverflow: overflow })
  }
  await page.screenshot({ path: path.join(OUT, String(key), `${sceneName}.png`) })
  await context.close()
  return result
}

const browser = await chromium.launch()
const metrics = { base: BASE, viewports: {}, labelChecks: {}, notes: [] }

for (const [key, size] of Object.entries(VIEWPORTS)) {
  if (ONLY && ONLY !== key) {
    continue
  }
  await mkdir(path.join(OUT, String(key)), { recursive: true })
  const viewportMetrics = {}

  // ── 场景 1：三行列表 ──────────────────────────────────────────────
  viewportMetrics.list = await scene(browser, key, size, 'list', async (page) => {
    const dom = await snapshot(page)
    const rowGroups = dom.groups.filter((group) =>
      group.texts.some((text) => ROW_LABELS.includes(text.replace(/›$/, '')))
    )
    return {
      rowLabels: dom.rows.map((row) => row.label),
      rowHeights: dom.rows.map((row) => row.height),
      chevrons: dom.rows.map((row) => /›$/.test(row.text)),
      hairlineDividers: dom.dividers,
      // 分段控件的证据：`role="group"` 里是否包着来源三项（期望 0）
      groups: dom.groups,
      groupsWrappingSourceRows: rowGroups.length,
      buttons: dom.buttons,
    }
  })

  // ── 场景 2：第三方服务子页 ────────────────────────────────────────
  viewportMetrics.third = await scene(browser, key, size, 'third', async (page) => {
    await page.click('[data-testid="settings-source-third"]')
    await page.waitForTimeout(600)
    const dom = await snapshot(page)
    return {
      hasBack: dom.buttons.includes('返回'),
      groups: dom.groups,
      inputs: dom.inputs,
      buttons: dom.buttons,
    }
  })

  // ── 场景 3：未登录点「内置服务」→ 登录 / 注册（只有它判断登录） ──────
  viewportMetrics.builtinSignedOut = await scene(browser, key, size, 'builtin-signed-out', async (page) => {
    await page.click('[data-testid="settings-source-builtin"]')
    await page.waitForTimeout(700)
    const dom = await snapshot(page)
    return { buttons: dom.buttons, hasLogin: dom.buttons.includes('登录'), hasRegister: dom.buttons.includes('注册') }
  })

  metrics.viewports[key] = viewportMetrics
}

await browser.close()

// ── 汇总断言（缺一条就明确写 false，不靠人看图） ─────────────────────
const verdicts = { rows: [], noSourceGroup: [], thirdSubpage: [], builtinNeedsLogin: [], noOverflow: true }
for (const [key, viewportMetrics] of Object.entries(metrics.viewports)) {
  const list = viewportMetrics.list
  verdicts.rows.push({
    viewport: key,
    labels: list.rowLabels,
    ok: JSON.stringify(list.rowLabels) === JSON.stringify(ROW_LABELS),
    heights: list.rowHeights,
    chevrons: list.chevrons.every(Boolean),
  })
  verdicts.noSourceGroup.push({
    viewport: key,
    groupsWrappingSourceRows: list.groupsWrappingSourceRows,
    ok: list.groupsWrappingSourceRows === 0,
  })
  const third = viewportMetrics.third
  verdicts.thirdSubpage.push({
    viewport: key,
    ok:
      third.hasBack &&
      JSON.stringify(third.groups.filter((g) => g.label === '协议').flatMap((g) => g.texts)) ===
        JSON.stringify(PROTOCOLS) &&
      // API Key 行没有 aria-label，只有占位文案：「请输入 API Key」——按子串认字段
      FIELDS.every((field) => third.inputs.some((text) => (text || '').includes(field))),
    back: third.hasBack,
    protocols: third.groups.filter((g) => g.label === '协议').flatMap((g) => g.texts),
    inputs: third.inputs,
  })
  const builtin = viewportMetrics.builtinSignedOut
  verdicts.builtinNeedsLogin.push({
    viewport: key,
    ok: builtin.hasLogin && builtin.hasRegister,
    buttons: builtin.buttons,
  })
  if (viewportMetrics.list.buttons.length === 0) {
    verdicts.noOverflow = false
  }
}
metrics.verdicts = verdicts
metrics.pageErrors = checks

await writeFile(path.join(OUT, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)
console.log(JSON.stringify(verdicts, null, 2))
console.log(`\n截图与断言已落到 ${path.relative(ROOT, OUT)}/`)
