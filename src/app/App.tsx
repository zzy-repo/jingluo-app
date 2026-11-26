import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslate, type TranslationKey } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import {
  SAVE_BANNER_MESSAGE,
  saveBannerRetryable,
  selectSaveBannerTier,
  type SaveBannerTier,
  type StorageInitFailure,
} from '../services/chat/db.js'
import { DataLostBanner } from '../components/protection/DataLostBanner.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { SessionBranchDialog } from '../components/session/SessionBranchDialog.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { openSettings, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { syncManagedKeyFromServer } from '../components/settings/managedKeyRuntime.js'
import { useAuthStatus } from '../services/auth/useAuthStatus.js'
import { useApiConfig } from '../services/api/apiConfig.js'
import { shouldSyncManagedKey } from '../services/api/managedKey.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { AnnouncementPopup } from '../components/announcements/AnnouncementPopup.js'
import { applyResetFromLocation } from '../services/announcements/store.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import {
  initChatBackground,
  loadSessionBackground,
  useChatBackground,
  useSessionBackground,
} from '../services/chat/background.js'
import { backgroundPlanOf, resolveSessionBackground } from '../services/chat/sessionBackground.js'
import { onUploadNotice } from '../services/attachments.js'
import { useExternalImportBridge } from '../components/chatInput/useExternalImport.js'
import { onMemoryNotice } from '../services/memory/sessionMemory.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { UpdateDialog } from '../components/update/UpdateDialog.js'
import { snoozeStartupUpdatePrompt, startUpdateGate, useUpdateGate } from '../services/updateGateState.js'
import { bundledApp } from '../services/appUpdate.js'
import styles from './App.module.css'

/**
 * 读库失败的文案（P0）：`blocked`（另一个标签页攥着旧连接）与 `version`（库比代码新）**各有专属说法**。
 *
 * 为什么不能统一成「加载失败请重试」：这两种情况下重试永远是同一个结果 ——
 * 前者要用户去关掉其它页面，后者要用户更新应用。把重试按钮摆在最显眼处只会让用户反复点。
 */
const loadFailureKey = (ready: boolean, initFailure: StorageInitFailure | null): TranslationKey => {
  if (ready) {
    return 'sessionLoadFailed'
  }
  if (initFailure === 'blocked') {
    return 'storageBlockedByOtherTab'
  }
  if (initFailure === 'version') {
    return 'storageVersionTooNew'
  }
  return 'sessionListLoadFailed'
}

/**
 * 附件降级的文案：**配额不足就用配额那句话**（用户的动作同样是「清理 / 导出备份后重试」），
 * 其余原因用「附件没能存进本机」。
 *
 * 为什么不能复用「这段对话没存到本机」：拆事务之后，会话确实已经落盘了，
 * 跟用户说对话没存上是**假话**，而且会让人以为要重发整轮问答。
 */
const degradedMessageKey = (tier: SaveBannerTier): TranslationKey =>
  tier === 'quota' ? 'sessionSaveFailedQuota' : 'attachmentSaveFailed'

/**
 * 公告的调试开关（产品方边看边提要求时反复看弹窗效果用）：
 * URL 带 `?ann-reset` 就清掉「已读 / 已弹过」两个标记，没带就什么都不做。
 *
 * 放在模块作用域、只跑一次：放进组件体里会跟着每次重渲染重复清空 ——
 * 用户刚点完「一键已读」，一个状态更新就把红点又还原回去。page load 一次正好。
 */
applyResetFromLocation(typeof window === 'undefined' ? '' : window.location.search)

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  /**
   * 保存失败横幅的**档位**（P0）：`unavailable` > `quota` > 可重试。
   * 选档与文案映射都是纯函数（`db.selectSaveBannerTier` / `db.SAVE_BANNER_MESSAGE`），L0 直接可测。
   */
  const saveTier = useChatStore((state) => selectSaveBannerTier(state.sessionSaveErrors, state.lowSpace))
  /**
   * 附件降级（会话已落盘、blob 没写进去）：单独提示，绝不冒充「这段对话没存到本机」。
   * 档位与文案：配额不足时说「本机存储空间不足…」（用户的动作就是清理后重试），
   * 其余原因说「附件没能存进本机（可重试）」—— 两种情况都不许说「这段对话没存到本机」。
   */
  const degradedAttachments = useChatStore((state) => state.degradedAttachments)
  const degradedTier = selectSaveBannerTier(
    Object.fromEntries(
      Object.entries(degradedAttachments).map(([id, item]) => [id, item.failure])
    )
  )
  const initFailure = useChatStore((state) => state.initFailure)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  /**
   * 聊天背景（本单改成三层：会话设置 > 全局默认 > 什么都不加）。
   *
   *   - `backgroundUrl`：设置页「默认背景」那张图（IndexedDB 固定 key，老用户升级前就在用的那张）；
   *   - `sessionBackgroundUrl`：**当前会话**自己的图（key `chat-background:session:<id>`），
   *     只在 url 的主人正是当前会话时才取用 —— 否则会 A 会话的图闪到 B 会话上；
   *   - 两者合成 `plan`（`sessionBackground.ts` 的纯函数，L0 有测试），App 只按它铺变量。
   */
  const backgroundUrl = useChatBackground((state) => state.url)
  const sessionBackgroundUrl = useSessionBackground((state) =>
    state.sessionId !== null && state.sessionId === activeId ? state.url : null
  )
  const plan = backgroundPlanOf(resolveSessionBackground(session, { url: backgroundUrl }, sessionBackgroundUrl))
  const needsBuiltinKey = useApiConfig((state) => shouldSyncManagedKey(state.kind, state.apiKey))
  // #800：对齐还需要登录态（领取链路要 JWT）；判断口径与账号面板一致（`authenticated`），不自己造一套
  const signedIn = useAuthStatus().authenticated

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  // #399：记忆超出容量上限淘汰了条目 / 单条超上限被拒绝时，必须让用户看见（不许静默丢）
  useEffect(() => onMemoryNotice(showToast), [])
  useEffect(() => {
    void initChatBackground()
  }, [])
  // 切会话时读回该会话自己的背景图；object URL 的 revoke 由 background.ts 统一管
  useEffect(() => {
    void loadSessionBackground(activeId)
  }, [activeId])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    /**
     * 启动期**不再**打开设置层（产品决定 2026-11-25）。
     *
     * 这里曾经是「无 Key 首启就把设置弹出来让用户先填 Key」（`ensureApiKey({ fromBoot: true })`，
     * 还排在 `startUpdateGate()` 之后以免两层弹窗叠在一起）—— 那个功能被明确否掉了：
     * 没有 Key 时该出现的是发送时的一条**通知**（上面带「去选择渠道」按钮，用户自己点才进设置），
     * 而不是用户什么都没做就先被一层弹层打断。启动期的判定现在什么都不用做，
     * 更新检查由下面那个独立的 effect 负责（`void startUpdateGate()`）。
     */
  }, [])

  /**
   * 启动检查更新（本单）。
   *
   * 为什么必须在这里、而不是只在「设置 → 关于 → 应用更新」里：那一页只有用户主动点进去才跑，
   * 于是服务端的 `minSupportedVersionCode`（强制更新）等于空转 —— 线上清单 12 条记录里
   * 一条 `updatePolicy` 都没下发过，就是这个机制从没真正生效过的旁证。
   *
   * 三条纪律：
   *  1. **不阻塞首屏**：`void` 掉它，没有 `await`、没有 `Suspense`；判定要一次网络往返（超时 2.5s）；
   *  2. **判不出就不拦**：拉不到清单 / 超时 / 脏 JSON / 版本号读不出来，一律当「没什么要说的」
   *     （逻辑在 `services/updateGate.ts`，本文件不做任何兜底判断）；
   *  3. **结果只落 store**：`StartupUpdatePrompt` 与 `ChatInput` 的发送门禁读的是同一份判据。
   */
  useEffect(() => {
    void startUpdateGate()
  }, [])

  /**
   * 外部应用文件导入（WPS / 微信 / QQ / 文件管理器的「打开方式 / 分享」）。
   *
   * 挂在这里而不是 ChatInput 里：订阅是**应用级**的，与当前停在哪个会话无关 ——
   * 用户在别的会话里被分享进来，也要先切到新建对话再把附件铺进草稿。
   * 非 Android（Web / iOS）时内部直接返回，一行行为都不产生。
   */
  useExternalImportBridge()

  /** 只为了让「公告弹窗是否让位」跟着判定结果重渲染；具体档位由下面两个组件自己读 */
  const updateGateKind = useUpdateGate((state) => state.gate.kind)

  /**
   * 恢复登录时也补领：旧版已登录但没有配置模型来源的人，重开 App 就能走到这里。
   * 已选内置服务时照常与服务端对齐（#596 / #800）。
   */
  useEffect(() => {
    if (!needsBuiltinKey || !signedIn) {
      return
    }
    void syncManagedKeyFromServer().catch(() => {})
  }, [needsBuiltinKey, signedIn])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        {/*
          * 背景三层叠放都挂在 `.main` 的伪元素上（App.module.css）：
          *   ::before = 图/渐变（固定层，`pointer-events: none`，模糊只加在这一层）
          *   ::after  = 遮罩（保正文对比度，alpha 由「背景淡化」决定）
          * 会话级设置只影响这三个 CSS 变量的取值，不新增 DOM 节点、不碰消息列表。
          */}
        <main
          className={styles.main}
          data-chat-background={plan ? 'on' : undefined}
          data-chat-background-style={plan?.style}
          style={
            plan
              ? ({
                  '--chat-background-image': plan.imageCss,
                  ...(plan.maskAlpha === null
                    ? null
                    : { '--chat-background-mask': String(plan.maskAlpha) }),
                  ...(plan.blurPx > 0 ? { '--chat-background-blur': `${plan.blurPx}px` } : null),
                } as CSSProperties)
              : undefined
          }
        >
          {saveTier ? (
            <div className={styles.saveError} role="alert">
              <span>{t(SAVE_BANNER_MESSAGE[saveTier])}</span>
              {/* `unavailable`（这个环境根本写不进去）**不给重试**：点了也是同一个结果 */}
              {saveBannerRetryable(saveTier) ? (
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingHistory}
                  onClick={retrySaveSessions}
                >
                  {t('retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {degradedTier ? (
            <div className={styles.saveError} role="status">
              <span>{t(degradedMessageKey(degradedTier))}</span>
              {saveBannerRetryable(degradedTier) ? (
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingHistory}
                  onClick={retrySaveSessions}
                >
                  {t('retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <DataLostBanner className={styles.saveError} />
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(loadFailureKey(ready, initFailure))
                      : t('sessionLoading')}
                  </span>
                  {/* 库比代码新时重试一万次也一样：只留「请更新应用」这句话，不给假的出口 */}
                  {(!ready ? initError : sessionLoadError) &&
                  loadFailureKey(ready, initFailure) !== 'storageVersionTooNew' ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      {/*
       * 首次进入的公告弹窗（只弹最新一条，本地 mock）：与设置弹窗互斥，见组件内注释。
       *
       * 与「启动更新提示」的互斥（本单）：
       *  · **强制更新优先** → 判出 `forced` 时公告弹窗整个不挂载（公告让位），
       *    否则两层 dialog 会叠在一起，Esc / 点遮罩都只落到最上面那层，用户看到的是「点了没反应」；
       *  · `soft` 定时相反：公告先弹出去了就**不再弹**更新提示（先到先得），
       *    判定在 `<StartupUpdatePrompt>` 里做（那里能看见「现在已经有 dialog 开着」）。
       * 公告组件本身一个字没改（它有自己的「不弹过 / 没有未读 / 设置开着」三条既定口径）。
       */}
      {updateGateKind === 'forced' ? null : <AnnouncementPopup />}
      {/* 启动更新提示：soft = 可关闭（「稍后提醒」走既有 snooze），forced = 关不掉（只有「去更新」一个出口） */}
      <StartupUpdatePrompt />
      {/* #831 会话级分支的确认弹层：两个入口（列表「更多」/ 回答下方）共用这一份 */}
      <SessionBranchDialog />
      <Toast />
    </>
  )
}

/**
 * 「现在已经有另一层 dialog 开着吗」——启动更新提示挂载**之前**问一次。
 *
 * 为什么用 DOM 判而不是状态：公告弹窗（`AnnouncementPopup`）的开关是它自己的组件内 state，
 * 没有对外暴露，而本单**不许改**它的文件。`Modal`（`components/base/Modal.tsx`）的卡片上
 * 恒有 `role="dialog"`，所以「文档里有没有 role=dialog」就是「屏幕上是不是已经有一层弹层」，
 * 这是能拿到的最直接的事实，也比推断「公告会不会弹」可靠（公告还有「已弹过 / 没有未读 /
 * 设置开着再判一次」三条口径）。
 */
const anotherDialogOpen = (): boolean => {
  try {
    return document.querySelector('[role="dialog"]') !== null
  } catch {
    return false
  }
}

/**
 * 启动更新提示（本单）。
 *
 * | 档位 | 弹不弹 | 关闭方式 |
 * | --- | --- | --- |
 * | `none` | 不弹 | —— |
 * | `soft` | 弹，**但已经有别的 dialog 开着就不弹**（先到先得） | 「稍后提醒」写 snooze / X / Esc / 遮罩 |
 * | `forced` | 一定弹，且公告弹窗已被让位 | 关不掉；只有「去更新」一个出口 |
 *
 * forced 的「去更新」为什么是「收起提示 + 打开设置」而不是在本层做下载：
 * 下载 / 安装 / 校验 / 失败分类那一整套状态机只长在 `AppUpdateField` 里（#373 / #310 的坑都补在那一处），
 * 在这里抄一份等于给它开第二个发作点。启动提示只负责**拦人 + 指路**，
 * 真正的只读约束由 `ChatInput` 的发送门禁承担 —— 用户就算关掉了设置，一样发不出消息。
 */
const StartupUpdatePrompt = () => {
  const t = useTranslate()
  const gate = useUpdateGate((state) => state.gate)
  const checked = useUpdateGate((state) => state.checked)
  /** 用户已经动过手（稍后提醒 / 去更新）：本次运行不再弹 */
  const [closed, setClosed] = useState(false)
  /** 判定只做一次：否则每次 store 更新都会重新问一次 `anotherDialogOpen()`，弹出时机漂移 */
  const decided = useRef(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (decided.current || !checked || gate.kind === 'none') {
      return
    }
    decided.current = true
    // forced 无视别的弹层（它优先级最高）
    if (gate.kind === 'forced') {
      setShow(true)
      return
    }
    /**
     * soft 让位给「先到先得」，判定放在一个宏任务之后。
     *
     * 这条延迟原本的理由是「无 Key 首启」那条路会在本次判定之后、同一个 tick 内把设置弹层打开
     * （`ensureApiKey({ fromBoot: true })`），立刻问 `anotherDialogOpen()` 只会得到 false，
     * 于是两层弹窗叠在一起（实测）。2026-11-25 起启动期不再自动打开设置，那个理由消失了；
     * 但「等一帧再判弹层叠不叠」本身是这条更新提示的既有现场行为，本次改动不动它（只改注释）。
     */
    const timer = setTimeout(() => {
      // 设置弹层「已打开」以 store 为准（DOM 要等 React 提交，宏任务里可能还没落）；再兜一层 DOM 检查
      setShow(!useSettingsDialog.getState().open && !anotherDialogOpen())
    }, 0)
    return () => clearTimeout(timer)
  }, [checked, gate])

  if (!checked || gate.kind === 'none' || !show || closed) {
    return null
  }
  return (
    <UpdateDialog
      release={gate.release}
      /* 「当前版本」那一格：与设置页同一口径（构建期注入的版本名） */
      currentVersion={bundledApp().version}
      policy={gate.policy}
      primary={{
        label: t('updateGateActionUpdate'),
        onClick: () => {
          setClosed(true)
          // 设置首页的「关于」组里就是「应用更新」那一行（检查 / 下载 / 安装都在它里面）
          openSettings('general')
        },
      }}
      onSnooze={() => {
        snoozeStartupUpdatePrompt()
        setClosed(true)
      }}
      onClose={() => setClosed(true)}
    />
  )
}
