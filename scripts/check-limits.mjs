#!/usr/bin/env node
/**
 * check-limits.mjs —— 运行期阈值必须只在 `src/services/limits.ts` 里写数字（Issue #275）。
 *
 * 为什么要有它：#275 之前超时 / 限量 / 阈值散在 9 个文件、20 余个裸字面量里，改一个数要全仓 grep，
 * 而且没有任何地方能回答「当前线上生效的停滞阈值是多少秒」。搬进 LIMITS 之后，真正的风险变成
 * 「下一次有人顺手又写一个 45000」—— 那种回归在 review 里看不出来，只有跑起来才发作。
 * 这个脚本把那件事变成一条命令：**阈值文件里再出现裸的 4 位以上数字就 exit 1**。
 *
 * 扫描范围（WATCHED）：持有运行期阈值的那些文件。新增一处阈值来源时把文件加进这个清单，
 * 否则它不受保护。`src/services/limits.ts` 本身是唯一允许写数字的地方，不扫。
 *
 * 判定口径：
 *   - 只看**代码**里的数字：注释（`//`、块注释）与字符串 / 模板字面量先被抹掉，再扫；
 *   - 整数部分 ≥ 4 位（下划线分隔按去除后算，`30 * 60_000` 里的 `60_000` 也算）即命中；
 *   - 允许豁免，但必须逐条写进该文件的 `allow` 清单并注明理由（例如「字节换算的 1024」「字符数成本」）。
 *     豁免是**按出现次数**核对的：实际出现次数少于登记次数也算失败（避免豁免烂在那里误导下一个人）。
 *
 * 用法：
 *   node scripts/check-limits.mjs
 *   pnpm run check:limits
 *
 * 退出码：
 *   0  干净
 *   1  发现未收敛的阈值字面量（逐条打印 `文件:行`）
 *   2  用法 / 环境错误（清单里的文件不存在）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 受保护的文件清单 + 每个文件里**不是运行期阈值**的 4 位以上数字。
 * 加豁免时写清这是什么数（为什么不该搬进 LIMITS），别只写「历史遗留」。
 */
const WATCHED = [
  {
    // 唯一的一处：requestTimedOut() 里 Math.round(timeoutMs / 1000) 把毫秒折成文案里的秒数
    file: 'src/services/api/client.ts',
    allow: [{ value: 1000, count: 1, reason: '毫秒 → 秒换算（超时文案的 {seconds}）' }],
  },
  {
    file: 'src/services/chat/contextBudget.ts',
    allow: [{ value: 1500, count: 1, reason: 'FILE_BLOCK_CHARS：附件块的字符成本估算，不是时间/体积阈值' }],
  },
  { file: 'src/services/chat/store.ts', allow: [] },
  { file: 'src/services/chat/autoTitle.ts', allow: [] },
  { file: 'src/services/chat/autoTitleQueue.ts', allow: [] },
  {
    file: 'src/services/attachments.ts',
    allow: [
      { value: 1024, count: 2, reason: 'getMaxSizeMB() * 1024 * 1024：MB → 字节换算' },
      { value: 1024, count: 1, reason: 'formatBytes 的 KB 分档（bytes < 1024）' },
      { value: 1024, count: 3, reason: 'formatBytes 的单位递进（/1024、>= 1024、/= 1024）' },
    ],
  },
  {
    file: 'src/services/chat/history/urlImport.ts',
    allow: [
      { value: 1024, count: 4, reason: 'FIRST/MIN/MAX_CHUNK_BYTES 的 KiB 写法（4 * 1024 …）' },
      { value: 1024, count: 2, reason: 'DECODE_CHUNK_CHARS 的 KiB 写法（4 * 1024 * 1024）' },
      { value: 1200, count: 1, reason: 'CHUNK_TARGET_MS：分块目标耗时，自适应块大小的目标值' },
      { value: 4096, count: 1, reason: 'ERROR_BODY_CHARS：403 响应体只解前 4096 字符' },
      { value: 1000, count: 5, reason: '耗时 / 秒换算与诊断节流（maxTotalMs / 1000、stallMs / 1000、三处 >= 1000 的 trace 间隔）' },
      { value: 60000, count: 1, reason: '毫秒 → 分钟换算（Math.round(maxTotalMs / 60_000)）' },
    ],
  },
  {
    file: 'src/components/settings/PaymentTrailView.ts',
    allow: [{ value: 1000, count: 1, reason: '秒 → 毫秒换算（服务端时间戳是秒，value * 1000）' }],
  },
  {
    file: 'src/index.html',
    allow: [
      // 内联脚本在 bundle 之前执行，import 不到 LIMITS；数值由 tests/unit/limits-config.test.mjs 断言相等。
      { value: 12000, count: 1, reason: 'BOOT_DEADLINE_MS：与 LIMITS.bootDeadlineMs 相等，由单测守' },
      { value: 1000, count: 1, reason: '启动重试的定时器间隔（setTimeout 1000）' },
      {
        value: 4000,
        count: 1,
        reason: 'MAX_COPY_CHARS：兜底页复制文本上限，与 errorReport.ts 的 MAX_REPORT_CHARS 相等，由单测守',
      },
    ],
  },
]

/** 抹掉注释与字符串 / 模板字面量，只留代码里的数字 */
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
        // 保留换行，让行号不漂
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
        // 模板字面量里的 ${...} 含真代码：简单跳过整个替换段，避免把表达式当成字符串
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
        if (text[i] === '\n') {
          out += '\n'
        }
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 行号 + 数字：只看整数部分 ≥ 4 位的字面量 */
const findLiterals = (masked) => {
  const hits = []
  const lines = masked.split('\n')
  const re = /(?<![\w.$])\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  lines.forEach((line, index) => {
    for (const match of line.matchAll(re)) {
      const raw = match[0]
      const integerPart = raw.split(/[.eE]/)[0].replace(/_/g, '')
      if (integerPart.length < 4) continue
      hits.push({ line: index + 1, raw, value: Number(raw.replace(/_/g, '')) })
    }
  })
  return hits
}

const main = () => {
  const violations = []
  const staleAllows = []
  let checkedFiles = 0
  let allowedCount = 0

  for (const entry of WATCHED) {
    const abs = path.join(ROOT, entry.file)
    if (!fs.existsSync(abs)) {
      console.error(`清单里的文件不存在：${entry.file}（WATCHED 清单过期了？）`)
      process.exit(2)
    }
    checkedFiles += 1
    const hits = findLiterals(maskSource(fs.readFileSync(abs, 'utf8')))

    // 同一个数值可能有多条登记（一个文件里两处 1024 的用途不同）：按数值汇总后核对次数
    const perValue = new Map()
    for (const allow of entry.allow) {
      const item = perValue.get(allow.value) ?? { count: 0, reasons: [] }
      item.count += allow.count
      item.reasons.push(allow.reason)
      perValue.set(allow.value, item)
    }
    for (const [value, item] of perValue) {
      const used = hits.filter((hit) => hit.value === value).length
      allowedCount += Math.min(used, item.count)
      if (used !== item.count) {
        staleAllows.push(
          `${entry.file}: 豁免登记 ${value} × ${item.count}，实际 ${used} 次（${item.reasons.join(' / ')}）`
        )
      }
    }

    const budget = entry.allow.map((allow) => ({ ...allow, left: allow.count }))
    for (const hit of hits) {
      const slot = budget.find((item) => item.value === hit.value && item.left > 0)
      if (slot) {
        slot.left -= 1
        continue
      }
      violations.push(`${entry.file}:${hit.line}: ${hit.raw}（换算值 ${hit.value}）`)
    }
  }

  if (staleAllows.length) {
    console.error('豁免清单与实际代码对不上（删掉多余登记，或补齐说明）：')
    for (const item of staleAllows) console.error(`  ${item}`)
  }
  if (violations.length) {
    console.error(`发现 ${violations.length} 处未收敛的阈值字面量：`)
    for (const item of violations) console.error(`  ${item}`)
    console.error(
      '\n阈值请搬进 src/services/limits.ts 的 LIMITS 并从这里引用（只搬位置、不改数值）。' +
        '确实不是阈值的数字（字节换算、字符数成本等），在 scripts/check-limits.mjs 的 WATCHED 里登记豁免并写清理由。'
    )
    process.exit(1)
  }
  if (staleAllows.length) process.exit(1)
  console.log(
    `阈值收敛检查通过：扫了 ${checkedFiles} 个文件，` +
      `豁免 ${allowedCount} 处非阈值数字，未收敛阈值 0 处。`
  )
  process.exit(0)
}

main()
