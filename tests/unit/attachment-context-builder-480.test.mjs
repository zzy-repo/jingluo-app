// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #480 §8/§9：ContextBuilder —— 附件正文进入上下文预算、去重、与历史裁剪协同。
//
// 核心断言（前缀稳定性直接关系上游上下文缓存命中，成本差 8 倍，见 #345）：
// [绿 1] 按需读取：只有真的要注入的附件才 getText，预算用尽后不再读全文；
// [绿 2] 去重：同一 id / 同一 sha256 在单次请求里只注入一次；
// [绿 3] 禁止静默截断：超 maxExtractedChars 时注入文本里带 `[内容过长，已截断，剩余 N 字符未发送]`，且 warnings 有记录；
// [绿 4] 多附件超预算：顺序注入直到用尽，剩下的进 skipped（budget_exhausted）+ warnings，不静默丢；
// [绿 5] 裁剪协同：base 里没有的轮次（= 被 contextBudget 裁掉的）其附件不注入；窗口内的照旧注入；
// [绿 6] 前缀稳定：尾部多一轮之后，老消息的 JSON 逐字节不变；无附件消息保持同一对象引用；
// [绿 7] 出参剥掉 attachments 键（原样上行会被上游当未知字段）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { buildWithDocuments, DOC_INTRO } = await import(
  '../../src/services/attachments/contextBuilder.ts'
)

/** 假 manager：按 id 返回正文，并记录读过谁（用来断言「按需读取」） */
const makeSource = (docs) => {
  const reads = []
  return {
    reads,
    source: {
      getText: async (id) => {
        reads.push(id)
        return docs[id]?.text
      },
      getMeta: async (id) => {
        const doc = docs[id]
        return doc ? { filename: doc.name, sha256: doc.sha, status: doc.status ?? 'success' } : undefined
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

/** 从注入后的内容里把文档块抠出来（断言不受包装排版影响） */
const documentBlocks = (content) => content.match(/<document [\s\S]*?<\/document>/g) ?? []

test('按需读取：只读真正注入的附件，预算用尽后不再读全文', async () => {
  const docs = {
    a: { name: 'a.txt', text: 'A'.repeat(500) },
    b: { name: 'b.txt', text: 'B'.repeat(500) },
  }
  const { source, reads } = makeSource(docs)
  const base = [userMessage('u1', '第一个问题', ['a']), userMessage('u2', '第二个问题', ['b'])]
  // 一个 500 字附件的注入块约 535 字符（含包装），600 的预算只够一个
  const result = await buildWithDocuments(base, [], { source, docBudgetChars: 600 })

  assert.equal(result.injected.length, 1, '预算只够一个附件')
  assert.equal(result.injected[0].attachmentId, 'a')
  assert.deepEqual(reads, ['a'], '预算用尽后不该再 getText 第二个附件')
  assert.equal(result.skipped[0].reason, 'budget_exhausted')
})

test('去重：同一 id 只注入一次，按 sha256 也去重', async () => {
  const docs = {
    a: { name: '同名.txt', text: 'A 的内容', sha: 'sha-1' },
    b: { name: '另一个名.txt', text: 'A 的内容', sha: 'sha-1' },
  }
  const { source } = makeSource(docs)
  const base = [
    userMessage('u1', '第一问', ['a', 'a']),
    userMessage('u2', '第二问', ['b']),
  ]
  const result = await buildWithDocuments(base, ['a'], { source })

  assert.equal(result.injected.length, 1)
  assert.equal(
    result.skipped.filter((item) => item.reason === 'duplicate').length,
    3,
    '同 id 重复 2 次 + sha 相同 1 次'
  )
  assert.equal(documentBlocks(result.messages[0].content).length, 1, '消息里只出现一个文档块')
})

test('禁止静默截断：超上限时正文里带标注，warnings 记一条', async () => {
  const docs = { big: { name: 'long.txt', text: 'x'.repeat(2000) } }
  const { source } = makeSource(docs)
  const base = [userMessage('u1', '总结一下', ['big'])]
  const result = await buildWithDocuments(base, [], { source, maxExtractedChars: 500 })

  const [item] = result.injected
  assert.equal(item.truncated, true)
  assert.equal(item.totalCharacters, 2000)
  const content = result.messages[0].content
  const match = content.match(/\[内容过长，已截断，剩余 (\d+) 字符未发送\]/)
  assert.ok(match, '必须有截断标注')
  assert.equal(Number(match[1]), 2000 - item.bodyCharacters)
  assert.ok(
    result.warnings.some((line) => line.includes('已截断注入')),
    'warnings 要能被 UI 显示'
  )
  // 标注之后的字节数不超过上限
  assert.ok(item.characters <= 500 + 200, '包装 + 标注也要在预算内')
})

test('多附件超预算：顺序注入，剩余附件明确提示未注入', async () => {
  const docs = {
    a: { name: 'a.txt', text: 'A'.repeat(300) },
    b: { name: 'b.txt', text: 'B'.repeat(300) },
    c: { name: 'c.txt', text: 'C'.repeat(300) },
  }
  const { source } = makeSource(docs)
  const base = [userMessage('u1', '三个附件', ['a', 'b', 'c'])]
  const result = await buildWithDocuments(base, [], { source, docBudgetChars: 900 })

  assert.deepEqual(
    result.injected.map((item) => item.attachmentId),
    ['a', 'b'],
    '按顺序注入直到预算用尽'
  )
  assert.deepEqual(
    result.skipped.map((item) => [item.attachmentId, item.reason]),
    [['c', 'budget_exhausted']]
  )
  assert.ok(result.warnings.some((line) => line.includes('未发送')))
  assert.equal(documentBlocks(result.messages[0].content).length, 2)
})

test('裁剪协同：不在 base 里的轮次其附件不注入', async () => {
  const docs = {
    old: { name: 'old.txt', text: '旧轮次的内容' },
    kept: { name: 'kept.txt', text: '窗口内的内容' },
  }
  const { source, reads } = makeSource(docs)
  // contextBudget 裁掉最旧一轮后，base 里就只剩窗口内的消息
  const base = [userMessage('u2', '第二问', ['kept']), assistantMessage('回答二'), userMessage('u3', '第三问')]
  const result = await buildWithDocuments(base, [], { source })

  assert.deepEqual(reads, ['kept'], '被裁轮次的附件根本不该被读取')
  assert.deepEqual(
    result.injected.map((item) => item.attachmentId),
    ['kept']
  )
  assert.ok(!JSON.stringify(result.messages).includes('旧轮次的内容'))
})

test('前缀稳定：尾部多一轮后，老消息逐字节不变', async () => {
  const docs = { a: { name: 'a.txt', text: 'A'.repeat(1200) } }
  const { source } = makeSource(docs)
  const turnOne = [
    userMessage('u1', '第一问', ['a']),
    assistantMessage('第一答'),
    userMessage('u2', '第二问'),
  ]
  const turnTwo = [
    ...turnOne.slice(0, 2),
    userMessage('u2', '第二问'),
    assistantMessage('第二答'),
    userMessage('u3', '第三问'),
  ]
  const first = await buildWithDocuments(turnOne, [], { source })
  const second = await buildWithDocuments(turnTwo, [], { source })

  // 老消息（含带附件的第一条）序列化后逐字节相同
  assert.equal(
    JSON.stringify(second.messages.slice(0, 2)),
    JSON.stringify(first.messages.slice(0, 2)),
    '前缀必须逐字节稳定，否则上游上下文缓存永不命中'
  )
  // 同一组入参重复构建（重试 / 重新生成）也必须相同
  const again = await buildWithDocuments(turnOne, [], { source })
  assert.equal(JSON.stringify(again.messages), JSON.stringify(first.messages))
  // 无附件消息保持同一对象引用（连序列化都不重做）
  assert.equal(first.messages[1], turnOne[1])
})

test('出参不带 attachments 键；已有注入块不重复注入', async () => {
  const docs = { a: { name: 'a.txt', text: '内容' } }
  const { source } = makeSource(docs)
  const base = [userMessage('u1', '问题', ['a'])]
  const first = await buildWithDocuments(base, [], { source })
  assert.equal(JSON.stringify(first.messages).includes('attachments'), false)

  // 把结果（重新挂上引用）当 base 再跑一次：幂等保护，不会出现两个文档块
  const reinjected = [{ ...first.messages[0], attachments: [{ attachmentId: 'a' }] }]
  const again = await buildWithDocuments(reinjected, [], { source })
  assert.equal(again.injected.length, 0)
  assert.equal(again.skipped[0].reason, 'already_injected')
  assert.equal(documentBlocks(again.messages[0].content).length, 1)
})

test('注入位置固定在消息开头，且带统一说明（不可信资料）', async () => {
  const docs = { a: { name: '研究报告.pdf', text: '[第1页]\n正文' } }
  const { source } = makeSource(docs)
  const base = [userMessage('u1', '帮我总结一下这个文件。', ['a'])]
  const result = await buildWithDocuments(base, [], { source })
  const content = result.messages[0].content

  assert.ok(content.startsWith(DOC_INTRO))
  assert.ok(content.includes('<document name="研究报告.pdf">'))
  assert.ok(content.endsWith('用户问题：帮我总结一下这个文件。'))
})

test('读取失败 / 解析失败 / 未就绪都不静默：进 skipped + warnings', async () => {
  const base = [
    userMessage('u1', '问题', ['broken', 'failed', 'parsing']),
  ]
  const source = {
    getText: async (id) => {
      if (id === 'broken') {
        throw new Error('IndexedDB 打不开')
      }
      return '不该读到'
    },
    getMeta: async (id) => {
      if (id === 'failed') {
        return { filename: 'f.pdf', status: 'failed', errorMessage: '无文本层' }
      }
      if (id === 'parsing') {
        return { filename: 'p.pdf', status: 'parsing' }
      }
      return { filename: 'b.txt', status: 'success' }
    },
  }
  const result = await buildWithDocuments(base, [], { source })

  assert.equal(result.injected.length, 0)
  assert.deepEqual(
    result.skipped.map((item) => item.reason),
    ['read_error', 'parse_failed', 'not_ready']
  )
  assert.equal(result.warnings.length, 3)
})

test('与 #345 协同：真实裁剪链路上，整轮前缀逐字节不变（尾部只增长）', async () => {
  const { toRequestMessages } = await import('../../src/services/chat/reply.ts')

  // 每个轮次带一个附件；正文固定，注入结果只由「哪条消息 + 哪个附件」决定
  const docs = {}
  const docText = (index) => `第 ${index} 轮附件正文：${'资料内容'.repeat(20)}`
  for (let index = 0; index < 40; index += 1) {
    docs[`doc${index}`] = { name: `附件${index}.txt`, text: docText(index), sha: `sha-${index}` }
  }
  const { source } = makeSource(docs)

  const historyUser = (index) => ({
    id: `u${index}`,
    role: 'user',
    content: `第 ${index} 轮提问：${'背景说明'.repeat(25)}`,
    files: [],
    createdAt: index * 2,
  })
  const historyAssistant = (index) => ({
    id: `a${index}`,
    role: 'assistant',
    createdAt: index * 2 + 1,
    model: null,
    prefix: false,
    status: 'done',
    blocks: [{ type: 'text', text: `第 ${index} 轮回答：${'结论与依据'.repeat(25)}`, citations: [] }],
  })

  /** 一轮完整的真实链路：toRequestMessages（裁剪 + #345 锚点）→ 挂附件引用 → 注入正文 */
  const buildTurn = async (rounds, questionIndex) => {
    const history = []
    for (let index = 0; index < rounds; index += 1) {
      history.push(historyUser(index), historyAssistant(index))
    }
    const params = toRequestMessages(history, historyUser(questionIndex), undefined, false, undefined, {
      anchorKey: 'session-480',
      budget: { maxRounds: 6 },
    })
    const withRefs = params.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      const match = String(message.content).match(/第 (\d+) 轮提问/)
      return match ? { ...message, attachments: [{ attachmentId: `doc${match[1]}` }] } : message
    })
    // 预算收紧到只够 2 个附件：分配顺序一旦变成「新的优先」，老消息的注入结果
    // 就会随轮次推进而改变 —— 这条用例就是靠这个压力点抓前缀漂移的。
    return buildWithDocuments(withRefs, [], { source, docBudgetChars: 400 })
  }

  const turnA = await buildTurn(30, 30)
  const turnB = await buildTurn(31, 31)

  // 裁剪确实发生了（否则这条用例证明不了什么）
  assert.ok(turnA.messages.length < 30 * 2 + 1, '应触发历史裁剪')
  // 关键断言：A 轮的**整段**请求（含附件注入）是 B 轮请求的逐字节前缀
  assert.equal(
    JSON.stringify(turnB.messages.slice(0, turnA.messages.length)),
    JSON.stringify(turnA.messages),
    '整轮前缀必须逐字节稳定：否则上游上下文缓存从第一个 token 起失效（#345，成本差 8 倍）'
  )
  // 注入结果也只随消息本身变化（同样的附件不会因为轮次推进而换一种拼法）
  assert.equal(turnA.injected.length, 2)
  assert.equal(turnB.injected.length, 2)
  assert.deepEqual(
    turnB.injected.map((item) => item.attachmentId),
    turnA.injected.map((item) => item.attachmentId),
    '老消息拿到的预算不能因为尾部多了一轮就被挤掉'
  )
})
