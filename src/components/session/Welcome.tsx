import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getSpec } from '../../services/api/providers.js'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { setChatMode, useSettings, type ChatMode } from '../../services/settings.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

const IconBoltOutline24 = () => (
  <svg
    className={styles.modeIcon}
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M13 2.8L4.7 13.6H10.6L9.4 21.2L17.9 10.4H11.8L13 2.8Z"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IconGemOutline24 = () => (
  <svg
    className={styles.modeIcon}
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M12 3.1L20.2 11.5L12 20.9L3.8 11.5L12 3.1Z"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * 分段切换控件：**真的切档位**——写 settings.chatMode（落 localStorage），
 * 请求侧由 chat/store.ts 的 createReply 读成 AssistantMessage.thinking，
 * 最终变成请求体的 thinking.type（快速 = disabled，专家 = enabled），见 issue #25。
 * 与输入行「深度思考」开关共用同一个状态（setThinking 等价于切模式），两边永远同步。
 *
 * #341 起入口**恒常驻**：四渠道都渲染、都可点，不置灰、不带 `disabled` / `aria-disabled`。
 * `caps.thinking` 只表示档位是否真生效，落在不可见的 `data-thinking-effective` 上；
 * 不可用渠道的请求侧由 `REQUEST_GATES.reasoning_param` 拦截，一个思考字段都不发。
 */
const ModeSwitch = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.chatMode)
  const caps = getSpec(useApiConfig((state) => state.kind)).caps
  const options: { mode: ChatMode; label: string; icon: ReactNode }[] = [
    { mode: 'fast', label: t('modeFast'), icon: <IconBoltOutline24 /> },
    { mode: 'expert', label: t('modeExpert'), icon: <IconGemOutline24 /> },
  ]
  return (
    <div
      className={styles.modeSwitch}
      role="group"
      aria-label={t('modeSwitchLabel')}
      data-thinking-effective={caps.thinking ? 'true' : 'false'}
    >
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          data-mode={option.mode}
          aria-pressed={mode === option.mode}
          className={clsx(styles.modeOption, mode === option.mode && styles.modeOptionSelected)}
          onClick={() => setChatMode(option.mode)}
        >
          {option.icon}
          <span className={styles.modeLabel}>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/** 新对话：问候语 + 模式切换 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.hero}>
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
          <ModeSwitch />
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
