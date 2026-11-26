#!/usr/bin/env node
/**
 * check-bare-const.mjs —— **策略表之外不许再写一个超时 / 重试的裸常量**（母单 #894，子单 #896）。
 *
 * ## 一句话事故
 *
 * 因为曾经有人在 `chat/streamBreakout.ts` 里自己写了 `STREAM_BREAK_RETRY_LIMIT = 5`，
 * 而同一类请求（`stream`）的重试上限在 `net/requestPolicy.ts` 的策略表里写的是 `2`，
 * 两处都能编译、都能跑，**改一处是否生效取决于"谁问哪个问题"** —— 结果用户看到的
 * 「断流后到底还试几次」在两条链路上是两个答案，而且没有任何门禁会红。
 *
 * ## 证据（可复现，不靠记忆）
 *
 *   git show 92770fad:src/services/chat/streamBreakout.ts | grep -n 'RETRY_LIMIT\|BUDGET_MS'
 *     → 101: export const STREAM_BREAK_RETRY_LIMIT = 5
 *     → 104: export const STREAM_BREAK_PARTIAL_RETRY_LIMIT = 1
 *     → 107: 断流重试的总时长预算（60s）
 *   同一提交的 `src/services/net/requestPolicy.ts`（策略表）里，`stream.retry` 取的是
 *   `LIMITS.streamRetryLimit`（= 2）。两个数说的都是「断流后自动再发几次」，一个是 5、一个是 2。
 *
 * ## 为什么现有门禁防不住（点名最接近的那道）
 *
 * `check:limits`（`scripts/check-limits.mjs`）是唯一在管「阈值不许散落」的门禁，它有两处不覆盖：
 *
 *  1. **扫描面是手写清单 `WATCHED`**（`src/services/api/client.ts`、`chat/store.ts` 等），
 *     而 #896 迁移的 `chat/streamBreakout.ts` / `api/managedKey.ts` / `ours/purchases.ts`
 *     三个文件**从来不在名单里** —— 不在名单 = 不扫 = 写什么都不红。
 *  2. 就算把文件加进去也没用：它的判据是「**4 位以上**数字」。`retry: 5` / `retry: 2` /
 *     `dedupeRetry: 1` 这类一位数是它**永远看不见**的形态，而那正是本题的事故形态。
 *
 * ## 判据（本脚本守什么）
 *
 * 在**窄口径**扫描面（见 `SCOPE_DIRS` / `SCOPE_FILES`）里，`const|let|var NAME = <整数字面量>`
 * 即命中，且数值**≥ 1**（`for (let attempt = 1; …)` 的循环初值不算——那是计数器起点，不是策略）。
 *
 * **只判声明形态**，不判对象属性 `{ attempt: 1 }`：那是**诊断元数据**（`buildMeta({ attempt: 1 })`
 * 记录「这是第 1 次尝试」进日志），与策略无关；实测按属性判会误伤 `urlImport.ts` 的两处日志字段。
 * 一条判据把「日志字段」和「策略常量」混在一起，人就学会绕过它 —— 宁可窄，不可误伤。
 * 代价写在「边界」里：第二张策略表如果写成 `const TABLE = { retry: 5 }`，本门禁看不见
 * （`TABLE` 不是策略名，`5` 不是声明值）。这属于 review 的判断，不是机械判据的活。
 *
 * `NAME` 命中策略词才算：`retry / retries / attempt / attempts / backoff / delay(s) / timeout /
 * stall / idle / firstByte / budget / interval`，或以 `Ms` / `_MS` 结尾（时间量）。
 * **数值 0 一律放行** —— 表里 `0` 的语义是「这一类没有这一段」，不是「0 毫秒」。
 *
 * 两条不受判的例外，都必须写在这里（不是散在代码注释里）：
 *
 *  - `POLICY_TABLE`：**策略表本体**。`net/requestPolicy.ts` 就是那个唯一来源，它的
 *    `dedupeRetry: 1` / `BACKOFF_FACTOR = 2` 是表语义，正是本门禁要大家去读的那一行。
 *  - `ALLOW`：逐条登记的、**不是请求级策略**的数字，每条带原因 + 承接单，且**按次数核对**
 *    （登记了却没出现 → 判红，逼着收口的人回来删条目，见台账 §5 X1）。
 *
 * ## 范围（有意只扫这一小块）
 *
 * `src/services/net/**` + #896 本轮迁移的 4 个文件。**扩到全 `src/**` 不由这道门禁负责**，
 * 归 #903（清偿 44 处裸超时 / 重试常量时一起扩）—— 先窄口径接线，再扩围，避免把一道
 * 「今天恒红」的门禁接进 CI（台账 §3.2 第 3 条：先全绿再接线）。
 *
 * ## 边界（这道门禁**不**管什么）
 *
 *  - 不管业务阈值（条数 / 字节 / 附件大小）—— 那是 `check:limits` 与 `LIMITS` 的地盘；
 *  - 不管「值选得对不对」—— 只判「这个数是不是写在策略表外面」；
 *  - 认得的是**声明形态**。`if (attempt < 3)` 这种写在表达式里的比较不在判据内：
 *    把它也判掉需要解析语义，而语义判据的误伤率会让人学会绕过，不如只守声明。
 *
 * 用法：
 *   node scripts/check-bare-const.mjs
 *   pnpm run check:bare-const
 *   node scripts/check-bare-const.mjs --selftest   # 负向对照四拍（临时目录，不碰本仓）
 *
 * 退出码：
 *   0  干净
 *   1  发现策略表之外的裸常量（逐条打印 `文件:行: 名字 = 值`）/ 豁免账不平
 *   2  用法或环境错误（扫描面里的文件不存在 —— fail-closed，不当绿）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根。`CHECK_BARE_CONST_ROOT` 只给 `--selftest` 用（它在临时目录上跑），
 * 是测试注入口、不是运行开关。
 */
const ROOT = path.resolve(
  process.env.CHECK_BARE_CONST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
)

/** 窄口径扫描面：#896 的单一策略源所在目录 + 本轮迁移的 4 个判定文件 */
const SCOPE_DIRS = ['src/services/net']
const SCOPE_FILES = [
  'src/services/chat/streamBreakout.ts',
  'src/services/api/managedKey.ts',
  'src/services/ours/purchases.ts',
  'src/services/chat/history/urlImport.ts',
]

/** 策略表本体：这是唯一允许写策略数字的地方，不判（见文件头「判据」） */
const POLICY_TABLE = ['src/services/net/requestPolicy.ts']

/**
 * 不是请求级策略、但也叫「retry / ms」的数字：逐条登记，按**出现次数**核对。
 * 每条必须带 `reason`（为什么它不是策略）与 `followUp`（谁来收口）；收口后条目必须删，
 * 否则脚本报「豁免登记 N 次，实际 0 次」。
 */
export const ALLOW = [
  {
    file: 'src/services/chat/history/urlImport.ts',
    name: 'CHUNK_RETRIES',
    value: 1,
    count: 1,
    reason: '分块下载的单块重试次数：与请求级策略无关（不改 HTTP 请求的重发上限）',
    followUp: '#903',
  },
  {
    file: 'src/services/chat/history/urlImport.ts',
    name: 'CHUNK_TARGET_MS',
    value: 1200,
    count: 1,
    reason: '自适应块大小的目标耗时：分块传输的机械参数，不是超时阈值',
    followUp: '#903',
  },
]

/** 名字里出现这些词（不区分大小写）就算「策略词」 */
const STRATEGY_WORDS = [
  'retry',
  'retries',
  'attempt',
  'attempts',
  'backoff',
  'delay',
  'delays',
  'timeout',
  'stall',
  'idle',
  'firstbyte',
  'budget',
  'interval',
]

/** 名字以时间单位结尾也算（`CHUNK_TARGET_MS` / `CHUNK_TARGET_MS`）；`items` 不命中，故区分大小写 */
const TIME_SUFFIX = /(Ms|_MS|MS)$/

const isStrategyName = (name) => {
  if (TIME_SUFFIX.test(name)) {
    return true
  }
  const flat = name.toLowerCase().replace(/[_-]/g, '')
  return STRATEGY_WORDS.some((word) => flat.includes(word))
}

/**
 * 抹掉注释与字符串 / 模板字面量，只留代码里的数字。
 *
 * **故意不 import `scripts/lib/*`**：负向对照要把本脚本单独拷进临时目录跑
 * （同 `check-limits.mjs` 的先例），多一个 import 就多一个会被拷漏的文件 ——
 * 门禁自己先挂掉，对照就变成「红得对，但原因不是注入」。
 */
const maskSource = (text) => {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === quote) {
          i += 1
          break
        }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (text[i] === '{') depth += 1
            else if (text[i] === '}') depth -= 1
            i += 1
          }
          continue
        }
        if (text[i] === '\n') out += '\n'
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** `const NAME = 数字` / `let NAME = 数字`（`for (…)` 的循环初值不算；对象属性不算，见文件头「判据」） */
const DECL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(\d[\d_]*)\s*(?:$|[;\n])/g

/** 行号：按匹配位置之前的换行数算 */
const lineOf = (masked, index) => masked.slice(0, index).split('\n').length

/** 是不是 `for (let attempt = 1; …)` 里的初值（计数器起点不是策略） */
const insideForInit = (masked, index) => /for\s*\(\s*$/.test(masked.slice(Math.max(0, index - 24), index))

/**
 * 扫一个文件，返回 `{ hits, allowed }`。
 * `hits` = 未登记的裸常量；`allowed` = 命中 `ALLOW` 的那些（用于核对账目）。
 */
const scanFile = (rel) => {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    console.error(`扫描面里的文件不存在：${rel}（SCOPE 过期了？这道门禁不能凭空变绿）`)
    process.exit(2)
  }
  const masked = maskSource(fs.readFileSync(abs, 'utf8'))
  const hits = []
  DECL_RE.lastIndex = 0
  let match
  while ((match = DECL_RE.exec(masked)) !== null) {
    const name = match[1]
    const value = Number(match[2].replace(/_/g, ''))
    // 0 = 「这一类没有这一段预算」，是表里的合法语义，不是阈值
    if (value < 1) continue
    if (!isStrategyName(name)) continue
    if (insideForInit(masked, match.index)) continue
    const allowed = ALLOW.find((item) => item.file === rel && item.name === name && item.value === value)
    if (allowed) {
      allowed.seen = (allowed.seen ?? 0) + 1
      continue
    }
    hits.push({ file: rel, line: lineOf(masked, match.index), name, value: match[2] })
  }
  return hits
}

/** 扫描面：目录里所有 .ts + 显式列出的文件，去掉策略表本体 */
const scopeFiles = () => {
  const files = [...SCOPE_FILES]
  for (const dir of SCOPE_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) {
      console.error(`扫描面里的目录不存在：${dir}（SCOPE 过期了？）`)
      process.exit(2)
    }
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.endsWith('.ts')) files.push(`${dir}/${name}`)
    }
  }
  return files.filter((file) => !POLICY_TABLE.includes(file))
}

const renderSelftest = (cases) => {
  console.log('—— check:bare-const：负向对照（--selftest）——')
  let failed = 0
  for (const item of cases) {
    console.log(`  ${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
    if (!item.ok) failed += 1
  }
  console.log(
    failed === 0
      ? `\n✅ ${cases.length} 条对照全过：这门禁会咬，也不是恒红。`
      : `\n❌ ${failed}/${cases.length} 条对照没过：这门禁是装饰品，别信它的绿。`
  )
  return failed === 0
}

/**
 * `--selftest`：四拍，全在临时目录里跑（`CHECK_BARE_CONST_ROOT`），不碰本仓。
 *
 *   ① 合规样本 → exit 0（否则这道门禁恒红，接进去就是 CI 的背景色）
 *   ② 违规样本 → exit 1 **且点名** `文件:行: 名字 = 值`（复刻 92770fad 的原句）
 *   ③ 白名单样本 → exit 0（`ALLOW` 里登记过的 `CHUNK_RETRIES` 不该红；策略表本体也不该红）
 *   ④ 豁免过期 → exit 1（登记了 `CHUNK_RETRIES` 但代码里没有 → 账不平，逼人回来删条目）
 */
const selftest = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-bare-const-selftest-'))
  const cases = []
  const gate = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_BARE_CONST_ROOT: tmp },
    })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), `${text}\n`, 'utf8')
  }
  /** 每个扫描文件先造一份「合规版本」：只有注释、0、非策略名与已登记的豁免 */
  const writeCleanScope = () => {
    for (const dir of SCOPE_DIRS) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        if (!name.endsWith('.ts')) continue
        const rel = `${dir}/${name}`
        write(
          rel,
          POLICY_TABLE.includes(rel)
            ? "export const POLICY = { retry: 2, dedupeRetry: 1, backoffFactor: 2 }"
            : "// 合规样本\nexport const noBudget = 0\nexport const PAGE_SIZE = 20"
        )
      }
    }
    write('src/services/chat/streamBreakout.ts', '// 合规样本：数字只在策略表里\nexport const retryDelayMs = 0')
    write('src/services/api/managedKey.ts', "export const KEY_PAGE = { page: 1, pageSize: 20 }")
    write('src/services/ours/purchases.ts', 'export const roundYuan = (v: number) => Math.round(v * 100) / 100')
    write(
      'src/services/chat/history/urlImport.ts',
      // 已登记的两条豁免必须在场，否则第 ① 拍就会因「账不平」红
      'const CHUNK_RETRIES = 1\nconst CHUNK_TARGET_MS = 1200'
    )
  }
  try {
    writeCleanScope()
    const clean = gate()
    cases.push({ name: '① 合规样本 → exit 0', ok: clean.status === 0, detail: `exit ${clean.status}` })

    // ② 复刻 92770fad 的原句：断流重试上限写在策略表外面
    write(
      'src/services/chat/streamBreakout.ts',
      'export const STREAM_BREAK_RETRY_LIMIT = 5\nconst CHUNK_GUARD = 1'
    )
    const dirty = gate()
    cases.push({
      name: '② 策略表外写 `STREAM_BREAK_RETRY_LIMIT = 5` → exit 1',
      ok: dirty.status === 1 && dirty.out.includes('src/services/chat/streamBreakout.ts:1: STREAM_BREAK_RETRY_LIMIT = 5'),
      detail: `exit ${dirty.status}`,
    })
    cases.push({
      name: '② 报错给出修法（指向策略表 / LIMITS，而不是「再调阈值」）',
      ok: dirty.out.includes('requestPolicy') && dirty.out.includes('LIMITS'),
    })

    // ② 的第二种命中形状：一位数的重试次数（`check:limits` 的「≥4 位」判据永远看不见的形状）
    write('src/services/api/managedKey.ts', 'export const MANAGED_KEY_MAX_ATTEMPTS = 3')
    const attemptDirty = gate()
    cases.push({
      name: '② 一位数重试次数 `MANAGED_KEY_MAX_ATTEMPTS = 3` → exit 1',
      ok: attemptDirty.status === 1 && attemptDirty.out.includes('MANAGED_KEY_MAX_ATTEMPTS = 3'),
      detail: `exit ${attemptDirty.status}`,
    })

    // ③ 的反面：**诊断元数据不能误伤** —— `buildMeta({ attempt: 1 })` 是日志字段，不是策略。
    //    没有这一拍，后来者把判据放宽到「所有对象属性」时不会有人发现误报（实测会误伤 urlImport 两处）。
    writeCleanScope()
    write(
      'src/services/chat/history/urlImport.ts',
      'const CHUNK_RETRIES = 1\nconst CHUNK_TARGET_MS = 1200\n' +
        "record('import_start', { attempt: 1, retryable: false, timeoutMs: 5000 })"
    )
    const diagnostic = gate()
    cases.push({
      name: '③ 诊断元数据 `{ attempt: 1 }` 不判红（判据只认声明形态）',
      ok: diagnostic.status === 0,
      detail: `exit ${diagnostic.status}`,
    })

    // ③ 白名单样本必绿：登记过的豁免 + 策略表本体（`dedupeRetry: 1` / `BACKOFF_FACTOR = 2`）
    writeCleanScope()
    const allowClean = gate()
    cases.push({
      name: '③ 已登记的 `CHUNK_RETRIES = 1` 与策略表本体 → exit 0',
      ok: allowClean.status === 0,
      detail: `exit ${allowClean.status}`,
    })

    // ④ 豁免过期必红：登记还在、代码里已经没有了
    write('src/services/chat/history/urlImport.ts', 'const CHUNK_TARGET_MS = 1200')
    const stale = gate()
    cases.push({
      name: '④ 豁免登记 CHUNK_RETRIES × 1、实际 0 次（账不平）→ exit 1',
      ok: stale.status === 1 && stale.out.includes('CHUNK_RETRIES'),
      detail: `exit ${stale.status}`,
    })
    cases.push({
      name: '④ 报错点名「请删条目」（收口的人知道下一步）',
      ok: stale.out.includes('删') || stale.out.includes('#903'),
    })
  } catch (error) {
    cases.push({ name: 'selftest 自身抛错', ok: false, detail: error.message })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return renderSelftest(cases)
}

const main = () => {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1)

  const files = scopeFiles()
  const violations = []
  for (const rel of files) violations.push(...scanFile(rel))

  // 豁免账目：登记了几次就要真的出现几次（同 check:limits 的 `allow.count` 口径）
  const staleAllows = []
  for (const item of ALLOW) {
    const seen = item.seen ?? 0
    if (seen !== item.count) {
      staleAllows.push(
        `${item.file}: 豁免登记 ${item.name}（${item.value}）× ${item.count}，实际 ${seen} 次` +
          `（${item.reason}；承接 ${item.followUp}）`
      )
    }
  }

  if (staleAllows.length) {
    console.error('豁免清单与实际代码对不上（收口了就删条目，别让豁免烂在那里）：')
    for (const item of staleAllows) console.error(`  ${item}`)
  }
  if (violations.length) {
    console.error(`发现 ${violations.length} 处「策略表之外的裸常量」：`)
    for (const item of violations) console.error(`  ${item.file}:${item.line}: ${item.name} = ${item.value}`)
    console.error(
      '\n这类数字只有两个去处：\n' +
        '  · 请求级策略（重试次数 / 退避 / 超时 / 空闲）→ 搬进 src/services/net/requestPolicy.ts 的 REQUEST_POLICY，' +
        '数值本体放 src/services/limits.ts 的 LIMITS，调用方读 requestPolicyOf()；\n' +
        '  · 确实不是策略（分块传输 / 字节换算…）→ 在 scripts/check-bare-const.mjs 的 ALLOW 里登记，' +
        '写清 reason 与承接单（#903 在收口这些）。\n' +
        '别把数字藏进一个新常量：那正是这道门禁要防的形状（#894 / #896）。'
    )
  }
  if (violations.length > 0 || staleAllows.length > 0) process.exit(1)

  console.log(
    `策略常量收敛检查通过：扫了 ${files.length} 个文件（窄口径：net/** + #896 迁移的 4 个），` +
      `登记豁免 ${ALLOW.length} 条，策略表之外的裸常量 0 处。`
  )
  process.exit(0)
}

main()
