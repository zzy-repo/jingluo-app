// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 5「导入」（Issue #404）。**只跑 1 条主路径**：
//   链接导入：manifest → 下载 → 解析 → 入库
//
// 为什么这条进第一批：导入是「最容易静默坏掉」的一条 —— 解析、ZIP 校验、事务提交任何一步坏掉，
// 界面都可能停在「已开始导入…」或者干脆什么都不发生，而单测（L0）只要替换掉整个 importHistory
// 就看不见。黄金套件因此**一路跑到 IndexedDB 真的有会话**（不只断言文案）。
//
// 只打桩原生桥（CapacitorHttp.get），其余全是真代码：分块下载 → base64 解码 → ZIP 校验 →
// importHistory → staging → IndexedDB。链接导入只在原生壳里存在，所以必须给 `window.androidBridge`。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g05-import.test.mjs
import { buildArchiveZip } from '../fixtures/archive-fixture.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, sessionCount, waitFor, waitForBoot } from '../helpers/golden.mjs'

const ZIP_URL = 'https://obs.example.test/deepseek_data-golden.zip'
const TITLE_PREFIX = '黄金导入会话'

/**
 * 原生桥桩：让 Capacitor 认为自己在 APK 里，`CapacitorHttp.get` 返回预先构造好的 ZIP。
 * 走 `addInitScript` = 在应用脚本之前注入，不改源码、不改产物。
 */
const nativeDownloadStub = ({ base64, headers }) => {
  window.androidBridge = { postMessage: () => {} }
  const bytesOf = (value) => {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  window.__goldenDownloads = []
  window.Capacitor = {
    PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] }],
    nativePromise: (pluginName, methodName, options) => {
      window.__goldenDownloads.push({ pluginName, methodName, url: options?.url })
      const bytes = bytesOf(base64)
      return Promise.resolve({ status: 200, headers, url: options?.url ?? '', data: bytes.buffer })
    },
  }
}

const zip = buildArchiveZip({ sessionCount: 1, titlePrefix: TITLE_PREFIX })

const result = await runGolden(
  { id: 'G5', domain: '导入', title: '链接导入：manifest → 下载 → 解析 → 入库' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, close } = await openGoldenPage(app.url, {
      initScripts: [
        {
          fn: nativeDownloadStub,
          arg: {
            base64: Buffer.from(zip).toString('base64'),
            headers: { 'Content-Length': String(zip.byteLength), 'Content-Type': 'application/zip' },
          },
        },
      ],
      storage: { 'chat-demo:api-key': 'sk-golden-g05' },
    })
    try {
      await waitForBoot(page)

      // ── 1. 打开「设置 → 数据管理」：原生壳里才有链接导入入口 ────────────────────
      ctx.begin('打开导入入口')
      if ((await page.getByRole('dialog').count()) === 0) {
        await page
          .getByRole('button', { name: /设置|Settings/ })
          .last()
          .click()
      }
      await page
        .getByRole('tab', { name: /数据管理|Data/ })
        .first()
        .click()
      const linkInput = page.getByLabel('从链接导入')
      const entryReady = await waitFor(page, async () => (await linkInput.count()) > 0)
      if (!entryReady) {
        ctx.abort('数据管理里有「从链接导入」输入框', '输入框存在', `body=${brief(await bodyText(page))}`)
      }
      const before = await sessionCount(page)

      // ── 2. 提交链接并确认：manifest → 下载 → 解析 → 入库 一次走完 ───────────────
      ctx.begin('提交链接并导入')
      await linkInput.fill(ZIP_URL)
      await page.getByRole('button', { name: '导入', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
      const confirmReady = await waitFor(page, async () => (await confirm.count()) > 0)
      if (!confirmReady) {
        ctx.abort('弹出「确认导入历史对话」', '确认弹窗出现', `body=${brief(await bodyText(page))}`)
      }
      await confirm.getByRole('button', { name: '确认导入', exact: true }).click()

      // ── 3. 下载：真的走原生桥，且打的是用户填的那条链接 ────────────────────────
      ctx.begin('下载')
      const downloaded = await waitFor(
        page,
        async () => (await page.evaluate(() => window.__goldenDownloads.length)) > 0
      )
      const downloads = await page.evaluate(() => window.__goldenDownloads)
      ctx.expect('原生桥被用上（CapacitorHttp.get 发起了下载）', downloaded, {
        expected: 'CapacitorHttp.get ≥1 次',
        actual: `${downloads.length} 次`,
      })
      ctx.expect('下载的是用户填的那条链接', downloads[0]?.url === ZIP_URL, {
        expected: ZIP_URL,
        actual: String(downloads[0]?.url),
      })

      // ── 4. 解析 + 入库：完成文案 + IndexedDB 真的有会话 ─────────────────────────
      ctx.begin('解析并入库')
      const imported = await waitFor(page, async () => (await bodyText(page)).includes('已导入 1 个会话'))
      ctx.expect('给出完成信号「已导入 1 个会话」', imported, {
        expected: 'body 含「已导入 1 个会话」',
        actual: `body=${brief(await bodyText(page))}`,
      })
      const after = await sessionCount(page)
      if (after !== before + 1) {
        // 库没写进去时后面的「侧栏看得见」必然连带失败，只留这条真正的原因
        ctx.abort('会话真的写进 IndexedDB', `sessions = ${before + 1}`, `sessions = ${after}`)
      }

      // ── 5. 界面上看得见：关掉设置后侧栏出现导入的会话 ──────────────────────────
      ctx.begin('侧栏出现导入的会话')
      const dialog = page.getByRole('dialog').first()
      if ((await dialog.count()) > 0) {
        await dialog
          .getByRole('button', { name: /^关闭$|^Close$/ })
          .first()
          .click()
          .catch(() => {})
      }
      const listed = await waitFor(page, async () => (await bodyText(page)).includes(TITLE_PREFIX))
      ctx.expect('侧栏列出刚导入的会话', listed, {
        expected: `body 含「${TITLE_PREFIX}」`,
        actual: `body=${brief(await bodyText(page))}`,
      })
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
