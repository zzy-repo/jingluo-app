// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage，零浏览器、零真实网络） | 耗时: <2s]
//
// Issue #451（#374 的收尾第 1、2 项）：
//
//   [1] Key 身份：设置 →「我们的渠道」要能看出这把 Key **什么时候绑的 / 最后一次确认可用是什么时候**，
//       好让用户判断「是不是这把 Key 出问题」。服务端额度接口没有这两个字段，所以是本机记录
//       （`services/invite/keyIdentity.ts`）：按 Key 短指纹存，换 Key 自动作废，Key 原文一个字不落盘。
//   [2] 发送前本地拦截：Key **有、但格式明显不对**（空 / 含空格换行 / 长度异常）时，在发送入口就拦下来
//       并打开设置说明原因，而不是发一次注定 401 的请求；「本来就没填 Key」那条既有路径一个字不改。
//   [3] 第 3 项（/rotate 文案联动）的文案断言也在这里：`rotated` 档不再写 #90 时代的
//       「换 Key 时旧 Key 会立即作废」（#357 之后 /rotate 只原地重算额度，不换 Key）。
//
//   node --test tests/unit/key-identity-451.test.mjs
//   node tests/run-layer.mjs unit --only key-identity-451
//
// 判据不自己编：拦截与失败细分共用 #374 的 `isKeyFormatInvalid`，本用例显式锁住「两边同一口径」。
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatBridge, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

installChatBridge()
installEndpointsGlobals()
const dom = setupDom()

const identity = await import('../../src/services/invite/keyIdentity.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const dialogState = await import('../../src/components/settings/settingsDialogState.ts')
const { isKeyFormatInvalid } = await import('../../src/services/api/keyFailure.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

/** 一把正常的 Key（尾号 abcd，长度过 MIN_KEY_CHARS） */
const GOOD_KEY = 'sk-live-0123456789abcd'
/** 换一把：长度相同、内容不同（验证「换 Key 就不再是同一把」） */
const OTHER_KEY = 'sk-live-0123456789wxyz'
/** 首尾带换行的 Key：粘贴时最常见的一种坏法（trim 后长度是够的，所以不会被「空 / 太短」掩盖） */
const NEWLINE_KEY = 'sk-live-0123456789abcd\n'

const T0 = Date.UTC(2026, 10, 20, 3, 20) // 2026-11-20 11:20 (Asia/Shanghai)
const MINUTE = 60_000

// ------------------------------------------------------------------ [1] 身份记录：纯逻辑

test('[1] 指纹：同一把 Key 恒定、换一把必变，且记录里不含 Key 原文', () => {
  const a = identity.keyFingerprint(GOOD_KEY)
  assert.equal(identity.keyFingerprint(GOOD_KEY), a, '同一把 Key 两次取指纹必须一致')
  assert.equal(identity.keyFingerprint(`  ${GOOD_KEY}  `), a, '首尾空白不影响身份（setApiKey 会 trim）')
  assert.notEqual(identity.keyFingerprint(OTHER_KEY), a, '换一把 Key 指纹必须变，否则旧时间会挂到新 Key 上')
  assert.equal(identity.keyFingerprint(''), '', '没有 Key 就没有身份')
  assert.equal(identity.keyFingerprint(null), '', 'null 同理')
  // 指纹会进 localStorage：绝不允许能反推出 Key（不出现任何长片段）
  assert.equal(a.includes(GOOD_KEY.slice(0, 8)), false, `指纹不能包含 Key 片段：${a}`)
  assert.match(a, /^[0-9a-f]+-\d+$/, '指纹 = 哈希-长度')
})

test('[1] 表驱动：写入 / 成功 / 解析 / 视图 四种时机各是什么结果', () => {
  const first = identity.identityOnKeyWrite(null, GOOD_KEY, T0)
  assert.deepEqual(first, { fingerprint: identity.keyFingerprint(GOOD_KEY), boundAt: T0, lastSuccessAt: null })

  // 同一把 Key 再保存一次：绑定时间**不刷新**（点两次保存不等于换了两次 Key）
  const again = identity.identityOnKeyWrite(first, GOOD_KEY, T0 + MINUTE)
  assert.equal(again?.boundAt, T0, '重复保存同一把 Key 不能把绑定时间往后推')
  assert.equal(again?.lastSuccessAt, null, '重复保存不制造「成功」记录')

  // 换一把：绑定时间跟着变，成功时间清空（新 Key 还没有成功过）
  const switched = identity.identityOnKeyWrite(first, OTHER_KEY, T0 + 5 * MINUTE)
  assert.equal(switched?.boundAt, T0 + 5 * MINUTE)
  assert.equal(switched?.lastSuccessAt, null)
  assert.notEqual(switched?.fingerprint, first?.fingerprint)

  // 清空 Key：记录一起删（留着旧时间只会误导）
  assert.equal(identity.identityOnKeyWrite(first, '', T0 + 6 * MINUTE), null)

  // 成功：只更新成功时间，绑定时间不动
  const success = identity.identityOnSuccess(first, GOOD_KEY, T0 + 30 * MINUTE)
  assert.equal(success?.boundAt, T0, '成功不改变绑定时间')
  assert.equal(success?.lastSuccessAt, T0 + 30 * MINUTE)

  // 没有记录 / 记录是上一把 Key 的：以这次成功为起点（更早的时间我们不知道，不编）
  const cold = identity.identityOnSuccess(null, GOOD_KEY, T0 + 40 * MINUTE)
  assert.deepEqual(cold, {
    fingerprint: identity.keyFingerprint(GOOD_KEY),
    boundAt: T0 + 40 * MINUTE,
    lastSuccessAt: T0 + 40 * MINUTE,
  })
  assert.equal(identity.identityOnSuccess(first, '', T0), null, '没有 Key 时不写空记录')

  // 解析：坏数据一律当「没有记录」，绝不补一个 1970 年的默认值
  const raw = identity.serializeKeyIdentity(first)
  assert.deepEqual(identity.parseKeyIdentity(raw), first, '写进去什么就读出什么')
  for (const bad of ['', '   ', 'not json', '[]', '{}', '{"f":"","b":1}', '{"f":"x","b":0}', '{"f":"x"}']) {
    assert.equal(identity.parseKeyIdentity(bad), null, `坏数据必须当没有记录：${bad}`)
  }
  // 成功时间为 0 / 非数字 → 视为「还没有成功记录」，而不是「1970 年成功过」
  assert.deepEqual(identity.parseKeyIdentity('{"f":"ab-12","b":1000,"s":0}'), {
    fingerprint: 'ab-12',
    boundAt: 1000,
    lastSuccessAt: null,
  })
})

test('[1] 视图三态：没有记录 / 记录是上一把 Key 的 → 都说「没有」，绝不借用别人的时间', () => {
  assert.deepEqual(identity.keyIdentityView(null, GOOD_KEY), { kind: 'none' })
  const record = identity.identityOnSuccess(null, OTHER_KEY, T0)
  assert.deepEqual(
    identity.keyIdentityView(record, GOOD_KEY),
    { kind: 'none' },
    '本地记录还是上一把 Key 的：不能把它的绑定时间挂到当前 Key 上'
  )
  assert.deepEqual(identity.keyIdentityView(record, ''), { kind: 'none' }, '没有 Key 就没有身份可谈')

  const mine = identity.identityOnSuccess(null, GOOD_KEY, T0)
  assert.deepEqual(identity.keyIdentityView(mine, GOOD_KEY), {
    kind: 'record',
    tail: 'abcd',
    boundAt: T0,
    lastSuccessAt: T0,
  })
  // 太短的「Key」一个字符都不回显（与 #374 的 keyTail 同一口径）
  const short = identity.identityOnSuccess(null, 'sk-short', T0)
  assert.equal(identity.keyIdentityView(short, 'sk-short').tail, '', '太短的 Key 不回显尾号')
})

test('[1] 时间格式：YYYY-MM-DD HH:mm（本机时区），非法值返回空串而不是 NaN', () => {
  const at = new Date(2026, 10, 20, 9, 5).getTime() // 本机时区 2026-11-20 09:05
  assert.equal(identity.formatIdentityTime(at), '2026-11-20 09:05')
  for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(identity.formatIdentityTime(bad), '', `非法时间必须返回空串：${String(bad)}`)
  }
})

// ------------------------------------------------------------------ [1] 落盘：真的走 localStorage

test('[1] 真跑 apiConfig：绑定时间落盘、重复保存不刷新、换 Key 重新记账、清空即删除', () => {
  dom.localStorage.clear()
  apiConfig.setApiKey(GOOD_KEY)
  const bound = apiConfig.getCurrentKeyIdentity()
  assert.equal(bound.kind, 'record')
  assert.equal(bound.kind === 'record' && bound.tail, 'abcd', '界面上要显示尾号，方便确认是哪一把')
  const boundAt = bound.kind === 'record' ? bound.boundAt : 0
  assert.ok(boundAt > 0, '绑定时间必须是真的时间戳')
  assert.equal(bound.kind === 'record' && bound.lastSuccessAt, null, '刚写入时还没有成功记录')

  // 同一把 Key 再保存：绑定时间不刷新
  apiConfig.setApiKey(GOOD_KEY)
  const again = apiConfig.getCurrentKeyIdentity()
  assert.equal(again.kind === 'record' && again.boundAt, boundAt, '重复保存不能改绑定时间')

  // 记一次成功：成功时间到位，绑定时间仍然不动
  const successAt = boundAt + MINUTE
  assert.equal(apiConfig.recordKeySuccess(GOOD_KEY, successAt), true)
  const afterSuccess = apiConfig.getCurrentKeyIdentity()
  assert.equal(afterSuccess.kind === 'record' && afterSuccess.lastSuccessAt, successAt)
  assert.equal(afterSuccess.kind === 'record' && afterSuccess.boundAt, boundAt)

  // 换一把 Key：旧记录作废，新记录从这一刻起算、成功时间清空
  apiConfig.setApiKey(OTHER_KEY)
  const switched = apiConfig.getCurrentKeyIdentity()
  assert.equal(switched.kind, 'record')
  assert.equal(switched.kind === 'record' && switched.tail, 'wxyz')
  assert.equal(switched.kind === 'record' && switched.lastSuccessAt, null, '换 Key 之后不能继承上一把的成功时间')
  assert.ok(
    switched.kind === 'record' && switched.boundAt >= boundAt,
    '新 Key 的绑定时间必须是这次写入的时间（而不是上一把的）'
  )

  // 清空 Key：连记录一起删，界面上不会剩一条孤儿时间
  apiConfig.setApiKey('')
  assert.equal(apiConfig.getKeyIdentity(), null)
  assert.deepEqual(apiConfig.getCurrentKeyIdentity(), { kind: 'none' })
  assert.equal(apiConfig.recordKeySuccess(), false, '没有 Key 时什么都不写')
})

// ------------------------------------------------------------------ [2] 发送前本地拦截

test('[2] checkApiKeyBeforeSend 三态与 #374 同源：本地能判死的才拦，判不死的放行', () => {
  dom.localStorage.clear()
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'missing', '没填 Key → missing（既有路径）')

  apiConfig.setApiKey('   ')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'missing', '只有空白也当没填，而不是「格式错」')

  for (const bad of ['sk-live 0123456789abcd', 'sk-short', `sk-${'x'.repeat(600)}`]) {
    apiConfig.setApiKey(bad)
    assert.equal(isKeyFormatInvalid(bad), true, `#374 判它是格式问题：${JSON.stringify(bad)}`)
    assert.equal(
      apiConfig.checkApiKeyBeforeSend(),
      'format',
      `格式明显不对就必须在发送前拦下：${JSON.stringify(bad)}`
    )
  }

  // 首尾带换行的 Key：`setApiKey` 会 trim，所以这种值只可能来自**历史/导入**的本地存储。
  // 拦截读的是存储原文，所以这条真实存在的老数据照样拦得住。
  dom.localStorage.setItem('chat-demo:api-key', NEWLINE_KEY)
  assert.equal(apiConfig.getApiKey(), NEWLINE_KEY, '存储里是什么就读到什么（不偷偷 trim）')
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'format', '历史遗留的带换行 Key 也要在发送前拦下')

  apiConfig.setApiKey(GOOD_KEY)
  assert.equal(isKeyFormatInvalid(GOOD_KEY), false)
  assert.equal(apiConfig.checkApiKeyBeforeSend(), 'ok', '正常 Key 一律放行，不多做判断')
})

test('[2] ensureApiKey：合法放行 / 没填走既有路径 / 格式错才拦并带原因', () => {
  dom.localStorage.clear()

  // ① 合法：放行，且不打开设置
  apiConfig.setApiKey(GOOD_KEY)
  dialogState.closeSettings()
  assert.equal(dialogState.ensureApiKey(), true, '有合法 Key 必须放行')
  assert.equal(dialogState.useSettingsDialog.getState().open, false, '不该顺手把设置弹窗打开')

  // ② 没填：既有路径（打开设置 + 选中「数据管理」），但**不能**戴上「格式不对」的帽子
  apiConfig.setApiKey('')
  dialogState.closeSettings()
  assert.equal(dialogState.ensureApiKey(), false)
  const missing = dialogState.useSettingsDialog.getState()
  assert.equal(missing.open, true, '没填 Key 时打开设置（#374 之前就有的行为）')
  assert.equal(missing.section, 'data', 'Key 在「数据管理」分组里')
  assert.equal(missing.apiKeyFormatBlocked, false, '「没填」与「格式错」必须分开说')

  // ③ 格式错：拦下 + 跳转设置 + 说明原因（这条消息根本没发出去）
  apiConfig.setApiKey('sk-live 0123456789abcd') // 中间混进一个空格：粘贴时就坏了，本地能判
  dialogState.closeSettings()
  assert.equal(dialogState.ensureApiKey(), false, '格式不对必须在发送前拦下，不浪费一次 401')
  const blocked = dialogState.useSettingsDialog.getState()
  assert.equal(blocked.open, true, '要跳转到设置让人就地改正')
  assert.equal(blocked.section, 'data')
  assert.equal(blocked.apiKeyFormatBlocked, true, '设置页要知道这次是「被拦下来的」')

  // 修好 Key（保存成功路径）→ 提示撤掉；直接关掉弹窗也会撤
  dialogState.clearApiKeyFormatBlocked()
  assert.equal(dialogState.useSettingsDialog.getState().apiKeyFormatBlocked, false, '修好后提示必须撤掉')
  assert.equal(dialogState.ensureApiKey(), false)
  dialogState.closeSettings()
  assert.equal(
    dialogState.useSettingsDialog.getState().apiKeyFormatBlocked,
    false,
    '关掉设置即清，别留一条挂着的僵尸提示'
  )
  // 关掉之后 Key 依然是坏的 → 下次发送还会被拦（不是「关一次就放过」）
  assert.equal(dialogState.ensureApiKey(), false)
  assert.equal(dialogState.useSettingsDialog.getState().apiKeyFormatBlocked, true)
})

// ------------------------------------------------------------------ [3] 文案：新 key 成对 + 旧语义清掉

test('[3] 新增文案中英成对、占位符对齐、真的翻译了', () => {
  const keys = [
    'settingsApiKeyFormatBlocked',
    'settingsApiKeyFormatHint',
    'oursKeyIdentityTitle',
    'oursKeyIdentityTail',
    'oursKeyIdentityTailUnknown',
    'oursKeyIdentityBoundAt',
    'oursKeyIdentityLastSuccess',
    'oursKeyIdentityNoSuccess',
    'oursKeyIdentityNoRecord',
    'oursKeyIdentitySource',
    'oursKeyIdentitySuccessSource',
  ]
  const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',')
  for (const key of keys) {
    const zhText = zh[key]
    const enText = en[key]
    assert.equal(typeof zhText, 'string', `zh 缺 key：${key}`)
    assert.equal(typeof enText, 'string', `en 缺 key：${key}`)
    assert.ok(zhText.trim() !== '' && enText.trim() !== '', `空文案会让界面出现空块：${key}`)
    assert.notEqual(zhText, enText, `英文没真的翻译：${key}`)
    assert.equal(placeholders(zhText), placeholders(enText), `占位符不对齐：${key}`)
  }
  // 两个关键提示必须说清「这件事的后果」，不能只有一句「格式不对」
  assert.match(zh.settingsApiKeyFormatBlocked, /没有发出去/, '要说清消息没发出去，否则用户只会重发')
  assert.match(en.settingsApiKeyFormatBlocked, /not sent/, '同上（英文侧）')
  assert.match(zh.oursKeyIdentityBoundAt, /\{time\}/, '绑定时间必须带时间占位符')
  assert.match(zh.oursKeyIdentityLastSuccess, /\{time\}/, '最近成功时间必须带时间占位符')
})

test('[3] /rotate 文案联动：rotated 档不再写 #90 的「换 Key 就旧 Key 立即作废」', () => {
  // #357 之后 /rotate 是「原地重置额度、Key 不变」，所以「被轮换」不再是用户点出来的
  for (const text of [zh.replyApiKeyRotated, en.replyApiKeyRotated]) {
    assert.equal(/立即作废/.test(text), false, `旧语义必须清掉：${text}`)
    assert.equal(/immediately/.test(text), false, `旧语义必须清掉（英文侧）：${text}`)
  }
  // 新文案要把「重置额度不换 Key」这件事说清，并给出可走的两条路
  assert.match(zh.replyApiKeyRotated, /重置额度/, '要说清「重置额度」不换 Key')
  assert.match(zh.replyApiKeyRotated, /不换 Key/)
  assert.match(en.replyApiKeyRotated, /does not change the key|keeps the same key/, '英文侧同上')
  // 失败时的另一条文案（TTS 等路径）也不再只说「请更换后重试」，而是给出取回本机 Key 的路
  assert.match(zh.apiKeyInvalidRetry, /重置额度/)
  assert.equal(translate('replyApiKeyRotated').includes('立即作废'), false, 'translate() 拿到的就是新文案')
})
