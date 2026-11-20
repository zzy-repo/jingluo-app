// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// Issue #357：`/rotate` 已改为**原地重置额度（不换 Key 字符串）**，前端不能再说「没换成功」。
//
// 运行：node --test tests/unit/rotate-copy-357.test.mjs
//
// 表驱动：**响应形态 → 判定结果（mode）+ 文案 key**，四行覆盖
// 「key 变了 / 没变 × 额度字段有 / 无」，另有 rotated 不再参与成败的对照行。
//
// 这几行同时钉住三条不能被改回去的口径：
//   [A] **成败只看 HTTP 层**：2xx + 非空 key = 成功；`rotated:false`、`key` 与原来相同都是常态。
//   [B] 文案分档只决定「怎么说」，四种结论全是成功，一句「没换成功 / 请重试」都不许出现。
//   [C] 「Key 没变」时文案绝不能声称「换了新 Key」；「Key 变了」时也不能说「Key 未变」。
//
// 全部 stub：只替换注入的 `OursTransport`，不发任何真实请求（真调生产 `/rotate` 会顶掉用户 Key）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// 构建期注入值（`__ENDPOINTS__`）的兜底：直接复用 --import 预加载那一份，不在这里再抄一遍
// （tests/helpers/injected.mjs；#274 之后端点只有 config/endpoints.json 一个来源）
import '../helpers/injected.mjs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const rotate = await import('../../src/services/invite/rotate.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
/** 只有测试用的假凭据；真 Key 绝不进仓库 */
const OLD_KEY = 'sk-live-unit-test-old-0000000000000000000000'
const NEW_KEY = 'sk-live-unit-test-new-1111111111111111111111'

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

/** 假传输：只回放一条 stubbed 响应，并记录请求（断言不发第二条、不改 body） */
const makeTransport = (reply) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return reply
  }
  return { transport, calls }
}

/** 跑一次完整的 rotateKey（本地存档 = 旧 Key），返回结论 + 落盘记录 */
const runRotate = async (body, options = {}) => {
  const { transport, calls } = makeTransport(json(200, body))
  const storage = { apiKey: options.currentKey ?? OLD_KEY, writes: 0 }
  const outcome = await rotate.rotateKey({
    deviceId: DEVICE_ID,
    transport,
    currentKey: storage.apiKey,
    saveKey: (key) => {
      storage.writes += 1
      storage.apiKey = key
    },
  })
  return { outcome, storage, calls }
}

// ------------------------------------------------------------------ 表：响应形态 → 判定 + 文案 key

/**
 * 每行 = 一种真实的 200 响应形态。
 *
 * - `body`         服务端回的 JSON（#357 正文的 `note` / `key_id` 也一起放进去，验证不外泄）
 * - `keyChanged`   这次响应的 Key 字符串相对本机旧 Key 是否变了（前四行构成 2×2 覆盖）
 * - `quota`        响应里有没有额度字段
 * - `mode`         期望的判定结果（RotateSuccessMode）
 * - `messageKey`   期望的文案 key
 * - `claimsNewKey` 文案里是否允许出现「新 Key」这类说法
 * - `claimsQuota`  文案里是否必须出现「额度」
 */
const ROWS = [
  {
    label: '① key 变了 + 有额度字段',
    keyChanged: true,
    quota: true,
    body: { key: NEW_KEY, rotated: true, key_id: 282, total_points: 300, remaining_points: 300 },
    mode: 'newKey',
    messageKey: 'oursRotateOk',
    claimsNewKey: true,
    claimsQuota: true,
  },
  {
    label: '② key 变了 + 没有额度字段',
    keyChanged: true,
    quota: false,
    body: { key: NEW_KEY, rotated: true, key_id: 282 },
    mode: 'newKeyNoQuota',
    messageKey: 'oursRotateOkNoQuota',
    claimsNewKey: true,
    claimsQuota: false,
  },
  {
    label: '③ key 没变 + 有额度字段（#357 常态：原地重置额度）',
    keyChanged: false,
    quota: true,
    // 逐字对齐 issue 正文的样例响应：只有 total_points，没有 invite_code / remaining_points
    body: {
      key: OLD_KEY,
      rotated: false,
      key_id: 282,
      note: '未分配新 key：key 只在点击「领取」时分配，已原地重置当前 key 的额度',
      total_points: 300,
    },
    mode: 'quotaReset',
    messageKey: 'oursRotateOkQuotaReset',
    claimsNewKey: false,
    claimsQuota: true,
  },
  {
    label: '④ key 没变 + 没有额度字段',
    keyChanged: false,
    quota: false,
    body: { key: OLD_KEY, rotated: false, key_id: 282 },
    mode: 'unverified',
    messageKey: 'oursRotateOkUnverified',
    claimsNewKey: false,
    claimsQuota: false,
  },
  {
    // 附加对照：rotated 自称 true、字符串却和本机那只一样 → 仍按「Key 未变」说，
    // 绝不因为 rotated 就宣称「换发了新 Key」。
    label: '⑤ rotated:true 但 key 与本地相同 + 有额度字段',
    keyChanged: false,
    quota: true,
    body: { key: OLD_KEY, rotated: true, total_points: 300 },
    mode: 'quotaReset',
    messageKey: 'oursRotateOkQuotaReset',
    claimsNewKey: false,
    claimsQuota: true,
  },
]

for (const row of ROWS) {
  test(`[表] ${row.label} → ${row.mode} / ${row.messageKey}`, async () => {
    const { outcome, storage, calls } = await runRotate(row.body)

    // [A] 成败只看 HTTP 层：这五种形态**全都必须是成功**（#357 的误报就在这里）
    assert.equal(outcome.kind, 'ok', `${row.label} 不许判成失败`)
    assert.equal(outcome.saved, true)
    assert.equal(storage.writes, 1, '成功就落盘一次')
    assert.equal(storage.apiKey, row.body.key, '#357：响应里的 key 一律覆盖本地（相同也要落盘）')
    assert.equal(calls.length, 1, '不重发、不兜底')

    // 判定结果 + 文案 key 必须与表一致
    assert.equal(outcome.mode, row.mode)
    assert.equal(rotate.rotateSuccessKey(outcome), row.messageKey)
    assert.equal(rotate.ROTATE_SUCCESS_KEYS[row.mode], row.messageKey, 'mode → key 的映射表必须一一对应')

    // [B] 四种结论都是成功：文案里一句「没换成功 / 请重试」都不许有
    for (const [lang, table] of [['zh', zh], ['en', en]]) {
      const text = table[row.messageKey]
      assert.equal(typeof text, 'string', `${lang} 缺文案 ${row.messageKey}`)
      assert.ok(text.trim() !== '', `${lang}.${row.messageKey} 不能是空串`)
      assert.equal(/没换成功|服务端没有更换|更换失败|没成功/.test(text), false, `${lang} 文案不许说「没换成功」：${text}`)
      assert.equal(/重试/.test(text), false, `${lang} 文案不许引导重试（结果不会变）：${text}`)
      assert.equal(/did not rotate|failed|try again/i.test(text), false, `${lang} 文案不许说失败或让重试：${text}`)
      // [C] 该不该声称「新 Key」严格跟着判定走，不能两种说法混用
      const mentionsNewKey = /新 Key|a new key/i.test(text)
      assert.equal(mentionsNewKey, row.claimsNewKey, `${lang} 文案的「新 Key」说法与判定不符：${text}`)
      if (row.claimsQuota) {
        assert.match(text, /额度|quota/i, `${lang} 有额度字段时必须提到额度：${text}`)
      }
    }
  })
}

test('[表] 前四行覆盖「key 变了/没变 × 额度字段有/无」', () => {
  const covered = new Set(ROWS.slice(0, 4).map((row) => `${row.keyChanged ? 'key变了' : 'key没变'}+${row.quota ? '有额度' : '无额度'}`))
  assert.deepEqual(
    [...covered].sort(),
    ['key变了+有额度', 'key变了+无额度', 'key没变+有额度', 'key没变+无额度'].sort(),
    '2×2 必须齐全，少一格就等于有一类响应没被钉住'
  )
  // 表格里的 quota 标记必须和真实 body 对得上，避免表本身写错
  for (const row of ROWS) {
    assert.equal(rotate.hasQuotaFields(row.body), row.quota, `${row.label}：quota 标记与 body 不符`)
    assert.equal(row.body.key !== OLD_KEY, row.keyChanged, `${row.label}：keyChanged 标记与 body 不符`)
  }
})

// ------------------------------------------------------------------ 纯函数：判定口径

test('[纯函数] classifyRotateSuccess：成败与文案都不看「key 是否不同」', () => {
  const classify = rotate.classifyRotateSuccess

  // 本机没有旧 Key（读不到）时退回服务端的 rotated
  assert.equal(classify({ apiKey: OLD_KEY, currentKey: '', rotated: false, quotaInResponse: true }), 'quotaReset')
  assert.equal(classify({ apiKey: NEW_KEY, currentKey: '', rotated: true, quotaInResponse: true }), 'newKey')

  // 本机有旧 Key 时直接比字符串：相同 = 原地重置，不同 = 换发了新 Key
  assert.equal(classify({ apiKey: OLD_KEY, currentKey: OLD_KEY, rotated: false, quotaInResponse: true }), 'quotaReset')
  assert.equal(classify({ apiKey: NEW_KEY, currentKey: OLD_KEY, rotated: false, quotaInResponse: true }), 'newKey')

  // 额度字段只在「额度已重置」和「未验证」之间分流，不改成败
  assert.equal(classify({ apiKey: OLD_KEY, currentKey: OLD_KEY, rotated: false, quotaInResponse: false }), 'unverified')
  assert.equal(classify({ apiKey: NEW_KEY, currentKey: OLD_KEY, rotated: false, quotaInResponse: false }), 'newKeyNoQuota')
})

test('[纯函数] hasQuotaFields 只认「字段存在且是有限数字」，不读值', () => {
  const has = rotate.hasQuotaFields
  assert.equal(has(null), false)
  assert.equal(has({}), false)
  assert.equal(has({ key: OLD_KEY, rotated: false }), false)
  // issue 样例：只有 total_points，没有 invite_code / remaining_points —— 额度信息确实有
  assert.equal(has({ key: OLD_KEY, total_points: 300 }), true)
  assert.equal(has({ remaining_points: 409.48 }), true)
  assert.equal(has({ quota_points: 410 }), true)
  assert.equal(has({ carried_used_points: 0.52 }), true)
  // 类型不对 / 非有限数不算
  assert.equal(has({ total_points: '300' }), false)
  assert.equal(has({ total_points: Number.NaN }), false)
})

// ------------------------------------------------------------------ 隐私与旧口径残留

test('[隐私] 成功分支不带回 note / key_id 等排查字段，也不含完整设备码', async () => {
  const note = '未分配新 key：key 只在点击「领取」时分配，已原地重置当前 key 的额度'
  const { outcome } = await runRotate({ key: OLD_KEY, rotated: false, key_id: 282, note, total_points: 300 })
  const text = JSON.stringify(outcome)
  assert.equal(text.includes('key_id'), false, 'key_id 不外泄')
  assert.equal(text.includes(note), false, 'note 原样不透传')
  assert.equal(text.includes(DEVICE_ID), false, '返回值里没有完整 device_id')
})

test('[旧口径] 「服务端没有更换，请稍后重试」这个文案 key 已经从 zh/en 里删掉', () => {
  assert.equal('oursRotateOkUnchanged' in zh, false, 'zh 不该再有「没换成功」的文案 key')
  assert.equal('oursRotateOkUnchanged' in en, false, 'en 不该再有「没换成功」的文案 key')
  // 成功文案的四种说法必须都在，且 zh/en 一一对应
  for (const key of ['oursRotateOk', 'oursRotateOkNoQuota', 'oursRotateOkQuotaReset', 'oursRotateOkUnverified']) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
  }
})

test('[接线] UI 用 rotateSuccessKey(outcome) 取文案，不再拿 replaced 判成败', () => {
  const source = readFileSync(new URL('../../src/components/settings/OursServicesDialog.tsx', import.meta.url), 'utf8')
  assert.match(source, /t\(rotateSuccessKey\(rotateResult\)\)/, '成功文案走 rotateSuccessKey')
  assert.equal(/rotateSuccessKey\(\s*\{?\s*replaced/.test(source), false, '不许再用 replaced 选文案')
  assert.equal(/replaced\s*\?/.test(source), false, 'UI 里不许出现「按 replaced 分流」')
  assert.match(source, /data-rotate-mode=/, '成功语义挂到 DOM 上，便于回归断言')
})
