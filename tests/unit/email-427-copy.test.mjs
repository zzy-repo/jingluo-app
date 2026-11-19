// [layer: unit | 依赖: 无（纯 Node + 源码文本扫描，零浏览器，不发网络） | 耗时: <1s]
// Issue #427 —— 邮箱适配回归基线（文案）：`oursInviteErr*` / `oursEmail*` 键在 zh / en 两侧
// 都存在、都非空、占位符对齐，并且在 `src/**` 里**真被引用**。
//
// 为什么单独一条：`scripts/check-i18n.mjs` 已经把 R1~R5 全做了，但它**不在** `pnpm test` /
// CI 的必跑链路上（它的存量孤立 key 还挂着 `compatBoot*`）。这里补的是「邮箱这一块的文案
// 自己不掉队」——不会因为别人那条门禁暂时红，就连带看不见邮箱文案漏了一侧。
//
// 「被引用」的判定：在 `src/**`（除 `src/i18n/` 自身）里出现该 key 的字面量。新增一条错误码
// 却忘了在 `EMAIL_ERROR_KEYS` 里挂上，或者写了文案没人用，都会在这里红。
//
//   node tests/run-layer.mjs unit --only email-427
//   pnpm test:email
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { installTsResolve, loadTsModule, ROOT } from '../helpers/dom-env.mjs'
import {
  allowedHosts,
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
} from '../../scripts/lib/endpoints.mjs'

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
})

installTsResolve()
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')
const api = await loadTsModule('src/services/invite/api.ts')

/** 递归收集 `src/**` 里所有 .ts / .tsx 的文本（跳过 i18n 目录本身：自己引自己不算引用） */
const collectSources = () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (full.endsWith(path.join('src', 'i18n'))) {
          continue
        }
        walk(full)
      } else if (/\.tsx?$/u.test(entry.name)) {
        files.push(full)
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return files.map((file) => readFileSync(file, 'utf8'))
}

const SOURCES = collectSources()
const referencedSomewhere = (key) => SOURCES.some((text) => text.includes(key))

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

const EMAIL_KEYS = Object.keys(zh)
  .filter((key) => key.startsWith('oursEmail') || key.startsWith('oursInviteErr'))
  .sort()

test('L1 邮箱相关文案键在 zh / en 两侧都存在、非空、占位符一一对齐', () => {
  assert.ok(EMAIL_KEYS.length >= 30, `邮箱文案键数量异常（${EMAIL_KEYS.length}）：只找到这几条说明扫描口径坏了`)
  for (const key of EMAIL_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh 的 ${key} 是空文案`)
    assert.notEqual(en[key].trim(), '', `en 的 ${key} 是空文案`)
    assert.deepEqual(
      placeholders(zh[key]),
      placeholders(en[key]),
      `${key} 的占位符两侧不一致（界面会把 {name} 直接端给用户）`
    )
  }
})

test('L2 每条邮箱文案键在 src/** 里都真被引用（新增了键却没人用 = 漏接线）', () => {
  const orphans = EMAIL_KEYS.filter((key) => !referencedSomewhere(key))
  assert.deepEqual(orphans, [], `这些键定义了但没有任何调用方：${orphans.join(', ')}`)
})

test('L3 13 条错误码的文案键全部落在 zh / en 里，且每条都被引用', () => {
  const tableKeys = Object.values(api.EMAIL_ERROR_KEYS)
  assert.equal(Object.keys(api.EMAIL_ERROR_KEYS).length >= 13, true, '错误码表至少要覆盖 #421 那 13 条')
  for (const key of tableKeys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
  }
  // 13 条「邮箱专属」码各自有独立文案：不许几个人共用一句，否则分流等于没做
  const EMAIL_SPECIFIC = [
    'oursInviteErrEmailInvalid',
    'oursInviteErrEmailDomainBlocked',
    'oursInviteErrEmailCodeInvalid',
    'oursInviteErrEmailCodeExpired',
    'oursInviteErrEmailCodeLocked',
    'oursInviteErrEmailTooFrequent',
    'oursInviteErrEmailHourLimit',
    'oursInviteErrIpHourLimit',
    'oursInviteErrDeviceHourLimit',
    'oursInviteErrEmailDailyCap',
    'oursInviteErrEmailSendFailed',
    'oursInviteErrCustomerHasEmail',
    'oursInviteErrAccountFrozen',
  ]
  for (const key of EMAIL_SPECIFIC) {
    assert.ok(tableKeys.includes(key), `${key} 必须在 EMAIL_ERROR_KEYS 里被用到`)
    assert.ok(referencedSomewhere(key), `${key} 没有调用方`)
  }
  assert.equal(new Set(EMAIL_SPECIFIC.map((key) => zh[key])).size, 13, '13 条文案必须互不相同')
})

test('L4 409 的两句话必须真的不一样（否则「先按 code 匹配」在用户眼里仍无区别）', () => {
  assert.notEqual(zh.oursInviteErrCustomerHasEmail, zh.oursInviteErrAlreadyRedeemed)
  assert.notEqual(en.oursInviteErrCustomerHasEmail, en.oursInviteErrAlreadyRedeemed)
  assert.equal(
    zh.oursInviteErrCustomerHasEmail.includes('邀请码'),
    false,
    '「已绑邮箱」的文案里不该出现「邀请码」三个字'
  )
})

test('L5 交互文案的占位名与代码实际传的字段对得上', () => {
  // 界面里传的是 { seconds } / { attempts } / { masked }；写错名字会让用户看到「{seconds} 秒后再试」
  assert.deepEqual(placeholders(zh.oursEmailRetryAfter), ['seconds'])
  assert.deepEqual(placeholders(en.oursEmailRetryAfter), ['seconds'])
  assert.deepEqual(placeholders(zh.oursEmailAttemptsLeft), ['attempts'])
  assert.deepEqual(placeholders(en.oursEmailAttemptsLeft), ['attempts'])
  assert.deepEqual(placeholders(zh.oursEmailBoundMaskedHint), ['masked'])
  assert.deepEqual(placeholders(en.oursEmailBoundMaskedHint), ['masked'])
})
