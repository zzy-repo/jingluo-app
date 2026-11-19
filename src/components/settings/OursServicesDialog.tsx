import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { setApiKey, useApiConfig, useIsOursChannel } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buyUrl,
  fetchPlans,
  formatPlanMeta,
  formatPoints,
  ORDER_STATUS_KEYS,
  OURS_PAYMENT_OPEN,
  pollOrder,
  probeApiKey,
  startCheckout,
  type OursKeyProbe,
  type OursLatestFulfilled,
  type OursMessageKey,
  type OursOrderStatus,
  type OursPlansState,
} from '../../services/ours/api.js'
import {
  applyForKey,
  isInviteCodeShape,
  normalizeInviteCode,
  redeemCardMigrated,
  redeemInviteCode,
  runWithDeviceSelfHeal,
  type InviteMessageKey,
  type RedeemCardResult,
  type InviteProfile,
} from '../../services/invite/api.js'
import { bindExistingKey, bindSuccessKey, resolveBindDeviceId, type BindMessageKey } from '../../services/invite/bind.js'
import { inviteCashbackLine, inviteOkCopy, inviteRuleLines } from '../../services/invite/copy.js'
import { rotateKey, rotateSuccessKey, type RotateOutcome } from '../../services/invite/rotate.js'
import { prepareDialogOpen, refreshProfile } from '../../services/invite/openFlow.js'
import { resolveDeviceFp } from '../../services/invite/fingerprint.js'
import {
  createDeviceId,
  ensureDeviceId,
  localStorageDeviceIdStorage,
  localStorageFlagStorage,
  markDeviceBackupHintSeen,
  shouldShowDeviceBackupHint,
} from '../../services/invite/device.js'
import {
  readStoredOrder,
  subscribeStoredOrder,
  writeStoredOrder,
  ORDER_RESUME_MAX_AGE_MS,
} from '../../services/ours/orderStore.js'
import { httpTransport, isNativePlatform, navigateTopLevel, openCheckout } from '../../services/ours/transport.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  closeSettings,
  consumeOursReplacedUnpaid,
  setOursServicesOpen,
  useSettingsDialog,
} from './settingsDialogState.js'
import styles from './OursServices.module.css'

/**
 * 「我们的渠道」的设备码 / 额度 / 邀请 / 套餐购买 / 订单 / 卡密兑换入口。
 * 整个组件只在 kind === 'ours' 时渲染（其他渠道一条 DOM 都不留，见 OursServicesRow）。
 *
 * 两套后端（都在 services/ 里，纯逻辑 + 注入传输，单测覆盖）：
 *  - 邀请 / 额度服务 http://140.210.13.146:60013（明文 HTTP）：设备码、Key、邀请码、剩余积分
 *  - 卡密 / 支付服务 https://apia.ecsafe.cn（HTTPS）：套餐、/buy 的 302 收银台、订单、卡密兑换
 *
 * 额度口径：**只认邀请服务的 remaining_points**，界面上只显示「N 积分」，不做人民币折算（#75）。
 * /api/balance 只用来判断 Key 是否有效，绝不当余额。
 *
 * 失败一律给可读文案 + 可重试，且重试都是安全的：
 *  - /apply 对同一 device_id 幂等（201 首次 / 200 已申请）
 *  - /api/redeem 用卡密本身当 request_id（同一张卡重发就是同一笔）
 *  - /buy **绝不自动重试**：每次 GET 都会新建订单
 */
type BalanceView =
  | { status: 'idle' | 'loading' }
  | { status: 'ok'; profile: InviteProfile }
  | { status: 'error'; messageKey: InviteMessageKey | OursMessageKey }

type ClaimView =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'ok'; firstTime: boolean; points: number }
  | { status: 'error'; messageKey: InviteMessageKey }

type OrderView = {
  outTradeNo: string
  orderToken: string
  status: OursOrderStatus | null
  cardTail: string
  busy: boolean
  timedOut: boolean
  errorKey: OursMessageKey | null
  /** 服务端兜底（Issue #157）：查的这一单没完成时，同 customer 最近一笔已完成订单 */
  latestFulfilled: OursLatestFulfilled | null
}

/** 套餐列表默认选中的套餐 id（没有可用套餐就是 null） */
const firstPlanId = (state: OursPlansState | { status: 'loading' }): string | null =>
  state.status === 'success' ? (state.plans[0]?.id ?? null) : null

/** 设置页里的入口行：只有我们的渠道才出现 */
export const OursServicesRow = () => {
  const t = useTranslate()
  // 渠道判定与设置页里「支付记录 / 卡密」两格同一份：apiConfig.useIsOursChannel
  const ours = useIsOursChannel()
  // 开合状态放在 settingsDialogState：付款回跳要能直接把它打开（见 openOursServices）
  const open = useSettingsDialog((state) => state.oursOpen)
  if (!ours) {
    return null
  }
  return (
    <>
      <div className={styles.row} data-testid="ours-services-row">
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>{t('oursServicesLabel')}</div>
          <div className={styles.rowDescription}>{t('oursServicesDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.rowButton}
          data-testid="ours-services-open"
          onClick={() => setOursServicesOpen(true)}
        >
          {t('oursServicesOpen')}
        </Button>
      </div>
      {open ? <OursServicesDialog onClose={() => setOursServicesOpen(false)} /> : null}
    </>
  )
}

/**
 * 填码成功文案（Issue #234）：线上规则改成「只给邀请人发积分」，被邀请人填码 `reward_points` 就是 0。
 * 0 / 字段缺失 → 只说「邀请关系已绑定」，不再渲染「+0 积分」；拿到积分（邀请人侧）文案保持原样。
 */
const inviteOkText = (rewardPoints: number, t: ReturnType<typeof useTranslate>): string => {
  const copy = inviteOkCopy(rewardPoints)
  return copy.key === 'oursInviteOk'
    ? t('oursInviteOk', { points: formatPoints(copy.points, t('oursPointsUnit')) })
    : t('oursInviteBound')
}

const OursServicesDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  /** 设备码可变：invalid_device 自愈时会重新生成一个（见 runWithDeviceSelfHeal） */
  const [deviceId, setDeviceId] = useState(() => ensureDeviceId())
  /** 设备码备份提示只提示一次（Issue #72 条件 4） */
  const [showBackupHint, setShowBackupHint] = useState(() => shouldShowDeviceBackupHint(localStorageFlagStorage()))
  const [claim, setClaim] = useState<ClaimView>({ status: 'idle' })
  const [balance, setBalance] = useState<BalanceView>({ status: 'idle' })
  const [keyProbe, setKeyProbe] = useState<OursKeyProbe | null>(null)
  /** 服务端为该设备生成的 Key 与当前已填的不同：不自动覆盖，等用户点「使用此 Key」 */
  const [pendingKey, setPendingKey] = useState('')
  const [plans, setPlans] = useState<OursPlansState | { status: 'loading' }>({ status: 'loading' })
  const [planId, setPlanId] = useState('')
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyError, setBuyError] = useState<OursMessageKey | null>(null)
  const [order, setOrder] = useState<OrderView | null>(null)
  const [inviteInput, setInviteInput] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<
    { kind: 'ok'; rewardPoints: number } | { kind: 'error'; messageKey: InviteMessageKey } | null
  >(null)
  const [cardNo, setCardNo] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeem, setRedeem] = useState<RedeemCardResult | null>(null)
  const [copied, setCopied] = useState<'device' | 'invite' | 'card' | null>(null)
  /** 「我已经有 Key」：入口收起 → 展开粘贴框 → 绑定结果（Issue #86） */
  const [bindOpen, setBindOpen] = useState(false)
  const [bindInput, setBindInput] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindResult, setBindResult] = useState<
    { kind: 'ok'; alreadyBound: boolean } | { kind: 'error'; messageKey: BindMessageKey } | null
  >(null)
  /** 「更换 Key」：入口收起 → 二次确认 → 结果（Issue #90）。换 Key 是破坏性操作，必须点两下 */
  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotateBusy, setRotateBusy] = useState(false)
  const [rotateResult, setRotateResult] = useState<RotateOutcome | null>(null)
  /** 打开弹层后还没确定凭据来源（本机无 Key 或未绑定）：让用户先选「领取新 Key」/「我已有 Key」 */
  const [openChoice, setOpenChoice] = useState(false)
  /**
   * 当前档案是从哪儿来的：
   *  - 'apply' = 刚才自动领了一把**新的**设备 Key（#72 首次使用），用户自己的 Key 还没绑
   *  - 'me'    = /me 读到了已有绑定 —— 这就是「本机已绑过」（#86 条件 5），入口该收起来
   */
  const [profileFrom, setProfileFrom] = useState<'apply' | 'me' | null>(null)

  /** 完整卡密只留内存（「一键兑换」要用）：不进 localStorage、不进日志、不进文案 */
  const orderCardRef = useRef('')
  /** 服务端兜底那张卡的完整卡密（同上，只留内存） */
  const latestCardRef = useRef('')
  /** 关闭弹层 / 组件卸载时取消轮询 */
  const cancelled = useRef(false)
  const alive = useRef(true)
  /**
   * 设备指纹哈希（Issue #243）。只上报、不判定：
   *  - 拿到就随 /apply 与 /me 一起带 `X-Device-Fp`；
   *  - 拿不到（Web / 旧壳子 / 模拟器）就是空串，请求照发，**绝不挡住领取**；
   *  - 装进 ref 而不是 state：它不进渲染，也不该触发重渲染。
   */
  const deviceFpRef = useRef('')
  /**
   * 轮询「代次」（Issue #157）。每次 runPoll 递增，旧的那次轮询在下一次 tick 自己退出。
   *
   * 之前只有一个 cancelled 布尔量，而且 runPoll 开头把它重置成 false —— 于是连点两次
   * 「去支付」会有**两个轮询同时在跑**，各自把状态写回自己那一单：旧单每 2s 把界面从
   * 「已发卡」翻回「待支付」，而服务端看到的是 App 一直在查那张没人付的旧单。
   */
  const pollRun = useRef(0)
  /** 当前轮询盯着的单号 / 令牌（随时可能被最新存档换掉） */
  const activeOrder = useRef<{ outTradeNo: string; orderToken: string } | null>(null)
  /** 正在轮询的单号：同一单不重复起两条轮询（存档写入会触发订阅，别再叠一次） */
  const runningFor = useRef<string | null>(null)
  /** 「上一笔未支付订单已失效」只在真的覆盖过时提示（Issue #157） */
  const [replacedUnpaid, setReplacedUnpaid] = useState(() => consumeOursReplacedUnpaid())

  useEffect(() => {
    alive.current = true
    cancelled.current = false
    const stopWatching = subscribeStoredOrder(() => {
      // 存档是单一真相：任何一次覆盖（原生 /buy、网页版回跳、另一个标签页）都要让轮询跟上
      const stored = readStoredOrder()
      if (stored === null || !alive.current) {
        return
      }
      if (Date.now() - stored.startedAt >= ORDER_RESUME_MAX_AGE_MS) {
        return
      }
      const active = activeOrder.current
      if (active !== null && active.outTradeNo === stored.outTradeNo) {
        return
      }
      void runPollRef.current({ outTradeNo: stored.outTradeNo, orderToken: stored.orderToken })
    }, window)
    return () => {
      alive.current = false
      cancelled.current = true
      stopWatching()
    }
  }, [])

  // ---------------------------------------------------------------- 额度 / 领取

  /**
   * 自愈依赖：device_not_found → POST /apply 重新领取并把 Key 落盘；
   * invalid_device → 重新生成设备码并持久化。两者都只重试一次（见 runWithDeviceSelfHeal）。
   */
  const saveHealedKey = (key: string) => {
    setApiKey(key)
    setPendingKey('')
  }
  const regenerateDevice = (current: string): string => {
    const next = createDeviceId()
    localStorageDeviceIdStorage().write(next)
    return next === current ? `${next}0` : next
  }
  const acknowledgeBackupHint = () => {
    markDeviceBackupHintSeen(localStorageFlagStorage())
    setShowBackupHint(false)
  }

  const refreshBalance = async () => {
    setBalance({ status: 'loading' })
    // 只读 /me：device_not_found 不再自愈补 /apply（#100，一台设备一把 Key）
    const outcome = await refreshProfile({
      deviceId,
      deviceFp: deviceFpRef.current,
      transport: httpTransport,
      hasLocalKey: true,
      regenerate: regenerateDevice,
    })
    if (!alive.current) {
      return
    }
    if (outcome.deviceId !== deviceId) {
      setDeviceId(outcome.deviceId)
    }
    setProfileFrom(outcome.kind === 'profile' ? 'me' : null)
    setBalance(
      outcome.kind === 'profile'
        ? { status: 'ok', profile: outcome.profile }
        : {
            status: 'error',
            messageKey: outcome.kind === 'choose' ? 'oursQuotaNeedsBind' : outcome.messageKey,
          }
    )
  }

  /**
   * 领 Key（POST /apply）—— **只由用户点「领取新 Key」触发**（#100：打开弹层绝不自动领）。
   * 已有 Key 且与服务端下发的不一致时**不覆盖**，只提示「使用此 Key」让用户自己决定。
   */
  const claimKey = async () => {
    setClaim({ status: 'busy' })
    const result = await applyForKey(deviceId, httpTransport, deviceFpRef.current)
    if (!alive.current) {
      return
    }
    if (result.kind === 'error') {
      setClaim({ status: 'error', messageKey: result.messageKey })
      return
    }
    setProfileFrom('apply')
    setOpenChoice(false)
    setBalance({ status: 'ok', profile: result.profile })
    setClaim({ status: 'ok', firstTime: result.firstTime, points: result.profile.remainingPoints })
    const current = useApiConfig.getState().apiKey.trim()
    if (current === '') {
      setApiKey(result.apiKey)
    } else if (result.apiKey !== current) {
      setPendingKey(result.apiKey)
    }
    // 服务端认不认这把 Key：只用来提示，不参与额度
    const probe = await probeApiKey(result.apiKey, httpTransport)
    if (alive.current) {
      setKeyProbe(probe)
    }
  }

  // ---------------------------------------------------------------- 订单轮询

  /**
   * 轮询状态机在 services/ours/api.ts（单测覆盖），这里只负责渲染与取消。
   *
   * 两处 Issue #157 的关键约束：
   *  1. 每次 runPoll 拿一个新的「代次」（pollRun）；旧代次的轮询在下一 tick 自己停，
   *     既不写状态也不写存档 —— 连点两次「去支付」不会出现两个轮询互相盖。
   *  2. 轮询每 tick 都回读本地存档（latest），存档被覆盖就换到新单；展示用的单号
   *     一律取**服务端返回的那一单**（next.outTradeNo），不再用发起时的闭包值。
   */
  const runPoll = async (initial: { outTradeNo: string; orderToken: string }) => {
    if (runningFor.current === initial.outTradeNo) {
      // 这一单已经在查了（下单时写存档会触发订阅，别再叠一条轮询上去）
      return
    }
    const run = pollRun.current + 1
    pollRun.current = run
    cancelled.current = false
    activeOrder.current = { ...initial }
    runningFor.current = initial.outTradeNo
    orderCardRef.current = ''
    latestCardRef.current = ''
    setOrder({
      outTradeNo: initial.outTradeNo,
      orderToken: initial.orderToken,
      status: null,
      cardTail: '',
      busy: true,
      timedOut: false,
      errorKey: null,
      latestFulfilled: null,
    })
    const isCurrent = () => alive.current && pollRun.current === run
    const result = await pollOrder({
      outTradeNo: initial.outTradeNo,
      orderToken: initial.orderToken,
      transport: httpTransport,
      // 存档是单一真相：重新下单后这里会读到新单号，轮询立刻切过去
      latest: () => {
        const stored = readStoredOrder()
        return stored === null ? null : { outTradeNo: stored.outTradeNo, orderToken: stored.orderToken }
      },
      onSwitch: (next) => {
        if (!isCurrent()) {
          return
        }
        activeOrder.current = { ...next }
        runningFor.current = next.outTradeNo
        orderCardRef.current = ''
        latestCardRef.current = ''
        setOrder({
          outTradeNo: next.outTradeNo,
          orderToken: next.orderToken,
          status: null,
          cardTail: '',
          busy: true,
          timedOut: false,
          errorKey: null,
          latestFulfilled: null,
        })
      },
      onUpdate: (next) => {
        if (!isCurrent()) {
          return
        }
        orderCardRef.current = next.status === 'fulfilled' ? next.cardNo : ''
        latestCardRef.current = next.latestFulfilled?.cardNo ?? ''
        setOrder({
          outTradeNo: next.outTradeNo,
          orderToken: activeOrder.current?.orderToken ?? initial.orderToken,
          status: next.status,
          cardTail: next.cardTail,
          busy: true,
          timedOut: false,
          errorKey: null,
          latestFulfilled: next.latestFulfilled,
        })
      },
      shouldStop: () => cancelled.current || !isCurrent(),
    })
    if (isCurrent()) {
      runningFor.current = null
    }
    if (!isCurrent() || result.kind === 'cancelled') {
      return
    }
    if (result.kind === 'error') {
      setOrder((current) => (current === null ? null : { ...current, busy: false, errorKey: result.messageKey }))
      return
    }
    if (result.kind === 'ok') {
      orderCardRef.current = result.order.status === 'fulfilled' ? result.order.cardNo : ''
      setOrder((current) =>
        current === null
          ? null
          : {
              ...current,
              outTradeNo: result.order.outTradeNo,
              status: result.order.status,
              cardTail: result.order.cardTail,
              busy: false,
              timedOut: false,
              latestFulfilled: result.order.latestFulfilled,
            }
      )
      writeStoredOrder(null)
      // 发卡成功说明这笔钱已到账，额度可能变了：顺手刷一次
      if (result.order.status === 'fulfilled') {
        void refreshBalance()
      }
      return
    }
    // timeout：不重复下单，只留「再查一次」
    setOrder((current) => (current === null ? null : { ...current, busy: false, timedOut: true }))
  }

  /** 事件回调里用的最新 runPoll（避免闭包抓到旧的那一份） */
  const runPollRef = useRef(runPoll)
  runPollRef.current = runPoll

  /**
   * 「再查一次」必须查**最新存档**那单（Issue #157）：
   * 之前用的是界面状态里的单号，一旦状态被旧轮询写脏，再查也还是在查旧单。
   */
  const requeryOrder = async () => {
    const stored = readStoredOrder()
    const fresh =
      stored !== null && Date.now() - stored.startedAt < ORDER_RESUME_MAX_AGE_MS
        ? { outTradeNo: stored.outTradeNo, orderToken: stored.orderToken }
        : null
    const target = fresh ?? activeOrder.current ?? (order === null ? null : { outTradeNo: order.outTradeNo, orderToken: order.orderToken })
    if (target === null) {
      return
    }
    await runPoll(target)
  }

  // ---------------------------------------------------------------- 绑定已有 Key（#86）

  /**
   * 把用户已有的 Key 绑到本机设备码，成功后走的**就是**「领取成功」那条路：
   * 保存返回的 Key → 刷新 /me → 关弹层回主页。adopted_points 是服务端内部折算值，
   * 全程不显示（见 services/invite/bind.ts）。重复提交（already_bound）也算成功。
   */
  const submitBind = async () => {
    const key = bindInput.trim()
    if (key === '' || bindBusy) {
      return
    }
    setBindBusy(true)
    setBindResult(null)
    // 设备码与 /apply、/me 共用同一份本地存储：缺了就按 #72 的规则生成并落盘
    const device = resolveBindDeviceId(localStorageDeviceIdStorage())
    if (device.deviceId !== deviceId) {
      setDeviceId(device.deviceId)
    }
    const result = await bindExistingKey({ deviceId: device.deviceId, apiKey: key }, httpTransport)
    if (!alive.current) {
      return
    }
    setBindBusy(false)
    if (result.kind === 'error') {
      setBindResult({ kind: 'error', messageKey: result.messageKey })
      return
    }
    setApiKey(result.apiKey)
    setPendingKey('')
    setBindInput('')
    setBindResult({ kind: 'ok', alreadyBound: result.alreadyBound })
    // 与兑换 / 领取成功后一致：刷新额度（内部走 runWithDeviceSelfHeal）
    await refreshBalance()
    if (!alive.current) {
      return
    }
    onClose()
    closeSettings()
  }

  // ---------------------------------------------------------------- 套餐 / 挂载

  const reloadPlans = async () => {
    setPlans({ status: 'loading' })
    const next = await fetchPlans(httpTransport)
    if (!alive.current) {
      return
    }
    setPlans(next)
    const nextId = firstPlanId(next)
    if (nextId !== null) {
      setPlanId((current) => (current === '' ? nextId : current))
    }
  }

  useEffect(() => {
    void (async () => {
      // 存档里的未完成订单（付款回跳最典型）先查：用户回来第一眼就该看到订单状态，
      // 不该排队等额度与套餐。只有存过 order_token 的才查得到。
      const stored = readStoredOrder()
      if (stored !== null && Date.now() - stored.startedAt < ORDER_RESUME_MAX_AGE_MS) {
        void runPoll({ outTradeNo: stored.outTradeNo, orderToken: stored.orderToken })
      }
      // Issue #243：先把设备指纹拿到手（本地桥，毫秒级），好让**第一条** /me 就带上它。
      // resolveDeviceFp 永不抛、拿不到就回空串 —— 没有指纹也照常往下走，不阻塞注册。
      deviceFpRef.current = await resolveDeviceFp()
      const opened = await prepareDialogOpen({
        deviceId,
        deviceFp: deviceFpRef.current,
        hasLocalKey: useApiConfig.getState().apiKey.trim() !== '',
        transport: httpTransport,
        regenerate: regenerateDevice,
      })
      if (!alive.current) {
        return
      }
      if (opened.deviceId !== deviceId) {
        setDeviceId(opened.deviceId)
      }
      if (opened.kind === 'profile') {
        setProfileFrom('me')
        setBalance({ status: 'ok', profile: opened.profile })
      } else if (opened.kind === 'choose') {
        // 打开弹层什么都没发：等用户选「领取新 Key」/「我已有 Key」（#100）
        setProfileFrom(null)
        setOpenChoice(true)
        setBalance({
          status: 'error',
          messageKey: opened.reason === 'unbound' ? 'oursQuotaNeedsBind' : 'oursQuotaNeedsClaim',
        })
      } else {
        setProfileFrom(null)
        setOpenChoice(true)
        setBalance({ status: 'error', messageKey: opened.messageKey })
      }
      const nextPlans = await fetchPlans(httpTransport)
      if (!alive.current) {
        return
      }
      setPlans(nextPlans)
      const nextId = firstPlanId(nextPlans)
      if (nextId !== null) {
        setPlanId((current) => (current === '' ? nextId : current))
      }
    })()
    // 只跑一次：挂载即初始化，之后都由用户操作驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- 购买

  /**
   * 去支付。两种环境两种走法（Issue #36 的技术订正）：
   *
   *  - **网页版**：直接 `window.location.assign(buyUrl(planId))` —— 顶层导航。
   *    /buy 的 302 目标里签名、单号、金额后端已经拼好，浏览器照着跳就行；
   *    跨域顶层跳转不受 CORS 约束，也不需要读 Location。**一条业务请求都不发**（不发 fetch）。
   *  - **原生**：GET /buy 读 302 的 Location（CapacitorHttp disableRedirects，读不到头时
   *    走原生插件 resolveLocation 兜底）→ 系统浏览器打开 → 存 order_token → 轮询。
   *
   * 旧的网页版实现用 `fetch('/buy', { redirect: 'manual' })` 读 302：按规范只能拿到
   * opaqueredirect（读不到 Location），所以永远走到「请在 App 内购买」—— 那条分支已删除。
   */
  const buy = async () => {
    if (!OURS_PAYMENT_OPEN || planId === '' || buyBusy) {
      return
    }
    setBuyError(null)
    if (!isNativePlatform()) {
      // 网页版：让浏览器自己跳（付款回来地址栏带 ?no=&order_token=，启动时解析后进查单）
      navigateTopLevel(buyUrl(planId))
      return
    }
    setBuyBusy(true)
    const result = await startCheckout(planId, httpTransport)
    if (!alive.current) {
      return
    }
    if (result.kind !== 'ok') {
      setBuyBusy(false)
      setBuyError(result.kind === 'no-location' ? 'oursErrCheckoutUnsupported' : result.messageKey)
      return
    }
    const opened = await openCheckout(result.checkout.payUrl)
    if (!alive.current) {
      return
    }
    setBuyBusy(false)
    if (!opened) {
      setBuyError('oursErrCheckoutUnsupported')
      return
    }
    // 存档由 startCheckout 在「拿到 Location 并解析出新单号」那一刻**覆盖**写法（api.ts），
    // 这里不再重复写一份：两处写同一份存档只会给「谁最后写」留坑（Issue #157）。
    // 覆盖掉一笔还没完成的旧单时明说一句，别让用户以为旧单还能付。
    setReplacedUnpaid(result.replacedUnpaidOrder)
    await runPoll({ outTradeNo: result.checkout.outTradeNo, orderToken: result.checkout.orderToken })
  }

  // ---------------------------------------------------------------- 兑换 / 邀请

  const submitRedeem = async (card: string) => {
    const trimmed = card.trim()
    if (trimmed === '') {
      setRedeem({ kind: 'error', code: 'card_missing', messageKey: 'oursErrCardMissing', cardTail: '', retryable: false, via: 'pool' })
      return
    }
    if (apiKey.trim() === '') {
      setRedeem({ kind: 'error', code: 'api_key_missing', messageKey: 'oursErrKeyMissing', cardTail: '', retryable: false, via: 'pool' })
      return
    }
    setRedeemBusy(true)
    // 打本机池（62.106:60013/redeem-card），池整条链路不通才兜底旧 /api/redeem；
    // device_not_found / invalid_device 由 runWithDeviceSelfHeal 自愈一次，绝不循环。
    const outcome = await runWithDeviceSelfHeal(
      { deviceId, deviceFp: deviceFpRef.current, transport: httpTransport, saveKey: saveHealedKey, regenerate: regenerateDevice },
      () => redeemCardMigrated({ cardNo: trimmed, apiKey }, httpTransport)
    )
    if (!alive.current) {
      return
    }
    setRedeemBusy(false)
    if (outcome.deviceId !== deviceId) {
      setDeviceId(outcome.deviceId)
    }
    if (outcome.kind === 'error') {
      setRedeem({
        kind: 'error',
        code: outcome.code,
        messageKey: outcome.messageKey as OursMessageKey,
        cardTail: trimmed.slice(-4),
        retryable: outcome.code === 'NETWORK' || outcome.code === 'TIMEOUT',
        via: 'pool',
      })
      return
    }
    // 走到这里只可能是 success / pending（错误已在上面 return）：202 也按「收下了」处理，
    // 所以清空输入并刷新一次额度（pending 时服务端稍后才入账，用户可点「刷新额度」再看）
    setRedeem(outcome.value)
    setCardNo('')
    orderCardRef.current = ''
    void refreshBalance()
  }

  const submitInvite = async () => {
    setInviteBusy(true)
    const result = await redeemInviteCode({ deviceId, inviteCode: inviteInput }, httpTransport)
    if (!alive.current) {
      return
    }
    setInviteBusy(false)
    if (result.kind === 'error') {
      setInviteResult({ kind: 'error', messageKey: result.messageKey })
      return
    }
    // #234：reward_points 为 0 是**成功**（被邀请人只建立关系），文案由 inviteOkText 决定说法
    setInviteResult({ kind: 'ok', rewardPoints: result.rewardPoints })
    setInviteInput('')
    if (result.profile !== null) {
      setBalance({ status: 'ok', profile: result.profile })
    } else {
      void refreshBalance()
    }
  }

  const copy = async (target: 'device' | 'invite' | 'card', value: string) => {
    const done = await copyText(value)
    if (!alive.current) {
      return
    }
    setCopied(done ? target : null)
  }

  // ---------------------------------------------------------------- 更换 Key（#90）

  /**
   * 换一把 Key：`POST /rotate` 只认设备码，所以**旧 Key 丢了也能换**（这是它和 /bind 的关键差别）。
   *
   * 三条硬约束，都落在这一小段里：
   *  1. `saveKey` 只在服务层判定成功时才会被调用一次 —— 失败**绝不清本地旧 Key**，
   *     用户不会因为一次换失败就彻底没服务（`rotateKey` 内部保证，这里只负责接住结果）。
   *  2. `rotateBusy` 期间按钮置灰：连点不会在服务端产生多把 Key。
   *  3. 成功后立刻用响应里的额度档案刷新余额显示（不用等用户再点「刷新额度」），
   *     并把旧的 Key 探测结果清掉（那是对作废的旧 Key 探的，留着会误导）。
   */
  const submitRotate = async () => {
    if (rotateBusy) {
      return
    }
    setRotateBusy(true)
    setRotateResult(null)
    const outcome = await rotateKey({
      deviceId,
      transport: httpTransport,
      currentKey: apiKey,
      saveKey: (key) => setApiKey(key),
    })
    if (!alive.current) {
      return
    }
    setRotateBusy(false)
    setRotateResult(outcome)
    if (outcome.kind === 'error') {
      // 旧 Key 一个字节都没动，确认框留着让用户直接重试
      return
    }
    setRotateOpen(false)
    setPendingKey('')
    setKeyProbe(null)
    setProfileFrom('me')
    if (outcome.profile !== null) {
      setBalance({ status: 'ok', profile: outcome.profile })
    } else {
      void refreshBalance()
    }
  }

  // ---------------------------------------------------------------- 渲染

  const profile = balance.status === 'ok' ? balance.profile : null
  /**
   * 邀请规则说明（Issue #234）：数值全部来自服务端 `invite_rules`，前端不写死金额。
   * 老服务端没发这个字段 → 两个数组/行都是空，界面整行隐藏（绝不回落「双方各得 1 元」）。
   */
  const inviteRules = inviteRuleLines(profile?.inviteRules ?? null)
  const inviteCashback = inviteCashbackLine(profile?.cashbackPoints ?? null)
  /** 「我已经有 Key」只在**还没读到已有绑定**时出现（一台设备一把 Key，#86 条件 5） */
  const canBindKey = profileFrom !== 'me'
  const hasKey = apiKey.trim() !== ''
  const orderStatusText = (current: OrderView): string => {
    if (current.errorKey !== null) {
      return t(current.errorKey)
    }
    return current.status === null ? t('oursOrderChecking') : t(ORDER_STATUS_KEYS[current.status])
  }

  return (
    <Modal
      title={t('oursServicesTitle')}
      zIndex={1100}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.sections} data-testid="ours-services-dialog">
        {/* 0. 先选一种方式（#100）：打开弹层一条请求都没发，等用户显式决定来源 */}
        {openChoice ? (
          <section className={styles.section} data-testid="ours-open-choice">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{t('oursOpenChoiceTitle')}</h3>
            </div>
            <div className={styles.hint}>{t('oursOpenChoiceHint')}</div>
            <div className={styles.actions}>
              <Button
                size="m"
                data-testid="ours-open-choice-claim"
                disabled={claim.status === 'busy'}
                onClick={() => void claimKey()}
              >
                {claim.status === 'busy' ? t('oursClaimBusy') : t('oursOpenChoiceClaim')}
              </Button>
              <Button
                variant="outlined"
                size="m"
                data-testid="ours-open-choice-bind"
                onClick={() => setBindOpen(true)}
              >
                {t('oursOpenChoiceBind')}
              </Button>
            </div>
          </section>
        ) : null}

        {/* 1. 设备码：账号凭据，可见、可复制、可备份；不写日志 */}
        <section className={styles.section} data-testid="ours-device">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursDeviceTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-device-copy"
              onClick={() => void copy('device', deviceId)}
            >
              {copied === 'device' ? t('oursDeviceCopied') : t('oursDeviceCopy')}
            </Button>
          </div>
          <code className={styles.deviceCode} data-testid="ours-device-code">
            {deviceId}
          </code>
          <div className={styles.hint}>{t('oursDeviceDescription')}</div>
          {showBackupHint ? (
            <div className={styles.hint} data-testid="ours-device-backup-hint">
              {t('oursDeviceBackupHint')}{' '}
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-device-backup-hint-ok"
                onClick={acknowledgeBackupHint}
              >
                {t('oursDeviceBackupHintOk')}
              </Button>
            </div>
          ) : null}

          <div className={styles.actions}>
            <Button
              size="m"
              data-testid="ours-claim"
              disabled={claim.status === 'busy'}
              onClick={() => void claimKey()}
            >
              {claim.status === 'busy' ? t('oursClaimBusy') : t('oursClaimAction')}
            </Button>
            {hasKey ? (
              <span className={styles.hint} data-testid="ours-claim-key">
                {t('oursClaimKeyTail', { tail: `••••${apiKey.trim().slice(-6)}` })}
              </span>
            ) : null}
          </div>

          {claim.status === 'ok' ? (
            <div className={clsx(styles.value, styles.valueSuccess)} data-testid="ours-claim-status">
              {claim.firstTime
                ? t('oursClaimOk', { points: formatPoints(claim.points, t('oursPointsUnit')) })
                : t('oursClaimOkExisting')}
            </div>
          ) : null}
          {claim.status === 'error' ? (
            <div className={clsx(styles.value, styles.valueError)} data-testid="ours-claim-status">
              {t(claim.messageKey)}
            </div>
          ) : null}
          {keyProbe !== null ? (
            <div className={styles.hint} data-testid="ours-key-probe">
              {keyProbe.status === 'valid'
                ? t('oursKeyProbeValid', { tail: keyProbe.keyTail })
                : keyProbe.status === 'invalid'
                  ? t('oursKeyProbeInvalid', { tail: keyProbe.keyTail })
                  : keyProbe.status === 'timeout'
                    ? t('oursKeyProbeTimeout')
                    : t('oursKeyProbeNetwork')}
            </div>
          ) : null}
          {pendingKey !== '' ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-claim-use"
                onClick={() => {
                  setApiKey(pendingKey)
                  setPendingKey('')
                }}
              >
                {t('oursClaimUseKey', { tail: `••••${pendingKey.slice(-6)}` })}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 1b. 我已经有 Key：把已有 Key 绑到本机设备码（#86）。
            本机已经绑过（/me 读得到档案）就不再显示这个入口：一台设备只留一把 Key。 */}
        {canBindKey ? (
          <section className={styles.section} data-testid="ours-bind">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{t('oursBindTitle')}</h3>
              {bindOpen ? null : (
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.sectionAction}
                  data-testid="ours-bind-open"
                  onClick={() => setBindOpen(true)}
                >
                  {t('oursBindEntryAction')}
                </Button>
              )}
            </div>
            <div className={styles.hint}>{t('oursBindDescription')}</div>
            {bindOpen ? (
              <div className={styles.redeemForm}>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="ours-bind-input"
                  aria-label={t('oursBindInputPlaceholder')}
                  placeholder={t('oursBindInputPlaceholder')}
                  value={bindInput}
                  disabled={bindBusy}
                  onChange={(event) => setBindInput(event.target.value)}
                />
                <Button
                  size="m"
                  data-testid="ours-bind-submit"
                  disabled={bindBusy || bindInput.trim() === ''}
                  onClick={() => void submitBind()}
                >
                  {bindBusy ? t('oursBindBusy') : t('oursBindAction')}
                </Button>
              </div>
            ) : null}
            {bindResult !== null ? (
              <div
                role="status"
                data-testid="ours-bind-result"
                className={clsx(
                  styles.value,
                  bindResult.kind === 'error' ? styles.valueError : styles.valueSuccess
                )}
              >
                {bindResult.kind === 'error'
                  ? t(bindResult.messageKey)
                  : t(bindSuccessKey({ alreadyBound: bindResult.alreadyBound }))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* 1c. 更换 Key（#90）：只认设备码，旧 Key 丢了也能换；破坏性操作，必须点两下才发请求 */}
        <section className={styles.section} data-testid="ours-rotate">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursRotateTitle')}</h3>
            {rotateOpen ? null : (
              <Button
                variant="outlined"
                size="s"
                className={styles.sectionAction}
                data-testid="ours-rotate-open"
                disabled={rotateBusy}
                onClick={() => {
                  setRotateOpen(true)
                  setRotateResult(null)
                }}
              >
                {t('oursRotateEntryAction')}
              </Button>
            )}
          </div>
          <div className={styles.hint}>{t('oursRotateDescription')}</div>
          {rotateOpen ? (
            <div data-testid="ours-rotate-confirm">
              <div className={styles.hint} role="alert" data-testid="ours-rotate-confirm-body">
                <strong>{t('oursRotateConfirmTitle')}</strong>
                <div>{t('oursRotateConfirmBody')}</div>
              </div>
              <div className={styles.actions}>
                <Button
                  size="m"
                  data-testid="ours-rotate-submit"
                  disabled={rotateBusy}
                  onClick={() => void submitRotate()}
                >
                  {rotateBusy ? t('oursRotateBusy') : t('oursRotateConfirmOk')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  data-testid="ours-rotate-cancel"
                  disabled={rotateBusy}
                  onClick={() => setRotateOpen(false)}
                >
                  {t('oursRotateConfirmCancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {rotateResult !== null ? (
            <div
              role="status"
              data-testid="ours-rotate-result"
              className={clsx(
                styles.value,
                rotateResult.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {rotateResult.kind === 'error'
                ? `${t(rotateResult.messageKey)}（${t('oursRotateKeptOldKey')}）`
                : t(rotateSuccessKey(rotateResult))}
            </div>
          ) : null}
        </section>

        {/* 2. 额度：只认邀请服务的 remaining_points；1 元 = 100 积分 */}
        <section className={styles.section} data-testid="ours-quota">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursQuotaTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-quota-refresh"
              disabled={balance.status === 'loading'}
              onClick={() => void refreshBalance()}
            >
              {balance.status === 'loading' ? t('oursQuotaLoading') : t('oursQuotaAction')}
            </Button>
          </div>
          <div
            role="status"
            data-testid="ours-quota-value"
            className={clsx(
              styles.value,
              balance.status === 'ok' && styles.valueSuccess,
              balance.status === 'error' && styles.valueError
            )}
          >
            {balance.status === 'ok'
              ? t('oursQuotaValue', { points: formatPoints(balance.profile.remainingPoints, t('oursPointsUnit')) })
              : balance.status === 'error'
                ? t(balance.messageKey)
                : balance.status === 'loading'
                  ? t('oursQuotaLoading')
                  : t('oursQuotaNeedsClaim')}
          </div>
          {profile !== null && profile.remainingPoints <= 0 ? (
            <div className={styles.hint} data-testid="ours-quota-hint">
              {t('oursQuotaZeroHint')}
            </div>
          ) : null}
        </section>

        {/* 3. 邀请码：自己的（可复制）+ 别人的（全部错误码） */}
        <section className={styles.section} data-testid="ours-invite">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursInviteTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-invite-copy"
              disabled={profile === null}
              onClick={() => void copy('invite', profile?.inviteCode ?? '')}
            >
              {copied === 'invite' ? t('oursInviteCopied') : t('oursInviteCopy')}
            </Button>
          </div>
          <div className={styles.value} data-testid="ours-invite-code">
            {profile === null
              ? t('oursInviteNeedsClaim')
              : `${t('oursInviteOwnLabel')}：${profile.inviteCode}`}
          </div>
          {profile !== null ? (
            <div className={styles.hint} data-testid="ours-invite-count">
              {t('oursInviteCount', { invited: profile.invitedCount, upper: profile.maxInvites })}
            </div>
          ) : null}
          {inviteRules.length > 0 ? (
            <div className={styles.hint} data-testid="ours-invite-rules">
              {inviteRules.map((line) => (
                <div key={line.key}>
                  {t(line.key, { points: formatPoints(line.points, t('oursPointsUnit')) })}
                </div>
              ))}
            </div>
          ) : null}
          {inviteCashback !== null ? (
            <div className={styles.hint} data-testid="ours-invite-cashback">
              {t(inviteCashback.key, {
                points: formatPoints(inviteCashback.points, t('oursPointsUnit')),
              })}
            </div>
          ) : null}
          <div className={styles.redeemForm}>
            <input
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="ours-invite-input"
              placeholder={t('oursInviteInputPlaceholder')}
              aria-label={t('oursInviteInputPlaceholder')}
              value={inviteInput}
              onChange={(event) => setInviteInput(event.target.value)}
              disabled={inviteBusy}
            />
            <Button
              size="m"
              data-testid="ours-invite-submit"
              disabled={inviteBusy || normalizeInviteCode(inviteInput) === ''}
              onClick={() => void submitInvite()}
            >
              {inviteBusy ? t('oursInviteBusy') : t('oursInviteAction')}
            </Button>
          </div>
          {inviteInput !== '' && !isInviteCodeShape(inviteInput) ? (
            <div className={styles.hint}>{t('oursInviteShapeHint')}</div>
          ) : null}
          {inviteResult !== null ? (
            <div
              role="status"
              data-testid="ours-invite-result"
              className={clsx(
                styles.value,
                inviteResult.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {inviteResult.kind === 'error'
                ? t(inviteResult.messageKey)
                : inviteOkText(inviteResult.rewardPoints, t)}
            </div>
          ) : null}
        </section>

        {/* 4. 套餐 + 购买：价格与积分来自 /api/plans，App 不硬编码 */}
        <section className={styles.section} data-testid="ours-plans">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursPlansTitle')}</h3>
            {plans.status === 'error' ? (
              <Button
                variant="outlined"
                size="s"
                className={styles.sectionAction}
                data-testid="ours-plans-retry"
                onClick={() => void reloadPlans()}
              >
                {t('oursPlansRetry')}
              </Button>
            ) : null}
          </div>
          {plans.status === 'loading' ? (
            <div className={styles.hint}>{t('oursPlansLoading')}</div>
          ) : plans.status === 'error' ? (
            <div className={clsx(styles.value, styles.valueError)}>{t(plans.messageKey)}</div>
          ) : (
            <ul className={styles.plans}>
              {plans.plans.map((plan) => (
                <li key={plan.id}>
                  <button
                    type="button"
                    className={clsx(styles.plan, plan.id === planId && styles.planActive)}
                    aria-pressed={plan.id === planId}
                    data-testid={`ours-plan-${plan.id}`}
                    onClick={() => setPlanId(plan.id)}
                  >
                    <span className={styles.planName}>{plan.name}</span>
                    <span className={styles.planMeta}>{formatPlanMeta(plan, t('oursPointsUnit'))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <Button
              size="m"
              data-testid="ours-buy"
              disabled={!OURS_PAYMENT_OPEN || buyBusy || planId === ''}
              onClick={() => void buy()}
            >
              {buyBusy ? t('oursBuyBusy') : t('oursBuyAction')}
            </Button>
          </div>
          <div
            className={clsx(styles.hint, buyError !== null && styles.valueError)}
            data-testid="ours-pay-notice"
          >
            {buyError !== null
              ? t(buyError)
              : isNativePlatform()
                ? t('oursBuyHint')
                : t('oursBuyWebHint')}
          </div>
        </section>

        {/* 5. 订单：待支付 → 已发卡；超时只说「稍后再看」，不重复下单 */}
        {order !== null ? (
          <section className={styles.section} data-testid="ours-order">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{t('oursOrderTitle')}</h3>
              {order.timedOut || order.errorKey !== null ? (
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.sectionAction}
                  data-testid="ours-order-requery"
                  disabled={order.busy}
                  onClick={() => void requeryOrder()}
                >
                  {t('oursOrderRequery')}
                </Button>
              ) : null}
            </div>
            <div
              role="status"
              data-testid="ours-order-status"
              className={clsx(
                styles.value,
                order.status === 'fulfilled' && styles.valueSuccess,
                (order.timedOut || order.errorKey !== null) && styles.valueError
              )}
            >
              {orderStatusText(order)}
            </div>
            <div className={styles.hint} data-testid="ours-order-no">
              {t('oursOrderNo', { tail: order.outTradeNo.slice(-8) })}
            </div>
            {replacedUnpaid ? (
              <div className={styles.hint} data-testid="ours-order-replaced">
                {t('oursOrderReplaced')}
              </div>
            ) : null}
            {order.busy ? (
              <div className={styles.hint} data-testid="ours-order-waiting">
                {t('oursOrderWaiting')}
              </div>
            ) : null}
            {order.timedOut ? (
              <div className={styles.hint} data-testid="ours-order-timeout">
                {t('oursOrderTimeout')}
              </div>
            ) : null}
            {order.status === 'fulfilled' && order.cardTail !== '' ? (
              <>
                <div className={styles.value} data-testid="ours-order-card">
                  {t('oursOrderCard', { tail: order.cardTail })}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="outlined"
                    size="s"
                    data-testid="ours-order-copy"
                    onClick={() => void copy('card', orderCardRef.current)}
                  >
                    {copied === 'card' ? t('oursOrderCopyCardDone') : t('oursOrderCopyCard')}
                  </Button>
                  <Button
                    size="s"
                    data-testid="ours-order-redeem"
                    disabled={redeemBusy}
                    onClick={() => void submitRedeem(orderCardRef.current)}
                  >
                    {redeemBusy ? t('oursRedeemBusy') : t('oursOrderRedeem')}
                  </Button>
                </div>
              </>
            ) : null}
            {/* 服务端兜底（Issue #157）：正在查的这单没完成，但同 customer 名下最近有一笔已完成订单
                → 直接把那张卡摆出来，并允许一键兑换（兑换逻辑与「发卡后一键兑换」同一套） */}
            {order.latestFulfilled !== null ? (
              <>
                <div
                  role="status"
                  className={clsx(styles.value, styles.valueSuccess)}
                  data-testid="ours-order-latest"
                >
                  {t('oursOrderLatestHint')}
                </div>
                <div className={styles.value} data-testid="ours-order-latest-card">
                  {t('oursOrderLatestCard', {
                    tail: order.latestFulfilled.cardTail,
                    no: order.latestFulfilled.outTradeNo.slice(-8),
                  })}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="outlined"
                    size="s"
                    data-testid="ours-order-latest-copy"
                    onClick={() => void copy('card', latestCardRef.current)}
                  >
                    {copied === 'card' ? t('oursOrderCopyCardDone') : t('oursOrderCopyCard')}
                  </Button>
                  <Button
                    size="s"
                    data-testid="ours-order-latest-redeem"
                    disabled={redeemBusy || !hasKey}
                    onClick={() => void submitRedeem(latestCardRef.current)}
                  >
                    {redeemBusy ? t('oursRedeemBusy') : t('oursOrderRedeem')}
                  </Button>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {/* 6. 卡密兑换（手输与发卡后一键兑换共用同一套语义） */}
        <section className={styles.section} data-testid="ours-redeem">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursRedeemTitle')}</h3>
          </div>
          <div className={styles.redeemForm}>
            <input
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="ours-redeem-input"
              placeholder={t('oursRedeemPlaceholder')}
              aria-label={t('oursRedeemPlaceholder')}
              value={cardNo}
              onChange={(event) => setCardNo(event.target.value)}
              disabled={redeemBusy}
            />
            <Button
              size="m"
              data-testid="ours-redeem-submit"
              disabled={redeemBusy || !hasKey}
              onClick={() => void submitRedeem(cardNo)}
            >
              {redeemBusy ? t('oursRedeemBusy') : t('oursRedeemAction')}
            </Button>
          </div>
          {redeem !== null ? (
            <div
              role="status"
              data-testid="ours-redeem-result"
              className={clsx(
                styles.value,
                redeem.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {redeem.kind === 'error'
                ? t(redeem.messageKey)
                : redeem.kind === 'pending'
                  ? // 202（CREDIT_PENDING / VERIFY_PENDING）只有一种说法：处理中，稍后自动到账
                    t('oursRedeemProcessing')
                  : redeem.messageKey === 'oursRedeemDuplicate'
                    ? t('oursRedeemDuplicate', { points: formatPoints(redeem.points, t('oursPointsUnit')) })
                    : t('oursRedeemSuccess', { points: formatPoints(redeem.points, t('oursPointsUnit')) })}
              {redeem.cardTail === '' ? '' : `（${redeem.cardTail}）`}
            </div>
          ) : null}
          {redeem !== null && redeem.kind === 'pending' ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-redeem-refresh"
                disabled={balance.status === 'loading'}
                onClick={() => void refreshBalance()}
              >
                {t('oursRedeemRefreshBalance')}
              </Button>
            </div>
          ) : null}
          {redeem !== null && redeem.kind === 'error' && redeem.retryable ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-redeem-retry"
                disabled={redeemBusy}
                onClick={() => void submitRedeem(cardNo)}
              >
                {t('oursRedeemRetry')}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 7. 安全说明：明文 HTTP 的邀请服务与 HTTPS 的支付服务混用，说清楚但不吓人 */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('oursSecurityTitle')}</h3>
          <div className={styles.hint} data-testid="ours-security-notice">
            {t('oursSecurityNotice')}
          </div>
        </section>
      </div>
    </Modal>
  )
}
