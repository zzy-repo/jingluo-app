#!/usr/bin/env node
/**
 * i18n 编译期门禁（Issue #314）。
 *
 * `src/i18n/en.ts` 的 `satisfies Record<keyof typeof zh, string>` 已经挡住了「zh 有、en 没」，
 * 但 tsc 看不见下面这几类（这正是本脚本的增量价值）：
 *
 *   R1 key 集合相等        —— 双向齐平，并把差异列成人话（tsc 的 TS2741 只报类型，不报清单）
 *   R2 占位符对齐          —— 同一 key 的 `{name}` 集合必须一致；`{count}` / `{total}` 错位不会报错，
 *                             界面直接把「共 {total} 笔」端给用户，和缺 key 是同一类病
 *   R3 代码引用的 key 存在 —— `t('...')` / `translate('...')` 里的字面量必须真的在 zh 里
 *                             （类型系统只在字面量位置生效，动态拼出来的 key 它管不到）
 *   R4 无孤立 key          —— 定义了但 src/** 里没人引用；存量死 key 登记在 ORPHAN_BASELINE，
 *                             **只许减不许增**（新增孤立 key 即失败）
 *   R5 空值 / 纯空白       —— 空文案会让界面出现「有块地方是空的」，比缺 key 更难查
 *
 * 刻意不 import 任何 .ts：脚本要能被 CI 单独跑，不依赖打包器 / ts 运行时。
 * 解析只认 zh.ts / en.ts 的「顶层 key: '字符串'」形态（含跨行字符串），不写完整 TS 解析器。
 *
 *   node scripts/check-i18n.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ZH_FILE = 'src/i18n/zh.ts'
const EN_FILE = 'src/i18n/en.ts'
const I18N_DIR = path.join(ROOT, 'src/i18n')

/**
 * R4 基线：当前 main 上「已定义、但 src/** 里没有引用」的存量 key。
 *
 * 本单（#314）只允许往 zh/en 追加自己的 key，不删别人的文案，所以存量先登记在这里；
 * 它们各自的清理归对应单子。**新增孤立 key 会直接失败**；基线里的 key 一旦被引用，
 * 脚本会提示把它从基线删掉（登记簿只能减，和 `check-log-coverage` 的 metaDebt 同一套规矩）。
 */
const ORPHAN_BASELINE = new Set([
  'apiKeyStart',
  'compatBootFooter',
  'compatBootHowTo',
  'compatBootLead',
  'compatBootMissing',
  'compatBootRuntimeError',
  'compatBootTimeout',
  'compatBootTitle',
  'compatBootVersion',
  'compatBootVersionUnknown',
  'completionServerBusyToast',
  'historyImportUrlRestarted',
  'historyImportUrlResumed',
  'settingsLocation',
  'settingsLocationCity',
  'settingsLocationProvince',
  'settingsLocationRegion',
  // W1-B 后半（#487）：额度改为读 sub2api（`consumeBalance`，单位元：1 元 = 1 额度，无 USD），设置页那一格不再用积分口径的
  // 显示模板；但 tests/unit（format-points-i18n / ours-api）仍断言它的文案，所以先把 key 留着、
  // 在基线里登记为「已不引用」。随旧额度链一起清理（W1-C 重写额度 UI / W1-D 删旧账本）。
  'oursQuotaValue',
  // 重构中，UI 落地后移除（#487 铺路）：登录注册 / 账户与消费 / 卡密兑换 / 邀请 / 邮箱绑定
  // 四条链路的词条骨架。这批 key 的引用方由 #487 的 UI 线接入，接入一个就从这里删一个（基线只许减）。
  // `inviteCode` 不在此列：它已经是既有代码里的字段名（src/services/invite/**），R4 视为已引用。
  // `consumeBalance` 已由 W1-B 后半接入设置页额度格（`OursServicesDialog` 里 `t('consumeBalance', …)`），
  // 金额口径由 W1-A 的 `utils/money.ts` 负责（1 元 = 1 额度，无 USD），故从基线删掉。
  'consumeBalanceApprox',
  'consumeKeyExpiresAt',
  'consumeRedeemBusy',
  'consumeRedeemCodeInvalid',
  'consumeRedeemCodeUsed',
  'consumeRedeemConfirming',
  'consumeRedeemFailed',
  'consumeRedeemPlaceholder',
  'consumeRedeemSuccess',
  'consumeRedeemTitle',
  'consumeUsageMonth',
  'consumeUsageToday',
  'emailBindFailed',
  'inviteCodeInvalid',
  'inviteDisabled',
  // #487 W1-C1（三弹层合一）：设置页三格入口（付款记录 / 我的购买 / 时间线）并成一格之后，
  // 下面这几条入口文案失去了唯一引用点。旧弹层文件本身还没删（归 W1-D），先按「登记、只许减」躺在这里；
  // W1-D 删旧弹层时连带把这几条从基线删掉。
  'oursPayRecordsEntryDescription',
  'oursPurchasesEntryAction',
  'oursPurchasesEntryDescription',
  'oursTrailEntry',
  'oursTrailEntryDescription',
  'sub2authConfirmPassword',
  'sub2authCredentialInvalid',
  'sub2authForgotPassword',
  'sub2authLogin',
  'sub2authLoginFailed',
  'sub2authNetworkError',
  'sub2authPassword',
  'sub2authRegister',
  'sub2authRegisterSuccess',
  'sub2authSendCode',
  'sub2authSwitchAccount',
  'sub2authTwoFactorHint',
])

const failures = []
const notes = []
/** @type {string[]} */
const fail = (rule, message) => failures.push(`[${rule}] ${message}`)

// ------------------------------------------------------------------ 解析
/**
 * 从 `export const <name> = { ... }` 里解析「顶层 key → 字符串值」。
 * 支持单/双引号与跨行字符串；值不是字符串字面量时记为 null（交给 R5 报）。
 *
 * @returns {{ table: Map<string, string | null>, duplicated: string[], broken: string[] }}
 */
const parseTable = (relFile, name) => {
  const source = fs.readFileSync(path.join(ROOT, relFile), 'utf8')
  const marker = `export const ${name} = {`
  const start = source.indexOf(marker)
  if (start < 0) {
    throw new Error(`${relFile}：找不到 \`${marker}\``)
  }
  const table = new Map()
  const duplicated = []
  const broken = []
  const isSpace = (char) => char === ' ' || char === '\n' || char === '\r' || char === '\t'
  let index = start + marker.length
  const skipTrivia = () => {
    for (;;) {
      while (index < source.length && (isSpace(source[index]) || source[index] === ',')) {
        index += 1
      }
      // 条目之间允许注释（本仓在 zh.ts 里用 /* ... */ 标注分组）
      if (source.startsWith('//', index)) {
        const end = source.indexOf('\n', index)
        index = end < 0 ? source.length : end + 1
        continue
      }
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2)
        index = end < 0 ? source.length : end + 2
        continue
      }
      return
    }
  }
  while (index < source.length) {
    skipTrivia()
    if (source[index] === '}') {
      break
    }
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))
    if (keyMatch === null) {
      broken.push(`${relFile}：偏移 ${index} 处读不出 key（不是「key: '文案'」的形态）`)
      break
    }
    const key = keyMatch[0]
    index += key.length
    while (index < source.length && isSpace(source[index])) {
      index += 1
    }
    if (source[index] !== ':') {
      broken.push(`${relFile}：key \`${key}\` 后面不是冒号`)
      break
    }
    index += 1
    while (index < source.length && isSpace(source[index])) {
      index += 1
    }
    const quote = source[index]
    if (quote !== "'" && quote !== '"') {
      // 不是字符串字面量：值为 null，R5 会报「不是非空字符串」
      table.set(key, null)
      // 跳过这个值，直到行尾逗号 / 下一个顶层 key；这类写法在本仓不存在，保守起见直接停
      broken.push(`${relFile}：key \`${key}\` 的值不是字符串字面量`)
      break
    }
    index += 1
    let value = ''
    let closed = false
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        const next = source[index + 1] ?? ''
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        index += 2
        continue
      }
      if (char === quote) {
        index += 1
        closed = true
        break
      }
      value += char
      index += 1
    }
    if (!closed) {
      broken.push(`${relFile}：key \`${key}\` 的字符串没有闭合`)
      break
    }
    if (table.has(key)) {
      duplicated.push(key)
    }
    table.set(key, value)
  }
  return { table, duplicated, broken }
}

const zh = parseTable(ZH_FILE, 'zh')
const en = parseTable(EN_FILE, 'en')

for (const message of [...zh.broken, ...en.broken]) {
  fail('解析', message)
}
for (const [file, parsed] of [
  [ZH_FILE, zh],
  [EN_FILE, en],
]) {
  for (const key of parsed.duplicated) {
    fail('R1', `${file} 里 key \`${key}\` 重复定义（后面的会覆盖前面的）`)
  }
}

// ------------------------------------------------------------------ R1 key 集合相等
const onlyInZh = [...zh.table.keys()].filter((key) => !en.table.has(key))
const onlyInEn = [...en.table.keys()].filter((key) => !zh.table.has(key))
for (const key of onlyInZh) {
  fail('R1', `\`${key}\` 只在 zh 里，en 缺`)
}
for (const key of onlyInEn) {
  fail('R1', `\`${key}\` 只在 en 里，zh 缺`)
}

// ------------------------------------------------------------------ R2 占位符对齐
const PLACEHOLDER = /\{(\w+)\}/g
const placeholders = (value) => {
  if (typeof value !== 'string') {
    return ''
  }
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]))].sort().join(', ')
}
for (const [key, zhValue] of zh.table) {
  if (!en.table.has(key)) {
    continue
  }
  const zhPlaceholders = placeholders(zhValue)
  const enPlaceholders = placeholders(en.table.get(key))
  if (zhPlaceholders !== enPlaceholders) {
    fail(
      'R2',
      `\`${key}\` 占位符不一致：zh(${zhPlaceholders || '无'}) vs en(${enPlaceholders || '无'})`
    )
  }
}

// ------------------------------------------------------------------ R3/R4 代码引用
const walk = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (full === I18N_DIR) {
        continue
      }
      out.push(...walk(full))
      continue
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const codeFiles = walk(path.join(ROOT, 'src'))
const toRel = (full) => path.relative(ROOT, full).split(path.sep).join('/')

/** 从 `(` 开始按括号配平取出实参文本（字符串 / 模板里的括号不计数） */
const readCallArgs = (source, openIndex) => {
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        return { text: source.slice(openIndex + 1, index), end: index }
      }
    }
  }
  return { text: source.slice(openIndex + 1), end: source.length }
}

/** 一行里第 index 个字符的行号（1 基），报错用 */
const lineOf = (source, index) => {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') {
      line += 1
    }
  }
  return line
}

const CALL = /(^|[^\w$.])(t|translate)\s*\(/g
/** `x === 'done'` 这类状态字面量不是 key：比较运算符两侧的字面量一律不算引用 */
const COMPARISON_BEFORE = /(?:===|!==|==|!=)\s*$/
const COMPARISON_AFTER = /^\s*(?:===|!==|==|!=)/
const LITERAL = /'([^'\\]*)'|"([^"\\]*)"/g

const referencedKeys = new Set()
const dynamicCallFiles = new Set()

for (const full of codeFiles) {
  const source = fs.readFileSync(full, 'utf8')
  for (const call of source.matchAll(CALL)) {
    const openIndex = call.index + call[0].length - 1
    const { text } = readCallArgs(source, openIndex)
    if (text.includes('`')) {
      dynamicCallFiles.add(toRel(full))
    }
    for (const literal of text.matchAll(LITERAL)) {
      const value = literal[1] ?? literal[2] ?? ''
      const at = openIndex + 1 + literal.index
      const before = source.slice(Math.max(0, at - 16), at)
      const after = source.slice(at + literal[0].length, at + literal[0].length + 16)
      if (COMPARISON_BEFORE.test(before) || COMPARISON_AFTER.test(after)) {
        continue
      }
      referencedKeys.add(value)
      if (!zh.table.has(value) && /^[A-Za-z_$][\w$]*$/.test(value)) {
        fail('R3', `${toRel(full)}:${lineOf(source, at)} 引用了不存在的 key \`${value}\``)
      }
    }
  }
}

// ------------------------------------------------------------------ R4 孤立 key
/** 全量引用语料：引号里的字面量 + `zh.xxx` / `en.xxx` 形式的属性访问 */
const quotedLiterals = new Set()
const propertyNames = new Set()
for (const full of codeFiles) {
  const source = fs.readFileSync(full, 'utf8')
  for (const match of source.matchAll(/(['"`])([A-Za-z_$][\w$]*)\1/g)) {
    quotedLiterals.add(match[2])
  }
  for (const match of source.matchAll(/\.([A-Za-z_$][\w$]*)\b/g)) {
    propertyNames.add(match[1])
  }
}

const orphans = [...zh.table.keys()].filter(
  (key) => !quotedLiterals.has(key) && !propertyNames.has(key)
)
const orphanSet = new Set(orphans)
for (const key of orphans) {
  if (!ORPHAN_BASELINE.has(key)) {
    fail('R4', `\`${key}\` 定义了但 src/** 里没人引用（新增孤立 key）`)
  }
}
for (const key of ORPHAN_BASELINE) {
  if (!orphanSet.has(key)) {
    notes.push(`ℹ R4 基线可减：\`${key}\` 已经被引用了，从 ORPHAN_BASELINE 删掉它`)
  }
}

// ------------------------------------------------------------------ R5 空值 / 纯空白
for (const [file, parsed] of [
  [ZH_FILE, zh],
  [EN_FILE, en],
]) {
  for (const [key, value] of parsed.table) {
    if (typeof value !== 'string') {
      fail('R5', `${file} 的 \`${key}\` 不是字符串字面量`)
      continue
    }
    if (value.trim() === '') {
      fail('R5', `${file} 的 \`${key}\` 是空值 / 纯空白`)
    }
  }
}

// ------------------------------------------------------------------ 输出
for (const note of notes) {
  console.log(note)
}
if (dynamicCallFiles.size > 0) {
  console.log(
    `ℹ R3 有 ${dynamicCallFiles.size} 个文件在 t()/translate() 里用了模板字符串，动态 key 无法静态校验（已知边界）`
  )
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`✗ ${message}`)
  }
  console.error(
    `\ni18n 门禁失败：zh ${zh.table.size} / en ${en.table.size} keys，failures: ${failures.length}`
  )
  process.exit(1)
}

console.log(
  `R1 key 集合：zh ${zh.table.size} / en ${en.table.size} ✓  ` +
    `R2 占位符对齐 ✓  R3 代码引用 ${referencedKeys.size} 个 key 全部存在 ✓  ` +
    `R4 孤立 key：0 个新增（基线 ${orphans.length} 个存量）✓  R5 无空值 ✓`
)
console.log(`i18n OK：${zh.table.size}/${en.table.size} keys，failures: 0`)
