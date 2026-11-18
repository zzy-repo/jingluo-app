#!/usr/bin/env node
/**
 * check-hardcoded-ip.mjs —— 源码里不许再出现写死的上游 IP（Issue #181）。
 *
 * 为什么要有它：#181 是一次纯手工迁移 —— 服务端从 62.106.70.167 换到 140.210.13.146，
 * 客户端里散落在 providers / invite / diagnostics / 脚本 / 复现装置里的地址要逐个改，
 * 全靠 `grep -rn` 自觉。三代写死 IP（123.207.199.196 → 62.106.70.167 → 140.210.13.146）
 * 说明漏一处就是一处线上故障：用户升级后打到一个已经不存在的机器上，界面只会转圈。
 * 这个脚本把那件事变成一条命令：**再写死一个 IP 就 exit 1**。
 *
 * 扫描范围（只扫会进产物 / 会打真实请求的代码）：
 *   src/      客户端源码
 *   scripts/  构建与截图脚本（会拼 URL）
 *   repro/    复现装置（同样打真实后端）
 *
 * 不扫：`docs/`（历史实测记录要保原文）、`CHANGELOG.md`（历史）、`tests/`（断言里必须写地址
 * 才能验证地址对不对）、`node_modules` / `dist*`（产物与依赖）。
 *
 * 不算违规的地址：
 *   - 回环 / 通配：127.0.0.0/8、0.0.0.0、::1、localhost
 *   - 私有 / 链路本地 / CGNAT / 保留测试段：10/8、172.16/12、192.168/16、169.254/16、
 *     100.64/10、192.0.2/24、198.51.100/24、203.0.113/24 —— 这些是本地测试桩用的
 *   - ALLOWED_HOSTS 里列的「当前唯一合法的线上地址」（迁移期豁免，见下）
 *   - 同一行（或上一行）带 `check-ip-allow` 标记的字面量：给「已下线主机名单」「规范条款号」
 *     这类必须写出 IP 形状的地方用，必须注明理由
 *
 * 用法：
 *   node scripts/check-hardcoded-ip.mjs
 *   pnpm run check:ip
 *
 * 退出码：
 *   0  干净（只有允许的地址）
 *   1  发现写死的 IP，逐条打印 `文件:行: <ip>`
 *   2  用法 / 环境错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫这些目录（相对仓库根） */
const SCAN_DIRS = ['src', 'scripts', 'repro']

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

/** 只看文本；二进制/产物一律跳过 */
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
])

/**
 * 当前**合法**的写死地址：服务端就在这个 IP 上（明文 HTTP，没有域名）。
 * 换域名（或服务端再搬一次）时改这里，并同步 providers.ts / invite/api.ts / diagnostics/config.ts。
 * 除了它，出现任何公网 IP 都算违规 —— 免得下一个人又靠 grep 自觉。
 */
const ALLOWED_HOSTS = new Set(['140.210.13.146'])

/** 回环、通配、私有、保留测试段：本地测试桩可以写 */
const isExemptIpv4 = (a, b) => {
  if (a === 0) return true // 0.0.0.0/8：通配
  if (a === 127) return true // 127.0.0.0/8：回环
  if (a === 10) return true // 10/8：私有
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12：私有
  if (a === 192 && b === 168) return true // 192.168/16：私有
  if (a === 169 && b === 254) return true // 169.254/16：链路本地
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10：CGNAT
  if (a === 192 && b === 0) return true // 192.0.0/24、192.0.2/24：文档 / 保留
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true // 198.18/15 基准、198.51.100/24 文档
  if (a === 203 && b === 0) return true // 203.0.113/24：文档
  if (a >= 224) return true // 组播 / 保留 / 广播
  return false
}

/** 用 new URL 认得出来的写法抓 IPv4：前面不能紧贴数字或点（避免把 1.2.3.4.5 这类版本号切一段） */
/** 行内豁免标记：同一行或上一行出现它，本行的 IP 一律放过 */
const ALLOW_MARK = 'check-ip-allow'

const RE_IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g
const RE_IPV6 = /(?<![\w:])(?:::1|fe80:[0-9a-f:]+|f[cd][0-9a-f]{2}:[0-9a-f:]+)(?![\w:])/gi

const log = (...args) => console.log(...args)

const collectFiles = (dir, out) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
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
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** 扫一个文件，返回 [{ line, ip }] */
const scanFile = (file) => {
  const hits = []
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return hits
  }
  // 二进制兜底：NUL 字节
  if (text.includes('\u0000')) return hits

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('.')) continue
    // 行内豁免：确需保留地址字面量的地方（已下线主机名单、规范条款号）写 check-ip-allow 并注明理由
    if (line.includes(ALLOW_MARK) || (i > 0 && lines[i - 1].includes(ALLOW_MARK))) continue

    RE_IPV4.lastIndex = 0
    let match
    while ((match = RE_IPV4.exec(line)) !== null) {
      const parts = match.slice(1, 5).map(Number)
      if (parts.some((n) => n > 255)) continue
      const ip = parts.join('.')
      if (ALLOWED_HOSTS.has(ip)) continue
      if (isExemptIpv4(parts[0], parts[1])) continue
      hits.push({ line: i + 1, ip })
    }

    RE_IPV6.lastIndex = 0
    while ((match = RE_IPV6.exec(line)) !== null) {
      const ip = match[0]
      if (ip === '::1') continue
      if (/^fe80:/i.test(ip) || /^f[cd]/i.test(ip)) continue
      hits.push({ line: i + 1, ip })
    }
  }
  return hits
}

const main = () => {
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) continue
    collectFiles(full, files)
  }

  if (files.length === 0) {
    console.error('check:ip 没扫到任何文件，检查 SCAN_DIRS 与工作目录')
    process.exit(2)
  }

  const violations = []
  for (const file of files) {
    // 规则书本身要写出旧 IP 才能说清「什么算违规」
    if (path.basename(file) === 'check-hardcoded-ip.mjs') continue
    for (const hit of scanFile(file)) {
      violations.push({ file: rel(file), ...hit })
    }
  }

  if (violations.length === 0) {
    log(
      `写死 IP 检查通过：扫了 ${files.length} 个文件（${SCAN_DIRS.join(' / ')}），` +
        `违规 0 处；豁免的线上地址 ${[...ALLOWED_HOSTS].join(', ')}。`,
    )
    process.exit(0)
  }

  console.error(`发现 ${violations.length} 处写死的 IP（服务端地址请走 spec.defaults / 常量，别散落在代码里）：`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.ip}`)
  }
  console.error(
    '\n允许的例外：回环/私有/保留测试段，以及 ALLOWED_HOSTS 里的当前线上地址' +
      `（${[...ALLOWED_HOSTS].join(', ')}）。真要新增，先想清楚换机器那天谁来 grep。`,
  )
  process.exit(1)
}

main()
