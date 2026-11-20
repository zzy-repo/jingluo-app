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
//      **G3 的判据本身也是派生的**（不再是一张手写的「门禁 → 正则」表，见下方
//      `deriveCiNegativeControl`）：手写清单一定会漂移，一天内已经漂了三次。
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
 * ── 为什么这一节是**派生**的，而不是一份手写清单（#407 / 第 3 次复发）──────────────
 * 这里原本是一张手写的 `CI_MARKERS` 表（`'check:redact': /check-redact\.mjs\s+--selftest/`
 * 这类「门禁名 → 正则」）。每多一道登记在 ci.yml 上的门禁，就得有人记得**再**回来补一行；
 * 而「记得」恰恰是这一族门禁全部失效的原因本身。实测同一形状在一天内红了三次：
 *   #413 `check:endpoints`（对照已进 ci.yml，判据没跟）→ C8 红（「CI_MARKERS 缺一行」）
 *   #413 `check:i18n`     （同上）                    → C8 红（同上）
 *   #463 `check:doc-refs` （同上）                    → C8 红（同上）
 * 三次都不是门禁坏了，而是「判据清单少一行」。**手写清单一定会漂移** —— 它的正确性依赖
 * 「一个不会忘记的人」，而这个人不存在。所以改成现场派生，链条每一环都从盘上读：
 *
 *     gate（ci.yml 的 `pnpm run <gate>`）
 *       → package.json 里那条 script 命令
 *       → 命令里的脚本文件（`scripts/*.mjs`；`check:legacy` 叫 check-bundle-syntax.mjs，按名字猜必错）
 *       → ci.yml 里**真在跑这个脚本、且带判定**的步骤（`if …; then … exit 1` 或 `--selftest`）
 *
 * 任一环断掉就红，而且报错直接指到**该补的那一环**（补 ci.yml 的对照步骤），
 * 而不是回来补测试里的一行正则 —— 于是「新增门禁忘了同步判据」不可能再以绿的形式漂过去。
 */

/** 吃掉正则元字符（把这些名字拼进判据时用） */
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * gate → 它真正执行的脚本文件，**从 package.json 的命令里解析**，不按门禁名猜。
 * `check:legacy` → `scripts/check-bundle-syntax.mjs`（不同名）；`check:matrix` → 两个脚本。
 * 解析结果为空 = 这道门禁映射不到证据，由 `deriveCiNegativeControl` 报红。
 */
const gateScripts = (gate) => {
  const command = String(pkg.scripts?.[gate] ?? '')
  const found = [...command.matchAll(/(?:^|[\s'"=])((?:scripts|tests)\/[\w./-]+\.mjs)/g)].map((m) => m[1])
  return [...new Set(found)]
}

/**
 * 把 ci.yml 切成一个个 `run:` 块（单行命令 + `|` / `>` 多行块），每块带上所属步骤名
 * （红的时候能直接指到那一步）。按缩进切：多行块的内容行比 `run:` 那一行更深。
 */
const ciRunBlocks = () => {
  const blocks = []
  const lines = ci.split('\n')
  let step = '(未命名步骤)'
  for (let i = 0; i < lines.length; i++) {
    const name = /^\s*-\s*name:\s*(.+)$/.exec(lines[i])
    if (name) step = name[1].trim()
    const run = /^(\s*)run:\s*(.*)$/.exec(lines[i])
    if (!run) continue
    const indent = run[1].length
    const inline = run[2].trim()
    if (!/^[|>]/.test(inline)) {
      blocks.push({ step, body: inline })
      continue
    }
    const body = []
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') {
        body.push('')
        end = j
        continue
      }
      if (lines[j].search(/\S/) <= indent) break
      body.push(lines[j])
      end = j
    }
    blocks.push({ step, body: body.join('\n') })
    i = end
  }
  return blocks
}

/**
 * 一块 `run:` 是不是 `script` 的**负向对照**，且是**真判定**（不是只 echo）。两种合法形状，
 * 都是 ci.yml 里已有的实例：
 *   · `inject`   现场注入：`if node <script> …; then … exit 1`（塞坏输入 → 门禁必须红、必须让流水线红）
 *   · `selftest` 自带反例：`node <script> --selftest`（脚本自己跑反例，失败即 exit≠0）
 * 只 echo / `|| true` / 只跑正例的步骤两种都不满足 —— 那正是 #369 的「绿灯空跑」。
 */
const negativeControlShape = (block, script) => {
  const path = esc(script)
  if (new RegExp(`${path}\\s+--selftest`).test(block.body)) return 'selftest'
  const isIfThen = new RegExp(`if [^\\n]*${path}[^\\n]*;[^\\n]*then`).test(block.body)
  // `exit 1` 必须是**一条独立的命令行**，不能只是 echo 文案里的字样：
  // 这些步骤的最后一句常常是 `echo "… → exit 1，删掉 → exit 0"`，用 `/\bexit 1\b/`
  // 去判会被自己的说明文字骗过去（实测：把真对照里的 `exit 1` 删掉，它照样判绿）。
  const isRealExit = /^[ \t]*exit 1[ \t]*$/m.test(block.body)
  return isIfThen && isRealExit ? 'inject' : null
}

/**
 * 派生「这道门禁在 ci.yml 上的负向对照」：gate → package.json → 脚本文件 → 真判定步骤。
 * 成功返回 `{ gate, script, shape, step }`；失败返回 `{ gate, failure }`（由 G3 报红，
 * 文案指到该补的那一环）。**没有任何手写的例外表可以绕过它** —— 绕过就等于漂移回来了。
 */
const deriveCiNegativeControl = (gate) => {
  const scripts = gateScripts(gate)
  if (scripts.length === 0) {
    return {
      gate,
      failure:
        `\`${pkg.scripts?.[gate] ?? `(package.json 里没有 ${gate})`}\` 里找不到可识别的脚本文件（\`scripts/*.mjs\`），` +
        '判据无法自动派生：把这道门禁的实现落到 scripts/*.mjs，或把它的负向对照挪进 tests/unit/ 的用例',
    }
  }
  const blocks = ciRunBlocks()
  for (const script of scripts) {
    for (const block of blocks) {
      const shape = negativeControlShape(block, script)
      if (shape) return { gate, script, shape, step: block.step }
    }
  }
  return {
    gate,
    failure:
      `ci.yml 里没有 \`${scripts.join('` / `')}\` 的负向对照步骤（门禁本身在跑，但没有东西证明它会红）。` +
      `补法二选一：① 现场注入 \`if node ${scripts[0]} …; then … exit 1\`；` +
      `② 脚本自带 \`--selftest\`（失败即 exit≠0）。只 echo 不判定的步骤不算对照`,
  }
}

/** 证据所在文件是不是「执行入口」：ci.yml 的步骤，或单元层（`pnpm test` 每次都跑）的用例 */
const isUnitLayerTest = (relative) => /^tests\/unit\/[^/]+\.test\.mjs$/.test(relative)

/** 登记在 ci.yml 上的门禁：它们的判据必须从 ci.yml 现场派生，不存在「手写一行」这条路 */
const CI_REGISTERED = GATES.filter((gate) => String(REGISTRY[gate]?.where ?? '').endsWith('.yml'))

// 抽取器自己退化时必须红：ci.yml 里 run 块抽不出来 → 派生会把「没抽到」当成「没有对照」，
// 报出来的红会指错方向（让人去补一条其实已经存在的步骤）。
assert.ok(
  ciRunBlocks().length >= 20,
  `ci.yml 的 run 块抽取退化了：只抽到 ${ciRunBlocks().length} 块（预期 ≥20），派生判据不可信`
)
assert.ok(
  CI_REGISTERED.length >= 4,
  `登记在 ci.yml 上的门禁只抽到 ${CI_REGISTERED.length} 道（预期 ≥4），派生覆盖面退化了：${CI_REGISTERED.join(', ')}`
)

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
      // 指向 ci.yml：判据**从 ci.yml 派生**（gate → script → 真判定步骤），没有手写清单可漂。
      // 派生不出来就红，且红在该补的那一环上。
      const derived = deriveCiNegativeControl(gate)
      assert.ok(derived.failure === undefined, `C8 判据派生失败：${gate} —— ${derived.failure}`)
      checked.push(`${gate}@${derived.script}(${derived.shape})`)
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
  t.diagnostic(
    `C8: 证据可执行 ${checked.length}/${GATES.length} —— ${checked.join(' · ')}\n` +
      `C8: 其中 ${CI_REGISTERED.length} 道登记在 ci.yml 上的由「门禁→script→真判定步骤」现场派生（无手写清单）`
  )
})
