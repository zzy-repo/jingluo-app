// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// issue #536：历史归档的两个导出入口必须走同一条落盘出口。
//
//   cd /root/deepseek-app && node tests/unit/export-single-exit.test.mjs
//
// 背景：全量导出（#307）修好了 Android 落盘，但「导出选中」（#390）自己走 `utils/downloadBlob`
// 的锚点下载 —— WebView 里 `<a download>` 对 blob URL 不会落盘，用户点了没反应也不报错。
// 这条断言把「两条入口共用同一个出口」钉在源码上，防止以后再分叉。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const ENTRY_POINTS = ['src/components/settings/SettingsDialog.tsx', 'src/components/sider/Sider.tsx']
const SHARED_EXIT = 'src/services/historyExportExit.ts'

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok ${label}`)
}

console.log('[1] 两个入口都指向同一个出口')
for (const file of ENTRY_POINTS) {
  check(`${path.basename(file)} import 了 saveHistoryArchive 且调用了它`, () => {
    const src = read(file)
    assert.match(
      src,
      /import \{[^}]*saveHistoryArchive[^}]*\} from '(\.\.\/)+services\/historyExportExit\.js'/,
      '缺少从 historyExportExit 引入 saveHistoryArchive'
    )
    assert.match(src, /saveHistoryArchive\(\{/, '没有真正调用 saveHistoryArchive')
  })
}

console.log('[2] 锚点下载已从入口侧移除')
for (const file of ENTRY_POINTS) {
  check(`${path.basename(file)} 不再引用 utils/downloadBlob`, () => {
    assert.doesNotMatch(read(file), /utils\/downloadBlob/)
  })
}
check('utils/downloadBlob.ts 已被删除（并入 exportText 的出口）', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/utils/downloadBlob.ts')), false)
})

console.log('[3] 共享出口只保留一份实现')
check('historyExportExit 把 ZIP MIME 与失败码映射收在一起', () => {
  const src = read(SHARED_EXIT)
  assert.match(src, /mimeType: 'application\/zip'/, '归档 MIME 应在这里统一给出')
  assert.match(src, /START_FAILED/, '缺少 START_FAILED 的失败码映射')
  assert.match(src, /TOO_LARGE/, '缺少 TOO_LARGE 的失败码映射')
  assert.match(src, /WRITE_FAILED/, '缺少 WRITE_FAILED 的失败码映射')
  assert.match(src, /saveBlobFile\(/, '应委托给 exportText 的统一保存函数')
})
check('exportErrorKey 仍在 SettingsDialog 使用（失败码映射没有被复制回组件）', () => {
  const src = read('src/components/settings/SettingsDialog.tsx')
  assert.match(src, /exportErrorKey\(error\)/)
  assert.doesNotMatch(src, /historyExportFailedStart[^\n]*\n?\s*if/, '组件里不应再有一份失败码映射实现')
})

console.log(`\n${passed} 项通过`)
