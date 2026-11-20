#!/usr/bin/env node
/**
 * check-endpoints.mjs —— 端点配置的**自洽门禁**（Issue #274）。
 *
 * 三件事，缺一不可：
 *
 *   1. **配置自洽**：`config/endpoints.json` 里的三份地址必须与两份白名单互相对得上 ——
 *      `allowedHosts`（主机白名单，`check:ip` 用的就是它）与 `allowedPorts`（同一台机器开放的端口）。
 *      只改地址不改白名单 → 「配置里的主机与白名单不一致」/「配置里的端口与白名单不一致」→ exit 1。
 *      三个端点还必须落在同一台机器上（本单的前提：一台机器、三个端口）。
 *      `legacyHosts`（已下线主机重写表）与 `allowedHosts` 不许重叠：一个「要丢掉」，一个「允许写死」。
 *
 *   2. **没有废弃占位**：`src/**` 里不许再出现 `feedback.rose7.cn` —— 那个占位常量从未替换过，
 *      谁 import 谁打到已下线的主机。Issue #274 已把它删掉，这里守住「不许加回来」。
 *
 *   3. **没有字面量副本**：`src` / `scripts` / `repro` / `tests` 的**代码行**里不许再出现三份端点地址
 *      （整段 URL 或 `主机:端口`）。地址只有两个来源：前端走构建期注入的 `__ENDPOINTS__`，
 *      脚本与测试 `import scripts/lib/endpoints.mjs`。注释行里的说明文字不管（那不是可执行的副本）。
 *
 *   4. **分发地址零副本**（Issue #269）：`download.primaryBase` / `download.fallbackBase` 不许以
 *      字面量出现在**客户端可执行代码**里 —— `src/**`、`android/app/src/main/java/**`、
 *      `android/app/build.gradle`。这三处就是「换个分发机要改几行」的全部答案：Web 侧只写
 *      `__ENDPOINTS__.dlPrimaryBase`，原生侧只写 `BuildConfig.DL_PRIMARY`，gradle 只从
 *      `config/endpoints.json` 读。发布侧脚本（上传 / 校验 / CI）自己有一份
 *      `scripts/release-common.mjs`，不在这一条的范围里。
 *
 * 为什么要有它：端点散成三份常量时，换机器要人去 grep 源码 + 13 个测试文件 + 一份门禁豁免名单；
 * 漏改测试里的字面量尤其坏 —— 用例打的还是旧机器的桩，**假绿**。把「只有一份」和「副本为零」
 * 变成两条命令，换机器就只剩改 `config/endpoints.json` 一件事。
 *
 * 用法：
 *   node scripts/check-endpoints.mjs
 *   pnpm run check:endpoints
 *
 * 退出码：0 通过 / 1 有违规（逐条打印 文件:行 或 字段名）/ 2 环境错误
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOWNLOAD_FIELDS, ENDPOINTS_FILE, URL_FIELDS, validateEndpoints } from './lib/endpointsSchema.mjs'
import { isCommentOnlyLine } from './lib/textLines.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫这些目录（相对仓库根）：源码、脚本、复现装置、测试 */
const SCAN_DIRS = ['src', 'scripts', 'repro', 'tests']

/** 进来也不看的目录名（任意层级） */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-scroll',
  'dist-internal',
  '.git',
  '.workflow-lite',
  'coverage',
])

/** 只看会执行的代码（`.md` 是文档/历史记录，不参与这条判定） */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])

/**
 * 分发地址（#269）的扫描范围：客户端可执行代码。`config/endpoints.json` 与
 * `android/app/build.gradle` 之外的任何一处出现 base 字面量都是「又一份副本」。
 */
const CLIENT_DIRS = ['src', 'android/app/src/main/java']

/** 客户端代码的扩展名（`.gradle` 单独列出：build.gradle 也必须只从配置读） */
const CLIENT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.java'])

/** 客户端里「只允许从配置读」的文件（不需要遍历的单个文件） */
const CLIENT_FILES = ['android/app/build.gradle']

/** 已经废弃、不许再出现在 `src/` 里的占位域名（测试里 route 掉它是为了证明没打过去，不在这条线上） */
const DEPRECATED_HOSTS = ['feedback.rose7.cn']

/**
 * 行内豁免标记：同一行或上一行出现它，本行不判。
 * 只给「规则自测」用 —— 例如 tests/unit/check-ip-version.test.mjs 必须写出地址字面量
 * 才能验证「代码行里写地址会报」，那种字面量不是可执行的副本。
 */
const ALLOW_MARK = 'check-endpoints-allow'

const log = (...args) => console.log(...args)
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

const collectFiles = (dir, filter, out) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(full, filter, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!filter(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
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

const main = () => {
  const problems = []

  // ---------- 1. 配置自洽 ----------
  let raw = null
  try {
    raw = JSON.parse(readFileSync(ENDPOINTS_FILE, 'utf8'))
  } catch (error) {
    console.error(`读不了 ${rel(ENDPOINTS_FILE)}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  for (const problem of validateEndpoints(raw)) {
    problems.push(`${rel(ENDPOINTS_FILE)}: ${problem}`)
  }

  // 端点地址的两种写法都算「字面量副本」：整段 URL 与 `主机:端口`
  const needles = new Set()
  for (const field of URL_FIELDS) {
    const value = typeof raw?.[field] === 'string' ? raw[field].trim() : ''
    if (!value) continue
    needles.add(value)
    try {
      const url = new URL(value)
      needles.add(`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`)
    } catch {
      // URL 不合法已经在 validateEndpoints 里报过，这里不再重复
    }
  }

  // 分发地址（#269）：只查客户端可执行代码 —— 那是「换分发机要改几行」的全部答案。
  // 发布侧脚本（scripts/release-common.mjs 的 DEFAULT_ENDPOINT 等）是另一件事，不在这里判。
  const downloadNeedles = new Set()
  for (const field of DOWNLOAD_FIELDS) {
    const value = typeof raw?.download?.[field] === 'string' ? raw.download[field].trim() : ''
    if (!value) continue
    downloadNeedles.add(value)
    try {
      const url = new URL(value)
      downloadNeedles.add(`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`)
    } catch {
      // 形态不合法已在 validateDownload 里报过
    }
  }

  const files = []
  for (const dir of SCAN_DIRS) {
    collectFiles(path.join(ROOT, dir), (ext) => CODE_EXT.has(ext), files)
  }
  const clientFiles = []
  for (const dir of CLIENT_DIRS) {
    collectFiles(path.join(ROOT, dir), (ext) => CLIENT_EXT.has(ext), clientFiles)
  }
  if (downloadNeedles.size > 0 && clientFiles.length === 0) {
    console.error(`check:endpoints 没扫到任何客户端文件（${CLIENT_DIRS.join(' / ')}），检查路径`)
    process.exit(2)
  }
  if (files.length === 0) {
    console.error('check:endpoints 没扫到任何代码文件，检查 SCAN_DIRS 与工作目录')
    process.exit(2)
  }

  for (const file of files) {
    // 规则书自己当然要写出废弃域名与判据才能说清规则
    const isSelf = path.basename(file) === 'check-endpoints.mjs'
    const inSrc = rel(file).startsWith('src/')
    const lines = readLines(file)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const prevLine = i > 0 ? lines[i - 1] : ''
      // 注释行是说明文字，不构成可执行的副本
      if (isCommentOnlyLine(line)) continue
      // 规则自测要喂字面量才能证明「写进去会红」
      if (line.includes(ALLOW_MARK) || prevLine.includes(ALLOW_MARK)) continue

      if (inSrc && !isSelf) {
        for (const host of DEPRECATED_HOSTS) {
          if (line.includes(host)) {
            problems.push(`${rel(file)}:${i + 1}: 已废弃的占位域名 ${host}（#274 已删除，别再加回来）`)
          }
        }
      }
      for (const needle of needles) {
        if (line.includes(needle)) {
          problems.push(
            `${rel(file)}:${i + 1}: 端点地址字面量 ${needle}` +
              '（前端走 __ENDPOINTS__，脚本/测试 import scripts/lib/endpoints.mjs）'
          )
        }
      }
    }
  }

  // 分发地址零副本（#269）：客户端可执行代码只能从配置 / BuildConfig 读
  const clientTargets = [
    ...clientFiles.map((file) => [file, rel(file)]),
    ...CLIENT_FILES.map((f) => [path.join(ROOT, f), f]),
  ]
  for (const [full, shown] of clientTargets) {
    const lines = readLines(full)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const prevLine = i > 0 ? lines[i - 1] : ''
      if (isCommentOnlyLine(line)) continue
      if (line.includes(ALLOW_MARK) || prevLine.includes(ALLOW_MARK)) continue
      for (const needle of downloadNeedles) {
        if (line.includes(needle)) {
          problems.push(
            `${shown}:${i + 1}: 分发地址字面量 ${needle}` +
              '（Web 走 __ENDPOINTS__.dlPrimaryBase / dlFallbackBase，原生走 BuildConfig.DL_PRIMARY / DL_FALLBACK；' +
              '唯一来源是 config/endpoints.json 的 download.*，换分发机只改那一处）'
          )
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(`端点配置门禁不通过，${problems.length} 处问题：`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(
      '\n唯一事实来源是 config/endpoints.json：地址、旧域名重写表、主机与端口白名单、以及分发地址' +
        '（download.primaryBase / download.fallbackBase）都在那一份里；前端由 rspack 注入 __ENDPOINTS__，' +
        '原生由 build.gradle 读成 BuildConfig.DL_PRIMARY / DL_FALLBACK，门禁与测试读 scripts/lib/endpoints.mjs。'
    )
    process.exit(1)
  }

  log(
    `端点配置检查通过：扫了 ${files.length} 个代码文件（${SCAN_DIRS.join(' / ')}）+ ` +
      `${clientFiles.length} 个客户端文件（${CLIENT_DIRS.join(' / ')} / ${CLIENT_FILES.join(' / ')}），` +
      `地址零副本、废弃占位 0 处；聊天 ${raw.chatBaseUrl} / 邀请 ${raw.inviteBaseUrl} / 反馈 ${raw.feedbackUrl}；` +
      `分发首选 ${raw.download.primaryBase} / 回退 ${raw.download.fallbackBase}（换分发机只改 download.primaryBase 一处）。`
  )
  process.exit(0)
}

main()
