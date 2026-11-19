// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// issue #2：长文本复制阈值按 UTF-8 字节数判定（不是字符数）。
//
//   cd /root/deepseek-app && node tests/unit/copy-limit.test.mjs
//
// [1] ASCII / 中文 / emoji 的字节数：1 / 3 / 4
// [2] 阈值判定：正好 512 KiB 可复制，多 1 字节即超限
// [3] 中文 200000 字（600000 字节）超限；emoji 140000 个（560000 字节、仅 140000 字符）同样超限
// [4] 提示用的 KiB 向上取整
//
// clipboard.ts 现在还 import 了 utils/capabilities.ts（#209 统一能力探测），源码里的相对 import
// 是 `.js` 写法（tsc NodeNext 要求），所以这里要挂 resolve hook 把它指到 `.ts`——和
// tests/unit/legacy-polyfills.test.mjs 同一套手法，因此改为动态 import。
import { registerHooks } from 'node:module'

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

const {
  COPY_LIMIT_BYTES,
  exceedsCopyLimit,
  kibibytes,
  utf8ByteLength,
} = await import('../../src/utils/clipboard.ts')

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const expect = (actual, expected, message) => {
  if (actual === expected) {
    ok(`${message}（${expected}）`)
  } else {
    failures.push(`${message}：期望 ${expected}，实际 ${actual}`)
    console.error(`  ✗  ${message}：期望 ${expected}，实际 ${actual}`)
  }
}

expect(COPY_LIMIT_BYTES, 512 * 1024, '[1a] 阈值是 512 KiB')
expect(utf8ByteLength('abc'), 3, '[1b] ASCII 每字符 1 字节')
expect(utf8ByteLength('中文'), 6, '[1c] 中文每字符 3 字节')
expect(utf8ByteLength('😀'), 4, '[1d] emoji 每字符 4 字节（代理对不重复计）')
expect(utf8ByteLength(''), 0, '[1e] 空串 0 字节')

expect(exceedsCopyLimit('a'.repeat(COPY_LIMIT_BYTES)), false, '[2a] 正好 512 KiB 不算超限')
expect(exceedsCopyLimit('a'.repeat(COPY_LIMIT_BYTES + 1)), true, '[2b] 多 1 字节即超限')
expect(
  exceedsCopyLimit('中'.repeat(Math.ceil(COPY_LIMIT_BYTES / 3))),
  true,
  '[2c] 中文按 3 字节计：174763 字 = 524289 字节即超限'
)
expect(
  exceedsCopyLimit('中'.repeat(Math.floor(COPY_LIMIT_BYTES / 3))),
  false,
  '[2d] 中文 174762 字 = 524286 字节仍可复制'
)

const chinese200k = '中'.repeat(200_000)
expect(utf8ByteLength(chinese200k), 600_000, '[3a] 中文 200000 字 = 600000 字节')
expect(exceedsCopyLimit(chinese200k), true, '[3b] 中文 200000 字超限')

const emoji140k = '😀'.repeat(140_000)
expect(emoji140k.length, 280_000, '[3c] 140000 个 emoji 是 280000 个 UTF-16 单元')
expect(utf8ByteLength(emoji140k), 560_000, '[3d] 但 UTF-8 是 560000 字节')
expect(exceedsCopyLimit(emoji140k), true, '[3e] 字符数远小于阈值、按字节判定仍超限')

expect(kibibytes('a'.repeat(COPY_LIMIT_BYTES)), 512, '[4a] 正好 512 KiB 显示 512')
expect(kibibytes(chinese200k), 586, '[4b] 600000 字节向上取整为 586 KiB')

console.log(`\n共 ${checks} 项断言`)
if (failures.length > 0) {
  console.error(`FAIL tests/unit/copy-limit.test.mjs（${failures.length} 条）`)
  process.exit(1)
}
console.log('PASS tests/unit/copy-limit.test.mjs')
