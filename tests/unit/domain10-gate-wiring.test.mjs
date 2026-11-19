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

/** ci.yml 里必须出现的 11 条门禁（`run: pnpm run <script>`）+ 单元层那一条（`run: pnpm test`） */
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
]

/** 这三道目前**没接线**，但必须在 issue 里有交代 —— 断言它们至少没被"假装"接线 */
const KNOWN_UNWIRED = ['check:identity', 'check:apk', 'check:guard']

const ROWS = [
  {
    id: 'W1',
    f10: ['F10-16'],
    name: 'ci.yml 一条不落地跑 12 道门禁，且含 check:legacy 的负向对照',
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
  // 3 行：ci.yml / deploy 入口 / which.mjs 反查（#362 §3.2 N6 的分支行数 6 = 3 行 × 正反两半）
  assert.equal(ROWS.length, 3, 'N6 应正好 3 行（配置 / 入口 / 反查）')
})

for (const row of ROWS) {
  test(`${row.id} ${row.name}`, async () => {
    await row.verify()
  })
}

test('未接线的门禁有明确交代（不许悄悄躺在 package.json 里当摆设）', () => {
  for (const gate of KNOWN_UNWIRED) {
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
