// unit 层的「界面语言固定器」：让断言 i18n 文案的用例不再跟着 shell 的 LANG 走。
//
// 根因（release gate 假红的来源）：
//   src/services/settings.ts 的 initialLocale() 读 navigator.language，
//   而 Node 的 navigator.language 由 ICU 从 shell 的 locale 解析而来：
//     LANG=zh_CN.UTF-8          → 'zh-CN'
//     LANG=en_US / C / POSIX    → 'en-US'（CI、Windows、默认 shell 都是这条路）
//   于是 translate() / describeReply() 在一次运行里可能吐英文、下一次吐中文：
//   断言「连接中断」「开新会话」这类中文文案的用例，本机绿、换台机器红 —— 产品没问题，是门禁不稳。
//
// 修法（首选方案）：用例内部用真实 settings store 把语言钉死，渲染仍走真实 translate()。
//   不用 process.env.LANG = ... / 不改 shell 环境变量：那只是把「这台机器绿」换成「那台机器绿」，
//   依赖的仍是外部环境，换 CI 依旧可能红。

/** 单测默认钉住的界面语言：和仓库里手写的中文期望值一致 */
export const TEST_LOCALE = 'zh-CN'

/**
 * 把界面语言钉死，返回钉住之后的真实值（调用方顺手 assert 一下，防以后有人删掉这行）。
 * @param {{ setState: (state: { locale?: string }) => void, getState: () => { locale?: string } }} useSettings
 *   src/services/settings.ts 导出的 zustand store
 * @param {'zh-CN' | 'en-US'} [locale] 目标语言，默认中文
 */
export const pinLocale = (useSettings, locale = TEST_LOCALE) => {
  useSettings.setState({ locale })
  return useSettings.getState().locale
}
