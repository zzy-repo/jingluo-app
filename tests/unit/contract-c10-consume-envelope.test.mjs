// [layer: unit | 依赖: 无（纯 Node，实测响应体 + 假 transport，零网络） | 耗时: <0.2s]
//
// C10 —— 消费侧**错误信封的分派语义**（对外契约，替代被删的 C4 / C6；#487 阶段③）
//
// 契约锁的是「调用方观察到的东西」，不是函数名、不是文件结构、更不是「这是哪一层返回的」：
//
//   不管错误来自面板 `/api/v1/**`、中间件、网关 `/v1/**`、429 限流，还是**根本不是 JSON** 的
//   `text/plain`（未知路径 404 / 边缘反代 401），消费层抛给界面的都是**同一个形状**：
//
//       { kind, code, message, status, retryable, envelope, i18nKey }
//
//   界面只靠 `kind` + `retryable` + `i18nKey` 就能决定「重试 / 换 Key / 去登录 / 提示已到账」，
//   **不需要知道错误来自哪一层**。所以：
//     · `kind` 必须是**语义**类别（auth / quota / rate_limit / redeem / key / server / network /
//       bad_request / unknown），不能是 `panel` / `middleware` / `gateway` / `text` 这类**来源**名字
//       （来源只允许出现在 `envelope` 这个排查字段里）；
//     · `message` 是英文原话，只用于排查，**永远不上屏**；上屏只认 `i18nKey`；
//     · 服务端 message 变了（同一 401 有三个变体）不许影响归一结果。
//
// 负向验证（本单实测，见 PR/评论）：删掉 `readEnvelope` 的网关分支 → **X2 红**
// （`S3 分派错了`：码退化成 HTTP_403、文案从「分组不匹配」退化成「没权限」）；
// 把 `kind` 改成返回信封名 → X1 红（`kind 把来源当成了 kind`）；把 text 分支删掉 → X5 红（抛错）。
//
//   node --test tests/unit/contract-c10-consume-envelope.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { failureRaw, jsonRaw, rawFromFixture, textRaw } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { parseSub2ApiError } = await import('../../src/services/consume/errors.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** `kind` 的语义枚举（契约锁的就是这个集合；加新类别要改契约，不能悄悄多一个来源名） */
const SEMANTIC_KINDS = ['auth', 'quota', 'rate_limit', 'redeem', 'key', 'server', 'network', 'bad_request', 'unknown']
/** 归一结果里**必须**有的字段（少一个，界面就得回去看来源） */
const REQUIRED_FIELDS = ['kind', 'code', 'message', 'retryable']
/** 允许出现的附加字段（排查用；多出别的字段说明有人在往出口塞私有信息） */
const OPTIONAL_FIELDS = ['status', 'envelope', 'i18nKey', 'reason', 'retryAfterMs', 'nonJson']

/**
 * 五套信封 + 传输层的**实测样本**（`tests/fixtures/consume/*.json`，采集于 2026-11-20）。
 * 契约只关心「喂进去什么形状、吐出来是不是同一个形状」，所以样本按形状选，不按接口选。
 */
const SAMPLES = [
  {
    id: 'S1',
    from: '中间件 401 {code:"UNAUTHORIZED"}',
    raw: () => rawFromFixture('error-401.json'),
    // 码来自 `body.code`（大写字符串）→ 会话失效文案
    expect: { envelope: 'middleware', code: 'UNAUTHORIZED', kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  },
  {
    id: 'S2',
    from: '429 {error:"rate limit exceeded"}（无 code）',
    raw: () => rawFromFixture('error-429.json', { status: 429, headers: { 'retry-after': '42' } }),
    // 没有 code 可读 → 只能按状态码分支，并用 `HTTP_429` 占位
    expect: { envelope: 'error_string', code: 'HTTP_429', kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  },
  {
    id: 'S3',
    from: '网关 {error:{message,type}}（无 code）',
    raw: () => rawFromFixture('local-gateway-403-permission.json', { status: 403 }),
    // 码来自 `error.type` → 「分组不匹配」而不是笼统的「没权限」
    expect: { envelope: 'gateway', code: 'permission_error', kind: 'key', i18nKey: 'consumeErrGroupNotAllowed' },
  },
  {
    id: 'S4',
    from: '面板 {code:404,reason}',
    raw: () => rawFromFixture('local-redeem-404.json', { status: 404 }),
    // 码来自 `reason`（业务码优先于整数 code）→ 卡密文案
    expect: { envelope: 'panel', code: 'REDEEM_CODE_NOT_FOUND', kind: 'redeem', i18nKey: 'consumeErrCardNotFound' },
  },
  {
    id: 'S5',
    from: '未知路径 404 text/plain',
    raw: () => textRaw(404, '404 page not found', 'text/plain'),
    // 根本不是 JSON → `text` 分派，码用 HTTP_<status> 占位
    expect: { envelope: 'text', code: 'HTTP_404', kind: 'unknown', i18nKey: 'consumeErrUnknown' },
  },
  {
    id: 'S6',
    from: '传输层超时（status 0）',
    raw: () => failureRaw('timeout'),
    expect: { envelope: 'none', code: 'TIMEOUT', kind: 'network', i18nKey: 'consumeErrTimeout' },
  },
]

const normalized = () => SAMPLES.map((sample) => ({ id: sample.id, error: parseSub2ApiError(sample.raw()) }))

const ROWS = [
  {
    id: 'X1',
    what: '五套信封 + 传输层：归一后**字段集合同构**（必含 kind/code/message/retryable，附加字段限白名单）',
    run: () => {
      for (const { id, error } of normalized()) {
        for (const field of REQUIRED_FIELDS) {
          assert.ok(field in error, `${id} 归一结果缺 ${field}（界面就得回去问「这是哪一层」）`)
        }
        for (const field of Object.keys(error)) {
          assert.ok(
            REQUIRED_FIELDS.includes(field) || OPTIONAL_FIELDS.includes(field),
            `${id} 多出字段 ${field}：出口只允许契约里的这几项`
          )
        }
        const sourceNames = ['panel', 'middleware', 'gateway', 'error_string', 'text', 'none']
        assert.ok(SEMANTIC_KINDS.includes(error.kind), `${id} 的 kind="${error.kind}" 不是语义类别`)
        assert.equal(sourceNames.includes(error.kind), false, `${id} 把来源当成了 kind（界面会跟着来源变，契约失效）`)
      }
    },
  },
  {
    id: 'X2',
    what: '五套形状**各自分派**：取码位置不同（code / reason / error.type / 状态码）→ 码与文案都不同',
    run: () => {
      // 删掉任一分派分支（例如网关的 `{error:{…}}`）→ 该行立刻红：码会退化成 `HTTP_<status>`、
      // 文案会从「分组不匹配」退化成「没权限」。这就是契约要的「不同来源、同一个形状」而不是「同一坨兜底」。
      for (const sample of SAMPLES) {
        const error = parseSub2ApiError(sample.raw())
        assert.equal(error.envelope, sample.expect.envelope, `${sample.id} 分派错了：来源是 ${sample.from}`)
        assert.equal(error.code, sample.expect.code, `${sample.id} 取码位置错了（应取 ${sample.expect.envelope} 里的码）`)
        assert.equal(error.kind, sample.expect.kind, `${sample.id} kind 与分派不一致`)
        assert.equal(error.i18nKey, sample.expect.i18nKey, `${sample.id} 文案与分派不一致（用户看到的就是这句）`)
      }
    },
  },
  {
    id: 'X3',
    what: '同一个 401、三个 message 变体（用户/admin/网关）→ 归一结论一致：**只看 code，不看 message**',
    run: () => {
      const user = parseSub2ApiError(rawFromFixture('error-401.json'))
      const admin = parseSub2ApiError(jsonRaw(401, { code: 'UNAUTHORIZED', message: 'Authorization required' }))
      const gateway = parseSub2ApiError(jsonRaw(401, { code: 'API_KEY_REQUIRED', message: 'API key is required' }))
      assert.equal(admin.kind, user.kind)
      assert.equal(admin.code, user.code)
      assert.equal(admin.i18nKey, user.i18nKey, 'message 不同不许改变结论（按文本匹配会在 admin 路径静默失效）')
      assert.notEqual(gateway.i18nKey, user.i18nKey, '但「没填 Key」和「登录过期」必须是两条文案')
      assert.equal(gateway.kind, 'key')
    },
  },
  {
    id: 'X4',
    what: '`retryable` 必须给出判定：429 / 5xx / 超时可重试；401 / 403 / 404 / 409 不可重试',
    run: () => {
      const retryable = (raw) => parseSub2ApiError(raw).retryable
      assert.equal(retryable(rawFromFixture('error-429.json', { status: 429 })), true, '429 可重试（按 Retry-After 倒计时）')
      assert.equal(retryable(jsonRaw(503, { code: 503, message: 'unavailable' })), true, '5xx 可重试')
      assert.equal(retryable(failureRaw('timeout')), true, '超时（没拿到响应）可重试')
      assert.equal(retryable(rawFromFixture('error-401.json')), false, '401 重试只会更糟')
      assert.equal(retryable(rawFromFixture('local-gateway-403-permission.json', { status: 403 })), false, '403 同上')
      assert.equal(retryable(rawFromFixture('local-redeem-404.json', { status: 404 })), false, '404 同上')
      assert.equal(
        retryable(jsonRaw(409, { code: 409, message: 'used', reason: 'REDEEM_CODE_USED' })),
        false,
        '409 同上（卡密重试只会拿第二个 409）'
      )
    },
  },
  {
    id: 'X5',
    what: '不是 JSON 的响应（text/plain 404 / HTML 502 / 空 body）→ **不抛异常**，仍归一成同一形状',
    run: () => {
      const samples = [
        textRaw(404, '404 page not found', 'text/plain'),
        textRaw(502, '<html><body>502 Bad Gateway</body></html>', 'text/html'),
        textRaw(500, '', 'text/plain'),
      ]
      for (const raw of samples) {
        let error
        assert.doesNotThrow(() => {
          error = parseSub2ApiError(raw)
        }, '对 text/plain 做 JSON.parse 会抛 —— 那正是「未知路径 404」崩溃的写法')
        for (const field of REQUIRED_FIELDS) {
          assert.ok(field in error, `${raw.status} 的归一结果缺 ${field}`)
        }
        assert.ok(SEMANTIC_KINDS.includes(error.kind))
        assert.match(error.code, /^HTTP_\d+$/, '没有服务端码时用 HTTP_<status> 占位，不编假码')
      }
      assert.match(parseSub2ApiError(textRaw(404, '404 page not found')).message, /404 page not found/)
    },
  },
  {
    id: 'X6',
    what: '`i18nKey` 一定能在 zh + en 里解析到（它是**唯一**该上屏的东西）',
    run: () => {
      for (const { id, error } of normalized()) {
        for (const [locale, dict] of [['zh', zh], ['en', en]]) {
          const text = dict[error.i18nKey]
          assert.equal(typeof text, 'string', `${id} 的 i18nKey=${error.i18nKey} 在 ${locale} 里不存在`)
          assert.notEqual(text.trim(), '', `${locale} 的 ${error.i18nKey} 是空文案`)
        }
        assert.notEqual(error.message, undefined, 'message 允许为空字符串，但字段必须在（排查要靠它）')
      }
    },
  },
]

test('C10 错误 envelope 分派：五套形状归一成同一个语义错误', tableTest('C10', ROWS, async (row) => row.run()))
