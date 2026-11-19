/**
 * N5 反馈弹窗负向表（域 8 · F8-04 / F8-05）的**唯一数据源**。
 *
 * 现有用例只测了「选出图片后能预览」这一条正向路径（`feedback-images` / `feedback-scroll` /
 * `diagnostics[6]`）。失败分支（非图片 / 相册读不出来 / 压缩失败 / 剪贴板失败 / 空描述）
 * 一个都没有断言 —— 而这几种恰好是用户**最容易踩到**的（选错文件、相册权限、局域网 HTTP 下剪贴板不可用）。
 *
 * 一行 = 一个负向场景，列：
 *   - `patch`：页面里要注入的故障（`addInitScript`，在应用代码跑之前生效）
 *   - `file`：要选的「图片」（`kind` 决定 buffer 怎么造）
 *   - `expect`：期望的提示文案 / 是否出现预览 / 提交键是否可点
 *
 * 文案来自 i18n（`src/i18n/zh.ts`）：`feedbackScreenshotFailed` / `copyFailed` / `feedbackDescriptionRequired`。
 * 只放数据，断言在 `tests/integration/domain08-feedback-negative.test.mjs`。
 */

export const TOAST = {
  screenshotFailed: '图片处理失败，请换一张再试',
  copyFailed: '复制失败，请长按或选中文本后复制',
  descriptionRequired: '请先填写问题描述',
}

export const NEGATIVE_CASES = [
  {
    id: 'U1',
    fn: 'F8-04',
    label: '选了一张非图片文件（.txt）',
    patch: 'none',
    action: 'pick',
    file: { kind: 'text', name: 'note.txt', mimeType: 'text/plain' },
    expect: { toast: TOAST.screenshotFailed, preview: false },
  },
  {
    id: 'U2',
    fn: 'F8-04',
    label: '相册里的图读不出来（FileReader 失败 ≈ 权限被拒 / 文件损坏）',
    patch: 'reader-deny',
    action: 'pick',
    file: { kind: 'image', name: 'denied.png', mimeType: 'image/png' },
    expect: { toast: TOAST.screenshotFailed, preview: false },
  },
  {
    id: 'U3',
    fn: 'F8-04',
    label: '压缩失败（canvas 不可用）→ 退回原图，不阻塞提交',
    patch: 'canvas-broken',
    action: 'pick',
    file: { kind: 'image', name: 'shot.png', mimeType: 'image/png' },
    expect: { toast: null, preview: true },
  },
  {
    id: 'U4',
    fn: 'F8-04',
    label: '超大图（5000×4000）→ 压到最长边 ≤1280 后仍可预览',
    patch: 'none',
    action: 'pick',
    file: { kind: 'svg-large', name: 'huge.svg', mimeType: 'image/svg+xml' },
    expect: { toast: null, preview: true, maxEdge: 1280 },
  },
  {
    id: 'U5',
    fn: 'F8-05',
    label: '剪贴板不可用（局域网 HTTP / 权限拒绝）→ 复制单条日志要明说失败',
    patch: 'clipboard-deny',
    action: 'copy-log',
    expect: { toast: TOAST.copyFailed },
  },
  {
    id: 'U6',
    fn: 'F8-07',
    label: '描述为空 → 提交键不可点（不会静默失败，也不会发出空反馈）',
    patch: 'none',
    action: 'submit-empty',
    expect: { toast: null, submitDisabled: true },
  },
]

/**
 * 已登记的真实缺口（现状红）：非图片文件会被**静默当成截图**收下 ——
 * `prepareScreenshot` 只做「读文件 → 试着压缩」，压缩失败退回原图，
 * 所以选一个 `.txt` 进去时既不报错，预览里还会出现一个坏图，用户点提交就把垃圾带上去了。
 * 追踪：#367（域 8+9 最小充分集）→ 子单登记修复（`prepareScreenshot` 加 `file.type` / 解码校验）。
 */
export const KNOWN_GAPS = [{ row: 'U1', issue: '#367', reason: '非图片文件被静默当作截图收下，没有任何提示' }]
