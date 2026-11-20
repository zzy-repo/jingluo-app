// [layer: regression | 依赖: 无（纯 Node + fflate 打 ZIP，无网络/无 IndexedDB） | Issue #32（关联 #50 / #40）]
//
// 回归对象：归档导入的**条目顺序容错**——src/services/chat/history/importArchive.ts。
//
// 修复前症状（#32）：导入在 staging 阶段报「文件内容不完整」。真实导出的 ZIP 里会话与图片是
//   交错排列、index 常常压在包尾、还夹着没有被任何消息引用的图片条目；
//   当时按「manifest → 全部会话 → index → 全部图片」的固定顺序解析，顺序一偏就整包失败。
// 修复后预期：
//   - 会话 JSON 与图片交错、index 在末尾，照样导完；
//   - 没有被引用的条目跳过（不落盘、不报错），不能因为多一个文件就整包失败；
//   - 引用的图片全部落盘，文件类型表按实际落盘内容交回 db。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 真实 errors.ts 用了 TS 参数属性，node strip-only 加载不了；替身保留 key/params 语义
    if (specifier === './errors.js') return { url: errorsStub, shortCircuit: true }
    // IndexedDB 在 node 里没有；staging 写入用记录型替身
    if (specifier === '../db.js') return { url: stub('history-db.mjs'), shortCircuit: true }
    // 仓库源码里写的是 `./paths.js`（编译后路径），node 直接跑 .ts 时要回退到同名 .ts
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { importArchive } = await import('../../src/services/chat/history/importArchive.ts')
const { buildArchive } = await import('../fixtures/domain05/archive-fixture.mjs')

const resetStaging = () => {
  globalThis.__stagedFiles = []
  globalThis.__stagedSessions = []
  globalThis.__stagedTypes = null
}

const importZip = async (zip, name = 'deepseek_data-test.zip') => {
  resetStaging()
  await importArchive(new File([zip], name), {})
}

test('#32 会话与图片交错、index 压在末尾的真实包必须能导完', async () => {
  const { zip, sessions } = buildArchive({ sessionCount: 3, imageBytes: 512 })
  await importZip(zip)
  assert.equal(globalThis.__stagedSessions.length, sessions, '每个会话都要进 staging')
  assert.equal(globalThis.__stagedFiles.length, sessions, '每张被引用的图片都要落盘')
  assert.equal(
    globalThis.__stagedTypes?.size,
    sessions,
    '文件类型表要按实际落盘的图片交回 db（少了就等于 staging 里没有类型）'
  )
})

test('#32 未被引用的多余条目只跳过，不能让整包失败', async () => {
  const { zip, sessions } = buildArchive({ sessionCount: 2, imageBytes: 256, padBytes: 4096 })
  await importZip(zip)
  assert.equal(globalThis.__stagedSessions.length, sessions)
  assert.equal(globalThis.__stagedFiles.length, sessions, '多余的 unreferenced.png 不该落盘')
  const storedPaths = [...(globalThis.__stagedTypes?.keys() ?? [])]
  assert.ok(
    storedPaths.every((path) => !path.includes('unreferenced')),
    `未被引用的条目被当成图片存了：${storedPaths.join(', ')}`
  )
})

test('#32 纯会话包（无图片）同样不受顺序影响', async () => {
  const { zip, sessions } = buildArchive({ sessionCount: 2, imageBytes: 0 })
  await importZip(zip)
  assert.equal(globalThis.__stagedSessions.length, sessions)
  assert.equal(globalThis.__stagedFiles.length, 0)
  assert.equal(globalThis.__stagedTypes?.size ?? 0, 0)
})
