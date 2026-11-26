#!/usr/bin/env node
/**
 * #899（母单 #894）的浏览器取证：**失败后那次「只判路」探测**让诊断能说出 dns / tls。
 *
 *   pnpm build && node scripts/shot-net-probe-899.mjs
 *
 * 产出 4 张（`tls` / `dns` 两个故障 × 390 / 360）：
 *   docs/ui/net-probe-tls-390.png / net-probe-tls-360.png
 *   docs/ui/net-probe-dns-390.png / net-probe-dns-360.png
 *
 * 每张图上展开的是**应用自己的「复制诊断信息」按钮写进剪贴板的原文**（界面上这段文本
 * 只在剪贴板，没有内联展示）—— 截的是「用户真按下去会拿到什么」，不是我们手拼的字符串。
 *
 * ## 两个注入（这是本脚本最需要说清的地方，别把它当「真机通过」）
 *
 * 1. **故障**：`page.route(host === mock 上游) → route.abort(...)`。这条是真的：请求确实失败，
 *    应用确实只拿到 `TypeError: Failed to fetch` —— 与线上弱网 / 证书错误的表现一致。
 * 2. **探测的分段证据**：`performance.getEntriesByName` 被替身**只对探测 URL** 返回一条
 *    合成的 `PerformanceResourceTiming`。为什么必须替身：#899 实测（Chromium 1248 与 Firefox
 *    1572，真 DNS 失败 / 真 connection refused / 真自签证书握手失败三种各跑一遍）
 *    **失败请求的分段全是 0**，浏览器不给页面 JS。所以真机上这条证据今天拿不到，
 *    能拿到的是「原生桥 / 未来 API」。本脚本证明的是**拿到之后整条链路的判定与文案是对的**，
 *    不是「web 上现在就能判出来」。剩下的判不出边界写在 `docs/ui/README.md` 与 #899 的回报里。
 *
 * 断言（任一不满足 → 该组合判红，脚本 exit 1）：
 *   · 剪贴板原文里出现 `失败分段: tls（依据 probe` / `失败分段: dns（依据 probe`；
 *   · 同一份文本里出现 `探测: 失败，但分段证据显示`（证明是探测结论，不是原始异常原文）；
 *   · `pageerror` 0 条。
 *
 * 落盘快照（IndexedDB）**不作为断言**：它是失败当刻写的，而探测结论晚到 —— 脚本只把它记下来，
 * 用来证明「刷新之后诊断会回到判不出」这条边界（不补造、也不假装它在盘上）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = '/root/deepseek-app'
const { serveGoldenApp, openGoldenPage, waitForBoot, waitFor } =
  await import(`${REPO}/tests/helpers/golden.mjs`)
const { startMockUpstream, configureAnthropicChannel } =
  await import(`${REPO}/tests/fixtures/domain01-02/mock-upstream.mjs`)
const { sendChat } = await import(`${REPO}/tests/helpers/helpers.mjs`)

const OUT_DIR = path.join(REPO, 'docs/ui')
const KEY = 'sk-net-probe-899'
const VIEWPORTS = [
  { tag: '390', width: 390, height: 844 },
  { tag: '360', width: 360, height: 740 },
]
const WAIT_MS = 60_000

/** 捕获 writeText 的入参（不改变应用行为：仍然照原样写剪贴板） */
const captureClipboard = () => {
  window.__copiedText = null
  try {
    const clipboard = navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      const original = clipboard.writeText.bind(clipboard)
      clipboard.writeText = (text) => {
        window.__copiedText = String(text)
        return original(text)
      }
    }
  } catch {
    /* 老 WebView 没有 clipboard：应用会走 execCommand 兜底，本脚本会记为「截不到」 */
  }
}

/**
 * 探测桩：**只对「探测 URL」**（`origin + '/'`）返回一条合成的 resource timing。
 *
 * 为什么打这个补丁而不是改产品代码：产品侧不许多一个测试接缝
 * （`check:test-seam` 的口径）；而探测读的就是 `performance.getEntriesByName`，
 * 在浏览器环境里替换**数据源**，产品代码路径一行不改 —— 这正是「注入探测桩」。
 */
const stubProbeTiming = ({ probeUrl, entry }) => {
  const read = performance.getEntriesByName.bind(performance)
  performance.getEntriesByName = (name, type) => {
    if (name === probeUrl) {
      return [
        {
          name: probeUrl,
          entryType: 'resource',
          transferSize: 0,
          ...entry,
        },
      ]
    }
    return read(name, type)
  }
}

/** 从 IndexedDB 读落盘的 error.net（落盘值 = 权威值） */
const persistedErrors = (page) =>
  page.evaluate(async () => {
    const open = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const db = await open()
    const sessions = await new Promise((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    const out = []
    for (const session of sessions) {
      for (const message of session.messages ?? []) {
        if (message.role === 'assistant' && message.error) {
          out.push({ kind: message.error.kind, net: message.error.net ?? null })
        }
      }
    }
    return out
  })

/** 把「点按钮后的真实文本」贴进页面（应用内该文本只在剪贴板，没有内联展示） */
const showPanel = async (page, { title, text }) => {
  await page.evaluate(
    ({ heading, body }) => {
      document.getElementById('net-probe-evidence')?.remove()
      const panel = document.createElement('div')
      panel.id = 'net-probe-evidence'
      panel.style.cssText = [
        'position:fixed',
        'left:0',
        'right:0',
        'bottom:0',
        'z-index:2147483647',
        'background:rgba(12,12,14,0.95)',
        'color:#f4f4f5',
        'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
        'padding:8px 10px',
        'white-space:pre-wrap',
        'border-top:2px solid #22c55e',
        'max-height:74vh',
        'overflow:auto',
      ].join(';')
      panel.textContent = `${heading}\n${body}`
      document.body.appendChild(panel)
    },
    { heading: title, body: text }
  )
}

/**
 * 两个场景。`abortReason` 只影响「原始失败长什么样」，探测结论来自 `entry`：
 *  · `dns`：解析开始、没结束（`domainLookupEnd = 0`）；
 *  · `tls`：解析完了、建连停在握手开始处（`connectEnd === secureConnectionStart`）。
 */
const SCENARIOS = [
  {
    key: 'tls',
    name: 'tls（探测显示：连上了、TLS 握手没过）',
    abortReason: 'failed',
    entry: {
      domainLookupStart: 2,
      domainLookupEnd: 9,
      connectStart: 9,
      connectEnd: 21,
      secureConnectionStart: 21,
      requestStart: 0,
      responseStart: 0,
    },
    expect: '失败分段: tls（依据 probe',
  },
  {
    key: 'dns',
    name: 'dns（探测显示：名字没解开）',
    abortReason: 'namenotresolved',
    entry: { domainLookupStart: 2, domainLookupEnd: 0, connectStart: 0, connectEnd: 0, requestStart: 0, responseStart: 0 },
    expect: '失败分段: dns（依据 probe',
  },
]

const rows = []
const app = await serveGoldenApp()
await mkdir(OUT_DIR, { recursive: true })
let failures = 0

try {
  for (const scenario of SCENARIOS) {
    for (const vp of VIEWPORTS) {
      const mock = await startMockUpstream()
      const mockHost = new URL(mock.url).host
      const probeUrl = `${new URL(mock.url).origin}/`
      const { page, close } = await openGoldenPage(app.url, {
        viewport: { width: vp.width, height: vp.height },
        initScripts: [
          captureClipboard,
          { fn: stubProbeTiming, arg: { probeUrl, entry: scenario.entry } },
        ],
        backends: { allowHosts: [mockHost] },
      })
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error && error.message)))
      const row = { scenario: scenario.key, viewport: `${vp.width}×${vp.height}`, ok: false }
      try {
        await configureAnthropicChannel(page, { url: mock.url, apiKey: KEY })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForBoot(page)
        await page.route(
          (url) => url.host === mockHost,
          (route) => route.abort(scenario.abortReason)
        )
        await sendChat(page, `#899 取证 ${scenario.key}`)
        const appeared = await waitFor(
          page,
          async () => (await page.getByRole('button', { name: '复制诊断信息' }).count()) > 0,
          WAIT_MS
        )
        if (!appeared) {
          throw new Error('等不到「复制诊断信息」按钮（最终错误条没出现）')
        }
        await page.getByRole('button', { name: '复制诊断信息' }).first().click()
        await page.waitForTimeout(300)
        let copied = await page.evaluate(() => window.__copiedText)
        if (!copied) {
          await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: app.url,
          })
          copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
        }
        row.diagnostics = copied ?? '（截不到）'
        /**
         * 落盘快照（IndexedDB）**故意不是断言对象**：它是失败当刻写下的，
         * 而探测结论 ≤2s 才落定（`services/net/phaseProbe.ts`）。所以这里只把它记下来，
         * 用来证明「刷新之后诊断会回到判不出」这条边界 —— 不补造，也不假装它在盘上。
         */
        const persisted = await persistedErrors(page)
        const last = persisted[persisted.length - 1] ?? null
        row.persistedNet = last?.net ?? null
        row.persistedPhase = row.persistedNet?.phase ?? null
        row.persistedProbe = row.persistedNet?.probe?.outcome ?? null
        row.livePhase = scenario.key

        const problems = []
        if (!row.diagnostics.includes(scenario.expect)) {
          problems.push(`诊断里没有「${scenario.expect}」`)
        }
        if (!row.diagnostics.includes('探测: 失败，但分段证据显示')) {
          problems.push('诊断里没有「探测: 失败，但分段证据显示」')
        }
        // 判出某一段之后，「判不出（依据 none）」这句就不许再出现（两件事不许混着写）
        if (/失败分段: 判不出/u.test(row.diagnostics)) {
          problems.push('诊断里同时出现了「失败分段: 判不出」')
        }
        if (pageErrors.length > 0) {
          problems.push(`pageerror ${pageErrors.length} 条`)
        }
        row.phaseLine = row.diagnostics
          .split('\n')
          .filter((line) => line.startsWith('失败分段'))
          .join(' | ')
        row.problems = problems
        row.ok = problems.length === 0

        await showPanel(page, {
          title:
            `#899 取证 · ${scenario.name} · ${vp.width}×${vp.height}\n` +
            `下面这段是应用「复制诊断信息」写进剪贴板的原文（界面不内联展示，此处原样展开）：`,
          text: row.diagnostics,
        })
        const file = path.join(OUT_DIR, `net-probe-${scenario.key}-${vp.tag}.png`)
        await page.screenshot({ path: file })
        row.shot = path.relative(REPO, file)
      } catch (error) {
        row.failure = String(error && error.message ? error.message : error)
        row.ok = false
      } finally {
        if (!row.ok) {
          failures += 1
        }
        rows.push(row)
        await close().catch(() => {})
        await mock.close().catch(() => {})
      }
      console.log(
        `[${row.ok ? 'SHOT' : 'FAIL'}] ${row.scenario}@${row.viewport} ` +
          `诊断=${row.phaseLine ?? '（无）'} 落盘快照=${row.persistedPhase ?? '判不出'}` +
          (row.problems?.length ? ` problems=${row.problems.join(' / ')}` : '') +
          (row.failure ? ` failure=${row.failure}` : '')
      )
    }
  }
} finally {
  await app.close().catch(() => {})
  await writeFile('/tmp/net-probe-899-rows.json', JSON.stringify(rows, null, 2), 'utf8')
  console.log('\n=== 汇总 ===')
  for (const row of rows) {
    console.log(
      `${row.scenario.padEnd(4)} ${row.viewport.padEnd(9)} ${row.ok ? '绿' : '红'} ` +
        `诊断=${row.phaseLine ?? '（无）'} 落盘快照=${row.persistedPhase ?? '判不出'}`
    )
  }
}
process.exit(failures === 0 ? 0 : 1)
