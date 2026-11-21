import { create } from 'zustand'
import {
  checkApiKeyBeforeSend,
  checkCurrentSendConfig,
  getApiKey,
  recordConfigRejection,
} from '../../services/api/apiConfig.js'
import {
  sendBlockFieldOf,
  type SendBlockCode,
  type SendBlockField,
} from '../../services/api/sendConfigCheck.js'
import { captureStateSnapshot, recordAction } from '../../services/diagnostics/collector.js'
import { showToast } from '../base/toastState.js'

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
  /**
   * 这次打开设置是**「我们的渠道」拿不到服务端那把 Key** 触发的（Issue #596）：
   * `unclaimed` = 本机根本没有 / 不是服务端给的；`stale` = 服务端换过了、本机还是旧的。
   *
   * 与上面的格式拦截分开一格：两者可以同时成立，但用户要看到的下一步不同
   * （格式拦截是「去改这一行」，这里是「去领取」——我们的渠道根本没有可改的输入框）。
   */
  managedKeyBlocked: null as null | 'unclaimed' | 'stale',
  /**
   * 这次打开设置是**必错的服务配置**触发的（Issue #490，`checkSendConfig` 的五类）：命中哪一类就记哪个码，
   * 设置页据此在**对应那一行**（`baseUrl` / `model`）写出原因，而不是让用户自己猜是哪一项填错了。
   * 修好那一个字段（保存成功）或关掉设置即清 —— 与 #451 的 Key 拦截同一套纪律，不留僵尸提示。
   */
  sendConfigBlocked: null as SendBlockCode | null,
}))

export const openSettings = (section: SettingsSection) => {
  recordAction('nav', 'open-settings', { section })
  useSettingsDialog.setState({ open: true, section })
  void captureStateSnapshot('after-open-settings')
}

export const closeSettings = () => {
  recordAction('nav', 'close-settings', {})
  // #451：拦截提示只服务于「这一次打开」；关掉就清，下次发送还会重新判一次
  // #596：领取拦截同理 —— 关掉设置不该留下一条挂着的「请先领取 Key」
  // #490：必错配置的红字同理
  useSettingsDialog.setState({
    open: false,
    apiKeyFormatBlocked: false,
    managedKeyBlocked: null,
    sendConfigBlocked: null,
  })
}

/** 修好 Key 之后调用（保存成功）：那条「格式不对，消息没发出」的提示到此为止（#451） */
export const clearApiKeyFormatBlocked = () => {
  if (useSettingsDialog.getState().apiKeyFormatBlocked) {
    useSettingsDialog.setState({ apiKeyFormatBlocked: false })
  }
}

/** 领取成功之后调用：那条「请先领取 Key / 请重新领取」的提示到此为止（#596） */
export const clearManagedKeyBlocked = () => {
  if (useSettingsDialog.getState().managedKeyBlocked !== null) {
    useSettingsDialog.setState({ managedKeyBlocked: null })
  }
}

/** 改对了那个字段之后调用（地址 / 模型保存成功）：那行红字到此为止（#490） */
export const clearSendConfigBlocked = (field?: SendBlockField) => {
  const blocked = useSettingsDialog.getState().sendConfigBlocked
  if (blocked === null) {
    return
  }
  // 只清本次被点名的那一行：改了地址不该顺手把模型的提示也抹掉
  // （落点从 `sendConfigCheck` 的表里取，不在这里按码前缀再猜一次）
  if (field && sendBlockFieldOf(blocked) !== field) {
    return
  }
  useSettingsDialog.setState({ sendConfigBlocked: null })
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
 *
 * #596 又多两条路，只对「我们的渠道」成立（另外三个渠道一字不改）：
 *
 *  4. `claim` → 本机没有服务端下发的那把 Key（没领过 / 手填的 / 老版本留下的）。**不发请求**，
 *     打开设置并在 Key 那一行写「请先领取 Key」+「重新领取」按钮；
 *  5. `stale` → 本机这把与服务端下发标记不一致（服务端换过了）。同样不发请求，写「Key 已更新，
 *     请重新领取」。
 *
 * 这两条**刻意不使用**「服务器繁忙」「未知错误」这类掩盖性说法：那正是 #596 第 1 条事故里
 * 用户被误导的原因（本地存着旧 Key，服务端换了，401 被读成「服务器忙」）。
 */
export type EnsureApiKeyOptions = {
  /**
   * 启动时的那一次调用（`App` 里「首次打开先配 Key」）。
   *
   * 只为「一个 Key 都没有」打开设置 —— 与 #374 之前那条既有路径完全一致。
   * 「有一把、但不是服务端下发的那把」（`claim` / `stale`）**不在启动时弹窗**：
   * 用户没做任何事，弹一层设置只会打断他；等发送时再拦（那时才是他需要知道的一刻），
   * 而设置页只要被打开就会自己把原因写在 Key 那一行（`managedKeyBlocked`）。
   */
  fromBoot?: boolean
}

export const ensureApiKey = (options: EnsureApiKeyOptions = {}) => {
  const status = checkApiKeyBeforeSend()
  if (status === 'ok') {
    return true
  }
  if (status === 'missing') {
    openSettings('data')
    return false
  }
  if (status === 'claim' || status === 'stale') {
    if (options.fromBoot === true && getApiKey().trim() !== '') {
      // 启动 + 手上已经有一把（只是不对）：不弹设置，留给发送时那一拦（见 EnsureApiKeyOptions）
      return false
    }
    const blocked = status === 'stale' ? 'stale' : 'unclaimed'
    // 「我们的渠道」的 Key 只能由服务端下发（#596）：这两种状态下本地那把**一定**不是服务端那把，
    // 发出去只会换回一次 401。先在诊断里留痕（只记判定档位与长度，Key 原文不进日志），再打开设置。
    recordConfigRejection('apiKey', status)
    recordAction('nav', 'block-send-managed-key', {
      reason: status,
      length: getApiKey().length,
    })
    openSettings('data')
    useSettingsDialog.setState({ managedKeyBlocked: blocked })
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

/**
 * 发送前的**服务配置**守卫（Issue #490）：五类必错配置在本地拦下，一个请求都不发。
 *
 * 与 `ensureApiKey` 的分工（两条门，各管各的字段，互不重复判定）：
 * - `ensureApiKey`：Key 有没有 / 像不像 / 是不是服务端发的那把（#374 / #451 / #596）；
 * - `ensureSendConfig`：**地址与模型**填得对不对（#490 的五类）—— 判据全在纯函数
 *   `services/api/sendConfigCheck.ts` 里，这里只负责「说给用户听 + 把他送到那一行」。
 *
 * 三步都有意义，缺一条就变成 #490 描述的那个现状（发一条、等一个 4xx、再从英文原文里猜）：
 *  1. **toast 说清是哪一项**：五种命中各有一句话（`sendBlocked*`），不是笼统的「配置有误」；
 *  2. **跳到对应设置**：打开设置并落在「数据管理」，同时在**那一行**写红字
 *     （`sendConfigBlocked`，由 `ApiConfigFields` 的地址 / 模型行读取）；
 *  3. **返回 false**：调用方据此不再往下走 —— 请求数为 0 是这条拦截的全部价值。
 *
 * 不放行「启动时那次」：本函数只在发送入口被调用（`App` 的启动检查走 `ensureApiKey`），
 * 用户还没做任何事时不该因为一个历史遗留的空模型被弹窗打断。
 */
export const ensureSendConfig = (): boolean => {
  const verdict = checkCurrentSendConfig()
  if (verdict.ok) {
    return true
  }
  // 先在诊断里留痕：这类「配置根本没填对」只看请求日志是查不出来的（请求都没发）
  recordConfigRejection(verdict.jumpTo, verdict.code)
  recordAction('nav', 'block-send-invalid-config', {
    code: verdict.code,
    field: verdict.jumpTo,
  })
  showToast({ key: verdict.messageKey })
  openSettings('data')
  useSettingsDialog.setState({ sendConfigBlocked: verdict.code })
  return false
}
