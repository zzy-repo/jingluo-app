// [layer: regression | 依赖: 无（纯函数，storage 用内存替身） | Issue #34（关联 #24 / #23）]
//
// 回归对象：导入体积上限的**唯一口径**——src/services/chat/history/importLimit.ts。
//
// 修复前症状（#34 / #24）：链接导入把 200MB 的包误报成「文件过大」；上限散落在多处、
//   调用方传 0 或负数时被当成「无上限」直接放行，随后内存三份拷贝把 WebView 拖死。
// 修复后预期：默认上限 200MB 且向下取整算 MB；调用方传非法值（NaN / ≤0 / 非数字）一律退回默认，
//   **不接受「无上限」这个语义**。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_MAX_IMPORT_BYTES, maxImportMegabytes, resolveMaxImportBytes } = await import(
  '../../src/services/chat/history/importLimit.ts'
)

test('#34 默认上限是 200MB，提示文案按 MB 向下取整', () => {
  assert.equal(DEFAULT_MAX_IMPORT_BYTES, 200 * 1024 * 1024)
  assert.equal(maxImportMegabytes(), 200)
  assert.equal(maxImportMegabytes(200 * 1024 * 1024 - 1), 199, '宁可提示小一点，也不要报未达的余量')
  assert.equal(maxImportMegabytes(1024 * 1024), 1)
})

test('#34 调用方传入的合法上限原样生效（默认值不许被顺手改掉）', () => {
  assert.equal(resolveMaxImportBytes(1024 * 1024), 1024 * 1024)
  assert.equal(resolveMaxImportBytes(1), 1)
})

test('#34 非法上限一律退回默认值，绝不解释成「无上限」', () => {
  for (const value of [undefined, 0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      resolveMaxImportBytes(value),
      DEFAULT_MAX_IMPORT_BYTES,
      `${String(value)} 必须退回默认上限（无上限会让 WebView 直接 OOM）`
    )
  }
})
