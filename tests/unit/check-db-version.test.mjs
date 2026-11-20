// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `check:db-version`（scripts/check-db-version.mjs）的判据自测 + 「版本号只有一个来源」的前提断言（Issue #547）。
//
// 为什么这两件事放在 L0：
//   1. **判据本身**：门禁只认「`indexedDB.open(…)` / `openDB(…)` 的第二个实参是数字字面量」。
//      宽一寸（把注释里的反例也报、把 `DB_VERSION` 这种变量也报）就是天天假红，人就开始写豁免；
//      窄一寸（漏掉 `openDB<ChatDB>(…)` 泛型写法、漏掉第三个参数里的数字干扰）就等于没这道门禁。
//      两头都钉在这里。
//   2. **前提**：门禁的报错文案让人「改用 DB_VERSION」，那就必须真的有那个导出 ——
//      `src/services/chat/db.ts` 的 `export const DB_VERSION` / `export const DB_NAME`（#547 建立的唯一来源，
//      L1 夹具 `tests/helpers/chat-db.mjs` 从这里取值）。这条导出一旦没了，门禁的建议就是空指针。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { maskSource, scanText } from '../../scripts/check-db-version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DB_SOURCE = 'src/services/chat/db.ts'
const dbSource = readFileSync(path.join(ROOT, DB_SOURCE), 'utf8')
const versions = (text) => scanText(text).map((hit) => hit.version)

test('check:db-version 咬住写死的版本号：#547 的两种形状都必报', () => {
  // 事故原文（tests/integration/domain04-session-list-flow.test.mjs 修前）
  assert.deepEqual(versions("const request = indexedDB.open('chat-demo', 12)"), ['12'])
  // idb 包装 + 泛型 + 第三参：版本是**顶层第二个实参**，不是 upgrade 回调里的数字
  assert.deepEqual(
    versions(
      "openDB<ChatDB>('chat-demo', 13, { upgrade(db, oldVersion) { db.createObjectStore('a', { autoIncrement: 12 }) } })",
    ),
    ['13'],
  )
  // 行号必须指到调用的那一行（不是文件头）：报错要能直接点开看
  assert.equal(scanText("// 头注释\n\nconst db = openDB('chat-demo', 7, {})")[0].line, 3)
})

test('check:db-version 不误伤正确写法：默认版本 / DB_VERSION / 变量 / 注释 / 字符串', () => {
  assert.deepEqual(versions("indexedDB.open('chat-demo')"), [])
  assert.deepEqual(versions("indexedDB.open('chat-demo', DB_VERSION)"), [])
  // copy-limit / chat-db.mjs 的写法：版本来自导入的常量或参数，变量本身放行
  assert.deepEqual(versions("indexedDB.open('chat-demo', version)"), [])
  // 文档与注释里必须允许写反例（本文件头、scripts/check-db-version.mjs 文件头都在写）
  assert.deepEqual(versions("// 旧写法：indexedDB.open('chat-demo', 12)"), [])
  assert.deepEqual(versions("/* indexedDB.open('chat-demo', 12) */"), [])
  assert.deepEqual(versions('const doc = "indexedDB.open(\'chat-demo\', 12)"'), [])
})

test('maskSource 只抹注释与字符串内部，长度与行号不变', () => {
  const text = "// 说明\nconst a = 'x, y'\n/* 块 */\nopen('k', 3)"
  const masked = maskSource(text)
  assert.equal(masked.length, text.length)
  assert.equal(masked.split('\n').length, text.split('\n').length)
  assert.doesNotMatch(masked, /说明|块|x, y/)
  // 字符串**内部**被抹掉、引号保留（所以 'k' → ' '）；调用形状与那个数字必须原样留着
  assert.match(masked, /open\(' ', 3\)/)
})

test('门禁的建议不是空指针：db.ts 真的导出了 DB_VERSION / DB_NAME，且 L1 夹具从这里取值', () => {
  assert.match(
    dbSource,
    /export\s+const\s+DB_VERSION\s*=\s*\d+/,
    `${DB_SOURCE} 必须 \`export const DB_VERSION = <数字>\` —— 门禁的报错文案让人改用它（#547）`,
  )
  assert.match(
    dbSource,
    /export\s+const\s+DB_NAME\s*=\s*'[^']+'/,
    `${DB_SOURCE} 必须 \`export const DB_NAME = '<库名>'\``,
  )
  // 版本号在源码里只出现一次（这条断言与门禁互补：门禁扫 tests/** 与 src/**，这里钉「源头本身没有第二处数字」）
  assert.deepEqual(
    versions(dbSource),
    [],
    `${DB_SOURCE} 自己也不许把版本写成字面量实参（应当传 DB_VERSION）`,
  )
  const l1Helper = readFileSync(path.join(ROOT, 'tests/helpers/chat-db.mjs'), 'utf8')
  assert.match(
    l1Helper,
    /loadTsModule\('src\/services\/chat\/db\.ts'\)/,
    'L1 夹具必须从 db.ts 取版本/库名，而不是自己写一份（#547 的根因）',
  )
})
