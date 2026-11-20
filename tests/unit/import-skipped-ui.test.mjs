// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <1s] Issue #49
//
// #49 的收尾：导入**收集到的跳过条目**必须一路带到界面上，用户能看见「跳过了几条、分别是哪里、为什么」。
// 之前的实现只在 toLocal / store 内部有 skipped，importArchive 直接把它丢掉了（返回 void），
// 所以 state.importSkipped 恒为空，界面上永远只有「已导入 N 个会话」。
//
// 用例包：manifest → 会话 JSON → 索引 → 图片（真实导出顺序），其中
//   s1 / s2 完好；s3 第 2 条消息 parent_id 悬空（截断，只丢这条）；
//   s4 唯一一条消息就悬空（整个会话无法构造，按容错策略跳过整个会话，连它的图片条目也不许炸）。
//
//   [1] 真实 importArchive：3 个会话入库，skipped 有 3 条（s3 的消息 / s4 的消息 / s4 的会话）
//   [2] 不损坏的包：skipped 为空（不回退）
//   [3] UI 层（ImportSkippedDetails）拿真实 skipped 渲染：条数、会话标题、消息 id、原因文案都在
//   [4] 新增文案 zh / en 成对、占位符对齐、en 下无中文；既有 key 未被删改
//
//   node tests/unit/import-skipped-ui.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importStagingDb, installImportEnv } from '../helpers/import-env.mjs'

// 装配走公共入口（#408 收尾批）：`./errors.js` 等价替身 + 只对 importArchive.ts 换掉 `../db.js`
// + `.js→.ts` 解析，全在 installImportEnv 里；假存储仍由本文件给（各文件的暂存语义不同）。
installImportEnv({ db: importStagingDb({ expose: '__skippedUiDB' }) })

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { zipSync, strToU8 } = await import('fflate')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const db = globalThis.__skippedUiDB

const TIME = '2026-11-01T00:00:00.000Z'

/** 与 i18n 的 createTranslate 等价：用真实 zh 文案渲染，占位符照抄真实现的规则 */
const tZh = (key, params) =>
  zh[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    typeof params?.[name] === 'string' || typeof params?.[name] === 'number'
      ? String(params[name])
      : placeholder
  )

const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

const sessionFile = ({ id, title, messages, imagePath }) => {
  const list = [...messages]
  if (imagePath) {
    list[0] = {
      ...list[0],
      fragments: [
        ...list[0].fragments,
        {
          type: 'FILE',
          files: [
            {
              id: imagePath.slice(imagePath.lastIndexOf('/') + 1, imagePath.lastIndexOf('_')),
              file_name: 'image.png',
              file_size: 128,
              token_usage: null,
              inserted_at: TIME,
              export_path: imagePath,
              is_image: true,
              width: 512,
              height: 512,
            },
          ],
        },
      ],
    }
  }
  return strToU8(
    JSON.stringify({
      id,
      title,
      pinned: false,
      current_message_id: list.length === 0 ? 1 : list[list.length - 1].id,
      inserted_at: TIME,
      updated_at: TIME,
      messages: list,
    })
  )
}

const indexOf = (sessions) =>
  strToU8(
    JSON.stringify(
      sessions.map(({ id, title }) => ({
        id,
        title,
        pinned: false,
        message_count: 2,
        inserted_at: TIME,
        updated_at: TIME,
      }))
    )
  )

const pngBytes = () => {
  const bytes = new Uint8Array(128)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

const manifest = () => strToU8(JSON.stringify({ export_format_version: 3 }))

const fileOf = (entries) =>
  new File([zipSync(Object.fromEntries(entries), { level: 0 })], 'deepseek_data.zip', {
    type: 'application/zip',
  })

/** 部分合法 + 部分不可识别：s1/s2 完好，s3 悬空父消息（截断），s4 整会话无法构造 */
const brokenArchive = async () => {
  await db.clearStaging()
  const s4Image = 'chat_sessions/s4_files/f4_image.png'
  const file = fileOf([
    ['manifest.json', manifest()],
    [
      'chat_sessions/s1.json',
      sessionFile({
        id: 's1',
        title: '完好会话一',
        messages: [message(1, null, 'USER', '问题一'), message(2, 1, 'ASSISTANT', '回答一')],
      }),
    ],
    [
      'chat_sessions/s2.json',
      sessionFile({
        id: 's2',
        title: '完好会话二',
        messages: [message(1, null, 'USER', '问题二'), message(2, 1, 'ASSISTANT', '回答二')],
      }),
    ],
    [
      'chat_sessions/s3.json',
      sessionFile({
        id: 's3',
        title: '悬空父消息会话',
        messages: [message(1, null, 'USER', '问题三'), message(2, 99, 'ASSISTANT', '回答三')],
      }),
    ],
    [
      'chat_sessions/s4.json',
      sessionFile({
        id: 's4',
        title: '整会话损坏',
        messages: [message(1, 7, 'ASSISTANT', '无主的回答')],
        imagePath: s4Image,
      }),
    ],
    [
      'chat_session_index.json',
      indexOf([
        { id: 's1', title: '完好会话一' },
        { id: 's2', title: '完好会话二' },
        { id: 's3', title: '悬空父消息会话' },
        { id: 's4', title: '整会话损坏' },
      ]),
    ],
    [s4Image, pngBytes()],
  ])
  return { file, result: await importArchive(file) }
}

test('[1] 部分合法 + 部分不可识别：3 个会话入库，skipped 带出消息与会话两级定位', async () => {
  const { result } = await brokenArchive()

  assert.equal(
    db.stagingSessions.map((session) => session.id).join(','),
    's1,s2,s3',
    '完好的 s1/s2 与截断后的 s3 必须入库，整会话损坏的 s4 跳过'
  )
  assert.ok(Array.isArray(result?.skipped), `importArchive 必须带回 skipped（实际 ${typeof result?.skipped}）`)
  assert.equal(
    result.skipped.length,
    4,
    `skipped 应有 4 条（s3 消息 + s3 分支定位 + s4 消息 + s4 会话），实际 ${result.skipped.length}`
  )

  const located = result.skipped.map(
    (entry) => `${entry.scope}:${entry.sessionId}${entry.messageId === null ? '' : `#${entry.messageId}`}`
  )
  assert.deepEqual(
    located,
    ['message:s3#2', 'branch:s3#2', 'message:s4#1', 'session:s4'],
    '每个跳过条目都要能定位到会话 id / 消息 id，整会话损坏时给会话级条目'
  )

  const s3Message = result.skipped[0]
  assert.equal(s3Message.sessionTitle, '悬空父消息会话', '要带出会话标题，用户才认得出是哪个会话')
  assert.equal(s3Message.reason, 'backupInvalidBranches')
  assert.equal(s3Message.parentId, '99', '消息级条目要带出缺失的父消息 id')

  assert.equal(result.skipped[1].scope, 'branch', '当前分支指向被丢弃的消息时，要单独给一条分支级定位')
  assert.equal(result.skipped[1].sessionId, 's3')

  const s4Session = result.skipped[3]
  assert.equal(s4Session.scope, 'session', '整个会话无法构造时要有一条会话级 skipped')
  assert.equal(s4Session.sessionId, 's4')
  assert.equal(s4Session.messageId, null)
})

test('[2] 完全不损坏的包：skipped 为空，导入行为与现在一致', async () => {
  await db.clearStaging()
  const file = fileOf([
    ['manifest.json', manifest()],
    [
      'chat_sessions/ok.json',
      sessionFile({
        id: 'ok',
        title: '完好会话',
        messages: [message(1, null, 'USER', '问题'), message(2, 1, 'ASSISTANT', '回答')],
      }),
    ],
    ['chat_session_index.json', indexOf([{ id: 'ok', title: '完好会话' }])],
  ])
  const result = await importArchive(file)

  assert.equal(result?.skipped?.length ?? 0, 0, '没有坏数据时 skipped 必须是空的，不能凭空报警')
  assert.equal(db.stagingSessions.length, 1)
})

test('[3] UI 层拿真实 skipped 渲染：条数、会话标题、消息 id、原因文案都在', async () => {
  const { result } = await brokenArchive()
  const { ImportSkippedDetails } = await import('../../src/components/settings/importSkipped.ts')

  const html = renderToStaticMarkup(createElement(ImportSkippedDetails, { skipped: result.skipped, t: tZh }))

  assert.match(html, /data-skipped-entry/g, 'UI 必须真的把跳过条目渲染成节点，不能只是存着')
  assert.equal(
    [...html.matchAll(/data-skipped-entry="/g)].length,
    result.skipped.length,
    '每条 skipped 都要有一行'
  )
  assert.match(html, /跳过了 4 处/, `标题要给出条数：${html}`)
  assert.ok(html.includes('悬空父消息会话'), '要渲染出会话标题，用户才知道是哪个会话坏了')
  assert.ok(html.includes('整会话损坏'), '整会话被跳过时也要点名是哪个会话')
  assert.ok(html.includes('#2'), '要渲染出消息 id')
  assert.ok(html.includes('#99'), '要渲染出缺失的父消息 id')
  assert.ok(
    html.includes(zh.historyImportSkipReasonBranches),
    `要渲染出人话原因（缺 ${zh.historyImportSkipReasonBranches}）：${html}`
  )
  assert.ok(html.includes(zh.historyImportSkippedHint), '要说明其余会话已正常导入，别让人以为整包失败')
})

test('[4] 放宽但不放水：索引里列了、包里却没有的会话仍然整包失败（backupIncomplete）', async () => {
  await db.clearStaging()
  const file = fileOf([
    ['manifest.json', manifest()],
    [
      'chat_sessions/s1.json',
      sessionFile({
        id: 's1',
        title: '完好会话一',
        messages: [message(1, null, 'USER', '问题一')],
      }),
    ],
    [
      'chat_session_index.json',
      indexOf([
        { id: 's1', title: '完好会话一' },
        { id: 'ghost', title: '索引里有、包里没有' },
      ]),
    ],
  ])

  await assert.rejects(
    () => importArchive(file),
    (error) => {
      assert.equal(error.key, 'backupIncomplete', `缺会话文件必须是 backupIncomplete，实际 ${error.key}`)
      return true
    },
    '索引列出的会话一个都不能少，缺了就是文件不完整——不能因为「跳过也允许」就把缺失也放过'
  )
})

test('[5] 新增文案 zh / en 成对、占位符对齐、en 下无中文，既有 key 未被删改', async () => {
  const keys = [
    'historyImportedPartial',
    'historyImportSkippedTitle',
    'historyImportSkippedHint',
    'historyImportSkipScopeSession',
    'historyImportSkipScopeMessage',
    'historyImportSkipScopeBranch',
    'historyImportSkipWhereSession',
    'historyImportSkipWhereMessage',
    'historyImportSkipWhereBranch',
    'historyImportSkipMissingParent',
    'historyImportSkipReasonBranches',
    'historyImportSkipReasonFiles',
  ]
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} 文案不能为空`)
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符必须一一对应`)
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en.${key} 不许出现中文：${en[key]}`)
  }

  // 既有文案一个字都不许动：本次只追加「跳过」相关的几条
  assert.equal(zh.historyImported, '已导入 {count} 个会话')
  assert.equal(en.historyImported, 'Imported {count} chats')
  assert.equal(zh.backupInvalidBranches, '文件中的消息分支已损坏，无法导入')
  assert.equal(en.backupInvalidBranches, 'The message branches in this file are corrupted and cannot be imported.')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
})
