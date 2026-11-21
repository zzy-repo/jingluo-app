#!/usr/bin/env node
/**
 * 产物语法下限门禁（issue #104）。
 *
 *   node scripts/compat/check-syntax-floor.mjs                 # 默认读 ./dist + config/compat.json
 *   node scripts/compat/check-syntax-floor.mjs --dist <dir>
 *   node scripts/compat/check-syntax-floor.mjs --floor <n>     # 覆盖声明值（负向对照用）
 *
 * ## 它补的是哪一种盲区
 *
 * `check:legacy` 的判据是「Chromium **83** 能力集」：只要产物没有 `||=` / `static {}` / 私有方法，
 * 它就合格。而 `?.` / `??` 属于 **ES2020 / Chrome 80**，本来就在 83 的能力集里，所以这道门
 * **永远不会因为可选链而变红** —— 这不是 bug，是它的契约（见 check-bundle-syntax.mjs 的说明）。
 *
 * 于是留下一条缝：产物的**真实语法下限是 80**，而我们对外声明的是 83（`config/compat.json:baselineChromium`），
 * 兜底页文案也照着 83 说话。80 和 83 之间这 3 档内核能解析、但不在承诺范围；而**低于 80 的内核
 * 整包解析失败**，用户看到 `Uncaught SyntaxError: Unexpected token '?'`（issue #104 的现场）。
 * 这条缝就是「线上复现了、门禁却全绿」的原因：没有任何一处把「声明的最低内核」和
 * 「产物真实的最低内核」放在一起比。
 *
 * 本脚本就是把这两个数字放在一起比：
 *   - 真实下限来自 `scripts/compat/matrix-scan.mjs` 的 `scanFileSyntax()`（AST 逐特性 → 最低 Chromium，
 *     特性到版本的映射带证据链接，**不是** acorn 的 ecmaVersion 阶梯 —— 后者会把 public class field
 *     （Chrome 72）误判成 ES2022/Chrome 94，量出来比真实值高得多）；
 *   - 声明下限来自 `config/compat.json:syntaxFloorChromium`（兜底页文案引用的就是它）。
 *
 * 判定：
 *   - 真实下限 **高于** 声明下限 → 红。产物比我们承诺的更难解析：要么把构建目标降回去，
 *     要么把 `syntaxFloorChromium` 与兜底页文案一起改（这两处由单测钉着，改一处另一处必红）；
 *   - 真实下限 **低于** 声明下限 → 绿，但打印一行提示（可以顺手把声明值往下调，让文案更准确）；
 *   - 相等 → 绿。
 *
 * 退出码：0 一致（或产物更兼容）/ 1 不一致 / 2 环境不具备（产物或 config 读不到）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadAcorn, readEntryScripts } from '../check-bundle-syntax.mjs'
import { scanFileSyntax } from './matrix-scan.mjs'
import { ROOT, SYNTAX_FLOOR_CHROMIUM } from '../lib/compatBaseline.mjs'

/**
 * 量一个入口文件的语法下限。
 * 返回 { file, chromeFloor, drivers, esFloor } —— 与 matrix-scan 的 scanFileSyntax 同口径。
 */
export const measureEntry = (acorn, file) => {
  const code = readFileSync(file, 'utf8')
  const result = scanFileSyntax(acorn, code)
  return {
    file,
    chromeFloor: result.chromeFloor,
    esFloor: result.esFloor,
    drivers: result.drivers ?? [],
    unparsable: Boolean(result.unparsable),
    decisive: result.decisive ?? null,
  }
}

/**
 * 纯函数判定，方便单测直接喂数字。
 * @returns {{ok: boolean, code: 'match'|'lower'|'higher'|'unparsable'}}
 */
export const judge = (measured, declared) => {
  if (measured.unparsable || measured.chromeFloor === null) return { ok: false, code: 'unparsable' }
  if (measured.chromeFloor > declared) return { ok: false, code: 'higher' }
  if (measured.chromeFloor < declared) return { ok: true, code: 'lower' }
  return { ok: true, code: 'match' }
}

const main = () => {
  const args = process.argv.slice(2)
  const readFlag = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : null
  }
  const distArg = readFlag('--dist')
  const floorArg = readFlag('--floor')
  if (args.includes('--dist') && !distArg) {
    console.error('--dist 需要一个目录参数')
    process.exit(2)
  }
  if (args.includes('--floor') && !/^\d+$/.test(floorArg ?? '')) {
    console.error('--floor 需要一个整数参数')
    process.exit(2)
  }
  const declared = floorArg === null ? SYNTAX_FLOOR_CHROMIUM : Number(floorArg)
  const distDir = distArg ? path.resolve(distArg) : path.join(ROOT, 'dist')

  const acorn = loadAcorn()
  if (!acorn) {
    console.error('✗ 找不到 acorn（先 pnpm install；它是 @rspack 的传递依赖）')
    process.exit(2)
  }
  const entryScripts = readEntryScripts(distDir)
  if (!entryScripts || entryScripts.length === 0) {
    console.error(`✗ 读不到入口脚本：${path.relative(ROOT, distDir)}/index.html（先 pnpm run build）`)
    process.exit(2)
  }

  console.log(`产物语法下限检查（issue #104）：${path.relative(ROOT, distDir) || '.'}`)
  console.log(`  声明下限 syntaxFloorChromium = ${declared}（config/compat.json，兜底页文案引用的就是它）`)

  let failed = false
  for (const relative of entryScripts) {
    const file = path.resolve(distDir, relative)
    let measured
    try {
      measured = measureEntry(acorn, file)
    } catch (error) {
      console.error(`✗ 读不到入口脚本 ${relative}：${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
    const verdict = judge(measured, declared)
    const drivers = measured.drivers.length ? measured.drivers.join(' + ') : '（无 80+ 特性）'
    if (verdict.code === 'match') {
      console.log(`  ✓ ${relative}：真实下限 Chrome ${measured.chromeFloor}（${drivers}）= 声明值`)
    } else if (verdict.code === 'lower') {
      console.log(
        `  ✓ ${relative}：真实下限 Chrome ${measured.chromeFloor}（${drivers}）**低于**声明值 ${declared} —— 合格，` +
          `但可以顺手把 syntaxFloorChromium 调到 ${measured.chromeFloor}，让兜底页文案更准确`
      )
    } else if (verdict.code === 'higher') {
      failed = true
      console.error(
        `  ✗ ${relative}：真实下限 Chrome ${measured.chromeFloor}（${drivers}）**高于**声明值 ${declared} —— ` +
          `产物比承诺的更难解析，低于 Chrome ${measured.chromeFloor} 的内核会整包解析失败（Unexpected token）`
      )
      if (measured.decisive) {
        console.error(
          `      首个卡点 ${measured.decisive.line}:${measured.decisive.column}（ES${measured.decisive.version} 解析）` +
            ` ${String(measured.decisive.snippet).slice(0, 100)}`
        )
      }
    } else {
      failed = true
      console.error(`  ✗ ${relative}：连 ES2022 都解析不了，先修构建`)
    }
  }

  if (failed) {
    console.error(
      '\n结论：不合格 —— 入口产物的真实语法下限高于声明下限。两条路选一条：' +
        '\n  a) 把构建目标降回 config/compat.json:baselineChromium 里声明的那一档（让新语法被降级）；' +
        '\n  b) 真的决定不再支持更低内核：同时改 config/compat.json:syntaxFloorChromium 与兜底页文案' +
        '（src/index.html 的 MIN_ENGINE_CHROMIUM，单测会钉住两边相等），并在 README / 发布说明里写清新的最低要求。'
    )
    process.exit(1)
  }
  console.log('\n结论：合格 —— 声明的最低内核与产物真实语法下限一致（或产物更兼容）')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
