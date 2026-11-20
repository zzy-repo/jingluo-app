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
import { openAccountConsume, openSettings } from '../settings/settingsDialogState.js'
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
          {/*
            文案 + 操作 + 折叠区共用一个列容器（#347 / #353）：折叠区要独占一行，
            不能和文案挤在同一个行盒里（英文原文一长就会把「打开设置」挤到屏幕外）。
          */}
          <div className={styles.noticeBody}>
            <span>
              {notice.text}
              {/*
                可操作入口（#347 / #353）：参数错误 / 模型不可用这两档以前只会「叫用户去设置里看」，
                却没有任何能点的东西。这里复用 #303 的按钮样式，落到「数据管理」（服务配置就在那一组）。
              */}
              {notice.action === 'settings' ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={styles.noticeAction}
                    onClick={() => openSettings('data')}
                  >
                    {t('openSettingsEntry')}
                  </button>
                </>
              ) : null}
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
                      onClick={() => openAccountConsume('quota')}
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
                Key 失效那一档的「先看额度」入口（#374）：换 Key 会影响额度归属，
                用户需要一条**不动 Key** 的路去核对当前账号 / 剩余额度，所以它和
                「更换 API Key」并排给，不与后者互斥。
              */}
              {notice.quotaAction ? (
                <>
                  {' '}
                  {oursChannel ? (
                    <button
                      type="button"
                      className={styles.noticeAction}
                      onClick={() => openAccountConsume('account')}
                    >
                      {t('openQuotaPanel')}
                    </button>
                  ) : (
                    <a
                      className={styles.noticeAction}
                      href={TOP_UP_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('openQuotaPanel')}
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
            {/*
              折叠区「上游原文」（#347 / #353）：默认收起 —— 英文原文直接铺在界面上既不可读
              也不可控（#324），但完全看不到又会让用户和反馈群无从判断。折起来是两全的那一档：
              内容已在服务层截断（200 字）并脱敏（scrubReportText），展开也不会带出 Key / 卡密。
            */}
            {notice.upstream ? (
              <details className={styles.noticeUpstream} data-testid="notice-upstream">
                <summary className={styles.noticeUpstreamToggle}>
                  {t('upstreamDetailToggle')}
                </summary>
                <pre className={styles.noticeUpstreamText}>{notice.upstream}</pre>
              </details>
            ) : null}
          </div>
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
