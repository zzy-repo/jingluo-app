// [layer: unit | 依赖: 无（纯 Node；原生桥 / 浏览器 DOM 都是注入替身） | 耗时: <2s] Issue #536
//
// 「导出选中」与「导出全部」必须走**同一个落盘出口**（#536 的根因就是两条路分叉）：
//   [1] 原生（Android WebView）：走 ExportText 二进制分块，字节逐位还原，落盘文件名以 `finish` 为准；
//   [2] 取消：用户在 SAF 面板点取消 → `cancelled`，既不算成功也不算失败（磁盘上没有文件）；
//   [3] 失败：原生桥的 code 一次翻成上屏文案（不许各调用点各抄一份映射）；
//   [4] Web：仍走锚点下载（`<a download>` + blob URL），不是「Android 静默失败」那条路；
//   [5] 接线：`Sider.tsx`（导出选中）与 `SettingsDialog.tsx`（导出全部）都只经由
//       `services/chat/history/saveArchive.ts`，且 `src/` 里不再有第二个归档落盘实现。
//
// 为什么这些断言放 L0：`.tsx` 组件在 `node --test` 里 import 不了（JSX 不在类型擦除范围内），
// 所以「两个入口共用同一出口」用**源码接线断言**钉住（第 [5] 条），落盘语义用真实现跑（[1]~[4]）。
//
//   node --test tests/unit/export-selected-native-536.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { asTypescript } from '../fixtures/domain05/hooks.mjs'

/** `@capacitor/core` 替身：`isNativePlatform()` 读 `globalThis.__native`，插件桥读 `globalThis.__bridge` */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export const Capacitor = { isNativePlatform: () => globalThis.__native === true }; export const registerPlugin = () => globalThis.__bridge;"
        )}`,
        shortCircuit: true,
      }
    }
    // 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const ROOT = path.resolve(import.meta.dirname, '../..')

/** 桥调用流水：每次重置，断言「到底走没走原生」 */
const calls = []
let startResult
let finishResult
let failAt

const reset = () => {
  calls.length = 0
  failAt = null
  startResult = { id: 'job' }
  finishResult = { status: 'saved', name: 'deepseek_data-2026-11-20.zip' }
  globalThis.__native = true
}

globalThis.__bridge = {
  start: async (options) => {
    calls.push(['start', options])
    if (failAt === 'start') {
      throw Object.assign(new Error('打开保存位置失败'), { code: 'START_FAILED' })
    }
    return startResult
  },
  writeChunk: async (options) => {
    calls.push(['chunk', options])
  },
  writeBinaryChunk: async (options) => {
    calls.push(['binary', options])
    if (failAt === 'write') {
      throw Object.assign(new Error('写入归档失败'), { code: 'WRITE_FAILED' })
    }
    if (failAt === 'too-large') {
      throw Object.assign(new Error('归档超过上限'), { code: 'TOO_LARGE' })
    }
  },
  finish: async (options) => {
    calls.push(['finish', options])
    return finishResult
  },
  abort: async (options) => {
    calls.push(['abort', options])
  },
}

const { saveHistoryArchive, archiveErrorKey, ARCHIVE_MIME_TYPE } = await import(
  '../../src/services/chat/history/saveArchive.ts'
)
const { unzipSync, zipSync, strToU8, strFromU8 } = await import('fflate')

/** 一份**真 ZIP**（不是随机字节）：导出产物本来就是 ZIP，替身也用它，顺带能验证字节没被改坏 */
const archiveBytes = () =>
  zipSync({
    'manifest.json': strToU8(JSON.stringify({ version: 1, sessions: 2 })),
    'sessions/a.json': strToU8('{"id":"a"}'),
  })

const archiveBlob = () => new Blob([archiveBytes()], { type: ARCHIVE_MIME_TYPE })

/** 跨多个 48KiB 分块边界的大归档（分块边界是 base64 往返最容易出错的地方） */
const bigArchiveBlob = () => {
  const bytes = new Uint8Array(48 * 1024 * 2 + 777)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
  bytes[0] = 0xff
  bytes[1] = 0x00
  return new Blob([bytes], { type: ARCHIVE_MIME_TYPE })
}

/** 把桥收到 base64 分块还原成字节（`Base64.DEFAULT` 容忍换行，替身这里只认无换行） */
const joined = () => {
  const chunks = calls.filter(([kind]) => kind === 'binary').map(([, options]) => options.data)
  return Buffer.concat(chunks.map((data) => Buffer.from(data, 'base64')))
}

test('[1] 原生：选中导出走 ExportText 二进制分块，字节逐位还原，文件名以 finish 为准', async () => {
  reset()
  const blob = archiveBlob()
  const outcome = await saveHistoryArchive({ filename: 'deepseek_data-2026-11-20.zip', blob })

  assert.deepEqual(outcome, { kind: 'saved', name: 'deepseek_data-2026-11-20.zip' })
  // ① 打开的是**二进制**模式的 ZIP（不是文本模式，也不是别的 MIME）
  const start = calls.find(([kind]) => kind === 'start')
  assert.ok(start, '必须调用原生 start')
  assert.equal(start[1].mimeType, 'application/zip')
  assert.equal(start[1].binary, true, '归档必须以二进制模式打开，否则原生侧会按 TXT 8MB 上限写')
  // ② 一个字节都不许走文本分块
  assert.equal(calls.some(([kind]) => kind === 'chunk'), false, '归档不许走 writeChunk（文本）通道')
  // ③ 字节逐位还原：解回 ZIP 还能读出原条目
  const bytes = joined()
  assert.deepEqual([...bytes], [...new Uint8Array(await blob.arrayBuffer())])
  const unzipped = unzipSync(new Uint8Array(bytes))
  assert.equal(strFromU8(unzipped['manifest.json']).includes('"sessions":2'), true)
  // ④ 收尾：finish 一次，之后没有 abort（成功路径不该清目标文件）
  assert.equal(calls.filter(([kind]) => kind === 'finish').length, 1)
  assert.equal(calls.some(([kind]) => kind === 'abort'), false)
})

test('[1b] 原生：跨分块边界的大归档也逐位还原（48KiB × 2 + 777 字节）', async () => {
  reset()
  const blob = bigArchiveBlob()
  const outcome = await saveHistoryArchive({ filename: 'big.zip', blob })
  assert.equal(outcome.kind, 'saved')
  assert.ok(calls.filter(([kind]) => kind === 'binary').length >= 3, '大归档必须分成多块写')
  assert.deepEqual([...joined()], [...new Uint8Array(await blob.arrayBuffer())])
})

test('[2] 取消：用户在 SAF 面板点取消 → cancelled，不写任何分块、不说「已导出」', async () => {
  reset()
  startResult = { status: 'cancelled' }
  const outcome = await saveHistoryArchive({ filename: 'x.zip', blob: archiveBlob() })
  assert.deepEqual(outcome, { kind: 'cancelled' })
  assert.equal(calls.some(([kind]) => kind === 'binary'), false, '取消后一个字节都不该写')
  assert.equal(calls.some(([kind]) => kind === 'finish'), false, '取消后不该 finish')
})

test('[3] 失败：原生失败码一次翻成上屏文案，且绝不返回 saved（不许静默）', async () => {
  // 打不开保存位置
  reset()
  failAt = 'start'
  assert.deepEqual(await saveHistoryArchive({ filename: 'x.zip', blob: archiveBlob() }), {
    kind: 'failed',
    key: 'historyExportFailedStart',
  })
  // 写不进去
  reset()
  failAt = 'write'
  assert.deepEqual(await saveHistoryArchive({ filename: 'x.zip', blob: archiveBlob() }), {
    kind: 'failed',
    key: 'historyExportFailedWrite',
  })
  // 超过 200MB 上限
  reset()
  failAt = 'too-large'
  assert.deepEqual(await saveHistoryArchive({ filename: 'x.zip', blob: archiveBlob() }), {
    kind: 'failed',
    key: 'historyExportFailedTooLarge',
  })
  // 认不得的码：通用文案 + 原文进 {message}
  reset()
  globalThis.__native = true
  assert.deepEqual(archiveErrorKey(Object.assign(new Error('boom'), { code: 'WHATEVER' })), 'historyExportFailed')
  assert.equal(archiveErrorKey(new Error('no code')), 'historyExportFailed')
})

test('[4] Web：没有原生平台时回退锚点下载（不是「点了没反应」那条路）', async () => {
  reset()
  globalThis.__native = false
  const clicked = []
  const originalDocument = globalThis.document
  const originalUrl = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => {
    clicked.push(['url', blob.type, blob.size])
    return 'blob:fake'
  }
  URL.revokeObjectURL = () => {}
  globalThis.document = {
    body: { appendChild: () => {} },
    createElement: () => ({
      set href(value) {
        this._href = value
      },
      get href() {
        return this._href
      },
      download: '',
      remove: () => {},
      click() {
        clicked.push(['click', this.download, this._href])
      },
    }),
  }
  try {
    const blob = archiveBlob()
    const outcome = await saveHistoryArchive({ filename: 'deepseek_data-2026-11-20.zip', blob })
    assert.deepEqual(outcome, { kind: 'saved', name: 'deepseek_data-2026-11-20.zip' })
    assert.deepEqual(clicked, [
      ['url', 'application/zip', blob.size],
      ['click', 'deepseek_data-2026-11-20.zip', 'blob:fake'],
    ])
    assert.equal(calls.length, 0, 'Web 上不许碰原生桥')
  } finally {
    globalThis.__native = true
    globalThis.document = originalDocument
    URL.createObjectURL = originalUrl
    URL.revokeObjectURL = originalRevoke
  }
})

test('[4b] Web 能力缺失（没有 createObjectURL）→ 归一成失败，不假装保存成功', async () => {
  reset()
  globalThis.__native = false
  const originalUrl = URL.createObjectURL
  try {
    URL.createObjectURL = undefined
    const outcome = await saveHistoryArchive({ filename: 'x.zip', blob: archiveBlob() })
    assert.equal(outcome.kind, 'failed', '能力缺失必须是 failed，不许静默返回 saved')
    assert.equal(outcome.key, 'historyExportFailed')
    assert.match(String(outcome.params?.message), /SAVE_UNAVAILABLE/)
  } finally {
    URL.createObjectURL = originalUrl
    globalThis.__native = true
  }
})

// ------------------------------------------------------------------ [5] 接线（同一个出口）

const sourceOf = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

/** 递归列 `src/**` 下的源码文件（排掉测试与构建产物） */
const walkSrc = (dir = path.join(ROOT, 'src'), out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      walkSrc(full, out)
    } else if (/\.(?:ts|tsx)$/u.test(entry)) {
      out.push(full)
    }
  }
  return out
}

test('[5] 两个导出入口都只经由 saveArchive.ts（同一个出口，不许再分叉）', () => {
  const sider = sourceOf('src/components/sider/Sider.tsx')
  const settings = sourceOf('src/components/settings/SettingsDialog.tsx')

  // ① 两个入口都 import 同一个函数，且路径**逐字相同**（改路径必须两处一起改，改一处就红）
  const importOf = (source) => {
    const found = source.match(/import \{ saveHistoryArchive \} from '([^']+)'/u)
    return found === null ? null : found[1]
  }
  assert.equal(importOf(sider), '../../services/chat/history/saveArchive.js', 'Sider（导出选中）必须走共用出口')
  assert.equal(importOf(settings), '../../services/chat/history/saveArchive.js', '设置页（导出全部）必须走共用出口')
  assert.equal(importOf(sider), importOf(settings), '两个入口的出口路径必须一模一样')

  // ② 谁都不许再自己下载：锚点工具与原生桥都不该被这两个文件直接碰到
  for (const [name, source] of [
    ['Sider.tsx', sider],
    ['SettingsDialog.tsx', settings],
  ]) {
    assert.equal(/from '[^']*utils\/downloadBlob\.js'/u.test(source), false, `${name} 不许再直接用锚点下载`)
    assert.equal(/from '[^']*exportText\.js'/u.test(source), false, `${name} 不许绕过共用出口直连原生保存实现`)
    assert.equal(/saveBlobFile\(|downloadBlob\(/u.test(source), false, `${name} 里不该再出现落盘调用`)
  }

  // ③ 全仓只有一个模块实现归档落盘：`src/` 里 import `saveBlobFile` 的只能是 saveArchive.ts
  const savers = walkSrc()
    .filter((file) => /import \{[^}]*saveBlobFile[^}]*\} from/u.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
  assert.deepEqual(savers, ['src/services/chat/history/saveArchive.ts'], `归档落盘实现只能有一处，实测：${savers.join(', ')}`)

  // ④ 老的锚点工具已经删干净（留着就是下一次分叉的现成模板）
  assert.equal(
    readdirSync(path.join(ROOT, 'src/utils')).includes('downloadBlob.ts'),
    false,
    'src/utils/downloadBlob.ts 应已删除：Web 锚点下载只在 services/exportText.ts 里有一份'
  )
})
