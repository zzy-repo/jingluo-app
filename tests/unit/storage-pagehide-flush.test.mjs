// [layer: unit | 依赖: 无（纯 Node；存储后端与 document/window 事件源打桩，被测的是真 chat/store.ts） | 耗时: <2s]
//
// #917：调用方改走 `getStorage()` 后，`pagehide` / `visibilitychange(hidden)` 的 flush 写入必须与迁移前
// 一样「事件触发的同一 tick 就把写请求发给后端」（`peekStorage()` 已打开时），而不是晚一个微任务；
// 后端还没打开时，事件后的写入要在打开完成后落盘、不丢。
//
// 路径是真的：`bindChatPersistence()` 注册的监听 → `save()` → `persist()` → `withStorage()` → 后端。
// 替身只有两处：`storage/index.js`（可控的 peekStorage / getStorage：已打开 / 打开中 / 打开失败）
// 与 document / window 的事件源（setupDom 的 addEventListener 是空函数，这里换成能 dispatch 的）。
//
// 机制类别（UNIT_SOLO 判断）：本文件换掉 globalThis.document / window、挂 globalThis.__peek，且 store.ts 是
// 模块级单例（unsavedSessions 等）。与同类 chat 用例一样靠 installTsResolve 的按父模块路由，
// 不碰全局 indexedDB；若合批 DEGRADED 超限再登记。
//
//   node tests/run-layer.mjs unit --case tests/unit/storage-pagehide-flush.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chatCollectorStub,
  chatFakeDb,
  chatStub,
  inlineModule,
  installEndpointsGlobals,
  installTsResolve,
  setupDom,
} from '../helpers/dom-env.mjs'
import { isStorageIndexSpecifier } from '../helpers/storage-stub.mjs'

// 可控的 storage/index.js：mode = 'open'（已打开，peek 有值）| 'pending'（打开中，等 gate）| 'reject'（打开失败）
const storageStub = inlineModule(`
const st = () => globalThis.__peek
export const peekStorage = () => (st().opened ? st().backend : undefined)
export const getStorage = () => {
  const s = st()
  if (s.mode === 'reject') return Promise.reject(new Error('open failed'))
  if (s.mode === 'pending') return s.gate.then(() => { s.opened = true; return s.backend })
  s.opened = true
  return Promise.resolve(s.backend)
}
`)

installEndpointsGlobals()
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatCollectorStub()],
  ],
  onResolve: (specifier, context) => {
    const parent = String(context.parentURL ?? '')
    if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
      return chatFakeDb()
    }
    if (isStorageIndexSpecifier(specifier) && parent.endsWith('/chat/store.ts')) {
      return storageStub
    }
    return undefined
  },
})
setupDom()

/** 能 dispatch 的事件源：store.ts 只用 addEventListener / removeEventListener / visibilityState */
const makeTarget = (extra = {}) => {
  const listeners = new Map()
  return {
    ...extra,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) =>
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    dispatch: (type) => {
      for (const fn of listeners.get(type) ?? []) {
        fn({ type })
      }
    },
  }
}
const doc = makeTarget({ visibilityState: 'visible' })
const win = makeTarget()
globalThis.document = doc
globalThis.window = win

const chat = await import('../../src/services/chat/store.ts')
const drafts = await import('../../src/services/chat/drafts.ts')

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** 后端替身：每次调用立刻（同步）记账，行为由 saveImpl 决定 */
const freshBackend = ({ mode, saveImpl }) => {
  const calls = { save: [], pin: [], rename: [], get: [] }
  const peek = {
    mode,
    opened: mode === 'open',
    calls,
    saveImpl,
    gate: undefined,
    openGate: undefined,
    backend: {
      sessions: {
        save: (session) => {
          calls.save.push(session.title)
          return peek.saveImpl(session)
        },
        pin: async (id, pinnedAt) => {
          calls.pin.push([id, pinnedAt])
        },
        rename: async (id, title) => {
          calls.rename.push([id, title])
        },
        get: async () => undefined,
      },
    },
  }
  peek.gate = new Promise((resolve) => {
    peek.openGate = resolve
  })
  globalThis.__peek = peek
  return peek
}

const OK = async () => ({ failure: null, degradedFiles: [], strippedFields: [] })
const FAIL = async () => {
  throw new Error('disk busy')
}

const sessionOf = (id, title) => ({
  id,
  title,
  createdAt: 1_000,
  updatedAt: 1_000,
  messages: [],
  rootMessageId: null,
})

const reset = (id, title = '旧标题') => {
  drafts.clearAllDrafts()
  chat.useChatStore.setState({
    ready: true,
    initError: false,
    importingHistory: false,
    sessions: [{ id, title, createdAt: 1_000, updatedAt: 1_000 }],
    sessionCache: { [id]: sessionOf(id, title) },
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
    importSkipped: [],
    waitHints: {},
  })
  doc.visibilityState = 'visible'
}

test('后端已打开：pagehide / visibilitychange(hidden) 触发的 flush 在同一 tick 就调到后端', async (t) => {
  reset('s-open')
  const peek = freshBackend({ mode: 'open', saveImpl: FAIL })
  const unbind = chat.bindChatPersistence()
  t.after(async () => {
    unbind()
    peek.saveImpl = OK
    win.dispatch('pagehide')
    await settle()
  })

  // 前置：用户改名 → persist，写请求在调用的同一 tick 已发出；这一次写失败，会话留在「待保存」集合里
  chat.renameSession('s-open', '改名后')
  assert.deepEqual(peek.calls.save, ['改名后'], '后端已打开：renameSession 同一 tick 就调到 save（没有额外微任务）')
  await settle()
  assert.ok(chat.useChatStore.getState().sessionSaveErrors['s-open'], '前置：第一次写失败，保存失败标记存在')

  win.dispatch('pagehide')
  assert.equal(peek.calls.save.length, 2, 'pagehide：flush 的 save 在事件返回前（同一 tick）就已调到后端')
  assert.equal(peek.calls.save[1], '改名后', 'flush 写的是最后一次内存里的标题')
  await settle()

  doc.visibilityState = 'visible'
  doc.dispatch('visibilitychange')
  assert.equal(peek.calls.save.length, 2, 'visibilitychange 到 visible：不 flush')

  doc.visibilityState = 'hidden'
  doc.dispatch('visibilitychange')
  assert.equal(peek.calls.save.length, 3, 'visibilitychange(hidden)：flush 的 save 在同一 tick 调到后端')
  assert.equal(peek.calls.save[2], '改名后')
})

test('后端已打开：pin / 未缓存会话的 rename 在调用的同一 tick 调到后端，且先后顺序保持', async () => {
  reset('s-pin')
  chat.useChatStore.setState({ sessionCache: {} }) // 详情不在内存：rename 走直接改库的分支
  const peek = freshBackend({ mode: 'open', saveImpl: OK })

  chat.pinSession('s-pin')
  chat.renameSession('s-pin', '改库里的名字')
  assert.equal(peek.calls.pin.length, 1, 'pinSession 同一 tick 调到后端')
  assert.equal(peek.calls.rename.length, 1, 'renameSession（未缓存）同一 tick 调到后端')
  assert.deepEqual(peek.calls.rename[0], ['s-pin', '改库里的名字'])
  await settle()
})

test('后端未打开：打开失败后的会话，事件后的 flush 写入在打开完成后落盘、不丢', async (t) => {
  reset('s-late')
  const peek = freshBackend({ mode: 'reject', saveImpl: OK })
  const unbind = chat.bindChatPersistence()
  t.after(() => unbind())

  // 前置：打开失败 → 这次写丢在半路，会话留在「待保存」里（没有任何后端调用）
  chat.renameSession('s-late', '最后一次改名')
  await settle()
  assert.equal(peek.calls.save.length, 0, '前置：后端没打开，没有任何 save 到达后端')
  assert.ok(chat.useChatStore.getState().sessionSaveErrors['s-late'], '前置：写入失败被标记，用户看得到')

  // 后端进入「打开中」；此时发 pagehide / hidden：flush 发起写入，但后端还没打开
  peek.mode = 'pending'
  win.dispatch('pagehide')
  doc.visibilityState = 'hidden'
  doc.dispatch('visibilitychange')
  await settle()
  assert.equal(peek.calls.save.length, 0, '后端尚未打开：事件后的写入还没到达后端（在等打开）')

  // 打开完成：等着的写入落盘，内容是最后一次改名
  peek.openGate()
  await settle()
  assert.ok(peek.calls.save.length >= 1, '打开完成后，事件触发的写入必须落盘（不丢）')
  assert.equal(peek.calls.save.at(-1), '最后一次改名')
  assert.equal(
    chat.useChatStore.getState().sessionSaveErrors['s-late'],
    undefined,
    '落盘成功后保存失败标记被清掉'
  )
})
