// [layer: integration | 依赖: playwright + chromium + 本地 dist-standard 静态服务 | 耗时: ~1.5 分钟]
//
// #362 / #367 · 域 4 最小充分集 · N4-C「会话列表闭环 + 降级」（L2，一张表 13 行）
//
// 为什么必须有这条：N4-A/N4-B 验证得了状态机，验证不了「刷新后还在」（需要真 IndexedDB 跨 reload），
// 也验证不了菜单 / 确认弹窗 / 移动端双击这些只在真 DOM 里存在的行为。
//
//   cd <repo> && DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   node tests/integration/session-list-flow.test.mjs
//
// 覆盖功能点：
//   F4-01 新建会话：点「开启新对话」回空态、旧会话仍在列表
//   F4-02 切换会话：点会话项打开对应会话
//   F4-03 会话置顶 / 取消置顶与排序：菜单、「已置顶」标记、置顶分组置前、刷新后仍在
//   F4-04 重命名会话：Enter 提交、Escape 取消、空白不提交，且刷新后仍在
//   F4-05 删除会话：确认弹窗、取消、删当前会话回空态、刷新后不再回来
//   F4-07 双击标题回顶：移动端标题栏双击（真实触摸语义用 click 两次模拟）
//   F4-09 损坏会话隔离的**列表侧降级**：列表读取失败给「对话列表加载失败，请重试」+ 重试按钮
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}

/** 打开（必要时建）应用自己的库：schema 与 src/services/chat/db.ts 一致 */
const OPEN_DB = async (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo', 12)
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
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    db.close()
  })

/** 清空业务数据（不删库：应用自己还连着，deleteDatabase 会被 blocked 卡住） */
const CLEAR_DB = async (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo', 12)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise((resolve, reject) => {
      const names = [...db.objectStoreNames]
      const tx = db.transaction(names, 'readwrite')
      for (const name of names) {
        tx.objectStore(name).clear()
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })

/** 直接写 IndexedDB：确定性造数据，避免靠 UI 发消息攒会话 */
const SEED = async (page, sessions) =>
  page.evaluate(async (items) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo', 12)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      const sessionsStore = tx.objectStore('sessions')
      const summaryStore = tx.objectStore('sessionSummaries')
      for (const item of items) {
        sessionsStore.put(item)
        summaryStore.put({
          id: item.id,
          title: item.title,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          ...(item.pinnedAt === undefined ? {} : { pinnedAt: item.pinnedAt }),
          fileIds: [],
        })
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, sessions)

const sessionOf = (id, title, { updatedAt, pinnedAt, messages = 2 } = {}) => ({
  id,
  title,
  createdAt: 1_700_000_000_000 + updatedAt,
  updatedAt: 1_700_000_000_000 + updatedAt,
  ...(pinnedAt === undefined ? {} : { pinnedAt }),
  messages: Array.from({ length: messages }, (_, index) =>
    index % 2 === 0
      ? { id: `${id}-u${index}`, role: 'user', content: `${title} 的第 ${index} 问`, files: [], createdAt: 1_700_000_000_000 + updatedAt + index }
      : {
          id: `${id}-a${index}`,
          role: 'assistant',
          createdAt: 1_700_000_000_000 + updatedAt + index,
          blocks: [{ type: 'text', text: `${title} 的第 ${index} 答` }],
          status: 'done',
          model: 'deepseek-flash',
        }
  ),
})

let served
let browser
try {
  served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist-standard' })
  const APP_URL = process.env.APP_URL || served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  const resetTo = async (sessions) => {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    await page.evaluate(() => {
      window.localStorage.clear()
      // 有 Key 才不会在启动时自动弹设置（那层 overlay 会挡住侧栏点击）
      window.localStorage.setItem('chat-demo:api-key', 'sk-domain04-flow-key')
    })
    await OPEN_DB(page)
    await CLEAR_DB(page)
    await SEED(page, sessions)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
  }

  const titles = () => page.locator('[class*="item-"] [class*="title-"]').allInnerTexts()
  /** 「更多」按钮在桌面端只在 hover 时 display:flex，所以必须先悬停条目再点 */
  const openMenu = async (title) => {
    const item = page.locator('[class*="item-"]').filter({ hasText: new RegExp(`^${title}$`) }).first()
    await item.hover()
    await page.waitForTimeout(150)
    await item.getByRole('button', { name: '更多' }).click()
    await page.getByRole('menu').waitFor({ timeout: 5000 })
  }
  const menuPick = async (label) => {
    await page.getByRole('menuitem', { name: label }).first().click()
    await page.waitForTimeout(500)
  }

  const base = [
    sessionOf('s1', '会话一', { updatedAt: 100 }),
    sessionOf('s2', '会话二', { updatedAt: 200 }),
    sessionOf('s3', '会话三', { updatedAt: 300 }),
  ]

  // ---------- [1] F4-01 新建会话 ----------
  console.log('\n[1] F4-01 开启新对话 → 空态首页，旧会话仍在')
  await resetTo(base)
  {
    await page.getByText('会话三', { exact: true }).first().click()
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /开启新对话/ }).first().click()
    await page.waitForTimeout(500)
    const list = await titles()
    const welcome = await page.getByText('今天有什么可以帮到你？').count()
    if (list.length !== 3) {
      bad(`1) 新建后旧会话丢了：侧栏 ${JSON.stringify(list)}`)
    } else if (welcome === 0) {
      bad('1) 新建后没有回空态首页')
    } else {
      ok('1) 点「开启新对话」→ 回空态，侧栏 3 条旧会话都在')
    }
  }

  // ---------- [2] F4-02 切换会话 ----------
  console.log('\n[2] F4-02 点会话项 → 打开该会话内容')
  {
    await page.getByText('会话一', { exact: true }).first().click()
    await page.waitForTimeout(700)
    const body = await page.locator('body').innerText()
    if (!/会话一 的第 0 问/.test(body)) {
      bad(`2) 打开会话一后主区没有它的消息：${body.slice(-160).replace(/\n/g, ' / ')}`)
    } else if (/会话三 的第 0 问/.test(body)) {
      bad('2) 主区串到了别的会话')
    } else {
      ok('2) 点「会话一」→ 主区渲染它自己的消息')
    }
  }

  // ---------- [3][4] F4-03 置顶 + 刷新后仍在 ----------
  console.log('\n[3] F4-03 菜单置顶 → 「已置顶」标记 + 置顶分组置前')
  await resetTo(base)
  {
    await openMenu('会话一')
    await menuPick(/置顶会话/)
    const list = await titles()
    const pinnedMarks = await page.getByLabel('已置顶').count()
    const groupHeaders = await page.getByText('置顶会话', { exact: true }).count()
    if (list[0] !== '会话一') {
      bad(`3) 置顶后没有排到最前：${JSON.stringify(list)}`)
    } else if (pinnedMarks !== 1) {
      bad(`3) 没有渲染「已置顶」标记（命中 ${pinnedMarks} 个）`)
    } else if (groupHeaders === 0) {
      bad('3) 没有渲染「置顶会话」分组')
    } else {
      ok(`3) 会话一置顶 → 列表 ${JSON.stringify(list)}，标记 1 个，分组标题在`)
    }
  }

  console.log('\n[4] F4-03 刷新后仍是置顶（真 IndexedDB）')
  {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const list = await titles()
    const pinnedMarks = await page.getByLabel('已置顶').count()
    if (list[0] !== '会话一' || pinnedMarks !== 1) {
      bad(`4) 刷新后置顶丢了：${JSON.stringify(list)} 标记 ${pinnedMarks}`)
    } else {
      ok(`4) reload 后仍置顶：${JSON.stringify(list)}`)
    }
  }

  // ---------- [5] F4-03 取消置顶 ----------
  console.log('\n[5] F4-03 再点一次「取消置顶」 → 标记消失、回普通分组')
  {
    await openMenu('会话一')
    await menuPick(/取消置顶/)
    const pinnedMarks = await page.getByLabel('已置顶').count()
    const list = await titles()
    if (pinnedMarks !== 0) {
      bad(`5) 取消置顶后标记还在（${pinnedMarks} 个）`)
    } else if (list[0] === '会话一') {
      bad(`5) 取消置顶后仍排最前：${JSON.stringify(list)}`)
    } else {
      ok(`5) 取消置顶 → 标记消失，顺序回到按更新时间：${JSON.stringify(list)}`)
    }
  }

  // ---------- [6][7][8] F4-04 重命名 ----------
  console.log('\n[6] F4-04 重命名 Enter → 落盘且刷新后仍在')
  await resetTo(base)
  {
    await openMenu('会话二')
    await menuPick(/重命名/)
    const input = page.locator('input[class*="rename"]').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('改过的名字')
    await input.press('Enter')
    await page.waitForTimeout(500)
    const after = await titles()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const afterReload = await titles()
    if (!after.includes('改过的名字')) {
      bad(`6) Enter 没有提交标题：${JSON.stringify(after)}`)
    } else if (!afterReload.includes('改过的名字')) {
      bad(`6) 重命名没有落盘（刷新即丢）：${JSON.stringify(afterReload)}`)
    } else {
      ok('6) 菜单→重命名→Enter → 标题写回，reload 后仍在')
    }
  }

  console.log('\n[7] F4-04 重命名 Escape → 不提交')
  {
    await openMenu('会话一')
    await menuPick(/重命名/)
    const input = page.locator('input[class*="rename"]').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('不该生效的名字')
    await input.press('Escape')
    await page.waitForTimeout(400)
    const list = await titles()
    if (list.includes('不该生效的名字')) {
      bad(`7) Escape 仍然提交了：${JSON.stringify(list)}`)
    } else if (!list.includes('会话一')) {
      bad(`7) Escape 之后原会话不见了：${JSON.stringify(list)}`)
    } else {
      ok('7) Escape → 标题不变（仍是「会话一」）')
    }
  }

  console.log('\n[8] F4-04 重命名空白 → 不提交，不变成「新对话」')
  {
    await openMenu('会话三')
    await menuPick(/重命名/)
    const input = page.locator('input[class*="rename"]').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('   ')
    await input.press('Enter')
    await page.waitForTimeout(400)
    const list = await titles()
    if (!list.includes('会话三')) {
      bad(`8) 纯空格被当成新标题：${JSON.stringify(list)}`)
    } else {
      ok('8) 纯空格不提交，标题仍是「会话三」')
    }
  }

  // ---------- [9] F4-05 删除：取消 ----------
  console.log('\n[9] F4-05 删除 → 确认弹窗「永久删除对话」→ 取消')
  {
    await openMenu('会话三')
    await menuPick(/^删除$/)
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ timeout: 5000 })
    const dialogText = await dialog.innerText()
    await page.getByRole('button', { name: /^取消$/ }).first().click()
    await page.waitForTimeout(400)
    const list = await titles()
    if (!/永久删除对话/.test(dialogText) || !/不可恢复|上传的文件/.test(dialogText)) {
      bad(`9) 确认弹窗文案不对：${dialogText.replace(/\n/g, ' / ')}`)
    } else if (!list.includes('会话三')) {
      bad(`9) 点取消却把会话删了：${JSON.stringify(list)}`)
    } else {
      ok('9) 弹窗文案含「永久删除对话」+ 不可恢复说明；取消后会话仍在')
    }
  }

  // ---------- [10][11] F4-05 删除：确认（含删当前会话） ----------
  console.log('\n[10] F4-05 确认删除非当前会话 → 列表少一条，刷新后不回来')
  {
    await openMenu('会话一')
    await menuPick(/^删除$/)
    await page.getByRole('dialog').first().waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: /^删除$/ }).last().click()
    await page.waitForTimeout(700)
    const list = await titles()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const afterReload = await titles()
    if (list.includes('会话一') || afterReload.includes('会话一')) {
      bad(`10) 删除没有生效：现在 ${JSON.stringify(list)} / 刷新后 ${JSON.stringify(afterReload)}`)
    } else {
      ok(`10) 删除生效且持久：${JSON.stringify(afterReload)}`)
    }
  }

  console.log('\n[11] F4-05 删除当前会话 → 回空态首页')
  {
    await page.getByText('会话三', { exact: true }).first().click()
    await page.waitForTimeout(700)
    await openMenu('会话三')
    await menuPick(/^删除$/)
    await page.getByRole('dialog').first().waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: /^删除$/ }).last().click()
    await page.waitForTimeout(800)
    const list = await titles()
    const welcome = await page.getByText('今天有什么可以帮到你？').count()
    if (list.includes('会话三')) {
      bad(`11) 当前会话没被删掉：${JSON.stringify(list)}`)
    } else if (welcome === 0) {
      bad('11) 删掉当前会话后没有回到空态首页（停在已删会话上）')
    } else {
      ok('11) 删当前会话 → 回空态，侧栏只剩其他会话')
    }
  }

  // ---------- [12] F4-07 移动端双击标题回顶 ----------
  console.log('\n[12] F4-07 移动端双击标题栏 → 回到首条')
  {
    const mobile = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
    const mobilePage = await mobile.newPage()
    await mobilePage.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await mobilePage.evaluate(() => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:api-key', 'sk-domain04-flow-key')
    })
    await OPEN_DB(mobilePage)
    await CLEAR_DB(mobilePage)
    await SEED(mobilePage, [sessionOf('long', '长会话', { updatedAt: 500, messages: 60 })])
    await mobilePage.reload({ waitUntil: 'domcontentloaded' })
    await mobilePage.waitForTimeout(900)
    // 移动端侧栏是抽屉：先打开抽屉选会话
    await mobilePage.getByRole('button', { name: '打开边栏' }).first().click()
    await mobilePage.waitForTimeout(600)
    await mobilePage.getByText('长会话', { exact: true }).first().click()
    await mobilePage.waitForTimeout(900)
    const scrolled = await mobilePage.evaluate(() => {
      const scroller = [...document.querySelectorAll('*')]
        .filter((element) => element.scrollHeight > element.clientHeight + 40)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      if (!scroller) {
        return -1
      }
      scroller.scrollTop = scroller.scrollHeight
      return scroller.scrollTop
    })
    const title = mobilePage.getByRole('button', { name: /回到首条消息/ }).first()
    const hasTitle = (await title.count()) > 0
    if (hasTitle) {
      await title.dblclick()
      await mobilePage.waitForTimeout(900)
    }
    const after = await mobilePage.evaluate(() =>
      Math.max(0, ...[...document.querySelectorAll('*')].map((element) => element.scrollTop))
    )
    await mobile.close()
    if (scrolled <= 0) {
      bad(`12) 长会话没有可滚动的容器（scrollTop=${scrolled}）`)
    } else if (!hasTitle) {
      bad('12) 移动端标题栏没有渲染（找不到「回到首条消息」按钮）')
    } else if (after > 40) {
      bad(`12) 双击标题后仍在 ${after}px，没有回到首条`)
    } else {
      ok(`12) 滚到 ${scrolled}px 后双击标题 → 回到 ${after}px`)
    }
  }

  // ---------- [13] F4-09 列表读取失败 → 可读降级文案 ----------
  console.log('\n[13] F4-09 列表读取失败 → 「对话列表加载失败，请重试」+ 重试按钮')
  {
    const broken = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
    // 让 IndexedDB 打不开：真机上对应「隐私模式 / 存储被清 / 数据库损坏」
    await broken.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        get: () => ({
          open: () => {
            const request = { onsuccess: null, onerror: null, onupgradeneeded: null }
            setTimeout(() => {
              request.error = new Error('indexedDB unavailable')
              request.onerror?.()
            }, 0)
            return request
          },
          databases: async () => [],
          deleteDatabase: () => ({ onsuccess: null, onerror: null }),
        }),
      })
    })
    const brokenPage = await broken.newPage()
    await brokenPage.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await brokenPage.waitForTimeout(1500)
    const text = await brokenPage.locator('body').innerText()
    const retry = await brokenPage.getByRole('button', { name: /^重试$/ }).count()
    await broken.close()
    if (!/对话列表加载失败，请重试/.test(text)) {
      bad(`13) 没有降级文案：${text.replace(/\n/g, ' / ').slice(0, 200)}`)
    } else if (retry === 0) {
      bad('13) 只有文案没有「重试」入口（用户只能杀进程）')
    } else {
      ok('13) 列表读取失败 → 「对话列表加载失败，请重试」+ 重试按钮')
    }
  }
} finally {
  await browser?.close().catch(() => {})
  served?.kill()
}

if (failures.length > 0) {
  console.error('\nFAIL tests/integration/session-list-flow.test.mjs')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nPASS tests/integration/session-list-flow.test.mjs')
