// [layer: integration | 依赖: playwright + chromium + 本地 dist-standard 静态服务 | 耗时: ~1 分钟]
//
// #362 / #367 · 域 3 最小充分集 · N3-C「设置页探测面板 + 模型行闭环」（L2，一张表 12 行）
//
// 为什么只能到 L2：`describeProbe`（六档文案 → 一句人话）是 `ApiConfigFields.tsx` 内部的 `const`，
// 没有导出，纯 Node 读不到；导出它属于改源码，超出本单边界（减法表之外只做新增）。
// 所以这里按 #362「能用 DOM 表达的用 DOM 表达」——真实点「测试」，读真实渲染出来的那句话。
//
//   自起标准产物服务（DIST_OUT=dist-standard），上游全部用 page.route 打桩：
//   cd <repo> && DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   node tests/integration/settings-probe-model.test.mjs
//
// 覆盖功能点：
//   F3-05 API Key 校验与探测：用输入框当前值探测、未填 Key 本地拦下不发请求
//   F3-06 探测失败文案分类（六档）：invalid 由 N3-B 覆盖，这里覆盖 timeout / network / html / json / http
//        以及成功档的「有列表」与「通了但空」
//   F3-07 模型列表拉取与选择：listbox 渲染、选中写回并落盘、空列表提示
//   F3-08 地址校验：空地址/非法地址各有专属文案，且非法值不落盘
//   F3-13 渠道间凭证隔离：401 判死后停自动探测、换 Key 后自动恢复（指纹 = host + Key）
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, SKIP_CODE } from '../helpers/env.mjs'
import { clickTest, openSettingsDataSection } from '../helpers/helpers.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const KEY = 'sk-probe-model-0123456789'
const NEW_KEY = 'sk-probe-model-replaced-9876'
const BASE = 'https://probe.example.test'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}

let served
let browser
try {
  served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist-standard' })
  const APP_URL = process.env.APP_URL || served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  /** 记录每一次 /v1/models 探测（自动刷新与手动「测试」共用同一个 probeProvider） */
  const probes = []
  let mode = 'ok'
  await page.route('**/v1/models', async (route) => {
    probes.push(route.request().url())
    switch (mode) {
      case 'ok':
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'model-alpha' }, { id: 'model-beta' }] }),
        })
      case 'empty':
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      case 'html':
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>gateway</title>',
        })
      case 'badjson':
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[oops' })
      case 'http500':
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'upstream boom' } }),
        })
      case 'unauthorized':
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Invalid API Key' } }),
        })
      case 'timeout':
        // 永不 fulfill：探测自己的 AbortController 到点后应给出「超时」而不是「无法连接」
        return new Promise(() => {})
      case 'network':
        return route.abort('failed')
      default:
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  /** 写配置并重载：页面按目标渠道起来（key 已存时不会自动弹设置） */
  const seed = async ({ kind = 'openai', baseUrl = BASE, model = '', key = KEY } = {}) => {
    await page.evaluate(
      ({ kind, baseUrl, model, key }) => {
        window.localStorage.clear()
        window.localStorage.setItem('chat-demo:provider-kind', kind)
        if (baseUrl) window.localStorage.setItem(`chat-demo:base-url:${kind}`, baseUrl)
        if (model) window.localStorage.setItem(`chat-demo:model:${kind}`, model)
        if (key) window.localStorage.setItem('chat-demo:api-key', key)
      },
      { kind, baseUrl, model, key }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
  }

  const dialogText = async () => {
    const dialog = page.getByRole('dialog').first()
    return (await dialog.count()) > 0 ? await dialog.innerText() : await page.locator('body').innerText()
  }

  /** 打开设置 → 点「测试」→ 等结论落地，返回 { text, probes: 本次窗口内打出的探测数 } */
  const runTest = async ({ settleMs = 600 } = {}) => {
    await openSettingsDataSection(page)
    // 打开设置时模型行会自己刷新一次列表（同一个 probeProvider），先等它落地再开窗口
    await page.waitForTimeout(settleMs)
    const start = probes.length
    await clickTest(page)
    await page
      .getByText(/连接成功|请求失败|无法连接|连接超时|返回的不是 JSON|请求返回的是网页|请先填写/)
      .first()
      .waitFor({ timeout: 25000 })
      .catch(() => {})
    await page.waitForTimeout(250)
    return { text: await dialogText(), probes: probes.length - start }
  }

  /** 六档文案：每一行一个上游响应，断言「界面说的是这一档」而不是别的档 */
  const tiers = [
    {
      id: '1',
      F: 'F3-06/F3-07',
      mode: 'ok',
      name: '成功（有列表）',
      expect: [/连接成功（HTTP 200）/, /共 2 个模型/, /model-alpha, model-beta/],
      forbid: [/请求失败/, /无法连接/, /连接超时/, /返回的不是 JSON/, /请求返回的是网页/],
    },
    {
      id: '2',
      F: 'F3-06',
      mode: 'empty',
      name: '成功但空（OkEmpty）',
      expect: [/连接成功（HTTP 200），但接口没有返回模型列表/],
      forbid: [/请求失败/, /无法连接/, /返回的不是 JSON/],
    },
    {
      id: '3',
      F: 'F3-06',
      mode: 'html',
      name: '上游返回网页（Html）',
      expect: [/请求返回的是网页（HTTP 200）/],
      forbid: [/连接成功/, /无法连接/, /返回的不是 JSON/],
    },
    {
      id: '4',
      F: 'F3-06',
      mode: 'badjson',
      name: '不是 JSON（BadJson）',
      expect: [/返回的不是 JSON：/, /\{"data":\[oops/],
      forbid: [/连接成功/, /请求返回的是网页/, /请求失败/],
    },
    {
      id: '5',
      F: 'F3-06',
      mode: 'http500',
      name: 'HTTP 5xx（Http）',
      expect: [/请求失败（HTTP 500）：upstream boom/],
      forbid: [/连接成功/, /无法连接/, /连接超时/],
    },
    {
      id: '6',
      F: 'F3-06',
      mode: 'network',
      name: '连不上（Network）',
      expect: [/无法连接：/],
      forbid: [/连接成功/, /请求失败（HTTP/, /返回的不是 JSON/],
    },
    {
      id: '7',
      F: 'F3-06',
      mode: 'timeout',
      name: '超时（Timeout）',
      expect: [/连接超时，请检查地址与网络后再试/],
      forbid: [/无法连接/, /请求失败（HTTP/],
    },
  ]

  for (const row of tiers) {
    console.log(`\n[${row.id}] ${row.F} ${row.name}`)
    mode = row.mode
    await seed()
    const result = await runTest({ settleMs: row.mode === 'timeout' ? 200 : 600 })
    const miss = row.expect.filter((re) => !re.test(result.text))
    const wrong = row.forbid.filter((re) => re.test(result.text))
    if (miss.length > 0) {
      bad(`${row.id}) ${row.name} 缺少应有的结论 ${miss.map(String).join(' / ')}；界面：${result.text.replace(/\n/g, ' / ').slice(-160)}`)
    } else if (wrong.length > 0) {
      bad(`${row.id}) ${row.name} 串到了别的档 ${wrong.map(String).join(' / ')}`)
    } else {
      ok(`${row.id}) ${row.name} → ${row.expect[0].source.slice(0, 24)}（窗口内探测 ${result.probes} 次）`)
    }
  }

  // ---------- F3-05：没有 Key 时本地拦下，一个请求都不发 ----------
  console.log('\n[8] F3-05 未填 Key → 本地拦下')
  mode = 'ok'
  await seed({ key: '' })
  {
    const before = probes.length
    await openSettingsDataSection(page)
    await page.waitForTimeout(400)
    await clickTest(page)
    await page.getByText(/请先填写 API Key/).first().waitFor({ timeout: 5000 }).catch(() => {})
    const text = await dialogText()
    if (!/请先填写 API Key/.test(text)) {
      bad(`8) 没有给出「请先填写 API Key」；界面：${text.replace(/\n/g, ' / ').slice(-160)}`)
    } else if (probes.length !== before) {
      bad(`8) 本地就该拦下，却打出了 ${probes.length - before} 次 /models（会拿到空鉴权的 401）`)
    } else {
      ok('8) 未填 Key 时不发请求，界面直接说「请先填写 API Key」')
    }
  }

  // ---------- F3-08：空地址 / 非法地址各有专属文案，且非法值不落盘 ----------
  console.log('\n[9] F3-08 地址校验（空 → 必填，非法 → 拒绝且不落盘）')
  await seed({ baseUrl: '' })
  {
    await openSettingsDataSection(page)
    await page.waitForTimeout(400)
    const input = page.getByLabel(/服务地址|Service URL/).first()
    // 空地址：自填渠道没有内置默认，失焦/回车保存时就该拒绝
    await input.click()
    await input.press('Enter')
    await page.waitForTimeout(300)
    const emptyText = await dialogText()

    await input.fill('relay.example.com')
    await input.press('Enter')
    await page.waitForTimeout(300)
    const invalidText = await dialogText()
    const stored = await page.evaluate(() => window.localStorage.getItem('chat-demo:base-url:openai'))

    if (!/请先填写服务地址/.test(emptyText)) {
      bad(`9) 空地址没有提示必填：${emptyText.replace(/\n/g, ' / ').slice(-160)}`)
    } else if (!/服务地址必须以 http:\/\/ 或 https:\/\/ 开头/.test(invalidText)) {
      bad(`9) 非法地址没有提示格式：${invalidText.replace(/\n/g, ' / ').slice(-160)}`)
    } else if (stored !== null) {
      bad(`9) 非法地址被写进 localStorage：${stored}`)
    } else {
      ok('9) 空地址 → 必填提示；relay.example.com → 格式提示且不落盘')
    }
  }

  // ---------- F3-07：模型列表下拉、选中写回、刷新后仍在 ----------
  console.log('\n[10] F3-07 模型行：listbox 渲染 + 选中写回 + 刷新后保留')
  mode = 'ok'
  await seed({ model: '' })
  {
    await openSettingsDataSection(page)
    const modelInput = page.getByLabel(/^模型$|^Model$/).first()
    await modelInput.click()
    const listbox = page.getByRole('listbox')
    await listbox.waitFor({ timeout: 10000 }).catch(() => {})
    const options = await page.getByRole('option').allInnerTexts()
    if (!options.includes('model-alpha') || !options.includes('model-beta')) {
      bad(`10) 模型下拉没有渲染出接口返回的列表：${JSON.stringify(options)}`)
    } else {
      await page.getByRole('option', { name: 'model-beta' }).first().click()
      await page.waitForTimeout(400)
      const stored = await page.evaluate(() => window.localStorage.getItem('chat-demo:model:openai'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(700)
      await openSettingsDataSection(page)
      const shown = await page
        .getByLabel(/^模型$|^Model$/)
        .first()
        .inputValue()
      if (stored !== 'model-beta') {
        bad(`10) 选中模型没有落盘：localStorage=${JSON.stringify(stored)}`)
      } else if (shown !== 'model-beta') {
        bad(`10) 刷新后模型行不是选中值：${JSON.stringify(shown)}`)
      } else {
        ok(`10) 下拉渲染 ${options.length} 项，选中 model-beta → 落盘 → 刷新后仍在`)
      }
    }
  }

  // ---------- F3-07：空列表提示 ----------
  console.log('\n[11] F3-07 接口返回空列表 → 「可直接手动输入」')
  mode = 'empty'
  await seed({ model: '' })
  {
    await openSettingsDataSection(page)
    await page.getByText(/接口返回空模型列表/).first().waitFor({ timeout: 15000 }).catch(() => {})
    const text = await dialogText()
    if (!/接口返回空模型列表/.test(text)) {
      bad(`11) 空列表没有给出提示：${text.replace(/\n/g, ' / ').slice(-160)}`)
    } else {
      ok('11) 空列表 → 「接口返回空模型列表，可直接手动输入」')
    }
  }

  // ---------- F3-13 / F3-05：401 判死 → 停自动探测 → 换 Key 恢复 ----------
  console.log('\n[12] F3-13 401 判死后停自动探测，换 Key 自动恢复')
  mode = 'unauthorized'
  await seed()
  {
    await openSettingsDataSection(page)
    await page.getByText(/Key 无效或已过期/).first().waitFor({ timeout: 15000 }).catch(() => {})
    const afterFail = await dialogText()
    // 关掉再打开设置：自动探测应当已被拦下（否则同一把死 Key 会一直打上游，#303 问题 3）
    const before = probes.length
    await page.getByRole('dialog').first().getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(400)
    await openSettingsDataSection(page)
    await page.waitForTimeout(900)
    const autoProbes = probes.length - before

    // 换一把 Key：指纹（host + Key 短哈希）变了，自动探测必须恢复
    mode = 'ok'
    const probesBeforeSave = probes.length
    await page.getByRole('button', { name: /修改 API Key|Edit API Key/ }).first().click()
    await page.locator('input[type="password"]').first().fill(NEW_KEY)
    await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
    await page.waitForTimeout(1500)
    const recovered = await dialogText()
    const probesAfterSave = probes.length - probesBeforeSave

    if (!/Key 无效或已过期/.test(afterFail)) {
      bad(`12) 401 之后没有可读的 Key 判死提示：${afterFail.replace(/\n/g, ' / ').slice(-160)}`)
    } else if (autoProbes !== 0) {
      bad(`12) Key 已判死，重开设置仍自动打了 ${autoProbes} 次 /models`)
    } else if (/Key 无效或已过期/.test(recovered)) {
      bad('12) 换 Key 之后提示没有解除（换号应自动失效旧指纹）')
    } else if (probesAfterSave === 0) {
      bad('12) 换了 Key 仍然没有自动探测（恢复不了，用户只能手动刷）')
    } else {
      ok(`12) 401 → 「Key 无效或已过期」；重开设置自动探测 0 次；换 Key 后恢复自动探测 ${probesAfterSave} 次`)
    }
  }
} finally {
  await browser?.close().catch(() => {})
  served?.kill()
}

if (failures.length > 0) {
  console.error(`\nFAIL tests/integration/settings-probe-model.test.mjs`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
if (!browser) {
  console.error('SKIP(env) 无法启动浏览器')
  process.exit(SKIP_CODE)
}
console.log('\nPASS tests/integration/settings-probe-model.test.mjs')
