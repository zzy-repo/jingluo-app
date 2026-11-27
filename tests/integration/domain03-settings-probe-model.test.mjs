// [layer: integration | 依赖: playwright + chromium + 本地 dist-standard 静态服务 | 耗时: ~1 分钟]
//
// #362 / #367 · 域 3 · 「模型来源 → 第三方服务」**草稿态**里的连通性探测（L2）
//
// ## 这条用例钉什么（裁决 2026-11-26，见 docs/testing/product-debt.md 已裁决第 3 条）
//
// #807 之后来源页是三行手风琴，探测入口从「打开模型下拉即探测」改成草稿里的**「测试」按钮**
// （`settings-source-draft-test`）。所以这里钉的是这个入口的**意图**：
//
//   1. 空地址点「测试」→ 必填提示（`settingsBaseUrlRequired`），**一个请求都不发**；
//   2. 有地址没 Key 点「测试」→ 提示先填 Key（`settingsTestApiKeyRequired`），同样不发请求；
//   3. 有地址有 Key 点「测试」→ **真的发出 `GET {草稿地址}/v1/models`**（带鉴权头），
//      并且把结果 / 错误**按档渲染出来**（成功、通了但空、网页、非 JSON、HTTP 5xx、连不上、超时）。
//
// **不再钉**「模型下拉存在 / listbox 渲染了几项 / 选中的模型写回」这类**界面形状**：#807 把模型行
// 收进了「确认使用」之后的生效形态，草稿态里没有那个下拉，也不该为了迁就旧断言把它加回来。
//
// ## 文案口径（自证伪点）
//
// 期望句子从 `src/i18n/zh.ts` 现取（`settingsTestOk` / `settingsTestHttp` / …），用例里不抄字面量：
// 产品改文案 → 这里跟着变（仍断「就是这一档」）；只有**改错档**（把 5xx 说成网络错误）才会红。
//
//   NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts
//   node tests/run-layer.mjs integration --case tests/integration/domain03-settings-probe-model.test.mjs
//
// ## #997：这条用例一天红三次的两个原因，以及现在怎么处理
//
// 原因一（等待）**旧写法 `clickDraftTest` 等的是按钮文案 `测试` —— 点下去那一刻文案**本来就是**
// `测试`（`测试中…` 只在重新渲染之后才出现），所以那个 `waitFor` 立刻返回、是个**空等待**；
// 真正在等的只有紧随其后的 `waitForTimeout(200)`。每一行的计数窗口因此是「点击 + 200 ms」这个
// **时长**，而不是「这次点击真的走完了」这个**状态**。
//
// 原因二（`/v1/models` 不止一种来源）展开「第三方服务」那一行时，界面会在后台把协议判一次
// （#794，`AccountConsumePage.tsx:259-273`）。判定看的是**已存地址**，不是草稿里的地址
// （`apiConfig.ts:301-311`）：1 号行要测「已存地址空着」的零状态，于是那次判定没有缓存可用、
// 去探构建期默认地址 `https://api.deepseek.com/v1/models`，两种鉴权各一次 = **2 次**；实测落在
// 点击前后那 200 ms 内（`[probe-in] 2132ms` / `2143ms`，`[click] 2365ms`）。runner 一慢就落进
// 原因一那个窗口 → CI 上 `1) 期望发出 0 次 /v1/models，实际 1 次`。
//
// 对应两处改动（`requests` 的期望值一个没动）：
//
//  A. **等真的终态**（把「时长」换成「状态」）：
//     ① 采样窗口**起点**先等「在飞集合为空 + `probes` 计数不再变化」（`waitProbesQuiet`）；
//     ② 点下去先等**忙碌态**（`disabled===true` / `测试中…`；观测不到不补睡，见 `waitDraftTestBusy`）；
//     ③ 结论落地（面板文字变了）→ **空闲态**（`disabled===false` 且文案回到 `测试`）；
//     ④ 再等一次「在飞集合为空 + 计数不再变化」，然后才收口。
//     行末那个 `row.settleMs`（旧 `:299`）同理换成同一判据。
//     「在飞集合」维护在 `page.route` 入口 + `requestfinished` / `requestfailed`
//     （`mode:'timeout'` 那档的 route 永远不 fulfill，只有页面 abort 后的 `requestfailed` 能收口）。
//  B. **把第二种来源钉进期望**，而不是种地址把它藏掉：每行多一列 `ambient`，断言「展开时后台判
//     协议发了几次、打到哪个地址」；`requests` 只数打到**草稿地址**的那几次。于是 1 号行的期望读
//     作「点击发出 0 次 + 展开时后台判协议 2 次（都打构建期默认地址）」，两个数都钉死。
//
// 自证「不是搬宽松」用**加压变体**：同一份代码、靠环境变量切「修复前的实现 / 修复后的实现」，
// 并把 runner 慢的那两件事同时做出来（各跑 3 次，结果必须一致）：
//
//   # 修复前（空等待 + 200 ms + 全地址混算）：3 次全红，原句 `期望发出 0 次 /v1/models，实际 1 次`
//   PROBE_LEGACY_WAIT=1 PROBE_SLOW_MS=400 DIST_DIR_STANDARD=dist-standard node tests/integration/domain03-settings-probe-model.test.mjs
//   # 修复后 + 同样的加压：3 次全绿
//   PROBE_SLOW_MS=400 DIST_DIR_STANDARD=dist-standard node tests/integration/domain03-settings-probe-model.test.mjs
//
// `PROBE_SLOW_MS` 干两件事（见下面 `addInitScript`）：把「点击 → 读设置 → 发请求」拖慢
// 400 ms（同步忙等 = 主线程被占满，且延迟一定在**发起前**，否则不会移动 `probes.push` 的时点），
// 并把「展开时后台判协议那两次」**挂到点击之后**再放行（runner 慢时它就是这么晚落地的）。
//
// 断言为什么能容忍那 2 次而不失守：`isDraftHit` 只认草稿地址，1 号行那 2 次打到默认地址 ——
// 一旦点击真的误打默认地址、或者后台判定改打别处，`ambient` 的次数/地址断言与 `requests` 的
// 计数会两头都红（**比以前更严**：以前这 2 次既没断言、又被混进 `requests`）。


import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, SKIP_CODE } from '../helpers/env.mjs'
import { openApiConfigSection } from '../helpers/helpers.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const KEY = 'sk-probe-model-0123456789'
const BASE = 'https://probe.example.test'
/**
 * 构建期默认地址（`__API_ORIGIN__`）：`rspack.config.ts:421` 的 `apiOrigin = 'https://api.deepseek.com'`，
 * `scripts/build.mjs` 不覆盖它，`src/services/api/apiConfig.ts:57` 把它读成 `DEFAULT_BASE_URL`。
 *
 * 为什么会出现在这条用例里：协议判定看的是**已存地址**（`apiConfig.ts:301-311` 的
 * `resolveBaseUrl()`：有已存值就用已存值，没有才落到 `spec.defaults?.baseUrl ?? DEFAULT_BASE_URL`）。
 * 1 号行是「用户选了第三方、已存地址还空着」的零状态，于是展开「第三方服务」时那次后台判定
 * （#794，`AccountConsumePage.tsx:259-273` → `protocolDetect.ts:310`）没有缓存地址可用、
 * 改探这个默认地址，`probeProtocol` 按两种鉴权各试一次（`protocolDetect.ts:199-204`）= **两次**
 * `GET https://api.deepseek.com/v1/models`。
 *
 * #997 的处理：不删、也不种地址把它藏掉，而是把「这几次打到默认地址」写进每行的期望里
 * （`ROWS[].ambient`），与本行点击发出的那几次分开钉。实测（dist-standard，2026-11-27）：
 *   已存地址为空 + 有 Key   → 展开时 2 次，全打 api.deepseek.com（点击前 ~1.2s 落地）
 *   已存地址 + 命中判定缓存 → 展开时 0 次
 *   已存地址、无缓存        → 展开时 2 次，全打**用户自己那个地址**（不是默认地址）
 */
const BUILD_DEFAULT_ORIGIN = 'https://api.deepseek.com'
const MODELS_PATH = '/v1/models'
/** 界面语言钉成中文（zh 表就是断言口径；不跟 shell 的 LANG 走） */
const { zh } = await import('../../src/i18n/zh.ts')

/** 与 i18n 的插值同一口径：`{name}` → params[name] */
const render = (key, params = {}) =>
  String(zh[key]).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole
  )

/** 带 `{message}` 的那几档：上游 / 浏览器给的原话不可预测，只等值断言模板的前半句 */
const head = (key) => String(zh[key]).split('{message}')[0]

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

  const DRAFT_TEST = '[data-testid="settings-source-draft-test"]'
  const THIRD_PANEL = '[data-testid="settings-source-third-panel"]'

  /**
   * #997 关闭条件①：同一份代码里能切「旧等待逻辑 / 新等待逻辑」，加压变体上对照
   * 「旧逻辑稳定红、新逻辑稳定绿」，不必靠 `git stash` 来回改文件。
   */
  const LEGACY_WAIT = process.env.PROBE_LEGACY_WAIT === '1'

  /**
   * #997 关闭条件①「加压变体」：把 CI runner 慢的两件事同时做出来（`PROBE_SLOW_MS` 给毫秒数）：
   *
   *  1. **点击 → 读设置 → 发 `/v1/models` 这一段慢**：延迟加在 `window.fetch` 的**发起前**
   *     （`probes.push` 在 `page.route` 入口 = 请求真正发出的那一刻；加在响应侧不会移动计入时点，
   *     竞态根本不会出现）。用同步忙等而不是 `setTimeout`：runner 一慢就是主线程被占满的样子；
   *     换成 `setTimeout` 会把控制权先交回事件循环，React 反而抢先把「测试中…」渲染出来，
   *     旧逻辑就又等对了（实测：那样旧逻辑在加压变体上是绿的，对照失效）。
   *  2. **展开那一行时后台判协议（#794）发的那次探测晚于用户点击落地**：旧实现给每一行留的
   *     计数窗口只有「点击 + 200 ms」，这条晚到的请求正好落进去 —— CI 上
   *     `1) 期望发出 0 次 /v1/models，实际 1 次` 就是它。所以这里把那类请求**挂到点击之后**再放行
   *     （每 5 ms 问一次点击标记，不阻塞点击本身）。
   */
  const SLOW_MS = Number(process.env.PROBE_SLOW_MS ?? 0)
  if (SLOW_MS > 0) {
    await context.addInitScript(`(() => {
      const MODELS = '${MODELS_PATH}'
      const BUTTON = '${DRAFT_TEST}'
      window.__draftTestClicks = 0
      document.addEventListener(
        'click',
        (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest(BUTTON)) {
            window.__draftTestClicks += 1
          }
        },
        true
      )
      const spin = (ms) => {
        const until = Date.now() + ms
        while (Date.now() < until) { /* 占住主线程：请求暂时发不出去 */ }
      }
      const original = window.fetch
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input)
        if (url.indexOf(MODELS) === -1) {
          return original.call(window, input, init)
        }
        if (window.__draftTestClicks === 0) {
          // 本行还没点过「测试」→ 这是展开时后台判协议的那次探测：挂到点击之后
          return new Promise((resolve) => {
            const timer = setInterval(() => {
              if (window.__draftTestClicks > 0) {
                clearInterval(timer)
                resolve(null)
              }
            }, 5)
          }).then(() => original.call(window, input, init))
        }
        spin(${SLOW_MS})
        return original.call(window, input, init)
      }
    })()`)
  }

  /**
   * #997：`page.route` 入口维护的「在飞集合」—— 请求进来就加入，请求结束 / 被页面放弃时移除。
   *
   * 为什么移除挂在 page 的 `requestfinished` / `requestfailed` 上，而不是 `route.fulfill`
   * 之后的 `finally`：`mode === 'timeout'` 那一档的 route **永远不 fulfill**（探测自己的
   * `AbortController` 到点后由页面放弃请求），只有 `requestfailed` 会在那一刻把它从集合里拿掉。
   * 实测 `route.request()` 与这两个事件里拿到的 request 是同一个对象，所以直接按引用删。
   */
  const inflight = new Set()
  page.on('requestfinished', (request) => inflight.delete(request))
  page.on('requestfailed', (request) => inflight.delete(request))

  /** 记录每一次 `/v1/models` 探测（草稿态没有自动探测：只有用户点「测试」才会发生） */
  const probes = []
  let mode = 'ok'
  await page.route(`**${MODELS_PATH}`, async (route) => {
    inflight.add(route.request())
    probes.push({
      url: route.request().url(),
      authorization: route.request().headers()['authorization'] ?? '',
      apiKey: route.request().headers()['x-api-key'] ?? '',
    })
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
      case 'network':
        return route.abort('failed')
      case 'timeout':
        // 永不 fulfill：探测自己的 AbortController 到点后应给出「超时」而不是「连不上」
        return new Promise(() => {})
      default:
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  /**
   * 写配置并重载：生效来源 = 第三方（openai 槽位）。
   *
   * 为什么要顺手种一条 `chat-demo:protocol-cache`（#794）：展开「第三方服务」那一行时界面会在后台
   * 判一次协议，判不出来就自己发 `GET {base}/v1/models` 探一次 —— 那条请求与本用例要数的「用户点
   * 「测试」发出的探测」不是一回事，混在一起会让次数断言按机器快慢漂移（实测撞过一次）。
   * 种上「这条地址上次判成 openai」之后，协议判定本地命中缓存，探测次数只剩用户点出来的那几次。
   *
   * 注意 `baseUrl` 为空时**只**种 Key、不种已存地址（1 号行就是这样，`if (baseUrl)` 从这份用例
   * 创建那天起就长这样）：那是「用户选了第三方但还没填地址」的真实零状态，这一状态下后台判定
   * 会拿不到缓存地址、改探构建期默认地址 —— 见下面 `BUILD_DEFAULT_ORIGIN` 那段与断言里的
   * `ambient` 一列。#997 没有把它藏掉，而是把它**钉进期望**。
   */
  const seed = async ({ baseUrl = BASE, key = KEY } = {}) => {
    await page.evaluate(
      ({ baseUrl, key }) => {
        window.localStorage.clear()
        window.localStorage.setItem('chat-demo:provider-kind', 'openai')
        if (baseUrl) {
          window.localStorage.setItem('chat-demo:base-url:openai', baseUrl)
          window.localStorage.setItem(
            'chat-demo:protocol-cache',
            JSON.stringify({ [baseUrl]: { p: 'openai', at: 1_700_000_000_000 } })
          )
        }
        if (key) window.localStorage.setItem('chat-demo:api-key', key)
      },
      { baseUrl, key }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
  }

  /**
   * 设置 → 账户与消费 → 模型来源 → 展开「第三方服务」（草稿态，不改生效来源）。
   * 走 helpers 里那条唯一路径：每一步失败都会说清「卡在哪 / 期望什么 / 现在是什么」。
   */
  const openThirdRow = async () => {
    await openApiConfigSection(page, { row: 'third' })
    return page.locator('[data-testid="settings-source-third-panel"]:not([hidden])').first()
  }

  const draftFill = async (field, value) => {
    await page.getByTestId(`settings-source-draft-${field}`).first().fill(value)
  }

  /** 面板文字归一：Node 侧与页面侧必须同一口径，否则「文字变了」这个判据会假阳/假阴 */
  const squeeze = (text) => String(text).replace(/\s+/g, ' ').trim()

  /**
   * #997：`/v1/models` 按**打到哪个地址**分成两类，别混在一个计数里。
   *
   *  - 「点击的」= 打到草稿地址（`BASE` + `/v1/models`）。`sent` 只数这一类 —— 行的期望
   *    （`requests` 列）说的本来就是「用户点『测试』发出几次」。
   *  - 「展开时后台判协议的」= 打到别的主机（1 号行零状态时就是构建期默认地址）。它**没被忽略**：
   *    每行的 `ambient` 列把它按次数 + 具体地址钉死，张冠李戴就红。
   */
  const DRAFT_PROBE_PREFIX = `${BASE}${MODELS_PATH}`
  const isDraftHit = (hit) => hit.url.startsWith(DRAFT_PROBE_PREFIX)

  /** 让页面渲染一帧 —— 轮询的节拍是「页面画完一帧」，不是「睡 N 毫秒」 */
  const nextFrame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
      undefined
    )

  /**
   * #997 的确定性判据：**在飞集合为空 且 `probes` 计数不再变化**。
   *
   * 单帧成立不够 —— 那也可能只是「请求还没发出来」。所以连续 `QUIET_FRAMES` 帧都成立才算收敛；
   * 循环的退出条件是状态，不是时长（`timeoutMs` 只是防止产品真坏时无限等下去的兜底）。
   */
  const QUIET_FRAMES = 6
  const waitProbesQuiet = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    let lastCount = probes.length
    let quiet = 0
    while (quiet < QUIET_FRAMES) {
      if (Date.now() > deadline) {
        throw new Error(
          `等 ${MODELS_PATH} 探测收敛超时（${timeoutMs}ms）：在飞 ${inflight.size} 个，probes 计数 ${probes.length}`
        )
      }
      await nextFrame()
      const settled = inflight.size === 0 && probes.length === lastCount
      quiet = settled ? quiet + 1 : 0
      if (!settled) lastCount = probes.length
    }
  }

  /**
   * 等按钮进**忙碌态**：`disabled === true` 或文案 `测试中…`（`ApiConfigFields.tsx` 的
   * `disabled={testing}` + `{testing ? t('settingsTesting') : t('settingsTest')}`）。
   *
   * 探测很快时这个状态可能一次都观测不到（探针 3 ms 就回来了），所以它只是**有限预算的观测**：
   * 观测不到**不算错、也不退化成固定睡眠** —— 调用方接着走「结论已渲染 / 已回到空闲 /
   * 在飞集合为空且计数不再变化」这几条状态判据（见 `clickDraftTest`）。
   * `BUSY_OBSERVE_MS` 不是断言超时，只是「这个瞬时状态还值不值得继续盯」。
   */
  const BUSY_OBSERVE_MS = 300
  const waitDraftTestBusy = () =>
    page.waitForFunction(
      ({ selector, busy }) => {
        const button = document.querySelector(selector)
        if (button === null) return false
        return button.disabled === true || (button.textContent ?? '').indexOf(busy) !== -1
      },
      { selector: DRAFT_TEST, busy: zh.settingsTesting },
      { timeout: BUSY_OBSERVE_MS, polling: 'raf' }
    )

  /** 等按钮回到空闲态：`disabled === false` 且文案回到 `测试`（`ApiConfigFields.tsx` 的 `disabled={testing}`） */
  const waitDraftTestIdle = () =>
    page.waitForFunction(
      ({ selector, idle }) => {
        const button = document.querySelector(selector)
        return button !== null && button.disabled === false && (button.textContent ?? '').trim() === idle
      },
      { selector: DRAFT_TEST, idle: zh.settingsTest },
      { timeout: 30000 }
    )

  /**
   * 点草稿里的「测试」，等这次探测**真的走完**再返回它发出的 `{MODELS_PATH}` 次数（#997）。
   *
   * 旧写法（`PROBE_LEGACY_WAIT=1` 保留，供加压变体对照）等的是按钮文案 `测试`：点下去那一刻
   * 文案本来就是 `测试`，所以它立刻返回 —— 空等待，真正在等的只有后面那个 200 ms 固定睡眠。
   *
   * 新写法每一步都等**可观察的终态**，一个固定睡眠都没有：
   *   ⓪ 开窗之前先等一次收敛（`waitProbesQuiet`）：展开「第三方服务」时的后台协议探测（#794）
   *      会自己打 `/v1/models`，它不属于本行点的「测试」，必须先落地再开窗；
   *   ① 点下去先等**忙碌态**（`disabled===true` / `测试中…`）；观测不到就按上面的约定不去猜时间；
   *   ② 结论落地：面板文字变了（各档结论 / 必填提示都是持久的 DOM 变化，用 rAF 轮询不会漏）；
   *   ③ 回到空闲：`disabled===false` 且文案回到 `测试`；
   *   ④ 计数收敛：在飞集合为空 + `probes` 计数连续若干帧不变。
   */
  const clickDraftTest = async (panel) => {
    if (LEGACY_WAIT) {
      const legacyStart = probes.length
      await page.getByTestId('settings-source-draft-test').first().click()
      await page
        .locator(`${DRAFT_TEST}:text-is("${zh.settingsTest}")`)
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {})
      await page.waitForTimeout(200)
      return probes.length - legacyStart
    }
    const baseline = squeeze(await panelText(panel))
    await waitProbesQuiet()
    const start = probes.length
    await page.getByTestId('settings-source-draft-test').first().click()
    // ① 忙碌态：观测不到不补睡（约定见 `waitDraftTestBusy`），靠后面的状态判据收口
    await waitDraftTestBusy().catch(() => {})
    await page.waitForFunction(
      ({ selector, previous }) => {
        const el = document.querySelector(selector)
        if (el === null) return false
        return (el.innerText ?? '').replace(/\s+/g, ' ').trim() !== previous
      },
      { selector: THIRD_PANEL, previous: baseline },
      { timeout: 30000 }
    )
    await waitDraftTestIdle()
    await waitProbesQuiet()
    // 只数**打到草稿地址**的那几次（`isDraftHit`）：展开时后台判协议打到别处的那几次，由行里的
    // `ambient` 列单独钉，不混进「这一行点了几次测试」。
    return probes.slice(start).filter(isDraftHit).length
  }

  const panelText = async (panel) => (await panel.innerText()).replace(/\s+/g, ' ')

  /**
   * 一张表 8 行：前三列是「上游长什么样 / 界面该说哪一档 / 这一档要不要真发请求」。
   * `expect` 有两种：`exact` = 整句等值（模板可完全填出来的），`prefix` = 只断模板前半句
   * （后半句是上游/浏览器原话，逐字断言等于把别人家的错误文案抄进用例）。
   *
   * `requests` = 用户点「测试」应发出的次数（只数打到**草稿地址**的）；
   * `ambient`  = 展开这一行时后台判协议（#794）应发出的次数（打到**构建期默认地址**的）。
   * 两者分开钉：`requests` 的期望值是这条用例原有的口径，`ambient` 是 #997 补上的 ——
   * 以前它既没被断言、又被算进了 `requests`，于是按机器快慢在 0/1 之间漂。
   */
  const ROWS = [
    {
      id: '1',
      where: '空地址点「测试」',
      mode: 'ok',
      baseUrl: '',
      key: KEY,
      expect: { kind: 'exact', key: 'settingsBaseUrlRequired' },
      requests: 0,
      // 已存地址为空 → 协议判定没有缓存地址可用，改探构建期默认地址，两种鉴权各一次
      ambient: 2,
      why: '自填渠道没有内置默认地址，空地址就该本地拦下',
    },
    {
      id: '2',
      where: '有地址没 Key 点「测试」',
      mode: 'ok',
      baseUrl: BASE,
      key: '',
      expect: { kind: 'exact', key: 'settingsTestApiKeyRequired' },
      requests: 0,
      why: '空鉴权打过去只会换回一个 401，不如本地说清楚',
    },
    {
      id: '3',
      where: '上游 200 + 两个模型',
      mode: 'ok',
      expect: {
        kind: 'exact',
        key: 'settingsTestOk',
        params: { status: 200, count: 2, models: 'model-alpha, model-beta' },
      },
      requests: 1,
    },
    {
      id: '4',
      where: '上游 200 但没有模型列表',
      mode: 'empty',
      expect: { kind: 'exact', key: 'settingsTestOkEmpty', params: { status: 200 } },
      requests: 1,
    },
    {
      id: '5',
      where: '上游返回网页（HTML）',
      mode: 'html',
      expect: { kind: 'exact', key: 'settingsTestHtml', params: { status: 200 } },
      requests: 1,
    },
    {
      id: '6',
      where: '上游返回的不是 JSON',
      mode: 'badjson',
      expect: { kind: 'prefix', key: 'settingsTestBadJson' },
      requests: 1,
    },
    {
      id: '7',
      where: '上游 HTTP 500',
      mode: 'http500',
      expect: { kind: 'exact', key: 'settingsTestHttp', params: { status: 500, message: 'upstream boom' } },
      requests: 1,
      forbid: ['settingsTestOk', 'settingsTestNetwork'],
    },
    {
      id: '8',
      where: '连不上（网络层失败）',
      mode: 'network',
      expect: { kind: 'prefix', key: 'settingsTestNetwork' },
      requests: 1,
      forbid: ['settingsTestOk', 'settingsTestHttp'],
    },
    {
      id: '9',
      where: '超时（上游不回应）',
      mode: 'timeout',
      expect: { kind: 'exact', key: 'settingsTestTimeout' },
      requests: 1,
      forbid: ['settingsTestNetwork', 'settingsTestOk'],
    },
  ]

  for (const row of ROWS) {
    console.log(`\n[${row.id}] ${row.where}${row.why ? `（${row.why}）` : ''}`)
    mode = row.mode
    await seed({ baseUrl: row.baseUrl ?? BASE, key: row.key ?? KEY })
    // 这一行的所有 `/v1/models`（含展开时后台判协议那几次）从这一刻开始记
    const rowStart = probes.length
    const panel = await openThirdRow()
    await draftFill('baseUrl', row.baseUrl ?? BASE)
    await draftFill('apiKey', row.key ?? KEY)
    const sent = await clickDraftTest(panel)
    const text = await panelText(panel)
    const expected =
      row.expect.kind === 'exact' ? render(row.expect.key, row.expect.params) : head(row.expect.key)
    if (!text.includes(expected)) {
      bad(
        `${row.id}) ${row.where} 渲染的不是 ${row.expect.key} 那一句\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(text.slice(0, 200))}`
      )
    } else {
      ok(`${row.id}) ${row.where} → ${row.expect.key}${row.expect.kind === 'prefix' ? '（前半句等值）' : ''}`)
    }
    if (sent !== row.requests) {
      bad(`${row.id}) 期望发出 ${row.requests} 次 ${MODELS_PATH}，实际 ${sent} 次`)
    } else if (row.requests > 0) {
      const hit = probes.filter(isDraftHit).at(-1)
      if (!hit.url.startsWith(`${BASE}${MODELS_PATH}`)) {
        bad(`${row.id}) 探测没有打到草稿里的地址：${hit.url}（期望 ${BASE}${MODELS_PATH}）`)
      } else if (hit.authorization === '' && hit.apiKey === '') {
        bad(`${row.id}) 探测请求一个鉴权头都没带`)
      } else {
        ok(`${row.id}) 探测 = GET ${hit.url}（带鉴权头，共 ${sent} 次）`)
      }
    } else {
      ok(`${row.id}) 本地拦下：${MODELS_PATH} 一次都没发`)
    }
    // #997：**展开这一行时**后台判协议（#794）发出的那几次，单独钉次数与地址。
    // 它跟「用户点测试」不是一回事，但确实发生在这条用例里：1 号行的零状态（已存地址为空）
    // 判定拿不到缓存地址，会去探构建期默认地址，两种鉴权各一次 = 2 次；其余行种了地址 + 缓存，
    // 判定直接命中缓存 = 0 次。把它写进期望而不是 seed 掉，是为了让「产品开始/停止发这条请求」
    // 这件事本身也让用例红。
    const rowHits = probes.slice(rowStart)
    const ambient = rowHits.filter((hit) => !isDraftHit(hit))
    const ambientExpected = row.ambient ?? 0
    if (ambient.length !== ambientExpected) {
      bad(
        `${row.id}) 期望展开时后台判协议发出 ${ambientExpected} 次（打到 ${BUILD_DEFAULT_ORIGIN}${MODELS_PATH}），实际 ${ambient.length} 次\n      实际：${JSON.stringify(ambient.map((hit) => hit.url))}`
      )
    } else if (ambientExpected > 0) {
      const offTarget = ambient.find((hit) => hit.url !== `${BUILD_DEFAULT_ORIGIN}${MODELS_PATH}`)
      if (offTarget !== undefined) {
        bad(
          `${row.id}) 展开时那次后台判协议没有打到构建期默认地址：${offTarget.url}（期望 ${BUILD_DEFAULT_ORIGIN}${MODELS_PATH}）`
        )
      } else {
        ok(
          `${row.id}) 展开时后台判协议 = GET ${BUILD_DEFAULT_ORIGIN}${MODELS_PATH} × ${ambient.length}（两种鉴权各一次，与点击无关）`
        )
      }
    } else {
      ok(`${row.id}) 展开时后台判协议 0 次（已存地址命中判定缓存）`)
    }
    for (const forbidKey of row.forbid ?? []) {
      const forbidden = render(forbidKey, {}).split('{')[0]
      if (forbidden !== '' && text.includes(forbidden)) {
        bad(`${row.id}) ${row.where} 串到了 ${forbidKey} 那一档`)
      }
    }
    // 展开 / 填写 / 探测都**不是**「切换生效来源」（#807）：只改草稿不许动 provider-kind
    const kind = await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))
    if (kind !== 'openai') {
      bad(`${row.id}) 探测把生效来源改掉了：chat-demo:provider-kind=${JSON.stringify(kind)}（展开 ≠ 生效）`)
    }
    // #997：行末不再拿固定睡眠收尾（旧 `row.settleMs`）—— 等「在飞为空 + 计数不再变化」，
    // 下一行的采样窗口才是干净的起点（`mode === 'timeout'` 那行以前靠 300 ms 猜，现在这条判据
    // 由页面 abort 后的 `requestfailed` 收口）。
    await waitProbesQuiet()
  }
} finally {
  await browser?.close().catch(() => {})
  served?.kill()
}

if (failures.length > 0) {
  console.error(`\nFAIL tests/integration/domain03-settings-probe-model.test.mjs`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
if (!browser) {
  console.error('SKIP(env) 无法启动浏览器')
  process.exit(SKIP_CODE)
}
console.log('\nPASS tests/integration/domain03-settings-probe-model.test.mjs')
