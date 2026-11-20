// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #18（剩余项）
//
// 会话自动标题的 system prompt 必须走 i18n：en 下不许再出现中文（旧版是整段中文硬编码，
// 连「约 8–14 个中文字符」都写死，en 用户拿到的标题因此被中文长度引导）。
// zh 下必须**逐字不变**，不许顺手改中文提示词。
//
//   node tests/unit/auto-title-prompt-i18n.test.mjs
//
// 覆盖（对应 Issue #18 关闭条件）：
//   [1] zh / en 两份都有 5 条提示词 key，键名对齐、非空
//   [2] en：prompt 与每条 en 文案都不含中文（CJK 汉字 / CJK 标点 / 全角）
//   [3] en：prompt 与 zh 的 prompt 不相同（真的切了语言，不是漏读 locale）
//   [4] zh：prompt 与修复前**逐字一致**（5 行硬编码字符串对照）
//   [5] zh：本地截取兜底逐字不变（与 tests/integration/auto-title.test.mjs 的期望值同源）
//   [6] en：本地截取兜底不含中文
//   [7] 行为不回归：「标题：」这类中文前缀在 en 下也要剥掉（清洗规则不随语言变）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
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

// 打包期注入的常量（rspack DefinePlugin）：纯 Node 跑源码时补一个占位值，
// 只影响「新建配置的预填 base url」，本用例不联网、不读它
globalThis.__API_ORIGIN__ = 'http://127.0.0.1:1'

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const autoTitle = await import('../../src/services/chat/autoTitle.ts')

const PROMPT_KEYS = [
  'autoTitlePromptIntro',
  'autoTitlePromptFormat',
  'autoTitlePromptLanguage',
  'autoTitlePromptLength',
  'autoTitlePromptFallback',
]

/** 修复前的整段中文 prompt（逐字对照，zh 侧必须一字不改） */
const EXPECTED_ZH_PROMPT = [
  '根据提供的用户消息，为这段 AI 对话生成一个简洁标题。',
  '只输出标题本身，一行纯文本，不要引号、前缀、解释、Markdown、XML 或控制字符，不允许输出代码。',
  '使用消息的语言。',
  '目标长度：约 8–14 个中文字符（或 3–5 个英文单词）。',
  '如果消息信息量太少，也要给一个简短的最佳猜测标题（如「打招呼」），不要解释。',
].join('\n')

/** 修复前 fallbackTitle 的期望值（tests/integration/auto-title.test.mjs 里的 LOCAL_FALLBACK 同源） */
const ZH_QUESTION = '你好，请问这个网络问题怎么解决？我这边代理一直连不上'
const EXPECTED_ZH_FALLBACK = '这个网络问题怎么解决…'
const EN_QUESTION = 'My proxy keeps disconnecting, how do I fix the network settings? It fails after a minute'

const failures = []
let checks = 0
const eq = (actual, expected, label) => {
  checks += 1
  if (actual !== expected) failures.push(`${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}
const ok = (condition, label, detail = '') => {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : `\n  ${detail}`}`)
}

const useLocale = (locale) => useSettings.setState({ locale })

/** 中文：汉字（含扩展 A）、CJK 标点、全角字符。不含 U+2026 省略号（中英共用） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const hasCjk = (text) => CJK.test(text)

/**
 * 读当前语言下的 system prompt。
 * 修复前没有 `autoTitleSystemPrompt()`：退回旧的模块级常量，让断言照常跑出真实差异（红），
 * 而不是在取函数时就崩掉。
 */
const prompt = () => {
  if (typeof autoTitle.autoTitleSystemPrompt === 'function') return autoTitle.autoTitleSystemPrompt()
  const legacy = autoTitle.AUTO_TITLE_SYSTEM_PROMPT
  return typeof legacy === 'string' ? legacy : ''
}

// ---------------------------------------------------------------- [1] 键对齐
console.log('\n[1] zh / en 都有自动标题提示词 key')
{
  for (const key of PROMPT_KEYS) {
    ok(typeof zh[key] === 'string' && zh[key] !== '', `zh 有 ${key}`, `zh.${key}=${JSON.stringify(zh[key])}`)
    ok(typeof en[key] === 'string' && en[key] !== '', `en 有 ${key}`, `en.${key}=${JSON.stringify(en[key])}`)
  }
}

// ---------------------------------------------------------------- [2] en 无中文
console.log('[2] en 下 prompt 与每条文案都不含中文')
{
  useLocale('en-US')
  const text = prompt()
  ok(text !== '', 'en prompt 非空')
  ok(!hasCjk(text), 'en prompt 不含中文', `en prompt=${JSON.stringify(text)}`)
  for (const key of PROMPT_KEYS) {
    const value = typeof en[key] === 'string' ? en[key] : ''
    ok(!hasCjk(value), `en.${key} 不含中文`, `en.${key}=${JSON.stringify(value)}`)
  }

  // ------------------------------------------------------------ [3] 真的切语言
  useLocale('zh-CN')
  const zhPrompt = prompt()
  useLocale('en-US')
  ok(prompt() !== zhPrompt, 'en prompt 与 zh prompt 不同（locale 真的生效）')

  // ------------------------------------------------------------ [6] en 兜底无中文
  const enFallback = autoTitle.fallbackTitle(EN_QUESTION)
  ok(enFallback !== '', 'en fallbackTitle 非空')
  ok(!hasCjk(enFallback), 'en fallbackTitle 不含中文', `fallbackTitle=${JSON.stringify(enFallback)}`)

  // ------------------------------------------------------------ [7] 清洗行为不随语言变
  eq(autoTitle.sanitizeTitle('标题：代理配置'), '代理配置', 'en 下仍剥掉中文「标题：」前缀')
}

// ---------------------------------------------------------------- [4] zh 逐字不变
console.log('[4] zh 下 prompt 逐字不变')
{
  useLocale('zh-CN')
  eq(prompt(), EXPECTED_ZH_PROMPT, 'zh prompt 逐字一致')

  // ------------------------------------------------------------ [5] zh 兜底逐字不变
  eq(autoTitle.fallbackTitle(ZH_QUESTION), EXPECTED_ZH_FALLBACK, 'zh fallbackTitle 逐字一致')
}

const label = failures.length === 0 ? 'PASS' : 'FAIL'
console.log(`\n${label} ${checks - failures.length}/${checks}`)
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`)
  for (const item of failures) console.error(`  ✗ ${item}`)
  process.exitCode = 1
}
