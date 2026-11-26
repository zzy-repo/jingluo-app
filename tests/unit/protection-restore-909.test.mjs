// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #909（4/5 异常恢复）：从快照恢复 —— 列出 / 校验和通过才允许 / 先把当前状态备份成「恢复前」/
// 走整包替换通道 / 可取消 / 失败不破坏现状 / 恢复后更新高水位。
//
//   [R1] 库已空（被系统清除）：恢复出全部会话，文本一致，附件只剩元信息，进行中的回复变「已停止」
//   [R2] 库里有数据：先写 pre-restore 备份（含当前状态），再替换；备份与自动快照分开轮转
//   [R3] 校验和不过 → corrupt，不碰数据、不备份、不进提交通道
//   [R4] 快照来自更新的库版本 → incompatible，不碰数据
//   [R5] 取消（暂存阶段）→ cancelled，旧数据完好，暂存已清
//   [F1] 备份失败（ENOSPC）→ backup-failed，旧数据完好，没有写任何暂存
//   [F2] 写暂存到一半失败 → failed，旧数据完好
//   [F3] 提交失败 → failed，旧数据完好
//   [L1] 列表：损坏的快照标 invalid 不隐藏；Web 返回空
//   [H1] 判定丢失后暂停自动快照（不把旧快照轮转掉）；恢复并确认后重新开始，高水位按恢复后的数更新
//
// 负向对照：去掉恢复前备份 → R2 变红；去掉取消检查 → R5 变红；read 不校验 → R3 变红。
//
//   node tests/run-layer.mjs unit --only protection-restore-909
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtection, makeCommit, makeSession, resetRecords, setupProtection } from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { SNAPSHOT_DIR, SNAPSHOT_MIN_INTERVAL_MS, resetProtectionDiagnosticsForTests, sessionFromSnapshot, toSnapshotSession } = P

const setup = (options = {}) => {
  resetProtectionDiagnosticsForTests()
  resetRecords()
  const env = setupProtection(P, { sessions: [makeSession('a'), makeSession('b'), makeSession('c')], ...options })
  return env
}

/** 先按当前库状态写一份快照，再把库清空（模拟被系统清除） */
const snapshotThenWipe = async (env) => {
  const { file } = await env.protection.snapshots.write()
  const saved = env.state.sessions
  env.state.sessions = []
  return { file, saved }
}

const names = async (env) => (await env.fs.list(SNAPSHOT_DIR)).map((entry) => entry.name).sort()

test('R1 库已空：恢复全部会话；文本一致，附件只剩元信息，进行中的回复变「已停止」', async () => {
  const env = setup()
  env.state.sessions[0].messages[1].status = 'streaming'
  env.state.sessions[0].rootMessageId = 'a-u1'
  env.state.sessions[1].branchOf = { sessionId: 'a', createdAt: 5 }
  const { file } = await snapshotThenWipe(env)
  const stages = []
  const result = await env.protection.restore(file, {
    commit: makeCommit(env.state),
    onProgress: (progress) => stages.push(`${progress.stage}:${progress.done}/${progress.total}`),
  })
  assert.deepEqual(result, { status: 'restored', sessions: 3, backup: null })
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['a', 'b', 'c'])
  const a = env.state.sessions[0]
  assert.equal(a.messages[0].content, '你好 a')
  assert.deepEqual(a.messages[0].files, [{ id: 'a-f1', serverId: null, name: 'a.png', size: 12, isImage: true, mimeType: '' }])
  assert.equal(a.messages[1].blocks[0].text, '回答 a')
  assert.equal(a.messages[1].status, 'stopped', '快照时还在生成的回复不能凭空变回 streaming')
  assert.equal(a.rootMessageId, 'a-u1')
  assert.deepEqual(env.state.sessions[1].branchOf, { sessionId: 'a', createdAt: 5 })
  assert.deepEqual(stages, ['verify:0/1', 'backup:0/1', 'stage:1/3', 'stage:2/3', 'stage:3/3', 'commit:0/1', 'commit:1/1'])
})

test('R2 库里有数据：先写 pre-restore 备份（含当前状态）再替换；备份不挤占自动快照名额', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('new1'), makeSession('new2')]
  const result = await env.protection.restore(file, { commit: makeCommit(env.state) })
  assert.equal(result.status, 'restored')
  assert.match(result.backup, /^pre-restore-\d+\.json$/u)
  const backup = await env.protection.snapshots.read(result.backup)
  assert.deepEqual(backup.data.map((session) => session.id), ['new1', 'new2'], '备份的是替换前的当前状态')
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['a', 'b', 'c'])
  // 备份单独保留 2 份，自动快照仍在
  for (let index = 0; index < 3; index += 1) {
    env.now.value += 1000
    env.state.sessions = [makeSession(`x${index}`)]
    await env.protection.restore(file, { commit: makeCommit(env.state) })
  }
  const all = await names(env)
  assert.equal(all.filter((name) => name.startsWith('pre-restore-')).length, 2)
  assert.ok(all.includes(file), '自动快照不被「恢复前」备份挤掉')
})

test('R3 校验和不过：corrupt，不备份、不进提交通道、数据不动', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  const path = `${SNAPSHOT_DIR}/${file}`
  await env.fs.writeAtomic(path, (await env.fs.readText(path)).replace('你好 a', '你好 X'))
  let committed = false
  const result = await env.protection.restore(file, {
    commit: async (write) => {
      committed = true
      return makeCommit(env.state)(write)
    },
  })
  assert.deepEqual(result, { status: 'corrupt' })
  assert.equal(committed, false)
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'])
  assert.deepEqual((await names(env)), [file], '没有生成任何备份')
})

test('R4 快照来自更新的库版本：incompatible，不碰数据', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  const path = `${SNAPSHOT_DIR}/${file}`
  const parsed = JSON.parse(await env.fs.readText(path))
  delete parsed.checksum
  parsed.schema = 99
  parsed.checksum = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
  await env.fs.writeAtomic(path, JSON.stringify(parsed))
  assert.deepEqual(await env.protection.restore(file, { commit: makeCommit(env.state) }), { status: 'incompatible' })
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'])
})

test('R5 取消：暂存阶段中止 → cancelled，旧数据完好，暂存已清', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  const controller = new AbortController()
  const result = await env.protection.restore(file, {
    signal: controller.signal,
    commit: makeCommit(env.state),
    onProgress: (progress) => {
      if (progress.stage === 'stage' && progress.done === 1) {
        controller.abort()
      }
    },
  })
  assert.deepEqual(result, { status: 'cancelled' })
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'])
  assert.deepEqual(env.state.staging, [], '取消后暂存必须清空')
  const early = new AbortController()
  early.abort()
  assert.deepEqual(await env.protection.restore(file, { signal: early.signal, commit: makeCommit(env.state) }), { status: 'cancelled' })
})

test('F1 备份失败（ENOSPC）：backup-failed，旧数据完好，没写任何暂存', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  env.fs.injectEnospc()
  const result = await env.protection.restore(file, { commit: makeCommit(env.state) })
  assert.deepEqual(result, { status: 'backup-failed', kind: 'quota' })
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'])
  assert.deepEqual(env.state.staging, [])
})

test('F2 写暂存到一半失败：failed，旧数据完好', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  let calls = 0
  const commit = async (write) => {
    env.state.staging = []
    const push = env.state.staging.push.bind(env.state.staging)
    env.state.staging.push = (...items) => {
      calls += 1
      if (calls === 2) {
        throw new Error('injected stage failure')
      }
      return push(...items)
    }
    try {
      await write()
    } catch (error) {
      env.state.staging = []
      throw error
    }
  }
  const result = await env.protection.restore(file, { commit })
  assert.equal(result.status, 'failed')
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'], '半途失败不得留下半个库')
  assert.deepEqual(env.state.staging, [])
})

test('F3 提交失败：failed，旧数据完好', async () => {
  const env = setup()
  const { file } = await snapshotThenWipe(env)
  env.state.sessions = [makeSession('keep')]
  const result = await env.protection.restore(file, { commit: makeCommit(env.state, { failAfterWrite: true }) })
  assert.equal(result.status, 'failed')
  assert.deepEqual(env.state.sessions.map((session) => session.id), ['keep'])
})

test('L1 列表：损坏的快照标 invalid 不隐藏；Web 返回空', async () => {
  const env = setup()
  const first = await env.protection.snapshots.write()
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  const second = await env.protection.snapshots.write()
  await env.fs.writeAtomic(`${SNAPSHOT_DIR}/${first.file}`, '{"v":1,')
  const listed = await env.protection.listRestorable()
  assert.deepEqual(
    listed.map((item) => ({ name: item.name, valid: item.valid, sessions: item.sessions })),
    [
      { name: second.file, valid: true, sessions: 3 },
      { name: first.file, valid: false, sessions: null },
    ],
    '新的在前；损坏的也列出来'
  )
  const web = setup({ native: false })
  assert.deepEqual(await web.protection.listRestorable(), [])
})

test('H1 判定丢失后暂停自动快照；恢复并确认后重新开始，高水位按恢复后的数更新', async () => {
  const env = setup()
  await env.protection.afterSave()
  const before = await names(env)
  assert.equal(before.length, 1)
  env.state.sessions = []
  assert.ok(await env.protection.checkAtStartup(), '库从有到无')
  env.state.sessions = [makeSession('fresh')]
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  assert.equal((await env.protection.afterSave({ flush: true }))?.status, 'suspended')
  assert.deepEqual(await names(env), before, '暂停期间不写新快照，旧快照不被轮转')
  // 用户恢复
  const result = await env.protection.restore(before[0], { commit: makeCommit(env.state) })
  assert.equal(result.status, 'restored')
  await env.protection.afterExplicitChange()
  assert.equal((await env.protection.highwater.read()).mark.sessions, 3)
  assert.equal((await env.protection.highwater.read()).mark.lost, undefined)
  assert.equal(await env.protection.checkAtStartup(), null)
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  assert.equal((await env.protection.afterSave())?.status, 'written', '确认后自动快照恢复')
})

test('S1 sessionFromSnapshot 对 toSnapshotSession 往返：文本 / 分支元数据不丢', () => {
  const original = makeSession('z', { pinnedAt: 7, customSystemPrompt: '提示' })
  const back = sessionFromSnapshot(toSnapshotSession(original))
  assert.equal(back.pinnedAt, 7)
  assert.equal(back.customSystemPrompt, '提示')
  assert.deepEqual(back.messages.map((message) => message.id), original.messages.map((message) => message.id))
  assert.equal(back.messages[0].content, original.messages[0].content)
})
