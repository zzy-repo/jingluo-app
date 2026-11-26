// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 chat/db.ts | 耗时: <5s]
//
// #917：`peekStorage()` —— 同步取已打开的后端，让 chat/store.ts 的 save/pin/rename 在后端已打开时
// 与迁移前直调 `db.xxx` 一样「同一个 tick 发出写请求」。不触发打开、不改变 `getStorage()` 语义。
//
//   node tests/run-layer.mjs unit --case tests/unit/storage-peek.test.mjs
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installEndpointsGlobals, installTsResolve, moduleUrl } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve()

// `?inst=` 拿一份全新的 index.ts 模块实例（模块级 current/resolved 从零开始，不受同进程别的文件影响）
const storage = await import(`${moduleUrl('src/services/storage/index.ts')}?inst=peek`)

test('[peek] 没打开过 → undefined，且 peek 本身不触发打开', async () => {
  assert.equal(storage.peekStorage(), undefined)
  assert.equal(storage.peekStorage(), undefined, '再 peek 一次仍是 undefined：它不会偷偷开库')
})

test('[peek] getStorage 打开成功后 peek 同步返回同一个实例（同一 tick 可用）', async () => {
  const opened = await storage.getStorage()
  assert.equal(storage.peekStorage(), opened)
  // 同步调用：不 await，写请求已经发出（返回的是 promise，而不是先等一个微任务再调用）
  let called = false
  const peeked = storage.peekStorage()
  const probe = { ...peeked, sessions: { ...peeked.sessions, get: (id) => { called = true; return peeked.sessions.get(id) } } }
  const pending = probe.sessions.get('nope')
  assert.equal(called, true, '同步调用，不经过额外微任务')
  assert.equal(await pending, undefined)
})

test('[peek] close() 后失效；重新 getStorage 后恢复', async () => {
  const opened = await storage.getStorage()
  await opened.close()
  assert.equal(storage.peekStorage(), undefined, '关闭后不能再同步拿到已关闭的后端')
  const reopened = await storage.getStorage()
  assert.notEqual(reopened, opened)
  assert.equal(storage.peekStorage(), reopened)
})

test('[peek] 打开失败（无 IndexedDB）→ 仍是 undefined，不缓存失败', async () => {
  await (await storage.getStorage()).close()
  const saved = globalThis.indexedDB
  delete globalThis.indexedDB
  try {
    await assert.rejects(() => storage.getStorage(), (error) => error.name === 'StorageUnavailableError')
    assert.equal(storage.peekStorage(), undefined)
  } finally {
    globalThis.indexedDB = saved
  }
  const recovered = await storage.getStorage()
  assert.equal(storage.peekStorage(), recovered)
})

test('[peek] setStorageForTests 注入替身 → peek 返回替身；传 null 后丢弃缓存', async () => {
  const before = await storage.getStorage()
  const fake = { tag: 'fake' }
  storage.setStorageForTests(fake)
  assert.equal(storage.peekStorage(), fake)
  storage.setStorageForTests(null)
  assert.equal(storage.peekStorage(), undefined, '恢复默认后缓存的单例被丢弃，peek 不再返回旧实例')
  assert.notEqual(storage.peekStorage(), before)
})
