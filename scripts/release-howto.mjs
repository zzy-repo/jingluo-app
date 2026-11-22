#!/usr/bin/env node
/**
 * release-howto.mjs —— 「接手发布」的一键串联：核对环境 → 取出签名凭据 → 构建 → 六项校验 → 取产物名 →
 * 提示下一步去发布控制台上传。docs/release/HOWTO-RELEASE.md 的第 15 节是它的说明书。
 *
 * 它**只出包、不发布**：不上传、不写 dl / 62、不建 GitHub Release、不打 tag、不推送。
 * 最后一步只打印「下一步该做什么」，上传与发布仍是人在发布控制台里的两次动作。
 *
 * 用法：
 *   node scripts/release-howto.mjs --dry-run                  # 只跑只读前置检查，并打印将要执行的命令
 *   node scripts/release-howto.mjs --last-code <n>            # 真跑；n = 已发布的最大 versionCode
 *   node scripts/release-howto.mjs --last-code <n> --skip-build --apk <path>   # 只校验一个现成 APK
 *
 * 选项：
 *   --dry-run          不构建、不解密、不写文件；前置检查照跑，失败照样 exit 1
 *   --last-code <n>    已发布的最大 versionCode。真跑必须给：本机没有可信来源能自动得出它
 *                      （main 上的 package.json 曾落后于线上；服务端也不查重），宁可让人填。
 *   --root <dir>       仓库根（默认：本脚本所在仓库）
 *   --secrets <file>   加密凭据包（默认 release-secrets/release-secrets.tar.enc）
 *   --skip-build       跳过 pnpm build / cap sync / gradle，配合 --apk 使用
 *   --apk <path>       --skip-build 时要校验的 APK
 *   --help
 *
 * 凭据口令：不写在任何文件里。环境变量 RELEASE_SECRETS_PASSPHRASE，或在终端里按提示输入（openssl 自己读）。
 *
 * 每一步的前置检查失败就停（exit 1）。退出码：0 全部通过 / 1 某步失败 / 2 用法错误。
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 })
export const REQUIRED_NODE_MAJOR = 22
export const REQUIRED_JAVA_MAJOR = 21
export const DEFAULT_NODE_OPTIONS = '--max-old-space-size=1536'
export const RELEASE_KEYS = Object.freeze(['storeFileRelease', 'storePasswordRelease', 'keyAliasRelease', 'keyPasswordRelease'])
export const SECRETS_ENV = 'RELEASE_SECRETS_PASSPHRASE'
const RE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const RE_SHA256 = /^[0-9a-f]{64}$/

const ok = (msg) => ({ ok: true, msg })
const bad = (msg, hint) => ({ ok: false, msg, hint })

/* ----------------------------------------------------------------- 纯函数（单测覆盖） */

export function parseArgs(argv) {
  const out = { dryRun: false, root: null, lastCode: null, secrets: null, skipBuild: false, apk: null, help: false, errors: [] }
  const needValue = new Set(['--root', '--last-code', '--secrets', '--apk'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--skip-build') out.skipBuild = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (needValue.has(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) { out.errors.push(`${a} 缺少取值`); continue }
      i++
      if (a === '--root') out.root = v
      else if (a === '--secrets') out.secrets = v
      else if (a === '--apk') out.apk = v
      else if (!/^\d+$/.test(v) || Number(v) <= 0) out.errors.push(`--last-code 必须是正整数：${v}`)
      else out.lastCode = Number(v)
    } else out.errors.push(`未知参数：${a}`)
  }
  if (out.skipBuild && !out.apk) out.errors.push('--skip-build 必须同时给 --apk <path>')
  return out
}

/** `node -v` 的输出（形如 v22.23.4）是否满足最低主版本 */
export function checkNode(versionText, minMajor = REQUIRED_NODE_MAJOR) {
  const m = /^v?(\d+)\.\d+\.\d+/.exec(String(versionText).trim())
  if (!m) return bad(`读不出 node 版本：${JSON.stringify(String(versionText).trim())}`, '确认 node 在 PATH 里（新机器：export PATH=/opt/node24/bin:$PATH）')
  const major = Number(m[1])
  return major >= minMajor ? ok(`node ${String(versionText).trim()}（需要 ≥ ${minMajor}）`) : bad(`node 主版本 ${major} < ${minMajor}`, '换 /opt/node24/bin 里的 node')
}

/** `java -version` 的输出（stderr 文本）是否是要求的 JDK 主版本 */
export function checkJava(versionText, requiredMajor = REQUIRED_JAVA_MAJOR) {
  const m = /version "(\d+)(?:\.\d+)*/.exec(String(versionText))
  if (!m) return bad('读不出 java 版本（没装 JDK？）', `装 JDK ${requiredMajor}，并让 java / keytool 在 PATH 里`)
  return Number(m[1]) === requiredMajor ? ok(`JDK ${m[1]}`) : bad(`JDK 主版本 ${m[1]}，要求 ${requiredMajor}`, `切到 JDK ${requiredMajor}（JAVA_HOME）`)
}

/** ANDROID_HOME 是否存在、是否带 apksigner；`exists` / `list` 可注入以便单测 */
export function checkAndroidSdk(androidHome, { exists = fs.existsSync, list = (d) => fs.readdirSync(d) } = {}) {
  if (!androidHome) return bad('ANDROID_HOME 未设置', '新机器：export ANDROID_HOME=$HOME/android-sdk')
  if (!exists(androidHome)) return bad(`ANDROID_HOME 不存在：${androidHome}`, '装 Android SDK 或改正路径')
  const bt = path.join(androidHome, 'build-tools')
  if (!exists(bt)) return bad(`缺少 ${bt}`, 'sdkmanager "build-tools;35.0.0"')
  const tiers = list(bt).filter((d) => exists(path.join(bt, d, 'apksigner')))
  return tiers.length ? ok(`${androidHome}（apksigner 档位：${tiers.sort().join(', ')}）`) : bad(`${bt} 下没有带 apksigner 的档位`, 'sdkmanager "build-tools;35.0.0"')
}

/** CHANGELOG 里是否有 `## <version>` 段 */
export function hasChangelogSection(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^##\\s+${esc}(?:\\s|$)`, 'm').test(String(text))
}

/** 版本号规则：格式、versionCode 为正整数且**严格大于**已发布最大值、CHANGELOG 有该版本段 */
export function checkVersionFields(pkg, { lastCode, changelogText }) {
  const version = String(pkg?.version ?? '')
  const code = pkg?.androidVersionCode
  if (!RE_VERSION.test(version)) return bad(`package.json version 非法：${JSON.stringify(version)}`, '形如 1.4.19 或 1.5.0-beta.1')
  if (!Number.isInteger(code) || code <= 0) return bad(`androidVersionCode 必须是正整数：${JSON.stringify(code)}`, '改 package.json')
  if (!Number.isInteger(lastCode) || lastCode <= 0) return bad('没给已发布的最大 versionCode（--last-code）', '查法见手册第 3 节；不给就不构建')
  if (code <= lastCode) {
    return bad(`versionCode ${code} ≤ 已发布最大值 ${lastCode}`, 'versionCode 必须严格递增，重复会让设备把新包当旧包（2.0.0 / 1.4.15 / 1.4.16 同码事故）')
  }
  if (!hasChangelogSection(changelogText, version)) return bad(`CHANGELOG.md 没有 "## ${version}" 段`, '先写用户能看懂的变更再出包')
  return ok(`version ${version} / versionCode ${code}（> 已发布最大值 ${lastCode}），CHANGELOG 有对应段`)
}

/** 相对路径按 android/app 解析（Gradle 在 app 模块里调 file()） */
export function resolveStoreFile(rel, appDir) {
  return path.isAbsolute(rel) ? rel : path.resolve(appDir, rel)
}

export function parseProperties(text) {
  const map = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  return map
}

/** keystore.properties 的形状：四个 *Release 键齐全、keystore 文件存在。不打印任何口令 */
export function checkSigningProps(propsText, { appDir, exists = fs.existsSync }) {
  const p = parseProperties(propsText)
  const missing = RELEASE_KEYS.filter((k) => !String(p[k] ?? '').trim())
  if (missing.length) {
    const unsuffixed = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].filter((k) => k in p)
    return bad(`缺少键：${missing.join(', ')}${unsuffixed.length ? `（发现不带 Release 后缀的 ${unsuffixed.join(', ')}，Gradle 不认）` : ''}`, '键名必须带 Release 后缀，见 keystore.properties.example')
  }
  const file = resolveStoreFile(p.storeFileRelease.trim(), appDir)
  if (!exists(file)) return bad(`storeFileRelease 指向的文件不存在：${file}`, '相对路径按 android/app/ 解析；建议写绝对路径')
  return ok(`四个 Release 键齐全，keystore = ${file}`)
}

/** 证书指纹比对：忽略冒号与大小写；期望值必须是 64 位十六进制 */
export function certsEqual(actual, expected) {
  const norm = (s) => String(s ?? '').replace(/[:\s]/g, '').toLowerCase()
  const a = norm(actual)
  const e = norm(expected)
  if (!RE_SHA256.test(e)) return bad(`期望指纹格式非法：${JSON.stringify(expected)}`, '来源是 config/appIdentity.json 的 expectedCertSha256')
  if (!RE_SHA256.test(a)) return bad(`实际指纹格式非法：${JSON.stringify(actual)}`)
  return a === e ? ok(`证书指纹 = ${e}`) : bad(`证书不一致：实际 ${a} ≠ 期望 ${e}`, '证书不一致的包装不上去（Android 不允许覆盖升级）；换 keystore，不许改期望值')
}

/** 构建锁：一次只跑一个重任务。`read` 返回锁里的 pid 或 null，`alive` 判断进程是否还在 */
export function lockState(read, alive) {
  const pid = read()
  if (pid == null) return { busy: false }
  return alive(pid) ? { busy: true, pid } : { busy: false, stale: pid }
}

/* ----------------------------------------------------------------- 运行时（有副作用，不在单测里跑） */

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

function sha256File(file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 33)
    console.log(head.map((l) => l.replace(/^ \* ?/, '')).join('\n'))
    return EXIT.OK
  }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`[用法错误] ${e}`)
    console.error('node scripts/release-howto.mjs --help')
    return EXIT.USAGE
  }

  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const root = path.resolve(args.root ?? here)
  const dry = args.dryRun
  const tag = dry ? 'DRY-RUN ' : ''
  const androidDir = path.join(root, 'android')
  const propsFile = path.join(androidDir, 'keystore', 'keystore.properties')
  const secretsFile = path.resolve(root, args.secrets ?? path.join('release-secrets', 'release-secrets.tar.enc'))
  const unpackDir = path.join(root, 'build', 'release-secrets')
  const outDir = path.join(root, 'build', 'release')
  const lockFile = path.join(os.tmpdir(), 'release-howto.lock')
  let n = 0
  const total = 6

  const head = (title) => console.log(`\n[${++n}/${total}] ${title}`)
  const show = (r) => { r.shown = true; console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.msg}${!r.ok && r.hint ? `\n       → ${r.hint}` : ''}`) }
  const stop = (r) => { if (!r.shown) show(r); console.log(`\n停在第 ${n}/${total} 步：前置检查没过，后面的步骤不会执行。`); return EXIT.FAIL }
  const plan = (cmd) => console.log(`  ${tag}${dry ? '将执行' : '执行'}: ${cmd}`)

  if (!fs.existsSync(path.join(root, 'package.json'))) {
    console.error(`[FAIL] ${root} 不是仓库根（没有 package.json）`)
    return EXIT.FAIL
  }
  console.log(`release-howto ${dry ? '（--dry-run：只读检查，不构建、不解密、不写文件）' : ''}\n仓库根：${root}`)

  // ---- 1/6 环境
  head('核对环境')
  const env = { ...process.env }
  env.ANDROID_HOME = env.ANDROID_HOME || path.join(os.homedir(), 'android-sdk')
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME
  if (!env.NODE_OPTIONS) env.NODE_OPTIONS = DEFAULT_NODE_OPTIONS
  let r = checkNode(process.version)
  show(r); if (!r.ok) return stop(r)
  const j = run('java', ['-version'])
  r = j.error ? bad('找不到 java', '装 JDK 21') : checkJava(`${j.stderr}${j.stdout}`)
  show(r); if (!r.ok) return stop(r)
  r = run('keytool', ['-help']).error ? bad('找不到 keytool', 'JDK 21 自带，确认 PATH') : ok('keytool 可用')
  show(r); if (!r.ok) return stop(r)
  r = checkAndroidSdk(env.ANDROID_HOME)
  show(r); if (!r.ok) return stop(r)
  const lock = lockState(
    () => (fs.existsSync(lockFile) ? Number(fs.readFileSync(lockFile, 'utf8')) || null : null),
    (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
  )
  r = lock.busy ? bad(`已有一个发布构建在跑（pid ${lock.pid}）`, '一次只跑一个重任务：等它跑完，或确认它已死后删掉 ' + lockFile) : ok(`没有并行的发布构建（锁：${lockFile}）`)
  show(r); if (!r.ok) return stop(r)
  console.log(`  NODE_OPTIONS=${env.NODE_OPTIONS}  ANDROID_HOME=${env.ANDROID_HOME}`)
  const dirty = run('git', ['status', '--porcelain'], { cwd: root })
  if (dirty.status === 0 && dirty.stdout.trim()) console.log(`  WARN 工作区有 ${dirty.stdout.trim().split('\n').length} 处未提交改动：产物将与 tag 对不上，发布前先提交或确认是有意的`)

  // ---- 2/6 版本号
  head('核对版本号（严格递增）')
  let pkg
  let changelog = ''
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch (e) { return stop(bad(`package.json 读不了：${e.message}`)) }
  try { changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') } catch { /* 缺文件会在下面判成没有版本段 */ }
  if (dry && args.lastCode == null) {
    console.log('  WARN --last-code 未给：dry-run 放行，真跑会在这里停（versionCode 必须与已发布最大值比较）')
    r = checkVersionFields(pkg, { lastCode: Number.MAX_SAFE_INTEGER - 1, changelogText: changelog })
    if (!r.ok && /versionCode .* ≤/.test(r.msg)) r = ok(`version ${pkg.version} / versionCode ${pkg.androidVersionCode}（递增未核实）`)
  } else r = checkVersionFields(pkg, { lastCode: args.lastCode, changelogText: changelog })
  show(r); if (!r.ok) return stop(r)
  const version = pkg.version
  const artifact = run(process.execPath, [path.join(root, 'scripts', 'artifact-name.mjs'), '--version', version], { cwd: root })
  if (artifact.status !== 0) return stop(bad(`artifact-name.mjs 失败：${artifact.stderr.trim()}`))
  const artifactName = artifact.stdout.trim()
  console.log(`  产物名：${artifactName}`)
  let expectedCert
  try { expectedCert = JSON.parse(fs.readFileSync(path.join(root, 'config', 'appIdentity.json'), 'utf8')).expectedCertSha256 } catch (e) { return stop(bad(`config/appIdentity.json 读不了：${e.message}`)) }
  r = certsEqual(expectedCert, expectedCert)
  if (!r.ok) return stop(r)
  console.log(`  期望签名证书（config/appIdentity.json）：${expectedCert}`)

  // ---- 3/6 签名凭据
  head('取出签名凭据（keystore.properties + keystore）')
  const havePropsAlready = fs.existsSync(propsFile)
  if (havePropsAlready) {
    console.log(`  已有 ${propsFile}，不解密、不覆盖`)
  } else if (!fs.existsSync(secretsFile)) {
    return stop(bad(`既没有 ${propsFile}，也没有加密包 ${secretsFile}`, '从仓库 main 取 release-secrets/release-secrets.tar.enc，口令在发布手册 issue 的「凭据」评论里'))
  } else {
    console.log(`  没有 keystore.properties，将从加密包取：${secretsFile}`)
    if (!env[SECRETS_ENV] && !process.stdin.isTTY && !dry) return stop(bad(`没有 ${SECRETS_ENV}，也不在终端里，没法问口令`, `export ${SECRETS_ENV}=<口令>（口令不写进任何文件）`))
    plan(`openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in ${path.relative(root, secretsFile)} | tar -x -C ${path.relative(root, unpackDir)}   # 口令来自 ${SECRETS_ENV} 或终端`)
    plan('复制 android-keystore/ 下的 keystore 与 keystore.properties 到 android/keystore/（chmod 600），并把 storeFileRelease 改成解出来的绝对路径')
    if (!dry) {
      fs.mkdirSync(unpackDir, { recursive: true, mode: 0o700 })
      const tarFile = path.join(unpackDir, '.secrets.tar')
      const passArgs = env[SECRETS_ENV] ? ['-pass', `env:${SECRETS_ENV}`] : []
      const d = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-in', secretsFile, '-out', tarFile, ...passArgs], { stdio: ['inherit', 'inherit', 'inherit'], env })
      if (d.status !== 0) { fs.rmSync(tarFile, { force: true }); return stop(bad('解密失败（口令错？）', '口令在发布手册 issue 的「凭据」评论里；不要连续试')) }
      const x = run('tar', ['-xf', tarFile, '-C', unpackDir])
      fs.rmSync(tarFile, { force: true })
      if (x.status !== 0) return stop(bad(`解包失败：${x.stderr.trim()}`))
      const src = path.join(unpackDir, 'release-secrets', 'android-keystore')
      const ksName = fs.readdirSync(src).find((f) => f.endsWith('.keystore'))
      if (!ksName || !fs.existsSync(path.join(src, 'keystore.properties'))) return stop(bad('加密包里没有 android-keystore/<x>.keystore 或 keystore.properties'))
      fs.mkdirSync(path.join(androidDir, 'keystore'), { recursive: true })
      const dstKs = path.join(androidDir, 'keystore', ksName)
      fs.copyFileSync(path.join(src, ksName), dstKs); fs.chmodSync(dstKs, 0o600)
      const rewritten = fs.readFileSync(path.join(src, 'keystore.properties'), 'utf8').replace(/^storeFileRelease=.*$/m, `storeFileRelease=${dstKs}`)
      fs.writeFileSync(propsFile, rewritten, { mode: 0o600 })
      console.log(`  已写入 ${dstKs} 与 ${propsFile}（均已被 .gitignore 排除）；控制台凭据留在 ${path.join(unpackDir, 'release-secrets')}（600，别提交）`)
    }
  }
  if (!fs.existsSync(propsFile)) {
    console.log(`  ${tag}之后会检查：四个 Release 键齐全、keystore 存在、证书指纹 = 期望值（node scripts/check-keystore-config.mjs）`)
  } else {
    r = checkSigningProps(fs.readFileSync(propsFile, 'utf8'), { appDir: path.join(androidDir, 'app') })
    show(r); if (!r.ok) return stop(r)
    const ck = run(process.execPath, [path.join(root, 'scripts', 'check-keystore-config.mjs')], { cwd: root })
    const fp = /证书 SHA-256\s*=\s*([0-9a-f]{64})/.exec(ck.stdout)
    r = ck.status === 0 && fp ? certsEqual(fp[1], expectedCert) : bad(`check-keystore-config 退出码 ${ck.status}\n${ck.stdout.split('\n').slice(-6).join('\n')}`, '口令 / 别名 / 路径 / 证书不对')
    show(r); if (!r.ok) return stop(r)
  }

  // ---- 4/6 构建
  head('构建（pnpm build → cap sync → gradle assembleRelease，串行）')
  const apkBuilt = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  let apk = apkBuilt
  if (args.skipBuild) {
    apk = path.resolve(args.apk)
    if (!fs.existsSync(apk)) return stop(bad(`--apk 文件不存在：${apk}`))
    console.log(`  --skip-build：直接校验 ${apk}`)
  } else {
    if (!fs.existsSync(path.join(root, 'node_modules'))) plan('pnpm install --frozen-lockfile')
    plan('pnpm build')
    plan('npx cap sync android        # 会改 android/capacitor.settings.gradle；脚本在它本来干净时会还原')
    plan('cd android && ./gradlew assembleRelease --no-daemon --max-workers=1')
    plan('cd android && ./gradlew --stop')
    plan(`产物：${apkBuilt}`)
    if (!dry) {
      fs.writeFileSync(lockFile, String(process.pid))
      const sh = (cmd, a, cwd = root) => spawnSync(cmd, a, { cwd, stdio: 'inherit', env }).status === 0
      try {
        if (!fs.existsSync(path.join(root, 'node_modules')) && !sh('pnpm', ['install', '--frozen-lockfile'])) return stop(bad('pnpm install 失败'))
        if (!sh('pnpm', ['build'])) return stop(bad('pnpm build 失败'))
        const settings = 'android/capacitor.settings.gradle'
        const cleanBefore = run('git', ['diff', '--quiet', '--', settings], { cwd: root }).status === 0
        if (!sh('npx', ['cap', 'sync', 'android'])) return stop(bad('cap sync 失败'))
        if (cleanBefore && run('git', ['diff', '--quiet', '--', settings], { cwd: root }).status !== 0) {
          run('git', ['checkout', '--', settings], { cwd: root })
          console.log(`  已还原 ${settings}（cap sync 会把 node_modules 路径写成本机形态，不能提交）`)
        } else if (!cleanBefore) console.log(`  WARN ${settings} 在 cap sync 之前就有改动，没动它`)
        if (!sh('./gradlew', ['assembleRelease', '--no-daemon', '--max-workers=1'], androidDir)) return stop(bad('gradle assembleRelease 失败', '签名闸失败时错误里会写明实际证书与期望证书'))
      } finally {
        spawnSync('./gradlew', ['--stop'], { cwd: androidDir, stdio: 'ignore', env })
        fs.rmSync(lockFile, { force: true })
      }
      if (!fs.existsSync(apk)) return stop(bad(`没有产出 ${apk}`))
    }
  }

  // ---- 5/6 校验
  head('六项校验（verify-release-apk）+ debuggable + release-check')
  const checks = [
    ['verify-release-apk.mjs', [apk]],
    ['check-apk-debuggable.mjs', [apk]],
    ['release-check.mjs', ['--apk', apk, '--tag', `v${version}`]],
  ]
  for (const [script, a] of checks) {
    plan(`node scripts/${script} ${a.map((x) => (path.isAbsolute(x) ? path.relative(root, x) || x : x)).join(' ')}`)
    if (!dry || fs.existsSync(apk)) {
      const c = run(process.execPath, [path.join(root, 'scripts', script), ...a], { cwd: root })
      console.log(c.stdout.split('\n').slice(-12).map((l) => `    ${l}`).join('\n').replace(/\s+$/, ''))
      if (c.status !== 0) return stop(bad(`${script} 退出码 ${c.status}`, '任何一项不过都不许上传，见手册第 7 节每一项失败的含义'))
    } else console.log('  （DRY-RUN：还没有 APK，校验不会真跑）')
  }

  // ---- 6/6 取产物名并提示下一步
  head('取产物名，提示下一步（本脚本不上传、不发布）')
  if (dry || !fs.existsSync(apk)) {
    plan(`复制 APK 到 ${path.relative(root, path.join(outDir, artifactName))} 并打印 sha256`)
  } else {
    fs.mkdirSync(outDir, { recursive: true })
    const dst = path.join(outDir, artifactName)
    fs.copyFileSync(apk, dst)
    console.log(`  产物：${dst}\n  sha256：${sha256File(dst)}\n  大小：${fs.statSync(dst).size} 字节`)
  }
  console.log([
    '',
    '下一步（都是人做，脚本不替你做）：',
    '  1. 打开发布控制台 https://ra.rose7.cn ，用 UPLOAD_TOKEN 上传（命令见手册第 9 节），包进「待发布」，此时对线上零影响',
    '  2. 页面点「发布」→ 确认串 PROD ok <version>-<sha前8位> → 操作员口令',
    '  3. 发布后做第 12 节的核对（dl 清单 / 62 跟随 / GitHub Release）',
  ].join('\n'))
  console.log(`\n${dry ? 'DRY-RUN 结束：只读检查全部通过，什么都没改。' : '全部步骤通过。'}`)
  return EXIT.OK
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
