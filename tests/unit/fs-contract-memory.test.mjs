// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 被测对象：src/services/fs/memoryFs.ts 对 AppFileSystem 契约（tests/helpers/fs-contract）的满足程度。
// memoryFs 是契约的第一个被测实现，也是 Storage Protection 单测的替身。
// 原生实现（Android）的同一份契约见 docs/fs-device-checklist.md（本期未执行）。
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { runFsContract } from '../helpers/fs-contract/index.mjs'

installTsResolve()
const { createMemoryFs } = await loadTsModule('src/services/fs/memoryFs.ts')

runFsContract({
  name: 'memoryFs',
  create: () => createMemoryFs(),
  injectEnospc: (fs) => fs.injectEnospc(),
  injectCrashMidWrite: (fs) => fs.injectCrashMidWrite(),
  tempFiles: (fs) => fs.tempFiles(),
})
