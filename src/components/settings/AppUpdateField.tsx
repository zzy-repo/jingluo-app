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
  loadManifest,
  parseManifest,
  releaseUrl,
  selectUpdate,
  type UpdateChannel,
  type UpdateRelease,
} from '../../services/updateManifest.js'
import styles from './Settings.module.css'

const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
/** Update operations are isolated from history, API settings and feedback transport. */
export const AppUpdateField = () => {
  const [opened, setOpened] = useState(false)
  const [channel, setChannel] = useState<UpdateChannel>(
    /-/.test(bundledApp().version) ? 'prerelease' : 'stable'
  )
  const [release, setRelease] = useState<UpdateRelease>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState<{ received: number; total: number }>()
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
  const checking = useRef(false)
  const check = async () => {
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
    setMessage('正在检查更新…')
    try {
      const current = native ? await nativeUpdate.installed() : bundledApp()
      const variant = native ? current.artifactVariant : currentVariant()
      if (variant !== 'internal' && variant !== 'standard') {
        throw new Error('当前安装包渠道信息缺失')
      }
      const rows = native
        ? parseManifest(JSON.parse((await nativeUpdate.manifest()).body))
        : await loadManifest(controller.signal)
      const result = selectUpdate(rows, current.versionCode, variant, channel)
      if (controller.signal.aborted) {
        return
      }
      setRelease(result.release)
      setMessage(
        result.release
          ? '发现新版本，确认后再下载。'
          : result.incomplete
            ? '部分发布记录缺少渠道或 SHA256，暂不作为更新目标。'
            : '当前已是所选渠道最新版本。'
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(
          error instanceof Error && error.message === '当前安装包渠道信息缺失'
            ? error.message
            : '检查更新失败，请稍后重试。'
        )
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
    setProgress({ received: 0, total: release.size })
    setMessage('正在下载…')
    try {
      const result = await downloadUpdate(release, controller.signal, setProgress)
      if (!controller.signal.aborted) {
        setReady(true)
        setMessage(result.cached ? '已复用并校验缓存，点击安装。' : '下载及校验完成，点击安装。')
      }
    } catch {
      if (mounted.current) {
        setMessage(
          controller.signal.aborted ? '已取消下载，可重新下载。' : '下载或校验失败，请重试。'
        )
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
    } catch {
      if (mounted.current) {
        setReady(false)
        setMessage('安装未完成，请重新下载校验后重试。')
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
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
                  <a href={releaseUrl(release.file)} target="_blank" rel="noreferrer">
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
                setChannel(event.target.value as UpdateChannel)
                setRelease(undefined)
                setReady(false)
                setMessage('渠道已切换，请重新检查。')
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
        </Modal>
      ) : null}
    </>
  )
}
