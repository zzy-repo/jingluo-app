import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  IconDocumentOutline16,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { getApiKey, supportsFileUpload, useApiConfig } from '../../services/api/apiConfig.js'
import { getSpec } from '../../services/api/providers.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftDocuments,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { ATTACHMENT_LIMITS, SUPPORTED_EXTENSIONS } from '../../services/attachments/limits.js'
import {
  acceptsDocuments,
  supportsImage,
  visionFor,
} from '../../services/attachments/providerCapability.js'
import {
  AttachmentList,
  AttachmentPicker,
  extensionOf,
  useAttachmentDrafts,
} from '../attachments/index.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import {
  ensureApiKey,
  ensureSendConfig,
  ensureSendPrerequisites,
} from '../settings/settingsDialogState.js'
import { enterKeyHintFor, resolveEnterKeyAction } from './enterKey.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { IMAGE_ACCEPT } from '../../services/attachments/imageSource.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import { ThinkingToggle } from './ThinkingToggle.js'
import styles from './ChatInput.module.css'

/**
 * 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止。
 *
 * #813：官方渠道（`kind === 'deepseek'`）走**精简工具栏** —— 语音输入与文档上传都不渲染，
 * 右侧只剩最右边的文件上传（回形针）与发送 / 停止，见 `Input` 里的 `compactToolbar`。
 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments, documents } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  // 回车键行为（issue #108）：默认 enter-send 等于改造前的写死行为
  const enterKeyMode = useSettings((state) => state.enterKeyMode)
  // 能力开关来自当前服务类型的 spec：不支持的入口直接不渲染
  const kind = useApiConfig((state) => state.kind)
  const caps = getSpec(kind).caps
  /**
   * 文档附件入口是否可用（#480 §7 / **#538**）：`acceptsDocuments(kind)` —— 该渠道要么走
   * **文本注入**（anthropic / openai / ours），要么**确有可用的原生上传实现**（目前没有）。
   *
   * DeepSeek 两条都不满足：`textInjection: false`，而 `/v1/chat/completions/files` 早在 #360
   * 就确认不存在 —— 在那里挂一个「能选、选了也没用」的入口，用户只传文档不写字就会发出
   * 一条 **content 为空**的消息（#538）。所以这里**不给假承诺**：入口渲染成既有禁用态
   * （`styles.unavailableEntry` + `aria-disabled`），点下去 / 拖进来都走既有的 toast 提示
   * （`attachChannelUnsupported`，文案里带原因）。**选择逻辑完全复用原有入口**
   * （`AttachmentPicker` + 隐藏 `input[type=file]` + `ACCEPT` 过滤），本单没有另起一套。
   */
  const canAttachDocs = acceptsDocuments(kind)
  /**
   * 官方渠道的**精简工具栏**（#813）：`kind === 'deepseek'` 时输入框右侧只留最右边的文件上传
   * （回形针 `attach-image`）与发送 / 停止，**语音输入**与**文档上传**（含「不可用」占位那一支）
   * 彻底不渲染 —— 不是渲成禁用态，是 DOM 里压根没有节点。
   *
   * 为什么单开一个派生值而不是改 `caps.asr` / `acceptsDocuments()`：那两个是**能力声明**，
   * 设置页、发送门禁、朗读链路都在读它们，把它们按渠道改掉会连带影响别处；
   * 这里改的只是「这个渠道的输入区摆几个按钮」这一个展示决策。
   *
   * 其它渠道（`anthropic` / `openai` / `ours`）保持原样：三家 `caps.asr` 本来就是 false，
   * 文档入口照旧按 `canAttachDocs` 渲染真入口。
   */
  const compactToolbar = kind === 'deepseek'
  /**
   * 图片附件入口是否真的可用（#552）：判定**只查那一张渠道能力表**
   * （`providerCapability.ts` 的 `image` 维度，`supportsImage()` / `visionFor()`），
   * 不再自己拼 `caps.vision && paths.files`：
   *
   * - `image.base64`（anthropic / openai / ours）：本地编码内联，**不需要任何端点**；
   * - `image.nativeFile`（deepseek）：走 Files API，还要它**显式声明了 `paths.files`**
   *   （`supportsFileUpload()`）—— 只有 `nativeFile` 是不够的，以前就是拿 messages 前缀拼出
   *   `/v1/chat/completions/files` 去试，网关没有这条路由，线上 86% 的日志是它的 404（#303）。
   *
   * `caps.vision` 仍然是与门（UI 侧的开关语义）；不满足时入口**照常渲染**，点下去给可读提示，
   * 不静默失败（#37 / #43 的诉求）。
   */
  const imageTransport = visionFor(kind)
  const canAttach =
    caps.vision && supportsImage(kind) && (imageTransport.base64 || supportsFileUpload())
  /**
   * 入口不可用时说清是哪一种「不可用」（#552）：渠道压根没有图片能力时用
   * `visionUnsupported`（«换渠道/换模型» 是唯一出路），渠道声称有 vision 但没有可用的
   * 发图通路时用 `uploadChannelUnsupported`（#303 / #360 那一类）。
   */
  const attachDenied = supportsImage(kind) ? 'uploadChannelUnsupported' : 'visionUnsupported'
  /**
   * base64 渠道只收图片（文档走 #480 的文本注入，有独立的文档入口）：
   * 选择框也照此过滤，免得用户选了一个只能得到「上传失败 404」的 csv/py。
   */
  const acceptUpload = imageTransport.base64 ? IMAGE_ACCEPT : ACCEPT
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  /**
   * 文档附件（#480 / #527）：`addFile → parse（后台，带进度） → 卡片`，状态机在 manager。
   * 数量上限取 `ATTACHMENT_LIMITS.maxFilesPerMessage`（超出逐条提示，不静默丢弃）。
   */
  const docDrafts = useAttachmentDrafts({
    maxFiles: ATTACHMENT_LIMITS.maxFilesPerMessage,
    restoreIds: documents.map((item) => item.id),
  })
  /**
   * 把「已就绪」的文档同步进草稿存储：`sendMessage()` 只读草稿，所以附件引用必须在发送前
   * 就落到 `drafts.documents` 上。解析中 / 失败 / 已取消的卡片留在输入区，但不进消息。
   */
  const readyDocs = docDrafts.attachments.filter(
    (view) => view.status === 'success' || view.status === 'partial'
  )
  const readyDocKey = readyDocs.map((view) => view.id).join('|')
  // readyDocs 每次渲染都是新数组，直接进依赖会无限触发同步；
  // 用 ref 持有最新值、依赖只落在 id 串上（lint 对 ref 访问不要求进依赖）。
  const readyDocsRef = useRef(readyDocs)
  readyDocsRef.current = readyDocs
  useEffect(() => {
    setDraftDocuments(
      sessionId,
      readyDocsRef.current.map((view) => ({
        id: view.id,
        name: view.filename,
        size: view.size,
        // MIME 只用于展示与去重指纹，文档的权威类型在 manager 的记录里
        mimeType: '',
      }))
    )
    // 依赖落在 id 串上：视图对象每次渲染都是新的，直接依赖数组会无限触发同步
  }, [readyDocKey, sessionId])

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0) {
      return
    }
    // 拖入 / 粘贴的文件按扩展名分流：文档走 manager（#480），其余仍走原来的上传链路。
    // 两条线各自「不合格就明说」，不互相吞掉（分成两批也不会把图片报成「不支持的文档类型」）。
    const docFiles = files.filter((file) =>
      (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(file.name))
    )
    const uploads = files.filter((file) => docFiles.indexOf(file) < 0)
    if (docFiles.length > 0) {
      if (canAttachDocs) {
        docDrafts.addFiles(docFiles)
      } else {
        showToast({ key: 'attachChannelUnsupported' })
      }
    }
    if (uploads.length === 0) {
      return
    }
    acceptUploadFiles(uploads)
  }

  const acceptUploadFiles = (files: File[]) => {
    if (!canAttach) {
      // 拖拽 / 粘贴进来的文件同样要说清为什么不收：静默忽略会让用户以为界面卡住
      showToast({ key: attachDenied })
      return
    }
    if (useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, getApiKey())
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, getApiKey())
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  /**
   * #813：官方渠道不渲染语音入口，**录音状态也得跟着收敛** —— `useVoiceInput` 是无条件调用的
   * （hook 不能在渠道分支里调），所以「切到官方渠道时正在录音 / 正在转写」这一支只能在这里兜：
   * 不 cancel 的话 `voice.status !== 'idle'` 会让发送按钮永远不放行，移动端还会留着
   * 「频谱盖住输入框」（`recording && isMobile`），用户既看不见输入框也发不出消息。
   *
   * 只取消**已经发生**的录音与转写：`useVoiceInput` 的麦克风权限只在 `toggle()` 里申请，
   * 按钮不渲染 = 没有人能按到它 = 不会弹权限框；频谱 / 隐藏输入框由下面的 `recording` 一起收敛。
   */
  useEffect(() => {
    if (compactToolbar) {
      cancelVoice()
    }
  }, [compactToolbar, cancelVoice])

  // 移动端录音时用频谱替代输入框内容（官方渠道没有语音入口，这一支同时失效）
  const recording = !compactToolbar && voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend =
    !importingHistory && !streaming && voice.status === 'idle' && draftReady && !docDrafts.busy

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    /**
     * #538 第二道防线（UI 侧，明说原因）：渠道能力在**附件添加时**就拦了一次（上面的
     * `canAttachDocs`），但草稿里的文档引用可能来自**另一个渠道**——用户在 OpenAI 渠道
     * 挂好文档后切到 DeepSeek，卡片还在、引用也还在。此时按键发送只会得到一条 content
     * 为空的消息，所以要在这里**明确报错并停下**，而不是静默丢弃附件或发出空消息。
     * 服务层还有一道同样的闸（`chat/store.ts` 的 `sendMessage`），绕过 UI 也挡得住。
     */
    if (getDraft(sessionId).documents.length > 0 && !canAttachDocs) {
      /**
       * #813：官方渠道的工具栏里**已经没有文档入口**（连「不可用」占位都不渲染），而草稿里的
       * 文档引用可能来自别的渠道 —— 只说一句「当前渠道不支持」会把用户卡在死局：发不出去，
       * 又看不出从哪儿把文档拿掉。所以这里换成一条**带出路**的提示：
       *   · 文案点名「草稿里还有几个文档、先移除再发」；
       *   · 提示条上给一个真的能点的「移除附件」动作，一键把这些引用清掉（清完就能发）。
       * 卡片本身的「移除附件」按钮也还在（`AttachmentList` 的 `onRemove` 不随工具栏精简），
       * 所以两条路都通；服务层 `chat/store.ts` 的同名 gate 不受影响。
       */
      const pending = docDrafts.attachments.map((view) => view.id)
      const blocked = getDraft(sessionId).documents.length
      showToast(
        { key: 'attachDraftChannelUnsupported', params: { count: blocked } },
        {
          action: {
            key: 'attachRemove',
            run: () => {
              for (const id of pending) {
                docDrafts.remove(id)
              }
              // 卡片可能已经不在（例如恢复失败），引用本身也要清掉，否则「移除」点完还是发不出去
              setDraftDocuments(sessionId, [])
            },
          },
        }
      )
      return
    }
    /**
     * 三道发送前门禁，字段不重叠：
     *  1. `ensureSendPrerequisites`（#793）：**身份**——未登录且没有一把能用的 Key 时才拦，
     *     toast 带「去选择渠道」按钮直达「服务 Tab → 模型来源」；
     *  2. `ensureApiKey`（#451 / #596）：有身份但 Key 缺 / 格式不对 / 不是服务端那把；
     *  3. `ensureSendConfig`（#490）：地址与模型填得对不对。
     * 顺序：先身份、再 Key、最后配置 —— 什么都没有时别拿「地址没填」把人引到别处。
     * 任一命中都**不发请求**：这里 return 之后不会再走到 `sendMessage`，请求数为 0。
     */
    if (!ensureSendPrerequisites() || !ensureApiKey() || !ensureSendConfig()) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!sendMessage(sessionId)) {
      return
    }
    // 引用已经挂到消息上（store 的 sendMessage 读的是草稿），输入区的卡片到此清空；
    // manager 里的记录不动 —— 消息还引用着它们，回收由删除消息 / 会话后的 sweep 负责。
    docDrafts.clear()
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      {/* 文档附件卡片：五态 + 解析进度 + 取消 / 重试 / 移除（只展示元信息，不展示正文） */}
      <AttachmentList
        attachments={docDrafts.attachments}
        variant="draft"
        className={styles.docAttachments}
        onCancel={docDrafts.cancel}
        onRetry={docDrafts.retry}
        onRemove={docDrafts.remove}
      />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          // 软键盘回车键文案跟档位走：换行档不能还写着「发送」
          enterKeyHint={enterKeyHintFor(enterKeyMode)}
          onKeyDown={(event) => {
            // 合成期（isComposing / keyCode 229）在 resolveEnterKeyAction 里一律判成换行，不发送
            const action = resolveEnterKeyAction(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              },
              enterKeyMode
            )
            if (action === 'send') {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          {/* 深度思考开关：入口恒常驻（#341），是否真生效见 data-thinking-effective；请求侧由 REQUEST_GATES 拦截 */}
          <ThinkingToggle
            caps={caps}
            thinking={thinking}
            onToggle={() => setThinking(!thinking)}
            label={t('thinkingSwitch')}
            tooltip={t('deactivatedThinkTooltip')}
            icon={<IconThinkOutline14 />}
            className={styles.toggle}
            selectedClassName={styles.selected}
            labelClassName={styles.toggleLabel}
            wrap={(content, children) => <Tooltip content={content}>{children}</Tooltip>}
          />
          {caps.search ? (
            <Tooltip content={t('deactivatedSearchTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, search && styles.selected)}
                aria-label={t('search')}
                aria-pressed={search}
                onClick={() => setSearch(!search)}
              >
                <IconGlobeLanguageOutline14 />
                <span className={styles.toggleLabel}>{t('search')}</span>
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className={styles.right}>
          {/* #813：官方渠道的精简工具栏里连语音入口都不渲染（`caps.asr` 本身不动，见 compactToolbar） */}
          {caps.asr && !compactToolbar ? (
            <VoiceButton
              status={voice.status}
              disabled={!voice.available}
              seconds={voice.seconds}
              onClick={() => {
                if (
                  voice.status !== 'idle' ||
                  (!useChatStore.getState().importingHistory && ensureApiKey())
                ) {
                  void voice.toggle()
                }
              }}
            />
          ) : null}
          {compactToolbar ? null : canAttachDocs ? (
            <AttachmentPicker
              onFiles={docDrafts.addFiles}
              disabled={importingHistory}
              icon={<IconDocumentOutline16 />}
              testId="attach-document"
            />
          ) : (
            /*
             * 渠道不支持文本注入时的「不可用」文档附件入口（#480 §7 / #538）。
             *
             * **#813 之后，官方渠道（`deepseek`）连这一支都不渲染**（`compactToolbar`）：
             * 官方渠道的右侧工具栏只留最右边的文件上传回形针。这个禁用态分支仍保留给
             * 「能力门关掉但不是官方渠道」的情形（今天的未知渠道 / 未来新增渠道），
             * 语义不变：它看得见、点下去给可读提示，但**不提供功能**。
             *
             * `data-attachment-entry="unavailable"` 是给门禁看的显式标记 ——
             * `mode-switch-plain` 数「输入区功能性按钮」时要把它排除，
             * 否则一句解释文案会混进按钮清单（`发送` 在空输入时也是 aria-disabled，
             * 所以不能笼统地按 aria-disabled 过滤，只能按这个标记排除）。
             *
             * `data-testid="attach-document"` 与可用分支**同名**是刻意的（#586）：两条分支是
             * 「同一件事的两种状态」，用例数「文档入口在不在」不该因为能力门开关而换选择器；
             * 「能不能用」由 `data-attachment-entry="unavailable"` / `aria-disabled` 判断。
             */
            <IconButton
              size="m"
              tone="primary"
              className={styles.unavailableEntry}
              icon={<IconDocumentOutline16 />}
              tooltip={t('attachChannelUnsupported')}
              aria-disabled="true"
              data-testid="attach-document"
              data-attachment-entry="unavailable"
              disabled={importingHistory}
              onClick={() => showToast({ key: 'attachChannelUnsupported' })}
            />
          )}
          {/*
           * 图片入口（#548 / #551 / #552）：与上面那个**文档**入口是两件事，所以各自带一个
           * 稳定的 `data-testid`。两家都长成图标按钮、文案里又都有「上传/附件」字样，
           * 用例按 `aria-label` 数节点会把这两个入口搅在一起（#586 的根因）。
           *
           * 注意**不要**给它加 `data-attachment-entry="unavailable"`：那个标记的语义是
           * 「这个入口不提供功能」，`mode-switch-plain` 靠它把解释性按钮排除出功能性按钮清单；
           * 图片入口即使当前渠道不可用，也仍然是一个真实入口（点下去给可读提示），
           * 与文档那条「能力门关掉就只剩解释」的语义不同。
           */}
          <IconButton
            size="m"
            tone="primary"
            className={clsx(!canAttach && styles.unavailableEntry)}
            data-testid="attach-image"
            icon={<IconPaperclipOutline16 />}
            tooltip={canAttach ? t('uploadFile') : t(attachDenied)}
            aria-disabled={canAttach ? undefined : 'true'}
            disabled={importingHistory}
            onClick={() => {
              if (!canAttach) {
                showToast({ key: attachDenied })
                return
              }
              if (ensureApiKey()) {
                fileInputRef.current?.click()
              }
            }}
          />
          {canAttach ? (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={acceptUpload}
              onChange={(event) => {
                acceptFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
          ) : null}
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
