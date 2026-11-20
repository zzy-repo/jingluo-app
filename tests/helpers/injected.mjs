// 非打包环境的「构建期注入值」兜底 —— **由 tests/helpers/runtime.mjs 用 `--import` 预加载**，
// 每个测试进程都会先执行这份（Issue #274）。
//
// 为什么要有它：`__ENDPOINTS__` 是 rspack 的 DefinePlugin 在打包时替换掉的标识符，
// 而单测是 `node --test` 直接 import `.ts`，没有打包器。src 里只要有一个模块在顶层读它
// （apiConfig.ts / providers.ts / invite/api.ts / diagnostics/config.ts），没预加载就会
// `ReferenceError: __ENDPOINTS__ is not defined`。
//
// 登录接缝（`__TEST_AUTH_STATE__`，#510）**故意不在这里设默认值** ——
// 它读的是构建期常量（`AuthGate` 里那句 `typeof __TEST_AUTH_STATE__`），而预加载一旦给出
// 「已登录」的默认会话，所有「未登录才该出现登录页」的单测就一起变成假红/假绿：登录页、注册入口、
// 过期提示这些断言全都测不到东西了。需要它的用例自己调下面的 `installTestAuthState()`（显式、可搜）；
// 浏览器层的黄金回归 / L1 不靠这条预加载 —— 它们读的是**测试构建**的产物
// （`TEST_AUTH_SEAM=1 pnpm build`），见 scripts/lib/testAuthSeam.mjs。
//
// 只设 `__ENDPOINTS__`，**不动** `__API_ORIGIN__` / `__INTERNAL_BUILD__`：
// 那两个的取值是按用例来的（有的用例要 https://api.deepseek.com，有的要内部构建号），
// 各用例自己 `globalThis.X ??= ...` 设，预加载要是抢先把默认值占住，用例显式设的值就失效了。
//
// 端点值全部来自 config/endpoints.json（经 scripts/lib/endpoints.mjs），测试不再自己抄地址。

import { SEAM_SESSION } from '../../scripts/lib/testAuthSeam.mjs'
import {
  allowedHosts,
  chatBaseUrl,
  consumeApiV1Prefix,
  consumeBaseUrl,
  consumeGatewayPrefix,
  consumeTimeouts,
  downloadFallbackBase,
  downloadPrimaryBase,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
  payBaseUrl,
  payTimeouts,
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
  // 消费侧 / 支付侧（#484 W1-A）：services/consume/** 顶层不读它（读取是懒的、可注入），
  // 但用例自己要按同一份配置拼断言时从这里取，避免在测试里再抄一遍地址。
  consume: Object.freeze({
    baseUrl: consumeBaseUrl,
    apiV1Prefix: consumeApiV1Prefix,
    gatewayPrefix: consumeGatewayPrefix,
    timeoutMs: consumeTimeouts,
  }),
  pay: Object.freeze({ baseUrl: payBaseUrl, timeoutMs: payTimeouts }),
})

// --------------------------------------------------------------------------- 登录接缝（#510）

/**
 * 假会话（与 `scripts/lib/testAuthSeam.mjs` 的 `SEAM_SESSION` 同一形状；token 一眼假）。
 * 只导出、**不自动安装**：见文件头「故意不在这里设默认值」。
 */
export const TEST_AUTH_STATE = SEAM_SESSION

/**
 * 给「需要启动即已登录」的单测装上接缝：设成**运行期 global**（构建期常量在没打包的 Node 里不存在，
 * 而 `AuthGate` 用的是 `typeof __TEST_AUTH_STATE__` 写法，正好能读到 global）。
 *
 * 浏览器层别用这个：dist 里那句已经是 `typeof undefined`，设 global 不会有任何效果 ——
 * 那边靠 `TEST_AUTH_SEAM=1` 构建。
 */
export const installTestAuthState = (session = TEST_AUTH_STATE) => {
  globalThis.__TEST_AUTH_STATE__ = session
  return session
}

/** 卸掉接缝（用例之间互不污染） */
export const uninstallTestAuthState = () => {
  delete globalThis.__TEST_AUTH_STATE__
}
