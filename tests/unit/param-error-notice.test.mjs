// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// issue #353：上游「参数错误」提示必须可操作 —— 带原文、带当前配置、能跳设置、发送前先拦。
//
//   cd /root/deepseek-app && node tests/unit/param-error-notice.test.mjs
//
// [1] 脱敏：API Key 只留尾 6 位；太短的串不当作密钥
// [2] 原文压成一行：换行/连续空白折叠，超长截断（240 字符 + 省略号）
// [3] 发送前自检：空模型 / 模型带空格 / 空地址 / 缺协议头 / 把具体接口填进服务地址
// [4] 自检不误伤：`/v1` 在不在都合法（joinUrl 会去重），官方渠道地址不挑
//
// 源码里的相对 import 是 `.js` 写法（tsc NodeNext 要求），这里挂 resolve hook 指到 `.ts`。
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'

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

const { checkSendConfig, maskSecrets, sanitizeUpstreamError } = await import(
  '../../src/services/api/paramErrorNotice.ts'
)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok ${label}`)
}

console.log('[1] 脱敏')
check('API Key 只留尾 6 位', () => {
  assert.equal(maskSecrets('key sk-live-abcdef123456 rejected', ['sk-live-abcdef123456']), 'key ••••123456 rejected')
})
check('太短的串不当作密钥（避免误伤普通单词）', () => {
  assert.equal(maskSecrets('model gpt-4o is invalid', ['gpt-4o']), 'model gpt-4o is invalid')
})
check('空密钥列表原样返回', () => {
  assert.equal(maskSecrets(' plain text ', []), ' plain text ')
})

console.log('[2] 原文压成一行')
check('换行与连续空白折叠', () => {
  assert.equal(sanitizeUpstreamError('bad\n\n  request:   model  not found '), 'bad request: model not found')
})
check('空原文返回空串（调用方据此换「上游没给字段」那档文案）', () => {
  assert.equal(sanitizeUpstreamError('   \n  '), '')
})
check('超长截断到 240 字符 + 省略号', () => {
  const out = sanitizeUpstreamError('x'.repeat(400))
  assert.equal(out.length, 241)
  assert.ok(out.endsWith('…'))
})
check('先脱敏再截断（密钥不会因为截断而漏出前缀）', () => {
  const key = 'sk-very-secret-0987654321'
  const out = sanitizeUpstreamError(`invalid key ${key} for model x`, [key])
  assert.ok(!out.includes(key))
  assert.ok(out.includes('••••654321'))
})

console.log('[3] 发送前自检')
const base = { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4.1-flash' }
check('正常配置放行', () => {
  assert.equal(checkSendConfig(base), null)
})
check('模型为空 → modelEmpty', () => {
  assert.equal(checkSendConfig({ ...base, model: '   ' }), 'modelEmpty')
})
check('模型名带空格 → modelHasSpaces', () => {
  assert.equal(checkSendConfig({ ...base, model: 'deepseek v4.1' }), 'modelHasSpaces')
})
check('地址为空 → baseUrlEmpty', () => {
  assert.equal(checkSendConfig({ ...base, baseUrl: '' }), 'baseUrlEmpty')
})
check('漏了协议头 → baseUrlNotHttp', () => {
  assert.equal(checkSendConfig({ ...base, baseUrl: 'api.example.com/v1' }), 'baseUrlNotHttp')
})
check('把具体接口填进服务地址 → baseUrlLooksLikeEndpoint', () => {
  assert.equal(
    checkSendConfig({ ...base, baseUrl: 'https://api.example.com/v1/chat/completions' }),
    'baseUrlLooksLikeEndpoint'
  )
})

console.log('[4] 自检不误伤')
check('根地址不带 /v1 也合法（joinUrl 会拼路径）', () => {
  assert.equal(checkSendConfig({ ...base, baseUrl: 'https://api.example.com' }), null)
})
check('官方渠道不挑地址', () => {
  assert.equal(checkSendConfig({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }), null)
})
check('Anthropic 兼容渠道同样接受带 /v1 的地址', () => {
  assert.equal(
    checkSendConfig({ kind: 'anthropic', baseUrl: 'https://api.example.com/v1', model: 'claude-x' }),
    null
  )
})

console.log(`\n${passed} 项通过`)
