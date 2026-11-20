// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// issue #379：导入会话里的历史附件不参与发送前补传。
//
//   cd /root/deepseek-app && node tests/unit/history-attachment-reupload.test.mjs
//
// [1] 导入的附件（imported=true）一律不补传：它们是既有消息记录，不是待发送内容
// [2] 用户自己新加、还没有 serverId 的附件仍然补传
// [3] 已经有 serverId 的附件不补传（本来就带 file_id 进请求）
//
// 源码里的相对 import 是 `.js` 写法（tsc NodeNext 要求），这里挂 resolve hook 指到 `.ts`。
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { shouldReuploadHistoryAttachment, shouldUploadQuestionAttachment } = await import(
  '../../src/services/chat/historyAttachment.ts'
)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok ${label}`)
}

console.log('[1] 导入的附件不补传')
check('imported=true 且无 serverId → 不补传（#379 的核心）', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: null, imported: true }), false)
})
check('imported=true 且有 serverId → 仍然不补传', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: 'file-api-1', imported: true }), false)
})
check('缺省 imported 视为用户自己的附件（老会话不带这个字段）', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: null }), true)
})

console.log('[2] 新加附件照常补传')
check('用户自己加的、还没 serverId → 补传', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: null, imported: false }), true)
})

console.log('[3] 已有 file_id 的不补传')
check('有 serverId → 不补传', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: 'file-api-2' }), false)
})
check('有 serverId 且 imported=false → 不补传', () => {
  assert.equal(shouldReuploadHistoryAttachment({ serverId: 'file-api-3', imported: false }), false)
})

console.log(`\n${passed} 项通过`)

console.log('[4] 本轮提问的附件')
check('导入的附件不进上传队列（编辑并重发导入消息时也不能阻断发送）', () => {
  assert.equal(shouldUploadQuestionAttachment({ serverId: null, imported: true }), false)
})
check('用户新加的附件照常上传', () => {
  assert.equal(shouldUploadQuestionAttachment({ serverId: null }), true)
})
console.log(`\n合计 ${passed} 项通过`)
