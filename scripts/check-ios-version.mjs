#!/usr/bin/env node
/**
 * check-ios-version.mjs —— 「iOS 工程的版本号必须与 package.json 同源」门禁（Issue #873）。
 *
 * 为什么要有它：#873 用 `cap add ios` 生成 iOS 工程，Xcode 模板自带的是写死的
 *
 *     MARKETING_VERSION = 1.0
 *     CURRENT_PROJECT_VERSION = 1
 *
 * 而 Android 那条链的版本号**只有一个来源**（`package.json` 的 `version` 与
 * `androidVersionCode`，`android/app/build.gradle` 自己去读，见 `build-apk.sh` 第 148 行）。
 * iOS 没有这条链：`xcodebuild` 不会读 JSON。于是同一个 App 的两端各说各话 ——
 * 实测（2026-11-26）：`package.json` 是 `2.0.1` / `41`，而 iOS 工程里是 `1.0` / `1`，
 * 差 4 个 minor、40 个 build。
 *
 * 后果是用户能感知的那种：App Store Connect 拒收重复的 build 号（同一个
 * `CFBundleVersion` 永远传不上去）、两端版本号对不上导致「用户报的版本号到底是哪个」查不清、
 * 灰度/回滚按版本号对齐时 iOS 那侧整个失准。而它**不会让任何东西变红** ——
 * `pnpm type` / `lint` / 全部 L0–L1 用例 / APK 出包全绿，因为没人读过那个 pbxproj。
 *
 * 判据（两条，都是等号，不做「大于就行」这种模糊判断）：
 *   ios/App/App.xcodeproj/project.pbxproj 里每一处 `MARKETING_VERSION`      == package.json `version`
 *   ios/App/App.xcodeproj/project.pbxproj 里每一处 `CURRENT_PROJECT_VERSION` == package.json `androidVersionCode`
 *
 * 为什么 `CURRENT_PROJECT_VERSION` 取 `androidVersionCode`：iOS 的 build 号要求是**单调递增的整数**，
 * `androidVersionCode` 本来就是同一个语义（每次出包 +1，老包认得新包）。用一个计数器比养两个
 * 更不容易撞 —— 「iOS 单独再养一个 build 号」正是「两端对不上」的来源。
 *
 * 为什么上架版本必须是纯数字：`CFBundleShortVersionString` 只接受 1~3 段点分数字，
 * `1.4.0-beta.8` 这种**传不上去**。所以遇到非数字版本一律 exit 2 让人来判，
 * 不在这里偷偷截断成 `1.4.0` —— 那就是又造了一份「看起来对」的版本号。
 *
 * 用法：
 *   node scripts/check-ios-version.mjs           # 有漂移 → exit 1（CI 跑这条）
 *   node scripts/check-ios-version.mjs --write   # 把 pbxproj 改写成 package.json 的值
 *   pnpm run check:ios-version
 *   pnpm run ios:version                         # = --write
 *
 * 退出码：
 *   0  一致
 *   1  有漂移（打印 `文件:行: 现值 → 期望值`）
 *   2  环境/用法错误（工程不存在、pbxproj 里没有这两个键、版本号不是纯数字）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_REL = 'package.json'
const PBXPROJ_REL = 'ios/App/App.xcodeproj/project.pbxproj'

/** App Store 能接受的形态：1~3 段点分数字 */
const APPLE_VERSION_RE = /^\d+(?:\.\d+){0,2}$/

/** 每一行都是 `\t\t\t\tKEY = value;`（Xcode 模板的缩进不稳定，只认键与非分号值的边界） */
const lineRe = (key) => new RegExp(`^(\\s*${key} = )([^;]+)(;)\\s*$`)

/**
 * 从文本里抽出一处键的全部出现（带行号）。
 * @returns {{ line: number, value: string }[]}
 */
const occurrences = (text, key) => {
  const re = lineRe(key)
  const hits = []
  text.split('\n').forEach((raw, index) => {
    const match = re.exec(raw)
    if (match) hits.push({ line: index + 1, value: match[2].trim() })
  })
  return hits
}

/** 把所有 `KEY = 旧值;` 就地改成 `KEY = 新值;`，保留缩进与行尾 */
const rewrite = (text, key, value) => text.replace(new RegExp(lineRe(key).source, 'gm'), `$1${value}$3`)

const main = (argv) => {
  const write = argv.includes('--write')

  let pkg
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, PKG_REL), 'utf8'))
  } catch (error) {
    console.error(`[check:ios-version] 读不到 ${PKG_REL}：${error.message}（版本号唯一来源就在这里）`)
    return 2
  }

  const version = String(pkg.version ?? '').trim()
  const buildNumber = String(pkg.androidVersionCode ?? '').trim()

  if (!APPLE_VERSION_RE.test(version)) {
    console.error(
      `[check:ios-version] ${PKG_REL} 的 version='${version}' 不是 iOS 上架可用的形态（1~3 段点分数字）。\n` +
        '  CFBundleShortVersionString 不接受 beta/rc 后缀 —— 出 iOS 包前必须先把版本定成数字版。\n' +
        '  这里不做「自动截断后缀」：那会造出第二份看起来对的版本号。',
    )
    return 2
  }
  if (!/^\d+$/.test(buildNumber) || Number(buildNumber) <= 0) {
    console.error(
      `[check:ios-version] ${PKG_REL} 的 androidVersionCode='${buildNumber}' 不是正整数 —— ` +
        'iOS 的 CURRENT_PROJECT_VERSION 取的就是它（单调递增的 build 号）。',
    )
    return 2
  }

  let text
  try {
    text = readFileSync(path.join(ROOT, PBXPROJ_REL), 'utf8')
  } catch {
    console.error(
      `[check:ios-version] 找不到 ${PBXPROJ_REL}：iOS 工程不在仓库里（或路径变了）。\n` +
        '  判不了 ≠ 通过 —— 工程重建/搬家后请同步改本脚本的 PBXPROJ_REL。',
    )
    return 2
  }

  const expected = [
    { key: 'MARKETING_VERSION', want: version, from: `${PKG_REL} version` },
    { key: 'CURRENT_PROJECT_VERSION', want: buildNumber, from: `${PKG_REL} androidVersionCode` },
  ]

  const drift = []
  for (const { key, want, from } of expected) {
    const hits = occurrences(text, key)
    if (hits.length === 0) {
      // 键被删掉 = 版本号根本没有接线，与「值不对」一样是违规（否则门禁会空转成恒绿）
      console.error(
        `[check:ios-version] ${PBXPROJ_REL} 里找不到 ${key} —— 版本号没有接上（期望 ${want}，来自 ${from}）。\n` +
          '  Xcode 工程重建后若键名变了，请同步改本脚本，别让门禁静默空转。',
      )
      return 2
    }
    for (const hit of hits) {
      if (hit.value !== want) drift.push({ key, line: hit.line, got: hit.value, want, from })
    }
  }

  if (drift.length === 0) {
    console.log(
      `[check:ios-version] 通过：iOS 工程版本与 ${PKG_REL} 同源 —— ` +
        `MARKETING_VERSION=${version}（version）、CURRENT_PROJECT_VERSION=${buildNumber}（androidVersionCode）。`,
    )
    return 0
  }

  if (write) {
    let next = text
    for (const { key, want } of expected) next = rewrite(next, key, want)
    writeFileSync(path.join(ROOT, PBXPROJ_REL), next)
    console.log(`[check:ios-version] 已写入 ${PBXPROJ_REL}：`)
    for (const { key, want, from } of expected) console.log(`  ${key} = ${want}   ← ${from}`)
    console.log('  这些行是生成物，别手改；改版本号请改 package.json 再跑 pnpm run ios:version。')
    return 0
  }

  console.error(`[check:ios-version] iOS 工程版本与 ${PKG_REL} 漂了 ${drift.length} 处：`)
  for (const item of drift) {
    console.error(`  ${PBXPROJ_REL}:${item.line} ${item.key} = ${item.got} → 应为 ${item.want}（来自 ${item.from}）`)
  }
  console.error('')
  console.error('  修法：pnpm run ios:version   （把 pbxproj 改写成 package.json 的值）')
  console.error(`  版本号的唯一来源是 ${PKG_REL}：version → MARKETING_VERSION，androidVersionCode → CURRENT_PROJECT_VERSION。`)
  console.error('  别手改 pbxproj：下一次 pnpm ios:version 会把两份值再分叉一次。')
  return 1
}

process.exitCode = main(process.argv.slice(2))
