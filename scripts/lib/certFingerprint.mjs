#!/usr/bin/env node
/**
 * certFingerprint.mjs —— 「已发布证书指纹的期望值」的**唯一读取实现**（Issue #702，同根因 #697 / #271）。
 *
 * 为什么单独抽出来：同一个判据曾经有**两份实现**，各自去 `android/app/build.gradle` 找
 * `EXPECTED_CERT_SHA256 = '<64 hex>'` 字面量：
 *
 *   · `scripts/check-keystore-config.mjs`  —— #697 改成读 `config/appIdentity.json`（修好了）
 *   · `scripts/release-common.mjs`         —— 没跟上，#702 时仍读 gradle 字面量 → **恒返回 null**
 *
 * 后果不是「少一条提示」，而是 `release-check`（发版前自检）拿到 null 只打一句 nothing，
 * **从来没有真正比对过指纹**。一处读对、另一处读错 = 同一判据两个实现，一个真一个假
 * （#285「第二份真相源」的镜像形态）。
 *
 * 所以读取逻辑只留这一份，两个脚本都调它：
 *
 *   主源（唯一来源，#271）：`config/appIdentity.json` 的 `expectedCertSha256`（64 位小写十六进制）；
 *   兼容回落（老 checkout）：`android/app/build.gradle` 里若还有 64 位字面量，照读并点明来源；
 *   两份副本不等 → 判红并**点名两个值**（第二份真相源显式拦截，与 #697 同口径）。
 *
 * 另外提供 `assertMatchesPublishedCert`：把「期望值」与仓库里的**已发布身份断言**
 * （`scripts/lib/appIdentity.mjs` 的 `PUBLISHED_IDENTITY`，它是指纹这件事的第二份记录）
 * 比一次 —— 这是 `release-check` 唯一能真正判红的口径（它零依赖、没有 apksigner，
 * 读不到 APK 内的真实证书），也是「有人把配置里的指纹改一个字」立刻变红的那个点。
 *
 * 只读：不修改任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'

import { PUBLISHED_IDENTITY, RE_CERT_SHA256, REPO_ROOT } from './appIdentity.mjs'

/** 主源：`config/appIdentity.json`（#271 之后身份事实的唯一记录点） */
export const CERT_PRIMARY_REL = 'config/appIdentity.json'
/** 兼容回落：老 checkout 的 `android/app/build.gradle` 字面量（#271 之后本仓改为从配置派生） */
export const CERT_FALLBACK_REL = 'android/app/build.gradle'
/** 「已发布证书」这条断言所在文件（不是来源，是闸门） */
export const PUBLISHED_CERT_REL = 'scripts/lib/appIdentity.mjs'

/**
 * build.gradle 里遗留的指纹字面量（老 checkout 的兼容来源；#271 之后本仓已无副本）。
 * @returns {string|null} 小写 64 位十六进制，或 null
 */
export const gradleCertLiteral = (root = REPO_ROOT) => {
  try {
    const text = fs.readFileSync(path.join(root, CERT_FALLBACK_REL), 'utf8')
    const m = /EXPECTED_CERT_SHA256\s*=\s*['"]([0-9a-fA-F]{64})['"]/.exec(text)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * 读已发布证书指纹的期望值。**所有消费者都走这里**（#702：不许在各自脚本里再写一份）。
 *
 * @returns {{value: string|null, source: string|null, invalid: string|null}}
 *   `value === null` 表示判不出来（调用方必须 fail-closed，不许猜值放行）；
 *   `source` 是**实际**读到值的来源（`config/appIdentity.json` / `android/app/build.gradle`）；
 *   `invalid` 是主源读到了但格式不对时的原因（此时**不回落**掩盖问题，与 #697 同口径）。
 */
export const resolveExpectedCertSha256 = (root = REPO_ROOT) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, CERT_PRIMARY_REL), 'utf8'))
    const raw = typeof parsed?.expectedCertSha256 === 'string' ? parsed.expectedCertSha256.trim().toLowerCase() : ''
    if (RE_CERT_SHA256.test(raw)) return { value: raw, source: CERT_PRIMARY_REL, invalid: null }
    return {
      value: null,
      source: CERT_PRIMARY_REL,
      invalid: raw === '' ? '缺失或不是字符串' : `不是 64 位小写十六进制：'${raw}'`,
    }
  } catch (e) {
    // 文件不存在 → 走兼容回落；解析失败 / 读不动 → 判不出来（不做「猜一个」）
    if (e?.code !== 'ENOENT') return { value: null, source: CERT_PRIMARY_REL, invalid: `读不出来（${e.message}）` }
  }
  const literal = gradleCertLiteral(root)
  if (literal) return { value: literal, source: CERT_FALLBACK_REL, invalid: null }
  return { value: null, source: null, invalid: null }
}

/** 仓库里「已发布证书指纹」这条断言（不是来源，是闸门：改它 = 声明一次签名迁移） */
export const publishedCertSha256 = () => PUBLISHED_IDENTITY.expectedCertSha256.toLowerCase()

/**
 * 期望值的两份副本必须相等（主源 JSON + 兼容回落 gradle 字面量）。
 * 不相等 = 第二份真相源：一处改了另一处没改，迟早「按这份配置过闸、按那份配置构建」。
 * @returns {boolean} true = 一致（或只有一份）；false = 已打印两个值与修法
 */
export const assertSingleFingerprintSource = (expected, { log = console.error, root = REPO_ROOT } = {}) => {
  const literal = gradleCertLiteral(root)
  if (!expected.value || !literal || literal === expected.value) return true
  log('[FAIL] 证书指纹有两份来源且不一致（第二份真相源）：')
  log(`       期望 ${expected.value}（来源 ${expected.source}）`)
  log(`       实际 ${literal}（来源 ${CERT_FALLBACK_REL} 的 EXPECTED_CERT_SHA256 字面量）`)
  log('')
  log('  修法: 指纹只许有一个来源 —— config/appIdentity.json 的 expectedCertSha256（#271）。')
  log(`        把 ${CERT_FALLBACK_REL} 里那份字面量删掉（改成从配置派生），或把它改成与配置相同的值。`)
  log('        不要通过改期望值让闸门变绿：换证书 = 已装用户无法覆盖升级（docs/RELEASE-MANUAL.md §1）。')
  return false
}

/**
 * 期望值必须等于仓库记录的**已发布证书**指纹（`PUBLISHED_IDENTITY.expectedCertSha256`）。
 *
 * 为什么需要这一拍：`release-check` 是零依赖自检（任何机器都跑，没有 apksigner），它读不到
 * APK 内的真实证书 —— 于是「配置里的指纹被改了一个字」在它眼里毫无差别。把期望值与
 * 已发布断言比一次，这一项才**真的会红**（#702 的负向对照就是改这一个字）。
 * 改这个值本身不是错，但要同一个 PR 改 `scripts/lib/appIdentity.mjs` 并写迁移方案（#271）。
 *
 * @returns {boolean} true = 一致（或没有可比的值，由调用方另行 fail-closed）
 */
export const assertMatchesPublishedCert = (expected, { log = console.error } = {}) => {
  if (!expected.value) return true
  const published = publishedCertSha256()
  if (expected.value === published) return true
  log('[FAIL] 期望证书指纹与「已发布证书」不一致（有人在动签名身份）：')
  log(`       配置   ${expected.value}（来源 ${expected.source}）`)
  log(`       已发布 ${published}（来源 ${PUBLISHED_CERT_REL} 的 PUBLISHED_IDENTITY.expectedCertSha256）`)
  log('')
  log('  为什么这算 P0: 期望值一改，闸门以后就按新值放行 —— 而那把 key 签出的包装不上已装用户')
  log('                （签名不同，无法覆盖升级）。历史所有版本都是同一张证书。')
  log('  修法:')
  log('    1) 是手滑/笔误 → 把 config/appIdentity.json 恢复成上面那个已发布值（这才是本仓的事实）。')
  log('    2) 真要换签名 → 单独开 Issue：同一个 PR 里改 PUBLISHED_IDENTITY + 迁移方案')
  log('       （新包名 / 商店渠道 / 引导重装），并同步 build.gradle 顶部的禁止事项（见 #271）。')
  return false
}
