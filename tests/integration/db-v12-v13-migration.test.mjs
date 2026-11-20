// [layer: integration | 依赖: playwright + chromium + 本地标准产物（dist-standard）静态服务 | 耗时: ~40s]
//
// #547 / #545 · IndexedDB **v12 → v13 升级不变量**（#480 的文档附件只新增两个 store）
//
// 为什么必须有这条：#545 的验收报告自己承认「DB v12→v13 迁移未验」。老用户升级是这条链路唯一
// 真正危险的时刻 —— 升级回调里一句 `deleteObjectStore` / 一个没加 `contains()` 守卫的
// `createObjectStore`（重复建会抛 ConstraintError，整次升级回滚、库卡在旧版本），
// 代价就是「历史会话全没了」。而「能用一个空库以 v13 打开」什么都证明不了。
//
// 所以本条用例造的是一条**真升级路径**：
//   ① 在应用脚本跑起来**之前**建一个 v12 库（v12 的 schema 是冻结的历史，见 LEGACY_DB_VERSION），
//      写入代表性旧数据：2 个会话（含置顶、多轮消息）、1 份文件原件（Blob 字节）、1 份应用素材；
//   ② 放开真实产物，让应用自己 `openDB(name, DB_VERSION)` 把它升到 v13；
//   ③ 断言升级不变量：
//      [1] 版本 = 源码 DB_VERSION（不写死数字）
//      [2] 两个新 store（attachments / attachmentTexts）及其索引建出来了
//      [3] 旧 store 一个不少（6 个）
//      [4] **旧数据逐字节还在**（整库快照比对：会话详情 / 摘要 / 原件 Blob / 素材 Blob）
//      [5] 新 store 是空的（升级只新增，不预置、不改写）
//      [6] 升级后应用读得到迁移后的数据（侧栏渲染 v12 时期的会话标题、点开能渲染消息）
//
// 为什么建库要在应用之前：应用一挂载就 `initChat()` → `openDB(…, 13)`，库会当场被建成 v13，
// 就没有「升级」可验了。做法是用 `page.route()` 把主文档换成同源空白页（同源 → 同一个 IndexedDB）。
//
//   node tests/integration/db-v12-v13-migration.test.mjs
import { chromium } from 'playwright'

import {
  DB_NAME,
  DB_VERSION,
  LEGACY_DB_VERSION,
  PROBE_HTML,
  ensureChatDb,
  readAllStores,
  seedLegacyV12,
} from '../helpers/chat-db.mjs'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message, detail) => {
  if (condition) {
    ok(detail === undefined ? message : `${message}（${detail}）`)
  } else {
    bad(detail === undefined ? message : `${message}（实际：${detail}）`)
  }
}

/** v12 时代的 6 个 store（不是当前 schema：这是历史快照，故意写死） */
const LEGACY_STORES = [
  'appAssets',
  'files',
  'filesStaging',
  'sessionSummaries',
  'sessions',
  'sessionsStaging',
]

/** v12 旧数据：字段形状按 v12 的 StoredSession 来（`files` 里是文件引用，原件在 files store） */
const NOW = 1_700_000_000_000
const LEGACY_PAYLOAD = {
  sessions: [
    {
      id: 'v12-session-pinned',
      title: 'v12 时期置顶的老会话',
      createdAt: NOW,
      updatedAt: NOW + 2,
      pinnedAt: NOW + 2,
      messages: [
        { id: 'v12-pinned-u0', role: 'user', content: 'v12 的第二问', files: [], createdAt: NOW + 1 },
        {
          id: 'v12-pinned-a0',
          role: 'assistant',
          createdAt: NOW + 2,
          status: 'done',
          model: 'deepseek-flash',
          blocks: [{ type: 'text', text: 'v12 的第二答' }],
        },
      ],
    },
    {
      id: 'v12-session-plain',
      title: 'v12 时期的普通会话',
      createdAt: NOW,
      updatedAt: NOW + 4,
      messages: [
        {
          id: 'v12-plain-u0',
          role: 'user',
          content: 'v12 的第一问',
          files: [{ id: 'legacy-file-1', name: '旧附件.txt', type: 'text/plain', size: 24 }],
          createdAt: NOW + 3,
        },
        {
          id: 'v12-plain-a0',
          role: 'assistant',
          createdAt: NOW + 4,
          status: 'done',
          model: 'deepseek-flash',
          blocks: [{ type: 'text', text: 'v12 的第一答' }],
        },
      ],
    },
  ],
  // 原件按「文本 + 类型」传过去，由页内自己 new Blob（Blob 过不了 evaluate 序列化）
  files: [{ id: 'legacy-file-1', type: 'text/plain', text: 'v12 时代的原件字节：不要被升级改掉' }],
  assets: [
    { key: 'chat-background', type: 'text/plain', text: 'v12 时代的背景图字节', updatedAt: NOW },
  ],
}

let served
let browser
try {
  served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist-standard' })
  const APP_URL = process.env.APP_URL || served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
  console.log(`· 被测地址 ${APP_URL}；源码 DB_VERSION = ${DB_VERSION}（库 ${DB_NAME}）`)

  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  // ---------- ① 同源空白页：在应用之前把 v12 库建好 ----------
  console.log(`\n[0] 造 v12 旧库（${LEGACY_DB_VERSION}）+ 旧数据`)
  const probeDocument = (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PROBE_HTML })
      : route.continue()
  await page.route('**/*', probeDocument)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  const legacy = await page.evaluate(seedLegacyV12, {
    name: DB_NAME,
    version: LEGACY_DB_VERSION,
    payload: LEGACY_PAYLOAD,
  })
  // 有 Key 才不会在启动时自动弹设置（那层 overlay 会挡住侧栏）
  await page.evaluate(() => {
    window.localStorage.clear()
    window.localStorage.setItem('chat-demo:api-key', 'sk-migration-invariant-key')
  })
  const before = await page.evaluate(readAllStores, { name: DB_NAME })
  expect(legacy.version === LEGACY_DB_VERSION, `[0a] 旧库版本 = ${LEGACY_DB_VERSION}`, `v${legacy.version}`)
  expect(
    LEGACY_STORES.every((store) => legacy.stores.includes(store)),
    '[0b] 旧库是 v12 的 6 个 store',
    legacy.stores.join(' / ')
  )
  // 负向对照：v12 里确实没有附件两个 store，否则下面的断言就是自证
  expect(
    !legacy.stores.includes('attachments') && !legacy.stores.includes('attachmentTexts'),
    '[0c] 旧库还没有附件 store（v12 的事实）'
  )
  expect(
    before.data.sessions?.length === 2 && before.data.files?.length === 1,
    '[0d] 旧数据写进去了',
    `sessions=${before.data.sessions?.length} files=${before.data.files?.length}`
  )

  // ---------- ② 放开真实产物：让它自己升级 ----------
  console.log('\n[1] 用产物打开同一个库 → 触发 v12 → v13 升级')
  await page.unroute('**/*', probeDocument)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  // 只把「新 store」作为必检项：旧 store 丢没丢交给下面 [3]/[4] 逐条报，
  // 不要在这里抛异常中断 —— 失败信息要指出「少了哪个 store / 哪条数据」，而不是一句中断。
  const opened = await ensureChatDb(page, { version: DB_VERSION, stores: ['attachments', 'attachmentTexts'] })
  expect(
    opened.version === DB_VERSION,
    `[1] 库版本从 v${LEGACY_DB_VERSION} 升到源码 DB_VERSION`,
    `v${legacy.version} → v${opened.version}`
  )

  // ---------- ③ 升级不变量 ----------
  const after = await page.evaluate(readAllStores, { name: DB_NAME })
  console.log('\n[2] 两个新 store 与索引')
  expect(after.stores.includes('attachments'), '[2a] attachments 建出来了')
  expect(after.stores.includes('attachmentTexts'), '[2b] attachmentTexts 建出来了')
  expect(
    ['parsedTextPath', 'sha256'].every((index) => after.indexes.attachments?.includes(index)),
    '[2c] attachments 带 sha256 / parsedTextPath 索引',
    (after.indexes.attachments ?? []).join(' / ')
  )
  expect(
    after.indexes.attachmentTexts?.includes('sha256'),
    '[2d] attachmentTexts 带 sha256 索引',
    (after.indexes.attachmentTexts ?? []).join(' / ')
  )

  console.log('\n[3] 旧 store 一个不少')
  const lostStores = LEGACY_STORES.filter((store) => !after.stores.includes(store))
  expect(lostStores.length === 0, '[3] v12 的 6 个 store 升级后都还在', `缺 ${lostStores.join(' / ') || '无'}`)
  expect(
    after.indexes.sessionSummaries?.includes('fileIds'),
    '[3b] 旧索引 fileIds 还在（重建 store 会把它丢掉）',
    (after.indexes.sessionSummaries ?? []).join(' / ')
  )

  console.log('\n[4] 旧数据逐字节还在（迁移不变量）')
  const changed = []
  for (const store of LEGACY_STORES) {
    const beforeRows = JSON.stringify(before.data[store] ?? null)
    const afterRows = JSON.stringify(after.data[store] ?? null)
    if (beforeRows !== afterRows) {
      changed.push(`${store}（升级前 ${(before.data[store] ?? []).length} 条 → 升级后 ${(after.data[store] ?? []).length} 条）`)
    }
  }
  expect(changed.length === 0, '[4a] 6 个旧 store 的记录与升级前逐字节相同', changed.join('；') || '无差异')
  expect(
    after.data.files?.[0]?.blob?.__blob?.text === LEGACY_PAYLOAD.files[0].text,
    '[4b] 文件原件的 Blob 字节没被改写',
    after.data.files?.[0]?.blob?.__blob?.text?.slice(0, 24)
  )
  expect(
    after.data.sessions?.find((session) => session.id === 'v12-session-pinned')?.pinnedAt === NOW + 2,
    '[4c] 置顶字段（pinnedAt）随会话一起活下来'
  )

  console.log('\n[5] 新 store 是空的（只新增，不预置）')
  expect(
    (after.data.attachments ?? []).length === 0 && (after.data.attachmentTexts ?? []).length === 0,
    '[5] attachments / attachmentTexts 里没有任何记录',
    `attachments=${after.data.attachments?.length} texts=${after.data.attachmentTexts?.length}`
  )

  console.log('\n[6] 升级后应用读得到迁移后的数据')
  let sidebarTitles = []
  try {
    await page.getByText('v12 时期置顶的老会话').first().waitFor({ timeout: 20_000 })
    sidebarTitles = await page.locator('[class*="item-"] [class*="title-"]').allInnerTexts()
    ok(`[6a] 侧栏渲染出 v12 时期的会话（${JSON.stringify(sidebarTitles)}）`)
  } catch (error) {
    bad(`[6a] 升级后侧栏没有 v12 时期的会话：${String(error?.message ?? error).split('\n')[0]}`)
  }
  try {
    await page.getByText('v12 时期的普通会话', { exact: true }).first().click()
    // 等终态（消息渲染出来）而不是 sleep：见 docs/TESTING-POLICY.md §11.5
    await page.getByText('v12 的第一问').first().waitFor({ timeout: 15_000 })
    const body = await page.locator('body').innerText()
    expect(
      /v12 的第一问/.test(body) && /v12 的第一答/.test(body),
      '[6b] 点开老会话能渲染出 v12 时期的问答'
    )
  } catch (error) {
    bad(`[6b] 打不开 v12 时期的老会话：${String(error?.message ?? error).split('\n')[0]}`)
  }
} catch (error) {
  const reason = String(error instanceof Error ? error.message : error).split('\n')[0]
  failures.push(`用例中断：${reason}`)
  console.error(`  ✗  用例中断（后续断言未执行）：${reason}`)
} finally {
  await browser?.close().catch(() => {})
  served?.kill()
}

console.log(`\n共 ${checks} 项断言`)
if (failures.length > 0) {
  console.error(`FAIL tests/integration/db-v12-v13-migration.test.mjs（${failures.length} 条）`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('PASS tests/integration/db-v12-v13-migration.test.mjs')
