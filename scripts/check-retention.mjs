#!/usr/bin/env node
/**
 * check-retention.mjs —— 分发机保留策略的到期检查（Issue #662）。
 *
 * ## 为什么要有它
 *
 * #285 的盘点里四条「孤儿资源」全靠人记：`/opt/dl-private/private` 下 12 个清单查不到
 * 的包（64 MB）、`/opt/dl-leak-evidence` 的 9 份 #601 取证物、`/root/dl-release-backups`
 * 的 15 份发布备份。**没有到期日 = 永远不会过期 = 明年还是这一堆**，而且没人分得清
 * 「哪份能删、哪份是唯一副本」。
 *
 * #662 的做法不是 `rm`，而是给每个文件写一行账（`<目录>/.retention.json`：
 * sha256 / 大小 / 何时进来 / 何时该删 / 为什么能删），再让这条命令去对账：
 * **过了 `deleteAfter` 就红**，没过就报剩余天数。这样「该删了」不再依赖谁记性好。
 *
 * 为什么不接 CI：账本与文件都在**分发机**上（`/opt/dl-private`、`/opt/dl-leak-evidence`），
 * CI runner 上没有这两个目录，接了只会每天红一次。它由运维定期在分发机上跑
 * （见 `docs/RELEASE-MANUAL.md` 的「分发机保留策略」）。
 *
 * ## 判据（每条都对应一个真实的失效模式）
 *
 * 对账本里每一条 `键 = 相对本目录的路径`：
 *
 *   · `deleteAfter` 是日期且 **< 今天** → `EXPIRED`（error）：「已经过了 N 天，该删了」。
 *     这是本命令存在的理由 —— 唯一的「该动手了」信号。
 *   · `deleteAfter` 是日期且 >= 今天 → `ok`，打印剩余天数。
 *   · `deleteAfter: null` + `deleteAfterRule` + `reviewAfter` → 条件到期（#601 取证物：
 *     「复盘关闭后 30 天」，而复盘关没关**只能人判断**）。到 `reviewAfter` 之前 → `ok`（打印
 *     复核日与剩余天数）；过了 `reviewAfter` 还没人改 → `REVIEW-DUE`（error）：
 *     不是自动删，而是逼人做一次判断（确认复盘关闭 → 填上 deleteAfter；或续期）。
 *     没有 `reviewAfter` 的 `deleteAfter: null` → `BAD-LEDGER`（error）：那是「无限期」，
 *     正是本单要消灭的东西。
 *   · 文件**已不在** → `MISSING`（warning，不判红）：可能已经按账删掉了，人不该因此红；
 *     但要打印出来，提醒把这条从账本里划掉（否则账本会越攒越多僵尸条目）。
 *   · 文件在但 `sha256`/`size` 与账本不符 → `DRIFT`（error）：账本是可追溯性的唯一凭据，
 *     对不上就说明「这行账记录的不是现在这个文件」，比过期更严重。
 *   · 目录或账本不存在 → 整个 target `SKIP`（不判红）：本机（开发机 / CI）上没有分发机目录
 *     是正常情况，不是失败。四个 target 全 SKIP 时 exit 0。
 *
 * ## 用法
 *
 *   node scripts/check-retention.mjs                 # pnpm check:retention，查默认两个目录
 *   node scripts/check-retention.mjs --dir <目录> --ledger <账本>   # 指定一对（可重复）
 *   node scripts/check-retention.mjs --now 2026-11-20 # 假定「今天」，用于演练/负向对照
 *   node scripts/check-retention.mjs --json          # 机器可读（给运维脚本用）
 *   node scripts/check-retention.mjs --verbose       # 逐条打印（默认只打印异常 + 汇总）
 *
 * 退出码：0 通过（含全部 SKIP）/ 1 有 EXPIRED / REVIEW-DUE / DRIFT / BAD-LEDGER /
 *         2 用法或数组装错误（账本不是合法 JSON、日期格式不对）。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认账本对（分发机上才有；本机不存在 → SKIP）。 */
export const DEFAULT_TARGETS = [
  { dir: '/opt/dl-private/private', ledger: '/opt/dl-private/private/.retention.json' },
  { dir: '/opt/dl-leak-evidence', ledger: '/opt/dl-leak-evidence/.retention.json' },
]

/** 账本里以 `_` 开头的键是元信息，不是条目。 */
const isMeta = (key) => key.startsWith('_')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` → 当天 UTC 零点毫秒；格式不对返回 null。 */
export function parseDay(text) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) return null
  const t = Date.parse(`${text}T00:00:00Z`)
  return Number.isNaN(t) ? null : t
}

/** 毫秒 → `YYYY-MM-DD`（UTC）。 */
export function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

const DAY_MS = 24 * 60 * 60 * 1000

async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 纯判定：拿到账本对象 + 一个「文件解析器」，吐出一串结论。
 * 抽出来是为了让 `tests/unit/retention-662.test.mjs` 能钉住每种状态（而不是只钉 CLI）。
 *
 * @param {{dir: string, ledger: string, doc?: object, today: number, inspect?: (abs: string) => Promise<{size: number, sha256: string} | null>}} input
 *   `inspect` 返回 null 表示文件不存在（测试可注入，避免真读 64 MB 的 apk）。
 */
export async function evaluateTarget({ dir, ledger, doc, today, inspect }) {
  const problems = []
  const rows = []
  const meta = doc && !Array.isArray(doc) && typeof doc === 'object' ? doc._meta : undefined

  for (const [rel, raw] of Object.entries(doc ?? {})) {
    if (isMeta(rel)) continue
    const entry = raw && typeof raw === 'object' ? raw : {}
    const row = { target: dir, file: rel, status: 'ok', detail: '', action: '' }

    if (entry.deleteAfter !== null && entry.deleteAfter !== undefined) {
      const due = parseDay(entry.deleteAfter)
      if (due === null) {
        row.status = 'BAD-LEDGER'
        row.detail = `deleteAfter「${entry.deleteAfter}」不是 YYYY-MM-DD`
        problems.push(row)
        rows.push(row)
        continue
      }
      const left = Math.round((due - today) / DAY_MS)
      if (left < 0) {
        row.status = 'EXPIRED'
        row.detail = `deleteAfter ${entry.deleteAfter}，已过期 ${-left} 天`
        row.action = '该删了：先把 sha256/大小核对 MANIFEST，再删并划掉账本条目'
        problems.push(row)
      } else {
        row.detail = `deleteAfter ${entry.deleteAfter}，还剩 ${left} 天`
      }
    } else {
      // 条件到期：没有硬日期，必须有规则 + 复核日，否则就是「无限期保留」。
      const review = parseDay(entry.reviewAfter)
      if (!entry.deleteAfterRule || review === null) {
        row.status = 'BAD-LEDGER'
        row.detail = 'deleteAfter 为 null 但缺 deleteAfterRule 或 reviewAfter（= 无限期保留）'
        problems.push(row)
        rows.push(row)
        continue
      }
      const left = Math.round((review - today) / DAY_MS)
      if (left < 0) {
        row.status = 'REVIEW-DUE'
        row.detail = `复核日 ${entry.reviewAfter} 已过 ${-left} 天，到期条件（${entry.deleteAfterRule}）仍未确认`
        row.action = '人工确认到期条件是否已满足：满足 → 填 deleteAfter 并排期删除；未满足 → 改 reviewAfter 续期'
        problems.push(row)
      } else {
        row.detail = `条件到期（${entry.deleteAfterRule}），复核日 ${entry.reviewAfter}，还剩 ${left} 天`
      }
    }

    const abs = path.join(dir, rel)
    const actual = await inspect(abs)
    if (actual === null) {
      row.status = 'MISSING'
      row.detail = `文件已不在（${row.detail}）`
      row.action = '若已按账删除，把这行从账本删掉'
    } else if (entry.sha256 && actual.sha256 !== entry.sha256) {
      row.status = 'DRIFT'
      row.detail = `sha256 与账本不符（账本 ${entry.sha256.slice(0, 16)}… / 实测 ${actual.sha256.slice(0, 16)}…）`
      row.action = '账本记录的已不是这个文件：先查清谁改的，别删'
      problems.push(row)
    } else if (entry.size !== undefined && actual.size !== entry.size) {
      row.status = 'DRIFT'
      row.detail = `大小与账本不符（账本 ${entry.size} / 实测 ${actual.size}）`
      row.action = '同 sha256 不符：先查清来源，别删'
      problems.push(row)
    }

    rows.push(row)
  }

  return { dir, ledger, title: meta?.title ?? '', rows, problems }
}

async function inspectReal(abs) {
  if (!(await exists(abs))) return null
  const st = await stat(abs)
  return { size: st.size, sha256: await sha256Of(abs) }
}

function parseArgs(argv) {
  const opts = { targets: [], now: null, json: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--now') {
      const [, v] = [null, argv[(i += 1)]]
      if (parseDay(v) === null) throw new Error(`--now 需要 YYYY-MM-DD，收到「${v}」`)
      opts.now = parseDay(v)
    } else if (a === '--dir') {
      const dir = argv[(i += 1)]
      if (!dir) throw new Error('--dir 需要目录')
      opts.targets.push({ dir, ledger: path.join(dir, '.retention.json') })
    } else if (a === '--ledger') {
      const ledger = argv[(i += 1)]
      if (!ledger) throw new Error('--ledger 需要路径')
      if (opts.targets.length === 0) throw new Error('--ledger 要跟在一个 --dir 后面')
      opts.targets[opts.targets.length - 1].ledger = ledger
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else {
      throw new Error(`不认识的参数「${a}」（--help 看用法）`)
    }
  }
  return opts
}

async function main() {
  const argv = process.argv.slice(2)
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`check:retention 用法错误：${err.message}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log('node scripts/check-retention.mjs [--dir <目录> [--ledger <账本>]]... [--now YYYY-MM-DD] [--json] [--verbose]')
    console.log('默认目录：' + DEFAULT_TARGETS.map((t) => t.dir).join('、'))
    return
  }

  const today = opts.now ?? parseDay(new Date().toISOString().slice(0, 10))
  const targets = opts.targets.length > 0 ? opts.targets : DEFAULT_TARGETS
  const results = []
  let fatal = null

  for (const t of targets) {
    if (!(await exists(t.dir)) || !(await exists(t.ledger))) {
      results.push({ dir: t.dir, ledger: t.ledger, skipped: true, rows: [], problems: [] })
      continue
    }
    let doc
    try {
      doc = JSON.parse(await readFile(t.ledger, 'utf8'))
    } catch (err) {
      fatal = `${t.ledger} 读不出来或不是合法 JSON：${err.message}`
      break
    }
    results.push(await evaluateTarget({ ...t, doc, today, inspect: inspectReal }))
  }

  const problems = results.flatMap((r) => r.problems)
  const rows = results.flatMap((r) => r.rows)
  const skipped = results.filter((r) => r.skipped)

  if (opts.json) {
    console.log(JSON.stringify({ today: formatDay(today), results, problems: problems.length, fatal }, null, 2))
    process.exit(fatal ? 2 : problems.length > 0 ? 1 : 0)
  }

  if (fatal) {
    console.error(`check:retention 失败：${fatal}`)
    process.exit(2)
  }

  for (const r of results) {
    if (r.skipped) {
      console.log(`SKIP  ${r.dir} —— 目录或账本不存在（分发机之外是正常的，不是失败）`)
      continue
    }
    const active = r.rows.filter((x) => x.status !== 'MISSING')
    console.log(`${r.title || r.dir} —— ${r.dir}：${active.length} 条` + (r.rows.length !== active.length ? `，另有 ${r.rows.length - active.length} 条已不在盘中` : ''))
    const show = opts.verbose ? r.rows : r.rows.filter((x) => x.status !== 'ok')
    for (const row of show) {
      const tag = row.status.padEnd(10)
      console.log(`  [${tag}] ${row.file} —— ${row.detail}`)
      if (row.action) console.log(`             → ${row.action}`)
    }
    if (!opts.verbose) {
      const okCount = r.rows.filter((x) => x.status === 'ok').length
      if (okCount > 0) console.log(`  其余 ${okCount} 条未到期（--verbose 逐条看）`)
    }
  }

  if (rows.length === 0 && skipped.length === results.length) {
    console.log(`\ncheck:retention OK —— ${results.length} 个分发机目录都不在这台机器上（SKIP），无检查可做。`)
    console.log('  在分发机上跑：ssh <分发机> -- "cd <repo> && pnpm check:retention"（见 docs/RELEASE-MANUAL.md「分发机保留策略」）')
    return
  }

  if (problems.length === 0) {
    console.log(`\ncheck:retention OK —— ${rows.length} 条账目全部未到期，且 sha256/大小与账本一致。`)
    return
  }

  console.error(`\ncheck:retention 失败：${problems.length} 条需要处理（今天 ${formatDay(today)}）\n`)
  for (const p of problems) {
    console.error(`  ${p.status}  ${p.target}/${p.file}`)
    console.error(`        ${p.detail}`)
    if (p.action) console.error(`        → ${p.action}`)
  }
  console.error('\n过期 ≠ 立刻 rm：先核对 #662 的 MANIFEST 里的 sha256，确认不是唯一副本，再删并划掉账本条目。')
  process.exit(1)
}

// 仅在被直接执行时跑 CLI（测试 import 本文件取 evaluateTarget 时不应产生副作用）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
