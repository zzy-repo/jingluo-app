// AttachmentRepo 契约（元数据 + 解析全文 + 引用计数删除 + 清孤儿）。
// 引用计数的原子性（remove / sweepOrphans）放在 atomic.mjs；这里只验可观察的结果。
import assert from 'node:assert/strict'
import { allItems, attDraft, attKey, blobOf, byId, ids, SHA_A, SHA_B, sessionOf, seed, stored } from './fixtures.mjs'

const textDraft = (over = {}) => ({ sha256: 'h1', parserVersion: 'txt-1', text: '一二三', status: 'success', ...over })

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[attachment][读] get 不存在为 undefined；空库 list 为 []；readText(undefined) 与不存在键为 undefined ← char-blob B1/B2 / types', async ({ backend }) => {
    assert.equal(await backend.attachments.get('att-none'), undefined)
    assert.deepEqual(await backend.attachments.list(), [])
    assert.equal(await backend.attachments.readText(undefined), undefined)
    assert.equal(await backend.attachments.readText('missing:txt-1'), undefined)
  })

  S('[attachment][add] 返回落库记录：localPath = attachment-<sha256>，原件写入同键，get / list 同形 ← char-blob B1 / types:add', async ({ backend }) => {
    const draft = attDraft({ id: 'att-1', sha256: SHA_A })
    const saved = await backend.attachments.add(draft, blobOf('正文', 'text/plain'))
    assert.equal(saved.localPath, attKey(SHA_A))
    assert.equal(saved.status, 'pending')
    assert.equal(saved.id, 'att-1')
    assert.deepEqual(await backend.attachments.get('att-1'), saved)
    assert.deepEqual(await backend.attachments.list(), [saved])
    assert.equal(await (await backend.blobs.get(attKey(SHA_A))).text(), '正文', '原件与元数据在同一次 add 里落库')
  })

  S('[attachment][add] 同内容（同 sha256）两条元数据共用一份原件 ← types:add「去重」/ char-blob B3', async ({ backend }) => {
    await backend.attachments.add(attDraft({ id: 'a1', sha256: SHA_A }), blobOf('同', 'text/plain'))
    await backend.attachments.add(attDraft({ id: 'a2', sha256: SHA_A, filename: 'b.txt' }), blobOf('同', 'text/plain'))
    assert.deepEqual(ids(await backend.attachments.list()).sort(), ['a1', 'a2'])
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [attKey(SHA_A)], '一份原件')
  })

  S('[attachment][put] 按 id 覆盖元数据且不产生第二条；没改的字段原样；不碰原件 ← char-blob B7 / types:put', async ({ backend }) => {
    const saved = await backend.attachments.add(attDraft({ id: 'a1', sha256: SHA_A }), blobOf('x', 'text/plain'))
    await backend.attachments.put({ ...saved, filename: 'renamed.txt', status: 'failed', errorMessage: 'boom' })
    const rows = await backend.attachments.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].filename, 'renamed.txt')
    assert.equal(rows[0].status, 'failed')
    assert.equal(rows[0].errorMessage, 'boom')
    assert.equal(rows[0].sha256, SHA_A)
    assert.ok(await backend.blobs.get(attKey(SHA_A)), 'put 不碰原件')
  })

  // ------------------------------------------------------------ 解析全文
  S('[attachment][writeText] 键 = sha256:parserVersion；characterCount 缺省取 text.length；可选字段不落库；createdAt 为数字 ← char-blob B2 / types:writeText', async ({ backend }) => {
    const written = await backend.attachments.writeText(textDraft({ sha256: 'b2hash', status: 'partial' }))
    assert.equal(written.key, 'b2hash:txt-1')
    assert.equal(written.characterCount, 3)
    assert.equal(written.status, 'partial')
    assert.equal(typeof written.createdAt, 'number')
    for (const optional of ['totalPages', 'extractedPages', 'warnings']) {
      assert.equal(written[optional], undefined, `没传的 ${optional} 不得凭空出现`)
    }
    assert.deepEqual(await backend.attachments.readText(written.key), written)
  })

  S('[attachment][writeText] 显式 characterCount 不被 text.length 覆盖；页数与 warnings 原样；同键覆盖幂等 ← char-blob B2 / types:writeText', async ({ backend }) => {
    await backend.attachments.writeText(textDraft({ sha256: 'k' }))
    const rich = await backend.attachments.writeText(textDraft({ sha256: 'k', characterCount: 2, totalPages: 4, extractedPages: 3, warnings: ['一页是扫描件'] }))
    assert.equal(rich.characterCount, 2)
    assert.equal(rich.totalPages, 4)
    assert.equal(rich.extractedPages, 3)
    assert.deepEqual(rich.warnings, ['一页是扫描件'])
    assert.deepEqual(await backend.attachments.readText('k:txt-1'), rich, '同键只剩最后一次')
  })

  S('[attachment][writeText] parserVersion 不同则键不同，互不覆盖 ← 键形状 sha256:parserVersion', async ({ backend }) => {
    await backend.attachments.writeText(textDraft({ sha256: 'k', parserVersion: 'v1', text: 'one' }))
    await backend.attachments.writeText(textDraft({ sha256: 'k', parserVersion: 'v2', text: 'two' }))
    assert.equal((await backend.attachments.readText('k:v1')).text, 'one')
    assert.equal((await backend.attachments.readText('k:v2')).text, 'two')
  })

  // ------------------------------------------------------------ remove
  const addWithText = async (backend, id, sha, textKey) => {
    const saved = await backend.attachments.add(attDraft({ id, sha256: sha, parsedTextPath: textKey }), blobOf(id, 'text/plain'))
    return saved
  }

  S('[attachment][remove] 不存在返回 0 ← char-blob B4 / types:remove', async ({ backend }) => {
    assert.equal(await backend.attachments.remove('att-never'), 0)
  })

  S('[attachment][remove] 独占的元数据 + 全文 + 原件都删，返回条数 3 ← char-blob B3 / types:remove', async ({ backend }) => {
    await backend.attachments.writeText(textDraft({ sha256: SHA_A }))
    await addWithText(backend, 'a1', SHA_A, `${SHA_A}:txt-1`)
    assert.equal(await backend.attachments.remove('a1'), 3)
    assert.equal(await backend.attachments.get('a1'), undefined)
    assert.equal(await backend.attachments.readText(`${SHA_A}:txt-1`), undefined)
    assert.equal(await backend.blobs.get(attKey(SHA_A)), undefined)
  })

  S('[attachment][remove] 同 sha256 还有别的元数据：原件与全文都留，只删元数据（返回 1）← types:remove「无其它引用时」', async ({ backend }) => {
    await backend.attachments.writeText(textDraft({ sha256: SHA_A }))
    await addWithText(backend, 'a1', SHA_A, `${SHA_A}:txt-1`)
    await addWithText(backend, 'a2', SHA_A, `${SHA_A}:txt-1`)
    assert.equal(await backend.attachments.remove('a1'), 1)
    assert.ok(await backend.blobs.get(attKey(SHA_A)))
    assert.ok(await backend.attachments.readText(`${SHA_A}:txt-1`))
    assert.equal(await backend.attachments.remove('a2'), 3, '最后一条带走全文与原件')
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [])
  })

  S('[attachment][remove] 不同 sha256 的附件共用同一份全文：先删的不带走全文，最后一个才删 ← char-blob B3 / types:remove 引用数现数', async ({ backend }) => {
    const shared = 'shared:txt-1'
    await backend.attachments.writeText(textDraft({ sha256: 'shared' }))
    await backend.attachments.writeText(textDraft({ sha256: 'other' }))
    await addWithText(backend, 'a', SHA_A, shared)
    await addWithText(backend, 'b', SHA_B, shared)
    assert.equal(await backend.attachments.remove('a'), 2, '元数据 + 它独占的原件；全文仍被 b 指向')
    assert.ok(await backend.attachments.readText(shared))
    assert.equal(await backend.attachments.remove('b'), 3)
    assert.equal(await backend.attachments.readText(shared), undefined)
    assert.ok(await backend.attachments.readText('other:txt-1'), '没人删过的全文留着')
  })

  S('[attachment][remove] localPath 不是 attachment- 前缀时只删元数据，不碰同名原件 ← char-blob B4 / types:remove', async ({ backend }) => {
    await backend.blobs.putMany([stored('chat-image-b4', 'img')])
    await backend.attachments.put(attDraft({ id: 'att-b4', sha256: 'b4hash', localPath: 'chat-image-b4' }))
    assert.equal(await backend.attachments.remove('att-b4'), 1)
    assert.ok(await backend.blobs.get('chat-image-b4'), '聊天图片原件原封不动')
  })

  // ------------------------------------------------------------ removeUnreferenced
  S('[attachment][removeUnreferenced] 命中集合的一条不动，其余走完整 remove；返回删除的条目总数 ← char-blob B5 / types:removeUnreferenced', async ({ backend }) => {
    await backend.attachments.add(attDraft({ id: 'a', sha256: SHA_A }), blobOf('a', 'text/plain'))
    await backend.attachments.add(attDraft({ id: 'b', sha256: SHA_B }), blobOf('b', 'text/plain'))
    assert.equal(await backend.attachments.removeUnreferenced(new Set(['a'])), 2, 'b 的元数据 + 原件')
    assert.notEqual(await backend.attachments.get('a'), undefined)
    assert.equal(await backend.attachments.get('b'), undefined)
    assert.equal(await backend.blobs.get(attKey(SHA_B)), undefined)
    assert.ok(await backend.blobs.get(attKey(SHA_A)))
  })

  S('[attachment][removeUnreferenced] 空集合 = 全部删除；空库返回 0 ← char-blob B5 / types:removeUnreferenced「空集合 = 全部删除」', async ({ backend }) => {
    assert.equal(await backend.attachments.removeUnreferenced(new Set()), 0)
    await backend.attachments.add(attDraft({ id: 'a', sha256: SHA_A }), blobOf('a', 'text/plain'))
    await backend.attachments.add(attDraft({ id: 'b', sha256: SHA_B }), blobOf('b', 'text/plain'))
    assert.equal(await backend.attachments.removeUnreferenced(new Set()), 4)
    assert.deepEqual(await backend.attachments.list(), [])
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [])
  })

  // ------------------------------------------------------------ sweepOrphans
  S('[attachment][sweepOrphans] 只清 attachment- 前缀的无主原件与无主全文；聊天图片、仍被引用的原件、元数据都不动 ← char-blob B6 / types:sweepOrphans', async ({ backend }) => {
    await backend.attachments.add(attDraft({ id: 'att-live', sha256: 'livehash' }), blobOf('live', 'text/plain'))
    await backend.attachments.writeText(textDraft({ sha256: 'orphan' }))
    await backend.blobs.putMany([{ id: 'attachment-dead', blob: blobOf('dead') }, stored('chat-image', 'img')])
    assert.equal(await backend.attachments.sweepOrphans(), 2, '一条无主全文 + 一条无主原件')
    const keys = (await allItems((q) => backend.blobs.listKeys(q))).sort()
    assert.deepEqual(keys, ['attachment-livehash', 'chat-image'])
    assert.equal(await backend.attachments.readText('orphan:txt-1'), undefined)
    assert.notEqual(await backend.attachments.get('att-live'), undefined, '清扫不删元数据')
  })

  S('[attachment][sweepOrphans] 被元数据 parsedTextPath 指着的全文不是孤儿；没有孤儿时返回 0 ← types:sweepOrphans', async ({ backend }) => {
    await backend.attachments.writeText(textDraft({ sha256: SHA_A }))
    await addWithText(backend, 'a', SHA_A, `${SHA_A}:txt-1`)
    assert.equal(await backend.attachments.sweepOrphans(), 0)
    assert.ok(await backend.attachments.readText(`${SHA_A}:txt-1`))
  })

  S('[attachment][与会话] 会话删除后文档附件仍在，由 removeUnreferenced 单独收尾 ← char-blob D1 / types:delete 与 removeUnreferenced', async ({ backend }) => {
    await backend.attachments.add(attDraft({ id: 'att-1', sha256: SHA_A }), blobOf('doc', 'text/plain'))
    await seed(backend, sessionOf('s1'))
    await backend.sessions.delete('s1')
    assert.notEqual(await backend.attachments.get('att-1'), undefined)
    assert.equal(await backend.attachments.removeUnreferenced(new Set()), 2)
  })

  S('[attachment][list] 返回全部元数据（顺序不保证）← types:list', async ({ backend }) => {
    for (const [id, sha] of [['b', SHA_B], ['a', SHA_A]]) await backend.attachments.add(attDraft({ id, sha256: sha }), blobOf(id, 'text/plain'))
    assert.deepEqual(ids([...(await backend.attachments.list())].sort(byId)), ['a', 'b'])
  })
}
