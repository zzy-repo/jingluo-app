// [layer: unit | 纯 Node，零浏览器，不发网络请求 | 耗时: <1s]
//
// N1 敏感字段矩阵（域 8 · 反馈与诊断）—— #362 / #367
//
// 覆盖功能点：F8-11（`sk-` / `Bearer` / `token=` / `Signature=` / `AccessKeyId=` / 完整 URL 的脱敏）
// 与 F8-12（设备码 / 卡密 / 卡号 / 订单号 / 手机号**绝不原样进**日志、导出、错误页）。
//
// 为什么要这张表：现状对这 8 类只有「键名过滤」与「console 静默」两条**间接**证据，
// 没有任何一条断言过「一次真实的购买记录 + 设备码操作之后，日志 payload / 导出文件里没有原文」。
// 本表把同一份输入喂给三个边界，逐格断言「原文不出现 + 打码形态出现」：
//   ① 日志：采集层 `sanitizeMeta()`（`record()` 里唯一的清洗入口）
//   ② 导出：`redactExportText()` 与**整份导出文件** `buildFeedbackExport()` 的文本
//   ③ 错误页：`scrubReportText()` 与**整份报告** `buildErrorReport()` 的文本
//
// 历史：#383 落地时 V6–V10 五行（设备码 / 卡密 / 卡号 / 订单号 / 手机号）在三个边界上全部泄漏，
// 15 格登记在 `tests/fixtures/domain08-09/sensitive-cases.mjs` 的 `KNOWN_GAPS` 里（与
// `scripts/check-log-coverage.mjs` 的 knownGaps 同口径）。
//
// **#387 已修**：规则补齐后 15 格全绿，`KNOWN_GAPS` 已清空 —— 本表从此**全严格**：
//   - 任何一格变红 → **本用例失败**（真实泄漏，不许再登记回 KNOWN_GAPS 绕过）；
//   - 登记簿留残条目 → 失败（表示修复没跟上登记）。
//
//   node --test tests/unit/domain08-sensitive-fields.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const collectorStub = new URL('../fixtures/domain08-09/collector-stub.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    // 导出层只用到 `redactExportText` / `buildFeedbackExport`：采集层（DOM + IndexedDB）换成空替身，
    // 保证本用例零浏览器依赖（导出边界不读快照，读快照的行为在 feedback-export.test.mjs 里钉）
    if (
      /(?:^|\.\/)collector\.js$/.test(specifier) &&
      context.parentURL?.includes('/src/services/diagnostics/')
    ) {
      return { url: collectorStub, shortCircuit: true }
    }
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

const { redact } = await import('../../src/services/diagnostics/redact.ts')
const { sanitizeMeta } = await import('../../src/services/diagnostics/fields.ts')
const { buildFeedbackExport, redactExportText } = await import('../../src/services/diagnostics/export.ts')
const { buildErrorReport, scrubReportText } = await import('../../src/app/errorReport.ts')
const { BOUNDARIES, KEY_CASES, KNOWN_GAPS, VALUE_CASES } = await import(
  '../fixtures/domain08-09/sensitive-cases.mjs'
)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 导出层的入参快照：只需要能装下一条 msg 的最小形状 */
const snapshotWith = (text) => ({
  schemaVersion: 1,
  app: { version: '1.4.0-beta.10', versionCode: 17, platform: 'android', buildType: 'standard' },
  device: {},
  client: { clientId: 'c-test', sessionId: 's-test' },
  logs: [{ t: 1, kind: 'error', level: 'error', msg: text }],
})
const EXPORT_CONTEXT = { category: 'bug' }

/**
 * 每个边界给出「主断言文本」+「全部需要检查的文本」：
 * 主断言文本判「打码形态出现了没有」，全部文本判「原文 / 额外禁止片段漏没漏」。
 */
const BOUNDARY_PROBES = {
  log: (text) => {
    const meta = sanitizeMeta({ detail: text })
    const value = typeof meta.detail === 'string' ? meta.detail : ''
    return { primary: value, all: [value] }
  },
  export: (text) => {
    const file = buildFeedbackExport(snapshotWith(text), EXPORT_CONTEXT, {
      now: new Date('2026-11-19T00:00:00Z'),
    })
    return { primary: redactExportText(text), all: [redactExportText(text), file.text] }
  },
  error: (text) => {
    const report = buildErrorReport({
      error: new Error(text),
      version: '1.4.0-beta.10',
      stage: 'ErrorBoundary',
      at: Date.UTC(2026, 10, 19),
    })
    return { primary: scrubReportText(text), all: [scrubReportText(text), report] }
  },
}

const BOUNDARY_LABEL = {
  log: '日志（sanitizeMeta）',
  export: '导出（redactExportText + 整份文件）',
  error: '错误页（scrubReportText + 整份报告）',
}

/** 跑一个单元格：返回未通过的断言说明（空数组 = 这一格通过） */
const probeCell = (row, boundary) => {
  const spec = row.expect[boundary]
  const { primary, all } = BOUNDARY_PROBES[boundary](row.text)
  const failures = []
  const check = (condition, message) => {
    if (!condition) failures.push(message)
  }
  for (const secret of row.secrets) {
    check(!primary.includes(secret), `原文 "${secret}" 出现在${BOUNDARY_LABEL[boundary]}里`)
    for (const text of all) {
      check(!text.includes(secret), `原文 "${secret}" 出现在整份产物里`)
    }
  }
  for (const fragment of spec.excludes ?? []) {
    for (const text of all) {
      check(!text.includes(fragment), `不该保留的片段 "${fragment}" 还在`)
    }
  }
  for (const mask of spec.includes ?? []) {
    check(primary.includes(mask), `缺少期望的打码形态 "${mask}"（实际：${JSON.stringify(primary)}）`)
  }
  return failures
}

const cellKey = (cell) => `${cell.row}/${cell.boundary}`

test('N1-a 值维度：一张表 × 三个边界（日志 / 导出 / 错误页）', () => {
  const cells = []
  for (const row of VALUE_CASES) {
    for (const boundary of BOUNDARIES) {
      cells.push({ row: row.id, fn: row.fn, label: row.label, boundary, failures: probeCell(row, boundary) })
    }
  }

  const known = new Set(KNOWN_GAPS.map((gap) => `${gap.row}/${gap.boundary}`))
  const red = cells.filter((cell) => cell.failures.length > 0)
  const unexpectedRed = red.filter((cell) => !known.has(cellKey(cell)))
  const unexpectedGreen = cells.filter((cell) => cell.failures.length === 0 && known.has(cellKey(cell)))
  const staleGaps = KNOWN_GAPS.filter(
    (gap) => !cells.some((cell) => cellKey(cell) === `${gap.row}/${gap.boundary}`)
  )

  // 证据：现状红哪几格，逐格打出来（CI 日志即回执）
  for (const cell of red) {
    const tag = known.has(cellKey(cell)) ? '已知缺口（已登记 #367）' : '**未登记**'
    console.log(`  RED  ${cell.row} ${cell.fn} ${cell.label} · ${BOUNDARY_LABEL[cell.boundary]} → ${tag}`)
    for (const failure of cell.failures) console.log(`       - ${failure}`)
  }
  const redRows = [...new Set(red.map((cell) => cell.row))]
  console.log(
    `  ·  值维度：${VALUE_CASES.length} 行 × ${BOUNDARIES.length} 边界 = ${cells.length} 格，` +
      `现状红 ${red.length} 格 / ${redRows.length} 行（${redRows.join(', ')}）`
  )

  assert.deepEqual(
    unexpectedRed.map((cell) => ({ cell: cellKey(cell), failures: cell.failures })),
    [],
    '出现**未登记**的泄漏：这是真实回归，必须修规则或把新缺口登记进 KNOWN_GAPS'
  )
  assert.deepEqual(
    unexpectedGreen.map(cellKey),
    [],
    '已登记的缺口意外变绿 = 已经修好了：请把对应行从 KNOWN_GAPS 删掉（自动转严格）'
  )
  assert.deepEqual(staleGaps.map((gap) => `${gap.row}/${gap.boundary}`), [], 'KNOWN_GAPS 里有表外条目')
  // 口径硬断言（#387 已翻面）：五类账号/资损相关字段必须**全绿**。
  // 修之前这条钉的是「现状红 5 行」，现在是「一行都不许红」——少一行绿就说明规则被删了。
  assert.deepEqual(
    redRows.sort(),
    [],
    '设备码 / 卡密 / 卡号 / 订单号 / 手机号五类必须全绿（#387）；变红即真实泄漏'
  )
})

test('N1-b 键维度：敏感键整条丢弃（日志 + 导出）', () => {
  const failures = []
  for (const row of KEY_CASES) {
    const meta = sanitizeMeta({ [row.key]: row.secret })
    if (row.key in meta) failures.push(`${row.id} ${row.key}：键没有被丢弃`)
    if (JSON.stringify(meta).includes(row.secret)) failures.push(`${row.id} ${row.key}：值原样进了日志`)

    const file = buildFeedbackExport(
      {
        ...snapshotWith('meta probe'),
        logs: [{ t: 1, kind: 'config_change', level: 'info', msg: 'meta probe', meta: { [row.key]: row.secret } }],
      },
      EXPORT_CONTEXT,
      { now: new Date('2026-11-19T00:00:00Z') }
    )
    if (file.text.includes(row.secret)) failures.push(`${row.id} ${row.key}：值原样进了导出文件`)
    const exportedMeta = JSON.parse(file.text).logs[0].meta ?? {}
    if (row.key in exportedMeta) failures.push(`${row.id} ${row.key}：键没有被导出层过滤掉`)
  }
  console.log(`  ·  键维度：${KEY_CASES.length} 行 × 2 边界（日志 / 导出），失败 ${failures.length} 条`)
  assert.deepEqual(failures, [], '敏感键名必须整条丢弃（与 apiKey / token 同级）')
})

test('N1-c 错误页边界对键维度不适用：状态摘要键集合不含敏感键', () => {
  // 错误页没有 meta 层：报告里的「状态:」行由 ErrorBoundary 的白名单键拼装，不可能带上
  // deviceId / cardNo / phone。这条静态断言把「第三个边界为什么只覆盖值维度」写死。
  const source = readFileSync(fileURLToPath(new URL('src/app/ErrorBoundary.tsx', `file://${ROOT}`)), 'utf8')
  const factsBlock = /const readFacts = \(\)[\s\S]*?\n\}/.exec(source)
  assert.ok(factsBlock, 'ErrorBoundary 里应能找到状态摘要的构造块')
  const keys = [...factsBlock[0].matchAll(/^\s{6}([A-Za-z]+):/gm)].map((match) => match[1])
  assert.ok(keys.length >= 8, `状态摘要键应至少 8 个，实际 ${keys.length}`)
  const forbidden = ['deviceId', 'device', 'cardNo', 'cardNumber', 'card', 'phone', 'contact', 'apiKey', 'token']
  for (const key of keys) {
    assert.ok(!forbidden.includes(key), `错误页状态摘要里出现了敏感键 ${key}`)
  }
})

test('N1-d 抽取的规则是既有实现（不是本用例自造的期望）', () => {
  // 打码形态必须来自生产代码，否则「期望」变成测试自己的发明：
  // - `sk-***` / `Bearer ***` / `token=***` 由 redact.ts 的 REDACTION_RULES 产出
  // - 尾 4 位的口径由 src/services/ours/mask.ts 的 maskCard / maskDeviceId 定义
  const redactSource = readFileSync(fileURLToPath(new URL('src/services/diagnostics/redact.ts', `file://${ROOT}`)), 'utf8')
  for (const rule of ['sk-***', 'Bearer ***', 'Signature=***', 'AccessKeyId=***', 'token=***']) {
    assert.ok(redactSource.includes(rule), `redact.ts 应产出 ${rule}`)
  }
  const maskSource = readFileSync(fileURLToPath(new URL('src/services/ours/mask.ts', `file://${ROOT}`)), 'utf8')
  assert.match(maskSource, /maskCard[\s\S]*maskTail\(cardNo, 4\)/, '卡密只留尾 4 位')
  assert.match(maskSource, /maskDeviceId[\s\S]*maskTail\(deviceId, 4\)/, '设备码只留尾 4 位')
  assert.equal(redact('sk-abcdefghijklmnopqrstuvwxyz012345'), 'sk-***', '规则本体可直接调用')
})
