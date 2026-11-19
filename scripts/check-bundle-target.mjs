#!/usr/bin/env node
// 产物门禁：E-1 / E-2 的**硬**入口（GitHub issue #298，承 #95 / #287）。
//
//   pnpm run check:bundle-target               # 检查 dist/
//   node scripts/check-bundle-target.mjs       # 同上
//   node scripts/check-bundle-target.mjs dist-xxx
//
// 和单测层那两条同名的 E-1/E-2 比，差别只有一处：**没有「跳过」这个结果**。
//
//   单测层（tests/unit/legacy-bundle-target.test.mjs）跑在 build 之前，dist/ 不存在时只能声明期
//   SKIP —— #287 之后 CI 报告里长期挂着 `NODE-SKIP 2`，那 2 条就是它们：产物违规也不会红。
//   本脚本提供的是「必须已经构建过」的跑法：
//     · dist 不存在 / dist/static/js 或 dist/static/css 为空 → exit 1，并打印「产物未构建，请先 pnpm build」
//     · 产物不合格（低内核解析不了的语法 / 裸 dvh / 缺 polyfill 的内置 API）→ exit 1，逐条打印
//     · 缺 acorn（AST 层判定不成立）→ exit 2（与 check:legacy 同一约定：2 = 环境不具备检查能力）
//     · 合格 → exit 0
//
// 断言**不是**第二套实现：判定与断言全部来自 scripts/lib/bundleTargetAudit.mjs，单测的 E-1/E-2
// 调用的是同一组函数。CI 里必须放在 build（build:internal）之后，见 PR 里给出的 workflow diff。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAcorn } from './check-bundle-syntax.mjs'
import { assertBundleTarget, auditDist, hasBundle, NO_DIST_REASON } from './lib/bundleTargetAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const main = () => {
  const distDir = path.resolve(ROOT, process.argv[2] ?? 'dist')
  const shown = path.relative(ROOT, distDir).split(path.sep).join('/') || '.'

  // ── 前置：没有产物就是不合格 ────────────────────────────────────────────────
  // 这一步以前不存在，于是「没东西可扫」被当成「扫过且干净」：单测层 SKIP、CI 只看退出码 → 全绿。
  // 现在它是硬失败。措辞里必须带「产物未构建，请先 pnpm build」，别让人只看到一条 assert 栈。
  if (!hasBundle(distDir)) {
    console.error(`✗ 产物未构建，请先 pnpm build（检查目录：${shown}/）`)
    console.error(`  ${NO_DIST_REASON}`)
    console.error('  这是产物层门禁（E-1 语法/内置 API、E-2 CSS dvh + 守卫顺序），没有产物 = 没有检查，')
    console.error('  所以这里一律判失败，不存在「跳过」这个结果（issue #298）。')
    process.exit(1)
  }

  // ── 环境：acorn 拿不到就无法做 AST 层判定，宁可 exit 2 也不假绿 ───────────────
  if (!loadAcorn()) {
    console.error('✗ 找不到 acorn：E-1 的语法层（AST）无法判定，本次门禁不成立（issue #156 / #298）')
    console.error('  修复：pnpm install（acorn 是 @rspack 的传递依赖，不在 package.json 里）')
    process.exit(2)
  }

  const audit = auditDist(distDir)
  console.log(`产物门禁 E-1/E-2：${shown}/`)
  console.log(
    `  JS 文件 ${audit.js.files} 个；词法层违规 ${audit.js.lexical.length} 个；AST 层违规 ${audit.js.ast.length} 个` +
      `（acorn ${audit.js.acornVersion ?? '缺失'}）`
  )
  console.log(
    `  dvh 声明 ${audit.css.dvhTotal} 处；带 vh 回退 ${audit.css.fallbackTotal} 处；CSS 问题 ${audit.css.problems.length} 个`
  )
  console.log(
    `  运行时 API 违规 ${audit.runtime.violations.length} 个；入口脚本里的 polyfill 标记 ${audit.runtime.polyfillInEntries.length} 个`
  )

  try {
    assertBundleTarget(audit, distDir)
  } catch (error) {
    console.error('\n结论：不合格 —— 产物过不了 E-1/E-2（判定与单测同一份：scripts/lib/bundleTargetAudit.mjs）')
    for (const finding of [...audit.js.lexical, ...audit.js.ast]) {
      console.error(
        `  ✗ ${finding.file}:${finding.line}:${finding.column} ${finding.kind}（${finding.why}）${finding.token ?? ''}`
      )
    }
    for (const problem of audit.css.problems) {
      console.error(`  ✗ ${problem.file} ${problem.value}（${problem.kind}）`)
    }
    for (const violation of audit.runtime.violations) {
      console.error(`  ✗ ${violation.file}:${violation.line}:${violation.column} ${violation.id}（${violation.reason}）${violation.token}`)
    }
    // 失败可能不是「产物里有问题」而是断言本身（文件数不足 / 找不到 main 包 / defer 丢了），
    // 这类没有逐条 problem，打断言原文第一行就够，别把 node 生成的 diff 整段刷屏。
    console.error(`  断言：${error.message.split('\n')[0]}`)
    process.exit(1)
  }
  console.log(
    '\n结论：合格 —— E-1（Chrome 83 可解析 + 内置 API 有 polyfill 兜底）与 E-2（无裸 dvh + 守卫在业务包之前）都通过'
  )
}

main()
