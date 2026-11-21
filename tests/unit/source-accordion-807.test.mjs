// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + renderToStaticMarkup，零浏览器、零真实网络） | 耗时: <2s]
//
// Issue #807：「模型来源」重构为**单层手风琴** + 内置服务行内领取 +「确认使用」+ 打勾标识。
//
// 这一页以前是三层：L1 列表 → L2 三个来源 → L3 每一行的字段子页（带「返回」）。本单把它压成一层：
// 三行行头、同一时间只展开一行，展开区里就是这一行要配的东西。八条验收（与 issue 一一对应）：
//
//   [①] 手风琴：展开第三方 → 再点官方 → 第三方自动收起（同一时间只一行）
//   [②] 行头状态：未配置 / ✓ 当前使用；`aria-expanded` / `aria-controls` 正确
//   [③] 内置服务未登录 → 弹登录、**不调用发放接口**；登录完成后**自动继续领取**（领取真的被触发）
//   [④] 领取中 → 行禁用 + 「领取中…」；成功后才打勾并生效
//   [⑤] 领取失败 → 不选中 + 行内原因 + 「重试」
//   [⑥] 第三方填完 + 「确认使用」→ 才切换生效来源并打勾；**只展开不点确认 → 不切换**
//   [⑦] 收起后草稿仍在；重启（重新读 storage）后打勾保持在那一个生效来源
//   [⑧] 内置服务下**没有** Key 展示 / 复制 /「重新领取」DOM
//
// 为什么这么测：`.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除范围内），所以
//   · 状态机 / 校验 / 状态判定抽成纯函数 `components/settings/sourceAccordion.ts`；
//   · 视图抽成 `sourceAccordionView.ts`（真 zh 文案 + `renderToStaticMarkup`）；
//   · 副作用只有两条路，收在 `sourceAccordionRuntime.ts`（领 取 / 确认使用 —— 全页仅有的两处
//     `setProviderKind`），用例直接跑它 + 注入假的消费层客户端。
// 断言断的都是**界面真的会渲染 / 真的会调**的那一份，不是一份平行真理。
//
//   node --test tests/unit/source-accordion-807.test.mjs
//   node tests/run-layer.mjs unit --only source-accordion-807
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'

import { installChatBridge, installEndpointsGlobals, ROOT, setupDom } from '../helpers/dom-env.mjs'
import { pinLocale } from '../helpers/locale.mjs'

// 原生桥 + 诊断写入口替身：apiConfig / managedKeyRuntime / settingsDialogState 会调 recordAction
installChatBridge()
// 构建期注入值（`__ENDPOINTS__` / `__API_ORIGIN__`）：apiConfig 顶层就要读
installEndpointsGlobals()
const dom = setupDom()

const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const plan = await import('../../src/components/settings/sourceFieldPlan.ts')
const accordion = await import('../../src/components/settings/sourceAccordion.ts')
const view = await import('../../src/components/settings/sourceAccordionView.ts')
const runtime = await import('../../src/components/settings/sourceAccordionRuntime.ts')
const consumeClient = await import('../../src/services/consumeClient.ts')
const { useAuthStore } = await import('../../src/services/auth/store.ts')
const { renderToStaticMarkup } = await import('react-dom/server')

test.after(() => {
  consumeClient.setConsumeClient(null)
  dom.restore()
})

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** CSS Module 类名表替身：取什么给什么（断言不依赖类名，只为让真视图能渲染） */
const classNames = new Proxy({}, { get: (_t, name) => String(name) })

const staticMarkup = (element) => renderToStaticMarkup(element)

const hasTestId = (markup, testId) => markup.includes(`data-testid="${testId}"`)

/**
 * 取某个 `data-testid` **整个元素**的 markup（按同名标签配平，嵌套也取全）。
 *
 * 为什么要配平、不只截到下一个 `data-testid`：行头状态里套着一个 ✓ 的 `<span>`，
 * 截到「下一个 testid」会正好切在标签中间，后面提取文字就变成一堆属性文本。
 */
const elementOf = (markup, testId) => {
  const marker = `data-testid="${testId}"`
  const at = markup.indexOf(marker)
  if (at < 0) {
    return ''
  }
  const start = markup.lastIndexOf('<', at)
  const openEnd = markup.indexOf('>', at)
  if (start < 0 || openEnd < 0) {
    return ''
  }
  const tag = /^<([a-zA-Z]+)/u.exec(markup.slice(start))?.[1] ?? ''
  if (tag === '' || markup[openEnd - 1] === '/') {
    return markup.slice(start, openEnd + 1)
  }
  const openRe = new RegExp(`<${tag}[\\s>]`, 'gu')
  const closeRe = new RegExp(`</${tag}>`, 'gu')
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0) {
    openRe.lastIndex = cursor
    closeRe.lastIndex = cursor
    const nextOpen = openRe.exec(markup)
    const nextClose = closeRe.exec(markup)
    if (nextClose === null) {
      return markup.slice(start)
    }
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth++
      cursor = nextOpen.index + 1
      continue
    }
    depth--
    cursor = nextClose.index + tag.length + 3
  }
  return markup.slice(start, cursor)
}

/** 某个 `data-testid` 元素的纯文本（失败信息里给一句话，不灌整页 DOM） */
const textOf = (markup, testId) =>
  elementOf(markup, testId)
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

/** 从渲染结果里取出某一行行头（`<button …data-testid="settings-source-x"…>`）的整段标签 */
const headerTagOf = (markup, row) => {
  const marker = `data-testid="settings-source-${row}"`
  const at = markup.indexOf(marker)
  if (at < 0) {
    return ''
  }
  const start = markup.lastIndexOf('<button', at)
  const end = markup.indexOf('>', at)
  return start >= 0 && end > start ? markup.slice(start, end + 1) : ''
}

/** 视图的统一入口：真组件 + 真 zh 文案 + 桩面板（字段区由界面注入，这里不需要真表单） */
const EMPTY_DRAFT = accordion.EMPTY_SOURCE_DRAFT
const baseState = () =>
  accordion.initialSourcePageState({ third: { ...EMPTY_DRAFT }, official: { ...EMPTY_DRAFT } })

const viewMarkup = (over = {}) =>
  staticMarkup(
    createElement(view.SourceAccordionView, {
      t: translate,
      state: baseState(),
      effectiveKind: 'ours',
      configured: { builtin: true, third: false, official: false },
      panels: {
        third: createElement('div', { 'data-testid': 'stub-panel-third' }, '第三方字段'),
        official: createElement('div', { 'data-testid': 'stub-panel-official' }, '官方字段'),
      },
      onToggle() {},
      onRetry() {},
      onConfirm() {},
      styles: classNames,
      ...over,
    })
  )

/** 每个用例从干净的本地配置 + 未登录状态开始（同一进程里多行表格之间不许串味） */
const reset = () => {
  dom.localStorage.clear()
  useAuthStore.setState({ state: 'unauthenticated', user: null, token: null })
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('')
  runtime.resetPendingBuiltinClaim()
  consumeClient.setConsumeClient(null)
}

const signIn = () =>
  useAuthStore.setState({
    state: 'authenticated',
    restored: true,
    token: { accessToken: 'jwt-test', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    user: { id: 1, email: 'a@b.co', username: 'a' },
  })

/** 领 Key 的假服务端：`mode` 决定这次 create 是成功还是失败 */
const fakeConsumeKeys = (mode = 'ok') => {
  const calls = { create: 0, update: 0, list: 0 }
  const client = {
    keys: {
      list: async () => {
        calls.list++
        return { ok: true, status: 200, raw: '', data: { items: [], total: 0 } }
      },
      create: async () => {
        calls.create++
        if (mode === 'fail') {
          return {
            ok: false,
            status: 503,
            raw: '',
            error: {
              kind: 'server',
              code: 'HTTP_503',
              message: 'unavailable',
              status: 503,
              retryable: true,
              envelope: 'none',
              i18nKey: 'consumeErrServerUnavailable',
            },
          }
        }
        return {
          ok: true,
          status: 200,
          raw: '',
          data: { id: 42, name: 'app-x', key: 'sk-live-0123456789e849' },
        }
      },
      update: async () => {
        calls.update++
        return { ok: true, status: 200, raw: '', data: { id: 1, name: 'old', key: 'sk-old' } }
      },
    },
  }
  consumeClient.setConsumeClient(client)
  return calls
}

// ============================================================ [①] 手风琴：同一时间只展开一行

test('[①] 状态机：展开第三方再点官方 → 第三方自动收起（同一时间只一行）', () => {
  let state = baseState()
  state = accordion.sourcePageReducer(state, { type: 'toggle', row: 'third' })
  assert.equal(state.open, 'third', '第一次点击：展开第三方')
  state = accordion.sourcePageReducer(state, { type: 'toggle', row: 'official' })
  assert.equal(state.open, 'official', '再点官方：展开官方，第三方**自动收起**')
  // 再点同一行 = 收起（不是「一直开着」）
  state = accordion.sourcePageReducer(state, { type: 'toggle', row: 'official' })
  assert.equal(state.open, null, '点已展开的那一行 = 收起')
  // 纯函数本身也钉一次（界面用的就是它）
  assert.equal(accordion.toggleAccordion('third', 'official'), 'official')
  assert.equal(accordion.toggleAccordion('third', 'third'), null)
})

test('[①] markup：`aria-expanded` 一个 true、两个 false，且 `aria-controls` 指向真的存在的面板', () => {
  const state = accordion.sourcePageReducer(baseState(), { type: 'toggle', row: 'official' })
  const markup = viewMarkup({ state })
  const expandedRows = ['builtin', 'third', 'official'].filter((row) =>
    headerTagOf(markup, row).includes('aria-expanded="true"')
  )
  assert.deepEqual(expandedRows, ['official'], `同一时间只该有一行展开，实际：${expandedRows}`)
  for (const row of accordion.SOURCE_ROWS) {
    const tag = headerTagOf(markup, row)
    const panelId = /aria-controls="([^"]+)"/u.exec(tag)?.[1] ?? ''
    assert.equal(panelId, `settings-source-${row}-panel`, `${row} 的 aria-controls 要指到自己的面板`)
    assert.equal(
      markup.includes(`id="${panelId}"`),
      true,
      `${row} 的 aria-controls=${panelId} 在 DOM 里找不到对应节点（读屏会指空）`
    )
  }
  // 收起的面板是 `hidden`：结构上收起，不是靠 CSS 叠一层
  assert.match(markup, /id="settings-source-third-panel"[^>]*hidden/u, '未展开的面板必须 hidden')
})

// ============================================================ [②] 行头状态

test('[②] 行头状态：生效来源那一行是「✓ 当前使用」，其余「未配置」', () => {
  const markup = viewMarkup() // effectiveKind = ours，内置服务已配置
  assert.equal(textOf(markup, 'settings-source-builtin-status'), '✓ 当前使用')
  assert.equal(textOf(markup, 'settings-source-third-status'), '未配置')
  assert.equal(textOf(markup, 'settings-source-official-status'), '未配置')
  // 打勾不只靠图形：`aria-label` + `title` 都要有（#807 第 4 条）
  const check = /<span[^>]*data-testid="settings-source-current"[^>]*>/u.exec(markup)?.[0] ?? ''
  assert.match(check, /aria-label="当前使用中"/u, '✓ 必须带 aria-label=当前使用中')
  assert.match(check, /title="当前使用中"/u, '✓ 必须带 tooltip（title）')
  assert.equal(zh.settingsSourceCurrentAria, '当前使用中', '词条也要对得上')
  // 打勾**只**绑生效来源：同一时间最多一个
  assert.equal((markup.match(/data-testid="settings-source-current"/gu) ?? []).length, 1)
})

test('[②] 打勾跟着生效来源走：生效是第三方时，唯有第三方打勾', () => {
  const markup = viewMarkup({
    effectiveKind: 'openai',
    configured: { builtin: true, third: true, official: true },
  })
  assert.equal(textOf(markup, 'settings-source-third-status'), '✓ 当前使用')
  assert.equal(textOf(markup, 'settings-source-builtin-status'), '未配置')
  assert.equal(textOf(markup, 'settings-source-official-status'), '未配置')
  // 没有 Key 的那一行即使「是生效来源」也不许打勾（否则是句假话）
  const noKey = viewMarkup({ effectiveKind: 'ours', configured: { builtin: false, third: false, official: false } })
  assert.equal(textOf(noKey, 'settings-source-builtin-status'), '未配置', '没 Key 的内置服务不该显示 ✓')
  assert.equal(hasTestId(noKey, 'settings-source-current'), false)
})

// ================================================ [③] 未登录：弹登录，不调发放接口；登录后自动续领

test('[③] 未登录点内置服务：判定为「去登录」且一个请求都不发', async () => {
  reset()
  const planOnClick = accordion.planBuiltinClick({ signedIn: false, hasKey: false })
  assert.equal(planOnClick.action, 'need-login', '未登录必须先登录')
  assert.equal(planOnClick.resume, true, '并且要记住「登录后自动继续领取」')

  const calls = fakeConsumeKeys('ok')
  const result = await runtime.claimBuiltinKey({ signedIn: false })
  assert.equal(result.kind, 'need-login')
  assert.equal(calls.create, 0, '未登录时**一次发放接口都不许调**（没 JWT，调了只会 401）')
  assert.equal(runtime.hasPendingBuiltinClaim(), true, '要记下这一次待办，登录回来接着领')
  assert.equal(apiConfig.getProviderKind(), 'ours', '未登录时生效来源不动（这里本来就没换过）')
})

test('[③] 登录完成后自动继续领取：待办消费一次、领取真的被触发', async () => {
  reset()
  assert.equal(
    accordion.shouldResumeAfterLogin({ pending: true, signedIn: false }),
    false,
    '还没登录时不该续领'
  )
  const calls = fakeConsumeKeys('ok')
  // 未登录那一下：只记待办
  await runtime.claimBuiltinKey({ signedIn: false })
  assert.equal(calls.create, 0)
  // 登录回来（页面 effect 的判据）：待办还在 + 已登录 → 立刻接着领
  signIn()
  const pending = runtime.takePendingBuiltinClaim()
  assert.equal(accordion.shouldResumeAfterLogin({ pending, signedIn: true }), true)
  const resumed = await runtime.claimBuiltinKey({ signedIn: true })
  assert.equal(resumed.kind, 'claimed', '登录后的自动续领要真的领到 Key')
  assert.equal(calls.create, 1, '续领必须真的打了发放接口（不是只改一句文案）')
  assert.equal(runtime.hasPendingBuiltinClaim(), false, '待办只消费一次')

  // 页面真的接了这条续领（否则「自动继续」只是本模块自己说说）
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.match(page, /takePendingBuiltinClaim\(\)/u, '页面要在登录态翻过来时取走待办')
  assert.match(page, /hasPendingBuiltinClaim\(\)/u, '重开设置时待办还在也要接着领')
  assert.match(page, /void runBuiltinClaim\(true\)/u, '取到待办后要真的触发领取')
})

// ============================================================ [④] 领取中 / 成功

test('[④] 领取中：整行禁用 + 行头「领取中…」', () => {
  const state = accordion.sourcePageReducer(baseState(), { type: 'claim-started' })
  const markup = viewMarkup({ state })
  assert.equal(textOf(markup, 'settings-source-builtin-status'), '领取中…')
  assert.match(headerTagOf(markup, 'builtin'), /disabled/u, '领取期间该行必须禁用（防重复领取）')
  assert.equal(hasTestId(markup, 'settings-source-builtin-claiming'), true, '展开区里也要说清在领')
  // 其它两行不受影响
  assert.equal(/disabled/u.test(headerTagOf(markup, 'third')), false, '第三方行不该被一起禁用')
})

test('[④] 领取成功：Key 落盘 + 生效来源切到内置服务 + 打勾（拿到 key 之后才允许选中）', async () => {
  reset()
  signIn()
  const calls = fakeConsumeKeys('ok')
  const result = await runtime.claimBuiltinKey({ signedIn: true })
  assert.equal(result.kind, 'claimed')
  assert.equal(calls.create, 1)
  assert.equal(apiConfig.getApiKey(), 'sk-live-0123456789e849', 'Key 只在后台落盘（界面不展示）')
  assert.equal(apiConfig.getProviderKind(), 'ours', '领取成功后才切生效来源')
  assert.equal(runtime.effectiveRow(), 'builtin', '打勾落在内置服务')
  assert.equal(runtime.rowConfigured('builtin'), true, '下发给标记到手后这一行才算「配置好了」')
  // 界面上：这一行是 ✓ 当前使用，且展开区里没有任何 Key 控件（⑧ 的另一半）
  const state = accordion.sourcePageReducer(baseState(), { type: 'claim-ok' })
  const markup = viewMarkup({ state, effectiveKind: apiConfig.getProviderKind() })
  assert.equal(textOf(markup, 'settings-source-builtin-status'), '✓ 当前使用')
  assert.equal(markup.includes('<input'), false, '内置服务展开区里连输入框都没有')
})

// ============================================================ [⑤] 领取失败：不选中 + 原因 + 重试

test('[⑤] 领取失败：生效来源不动，行内给原因 + 「重试」', async () => {
  reset()
  signIn()
  apiConfig.setProviderKind('deepseek')
  const calls = fakeConsumeKeys('fail')
  const result = await runtime.claimBuiltinKey({ signedIn: true })
  assert.equal(result.kind, 'failed')
  assert.equal(calls.create, 1, '失败也是真的打了请求（不是本地拦下）')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '失败**不选中**：生效来源一个字都不动')
  assert.equal(runtime.effectiveRow(), 'official')

  // 界面：把失败状态喂给视图
  const state = accordion.sourcePageReducer(
    accordion.sourcePageReducer(baseState(), { type: 'claim-started' }),
    { type: 'claim-failed', messageKey: result.error.i18nKey, retryable: result.error.retryable }
  )
  const markup = viewMarkup({ state, effectiveKind: 'deepseek', configured: { builtin: true, third: false, official: true } })
  assert.equal(textOf(markup, 'settings-source-builtin-status'), '未配置', '失败后回到「未配置」，不是 ✓')
  assert.match(textOf(markup, 'settings-source-builtin-error'), /领取失败/u, '行内要说清原因')
  assert.match(textOf(markup, 'settings-source-builtin-error'), /服务器繁忙|暂时不可用|重试|失败/u)
  assert.equal(hasTestId(markup, 'settings-source-builtin-retry'), true, '必须给「重试」')
  assert.equal(textOf(markup, 'settings-source-builtin-retry'), '重试')
  // 失败原因来自 #771/#484 的既有分类，不是这里编的
  assert.equal(result.error.i18nKey, 'consumeErrServerUnavailable', '错误分类复用既有 toPanelError')
})

// ============================================================ [⑥] 「确认使用」才切换

test('[⑥] 只展开不点确认 → 生效来源不切换（展开 ≠ 生效）', () => {
  reset()
  apiConfig.setProviderKind('deepseek')
  const state = accordion.sourcePageReducer(baseState(), { type: 'toggle', row: 'third' })
  assert.equal(state.open, 'third')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '展开只是查看，切换一次都不许发生')
  // 改草稿同样不切换
  const edited = accordion.sourcePageReducer(state, {
    type: 'edit',
    row: 'third',
    field: 'baseUrl',
    value: 'https://proxy.example.com/v1',
  })
  assert.equal(edited.drafts.third.baseUrl, 'https://proxy.example.com/v1')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '改草稿也不切换')
})

test('[⑥] 校验不过 → 不切换、行内红字；校验通过 → 才切换 + 打勾', () => {
  reset()
  apiConfig.setProviderKind('deepseek')
  // (a) 空 Key
  const empty = runtime.confirmSourceRow('third', { baseUrl: 'https://proxy.example.com/v1', apiKey: '', model: 'gpt-4o' })
  assert.equal(empty.kind, 'invalid')
  assert.equal(empty.field, 'apiKey')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', 'Key 空着不许生效')
  // (b) 地址不合法（缺协议）
  const badUrl = runtime.confirmSourceRow('third', { baseUrl: 'proxy.example.com', apiKey: 'sk-x', model: 'gpt-4o' })
  assert.equal(badUrl.kind, 'invalid')
  assert.equal(badUrl.field, 'baseUrl')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '地址不合法不许生效')
  // (c) 校验通过
  const ok = runtime.confirmSourceRow('third', {
    baseUrl: 'https://proxy.example.com/v1',
    apiKey: 'sk-third-0000',
    model: 'gpt-4o',
  })
  assert.equal(ok.kind, 'applied')
  assert.equal(apiConfig.getProviderKind(), ok.providerKind, '确认后才切生效来源')
  assert.equal(runtime.effectiveRow(), 'third')
  assert.equal(apiConfig.getBaseUrl(), 'https://proxy.example.com/v1', '地址真的落盘了')
  assert.equal(apiConfig.getModel(), 'gpt-4o')
  assert.equal(apiConfig.getApiKey(), 'sk-third-0000')

  // 红字落在行内（视图这边也钉一次）
  const failedState = accordion.sourcePageReducer(baseState(), {
    type: 'submit-failed',
    row: 'third',
    field: 'apiKey',
    messageKey: 'settingsTestApiKeyRequired',
  })
  const markup = viewMarkup({ state: failedState })
  assert.match(textOf(markup, 'settings-source-third-error'), /请先填写 API Key/u)
  assert.equal(hasTestId(markup, 'settings-source-third-confirm'), true, '展开区底部要有「确认使用」')
  assert.equal(textOf(markup, 'settings-source-third-confirm'), '确认使用')
  // 内置服务**没有**「确认使用」（行即动作、无表单）
  assert.equal(hasTestId(markup, 'settings-source-builtin-confirm'), false)
})

test('[⑥] 官方服务：地址固定只填 Key，空 Key 不生效、填了才生效', () => {
  reset()
  apiConfig.setProviderKind('ours')
  assert.deepEqual(plan.sourceFieldRows('deepseek'), ['apiKey'], '官方服务只渲染 Key 一行（#800 的口径不变）')
  const rejected = runtime.confirmSourceRow('official', { baseUrl: '', apiKey: '  ', model: '' })
  assert.equal(rejected.kind, 'invalid')
  assert.equal(apiConfig.getProviderKind(), 'ours')
  const applied = runtime.confirmSourceRow('official', { baseUrl: '', apiKey: 'sk-official-1', model: '' })
  assert.equal(applied.kind, 'applied')
  assert.equal(apiConfig.getProviderKind(), 'deepseek')
  assert.equal(apiConfig.getBaseUrl(), 'https://api.deepseek.com', '官方地址固定（来自 spec.defaults）')
})

// ============================================================ [⑦] 草稿与重启

test('[⑦] 收起后草稿仍在（草稿不跟着面板一起丢）', () => {
  let state = accordion.sourcePageReducer(baseState(), { type: 'toggle', row: 'third' })
  state = accordion.sourcePageReducer(state, { type: 'edit', row: 'third', field: 'baseUrl', value: 'https://proxy.example.com/v1' })
  state = accordion.sourcePageReducer(state, { type: 'edit', row: 'third', field: 'model', value: 'gpt-4o' })
  state = accordion.sourcePageReducer(state, { type: 'toggle', row: 'third' }) // 收起
  assert.equal(state.open, null, '点一次收起')
  assert.equal(state.drafts.third.baseUrl, 'https://proxy.example.com/v1', '收起后草稿仍在')
  assert.equal(state.drafts.third.model, 'gpt-4o')
  // 再展开还是那一份
  state = accordion.sourcePageReducer(state, { type: 'toggle', row: 'third' })
  assert.equal(state.drafts.third.baseUrl, 'https://proxy.example.com/v1', '重新展开不许清空')
})

test('[⑦] 重启（重新读 storage）后：打勾仍在生效来源，草稿也还在', () => {
  reset()
  apiConfig.setProviderKind('deepseek')
  const applied = runtime.confirmSourceRow('third', {
    baseUrl: 'https://proxy.example.com/v1',
    apiKey: 'sk-third-0000',
    model: 'gpt-4o',
  })
  assert.equal(applied.kind, 'applied')

  // 「重启」= 只从存储重新读一遍（`apiConfig.getProviderKind()` / `readSourceDraft()` 每次都读 localStorage）
  assert.equal(apiConfig.getProviderKind(), 'openai', '生效来源持久化在既有键 chat-demo:provider-kind 上')
  assert.equal(runtime.effectiveRow(), 'third')
  const drafts = runtime.readSourceDrafts()
  assert.equal(drafts.third.baseUrl, 'https://proxy.example.com/v1', '重启后草稿（已存的地址）还在')
  assert.equal(drafts.third.model, 'gpt-4o')
  assert.equal(drafts.third.apiKey, 'sk-third-0000')

  // 首帧状态机 = 用这份草稿建出来，打勾落在生效来源
  const state = accordion.initialSourcePageState(drafts)
  const markup = viewMarkup({
    state,
    effectiveKind: apiConfig.getProviderKind(),
    configured: { builtin: false, third: true, official: true },
  })
  assert.equal(textOf(markup, 'settings-source-third-status'), '✓ 当前使用')
  assert.equal((markup.match(/data-testid="settings-source-current"/gu) ?? []).length, 1, '重启后也只打一个勾')
})

// ============================================================ [⑧] 内置服务没有 Key 控件

test('[⑧] 内置服务：没有 Key 展示 / 复制 /「重新领取」；行清单本来就是空的', () => {
  assert.deepEqual(plan.sourceFieldRows('ours'), [], '内置服务没有字段行（#800 的减法不许退回）')
  assert.equal(plan.rendersKeyControls('ours'), false)
  const state = accordion.sourcePageReducer(baseState(), { type: 'toggle', row: 'builtin' })
  const markup = viewMarkup({ state })
  const panel = markup.slice(
    markup.indexOf('data-testid="settings-source-builtin-panel"'),
    markup.indexOf('data-testid="settings-source-third"')
  )
  assert.equal(panel.includes('<input'), false, '内置服务展开区里没有输入框')
  assert.equal(/type="password"/u.test(panel), false, '没有 Key 输入框')
  assert.equal(/settings-managed-key/u.test(panel), false, '没有 Key 掩码展示区（那一段 DOM 不存在）')
  assert.equal(/重新领取/u.test(panel), false, '没有「重新领取」按钮')
  assert.equal(/复制|copy/iu.test(panel), false, '没有复制入口')
  assert.equal(/sk-[a-z0-9]/iu.test(markup), false, '整页都不许出现 Key 原文')
  // 视图里连「读 Key 再显示」的代码都没有
  const viewSource = codeOf('src/components/settings/sourceAccordionView.ts')
  assert.equal(/getApiKey|managedKeyTail|clipboard/u.test(viewSource), false, '视图不许碰 Key 原文 / 剪贴板')
})

// ============================================================ 接线（`page` 的 `.tsx` 一侧）

test('[接线] 页面用同一份状态机与视图，且**只有运行时**能切生效来源', () => {
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.match(page, /sourcePageReducer/u, '页面必须用同一份状态机（不另写一遍展开逻辑）')
  assert.match(page, /<SourceAccordionView/u, '视图就是被测的那一个组件')
  assert.equal(/setProviderKind/u.test(page), false, '页面自己不许切生效来源（只走运行时）')
  assert.equal(/claimManagedKeyForDevice|ManagedKeyField/u.test(page), false, '页面不许挂领取按钮 / 只读 Key 行')
  // 字段区是「草稿」形态（`mode="draft"`）：确认之前不落盘
  assert.match(page, /mode="draft"/u, '展开区里的字段必须走草稿形态')
  assert.match(page, /onConfirm=\{onConfirmSourceRow\}/u, '「确认使用」接在页面上')
  // 内置服务那一行是「行即动作」：展开的同时按 plan 做一件事
  assert.match(page, /planBuiltinClick\(/u)
  // 运行时才是唯一的切换点（两处：领取成功 / 确认使用）
  const rt = codeOf('src/components/settings/sourceAccordionRuntime.ts')
  assert.equal((rt.match(/setProviderKind\(/gu) ?? []).length, 3, '运行时里只有 selectBuiltin / 领取成功 / 确认使用 三处写它')
  assert.match(rt, /if \(!options\.signedIn\)/u, '未登录必须在最前面拦下（不调接口）')
})

test('[接线] 不再有子页 / 子页「返回」/ 底部 sheet：模型来源是一层', () => {
  const page = codeOf('src/components/consume/AccountConsumePage.tsx')
  assert.equal(/account-consume-source-back/u.test(page), false, '子页的「返回」必须删掉')
  assert.equal(/setSourceRow/u.test(page), false, '页面里不该再有「点到哪一行子页」的状态')
  assert.equal(/<SourceSheet/u.test(page), false, '兜底的底部 sheet 已经退场（手风琴就是唯一形态）')
  assert.equal(/account-consume-source-list/u.test(page), false, '三行列表的老 testid 退场')
  const settings = codeOf('src/components/settings/SettingsDialog.tsx')
  assert.equal(/sourceConfig/u.test(settings), false, '设置层不再注入字段区（草稿状态住在模型来源页里）')
})

test('[接线] 动画尊重 prefers-reduced-motion', () => {
  const css = sourceOf('src/components/consume/AccountConsume.module.css')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u, '必须有 reduced-motion 分支')
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(block, /\.sourcePanel\s*\{[^}]*animation: none/u, 'reduced-motion 下展开动画要真的关掉')
  assert.match(block, /\.sourceChevron\s*\{[^}]*transition: none/u, '箭头旋转也要关掉')
})
