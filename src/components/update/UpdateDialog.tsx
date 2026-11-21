import { useEffect, useRef } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useTranslate } from '../../i18n/index.js'
import type { UpdatePolicyMode, ResolvedUpdatePolicy } from '../../services/updatePolicy.js'
import type { UpdateRelease } from '../../services/updateManifest.js'
import styles from './UpdateDialog.module.css'

/** 与清单同源的大小展示（1 位小数 MB）：弹窗与设置里的结果面板必须一致，别一处 5.2 MB 一处 5452595 B */
const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * 发布时间展示：把清单里的 ISO 串收成「YYYY-MM-DD HH:mm」（设备本地时区）。
 *
 * 清单写的是 `2026-11-20T10:00:00+08:00`，原样端给用户既长又难读；但**解析不了就原样显示**，
 * 不猜、不补时区 —— 时间读错会让用户拿它判断「这次更新是不是我要的」。
 */
const publishedText = (value: string): string => {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) {
    return value
  }
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(
    at.getMinutes()
  )}`
}

/** 历史记录里我们压的那一条（返回键守卫用）。只带一个标记，不带任何用户数据。 */
const BACK_GUARD_STATE = { updateDialogGuard: true }

/**
 * 标题按档位分三种口径。
 * 放在这里而不是写进三处 JSX：标题与底部按钮是「同一句话的两个位置」，分开写迟早一边改了另一边没改。
 */
const TITLE_KEY = {
  normal: 'updateDialogTitleNormal',
  soft: 'updateDialogTitleSoft',
  forced: 'updateDialogTitleForced',
} as const

export interface UpdateDialogProps {
  /** 本次检查选中的那条记录（版本号 / 更新说明 / 包大小 / 发布时间都从它来） */
  release: UpdateRelease
  /** 本机已装版本号（「当前版本」那一格） */
  currentVersion: string
  /** 判定结果（`resolveUpdatePolicy` 的输出；这里只读 mode 与文案字段） */
  policy: ResolvedUpdatePolicy
  /**
   * 主按钮：文案与动作由调用方给（`确认下载` / `安装更新` / `下载 APK`）。
   *
   * 为什么不让弹窗自己写「立即更新」：下载 / 安装 / 网页降级这一整套状态机已经在
   * `AppUpdateField` 里（#373 的进度终态、#310 的失败分类都长在那上面），弹窗只做**策略通知层**，
   * 动作一律复用那条链路 —— 抄一份按钮与状态进来，等于让 #373 那个 bug 有第二个发作点。
   */
  primary: { label: string; href?: string; onClick?: () => void }
  /** 正在下载：底部换成「取消」（与设置面板同一条中止链路） */
  busy?: boolean
  onCancel?: () => void
  /** 状态行（下载进度文案 / 失败原因 / 安装提示）：与设置面板共用同一份 `message` */
  message?: string
  progress?: { received: number; total: number }
  /** soft 独有的「稍后提醒」：写 snooze 后关闭 */
  onSnooze: () => void
  /** normal 的关闭（不写 snooze） */
  onClose: () => void
}

/**
 * 更新弹窗（Issue #517）。
 *
 * 三类行为（判定在 `services/updatePolicy.ts`，这里只负责「按判定结果渲染 + 拦关闭」）：
 *
 * | 档位 | 关闭入口 | 底部按钮 | 返回键 |
 * | --- | --- | --- | --- |
 * | `forced` | **全部失效**（不渲染 X、点遮罩无效、Esc 无效、返回键被吞） | 下载 / 安装 | 无效 |
 * | `soft` | X / Esc / 遮罩 / 返回键 = **稍后提醒**（写 snooze） | 稍后提醒 + 下载 | = 稍后提醒 |
 * | `normal` | X / Esc / 遮罩 / 返回键 = 关闭（不写 snooze） | 关闭 + 下载 | = 关闭 |
 *
 * 复用 `components/base/Modal`：遮罩、居中、Esc 栈、点外部、可视视口高度、深浅色底全归它管，
 * 这里只补三件它没有的事：① 结构化展示；② forced 的「关不掉」；③ 返回键。
 *
 * 为什么返回键要在这一层做：Android 的硬件返回在 Capacitor 里最终落到 `WebView.goBack()`
 * （就是浏览器 back），所以「按返回键不许关弹窗」只能靠 `popstate` 拦。做法是弹窗打开时先
 * **压一条同文档历史记录**，返回键就先落到我们这里：forced 直接吞掉（再压一条），其余档位当成关闭。
 */
export const UpdateDialog = ({
  release,
  currentVersion,
  policy,
  primary,
  busy = false,
  onCancel,
  message,
  progress,
  onSnooze,
  onClose,
}: UpdateDialogProps) => {
  const t = useTranslate()
  const mode: UpdatePolicyMode = policy.mode
  const forced = mode === 'forced'
  const soft = mode === 'soft'
  /** 关闭意图：forced 没有（Esc / X / 返回键都无效），soft = 稍后提醒，normal = 关闭 */
  const dismiss = forced ? undefined : soft ? onSnooze : onClose
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  /** 主按钮始终在（forced 也必须有出口：不能把用户困在一个点不动的界面上） */
  const primaryNode =
    primary.href === undefined ? (
      <Button data-testid="update-dialog-primary" onClick={primary.onClick}>
        {primary.label}
      </Button>
    ) : (
      /* 网页预览：与设置面板一致，降级成下载链接（原生下载在这里根本不存在） */
      <a
        className={styles.linkButton}
        data-testid="update-dialog-primary"
        href={primary.href}
        target="_blank"
        rel="noreferrer"
      >
        {primary.label}
      </a>
    )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof history === 'undefined') {
      return
    }
    /** 吞掉一次返回：重新压一条同文档记录，用户还停在弹窗上 */
    const swallow = () => {
      try {
        history.pushState(BACK_GUARD_STATE, '')
      } catch {
        // 隐私模式 / 历史栈被限制：吞不掉就吞不掉，界面照旧（返回键拦截不许把页面搞崩）
      }
    }
    let guard = true
    swallow()
    const onPopState = () => {
      if (forced) {
        // forced：返回键无效（#517 的硬要求）。只补一条记录，不触发任何关闭动作。
        swallow()
        return
      }
      guard = false
      dismissRef.current?.()
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      // 我们压的那条还在栈顶就退掉：否则用户关了弹窗后第一次按返回会「没反应」
      if (guard) {
        try {
          history.back()
        } catch {
          // 退不掉最多多一条历史记录，不影响功能
        }
      }
    }
  }, [forced])

  return (
    <Modal
      title={t(TITLE_KEY[mode])}
      /* forced：连关闭按钮都不渲染；点遮罩由 dismissDisabled 挡掉；Esc 交给下面的空 onClose 吸收 */
      closable={!forced}
      dismissDisabled={forced}
      onClose={dismiss ?? (() => {})}
      className={styles.dialog}
      mainClassName={styles.main}
      footer={
        <>
          {busy && onCancel ? (
            <Button variant="outlined" data-testid="update-dialog-cancel" onClick={onCancel}>
              {t('updateDialogCancel')}
            </Button>
          ) : null}
          {!busy && soft ? (
            <Button variant="outlined" data-testid="update-dialog-snooze" onClick={onSnooze}>
              {t('updateDialogSnooze')}
            </Button>
          ) : null}
          {!busy && mode === 'normal' ? (
            <Button variant="outlined" data-testid="update-dialog-close" onClick={onClose}>
              {t('updateDialogClose')}
            </Button>
          ) : null}
          {primaryNode}
        </>
      }
    >
      <div className={styles.body} data-testid="update-dialog" data-update-mode={mode}>
        {forced ? (
          <p className={styles.notice} data-testid="update-dialog-notice">
            {/*
             * 两句话分工不同：被「最低支持版本」顶成强制时，用户需要知道为什么是这条线
             * （我的版本落后了），所以带上两头的版本号；服务端只是标了 mode:"forced" 时，
             * 报版本号没有任何信息量，说清「必须更新」就够了。
             */}
            {policy.basis === 'below-minimum'
              ? t('updateDialogBelowMinimumNotice', {
                  current: currentVersion,
                  version: release.version,
                })
              : t('updateDialogForcedNotice')}
          </p>
        ) : null}
        {soft ? (
          <p className={styles.notice} data-testid="update-dialog-notice">
            {t('updateDialogSoftNotice', { hours: policy.snoozeHours })}
          </p>
        ) : null}
        {forced && policy.reason ? (
          <p className={styles.reason} data-testid="update-dialog-reason">
            {t('updateDialogForcedReason', { reason: policy.reason })}
          </p>
        ) : null}
        {/* h3 里只放版本号：与设置面板那条标题同形，界面/用例都按「版本号」认它 */}
        <h3 className={styles.version}>{release.version}</h3>
        <dl className={styles.facts}>
          <div>
            <dt>{t('updateDialogLabelCurrent')}</dt>
            <dd data-testid="update-dialog-current">{currentVersion}</dd>
          </div>
          <div>
            <dt>{t('updateDialogLabelSize')}</dt>
            <dd data-testid="update-dialog-size">{sizeText(release.size)}</dd>
          </div>
          <div>
            <dt>{t('updateDialogLabelPublishedAt')}</dt>
            <dd data-testid="update-dialog-published">
              {release.releasedAt === undefined
                ? t('updateDialogPublishedUnknown')
                : publishedText(release.releasedAt)}
            </dd>
          </div>
        </dl>
        <p className={styles.changesTitle}>{t('updateDialogChangesTitle')}</p>
        <ul className={styles.changes} data-testid="update-dialog-changes">
          {release.changes.map((change, index) => (
            <li key={index}>{change}</li>
          ))}
        </ul>
        {progress ? (
          <>
            <progress
              className={styles.progress}
              aria-label="APK 下载进度"
              max={progress.total}
              value={progress.received}
            />
            <p className={styles.progressText} data-testid="update-dialog-progress">
              {sizeText(progress.received)} / {sizeText(progress.total)}
            </p>
          </>
        ) : null}
        {message ? (
          <p className={styles.status} data-testid="update-dialog-status">
            {message}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
