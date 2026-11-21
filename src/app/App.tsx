import { useEffect, type CSSProperties } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { syncManagedKeyFromServer } from '../components/settings/managedKeyRuntime.js'
import { useAuthStatus } from '../services/auth/useAuthStatus.js'
import { useIsOursChannel } from '../services/api/apiConfig.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { initChatBackground, useChatBackground } from '../services/chat/background.js'
import { onUploadNotice } from '../services/attachments.js'
import { onMemoryNotice } from '../services/memory/sessionMemory.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
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
  // 聊天背景图存在 IndexedDB，刷新/重开后读回；只作用于聊天主区域
  const backgroundUrl = useChatBackground((state) => state.url)
  // #596：自有渠道的 Key 由服务端下发，进入该渠道时要与本地对齐一次（见下面的 effect）
  const oursChannel = useIsOursChannel()
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
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key（启动这一次只为「一个都没有」打开设置，见 #596）
    ensureApiKey({ fromBoot: true })
  }, [])

  /**
   * 「我们的渠道」的 Key 由服务端管理（Issue #596）：进入该渠道时对齐一次。
   *
   * 为什么在启动就对齐、而不是等用户点按钮：事故里那一类是「服务端早换了、
   * 本机还留着旧的」，等用户操作就永远等不到。这里用幂等的领取问一次服务端那把是哪把，
   * 不一样就覆盖本地（`syncManagedKeyFromServer` 内部完成落盘 + 写下发标记）。
   *
   * **#800 起它是唯一的恢复入口**（内置服务子页不再有 Key 行与「重新领取」），所以依赖里多了
   * 登录态：先启动、后登录的用户（#608 允许未登录先逛）登录成功这一刻也要对齐一次，
   * 否则本机一直没有服务端那把、发送前那道闸会一直拦着，而用户已经没有按钮可点。
   *
   * 失败（未登录 / 离线 / 服务端异常）**静默**：本机现状不动，发送前那道闸会用标记
   * 判出「这把不是服务端那把」并拦下来，并在设置页里自动再对齐一次（见 `AccountConsumePage`）。
   */
  useEffect(() => {
    if (!oursChannel || !signedIn) {
      return
    }
    void syncManagedKeyFromServer().catch(() => {})
  }, [oursChannel, signedIn])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main
          className={styles.main}
          data-chat-background={backgroundUrl ? 'on' : undefined}
          style={
            backgroundUrl
              ? ({ '--chat-background-image': `url("${backgroundUrl}")` } as CSSProperties)
              : undefined
          }
        >
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
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
      <Toast />
    </>
  )
}
