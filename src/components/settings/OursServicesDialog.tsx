import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { setApiKey, useApiConfig, useIsOursChannel } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import {
  fetchPayLink,
  formatPoints,
  probeApiKey,
  type OursKeyProbe,
  type OursMessageKey,
} from '../../services/ours/api.js'
import {
  applyForKey,
  claimMessageKeyFor,
  fetchEmailStatus,
  isEmailCodeShape,
  isEmailShape,
  isInviteCodeShape,
  normalizeInviteCode,
  redeemCardMigrated,
  redeemInviteCode,
  runWithDeviceSelfHeal,
  sendEmailCode,
  shouldShowEmailEntry,
  type ClaimOutcome,
  type EmailChoice,
  type EmailConflict,
  type EmailMessageKey,
  type EmailStatusResult,
  type InviteMessageKey,
  type RedeemCardResult,
  type InviteProfile,
} from '../../services/invite/api.js'
import { bindExistingKey, bindSuccessKey, resolveBindDeviceId, type BindMessageKey } from '../../services/invite/bind.js'
import { verifyEmailAndAdopt } from '../../services/invite/email.js'
import {
  EMAIL_COOLDOWN_TICK_MS,
  emailCooldownRemaining,
  startEmailCooldown,
  type EmailCooldown,
} from '../../services/invite/emailCooldown.js'
import { inviteCashbackLine, inviteOkCopy, inviteRuleLines } from '../../services/invite/copy.js'
import { rotateKey, rotateSuccessKey, type RotateOutcome } from '../../services/invite/rotate.js'
import { prepareDialogOpen, refreshProfile } from '../../services/invite/openFlow.js'
import { resolveDeviceFp } from '../../services/invite/fingerprint.js'
import {
  adoptServerDeviceId,
  createDeviceId,
  ensureDeviceId,
  localStorageDeviceIdStorage,
  localStorageFlagStorage,
  markDeviceBackupHintSeen,
  shouldShowDeviceBackupHint,
} from '../../services/invite/device.js'
import { httpTransport, openPayLinkInApp } from '../../services/ours/transport.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { closeSettings, setOursServicesOpen, useSettingsDialog } from './settingsDialogState.js'
import styles from './OursServices.module.css'

/**
 * 「我们的渠道」的设备码 / 额度 / 邀请 / 套餐购买 / 订单 / 卡密兑换入口。
 * 整个组件只在 kind === 'ours' 时渲染（其他渠道一条 DOM 都不留，见 OursServicesRow）。
 *
 * 两套后端（都在 services/ 里，纯逻辑 + 注入传输，单测覆盖）：
 *  - 邀请 / 额度服务 http://140.210.13.146:60013（明文 HTTP）：设备码、Key、邀请码、剩余积分
 *  - 卡密 / 收款服务 https://apia.ecsafe.cn（HTTPS）：联动小铺收款页地址（`/api/pay-link`）、卡密兑换
 *
 * 额度口径：**只认邀请服务的 remaining_points**，界面上只显示「N 积分」，不做人民币折算（#75）。
 * /api/balance 只用来判断 Key 是否有效，绝不当余额。
 *
 * 失败一律给可读文案 + 可重试，且重试都是安全的：
 *  - /apply 对同一 device_id 幂等（201 首次 / 200 已申请）
 *  - /api/redeem 用卡密本身当 request_id（同一张卡重发就是同一笔）
 *  - /api/pay-link 是只读接口，重试不会建单（Issue #331：这条链路我们**不建单**）
 */
type BalanceView =
  | { status: 'idle' | 'loading' }
  | { status: 'ok'; profile: InviteProfile }
  | { status: 'error'; messageKey: InviteMessageKey | OursMessageKey }

type ClaimView =
  | { status: 'idle' }
  | { status: 'busy' }
  /** outcome 决定文案（#261）：granted = 领取成功；另两种都是「已领过」，绝不能显示成功 */
  | { status: 'ok'; outcome: ClaimOutcome; points: number }
  | { status: 'error'; messageKey: InviteMessageKey }

/**
 * 「前往购买」的状态机（Issue #331）。
 *
 * 只有三种：idle / busy（正在取地址或正在打开）/ error（通道不可用、取地址失败、打不开）。
 * 成功打开**不显示「支付成功」**：付款结果在联动小铺那边，我们这边没有订单可查。
 */
type PayLinkView =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'error'; messageKey: OursMessageKey }

/**
 * 邮箱验证码的表单结果（Issue #421）。
 *
 * 错误分支把服务端那几个附加字段（`attempts_left` / `retry_after` / `bound_email_masked`）
 * 一起带出来：它们不是装饰，是用户下一步该做什么（还剩几次机会 / 等多少秒 / 已绑的是哪个邮箱）。
 */
type EmailResultView =
  | { kind: 'ok'; action: 'bound' | 'login'; successKey: 'oursBindOk' }
  | {
      kind: 'error'
      messageKey: EmailMessageKey
      attemptsLeft: number | null
      retryAfter: number | null
      boundEmailMasked: string | null
    }

/** 设置页里的入口行：只有我们的渠道才出现 */export const OursServicesRow = () => {
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
  /** 「前往购买」（Issue #331）：地址每次现取，取不到就只给提示，绝不整页跳走 */
  const [payLink, setPayLink] = useState<PayLinkView>({ status: 'idle' })
  const [inviteInput, setInviteInput] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<
    { kind: 'ok'; rewardPoints: number } | { kind: 'error'; messageKey: InviteMessageKey } | null
  >(null)
  const [cardNo, setCardNo] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeem, setRedeem] = useState<RedeemCardResult | null>(null)
  const [copied, setCopied] = useState<'device' | 'invite' | null>(null)
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
   * 邮箱入口（Issue #421）：**先探测再出现**。
   *
   * 初始值就是「服务端没有邮箱功能」——探测成功之前入口一律不显示：
   * 生产上邮箱功能还没开（`404 not_found`），绝不能给用户一个点了就报错的按钮。
   * 探测判据在 `fetchEmailStatus`（404 + `not_found` → disabled；404 + `device_not_found` 是真错误）。
   */
  const [emailStatus, setEmailStatus] = useState<EmailStatusResult>({ kind: 'disabled' })
  /** 邮箱表单：没展开时不渲染输入框（未绑定时由「绑定邮箱」按钮展开） */
  const [emailFormOpen, setEmailFormOpen] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailBusy, setEmailBusy] = useState<'send' | 'verify' | null>(null)
  /** 验证码已发出（当前服务端只写日志，不发真邮件 —— 文案如实说明） */
  const [emailSent, setEmailSent] = useState(false)
  const [emailResult, setEmailResult] = useState<EmailResultView | null>(null)
  /**
   * 发码冷却（#421 第 4 点 / 验收 D3）：`resend_after`（发码成功后）与 `retry_after`（429 频控）
   * 都是**服务端**给的秒数，这里存截止时刻，`emailCooldownLeft` 由每秒的 tick 算出来。
   */
  const [emailCooldown, setEmailCooldown] = useState<EmailCooldown | null>(null)
  /** 还剩几秒可重发（0 = 现在就能点）。逐秒递减由下面那个 effect 推动，不做「减一」累加 */
  const [emailCooldownLeft, setEmailCooldownLeft] = useState(0)
  /**
   * 登录冲突（#421 第 3 点）：`device_has_account` 时非 null，弹窗让用户选「用邮箱账号 / 保留本机账号」。
   * **验证码此时没被消耗** —— 选择之后带同一个验证码 + `choice` 重发一次。
   */
  const [emailConflict, setEmailConflict] = useState<EmailConflict | null>(null)
  /**
   * 当前档案是从哪儿来的：
   *  - 'apply' = 刚才自动领了一把**新的**设备 Key（#72 首次使用），用户自己的 Key 还没绑
   *  - 'me'    = /me 读到了已有绑定 —— 这就是「本机已绑过」（#86 条件 5），入口该收起来
   */
  const [profileFrom, setProfileFrom] = useState<'apply' | 'me' | null>(null)

  const alive = useRef(true)
  /**
   * 设备指纹哈希（Issue #243）。只上报、不判定：
   *  - 拿到就随 /apply 与 /me 一起带 `X-Device-Fp`；
   *  - 拿不到（Web / 旧壳子 / 模拟器）就是空串，请求照发，**绝不挡住领取**；
   *  - 装进 ref 而不是 state：它不进渲染，也不该触发重渲染。
   */
  const deviceFpRef = useRef('')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * 冷却倒计时（D3）：每秒按**截止时刻**重算一次剩余秒数（不是「减一」）。
   *
   * 用截止时刻而不是累减：后台标签页被节流 / 系统休眠回来时，累减会少走好几秒，
   * 用户等够了按钮却还灰着 —— 按 `Date.now()` 算就不会。
   */
  useEffect(() => {
    if (emailCooldown === null) {
      setEmailCooldownLeft(0)
      return
    }
    const update = () => {
      const left = emailCooldownRemaining(emailCooldown, Date.now())
      setEmailCooldownLeft(left)
      if (left <= 0) {
        setEmailCooldown(null)
      }
    }
    update()
    const timer = setInterval(update, EMAIL_COOLDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [emailCooldown])

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
  /** 服务端回填的 device_id 的自愈链路落盘口（#261）；claimKey 那条走 adoptServerDeviceId */
  const persistDevice = (next: string): void => {
    localStorageDeviceIdStorage().write(next)
    setDeviceId(next)
  }
  const acknowledgeBackupHint = () => {
    markDeviceBackupHintSeen(localStorageFlagStorage())
    setShowBackupHint(false)
  }

  // ---------------------------------------------------------------- 邮箱账号（#421）

  /**
   * 探测邮箱入口：`GET /email/status`。
   *
   *  - `disabled`（404 + `not_found`）= 服务端没开邮箱功能 → 入口不出现，旧流程一字不动；
   *  - 其它失败（网络 / 超时 / `device_not_found`）同样不出现：老部署上宁可不显示入口；
   *  - 成功：已绑 → 显示脱敏邮箱，未绑 → 显示「绑定邮箱」。
   *
   * 顺带处理第 5 点：已绑邮箱 → 不再提示「复制设备码备份」（账号可以靠邮箱找回）。
   */
  const probeEmail = async (device: string) => {
    const status = await fetchEmailStatus(device, httpTransport, deviceFpRef.current)
    if (!alive.current) {
      return
    }
    setEmailStatus(shouldShowEmailEntry(status) ? status : { kind: 'disabled' })
    if (status.kind === 'ok' && status.hasEmail === true) {
      setShowBackupHint(false)
    }
  }

  /**
   * 把一次错误落到界面：文案 + 剩余次数，并且**按服务端给的 retry_after 起倒计时**。
   *
   * `retry_after` 不是装饰（#421 验收 D3）：它是「还要等多少秒」的唯一来源，
   * 光显示一句静态文案、按钮却还能连点，等于让用户反复撞频控。
   */
  const applyEmailError = (error: {
    messageKey: EmailMessageKey
    attemptsLeft: number | null
    retryAfter: number | null
    boundEmailMasked: string | null
  }) => {
    setEmailResult({
      kind: 'error',
      messageKey: error.messageKey,
      attemptsLeft: error.attemptsLeft,
      retryAfter: error.retryAfter,
      boundEmailMasked: error.boundEmailMasked,
    })
    const cooldown = startEmailCooldown(error.retryAfter, Date.now())
    if (cooldown !== null) {
      setEmailCooldown(cooldown)
    }
  }

  /** 发验证码：频控由服务端说了算（`retry_after` 秒数原样用于倒计时，客户端不自己算窗口） */
  const submitEmailSend = async () => {
    if (emailBusy !== null || emailCooldownLeft > 0) {
      return
    }
    setEmailBusy('send')
    setEmailResult(null)
    setEmailConflict(null)
    const result = await sendEmailCode(
      { deviceId, email: emailInput },
      httpTransport,
      deviceFpRef.current
    )
    if (!alive.current) {
      return
    }
    setEmailBusy(null)
    if (result.kind === 'error') {
      applyEmailError(result)
      return
    }
    setEmailSent(true)
    // 发码成功后服务端说多久能再发（`resend_after`）→ 按钮开始逐秒倒计时
    const cooldown = startEmailCooldown(result.resendAfter, Date.now())
    setEmailCooldown(cooldown)
  }

  /**
   * 提交验证码：绑定还是登录由服务端 `action` 决定；登录分支的 `device_id` / `key`
   * 由 `verifyEmailAndAdopt` 走 `adoptServerDeviceId` + `bindSuccessKey` 那条既有路径采用，
   * 这里只负责把结果落到界面上（不自己写覆盖逻辑，也不回显 Key）。
   *
   * `choice` 只有冲突弹窗上点过按钮才有：此时**带同一个验证码**再提交一次，
   * 服务端据此决定换不换账号（#421 第 3 点：冲突那次验证码没被消耗）。
   */
  const submitEmailVerify = async (choice?: EmailChoice) => {
    if (emailBusy !== null) {
      return
    }
    setEmailBusy('verify')
    setEmailResult(null)
    const result = await verifyEmailAndAdopt(
      choice === undefined
        ? { deviceId, email: emailInput, code: emailCode }
        : { deviceId, email: emailInput, code: emailCode, choice },
      httpTransport,
      {
        storage: localStorageDeviceIdStorage(),
        currentDeviceId: deviceId,
        saveKey: (key) => {
          setApiKey(key)
          setPendingKey('')
        },
        deviceFp: deviceFpRef.current,
      }
    )
    if (!alive.current) {
      return
    }
    setEmailBusy(null)
    if (result.kind === 'conflict') {
      // 本机已有账号：不采用任何东西、不动设备码，弹窗让用户选（验证码留着）
      setEmailConflict(result)
      return
    }
    if (result.kind === 'error') {
      applyEmailError(result)
      return
    }
    const adopted = result.value
    setEmailConflict(null)
    if (adopted.deviceId !== '' && adopted.deviceId !== deviceId) {
      setDeviceId(adopted.deviceId)
    }
    setEmailCode('')
    setEmailFormOpen(false)
    setEmailResult({ kind: 'ok', action: adopted.action, successKey: adopted.successKey })
    setEmailStatus({
      kind: 'ok',
      hasEmail: adopted.hasEmail === true,
      emailMasked: adopted.emailMasked,
    })
    // #421 第 5 点：绑上邮箱之后「复制设备码备份」的前提没了
    setShowBackupHint(false)
    void refreshBalance()
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
      persistDeviceId: persistDevice,
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
    // #261：服务端回填了 device_id 就**立刻**写回本地。服务端只认它：继续用本地那个被
    // 忽略的 ID，后续 /me、兑换、下单全会查到一个不存在的设备，用户看到的就是「号丢了」。
    const finalDeviceId = adoptServerDeviceId(
      localStorageDeviceIdStorage(),
      deviceId,
      result.serverDeviceId
    )
    if (finalDeviceId !== deviceId) {
      setDeviceId(finalDeviceId)
    }
    setProfileFrom('apply')
    setOpenChoice(false)
    setBalance({ status: 'ok', profile: result.profile })
    // 只有 outcome === 'granted' 才显示「领取成功」；已领过一律显示「已领取」（#261）
    setClaim({ status: 'ok', outcome: result.outcome, points: result.profile.remainingPoints })
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
    // #421：刚领到账号 -> 再探一次邮箱入口（打开弹层时没有 Key，探过也是白探）
    if (alive.current) {
      await probeEmail(finalDeviceId)
    }
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
    if (alive.current) {
      // #421：刚绑上账号 -> 再探一次邮箱入口
      await probeEmail(device.deviceId)
    }
    if (!alive.current) {
      return
    }
    onClose()
    closeSettings()
  }

  useEffect(() => {
    void (async () => {
      // Issue #243：先把设备指纹拿到手（本地桥，毫秒级），好让**第一条** /me 就带上它。
      // resolveDeviceFp 永不抛、拿不到就回空串 —— 没有指纹也照常往下走，不阻塞注册。
      deviceFpRef.current = await resolveDeviceFp()
      const opened = await prepareDialogOpen({
        deviceId,
        deviceFp: deviceFpRef.current,
        hasLocalKey: useApiConfig.getState().apiKey.trim() !== '',
        transport: httpTransport,
        regenerate: regenerateDevice,
        persistDeviceId: persistDevice,
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
      // #421：邮箱入口是**独立探测**，不影响上面任何一条既有分支（服务端没开就一条都不显示）。
      // 只在本机已有 Key（有账号可绑）时探：没凭据时按 #100 的规矩一条请求都不发，
      // 领取 / 绑定成功之后会再探一次（见 claimKey / submitBind）。
      if (useApiConfig.getState().apiKey.trim() !== '') {
        await probeEmail(opened.deviceId)
      }
    })()
    // 只跑一次：挂载即初始化，之后都由用户操作驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- 购买（Issue #331）

  /**
   * 「前往购买」：现取联动小铺收款页地址，再用 **App 内嵌浏览器**（`Browser.open`）打开。
   *
   * 这条链路我们**不建单、不轮询**：付款与发卡都在联动小铺那边完成，App 侧只负责把页面
   * 打开在 App 内（关掉就回到原页面），关闭后顺手刷一次额度显示 —— 但**绝不**据此显示
   * 「支付成功」：没有订单可查，付款结果以买家拿到的卡密为准。
   *
   * 失败一律留在弹层里给可读提示（不整页跳走）：
   *  - 503 / `ok:false` / 非 2xx / 非法 JSON → 「收款通道暂不可用，请稍后再试」（oursPayUnavailable）
   *  - 连不上 / 超时                        → 网络 / 超时文案，可重试（只读接口，重试安全）
   *  - 插件打不开（Web / 旧壳子）            → 「没能在 App 内打开收款页」（oursPayOpenFailed）
   */
  const openPay = async () => {
    if (payLink.status === 'busy') {
      return
    }
    setPayLink({ status: 'busy' })
    const next = await fetchPayLink(httpTransport)
    if (!alive.current) {
      return
    }
    if (next.status === 'error') {
      setPayLink({ status: 'error', messageKey: next.messageKey })
      return
    }
    // 关掉收款页 = 回到 App：只刷新额度显示（卡密由小铺直接发给买家，额度可能已经变了）
    const opened = await openPayLinkInApp(next.url, () => {
      if (alive.current) {
        void refreshBalance()
      }
    })
    if (!alive.current) {
      return
    }
    setPayLink(opened ? { status: 'idle' } : { status: 'error', messageKey: 'oursPayOpenFailed' })
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
      { deviceId, deviceFp: deviceFpRef.current, transport: httpTransport, saveKey: saveHealedKey, regenerate: regenerateDevice, persistDeviceId: persistDevice },
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

  const copy = async (target: 'device' | 'invite', value: string) => {
    const done = await copyText(value)
    if (!alive.current) {
      return
    }
    setCopied(done ? target : null)
  }

  // ---------------------------------------------------------------- 更换 / 重置 Key（#90 #357）

  /**
   * 重置 Key 额度：`POST /rotate` 只认设备码，所以**旧 Key 丢了也能用**（这是它和 /bind 的关键差别）。
   *
   * #357：云端已改成「原地重置额度、不换 Key 字符串」，所以这里**不再比对返回的 Key 和本地是否相同**
   * 来决定成不成败 —— 成败只看服务层给的 `kind`，成功的说法由 `outcome.mode`
   * （`rotateSuccessKey`）决定。把「Key 没变」当成失败是 #357 那条误报的根因。
   *
   * 三条硬约束，都落在这一小段里：
   *  1. `saveKey` 只在服务层判定成功时才会被调用一次 —— 失败**绝不清本地旧 Key**，
   *     用户不会因为一次失败就彻底没服务（`rotateKey` 内部保证，这里只负责接住结果）。
   *  2. `rotateBusy` 期间按钮置灰：连点不会在服务端产生多条重置。
   *  3. 成功后立刻用响应里的额度档案刷新余额显示（不用等用户再点「刷新额度」）；
   *     响应没带额度档案时主动去查一次 /me，并把旧的 Key 探测结果清掉（留着会误导）。
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
  /**
   * 邮箱入口要不要出现（#421）：只有探测成功才出现。
   * `disabled` = 服务端没开邮箱功能（404 `not_found`），生产现在就是这个状态。
   */
  const emailEntryVisible = shouldShowEmailEntry(emailStatus)
  /** 已绑判定同样是三态：只有服务端明确说 `true` 才算；`null`（老服务端）按未开启处理 */
  const emailBound = (emailStatus.kind === 'ok' && emailStatus.hasEmail === true) || profile?.hasEmail === true
  const emailMasked = emailStatus.kind === 'ok' ? emailStatus.emailMasked : profile?.emailMasked ?? null
  /**
   * 冲突弹窗里的「本机原账号剩余额度」（#421 第 3 点要求必须展示数字）。
   * 服务端没回这个字段时给「—」：既不编造成 0（0 = 用完了，是另一个意思），
   * 也不把整行藏掉 —— 用户看不到数字就不知道切过去会失去多少。
   */
  const emailConflictPointsText =
    emailConflict === null || emailConflict.deviceRemainingPoints === null
      ? '—'
      : formatPoints(emailConflict.deviceRemainingPoints, t('oursPointsUnit'))

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
          {/* #421 第 5 点：已绑邮箱的用户不再提示「复制设备码备份」——账号可以靠邮箱找回 */}
          {showBackupHint && !emailBound ? (
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
              {claim.outcome === 'granted'
                ? t('oursClaimOk', { points: formatPoints(claim.points, t('oursPointsUnit')) })
                : t(claimMessageKeyFor(claim.outcome))}
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

        {/* 1a. 邮箱账号（#421）：探测成功才出现；已绑显示脱敏邮箱，未绑显示「绑定邮箱」。
            服务端未开启时（404 not_found）整块不渲染，旧流程一字不动。 */}
        {emailEntryVisible ? (
          <section className={styles.section} data-testid="ours-email">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{t('oursEmailTitle')}</h3>
              {emailBound || emailFormOpen ? null : (
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.sectionAction}
                  data-testid="ours-email-bind"
                  onClick={() => {
                    setEmailFormOpen(true)
                    setEmailResult(null)
                  }}
                >
                  {t('oursEmailBindAction')}
                </Button>
              )}
            </div>
            <div className={styles.hint}>{t('oursEmailDescription')}</div>
            {emailBound ? (
              <div className={styles.value} data-testid="ours-email-masked">
                {emailMasked ?? ''}
              </div>
            ) : null}
            {emailFormOpen && !emailBound ? (
              <>
                <div className={styles.redeemForm}>
                  <input
                    className={styles.input}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="ours-email-input"
                    placeholder={t('oursEmailInputPlaceholder')}
                    aria-label={t('oursEmailInputPlaceholder')}
                    value={emailInput}
                    disabled={emailBusy !== null}
                    onChange={(event) => setEmailInput(event.target.value)}
                  />
                  <Button
                    size="m"
                    data-testid="ours-email-send"
                    disabled={emailBusy !== null || emailCooldownLeft > 0 || !isEmailShape(emailInput)}
                    onClick={() => void submitEmailSend()}
                  >
                    {emailBusy === 'send'
                      ? t('oursEmailSendBusy')
                      : emailCooldownLeft > 0
                        ? t('oursEmailSendCountdown', { seconds: emailCooldownLeft })
                        : t('oursEmailSendAction')}
                  </Button>
                </div>
                {emailSent ? (
                  <div className={styles.hint} data-testid="ours-email-sent">
                    {t('oursEmailSentHint')}
                  </div>
                ) : null}
                <div className={styles.redeemForm}>
                  <input
                    className={styles.input}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="ours-email-code"
                    placeholder={t('oursEmailCodePlaceholder')}
                    aria-label={t('oursEmailCodePlaceholder')}
                    value={emailCode}
                    disabled={emailBusy !== null}
                    onChange={(event) => setEmailCode(event.target.value)}
                  />
                  <Button
                    size="m"
                    data-testid="ours-email-verify"
                    disabled={emailBusy !== null || !isEmailCodeShape(emailCode)}
                    onClick={() => void submitEmailVerify()}
                  >
                    {emailBusy === 'verify' ? t('oursEmailVerifyBusy') : t('oursEmailVerifyAction')}
                  </Button>
                </div>
                {emailCode !== '' && !isEmailCodeShape(emailCode) ? (
                  <div className={styles.hint}>{t('oursEmailCodeShapeHint')}</div>
                ) : null}
              </>
            ) : null}
            {/* #421 第 3 点：登录冲突弹窗（device_has_account）。验证码此时没被消耗，
                选完带同一个验证码 + choice 重发（见 submitEmailVerify）。 */}
            {emailConflict !== null ? (
              <div data-testid="ours-email-conflict">
                <div className={styles.value} data-testid="ours-email-conflict-title">
                  {t('oursEmailConflictTitle')}
                </div>
                {emailConflict.emailMasked === null ? null : (
                  <div className={styles.hint} data-testid="ours-email-conflict-masked">
                    {t('oursEmailConflictEmail', { masked: emailConflict.emailMasked })}
                  </div>
                )}
                <div className={styles.value} data-testid="ours-email-conflict-points">
                  {t('oursEmailConflictPoints', { points: emailConflictPointsText })}
                </div>
                <div className={styles.hint} data-testid="ours-email-conflict-warning">
                  {t('oursEmailConflictWarning')}
                </div>
                <div className={styles.actions}>
                  {emailConflict.options.includes('use_email') ? (
                    <Button
                      size="m"
                      data-testid="ours-email-conflict-use-email"
                      disabled={emailBusy !== null}
                      onClick={() => void submitEmailVerify('use_email')}
                    >
                      {emailBusy === 'verify'
                        ? t('oursEmailVerifyBusy')
                        : t('oursEmailConflictUseEmail')}
                    </Button>
                  ) : null}
                  {emailConflict.options.includes('keep_device') ? (
                    <Button
                      variant="outlined"
                      size="m"
                      data-testid="ours-email-conflict-keep-device"
                      disabled={emailBusy !== null}
                      onClick={() => void submitEmailVerify('keep_device')}
                    >
                      {t('oursEmailConflictKeepDevice')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {emailResult !== null ? (
              <div
                role="status"
                data-testid="ours-email-result"
                className={clsx(
                  styles.value,
                  emailResult.kind === 'error' ? styles.valueError : styles.valueSuccess
                )}
              >
                {emailResult.kind === 'error'
                  ? [
                      t(emailResult.messageKey),
                      emailResult.retryAfter === null
                        ? ''
                        : // 有倒计时时用**实时剩余**秒数，静态数字过了几秒就不对了
                          t('oursEmailRetryAfter', {
                            seconds: emailCooldownLeft > 0 ? emailCooldownLeft : emailResult.retryAfter,
                          }),
                      emailResult.attemptsLeft === null
                        ? ''
                        : t('oursEmailAttemptsLeft', { attempts: emailResult.attemptsLeft }),
                      emailResult.boundEmailMasked === null
                        ? ''
                        : t('oursEmailBoundMaskedHint', { masked: emailResult.boundEmailMasked }),
                    ]
                      .filter((part) => part !== '')
                      .join(' ')
                  : emailResult.action === 'login'
                    ? t('oursEmailLoginOk')
                    : t(emailResult.successKey)}
              </div>
            ) : null}
          </section>
        ) : null}

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

        {/* 1c. 重置额度 / 更换 Key（#90 #357）：只认设备码；仍保留二次确认，避免误点 */}
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
              data-rotate-mode={rotateResult.kind === 'ok' ? rotateResult.mode : undefined}
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

        {/* 4. 购买（Issue #331）：套餐全线下架，入口直接打开联动小铺收款页，不再渲染套餐卡片 */}
        <section className={styles.section} data-testid="ours-plans">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursPayTitle')}</h3>
          </div>
          <div className={styles.hint} data-testid="ours-plans-empty">
            {t('oursPayEmpty')}
          </div>
          <div className={styles.actions}>
            <Button
              size="m"
              data-testid="ours-buy"
              disabled={payLink.status === 'busy'}
              onClick={() => void openPay()}
            >
              {payLink.status === 'busy' ? t('oursPayBusy') : t('oursPayAction')}
            </Button>
          </div>
          <div
            role="status"
            className={clsx(styles.hint, payLink.status === 'error' && styles.valueError)}
            data-testid="ours-pay-notice"
          >
            {payLink.status === 'error' ? t(payLink.messageKey) : t('oursPayHint')}
          </div>
        </section>

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
