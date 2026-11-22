/**
 * #831「分支会话」确认弹层：两种分支共用，区别只有一句确认文案。
 *
 *  - **完整分支**（列表「更多」→「从此会话分支」）：整条会话复制成新会话，确认行写「N 条消息」；
 *  - **节点分支**（回放下方 →「从此消息分支」）：**创建前**必须让用户看到
 *    「将从第 N 条消息处分支，之后的 M 条不会带入」（票面第 2 条），N / M 由
 *    `sessionBranch.ts::branchPointOf()` 算，界面不自己数。
 *
 * 两件事都在这里当场做完：默认名 `<原标题>（分支）` 预填在输入框里（可当场改，票面第 3 条），
 * 创建成功就直接切到新会话（`createSessionBranch()` 内部落库并设 activeId）。
 */
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createSessionBranch,
  previewSessionBranch,
  useChatStore,
} from '../../services/chat/store.js'
import { branchTitle, type BranchPoint } from '../../services/chat/sessionBranch.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import styles from './SessionBranch.module.css'
import {
  closeSessionBranchDialog,
  useSessionBranchDialog,
  type SessionBranchDialogRequest,
} from './sessionBranchState.js'

const keyOf = (request: SessionBranchDialogRequest) =>
  `${request.sessionId}:${request.messageId === undefined ? '' : request.messageId}`

/** 弹层本体：按请求的 key 重新挂载，默认标题 / 分叉点都按这次请求重新算 */
const SessionBranchDialogBody = ({ request }: { request: SessionBranchDialogRequest }) => {
  const t = useTranslate()
  const source = useChatStore((state) =>
    state.sessions.find((session) => session.id === request.sessionId)
  )
  const baseTitle = source === undefined || source.title.trim() === '' ? t('untitledChat') : source.title
  const [title, setTitle] = useState(() => branchTitle(baseTitle, t('sessionBranchTitleSuffix')))
  const [point, setPoint] = useState<BranchPoint | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    // 预览只是「算分叉点」：会话详情可能还没加载，previewSessionBranch 自己会等它
    void previewSessionBranch(request).then(
      (result) => {
        if (!cancelled) {
          setPoint(result)
          setLoaded(true)
        }
      },
      () => {
        if (!cancelled) {
          setPoint(null)
          setLoaded(true)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [request])

  const node = request.messageId !== undefined
  const submit = async () => {
    if (pending) {
      return
    }
    setPending(true)
    const name = title.trim() === '' ? branchTitle(baseTitle, t('sessionBranchTitleSuffix')) : title.trim()
    const id = await createSessionBranch({ ...request, title: name })
    setPending(false)
    if (id === null) {
      showToast({ key: 'sessionBranchCreateFailed', type: 'error' })
      return
    }
    closeSessionBranchDialog()
    closeMobileSider()
  }

  return (
    <Modal
      title={t('sessionBranchDialogTitle')}
      onClose={() => {
        if (!pending) {
          closeSessionBranchDialog()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={pending} onClick={closeSessionBranchDialog}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={pending || !loaded || point === null}
            data-testid="session-branch-create"
            onClick={() => void submit()}
          >
            {t('sessionBranchCreate')}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody} data-testid="session-branch-dialog">
        {!loaded ? (
          <p className={styles.confirm} data-testid="session-branch-confirm-loading">
            {t('sessionLoading')}
          </p>
        ) : point === null ? (
          // 分叉点算不出来（消息已被删 / 数据损坏）：说清事实并让用户只能取消，不瞎猜位置
          <p className={styles.confirm} data-testid="session-branch-unavailable">
            {t('sessionBranchCreateFailed')}
          </p>
        ) : (
          <p className={styles.confirm} data-testid="session-branch-confirm">
            {node
              ? t('sessionBranchConfirmNode', { kept: point.kept, dropped: point.dropped })
              : t('sessionBranchConfirmFull', { count: point.kept })}
          </p>
        )}
        <p className={styles.note}>{t('sessionBranchAttachmentsNote')}</p>
        <label className={styles.fieldLabel} htmlFor="session-branch-name">
          {t('sessionBranchNameLabel')}
        </label>
        <input
          id="session-branch-name"
          className={styles.nameInput}
          data-testid="session-branch-name-input"
          value={title}
          disabled={pending}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void submit()
            }
          }}
        />
      </div>
    </Modal>
  )
}

/** 挂在 `App` 上：没有请求时什么都不渲染（不占 DOM、不跑副作用） */
export const SessionBranchDialog = () => {
  const request = useSessionBranchDialog((state) => state.request)
  if (request === null) {
    return null
  }
  return <SessionBranchDialogBody key={keyOf(request)} request={request} />
}
