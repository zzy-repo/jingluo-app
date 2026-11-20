// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #40
//
// check 阶段（`checkArchiveFormat`）必须给出**可区分**的失败原因，不再把一切折叠成
// 笼统的 backupUnrecognized / backupIncomplete：
//   [1] 首个条目不是 manifest.json → backupManifestNotFirst（带出 found / expected）
//   [2] ZIP 没有任何条目（空包）→ backupEmptyArchive
//   [3] 条目数据 CRC 不符（ArchiveError）→ backupArchiveDamaged（带出 entry / index），
//       不再折叠成 backupIncomplete
//   [4] 中央目录读不到（截断包，ArchiveError）→ backupArchiveUnreadable
//   [5] 四条新文案 zh / en 都在、占位符一一对应、en 下不出现中文
//   [6] 正例回归：manifest 在首位且版本合法时照旧通过
//
//   node tests/unit/import-archive-manifest.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件。
// errors.ts 用 TS 参数属性，node 的 strip-only 模式不支持，按仓库既有做法换成等价替身
// （key / params / message 三条语义一致，message 用真实 zh 文案渲染）。
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './errors.js') {
      return { url: errorsStub, shortCircuit: true }
    }
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

const { zipSync, strToU8 } = await import('fflate')
const { checkArchiveFormat } = await import('../../src/services/chat/history/importArchive.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const MANIFEST = 'manifest.json'
const manifestJson = JSON.stringify({ export_format_version: 3 })

/** level: 0 = stored（不压缩），这样篡改数据字节只会导致 CRC 不符，不会破坏 deflate 流 */
const stored = (text) => [strToU8(text), { level: 0 }]

const zipOf = (entries) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, stored(text)])))

const archiveOf = (bytes, name = 'history.zip') => new File([bytes], name)

/** 断言失败并返回错误对象（成功则直接失败） */
const failure = async (file) => {
  try {
    await checkArchiveFormat(file)
  } catch (error) {
    return error
  }
  return assert.fail('check 阶段必须失败，但校验通过了')
}

const findBytes = (haystack, needle) => {
  const pattern = strToU8(needle)
  outer: for (let start = 0; start + pattern.length <= haystack.length; start++) {
    for (let index = 0; index < pattern.length; index++) {
      if (haystack[start + index] !== pattern[index]) {
        continue outer
      }
    }
    return start
  }
  return -1
}

test('首个条目不是 manifest：给出 backupManifestNotFirst 并说明实际/期望条目', async () => {
  const error = await failure(archiveOf(zipOf({ 'user.json': '{}', [MANIFEST]: manifestJson })))

  assert.equal(error?.name, 'BackupError')
  assert.equal(
    error?.key,
    'backupManifestNotFirst',
    `首个条目不是 manifest 时必须给出可区分原因（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(error?.params?.found, 'user.json')
  assert.equal(error?.params?.expected, MANIFEST)
  assert.match(error.message, /manifest\.json/)
  assert.match(error.message, /user\.json/)
  assert.notEqual(error.message, zh.backupUnrecognized, '不许退化成笼统的「无法识别该文件」')
})

test('空包（只有目录条目、没有任何文件）：给出 backupEmptyArchive', async () => {
  // 只有目录条目（以 / 结尾、size 0）时 readArchive 一条都不会交给调用方：
  // 这种包在 isZipFile 阶段是合法 ZIP，必须落到「一个文件都没有」的原因上。
  const error = await failure(archiveOf(zipSync({ 'deepseek_export/': [new Uint8Array(0), { level: 0 }] })))

  assert.equal(error?.name, 'BackupError')
  assert.equal(error?.key, 'backupEmptyArchive', `实际 ${error?.key}: ${error?.message}`)
  assert.notEqual(error.message, zh.backupUnrecognized, '不许退化成笼统的「无法识别该文件」')
})

test('条目数据 CRC 不符：ArchiveError 带出条目名与序号，不再折叠成 backupIncomplete', async () => {
  const bytes = zipOf({ [MANIFEST]: `{"export_format_version":3,"note":"CRC-PROBE"}` })
  const at = findBytes(bytes, 'CRC-PROBE')
  assert.ok(at > 0, '测试夹具里必须能找到探针字符串')
  bytes[at] = 'X'.charCodeAt(0) // 篡改条目数据 → CRC 校验失败

  const error = await failure(archiveOf(bytes))

  assert.equal(error?.name, 'BackupError')
  assert.equal(
    error?.key,
    'backupArchiveDamaged',
    `ZIP 数据损坏必须给出可区分原因（实际 ${error?.key}: ${error?.message}）`
  )
  assert.equal(error?.params?.entry, MANIFEST)
  assert.equal(error?.params?.index, 1)
  assert.match(error.message, /manifest\.json/)
  assert.notEqual(error.message, zh.backupIncomplete, '不许折叠成笼统的「文件内容不完整」')
})

test('中央目录读不到（截断包）：给出 backupArchiveUnreadable', async () => {
  const bytes = zipOf({ [MANIFEST]: manifestJson })
  const truncated = bytes.subarray(0, bytes.length - 12) // 砍掉 EOCD

  const error = await failure(archiveOf(truncated))

  assert.equal(error?.name, 'BackupError')
  assert.equal(error?.key, 'backupArchiveUnreadable', `实际 ${error?.key}: ${error?.message}`)
  assert.notEqual(error.message, zh.backupIncomplete, '不许折叠成笼统的「文件内容不完整」')
})

test('四条新文案 zh/en 都在，占位符对齐且 en 下不出现中文', async () => {
  const keys = ['backupManifestNotFirst', 'backupEmptyArchive', 'backupArchiveDamaged', 'backupArchiveUnreadable']
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} 文案不能为空`)
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符必须一一对应`)
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en.${key} 不许出现中文：${en[key]}`)
    assert.doesNotMatch(zh[key], /\{[a-z]+\}\s*[a-z]+\{[a-z]+\}/, `zh.${key} 占位符异常`)
  }
})

test('正例回归：manifest 在首位且版本合法时照旧通过', async () => {
  await checkArchiveFormat(archiveOf(zipOf({ [MANIFEST]: manifestJson, 'user.json': '{}' })))
})
