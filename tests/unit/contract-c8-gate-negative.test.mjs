// [layer: unit | 纯 Node，只读 ci.yml / package.json / 登记簿文本 | 耗时: <1s]
//
// C8 —— 门禁必须有**负向对照**，而且那份对照**真的会被执行**（Issue #407 / 防 #369）
//
// 历史事故 #369 / #392：CI 上「门禁绿」不等于「门禁在工作」。最刺眼的是 `check:legacy`：
// beta.8 漏了 polyfill，产物在 WebView ≤92 上整包白屏，而**所有门禁都是绿的** ——
// 因为没有任何一条用例证明「注入一处违规，这道门禁会红」。同一族的第二种失效是
// `deploy/dl-release/test` 那 24 条用例：全绿，却不在任何执行入口（#362 的门禁盘点）。
// 两种都是「写了、没人跑、不会红」。
//
// 本契约锁三条（语义），全部从**动态抽取**的 CI 门禁集合出发（ci.yml 加一行就立刻被算进来）：
//   G1 **接线**：`ci.yml` 里每条 `run: pnpm run <gate>` 都必须在 `package.json` 里有同名 script
//      （改名/删脚本 → 那一步变成空跑，YAML 照样绿）。
//   G2 **登记**：每条 ci 门禁都必须在负向对照登记簿里出现（缺则红）—— 登记簿的**单一来源**
//      是 `tests/unit/gate-negative-controls.test.mjs` 的 `REGISTRY`（#369 落地的那一份），
//      本契约**不维护第二份清单**，只把那份数据当数据读出来比对。
//   G3 **可执行**：登记指向的证据必须有人跑 ——
//      · 指向 `ci.yml` 的：那一步必须还在，且是 `if <门禁>; then exit 1` 这种**真判定**
//        （只 echo 不判定的步骤是假对照）；
//      · 指向 `tests/unit/*.test.mjs` 的：必须落在单元层（`pnpm test` 每次都会跑它），
//        放在任何 LAYERS 之外的目录里都等于没写（#368 的坑）。
//
// 与 `tests/unit/gate-negative-controls.test.mjs` 的 N6 的分工：N6 是**登记簿自己的**自检
// （门禁集合 ↔ 它自己的 REGISTRY）；本契约是外部的**消费者视角**，额外钉住「脚本真的存在」
// 与「证据真的在执行入口里」。两处读同一份 REGISTRY，不各自抄一份。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasFile, installResolveHooks, readJson, readText, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const pkg = readJson('package.json')
const ci = readText('.github/workflows/ci.yml')

/** 负向对照登记簿的唯一来源（#369 落地；`REGISTRY` 是对象字面量，按数据读，不 import 那个用例文件） */
const REGISTRY_FILE = 'tests/unit/gate-negative-controls.test.mjs'

/** ci.yml 里所有 `run: pnpm run <script>` 与 `run: pnpm test` —— 动态抽取，不在测试里抄第二份 */
const ciGates = () => {
  const gates = new Set()
  for (const line of ci.split('\n')) {
    const run = /^\s*run: (?!\|)(.+)$/.exec(line)
    if (!run) continue
    for (const matched of run[1].matchAll(/(?:pnpm|npm) run ([a-zA-Z0-9:_-]+)/g)) gates.add(matched[1])
    if (/(?:pnpm|npm) test(?![:\w-])/.test(run[1])) gates.add('test')
  }
  return [...gates].sort()
}

/**
 * 被对照的门禁集合 = ci.yml 的 `pnpm run <gate>`。
 * `pnpm test`（单元层本身）不算：它是**承载**负向对照的那一层，不是被对照的门禁
 * （与 `gate-negative-controls.test.mjs` 的 N6 用同一口径，两边不会各算一套）。
 */
const GATES = ciGates().filter((gate) => gate !== 'test')
assert.ok(GATES.length >= 16, `ci.yml 里应能抽出 ≥16 道门禁，实际 ${GATES.length}：${GATES.join(', ')}`)

/**
 * 把登记簿里的 `const REGISTRY = { … }` 当**数据**读出来（花括号配平 + `new Function` 求值）。
 * 读不到就直接红：登记簿被改名/被搬走时，这道契约不能假装通过。
 */
const readRegistry = () => {
  const text = readText(REGISTRY_FILE)
  const start = text.indexOf('const REGISTRY = {')
  assert.ok(start >= 0, `${REGISTRY_FILE} 里找不到 \`const REGISTRY = {\`（登记簿被改名/搬走了？）`)
  let depth = 0
  let end = start
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert.ok(end > start, `${REGISTRY_FILE} 的 REGISTRY 花括号没有配平`)
  const literal = text.slice(text.indexOf('{', start), end)
  // 只求值一个纯对象字面量（值里只有字符串 / 正则 / 布尔）：不是任意代码执行
  const registry = new Function(`return (${literal})`)()
  assert.ok(registry && typeof registry === 'object', `${REGISTRY_FILE} 的 REGISTRY 求值结果不是对象`)
  return registry
}

const REGISTRY = readRegistry()

/**
 * 登记指向 `ci.yml` 的门禁：它们的具体负向对照步骤各自长什么样（登记簿只写文件，不写这一句）。
 * 指向 ci.yml 的**每一道**都必须在这里有一句判据，否则「门禁还在、对照被删」查不出来。
 */
const CI_MARKERS = {
  'check:redact': /check-redact\.mjs\s+--selftest/,
  'check:legacy': /__ciNeg/,
}

/** 证据所在文件是不是「执行入口」：ci.yml 的步骤，或单元层（`pnpm test` 每次都跑）的用例 */
const isUnitLayerTest = (relative) => /^tests\/unit\/[^/]+\.test\.mjs$/.test(relative)

test('C8 门禁接线：ci.yml 里跑的每个 script 都必须在 package.json 里真的存在（防空跑）', tableTest(
  'C8-wiring',
  GATES.map((gate) => ({ id: gate, what: `ci.yml 调用了 pnpm run ${gate}` })),
  (row) => {
    assert.ok(
      Object.hasOwn(pkg.scripts ?? {}, row.id),
      `ci.yml 里跑了 \`pnpm run ${row.id}\`，但 package.json 里没有这个 script —— 那一步等于空跑（YAML 照样绿）`
    )
  }
))

test('C8 登记：每条 ci 门禁都必须在负向对照登记簿里（新增门禁忘了登记 → 红，防 #369）', (t) => {
  const unregistered = GATES.filter((gate) => !Object.hasOwn(REGISTRY, gate))
  assert.deepEqual(
    unregistered,
    [],
    `这些 CI 门禁没有负向对照登记：${unregistered.join(', ')}\n` +
      `请在 ${REGISTRY_FILE} 的 REGISTRY 里写清「注入什么缺陷、门禁红在哪」，` +
      '或者登记进 KNOWN_GAPS 并写原因与承接单（没有负向对照的门禁 = #369 那个「绿灯空跑」）'
  )
  t.diagnostic(`C8: ci.yml 里 ${GATES.length} 道门禁全部登记（登记簿 ${REGISTRY_FILE}）`)
})

test('C8 可执行：登记的负向对照必须真的在某个执行入口里，且是真判定（防 #368 写了没人跑）', (t) => {
  const checked = []
  for (const gate of GATES) {
    const entry = REGISTRY[gate]
    if (!entry) continue // 已在 G2 报红，这里不重复报
    assert.ok(hasFile(entry.where), `${gate} 的负向对照指向不存在的文件：${entry.where}`)

    if (entry.where.endsWith('.yml')) {
      // 指向 ci.yml：**这一道**门禁的负向对照步骤必须还在（别的门禁的步骤不能替它作证）
      const marker = CI_MARKERS[gate]
      assert.ok(marker, `${gate} 的负向对照登记在 ci.yml 上，但本契约没有它的判据（CI_MARKERS 缺一行）`)
      assert.match(ci, marker, `ci.yml 里找不到 ${gate} 的负向对照步骤（${marker}）—— 对照被摘掉了`)
      assert.match(
        ci,
        /if node scripts\/check-bundle-syntax\.mjs \/tmp\/dist-neg; then[\s\S]{0,200}exit 1/,
        'check:legacy 的负向对照不是 `if … then exit 1` 形状：门禁红了流水线也不会红（假对照）'
      )
      checked.push(`${gate}@ci.yml`)
      continue
    }

    const sourceText = readText(entry.where)
    const mention = entry.mention instanceof RegExp ? entry.mention : new RegExp(
      String(entry.mention ?? gate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    assert.match(sourceText, mention, `${entry.where} 里不再提到 ${mention} —— 对照可能已被删/搬走`)

    // 用例型证据必须在单元层；脚本型证据（scripts/*.mjs、tests/run-*.mjs）必须被某个 npm script 引用
    const isScript = /^(scripts|tests)\/.*\.mjs$/.test(entry.where) && !entry.where.includes('.test.mjs')
    if (isScript) {
      const referenced = Object.values(pkg.scripts ?? {}).some((command) => command.includes(entry.where))
      assert.ok(referenced, `${entry.where} 没有被任何 npm script 引用 —— 这份「对照」没有任何执行入口`)
    } else {
      assert.ok(
        isUnitLayerTest(entry.where),
        `${gate} 的负向对照落在 ${entry.where}：不在 tests/unit/ 下的用例不会被 \`pnpm test\` 跑到（#368 的坑）`
      )
    }
    checked.push(`${gate}@${entry.where}`)
  }
  t.diagnostic(`C8: 证据可执行 ${checked.length}/${GATES.length} —— ${checked.join(' · ')}`)
})
