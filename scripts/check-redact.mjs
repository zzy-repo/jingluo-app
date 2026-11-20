#!/usr/bin/env node
/**
 * check-redact.mjs —— 脱敏规则集的「必填类别」门禁（Issue #387）。
 *
 * 为什么要有它：#387 的病根不是「规则写错了」，而是**规则从来就没有过** ——
 * `REDACTION_RULES` 里只有 `sk-` / `Bearer` / `token=` / 签名参数，设备码 / 卡密 / 卡号 /
 * 订单号 / 手机号一个都没有，而 `export.ts` 的 `PRIVATE_KEY` 只匹配**键名**，
 * 自由文本里的值（用户随手打在错误信息、日志正文里的那一份）三个边界全漏。
 * 这类漏洞的共同点是：**删掉一条规则不会让编译失败，也不会让任何一条别的用例变红** ——
 * 只有当有人回头把 `domain08-sensitive-fields.test.mjs` 的表也一起放宽时才看得出来。
 * 所以这里把「必填类别」写成一张清单，规则被删 / 被改窄就 exit 1。
 *
 * 判据（**行为优先，静态兜底**）：
 *   R1 必填类别：REQUIRED_CATEGORIES 里每一类都必须有探针，且探针经真实代码必须通过 ——
 *      日志 / 错误页边界（`redact()`）断言打码形态出现 + 原文不出现；
 *      导出边界（`redactExportText()`）断言类别标记出现 + 原文与尾号都不出现。
 *   R2 误伤负例：时间戳 / 雪花 ID / 普通流水号必须**原样**通过两个边界。
 *      规则写宽了（例如把 `1[3-9]\d{9}` 直接套在任意数字串上）在这里就红。
 *   R3 键名兜底：`fields.ts` 的 `SECRET_SEGMENTS` 必须含 `deviceid` / `card` / `cardno` / `phone`；
 *      `export.ts` 必须真的调用 `markSensitiveValues()`（否则值维度在导出侧被旁路）。
 *
 * 用法：
 *   node scripts/check-redact.mjs            # 门禁模式
 *   node scripts/check-redact.mjs --selftest # 负向自检：把红actor换成恒等函数必须被拦下
 *   pnpm run check:redact
 *
 * 退出码：
 *   0  干净
 *   1  发现违规（缺类别 / 误伤 / 静态口径丢失）
 *   2  用法 / 环境错误
 */
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceUrl = (relative) => pathToFileURL(path.join(ROOT, relative)).href
const sourceText = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

// 导出层（export.ts）import 了采集层（DOM + IndexedDB）：门禁只需要 `redactExportText` 这个纯函数，
// 采集层换成域 8/9 用例共用的空替身。`.js → .ts` 的映射与单测同一套规则（NodeNext 写法）。
const COLLECTOR_STUB = sourceUrl('tests/fixtures/domain08-09/collector-stub.mjs')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /(?:^|\/)collector\.js$/.test(specifier) &&
      context.parentURL?.includes('/src/services/diagnostics/')
    ) {
      return { url: COLLECTOR_STUB, shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const typescript = fileURLToPath(new URL(specifier, context.parentURL)).replace(
        /\.js$/,
        '.ts'
      )
      if (fs.existsSync(typescript)) {
        return { url: pathToFileURL(typescript).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

/** 必填类别：这是 #387 的「一张清单」，删任何一条都得先改这里（然后被 review 拦住） */
export const REQUIRED_CATEGORIES = ['device_id', 'card_key', 'card_no', 'order_token', 'phone']

/** 键名维度的兜底段（`fields.ts` 的 SECRET_SEGMENTS） */
export const REQUIRED_SECRET_SEGMENTS = ['deviceid', 'card', 'cardno', 'phone']

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const CARD_DASHED = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const CARD_DIGITS = '6222021234567890123'
const PHONE = '13812345678'

/**
 * 值维度探针：同一份原文喂两个边界。
 *   `log`    = 日志 / 错误页（`redact()`，尾 4 位）
 *   `export` = 导出（`redactExportText()`，类别标记）
 * `secrets` 是原文里不许出现的片段（打码形态必须真的把它吃掉）。
 */
const PROBES = [
  {
    category: 'device_id',
    label: '设备码（d- + 32 hex）',
    text: `bind failed device_id=${DEVICE_ID}`,
    secrets: [DEVICE_ID],
    log: ['••••cdef'],
    export: ['[DEVICE_ID]'],
  },
  {
    category: 'card_key',
    label: '卡密（4×4 横杠分组）',
    text: `兑换失败 card=${CARD_DASHED}`,
    secrets: [CARD_DASHED],
    log: ['••••A3SR'],
    export: ['[CARD]'],
  },
  {
    category: 'card_no',
    label: '卡号（19 位数字）',
    text: `支付失败 cardNo=${CARD_DIGITS}`,
    secrets: [CARD_DIGITS],
    log: ['••••0123'],
    export: ['[CARD]'],
  },
  {
    category: 'order_token',
    label: '订单 token / 商户单号',
    text: '下单失败 order_token=ORDERSECRET123 out_trade_no=OUTTRADE2026111900001',
    secrets: ['ORDERSECRET123', 'OUTTRADE2026111900001'],
    log: ['order_token=***', 'out_trade_no=***'],
    export: ['order_token=[REDACTED]', 'out_trade_no=[REDACTED]'],
  },
  {
    category: 'phone',
    label: '手机号（11 位大陆号）',
    text: `联系方式解析失败 phone=${PHONE}`,
    secrets: [PHONE],
    log: ['••••5678'],
    export: ['[PHONE]'],
  },
]

/**
 * 误伤负例：这些串里**没有**敏感字段，两个边界都必须原样放行。
 * 写在这里而不是只写进单测：规则被改宽时，单测与门禁同时红，谁都不会漏看。
 */
const FALSE_POSITIVES = [
  { label: '13 位毫秒时间戳', text: 'ts=1732051200000' },
  { label: '19 位纳秒时间戳', text: 'at=1700000000000000000' },
  { label: '19 位雪花 ID', text: 'id=1234567890123456789' },
  { label: '11 位普通流水号', text: 'orderNo=20261119001' },
]

/**
 * 门禁本体（纯函数，便于 `--selftest` 用恒等实现跑一遍）。
 * 返回字符串数组：空数组 = 干净。
 */
export const audit = ({ redact, redactExportText }) => {
  const failures = []
  const covered = new Set(PROBES.map((probe) => probe.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) {
      failures.push(`规则集缺类别 ${category}：PROBES 里没有对应探针（规则被删或类别被改名）`)
    }
  }
  for (const probe of PROBES) {
    const logged = redact(probe.text)
    const exported = redactExportText(probe.text)
    for (const secret of probe.secrets) {
      if (logged.includes(secret)) failures.push(`${probe.category} 日志边界仍在漏原文 ${secret}`)
      if (exported.includes(secret)) failures.push(`${probe.category} 导出边界仍在漏原文 ${secret}`)
    }
    for (const expected of probe.log) {
      if (!logged.includes(expected)) {
        failures.push(`${probe.category} 日志边界缺打码形态 ${expected}（实际：${logged}）`)
      }
    }
    for (const expected of probe.export) {
      if (!exported.includes(expected)) {
        failures.push(`${probe.category} 导出边界缺类别标记 ${expected}（实际：${exported}）`)
      }
    }
  }
  for (const item of FALSE_POSITIVES) {
    const logged = redact(item.text)
    const exported = redactExportText(item.text)
    if (logged !== item.text) failures.push(`误伤：${item.label} 在日志边界被改写 → ${logged}`)
    if (exported !== item.text) failures.push(`误伤：${item.label} 在导出边界被改写 → ${exported}`)
  }
  return failures
}

/** 静态口径（行为测不到的那两处：键名兜底段、导出侧的接线） */
export const auditSources = ({ fieldsSource, exportSource }) => {
  const failures = []
  for (const segment of REQUIRED_SECRET_SEGMENTS) {
    // 段名以带引号的字面量出现在 SECRET_SEGMENTS 里（用 Set 的成员写法，不是别的注释）
    if (!new RegExp(`['"]${segment}['"]`).test(fieldsSource)) {
      failures.push(`fields.ts 的 SECRET_SEGMENTS 缺段 ${segment}（键名维度兜底缺失）`)
    }
  }
  if (!/markSensitiveValues\(/.test(exportSource)) {
    failures.push('export.ts 没有调用 markSensitiveValues()：导出边界的值维度被旁路')
  }
  return failures
}

const runSelftest = async () => {
  const identity = (text) => text
  const problems = []
  const blind = audit({ redact: identity, redactExportText: identity })
  if (blind.length === 0)
    problems.push('负向对照失败：恒等「脱敏器」竟然通过了所有探针（门禁是空跑）')
  const brokenFields = sourceText('src/services/diagnostics/fields.ts').replace(/'deviceid',?/, '')
  const brokenExport = sourceText('src/services/diagnostics/export.ts').replace(
    /markSensitiveValues\(/g,
    '('
  )
  const blindSources = auditSources({ fieldsSource: brokenFields, exportSource: brokenExport })
  if (blindSources.length < 2) {
    problems.push(`负向对照失败：删掉键名段与导出接线后只报出 ${blindSources.length} 条（应 ≥ 2）`)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    return 1
  }
  console.log(
    `  ✓ 负向对照通过：恒等脱敏器被拦下 ${blind.length} 条，静态口径缺失被拦下 ${blindSources.length} 条`
  )
  return 0
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.some((arg) => arg !== '--selftest')) {
    console.error('Usage: node scripts/check-redact.mjs [--selftest]')
    return 2
  }
  let redactModule, exportModule
  try {
    redactModule = await import(sourceUrl('src/services/diagnostics/redact.ts'))
    exportModule = await import(sourceUrl('src/services/diagnostics/export.ts'))
  } catch (error) {
    console.error(`check:redact 无法加载被测源码：${error.message}`)
    return 2
  }
  const failures = [
    ...audit({ redact: redactModule.redact, redactExportText: exportModule.redactExportText }),
    ...auditSources({
      fieldsSource: sourceText('src/services/diagnostics/fields.ts'),
      exportSource: sourceText('src/services/diagnostics/export.ts'),
    }),
  ]
  if (failures.length > 0) {
    console.error(`check:redact 发现 ${failures.length} 条违规：`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    return 1
  }
  console.log(
    `  ✓ ${REQUIRED_CATEGORIES.length} 类必填规则齐备（${REQUIRED_CATEGORIES.join(' / ')}）；` +
      `${PROBES.length} 条探针 × 2 边界、${FALSE_POSITIVES.length} 条误伤负例、` +
      `${REQUIRED_SECRET_SEGMENTS.length} 个键名兜底段全部通过`
  )
  if (argv.includes('--selftest')) {
    return runSelftest()
  }
  return 0
}

process.exit(await main())
