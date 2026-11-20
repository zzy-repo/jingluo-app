// 非打包环境的「构建期注入值」兜底 —— **由 tests/helpers/runtime.mjs 用 `--import` 预加载**，
// 每个测试进程都会先执行这份（Issue #274）。
//
// 为什么要有它：`__ENDPOINTS__` 是 rspack 的 DefinePlugin 在打包时替换掉的标识符，
// 而单测是 `node --test` 直接 import `.ts`，没有打包器。src 里只要有一个模块在顶层读它
// （apiConfig.ts / providers.ts / invite/api.ts / diagnostics/config.ts），没预加载就会
// `ReferenceError: __ENDPOINTS__ is not defined`。
//
// 只设 `__ENDPOINTS__`，**不动** `__API_ORIGIN__` / `__INTERNAL_BUILD__`：
// 那两个的取值是按用例来的（有的用例要 https://api.deepseek.com，有的要内部构建号），
// 各用例自己 `globalThis.X ??= ...` 设，预加载要是抢先把默认值占住，用例显式设的值就失效了。
//
// 端点值全部来自 config/endpoints.json（经 scripts/lib/endpoints.mjs），测试不再自己抄地址。

import {
  allowedHosts,
  chatBaseUrl,
  downloadFallbackBase,
  downloadPrimaryBase,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
} from '../../scripts/lib/endpoints.mjs'

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl,
  feedbackUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
  // 分发地址（Issue #269）：updateManifest.ts 顶层就读它，缺了就是 undefined base
  dlPrimaryBase: downloadPrimaryBase,
  dlFallbackBase: downloadFallbackBase,
})
