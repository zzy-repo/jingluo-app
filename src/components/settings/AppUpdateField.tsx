import { useEffect, useRef, useState } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  bundledApp,
  currentVariant,
  downloadUpdate,
  isAndroidUpdate,
  nativeUpdate,
} from '../../services/appUpdate.js'
import {
  fetchManifest,
  parseManifest,
  releaseUrl,
  selectUpdate,
  DEFAULT_RELEASE_BASE,
  type UpdateChannel,
  type UpdateRelease,
} from '../../services/updateManifest.js'
import {
  classifyUpdateError,
  describeUpdateFailure,
  describeUpToDate,
  type UpdateFailureView,
} from '../../services/updateFailure.js'
import { recordError, recordEvent } from '../../services/diagnostics/collector.js'
import { buildMeta, type Stage } from '../../services/diagnostics/fields.js'
import { bytesPerSecond, createStageTimer } from '../../services/diagnostics/timing.js'
import { copyText } from '../../utils/clipboard.js'
import { buildUpdateReport, hostOf, releaseHosts } from '../../services/updateReport.js'
import dialogStyles from './AppUpdateField.module.css'
import styles from './Settings.module.css'

const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** 渠道的中文名：#310 之后失败文案里会写清「哪个渠道」，所以只写一次 */
const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  stable: '稳定版',
  prerelease: '稳定版与预发布版',
}

/** 最近检查时间：只到秒（用户在截图里对得上就够了） */
const clockText = (at: number | undefined): string => {
  if (at === undefined) {
    return '尚未检查'
  }
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? '尚未检查'
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
        date.getSeconds()
      ).padStart(2, '0')}`
}

/** Update operations are isolated from history, API settings and feedback transport. */
export const AppUpdateField = () => {
  const [opened, setOpened] = useState(false)
  const [channel, setChannel] = useState<UpdateChannel>(
    /-/.test(bundledApp().version) ? 'prerelease' : 'stable'
  )
  const [release, setRelease] = useState<UpdateRelease>()
  /** 本次清单实际生效的分发机：相对 file 必须拼在它上面（回退到旧机后别拼新机域名）。 */
  const [base, setBase] = useState<string>(DEFAULT_RELEASE_BASE)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState<{ received: number; total: number }>()
  /** 最近一次检查 / 下载 / 安装的结论（#310）：界面文案与「复制诊断信息」共用同一份 */
  const [outcome, setOutcome] = useState<UpdateFailureView>()
  const [checkedAt, setCheckedAt] = useState<number>()
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  /** 下载进度也要给失败文案用：state 在一次下载里是旧值，这里留一份最新的 */
  const progressRef = useRef<{ received: number; total: number }>()
  const operation = useRef<AbortController>()
  const mounted = useRef(true)
  const native = isAndroidUpdate()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current?.abort()
    }
  }, [])
  const close = () => {
    operation.current?.abort()
    setOpened(false)
  }
  /**
   * 异常 → 界面文案（#310）：分类在 services/updateFailure.ts，这里只负责把结果写到界面上，
   * 同一份 `UpdateFailureView` 既给状态行，也给「复制诊断信息」。
   */
  const showFailure = (error: unknown, activeChannel: UpdateChannel, version: string) => {
    const view = describeUpdateFailure(classifyUpdateError(error), {
      channel: CHANNEL_LABEL[activeChannel],
      version,
    })
    setOutcome(view)
    setMessage(view.text)
    return view
  }
  const checking = useRef(false)
  const check = async (nextChannel?: UpdateChannel) => {
    // 切渠道后自动重查（issue #310 验收）：这时 state 里的 channel 还是旧值，必须用入参
    const activeChannel = nextChannel ?? channel
    if (checking.current) {
      return
    }
    checking.current = true
    if (operation.current && !operation.current.signal.aborted) {
      operation.current.abort()
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setRelease(undefined)
    setReady(false)
    setProgress(undefined)
    setOutcome(undefined)
    setCopyState('idle')
    setCheckedAt(Date.now())
    setMessage('正在检查更新…')
    const startedAt = Date.now()
    const timer = createStageTimer()
    /** 更新检查的每一步都留一条带耗时的日志（#306）：哪一步慢，不用再靠体感描述 */
    const phase = (stage: Stage) =>
      recordEvent('nav', `update: ${stage}`, {
        ...buildMeta({
          flow: 'update',
          stage,
          attempt: 1,
          status: 'ok',
          endpointKey: 'other',
          durationMs: timer.lap(),
        }),
        source: activeChannel,
        native,
      })
    try {
      const current = native ? await nativeUpdate.installed() : bundledApp()
      const variant = native ? current.artifactVariant : currentVariant()
      if (variant !== 'internal' && variant !== 'standard') {
        throw new Error('VARIANT_MISSING')
      }
      const version = current.version || bundledApp().version
      phase('update.check.installed')
      // 原生侧返回「真的回了清单」的 base；网页预览走同一条回退顺序。
      let rows: UpdateRelease[]
      let effectiveBase: string = DEFAULT_RELEASE_BASE
      if (native) {
        const manifest = await nativeUpdate.manifest()
        rows = parseManifest(JSON.parse(manifest.body))
        effectiveBase = manifest.base || DEFAULT_RELEASE_BASE
      } else {
        const manifest = await fetchManifest(controller.signal)
        rows = manifest.rows
        effectiveBase = manifest.base
      }
      phase('update.check.manifest')
      const result = selectUpdate(rows, current.versionCode, variant, activeChannel)
      if (controller.signal.aborted) {
        return
      }
      recordEvent('nav', 'update: update.check.select', {
        ...buildMeta({
          flow: 'update',
          stage: 'update.check.select',
          attempt: 1,
          status: 'ok',
          endpointKey: 'other',
          durationMs: Date.now() - startedAt,
        }),
        source: activeChannel,
        result: result.release ? 'update-available' : 'up-to-date',
      })
      setRelease(result.release)
      setBase(effectiveBase)
      if (result.release) {
        setMessage('发现新版本，确认后再下载。')
      } else {
        // 无新版也要说清「哪个渠道、当前版本、为什么没有可装的记录」（#310 验收第 5 条）
        const view = describeUpToDate({
          channel: CHANNEL_LABEL[activeChannel],
          version,
          incomplete: result.incomplete,
        })
        setOutcome(view)
        setMessage(view.text)
      }
    } catch (error) {
      // 取消不算失败（用户自己点的），只有真异常才进 error 级
      if (!controller.signal.aborted) {
        recordError(
          'update check failed',
          {
            ...buildMeta({
              flow: 'update',
              stage: 'update.check.manifest',
              attempt: 1,
              status: 'error',
              endpointKey: 'other',
              durationMs: Date.now() - startedAt,
            }),
            source: activeChannel,
            native,
            upstreamCode: classifyUpdateError(error).code,
          },
          error
        )
        showFailure(error, activeChannel, bundledApp().version)
      }
    } finally {
      checking.current = false
      if (mounted.current && operation.current === controller) {
        setBusy(false)
      }
    }
  }
  const download = async () => {
    if (!release || busy) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    progressRef.current = { received: 0, total: release.size }
    setProgress({ received: 0, total: release.size })
    setOutcome(undefined)
    setMessage('正在下载…')
    try {
      const startedAt = Date.now()
      const result = await downloadUpdate(
        release,
        controller.signal,
        (event) => {
          progressRef.current = event
          setProgress(event)
        },
        nativeUpdate,
        base
      )
      const duration = Date.now() - startedAt
      recordEvent('nav', 'update: update.download', {
        ...buildMeta({
          flow: 'update',
          stage: 'update.download',
          attempt: 1,
          status: 'ok',
          endpointKey: 'other',
          durationMs: duration,
          totalBytes: release.size,
          // 命中本地缓存 = 没真下载（fromCache 才是「为什么这么快」的答案）
          fromCache: result.cached,
          speedBps: result.cached ? undefined : bytesPerSecond(release.size, duration),
        }),
        source: channel,
        native,
      })
      if (!controller.signal.aborted) {
        setReady(true)
        setMessage(result.cached ? '已复用并校验缓存，点击安装。' : '下载及校验完成，点击安装。')
      }
    } catch (error) {
      if (mounted.current) {
        if (controller.signal.aborted) {
          setOutcome(undefined)
          setMessage('已取消下载，可重新下载。')
        } else {
          // 下载 / 校验失败也要说清是哪一类（#310）：签名不符与断流对用户意味着不同的下一步
          const view = showFailure(error, channel, release.version)
          const partial = progressRef.current?.received
          if (partial !== undefined && partial > 0 && view.kind === 'download') {
            setMessage(
              `${view.text}（已下载 ${sizeText(partial)} / ${sizeText(progressRef.current?.total ?? release.size)}）`
            )
          }
        }
      }
    } finally {
      if (mounted.current && operation.current === controller) {
        setBusy(false)
      }
    }
  }
  const install = async () => {
    if (!release?.sha256 || busy) {
      return
    }
    setBusy(true)
    try {
      const result = await nativeUpdate.install({
        sha256: release.sha256,
        size: release.size,
        versionCode: release.versionCode,
      })
      if (mounted.current) {
        setMessage(
          result.status === 'permission-required'
            ? '请允许此应用安装更新；返回后再次点击安装。未允许可稍后重试。'
            : '已打开系统安装界面；取消或失败后可再次点击安装。安装结果以系统提示为准。'
        )
      }
    } catch (error) {
      if (mounted.current) {
        setReady(false)
        showFailure(error, channel, release.version)
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  const copyReport = async () => {
    const ok = await copyText(
      buildUpdateReport({
        version: bundledApp().version,
        versionCode: bundledApp().versionCode,
        channel: CHANNEL_LABEL[channel],
        native,
        checkedAt,
        outcome: outcome?.text,
        code: outcome?.code,
        base,
      })
    )
    setCopyState(ok ? 'done' : 'failed')
  }
  return (
    <>
      <div className={styles.cell}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>应用更新</div>
            <div>当前版本 {bundledApp().version}</div>
          </div>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              setOpened(true)
              void check()
            }}
          >
            检查更新
          </Button>
        </div>
      </div>
      {opened ? (
        <Modal
          title="检查更新"
          closable
          className={dialogStyles.dialog}
          mainClassName={dialogStyles.main}
          onClose={close}
          footer={
            <>
              {busy ? (
                <Button variant="outlined" onClick={() => operation.current?.abort()}>
                  取消
                </Button>
              ) : (
                <Button variant="outlined" onClick={() => void check()}>
                  重新检查
                </Button>
              )}
              {release && !busy ? (
                native ? (
                  <Button onClick={() => void (ready ? install() : download())}>
                    {ready ? '安装更新' : '确认下载'}
                  </Button>
                ) : (
                  <a href={releaseUrl(release.file, base)} target="_blank" rel="noreferrer">
                    下载 APK
                  </a>
                )
              ) : null}
            </>
          }
        >
          <label>
            更新渠道{' '}
            <select
              value={channel}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as UpdateChannel
                setChannel(next)
                setRelease(undefined)
                setReady(false)
                // 切渠道后自动重查（#310 验收）：不再让用户再点一次「检查更新」
                void check(next)
              }}
            >
              <option value="stable">稳定版</option>
              <option value="prerelease">稳定版与预发布版</option>
            </select>
          </label>
          <p role="status" aria-live="polite">
            {message}
          </p>
          {release ? (
            <>
              <h3>{release.version}</h3>
              <p>{sizeText(release.size)}</p>
              <ul>
                {release.changes.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
              {native ? (
                <p>同包名、同签名覆盖安装保留聊天及设置；由系统确认安装。</p>
              ) : (
                <p>下载 APK 后请在 Android 设备上手动安装。</p>
              )}
              <p className={dialogStyles.endNote}>以上为本次更新的全部内容</p>
            </>
          ) : null}
          {progress ? (
            <>
              <progress aria-label="APK 下载进度" max={progress.total} value={progress.received} />
              <p>
                {sizeText(progress.received)} / {sizeText(progress.total)}
              </p>
            </>
          ) : null}
          {/*
           * 诊断区（#310）：失败时用户说不出任何有效信息，反馈单只能一轮往返。
           * 这里只放「用户本来就知道、且截图里能对得上」的事实：版本、渠道、更新服务、最近检查时间。
           * 地址只到 host（首选项 → 回退项），不含路径与 query。
           */}
          <div className={dialogStyles.diagnostics} data-testid="update-diagnostics">
            <dl className={dialogStyles.facts}>
              <div>
                <dt>当前版本</dt>
                <dd>
                  {bundledApp().version}
                  {bundledApp().versionCode > 0 ? `（${bundledApp().versionCode}）` : ''}
                </dd>
              </div>
              <div>
                <dt>更新渠道</dt>
                <dd>{CHANNEL_LABEL[channel]}</dd>
              </div>
              <div>
                <dt>更新服务</dt>
                <dd>{releaseHosts()}</dd>
              </div>
              {base !== DEFAULT_RELEASE_BASE ? (
                <div>
                  <dt>本次生效</dt>
                  <dd>{hostOf(base)}（已回退备用分发机）</dd>
                </div>
              ) : null}
              <div>
                <dt>最近检查</dt>
                <dd>{clockText(checkedAt)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className={dialogStyles.copyButton}
              data-testid="update-diagnostics-copy"
              onClick={() => void copyReport()}
            >
              {copyState === 'done'
                ? '已复制诊断信息'
                : copyState === 'failed'
                  ? '复制失败，请长按选择'
                  : '复制诊断信息'}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
