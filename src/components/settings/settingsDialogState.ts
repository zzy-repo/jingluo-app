import { create } from 'zustand'
import {
  checkApiKeyBeforeSend,
  checkCurrentSendConfig,
  getApiKey,
  recordConfigRejection,
} from '../../services/api/apiConfig.js'
import {
  checkSendPrerequisites,
  sendBlockFieldOf,
  type SendBlockCode,
  type SendBlockField,
} from '../../services/api/sendConfigCheck.js'
import { getAuthSnapshot } from '../../services/auth/store.js'
import { captureStateSnapshot, recordAction } from '../../services/diagnostics/collector.js'
import { showToast } from '../base/toastState.js'

/**
 * 设置弹窗的分组：通用设置 / 数据管理 / 账户与消费。
 *
 * `memory` 是 #398 为「窗口记忆」加的第三个分组（组内只有 embedding 开关一行）；#711 决定
 * **下线这个入口**，所以这里直接把它从联合里删掉 —— 收窄而不是「留着值但入口不可达」：
 * 任何残留引用（文案 key / 渲染分支 / 旧调用方）都会在 `npx tsc` 时报错，而不是变成一段
 * 谁也点不到、却仍然编译通过的代码。
 *
 * 只切 UI 入口：`src/services/memory/**` 与 `settings.embeddingEnabled` 的持久化 / 迁移
 * **一律不动**（它们不依赖这个类型）。
 *
 * #727 阶段 1：加回第三项 `'account'`（账户与消费），而且**常显** —— 它不再依赖「渠道是不是
 * 我们的渠道」（那是维护者明确否掉的条件渲染）：渠道 / API Key / 模型 / 连通性测试就住在这个
 * tab 里，任何渠道下都必须能进得去。三个 tab 都是设置弹层**内部**的内容区，没有第二层弹层。
 */
export type SettingsSection = 'general' | 'data' | 'account'

/**
 * 把任意来源的分组值收敛成合法值（#711 兜底）。
 *
 * 非法值是真会出现的：小版本回滚 / 旧包里可能留下 `'memory'`，JS 调用方（`open({ section })`
 * 没有 tsc 把关）也可能塞脏值。设置弹窗**任何时候都要有一块非空面板**，不能因为一个分组
 * 下线就渲染出空白，所以：只认 `'data'` / `'account'`，其余一律落到 `'general'`（老行为的默认落点）。
 */
export const normalizeSettingsSection = (value: unknown): SettingsSection =>
  value === 'data' ? 'data' : value === 'account' ? 'account' : 'general'

/**
 * 「账户与消费」页里**打开时要落在哪一页**（#482 三弹层合一 / #487 / #817）。
 *
 * 类型放在这里而不是页面组件里：`settingsDialogState` 要能被消息流（额度不足 / Key 失效的 CTA）
 * 直接调用，**组件不许反向被状态层 import**（页面自己从这里取同一个类型）。
 *
 * #817：`'quota'`（我的额度）整页退场 —— 入口删了、子页也删了，所以这里跟着收窄。
 * 「额度用完 → 去充值」的 CTA 改指 `'wallet'`（钱包页首就是余额卡 + 付款入口）。
 */
export type AccountConsumeTab = 'wallet' | 'cards' | 'buy' | 'account'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  /**
   * 「账户与消费」里要落在哪一页（#482 三弹层合一 / #487；#727 阶段 1 改成「切到第三个 tab」）。
   *
   * 放在这里而不是组件本地 state：付款回跳要能直接指到「我的卡密」，消息流里的额度不足 /
   * Key 失效 CTA 也要能指到别的页。
   *
   * **`null` = 落在 L1 列表页**（模型来源 / 我的钱包 / 账号三行）——这是「从设置侧栏点进来」
   * 与「Key 守卫把设置打开」两种默认情况的落点：用户还没表达要看哪一页。
   * `openAccountConsume(tab)` 才把它指到某一页（缺省 `'cards'`）。
   *
   * #817 修正：#727 重构 `AccountConsumePage` 的 `page`/`onNavigate` 之后，这个字段一度**没人读**
   * ——CTA 的落点静默退化成 L1（「额度不足 → 去充值」其实没到指定页）。现在由 `SettingsDialog`
   * 在挂载时读它当 `accountPage` 的初值（一处读，口径与注释一致）。
   *
   * **不再有「打开独立页」的开关**：这里只是「切到第三个 tab + 落在哪一页」，
   * 内容永远渲染在设置弹层内部（维护者口径：不弹第二层窗口）。
   */
  accountConsumeTab: null as AccountConsumeTab | null,
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
  // #711 兜底：`'memory'` 只可能来自旧版本残留或没跟上的调用方（JS 侧 tsc 管不到）。
  // 在**写进 store 之前**就收敛，后续所有读 `state.section` 的地方看到的都是合法值。
  const normalized = normalizeSettingsSection(section)
  recordAction('nav', 'open-settings', { section: normalized })
  useSettingsDialog.setState({ open: true, section: normalized })
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

/**
 * 切到设置里的第三个 tab（账户与消费）并落在指定子页（#482 三弹层合一 / #487 / #727 / #817）。
 *
 * 两个既有入口共用这一个出口，只是落的子页不同：
 *   - 付款回跳：`cards`（默认）—— 回跳就是为了让用户看到卡密；
 *   - 消息流「额度不足 → 去充值 / 兑换卡密」CTA：`wallet`（#817：原来指 `quota`，
 *     那一页已删；钱包页首就是余额卡 + 付款入口，充值/兑换都在一步之内）；
 *   - 消息流「Key 失效 → 查看额度」CTA：`account`（换 Key / 核对账号都在这一页）。
 *
 * 打开设置并**选中第三个 tab**（账户与消费），落在指定子页：
 * 面包屑是「设置 → 账户与消费 → 我的钱包 / 我的卡密 / 购买 / 账号」。内容渲染在设置弹层内部，
 * 不再抬高 zIndex 叠一层独立弹窗（维护者口径：#727 阶段 1 只许有一个容器）。
 */
export const openAccountConsume = (tab: AccountConsumeTab = 'cards') => {
  useSettingsDialog.setState({
    open: true,
    section: 'account',
    accountConsumeTab: tab,
  })
}

/**
 * 通知按钮上的动作：**用户点了**才打开设置（落在第三个 tab：渠道 / API Key / 模型都在那里）。
 *
 * 为什么单独提一个函数、而不是在 `ensureApiKey` 里写内联箭头：那条路径必须一眼看出
 * 「打开设置只可能来自一次点击」。源码门禁 `tests/unit/no-auto-settings.test.mjs` 直接断言
 * `ensureApiKey` 函数体里**不出现** `openSettings(` —— 内联写法就算是点击回调也会被它判红，
 * 而这条门禁要防的正是「发送时顺手把设置弹出来」（产品决定 2026-11-25：不许自动弹设置层）。
 */
const openSettingsFromHint = () => {
  openSettings('account')
}

/**
 * 发送前的 Key 守卫：返回是否放行（每个发送入口 —— 输入行、编辑后重发、重新生成 —— 都会调它）。
 *
 * **拦下就只是拦下 + 一条通知，绝不打开设置层**（产品决定 2026-11-25）：
 * 「没有 key 就自动弹设置」这个功能被否掉了 —— 没有 Key 时该出现的是**通知**，
 * 通知上有「去选择渠道 / 打开设置」按钮，用户**自己点**才进设置（`openSettings('account')`）。
 * 自动弹层会打断用户（尤其启动时他还没做任何事），也让「点一下就走」变成「先关一层弹层」。
 *
 * 五条路，顺序不能换（Issue #451 第 2 点在这条链路上落地）：
 *
 *  1. `ok`            → 放行，一个多余的判断都不多做；
 *  2. `missing`       → 一个 Key 都没有（**既有路径**，只是落点从「弹设置」改成「弹通知 + 按钮」）；
 *  3. `format`（#451）→ 有 Key 但格式明显不对：同样只发通知，**不发请求** ——
 *     所以不会有一次 401 和一条「API Key 无效或已被删除」的误导文案
 *     （用户手上明明有一把 Key，那句话只会让他以为 Key 被删了）；
 *  4. `claim`（#596）→ 本机没有服务端下发的那把 Key（没领过 / 手填的 / 老版本留下的）；
 *  5. `stale`（#596）→ 本机这把与服务端下发标记不一致（服务端换过了）。
 *
 * **第 4/5 条在 #898 之后分成两半**（这是本文件唯一一处「判定档位相同、处置不同」）：
 *  - 本地**有** Key → **放行试发一次** + 保守提示（控制面失败不阻断数据面）；诊断记
 *    `degrade-send-managed-key`。这是 #898 的验收项，不许改回「一律拦」；
 *  - 本地**没有** Key → 仍然拦（#898 只允许保留「本地完全没有凭据」与「服务端明确拒绝」两条）。
 *
 * 第 4/5 条**刻意不使用**「服务器繁忙」「未知错误」这类掩盖性说法：那正是 #596 第 1 条事故里
 * 用户被误导的原因（本地存着旧 Key，服务端换了，401 被读成「服务器忙」）。
 *
 * 通知的两段：正文说清「这条消息没有发出 / 下一步做什么」，按钮是**唯一出口**
 * （toast 3 秒就没了，带按钮的给到 `ACTION_DURATION` 8 秒 —— 点不到等于没有入口）。
 *
 * 为什么还要写 `managedKeyBlocked` / `apiKeyFormatBlocked` 这两个 marker（**不是**为了「让弹窗显示原因」）：
 * 设置页本来就逐字渲染它们（`ManagedKeyField` / `ApiConfigFields` 读 store，与「怎么打开的」无关），
 * 用户点通知上的按钮进来时，Key 那一行会直接写出「为什么刚才没发出去」，不用他自己猜。
 * 用户从侧栏自己点进来也一样读得到 —— marker 跟着这次拦截，`closeSettings()` 清掉，不留僵尸提示。
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
    // 一个 Key 都没有：说「还没有可用的 API Key」，按钮「去选择渠道」——
    // #727 阶段 1：渠道 / API Key / 模型都在第三个 tab（账户与消费），所以落点是 `account`
    // （落在「数据管理」会把用户送到一个没有 Key 输入框的面板）。点了才开，不点不开。
    showToast(
      { key: 'sendBlockedNoApiKey' },
      { action: { key: 'sendBlockedPickProvider', run: openSettingsFromHint } }
    )
    return false
  }
  if (status === 'claim' || status === 'stale') {
    const localKey = getApiKey().trim()
    /**
     * **降级优先**（#898，母单 #894 的「控制面不可达不阻断数据面」）。
     *
     * 只要本地**有一把** Key，就先按它试发一次：控制面（自动领 Key）这一次没成，
     * 不该把数据面（发消息）一起堵死 —— #898 正文里的用户实证就是 `sk-3c5…` 已经在本地，
     * 界面仍提示「这条消息暂时发不出去」。
     *
     * 与 #596 的冲突是明摆着的，解法写在这里：**放行，但让 401 说话**。
     * 所以两条约束不许退：
     *  1. 提示文案保守（「先按本地 Key 试发一次；失败就去重新领取」），**不承诺成功**；
     *  2. 诊断里留痕（`degrade-send-managed-key` + 档位 + 长度，Key 原文不进日志），
     *     出问题时能查出「这一次是降级发出去的」。
     * 任一失守，#898 就退回成 #596 第 1 条事故（用户一直 401 却以为是服务器繁忙）。
     */
    if (localKey !== '') {
      recordAction('nav', 'degrade-send-managed-key', {
        reason: status,
        length: localKey.length,
      })
      showToast(
        { key: status === 'stale' ? 'settingsManagedKeyStaleDegraded' : 'settingsManagedKeyClaimDegraded' },
        { action: { key: 'openSettingsEntry', run: openSettingsFromHint } }
      )
      return true
    }
    const blocked = status === 'stale' ? 'stale' : 'unclaimed'
    // 走到这里 = **本地一把 Key 都没有**：这是 #898 明确允许保留的阻断之一（没有可用凭据）。
    // 先在诊断里留痛（只记判定档位与长度，Key 原文不进日志），再发通知。
    recordConfigRejection('apiKey', status)
    recordAction('nav', 'block-send-managed-key', {
      reason: status,
      length: localKey.length,
    })
    useSettingsDialog.setState({ managedKeyBlocked: blocked })
    showToast(
      { key: blocked === 'stale' ? 'settingsManagedKeyBlockedStale' : 'settingsManagedKeyBlockedClaim' },
      { action: { key: 'openSettingsEntry', run: openSettingsFromHint } }
    )
    return false
  }
  // format：先在诊断里留痕（这类「有 Key 却发不出去」只看状态是查不出来的），再发通知
  recordConfigRejection('apiKey', 'format')
  // 只记「有没有 / 多长」这类可切片字段，Key 原文一个字都不进日志（与 setApiKey 同一口径）
  recordAction('nav', 'block-send-invalid-key', { reason: 'format', length: getApiKey().length })
  useSettingsDialog.setState({ apiKeyFormatBlocked: true })
  showToast(
    { key: 'settingsApiKeyFormatBlocked' },
    { action: { key: 'openSettingsEntry', run: openSettingsFromHint } }
  )
  return false
}

/**
 * 发送前的**凭据**守卫（Issue #793）：**既没登录、也没有一把能用的 Key** 时，一个请求都不发。
 *
 * 为什么这就是 #793 的那个洞：三道既有门禁（`ensureApiKey` / `ensureSendConfig`）都长在 UI 的
 * 发送入口上，服务层（`chat/store.ts` 的 `sendMessage` / `regenerateReply` / `editMessage`）
 * 一道都没有 —— 于是「重新生成」「继续」这类**没有走输入框**的入口，以及任何绕过 UI 的调用，
 * 会带着空 `x-api-key` / `Authorization` 直接把请求打出去：上游回 401，界面停在转圈上，
 * 一句可读的话都没有（用户不知道该登录、还是该选渠道）。
 *
 * 判据全在纯函数 `checkSendPrerequisites()`（`sendConfigCheck.ts`），这里只做三件事：
 *  1. **说清是什么都缺**：toast 写「请先登录或选择模型渠道后再发送，这条消息没有发出」；
 *  2. **给一个按键就能过去的入口**：toast 上挂一个「去选择渠道」的动作，点了走
 *     `openSettings('account')` 那条既有路径（#727 的第三个 tab，模型来源那三行就在里面）——
 *     toast 三秒就没了，动作按钮给了 8 秒（`ACTION_DURATION`），点不到等于没有入口；
 *  3. **返回 false**：调用方据此不再往下走 —— 请求数为 0 是这条拦截的全部价值。
 *
 * 与另外两道门的分工（不重复判定、不互相顶替）：
 *  - `ensureSendPrerequisites`：**身份**有没有（登录态 / 一把能用的 Key）—— 两样都没有才拦；
 *  - `ensureApiKey`：Key 有没有、像不像、是不是服务端发的那把（#374 / #451 / #596）——
 *    已登录（或已有一把好 Key）时仍由它说「去填 Key / 去领取 / 格式不对」；
 *  - `ensureSendConfig`：地址与模型填得对不对（#490）。
 *
 * 顺序上它排在 `ensureApiKey` **之前**：未登录 + 没 Key 时，把用户送进设置里「去领取 / 去填 Key」
 * 是一句做不到的话（我们的渠道要先登录才领得到，自填渠道在 web 上也确实能填 —— 所以这里给的
 * 是「登录或选渠道」二选一的入口，而不是断言他必须登录）。
 */
export const ensureSendPrerequisites = (): boolean => {
  const verdict = checkSendPrerequisites({
    authenticated: getAuthSnapshot().state === 'authenticated',
    // 「能用的 Key」与发送时那一份口径相同：`ok` 才放行（`missing` / `format` / `claim` / `stale` 都不算）
    hasUsableKey: checkApiKeyBeforeSend() === 'ok',
  })
  if (verdict.ok) {
    return true
  }
  // 请求都没发出去，只有本地判定：这类「什么都没配」的状态在请求日志里根本看不见，先留痕
  recordConfigRejection('apiKey', verdict.code)
  recordAction('nav', 'block-send-no-credentials', {
    code: verdict.code,
    // 只记判定档位，Key 原文 / 登录态细节都不进日志（与 `setApiKey` 同一口径）
    authenticated: false,
  })
  showToast(
    { key: verdict.messageKey },
    { action: { key: verdict.actionKey, run: () => openSettings('account') } }
  )
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
 *  2. **给一个点了就过去的入口**：toast 上挂「打开设置」，用户点了才落在「账户与消费」
 *     （地址 / 模型都在那一页）；拦下的同时把 `sendConfigBlocked` 写上，`ApiConfigFields`
 *     的地址 / 模型行据此写红字 —— marker 与服务端/设置层无关，用户从侧栏自己进来也读得到；
 *  3. **返回 false**：调用方据此不再往下走 —— 请求数为 0 是这条拦截的全部价值。
 *
 * **拦下时不自动打开设置层**（产品决定 2026-11-25：「地址/模型填错也没有必要自动打开设置，
 * 压根不需要什么自动打开设置的操作」）：与 `ensureApiKey` 同一条纪律 —— 自动弹层会打断用户，
 * 也让「点一下就走」变成「先关一层弹层」。源码门禁 `tests/unit/no-auto-settings.test.mjs`
 * 的第 [6][7] 条钉住这件事（本函数体里不许出现 `openSettings(`）。
 *
 * 本函数只在**发送入口**被调用，启动链路一次都不走（2026-11-25 起 `App` 的启动 effect 连
 * `ensureApiKey` 都不调了）：用户还没做任何事时，不该因为一个历史遗留的空模型被弹窗打断。
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
  // 拦下只发通知，**不打开设置层**（产品决定 2026-11-25：「压根不需要什么自动打开设置的操作」）。
  // 「打开设置」在按钮上，用户自己点才进 —— 与 `ensureApiKey` 同一条路径（复用同一个 helper 与 key）。
  showToast(
    { key: verdict.messageKey },
    { action: { key: 'openSettingsEntry', run: openSettingsFromHint } }
  )
  useSettingsDialog.setState({ sendConfigBlocked: verdict.code })
  return false
}
