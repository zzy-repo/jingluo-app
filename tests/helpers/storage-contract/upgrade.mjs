// 升级保数据钩子。`seedLegacy()` 由 runner 实现（本期只有 IDB：用旧版 schema 建库并写数据），返回
//   { open(): Promise<StorageBackend>,   // 打开这份旧库（触发升级）
//     expected: {                        // 逐条比对用的期望，全部是接口层的值
//       sessions: Session[], summaries: SessionSummary[],
//       blobs: Record<key, {type,size,text}>, assets: Record<key,{type,text}>,
//       attachments: DocumentAttachment[], texts: Record<key, StoredAttachmentText>,
//       memory: Record<sessionId, StoredSessionMemory[]> } }
// 套件不碰旧 schema，也不知道物理库名；SQLite 将来由它自己的 runner 提供同形状的 seedLegacy。
import assert from 'node:assert/strict'
import { byId, fold, sessionOf, seed, snapshot, stored } from './fixtures.mjs'

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[upgrade][保数据] 旧版 schema 的库升级后：会话 / 摘要 / 原件 / 素材 / 附件 / 全文 / 记忆逐条一致，一条不丢 ← docs §1 DB_VERSION 迁移 / memory-session-scope-399 T8', async ({ seedLegacy, adopt }) => {
    const { open, expected } = await seedLegacy()
    const backend = adopt(await open())
    const got = await snapshot(backend, { memoryOf: Object.keys(expected.memory), textKeys: Object.keys(expected.texts) })
    assert.deepEqual(got.sessions, [...expected.sessions].sort(byId), '会话逐条一致')
    assert.deepEqual(got.summaries, [...expected.summaries].sort(byId), '摘要逐条一致')
    assert.deepEqual(got.blobs, expected.blobs, '原件（含 MIME 与字节）逐条一致')
    assert.deepEqual(got.attachments, [...expected.attachments].sort(byId))
    assert.deepEqual(got.texts, expected.texts)
    assert.deepEqual(got.memory, expected.memory)
    for (const [key, want] of Object.entries(expected.assets)) {
      const asset = await backend.assets.get(key)
      assert.deepEqual({ type: asset.blob.type, text: await asset.blob.text() }, want, `素材 ${key}`)
    }
  }, { needs: ['seedLegacy'] })

  S('[upgrade][保数据] 升级后的库可正常写：新数据落库，旧数据不被动 ← memory-session-scope-399 T8', async ({ seedLegacy, adopt }) => {
    const { open, expected } = await seedLegacy()
    const backend = adopt(await open())
    await seed(backend, sessionOf('post-upgrade', { files: ['new-file'] }), [stored('new-file', '新')])
    assert.equal((await backend.sessions.get('post-upgrade')).id, 'post-upgrade')
    for (const session of expected.sessions) assert.deepEqual(await backend.sessions.get(session.id), session)
    for (const [key, want] of Object.entries(expected.blobs)) assert.deepEqual(await fold(await backend.blobs.get(key)), want)
  }, { needs: ['seedLegacy'] })

  S('[upgrade][保数据] 旧库的会话引用关系可反查（升级后索引 / 摘要的引用列没丢）← docs §1 索引', async ({ seedLegacy, adopt }) => {
    const { open, expected } = await seedLegacy()
    const backend = adopt(await open())
    for (const summary of expected.summaries) {
      const session = expected.sessions.find((s) => s.id === summary.id)
      const fileIds = new Set(session.messages.filter((m) => m.role === 'user').flatMap((m) => m.files.map((f) => f.id)))
      for (const id of fileIds) assert.ok((await backend.sessions.listReferencing(id)).includes(summary.id), `${id} 应能反查到 ${summary.id}`)
    }
  }, { needs: ['seedLegacy'] })
}
