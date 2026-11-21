// 兜底页（`src/index.html` 内联 ES5 守卫）文案的**参照副本**。
//
// 为什么这些文案不在 `src/i18n/zh.ts` / `en.ts`：走到兜底页时业务包（连同 i18n 模块）已经挂了
// —— 守卫只能把文案内联在 HTML 里，运行时永远读不到 i18n 表。它们在 i18n 表里就是「定义了但
// 没人引用」的孤立 key（`scripts/check-i18n.mjs` 的 R4），已从 zh/en 删除（issue #413）。
//
// 守卫里的 `COPY` 表与本文件逐字一致，由
//   tests/unit/compat-guard-diagnostics.test.mjs（卡片正文）
//   tests/unit/compat-env-fields.test.mjs（环境信息 / 复制 / 脱敏）
// 两侧比对：改守卫的文案就必须改这里，否则单测红 —— 校验力度和「参照放在 i18n 表里」时一样，
// 只是不再污染 i18n key 空间。
//
// 导出的是「i18n 表 + 兜底页专属文案」的合并结果，单测直接用 `zh` / `en` 当参照。
// 注意：合并结果**不参与** `check-i18n` 的 key 统计（那只扫 src/**），这里只是测试夹具。

const { zh: zhI18n } = await import('../../../src/i18n/zh.ts')
const { en: enI18n } = await import('../../../src/i18n/en.ts')

/** 只存在于兜底页的文案（#104 / #180）：运行时读不到 i18n，故 i18n 表里已不再定义 */
const fallbackZh = {
  // #104：必须同时给出「本机 / 最低 / 推荐」三个数，否则用户不知道该更到哪一版
  compatBootLeadBlocked:
    '本机系统浏览器内核过旧（{version}），低于本应用的最低要求 {min}，无法解析本应用的页面脚本。请更新 Android System WebView（推荐 {recommended} 及以上）后重新打开本应用。',
  compatBootLeadOld:
    '本机系统浏览器内核偏旧（{version}），低于推荐的 {recommended}。部分功能可能不完整，建议更新 Android System WebView。',
  compatBootUpgradePath:
    '升级路径：设置 → 应用 → Android System WebView → 更新（或在应用商店搜索「Android System WebView」），完成后重新打开本应用。',
  compatBootEnvApp: 'App 版本：{version}',
  compatBootEnvEngine: '内核版本：{version}',
  compatBootEnvEngineUnknown: '内核版本：无法从浏览器标识里解析出来',
  compatBootEnvAndroid: 'Android 版本：{version}',
  compatBootEnvStage: '失败阶段：{stage}',
  compatBootEnvTime: '时间：{time}',
  compatBootEnvDevice: '设备码：{code}（已脱敏）',
  compatBootStageMissing: '启动检查未通过（缺少必要能力）',
  compatBootStageRuntime: '业务脚本启动时报错',
  compatBootStageTimeout: '业务脚本 12 秒内未启动',
  compatBootCopy: '复制环境信息',
  compatBootCopied: '已复制，可直接粘贴到反馈里',
  compatBootCopyManual: '复制未成功：请长按下面的信息手动复制',
  compatBootDetails: '技术细节',
  compatBootTruncated: '…（已截断）',
}

const fallbackEn = {
  compatBootLeadBlocked:
    "This device's system WebView engine ({version}) is below this app's minimum requirement {min} and cannot parse the app's page scripts. Update Android System WebView (recommended {recommended} or newer) and reopen this app.",
  compatBootLeadOld:
    "This device's system WebView engine ({version}) is older than the recommended {recommended}. Some features may be missing; updating Android System WebView is advised.",
  compatBootUpgradePath:
    'To update: Settings → Apps → Android System WebView → Update (or search "Android System WebView" in your app store), then reopen this app.',
  compatBootEnvApp: 'App version: {version}',
  compatBootEnvEngine: 'Engine version: {version}',
  compatBootEnvEngineUnknown: 'Engine version: could not be read from the browser identifier',
  compatBootEnvAndroid: 'Android version: {version}',
  compatBootEnvStage: 'Failed stage: {stage}',
  compatBootEnvTime: 'Time: {time}',
  compatBootEnvDevice: 'Device code: {code} (masked)',
  compatBootStageMissing: 'Startup check failed (missing required features)',
  compatBootStageRuntime: 'App script failed at startup',
  compatBootStageTimeout: 'App script did not start within 12 seconds',
  compatBootCopy: 'Copy environment info',
  compatBootCopied: 'Copied — paste it into your report',
  compatBootCopyManual: 'Copy failed — long-press the text below to copy it',
  compatBootDetails: 'Technical details',
  compatBootTruncated: '…(truncated)',
}

export const zh = { ...zhI18n, ...fallbackZh }
export const en = { ...enI18n, ...fallbackEn }
