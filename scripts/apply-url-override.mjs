#!/usr/bin/env node
/**
 * 测试专用构建的 base URL 覆盖补丁（**只用于 test/pay-mock-device 分支，绝不进发布分支**）。
 *
 * 为什么需要它：Android WebView 里的请求由原生 CapacitorHttp 发出，页面级 fetch / page.route
 * 拦不到，所以只能在**构建期**把两个服务地址指到本地 mock（http://10.0.2.2:<port>）。
 *
 * 做法与仓库现有约定一致：rspack 的 DefinePlugin 注入常量（参照 __API_ORIGIN__ / __INTERNAL_BUILD__），
 * 源码里 `typeof X === 'undefined'` 兜底 —— Node 单测 / dev server 取不到常量也不会炸。
 *
 * 覆盖为空时行为与正式构建**完全一致**（回落到硬编码地址）。
 *
 * 用法：node scripts/apply-url-override.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const replaceOnce = (file, from, to) => {
  const text = readFileSync(file, 'utf8')
  if (text.includes(to)) {
    console.log(`[skip] ${file} 已经打过了`)
    return
  }
  if (!text.includes(from)) {
    throw new Error(`[fail] ${file} 里找不到待替换的原文：\n${from}`)
  }
  writeFileSync(file, text.replace(from, to))
  console.log(`[ok] ${file}`)
}

// ---------------------------------------------------------------- 1. env.d.ts
replaceOnce(
  'src/env.d.ts',
  `/** Android versionCode（取自 package.json 的 androidVersionCode），由 rspack 的 DefinePlugin 注入 */
declare const __APP_VERSION_CODE__: number`,
  `/** Android versionCode（取自 package.json 的 androidVersionCode），由 rspack 的 DefinePlugin 注入 */
declare const __APP_VERSION_CODE__: number

/**
 * ⚠️ 仅测试构建：把邀请服务 / 卡密支付服务的 base URL 覆盖成指定值（真机联调本地 mock 用）。
 * 由 rspack.config.ts 从环境变量 TEST_INVITE_API_BASE / TEST_OURS_API_BASE 注入；
 * 非测试构建是空串，源码回落硬编码地址。Node 单测取不到该常量，用 typeof 兜底。
 */
declare const __TEST_INVITE_API_BASE__: string
declare const __TEST_OURS_API_BASE__: string`
)

// ------------------------------------------------------------ 2. rspack.config.ts
replaceOnce(
  'rspack.config.ts',
  `      __APP_VERSION_CODE__: JSON.stringify(readVersionCode()),`,
  `      __APP_VERSION_CODE__: JSON.stringify(readVersionCode()),
      // ⚠️ 仅测试构建：真机联调本地 mock 时把两个服务地址指到宿主机（10.0.2.2）。
      //    默认空串 → 源码回落硬编码地址，正式构建行为不变。
      __TEST_INVITE_API_BASE__: JSON.stringify(process.env.TEST_INVITE_API_BASE?.trim() ?? ''),
      __TEST_OURS_API_BASE__: JSON.stringify(process.env.TEST_OURS_API_BASE?.trim() ?? ''),`
)

// ------------------------------------------------------- 3. 邀请 / 额度服务地址
replaceOnce(
  'src/services/invite/api.ts',
  `/** 邀请 / 额度服务地址：明文 HTTP，见文件头的安全说明 */
export const INVITE_API_BASE = 'http://62.106.70.167:60013'`,
  `/**
 * 邀请 / 额度服务地址：明文 HTTP，见文件头的安全说明。
 * ⚠️ 测试构建（TEST_INVITE_API_BASE）可覆盖为本地 mock；正式构建该常量为空串，行为不变。
 */
export const INVITE_API_BASE: string =
  (typeof __TEST_INVITE_API_BASE__ === 'undefined' ? '' : __TEST_INVITE_API_BASE__).trim() ||
  'http://62.106.70.167:60013'`
)

// --------------------------------------------------------- 4. 卡密 / 支付服务地址
replaceOnce(
  'src/services/ours/api.ts',
  `/** 卡密 / 支付服务地址（HTTPS）：价格、积分、发卡、兑换都问它 */
export const OURS_API_BASE = 'https://apia.ecsafe.cn'`,
  `/**
 * 卡密 / 支付服务地址（HTTPS）：价格、积分、发卡、兑换都问它。
 * ⚠️ 测试构建（TEST_OURS_API_BASE）可覆盖为本地 mock；正式构建该常量为空串，行为不变。
 */
export const OURS_API_BASE: string =
  (typeof __TEST_OURS_API_BASE__ === 'undefined' ? '' : __TEST_OURS_API_BASE__).trim() ||
  'https://apia.ecsafe.cn'`
)

console.log('\n完成：测试构建时用 TEST_INVITE_API_BASE / TEST_OURS_API_BASE 指向 mock。')
