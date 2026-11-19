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
 *
 * 只读：不修改任何文件、不打印任何口令内容（只打印长度）。
 *
 * 用法：
 *   node scripts/check-keystore-config.mjs
 *   node scripts/check-keystore-config.mjs --file android/keystore/keystore.properties
 *   pnpm run check:keystore
 *
 * 退出码：
 *   0  形状正确
 *   1  配置不合格（缺键 / 路径不对 / 读不到证书 / 口令或别名错）
 *   2  环境不合格（没有属性文件、找不到 keytool、用法错误）—— 同样当失败处理（fail-closed）
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
    '用法: node scripts/check-keystore-config.mjs [--file <keystore.properties>] [--quiet]',
    '',
    '检查内容: 属性文件存在 / 四个 release 键齐全 / storeFileRelease 指向的文件存在 / keytool 能读到证书',
    '退出码: 0 通过 / 1 配置不合格 / 2 环境不合格（无文件、无 keytool、用法错误）',
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

/** 读已发布证书指纹（与 build.gradle 的闸门同一个常量；读不到就不比对，只做形状判定） */
function expectedCertSha256() {
  try {
    const m = /EXPECTED_CERT_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/.exec(fs.readFileSync(BUILD_GRADLE, 'utf8'))
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
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
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-h' || a === '--help') {
      console.log(usage())
      return EXIT_OK
    } else if (a === '--quiet' || a === '-q') {
      quiet = true
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

  // ---- 附加信息：证书指纹（不判定成败，换证书归 #271 管） ----
  const sha = (/SHA-?256:\s*([0-9A-Fa-f:]{64,95})/.exec(list.out) ?? [])[1]
  const shaHex = sha ? sha.replace(/:/g, '').toLowerCase() : null
  const expected = expectedCertSha256()
  if (!quiet && shaHex) {
    console.log(`  证书 SHA-256         = ${shaHex}`)
    if (expected && shaHex !== expected) {
      console.log(`  ⚠ 这不是已发布证书（build.gradle 期望 ${expected}）。`)
      console.log('    形状没问题，但 release 构建会被指纹闸门中止；换证书属于签名迁移，见 docs/RELEASE-MANUAL.md §1 与 #271。')
    }
  }
  if (list.legacyPassArg && !quiet) {
    console.log('  提示: 本机 keytool 不支持 -storepass:file（JDK 8），口令经命令行传入；升级到 JDK 21 可避免。')
  }

  if (!quiet) console.log(`\n通过: 四个 release 键齐全，${rel(storeFile)} 存在且能读到 ${alias} 的证书。`)
  return EXIT_OK
}

process.exitCode = main(process.argv.slice(2))
