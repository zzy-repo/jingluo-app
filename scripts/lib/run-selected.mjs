/**
 * scripts/lib/run-selected.mjs —— 把「选中一批测试文件、顺序跑完、逐条报结果」这件事收进一份实现，
 * 给 `pnpm test:fast` / `pnpm test:affected` 用（Issue #409）。
 *
 * 为什么要复用 `tests/helpers/runtime.mjs` 的 `runCase`，而不是自己 spawn：
 *   用例的「是不是 node:test 文件」「要不要 `--experimental-transform-types`」「要不要预加载
 *   injected.mjs」「环境不满足=退出码 77 = SKIP(env) 而不是红」这些语义都写在 runCase 里。
 *   自起一套 spawn，两套语义迟早会漂移（一套把 SKIP 当红、另一套当绿），而这里的结论是要给人看的。
 *   所以：**只借 runCase，不碰 run-layer.mjs**（那是分层门的入口，#366 正在改它，别在这里加口子）。
 *
 * 与 `tests/run-layer.mjs` 的分工：run-layer 跑**整层**（unit/integration/...），这里跑**选出来的
 * 子集**。层语义、用例内容都不动，只是换了一个「跑哪些文件」的输入。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from '../../tests/helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')

/** 用例自报的环境不满足（端口/产物/种类不对），不算失败 */
export const SKIP_CODE = 77

export const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** 一条用例的「用例数」：node:test 报 `ℹ tests N`；自执行脚本按 `[1] [2] …` 分节数计 */
export const countCases = (tail) => {
  const text = tail.join('')
  const declared = /^ℹ tests (\d+)$/m.exec(text)
  if (declared) return Number(declared[1])
  const sections = text.match(/^\s*\[\d+\]/gm)
  return sections ? sections.length : null
}

/**
 * 顺序跑一批用例文件。
 * @param {string[]} files 绝对或仓库相对路径
 * @param {{timeoutMs?: number, env?: Record<string,string>, quiet?: boolean}} options
 * @returns {Promise<{results: Array, totalMs: number, passed: number, failed: number, skipped: number, cases: number|null}>}
 */
export async function runSelected(files, { timeoutMs = 180000, env = process.env, quiet = false, concurrency = 1 } = {}) {
  const started = performance.now()
  const results = []
  /**
   * 并发只在**明确要求**时开（`test:fast` 默认 3）：
   *   - 每个用例本来就有自己的 mkdtemp 与 TEST_TMP_DIR/TMPDIR，端口一律 `listen(0)` 原子分配；
   *   - 会往仓库里写「坏文件」再还原的门禁用例（gate-negative-controls）不在快速子集里 —— 并行互踩的
   *     唯一真实来源就是它，所以它被排除在并发跑法之外。
   * 并发跑时不实时透传子进程输出（会交错成一团），按条缓冲、跑完再按文件顺序补打。
   */
  const queue = files.map((file) => (path.isAbsolute(file) ? file : path.join(ROOT, file)))
  const record = (name, result) => {
    const skipped = result.code === SKIP_CODE
    const cases = countCases(result.tail)
    const item = { file: name, ok: result.ok, skipped, ms: result.ms, cases, timedOut: result.timedOut }
    results.push(item)
    const status = result.ok ? 'PASS' : skipped ? 'SKIP(env)' : result.timedOut ? 'TIMEOUT' : 'FAIL'
    if (!quiet) {
      console.log(`<< ${status} ${name} (${result.ms}ms${cases === null ? '' : `, ${cases} 用例`})`)
      if (skipped) console.log(`   ↳ ${(/SKIP\(env\) (.+)/.exec(result.tail.join(''))?.[1] ?? '环境不满足').trim()}`)
      if (!result.ok && !skipped) console.log(`   ↳ ${result.tail.join('').trim().split('\n').slice(-6).join('\n     ')}`)
    }
  }
  const worker = async () => {
    for (;;) {
      const absolute = queue.shift()
      if (!absolute) return
      const name = rel(absolute)
      if (!quiet) console.log(`>> ${name} (timeout ${timeoutMs}ms)`)
      const result = await runCase(absolute, { cwd: ROOT, env, timeoutMs, output: concurrency === 1 })
      record(name, result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker))
  if (concurrency > 1) results.sort((a, b) => a.file.localeCompare(b.file))
  const failed = results.filter((item) => !item.ok && !item.skipped)
  const skipped = results.filter((item) => item.skipped)
  const withCases = results.filter((item) => typeof item.cases === 'number')
  return {
    results,
    totalMs: Math.round(performance.now() - started),
    passed: results.filter((item) => item.ok).length,
    failed: failed.length,
    skipped: skipped.length,
    // 有用例数的文件才计入；null 表示这个文件的输出里没有可解析的用例计数
    cases: withCases.length === 0 ? null : withCases.reduce((sum, item) => sum + item.cases, 0),
    casesCoveredFiles: withCases.length,
  }
}

/** 统一的结果摘要（顺序跑完之后的最后 3~6 行，给人扫一眼） */
export function printSummary(label, summary) {
  console.log(
    `\n${label}：共 ${summary.results.length} 个文件，PASS ${summary.passed}，FAIL ${summary.failed}，SKIP(env) ${summary.skipped}；耗时 ${(summary.totalMs / 1000).toFixed(1)}s`,
  )
  for (const item of summary.results.filter((entry) => !entry.ok && !entry.skipped)) {
    console.log(`  复跑：node ${item.file}`)
  }
}
