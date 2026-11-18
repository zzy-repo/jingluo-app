// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 2~4 分钟] 说明见 tests/README.md
// issue #2：长文本复制超限（>512 KiB UTF-8）的回归验收。
//
//   cd /root/deepseek-app && node tests/integration/copy-limit.test.mjs
//
// 会话数据由 fixture 直接写入 IndexedDB（chat-demo）后**新建 page** 打开应用，
// 让 store 在首次 hydration 时就从库里读到会话 —— 不在同一页里 reload 复用已初始化的 store。
//
// 断言：
//   [1] 超限（中文 200000 字 = 600000 字节）：点复制不写剪贴板，弹出「保存为 TXT」弹窗，
//       文案给出实际大小与 512 KiB 上限；点取消后弹窗关闭、无下载发生
//   [2] 超限判定按 UTF-8 字节：140000 个 emoji（仅 140000 字符、560000 字节）同样弹窗
//   [3] 边界：正好 512 KiB（524288 字节）仍走复制，剪贴板被写入一次且不弹窗
//   [4] 保存成功：点「保存为 TXT」触发 .txt 下载，弹窗关闭
//   [5] 保存失败：保存抛错时提示「保存失败」，弹窗保持打开，剪贴板依然未被写入
//   [6] 全程 console error = 0
//
// 未测项目（本脚本不覆盖，需要真机）：
//   · Android Binder 侧剪贴板写入结果（ClipboardManager.setPrimaryClip 返回值 / OEM 截断行为）
//   · Android ExportText 原生桥在 SAF 面板上的取消与保存结果
//   上述两项必须在已预约设备上用 adb logcat 取证，不能以本脚本的浏览器结果替代。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
let APP_URL = process.env.APP_URL || ''
const LIMIT = 512 * 1024
/** 与 src/services/chat/db.ts 的 DB_VERSION 保持一致；fixture 建库结构必须与之一致。 */
const DB_VERSION = 12

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const note = (message) => console.log(`  ·   ${message}`)
const expect = (condition, message, detail) => {
  if (condition) {
    ok(detail === undefined ? message : `${message}（${detail}）`)
  } else {
    failures.push(detail === undefined ? message : `${message}（实际：${detail}）`)
    console.error(`  ✗  ${message}${detail === undefined ? '' : `（实际：${detail}）`}`)
  }
}

// ---------- 0) 被测产物 + 静态服务 ----------
// 默认用本用例自己的标准产物：`dist/` 里常是内测包（<768px 布局差异会干扰），别混用
let distDir = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-copy-limit')
if (!existsSync(path.join(distDir, 'index.html'))) {
  distDir = path.join(ROOT, 'dist-copy-limit')
  console.log('· 构建被测产物到 dist-copy-limit（DIST_OUT=dist-copy-limit）…')
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'rspack'),
    ['build', '-c', 'rspack.config.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', DIST_OUT: 'dist-copy-limit' },
      stdio: 'inherit',
    }
  )
}

// 端口自动分配（不再固定 5296：撞到别的进程会连到陌生产物 → 假红）
const served = await serveDir(distDir, { port: process.env.PORT, label: '被测产物' })
APP_URL = APP_URL || served.url
await verifyAppUrl(APP_URL, distDir, { variant: 'standard' })
const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(APP_URL, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        return
      }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`静态服务未就绪：${APP_URL}`)
}
await waitForServer()
note(`被测地址 ${APP_URL}（产物目录 ${path.relative(ROOT, distDir) || '.'}）`)

// ---------- 1) 会话 fixture：中文 / emoji / 精确边界 ----------
const TEXT_CN = '中'.repeat(200_000) // 600000 字节
const TEXT_EMOJI = '😀'.repeat(140_000) // 560000 字节
const TEXT_EXACT = 'a'.repeat(LIMIT) // 正好 524288 字节
const SESSIONS = [
  { id: 'copy-limit-cn', title: '长文本-中文', text: TEXT_CN },
  { id: 'copy-limit-emoji', title: '长文本-emoji', text: TEXT_EMOJI },
  { id: 'copy-limit-exact', title: '边界-512K', text: TEXT_EXACT },
]

const makeSession = ({ id, title, text }) => {
  const now = Date.now()
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      { id: `${id}-user`, role: 'user', content: '把这段内容复制给我', files: [], createdAt: now },
      {
        id: `${id}-reply`,
        role: 'assistant',
        createdAt: now + 1,
        model: null,
        prefix: false,
        status: 'done',
        blocks: [{ type: 'text', text }],
      },
    ],
  }
}

const seedSessions = (page, sessions) =>
  page.evaluate(
    async ({ sessions, version }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo', version)
        request.onupgradeneeded = () => {
          const opened = request.result
          for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
            if (!opened.objectStoreNames.contains(name)) {
              opened.createObjectStore(name, { keyPath: 'id' })
            }
          }
          const summaries = opened.objectStoreNames.contains('sessionSummaries')
            ? request.transaction.objectStore('sessionSummaries')
            : opened.createObjectStore('sessionSummaries', { keyPath: 'id' })
          if (!summaries.indexNames.contains('fileIds')) {
            summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
          }
          if (!opened.objectStoreNames.contains('appAssets')) {
            opened.createObjectStore('appAssets', { keyPath: 'key' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
        for (const session of sessions) {
          tx.objectStore('sessions').put(session)
          tx.objectStore('sessionSummaries').put({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            fileIds: [],
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      db.close()
    },
    { sessions, version: DB_VERSION }
  )

// ---------- 2) 浏览器 ----------
const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  // 桌面宽度：402px 移动视口下侧栏是抽屉，fixture 会话不可见（复制流程本身与宽度无关）
  viewport: { width: 1280, height: 900 },
  colorScheme: 'light',
  acceptDownloads: true,
})
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL })
// 剪贴板探针 + 可注入的保存失败开关；均在各 page 加载前安装。
await context.addInitScript(() => {
  window.__copied = []
  window.__failSave = false
  window.localStorage.setItem('chat-demo:provider-kind', 'deepseek')
  window.localStorage.setItem('chat-demo:api-key', 'sk-copy-limit-acceptance-key')
  try {
    const clipboard = navigator.clipboard
    const writeText = clipboard?.writeText?.bind(clipboard)
    if (writeText) {
      clipboard.writeText = async (value) => {
        window.__copied.push(String(value).length)
        return writeText(value)
      }
    }
  } catch {
    window.__clipboardSpy = false
  }
  const createObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob) => {
    if (window.__failSave) {
      throw new Error('save-unavailable (test injection)')
    }
    return createObjectURL(blob)
  }
})

const newPage = async () => {
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  return { page, errors }
}

/** 打开某个会话：先等首次 hydration 的侧栏，必要时点标题，再等回复里的复制按钮 */
const openSession = async (page, title) => {
  await page.getByText(title).first().waitFor({ timeout: 20_000 })
  const copyButton = page.getByRole('button', { name: '复制' }).last()
  try {
    await copyButton.waitFor({ timeout: 3000 })
  } catch {
    await page.getByText(title).first().click({ timeout: 120_000 })
    // 512 KiB 单段文本首次渲染慢且机器相关：本机实测 92~96s（作者环境约 20s），预算按实测留足
    await copyButton.waitFor({ timeout: 240_000 })
  }
  return copyButton
}

const dialog = (page) => page.getByRole('dialog')
const copiedCount = (page) => page.evaluate(() => window.__copied.length)
const copiedLengths = (page) => page.evaluate(() => window.__copied)

try {
  // 先播种，再每个场景新建 page，让 store 首次 hydration 读到 fixture
  const seeder = await context.newPage()
  await seeder.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await seedSessions(seeder, SESSIONS.map(makeSession))
  await seeder.close()
  note('已写入 3 个会话 fixture（chat-demo v12），后续每个场景都新建 page 打开')

  // [1] 超限（中文）：弹窗 + 不写剪贴板 + 取消
  {
    const { page, errors } = await newPage()
    const copyButton = await openSession(page, '长文本-中文')
    await copyButton.click()
    await dialog(page).waitFor({ timeout: 10_000 })
    const text = await dialog(page).innerText()
    expect(text.includes('586'), '[1a] 弹窗给出实际大小 586 KiB', text.replace(/\n/g, ' ').trim())
    expect(text.includes('512'), '[1b] 弹窗给出 512 KiB 上限')
    const copiedAfterClick = await copiedCount(page)
    expect(copiedAfterClick === 0, '[1c] 超限时不写剪贴板', `写入 ${copiedAfterClick} 次`)
    expect(
      await page.getByRole('button', { name: '保存为 TXT' }).isVisible(),
      true,
      '[1d] 弹窗里有可见的保存 TXT 入口'
    )
    let downloaded = false
    page.on('download', () => {
      downloaded = true
    })
    await dialog(page).getByRole('button', { name: '取消' }).click()
    await dialog(page).waitFor({ state: 'hidden', timeout: 10_000 })
    await page.waitForTimeout(500)
    expect(downloaded === false, '[1e] 取消保存后不产生下载', String(downloaded))
    const copiedAfterCancel = await copiedCount(page)
    expect(copiedAfterCancel === 0, '[1f] 取消后剪贴板依然未被写入', `写入 ${copiedAfterCancel} 次`)
    expect(errors.length === 0, '[1g] 无 console error', errors.join(' | '))
    await page.close()
  }

  // [2] 超限判定按字节：emoji 字符数不足阈值、字节数超限
  {
    const { page } = await newPage()
    const copyButton = await openSession(page, '长文本-emoji')
    await copyButton.click()
    await dialog(page).waitFor({ timeout: 10_000 })
    const copiedEmoji = await copiedCount(page)
    expect(copiedEmoji === 0, '[2a] emoji 文本超限不写剪贴板', `写入 ${copiedEmoji} 次`)
    const text = await dialog(page).innerText()
    expect(text.includes('547'), '[2b] 按 560000 字节算出 547 KiB', text.replace(/\n/g, ' ').trim())
    await dialog(page).getByRole('button', { name: '取消' }).click()
    await page.close()
  }

  // [3] 边界：正好 512 KiB 仍可复制
  {
    const { page, errors } = await newPage()
    const copyButton = await openSession(page, '边界-512K')
    await copyButton.click()
    await page.waitForTimeout(1500)
    const dialogCount = await dialog(page).count()
    expect(dialogCount === 0, '[3a] 正好 512 KiB 不弹超限弹窗', `弹窗 ${dialogCount} 个`)
    const lengths = await copiedLengths(page)
    expect(lengths.length === 1, '[3b] 剪贴板被写入一次', `写入 ${lengths.length} 次`)
    expect(lengths[0] === LIMIT, '[3c] 写入内容长度等于 512 KiB', String(lengths[0]))
    expect(errors.length === 0, '[3d] 无 console error', errors.join(' | '))
    await page.close()
  }

  // [4] 保存成功：下载 .txt
  {
    const { page } = await newPage()
    const copyButton = await openSession(page, '长文本-中文')
    await copyButton.click()
    await dialog(page).waitFor({ timeout: 10_000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByRole('button', { name: '保存为 TXT' }).click(),
    ])
    expect(
      download.suggestedFilename().endsWith('.txt'),
      true,
      '[4a] 下载文件名是 .txt',
      download.suggestedFilename()
    )
    await dialog(page).waitFor({ state: 'hidden', timeout: 10_000 })
    ok('[4b] 保存后弹窗关闭')
    await page.close()
  }

  // [5] 保存失败：提示错误、弹窗保留、剪贴板仍为空
  {
    const { page } = await newPage()
    const copyButton = await openSession(page, '长文本-中文')
    await copyButton.click()
    await dialog(page).waitFor({ timeout: 10_000 })
    await page.evaluate(() => {
      window.__failSave = true
    })
    await page.getByRole('button', { name: '保存为 TXT' }).click()
    const toast = page.getByRole('status')
    await toast.waitFor({ timeout: 10_000 })
    const toastText = await toast.innerText()
    expect(toastText.includes('保存失败'), '[5a] 保存失败有明确提示', toastText.trim())
    expect(await dialog(page).isVisible(), true, '[5b] 保存失败后弹窗保持打开')
    const copiedAfterFail = await copiedCount(page)
    expect(copiedAfterFail === 0, '[5c] 保存失败不写剪贴板', `写入 ${copiedAfterFail} 次`)
    await page.close()
  }
} catch (error) {
  // 单个场景超时不要以未捕获异常结束：后续场景可能还没跑，至少要留下可读的失败摘要。
  const reason = String(error instanceof Error ? error.message : error).split('\n')[0]
  failures.push(`用例中断：${reason}`)
  console.error(`  ✗  用例中断（后续场景未执行）：${reason}`)
} finally {
  await browser.close()
  served.kill()
}

console.log(`\n共 ${checks} 项断言`)
console.log(
  '未测项目（需真机，本脚本不覆盖）：Android Binder 剪贴板结果、ExportText SAF 取消/保存结果'
)
if (failures.length > 0) {
  console.error(`FAIL tests/integration/copy-limit.test.mjs（${failures.length} 条）`)
  process.exit(1)
}
console.log('PASS tests/integration/copy-limit.test.mjs')
