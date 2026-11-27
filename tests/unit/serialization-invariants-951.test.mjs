// [layer: unit | 依赖: 只读源码文本（不开库、不联网） | 耗时: <2s]
//
// ## 为什么这条测试必须存在（别删）
//
// #951 给单连接加了一道串行闸 `serializeOn`（`src/services/storage/sqlite/repos/context.ts`）：
// 同一个库上的顶层语句一次只跑一条。这道闸把「并发写互相撞」修好了，但它**不可重入** ——
// 一个任务的 `work()` 内部再调一次 `serializeOn(同一个 db, …)`，拿到的队尾就是**自己这次
// 尚未 resolve 的 promise**，于是它等自己 → **永久挂住**。
//
// 而「永久挂住」是**最糟糕的失效形态**：没有栈、没有 message、没有日志，生产现场只表现为
// 「应用卡住」，用户只能杀进程。改前的行为反而是**抛错**（`guardIdle()` 的
// `connection is inside a transaction` / JS 侧 `nested transactions not supported`）——可恢复。
//
// 具体会怎么踩到：`runAtomic` 的回调里如果去调**外层** storage 门面（`storage.sessions.save()`）
// 而不是回调参数里的 `repos.*`，或者 `runner.tx(async (ex) => …)` 的回调里又去调 `runner.*`
// 而不是用传进来的 `ex`。这两种写法人眼看不出来、类型也拦不住，**只能靠断言钉住**。
//
// 所以本文件把「当前不存在重入路径」这件事**固化成可执行的不变量**：将来谁加了跨仓储调用、
// 或者在事务回调里回头调顶层 runner，CI 直接红，而不是等生产上「应用卡住」再查三天。
//
// ## 口径说明
//
// 纯文本静态检查，不做 AST：用「抹掉字符串内容但保留长度」的骨架来配平括号，再在骨架上找
// `runner.tx(` / `runner.direct(`。抹字符串是必须的 —— 仓储里的 SQL 字面量大量带括号
// （`INSERT INTO x (a,b) VALUES (?,?)`），不抹就会把括号配平算错，反而漏判。
// 已知边界：模板字面量 `${…}` 里的代码也会被一起抹掉；仓储里没有那种写法，且**真要有**也
// 只会让本测试漏判（不会误报），漏判由第 6 条「joinedRunner 必须直通」兜住。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const REPOS = path.join(ROOT, 'src/services/storage/sqlite/repos')
const BACKEND = path.join(ROOT, 'src/services/storage/sqlite/backend.ts')

/** 六个仓储实现（`context.ts` 是执行器、`shared.ts` 是工具，不算仓储）。 */
const REPO_FILES = ['sessions.ts', 'blobs.ts', 'assets.ts', 'attachments.ts', 'memory.ts', 'staging.ts']

const read = (file) => readFileSync(file, 'utf8')

/**
 * 把字符串 / 模板字面量的**内容**替换成等长空格（保留换行，行号不变），
 * 这样括号配平就只数真正的代码括号。引号本身保留。
 */
const blankStrings = (src) => {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') {
          out[j] = ' '
          j += 1
          if (j < src.length) {
            if (src[j] !== '\n') out[j] = ' '
            j += 1
          }
          continue
        }
        if (src[j] === quote) break
        if (src[j] !== '\n') out[j] = ' '
        j += 1
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 从 `open`（一个 `(` 的下标）找配对的 `)`，返回其下标；找不到返回 -1。 */
const matchParen = (skeleton, open) => {
  let depth = 0
  for (let i = open; i < skeleton.length; i += 1) {
    if (skeleton[i] === '(') depth += 1
    else if (skeleton[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 找出所有 `runner.tx(` / `runner.direct(`，返回 [{ kind, start, bodyStart, bodyEnd }]。 */
const runnerCalls = (src, skeleton, kind) => {
  const needle = `runner.${kind}`
  const found = []
  let from = 0
  for (;;) {
    const at = skeleton.indexOf(needle, from)
    if (at === -1) break
    const open = skeleton.indexOf('(', at + needle.length)
    if (open === -1 || open - (at + needle.length) > 24) {
      from = at + needle.length
      continue
    }
    const close = matchParen(skeleton, open)
    if (close === -1) {
      from = at + needle.length
      continue
    }
    const line = skeleton.slice(0, at).split('\n').length
    found.push({ kind, line, bodyStart: open + 1, bodyEnd: close, body: src.slice(open + 1, close) })
    from = close
  }
  return found
}

/** 从 `name` 所在位置起，取它后面第一个函数体的花括号区间。 */
const blockAfter = (skeleton, name) => {
  const at = skeleton.indexOf(name)
  if (at === -1) return null
  const open = skeleton.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < skeleton.length; i += 1) {
    if (skeleton[i] === '{') depth += 1
    else if (skeleton[i] === '}') {
      depth -= 1
      if (depth === 0) return { start: open, end: i, text: skeleton.slice(open, i + 1) }
    }
  }
  return null
}

test('不变量 1：六个仓储之间没有跨仓储 createXRepo( 调用（否则会「repoA 排队中调 repoB」）', () => {
  const offenders = []
  for (const file of REPO_FILES) {
    const src = read(path.join(REPOS, file))
    const hits = [...src.matchAll(/\bcreate[A-Za-z]+Repo\s*\(/g)]
    for (const hit of hits) {
      offenders.push(`${file}:${src.slice(0, hit.index).split('\n').length}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `仓储文件里出现了 createXRepo( 调用：${offenders.join(', ')}。` +
      ' 仓储只能使用构造时传入的 runner，互相调用会把两条队列编成环 → 死锁。' +
      ' 需要跨仓储的原子操作，请用 runAtomic 的回调参数 repos.* 在外面组合。'
  )
  // 反向对照：确认这条断言不是「因为一个都没匹配上」而空过
  const backend = read(BACKEND)
  assert.ok(
    /createSessionRepo\s*\(/.test(backend),
    'backend.ts 里应当有 createSessionRepo( —— 否则说明本测试的正则已经和代码脱节，会静默空过'
  )
})

test('不变量 2：runner.tx 回调体内不再调 runner.direct / runner.tx / topRunner（否则等自己已持有的锁）', () => {
  const offenders = []
  let checked = 0
  for (const file of [...REPO_FILES, 'context.ts']) {
    const src = read(path.join(REPOS, file))
    const skeleton = blankStrings(src)
    for (const call of runnerCalls(src, skeleton, 'tx')) {
      checked += 1
      const bodySkeleton = blankStrings(call.body)
      for (const banned of ['runner.direct', 'runner.tx', 'topRunner']) {
        if (bodySkeleton.includes(banned)) {
          offenders.push(`${file}:${call.line} 的 runner.tx 回调里出现 ${banned}`)
        }
      }
    }
  }
  assert.ok(checked > 0, '一个 runner.tx( 都没解析到 —— 解析器已和代码脱节，本断言会静默空过')
  assert.deepEqual(
    offenders,
    [],
    `事务回调里回头调顶层 runner：\n  ${offenders.join('\n  ')}\n` +
      ' 回调内只能使用传进来的 ex 句柄（读 / 写都走它），否则会等自己已持有的锁 → 永久挂起（不是报错）。'
  )
})

test('不变量 3：runAtomic 绑定的是 joinedRunner(tx)，atomic 仓储摸不到 topRunner', () => {
  const src = read(BACKEND)
  const skeleton = blankStrings(src)
  const block = blockAfter(skeleton, 'runAtomic:')
  assert.ok(block !== null, 'backend.ts 里找不到 runAtomic: 的实现块 —— 解析器已脱节')
  assert.match(
    block.text,
    /buildRepos\s*\(\s*joinedRunner\s*\(\s*tx\s*\)/,
    'runAtomic 必须用 buildRepos(joinedRunner(tx), …) 造回调参数：' +
      ' 换成 topRunner 就等于在事务里再排队，必然死锁。'
  )
  assert.ok(
    !block.text.includes('topRunner('),
    'runAtomic 的回调参数里不许出现 topRunner( —— atomic 仓储必须走 joinedRunner 的直通执行器'
  )
})

test('不变量 4：嵌套 runAtomic 仍然「抛错」而不是「排队等等」—— throw 必须在 serializeOn 之前', () => {
  const src = read(BACKEND)
  const block = blockAfter(blankStrings(src), 'runAtomic:')
  assert.ok(block !== null, 'backend.ts 里找不到 runAtomic: 的实现块')
  // 注意：block.text 是抹掉字符串后的骨架，所以这里按「结构」找而不是按错误文案找；
  // 文案本身另在原文里核对一次，避免断言和真实代码脱节。
  const guardAt = block.text.indexOf('atomicDepth > 0')
  assert.notEqual(guardAt, -1, '嵌套 runAtomic 的深度守卫（atomicDepth > 0）不见了 —— 嵌套会退化成等待')
  const throwAt = block.text.indexOf('throw', guardAt)
  const blockEnd = block.text.length
  assert.ok(throwAt > guardAt && throwAt < blockEnd, '原子深度守卫后面没有 throw —— 嵌套会变成排队')
  const gateAt = block.text.indexOf('serializeOn(')
  assert.notEqual(gateAt, -1, 'runAtomic 没有过串行闸（serializeOn(）—— 那它还会和顶层写相撞')
  assert.ok(
    guardAt < gateAt,
    '嵌套保护必须排在 serializeOn 之前：放到后面的话，嵌套调用会先排队等自己 → 挂起而不是报错'
  )
  assert.ok(
    src.includes('runAtomic 不允许嵌套'),
    '错误文案「runAtomic 不允许嵌套」不见了 —— 这条可恢复的错被改成了别的语义'
  )
})

test('不变量 5：joinedRunner 必须是直通（自己不许过 serializeOn）', () => {
  const src = read(path.join(REPOS, 'context.ts'))
  const skeleton = blankStrings(src)
  const block = blockAfter(skeleton, 'export const joinedRunner')
  assert.ok(block !== null, 'context.ts 里找不到 joinedRunner 的实现块')
  assert.ok(
    !block.text.includes('serializeOn('),
    'joinedRunner 不许过 serializedOn：它跑在已持有的事务里，排队会等自己 → 死锁。' +
      ' 它必须是 `work(tx)` 直通。'
  )
  assert.match(block.text, /work\s*\(\s*tx\s*\)/, 'joinedRunner 的 direct / tx 都应当直接执行 work(tx)')
})

test('不变量 6：serializeOn 的注释必须写明「不可重入」「会永久挂起」「回调内禁止调顶层 runner」', () => {
  const src = read(path.join(REPOS, 'context.ts'))
  // 不校验措辞，只校验「这条不变量被写下来了」——注释被删掉时这里会红，逼后来人恢复。
  // 为什么不靠运行期检测：浏览器没有 AsyncLocalStorage，跑不出「任务内重入 vs 外部并发」的区分，
  // 所以注释 + 静态护栏就是这条不变量的全部载体。
  assert.ok(src.includes('不可重入'), 'context.ts 里必须写明串行闸「不可重入」')
  assert.ok(src.includes('永久挂起'), 'context.ts 里必须写明重入的后果是「永久挂起」而不是报错')
  assert.match(
    src,
    /禁止[^\n]*topRunner\.direct/,
    'context.ts 里必须写明「回调内部禁止再调 topRunner.direct」，并点名 topRunner.tx'
  )
  assert.match(src, /topRunner\.tx/, 'context.ts 里必须同时点名 topRunner.tx')
})
