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
// **#460 补了 N1-e**：N1-b 只断言「键没进 meta」，**没断言是哪一层拦的**。于是
// `SECRET_SEGMENTS` 里的 `deviceid` / `cardno` / `phone` 其实是**死规则**（白名单先丢，第二道
// 根本不被求值）：单删任何一条都一条不红；换成 snake_case（`device_id`）再把白名单放开，
// 就原样放行明文而本文件**全绿**。N1-e 逐行钉住「丢弃来自哪一层」，两层各留锚点。
//
//   node --test tests/unit/domain08-sensitive-fields.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

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
const { META_KEYS, sanitizeMeta } = await import('../../src/services/diagnostics/fields.ts')
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

// ---------------------------------------------------------------------------
// #460 键名维度的**组合语义**：白名单放行之后，`SECRET_SEGMENTS` 必须仍然拦住
//
// 病根（issue 已实测，本文件改造前）：
//   · 单删 `SECRET_SEGMENTS` 的 `'deviceid'` → 一条都不红，而且是**等价变异**：`deviceId` 不在
//     `EXTRA_KEYS` 里，`sanitizeMeta` 的 `isAllowedKey` 先把它丢了，第二道判断根本不会被求值
//     （`!isAllowedKey(k) || hasSecretName(k)` 短路）—— 这条规则当时是**死规则**；
//   · 换成 snake_case 就是组合变异：`EXTRA_KEYS` 收下 `device_id` + 删掉 `'deviceid'`
//     → `sanitizeMeta({ device_id: '…' })` 原样放行明文，而 N1-a…N1-d **全绿**
//     （它们只在「键恰好不在白名单」时才发现问题，说不清是哪一层拦的）。
//
// 所以本表逐行钉住「这次丢弃是**哪一层**做的」，两列缺一不可：
//   guard = 'secret-name'：键**在白名单里**（放行）→ 整条丢弃只可能来自键名兜底。
//        删段名 / 把段名改窄（丢掉分隔符归一）→ 这一列立刻红；把键从 `EXTRA_KEYS` 拿走 → 也红
//        （规则重新变成不可达，退回 #460 的原始状态）。
//   guard = 'whitelist'  ：键**不在白名单里** → 第一层丢弃。同时**禁止**它被悄悄收进白名单 ——
//        那正是组合变异的第一半：收了就必须同步让密钥段归一后命中，否则明文进日志。
//
// 值故意选**值维度脱敏规则碰不到**的形状（不是 `d-<32hex>`、不是 16–19 位数字、不是 11 位手机号），
// 这样断言看到的是**键名维度**本身，不会被 `redact()` 的值规则掩盖（见 N1-f 的自证）。
// ---------------------------------------------------------------------------

/** 键名维度的探针值：`redact()` 原样放过它（N1-f 直接断言这一点） */
const KEY_PROBE = 'plain-778899-abcdef'

const KEY_LAYER_CASES = [
  // —— 白名单放行 + 密钥段必须拦住（#460 方案 A：把这几条从「死规则」变成可达规则）——
  { id: 'C1', guard: 'secret-name', key: 'deviceId' },
  { id: 'C2', guard: 'secret-name', key: 'device_id' },
  { id: 'C3', guard: 'secret-name', key: 'cardNo' },
  { id: 'C4', guard: 'secret-name', key: 'card_no' },
  { id: 'C5', guard: 'secret-name', key: 'phone' },
  { id: 'C6', guard: 'secret-name', key: 'orderToken' },
  { id: 'C7', guard: 'secret-name', key: 'order_token' },
  // —— 白名单外：第一层丢弃；而且不许被悄悄收进白名单（收了就得先有密钥段兜住）——
  { id: 'C8', guard: 'whitelist', key: 'phoneNumber' },
  { id: 'C9', guard: 'whitelist', key: 'contactPhone' },
  { id: 'C10', guard: 'whitelist', key: 'deviceNumber' },
  { id: 'C11', guard: 'whitelist', key: 'cardNumber' },
  { id: 'C12', guard: 'whitelist', key: 'deviceFingerprint' },
  { id: 'C13', guard: 'whitelist', key: 'userPhone' },
]

/**
 * `fields.ts` 里 `EXTRA_KEYS` 的**字面量**（只认独占一行的 `'name',`：注释里提到的键名不算）。
 * 直接读源码而不加一个只给测试用的导出 —— `fields.ts` 的公开面是采集层的契约，不为测试开洞。
 */
const readExtraKeys = () => {
  const source = readFileSync(
    fileURLToPath(new URL('src/services/diagnostics/fields.ts', `file://${ROOT}`)),
    'utf8'
  )
  const block = /const EXTRA_KEYS: readonly string\[\] = \[([\s\S]*?)\n\]/.exec(source)
  assert.ok(block, 'fields.ts 里应能找到 EXTRA_KEYS 数组字面量')
  return new Set([...block[1].matchAll(/^ {2}'([^']+)',$/gm)].map((match) => match[1]))
}

test('N1-e 键名组合语义：白名单放行后密钥段仍须拦住（两层各留锚点）', () => {
  const extraKeys = readExtraKeys()
  const inWhitelist = (key) => extraKeys.has(key) || META_KEYS.includes(key)
  const failures = []
  for (const row of KEY_LAYER_CASES) {
    const meta = sanitizeMeta({ [row.key]: KEY_PROBE })
    // ② 行为：键名维度的契约是**整条丢弃**（不是「打码后保留」），原文更不许进 payload
    if (row.key in meta) {
      failures.push(`${row.id} ${row.key}：键没有被丢弃（存活值 ${JSON.stringify(meta[row.key])}）`)
    }
    if (JSON.stringify(meta).includes(KEY_PROBE)) {
      failures.push(`${row.id} ${row.key}：探针值原样进了日志`)
    }
    // ① 层次：这次丢弃必须来自表里声明的**那一层**，否则另一层就是没被覆盖到的死规则
    const actual = inWhitelist(row.key) ? 'secret-name' : 'whitelist'
    if (actual !== row.guard) {
      failures.push(
        row.guard === 'secret-name'
          ? `${row.id} ${row.key}：已不在白名单里 → SECRET_SEGMENTS 对它将再次**不可达**（#460 的等价变异），丢弃只靠第一层。要放行就把它加回 EXTRA_KEYS，并把归一后的段名写进 SECRET_SEGMENTS`
          : `${row.id} ${row.key}：被收进了白名单 → 白名单放行后必须由 SECRET_SEGMENTS 拦住，否则整条明文进日志（#460 的组合变异）。确认段名已覆盖后把本行改成 guard: 'secret-name'`
      )
    }
  }
  // 防「把表削薄」：两层各自至少留几行锚点，删行凑绿会在这里红
  const byGuard = (guard) => KEY_LAYER_CASES.filter((row) => row.guard === guard)
  if (byGuard('secret-name').length < 7) {
    failures.push(
      `secret-name 行只有 ${byGuard('secret-name').length} 行（应 ≥ 7）：第二层失去锚点，键名兜底又会退回不可达的死规则`
    )
  }
  if (byGuard('whitelist').length < 5) {
    failures.push(
      `whitelist 行只有 ${byGuard('whitelist').length} 行（应 ≥ 5）：第一层（白名单）的覆盖被削`
    )
  }
  console.log(
    `  ·  键名层次：${KEY_LAYER_CASES.length} 行（secret-name ${byGuard('secret-name').length} / whitelist ${byGuard('whitelist').length}），失败 ${failures.length} 条`
  )
  assert.deepEqual(failures, [], '键名维度必须两层都可生效：白名单放行后密钥段仍要拦住')
})

test('N1-f 探针自证：N1-e 的探针值确实是值维度碰不到的形状', () => {
  // 若将来有人把这行改红成「用会被 redact() 打码的值」，N1-e 就退化成「值维度在兜底」，
  // 键名维度的组合变异会重新隐身。所以探针本身也要钉住：redact() 必须原样放过它。
  assert.equal(redact(KEY_PROBE), KEY_PROBE, 'N1-e 的探针值必须不被值维度改写')
  assert.equal(
    redactExportText(KEY_PROBE),
    KEY_PROBE,
    'N1-e 的探针值必须不被导出层的值维度改写'
  )
})
