import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo } from 'react'
import { IconRefreshOutline16, IconWarningOutline16 } from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply } from '../../services/chat/reply.js'
import {
  continueReply,
  regenerateReply,
  stopReply,
  useChatStore,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings, openOursServices } from '../settings/settingsDialogState.js'
import { useIsOursChannel } from '../../services/api/apiConfig.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { copyText as copyToClipboard } from '../../utils/clipboard.js'
import { showToast } from '../base/toastState.js'
import { useSettings } from '../../services/settings.js'
import { ReplyArea } from './ReplyArea.js'
import { WaitNotice } from './WaitNotice.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 额度和充值都发生在「我们的渠道」上：它自带「额度与卡密」弹层（套餐 / 卡密兑换 / 剩余额度），
  // 提示里的出路就该开这个弹层，而不是把用户甩去 DeepSeek 官网（#299）
  const oursChannel = useIsOursChannel()
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  // 思考过程设为「完全不显示」时，思考期间回复区是空的：这里补回等待圆点，避免一片空白。
  const thinkingHidden = useSettings((state) => state.thinkingDisplay) === 'hidden'
  /**
   * 首字前一律走这块等待占位（#328 修 G4）：
   * 原来还要求 `!message.thinking`，而专家模式 `thinking = true` 从点发送就成立，
   * 于是 `waiting` 整段为 false —— #41 的 5s/30s/60s 三档提示在专家模式是死代码。
   * 思考块真的出现后（`view.steps.length > 0`）才交给 ReplyArea 的标题，隐藏档继续留在这里。
   */
  const waiting = streaming && !view.answer && (thinkingHidden || view.steps.length === 0)
  // 首字等待的分级提示：阶段名 + 已等待秒数（秒数在 WaitNotice 里 1Hz 自刷，不进 store）
  const waitHint = useChatStore((state) => state.waitHints[sessionId])
  const waitActions = waiting && !!waitHint?.actions
  const summaryEntry = `${message.id}-summary`
  return (
    <div className={styles.message}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          <span className={styles.waitingDots}>
            {[0, 1, 2].map((index) => (
              <span key={index} className={styles.waitingDot} />
            ))}
          </span>
          {waitHint ? <WaitNotice hint={waitHint} /> : null}
          {waitActions ? (
            <button
              type="button"
              className={styles.waitingAction}
              onClick={() => stopReply(sessionId)}
            >
              {t('chatInputStopButtonTooltip')}
            </button>
          ) : null}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => openSettings('data')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                {oursChannel ? (
                  <button
                    type="button"
                    className={styles.noticeAction}
                    onClick={() => openOursServices()}
                  >
                    {t('quotaTopUpEntry')}
                  </button>
                ) : (
                  <a
                    className={styles.noticeAction}
                    href={TOP_UP_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('topUp')}
                  </a>
                )}
              </>
            ) : null}
            {/*
              未识别的失败不再只给一句「未知错误」（#324）：文案里已经带了状态码与上游短码，
              这里给一个「复制诊断信息」的出口，走 #104 同一套剪贴板与反馈文案。
            */}
            {notice.diagnostics ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => {
                    void copyToClipboard(notice.diagnostics as string).then((ok: boolean) => {
                      showToast({ key: ok ? 'errorScreenCopied' : 'errorScreenCopyFailed' })
                    })
                  }}
                >
                  {t('errorScreenCopyDiagnostics')}
                </button>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
