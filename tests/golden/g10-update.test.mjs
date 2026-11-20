// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 10「更新」（Issue #404）。**只跑 1 条主路径**：
//   检查 → 解析清单 → 选对版本 → 下载校验
//
// 为什么这条进第一批：更新链路坏掉的后果是「用户永远收不到新版本」—— 不报错、不白屏，
// 只是安静地什么都不发生，最典型的静默回归。清单解析/筛选/排序的**算法细节**在 L0 已用矩阵钉住，
// 清单失败的分类文案在 L1（domain10-update-check-flow），这里只走「有一条能装的版本 → 选它 → 下载地址对」。
//
// 两台分发机都要 route 住：只拦一台时首选机一旦真的可达，用例会连真服务器（离线环境下表现为超时）。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g10-update.test.mjs
import {
  CURRENT,
  CHANNEL_BUILD_TYPE,
  NEWEST_INSTALLABLE,
  nextPatch,
} from '../helpers/current-version.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

/** 与 src/services/updateManifest.ts 的 RELEASE_BASES 同源 */
const PRIMARY = 'http://62.106.70.167:8888'
const FALLBACK = 'https://dl.rose7.cn'
/**
 * 当前产物版本（build-info.json / __APP_VERSION__）与「更高版本」一律从 tests/helpers/current-version.mjs
 * 派生 —— 版本号只有一个来源（package.json），用例里不抄第二份。
 */
const NEW_VERSION = NEWEST_INSTALLABLE.version
const RELEASE_FILE = `apk/deepseek-chat-${NEW_VERSION}.apk`
const APK_BYTES = 5_452_595

const release = (over = {}) => ({
  version: NEW_VERSION,
  versionCode: NEWEST_INSTALLABLE.versionCode,
  size: APK_BYTES,
  file: RELEASE_FILE,
  changes: ['修复重试与离线提示'],
  buildType: CHANNEL_BUILD_TYPE,
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
  ...over,
})

/**
 * 清单：三条记录各司其职 ——
 *   1) 与当前版本相同（不该被当成更新）
 *   2) versionCode 更高但缺 sha256（不可安装，不该被选中）
 *   3) 唯一可安装的新版本（= 期望被选中的那条）
 */
const RELEASES = [
  release({ version: CURRENT.version, versionCode: CURRENT.versionCode }),
  release({
    version: nextPatch(CURRENT.version, 2),
    versionCode: CURRENT.versionCode + 2,
    sha256: undefined,
  }),
  release(),
]

/** 拦发布清单（跨域 GET 必须自己给 CORS 头，否则会变成 network 类失败） */
const routeManifest = async (context) => {
  await context.route(`${PRIMARY}/releases.json`, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ releases: RELEASES }),
    })
  )
  await context.route(`${FALLBACK}/releases.json`, (route) => route.fulfill({ status: 503, body: '' }))
  // APK 本体：给固定字节数，让「下载校验」能真的取到东西
  await context.route(`${PRIMARY}/${RELEASE_FILE}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.android.package-archive' },
      body: Buffer.alloc(APK_BYTES, 7),
    })
  )
}

/** 页面内取数：结论行 + 版本号 + 下载入口 */
const probe = () =>
  (() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
    const link = [...(dialog?.querySelectorAll('a') ?? [])].find((item) => (item.textContent ?? '').includes('下载 APK'))
    return {
      dialogOpen: dialog !== null,
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? '',
      title: dialog?.querySelector('h3')?.textContent?.trim() ?? '',
      linkText: (link?.textContent ?? '').trim(),
      linkHref: link?.getAttribute('href') ?? '',
    }
  })()

const result = await runGolden(
  { id: 'G10', domain: '更新', title: '检查 → 解析清单 → 选对版本 → 下载校验' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, context, close } = await openGoldenPage(app.url, {
      storage: { 'chat-demo:api-key': 'sk-golden-g10' },
    })
    try {
      await routeManifest(context)
      await waitForBoot(page)

      // ── 1. 打开「设置 → 检查更新」──────────────────────────────────────────────
      ctx.begin('打开检查更新')
      if ((await page.getByRole('dialog').count()) === 0) {
        await page
          .getByRole('button', { name: /设置|Settings/ })
          .last()
          .click()
      }
      const entry = page.getByRole('button', { name: '检查更新', exact: true })
      const entryReady = await waitFor(page, async () => (await entry.count()) > 0)
      if (!entryReady) {
        ctx.abort('设置里有「检查更新」入口', '按钮「检查更新」存在', `body=${brief(await bodyText(page))}`)
      }
      await entry.first().click()

      // ── 2. 解析清单：自动检查后给出「发现新版本」的结论 ────────────────────────
      ctx.begin('解析清单')
      const concluded = await waitFor(page, async () => (await page.evaluate(probe)).status.includes('发现新版本'))
      const seen = await page.evaluate(probe)
      if (!concluded) {
        ctx.abort('清单解析出结论', 'status 含「发现新版本」', `status=${brief(seen.status)}`)
      }

      // ── 3. 选对版本：可安装的最新版（versionCode 更高但缺 sha256 的那条不算） ────
      ctx.begin('选对版本')
      ctx.expect(`弹窗标题是 ${NEW_VERSION}`, seen.title === NEW_VERSION, {
        expected: NEW_VERSION,
        actual: brief(seen.title),
      })
      ctx.expect('清单里的更新说明被渲染出来', (await bodyText(page)).includes('修复重试与离线提示'), {
        expected: 'body 含「修复重试与离线提示」',
        actual: `body=${brief(await bodyText(page))}`,
      })

      // ── 4. 下载校验：下载入口指向该版本的文件，且真的能取到整包 ────────────────
      ctx.begin('下载校验')
      const expectedHref = `${PRIMARY}/${RELEASE_FILE}`
      ctx.expect('下载入口指向选中版本的文件', seen.linkHref === expectedHref, {
        expected: expectedHref,
        actual: brief(seen.linkHref || '（没有下载链接）'),
      })
      // 网页通道降级成链接：按用户点下去之后浏览器会做的事取一次，确认整包拿得到（不是 404 / 半截）。
      // 必须在页面里 fetch（分发机跨域，靠 route 给的 CORS 头），APIRequestContext 不走 context.route。
      const downloaded = await page.evaluate(
        async (href) => {
          const response = await fetch(href, { signal: AbortSignal.timeout(15000) })
          const bytes = await response.arrayBuffer()
          return { status: response.status, bytes: bytes.byteLength }
        },
        expectedHref
      )
      ctx.expect('下载地址返回完整包体', downloaded.status === 200 && downloaded.bytes === APK_BYTES, {
        expected: `HTTP 200 且 ${APK_BYTES} 字节`,
        actual: `HTTP ${downloaded.status} / ${downloaded.bytes} 字节`,
      })
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
