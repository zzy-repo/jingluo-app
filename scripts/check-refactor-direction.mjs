#!/usr/bin/env node
/**
 * check-refactor-direction.mjs —— 把 #484 §九「A1–A7 方向验收」变成一条命令（#487 阶段②的输入）。
 *
 * 为什么要有它：#484 §九 的验收口径本来就写着「一条命令 / 一张图」，但那七条命令散在表格里，
 * 靠人一条条贴。重构期间（#487 阶段①）这些项**本来就该是红的**，更没法靠"记得跑"——红成常态
 * 之后就没人分得清"还是重构中"和"真退回去了"。这个脚本只做一件小事：把七项判定钉成同一份
 * 输出（PASS / FAIL / SKIP / MANUAL + 证据行 + 该改哪里），`--report` 只报告不退出非零，
 * 阶段②出验收报告时用 `--json` 直接落机器可读结果。
 *
 * ## 判定口径（只验方向，不验实现 —— #484 §九 原则）
 *
 * | 项 | 验什么 | 判据 | 不判什么 |
 * | --- | --- | --- | --- |
 * | A1 | 旧体系已断 | `src/` `android/` 里 0 处 `140.210.13.146` / `:60013` / `device_id` 鉴权参数 | 不查残留变量名 |
 * | A2 | 调用归位白名单 | 跑 `scripts/check-consume-api.mjs`，exit 0 | 不判调用写得好不好 |
 * | A3 | 身份走 JWT | `src/` 有 `auth/login` / `auth/register` 调用；`Bearer` 使用处能分出 JWT 与 `sk-` 两条通道 | 不查 token 存哪、怎么刷新 |
 * | A4 | 额度来自后端 | `src/` 无 `remaining_points` / `pointsCache` / 本地余额持久化 | 不查缓存策略 |
 * | A5 | 卡密方向对 | `src/` 有 `api/v1/redeem`，且有 `redeem/history`（幂等补偿痕迹） | 不查重试几次、退避算法 |
 * | A6 | base 配置化 | `config/endpoints.json` 有 `consume` / `pay`；`src/`（排除测试）无后端域名 https 字面量 | 不查注入实现细节 |
 * | A7 | UI 收敛 | **不自动检查**，恒为 MANUAL，输出「需人工截图确认」 | 不评布局/配色/文案 |
 *
 * 三条实现约定（都是为了"别把它做成第二个产品规范"）：
 *
 * 1. **注释行也算命中**。A1 的原文口径是 `grep → 0 命中`，注释里写 `GET /me?device_id=…` 一样会
 *    被下一个人照抄。命中标注 `[注释]`，提示只要求"把描述改成文字"，不要求改代码。
 * 2. **A3 的通道判定只看行内文本**（`accessToken` / `jwt` ↔ `sk-` / `apiKey` / `x-api-key`），
 *    或在同一行写 `// JWT` / `// sk-` 标死。这条是启发式，不是命名规范 —— 判不出来时的提示
 *    就是"要么改名，要么标一行"，不会因为函数叫 `token` 而悄悄算通过。
 * 3. **生成目录不进扫描范围**（#590 ①）。`android/app/src/main/assets/**` 是 `cap sync android`
 *    从 `dist` 拷进去的产物，`.gitignore` 已忽略、`git ls-files` 为 0 条：本地跑过一次 cap sync
 *    就有它、CI 干净 checkout 没有它。同一份代码因此会**本地红、CI 绿**，两种结论都不可信 ——
 *    门禁判的是仓库里的源码，不是本机上次构建的残渣。跳过时会打印「已跳过生成目录 N 个文件」，
 *    **不是静默放行**（口径见 `GENERATED_DIRS`；负向对照见文件末 #590 一节的用法）。
 * 4. **A6 的 https 判据允许回环例外**（`127.0.0.1` / `localhost` / `[::1]`）。本地联调的 sub2api
 *    实例跑在 `http://127.0.0.1:18000`，回环地址上的明文是开发环境的正当需求；**非回环明文仍然
 *    判红**（生产 host 必须是 https，见 `scripts/lib/consumeEndpoints.mjs` 与 build 期校验）。
 * 5. **A6 只拦"后端域名"**。`src/` 里的 `https://www.unicode.org`、`https://api.deepseek.com`
 *    这类上游/文档地址不算违规 —— 后端域名白名单来自 `config/endpoints.json`（`allowedHosts` /
 *    `legacyHosts` / 两组 `download` / `consume` / `pay` 的 host），外加 #484 §一 写死的支付域名
 *    与任何 IP 字面量 URL。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-refactor-direction.mjs            # 门禁模式：有任何 FAIL → exit 1
 * node scripts/check-refactor-direction.mjs --report   # 报告模式：只报告，恒 exit 0（重构期用它）
 * node scripts/check-refactor-direction.mjs --json     # 机器可读结果打到 stdout（阶段②出验收报告）
 * node scripts/check-refactor-direction.mjs --json out.json --report
 * pnpm check:refactor-direction --report
 * ```
 *
 * **已接进 CI**（#590，2026-11-20）：`ci.yml` 里 `pnpm run check:refactor-direction` 紧跟一条
 * 负向对照（生成目录里的旧池域地址必须**仍然 exit 0**、src/ 里同一条必须 exit 1、删掉后 exit 0）。
 * 接线的前提是**先全绿** —— #487 阶段②把它建出来时 A1/A4/A6 全是 FAIL，接一道恒红的门禁等于
 * 没有门禁，所以等 #590 把三项降到 0 命中之后再接的。**别在它重新变红时把这一步摘掉**：
 * 这道门禁判的不是「这一处有没有违规」，而是「重构的方向还在不在」。
 *
 * ## 退出码
 *
 * `0` 通过（或 `--report` 模式下无论如何）/ `1` 有 FAIL（仅门禁模式）/ `2` 用法或环境错误。
 *
 * ## 负向对照（改这个脚本之前先证明它还会咬）
 *
 * 重构期基线全红，「注入一条看它变不变」看不出差别 —— 所以用 `--root` 指向一个**合成仓库**
 * （一个文件就能让六项全绿），再逐项注入：
 *
 * ```bash
 * mkdir -p /tmp/rdctl/{src/consume,scripts,android,config}
 * # config/endpoints.json 写好 consume/pay 两组；src/consume/*.ts 写一行 auth/login、
 * # 一行 Bearer ${accessToken}、一行 Bearer ${apiKey}、一行 '/redeem'、一行 '/redeem/history'
 * # scripts/check-consume-api.mjs 先写个 exit 0 的桩
 * node scripts/check-refactor-direction.mjs --root /tmp/rdctl            # → A1–A6 全 PASS，exit 0
 * printf "export const p = 'https://apia.ecsafe.cn/api/plans'\n" >> /tmp/rdctl/src/consume/auth.ts
 * node scripts/check-refactor-direction.mjs --root /tmp/rdctl            # → A6 FAIL，exit 1
 * ```
 *
 * 已知的连带：往 src 塞一条旧池域地址会**同时**让 A1 与 A6 红（地址既是旧体系、也是字面量）——
 * 这是对的，两项本来就从不同角度看同一处违规。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bothUnifiedBase } from './lib/consumeEndpoints.mjs'
import { isCommentOnlyLine } from './lib/textLines.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** A2 的实体：跑它（不是复制它的规则） */
const CONSUME_API_GATE = 'scripts/check-consume-api.mjs'

/** 端点配置（A6 的唯一事实来源） */
const ENDPOINTS_FILE = 'config/endpoints.json'

/** 每条判定的证据最多打印多少条样本行（其余只计数） */
const MAX_SAMPLES = 5

/** 进来也不看的目录名（任意层级）：依赖 / 产物 / 构建缓存 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-scroll',
  'dist-internal',
  'coverage',
  'build',
  '.gradle',
  '.git',
  '.idea',
  '.cxx',
  '.vite',
  '.workflow-lite',
  '.work-compat',
])

/**
 * **生成目录**（相对仓库根，前缀匹配）：`cap sync` / 构建产物，**不进扫描范围**（#590 ①）。
 *
 * 为什么必须跳过：`android/app/src/main/assets/public/` 是 `pnpm exec cap sync android` 把 `dist`
 * 原样拷进去的结果 —— `.gitignore:11` 已忽略、`git ls-files` 为 **0 条**。于是同一份代码在两种
 * 机器上得到两种结论：
 *   - 本地（跑过一次 cap sync，或按 docs/TESTING-POLICY 第 8/9.6 节做过 gradle 配置校验）：
 *     `static/js/main.*.js` 就在盘上，A1 命中里面还没重打的历史 IP → **红**；
 *   - CI（干净 checkout）：那些文件根本不存在 → **绿**。
 * 门禁要判的是**仓库里的源码**，不是"本机上次构建留下的残渣"。继续把生成目录算进来的后果不是
 * 「更严格」，而是「结论不可复现」：谁在本地复跑都能得出不同的 A1 命中数，收口就永远说不清。
 *
 * 跳过是**写进输出**的（`已跳过生成目录 N 个文件`），不是静默放行；而且**范围只到这一条前缀**——
 * 同一个目录里如果放了人写的源码（理论上不该有），要先把源码搬出 assets/ 再来谈豁免。
 * 负向对照（#590 验收项）：在该目录里放一个含旧池域 IP 的文件 → 命中数**不变**；
 * 同时在 `src/` 里放一个同样的文件 → 命中数**必须 +1**（证明不是整体失明）。
 */
const GENERATED_DIRS = ['android/app/src/main/assets/']
const isGeneratedPath = (relPath) => GENERATED_DIRS.some((dir) => relPath.startsWith(dir))

/** 只看会进产物 / 会打真实请求的文本（图片与二进制一律跳过） */
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.java',
  '.kt',
  '.gradle',
  '.xml',
  '.json',
  '.css',
  '.html',
  '.properties',
  '.pro',
])

const USAGE = `把 #484 §九 的 A1–A7 方向验收跑成一条命令

用法:
  node scripts/check-refactor-direction.mjs [--report] [--json [文件]] [--root 目录] [--selftest]

  --selftest     A6 的负向对照：https / 回环 → PASS，非回环明文 → 必须 FAIL（证明例外没放水）
  --report       报告模式：只报告，不因 FAIL 退出非零（重构期用它，CI 暂时别接）
  --json [文件]  输出机器可读结果；不给文件名就打 stdout（阶段②出验收报告用）
  --root 目录    换一个仓库根（默认脚本所在的仓库）
  -h, --help     这张说明

退出码: 0 通过（或 --report）/ 1 有 FAIL（仅门禁模式）/ 2 用法或环境错误`

// ---------------------------------------------------------------------------
// 通用扫描（一次遍历，后面各项都在同一份语料上跑）
// ---------------------------------------------------------------------------

const collectFiles = (dir, out) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
  return out
}

const relOf = (root, file) => path.relative(root, file).split(path.sep).join('/')

/**
 * 读盘：`Map<仓库相对路径, 行数组>`。读不了的文件直接跳过（不谎报"扫过"）。
 *
 * `skipped`：被 `GENERATED_DIRS` 挡掉的生成目录文件数（#590 ①）—— 由调用方打到输出里，
 * 「跳过」这件事必须是可见的，否则下一个人会以为扫描器真的读了那些文件。
 */
const readCorpus = (root, dirs) => {
  const files = []
  for (const dir of dirs) collectFiles(path.join(root, dir), files)
  const corpus = new Map()
  const skipped = []
  for (const file of files) {
    const rel = relOf(root, file)
    if (isGeneratedPath(rel)) {
      skipped.push(rel)
      continue
    }
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    corpus.set(rel, text.split('\n'))
  }
  return { corpus, skipped }
}

/**
 * 「白名单标记」—— 与 `scripts/check-hardcoded-ip.mjs`（`check:ip`）**同一个 token、同一套语义**
 * （#590 ②）：同一行、或紧跟其上的前一行带 `check-ip-allow` 的字面量，不判违规。
 *
 * 为什么 A1 需要它：A1 的判据是「`140.210.13.146` / `:60013` 在 `src/` `android/` 里 grep 到 0 命中」，
 * 但**废弃域黑名单本身**必须把这个地址写出来才能拦住它 ——
 * `android/app/build.gradle` 的 `CONSUME_DEPRECATED_MARKERS` 就是拿它去比对 `consume.baseUrl` /
 * `pay.baseUrl` / `legacyHosts`（同文件 :211），`scripts/lib/consumeEndpoints.mjs` 的
 * `DEPRECATED_MARKERS` 是同一份名单的 Node 侧副本。把「拦旧域的清单」判成「旧域还在用」是纯粹的
 * 自反错误：名单删掉，等于把这道 build 期拦截一起删掉（那才是真的退回旧体系）。
 *
 * 约束（防止它变成万能后门）：
 *   - 只对 A1 的**字面量规则**生效（`LEGACY_ADDRESS_RULES`）；`device_id` 那两条规则不给标记豁免 ——
 *     「用 device_id 当凭据」没有「必须写出 device_id 才能拦它」的等价情形。
 *   - 标记必须带理由（`check-ip-allow：<理由>`），A1 会把命中的白名单行**逐条打出来**
 *     （`↪ 白名单`），不是静默丢弃：谁加的、为什么加，评审时看得见。
 *   - 只认「同一行 / 紧邻上一行」，不做整文件豁免 —— 一个文件里写一条标记就全文件免检，那就等于没有门禁。
 */
const ALLOW_MARKER = /check-ip-allow/u

/** 该行（或紧邻的上一行）有没有白名单标记；有就返回理由文本 */
const allowReasonOf = (lines, index) => {
  for (const candidate of [lines[index], index > 0 ? lines[index - 1] : '']) {
    if (typeof candidate === 'string' && ALLOW_MARKER.test(candidate)) return candidate.trim()
  }
  return null
}

/**
 * 在语料里找命中行。
 *
 * @param {Map<string, string[]>} corpus 语料
 * @param {(line: string, file: string) => boolean} test 行判定（第二个参数是文件，供「同文件里有前缀」这类判定用）
 * @param {{ skip?: (file: string) => boolean, allowMarker?: boolean }} [options]
 *   `skip` 用来排除测试文件之类；`allowMarker` 为真时认 `check-ip-allow` 白名单（只有 A1 的字面量规则开它）
 * @returns {{ file: string, line: number, text: string, comment: boolean, allow?: string }[]}
 */
const findLines = (corpus, test, options = {}) => {
  const hits = []
  for (const [file, lines] of corpus) {
    if (options.skip && options.skip(file)) continue
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]
      if (!test(text, file)) continue
      const hit = { file, line: index + 1, text: text.trim(), comment: isCommentOnlyLine(text) }
      const allow = options.allowMarker ? allowReasonOf(lines, index) : null
      if (allow) hit.allow = allow
      hits.push(hit)
    }
  }
  // 代码行排在注释行前面：样本只打前几条，先给"真的会跑的那几行"
  return hits.sort((a, b) => Number(a.comment) - Number(b.comment))
}

/** 样本行排版：`src/a.ts:12  <text>`（注释行标 [注释]，超过 120 字截断） */
const formatSample = (hit) => {
  const flag = hit.comment ? '[注释] ' : ''
  const text = hit.text.length > 120 ? `${hit.text.slice(0, 120)}…` : hit.text
  return `${hit.file}:${hit.line}  ${flag}${text}`
}

/** 把命中压成「计数 + 前 N 条样本」两段证据 */
const evidenceOfHits = (label, hits) => {
  const lines = [`${label}：命中 ${hits.length} 处`]
  for (const hit of hits.slice(0, MAX_SAMPLES)) lines.push(`    ${formatSample(hit)}`)
  if (hits.length > MAX_SAMPLES) lines.push(`    …另有 ${hits.length - MAX_SAMPLES} 处（见 --json）`)
  return lines
}

const countBy = (hits) => ({ total: hits.length, code: hits.filter((h) => !h.comment).length })

/** 哪些文件里出现过 JWT 前缀（`/api/v1` 或 `apiV1Prefix`）—— 路径常是拼出来的，字面量看不到全路径 */
const filesWithJwtPrefix = (corpus) => {
  const files = new Set()
  for (const [file, lines] of corpus) {
    if (lines.some((line) => /api\/v1|apiV1Prefix/u.test(line))) files.add(file)
  }
  return files
}

/** 「只有注释命中」—— 提示语要跟着变：不用改代码，改描述即可 */
const commentOnly = (hits) => hits.length > 0 && hits.every((hit) => hit.comment)

// ---------------------------------------------------------------------------
// A1 旧体系已断
// ---------------------------------------------------------------------------

/** 旧池域地址：命中即 FAIL（注释也算，口径 #484 §九 A1「grep → 0 命中」） */
const LEGACY_ADDRESS_RULES = [
  // check-ip-allow：旧池域黑名单，A1 的判定对象（不是可调地址；地址一律来自 config/endpoints.json）
  { what: '旧池域 IP 140.210.13.146', test: (line) => /140\.210\.13\.146/u.test(line) },
  { what: '旧池域端口 :60013', test: (line) => /:60013\b/u.test(line) },
]

/** `device_id` 当鉴权参数用（#484 §七.3：该体系已废弃；§二：key/token 不进 query） */
const DEVICE_AUTH_RULES = [
  {
    what: 'device_id 与 Authorization/Bearer 同行',
    test: (line) => /device_?id/iu.test(line) && /authorization|bearer/iu.test(line),
  },
  {
    what: 'device_id / X-Device-Id 作为请求参数或请求头',
    test: (line) => /[?&]device_id=/iu.test(line) || /x-device-id/iu.test(line),
  },
]

/**
 * A1 的扫描口径（#590 收口时钉死）：
 *   - 语料 = `src/` + `android/`，**排除生成目录**（`GENERATED_DIRS`：cap sync 产物，git 未跟踪）；
 *   - 字面量规则认 `check-ip-allow` 白名单（只认「同一行 / 紧邻上一行」，且逐条打印），
 *     `device_id` 规则**不认**（没有「必须写出 device_id 才能拦它」的等价情形）。
 */
const checkA1 = (corpus, skippedGenerated = []) => {
  const results = [
    ...LEGACY_ADDRESS_RULES.map((rule) => ({
      what: rule.what,
      hits: findLines(corpus, rule.test, { allowMarker: true }),
    })),
    ...DEVICE_AUTH_RULES.map((rule) => ({ what: rule.what, hits: findLines(corpus, rule.test) })),
  ]
  // 白名单行从「违规」里摘出来，但**逐条报出来**：它们不是违规，也不许变成隐形豁免
  const allowed = results.flatMap((result) => result.hits.filter((hit) => hit.allow))
  const resultsVerdict = results.map((result) => ({
    what: result.what,
    hits: result.hits.filter((hit) => !hit.allow),
  }))
  const all = resultsVerdict.flatMap((result) => result.hits)
  const evidence = [
    `扫描 src/ + android/：${corpus.size} 个文件` +
      (skippedGenerated.length > 0
        ? `（已跳过生成目录 ${skippedGenerated.length} 个文件：${GENERATED_DIRS.join(' / ')}**，cap sync 产物不入库）`
        : `（生成目录 ${GENERATED_DIRS.join(' / ')}** 本机不存在，跳过 0 个文件）`),
  ]
  for (const result of resultsVerdict) evidence.push(...evidenceOfHits(result.what, result.hits))
  if (allowed.length > 0) {
    // 同一行可能同时命中「IP」与「端口」两条规则：按 文件:行 去重，别把一条名单印两遍
    const allowedLines = [...new Map(allowed.map((hit) => [`${hit.file}:${hit.line}`, hit])).values()]
    evidence.push(
      `白名单（check-ip-allow，共 ${allowedLines.length} 处）：这些字面量是「废弃域黑名单」的定义，` +
        '用来拦住旧域、不是可调地址 —— 判红等于把这道拦截删掉：',
    )
    for (const hit of allowedLines) evidence.push(`    ↪ ${formatSample(hit)}`)
    if (allowedLines[0]?.allow) evidence.push(`      理由：${allowedLines[0].allow}`)
  }

  if (all.length === 0) {
    return {
      id: 'A1',
      title: '旧体系已断',
      status: 'PASS',
      evidence,
      hints: [],
      stats: {
        files: corpus.size,
        hits: 0,
        whitelisted: allowed.length,
        skippedGenerated: skippedGenerated.length,
      },
    }
  }

  const hints = []
  const addressCode = resultsVerdict
    .slice(0, LEGACY_ADDRESS_RULES.length)
    .flatMap((result) => result.hits)
    .filter((hit) => !hit.comment)
  const addressComment = resultsVerdict
    .slice(0, LEGACY_ADDRESS_RULES.length)
    .flatMap((result) => result.hits)
    .filter((hit) => hit.comment)

  if (addressCode.length > 0) {
    hints.push(
      `旧池域调用点代码行 ${addressCode.length} 处：删掉它们（#487 的清理项），地址只能来自 ` +
        `${ENDPOINTS_FILE} 的 consume/pay —— 源码里不许再拼 IP / 端口。`,
    )
  }
  if (addressComment.length > 0) {
    hints.push(
      `旧池域地址只剩注释行（${addressComment.length} 处）：改写成「旧池域（已废弃）」这类不含 ` +
        'IP/端口 的描述即可 —— #484 A1 的口径是 grep 0 命中，注释里留着会被下一个人照抄。',
    )
  }
  const deviceHits = resultsVerdict.slice(LEGACY_ADDRESS_RULES.length).flatMap((result) => result.hits)
  if (deviceHits.length > 0) {
    hints.push(
      `device_id 不再当鉴权参数（#484 §二 / #253 已作废）：身份走 POST /api/v1/auth/login，` +
        'token 放 Authorization: Bearer <access_token>；query 只放业务参数，不放身份。',
    )
  }

  return {
    id: 'A1',
    title: '旧体系已断',
    status: 'FAIL',
    evidence,
    hints,
    stats: {
      files: corpus.size,
      ...countBy(all),
      whitelisted: allowed.length,
      skippedGenerated: skippedGenerated.length,
    },
  }
}

// ---------------------------------------------------------------------------
// A2 调用归位白名单（跑 #484 §八.2 那道门禁，不复制它的规则）
// ---------------------------------------------------------------------------

const checkA2 = (root) => {
  const script = path.join(root, CONSUME_API_GATE)
  if (!fs.existsSync(script)) {
    return {
      id: 'A2',
      title: '调用归位白名单',
      status: 'SKIP',
      evidence: [
        `${CONSUME_API_GATE} 还不存在 → 本项跳过（记 SKIP，不计 FAIL）`,
        'A2 的实体是 #484 §八.2 的 `check:consume-api` 门禁；它落地后本项自动开始判定，',
        '不用回来改这个脚本（这里只负责调用它并看 exit code）。',
      ],
      hints: [
        `等 W1-A / 门禁单把 ${CONSUME_API_GATE} 建出来；在那之前「白名单外路径零出现」这件事` +
          '没有任何自动证据，A2 不算通过。',
      ],
      stats: { ran: false },
    }
  }

  const started = Date.now()
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const durationMs = Date.now() - started
  const code = result.status === null ? 1 : result.status
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  const tail = output.slice(-MAX_SAMPLES * 2)

  const evidence = [
    `命令：node ${CONSUME_API_GATE} → exit ${code}（${durationMs}ms）`,
    ...tail.map((line) => `    ${line}`),
  ]
  if (result.error) evidence.push(`    spawn 失败：${result.error.message}`)

  if (code === 0) {
    return {
      id: 'A2',
      title: '调用归位白名单',
      status: 'PASS',
      evidence,
      hints: [],
      stats: { ran: true, exitCode: 0, durationMs },
    }
  }

  return {
    id: 'A2',
    title: '调用归位白名单',
    status: 'FAIL',
    evidence,
    hints: [
      '白名单外路径 / 旧池域 / 明文 http / device_id 鉴权里有命中：按上面打印的 `文件:行` 逐条' +
        '改，路径只能取 #484 §三 的端点表（新增能力要先改 #484 重新评审，不许客户端先上）。',
      '若红是门禁自身规则不对（例如把上游 provider 域名误判成后端域名），改门禁 + 补一条负向对照，' +
        '别在这里绕过。',
    ],
    stats: { ran: true, exitCode: code, durationMs },
  }
}

// ---------------------------------------------------------------------------
// A3 身份走 JWT
// ---------------------------------------------------------------------------

/** 登录 / 注册调用（JWT 通道的入口；注释行不算调用） */
const AUTH_ENDPOINT = /\bauth\/(?:login|register)\b/u
/** 拼路径时的写法：`'/login'` / `\`/register\`` —— 只有在声明了 JWT 前缀的文件里才算 */
const AUTH_SEGMENT = /["'`]\/?(?:login|register)["'`]/u
/**
 * 「Bearer 使用处」= 代码行里在**认证头上下文**出现的 Bearer。
 * 只看 `Bearer` 字面量会把脱敏规则（`sk- / Bearer / Signature=`）和注释里的协议说明也算成一个
 * 通道，那些不是"使用处"。所以要求同一行里有 `Authorization` 头，或 `Bearer ${…}` / `Bearer sk-`
 * 这种真的在拼请求头的写法。
 */
const BEARER_SITE = (line) =>
  /bearer/iu.test(line) &&
  (/authorization/iu.test(line) || /bearer\s+\$\{|bearer\s+sk-/iu.test(line) || /x-api-key/iu.test(line)) &&
  !isCommentOnlyLine(line) &&
  // 类型声明（`type ProviderAuth = 'x-api-key' | 'bearer'`）是在描述通道枚举，不是使用处
  !/^\s*(?:export\s+)?(?:type|interface)\s/u.test(line)
/** 两条通道的行内语义词：JWT 侧 */
const JWT_WORDS = /access[-_]?token|refresh[-_]?token|\bjwt\b|bearer[-_]?token|sessionToken/iu
/** 两条通道的行内语义词：API Key 侧 */
const KEY_WORDS = /sk-|api[-_]?key|apikey|x-api-key/iu
/** 显式标死通道（判不出来时的逃生口，不是命名规范） */
const JWT_MARK = /\/\/\s*JWT\b/u
const KEY_MARK = /\/\/\s*sk-/u

const checkA3 = (corpus) => {
  const jwtFiles = filesWithJwtPrefix(corpus)
  const authCalls = findLines(
    corpus,
    (line, file) =>
      !isCommentOnlyLine(line) &&
      (AUTH_ENDPOINT.test(line) || (AUTH_SEGMENT.test(line) && jwtFiles.has(file))),
  )
  const bearerLines = findLines(corpus, BEARER_SITE)

  const jwtSites = []
  const keySites = []
  const unknownSites = []
  const mixedSites = []
  for (const hit of bearerLines) {
    const jwt = JWT_WORDS.test(hit.text) || JWT_MARK.test(hit.text)
    const key = KEY_WORDS.test(hit.text) || KEY_MARK.test(hit.text)
    if (jwt && key) mixedSites.push(hit)
    else if (jwt) jwtSites.push(hit)
    else if (key) keySites.push(hit)
    else unknownSites.push(hit)
  }

  const evidence = [
    `auth/login|auth/register 调用（代码行）：${authCalls.length} 处`,
    ...authCalls.slice(0, MAX_SAMPLES).map((hit) => `    ${formatSample(hit)}`),
    `Bearer 使用处：JWT 通道 ${jwtSites.length} / sk- 通道 ${keySites.length} / 分不出 ${unknownSites.length} / 混用 ${mixedSites.length}`,
    ...jwtSites.slice(0, 2).map((hit) => `    [JWT] ${formatSample(hit)}`),
    ...keySites.slice(0, 2).map((hit) => `    [sk-] ${formatSample(hit)}`),
    ...unknownSites.slice(0, 2).map((hit) => `    [分不出] ${formatSample(hit)}`),
  ]
  if (unknownSites.length > 0) {
    evidence.push('（「分不出」= 行内既没有 JWT 语义词也没有 sk-/API Key 语义词，不计入任何一条通道）')
  }
  if (authCalls.length === 0 && bearerLines.length === 0) {
    evidence.push('src/ 里既没有 auth 调用也没有 Bearer 使用处 —— 消费层还没接（重构期正常）')
  }

  const failures = []
  if (authCalls.length === 0) failures.push('auth-missing')
  if (jwtSites.length === 0) failures.push('jwt-channel-missing')
  if (keySites.length === 0) failures.push('key-channel-missing')
  if (mixedSites.length > 0) failures.push('channels-mixed')

  if (failures.length === 0) {
    return {
      id: 'A3',
      title: '身份走 JWT',
      status: 'PASS',
      evidence,
      hints: [],
      stats: {
        authCalls: authCalls.length,
        jwtSites: jwtSites.length,
        keySites: keySites.length,
        unknownSites: unknownSites.length,
      },
    }
  }

  const hints = []
  if (failures.includes('auth-missing')) {
    hints.push(
      '`src/` 里找不到 `auth/login` / `auth/register` 调用：身份入口应落在 ' +
        '`POST /api/v1/auth/login` 与 `POST /api/v1/auth/register`（#484 §3.1），' +
        '首启改为注册/登录而不是设备码。',
    )
  }
  if (failures.includes('jwt-channel-missing')) {
    hints.push(
      '找不到 JWT 通道的 Bearer 使用处：`/api/v1/**` 的请求要带 ' +
        '`Authorization: Bearer <access_token>`（#484 §二）。行内看不出通道时，' +
        '把变量写作 accessToken/jwt，或在该行写 `// JWT` 标死（脚本按行内文本判定）。',
    )
  }
  if (failures.includes('key-channel-missing')) {
    hints.push(
      '找不到 sk- Key 通道的 Bearer 使用处：`/v1/**`（聊天转发 / `/v1/usage`）走 ' +
        '`Bearer sk-…` 或 `x-api-key`。两条通道必须各自存在、不许合并成一个 helper。',
    )
  }
  if (failures.includes('channels-mixed')) {
    hints.push(
      '同一处 Bearer 同时出现 JWT 与 sk- 的语义词（或用 `??` / `||` 把两种 token 接在一起）：' +
        '两条通道要分开（#484 §二「两条独立通道，不许混用」）。',
    )
  }

  return {
    id: 'A3',
    title: '身份走 JWT',
    status: 'FAIL',
    evidence,
    hints,
    stats: {
      authCalls: authCalls.length,
      jwtSites: jwtSites.length,
      keySites: keySites.length,
      unknownSites: unknownSites.length,
      mixedSites: mixedSites.length,
    },
  }
}

// ---------------------------------------------------------------------------
// A4 额度来自后端（客户端不再当账本）
// ---------------------------------------------------------------------------

/**
 * ## 豁免规则（#590 收口时钉死：**当前一条都没有**）
 *
 * 口径是「客户端不再持有消费账本」，判据是**行内字面量**（注释行也算）。曾经出现过一类灰色情形：
 * 旧设备码体系的服务层（`services/invite/**`）把服务端响应里的额度字段原样解析进展示结构 ——
 * 它不是账本、不落盘、不参与「能不能发送」的判断，但字段名一样会命中这条规则。
 *
 * #590 的处置是**按「调用点归零就删」办，不开口子**：`OursServicesDialog`（唯一调用方）随 #562
 * 退役之后，`invite/{api,bind,rotate,email,openFlow,copy}.ts` 在 `src/` 里引用数归零
 * （`git grep -c "services/invite/\(api\|bind\|rotate\|email\|openFlow\|copy\)\.js" -- src` → 0），
 * 于是 20 处命中随文件一起删除，**不需要任何豁免**。
 *
 * 给后来人的规矩：**先查调用点**。
 *   - 调用点为 0 → 删代码（真的减少），不要把字段名改个花名骗过这条正则；
 *   - 调用点 > 0 → 说明还有活路径，**先在这段注释里写清「哪条路径、为什么必须留、谁来收」**
 *     并同步进 Issue，才允许把它判成「仍在生产路径，不计入」。没有这条记录的放宽一律视为放水 ——
 *     与「不许为了绿而硬删」是同一条纪律的两面。
 */
const LEDGER_RULES = [
  { what: '本地余额账本字段 remaining_points', test: (line) => /remaining[_-]points/iu.test(line) },
  {
    what: '本地余额缓存 pointsCache / points_cache',
    test: (line) => /points[_-]?Cache/iu.test(line),
  },
  {
    what: '余额/额度落本地存储（storage 与余额同行）',
    test: (line) =>
      /localStorage|sessionStorage|indexedDB|idb\b|secureStorage|Preferences/iu.test(line) &&
      /balance|quota|points|credits|额度|余额/iu.test(line),
  },
]

/** 正向参考（不判定）：额度到底从哪读 */
const QUOTA_SOURCE = /v1\/usage|\/user\/profile|\/api\/v1\/usage/u

const checkA4 = (corpus) => {
  const results = LEDGER_RULES.map((rule) => ({ what: rule.what, hits: findLines(corpus, rule.test) }))
  const all = results.flatMap((result) => result.hits)
  const quotaSource = findLines(corpus, (line) => QUOTA_SOURCE.test(line))

  const evidence = [`扫描 src/：${corpus.size} 个文件（注释行也计入）`]
  for (const result of results) evidence.push(...evidenceOfHits(result.what, result.hits))
  evidence.push(
    `参考（不判定）：额度读取端点 v1/usage|user/profile 命中 ${quotaSource.length} 处` +
      (quotaSource.length === 0 ? ' —— 重构后这里应该有命中' : ''),
  )
  for (const hit of quotaSource.slice(0, 2)) evidence.push(`    ${formatSample(hit)}`)

  if (all.length === 0) {
    return {
      id: 'A4',
      title: '额度来自后端',
      status: 'PASS',
      evidence,
      hints: quotaSource.length === 0
        ? ['账本已经不在本地了，但也没看到读 `v1/usage` / `user/profile` 的地方 —— 额度总得有个来源。']
        : [],
      stats: { files: corpus.size, hits: 0, quotaSource: quotaSource.length },
    }
  }

  const hints = []
  if (commentOnly(all)) {
    hints.push(
      `只剩注释行（${all.length} 处）：把 remaining_points 这类旧口径描述删掉，或改成 #484 §3.3 的` +
        '读法（额度只来自 sub2api，客户端不折算、不缓存）。',
    )
  } else {
    hints.push(
      '客户端不再持有消费账本（#482 / #484 §七.6）：删掉本地余额字段与持久化，额度每次从 ' +
        '`GET /v1/usage`（sk- Key）或 `GET /api/v1/user/profile`（JWT）读；' +
        '「查不到」就报查不到，不许当 0、不许据此判断「能不能发送」。',
    )
  }

  return {
    id: 'A4',
    title: '额度来自后端',
    status: 'FAIL',
    evidence,
    hints,
    stats: { files: corpus.size, ...countBy(all), quotaSource: quotaSource.length },
  }
}

// ---------------------------------------------------------------------------
// A5 卡密方向对
// ---------------------------------------------------------------------------

/** `/api/v1/redeem`（JWT）：卡密 → 余额。`(?![-_a-z0-9])` 是为了不把旧池域的 `redeem-card` 算进来 */
const REDEEM_PATH = /api\/v1\/redeem(?![\w-])/u
/** 拼路径时的写法：`'/redeem'` —— 只有在声明了 JWT 前缀的文件里才算（`'/api/redeem'` 是旧 apia 端点，不算） */
const REDEEM_SEGMENT = /["'`]\/?redeem["'`]/u
/** `/api/v1/redeem/history`：超时后先查这个再决定是否重试（#484 §五） */
const REDEEM_HISTORY_PATH = /redeem\/history(?![\w-])/u

const checkA5 = (corpus) => {
  const jwtFiles = filesWithJwtPrefix(corpus)
  const redeem = findLines(
    corpus,
    (line, file) =>
      REDEEM_PATH.test(line) || (REDEEM_SEGMENT.test(line) && jwtFiles.has(file)),
  )
  const history = findLines(corpus, (line) => REDEEM_HISTORY_PATH.test(line))

  const evidence = [
    'POST /api/v1/redeem 命中：' + `${redeem.length} 处`,
    ...redeem.slice(0, MAX_SAMPLES).map((hit) => `    ${formatSample(hit)}`),
    'GET /api/v1/redeem/history 命中（幂等补偿痕迹）：' + `${history.length} 处`,
    ...history.slice(0, MAX_SAMPLES).map((hit) => `    ${formatSample(hit)}`),
  ]

  const missing = []
  if (redeem.length === 0) missing.push('redeem')
  if (history.length === 0) missing.push('history')

  if (missing.length === 0) {
    return {
      id: 'A5',
      title: '卡密方向对',
      status: 'PASS',
      evidence,
      hints: [],
      stats: { redeem: redeem.length, history: history.length },
    }
  }

  const hints = []
  if (missing.includes('redeem')) {
    hints.push(
      '兑换要打 `POST /api/v1/redeem`（JWT，body `{code}`）—— 不是旧池域/apia 的兑换接口' +
        '（#482 第二节：apia 只发卡密，兑换由 sub2api 完成）。',
    )
  }
  if (missing.includes('history')) {
    hints.push(
      '`redeem` 没有幂等键，超时绝不能盲目重试（重试会拿到 `409 REDEEM_CODE_USED`，可能正是' +
        '自己上一次成功）：超时分支必须先查 `GET /api/v1/redeem/history` 确认到没到账。' +
        '这一条要求源码里能看到 `redeem/history` 的调用痕迹。',
    )
  }

  return {
    id: 'A5',
    title: '卡密方向对',
    status: 'FAIL',
    evidence,
    hints,
    stats: { redeem: redeem.length, history: history.length },
  }
}

// ---------------------------------------------------------------------------
// A6 base 配置化
// ---------------------------------------------------------------------------

/** 测试文件（A6 的 src 扫描排除它们：断言里必须能写地址） */
const isTestFile = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)(?:__tests__|tests?)\//u.test(file)

const hostOf = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value.trim()).hostname.toLowerCase()
  } catch {
    return null
  }
}

const isIpv4 = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)

/** 后端域名白名单：全部来自 `config/endpoints.json`，外加 #484 §一 写死的支付域名 */
const backendHostsOf = (config) => {
  // apia = #484 §一 写死的支付域名；旧池域 IP = 黑名单条目（A6 要能拦住它被写进 src/）
  // check-ip-allow：同上，黑名单条目不是可调地址
  const hosts = new Set(['apia.ecsafe.cn', '140.210.13.146'])
  const push = (value) => {
    const host = hostOf(value)
    if (host) hosts.add(host)
  }
  for (const key of ['allowedHosts', 'legacyHosts']) {
    if (Array.isArray(config?.[key])) for (const value of config[key]) push(value)
  }
  for (const key of ['primaryBase', 'fallbackBase']) push(config?.download?.[key])
  for (const group of ['consume', 'pay']) push(config?.[group]?.baseUrl)
  return hosts
}

/**
 * A6 的 base 判据：**https**，唯一例外是**本机回环**。
 *
 * 为什么要有例外：本地联调的 sub2api 实例就是 `http://127.0.0.1:18000`（维护者 2026-11-20 明确
 * 联调与 base URL 都以本地实例为准）。回环地址出不了网，明文不会把 Key 交给中间人；
 * 而**非回环**的明文仍然是硬红线（公网 IP / 域名都必须照样红）—— 例外只对回环成立，不是整体放水。
 */
const isHttpsOrLoopback = (value) =>
  typeof value === 'string' && (/^https:\/\//iu.test(value) || /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/iu.test(value))

const checkA6 = (corpus, root) => {
  const file = path.join(root, ENDPOINTS_FILE)
  const evidence = []
  const hints = []
  const stats = { consume: false, pay: false, consumeBase: null, payBase: null, literals: 0 }

  let config = null
  if (!fs.existsSync(file)) {
    evidence.push(`${ENDPOINTS_FILE} 不存在`)
    hints.push(
      `新建 ${ENDPOINTS_FILE} 的 \`consume\` / \`pay\` 两组（字段见 #484 §6.1）；` +
        'base 只从配置读，源码零字面量。',
    )
  } else {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      evidence.push(`${ENDPOINTS_FILE} 解析失败：${error.message}`)
      hints.push(`${ENDPOINTS_FILE} 不是合法 JSON：构建期注入要靠它，先修好再谈 A6。`)
    }
  }

  const sub = []
  if (config) {
    const consume = config.consume
    const pay = config.pay
    stats.consume = Boolean(consume && typeof consume === 'object')
    stats.pay = Boolean(pay && typeof pay === 'object')
    stats.consumeBase = typeof consume?.baseUrl === 'string' ? consume.baseUrl : null
    stats.payBase = typeof pay?.baseUrl === 'string' ? pay.baseUrl : null

    sub.push({ what: 'consume 组存在', ok: stats.consume })
    sub.push({ what: 'pay 组存在', ok: stats.pay })
    const consumeHttps = isHttpsOrLoopback(stats.consumeBase)
    const payHttps = isHttpsOrLoopback(stats.payBase)
    sub.push({
      what: `consume.baseUrl 是 https 或回环（当前 ${stats.consumeBase ?? '缺失'}）`,
      ok: consumeHttps,
    })
    sub.push({ what: `pay.baseUrl 是 https 或回环（当前 ${stats.payBase ?? '缺失'}）`, ok: payHttps })
    // #869 单一 BASE：唯一例外是两者都等于统一网关 BASE（判据与 consumeEndpoints.mjs 同源，不另写一份）；
    // 其余相等一律照红 —— 规则没有放宽，只是登记了一个有理由的例外。
    const distinct =
      Boolean(stats.consumeBase) &&
      Boolean(stats.payBase) &&
      (stats.consumeBase !== stats.payBase || bothUnifiedBase(stats.consumeBase, stats.payBase))
    sub.push({ what: 'consume 与 pay 不指向同一个 base（职责不能混；#869 例外：两者都是统一网关 BASE）', ok: distinct })

    if (!stats.consume) {
      hints.push(
        `${ENDPOINTS_FILE} 缺 \`consume\` 组：` +
          '`{ baseUrl, apiV1Prefix: "/api/v1", gatewayPrefix: "/v1", timeoutMs: { read, write, redeem } }`（#484 §6.1）。',
      )
    }
    if (!stats.pay) {
      hints.push(
        `${ENDPOINTS_FILE} 缺 \`pay\` 组：` +
          '`{ baseUrl: <与 consume.baseUrl 同一个网关 BASE，#869>, timeoutMs: { read, write } }`（apia 只负责买，不改协议）。',
      )
    }
    if (stats.consumeBase && !consumeHttps) {
      hints.push(
        'consume.baseUrl 必须是 https，唯一例外是本机回环（127.0.0.1 / localhost / [::1]）：' +
          '非回环明文会中止构建（#484 §6.3）；生产 host 待维护者提供，届时填 https。',
      )
    }
    if (stats.payBase && !payHttps) {
      hints.push('pay.baseUrl 必须是 https（唯一例外是本机回环）：明文 http 直接中止构建（#484 §6.3）。')
    }
    if (!distinct && stats.consumeBase && stats.payBase) {
      hints.push('consume.baseUrl 与 pay.baseUrl 不许相同（唯一例外：两者都是统一网关 BASE，#869）：一个卖卡、一个消费，职责不能混（#484 §6.3）。')
    }
  }

  // 源码字面量：只拦后端域名 / IP
  const hosts = backendHostsOf(config)
  const literalHits = findLines(
    corpus,
    (line) => {
      const matches = line.matchAll(/(?:https?):\/\/([a-z0-9.-]+)/giu)
      for (const match of matches) {
        const host = match[1].toLowerCase()
        if (isIpv4(host) || hosts.has(host)) return true
      }
      return false
    },
    { skip: isTestFile },
  )
  stats.literals = literalHits.length

  for (const item of sub) evidence.push(`${item.ok ? '✓' : '✗'} ${item.what}`)
  evidence.push(
    `地址白名单（后端 + 分发，来自 ${ENDPOINTS_FILE} 与 #484 §一）：${[...hosts].sort().join(', ')}`,
  )
  evidence.push(...evidenceOfHits('src/ 后端域名地址字面量 http(s)（已排除测试文件）', literalHits))

  if (literalHits.length > 0) {
    const commentHits = literalHits.filter((hit) => hit.comment)
    if (literalHits.length > commentHits.length) {
      hints.push(
        'src/ 里出现后端地址字面量：改成 `__ENDPOINTS__.consume.baseUrl` / `__ENDPOINTS__.pay.baseUrl`' +
          '（Web）与 `BuildConfig.CONSUME_BASE` / `PAY_BASE`（原生），注入点见 #484 §6.2。',
      )
    }
    if (commentHits.length > 0) {
      hints.push(
        `${commentHits.length} 处只在注释里：改写成不含主机名的描述（例如「consume base」），` +
          'A6 的口径是源码零字面量。',
      )
    }
  }

  const ok = sub.length > 0 && sub.every((item) => item.ok) && literalHits.length === 0
  return {
    id: 'A6',
    title: 'base 配置化',
    status: ok ? 'PASS' : 'FAIL',
    evidence,
    hints: ok ? [] : hints,
    stats,
  }
}

// ---------------------------------------------------------------------------
// A7 UI 收敛（人工）
// ---------------------------------------------------------------------------

const checkA7 = () => ({
  id: 'A7',
  title: 'UI 收敛',
  status: 'MANUAL',
  evidence: [
    '需人工截图确认（脚本不判，也不该判）：',
    '    390 宽截图：设置里「付款记录 / 我的购买 / 时间线」三个入口已经合成一个「账户与消费」页；',
    '    截图贴进 #487 的阶段②验收评论，并注明机型 / 构建 variant。',
    '不评：布局、配色、文案措辞（#484 §九 A7 的「不验什么」）。',
  ],
  hints: ['阶段②判定 A1–A6 全绿之后，补一张 390 宽截图即算 A7 完成。'],
  stats: {},
})

// ---------------------------------------------------------------------------
// 汇总与输出
// ---------------------------------------------------------------------------

const STATUS_ORDER = ['PASS', 'FAIL', 'SKIP', 'MANUAL']
const STATUS_LABEL = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', MANUAL: 'MANUAL' }

const runAll = (root, options) => {
  // 一次遍历两份语料：A1 要连 android/ 一起扫（旧体系在原生侧也有痕迹），其余各项只看 src/
  // 生成目录（android/app/src/main/assets/**）两份语料都不进 —— 见 GENERATED_DIRS
  const srcScan = readCorpus(root, ['src'])
  const srcCorpus = srcScan.corpus
  const androidScan = readCorpus(root, ['android'])
  const fullCorpus = new Map(srcCorpus)
  for (const [file, lines] of androidScan.corpus) fullCorpus.set(file, lines)
  const skippedGenerated = [...srcScan.skipped, ...androidScan.skipped]

  const items = [
    checkA1(fullCorpus, skippedGenerated),
    checkA2(root),
    checkA3(srcCorpus),
    checkA4(srcCorpus),
    checkA5(srcCorpus),
    checkA6(srcCorpus, root),
    checkA7(),
  ]
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]))
  for (const item of items) counts[item.status] += 1

  return {
    schemaVersion: 1,
    gate: 'check:refactor-direction',
    issue: 484,
    refs: [484, 487],
    source: 'issue-484 §九 A1–A7',
    root,
    mode: options.report ? 'report' : 'gate',
    generatedAt: new Date().toISOString(),
    summary: {
      items: items.length,
      pass: counts.PASS,
      fail: counts.FAIL,
      skip: counts.SKIP,
      manual: counts.MANUAL,
      ok: counts.FAIL === 0,
    },
    // #590 ①：扫描范围的自述 —— 跳过生成目录这件事必须在机器可读结果里也留痕
    scan: {
      excludedDirs: GENERATED_DIRS,
      skippedGenerated: skippedGenerated.length,
      skippedSamples: skippedGenerated.slice(0, MAX_SAMPLES),
    },
    items,
  }
}

const formatReport = (report) => {
  const out = []
  out.push(`#484 §九 方向验收（A1–A7）· ${report.mode === 'report' ? '报告模式' : '门禁模式'}`)
  out.push(`仓库根：${report.root}`)
  // #590 ①：跳过生成目录要说出来（不是静默放行）
  const scan = report.scan ?? { excludedDirs: [], skippedGenerated: 0, skippedSamples: [] }
  if (scan.skippedGenerated > 0) {
    out.push(
      `已跳过生成目录 ${scan.skippedGenerated} 个文件（${scan.excludedDirs.join(' / ')}**：` +
        'cap sync 产物，git 未跟踪，本地有、CI 没有 —— 算进来会让同一份代码两种结论）',
    )
    for (const sample of scan.skippedSamples) out.push(`    · 跳过 ${sample}`)
  } else {
    out.push(`生成目录（${scan.excludedDirs.join(' / ')}**）本机不存在 → 本次跳过 0 个文件`)
  }
  out.push('')
  for (const item of report.items) {
    out.push(`[${item.id}] ${STATUS_LABEL[item.status]}  ${item.title}`)
    for (const line of item.evidence) out.push(`  · ${line}`)
    for (const hint of item.hints) out.push(`  → 应该改哪里：${hint}`)
    out.push('')
  }

  const { summary } = report
  const chips = report.items.map((item) => `${item.id} ${item.status}`).join(' · ')
  out.push('—— 汇总 ——')
  out.push(chips)
  out.push(
    `PASS ${summary.pass} · FAIL ${summary.fail} · SKIP ${summary.skip} · MANUAL ${summary.manual}` +
      `（共 ${summary.items} 项；SKIP 与 MANUAL 不计 FAIL）`,
  )
  if (summary.ok) {
    out.push('结论：方向验收通过（A1–A6 全绿；A7 见人工截图）。')
  } else if (report.mode === 'report') {
    out.push('结论：方向验收未通过 —— 重构期间（#487 阶段①）这是预期状态；')
    out.push('      报告模式不退出非零，阶段②结束后再跑一次门禁模式收口。')
  } else {
    out.push('结论：方向验收未通过（exit 1）。重构期请用 `--report`，CI 接线推迟到阶段②之后。')
  }
  return out.join('\n')
}

/**
 * `--selftest`：A6 的负向对照（#487 W1-A 要求「回环例外不是整体放水」）。
 *
 * 做法：在一个临时目录里造「只够 A6 判」的合成仓库（`src/` 空 + `config/endpoints.json`），
 * 只断言 **A6 这一项**的 PASS/FAIL —— 其它项在合成仓库里本来就是红的，不参与断言。
 *
 * 六个用例：https / `127.0.0.1` / `localhost` / `[::1]` → **PASS**；
 * `http://8.8.8.8`（check-ip-allow：负向对照的靶子地址，不发任何请求）与 `http://consume.example.com`（非回环明文）→ **必须 FAIL**。
 */
const selftestA6 = () => {
  const cases = [
    { base: 'https://consume.example.com', expect: 'PASS', label: 'https' },
    { base: 'http://127.0.0.1:18000', expect: 'PASS', label: '回环 127.0.0.1' },
    { base: 'http://localhost:18000', expect: 'PASS', label: '回环 localhost' },
    { base: 'http://[::1]:18000', expect: 'PASS', label: '回环 [::1]' },
    // check-ip-allow: A6 负向对照的靶子地址（非回环明文必须判红），只作字符串比对，不发请求
    { base: 'http://8.8.8.8', expect: 'FAIL', label: '非回环明文 IP（例外不许放水）' },
    { base: 'http://consume.example.com', expect: 'FAIL', label: '非回环明文域名（例外不许放水）' },
  ]
  const failures = []
  for (const item of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-a6-'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    const config = {
      feedbackUrl: 'https://chat.example.com/feedback',
      legacyHosts: ['legacy.example.com'],
      allowedHosts: ['chat.example.com'],
      allowedPorts: [443],
      download: { primaryBase: 'https://dl.example.com', fallbackBase: 'https://dl2.example.com' },
      consume: {
        baseUrl: item.base,
        apiV1Prefix: '/api/v1',
        gatewayPrefix: '/v1',
        timeoutMs: { read: 10000, write: 20000, redeem: 30000 },
      },
      pay: { baseUrl: 'https://pay.example.com', timeoutMs: { read: 10000, write: 20000 } },
    }
    fs.writeFileSync(path.join(dir, ENDPOINTS_FILE), JSON.stringify(config, null, 2))
    const report = runAll(dir, { report: true })
    const a6 = report.items.find((entry) => entry.id === 'A6')
    fs.rmSync(dir, { recursive: true, force: true })
    if (!a6 || a6.status !== item.expect) {
      failures.push(`${item.label}：期望 A6 ${item.expect}，实际 ${a6?.status ?? '缺失'}`)
    }
  }
  if (failures.length > 0) {
    console.error(`A6 负向对照失败，${failures.length} 处：`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  // check-ip-allow: 这是负向对照的说明文字（靶子地址），不发请求
  console.log('A6 负向对照通过：https / 127.0.0.1 / localhost / [::1] → PASS；非回环明文（8.8.8.8 与域名）→ FAIL')
  return 0
}

const parseArgs = (argv) => {
  const options = { root: ROOT, report: false, json: false, jsonPath: null, help: false, selftest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--report') options.report = true
    else if (arg === '--json') {
      options.json = true
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) {
        options.jsonPath = path.resolve(next)
        index += 1
      }
    } else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--root 需要一个目录')
      options.root = path.resolve(value)
      index += 1
    } else if (arg === '--selftest') options.selftest = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

/** 入口（测试/其它脚本可直接调，不必起进程） */
export const main = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`check:refactor-direction 参数错误：${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.selftest) return selftestA6()
  if (!fs.existsSync(path.join(options.root, 'src'))) {
    console.error(`${options.root} 下没有 src/，不像仓库根（--root 指错了？）`)
    return 2
  }

  const report = runAll(options.root, options)
  if (options.json) {
    const text = JSON.stringify(report, null, 2)
    if (options.jsonPath) {
      fs.writeFileSync(options.jsonPath, `${text}\n`)
      console.error(`check:refactor-direction：JSON 报告已写入 ${options.jsonPath}`)
    } else {
      console.log(text)
    }
  } else {
    console.log(formatReport(report))
  }

  if (options.report) return 0
  return report.summary.ok ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
