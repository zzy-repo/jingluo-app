// [layer: unit | 依赖: 无（纯 Node，假 transport，零网络） | 耗时: <1s]
//
// L0-1 / L0-2（#487 阶段③ 并行补基准，方案见 `docs/testing/rebuild-plan.md` §3）：
// `src/services/consume/errors.ts` 的**信封分派**与**错误码 → i18nKey 映射**。
//
// 为什么这两件事放同一个文件：它们是同一个出口的两半 —— `parseSub2ApiError()` 先决定「这是哪套信封」，
// 再拿信封里取出的码去查映射表；分派错了或映射缺了，用户看到的都是同一句错的文案。
//
// 输入全部是**实测响应体**（`tests/fixtures/consume/*.json`，2026-11-20 只读探测，`_meta` 里带采集记录）：
//   · 用户 401 `{code:"UNAUTHORIZED"}` / admin 401（同码不同 message）
//   · 429 `{error:"rate limit exceeded"}` —— **没有 code 字段**
//   · 网关 `{error:{message,type}}` —— `error` 里**只有 type、没有 code**
//   · 未知路径 404：**`text/plain` 的 `404 page not found`**（对 JSON.parse 会抛）
//   · 面板 `{code:<整数>, message, reason?}` —— `reason` 优先于整数 code
// 取不到的形状（例如枚举 §4.1 里客户端该覆盖、但实测没抓到的码）由 `jsonRaw()` 拼，
// 拼法照 `docs/sub2api-client-contract.md` §4 的信封定义，**不自己发明字段**。
//
// 覆盖（每行注释标明它盯的是哪种信封 / 哪条映射）：
//   E1 用户 401 → middleware 信封（不是面板整数 code）      E2 admin 401 → 与 E1 结论**完全一致**（不看 message）
//   E3 429 → error_string 信封 + Retry-After 秒数           E4 网关 → gateway 信封，码从 `type` 取
//   E5 未知路径 404 → text 信封，**不 JSON.parse、不抛**     E6 面板 → panel 信封，reason 优先
//   M0 映射表全量：每个码都映射到**存在的** i18n key（zh + en）
//   M1–M7 会话 / 余额 / 限流 / 卡密三态 / 邀请未开 六条高价值码（§4.1 点名要在表里）
//   M8 `EMAIL_VERIFY_REQUIRED` 已在表里 → 具体文案 + **不记缺口**；真正的表外码仍记缺口走兜底
//   M9 面板整数 code 无 reason → `HTTP_<status>` 占位，不把 404 当业务码
//
// 缺口 2 已修（PR #512 记录的）：`EMAIL_VERIFY_REQUIRED` 补进 `CONSUME_ERROR_KEYS`
// → `consumeErrEmailVerifyRequired`（zh「请先完成邮箱验证」/ en「Please verify your email first」）。
// M8 因此从「锁表里没有」翻成「锁表里有」，并把「表外码记缺口」这条覆盖挪到真正的表外码上。
//
//   node --test tests/unit/consume-errors-envelope.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { failureRaw, jsonRaw, loadFixture, rawFromFixture, textRaw } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { CONSUME_ERROR_KEYS, isRedeemLocked, isRedeemUsed, isSessionError, parseSub2ApiError, resetConsumeGaps, unmappedConsumeCodes } =
  await import('../../src/services/consume/errors.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** `kind` 只允许是**语义**类别（#484 §四口径 + `network` / `bad_request` 两个客户端补给项） */
const KINDS = ['auth', 'quota', 'rate_limit', 'redeem', 'key', 'server', 'network', 'bad_request', 'unknown']

/** 取一份 fixture 的实测变体（`_meta.variants_observed`：admin 401 / 网关 401 的原话都在里面） */
const variantsOf = (name) => loadFixture(name).meta.variants_observed ?? []
/** 一行 = 一条「哪种信封 → 归一成什么」 */
const ENVELOPE_ROWS = [
  {
    id: 'E1',
    what: '用户 401 {code:"UNAUTHORIZED"} → middleware 信封（不是面板整数 code），会话类错误',
    run: () => {
      const error = parseSub2ApiError(rawFromFixture('error-401.json'))
      assert.equal(error.envelope, 'middleware')
      assert.equal(error.kind, 'auth')
      assert.equal(error.code, 'UNAUTHORIZED')
      assert.equal(error.status, 401)
      assert.equal(error.retryable, false, '业务失败（401）重试只会更糟')
      assert.equal(error.i18nKey, 'consumeErrUnauthorized')
      assert.equal(isSessionError(error), true, 'W1-B 据此决定是否 refresh')
    },
  },
  {
    id: 'E2',
    what: 'admin 401：code 相同、message 不同（"Authorization required"）→ 结论必须与 E1 完全一致',
    run: () => {
      const admin = variantsOf('error-401.json').find((item) => item.trigger.startsWith('/api/v1/admin'))
      assert.ok(admin, 'fixture 里应当记录 admin 401 变体')
      const user = parseSub2ApiError(rawFromFixture('error-401.json'))
      const variant = parseSub2ApiError(jsonRaw(admin.status ?? 401, { code: admin.code, message: admin.message }))
      assert.notEqual(admin.message, user.message, '两个变体的 message 确实不同')
      assert.equal(variant.envelope, user.envelope)
      assert.equal(variant.kind, user.kind)
      assert.equal(variant.code, user.code)
      assert.equal(variant.i18nKey, user.i18nKey, '只按 code 分支：message 不许影响结论（否则 admin 路径静默失效）')
    },
  },
  {
    id: 'E3',
    what: '429 {error:"rate limit exceeded"} 没有 code → error_string 信封 + Retry-After 秒数',
    run: () => {
      const { meta, body } = loadFixture('error-429.json')
      assert.equal(body.code, undefined, '实测 429 没有 code：任何 if (body.code === "RATE_LIMITED") 都不会触发')
      assert.equal(typeof body.error, 'string')
      const error = parseSub2ApiError(
        rawFromFixture('error-429.json', { status: 429, headers: { 'retry-after': meta.retry_after_header } })
      )
      assert.equal(error.envelope, 'error_string')
      assert.equal(error.kind, 'rate_limit')
      assert.equal(error.code, 'HTTP_429', '没有服务端码时用状态码占位，不编一个假的码')
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterMs, Number(meta.retry_after_header) * 1000, '倒计时按服务端秒数，客户端不自己算节奏')
      assert.equal(error.i18nKey, 'consumeErrRateLimited')
    },
  },
  {
    id: 'E4',
    what: '网关 {error:{message,type}} 只有 type 没有 code → gateway 信封，码从 error.type 取',
    run: () => {
      const error = parseSub2ApiError(rawFromFixture('local-gateway-403-permission.json', { status: 403 }))
      assert.equal(error.envelope, 'gateway')
      assert.equal(error.code, 'permission_error', 'error.code 缺失时退回 error.type')
      assert.equal(error.kind, 'key')
      assert.equal(error.retryable, false)
      assert.equal(error.i18nKey, 'consumeErrGroupNotAllowed')
      assert.ok(error.message.length > 0, '原始 message 只用于排查，但必须留下')
    },
  },
  {
    id: 'E5',
    what: '未知路径 404 是 text/plain "404 page not found" → text 信封，**不许 JSON.parse 抛**',
    run: () => {
      const { meta, file } = loadFixture('error-404-unknown-path.json')
      assert.equal(meta.content_type, 'text/plain')
      const raw = { status: 404, ok: false, text: String(file._raw_text_body), json: null, headers: {}, contentType: 'text/plain' }
      const error = parseSub2ApiError(raw)
      assert.equal(error.envelope, 'text')
      assert.equal(error.nonJson, true, '调用方据此知道「不要指望有 code」')
      assert.match(error.message, /404 page not found/)
      assert.equal(error.code, 'HTTP_404')
      assert.equal(error.kind, 'unknown')
      assert.equal(error.retryable, false)
      // 另外三种「根本不是 JSON」的体也必须不抛：HTML 502 页 / 空 body / 超时（没拿到响应）
      const html502 = parseSub2ApiError(textRaw(502, '<html><body>502 Bad Gateway</body></html>', 'text/html'))
      assert.equal(html502.kind, 'server')
      assert.match(html502.message, /502 Bad Gateway/, '非 JSON 原文截进 message 供排查')
      assert.equal(html502.i18nKey, 'consumeErrServerUnavailable')
      const emptyBody = parseSub2ApiError(textRaw(500, '', 'text/plain'))
      assert.equal(emptyBody.kind, 'server')
      assert.equal(emptyBody.message, '', '空 body 就是没有 message（**如实留空**，不编一句假的）')
      assert.equal(emptyBody.i18nKey, 'consumeErrServerUnavailable', '上屏文案只来自 i18nKey，不靠 message')
      const timedOut = parseSub2ApiError(failureRaw('timeout'))
      assert.equal(timedOut.kind, 'network')
      assert.equal(timedOut.code, 'TIMEOUT')
      assert.equal(timedOut.retryable, true)
      assert.equal(timedOut.i18nKey, 'consumeErrTimeout')
      for (const sample of [html502, emptyBody, timedOut]) {
        assert.ok(KINDS.includes(sample.kind), `${sample.kind} 必须是语义类别`)
      }
    },
  },
  {
    id: 'E6',
    what: '面板 {code:404,reason:"REDEEM_CODE_NOT_FOUND"} → panel 信封，reason 优先于整数 code',
    run: () => {
      const { body } = loadFixture('local-redeem-404.json')
      assert.equal(typeof body.code, 'number')
      assert.equal(body.reason, 'REDEEM_CODE_NOT_FOUND')
      const error = parseSub2ApiError(rawFromFixture('local-redeem-404.json', { status: 404 }))
      assert.equal(error.envelope, 'panel')
      assert.equal(error.reason, 'REDEEM_CODE_NOT_FOUND')
      assert.equal(error.code, 'REDEEM_CODE_NOT_FOUND', '业务码优先，不许把 404 当码')
      assert.equal(error.kind, 'redeem')
      assert.equal(error.i18nKey, 'consumeErrCardNotFound')
    },
  },
]

/** 一行 = 一个服务端码 → 一条界面上该显示的文案 key（`reason` / `code` 共用一张表） */
const MAPPING_ROWS = [
  {
    id: 'M0',
    what: '映射表全量：每个码都映射到 zh + en 都存在、且非空的 i18n key（表里不许留死 key）',
    run: () => {
      const entries = Object.entries(CONSUME_ERROR_KEYS)
      assert.ok(entries.length >= 40, `映射表条目数异常（${entries.length}），覆盖口径被削过？`)
      for (const [code, mapped] of entries) {
        assert.ok(KINDS.includes(mapped.kind), `${code} 的 kind ${mapped.kind} 不在语义枚举里`)
        for (const [locale, dict] of [['zh', zh], ['en', en]]) {
          const text = dict[mapped.i18nKey]
          assert.equal(typeof text, 'string', `${locale} 缺 ${code} → ${mapped.i18nKey}`)
          assert.notEqual(text.trim(), '', `${locale} 的 ${mapped.i18nKey} 是空文案`)
        }
      }
    },
  },
  {
    id: 'M1',
    what: 'INVALID_TOKEN（401）→ consumeErrUnauthorized（会话失效，先 refresh 再引导登录）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(401, { code: 'INVALID_TOKEN', message: 'Invalid token' }))
      assert.equal(error.kind, 'auth')
      assert.equal(error.i18nKey, 'consumeErrUnauthorized')
      assert.equal(isSessionError(error), true)
    },
  },
  {
    id: 'M2',
    what: 'INSUFFICIENT_BALANCE → consumeErrInsufficientBalance（USD 余额不足，不是「额度用完」）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(402, { code: 'INSUFFICIENT_BALANCE', message: 'insufficient balance' }))
      assert.equal(error.kind, 'quota')
      assert.equal(error.i18nKey, 'consumeErrInsufficientBalance')
      assert.notEqual(error.i18nKey, 'consumeErrKeyQuotaExhausted', '账户余额 ≠ 单把 Key 的额度：两条文案不许合并')
    },
  },
  {
    id: 'M3',
    what: 'RATE_LIMITED（429 带码）→ consumeErrRateLimited，且 retryable（界面可以倒计时重试）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(429, { code: 'RATE_LIMITED', message: 'too many requests' }))
      assert.equal(error.kind, 'rate_limit')
      assert.equal(error.i18nKey, 'consumeErrRateLimited')
      assert.equal(error.retryable, true)
      assert.equal(error.code, 'RATE_LIMITED')
    },
  },
  {
    id: 'M4',
    what: 'REDEEM_CODE_USED → consumeErrCardUsed（可能是自己上次成功 → 文案要提示核对余额）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(409, { code: 409, message: 'code already used', reason: 'REDEEM_CODE_USED' }))
      assert.equal(error.kind, 'redeem')
      assert.equal(error.i18nKey, 'consumeErrCardUsed')
      assert.equal(isRedeemUsed(error), true, 'redeem.ts 靠它走「先查历史」而不是直接判失败')
      assert.equal(error.retryable, false)
    },
  },
  {
    id: 'M5',
    what: 'REDEEM_CODE_LOCKED → consumeRedeemProcessing（「正在处理」不是失败，禁止提示换卡）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(409, { code: 409, message: 'code is locked', reason: 'REDEEM_CODE_LOCKED' }))
      assert.equal(error.i18nKey, 'consumeRedeemProcessing')
      assert.equal(isRedeemLocked(error), true)
      assert.notEqual(error.i18nKey, 'consumeErrCardUsed')
    },
  },
  {
    id: 'M6',
    what: 'INVITATION_CODE_DISABLED → consumeErrNotEnabled（「后台没开」≠「邀请码无效」）',
    run: () => {
      const error = parseSub2ApiError(jsonRaw(400, { code: 400, message: 'invitation code disabled', reason: 'INVITATION_CODE_DISABLED' }))
      assert.equal(error.i18nKey, 'consumeErrNotEnabled')
      assert.notEqual(error.i18nKey, 'consumeErrInvitationInvalid', '旧文案残留的典型错法（#487 L1-6 负向验证同一条）')
    },
  },
  {
    id: 'M7',
    what: 'reason 优先于 code：同一个 404，带 reason 走业务文案，不带 reason 落到状态码兜底',
    run: () => {
      const withReason = parseSub2ApiError(jsonRaw(404, { code: 404, message: 'x', reason: 'REDEEM_CODE_NOT_FOUND' }))
      assert.equal(withReason.code, 'REDEEM_CODE_NOT_FOUND')
      assert.equal(withReason.kind, 'redeem')
      const withoutReason = parseSub2ApiError(rawFromFixture('error-404-model-plaza-disabled.json', { status: 404 }))
      assert.equal(withoutReason.kind, 'unknown')
      assert.notEqual(withoutReason.i18nKey, 'consumeErrCardNotFound', '面板 404 不许被读成「卡密不存在」')
    },
  },
  {
    id: 'M8',
    what: 'EMAIL_VERIFY_REQUIRED 进表（缺口 2 已补）→ kind auth + 具体文案 + **不记缺口**；真正的表外码仍记缺口',
    run: () => {
      resetConsumeGaps()
      assert.deepEqual(
        CONSUME_ERROR_KEYS.EMAIL_VERIFY_REQUIRED,
        { kind: 'auth', i18nKey: 'consumeErrEmailVerifyRequired' },
        '实测存在、契约 §4.1 漏列的码必须进表，否则掉到 consumeErrUnknown'
      )
      const error = parseSub2ApiError(jsonRaw(403, { code: 'EMAIL_VERIFY_REQUIRED', message: 'email not verified' }))
      assert.equal(error.code, 'EMAIL_VERIFY_REQUIRED', '原码保留（排查要能看见服务端到底说了什么）')
      assert.equal(error.kind, 'auth', '会话本身没问题，缺的是「验证」这一步')
      assert.equal(error.retryable, false, '邮箱没验证重试没用：先去验证')
      assert.equal(error.i18nKey, 'consumeErrEmailVerifyRequired', '要具体到根因，不是「未知错误」')
      assert.equal(zh.consumeErrEmailVerifyRequired, '请先完成邮箱验证')
      assert.equal(en.consumeErrEmailVerifyRequired, 'Please verify your email first')
      assert.deepEqual(unmappedConsumeCodes(), [], '进表之后就不该再记缺口')

      // 「表外码 → 记缺口 + 状态码兜底」这条覆盖不能因为补了上面那条就丢掉，换个真表外的码继续锁
      const unlisted = parseSub2ApiError(jsonRaw(400, { code: 'SOME_UNLISTED_CODE', message: 'x' }))
      assert.equal(unlisted.code, 'SOME_UNLISTED_CODE', '原码保留')
      assert.equal(unlisted.i18nKey, 'consumeErrBadRequest', '兜底也要给一条具体文案，不是「未知错误」')
      assert.deepEqual(unmappedConsumeCodes(), ['middleware:SOME_UNLISTED_CODE'], '缺口要进清单，不静默吞')
    },
  },
  {
    id: 'M9',
    what: '面板整数 code 且没有 reason → code 用 HTTP_<status> 占位（404 不是业务码）',
    run: () => {
      const error = parseSub2ApiError(rawFromFixture('error-404-model-plaza-disabled.json', { status: 404 }))
      assert.equal(error.envelope, 'panel')
      assert.equal(error.code, 'HTTP_404')
      assert.equal(error.reason, undefined)
      assert.ok(error.message.length > 0, '服务端 message 留在 message 里供排查（但不上屏）')
    },
  },
]

test('L0 信封分派：五套形状（含 text/plain）归一成同一个错误对象', tableTest('consume-errors-envelope', ENVELOPE_ROWS, async (row) => row.run()))
test('L0 错误码映射：服务端码 → i18nKey（含 reason 优先与表外缺口）', tableTest('consume-errors-mapping', MAPPING_ROWS, async (row) => row.run()))
