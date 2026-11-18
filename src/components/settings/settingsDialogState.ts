import { create } from 'zustand'
import { getApiKey } from '../../services/api/apiConfig.js'
import { captureStateSnapshot, recordAction } from '../../services/diagnostics/collector.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  /**
   * 「我们的渠道」额度 / 支付弹层是否打开。
   * 放在这里而不是组件本地 state：付款回跳（?no=&order_token=）要能直接把它打开，
   * 让用户看到「正在查询订单」（见 main.tsx 的 consumeOrderReturn）。
   */
  oursOpen: false,
  /** 付款记录弹层（Issue #115）：与「我们的渠道」弹层同层叠放，互不影响 */
  paymentRecordsOpen: false,
}))

export const openSettings = (section: SettingsSection) => {
  recordAction('nav', 'open-settings', { section })
  useSettingsDialog.setState({ open: true, section })
  void captureStateSnapshot('after-open-settings')
}

export const closeSettings = () => {
  recordAction('nav', 'close-settings', {})
  useSettingsDialog.setState({ open: false })
}

export const setOursServicesOpen = (open: boolean) => {
  useSettingsDialog.setState({ oursOpen: open })
}

/** 付款记录弹层（Issue #115）：只读历史，不受渠道类型限制，打开即可查 */
export const setPaymentRecordsOpen = (open: boolean) => {
  useSettingsDialog.setState({ paymentRecordsOpen: open })
}

/** 付款回跳后直接进「订单查询」：打开设置并展开「我们的渠道」弹层 */
export const openOursServices = () => {
  // 弹层的叠放层级由 OursServicesDialog 的 Modal zIndex 显式抬高，不依赖挂载先后
  useSettingsDialog.setState({ open: true, section: 'data', oursOpen: true })
}

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (getApiKey()) {
    return true
  }
  openSettings('data')
  return false
}
