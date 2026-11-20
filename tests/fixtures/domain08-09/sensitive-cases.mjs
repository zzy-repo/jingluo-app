/**
 * N1 敏感字段矩阵的**唯一数据源**（域 8 · 反馈与诊断）。
 *
 * 功能点：#362 的 F8-11（脱敏：`sk-` / `Bearer` / `token=` / `Signature=` / `AccessKeyId=` → `***`，
 * 完整 URL 只剩 path）与 F8-12（设备码 / 卡密 / 手机号**绝不进**日志、导出、错误页）。
 *
 * 为什么是一张表：域 8 的敏感字段天生条目多，一项一条用例会炸（见
 * `docs/testing/coverage/domain08-09.md` §0.3 的减法原则）。一张表 × 三个边界
 * （采集层日志 `sanitizeMeta` / 离线导出 `redactExportText` + 整份导出文件 / 错误页
 * `scrubReportText` + `buildErrorReport`）就能把「谁在哪个边界漏」钉死。
 *
 * 列的口径（每一行的 `expect.<boundary>`）：
 *   - `includes`：期望**出现**的打码形态（现状不符合就是缺口 → 由用例登记为 known-red）
 *   - `excludes`：除「原文一律不许出现」之外的额外禁止片段（host / query / fragment 这类）
 * 所有行的 `secrets` 都会在三个边界里逐个断言「不得原样出现」，不需要逐行重复写。
 *
 * 打码形态的来源（不要另发明一套）：
 *   - `src/services/ours/mask.ts` 的 `maskDeviceId` / `maskCard`：**只留尾 4 位**，前缀四个实心点
 *   - `redact.ts` 的既有约定：`sk-***` / `Bearer ***` / `token=***` / `Signature=***` / `AccessKeyId=***`
 *   - `export.ts` 的第二道边界：`[API_KEY]` / `[REDACTED]` / `[QUERY_REDACTED]`
 *
 * 本文件只放**数据**，断言在 `tests/unit/domain08-sensitive-fields.test.mjs`。
 */

/** 三个边界：采集层日志 / 离线导出 / 错误页 */
export const BOUNDARIES = ['log', 'export', 'error']

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
/** 卡密（带横杠的 4×4 分组，支付服务实际下发的形状） */
const CARD_DASHED = 'MUSE-3CYP-5NA3-AHSE-A3SR'
/** 卡号（19 位数字，银行卡 / 充值卡都可能是这种纯数字形状） */
const CARD_DIGITS = '6222021234567890123'
const PHONE = '13812345678'

/**
 * 值维度：敏感值出现在**自由文本**里（错误消息、日志正文、导出 msg）。
 * `text` 是该行喂给三个边界的原文，`secrets` 是其中不许原样出现的片段。
 */
export const VALUE_CASES = [
  {
    id: 'V1',
    fn: 'F8-11',
    label: 'API Key（sk- 前缀）',
    text: 'send failed key=sk-abcdefghijklmnopqrstuvwxyz012345',
    secrets: ['sk-abcdefghijklmnopqrstuvwxyz012345'],
    expect: {
      log: { includes: ['sk-***'], excludes: [] },
      export: { includes: ['[API_KEY]'], excludes: [] },
      error: { includes: ['sk-***'], excludes: [] },
    },
  },
  {
    id: 'V2',
    fn: 'F8-11',
    label: 'Authorization: Bearer',
    text: 'Authorization: Bearer abc.def.ghi',
    secrets: ['abc.def.ghi'],
    expect: {
      log: { includes: ['Bearer ***'], excludes: [] },
      // 导出层的第二道边界先按「键=值」整体打码，所以这里只剩 [REDACTED]
      export: { includes: ['[REDACTED]'], excludes: [] },
      error: { includes: ['Bearer ***'], excludes: [] },
    },
  },
  {
    id: 'V3',
    fn: 'F8-11',
    label: 'query 里的 token=（相对地址）',
    text: 'GET /v1/models?token=TOKENVALUE99&y=2',
    secrets: ['TOKENVALUE99'],
    expect: {
      log: { includes: ['token=***'], excludes: [] },
      export: { includes: ['[QUERY_REDACTED]'], excludes: ['TOKENVALUE99'] },
      error: { includes: ['token=***'], excludes: [] },
    },
  },
  {
    id: 'V4',
    fn: 'F8-11',
    label: '签名参数 Signature= / AccessKeyId=（完整 URL）',
    text: 'GET https://oss.example.com/x?Signature=SIGVALUE&AccessKeyId=AKVALUE',
    secrets: ['SIGVALUE', 'AKVALUE'],
    // 采集层把完整地址压成 path：host / query / 签名一起丢，所以这里断言的是「只剩 path」
    expect: {
      log: { includes: ['/x'], excludes: ['oss.example.com', 'https://'] },
      export: { includes: ['https://oss.example.com/x'], excludes: ['Signature', 'AccessKeyId'] },
      error: { includes: ['https://oss.example.com/***'], excludes: ['https://oss.example.com/x'] },
    },
  },
  {
    id: 'V5',
    fn: 'F8-11',
    label: '完整 URL（path + query + fragment）',
    text: 'GET https://oss.example.com/bucket/file.zip?Signature=SIG&y=2#FRAGMENT',
    secrets: ['SIG'],
    expect: {
      log: { includes: ['/bucket/file.zip'], excludes: ['oss.example.com', 'FRAGMENT', 'y=2'] },
      export: {
        includes: ['https://oss.example.com/bucket/file.zip'],
        excludes: ['FRAGMENT', '?Signature', 'y=2'],
      },
      error: { includes: ['https://oss.example.com/***'], excludes: ['FRAGMENT', 'file.zip'] },
    },
  },
  {
    id: 'V6',
    fn: 'F8-12',
    label: '设备码 device_id（d- + 32 hex）',
    text: `bind failed device_id=${DEVICE_ID}`,
    secrets: [DEVICE_ID],
    // 期望：只留尾 4 位（与 src/services/ours/mask.ts 的 maskDeviceId 同口径）
    expect: {
      log: { includes: ['••••cdef'], excludes: [] },
      export: { includes: ['[DEVICE_ID]'], excludes: [] },
      error: { includes: ['••••cdef'], excludes: [] },
    },
  },
  {
    id: 'V7',
    fn: 'F8-12',
    label: '卡密（带横杠分组）',
    text: `兑换失败 card=${CARD_DASHED}`,
    secrets: [CARD_DASHED],
    // 期望：只留尾 4 位（maskCard 口径）
    expect: {
      log: { includes: ['••••A3SR'], excludes: [] },
      export: { includes: ['[CARD]'], excludes: [] },
      error: { includes: ['••••A3SR'], excludes: [] },
    },
  },
  {
    id: 'V8',
    fn: 'F8-12',
    label: '卡号（19 位数字）',
    text: `支付失败 cardNo=${CARD_DIGITS}`,
    secrets: [CARD_DIGITS],
    expect: {
      log: { includes: ['••••0123'], excludes: [] },
      export: { includes: ['[CARD]'], excludes: [] },
      error: { includes: ['••••0123'], excludes: [] },
    },
  },
  {
    id: 'V9',
    fn: 'F8-12',
    label: '订单 token / 商户单号（key=value 形态）',
    text: '下单失败 order_token=ORDERSECRET123 out_trade_no=OUTTRADE2026111900001',
    secrets: ['ORDERSECRET123', 'OUTTRADE2026111900001'],
    // 期望：与 `token=` 同级处理，值打成 ***（导出侧打 [REDACTED]）
    expect: {
      log: { includes: ['order_token=***', 'out_trade_no=***'], excludes: [] },
      export: { includes: ['order_token=[REDACTED]', 'out_trade_no=[REDACTED]'], excludes: [] },
      error: { includes: ['order_token=***', 'out_trade_no=***'], excludes: [] },
    },
  },
  {
    id: 'V10',
    fn: 'F8-12',
    label: '手机号（11 位大陆号）',
    text: `联系方式解析失败 phone=${PHONE}`,
    secrets: [PHONE],
    // 期望：只留尾 4 位（与设备码 / 卡密同口径，不做整段丢弃）
    expect: {
      log: { includes: ['••••5678'], excludes: [] },
      export: { includes: ['[PHONE]'], excludes: [] },
      error: { includes: ['••••5678'], excludes: [] },
    },
  },
]

/**
 * 键维度：敏感值挂在**键名**上（`{deviceId: ...}` / `{cardNo: ...}`）。
 * 期望是「整条丢弃」，与 `apiKey` / `token` 同级 —— 键名本身已经表明值是什么。
 *
 * `error` 边界对这类行不适用：错误页的状态摘要只由 `ErrorBoundary` 的白名单键拼装
 * （没有 meta 这一层），所以这一半由 `domain08-sensitive-fields.test.mjs` 里的
 * 「状态摘要键集合」静态断言覆盖。
 */
export const KEY_CASES = [
  { id: 'K1', fn: 'F8-12', label: '键名 deviceId', key: 'deviceId', secret: DEVICE_ID },
  { id: 'K2', fn: 'F8-12', label: '键名 cardNo', key: 'cardNo', secret: CARD_DASHED },
  { id: 'K3', fn: 'F8-12', label: '键名 orderToken', key: 'orderToken', secret: 'ORDERSECRET123' },
  { id: 'K4', fn: 'F8-12', label: '键名 phone', key: 'phone', secret: PHONE },
]

/**
 * 已登记的真实缺口（**现状红**）：断言不放宽，登记在这里，等修复后自动转严格。
 *
 * 口径与 `scripts/check-log-coverage.mjs` 的 `knownGaps` 一致：
 *   - 表内单元格**仍然失败** → 报告为「已知缺口（已登记 #367）」，不算本次回归；
 *   - 表内单元格**意外变绿** → 用例**失败**，提示「已修复，请从 KNOWN_GAPS 删除这一行」；
 *   - 表外单元格变红 → 用例**失败**（真实泄漏）。
 *
 * 追踪单：Issue #367（域 8+9 最小充分集）。
 *
 * **#387 已修（2026-11）**：V6–V10 的 15 格全部转绿 —— `redact.ts` 补了设备码 / 卡密 / 卡号 /
 * 订单号 / 手机号的值维度规则，`export.ts` 补了同一批值的类别标记，`fields.ts` 的
 * `SECRET_SEGMENTS` 补齐了键名兜底。清单已清空，本表从此**全严格**：
 * 任何一格变红都是真实回归（`scripts/check-redact.mjs` 是防止规则被删的第二道门禁）。
 */
export const KNOWN_GAPS = []
