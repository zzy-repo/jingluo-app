// 「当前产物版本」的唯一来源（Issue #591 收口）。
//
// 为什么要有它：更新链路的用例以前把「当前版本 1.4.0-beta.10 / versionCode 17」写死在假清单里，
// 于是 `package.json` 一升版本，假数据里的「更高版本」就不再更高、默认渠道也跟着从
// 「稳定版与预发布版」变成「稳定版」，一整批用例以「暂无可用版本 …… 已是最新」的形态假红——
// 红的是测试，不是产品。这里把口径收成一处：**只读 `package.json`**。
//
// 为什么不读 `dist/build-info.json`：那是产物自述，只在构建后存在；`package.json` 才是
// versionName / versionCode / `__APP_VERSION__` 的共同来源（`android/app/build.gradle` 也从它取）。
//
// 口径同源说明（改一处要想着这两处）：
//   · 清单筛选只看 `versionCode`（`src/services/updateManifest.ts` 的 `selectUpdate`）；
//   · 「更新渠道」默认值按「装的是不是预发布包」算 —— 版本号带 `-` 即预发布
//     （`src/components/settings/AppUpdateField.tsx` 的 `/-/.test(bundledApp().version)`）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** `package.json` 全文（用例要别的字段时直接读它，别再各自 `JSON.parse` 一遍） */
export const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 当前产物版本号（→ versionName / `__APP_VERSION__`） */
export const CURRENT_VERSION = PKG.version

/** 当前产物构建号（→ Android versionCode；清单里必须**严格大于**它才算「有更新」） */
export const CURRENT_CODE = PKG.androidVersionCode

/**
 * 默认「更新渠道」：预发布包 → `prerelease`（稳定版与预发布版都看），正式包 → `stable`。
 * 与 `AppUpdateField` 同一口径，别在这里另写一套判断。
 */
export const defaultUpdateChannel = (version = CURRENT_VERSION) => (/-/.test(version) ? 'prerelease' : 'stable')

/**
 * 在给定版本号上顺延 n 个（造假清单用；清单筛选只看 versionCode，版本号只用来展示）：
 *   `1.4.2` → `1.4.3`；`1.4.0-beta.10` → `1.4.0-beta.11`
 */
export const bumpVersion = (n, version = CURRENT_VERSION) => {
  const tail = /^(.*?)(\d+)$/.exec(version)
  if (!tail) throw new Error(`版本号不像可顺延的写法：${version}`)
  return `${tail[1]}${Number(tail[2]) + n}`
}

/**
 * 「更新渠道」的存储键（= `src/services/updateManifest.ts` 的 `UPDATE_CHANNEL_KEY`）。
 *
 * 用例**显式钉住渠道**：更新链路的假清单都是预发布记录，而默认渠道取决于产物版本号里有没有 `-`。
 * 不钉住的话，「同一个用例在 beta 产物上绿、在正式产物上红」——渠道是用户可以自己选的设置，
 * 用例应该把它写成前提条件，而不是靠产物形态去猜。
 */
export const UPDATE_CHANNEL_KEY = 'chat-demo:update-channel'

/** 用例里常用的那条前提：渠道钉成「稳定版与预发布版」 */
export const PRERELEASE_CHANNEL = 'prerelease'
