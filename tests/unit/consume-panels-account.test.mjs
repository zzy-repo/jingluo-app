// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 keys 源 + renderToStaticMarkup） | Issue #487 阶段③]
//
// **账号面板主路径**（L1-2）：创建 Key → 亮一次明文 → 之后只剩尾 4 位；删除 → 二次确认。
//
// 三行表格：
//   ① 创建成功 → 完整 Key **只出现一次**（`account-key-once` 块），关掉后重渲染只剩 `••••尾4`；
//   ② 删除 → 必须先在行内确认（`account-key-delete` 只是「问」，`account-key-delete-yes` 才「做」），
//      没确认之前**一个 DELETE 都不发**；
//   ③ 空名字 → 本地校验拦下，不发请求（服务端也会拒，但白跑一趟网络没意义）。
//
// 硬要求（面板文件头第 3 条）：Key 原文只露一次；列表永远是 `••••` + 末 4 位；不打日志、不进 URL。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const {
  AccountPanelView,
  initialAccountState,
  reduceAccount,
  runCreateKey,
  runDeleteKey,
  runLoadAccount,
} = await import('../../src/components/consume/accountPanelModel.ts')

const FULL_KEY = 'sk-live-0123456789abcdef9f2c'

const apiKey = (over = {}) => ({
  id: 7,
  name: '我的第一把',
  key: FULL_KEY,
  status: 'active',
  quota: 0,
  quotaUsed: 0,
  ...over,
})

const ok = (data) => ({ ok: true, status: 200, raw: {}, data })

/** 假 keys 源：`create` / `remove` 都记调用，`list` 先给空列表 */
const sourceOf = ({ created = apiKey(), list = [] } = {}) => {
  const calls = { create: [], update: [], remove: [] }
  const source = {
    auth: {
      profile: async () => ok({ id: 2, email: 'ui@mock.local', balance: 2 }),
      revokeAllSessions: async () => ok(undefined),
    },
    keys: {
      list: async () => ok({ items: list, total: list.length, page: 1, pageSize: 20, pages: 1 }),
      create: async (input) => {
        calls.create.push(input)
        return ok(created)
      },
      update: async (id, input) => {
        calls.update.push({ id, input })
        return ok(apiKey({ id }))
      },
      remove: async (id) => {
        calls.remove.push(id)
        return ok(undefined)
      },
    },
  }
  return { source, calls }
}

/** 把视图完整渲染一次（所有回调都是空函数：本文件断言的是「点了会不会发请求」，由 run* 负责） */
const render = (state, extra = {}) =>
  markupOf(
    AccountPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      copied: false,
      onCopyKey() {},
      onDraft() {},
      onCreate() {},
      onToggleKey() {},
      onAskDelete() {},
      onCancelDelete() {},
      onConfirmDelete() {},
      onDismissCreated() {},
      onAskLogout() {},
      onCancelLogout() {},
      onLogout() {},
      onRetry() {},
      ...extra,
    })
  )

/** 首屏状态 + 已加载的空列表（创建 / 删除两条路径的起点） */
const readyState = async (source) => {
  let state = initialAccountState(null)
  for (const event of await runLoadAccount(source)) {
    state = reduceAccount(state, event)
  }
  return state
}

test('L1 账号面板：创建只亮一次明文 / 删除要二次确认 / 空名字本地拦（表驱动）', async (t) => {
  await t.test('创建成功：完整 Key 只出现一次，重新渲染只剩尾 4 位', async () => {
    const { source, calls } = sourceOf()
    let state = await readyState(source)

    // 创建前：列表里什么都没有，也没有「只显示这一次」的块
    assert.equal(hasTestId(render(state), 'account-key-once'), false)

    for (const event of await runCreateKey(source, '  我的第一把  ')) {
      state = reduceAccount(state, event)
    }
    assert.deepEqual(calls.create, [{ name: '我的第一把' }], '名字要 trim 后再发')

    const first = render(state)
    assert.equal(hasTestId(first, 'account-key-once'), true)
    assert.equal(textOf(first, 'account-key-once-value').includes(FULL_KEY), true, '创建成功那一次必须给完整 Key')
    assert.equal(textOf(first, 'account-key-once-value').includes('••••'), false)

    // 关掉「我保存好了」→ 完整值从状态里彻底消失（不是折叠）
    state = reduceAccount(state, { type: 'createdDismiss' })
    const second = render(state)
    assert.equal(hasTestId(second, 'account-key-once'), false, '关掉之后不许再有完整 Key 的块')
    assert.equal(second.includes(FULL_KEY), false, '完整 Key 不许留在任何一处渲染里')
    // 列表里只剩 `••••9f2c`，并且明确告诉用户「只能看尾号」
    assert.equal(textOf(second, 'account-key-masked').includes('••••9f2c'), true)
    assert.equal(hasTestId(second, 'account-key-tail-hint'), true)
    assert.equal(second.includes('9f2c') && second.includes(FULL_KEY), false)
  })

  await t.test('删除：先问再删，确认之前一个 DELETE 都不发', async () => {
    const { source, calls } = sourceOf({ list: [apiKey()] })
    let state = await readyState(source)

    // 未确认态：行内只有「删除」按钮，没有确认块
    const before = render(state)
    assert.equal(hasTestId(before, 'account-key-delete'), true)
    assert.equal(hasTestId(before, 'account-key-delete-confirm'), false)
    assert.equal(calls.remove.length, 0, '还没点确认，不该有任何删除请求')

    // 点「删除」= 只是把 confirmDeleteId 设上（纯状态迁移，不发请求）
    state = reduceAccount(state, { type: 'confirmDelete', id: 7 })
    const asked = render(state)
    assert.equal(hasTestId(asked, 'account-key-delete-confirm'), true)
    assert.equal(asked.includes(translate('consumeDeleteConfirm')), true, '二次确认要写清「删除后不可恢复」')
    assert.equal(hasTestId(asked, 'account-key-delete-yes') && hasTestId(asked, 'account-key-delete-no'), true)
    assert.equal(calls.remove.length, 0, '弹确认本身不删')

    // 点「确认」才算真删
    for (const event of await runDeleteKey(source, 7)) {
      state = reduceAccount(state, event)
    }
    assert.deepEqual(calls.remove, [7])
    assert.equal(state.confirmDeleteId, null, '删完要把确认态收掉')
    assert.equal(render(state).includes('我的第一把'), false, '删掉的 Key 不许还留在列表里')
    assert.equal(hasTestId(render(state), 'account-notice'), true)
  })

  await t.test('空名字：本地拦下并发一条文案，不白跑一趟网络', async () => {
    const { source, calls } = sourceOf()
    let state = await readyState(source)
    for (const event of await runCreateKey(source, '   ')) {
      state = reduceAccount(state, event)
    }
    assert.equal(calls.create.length, 0, '空名字不该发 POST /keys')
    assert.equal(state.actionError.i18nKey, 'consumeKeyNameRequired')
    assert.equal(state.createdKey, null)
    const markup = render(state)
    assert.equal(hasTestId(markup, 'account-action-error'), true)
    assert.equal(markup.includes(translate('consumeKeyNameRequired')), true)
    assert.equal(hasTestId(markup, 'panel-retry'), false, '本地校验错不可重试')
  })
})
