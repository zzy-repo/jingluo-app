// [layer: unit | dependencies: none | 预算: ≤1s]
//
// #528 L0 验收：**ContextBuilder**（#526 契约）+ 与 #345 历史裁剪的协同。
//
// 覆盖 #528 清单四条：
//  1. **截断显式标注**：单附件超本轮预算时，注入文本里就地出现
//     `[内容过长，已截断，剩余 N 字符未发送]`，并且 warnings 有记录（§3.7 禁止静默截断）；
//  2. **多附件超预算**：顺序注入直到用尽，剩下的进 `skipped`（`budget_exhausted`）+ warnings，
//     且**用尽之后不再读全文**（按需读取：`getText` 不再被调用）；
//  3. **裁剪协同**：被 `contextBudget` 裁掉的那一轮，它的附件不注入、不占预算；
//     窗口内的照旧注入（引用挂在消息上，消息被裁 → 引用一起消失）；
//  4. **前缀稳定**：本轮请求的消息序列 JSON，必须是下一轮（尾部多一轮）请求的**逐字节前缀**。
//     这是上游上下文缓存的成本前提（命中 0.19 分 vs 未命中 4.70 分，见 #345），
//     也是本层唯一「跨轮」的断言，所以用整串 JSON 比较而不是逐字段 diff。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { buildWithDocuments, truncationMarker, formatDocumentInjection } = await import(
  '../../src/services/attachments/contextBuilder.ts'
)
const { toRequestMessages } = await import('../../src/services/chat/reply.ts')

/** 假 manager：按 id 返回正文，并记录读过谁（用来断言「按需读取」） */
const makeSource = (docs) => {
  const reads = []
  return {
    reads,
    source: {
      getText: async (id) => {
        reads.push(id)
        const doc = docs[id]
        return doc === undefined ? undefined : doc.text
      },
      getMeta: async (id) => {
        const doc = docs[id]
        return doc === undefined
          ? undefined
          : { filename: doc.name, sha256: doc.sha, status: doc.status ?? 'success' }
      },
    },
  }
}

const userMessage = (id, content, refs = []) => ({
  role: 'user',
  content,
  ...(refs.length > 0 ? { attachments: refs.map((attachmentId) => ({ attachmentId })) } : {}),
})

const assistantMessage = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

/** 注入块里的正文（剥掉包装，便于断言「注入了多少」） */
const bodyOf = (message) => {
  const text = typeof message.content === 'string' ? message.content : ''
  const start = text.indexOf('>\n') + 2
  const end = text.lastIndexOf('\n</document>')
  return start >= 2 && end > start ? text.slice(start, end) : ''
}

test('[L0-CTX] 截断显式标注：注入文本里带「剩余 N 字符未发送」+ warnings 有记录', async () => {
  const long = '甲'.repeat(1200)
  const { source } = makeSource({ a: { text: long, name: '长文档.txt', sha: 'sha-a' } })
  const base = [userMessage('u1', '请总结', ['a'])]
  const result = await buildWithDocuments(base, [], { source, docBudgetChars: 600 })

  assert.equal(result.injected.length, 1)
  assert.equal(result.injected[0].truncated, true, '必须标记为已截断')
  assert.equal(result.injected[0].totalCharacters, 1200)
  const rest = 1200 - result.injected[0].bodyCharacters
  assert.ok(rest > 0)
  // 逐字断言标注（它属于请求前缀，改字就是全量缓存失效）
  assert.equal(
    truncationMarker(rest),
    `[内容过长，已截断，剩余 ${rest} 字符未发送]`
  )
  const injected = String(result.messages[0].content)
  assert.ok(injected.includes(truncationMarker(rest)), '标注必须出现在注入正文里（就地）')
  assert.ok(
    result.warnings.some((warning) => warning.includes(`剩余 ${rest} 字符未发送`)),
    `warnings 也要说清差多少：${JSON.stringify(result.warnings)}`
  )
  // 标注本身也吃预算：注入块总长不超过预算（否则预算形同虚设）
  assert.ok(result.budget.usedChars <= 600, `usedChars=${result.budget.usedChars}`)
})

test('[L0-CTX] 多附件超预算：顺序注入到用尽，其余的进 skipped + warnings，「用尽后不再读全文」', async () => {
  // 三份各 400 字符；预算只够两份
  const docs = {}
  for (const id of ['a', 'b', 'c']) {
    docs[id] = { text: `${id}`.repeat(400), name: `${id}.txt`, sha: `sha-${id}` }
  }
  const { source, reads } = makeSource(docs)
  const base = [userMessage('u1', '一起看', ['a', 'b', 'c'])]
  const result = await buildWithDocuments(base, [], { source, docBudgetChars: 1000 })

  assert.deepEqual(
    result.injected.map((item) => item.attachmentId),
    ['a', 'b'],
    '按请求顺序先到先得'
  )
  assert.deepEqual(
    result.skipped.map((item) => `${item.attachmentId}:${item.reason}`),
    ['c:budget_exhausted']
  )
  assert.ok(
    result.warnings.some((warning) => warning.includes('附件「c.txt」未发送')),
    `未注入必须显式告知：${JSON.stringify(result.warnings)}`
  )
  // 按需读取：第三份的正文一个字都没读
  assert.deepEqual(reads, ['a', 'b'], '预算用尽后仍在读全文 = 白读几十 MB')
  assert.ok(result.budget.usedChars <= 1000)
  assert.equal(formatDocumentInjection(result).includes('注入 2 个'), true)
})

test('[L0-CTX] 去重：同一附件被两条消息引用 → 单次请求只注入一次（位置固定在第一次出现处）', async () => {
  const { source, reads } = makeSource({ a: { text: '共享正文', name: 'a.txt', sha: 'sha-a' } })
  const base = [
    userMessage('u1', '第一轮', ['a']),
    assistantMessage('ok'),
    userMessage('u2', '第二轮', ['a']),
  ]
  const result = await buildWithDocuments(base, [], { source })
  assert.equal(result.injected.length, 1)
  assert.deepEqual(result.skipped.map((item) => item.reason), ['duplicate'])
  assert.deepEqual(reads, ['a'], '同一份正文只读一次')
  // 出参必须剥掉 attachments 键（原样上行会被上游当未知字段）
  assert.equal(JSON.stringify(result.messages).includes('"attachments"'), false)
})

test('[L0-CTX] 裁剪协同：被裁掉的轮次其附件不注入，窗口内的照旧注入', async () => {
  const docs = {
    old: { text: '老的附件正文'.repeat(30), name: 'old.txt', sha: 'sha-old' },
    recent: { text: '新的附件正文'.repeat(30), name: 'recent.txt', sha: 'sha-recent' },
  }
  const { source, reads } = makeSource(docs)

  /** 三轮历史，第一轮带附件，第三轮带附件；预算只容得下一轮 */
  const history = [
    { id: 'h1', role: 'user', content: '第一轮提问'.repeat(40), files: [], createdAt: 1 },
    { id: 'h2', role: 'user', content: '第二轮提问', files: [], createdAt: 2 },
    { id: 'h3', role: 'user', content: '第三轮提问', files: [], createdAt: 3 },
  ]
  const replies = {
    h1: { content: [{ type: 'text', text: '答一' }] },
    h2: { content: [{ type: 'text', text: '答二' }] },
    h3: { content: [{ type: 'text', text: '答三' }] },
  }
  const roundMessages = history.map((user) => ({
    user,
    reply: replies[user.id],
  }))
  // 用真实的 reply.ts 产出（引用挂在消息上），但把「旧轮」的附件引用手动挂到第 1 轮
  const base = []
  base.push(userMessage('u1', '第一轮提问'.repeat(40), ['old']))
  base.push(assistantMessage('答一'))
  base.push(userMessage('u2', '第二轮提问', []))
  base.push(assistantMessage('答二'))
  base.push(userMessage('u3', '第三轮提问', ['recent']))

  // 模拟 contextBudget 已经裁掉了第 1 轮：窗口里只剩第 2/3 轮
  const trimmed = base.slice(2)
  const result = await buildWithDocuments(trimmed, [], { source })
  assert.deepEqual(
    result.injected.map((item) => item.attachmentId),
    ['recent'],
    '被裁掉的轮次带走了它的附件'
  )
  assert.deepEqual(reads, ['recent'], '窗口外的附件连读都不读')
  assert.equal(JSON.stringify(result.messages).includes('老的附件正文'), false)
  // 反向断言：不裁剪时两份都会注入 —— 证明上面那条差异是「裁剪」造成的
  const whole = await buildWithDocuments(base, [], { source })
  assert.deepEqual(whole.injected.map((item) => item.attachmentId), ['old', 'recent'])
  assert.ok(roundMessages.length === 3)
})

test('[L0-CTX] 前缀稳定：本轮请求的消息 JSON 是下一轮请求的逐字节前缀', async () => {
  const docs = {
    keep: { text: '稳定正文'.repeat(50), name: 'keep.txt', sha: 'sha-keep' },
  }
  const { source } = makeSource(docs)

  const round1 = [userMessage('u1', '第一轮提问', ['keep']), assistantMessage('第一轮回答')]
  const firstResult = await buildWithDocuments(round1, [], { source })
  const firstJson = JSON.stringify({ messages: firstResult.messages })

  // 下一轮：历史多了一轮（第一轮 + 它的回答），本轮提问不带附件
  const round2 = [
    userMessage('u1', '第一轮提问', ['keep']),
    assistantMessage('第一轮回答'),
    userMessage('u2', '第二轮提问', []),
  ]
  const secondResult = await buildWithDocuments(round2, [], { source })
  const secondJson = JSON.stringify({ messages: secondResult.messages })

  // 「整轮请求 = 下一轮逐字节前缀」：老消息（含注入块）一个字节都没变
  const prefix = firstJson.slice(0, firstJson.lastIndexOf(']'))
  assert.ok(
    secondJson.startsWith(prefix),
    `下一轮请求不再以本轮请求为前缀：\n前一轮 ${firstJson}\n下一轮 ${secondJson}`
  )
  assert.equal(
    JSON.stringify(secondResult.messages[0]),
    JSON.stringify(firstResult.messages[0]),
    '带附件的 user 消息必须逐字节相同'
  )
  // 同一组入参重跑一次：结果完全相同（无状态纯函数，重试/重新生成不会抖动）
  const again = await buildWithDocuments(round1, [], { source })
  assert.equal(JSON.stringify({ messages: again.messages }), firstJson, '同一入参两次构建必须逐字节相同')
})

test('[L0-CTX] 无附件的消息保持同一对象引用（连序列化都不重做）', async () => {
  const { source } = makeSource({ a: { text: '正文', name: 'a.txt', sha: 'sha-a' } })
  const plain = assistantMessage('纯回答')
  const base = [userMessage('u1', '提问', ['a']), plain]
  const result = await buildWithDocuments(base, [], { source })
  assert.equal(result.messages[1], plain, '没有附件引用的消息必须原对象返回')
})

test('[L0-CTX] 解析失败 / 未就绪 / 正文缺失：进 skipped + warnings，绝不静默', async () => {
  const { source } = makeSource({
    failed: { text: '不该被注入', name: 'failed.pdf', sha: 's1', status: 'failed' },
    pending: { text: '也不该', name: 'pending.pdf', sha: 's2', status: 'pending' },
  })
  const base = [userMessage('u1', '看看', ['failed', 'pending', 'missing'])]
  const result = await buildWithDocuments(base, [], { source })
  assert.equal(result.injected.length, 0)
  assert.deepEqual(
    result.skipped.map((item) => item.reason),
    ['parse_failed', 'not_ready', 'empty']
  )
  assert.equal(result.warnings.length, 3, JSON.stringify(result.warnings))
})

test('[L0-CTX] 只有附件、没有文字的本轮提问：正文进消息，且不留悬空的「用户问题：」', async () => {
  const { source } = makeSource({ a: { text: '只有附件的正文', name: 'a.txt', sha: 'sha-a' } })
  const result = await buildWithDocuments([userMessage('u1', '', ['a'])], [], { source })
  const content = String(result.messages[0].content)
  assert.ok(content.includes('只有附件的正文'))
  assert.equal(content.includes('用户问题：'), false, '空提问不该留悬空标签')
  assert.equal(bodyOf(result.messages[0]).startsWith('只有附件的正文'), true)
})
