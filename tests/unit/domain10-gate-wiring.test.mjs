// [layer: unit | 纯 Node，只读配置与文件清单 | 耗时: <1s]
//
// 域10 N6 —— **门禁接线断言**（Issue #362 §3.2 N6）。
//
// 和 N2 的分工（两张红长得不一样，别混在一起，否则分不清该修脚本还是补接线）：
//   N2 红 = 门禁**脚本本身**坏了（注入缺陷没被拦下）；
//   N6 红 = 门禁**被人从流水线上摘掉了**（脚本是好的，但没人跑它）。
//
// 这个文件只断言「配置与入口」，不跑任何业务脚本。它守的是 #362 域10 §2 里那三句话里的
// 第二、三句：`deploy/dl-release/test` 24 条全绿却**不在任何执行入口**；
// `tests/which.mjs` 对 `shared/build-types.mjs` 永远映射 0 个用例（改枚举不触发任何 L0）。
//
// 覆盖的功能点：
//   F10-15 渠道枚举只有一份定义，四处都认同一份（改 shared/build-types.mjs 必须能触发 L0）
//   F10-16 清单校验器真的还活着（12 道 CI 门禁一条都不许被静默摘掉）
//   F10-17/18/19/20 上传契约 / 防降级 / debuggable / 变体（它们的用例必须**有人跑**）
//
// 表驱动（3 行）：一行 = 一条「接线不变量」。加一条不变量 = 加一行。

// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { selectTests } from '../which.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))
const ci = read('.github/workflows/ci.yml')

/** ci.yml 里必须出现的 12 条门禁（`run: pnpm run <script>`）+ 单元层那一条（`run: pnpm test`） */
const REQUIRED_CI_GATES = [
  'check:hygiene',
  'check:dup-impl',
  'type',
  'lint',
  'build:internal',
  'check:bundle-target',
  'check:legacy',
  'check:matrix',
  'check:ip',
  'check:manifest',
  'check:log-coverage',
  'check:doc-refs',
  // #557：大小写撞车门禁 —— 摘掉它，consume 面板那 4 对同名文件就会再次漂回 main
  'check:case-collision',
  // #547：DB 版本硬编码门禁 —— 摘掉它，下一次库升级（图片线可能要升 v14）又会把 L1 用例打成 VersionError
  'check:db-version',
  // #590：方向验收 A1–A7 —— #487 阶段②建好时它是「设计性红」（A1/A4/A6 全是 FAIL），
  // 接一道恒红的门禁等于没有门禁，所以等 #590 把三项降到 0 命中之后才接线。摘掉它，
  // 「旧体系又回来了 / 额度又被搬回本地 / base 又被写死」这三件事就再没人守。
  'check:refactor-direction',
  // #609（裁决 #614 决定 3，P0）：webroot 卫生门禁 —— 摘掉它，#601 那种「清单删了、
  // 文件还躺在 /var/www/dl/apk/ 下」的状态就再没有任何机械化检查（静态目录不看清单）。
  'check:webroot-hygiene',
]

/**
 * 目前**没接线**（ci.yml 里没有 `run: pnpm run <alias>`）的门禁，逐条给理由。
 *
 * #487 全量体检（2026-11-20）实测：`scripts/check-*.mjs` 28 道，接进 CI 的 15 道，
 * 剩下 13 道里有 10 道**连交代都没有** —— 这就是 #362 说的「脚本能判红 ≠ 有人在跑」，
 * 而且比判红更隐蔽：一道从未被跑过的门禁，谁也不知道它其实早就判不动了。
 * 这里把清单补全：只要有别名却没接线，就必须出现在这张表里，代码 review 时才看得见这笔账。
 */
const KNOWN_UNWIRED = {
  'check:identity': '语义由 L0 用例（tests/unit/app-identity.test.mjs 等 3 条）覆盖；脚本本体未接 CI',
  'check:apk': 'release.yml 每次发布对每个产物实跑（需要 apk 路径参数，checks job 里没有产物）',
  'check:keystore': '需要本机 android/keystore/keystore.properties（不入库），在 CI 里必然 exit 2',
  'check:guard': 'ES5 守卫顺序扫描；存量与 check:legacy 重叠，待定是否合并后接线',
  'check:gap': 'CSS flex gap 兜底扫描；四个 fallback 门禁统一在「阶段③测试重建」后接线',
  'check:focus': 'CSS focus-visible 兜底扫描；同上',
  'check:gutter': 'CSS scrollbar-gutter 兜底扫描；同上',
  'check:container': 'CSS 容器查询兜底扫描；语义已由 tests/unit/container-query-fallback.test.mjs 覆盖',
  'check:compat-baseline': '静态兼容基线；语义已由 tests/unit/compat-baseline.test.mjs 覆盖',
  'check:hardcoded-ports': '硬编码端口扫描；语义已由 tests/unit/check-hardcoded-ports.test.mjs 覆盖',
  'check:limits': '上限常量一致性扫描；无任何调用点（本次体检新增登记）',
  'check:icon': '图标边缘留白扫描；无任何调用点（本次体检新增登记）',
}

/** 有脚本、没别名、也没接线的门禁：手工跑（合并前看 issue 关键字），故不设 npm script */
const SCRIPT_WITHOUT_ALIAS = ['check-issue-close-keywords.mjs']

const ROWS = [
  {
    id: 'W1',
    f10: ['F10-16'],
    name: 'ci.yml 一条不落地跑 13 道门禁，且含 check:legacy 的负向对照',
    verify: () => {
      const missing = REQUIRED_CI_GATES.filter((gate) => !new RegExp(`run: pnpm run ${gate}\\b`).test(ci))
      assert.deepEqual(missing, [], `ci.yml 里缺这些门禁步骤（摘掉一道 = 那条路再也没人守）：${missing.join(', ')}`)
      assert.match(ci, /run: pnpm test\b/, '单元层那一步（run: pnpm test）不许被删：全仓 L0 都靠它')
      // 负向对照：ci.yml 目前只有一条（check:legacy 现场注入 ?. / ??=）。
      // #369 之后会收敛成统一模板；在那之前这条断言保证「不是零条」。
      assert.match(
        ci,
        /负向对照/,
        'ci.yml 里至少要有一条负向对照步骤 —— 没有它就没人能证明门禁不是空跑（#369）'
      )
      assert.match(ci, /__ciNeg/, 'check:legacy 的负向对照注入标记（__ciNeg）不见了')
    },
  },
  {
    id: 'W2',
    f10: ['F10-17', 'F10-18', 'F10-19', 'F10-20'],
    name: 'deploy/dl-release/test 的用例真的有执行入口（npm script 覆盖，不再是「写了没人跑」）',
    verify: () => {
      const dir = 'deploy/dl-release/test'
      const files = readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.test.mjs'))
      // #362 域10 §0.1 实测：这里 24 条用例全绿，但 LAYERS 不含 deploy/、也不是 npm script、CI 无步骤。
      assert.ok(files.length >= 3, `${dir} 下的 .test.mjs 至少要有 3 份（变体 / APK 清单 / 服务端契约），实际 ${files.length}`)
      const entries = Object.entries(pkg.scripts ?? {}).filter(([, command]) => command.includes(dir))
      assert.ok(
        entries.length >= 1,
        `${dir} 的用例没有任何 npm script 入口 —— 这就是 #362 说的「今天谁删了都不会有人发现」。` +
          '修法：在 package.json 加 "test:dl-release": "node --test deploy/dl-release/test/*.test.mjs"'
      )
      const [name, command] = entries[0]
      assert.match(command, /--test/, `入口 ${name} 应该用 node --test 跑：${command}`)
      assert.match(command, /\.test\.mjs/, `入口 ${name} 应覆盖 .test.mjs 文件：${command}`)
      // 契约矩阵（N3）本身也必须是这些文件之一，否则「有入口但没跑新用例」
      assert.ok(
        files.includes('domain10-server-contract.test.mjs'),
        `${dir} 里缺域10 的上传契约矩阵（F10-17/18/19/20 的断言在这里）`
      )
      // #415：npm script 只证明「有人能手跑」，还要证明它在**测试体系的枚举口径**里 ——
      // `run-layer` 的 LAYERS 含 `server`，且该层目录就是本目录（LAYER_DIRS）。
      // 少了这一段，`check:test-layout` 的孤儿判定（它实跑 --list）会把这里判红。
      const runner = read('tests/run-layer.mjs')
      assert.match(
        runner,
        /const LAYERS = \[[^\]]*'server'[^\]]*\]/,
        'tests/run-layer.mjs 的 LAYERS 里应有 server 层（#415）—— 去掉它这批用例又回到「写了没人跑」'
      )
      assert.match(
        runner,
        /server: path\.join\(ROOT, 'deploy\/dl-release\/test'\)/,
        'run-layer.mjs 的 LAYER_DIRS 应把 server 层指向 deploy/dl-release/test（#415）'
      )
    },
  },
  {
    id: 'W4',
    f10: ['F10-16'],
    name: '门禁入口自检：每个 check:* 别名 / CI 里 node scripts/*.mjs 都指向真实文件（跑不起来比判红更危险）',
    verify: () => {
      // ① 别名 → 文件：`check:dup-impl` 这类别名如果写成 `scripts/check-dup-impl.mjs`（少了 duplicate），
      //    那条 CI 步骤只会 MODULE_NOT_FOUND 崩掉；脚本还在，但「这道门禁」等于不存在。
      const missing = []
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!name.startsWith('check:')) continue
        for (const m of command.matchAll(/([A-Za-z0-9_.@/-]+\.mjs)/g)) {
          if (m[1].includes('*')) continue
          if (!existsSync(path.join(ROOT, m[1]))) missing.push(`${name} → ${m[1]}`)
        }
      }
      assert.deepEqual(missing, [], `这些门禁别名指向不存在的脚本（点开就是个 MODULE_NOT_FOUND）：${missing.join(', ')}`)

      // ② 反过来：scripts/check-*.mjs 里躺着的每个脚本都得有别名或明确登记，否则没人记得它存在
      const aliased = new Set()
      for (const command of Object.values(pkg.scripts ?? {})) {
        for (const m of command.matchAll(/(check-[A-Za-z0-9_.-]+\.mjs)/g)) aliased.add(m[1])
      }
      const orphans = readdirSync(path.join(ROOT, 'scripts'))
        .filter((name) => /^check-.*\.mjs$/.test(name))
        .filter((name) => !aliased.has(name) && !SCRIPT_WITHOUT_ALIAS.includes(name))
      assert.deepEqual(orphans, [], `这些门禁脚本既没有 npm 别名也没有登记，等于藏起来了：${orphans.join(', ')}`)

      // ③ CI 里以 `node scripts/xxx.mjs` 直接入场的脚本同样必须存在（如 release.yml 的 apk 校验、ci.yml 的负向对照）
      for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
        for (const m of read(file).matchAll(/node (scripts\/[A-Za-z0-9_.@/-]+\.mjs)/g)) {
          if (m[1].includes('*')) continue
          assert.ok(existsSync(path.join(ROOT, m[1])), `${file} 里执行的 ${m[1]} 不存在 —— 这条 CI 步骤会直接崩掉`)
        }
      }
    },
  },
  {
    id: 'W3',
    f10: ['F10-15'],
    name: 'shared/build-types.mjs 改动能反查到用例（不再是「不在已知范围 → 忽略」）',
    verify: async () => {
      assert.ok(existsSync(path.join(ROOT, 'shared/build-types.d.mts')), 'shared/build-types.d.mts 不见了')
      const { tests, notes } = await selectTests(['shared/build-types.mjs'])
      assert.ok(
        tests.length >= 1,
        `改 shared/build-types.mjs 反查到 0 个用例 —— 渠道枚举被改坏不会有任何 L0 报警。` +
          `实际 notes：${notes.join(' | ')}`
      )
      // 反查到的不许只有「域10 自己的用例」：枚举是四处共用的（客户端 / 脚本 / 校验器 / 服务端）
      assert.match(notes.join(' '), /shared\/build-types\.mjs/, 'notes 里应能看出命中的是这条改动')
    },
  },
]

test('域10 接线矩阵的表结构自洽（id 唯一 / 功能点 ID 合法）', () => {
  const ids = new Set()
  for (const row of ROWS) {
    assert.equal(ids.has(row.id), false, `行 id 重复：${row.id}`)
    ids.add(row.id)
    for (const id of row.f10) {
      assert.match(id, /^F10-(0[1-9]|1[0-9]|2[0-2])$/, `${row.id} 的功能点 ID 不合法：${id}`)
    }
  }
  // 4 行：ci.yml / deploy 入口 / which.mjs 反查 / 门禁入口自检（#487 体检补的第 4 条不变量：
  // 前三行都在验「门禁在不在跑」，这一行验「门禁自己还站得住吗」—— 崩溃的门禁同样是零覆盖）
  assert.equal(ROWS.length, 4, 'N6 应正好 4 行（配置 / 入口 / 反查 / 入口自检）')
})

for (const row of ROWS) {
  test(`${row.id} ${row.name}`, async () => {
    await row.verify()
  })
}

test('未接线的门禁有明确交代（不许悄悄躺在 package.json 里当摆设）', () => {
  for (const [gate, reason] of Object.entries(KNOWN_UNWIRED)) {
    assert.ok(reason && reason.length >= 8, `${gate} 的未接线理由太短，等于没有理由`)
    assert.ok(Object.hasOwn(pkg.scripts ?? {}, gate), `${gate} 连 script 都没了，issue 里的登记也失效了`)
    assert.doesNotMatch(
      ci,
      new RegExp(`run: pnpm run ${gate}\\b`),
      `${gate} 已经接进 ci.yml 了 —— 请把这条断言连同 KNOWN_UNWIRED 一起更新（#365/#369）`
    )
    assert.ok(
      Object.hasOwn(pkg.scripts, `${gate.replace('check:', 'check:')}`),
      `${gate} 的 npm script 名对不上`
    )
  }
})
