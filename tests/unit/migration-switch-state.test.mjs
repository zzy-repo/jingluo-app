// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <3s]
//
// #916：状态文件读写、校验和、损坏/缺失、双见证收敛规则（纯函数）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEnv, mods, sha256 } from '../helpers/migration-switch/kit.mjs'

// 本文件守的是「开关值只能被有意识地改动」。
// main 上必须是 false（合并不改变线上行为）：本 PR 把内测分支的交互补全搬进 main，
// 但迁移开关保持关闭，只有内测 APK 分支才是 true。
// 任何人翻转 config.ts 时必须同步来这里翻转 EXPECTED_SWITCH，
// 这就是双写校验的意义：让"无意翻转"变红，让"有意翻转"留下痕迹。
const EXPECTED_SWITCH = false // ← main 口径：不向全量用户开启迁移（内测分支为 true）

const { reconcileWitnesses, freshState, createStateStore, parseMigrationState } = mods.state
const T = 5000
const at = (phase, extra = {}) => ({ ...freshState(1), phase, seq: 3, ...extra })
test('开关值与 EXPECTED_SWITCH 一致（防无意翻转：翻 config.ts 必须同步翻测试里的 EXPECTED_SWITCH）', () => {
  assert.equal(mods.config.NATIVE_SQLITE_MIGRATION_ENABLED, EXPECTED_SWITCH)
})

test('规则1：状态文件缺失 + SQLite 有 committed_at → 以 SQLite 为真源并重建 committed', () => {
  const out = reconcileWitnesses(undefined, { committedAt: '4242' }, T)
  assert.equal(out.kind, 'rebuild-committed')
  assert.equal(out.state.phase, 'committed')
  // 负向对照：SQLite 没有见证 → 不得凭空 committed
  assert.equal(reconcileWitnesses(undefined, {}, T).kind, 'use')
  assert.equal(reconcileWitnesses(undefined, {}, T).state.phase, 'idle')
})

test('规则2：状态文件损坏 + SQLite 无 committed → idle 且保留损坏文件', () => {
  assert.deepEqual(reconcileWitnesses({ corrupt: true }, {}, T), { kind: 'idle-keep-corrupt' })
  // 库文件根本不存在也一样
  assert.deepEqual(reconcileWitnesses({ corrupt: true }, { absent: true }, T), { kind: 'idle-keep-corrupt' })
})

test('规则3：两处见证矛盾 → blocked，不猜（逐种矛盾）', () => {
  const cases = [
    [at('committed'), {}, 'state-file-committed-but-sqlite-meta-missing'],
    [at('copying'), { committedAt: '1' }, 'state-file-copying-but-sqlite-meta-committed'],
    [at('failed'), { committedAt: '1' }, 'state-file-failed-but-sqlite-meta-committed'],
    [at('idle'), { committedAt: '1' }, 'state-file-idle-but-sqlite-meta-committed'],
    [{ corrupt: true }, { committedAt: '1' }, 'state-file-corrupt-and-sqlite-meta-committed'],
    [{ corrupt: true }, { unavailable: true }, 'state-file-corrupt-and-sqlite-unreadable'],
    [undefined, { unavailable: true }, 'state-file-missing-and-sqlite-unreadable'],
  ]
  for (const [file, witness, detail] of cases) {
    assert.deepEqual(reconcileWitnesses(file, witness, T), { kind: 'blocked', detail })
  }
})

test('例外：verified + meta 已 committed 且指纹一致 = 写 meta 与写状态之间被杀，补写而不是矛盾', () => {
  const file = at('verified', { sourceFingerprint: 'fp' })
  assert.equal(reconcileWitnesses(file, { committedAt: '1', migratedFrom: 'fp' }, T).kind, 'finish-commit')
  // 负向对照：指纹对不上就是矛盾
  assert.equal(reconcileWitnesses(file, { committedAt: '1', migratedFrom: 'other' }, T).kind, 'blocked')
})

test('committed 且库打不开/不存在：不是矛盾，原样交给路由判 sqlite-unavailable-after-commit', () => {
  for (const witness of [{ unavailable: true }, { absent: true }, { committedAt: '1' }]) {
    assert.equal(reconcileWitnesses(at('committed'), witness, T).kind, 'use')
  }
})

test('正常阶段原样通过', () => {
  for (const phase of ['idle', 'preflight', 'backing-up', 'backup-verified', 'copying', 'verifying', 'verified', 'failed']) {
    assert.equal(reconcileWitnesses(at(phase), {}, T).kind, 'use', phase)
  }
})

test('写/读往返；带 checksum；seq 保留', async () => {
  const env = makeEnv()
  try {
    const store = createStateStore(env.fs, sha256)
    await store.write(at('copying', { checkpoints: [{ store: 'sessions', lastKey: 's2', done: false }], sourceFingerprint: 'x' }))
    const back = await store.read()
    assert.equal(back.phase, 'copying')
    assert.equal(back.seq, 3)
    assert.deepEqual(back.checkpoints, [{ store: 'sessions', lastKey: 's2', done: false }])
    assert.match(await env.fs.readText('storage-engine/state.json'), /"checksum":"[0-9a-f]{64}"/)
    assert.equal(await createStateStore(mods.memoryFs.createMemoryFs(), sha256).read(), undefined)
  } finally {
    env.cleanup()
  }
})

test('状态文件各种损坏都读成 corrupt（不抛、不猜）', async () => {
  const env = makeEnv()
  try {
    const store = createStateStore(env.fs, sha256)
    await store.write(at('copying'))
    const good = await env.fs.readText('storage-engine/state.json')
    const bad = {
      '截断': good.slice(0, good.length - 7),
      '非 JSON': 'not json',
      '空文件': '',
      '数组': '[]',
      '改了字段（校验和不符）': good.replace('"phase":"copying"', '"phase":"committed"'),
      '缺校验和': good.replace(/,?"checksum":"[0-9a-f]+"/u, ''),
      '阶段名未知': JSON.stringify({ ...JSON.parse(good), phase: 'weird' }),
    }
    for (const [name, text] of Object.entries(bad)) {
      await env.fs.writeAtomic('storage-engine/state.json', text)
      assert.deepEqual(await store.read(), { corrupt: true }, name)
    }
    // 负向对照：原文写回就是正常的
    await env.fs.writeAtomic('storage-engine/state.json', good)
    assert.equal((await store.read()).phase, 'copying')
  } finally {
    env.cleanup()
  }
})

test('校验和不能被「改字段后重算」之外的方式绕过；parse 拒绝类型错误', () => {
  assert.equal(parseMigrationState({ ...freshState(1), seq: -1 }), undefined)
  assert.equal(parseMigrationState({ ...freshState(1), checkpoints: [{ store: 'nope', done: true }] }), undefined)
  assert.equal(parseMigrationState({ ...freshState(1), failure: { code: 'x', message: 'm', at: 1 } }), undefined)
  assert.ok(parseMigrationState(freshState(1)))
})

test('原子写失败（ENOSPC）不破坏旧状态', async () => {
  const env = makeEnv()
  try {
    const store = createStateStore(env.fs, sha256)
    await store.write(at('copying'))
    env.fs.injectEnospc()
    await assert.rejects(() => store.write(at('verified')))
    assert.equal((await store.read()).phase, 'copying')
  } finally {
    env.cleanup()
  }
})

test('损坏文件被保留：preserveCorruptState 另存原字节，原文件不动', async () => {
  const env = makeEnv()
  try {
    await env.fs.writeAtomic('storage-engine/state.json', '{garbage')
    const saved = await mods.state.preserveCorruptState(env.fs, 77)
    assert.equal(saved, 'storage-engine/state.corrupt-77.json')
    assert.equal(await env.fs.readText(saved), '{garbage')
    assert.equal(await env.fs.readText('storage-engine/state.json'), '{garbage')
  } finally {
    env.cleanup()
  }
})

// #924 真机复现：迁移备份是在 committed **之前**拍的，所以里面没有 meta.committed_at。
// 用户用这份备份覆盖主库恢复时：状态文件说 committed、见证人说「没有 committed_at」。
// 旧规则判「矛盾」并 block —— 于是没有任何恢复路径。库里**真有数据**比一行元数据更强，判为已切换。
test('规则8：状态 committed + 见证人没有 committed_at，但库里有数据 → finish-commit（可恢复），不是 block', () => {
  const state = { ...freshState(1), phase: 'committed', seq: 5 }
  const out = reconcileWitnesses(state, { hasData: true }, T)
  assert.equal(out.kind, 'finish-commit')
})

test('规则8 反例：状态 committed + 见证人没有 committed_at + 库里没数据 → 仍然 block（不猜、不覆盖）', () => {
  const state = { ...freshState(1), phase: 'committed', seq: 5 }
  const out = reconcileWitnesses(state, { hasData: false }, T)
  assert.equal(out.kind, 'blocked')
  assert.equal(out.detail, 'state-file-committed-but-sqlite-meta-missing')
})

// ---------------------------------------------------------------- #980 F1
//
// 「库里有业务数据吗」只看 `sessions` 是错的：引用计数保证「删会话不等于删文件」，
// 孤儿原件（files/attachments/attachmentTexts）本来就可能单独存在。只数会话会把这类库
// 判成空库，而空库在下游意味着「可以清空重来」。
test('#980 F1：hasBusinessData 覆盖全部 store 表——只有孤儿原件、没有会话也算有数据', async () => {
  const env = makeEnv()
  try {
    const { db } = await env.mainTarget()
    // 只有 files 有行，sessions 为空
    await db.run('INSERT INTO files (id, doc) VALUES (?, ?)', [Buffer.from('f1'), JSON.stringify({ id: 'f1' })])
    assert.equal(await mods.state.hasBusinessData(db), true)
    // 只有 attachments 有行
    await db.run('DELETE FROM files')
    await db.run('INSERT INTO attachments (id, sha256, parsed_text_path, doc) VALUES (?, NULL, NULL, ?)', [Buffer.from('a1'), JSON.stringify({ id: 'a1' })])
    assert.equal(await mods.state.hasBusinessData(db), true)
    // 全空才是 false
    await db.run('DELETE FROM attachments')
    assert.equal(await mods.state.hasBusinessData(db), false)
    await db.close()
  } finally {
    env.cleanup()
  }
})
