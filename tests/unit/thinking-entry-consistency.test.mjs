// [layer: unit | dependencies: none（纯 Node，无浏览器/网络） | 耗时: <1s]
//
// GitHub issue #341：深度思考 / 专家模式入口在四个渠道表现一致 —— 入口恒常驻、
// 外观不降级（不置灰、不带 disabled / aria-disabled）、可点击、档位真翻转；
// 请求侧由 REQUEST_GATES 拦截：第三方 openai 一个思考字段都不发；ours 自 #363 起认
// reasoning_effort（档位 high），门禁放行。
//
// 覆盖（对应 issue 的 4 渠道 × 2 入口矩阵）：
//   [1] 深度思考入口：四渠道都渲染；无 disabled；data-thinking-effective 只标记是否真生效；
//       点击后 settings.chatMode / thinking / localStorage 真翻转
//   [2] 快速/专家入口：Welcome.tsx 不再用 caps.thinking 早退，两个 button[data-mode] 恒渲染、
//       无 disabled、挂 data-thinking-effective；setChatMode 在四渠道都真写档位
//   [3] 请求体：deepseek / anthropic 照旧带 thinking；openai 零思考字段；ours 带 reasoning_effort: high（#363）
//
//   node tests/run-layer.mjs unit --only thinking-entry-consistency
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

/** 最小 localStorage：settings.ts / apiConfig.ts 只在读不到时回落默认值 */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__ENDPOINTS__ ??= { chatBaseUrl: 'https://ours.test.invalid' }
globalThis.INTERNAL_BUILD = false

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const providers = await import('../../src/services/api/providers.ts')
const settings = await import('../../src/services/settings.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const { toOpenAIRequest } = await import('../../src/services/api/openaiAdapter.ts')
const { ThinkingToggle, THINKING_TOGGLE_ATTR } = await import(
  '../../src/components/chatInput/ThinkingToggle.ts'
)

const KINDS = providers.PROVIDER_KINDS
// #363：ours 从「开关点了也不生效」改成真生效（reasoning_effort + high），所以这里从 false 变 true。
// 第三方 openai 仍是 false：它的能力我们不知道，不猜（REQUEST_GATES.reasoning_param 拦下）。
const EXPECTED_EFFECTIVE = { deepseek: 'true', anthropic: 'true', openai: 'false', ours: 'true' }

const TOGGLE_PROPS = {
  label: '深度思考',
  tooltip: '先思考后回答，解决推理问题',
  icon: null,
  className: 'toggle',
  selectedClassName: 'selected',
  labelClassName: 'toggleLabel',
}

const renderToggle = (caps, thinking) =>
  renderToStaticMarkup(
    createElement(ThinkingToggle, { ...TOGGLE_PROPS, caps, thinking, onToggle: () => {} })
  )

// ============ [1] 入口 1：深度思考（四渠道 × DOM / 点击） ============
test('[1] 四渠道深度思考入口恒常驻、无 disabled、点击真翻档位（#341）', () => {
  for (const kind of KINDS) {
    const spec = providers.getSpec(kind)
    const html = renderToggle(spec.caps, false)

    assert.ok(html.includes(THINKING_TOGGLE_ATTR), `${kind} 缺少深度思考入口：${html}`)
    assert.match(html, /<button /, `${kind} 入口不是按钮：${html}`)
    assert.doesNotMatch(html, /\sdisabled(=|[\s>])/, `${kind} 入口被 disabled：${html}`)
    assert.doesNotMatch(html, /aria-disabled/, `${kind} 入口带 aria-disabled：${html}`)
    assert.doesNotMatch(html, /\shidden(=|[\s>])/, `${kind} 入口被隐藏：${html}`)
    assert.ok(html.includes('aria-pressed="false"'), `${kind} 初始档位不是关闭态：${html}`)
    assert.ok(
      html.includes(`data-thinking-effective="${EXPECTED_EFFECTIVE[kind]}"`),
      `${kind} 的 data-thinking-effective 应为 ${EXPECTED_EFFECTIVE[kind]}：${html}`
    )

    // 点击：与 ChatInput 完全一致的接线 onToggle = () => setThinking(!thinking)
    settings.setThinking(false)
    const props = {
      ...TOGGLE_PROPS,
      caps: spec.caps,
      thinking: false,
      onToggle: () => settings.setThinking(!settings.useSettings.getState().thinking),
    }
    const element = ThinkingToggle(props)
    assert.equal(typeof element.props.onClick, 'function', `${kind} 入口没有 onClick`)
    element.props.onClick()
    assert.equal(settings.useSettings.getState().chatMode, 'expert', `${kind} 点击后没切到专家模式`)
    assert.equal(settings.useSettings.getState().thinking, true, `${kind} 点击后 thinking 没翻转`)
    assert.equal(localStorage.getItem('chat-demo:chat-mode'), 'expert', `${kind} 没写 chat-mode`)
    assert.equal(localStorage.getItem('chat-demo:thinking'), 'true', `${kind} 没写 thinking`)
    assert.ok(
      renderToggle(spec.caps, true).includes('aria-pressed="true"'),
      `${kind} 点击后 aria-pressed 没翻转`
    )
    settings.setThinking(false)
  }
})

// ============ [2] 入口 2：快速 / 专家模式（Welcome.tsx 恒渲染 + 档位写入） ============
test('[2] 四渠道快速/专家入口恒常驻、无 disabled（Welcome.tsx 不再看 caps.thinking）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/components/session/Welcome.tsx', import.meta.url)),
    'utf8'
  )

  assert.doesNotMatch(source, /if\s*\(\s*!caps\.thinking\s*\)/, 'Welcome 仍在用 caps.thinking 早退')
  assert.doesNotMatch(source, /return\s+null/, 'Welcome 仍会让入口整块消失')
  assert.doesNotMatch(source, /\sdisabled=/, 'Welcome 的入口带 disabled')
  assert.doesNotMatch(source, /aria-disabled=/, 'Welcome 的入口带 aria-disabled')
  assert.match(source, /data-mode=\{option\.mode\}/, 'Welcome 没有渲染两个 data-mode 按钮')
  assert.match(source, /onClick=\{\(\) => setChatMode\(option\.mode\)\}/, 'Welcome 点击没接到 setChatMode')
  assert.match(
    source,
    /data-thinking-effective=\{caps\.thinking \? 'true' : 'false'\}/,
    'Welcome 缺少不可见的 data-thinking-effective 标记'
  )

  // 四渠道都走同一个 setChatMode：档位写入与渠道无关，且不产生任何请求
  for (const kind of KINDS) {
    localStorage.setItem('chat-demo:provider-kind', kind)
    for (const mode of ['fast', 'expert', 'fast']) {
      settings.setChatMode(mode)
      assert.equal(settings.useSettings.getState().chatMode, mode, `${kind} 没切到 ${mode}`)
      assert.equal(
        localStorage.getItem('chat-demo:chat-mode'),
        mode,
        `${kind} 没把 ${mode} 写进 localStorage`
      )
    }
  }
})

// ============ [3] 请求侧：四渠道矩阵（官方零变化、openai 零字段、ours 带档位） ============
test('[3] 请求体：deepseek/anthropic 带 thinking，openai 零字段，ours 带 reasoning_effort（#341 / #363）', () => {
  const input = {
    model: 'mock-model',
    system: 'system',
    messages: [{ role: 'user', content: '你好' }],
    thinking: true,
  }

  for (const kind of KINDS) {
    const spec = providers.getSpec(kind)
    const body = buildMessageBody(spec, input)
    const sent = toOpenAIRequest(body, spec)

    if (spec.protocol === 'anthropic') {
      assert.equal(body.thinking?.type, 'enabled', `${kind} 开启态丢了 thinking：${JSON.stringify(body)}`)
      assert.equal(
        Object.hasOwn(body.thinking ?? {}, 'budget_tokens'),
        kind === 'anthropic',
        `${kind} 的 budget_tokens 不符合预期：${JSON.stringify(body.thinking)}`
      )
      assert.equal(
        providers.requestGates(spec).reasoning_param,
        true,
        `${kind} 的 reasoning_param 门禁应放行`
      )
    } else if (kind === 'ours') {
      // #363：我们自己的网关认 reasoning_effort，门禁放行、档位 high —— 开关必须真的生效
      assert.equal(body.thinking?.type, 'enabled', `ours 请求侧必须开启 thinking：${JSON.stringify(body)}`)
      assert.equal(sent.reasoning_effort, 'high', `ours 适配后应带 reasoning_effort: high：${JSON.stringify(sent)}`)
      assert.equal(
        Object.hasOwn(sent, 'thinking'),
        false,
        `ours 走 reasoning_effort 档，不该再带 thinking：${JSON.stringify(sent)}`
      )
      assert.equal(providers.requestGates(spec).reasoning_param, true, 'ours 的 reasoning_param 门禁应放行')
    } else {
      assert.equal(body.thinking?.type, 'disabled', `${kind} 请求侧不该开启 thinking`)
      assert.equal(
        Object.hasOwn(sent, 'thinking'),
        false,
        `${kind} 适配后不该带 thinking：${JSON.stringify(sent)}`
      )
      assert.equal(
        Object.hasOwn(sent, 'reasoning_effort'),
        false,
        `${kind} 适配后不该带 reasoning_effort：${JSON.stringify(sent)}`
      )
      assert.equal(
        providers.requestGates(spec).reasoning_param,
        false,
        `${kind} 的 reasoning_param 门禁应拦截`
      )
    }
  }
})
