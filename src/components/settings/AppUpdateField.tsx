import { registerPlugin } from '@capacitor/core'
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
  manualDownloadTarget,
  readManifestSnapshot,
  readUpdateChannel,
  releaseUrl,
  saveManifestSnapshot,
  saveUpdateChannel,
  selectUpdate,
  DEFAULT_RELEASE_BASE,
  type ArtifactVariant,
  type ManifestSnapshot,
  type UpdateChannel,
  type UpdateRelease,
} from '../../services/updateManifest.js'
import { useTranslate } from '../../i18n/index.js'
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
import { setUpdateSnoozeUntil, useSettings } from '../../services/settings.js'
import {
  resolveUpdatePolicy,
  resolveUpdatePrompt,
  snoozeDeadline,
  type ResolvedUpdatePolicy,
} from '../../services/updatePolicy.js'
import { UpdateDialog } from '../update/UpdateDialog.js'
import { buildUpdateReport, hostOf, primaryReleaseHost } from '../../services/updateReport.js'
import dialogStyles from './AppUpdateField.module.css'
import styles from './Settings.module.css'

const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * 渠道名（双语对）：#310 之后失败文案里会写清「哪个渠道」，所以只写一次；
 * #373 起文案分 zh/en，渠道名不能只有中文，否则英文句子里会嵌一段中文。
 */
const CHANNEL_LABEL: Record<UpdateChannel, { zh: string; en: string }> = {
  stable: { zh: '稳定版', en: 'Stable' },
  prerelease: { zh: '稳定版与预发布版', en: 'Stable + pre-release' },
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

/**
 * 「上次成功时间」（Issue #412）：带日期，因为缓存可能来自好几天前 ——
 * 只给 `19:05:16` 会让用户以为是今天拉到的。当天只给时分会更短，但**短不等于准**，
 * 缓存标注的第一原则是「别让用户误以为这是刚拿到的」。
 */
const snapshotText = (at: number): string => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 失败兜底里最多列几条：够让用户认出「上次看到过哪个版本」，也不至于把弹窗撑爆 */
const CACHE_PREVIEW_ROWS = 5

/**
 * 原生侧「App 内嵌浏览器」：与 #331 的「前往购买」同一个插件（`@capacitor/browser`）。
 *
 * 这里刻意**不** `import('@capacitor/browser')`：那个包的 web 实现 `extends WebPlugin`，
 * 会把 `WebPlugin` 这个 `@capacitor/core` 导出拉进打包图 —— 而域10 / #373 的 harness 用
 * `tests/fixtures/<域>/capacitor-mock.ts` 顶替 `@capacitor/core`（只有 Capacitor / registerPlugin /
 * CapacitorHttp 三个导出），一旦进图就是构建期 `export 'WebPlugin' was not found`，整批集成用例红。
 *
 * `registerPlugin('Browser')` 与官方 wrapper 内部做的事完全一样（Android 侧
 * `android/capacitor.settings.gradle` 已 include `:capacitor-browser`，原生插件真的在），
 * 但不需要把 web 实现打进产物；网页预览下这个按钮根本不会渲染。
 */
/** 只用到 `open` 一个方法（本文件是 .tsx，泛型写法会被当成 JSX，所以用类型别名 + 断言） */
interface NativeBrowserPlugin {
  open(options: { url: string; presentationStyle?: string }): Promise<void>
}
const nativeBrowser = registerPlugin('Browser') as unknown as NativeBrowserPlugin

/** Update operations are isolated from history, API settings and feedback transport. */
export const AppUpdateField = () => {
  /** 失败文案是按界面语言取一侧的双语对（见 services/updateFailure.ts） */
  const locale = useSettings((state) => state.locale)
  const lang = locale === 'zh-CN' ? 'zh' : 'en'
  /** #412：新增文案走 i18n（zh/en 成对，check:i18n 的 R1/R2/R4 会盯着） */
  const t = useTranslate()
  const [opened, setOpened] = useState(false)
  /**
   * 渠道默认值按「装的是不是预发布包」猜；**用户选过就以用户的为准**（#412 第 3 项）——
   * 以前这里只有猜测，于是「我把渠道切到稳定版了」在重开设置后根本不成立。
   */
  const [channel, setChannel] = useState<UpdateChannel>(() =>
    readUpdateChannel(/-/.test(bundledApp().version) ? 'prerelease' : 'stable')
  )
  const [release, setRelease] = useState<UpdateRelease>()
  /** 本次清单实际生效的分发机：相对 file 必须拼在它上面（回退到旧机后别拼新机域名）。 */
  const [base, setBase] = useState<string>(DEFAULT_RELEASE_BASE)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  /**
   * 下载进度只描述「正在下载的字节」，**不参与**「能不能装」的判断（#373）：
   * `received === total` 永不推导「可安装」，可安装的唯一来源是下面的 `ready`（显式状态）。
   * 以前失败 / 取消分支不清它，终态就渲染成「5.2 MB / 5.2 MB 满格 + 确认下载」，
   * 用户按「进度满格 = 下好了」理解，实际一次都没下成。
   * TODO(原生侧，另开单)：`AppUpdatePlugin.java:205-208` 在 `received == size` 时就发 100%，
   * `:213` 才 `verify()` —— 真机上任何校验失败都必然「先看到满格、再收到失败」。
   * 那一帧应挪到 `verify()` 通过之后（本 PR 只改 JS，不动 Java）。
   */
  const [progress, setProgress] = useState<{ received: number; total: number }>()
  /** 最近一次检查 / 下载 / 安装的结论（#310）：界面文案与「复制诊断信息」共用同一份 */
  const [outcome, setOutcome] = useState<UpdateFailureView>()
  const [checkedAt, setCheckedAt] = useState<number>()
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  /**
   * 失败兜底（#412）：`failed` 只表示「本次检查以失败收场」，界面据此决定要不要给
   * 「缓存版本列表 + 手动下载」两个出口；`snapshot` 是失败那一刻从 localStorage 读到的
   * 上次成功清单（读不到就保持 undefined，界面退回原来的失败文案）。
   */
  const [failed, setFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<ManifestSnapshot>()
  /**
   * 更新策略弹窗（Issue #517）：`undefined` = 不弹。
   *
   * 触发条件只有一条：**选中的那条记录真的带了下发策略**（`release.updatePolicy`）。
   * 没带策略的清单（老服务端 / 现有 L1 契约里的形状）行为一个字不变 —— 结果仍旧在下面这块面板里展示。
   * 这条边界的理由：弹窗是「服务端策略」的载体，不是「有新版本」的另一种画法；
   * 混在一起会让没有策略的清单也突然多一层遮罩，把面板里的渠道切换 / 诊断 / 缓存兜底全挡住。
   */
  const [prompt, setPrompt] = useState<{ release: UpdateRelease; policy: ResolvedUpdatePolicy }>()
  /**
   * 用户是否已经在弹窗里按过「下载 / 安装」。
   *
   * 弹窗里的状态行只在**动过手之后**出现：一开始那句「发现新版本，确认后再下载」是面板的结论，
   * 弹窗自己在标题 + 版本号里已经说完了，重复一遍只是噪音；而一旦开始下载，
   * 「正在下载 / 已就绪 / 失败原因」必须在这个弹层里可见（面板被它盖住了）。
   */
  const [promptActed, setPromptActed] = useState(false)
  /**
   * 本机已装包的变体与 versionCode：失败时也要用来从**缓存**里挑「最新可装的那一条」。
   * 用 ref 而不是 state —— 它们由检查流程写、由兜底链接读，不参与任何渲染分支。
   */
  const installedRef = useRef<{ code: number; variant: ArtifactVariant }>({
    code: bundledApp().versionCode,
    variant: currentVariant(),
  })
  /** 下载进度也要给失败文案用：state 在一次下载里是旧值，这里留一份最新的 */
  const progressRef = useRef<{ received: number; total: number }>()
  const operation = useRef<AbortController>()
  /**
   * `busy` 是 state：同一 tick 连点两次会都读到旧值，两次都放行（#373 场景 E 实测向原生下发了 2 次下载，
   * 第 2 次被原生 BUSY 拒）。真正的「正在下载」判定要靠这个 ref。
   */
  const downloading = useRef(false)
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
      locale: lang,
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
    setFailed(false)
    setSnapshot(undefined)
    setPrompt(undefined)
    setPromptActed(false)
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
      // #412：本机变体与 versionCode 记进 ref —— 失败时要用它们从**缓存快照**里挑最新可装版本
      installedRef.current = { code: current.versionCode, variant }
      // 清单拿到了就存一份快照：下次失败时它就是唯一的兜底（写不进去不影响本次检查）
      saveManifestSnapshot({ rows, base: effectiveBase })
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
        // #377：没有候选时把「为什么没有」也记进日志——排查时不用再靠用户复述文案
        reason: result.reason ?? 'none',
      })
      setRelease(result.release)
      setBase(effectiveBase)
      if (result.release) {
        setMessage('发现新版本，确认后再下载。')
        /**
         * #517：判定「这次要不要弹策略弹窗」（纯函数，L0 钉住）。三件事一次算清：
         *   1. 档位（forced / soft / normal，见 resolveUpdatePolicy 的判定顺序）；
         *   2. snooze 是否仍在有效期内（soft 才会被它挡住）；
         *   3. 有没有下发策略 —— 没下发就不弹（见上面 prompt 的注释）。
         */
        const resolved = resolveUpdatePolicy(result.release.updatePolicy, current.versionCode)
        const decision = resolveUpdatePrompt({
          policy: result.release.updatePolicy,
          currentVersionCode: current.versionCode,
          // 读一次当前值就够：snooze 只由这个弹窗写，本次检查期间不会变
          snoozedUntil: useSettings.getState().updateSnoozeUntil,
        })
        const show = result.release.updatePolicy !== undefined && decision.show
        setPrompt(show ? { release: result.release, policy: resolved } : undefined)
      } else {
        // 无新版也要说清「哪个渠道、当前版本、为什么没有可装的记录」（#310 验收第 5 条）。
        // #377：`reason` 把「本机变体在清单里断链」与「确实已是最新」分开——前者要给的是
        // 「手动下载正式版」这种能行动的结论，不是「已是最新」。
        const view = describeUpToDate({
          channel: CHANNEL_LABEL[activeChannel],
          version,
          locale: lang,
          incomplete: result.incomplete,
          reason: result.reason,
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
        /**
         * #412 第 1 项：失败时不再只剩一句「检查失败」。
         * 上次成功拉到的清单还在 localStorage 里，读出来给用户看（标注缓存时间 + 「可能不是最新」），
         * 至少让他知道「上次看到的是哪个版本」。读不到（没缓存 / 过期 / 结构变了）就保持 undefined，
         * 界面回到原来的失败文案 —— 不拿过期数据硬凑。
         */
        setSnapshot(readManifestSnapshot())
        setFailed(true)
      }
    } finally {
      checking.current = false
      if (mounted.current && operation.current === controller) {
        setBusy(false)
      }
    }
  }
  const download = async () => {
    if (!release || busy || downloading.current) {
      return
    }
    downloading.current = true
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
        // 进度条只描述「正在下载的字节」：失败 / 取消后必须清空，
        // 否则终态是「满格进度 + 确认下载」，等于把失败画成下好了（#373 根因）
        setProgress(undefined)
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
      downloading.current = false
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
        // 安装阶段的校验失败 = 缓存的包不可信：按钮会回到「确认下载」，同样不能留满格进度（#373 场景 B2）
        setProgress(undefined)
        showFailure(error, channel, release.version)
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  /**
   * 策略弹窗的两个出口（#517）。
   *
   * `soft` 的「稍后提醒」= 按服务端给的 `snoozeHours` 写一条到期时刻再关；到期前的检查都不再弹
   * （`resolveUpdatePrompt` 判定，手改系统时间也不影响口径：比较的是绝对时间戳）。
   * `forced` 根本没有这个出口：不渲染按钮、也不写 snooze —— 强制更新不许「稍后」。
   */
  const snoozePrompt = () => {
    if (!prompt) {
      return
    }
    const hours = prompt.policy.snoozeHours
    setUpdateSnoozeUntil(snoozeDeadline(Date.now(), hours))
    setPrompt(undefined)
    setMessage(t('updateDialogSnoozed', { hours }))
  }
  const copyReport = async () => {
    const ok = await copyText(
      buildUpdateReport({
        version: bundledApp().version,
        versionCode: bundledApp().versionCode,
        channel: CHANNEL_LABEL[channel].zh,
        native,
        checkedAt,
        outcome: outcome?.text,
        code: outcome?.code,
        base,
      })
    )
    setCopyState(ok ? 'done' : 'failed')
  }
  /**
   * 「手动下载最新版」的目标地址（#412 第 2 项）。判定本体在 services/updateManifest.ts 的
   * `manualDownloadTarget`（纯函数、单测钉住）：有缓存就给最新可装那条记录的直链，
   * 没有就退到公开下载站首页。组件这里只负责「怎么打开」。
   */
  const manual = manualDownloadTarget(snapshot, installedRef.current, channel)
  /**
   * 原生侧用 App 内嵌浏览器打开（与 #331 的「前往购买」同一条通道）；插件缺失 / 打不开时
   * 留在弹窗里给一句可读提示，不做 `window.open` / `location` 兜底（整页跳走就等于把设置界面弄丢）。
   */
  const openManualDownload = async () => {
    try {
      await nativeBrowser.open({ url: manual.url, presentationStyle: 'popover' })
    } catch {
      // 插件缺失（旧壳子）/ 打不开：留在弹窗里说清楚，不整页跳走
      setMessage(t('updateManualOpenFailed'))
    }
  }
  /** 缓存列表只列最新几条：按 versionCode 降序，读的是已校验过的快照 */
  const cachedPreview = snapshot
    ? [...snapshot.rows].sort((a, b) => b.versionCode - a.versionCode).slice(0, CACHE_PREVIEW_ROWS)
    : []
  /**
   * 「手动下载最新版」那个入口本身：原生侧是按钮（走 App 内嵌浏览器），网页预览是链接。
   * 抽成一个元素是因为失败态有「有缓存 / 没缓存」两种排版，出口必须**一模一样**——
   * 复制一份 JSX 迟早会有一边改了另一边没改。
   */
  const manualEntry = native ? (
    <button
      type="button"
      className={dialogStyles.copyButton}
      data-testid="update-manual-download"
      onClick={() => void openManualDownload()}
    >
      {t('updateManualDownload')}
    </button>
  ) : (
    <a href={manual.url} target="_blank" rel="noreferrer" data-testid="update-manual-download">
      {t('updateManualDownload')}
    </a>
  )
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
          /*
           * 弹窗打开时底部整块不渲染：同一个动作不许出现在两个地方
           * （用户会不知道点哪个；用例按名字取按钮也会撞见两个同名按钮）。
           * 弹窗的底部按钮走的是**同一条**下载 / 安装 / 取消链路，状态也读同一份。
           */
          footer={
            prompt ? null : (
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
            )
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
                // #412 第 3 项：选择要记住（否则「切到仅稳定版」重开设置就不成立了）。
                // 写失败（隐私模式 / 配额满）只影响下次默认值，不影响本次检查。
                saveUpdateChannel(next)
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
          {/*
           * 失败兜底（#412）：检查失败时不再只剩一句「更新服务不可达」。
           * 有缓存 → 列出上次成功拉到的版本 + 明确标注「缓存数据，可能不是最新」+ 上次成功时间；
           * 没缓存 → 只有下面那一行「手动下载最新版」，不画缓存底纹（不拿过期数据硬凑）。
           * 失败文案（`role="status"`）照旧不变：缓存是补充，不是用来掩盖失败的。
           * 无论有没有缓存，都留一个「手动下载最新版」出口 —— 更新服务整体挂掉时，
           * 这是用户唯一还能拿到安装包的通道。
           */}
          {failed ? (
            snapshot ? (
              <div className={dialogStyles.cacheFallback} data-testid="update-cache-fallback">
                <p className={dialogStyles.cacheTitle}>{t('updateCacheFallbackTitle')}</p>
                <p className={dialogStyles.cacheNote}>
                  {t('updateCacheFallbackNote', {
                    time: snapshotText(snapshot.savedAt),
                    count: snapshot.rows.length,
                  })}
                </p>
                <ul className={dialogStyles.cacheList}>
                  {cachedPreview.map((row) => (
                    <li key={`${row.versionCode}-${row.file}`}>
                      {row.version} · {sizeText(row.size)}
                      {row.buildType ? ` · ${CHANNEL_LABEL[row.buildType][lang]}` : ''}
                    </li>
                  ))}
                </ul>
                <div className={dialogStyles.cacheManual}>{manualEntry}</div>
              </div>
            ) : (
              // 没有缓存：不画那块「缓存」底纹（画了会让人以为里面有数据），只留唯一还能走的出口
              <div className={dialogStyles.cacheManual} data-testid="update-cache-fallback">
                {manualEntry}
              </div>
            )
          ) : null}
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
           * 地址只到 host（界面只显示主地址；备用地址只在可复制的诊断报告里），不含路径与 query。
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
                <dd>{CHANNEL_LABEL[channel][lang]}</dd>
              </div>
              <div>
                <dt>更新服务</dt>
                <dd>{primaryReleaseHost()}</dd>
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
      {/*
       * 策略弹窗（Issue #517）：叠在设置面板之上。
       * 内容区可滚动、底部按钮常驻（同 #172 的高度链），三档行为由 policy.mode 决定。
       * 只在清单条目带了下发策略时出现 —— 没策略的清单仍是上面那块面板（零回归）。
       */}
      {prompt ? (
        <UpdateDialog
          release={prompt.release}
          currentVersion={bundledApp().version}
          policy={prompt.policy}
          primary={
            native
              ? {
                  // 原生：与面板原来是同一颗按钮、同一套状态（ready 决定「确认下载 / 安装更新」）
                  label: ready ? '安装更新' : '确认下载',
                  onClick: () => {
                    setPromptActed(true)
                    void (ready ? install() : download())
                  },
                }
              : {
                  // 网页预览：降级成下载链接（与面板同一条 releaseUrl，拼在本次生效的 base 上）
                  label: '下载 APK',
                  href: releaseUrl(prompt.release.file, base),
                }
          }
          busy={busy}
          onCancel={() => operation.current?.abort()}
          message={promptActed ? message : undefined}
          progress={progress}
          onSnooze={snoozePrompt}
          onClose={() => setPrompt(undefined)}
        />
      ) : null}
    </>
  )
}
