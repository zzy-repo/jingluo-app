// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #909（2/5 原生瘦快照）：saveSession 成功后把「会话文本 + 摘要」经 AppFileSystem.writeAtomic
// 写到 snapshots/<ts>.json（版本号、会话数、sha256），保留最近 5 份；非 native 返回 unsupported；
// 写失败不影响主流程。
//
//   [S1] 写入内容：含会话文本 / 摘要 / 版本 / 会话数 / 校验和，不含附件字节（只留元信息）
//   [S2] 轮转：写 7 份只留最近 5 份，且留下的是最新的
//   [S3] 节流：15s 内第二次返回 throttled，flush 绕过
//   [S4] 非 native：返回 { status: 'unsupported' }，不写、不抛、不记日志
//   [F1] ENOSPC：返回 quota，旧快照完好，主流程（afterSave）不抛
//   [F2] 写到一半崩溃：返回 failed，不留半成品，旧快照完好
//   [F3] 校验和损坏 / 半截 JSON / 版本不认识：read 返回 null 并记诊断
//   [F4] 轮转时 remove 失败：新快照已写成，结果仍是 written 之外的可区分状态（failed），不吞掉
//
// 负向对照：SNAPSHOT_KEEP 的 slice(SNAPSHOT_KEEP - 1) 改成 slice(SNAPSHOT_KEEP) → S2 变红；
// parseSnapshot 里跳过校验和比较 → F3 变红。
//
//   node tests/run-layer.mjs unit --only protection-snapshot-909
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtection, makeSession, records, resetRecords, setupProtection } from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { SNAPSHOT_DIR, SNAPSHOT_KEEP, SNAPSHOT_MIN_INTERVAL_MS, parseSnapshot, resetProtectionDiagnosticsForTests } = P

const setup = (options = {}) => {
  resetProtectionDiagnosticsForTests()
  resetRecords()
  return setupProtection(P, { sessions: [makeSession('a'), makeSession('b')], ...options })
}
const names = async (env) => (await env.fs.list(SNAPSHOT_DIR)).map((entry) => entry.name)

test('S1 写入内容：文本 + 摘要 + 版本 + 会话数 + 校验和，不含附件字节', async () => {
  const env = setup()
  const result = await env.protection.snapshots.write()
  assert.equal(result.status, 'written')
  assert.equal(result.sessions, 2)
  const text = await env.fs.readText(`${SNAPSHOT_DIR}/${result.file}`)
  const file = await parseSnapshot(text)
  assert.ok(file, '写出去的快照必须能通过自己的校验')
  assert.deepEqual(
    { v: file.v, sessions: file.sessions, schema: file.schema, at: file.at, summaries: file.summaries.length },
    { v: 1, sessions: 2, schema: 15, at: env.now.value, summaries: 2 }
  )
  const user = file.data[0].messages[0]
  assert.equal(user.content, '你好 a')
  assert.deepEqual(user.files, [{ id: 'a-f1', name: 'a.png', size: 12, isImage: true }], '附件只留元信息')
  assert.equal(file.data[0].messages[1].text, '回答 a')
  assert.doesNotMatch(text, /base64|blob|mimeType/u, '快照里不得出现附件字节 / blob 相关字段')
})

test('S2 轮转：写 7 份只留最近 5 份，留下的是最新的', async () => {
  const env = setup()
  const written = []
  for (let index = 0; index < 7; index += 1) {
    env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
    const result = await env.protection.snapshots.write()
    assert.equal(result.status, 'written')
    written.push(result.file)
  }
  const kept = (await names(env)).sort()
  assert.equal(kept.length, SNAPSHOT_KEEP)
  assert.deepEqual(kept, written.slice(-SNAPSHOT_KEEP).sort())
})

test('S3 节流：15s 内第二次 throttled，flush 绕过', async () => {
  const env = setup()
  assert.equal((await env.protection.snapshots.write()).status, 'written')
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS - 1
  assert.equal((await env.protection.snapshots.write()).status, 'throttled')
  assert.equal((await names(env)).length, 1)
  env.now.value += 1
  const forced = await env.protection.snapshots.write({ force: true })
  assert.equal(forced.status, 'written')
  assert.equal((await names(env)).length, 2)
})

test('S4 非 native：unsupported，不写、不抛、不记日志', async () => {
  const env = setup({ native: false })
  const result = await env.protection.snapshots.write()
  assert.deepEqual(result, { status: 'unsupported' })
  assert.equal(records().length, 0, 'Web 端不得产生噪音日志')
  assert.equal(await env.protection.afterSave().then((value) => value?.status), 'unsupported')
})

test('F1 ENOSPC：返回 quota，旧快照完好，afterSave 不抛', async () => {
  const env = setup()
  const first = await env.protection.snapshots.write()
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  env.fs.injectEnospc()
  const failed = await env.protection.snapshots.write()
  assert.deepEqual({ status: failed.status, kind: failed.kind }, { status: 'quota', kind: 'quota' })
  assert.deepEqual(await names(env), [first.file], '失败不得动旧快照')
  assert.deepEqual(env.fs.tempFiles(), [], '失败不留半成品')
  assert.ok(await parseSnapshot(await env.fs.readText(`${SNAPSHOT_DIR}/${first.file}`)))
  assert.ok(records().some((entry) => entry.message === 'protection.snapshot-write failed'), '失败要留一条诊断')
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  env.fs.injectEnospc()
  await assert.doesNotReject(() => env.protection.afterSave())
})

test('F2 写到一半崩溃：failed，不留半成品，旧快照完好', async () => {
  const env = setup()
  const first = await env.protection.snapshots.write()
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  env.fs.injectCrashMidWrite()
  const failed = await env.protection.snapshots.write()
  assert.equal(failed.status, 'failed')
  assert.deepEqual(await names(env), [first.file])
  assert.deepEqual(env.fs.tempFiles(), [])
})

test('F3 损坏快照：校验和不过 / 半截 JSON / 未知版本都读成 null，并记诊断', async () => {
  const env = setup()
  const { file } = await env.protection.snapshots.write()
  const path = `${SNAPSHOT_DIR}/${file}`
  const good = await env.fs.readText(path)
  assert.ok(await env.protection.snapshots.read(file))

  const flipped = good.replace('你好 a', '你好 X')
  await env.fs.writeAtomic(path, flipped)
  assert.equal(await env.protection.snapshots.read(file), null, '改一个字：校验和不过')

  await env.fs.writeAtomic(path, good.slice(0, Math.floor(good.length / 2)))
  assert.equal(await env.protection.snapshots.read(file), null, '半截 JSON')

  await env.fs.writeAtomic(path, good.replace('"v":1', '"v":99'))
  assert.equal(await env.protection.snapshots.read(file), null, '未知版本')

  const mismatch = JSON.parse(good)
  mismatch.sessions = 5
  assert.equal(await parseSnapshot(JSON.stringify(mismatch)), null, '会话数与数据条数对不上')
  assert.ok(records().some((entry) => entry.message === 'protection.snapshot-read failed'))
})

test('F4 轮转时 remove 失败：新快照已写成，但结果必须可区分（failed），不吞掉', async () => {
  const env = setup()
  for (let index = 0; index < SNAPSHOT_KEEP; index += 1) {
    env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
    await env.protection.snapshots.write()
  }
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  const remove = env.fs.remove
  env.fs.remove = async () => {
    throw new P.FsError('unavailable', 'injected remove failure')
  }
  const result = await env.protection.snapshots.write()
  env.fs.remove = remove
  assert.equal(result.status, 'failed')
  assert.equal((await names(env)).length, SNAPSHOT_KEEP + 1, '新快照在，旧的没删掉；下一次会补轮转')
  env.now.value += SNAPSHOT_MIN_INTERVAL_MS + 1
  assert.equal((await env.protection.snapshots.write()).status, 'written')
  assert.equal((await names(env)).length, SNAPSHOT_KEEP)
})
