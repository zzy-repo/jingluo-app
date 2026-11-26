// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 Storage Module | 耗时: <3s]
//
// Issue #909：protection 与存储之间唯一的接触面 `storageAccess.ts` —— 经真实的 `getStorage()`
// （IndexedDB 后端，宿主是 fake-indexeddb）读写，而不是内存替身。
//
//   [A1] PROTECTION_SCHEMA_VERSION 与 `chat/db.ts` 的 DB_VERSION 一致（schema 升级时这条变红，提醒同步）
//   [A2] countSessions / loadSessions 分页读：超过一页（100 条）也一条不漏
//   [A3] protection/** 里除 storageAccess.ts 外没有任何文件 import chat/db.ts 或 storage 内部实现
//
// 为什么独占进程（登记在 UNIT_SOLO）：本文件要真 IndexedDB（顶层装 fake-indexeddb 全局）并占用
// `chat/db.ts` 的模块级连接单例，同批别的文件会吃到它的全局、或让它吃到别人的替身。
//
//   node tests/run-layer.mjs unit --case protection-storage-909
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { installEndpointsGlobals, installTsResolve, loadTsModule, ROOT } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const { getStorage } = await loadTsModule('src/services/storage/index.ts')
const access = await loadTsModule('src/services/protection/storageAccess.ts')

const sessionOf = (n) => ({
  id: `s${String(n).padStart(4, '0')}`,
  title: `会话 ${n}`,
  createdAt: n,
  updatedAt: n,
  messages: [{ id: `m${n}`, role: 'user', content: `内容 ${n}`, files: [], createdAt: n }],
})

test('A1 PROTECTION_SCHEMA_VERSION 与 DB_VERSION 一致', () => {
  assert.equal(access.PROTECTION_SCHEMA_VERSION, db.DB_VERSION, 'schema 升级后同步改 storageAccess.ts')
})

test('A2 分页读：250 条（超过 2 页）一条不漏，数量与内容都对', async () => {
  const storage = await getStorage()
  for (let n = 0; n < 250; n += 1) {
    await storage.sessions.save(sessionOf(n))
  }
  const protection = access.createStorageAccess()
  assert.equal(await protection.countSessions(), 250)
  assert.equal(await protection.countSummaries(), 250)
  const loaded = await protection.loadSessions()
  assert.equal(loaded.length, 250)
  assert.deepEqual(
    loaded.map((session) => session.id),
    Array.from({ length: 250 }, (_, n) => sessionOf(n).id),
    '主键升序、无重复、无遗漏'
  )
  assert.equal(loaded[249].messages[0].content, '内容 249')
})

test('A3 protection/** 只有 storageAccess.ts 碰存储，且只经 storage/index', () => {
  const dir = path.join(ROOT, 'src/services/protection')
  const offenders = []
  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), 'utf8')
    const specs = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1])
    for (const spec of specs) {
      if (/chat\/db(\.js)?$/u.test(spec)) {
        offenders.push(`${name}: ${spec}`)
      }
      if (/storage\/(idb|sqlite|migration)\//u.test(spec)) {
        offenders.push(`${name}: ${spec}`)
      }
      if (/(^|\/)storage\//u.test(spec) && !/storage\/(index|types)\.js$/u.test(spec) && !/storage\/(idb|sqlite|migration)\//u.test(spec)) {
        offenders.push(`${name}: ${spec}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
