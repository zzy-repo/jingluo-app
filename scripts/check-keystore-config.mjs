#!/usr/bin/env node
/**
 * check-keystore-config.mjs —— 签名凭据的「形状门禁」（Issue #272）。
 *
 * 为什么要有它：`android/keystore/keystore.properties` 的四个 release 键名长期靠口传
 * （`storeFileRelease` / `storePasswordRelease` / `keyAliasRelease` / `keyPasswordRelease`），
 * 写错一个字母时 build.gradle 只会报「缺字段」；路径写成 `keystore/release.keystore` 时
 * 它按 android/app/ 解析、指向不存在的文件；口令/别名错了要到读指纹那一步才炸。
 * 三种失败在 gradle 输出里长得都像「签名不行」，新机器接手时几乎无法定位。
 *
 * 这个脚本把「形状对不对」从 gradle 里拆出来单独判，输出直接说清
 * **缺哪个键 / 哪个路径不对 / 读不到证书的原因**，并在非 0 时给出修法。
 *
 * 判据（缺一不可）：
 *   1. 属性文件存在（默认 android/keystore/keystore.properties，可用 --file 指定）
 *   2. 四个 release 键齐全且非空
 *   3. storeFileRelease 解析到的文件存在
 *   4. keytool 能用 storePasswordRelease 打开该 keystore，且 keyAliasRelease 指向一张证书
 *   5. 读出来的证书 SHA-256 **必须等于已发布证书**（期望值来自 `config/appIdentity.json` 的
 *      `expectedCertSha256`，与 build.gradle 的 `EXPECTED_CERT_SHA256` 闸门同一个值）
 *
 * #697 —— 第 5 条以前是**死代码**：`expectedCertSha256()` 用正则去 `android/app/build.gradle`
 * 找 `EXPECTED_CERT_SHA256 = '<64 hex>'` 字面量，而 #271 之后该值已迁到 `config/appIdentity.json`
 * （build.gradle 改成从配置派生），于是期望值恒为 null、比较分支永不进入 —— 指纹不符一句警告都
 * 打不出来，「已发布证书」这道唯一能发现「签名换了一把 key」的检查等于不存在。
 * 现在：主源是 `config/appIdentity.json`（唯一来源），build.gradle 的字面量只作**兼容回落**，
 * 两处都有副本时必须一致（否则就是第二份真相源 → 判红）；不符 → exit 1 并点名期望/实际。
 *
 * 降级模式 `--config-only`（#697 接线用）：CI 上**没有** release keystore（secret 只在
 * `.github/workflows/release.yml` 里注入），这一步没法验真签名。于是显式跑降级档：
 * 只校验「期望值的来源与一致性」（配置里有合法的 64 位十六进制 + build.gradle 若有副本必须相等），
 * **不校验真签名**。它不是静默跳过 —— 配置坏了照样红，并且把「校验了什么 / 没校验什么」打在日志里。
 * 全量（真 keytool 读指纹 + 指纹必须等于期望）由发布机的 `pnpm run check:keystore` 跑。
 *
 * 只读：不修改任何文件、不打印任何口令内容（只打印长度）。
 *
 * 用法：
 *   node scripts/check-keystore-config.mjs
 *   node scripts/check-keystore-config.mjs --file android/keystore/keystore.properties
 *   node scripts/check-keystore-config.mjs --config-only          # CI 降级档（不验真签名）
 *   pnpm run check:keystore
 *
 * 退出码：
 *   0  形状正确（降级档：配置与来源一致）
 *   1  配置不合格（缺键 / 路径不对 / 读不到证书 / 口令或别名错 / **证书指纹不符** / 两份来源不一致）
 *   2  环境不合格（没有属性文件、找不到 keytool、用法错误、读不到期望指纹）—— 同样当失败处理（fail-closed）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const EXIT_OK = 0
const EXIT_BAD_CONFIG = 1
const EXIT_BAD_ENV = 2

/** 默认属性文件（与 android/app/build.gradle 的 rootProject.file("keystore/keystore.properties") 一致） */
const DEFAULT_PROPS = path.join(ROOT, 'android/keystore/keystore.properties')
const EXAMPLE_PROPS = path.join(ROOT, 'android/keystore/keystore.properties.example')
const BUILD_GRADLE = path.join(ROOT, 'android/app/build.gradle')
/** 已发布证书指纹的**唯一来源**（#271：身份事实只记在 config/appIdentity.json） */
const APP_IDENTITY = path.join(ROOT, 'config/appIdentity.json')
const APP_IDENTITY_REL = 'config/appIdentity.json'
const BUILD_GRADLE_REL = 'android/app/build.gradle'
/** storeFile* 的相对路径基准：Gradle 在 app 模块里调 file()，所以是 android/app/ */
const STORE_FILE_BASE = path.join(ROOT, 'android/app')

/** release 四个必填键（顺序 = 报错顺序） */
const REQUIRED_KEYS = [
  ['storeFileRelease', 'release keystore 文件路径'],
  ['storePasswordRelease', 'keystore 的 store password'],
  ['keyAliasRelease', '证书别名'],
  ['keyPasswordRelease', '私钥口令'],
]

/** 常见键名错法 → 正确键名（报「缺键」时直接点出来） */
const TYPO_HINTS = [
  ['storeFile', 'storeFileRelease'],
  ['storefileRelease', 'storeFileRelease'],
  ['storePassword', 'storePasswordRelease'],
  ['storePassRelease', 'storePasswordRelease'],
  ['keyAlias', 'keyAliasRelease'],
  ['aliasRelease', 'keyAliasRelease'],
  ['keyPassword', 'keyPasswordRelease'],
  ['storeFileRelase', 'storeFileRelease'],
]

function usage() {
  return [
    '用法: node scripts/check-keystore-config.mjs [--file <keystore.properties>] [--config-only] [--quiet]',
    '',
    '检查内容: 属性文件存在 / 四个 release 键齐全 / storeFileRelease 指向的文件存在 / keytool 能读到证书 /',
    '          证书 SHA-256 必须等于 config/appIdentity.json 的 expectedCertSha256',
    '--config-only: 降级档（CI 上没有 release keystore 时用）：只校验期望值的来源与一致性，不校验真签名',
    '退出码: 0 通过 / 1 配置不合格（含指纹不符） / 2 环境不合格（无文件、无 keytool、读不到期望值、用法错误）',
  ].join('\n')
}

/** 极简 .properties 解析：跳过 # 与 ! 注释，按键值第一个 = 或 : 切开，去首尾空白 */
function parseProperties(text) {
  const props = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const m = /^([^=:]+)[=:](.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (key) props.set(key, value)
  }
  return props
}

function rel(p) {
  const r = path.relative(ROOT, p)
  return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p
}

/** 找可用的 keytool：先 JAVA_HOME，再 PATH */
function findKeytool() {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool'
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe))
  candidates.push(exe)
  for (const c of candidates) {
    try {
      execFileSync(c, ['-help'], { stdio: 'ignore', timeout: 20000 })
      return c
    } catch {
      // -help 的退出码各家不同，能执行到这一步再看下面的显式探测
      try {
        execFileSync(c, ['-J-version'], { stdio: 'ignore', timeout: 20000 })
        return c
      } catch {
        continue
      }
    }
  }
  return null
}

/** build.gradle 里遗留的指纹字面量（老 checkout 的兼容来源；#271 之后本仓改为从配置派生） */
function gradleCertLiteral() {
  try {
    const m = /EXPECTED_CERT_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/.exec(fs.readFileSync(BUILD_GRADLE, 'utf8'))
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * 读已发布证书指纹：**主源 `config/appIdentity.json` 的 `expectedCertSha256`**（#271 的唯一来源）。
 * 读不到/格式不对才回落到 build.gradle 的字面量（老 checkout 兼容），两者都在时由
 * `assertSingleFingerprintSource` 判一致。
 * 返回 `{ value, source, invalid }`：`value === null` 表示判不出来（调用方 fail-closed）。
 */
function expectedCertSha256() {
  try {
    const parsed = JSON.parse(fs.readFileSync(APP_IDENTITY, 'utf8'))
    const raw = typeof parsed?.expectedCertSha256 === 'string' ? parsed.expectedCertSha256.trim().toLowerCase() : ''
    if (/^[0-9a-f]{64}$/.test(raw)) return { value: raw, source: APP_IDENTITY_REL }
    return { value: null, source: APP_IDENTITY_REL, invalid: raw === '' ? '缺失或不是字符串' : `不是 64 位小写十六进制：'${raw}'` }
  } catch (e) {
    // 文件不存在 → 走兼容回落；解析失败 / 读不动 → 判不出来（不做「猜一个」）
    if (e?.code !== 'ENOENT') return { value: null, source: APP_IDENTITY_REL, invalid: `读不出来（${e.message}）` }
  }
  const literal = gradleCertLiteral()
  if (literal) return { value: literal, source: BUILD_GRADLE_REL }
  return { value: null, source: null }
}

/**
 * 期望值的两份副本必须相等（主源 JSON + 兼容回落 gradle 字面量）。
 * 不相等 = 第二份真相源：一处改了另一处没改，迟早「按这份配置过闸、按那份配置构建」。
 */
function assertSingleFingerprintSource(expected, log = console.error) {
  const literal = gradleCertLiteral()
  if (!expected.value || !literal || literal === expected.value) return true
  log('[FAIL] 证书指纹有两份来源且不一致（第二份真相源）：')
  log(`       期望 ${expected.value}（来源 ${expected.source}）`)
  log(`       实际 ${literal}（来源 ${BUILD_GRADLE_REL} 的 EXPECTED_CERT_SHA256 字面量）`)
  log('')
  log('  修法: 指纹只许有一个来源 —— config/appIdentity.json 的 expectedCertSha256（#271）。')
  log(`        把 ${BUILD_GRADLE_REL} 里那份字面量删掉（改成从配置派生），或把它改成与配置相同的值。`)
  log('        不要通过改期望值让闸门变绿：换证书 = 已装用户无法覆盖升级（docs/RELEASE-MANUAL.md §1）。')
  return false
}

/**
 * 降级档（`--config-only`）：CI 上没有 release keystore 时用。
 * 只判「期望值从哪来、一致不一致」，**不判真签名** —— 并把这件事明确打出来（不是静默跳过）。
 */
function configOnlyCheck(quiet) {
  const expected = expectedCertSha256()
  if (!expected.value) {
    console.error(`[FAIL] 读不到已发布证书指纹的期望值（来源 ${expected.source ?? `既没有 ${APP_IDENTITY_REL}，也没有 ${BUILD_GRADLE_REL} 的字面量`}）`)
    if (expected.invalid) console.error(`       ${APP_IDENTITY_REL} 的 expectedCertSha256 ${expected.invalid}`)
    console.error('')
    console.error('  修法: 唯一的来源是 config/appIdentity.json 的 expectedCertSha256（64 位小写十六进制，#271）。')
    console.error('        这份文件入库、不该读不到；读不到就是仓库被改坏了，先修它再谈签名。')
    return EXIT_BAD_ENV
  }
  if (!assertSingleFingerprintSource(expected)) return EXIT_BAD_CONFIG

  if (!quiet) {
    console.log('模式: --config-only（CI 降级档）')
    console.log(`  期望证书 SHA-256      = ${expected.value}（来源 ${expected.source}）`)
    console.log('  本档**不校验真签名**：本机/CI 没有 release keystore 时无从比对，所以只校验「期望值的来源与一致性」。')
    console.log(`  全量（keytool 读出证书指纹并要求等于上面的值）由发布机跑：pnpm run check:keystore（.github/workflows/release.yml 已接）。`)
  }
  if (!quiet) console.log(`\n通过: ${APP_IDENTITY_REL} 的 expectedCertSha256 可用${gradleCertLiteral() ? `，且与 ${BUILD_GRADLE_REL} 的字面量一致` : `（${BUILD_GRADLE_REL} 已无副本）`}。`)
  return EXIT_OK
}

function keytoolList(keytool, storeFile, storePass, alias) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-check-'))
  const passFile = path.join(tmpDir, 'storepass')
  fs.writeFileSync(passFile, storePass, { mode: 0o600 })
  const run = (passArgs) => {
    try {
      // -J 两项：把 keytool 的诊断固定成英文 UTF-8。否则中文 Windows 的 JVM 会用 GBK 输出
      // （node 按 UTF-8 解码得到乱码），且「别名不存在 / 口令错误」的原文与下面的判据对不上。
      const out = execFileSync(
        keytool,
        ['-J-Duser.language=en', '-J-Dfile.encoding=UTF-8', '-list', '-v', '-keystore', storeFile, ...passArgs, '-alias', alias],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
      )
      return { ok: true, out }
    } catch (e) {
      return {
        ok: false,
        out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(),
        unrecognized: /Unrecognized option|Illegal option/i.test(`${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`),
      }
    }
  }
  try {
    // 优先把口令放临时文件（JDK 9+ 的 :file 语法），避免出现在命令行 / 进程列表里
    let r = run([`-storepass:file`, passFile])
    if (!r.ok && r.unrecognized) {
      // JDK 8 只认 -storepass <arg>：仅本机回退，并在输出里说明
      r = run(['-storepass', storePass])
      r.legacyPassArg = true
    }
    return r
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
}

function main(argv) {
  let propsFile = DEFAULT_PROPS
  let quiet = false
  let configOnly = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') {
      // `pnpm run check:keystore -- --config-only` 会把 `--` 原样转进来（pnpm 11 实测），
      // 它不是参数、也不是结束符 —— 跳过（与 scripts/release-common.mjs 的 parseArgs 同口径）。
      continue
    }
    if (a === '-h' || a === '--help') {
      console.log(usage())
      return EXIT_OK
    } else if (a === '--quiet' || a === '-q') {
      quiet = true
    } else if (a === '--config-only') {
      // 显式降级档：CI 没有 release keystore 时只校验配置一致性（不静默跳过，见文件头）
      configOnly = true
    } else if (a === '--file') {
      const v = argv[i + 1]
      if (!v) {
        console.error(`--file 缺少路径\n\n${usage()}`)
        return EXIT_BAD_ENV
      }
      propsFile = path.resolve(ROOT, v)
      i += 1
    } else if (a.startsWith('-')) {
      console.error(`未知参数: ${a}\n\n${usage()}`)
      return EXIT_BAD_ENV
    } else {
      propsFile = path.resolve(ROOT, a)
    }
  }

  // 降级档：只校验期望值的来源与一致性（不碰 keystore / keytool，也不假装验过签名）
  if (configOnly) return configOnlyCheck(quiet)

  const problems = []

  // ---- 1. 属性文件存在 ----
  if (!fs.existsSync(propsFile)) {
    console.error(`[FAIL] 找不到签名属性文件: ${rel(propsFile)}`)
    console.error('       这就是「新机器出不了 release 包」的第一道坎：这份文件不入库，必须手工放到本机。')
    console.error('')
    console.error('  修法:')
    console.error(`    1) cp ${rel(EXAMPLE_PROPS)} ${rel(propsFile)}`)
    console.error(`    2) 按 ${rel(EXAMPLE_PROPS)} 的注释填四个 *Release 键（键名必须带 Release 后缀）`)
    console.error('    3) chmod 600 ' + rel(propsFile) + '，再跑 pnpm run check:keystore')
    return EXIT_BAD_ENV
  }

  const props = parseProperties(fs.readFileSync(propsFile, 'utf8'))

  // ---- 2. 四个 release 键齐全 ----
  const present = Object.fromEntries([...props.keys()].map((k) => [k, props.get(k)]))
  const missing = REQUIRED_KEYS.filter(([key]) => !props.get(key))
  if (missing.length) {
    console.error(`[FAIL] ${rel(propsFile)} 缺少 ${missing.length} 个必填键（键名必须带 Release 后缀）:`)
    for (const [key, what] of missing) {
      const typo = TYPO_HINTS.find(([wrong, right]) => right === key && present[wrong] !== undefined)
      const tail = typo
        ? `  ← 文件里写的是 \`${typo[0]}\`，键名错了：改成 \`${key}\``
        : props.get(key) === ''
          ? '  ← 键在但值为空'
          : ''
      console.error(`       - ${key}  （${what}）${tail}`)
    }
    const unknownReleaseish = [...props.keys()].filter(
      (k) => !REQUIRED_KEYS.some(([key]) => key === k) && /release/i.test(k),
    )
    if (unknownReleaseish.length) {
      console.error(`       文件里这几个 release 相关键名不匹配必需清单: ${unknownReleaseish.join(', ')}`)
    }
    console.error('')
    console.error('  修法:')
    console.error(`    对照 ${rel(EXAMPLE_PROPS)} 补齐上面列的键；四个键名只认:`)
    for (const [key] of REQUIRED_KEYS) console.error(`      ${key}`)
    console.error('    键名少了 Release 后缀（如 storeFile、keyPassword）不会被当作 release 凭据。')
    return EXIT_BAD_CONFIG
  }

  // ---- 3. storeFileRelease 指向的文件存在 ----
  const storeFileRaw = props.get('storeFileRelease')
  const storeFile = path.isAbsolute(storeFileRaw)
    ? storeFileRaw
    : path.resolve(STORE_FILE_BASE, storeFileRaw)
  const storePass = props.get('storePasswordRelease')
  const alias = props.get('keyAliasRelease')
  const keyPass = props.get('keyPasswordRelease')

  if (!quiet) {
    console.log(`属性文件: ${rel(propsFile)}`)
    console.log(`  storeFileRelease     = ${storeFileRaw}`)
    console.log(`                          → ${storeFile}${path.isAbsolute(storeFileRaw) ? '（绝对路径）' : `（相对 ${rel(path.join(ROOT, 'android/app'))}/ 解析，与 Gradle 的 file() 一致）`}`)
    console.log(`  storePasswordRelease = <${storePass.length} 字符，不显示>${storePass ? '' : ''}`)
    console.log(`  keyAliasRelease      = ${alias}`)
    console.log(`  keyPasswordRelease   = <${keyPass.length} 字符，不显示>${keyPass === storePass ? '（与 store password 相同）' : ''}`)
  }

  if (!fs.existsSync(storeFile)) {
    console.error(`[FAIL] storeFileRelease 指向的文件不存在: ${storeFile}`)
    console.error(`       键值原样是: ${storeFileRaw}`)
    console.error('')
    console.error('  修法:')
    console.error('    1) 相对路径是相对 android/app/ 解析的（Gradle 在 app 模块里调 file()），不是仓库根、也不是 android/。')
    console.error('       写 `keystore/release.keystore` 会解析成 android/app/keystore/release.keystore —— 一般不存在。')
    console.error('    2) 建议直接写绝对路径，例如已发布证书那把:')
    console.error('       storeFileRelease=/root/.android/debug.keystore')
    console.error('    3) 先 ls 一下这个路径确认文件真的在；keystore 文件本身不入库，换机器要单独搬运（docs/RELEASE-MANUAL.md §1）。')
    return EXIT_BAD_CONFIG
  }
  if (fs.statSync(storeFile).isDirectory()) {
    console.error(`[FAIL] storeFileRelease 指向的是目录，不是 keystore 文件: ${storeFile}`)
    console.error('  修法: 指向具体的 .keystore / .jks 文件（目录不行）。')
    return EXIT_BAD_CONFIG
  }

  // ---- 4. keytool 能读到证书 ----
  const keytool = findKeytool()
  if (!keytool) {
    console.error('[FAIL] 找不到 keytool，无法确认 keystore 能不能被正确口令打开（按失败处理，不跳过）。')
    console.error('')
    console.error('  修法: 装 JDK 21 并让 keytool 出现在 PATH，或 export JAVA_HOME=<jdk 根目录> 后重跑。')
    console.error('       ./build-apk.sh 也是用 JAVA_HOME/bin/keytool，缺它本来就会 die。')
    return EXIT_BAD_ENV
  }

  const list = keytoolList(keytool, storeFile, storePass, alias)
  if (!list.ok) {
    const raw = list.out.split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n       ')
    const badPass = /password was incorrect|Keystore was tampered with|UnrecoverableKey|password/i.test(list.out)
    const badAlias = /does not exist|Alias .* does not exist/i.test(list.out)
    console.error(`[FAIL] keytool 读不到 ${alias} 的证书（${rel(storeFile)}）`)
    if (badAlias) {
      console.error(`       原因: 别名 \`${alias}\` 在 keystore 里不存在。`)
    } else if (badPass) {
      console.error('       原因: 口令打不开 keystore（storePasswordRelease / keyPasswordRelease 不对？）。')
    } else {
      console.error('       原因: 未能分类，keytool 原文见下。')
    }
    if (raw) console.error(`       ${raw}`)
    console.error('')
    console.error('  修法:')
    console.error(`    1) 列出现有别名: keytool -list -keystore "${storeFile}"    （会提示输入 store password）`)
    console.error('    2) 别名对不上 → 改 keyAliasRelease；口令不对 → 改 storePasswordRelease / keyPasswordRelease。')
    console.error('    3) PKCS12 keystore 的 store password 与 key password 通常相同，两个都写错时先修 storePasswordRelease。')
    console.error('    4) 口令里带 # = : 等符号时不要加引号（.properties 不支持引号转义）。')
    return EXIT_BAD_CONFIG
  }

  // ---- 5. 证书指纹必须等于已发布证书（#697：这条以前是死代码，现在真的咬） ----
  // 期望值唯一来源 = config/appIdentity.json 的 expectedCertSha256（#271）；build.gradle 的字面量
  // 只作兼容回落。读不出来 / 判不出来 → fail-closed（exit 2），不猜着放行。
  const sha = (/SHA-?256:\s*([0-9A-Fa-f:]{64,95})/.exec(list.out) ?? [])[1]
  const shaHex = sha ? sha.replace(/:/g, '').toLowerCase() : null
  const expected = expectedCertSha256()
  if (!quiet) console.log(`  证书 SHA-256         = ${shaHex ?? '（keytool 没有输出 SHA-256）'}`)

  if (!shaHex) {
    console.error('[FAIL] keytool 打开了 keystore，但输出里读不到证书的 SHA-256 —— 判不出来按失败处理（不猜着放行）。')
    console.error('  修法: 升级 JDK（keytool -list -v 的标准输出里应有 SHA-256 行），或人工核对：')
    console.error(`        keytool -list -v -keystore "${storeFile}" | grep -i sha256`)
    return EXIT_BAD_ENV
  }

  if (!expected.value) {
    console.error(`[FAIL] 读不到已发布证书指纹的期望值（来源 ${expected.source ?? `既没有 ${APP_IDENTITY_REL}，也没有 ${BUILD_GRADLE_REL} 的字面量`}）`)
    if (expected.invalid) console.error(`       ${APP_IDENTITY_REL} 的 expectedCertSha256 ${expected.invalid}`)
    console.error('')
    console.error('  修法: 唯一的来源是 config/appIdentity.json 的 expectedCertSha256（64 位小写十六进制，#271）。')
    console.error('        这份文件入库、不该读不到；读不到就没法回答「这把 key 是不是已发布证书」，绝不能当通过。')
    return EXIT_BAD_ENV
  }

  if (!assertSingleFingerprintSource(expected)) return EXIT_BAD_CONFIG

  if (shaHex !== expected.value) {
    console.error('[FAIL] 证书指纹不符 —— 这把 key 不是已发布证书')
    console.error(`       期望 ${expected.value} 实际 ${shaHex}（来源 ${expected.source}）`)
    console.error('')
    console.error('  为什么这是 P0: 换证书 = 已装用户无法覆盖升级（签名不同的包装不上去），')
    console.error('                历史所有版本（含 1.4.0-beta.8）都是同一张 —— 这一行就是唯一能发现「签名换了」的检查。')
    console.error('  修法:')
    console.error('    1) 先用这把 key 核对一下它到底是什么:')
    console.error(`       keytool -list -v -keystore "${storeFile}" -alias ${alias} | grep -i sha256`)
    console.error('    2) 拿错 keystore 了（新机器 / 错目录 / 误用 debug key）→ 换成已发布的那把，不要动期望值。')
    console.error(`    3) **不要**为了过闸改 ${APP_IDENTITY_REL} 的 expectedCertSha256 或 ${BUILD_GRADLE_REL}：`)
    console.error('       那是换签名，必须单独规划迁移（新包名 / 商店渠道 / 引导重装），另开 Issue（#271）。')
    return EXIT_BAD_CONFIG
  }

  if (list.legacyPassArg && !quiet) {
    console.log('  提示: 本机 keytool 不支持 -storepass:file（JDK 8），口令经命令行传入；升级到 JDK 21 可避免。')
  }

  if (!quiet) {
    console.log(`  证书指纹             = 与已发布证书一致（来源 ${expected.source}）`)
    console.log(`\n通过: 四个 release 键齐全，${rel(storeFile)} 存在且能读到 ${alias} 的证书，指纹等于已发布证书。`)
  }
  return EXIT_OK
}

process.exitCode = main(process.argv.slice(2))
