// 契约层（Issue #407）的共享装配 —— 只放「8 个 contract-*.test.mjs 都要用、且必须一模一样」的四件事。
//
// 为什么要有这个文件（而不是每个契约文件各抄一份）：
//   · `.js → .ts` 的解析钩子是 90 个文件各抄一份的老毛病（#362 §2 记的 D7），
//     `check:test-duplication` 的 R1 规则（逐字 ≥20 行）会当场把第 9 份判红；
//   · 域 8 的采集层替身桩（`tests/fixtures/domain08-09/collector-stub.mjs`）已有现成的一份，
//     契约层直接复用，不再造第二个桩；
//   · 契约层要跑门禁脚本（校验器 / 门禁命令）并断言「退出码 + 报错点」，
//     这套「跑一次拿 stdout」的写法也只有一份。
//
// 本文件**不**包含任何业务断言：断言全部留在各自的 `contract-*.test.mjs` 里（一契约一文件）。
// 构建期注入值（`__ENDPOINTS__`）的兜底：直接复用 tests/helpers/injected.mjs（`--import` 预加载那一份）。
// 契约层要能被 `node --test tests/unit/contract-*.test.mjs` 这样裸跑（不带任何 flag），
// 所以不能只靠 runner 的预加载。
import './injected.mjs'

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根（`tests/helpers/` 的上两级） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const abs = (relative) => path.join(ROOT, relative)

/** 读文本（相对仓库根） */
export const readText = (relative) => readFileSync(abs(relative), 'utf8')

/** 读 JSON（相对仓库根） */
export const readJson = (relative) => JSON.parse(readText(relative))

/** 文件在不在（断言「证据真的落到盘上」时用，比断言字符串更难被糊弄） */
export const hasFile = (relative) => existsSync(abs(relative))

/**
 * 装上解析钩子：`.js → .ts`（NodeNext 写法）+ 诊断采集层替身桩。
 * 必须在本文件之后、`await import('../../src/...')` 之前调用一次。
 */
export const installResolveHooks = () => {
  const collectorStub = pathToFileURL(abs('tests/fixtures/domain08-09/collector-stub.mjs')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 只有「导出层要的采集层」被换成空替身：契约层不碰 DOM / IndexedDB（域 8 既有约定）
      if (
        /(?:^|\.\/)collector\.js$/.test(specifier) &&
        context.parentURL?.includes('/src/services/diagnostics/')
      ) {
        return { url: collectorStub, shortCircuit: true }
      }
      if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
        const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
      }
      return nextResolve(specifier, context)
    },
  })
}

/**
 * 跑一条仓库内的命令（校验器 / 门禁用例都靠它），返回「退出码 + 两路输出」。
 * 一律用当前 node 可执行文件：CI 与本地同一条 `node`，不依赖 pnpm 是否在 PATH 上。
 */
export const run = (args, options = {}) =>
  spawnSync(process.execPath, args.map((item) => (path.isAbsolute(item) ? item : abs(item))), {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  })

/**
 * 表驱动的最小执行器：一行 = 一条断言，失败时把「行 id + 说明」直接写进报错信息。
 *
 * 契约层的用例都长成「喂一组输入 → 断言一组输出」，逐条 `test()` 会把文件撑成几十个用例
 * （#362 §0.3 的减法原则）。这里保持「一个契约一个 test()」，行级失败仍能定位到具体某一行。
 *
 * @param {string} title 用例名
 * @param {Array<{id: string, what: string}>} rows 行（每行必须有 id 与 what，报错时带出来）
 * @param {(row: any, helpers: {same: Function}) => void} check 行断言
 */
export const tableTest = (title, rows, check) => async (t) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${title}: 表是空的（空表 = 假绿，契约层不接受）`)
  }
  for (const row of rows) {
    try {
      await check(row)
    } catch (error) {
      error.message = `[${row.id}] ${row.what}\n${error.message}`
      throw error
    }
  }
  t.diagnostic(`${title}: ${rows.length} 行全绿`)
}
