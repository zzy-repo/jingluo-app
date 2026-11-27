#!/usr/bin/env node
/**
 * check-internal-lane.mjs —— 内测包的「覆盖升级」硬断言（用户规则，2026-11-27 拍板）。
 *
 * 判据（缺一不可，全部在**出包这一秒**就能判，不靠人记）：
 *   1. `package.json` 的 `androidVersionCode` 是正整数（它是 Android versionCode 的唯一来源）；
 *   2. 它 **严格大于** `docs/release/internal-lane.json` 的 `lastDistributedVersionCode`
 *      —— 每次对外分发新内测 APK，versionCode 必须递增（44 → 45 → 46 …），
 *      `versionName` 可以维持 `2.0.1`。目的：避免版本混淆、保证已装用户能**直接覆盖升级**
 *      （无须卸载重装、保留全部历史数据）；
 *   3. `config/appIdentity.json` 的 `expectedCertSha256` **以台账里的 `certSha256Prefix` 开头**
 *      —— 换签名证书会让已装用户无法覆盖升级（Android 只允许同证书的更新包覆盖安装）。
 *      前缀够用：完整的 64 位比对由 `verify-release-apk.mjs` 第 4 项做（同一份配置派生），
 *      这里要拦的是「配置被换成另一把证书」这种整段替换，不是抄第二份完整指纹。
 *
 * 为什么不做成「从线上清单取上一个 versionCode」：内测包**不进公网清单**
 * （`docs/releases-manifest.md` §1 明确废止了 internal 条目），本机没有任何可信来源能自动得出
 * 「上一个分发出去的是几」。所以拿台账当唯一来源，并且**台账不自动改写**：谁分发谁记一行。
 *
 * 用法：
 *   node scripts/check-internal-lane.mjs                 # 对着当前 package.json 判（出包前必跑）
 *   node scripts/check-internal-lane.mjs --version-code 44   # 判「如果目标是 44」会怎样（预演）
 *   node scripts/check-internal-lane.mjs --json
 *
 * 退出码：0 通过 / 1 判据不通过（点名哪一条、差多少）/ 2 用法或配置本身读不出来（fail-closed）。
 *
 * 只读：不修改任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_ENV = 2

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = 'docs/release/internal-lane.json'
const IDENTITY = 'config/appIdentity.json'
const PKG = 'package.json'

const die = (code, message) => {
  process.stderr.write(`\n[check:internal-lane] ERROR ${message}\n\n`)
  process.exit(code)
}

const readJson = (rel, what) => {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) die(EXIT_ENV, `找不到${what}：${rel}`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    die(EXIT_ENV, `${rel} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 33).join('\n') + '\n')
  process.exit(EXIT_OK)
}
const jsonOut = argv.includes('--json')
const codeFlagIndex = argv.indexOf('--version-code')
const overrideCode = codeFlagIndex >= 0 ? Number(argv[codeFlagIndex + 1]) : null
if (codeFlagIndex >= 0 && !Number.isInteger(overrideCode)) die(EXIT_ENV, '--version-code 需要一个整数')

const pkg = readJson(PKG, '的 package.json')
const ledger = readJson(LEDGER, '的内测台账')
const identity = readJson(IDENTITY, '的已发布身份配置')

const versionName = typeof pkg.version === 'string' ? pkg.version.trim() : ''
if (!versionName) die(EXIT_ENV, 'package.json 的 version 读不出来：它是 versionName 的唯一来源')

const rawCode = overrideCode ?? pkg.androidVersionCode
if (!Number.isInteger(rawCode) || rawCode <= 0) {
  die(EXIT_ENV, `versionCode 不是正整数（${String(rawCode)}）：package.json 的 androidVersionCode 是唯一来源`)
}

const last = ledger.lastDistributedVersionCode
if (!Number.isInteger(last) || last <= 0) {
  die(EXIT_ENV, `${LEDGER} 的 lastDistributedVersionCode 不是正整数（${String(last)}）：台账坏了等于闸门不存在`)
}

const history = Array.isArray(ledger.history) ? ledger.history : []
const historyCodes = history
  .map((item) => (item && typeof item === 'object' ? item.versionCode : null))
  .filter((code) => Number.isInteger(code))
const chain = [...new Set([...historyCodes, last, rawCode])].sort((a, b) => a - b)

const prefix = typeof ledger.certSha256Prefix === 'string' ? ledger.certSha256Prefix.trim().toLowerCase() : ''
if (!/^[0-9a-f]{8,64}$/.test(prefix)) {
  die(EXIT_ENV, `${LEDGER} 的 certSha256Prefix 不像十六进制指纹前缀（${JSON.stringify(ledger.certSha256Prefix)}）`)
}
const cert = typeof identity.expectedCertSha256 === 'string' ? identity.expectedCertSha256.trim().toLowerCase() : ''
if (!/^[0-9a-f]{64}$/.test(cert)) {
  die(EXIT_ENV, `${IDENTITY} 的 expectedCertSha256 不是 64 位十六进制（${JSON.stringify(identity.expectedCertSha256)}）`)
}

const checks = []
const push = (item, ok, detail) => checks.push({ item, ok, detail })

push(
  `versionCode 严格大于上一次分发（${rawCode} > ${last}）`,
  rawCode > last,
  rawCode > last
    ? `ok（覆盖升级链 ${chain.join(' → ')}）`
    : `不允许：${rawCode} ≤ ${last}。每次对外分发新内测包 versionCode 必须递增（${last} → ${last + 1}）。` +
      `已装 vc${last} 的用户装不上同号或降号的包 —— 那条路只会得到「应用未安装」。` +
      `修法：把 package.json 的 androidVersionCode 改成 ${last + 1} 或更大；versionName 可以继续是 ${versionName}。`,
)
push(
  '覆盖升级历史连续（台账里没有比上次分发更大的号）',
  historyCodes.every((code) => code <= last),
  historyCodes.every((code) => code <= last)
    ? `ok（台账最大 ${last}）`
    : `台账 lastDistributedVersionCode=${last} 小于 history 里出现过的 ${Math.max(...historyCodes)}：台账自相矛盾，先修台账`,
)
push(
  `签名证书仍是已发布的那把（expectedCertSha256 以 ${prefix} 开头）`,
  cert.startsWith(prefix),
  cert.startsWith(prefix)
    ? `ok（${cert.slice(0, 12)}…${cert.slice(-6)}）`
    : `不允许：config/appIdentity.json 的 expectedCertSha256=${cert} 不以 ${prefix} 开头 —— 换签 = 已装用户无法覆盖升级。` +
      '不要去改 certSha256Prefix 让它过，先确认签名材料是不是换错了',
)

const failed = checks.filter((check) => !check.ok)
if (jsonOut) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: failed.length === 0,
        versionName,
        versionCode: rawCode,
        lastDistributedVersionCode: last,
        chain,
        checks,
      },
      null,
      2,
    ) + '\n',
  )
} else {
  const rows = checks.map((check, index) => `${index + 1}  ${check.ok ? '✅' : '❌'}  ${check.item}\n     ${check.detail}`)
  process.stdout.write(
    `\n[check:internal-lane] 内测包覆盖升级判据（versionName=${versionName} versionCode=${rawCode}）\n\n` +
      rows.join('\n') +
      `\n\n${
        failed.length === 0
          ? `结论：PASS —— 已装 vc${chain.filter((code) => code < rawCode).join(' / vc')} 的内测用户可直接覆盖升级（同证书，code 递增）\n`
          : `结论：FAIL —— ${failed.length} 条不通过（上面点名了），不许对外分发\n`
      }\n`,
  )
}

process.exit(failed.length === 0 ? EXIT_OK : EXIT_FAIL)
