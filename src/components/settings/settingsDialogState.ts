import { create } from 'zustand'
import { checkApiKeyBeforeSend, getApiKey, recordConfigRejection } from '../../services/api/apiConfig.js'
import { captureStateSnapshot, recordAction } from '../../services/diagnostics/collector.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/**
 * 「账户与消费」页的四个 tab（#482 三弹层合一 / #487）。
 *
 * 类型放在这里而不是页面组件里：`settingsDialogState` 要能被消息流（额度不足 / Key 失效的 CTA）
 * 与付款回跳直接调用，**组件不许反向被状态层 import**（页面自己从这里取同一个类型）。
 */
export type AccountConsumeTab = 'cards' | 'buy' | 'quota' | 'account'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  /**
   * 「账户与消费」页是否打开（#482 三弹层合一 / #487，旧 `OursServicesDialog` 的替代物）。
   *
   * 放在这里而不是组件本地 state：付款回跳（?no=&order_token=）要能直接把它打开，
   * 让用户落在「我的卡密」tab；消息流里的额度不足 / Key 失效 CTA 也要能指到别的 tab。
   */
  accountConsumeOpen: false,
  /** 打开时落在哪个 tab（只在下一次打开时读一次，之后由页面自己切） */
  accountConsumeTab: 'cards' as AccountConsumeTab,
  /**
   * 这次打开设置是**发送前拦截**触发的（Issue #451 第 2 点）：Key 已填但格式明显不对，
   * 消息根本没发出去。设置页据此在 API Key 那一行直接说出原因，而不是让用户以为「又没填 Key」。
   * 修好 Key（保存成功）或关掉设置即清，不会变成一条挂着的僵尸提示。
   */
  apiKeyFormatBlocked: false,
}))

export const openSettings = (section: SettingsSection) => {
  recordAction('nav', 'open-settings', { section })
  useSettingsDialog.setState({ open: true, section })
  void captureStateSnapshot('after-open-settings')
}

export const closeSettings = () => {
  recordAction('nav', 'close-settings', {})
  // #451：拦截提示只服务于「这一次打开」；关掉就清，下次发送还会重新判一次
  useSettingsDialog.setState({ open: false, apiKeyFormatBlocked: false })
}

/** 修好 Key 之后调用（保存成功）：那条「格式不对，消息没发出」的提示到此为止（#451） */
export const clearApiKeyFormatBlocked = () => {
  if (useSettingsDialog.getState().apiKeyFormatBlocked) {
    useSettingsDialog.setState({ apiKeyFormatBlocked: false })
  }
}

export const setAccountConsumeOpen = (open: boolean) => {
  useSettingsDialog.setState({ accountConsumeOpen: open })
}

/**
 * 打开「账户与消费」页并落在指定 tab（#482 三弹层合一 / #487）。
 *
 * 三个既有入口共用这一个出口，只是落的 tab 不同：
 *   - 付款回跳（`?no=&order_token=`）：`cards`（默认）—— 回跳就是为了让用户看到卡密；
 *   - 消息流「额度不足 → 去充值 / 兑换卡密」CTA：`quota`；
 *   - 消息流「Key 失效 → 查看额度」CTA：`account`（换 Key / 核对账号都在这一页）。
 *
 * 打开设置并选中「数据管理」：面包屑仍是「设置 → 数据管理 → 账户与消费」，
 * 与旧的 `openOursServices` 一致；页面层级由 `AccountConsumePage` 自己的 Modal zIndex 抬高，
 * 不依赖挂载先后。
 */
export const openAccountConsume = (tab: AccountConsumeTab = 'cards') => {
  useSettingsDialog.setState({
    open: true,
    section: 'data',
    accountConsumeOpen: true,
    accountConsumeTab: tab,
  })
}

/**
 * 发送前的 Key 守卫：返回是否放行（每个发送入口 —— 输入行、编辑后重发、重新生成 —— 都会调它）。
 *
 * 三条路，顺序不能换（Issue #451 第 2 点在这条链路上落地）：
 *
 *  1. `ok`            → 放行，一个多余的判断都不多做；
 *  2. `missing`（**既有路径，一字不改**）→ 打开设置并选中「数据管理」，让用户去填 Key；
 *  3. `format`（#451 新增）→ 同样是打开设置，但多带一个标记：设置页在 Key 那一行直接写清
 *     「格式不对，这条消息没有发出去」。**不发请求**，所以也不会有一次 401 和一条
 *     「API Key 无效或已被删除」的误导文案（用户手上明明有一把 Key，那句话只会让他以为 Key 被删了）。
 *
 * 判据统一在 `apiConfig.checkApiKeyBeforeSend()`（底层是 #374 的 `isKeyFormatInvalid`）：
 * 拦截与失败文案看同一份口径，不会出现「发送时说过格式没错、失败文案说格式不对」。
 */
export const ensureApiKey = () => {
  const status = checkApiKeyBeforeSend()
  if (status === 'ok') {
    return true
  }
  if (status === 'missing') {
    openSettings('data')
    return false
  }
  // format：先在诊断里留痕（这类「有 Key 却发不出去」只看状态是查不出来的），再打开设置
  recordConfigRejection('apiKey', 'format')
  // 只记「有没有 / 多长」这类可切片字段，Key 原文一个字都不进日志（与 setApiKey 同一口径）
  recordAction('nav', 'block-send-invalid-key', { reason: 'format', length: getApiKey().length })
  openSettings('data')
  useSettingsDialog.setState({ apiKeyFormatBlocked: true })
  return false
}
