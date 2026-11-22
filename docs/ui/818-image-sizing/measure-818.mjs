/**
 * #818 的一次性量尺（关单取证脚本，随证据一起留档；不是 CI 用例）。
 *
 * 390×844 / 360×740 两档视口，量三处：① 草稿缩略图 ② 消息气泡里的图片 ③ 点开大图。
 * 被测图现场生成：竖 3000×4000、横 4000×3000 的真 PNG（长边 ≥ 4000px）。
 * 除了尺寸，还实测「#209 能力靠探测」的那几项：相邻两图的**像素间距**（getBoundingClientRect 之差）、
 * `getComputedStyle(img).objectFit` 读回值、预览层的 `data-object-fit` 探测结果。
 *
 * 跑法（需要 playwright 与一个装着本分支 src 的开发服务器）：
 *   node docs/ui/818-image-sizing/measure-818.mjs --label=after --base=http://127.0.0.1:8105
 * 结果写到 `result-<label>.json` 与 `shots/`。产物已随 #818 留档在
 * `docs/ui/818-image-sizing/`（metrics.json + 12 张截图 + README）。
 *
 * 注：脚本用的固定端口 8105 只在手动跑时用，`check:hardcoded-ports` 不扫 docs/。
 */
/**
 * #818 定位/验收量尺：390×844 与 360×740 两档视口，量三处「图片实际渲染尺寸」。
 *
 *   ① 输入框草稿缩略图（ChatInput.module.css 的 .attachment，固定 64px）
 *   ② 发送后消息气泡里的图片（MessageFile.module.css 的 .image，var(--message-file-image-size, 120px)）
 *      三种组合：单图 / 4 张多图 / 图 + 文档混合（后者走 .filesWithDocuments 的 64px 档）
 *   ③ 点击图片后（MessageFile.tsx 正常态 <a href target="_blank">）：有没有应用内预览层，
 *      新开页面里原图是不是未缩放
 *
 * 被测图：长边 4000px 的真 PNG（竖 3000×4000 / 横 4000×3000），png.mjs 现场生成。
 * 用法：node docs/ui/818-image-sizing/measure-818.mjs --label=before|after [--base=http://127.0.0.1:8105]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { makePng } from './png-818.mjs'

const args = new Map()
for (const arg of process.argv.slice(2)) {
  const [key, raw] = arg.replace(/^--/u, '').split('=')
  args.set(key, raw ?? '')
}
const LABEL = args.get('label') ?? 'run'
const BASE = args.get('base') ?? 'http://127.0.0.1:8105'
const HERE = path.dirname(new URL(import.meta.url).pathname)

const VIEWPORTS = [
  { key: '390', width: 390, height: 844 },
  { key: '360', width: 360, height: 740 },
]

const PORTRAIT = { name: 'tall-3000x4000.png', mimeType: 'image/png', buffer: makePng(3000, 4000) }
const LANDSCAPE = { name: 'wide-4000x3000.png', mimeType: 'image/png', buffer: makePng(4000, 3000) }

const SESSIONS = [
  { id: 'seed-single', title: '818-单图', images: 1, documents: 0 },
  { id: 'seed-multi', title: '818-四图', images: 4, documents: 0 },
  { id: 'seed-mixed', title: '818-图文混合', images: 2, documents: 1 },
]

/** 在页面里建库 + 写入三条用户消息（图片原件写进 files 表，MessageFile 从 IndexedDB 读） */
const seedInPage = async ({ sessions, payload }) => {
  const DB = 'chat-demo'
  const VERSION = 14
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION)
    request.onupgradeneeded = () => {
      const opened = request.result
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging', 'appAssets']) {
        if (!opened.objectStoreNames.contains(name)) {
          opened.createObjectStore(name, { keyPath: name === 'appAssets' ? 'key' : 'id' })
        }
      }
      if (!opened.objectStoreNames.contains('sessionSummaries')) {
        const store = opened.createObjectStore('sessionSummaries', { keyPath: 'id' })
        store.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const decode = (b64) => {
    const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
    return new Blob([bytes], { type: 'image/png' })
  }
  const now = Date.now()
  const plan = sessions.map((spec, index) => {
    const files = []
    const stored = []
    for (let n = 0; n < spec.images; n += 1) {
      const source = payload[n % payload.length]
      const id = `${spec.id}-img-${n}`
      files.push({
        id,
        serverId: null,
        name: source.name,
        size: source.size,
        isImage: true,
        mimeType: 'image/png',
      })
      stored.push({ id, b64: source.b64 })
    }
    for (let n = 0; n < spec.documents; n += 1) {
      files.push({
        id: `${spec.id}-doc-${n}`,
        serverId: 'file-818-doc',
        name: '说明.txt',
        size: 2048,
        isImage: false,
        mimeType: 'text/plain',
      })
    }
    const session = {
      id: spec.id,
      title: spec.title,
      createdAt: now + index,
      updatedAt: now + index,
      messages: [
        {
          id: `${spec.id}-u1`,
          role: 'user',
          content: `${spec.title}：长边 4000px 的大图`,
          files,
          createdAt: now + index,
        },
      ],
    }
    return { session, stored, fileIds: files.map((file) => file.id) }
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
    for (const item of plan) {
      tx.objectStore('sessions').put(item.session)
      tx.objectStore('sessionSummaries').put({
        id: item.session.id,
        title: item.session.title,
        createdAt: item.session.createdAt,
        updatedAt: item.session.updatedAt,
        fileIds: item.fileIds,
      })
      for (const file of item.stored) {
        tx.objectStore('files').put({ id: file.id, blob: decode(file.b64) })
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  return plan.map((item) => ({ id: item.session.id, files: item.session.messages[0].files.length }))
}

/** 页面内量尺：目标 <img> 的渲染宽高 + 最近的可滚动祖先是否溢出 */
const measureInPage = ({ alts }) => {
  const vw = window.innerWidth
  const round = (value) => Math.round(value * 100) / 100
  const rect = (node) => {
    const box = node.getBoundingClientRect()
    return { width: round(box.width), height: round(box.height) }
  }
  const overflowOf = (node) => {
    let host = node.parentElement
    while (host && host !== document.documentElement) {
      if (host.scrollWidth > host.clientWidth + 0.5) {
        return {
          className: String(host.className).slice(0, 60),
          scrollWidth: host.scrollWidth,
          clientWidth: host.clientWidth,
          overflowX: getComputedStyle(host).overflowX,
          by: host.scrollWidth - host.clientWidth,
        }
      }
      host = host.parentElement
    }
    return null
  }
  const report = {
    screen: { width: vw, height: window.innerHeight },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5,
    },
    images: [],
  }
  for (const alt of alts) {
    const img = Array.from(document.querySelectorAll('img')).find((node) => node.alt === alt)
    if (!img) {
      report.images.push({ alt, found: false })
      continue
    }
    const shell = img.parentElement
    const row = shell?.parentElement ?? null
    const entry = {
      alt,
      found: true,
      img: rect(img),
      imgNatural: { width: img.naturalWidth, height: img.naturalHeight },
      shell: shell ? { tag: shell.tagName.toLowerCase(), className: String(shell.className).slice(0, 60), ...rect(shell) } : null,
      row: row ? { className: String(row.className).slice(0, 60), ...rect(row) } : null,
      shellWidthRatio: shell ? Math.round((shell.getBoundingClientRect().width / vw) * 1000) / 1000 : null,
      overflow: overflowOf(img),
      href: shell?.getAttribute('href') ?? null,
      target: shell?.getAttribute('target') ?? null,
      testid: shell?.getAttribute('data-testid') ?? null,
    }
    if (entry.shell) entry.shellOverflow = shell.scrollWidth > shell.clientWidth + 0.5
    report.images.push(entry)
  }
  // 多图 flex-wrap：按 shell 的顶部偏移分行，量「每行几张」
  const shells = Array.from(document.querySelectorAll('img'))
    .filter((node) => node.alt.includes('4000'))
    .map((node) => node.parentElement?.getBoundingClientRect())
    .filter(Boolean)
  if (shells.length > 0) {
    const sorted = [...shells].sort((a, b) => a.top - b.top || a.left - b.left)
    const rowsByTop = new Map()
    for (const box of sorted) {
      const key = Math.round(box.top)
      const hit = [...rowsByTop.keys()].find((top) => Math.abs(top - key) < 4) ?? key
      rowsByTop.set(hit, (rowsByTop.get(hit) ?? 0) + 1)
    }
    // #209 / #173：排布真的生效吗？量同一行里相邻两张图之间的**实际像素间距**
    // （不靠「CSS 里写了 gap」当结论 —— 老内核上 flex gap 会静默失效，见 #173）
    const gaps = []
    for (let i = 1; i < sorted.length; i += 1) {
      if (Math.abs(sorted[i].top - sorted[i - 1].top) < 4) {
        gaps.push(Math.round((sorted[i].left - sorted[i - 1].right) * 100) / 100)
      }
    }
    report.tiles = {
      total: shells.length,
      perRow: [...rowsByTop.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count),
      /** 相邻两张图之间的实测间距（getBoundingClientRect 之差），应 = 10px 的列表间距 */
      gapsInRow: gaps,
      objectFitComputed: (() => {
        const first = document.querySelector('img[alt*="4000"]')
        return first ? getComputedStyle(first).objectFit : null
      })(),
    }
  }
  // 整行是否超过屏宽（多图 flex-wrap 时一行到底占多宽）
  const anyImg = document.querySelector('img[alt*="4000"]')
  const row = anyImg?.parentElement?.parentElement ?? null
  if (row) {
    const box = row.getBoundingClientRect()
    report.row = {
      className: String(row.className).slice(0, 60),
      width: round(box.width),
      left: round(box.left),
      right: round(box.right),
      ratio: Math.round((box.width / vw) * 1000) / 1000,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      overflow: row.scrollWidth > row.clientWidth + 0.5,
      overflowsScreen: box.right > vw + 0.5,
      beyondScreen: row.scrollWidth > vw + 0.5,
    }
  }
  return report
}

const pickUploadInput = async (page) => {
  const inputs = await page.locator('input[type="file"]').all()
  for (const input of inputs) {
    const accept = (await input.getAttribute('accept')) ?? ''
    if (accept.includes('.png')) return input
  }
  return null
}

const run = async () => {
  await mkdir(path.join(HERE, 'shots'), { recursive: true })
  const browser = await chromium.launch()
  const results = { label: LABEL, generatedAt: new Date().toISOString(), viewports: {} }
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(() => {
        try {
          localStorage.setItem('chat-demo:api-key', 'sk-818-measure-0000')
        } catch {}
      })
      // 上传/补齐打桩：本单只量布局，不碰真网络
      await context.route('**/*', (route) => {
        const url = route.request().url()
        if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ id: 'file-818-stub', object: 'file', bytes: 1024, created_at: 1700000000, filename: 'stub.png', purpose: 'assistants' }),
          })
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      })

      const page = await context.newPage()
      const consoleErrors = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200))
      })
      await page.goto(BASE, { waitUntil: 'load' })
      await page.waitForTimeout(1500)
      const payload = [PORTRAIT, LANDSCAPE].map((image) => ({
        name: image.name,
        size: image.buffer.length,
        b64: image.buffer.toString('base64'),
      }))
      const seeded = await page.evaluate(seedInPage, { sessions: SESSIONS, payload })
      await page.reload({ waitUntil: 'load' })
      await page.waitForTimeout(2000)

      const entry = { size: `${viewport.width}×${viewport.height}`, seeded, sessions: {} }

      for (const spec of SESSIONS) {
        const menu = page.getByRole('button', { name: '打开边栏' })
        if (await menu.isVisible().catch(() => false)) {
          await menu.click()
          await page.waitForTimeout(350)
        }
        await page.getByText(spec.title, { exact: true }).first().click()
        await page.waitForTimeout(1200)
        await page
          .waitForFunction(
            () =>
              Array.from(document.querySelectorAll('img'))
                .filter((node) => node.alt.includes('4000'))
                .every((node) => node.complete && node.naturalWidth > 0),
            undefined,
            { timeout: 20000 }
          )
          .catch(() => {})
        await page.waitForTimeout(400)
        const measured = await page.evaluate(measureInPage, { alts: [PORTRAIT.name, LANDSCAPE.name] })
        const shot = path.join(HERE, 'shots', `${LABEL}-${viewport.key}-${spec.id}.png`)
        await page.screenshot({ path: shot })
        entry.sessions[spec.id] = { title: spec.title, measured, shot }
      }

      // ③ 点开第一张图：回到「单图」会话再点（缩略图是消息气泡里的那一档）
      const menuBack = page.getByRole('button', { name: '打开边栏' })
      if (await menuBack.isVisible().catch(() => false)) {
        await menuBack.click()
        await page.waitForTimeout(350)
      }
      await page.getByText(SESSIONS[0].title, { exact: true }).first().click()
      await page.waitForTimeout(1000)
      const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null)
      await page.locator(`img[alt="${PORTRAIT.name}"]`).first().click()
      const popup = await popupPromise
      await page.waitForTimeout(700)
      let popupReport = null
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {})
        await popup.waitForTimeout(800)
        popupReport = await popup
          .evaluate(() => {
            const img = document.querySelector('img')
            const box = img?.getBoundingClientRect()
            return {
              url: location.href.slice(0, 60),
              title: document.title.slice(0, 40),
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
              img: img
                ? {
                    width: Math.round(box.width),
                    height: Math.round(box.height),
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    scaled: Math.round(box.width) !== img.naturalWidth,
                  }
                : null,
            }
          })
          .catch((error) => ({ error: String(error).slice(0, 120) }))
        await popup.screenshot({ path: path.join(HERE, 'shots', `${LABEL}-${viewport.key}-popup.png`) }).catch(() => {})
        await popup.close().catch(() => {})
      }
      const overlay = await page.evaluate(() => {
        // 先认稳定的取证钩子；没有再退回「全屏 fixed 层」启发式，并排除应用自己的 .frame 外壳
        const hook = document.querySelector('[data-testid="image-preview"]')
        const fixedLayers = hook
          ? [hook]
          : Array.from(document.querySelectorAll('body *')).filter((node) => {
              const style = getComputedStyle(node)
              if (style.position !== 'fixed') return false
              if (String(node.className).includes('frame')) return false
              const box = node.getBoundingClientRect()
              return box.width >= window.innerWidth * 0.9 && box.height >= window.innerHeight * 0.9
            })
        const layer = fixedLayers[0] ?? null
        if (!layer) return { fullScreenLayer: null, previewImg: null }
        const img = layer.querySelector('img')
        const box = img?.getBoundingClientRect()
        const style = img ? getComputedStyle(img) : null
        return {
          fullScreenLayer: {
            tag: layer.tagName.toLowerCase(),
            className: String(layer.className).slice(0, 60),
            role: layer.getAttribute('role'),
            testid: layer.getAttribute('data-testid'),
            width: Math.round(layer.getBoundingClientRect().width),
            height: Math.round(layer.getBoundingClientRect().height),
            background: getComputedStyle(layer).backgroundColor,
          },
          previewImg: img
            ? {
                width: Math.round(box.width),
                height: Math.round(box.height),
                objectFit: style.objectFit,
                maxWidth: style.maxWidth,
                maxHeight: style.maxHeight,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                insideViewport:
                  box.left >= -1 && box.top >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
                aspectRatio: Math.round((box.width / box.height) * 1000) / 1000,
                sourceAspectRatio: Math.round((img.naturalWidth / img.naturalHeight) * 1000) / 1000,
              }
            : null,
          objectFitProbe: layer.getAttribute('data-object-fit'),
        }
      })
      const afterClickShot = path.join(HERE, 'shots', `${LABEL}-${viewport.key}-click.png`)
      await page.screenshot({ path: afterClickShot })
      let escClosed = null
      let backdropClosed = null
      if (overlay.fullScreenLayer) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
        escClosed = await page.evaluate(() => document.querySelector('[data-testid="image-preview"]') === null)
        // 再点一次打开，然后点遮罩右上角关闭
        await page.locator(`img[alt="${PORTRAIT.name}"]`).first().click()
        await page.waitForTimeout(400)
        await page.mouse.click(6, 6)
        await page.waitForTimeout(400)
        backdropClosed = await page.evaluate(() => document.querySelector('[data-testid="image-preview"]') === null)
        await page.keyboard.press('Escape').catch(() => {})
      }
      entry.click = { popup: popupReport, overlay, escClosed, backdropClosed, shot: afterClickShot }

      // ① 草稿缩略图：输入区隐藏的图片 input 上传 3 张长边 4000px 的大图
      const input = await pickUploadInput(page)
      if (!input) throw new Error('没找到图片上传的 input[type=file]')
      await input.setInputFiles([
        { name: 'draft-tall-3000x4000.png', mimeType: 'image/png', buffer: PORTRAIT.buffer },
        { name: 'draft-wide-4000x3000.png', mimeType: 'image/png', buffer: LANDSCAPE.buffer },
        { name: 'draft-tall2-3000x4000.png', mimeType: 'image/png', buffer: PORTRAIT.buffer },
      ])
      await page.waitForTimeout(3000)
      entry.draft = await page.evaluate(() => {
        const vw = window.innerWidth
        const round = (value) => Math.round(value * 100) / 100
        const items = Array.from(document.querySelectorAll('img'))
          .filter((img) => img.alt.startsWith('draft-'))
          .map((img) => img.parentElement)
          .filter((node) => node !== null)
          .map((node) => ({ node, box: node.getBoundingClientRect() }))
        const row = items[0]?.node.parentElement ?? null
        const rowBox = row?.getBoundingClientRect() ?? null
        return {
          screen: vw,
          count: items.length,
          items: items.map((item) => ({
            className: String(item.node.className).slice(0, 40),
            width: round(item.box.width),
            height: round(item.box.height),
            ratio: Math.round((item.box.width / vw) * 1000) / 1000,
            overflowsScreen: item.box.right > vw + 0.5 || item.box.left < -0.5,
            img: (() => {
              const img = item.node.querySelector('img')
              const box = img.getBoundingClientRect()
              return {
                width: round(box.width),
                height: round(box.height),
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                objectFit: getComputedStyle(img).objectFit,
              }
            })(),
          })),
          gaps: items.slice(1).map((item, index) => Math.round((item.box.left - items[index].box.right) * 100) / 100),
          row: row
            ? {
                className: String(row.className).slice(0, 40),
                width: round(rowBox.width),
                scrollWidth: row.scrollWidth,
                clientWidth: row.clientWidth,
                overflowX: getComputedStyle(row).overflowX,
                overflow: row.scrollWidth > row.clientWidth + 0.5,
                overflowsScreen: rowBox.right > vw + 0.5,
              }
            : null,
          document: {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5,
          },
        }
      })
      entry.draft.shot = path.join(HERE, 'shots', `${LABEL}-${viewport.key}-draft.png`)
      await page.screenshot({ path: entry.draft.shot })
      entry.consoleErrors = consoleErrors.slice(0, 10)

      results.viewports[viewport.key] = entry
      console.log(`\n===== ${viewport.width}×${viewport.height} =====`)
      console.log(JSON.stringify(entry, null, 2))
      await context.close()
    }
  } finally {
    await browser.close()
    const out = path.join(HERE, `result-${LABEL}.json`)
    await writeFile(out, JSON.stringify(results, null, 2))
    console.log(`\n写出 ${out}`)
  }
}

await run()
