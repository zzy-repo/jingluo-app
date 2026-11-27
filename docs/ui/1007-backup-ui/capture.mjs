#!/usr/bin/env node
/**
 * #1007 的两条备份界面缺陷 —— 390 / 360 两档浏览器视口取证。
 *
 *   node scripts/build.mjs            # 先出产物（默认 dist/；本脚本读 DIST_OUT 或 dist）
 *   node docs/ui/1007-backup-ui/capture.mjs
 *
 * 为什么需要桩：`备份` 读的是**原生私有目录**（`isBackupStorageAvailable()` 在纯浏览器里恒为
 * false → 设置页只会显示「当前环境不支持备份到本机存储」）。所以这里在页面里装一套**内存文件
 * 系统 + BackupFile 桥**，让设置页跑真实的备份 / 恢复代码路径；截图拍到的是**真界面**，
 * 只是文件落在内存里。**这不是真机截图**，口径与 docs/ui/README.md 一致（浏览器视口截图）。
 *
 * 场景：
 *   A 盘上 7 份：占空间一格「共 7 份」，恢复列表默认 5 条 + 「还有 2 份」，点开后 7 条全在
 *   B 状态行：低空间备份失败 → 恢复成功之后，那句「存储空间不足」必须消失（不再与「已恢复完成」并存）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const DIST = process.env.DIST_OUT || path.join(ROOT, 'dist')
/** 出图子目录（空 = 修复后的画面；`before` = 修复前基线的对照画面） */
const SHOT_SUBDIR = process.env.SHOT_SUBDIR ?? ''
/** 修复前的产物没有「还有 N 份」入口：允许它缺席，但修复后的构建里必须存在 */
const EXPECT_FIX = process.env.SHOT_EXPECT_FIX !== '0'

const helper = (relativePath) => pathToFileURL(path.join(ROOT, relativePath)).href
const { serveDir } = await import(helper('tests/helpers/env.mjs'))
const { DB_NAME, ensureChatDb, writeSessions } = await import(helper('tests/helpers/chat-db.mjs'))

/** 两个验收宽度（与 scripts/shot-mobile.mjs 同档） */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]

/**
 * 页面里装的备份桥桩：内存文件系统 + 可拨的剩余空间。
 *
 * 语义照抄 `BackupFilePlugin`：`begin` → `writeChunk`* → `finish`（对盘上字节重算 sha256）→ 提交；
 * `abort` 丢弃临时文件。`freeBytes` 是「设备剩余空间」，用来制造 `space` 失败。
 */
const installBackupStub = (preset) => {
  const files = new Map()
  const state = { freeBytes: preset.freeBytes, pending: null }
  const enc = (text) => new TextEncoder().encode(text)
  const toB64 = (bytes) => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  const fromB64 = (data) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
  const sha256 = async (bytes) => {
    const hashed = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  for (const file of preset.files) {
    const bytes = file.text === undefined ? new Uint8Array(file.size ?? 0) : enc(file.text)
    files.set(file.name, { bytes, mtimeMs: Date.parse(file.mtimeMs ?? '2026-11-27T06:00:00.000Z') })
  }

  const notFound = () => Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
  const api = {
    async begin({ name }) {
      state.pending = { name, parts: [] }
      return { name }
    },
    async writeChunk({ data }) {
      state.pending.parts.push(fromB64(data))
    },
    async finish({ name }) {
      const total = state.pending.parts.reduce((sum, part) => sum + part.length, 0)
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const part of state.pending.parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      state.pending = null
      files.set(name, { bytes, mtimeMs: Date.now() })
      return { name, sizeBytes: bytes.length, sha256: await sha256(bytes) }
    },
    async abort() {
      state.pending = null
    },
    async list() {
      return {
        files: [...files.entries()]
          .filter(([name]) => !name.endsWith('.part'))
          .map(([name, file]) => ({ name, sizeBytes: file.bytes.length, mtimeMs: file.mtimeMs })),
      }
    },
    async readChunk({ name, offset, length }) {
      const file = files.get(name)
      if (!file) throw notFound()
      const slice = file.bytes.slice(offset, offset + length)
      return { data: toB64(slice), eof: offset + slice.length >= file.bytes.length }
    },
    async hash({ name }) {
      const file = files.get(name)
      if (!file) throw notFound()
      return { sha256: await sha256(file.bytes), sizeBytes: file.bytes.length }
    },
    async remove({ name }) {
      files.delete(name)
    },
    async freeBytes() {
      return { bytes: state.freeBytes }
    },
  }

  window.__backupStub = {
    setFreeBytes: (bytes) => {
      state.freeBytes = bytes
    },
    names: () => [...files.keys()],
    dump: () => [...files.entries()].map(([name, file]) => ({ name, sizeBytes: file.bytes.length })),
  }

  // `@capacitor/core` 在模块装载时 `win.Capacitor = createCapacitor(win)`；拦截这次赋值，
  // 让它拿到我们预置的 `PluginHeaders`（走 nativePromise 分支），再把 `isNativePlatform`
  // 掰成 true —— 备份能力探测只认这一个函数，平台名仍留 'web'（别的原生通路不受影响）。
  let capacitor = {
    PluginHeaders: [
      {
        name: 'BackupFile',
        methods: ['begin', 'writeChunk', 'finish', 'abort', 'list', 'readChunk', 'hash', 'remove', 'freeBytes'].map(
          (name) => ({ name, rtype: 'promise' })
        ),
      },
    ],
    nativePromise: (plugin, method, options) => window.__backupStub.api[method](options),
  }
  window.__backupStub.api = api
  Object.defineProperty(window, 'Capacitor', {
    configurable: true,
    get: () => capacitor,
    set: (value) => {
      value.isNativePlatform = () => true
      capacitor = value
    },
  })
}

/** 盘上 7 份：清单要能被 `parseManifest` 认（版本、id 前缀、摘要、大小一致） */
const sevenBackups = () => {
  const files = []
  for (let index = 1; index <= 7; index += 1) {
    const id = `b-20261127T06${String(index).padStart(2, '0')}00${String(index).padStart(3, '0')}Z`
    const sizeBytes = 8 * 1024 * 1024
    const createdAtUtc = new Date(Date.UTC(2026, 10, 27, 6, index, 0, index)).toISOString()
    files.push(
      { name: `${id}.zip`, size: sizeBytes, mtimeMs: createdAtUtc },
      {
        name: `${id}.manifest.json`,
        text: JSON.stringify({
          backup_format_version: 1,
          id,
          created_at_utc: createdAtUtc,
          archive: { name: `${id}.zip`, size_bytes: sizeBytes, sha256: '0'.repeat(64) },
          attachments: null,
          data_summary: { sessions: 6 + index, attachments: 0 },
          verified: true,
          origin: 'manual',
        }),
        mtimeMs: createdAtUtc,
      }
    )
  }
  files.push({
    name: 'status.json',
    text: JSON.stringify({
      last_success_at_utc: '2026-11-27T06:07:00.007Z',
      last_restore_at_utc: null,
      last_error: null,
    }),
    mtimeMs: '2026-11-27T06:07:00.007Z',
  })
  return files
}

/** 窄屏入口的 aria-label / 文案（`expandSiderbarButton` = 「打开边栏」） */
const SETTINGS_LABEL = { drawer: '打开边栏', settings: '设置', data: '数据管理' }

const seedChats = async (page) => {
  await ensureChatDb(page)
  const now = Date.now()
  await page.evaluate(writeSessions, {
    name: DB_NAME,
    items: [
      {
        id: 's-1007-a',
        title: '备份界面取证',
        createdAt: now - 60_000,
        updatedAt: now - 50_000,
        messages: [
          { id: 's-1007-a-u1', role: 'user', content: '先备份一次', files: [], createdAt: now - 60_000 },
          { id: 's-1007-a-a1', role: 'assistant', content: '好的。', createdAt: now - 59_000 },
        ],
      },
    ],
  })
}

/** 设置 → 数据管理（窄屏要先把侧栏抽屉点开） */
const openDataSettings = async (page) => {
  const menu = page.getByRole('button', { name: SETTINGS_LABEL.drawer })
  if (await menu.count()) {
    await menu.first().click()
    await page.waitForTimeout(400)
  }
  await page.getByRole('button', { name: SETTINGS_LABEL.settings }).first().click()
  await page.getByText(SETTINGS_LABEL.data, { exact: true }).first().click()
  await page.getByTestId('backup-status').waitFor({ state: 'visible' })
}

/** 等弹层把入场动画播完（否则截到的是「半透明叠影」，两张图会糊在一起） */
const settle = async (page) => {
  await page.waitForTimeout(700)
  await page.waitForFunction(() => {
    const modal = document.querySelector('[data-testid="backup-restore-pick"]')
    if (!modal) return true
    const layer = modal.closest('[class*="mask"], [class*="overlay"], [class*="modal"]') ?? modal
    return Number(getComputedStyle(layer).opacity || '1') >= 0.99
  })
  await page.waitForTimeout(200)
}

const shot = async (page, outDir, name) => {
  await settle(page)
  const file = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  const metrics = await page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    statusLine: document.querySelector('[data-testid="backup-status"]')?.innerText ?? '',
    spaceLine: document.querySelector('[data-testid="backup-space"]')?.innerText ?? '',
    restoreItems: document.querySelectorAll('[data-testid="backup-restore-item"]').length,
    hasMore: document.querySelector('[data-testid="backup-restore-more"]')?.textContent ?? null,
  }))
  await writeFile(path.join(outDir, `${name}.json`), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')
  console.log(`  ✓ ${path.relative(ROOT, file)}  ${JSON.stringify(metrics)}`)
}

const openRestorePicker = async (page) => {
  await page.getByTestId('backup-restore-button').click()
  await page.getByTestId('backup-restore-pick').waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="backup-restore-item"]').length > 0
  )
}

const closeModal = async (page) => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}

/** A：盘上 7 份 —— 列表与「共 7 份」不再矛盾 */
const scenarioSeven = async ({ context, outDir }) => {
  const page = await context.newPage()
  await page.goto(new URL('/', context.__appUrl).href, { waitUntil: 'domcontentloaded' })
  await seedChats(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openDataSettings(page)
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="backup-space"]')?.innerText ?? '').includes('共 7 份')
  )
  await shot(page, outDir, 'a1-seven-on-disk')

  await openRestorePicker(page)
  await shot(page, outDir, 'a2-list-default-5')

  const more = page.getByTestId('backup-restore-more')
  const expandable = (await more.count()) > 0
  if (expandable) {
    await more.click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="backup-restore-item"]').length === 7
    )
    await shot(page, outDir, 'a3-list-expanded-7')
  } else {
    // 修复前的产物：没有入口，多出来的那 2 份在界面上彻底不可达（这就是缺陷本身）
    console.log('    x 没有「还有 N 份」入口（修复前基线）')
    await shot(page, outDir, 'a3-no-entry')
  }
  if (EXPECT_FIX && !expandable) {
    throw new Error('a3 期望有「还有 N 份」入口：产物不是本次修复后的构建')
  }
  await closeModal(page)
  await page.close()
}

/** B：低空间备份失败 → 恢复成功 —— 旧失败提示不许与成功提示并存 */
const scenarioStaleFailure = async ({ context, outDir }) => {
  const page = await context.newPage()
  await page.goto(new URL('/', context.__appUrl).href, { waitUntil: 'domcontentloaded' })
  await seedChats(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openDataSettings(page)

  // ① 先真的备份一次（空间够），拿到一份可恢复的档案
  await page.getByTestId('backup-now-button').click()
  await page.waitForSelector('[data-testid="backup-notice"]', { timeout: 60_000 })
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="backup-notice"]')?.innerText ?? '').includes('备份完成')
  )

  // ② 把剩余空间拨到很低，再点「立即备份」→ 失败，「存储空间不足，暂时无法备份」。
  //    注意**不刷新页面**：按钮此刻还是可点的（上一次读到的空间够），失败发生在核心侧的写前判据，
  //    与设备现场一致（用户点的时候没觉得不够，写的时候盘已经没了）
  const stubFiles = await page.evaluate(() => window.__backupStub.dump())
  console.log(`    盘上文件：${JSON.stringify(stubFiles)}`)
  await page.evaluate(() => window.__backupStub.setFreeBytes(200 * 1024))
  await page.getByTestId('backup-now-button').click()
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="backup-status"]')?.innerText ?? '').includes('存储空间不足'),
    { timeout: 60_000 }
  )
  await shot(page, outDir, 'b1-space-failure')

  // ③ 空间恢复后做一次成功恢复：旧失败提示必须消失
  await page.evaluate(() => window.__backupStub.setFreeBytes(5 * 1024 * 1024 * 1024))
  await openRestorePicker(page)
  await page.getByTestId('backup-restore-select').first().click()
  await page.getByTestId('backup-restore-confirm').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '确认恢复' }).click()
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="backup-notice"]')?.innerText ?? '').includes('已恢复完成'),
    { timeout: 120_000 }
  )
  await page.waitForTimeout(500)
  await shot(page, outDir, 'b2-after-restore-no-stale')

  const leftover = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="backup-status"]')?.innerText ?? ''
    const notice = document.querySelector('[data-testid="backup-notice"]')?.innerText ?? ''
    return { status, notice, stale: status.includes('存储空间不足') }
  })
  await writeFile(path.join(outDir, 'b2-after-restore-no-stale.verdict.json'), `${JSON.stringify(leftover, null, 2)}\n`, 'utf8')
  console.log(`    恢复后状态行：${JSON.stringify(leftover)}`)
  await page.close()
}

const main = async () => {
  const server = await serveDir(DIST, { label: '被测产物' })
  const browser = await chromium.launch()
  try {
    for (const viewport of VIEWPORTS) {
      const outDir = path.join(HERE, SHOT_SUBDIR, String(viewport.width))
      await mkdir(outDir, { recursive: true })
      for (const scenario of [
        { name: 'A 盘上 7 份', preset: { files: sevenBackups(), freeBytes: 5 * 1024 * 1024 * 1024 }, run: scenarioSeven },
        { name: 'B 旧失败提示', preset: { files: [], freeBytes: 5 * 1024 * 1024 * 1024 }, run: scenarioStaleFailure },
      ]) {
        console.log(`▶ ${viewport.width}px · ${scenario.name}`)
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          locale: 'zh-CN',
        })
        context.__appUrl = server.url
        await context.addInitScript(installBackupStub, scenario.preset)
        // 出站总闸：只放行被测产物自己的 origin
        const origin = new URL(server.url).origin
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
        )
        try {
          await scenario.run({ context, outDir })
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

await main()
