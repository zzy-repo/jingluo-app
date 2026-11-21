// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 5「导入」+ 域 6「导出」（Issue #404 第二批，**两域合成一条往返**）：
//   导出 → 校验包结构 → 可再次导入
//
// 为什么合成一条：导出和导入天生是同一条流程的两端（README 的建议），而「自己导出的包自己导不进来」
// 正是域 5 盘点里排第一的 P0 缺口（F-05-23 / F-05-28：导出侧此前**零测试**）。拆成两条会各写一份
// 装配，却仍然测不到「两端对不对得上」——只有真的把导出的字节喂回导入，manifest 首条、条目路径、
// 索引与会话的一一对应才被同时钉住。
//
// 与 L1 的分工（url-import-native / url-import-stages / url-import-web 已覆盖 18 个下载与解析分支：
// Range 分块、416 收尾、停滞判定、8 类失败文案…）：这里只跑**本地文件这一条主路径**，
// 不重复任何失败分档，也不重复「链接导入」的原生桥（那是 G5 的事）。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g06-export-import.test.mjs
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { seedSessions, sessionEntry } from '../fixtures/domain01-02/idb-fault.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, sessionCount, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g06'
const NOW = Date.now()
const TITLES = ['黄金导出甲', '黄金导出乙']
const ENTRIES = [
  sessionEntry({ id: 'g6-jia', title: TITLES[0], question: '导出的第一问', answer: '导出的第一答', at: NOW - 200_000 }),
  sessionEntry({ id: 'g6-yi', title: TITLES[1], question: '导出的第二问', answer: '导出的第二答', at: NOW - 60_000 }),
]

/** 读条目 JSON：缺条目 / 坏 JSON 一律回 null（失败断言要一句话定位，不能抛解析异常） */
const readJson = (entries, name) => {
  if (!Object.hasOwn(entries, name)) {
    return null
  }
  try {
    return JSON.parse(strFromU8(entries[name]))
  } catch {
    return null
  }
}

/** 导出包的条目顺序与内容（导出格式见 src/services/chat/history/{paths,exportArchive}.ts） */
const readArchive = async (file) => {
  const bytes = new Uint8Array(await readFile(file))
  const entries = unzipSync(bytes)
  const names = Object.keys(entries)
  const manifest = readJson(entries, 'manifest.json')
  const index = readJson(entries, 'chat_session_index.json')
  const sessions = names
    .filter((name) => /^chat_sessions\/[^/]+\.json$/.test(name))
    .map((name) => readJson(entries, name) ?? {})
  return { names, manifest, index, sessions }
}

const result = await runGolden(
  { id: 'G6', domain: '导出+导入', title: '导出 → 校验包结构 → 可再次导入' },
  async (ctx) => {
    const app = await serveGoldenApp()
    // 导出 / 导入全走本地文件与 IndexedDB：总闸是空的（任何出站请求都算漏）
    const { page, close, guard } = await openGoldenPage(app.url, { storage: { 'chat-demo:api-key': KEY } })
    const dir = await mkdtemp(path.join(tmpdir(), 'deepseek-golden-export-'))
    const zipPath = path.join(dir, 'deepseek_data.zip')
    try {
      await waitForBoot(page)
      await seedSessions(page, ENTRIES)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const listed = await waitFor(page, async () => (await bodyText(page)).includes(TITLES[0]))
      if (!listed) {
        ctx.abort('侧栏列出待导出的 2 条会话', `含「${TITLES[0]}」`, `body=${brief(await bodyText(page))}`)
      }

      // ── 1. 导出：设置 → 数据管理 → 「下载」真的产出 ZIP ────────────────────────
      ctx.begin('导出')
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
      const downloadButton = page.getByRole('button', { name: /^下载$|^Download$/ }).first()
      const buttonReady = await waitFor(page, async () => (await downloadButton.count()) > 0)
      if (!buttonReady) {
        ctx.abort('数据管理里有「导出所有历史对话」的下载按钮', '按钮「下载」存在', `body=${brief(await bodyText(page))}`)
      }
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), downloadButton.click()])
      await download.saveAs(zipPath)
      ctx.expect('文件名是 deepseek_data-日期.zip', /^deepseek_data-.+\.zip$/.test(download.suggestedFilename()), {
        expected: 'deepseek_data-<日期>.zip',
        actual: download.suggestedFilename(),
      })

      // ── 2. 校验包结构：manifest 首条 → 会话 JSON → index，且内容对得上 ──────────
      ctx.begin('校验包结构')
      const archive = await readArchive(zipPath)
      if (archive.names[0] !== 'manifest.json') {
        // 缺 manifest 时后面「还能不能导回来」必然连带失败，只留这一条真正的原因
        ctx.abort('首条是 manifest.json（格式要求 manifest 必须在前）', 'manifest.json', archive.names[0] ?? '（空包）')
      }
      ctx.expect('manifest 声明导出格式版本 3', archive.manifest?.export_format_version === 3, {
        expected: '3',
        actual: archive.manifest === null ? '（没有 manifest.json）' : String(archive.manifest.export_format_version),
      })
      if (archive.sessions.length !== 2) {
        ctx.abort('导出包含 2 个会话 JSON', 'chat_sessions/*.json = 2', `实际 ${archive.sessions.length}（${archive.names.join(', ')}）`)
      }
      ctx.expect('索引与会话一一对应', archive.index?.length === 2, {
        expected: 'index = 2 条',
        actual: archive.index === null ? '（没有 chat_session_index.json）' : `index = ${archive.index.length} 条`,
      })
      const exportedTitles = archive.sessions.map((session) => session.title).sort()
      ctx.expect('导出包里的会话标题就是侧栏那两条', exportedTitles.join(',') === [...TITLES].sort().join(','), {
        expected: [...TITLES].sort().join(','),
        actual: exportedTitles.join(','),
      })

      // ── 3. 可再次导入：把刚导出的字节喂回导入入口 → 会话数不变、侧栏照旧 ─────────
      ctx.begin('可再次导入')
      const before = await sessionCount(page)
      await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipPath)
      const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
      const confirmReady = await waitFor(page, async () => (await confirm.count()) > 0)
      if (!confirmReady) {
        ctx.abort('选择刚导出的包后弹出「确认导入历史对话」', '确认弹窗出现', `body=${brief(await bodyText(page))}`)
      }
      await confirm.getByRole('button', { name: '确认导入', exact: true }).click()
      const imported = await waitFor(page, async () => /已导入 2 个(对话|会话)/.test(await bodyText(page)), 30_000)
      ctx.expect('导入给出完成信号「已导入 2 个会话」', imported, {
        expected: 'body 含「已导入 2 个会话」',
        actual: `body=${brief(await bodyText(page))}`,
      })
      const after = await sessionCount(page)
      if (after !== before) {
        ctx.abort('导入后会话数仍是 2（导出包能导入自己）', `sessions = ${before}`, `sessions = ${after}`)
      }
      const dialog = page.getByRole('dialog').first()
      if ((await dialog.count()) > 0) {
        await dialog
          .getByRole('button', { name: /^关闭$|^Close$/ })
          .first()
          .click()
          .catch(() => {})
      }
      const titlesBack = await waitFor(page, async () => (await bodyText(page)).includes(TITLES[1]))
      ctx.expect('侧栏重新列出导入回来的会话', titlesBack, {
        expected: `body 含「${TITLES[1]}」`,
        actual: `body=${brief(await bodyText(page))}`,
      })

      // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ──────────────
      ctx.begin('不连真实服务')
      guard.assertNoLeak(ctx)
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
