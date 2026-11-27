// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// #906/#910 存储边界（架构门禁，单元测试形态，不是新增 CI 门禁步骤）：
// `src/` 里除 `src/services/storage/**`、`src/services/chat/db.ts` 自身与显式豁免清单之外，
// 任何文件都不得
//   · import `chat/db.ts` 的**存取**导出（纯函数/错误类/常量/类型白名单见 PURE_DB_EXPORTS）；
//   · import `attachments/store.ts` 的存取导出（键口径白名单见 PURE_STORE_EXPORTS）；
//   · 出现 `indexedDB` / `openChatTransaction` / `runChatStoreRequest` / `getChatDB` / `from 'idb'`。
// 业务代码只能经 `getStorage()`（`src/services/storage`）取仓储。
//
// 豁免清单：tests/fixtures/storage/storage-boundary-exemptions.json
//   （放在 storage/ 子目录是因为 check:test-layout --strict 不允许 fixtures 根目录散放文件）。
//   只许缩不许涨：条目数上限 MAX_EXEMPTIONS；条目不再违规时本测试判红，要求删条目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers/dom-env.mjs'

/** 豁免条目数上限：只许往下改，不许往上改。 */
const MAX_EXEMPTIONS = 2

/** 不碰存储的 `db.ts` 导出（纯函数、错误类、常量）：业务代码可以继续直接取。类型导入一律放行。 */
const PURE_DB_EXPORTS = new Set([
  'STORAGE_FAILURE_KINDS',
  'isStorageFailureKind',
  'classifyStorageFailure',
  'storageFailureOf',
  'normalizeStorageFailure',
  'saveBannerTierOf',
  'selectSaveBannerTier',
  'selectSaveBannerDisplay',
  'bannerMessageKey',
  'bannerRetryable',
  'SAVE_BANNER_MESSAGE',
  'saveBannerRetryable',
  'stripNonCloneableFields',
  'StorageUnavailableError',
  'StorageBlockedError',
  'StorageVersionTooNewError',
  'BLOCKED_TIMEOUT_MS',
  'reportStorageError',
])

/** `attachments/store.ts` 里不碰存储的导出（原件键口径）。 */
const PURE_STORE_EXPORTS = new Set([
  'ATTACHMENT_BLOB_PREFIX',
  'attachmentBlobKey',
  'isAttachmentBlobKey',
  'attachmentTextKey',
])

const RAW_TOKENS = /\b(indexedDB|openChatTransaction|runChatStoreRequest|getChatDB)\b/u

const SRC = path.join(ROOT, 'src')
const DB_FILE = path.join(SRC, 'services/chat/db')
const STORE_FILE = path.join(SRC, 'services/attachments/store')
const STORAGE_DIR = path.join(SRC, 'services/storage') + path.sep
const DB_SELF = path.join(SRC, 'services/chat/db.ts')

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

/** 去掉注释：块注释、整行注释、行尾 `// ...`（前面必须是空白，避免误伤 `http://`）。 */
export const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/(\s)\/\/[^'"`\n]*$/gmu, '$1')

const resolveSpecifier = (file, spec) => {
  if (!spec.startsWith('.')) {
    return spec
  }
  return path.resolve(path.dirname(file), spec).replace(/\.(js|ts|tsx)$/u, '')
}

/**
 * 检出一个文件里的违规，返回人话数组。纯函数（不读盘），自检用例直接喂字符串。
 * `file` 只用来解析相对路径。
 */
export const violationsOf = (file, rawText) => {
  const text = stripComments(rawText)
  const found = []
  const token = text.match(RAW_TOKENS)
  if (token) {
    found.push(`直接使用 ${token[0]}`)
  }
  const importPattern =
    /(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
  for (const match of text.matchAll(importPattern)) {
    const typeOnly = match[1] !== undefined
    const clause = match[2] ?? ''
    const spec = match[3] ?? match[4]
    if (spec === 'idb') {
      found.push("import 'idb'")
      continue
    }
    const target = resolveSpecifier(file, spec)
    const policy =
      target === DB_FILE
        ? { name: 'chat/db.ts', pure: PURE_DB_EXPORTS }
        : target === STORE_FILE
          ? { name: 'attachments/store.ts', pure: PURE_STORE_EXPORTS }
          : undefined
    if (policy === undefined || typeOnly) {
      continue
    }
    if (match[4] !== undefined || /\*\s+as\s/u.test(clause) || !/\{/u.test(clause)) {
      // 动态 import / 命名空间导入 / 默认导入：看不出用了哪些导出，一律按违规处理
      found.push(`以整体方式引入 ${policy.name}（${match[0].replace(/\s+/gu, ' ').slice(0, 60)}）`)
      continue
    }
    const names = clause
      .replace(/[{}]/gu, ' ')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !part.startsWith('type '))
      .map((part) => part.split(/\s+as\s+/u)[0].trim())
    for (const name of names) {
      if (!policy.pure.has(name)) {
        found.push(`import ${policy.name} 的存取导出 ${name}`)
      }
    }
  }
  return found
}

const sourceFiles = () =>
  walk(SRC)
    .filter((file) => /\.(ts|tsx)$/u.test(file))
    .filter((file) => !file.startsWith(STORAGE_DIR) && file !== DB_SELF)

const exemptions = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/storage/storage-boundary-exemptions.json'), 'utf8')
).entries

const exemptFiles = new Set(exemptions.map((entry) => entry.file))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

test('边界：除 storage/**、db.ts 与豁免清单外，src 里没有绕过 Storage 接口的文件', () => {
  const offenders = []
  for (const file of sourceFiles()) {
    if (exemptFiles.has(rel(file))) {
      continue
    }
    const hits = violationsOf(file, readFileSync(file, 'utf8'))
    for (const hit of hits) {
      offenders.push(`${rel(file)}: ${hit}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件绕过了 getStorage()：改走 src/services/storage 的仓储接口；确属实现细节的，才进豁免清单并写明原因与去向'
  )
})

test('豁免清单：只许缩不许涨，每条带原因与去向，文件存在且仍在违规', () => {
  assert.ok(
    exemptions.length <= MAX_EXEMPTIONS,
    `豁免清单 ${exemptions.length} 条，超过上限 ${MAX_EXEMPTIONS}：清单只许缩不许涨`
  )
  const seen = new Set()
  for (const entry of exemptions) {
    assert.ok(!seen.has(entry.file), `豁免清单重复条目：${entry.file}`)
    seen.add(entry.file)
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim() !== '',
      `${entry.file}: 缺 reason（为什么现在不能迁）`
    )
    assert.ok(
      typeof entry.followUp === 'string' && /#\d+|不迁/u.test(entry.followUp),
      `${entry.file}: followUp 必须写明对应 issue 号或「不迁」的结论`
    )
    const abs = path.join(ROOT, entry.file)
    assert.ok(existsSync(abs), `${entry.file}: 豁免的文件已不存在，删这一条`)
    assert.ok(
      violationsOf(abs, readFileSync(abs, 'utf8')).length > 0,
      `${entry.file}: 已不再绕过存储接口，豁免过期，删这一条`
    )
    assert.ok(!abs.startsWith(STORAGE_DIR), `${entry.file}: storage/** 本来就不受检，不该出现在豁免里`)
  }
})

test('检测器自检（负向对照）：违规写法必须被抓到，合规写法不许误报', () => {
  const fake = path.join(SRC, 'components/Fake.tsx')
  const bad = [
    ["import { loadFile } from '../services/chat/db.js'", 'loadFile'],
    ["import { loadFile as lf } from '../services/chat/db.js'", 'loadFile'],
    ["import * as db from '../services/chat/db.js'", '整体'],
    ["import { reportStorageError, saveSession } from '../services/chat/db.js'", 'saveSession'],
    ["const m = await import('../services/chat/db.js')", '整体'],
    ["import { saveNewAttachment } from '../services/attachments/store.js'", 'saveNewAttachment'],
    ["import { openDB } from 'idb'", 'idb'],
    ['const tx = await openChatTransaction(["files"])', 'openChatTransaction'],
    ['const r = indexedDB.open("x")', 'indexedDB'],
  ]
  for (const [code, needle] of bad) {
    const hits = violationsOf(fake, code)
    assert.ok(
      hits.some((hit) => hit.includes(needle)),
      `应当抓到违规但没抓到：${code}（得到 ${JSON.stringify(hits)}）`
    )
  }
  const good = [
    "import { classifyStorageFailure, reportStorageError } from '../services/chat/db.js'",
    "import type { StoredFile } from '../services/chat/db.js'",
    "import { type StoredFile, reportStorageError } from '../services/chat/db.js'",
    "import { attachmentTextKey, isAttachmentBlobKey } from '../services/attachments/store.js'",
    "import { getStorage } from '../services/storage/index.js'",
    "// import { loadFile } from '../services/chat/db.js'\n/* indexedDB */ const a = 1",
    "import { useStore } from '../services/auth/store.js'",
  ]
  for (const code of good) {
    assert.deepEqual(violationsOf(fake, code), [], `不应误报：${code}`)
  }
})
