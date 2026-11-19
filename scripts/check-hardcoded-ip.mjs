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
 *   （`repro/` 复现装置已在 #291 整目录删除，扫它的那一条随之去掉；目录若重建会自动出现在
 *    `scripts/check-repo-hygiene.mjs` 的扫描范围里）
 *
 * 不扫：`docs/`（历史实测记录要保原文）、`CHANGELOG.md`（历史）、`tests/`（断言里必须写地址
 * 才能验证地址对不对）、`node_modules` / `dist*`（产物与依赖）。
 *
 * 不算违规的地址：
 *   - 回环 / 通配：127.0.0.0/8、0.0.0.0、::1、localhost
 *   - 私有 / 链路本地 / CGNAT / 保留测试段：10/8、172.16/12、192.168/16、169.254/16、
 *     100.64/10、192.0.2/24、198.51.100/24、203.0.113/24 —— 这些是本地测试桩用的
 *   - **注释行**里出现的线上地址（主机在 `config/endpoints.json` 的 `allowedHosts` 里）：说明文字不参与运行
 *   - 同一行（或上一行）带 `check-ip-allow` 标记的字面量：给「已下线主机名单」「规范条款号」
 *     这类必须写出 IP 形状的地方用，必须注明理由
 *   - 版本语境里的四段点分十进制（模拟器 / WebView / Chrome 的版本号）：四段点分十进制的版本号
 *     和 IPv4 语法上无法区分，段范围校验也救不了，只能看上下文。判定条件必须同时成立：
 *     出现版本语义词（emulator / webview / sdk / version / 模拟器 / 版本 …），**且**同处不出现
 *     主机/地址语义词（host / server / url / http / 服务器 / 生产 / 地址 / 迁移 …）。后一条是否决
 *     规则，所以 `// 生产环境 <四段点分>`、`// 服务器版本 <四段点分>`、`// <四段点分> → <四段点分> 迁移`
 *     照样要报。细则与已知边界见 scripts/lib/hardcodedIpAudit.mjs 的文件头。
 *
 * 主机白名单从哪来（Issue #274）：`config/endpoints.json` 的 `allowedHosts` —— 与本文件扫的源码
 * 同一事实来源，换机器只改那份 JSON，不需要再来这里同步一份名单。**代码行**里出现白名单主机也算
 * 违规（地址只能来自 `__ENDPOINTS__` / `scripts/lib/endpoints.mjs`）；只有注释行里的说明文字例外。
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

import { ALLOWED_HOSTS, REASON, scanText } from './lib/hardcodedIpAudit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫这些目录（相对仓库根） */
const SCAN_DIRS = ['src', 'scripts']

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

/** 扫一个文件：读文本，判定交给 lib（二进制兜底在 scanText 里） */
const scanFile = (file) => {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return scanText(text)
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

  console.error(`发现 ${violations.length} 处写死的 IP（服务端地址请走 config/endpoints.json，别散落在代码里）：`)
  for (const v of violations) {
    const hint =
      v.reason === REASON.allowedHostInCode
        ? '（白名单主机，但代码行里不许写死：走 __ENDPOINTS__ / scripts/lib/endpoints.mjs）'
        : ''
    console.error(`  ${v.file}:${v.line}: ${v.ip}${hint}`)
  }
  console.error(
    '\n允许的例外：回环/私有/保留测试段、版本语境里的四段点分十进制版本号、**注释行**里的线上地址，' +
      `以及同一行（或上一行）带 check-ip-allow 并写明理由的字面量。线上主机白名单来自 ` +
      `config/endpoints.json 的 allowedHosts（${[...ALLOWED_HOSTS].join(', ')}）：换机器只改那一份 JSON，` +
      '门禁自动跟上；代码行里再写一次地址照样会红。',
  )
  process.exit(1)
}

main()
