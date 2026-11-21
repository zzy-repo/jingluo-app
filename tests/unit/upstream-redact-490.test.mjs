// [layer: unit | 依赖: 无（纯 Node，零浏览器 / 零网络 / 零 localStorage） | 耗时: <1s]
//
// Issue #490 的第 3 个关闭条件：**上游原文的脱敏工具「独立可用」**。
//
// 三件事一个都不能少（都是关闭条件原文）：
//   1. 抹掉 Key，**只留尾 6 位**（用户要能认出是哪一把被上游拒了）；
//   2. 压成一行；
//   3. 超 240 字符截断，且**先脱敏、后截断** —— 顺序反了，一把跨过 240 边界的 Key 会被切成
//      半截：半截既不再是密钥形状（规则认不出来），又还是可用的凭证片段，截断本身成了泄露渠道。
//
// 本文件第 [4] 组「跨边界样本」就是为这条顺序写的：它把**反转顺序**的那份实现也放在用例里，
// 断言「反转会漏出密钥中段」—— 谁把 `redactUpstreamText()` 的步骤调过来，第 [4] 组立刻红。
//
//   node --test tests/unit/upstream-redact-490.test.mjs
//   node tests/run-layer.mjs unit --only upstream-redact-490
//
// 这个文件**不装任何替身**：工具能用就是因为它零依赖（不需要 DOM / 存储 / 桥），
// 这也是「独立可用」的一条硬证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  maskApiKeyTail,
  redact,
  redactUpstreamText,
  truncate,
  UPSTREAM_TEXT_MAX_CHARS,
} from '../../src/services/diagnostics/redact.ts'

/** #490 原文给的那把样本 Key：`sk-` 后 12 位（短于老判据的 20 位下限） */
const SAMPLE_KEY = 'sk-abcdef123456'

// ---------------------------------------------------------------- [1] Key 只留尾 6 位

test('[1] 抹掉 Key：只留尾 6 位，原文一个字都不留', () => {
  const out = redactUpstreamText(`upstream rejected the relay key ${SAMPLE_KEY} while streaming`)

  assert.equal(out.includes(SAMPLE_KEY), false, 'Key 原文不许出现在输出里')
  assert.equal(out.includes('abcdef'), false, 'Key 中段（前 6 位之后的部分）同样不许留')
  assert.ok(out.includes('••••123456'), `尾 6 位要留下，实际：${out}`)
  assert.ok(out.includes('upstream rejected'), '正文其余部分照旧保留')
})

test('[1] 尾号口径：`maskApiKeyTail` 的尾巴长度可调，默认 6 位', () => {
  assert.equal(maskApiKeyTail(SAMPLE_KEY), '••••123456', '默认留尾 6 位')
  assert.equal(maskApiKeyTail(SAMPLE_KEY, 4), '••••3456', '调用方能要更短的尾巴')
  // 与 `redact()` 共用同一条 sk- 形状：同一段文本，两边都认得出这把 Key，只是呈现不同
  assert.equal(redact(SAMPLE_KEY), 'sk-***', '日志 / 导出边界仍是整段归零')
})

// ---------------------------------------------------------------- [2] 压成一行

test('[2] 压成一行：换行 / 制表符 / 连续空格都收成一个空格', () => {
  const messy = 'invalid\nrequest:\n\t"messages.0.content"   failed\n\n(retry later)'
  const out = redactUpstreamText(messy)
  assert.equal(out.includes('\n'), false, '不许留换行')
  assert.equal(out.includes('\t'), false, '不许留制表符')
  assert.equal(out, 'invalid request: "messages.0.content" failed (retry later)')
})

// ---------------------------------------------------------------- [3] 240 字符截断

test('[3] 超 240 字符截断到 240（常量就是判据，不写死数字）', () => {
  assert.equal(UPSTREAM_TEXT_MAX_CHARS, 240, '与 #104 的单行上限同一量级')
  const long = 'x'.repeat(300)
  const out = redactUpstreamText(long)
  assert.equal(out.length, UPSTREAM_TEXT_MAX_CHARS, '恰好截到 240')
  assert.equal(out, long.slice(0, 240), '从尾部截断，不是掐掉开头')

  const short = 'y'.repeat(100)
  assert.equal(redactUpstreamText(short), short, '不到 240 不动它')
})

// ---------------------------------------------------------------- [4] 顺序：先脱敏后截断

/**
 * 跨 240 边界的样本：210 个字符的前缀 + 一把 39 位的 Key。
 *
 * 正确顺序（脱敏 → 截断）：Key 先被打成 `••••` + 尾 6 位（10 字符），整段只有 220 字符，
 * 一个字都不需要截 —— 密钥中段没有任何机会出现在输出里。
 *
 * 反转顺序（截断 → 脱敏）：先按 240 切，Key 被切成 `sk-` + 前 27 位；这半截仍是密钥形状，
 * 于是被打成 `••••` + **这半截的**尾 6 位 —— 那是密钥**中段**的 6 个字符，真实尾巴反而丢了。
 */
const KEY_BODY = 'aaaabbbbccccddddeeeeffffgggghhhhiiii'
const LONG_KEY = `sk-${KEY_BODY}`
const CROSSING_SAMPLE = `${'p'.repeat(210)}${LONG_KEY}`

/** 反过来的那份实现，只在本用例里存在：它证明「顺序」不是无关紧要的风格问题 */
const wrongOrder = (text) => maskApiKeyTail(truncate(text, UPSTREAM_TEXT_MAX_CHARS))

test('[4] 跨 240 边界：先脱敏后截断，密钥中段一个字都不留', () => {
  const out = redactUpstreamText(CROSSING_SAMPLE)

  assert.ok(out.length <= UPSTREAM_TEXT_MAX_CHARS, '输出不超过 240')
  assert.ok(out.includes(`••••${LONG_KEY.slice(-6)}`), '真尾巴照旧留下（尾 6 位口径）')
  assert.equal(out.includes(KEY_BODY.slice(0, 6)), false, '密钥中段（前 6 位）不许明文出现')
  assert.equal(out.includes('sk-'), false, '连 `sk-` 前缀都不该出现')
})

test('[4] 负向对照：把顺序反过来，同一段样本就会漏出密钥中段', () => {
  const leaked = wrongOrder(CROSSING_SAMPLE)

  // 「先截断再脱敏」的真实后果：截断剩下的半截 Key（`sk-` + 前 27 位）仍是密钥形状，
  // 于是被当成一把**新** Key 打码 —— 它留下的「尾 6 位」其实是原 Key 的中段字符。
  const middleSix = LONG_KEY.slice(24, 30)
  assert.notEqual(middleSix, LONG_KEY.slice(-6), '样本本身要能把「中段」和「真尾巴」区分开')
  assert.equal(leaked.includes(`••••${middleSix}`), true, '反转顺序：露的是密钥中段 6 个字符')
  assert.equal(leaked.includes(`••••${LONG_KEY.slice(-6)}`), false, '反转顺序：真尾巴反而丢了')
  assert.ok(leaked.length < CROSSING_SAMPLE.length, '先截断，长度已经先被切掉一截')
})

// ---------------------------------------------------------------- [5] 复用，而不是第二套规则

test('[5] 复用既有规则集：Bearer / token / 卡密 / 手机号 / 设备码 / 卡号 一样都不少', () => {
  const dirty = [
    'Authorization: Bearer sk-live-2f4c9a1b8d3e7f6051a2b3c4',
    'callback?token=SECRET_TOKEN_1',
    'card MUSE-3CYP-5NA3-AHSE-A3SR',
    'phone 13812345678',
    'device d-0123456789abcdef0123456789abcdef',
    'pan 4111111111111111',
  ].join('\n')
  const out = redactUpstreamText(dirty)

  for (const secret of [
    'sk-live-2f4c9a1b8d3e7f6051a2b3c4',
    'SECRET_TOKEN_1',
    'MUSE-3CYP-5NA3-AHSE-A3SR',
    '13812345678',
    'd-0123456789abcdef0123456789abcdef',
    '4111111111111111',
  ]) {
    assert.equal(out.includes(secret), false, `漏了：${secret}（应当是 redact() 的既有规则接住的）`)
  }
  assert.ok(out.includes('Bearer ***'), 'Bearer 头走既有规则')
  assert.ok(out.includes('token=***'), 'token= 走既有规则')
})

test('[5] 时间戳 / 雪花 ID 不被误伤（规则写宽了这里会红，#387 的负例仍在守）', () => {
  const benign = 'ts=1732051200000 snowflake=1234567890123456789 elapsed 1234ms'
  assert.equal(redactUpstreamText(benign), benign, '没有任何密钥形状时，原文照旧')
})
