#!/usr/bin/env node
/**
 * check-consume-api.mjs —— 消费侧调用门禁（Issue #484 §6.5 / §七，Issue #487 W1-A）。
 *
 * 拦的是「客户端又绕过白名单/又写死地址/又把设备码当凭据」这一类回归。每一条都对应一个真实事故：
 *
 *   R1 **配置齐全且合法**：`config/endpoints.json` 的 `consume` / `pay` 两段必须齐全、https
 *      （唯一例外是本机回环的本地联调实例）、互不相同、不得命中废弃域 —— 报错带**键名 + 行号**。
 *      判据与 `scripts/lib/consumeEndpoints.mjs` 同一份（构建期 fail-fast 也用它）。
 *   R2 **base 零字面量**：`src/**` 不许出现后端地址（consume / pay 的 base，以及下载之外的旧域名）。
 *      地址只有两个来源：Web 侧 `__ENDPOINTS__.consume|pay`，脚本/门禁 `scripts/lib/*`。
 *   R3 **路径白名单**：`src/**` 里出现的 `/api/v1/**`、`/api/**`、`/v1/**` 字面量必须在
 *      #484 §三 的表里（`scripts/lib/consumeApiAudit.mjs` 的 `PATH_WHITELIST`）。
 *      白名单外的调用一律 exit 1；旧路径（W1-D / W1-E 还没删的）走 `LEGACY_PATHS` 豁免，
 *      且**只许出现在登记过的文件里**（扩散 = 红）。
 *   R4 **废弃域**：`140.210.13.146`、`:60013`、`legacyHosts` 里的旧机器，`src/**` 与 `android/**`
 *      一律不许出现（A1 的 grep 判据）。
 *   R5 **明文 http**：`src/**` 里除本机回环（和 URL 解析哨兵）外不许出现 `http://`。
 *   R6 **device_id 不作凭据**：同一行里 `device_id` 与 `Authorization` / `Bearer` / `x-api-key` 同现。
 *   R7 **Key / JWT 不进 query**：`?key=` / `&api_key=` / `?token=` / `?access_token=` 一律红
 *      （sub2api 直接回 400 `api_key_in_query_deprecated`）。
 *   R8 **原生注入在位**：`android/app/build.gradle` 必须显式 `buildFeatures { buildConfig true }`
 *      且生成 `BuildConfig.CONSUME_BASE` / `BuildConfig.PAY_BASE`（AGP 8 默认关掉 BuildConfig，
 *      漏了这一行 buildConfigField 会被静默忽略，原生侧编译期找不到符号）。
 *
 * 用法：
 *   node scripts/check-consume-api.mjs             # 门禁模式（旧路径豁免按 LEGACY_PATHS 放行）
 *   node scripts/check-consume-api.mjs --strict    # 严格模式：旧路径 / 旧 base 落点也算红（W1-D 清理完后切这个）
 *   node scripts/check-consume-api.mjs --selftest  # 负向对照：往 src 塞一条 pay.baseUrl → 必须红，删掉 → 必须绿
 *   pnpm run check:consume-api
 *
 * 退出码：0 通过 / 1 有违规（逐条打印 文件:行 或 键名）/ 2 环境错误
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BACKEND_BASE_ALLOW,
  LEGACY_PATHS,
  PATH_WHITELIST,
  PLAINTEXT_ALLOW,
  findPathLiterals,
  keyInQuery,
  matchWhitelist,
  usesDeviceIdAsAuth,
} from './lib/consumeApiAudit.mjs'
import {
  DEPRECATED_MARKERS,
  ENDPOINTS_FILE,
  ENDPOINTS_LABEL,
  collectKeyLines,
  isLoopbackHost,
  loadConsumePay,
  parseBaseUrl,
  placeholderNotice,
  validateConsumePay,
} from './lib/consumeEndpoints.mjs'
import { isCommentOnlyLine } from './lib/textLines.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 源码扫描范围（会进产物的代码） */
const SRC_DIR = 'src'
/** 原生侧扫描范围（A1 的 grep 判据也覆盖 android/） */
const ANDROID_DIRS = ['android/app/src/main/java']
const ANDROID_FILES = ['android/app/build.gradle']
const GRADLE_FILE = 'android/app/build.gradle'

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.java'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-standard', 'dist-scroll', 'dist-internal', '.git', 'coverage'])

/** 负向对照用的探针文件（用完立刻删；文件名带 __gate_neg 前缀，与其它门禁的探针同风格） */
const PROBE = 'src/__gate_neg_consume_probe.ts'

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

const collect = (dir, out) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!CODE_EXT.has(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
  return out
}

const readLines = (file) => {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.includes('\u0000')) return []
    return text.split(/\r?\n/)
  } catch {
    return []
  }
}

/** R1：配置齐全 / https（回环例外）/ 互不相同 / 不得命中废弃域 */
const checkConfig = (problems) => {
  let text
  try {
    text = readFileSync(ENDPOINTS_FILE, 'utf8')
  } catch (error) {
    problems.push(`${ENDPOINTS_LABEL}: 读不了（${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    problems.push(`${ENDPOINTS_LABEL}: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
  for (const problem of validateConsumePay(raw, text)) problems.push(`${ENDPOINTS_LABEL}: ${problem}`)
  // 行号表另存一份：R2 报「哪一行写了地址」时要用
  return { raw, keyLines: collectKeyLines(text) }
}

/** R2-R7：扫 src 与 android 的每一行 */
const checkSources = (config, problems, strict) => {
  const settings = config?.raw
  if (!settings) return

  const consumeUrl = parseBaseUrl(settings.consume?.baseUrl)
  const payUrl = parseBaseUrl(settings.pay?.baseUrl)
  const legacyHosts = Array.isArray(settings.legacyHosts) ? settings.legacyHosts.map((host) => String(host).trim()) : []

  /** 「这个地址字面量」需要拦的 needle：整段 URL 与 `host:port` 两种写法 */
  const baseNeedles = []
  for (const [kind, url] of [
    ['consume', consumeUrl],
    ['pay', payUrl],
  ]) {
    if (!url) continue
    baseNeedles.push({ needle: url.origin, kind })
    baseNeedles.push({ needle: url.host, kind })
  }

  const srcFiles = collect(path.join(ROOT, SRC_DIR), [])
  for (const file of srcFiles) {
    const shown = rel(file)
    const lines = readLines(file)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (isCommentOnlyLine(line)) continue
      const at = `${shown}:${i + 1}`

      // R4 废弃域（代码行出现即违规；注释行已在上一步放过）
      for (const marker of [...DEPRECATED_MARKERS, ...legacyHosts]) {
        if (line.includes(marker)) {
          problems.push(`${at}: 出现废弃域 ${marker}（旧池域已下线，#484 §七 第 1 条；A1 的 grep 判据）`)
        }
      }

      // R2 base 零字面量：只允许 BACKEND_BASE_ALLOW 里登记过的两个旧文件（--strict 下连它们也红）
      for (const { needle, kind } of baseNeedles) {
        if (!line.includes(needle)) continue
        const allow = BACKEND_BASE_ALLOW[shown]
        if (allow && !strict) continue
        const why = allow
          ? `（${allow.owner} 会清：${allow.reason}；--strict 下不再豁免）`
          : '（地址只能来自 __ENDPOINTS__.consume / __ENDPOINTS__.pay）'
        problems.push(`${at}: 出现 ${kind}.baseUrl 的地址字面量 ${needle}${why}`)
      }

      // R5 明文 http：本机回环与登记过的哨兵例外
      for (const match of line.matchAll(/http:\/\/([A-Za-z0-9.-]+)/gi)) {
        const host = match[1].toLowerCase()
        if (isLoopbackHost(host)) continue
        if (PLAINTEXT_ALLOW[host]?.files.includes(shown)) continue
        problems.push(`${at}: 明文 http://${host} （后端一律 https；唯一例外是本机回环，#484 §6.3 / §七 第 5 条）`)
      }

      // R3 路径白名单
      for (const literal of findPathLiterals(line)) {
        const verdict = matchWhitelist(literal, { file: shown })
        if (verdict.ok) {
          if (verdict.kind === 'legacy' && strict) {
            problems.push(`${at}: 旧路径 ${literal} 仍在（${verdict.owner} 清理前豁免，--strict 下必须删）`)
          }
          continue
        }
        problems.push(`${at}: 路径 ${literal} ${verdict.reason}`)
      }

      // R6 设备码当凭据
      if (usesDeviceIdAsAuth(line)) {
        problems.push(`${at}: device_id 与鉴权头同现（device_id 体系已废弃，#484 §七 第 3 条）`)
      }

      // R7 Key / JWT 进 query
      if (keyInQuery(line)) {
        problems.push(`${at}: 凭据出现在 query（只许 Authorization 头；sub2api 会回 400 api_key_in_query_deprecated）`)
      }
    }
  }

  // android/：只看 A1 的三件事（废弃域 / device_id 当凭据 / 明文 http 到非回环）
  const androidFiles = [...ANDROID_DIRS.flatMap((dir) => collect(path.join(ROOT, dir), []))]
  for (const file of androidFiles) {
    const shown = rel(file)
    const lines = readLines(file)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (isCommentOnlyLine(line)) continue
      const at = `${shown}:${i + 1}`
      for (const marker of [...DEPRECATED_MARKERS, ...legacyHosts]) {
        if (line.includes(marker)) problems.push(`${at}: 出现废弃域 ${marker}（A1：android/ 同样不许有）`)
      }
      if (usesDeviceIdAsAuth(line)) {
        problems.push(`${at}: device_id 与鉴权头同现（device_id 体系已废弃）`)
      }
    }
  }
}

/** R8：原生侧必须显式打开 BuildConfig 并生成两个 base 字段 */
const checkGradle = (problems) => {
  const file = path.join(ROOT, GRADLE_FILE)
  const lines = readLines(file)
  if (lines.length === 0) {
    problems.push(`${GRADLE_FILE}: 读不了（消费侧地址的原生注入点）`)
    return
  }
  const ensure = (pattern, message) => {
    const index = lines.findIndex((line) => pattern.test(line))
    if (index < 0) problems.push(`${GRADLE_FILE}: ${message}`)
    return index >= 0
  }
  ensure(/buildConfig\s+true/, '缺少 buildFeatures { buildConfig true }（AGP 8 默认关掉 BuildConfig，buildConfigField 会被静默忽略）')
  ensure(/"CONSUME_BASE"/, '缺少 buildConfigField CONSUME_BASE（消费侧 base 的原生注入点）')
  ensure(/"PAY_BASE"/, '缺少 buildConfigField PAY_BASE（支付侧 base 的原生注入点）')
  ensure(/consumeBase/, '没有从 config/endpoints.json 的 consume 段取 base（原生侧也要读同一份配置）')
  ensure(/payBase/, '没有从 config/endpoints.json 的 pay 段取 base')
}

/** 跑一遍全部门禁，返回问题清单（空数组 = 通过） */
const runGate = ({ strict = false } = {}) => {
  const problems = []
  const config = checkConfig(problems)
  checkSources(config, problems, strict)
  checkGradle(problems)
  return { problems, config }
}

/** 负向对照：注入必红 → 撤掉必绿（四拍：正例 → 注入 → 断言红 → 还原 → 再断言绿） */
const selftest = () => {
  const before = runGate()
  if (before.problems.length > 0) {
    console.error('负向对照无法进行：当前仓库本来就有违规，先修干净再跑 --selftest')
    for (const problem of before.problems) console.error(`  ${problem}`)
    process.exit(1)
  }

  // 注入物取 be 真实配置里的 pay.baseUrl（不在脚本里另抄一份地址）
  const payBase = before.config?.raw?.pay?.baseUrl
  if (!payBase) {
    console.error('负向对照无法进行：config/endpoints.json 里读不到 pay.baseUrl')
    process.exit(1)
  }
  const probePath = path.join(ROOT, PROBE)
  try {
    writeFileSync(probePath, `export const NEG_CONSUME_BASE = '${payBase}'\n`, 'utf8')
    const injected = runGate()
    if (injected.problems.length === 0) {
      console.error(`负向对照失败：往 ${PROBE} 塞了 pay.baseUrl 之后门禁仍然通过，说明 R2 没有真正生效`)
      process.exit(1)
    }
    if (!injected.problems.some((problem) => problem.startsWith(PROBE))) {
      console.error('负向对照失败：门禁红了，但没有指到注入的那个文件（归因不明 = 对照无效）')
      for (const problem of injected.problems) console.error(`  ${problem}`)
      process.exit(1)
    }
  } finally {
    rmSync(probePath, { force: true })
  }

  const after = runGate()
  if (after.problems.length > 0) {
    console.error('负向对照失败：撤掉注入物之后门禁仍然红（说明有残留）')
    for (const problem of after.problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log('负向对照通过：塞入 pay.baseUrl → exit 1 且指到注入文件；删掉 → exit 0')
  return true
}

const main = () => {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')

  if (argv.includes('--selftest')) {
    selftest()
    process.exit(0)
  }

  const { problems, config } = runGate({ strict })
  if (problems.length > 0) {
    console.error(`消费侧调用门禁不通过，${problems.length} 处问题：`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(
      '\n白名单与豁免表在 scripts/lib/consumeApiAudit.mjs（旧路径只许减少，不许新增）。' +
        '地址与超时的唯一来源是 config/endpoints.json 的 consume / pay 两段。'
    )
    process.exit(1)
  }

  if (config) {
    try {
      // 构建期 fail-fast 的那一份校验也跑一遍：门禁与构建用同一套判据
      loadConsumePay(ENDPOINTS_FILE)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
    const notice = placeholderNotice(config.raw)
    if (notice) console.warn(`[warn] ${notice}`)
  }

  const legacyCount = strict ? 0 : Object.keys(LEGACY_PATHS).length
  const suffix = strict ? '（--strict：旧路径与旧 base 落点均为 0）' : ''
  console.log(
    `消费侧调用门禁通过${suffix}：consume=${config?.raw?.consume?.baseUrl ?? '?'} / pay=${config?.raw?.pay?.baseUrl ?? '?'}；` +
      `路径白名单 ${PATH_WHITELIST.length} 条、旧路径豁免 ${legacyCount} 条（W1-D / W1-E 清理前）；` +
      'src 地址字面量 0 处、废弃域 0 处、明文 http 0 处、device_id 作凭据 0 处、query 凭据 0 处'
  )
  process.exit(0)
}

main()
