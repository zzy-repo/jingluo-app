// 当前产物版本（`build-info.json` / `__APP_VERSION__`）的**唯一读法**：只从仓库根 `package.json` 取。
//
// 为什么要有这份：域 10（更新）的用例天生要造「比当前更高」的清单记录 —— 检查更新只认
// `versionCode > 当前 versionCode`，而渠道默认值又是按版本号推出来的（正式版 → stable、
// 带 `-beta` → prerelease，见 `src/components/settings/AppUpdateField.tsx` 的 readUpdateChannel 初值）。
// 把版本号抄成字面量，改一次版本号就同时踩两个坑：清单里全是「比当前低」的记录 → 永远
// 「已是最新」；`buildType` 与渠道对不上 → 记录被渠道过滤掉。两种都表现为红，但红得莫名其妙。
//
// 派生**不等于放宽断言**：用例仍然逐条比对具体的版本号 / versionCode / 文件名，只是这几个数
// 来自唯一来源，不再各抄一份。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const RAW_CODE = PKG.androidVersionCode
const CODE = typeof RAW_CODE === 'number' ? RAW_CODE : Number(String(RAW_CODE).trim())
if (!Number.isSafeInteger(CODE) || CODE <= 0) {
  throw new Error(`package.json 的 androidVersionCode 非法：${JSON.stringify(RAW_CODE)}`)
}

/** 当前产物版本 = 应用自己认为的「已安装版本」 */
export const CURRENT = Object.freeze({ version: String(PKG.version), versionCode: CODE })

/**
 * 当前版本 + delta 个补丁号（`1.4.3` → `1.4.4`）。只用来造「比当前更高」的候选版本号，
 * 不参与任何判定；预发布号（`1.4.3-beta.2`）取主版本部分再加，结果仍是合法 semver。
 */
export const nextPatch = (version, delta = 1) => {
  const matched = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  if (!matched) throw new Error(`version 不是 x.y.z 形式，无法派生更高版本：${version}`)
  const [, major, minor, patch] = matched
  return `${major}.${minor}.${Number(patch) + delta}`
}

/** 当前版本的默认更新渠道（正式版 = stable，带预发布后缀 = prerelease） */
export const CHANNEL_BUILD_TYPE = /-/.test(CURRENT.version) ? 'prerelease' : 'stable'

/** 清单里「唯一可安装的新版本」= 当前版本 +1 个补丁号 / versionCode +1 */
export const NEWEST_INSTALLABLE = Object.freeze({
  version: nextPatch(CURRENT.version, 1),
  versionCode: CURRENT.versionCode + 1,
})

/**
 * 「设备上装的是上一版」= 当前版本 -1 个补丁号 / versionCode -1。
 *
 * 原生桥的用例必须用它当 `installed()` 的返回值：更新用例的语义就是「旧包装新包」，
 * 把 installed 写成与内置产物完全相同的版本号/versionCode，等于在描述一个不存在的场景
 * （实测会让检查更新走进客户端未预料的错误分支，见 update-stuck-button-373 的取证）。
 */
export const PREVIOUS = Object.freeze({
  version: nextPatch(CURRENT.version, -1),
  versionCode: CURRENT.versionCode - 1,
})
