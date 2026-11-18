// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB 边界用假 db 替身） | 耗时: <20s] Issue #153
//
// 「导入加固」四条缺口，一条一组断言 + 组内反向用例（不许为了加固把正常包误杀）：
//   [1] 条目顺序敏感：chat_session_index.json 排在会话文件之前时，整包被判「内容不完整」
//   [2] 同名条目被折叠成「ZIP 结构损坏」，提示从不说「重复」，用户无法自查
//   [3] 没有解压上限：几十 KB 的条目能解出几十 MB～几 GB（只有 8KB 分块流式，靠内存兜底）
//   [4] 条目名没有长度上限：60000 字节的名字也一路进到路径校验
//
//   node tests/unit/import-hardening.test.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 假 db：IndexedDB 在裸 Node 里不存在，只替换存储边界，importArchive 本身全是真实代码。
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const stagingSessions = []
export const addStagingSession = async (session) => {
  stagingSessions.push(session)
}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const clearStaging = async () => {
  stagingSessions.length = 0
}
globalThis.__hardeningDB = { stagingSessions, clearStaging }
`)}`

// 真实 errors.ts 用了 TS 参数属性（node 的 strip-only 模式不支持），用仓库既有的等价替身：
// key / params 原样带出，message 用真实 zh 文案渲染。
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './errors.js') {
      return { url: errorsStub, shortCircuit: true }
    }
    if (specifier === '../db.js' && String(context.parentURL ?? '').endsWith('/history/importArchive.ts')) {
      return { url: fakeDB, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { strToU8 } = await import('fflate')
const { buildZip } = await import('../adversarial/lib/zip.mjs')
const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { listArchivePaths } = await import('../../src/services/chat/history/zipReader.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const db = globalThis.__hardeningDB

const TIME = '2026-11-01T00:00:00.000Z'
const MB = 1024 * 1024

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

const sessionBytes = (id, content) =>
  strToU8(
    JSON.stringify({
      id,
      title: id,
      pinned: false,
      current_message_id: 2,
      inserted_at: TIME,
      updated_at: TIME,
      messages: [
        message(1, null, 'USER', `${id} 的问题`),
        message(2, 1, 'ASSISTANT', content ?? `${id} 的回答`),
      ],
    })
  )

const manifestBytes = () => strToU8(JSON.stringify({ export_format_version: 3 }))

const indexBytes = (ids) =>
  strToU8(
    JSON.stringify(
      ids.map((id) => ({
        id,
        title: id,
        pinned: false,
        message_count: 2,
        inserted_at: TIME,
        updated_at: TIME,
      }))
    )
  )

/**
 * entries 是 [名字, 字节] 的有序数组：ZIP 条目顺序就是导入端看到的顺序，同名条目也不会被合并
 * （fflate 的 zipSync 会规范化名字并去重，构造不出「重复条目」，所以借用对抗层的 buildZip）。
 * compress=true 时逐条目 deflate 压缩（用来构造高压缩比 / 声明尺寸撒谎的包）。
 */
const archiveOf = (entries, compress = false) =>
  new File(
    [
      buildZip(
        entries.map(([name, data]) => ({
          name,
          data,
          compress,
        }))
      ),
    ],
    'deepseek_data.zip',
    { type: 'application/zip' }
  )

/** 正常导出的骨架：manifest 第一，会话若干，index 一个。 */
const normalArchive = (ids, extra = []) =>
  archiveOf([
    ['manifest.json', manifestBytes()],
    ...ids.map((id) => [`chat_sessions/${id}.json`, sessionBytes(id)]),
    ['chat_session_index.json', indexBytes(ids)],
    ...extra,
  ])

const run = async (file) => {
  await db.clearStaging()
  try {
    await importArchive(file)
    return { failed: false, error: null }
  } catch (error) {
    return { failed: true, error }
  }
}

// —— 缺口 1：条目顺序敏感 ——
test('缺口 1：index 排在会话文件之前 → 整包照常导入（顺序不是格式的一部分）', async () => {
  const indexFirst = archiveOf([
    ['manifest.json', manifestBytes()],
    ['chat_session_index.json', indexBytes(['s1', 's2'])],
    ['chat_sessions/s1.json', sessionBytes('s1')],
    ['chat_sessions/s2.json', sessionBytes('s2')],
  ])
  const { failed, error } = await run(indexFirst)
  assert.equal(failed, false, `index 先到不该判「内容不完整」（实际 ${error?.key}: ${error?.message}）`)
  assert.equal(db.stagingSessions.length, 2, '两个会话都要进暂存')
  assert.deepEqual(
    db.stagingSessions.map((session) => session.id).sort(),
    ['s1', 's2']
  )
})

test('缺口 1（反向）：标准顺序 manifest → 会话 → index 仍然成功，没被改坏', async () => {
  const { failed, error } = await run(normalArchive(['s1', 's2']))
  assert.equal(failed, false, `正常顺序必须继续可用（实际 ${error?.key}: ${error?.message}）`)
  assert.equal(db.stagingSessions.length, 2)
})

test('缺口 1（反向）：index 先到 + 会话后跟自己的图片目录，图片照样落到会话上', async () => {
  const imagePath = 'chat_sessions/s1_files/f1_image.png'
  const png = new Uint8Array(128)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const { failed, error } = await run(
    archiveOf([
      ['manifest.json', manifestBytes()],
      ['chat_session_index.json', indexBytes(['s1'])],
      ['chat_sessions/s1.json', sessionBytes('s1')],
      [imagePath, png],
    ])
  )
  assert.equal(failed, false, `index 先到、图片在会话之后必须成功（实际 ${error?.key}: ${error?.message}）`)
  assert.equal(db.stagingSessions.length, 1, '只认索引里的那一个会话')
})

// —— 缺口 2：同名条目 ——
test('缺口 2：同名条目 → backupEntryDuplicated，带出冲突路径，提示里点明「重复」', async () => {
  const { failed, error } = await run(
    archiveOf([
      ['manifest.json', manifestBytes()],
      ['manifest.json', manifestBytes()],
      ['chat_sessions/s1.json', sessionBytes('s1')],
    ])
  )
  assert.equal(failed, true, '同名条目必须拒绝，不能后一个覆盖前一个')
  assert.equal(
    error?.key,
    'backupEntryDuplicated',
    `要给出「重复」这个独立错误码（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(error?.params?.entry, 'manifest.json', '要带出是哪条路径重复了')
  assert.match(error.message, /重复/, '提示要让用户看懂是重名，而不是「文件被截断」')
  assert.match(error.message, /manifest\.json/, '提示里要有冲突路径')
  assert.equal(db.stagingSessions.length, 0, '拒绝时不许写入任何暂存')
})

test('缺口 2：目录与文件同名（a/ 与 a）也算重复', async () => {
  const { failed, error } = await run(
    archiveOf([
      ['manifest.json', manifestBytes()],
      ['chat_sessions/s1_files/', new Uint8Array()],
      ['chat_sessions/s1_files', strToU8('x')],
      ['chat_sessions/s1.json', sessionBytes('s1')],
    ])
  )
  assert.equal(failed, true, '目录与文件同名不能静默并存')
  assert.equal(error?.key, 'backupEntryDuplicated')
  assert.equal(error?.params?.entry, 'chat_sessions/s1_files')
})

test('缺口 2（反向）：没有重名的正常包不受影响', async () => {
  const { failed, error } = await run(normalArchive(['s1', 's2', 's3']))
  assert.equal(failed, false, `正常包不能被重复条目闸误杀（实际 ${error?.key}: ${error?.message}）`)
  assert.equal(db.stagingSessions.length, 3)
})

test('缺口 2：新文案 zh / en 成对、占位符对齐、en 下不出现中文', async () => {
  const key = 'backupEntryDuplicated'
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

  assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
  assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
  assert.deepEqual(placeholders(zh[key]), ['entry'], 'zh 占位符要与 params 对齐')
  assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), 'zh / en 占位符要一致')
  assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, 'en 下不能出现中文')
})

// —— 缺口 3：解压上限（压缩比 + 解压后总量）——
test('缺口 3：解压后 20MB 的高度可压缩条目 → 被解压闸拒绝，且不写入暂存', async () => {
  const padding = ' '.repeat(20 * MB)
  const bomb = strToU8(
    JSON.stringify({
      id: 'bomb',
      title: 'bomb',
      pinned: false,
      current_message_id: 2,
      inserted_at: TIME,
      updated_at: TIME,
      padding,
      messages: [message(1, null, 'USER', 'hi'), message(2, 1, 'ASSISTANT', 'ok')],
    })
  )
  const file = archiveOf(
    [
      ['manifest.json', manifestBytes()],
      ['chat_sessions/bomb.json', bomb],
      ['chat_session_index.json', indexBytes(['bomb'])],
    ],
    true
  )
  const { failed, error } = await run(file)
  assert.equal(failed, true, `压缩比 ~1000:1 的条目必须被挡住（包体只有 ${(file.size / 1024).toFixed(0)}KB）`)
  assert.equal(error?.name, 'BackupError')
  assert.equal(db.stagingSessions.length, 0, '拒绝时不许写入任何暂存')
})

test('缺口 3（反向）：10MB 全是同一字符的合法会话（比值高但体量小）照常导入', async () => {
  const content = 'y'.repeat(10 * MB)
  const file = archiveOf(
    [
      ['manifest.json', manifestBytes()],
      ['chat_sessions/huge.json', sessionBytes('huge', content)],
      ['chat_session_index.json', indexBytes(['huge'])],
    ],
    true
  )
  const { failed, error } = await run(file)
  assert.equal(
    failed,
    false,
    `小体量高压缩比是正常数据，不许误杀（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(db.stagingSessions.length, 1)
})

test('缺口 3（反向）：正常压缩比的包（3–10:1）照常导入', async () => {
  const first = await run(normalArchive(['s1', 's2']))
  assert.equal(first.failed, false, `不压缩的正常备份不能被解压闸误杀（实际 ${first.error?.key}）`)
  assert.equal(db.stagingSessions.length, 2)

  const compressed = archiveOf(
    [
      ['manifest.json', manifestBytes()],
      ['chat_sessions/s1.json', sessionBytes('s1')],
      ['chat_session_index.json', indexBytes(['s1'])],
    ],
    true
  )
  const second = await run(compressed)
  assert.equal(second.failed, false, `deflate 压缩的正常包必须成功（实际 ${second.error?.key}）`)
  assert.equal(db.stagingSessions.length, 1)
})

test('缺口 3（反向）：声明解压尺寸撒谎（4GB）→ 拒绝，且不按声明预分配', async () => {
  // 中央目录里把 manifest 条目的解压后尺寸写成 4GB，实际压缩数据只有几十字节。
  const liar = new File(
    [
      buildZip([
        { name: 'manifest.json', data: manifestBytes(), declaredSize: 4 * 1024 * MB },
        { name: 'chat_sessions/s1.json', data: sessionBytes('s1') },
        { name: 'chat_session_index.json', data: indexBytes(['s1']) },
      ]),
    ],
    'deepseek_data.zip',
    { type: 'application/zip' }
  )
  const rssBefore = process.memoryUsage().rss
  const { failed, error } = await run(liar)
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / MB
  assert.equal(failed, true, '声明尺寸撒谎必须拒绝')
  assert.equal(error?.name, 'BackupError')
  assert.ok(rssDeltaMb < 256, `不能按 4GB 声明预分配（ΔRSS ${rssDeltaMb.toFixed(0)}MB）`)
})

// —— 缺口 4：条目名长度上限 / BOM 前缀名归一化 ——
test('缺口 4：259 字节的条目名（正常长名）照常接受', async () => {
  const longName = `chat_sessions/${'a'.repeat(240)}.json`
  const file = archiveOf([
    ['manifest.json', manifestBytes()],
    [longName, sessionBytes('a'.repeat(240))],
    ['chat_session_index.json', indexBytes(['a'.repeat(240)])],
  ])
  const paths = await listArchivePaths(file)
  assert.equal(paths.length, 3)
  assert.ok(paths.includes(longName), '长名不能被误杀')
  const { failed, error } = await run(file)
  assert.equal(failed, false, `259 字节的名字在 1024 字节上限之内（实际 ${error?.key}）`)
})

test('缺口 4：60019 字节的条目名 → 超上限被拒绝，不再一路进到路径校验', async () => {
  const hugeName = `chat_sessions/${'b'.repeat(60000)}.json`
  const file = archiveOf([
    ['manifest.json', manifestBytes()],
    [hugeName, sessionBytes('b'.repeat(60000))],
  ])
  assert.deepEqual(await listArchivePaths(file), [], '目录都不该列出来')
  const { failed, error } = await run(file)
  assert.equal(failed, true, '60000 字节的条目名必须拒绝')
  assert.equal(error?.name, 'BackupError')
  assert.equal(error?.key, 'backupArchiveUnreadable', '目录读不出来：给出「读不到文件目录」而不是崩成普通 Error')
  assert.equal(db.stagingSessions.length, 0)
})

test('缺口 4：名字开头带 U+FEFF 的 manifest 归一化成 manifest.json 后照常导入', async () => {
  const file = archiveOf([
    ['\uFEFFmanifest.json', manifestBytes()],
    ['chat_sessions/s1.json', sessionBytes('s1')],
    ['chat_session_index.json', indexBytes(['s1'])],
  ])
  const paths = await listArchivePaths(file)
  assert.deepEqual(paths, ['manifest.json', 'chat_sessions/s1.json', 'chat_session_index.json'])
  const { failed, error } = await run(file)
  assert.equal(failed, false, `BOM 前缀的 manifest 要被当成 manifest.json（实际 ${error?.key}）`)
  assert.equal(db.stagingSessions.length, 1)
})
