// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: ~2s（门禁脚本都是纯文本扫描）]
//
// 域10 N2 —— **门禁脚本矩阵**（Issue #362 §3.2 N2 / Issue #369 负向对照）。
//
// 这个文件要回答的问题只有一个：**「门禁绿」是不是因为门禁真的在工作**。
// #369 立项的原因就写在它自己身上 —— 12 道 CI 门禁里有 6 道没有任何负向对照，
// 而 `check:legacy` 的历史教训（beta.8 漏 polyfill → WebView ≤92 白屏）说明
// 「门禁挂了也会绿」的代价是真金白银的用户白屏。
//
// 统一模板（#369 第 4 条要求，全文件只用这一套，不每道门禁各写一套）：
//
//     注入缺陷 → 断言 exit≠0（并断言报错里点出了注入的那一处）
//              → 还原
//              → 断言 exit=0
//
// 表驱动的产物：`ROWS` 一行 = 一道门禁 = 正例 + 反例；`test()` 只是把行注册出去，
// 断言逻辑集中在 `verify(row)` 里，加一道门禁 = 加一行。
//
// 覆盖的功能点（#362 域10 表）：
//   F10-16 清单校验器真的还活着（11 条事故逐条报出）
//   F10-19 debuggable 包四道门都拦（构建 / 上传 / 服务端 / 镜像；本文件管「脚本」这一道）
//   F10-21 版本号只有一个来源（package.json → 清单 → APK → tag；本文件管 tag 一致性那一段）
//   F10-15 渠道枚举只有一份定义（校验器 / 脚本都认同一份）
//
// 本文件**不做**的事（写给后来者，别当成已验）：
//   · 不跑 `tsc` / `oxlint` / `build` 这三道门禁的负向对照 —— 它们要造 TS 类型错 / lint 违规 /
//     构建失败，属于 #369 剩余 TODO（见 PR 与 #369 评论里的清单）；
//   · 不改 `.github/workflows/ci.yml`：负向对照先在 L0 里跑，CI 接线留给 #365 / #369；
//   · 不验「真 APK 的 aapt2 解析」——那要真机/真 aapt2，N3 用假 aapt2 + 真 ZIP/AXML 覆盖服务端顺序。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildApk } from '../fixtures/domain10/apk-fixture.mjs'
import { hasBundle, NO_DIST_REASON } from '../../scripts/lib/bundleTargetAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.join(ROOT, 'dist')

/** 跑一次 node 脚本 / 门禁 CLI，返回 { status, stdout, stderr, out } */
const run = (args, options = {}) =>
  spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, LANG: process.env.LANG ?? 'zh_CN.UTF-8' },
    ...options,
  })

const combined = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`

/** 临时目录（每个反例一份，跑完就删；不在仓库里留垃圾） */
const scratch = () => mkdtempSync(path.join(tmpdir(), 'domain10-gate-'))

/**
 * 注入式负向对照的公共骨架：**注入 → 红 → 还原 → 绿**。
 * `finally` 里一定要还原 —— 用例失败也不能把仓库留在「有违规文件」的状态，
 * 否则下一个人跑 `check:hygiene` 会看到一条与本用例无关的红。
 */
const injectThenRestore = (row, { inject, undo, negative }) => {
  let injected = false
  try {
    inject()
    injected = true
    const red = run(row.args)
    assert.notEqual(
      red.status,
      0,
      `${row.gate}：注入缺陷后必须 exit≠0（负向对照失效 = 门禁空跑）\n--- 输出 ---\n${combined(red)}`
    )
    assert.match(
      combined(red),
      negative.expect,
      `${row.gate}：exit≠0 了，但报错没点出注入的那一处（${negative.expect}）—— 可能红在别的原因上\n--- 输出 ---\n${combined(red)}`
    )
  } finally {
    if (injected) undo()
  }
  // 还原之后必须重新变绿：这一步才是「红不是恒红」的证明
  const green = run(row.args)
  assert.equal(
    green.status,
    0,
    `${row.gate}：还原后必须 exit=0（残留了 ${row.negative?.artifact ?? '注入文件'}？）\n--- 输出 ---\n${combined(green)}`
  )
}

// ---------------------------------------------------------------- 矩阵

/**
 * 一行 = 一道门禁。字段：
 *   id            稳定标识（PR / issue 评论里引用它）
 *   gate          npm script 名（与 package.json 对齐）
 *   f10           覆盖的功能点 ID（#362 域10 表）
 *   args          真正执行的 node 参数（走 scripts/**.mjs，不经 pnpm，避免包管理器差异）
 *   positive      正例：{ expect: 0 | 'skip', when?, match? }
 *   negative      反例：{ mode: 'inject' | 'arg' | 'builtin' | 'todo', ... }
 */
const HYGIENE_PROBE = 'docs/domain10-neg-probe.md'
const DUP_PROBE = 'tests/fixtures/domain10/dup-probe.mjs'

const ROWS = [
  {
    id: 'G1',
    gate: 'check:hygiene',
    f10: ['F10-16'],
    args: ['scripts/check-repo-hygiene.mjs'],
    positive: { expect: 0, match: /check:hygiene OK/ },
    negative: {
      mode: 'inject',
      artifact: HYGIENE_PROBE,
      // #369 点名的三道之一：注入一个 Windows 本机绝对路径 → 必须红
      what: '注入 C:\\Users\\x\\shot.png（本机绝对路径）',
      expect: /domain10-neg-probe\.md:\d+: \[win-drive\]/,
    },
  },
  {
    id: 'G2',
    gate: 'check:dup-impl',
    f10: ['F10-16'],
    args: ['scripts/check-duplicate-impl.mjs'],
    positive: { expect: 0, match: /没有字节完全相同的两份实现/ },
    negative: {
      mode: 'inject',
      artifact: DUP_PROBE,
      // #369 点名的三道之一：把已有 .mjs 原样复制一份 → 必须红
      what: '复制 scripts/lib/bundleTargetAudit.mjs 到 tests/fixtures/domain10/dup-probe.mjs',
      expect: /发现字节完全相同的两份实现[\s\S]*dup-probe\.mjs/,
    },
  },
  {
    id: 'G3',
    gate: 'check:bundle-target',
    f10: ['F10-16'],
    args: ['scripts/check-bundle-target.mjs'],
    // 正例依赖真实产物：单测层跑在 build 之前，缺产物时按仓库既有约定「声明期跳过并具名上报」
    positive: { expect: 0, when: hasBundle(DIST), skipReason: NO_DIST_REASON, match: /产物门禁 E-1\/E-2/ },
    negative: {
      mode: 'inject',
      artifact: '临时目录（dist 副本 / 合成产物）',
      // #369 点名的三道之一：往产物里注入 ??= → 必须红
      what: '往产物副本的 JS 里追加 `??=` / `?.`',
      expect: /低内核解析不了的语法/,
    },
  },
  {
    id: 'G4',
    gate: 'check:manifest',
    f10: ['F10-16'],
    args: ['scripts/check-manifest-fixtures.mjs'],
    positive: { expect: 0, match: /FAIL=0/ },
    // 这道门禁自带正反对（合法 fixture 必过 / invalid-*.json 必拦 / 11 条事故逐条报出），
    // 所以不注入缺陷，而是断言「它自己真的跑了反例」—— 删掉反例侧就会红。
    negative: { mode: 'builtin', what: '自带：invalid-*.json 必须 FAIL、事故清单 11 条逐条报出' },
  },
  {
    id: 'G5',
    gate: 'validate-releases-manifest（check:manifest 的判定内核）',
    f10: ['F10-03', 'F10-15', 'F10-16'],
    args: ['scripts/validate-releases-manifest.mjs', 'deploy/dl-release/fixtures/live-2026-11-18.json'],
    positive: { expect: 0, match: /FAIL=0/ },
    negative: {
      mode: 'arg',
      args: ['scripts/validate-releases-manifest.mjs', 'deploy/dl-release/fixtures/invalid-buildtype-release.json'],
      what: '拿事故清单（11 条 buildType:"release"）当输入',
      expect: /buildType[\s\S]*release/,
      alsoMatch: /FAIL=1/,
    },
  },
  {
    id: 'G6',
    gate: 'check:identity',
    f10: ['F10-02', 'F10-15'],
    args: ['scripts/check-identity.mjs'],
    positive: { expect: 0, match: /应用身份检查通过/ },
    negative: {
      mode: 'todo',
      issue: '#369',
      what: '改 config/appIdentity.json 的 applicationId 造身份漂移',
      why: '会污染工作树（身份文件被改坏 = 设备指纹全变），要等 #369 的统一模板先给出「在副本仓库里跑」的骨架',
    },
  },
  {
    id: 'G7',
    gate: 'check:apk',
    f10: ['F10-19'],
    args: ['scripts/check-apk-debuggable.mjs'],
    positive: { expect: 0, match: /clean|通过/, apk: { debuggable: false } },
    negative: {
      mode: 'arg',
      apk: { debuggable: true },
      what: '拿一个 application 上写着 android:debuggable="true" 的 APK 当输入',
      expect: /debuggable/,
    },
  },
  {
    id: 'G8',
    gate: 'release:check',
    f10: ['F10-21'],
    args: ['scripts/release-check.mjs', '--tag', `v${JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}`],
    positive: { expect: 0, match: /发版前自检通过/ },
    negative: {
      mode: 'arg',
      args: ['scripts/release-check.mjs', '--tag', 'v0.0.0'],
      what: '标签与 package.json 的 version 对不上（v0.0.0）',
      expect: /package\.json 的 version/,
      alsoMatch: /FAIL/,
    },
  },
  {
    id: 'G9',
    gate: 'check:guard',
    f10: ['F10-16'],
    args: ['scripts/check-guard-es5.mjs', 'src/index.html'],
    positive: { expect: 0, match: /兜底守卫没有 ES6\+ 语法/ },
    negative: {
      mode: 'arg',
      what: '拿一份内联守卫里写了 `?.` 的 index.html 当输入',
      expect: /ES6\+ 语法/,
      html: '<!doctype html><html><body><script>var guard = (window.reactNative)?.version;</script></body></html>',
    },
  },
]

// ---------------------------------------------------------------- 断言

const declaredScripts = () => JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {}

test('域10 门禁矩阵的表结构自洽（id 唯一 / 覆盖的功能点都在 22 项之内 / npm script 都存在）', () => {
  const scripts = declaredScripts()
  const ids = new Set()
  for (const row of ROWS) {
    assert.equal(ids.has(row.id), false, `行 id 重复：${row.id}`)
    ids.add(row.id)
    assert.match(row.id, /^G\d+$/, `行 id 必须是 G<数字>：${row.id}`)
    assert.ok(Array.isArray(row.f10) && row.f10.length > 0, `${row.id} 必须标出覆盖的功能点 ID`)
    for (const id of row.f10) {
      assert.match(id, /^F10-(0[1-9]|1[0-9]|2[0-2])$/, `${row.id} 的功能点 ID 不在 F10-01..F10-22 之内：${id}`)
    }
    // 门禁名必须真的存在于 package.json（否则 CI 里那道门禁已经名存实亡）
    if (/^check:|^release:/.test(row.gate)) {
      assert.ok(
        Object.hasOwn(scripts, row.gate),
        `${row.gate} 不在 package.json 的 scripts 里 —— 门禁被改名/删除了？`
      )
    }
  }
  // 三道「注入式」负向对照必须在表里（#369 这次要交付的三道）
  const injected = ROWS.filter((row) => row.negative?.mode === 'inject').map((row) => row.gate)
  assert.deepEqual(
    injected,
    ['check:hygiene', 'check:dup-impl', 'check:bundle-target'],
    `注入式负向对照应正好是 #369 点名的三道，实际：${injected.join(' / ')}`
  )
})

// 一行拆成「正例」与「反例」两条 test：缺口（缺产物）时只有正例被**声明期**跳过，
// 反例照常跑 —— 否则「跳过」会把反例一起吞掉，又变成 #287 那种「报告里看不出没检查」。
for (const row of ROWS) {
  const unavailable = row.positive.when === false
  test(
    `${row.id} 正例 ${row.gate}：干净仓库必过`,
    unavailable ? { skip: `${row.gate} 正例不可用：${row.positive.skipReason}` } : {},
    () => {
      const cleanDir = scratch()
      let clean
      try {
        let args = row.args
        if (row.positive.apk) {
          const apk = path.join(cleanDir, 'release.apk')
          writeFileSync(apk, buildApk({ ...row.positive.apk, versionName: '1.4.0', versionCode: 18 }))
          args = [...row.args, apk]
        }
        clean = run(args)
      } finally {
        rmSync(cleanDir, { recursive: true, force: true })
      }
      assert.equal(
        clean.status,
        0,
        `${row.gate} 正例必须 exit=0（当前仓库自己是干净的）\n--- 输出 ---\n${combined(clean)}`
      )
      if (row.positive.match) {
        assert.match(combined(clean), row.positive.match, `${row.gate} 正例输出里应能看出「它真的检查了」`)
      }
      // 自带正反对的那道（check:manifest）：顺手断言它的反例侧真的跑了
      if (row.negative.mode === 'builtin') {
        assert.match(combined(clean), /ok\s+PASS/i, `${row.gate}：自带的反例里必须有一条「合法必过」`)
        assert.match(combined(clean), /ok\s+FAIL/i, `${row.gate}：自带的反例里必须有一条「非法必拦」`)
      }
    }
  )

  test(
    `${row.id} 反例 ${row.gate}：${
      row.negative.mode === 'todo' ? `TODO(${row.negative.issue}) 未做，显式登记` : '注入/参数造违规必被拦'
    }`,
    () => {
      const negative = row.negative
      if (negative.mode === 'builtin') {
        // 正例那条已经断言过「自带正反对都在」，这里不重复跑
        return
      }
      if (negative.mode === 'todo') {
        // 不做假绿：显式登记「这道门禁目前没有负向对照」，并说明为什么留到 #369
        console.log(`  # TODO(${negative.issue}) ${row.gate} 的负向对照：${negative.what} —— ${negative.why}`)
        return
      }
      if (negative.mode === 'inject') {
        if (row.id === 'G1') {
          injectThenRestore(row, {
            inject: () =>
              writeFileSync(path.join(ROOT, HYGIENE_PROBE), '# 负向对照探针\n\n截图路径：C:\\Users\\x\\shot.png\n'),
            undo: () => rmSync(path.join(ROOT, HYGIENE_PROBE), { force: true }),
            negative,
          })
          return
        }
        if (row.id === 'G2') {
          const target = path.join(ROOT, DUP_PROBE)
          injectThenRestore(row, {
            inject: () => {
              mkdirSync(path.dirname(target), { recursive: true })
              copyFileSync(path.join(ROOT, 'scripts/lib/bundleTargetAudit.mjs'), target)
            },
            undo: () => rmSync(target, { force: true }),
            negative,
          })
          return
        }
        if (row.id === 'G3') {
          // 产物副本优先（真产物上注入最接近 CI 现场）；没有产物时合成一份，
          // 但口径不变：红必须红在「低内核解析不了的语法」上，不能红在「产物未构建」上。
          const dir = scratch()
          const dist = path.join(dir, 'dist')
          mkdirSync(path.join(dist, 'static/js'), { recursive: true })
          mkdirSync(path.join(dist, 'static/css'), { recursive: true })
          const target = path.join(dist, 'static/js/main.neg.js')
          if (hasBundle(DIST)) {
            copyFileSync(path.join(DIST, 'static/js', firstJs(DIST)), target)
            for (const css of allCss(DIST)) {
              copyFileSync(css, path.join(dist, 'static/css', path.basename(css)))
            }
          } else {
            writeFileSync(target, 'const base = 1\nexport default base\n')
            writeFileSync(path.join(dist, 'static/css/main.css'), '.a{color:red}\n')
          }
          try {
            writeFileSync(target, `${readFileSync(target, 'utf8')}\nconst __neg = (globalThis)?.__neg ??= 1\n`)
            const red = run(['scripts/check-bundle-target.mjs', dist])
            assert.notEqual(red.status, 0, `注入 ??= / ?. 后必须 exit≠0\n--- 输出 ---\n${combined(red)}`)
            assert.match(combined(red), negative.expect, `红的原因必须是「语法下限」，实际：\n${combined(red)}`)
            assert.doesNotMatch(combined(red), /产物未构建/, '不能红在「没产物」上（那是另一回事）')
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
          // 还原：原产物目录不该被碰过
          if (hasBundle(DIST)) {
            const again = run(row.args)
            assert.equal(again.status, 0, `还原后 dist/ 必须仍然合格：\n${combined(again)}`)
          }
          return
        }
        assert.fail(`未实现的注入方式：${row.id}`)
      }

      if (negative.mode === 'arg') {
        const dir = scratch()
        try {
          let args = negative.args
          if (negative.apk) {
            const apk = path.join(dir, negative.apk.debuggable ? 'debug.apk' : 'release.apk')
            writeFileSync(apk, buildApk({ debuggable: negative.apk.debuggable, versionName: '1.4.0', versionCode: 18 }))
            args = [...row.args, apk]
          } else if (negative.html !== undefined) {
            const html = path.join(dir, 'index.html')
            writeFileSync(html, negative.html)
            args = [row.args[0], html]
          }
          const red = run(args)
          assert.notEqual(red.status, 0, `${row.gate}：${negative.what} → 必须 exit≠0\n--- 输出 ---\n${combined(red)}`)
          assert.match(combined(red), negative.expect, `${row.gate}：报错要点出真正的原因\n--- 输出 ---\n${combined(red)}`)
          if (negative.alsoMatch) {
            assert.match(combined(red), negative.alsoMatch, `${row.gate}：结论行也要对\n--- 输出 ---\n${combined(red)}`)
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
        return
      }
      assert.fail(`未知的 negative.mode：${negative.mode}`)
    }
  )
}

// ---------------------------------------------------------------- 小工具（产物副本用）

/** dist/static/js 里的第一个 JS（真产物一定叫 main.<hash>.js，但这里不绑死文件名） */
const firstJs = (dist) =>
  (existsSync(path.join(dist, 'static/js')) ? readdirSync(path.join(dist, 'static/js')) : []).find((name) =>
    name.endsWith('.js')
  )

const allCss = (dist) =>
  (existsSync(path.join(dist, 'static/css')) ? readdirSync(path.join(dist, 'static/css')) : [])
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(dist, 'static/css', name))

test('负向对照不会在仓库里留下注入物（跑完自己体检一遍）', () => {
  assert.equal(existsSync(path.join(ROOT, HYGIENE_PROBE)), false, `残留：${HYGIENE_PROBE}`)
  assert.equal(existsSync(path.join(ROOT, DUP_PROBE)), false, `残留：${DUP_PROBE}`)
})
