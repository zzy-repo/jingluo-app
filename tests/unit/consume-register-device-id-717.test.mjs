// [layer: unit | 依赖: 无（纯 Node，可编程假 transport，零网络） | 耗时: <1s]
//
// #717 —— `POST /api/v1/auth/register` 的**可选**字段 `deviceId`（老账号额度迁移关联用）。
//
// 契约原文（`#717`）：
//   · 字段名 `deviceId`，**可选**，格式 `^[A-Za-z0-9._:-]{8,128}$`；
//   · 缺省 / 非法 → 后端**忽略该字段、不阻断注册**；不会因为 deviceId 失败而返回错误；
//   · **不是凭据**：不能单独认领老额度（真凭据是 `oldApiKey`），也不能替代密码 / 免验证登录；
//   · 只放**请求体**，不放 URL query；
//   · 后端当前（`RegisterRequest`）还没有这个字段 —— 客户端按契约先实现，传过去会被忽略。
//
// 本文件钉住六件事（对应 #717 的验收表 1–6 行）：
//   R1 合法 deviceId → 进 body；
//   R2 未传 → body 里**完全没有**该键（不是空串、不是占位值）；
//   R3 传空串 → 没有该键（**且不偷偷改成「本机设备码」**）；
//   R4 非法（长度 7 / 长度 129 / 含 `/` / 含空格）→ 没有该键；
//   R5 采集函数抛错 → 注册**仍然成功**（deviceId 只是配角，不许挡注册）；
//   R6 deviceId **只进 body**，不进 URL query（`check:consume-api` 的 R7 是同一个口径）；
//   R7 只有 register 带该字段：login / send-verify-code / refresh 的请求体**没有** deviceId
//      （同一采集口下 register 确实带上了，所以这一行不是空转）。
// 另外补三条：采集值被采纳且**只取一次**、显式传值时**不采集**、默认采集口绝不抛。
//
// 负向对照（人工，非本文件）两处，都必须红、还原后转绿：
//   ① 把 register 的 `deviceId` 整段去掉 → R1 变红（合法值进不去 body）；
//   ② 把「仅当合法才放」改成「无条件照发」→ R2 / R3 / R4 / R7 对照组变红。
//      —— 那是这组断言不空转的证据（见 PR 正文的实测输出）。
//
//   node --test tests/unit/consume-register-device-id-717.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { login, refresh, register, sendVerifyCode } = await import('../../src/services/consume/auth.ts')

const EMAIL = 'migrate-717@example.com'
const PASSWORD = 'secret-717'

/** 合法的设备码形状（`d-` + 32 位小写十六进制 = `createDeviceId()` 的真实产物形状，共 34 位） */
const VALID_DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
/** 采集口在 R3 里故意回一个**合法**值：实现若在「调用方给了非法值」时偷偷去采集，这一行就会露出来 */
const COLLECTED_DEVICE_ID = 'd-ffffffffffffffffffffffffffffffff'

/** 注册成功的面板信封（字段形状取自 #484 的 `AuthResponse`；这里只关心 body，不关心用户对象） */
const SESSION = {
  access_token: 'at-717',
  refresh_token: 'rt-717',
  expires_in: 86400,
  token_type: 'Bearer',
  user: { id: 7, email: EMAIL },
}

/** 一个只会回注册 200 的场景：打到别的端点就是失败（防「顺手多打一条」） */
const registerScene = (input, source) => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/auth/register') {return panelOk(SESSION)}
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => undefined, transport: recorder.transport })
  return {
    http,
    recorder,
    sequence: recorder.sequence,
    run: () => register(http, { email: EMAIL, password: PASSWORD, ...input }, source),
  }
}

/** 取这次请求的请求体（传输层拿到的是 JSON 字符串） */
const bodyOf = (recorder) => JSON.parse(recorder.calls[0].body)

/**
 * 表驱动：一行 = 一条覆盖（`expect` 是期望出现在 body 里的 deviceId，`undefined` = 该键必须不存在）。
 * `source` 是该行的采集口 —— 每一行都显式给一个，避免用例依赖「Node 里有没有 localStorage」。
 */
const ROWS = [
  {
    id: 'R1-合法',
    name: '合法 deviceId（d- + 32 hex）→ 放进 body',
    input: { deviceId: VALID_DEVICE_ID },
    source: () => undefined,
    expect: VALID_DEVICE_ID,
  },
  {
    id: 'R2-未传',
    name: '未传 → body 里没有 deviceId 这个键（不是空串）',
    input: {},
    source: () => undefined,
    expect: undefined,
  },
  {
    id: 'R3-空串',
    name: '传空串 → 没有该键，且不偷偷换成采集值',
    input: { deviceId: '' },
    source: () => COLLECTED_DEVICE_ID,
    expect: undefined,
  },
  {
    id: 'R4a-长度7',
    name: '非法（长度 7）→ 没有该键',
    input: { deviceId: 'd-12345' },
    source: () => undefined,
    expect: undefined,
  },
  {
    id: 'R4b-长度129',
    name: '非法（长度 129）→ 没有该键',
    input: { deviceId: `d-${'a'.repeat(127)}` },
    source: () => undefined,
    expect: undefined,
  },
  {
    id: 'R4c-非法字符',
    name: '非法（含 `/`）→ 没有该键',
    input: { deviceId: 'd-012345/789abcdef' },
    source: () => undefined,
    expect: undefined,
  },
  {
    id: 'R4d-含空格',
    name: '非法（含空格）→ 没有该键',
    input: { deviceId: 'd-012345 789abcdef' },
    // 采集口故意回**合法**值：实现若在「显式值非法」时改发采集值，这一行会露馅（契约是「忽略」不是「替换」）
    source: () => COLLECTED_DEVICE_ID,
    expect: undefined,
  },
]

for (const row of ROWS) {
  test(`${row.id} ${row.name}`, async () => {
    const scene = registerScene(row.input, row.source)
    const result = await scene.run()
    assert.equal(result.ok, true, '注册必须成功（deviceId 不参与成败）')
    const body = bodyOf(scene.recorder)
    if (row.expect === undefined) {
      assert.equal('deviceId' in body, false, '非法 / 缺省时**整个键不存在**（不是空串、不是占位值）')
    } else {
      assert.equal(body.deviceId, row.expect, '合法值原样进 body（camelCase，不做 snake_case 转换）')
    }
    // 其余字段不受影响（防止「为了塞 deviceId 把 email/password 弄丢」）
    assert.equal(body.email, EMAIL)
    assert.equal(body.password, PASSWORD)
  })
}

test('R5 采集函数抛错 → 注册仍然成功，且没有 deviceId 键', async () => {
  const scene = registerScene({}, () => {
    throw new Error('localStorage 不可用（隐私模式 / 老 WebView / 非浏览器环境）')
  })
  const result = await scene.run()
  assert.equal(result.ok, true, '采集失败**绝不**阻断注册（#717：不会因为 deviceId 失败而返回错误）')
  assert.equal(result.data?.accessToken, SESSION.access_token, '注册成功的会话照常返回')
  const body = bodyOf(scene.recorder)
  assert.equal('deviceId' in body, false, '采集不到就不传，不塞空串 / 占位值')
  assert.deepEqual(scene.sequence(), ['POST /api/v1/auth/register'], '只打一次注册，不因采集失败重试 / 补打')
})

test('R6 deviceId 只进 body：URL 里没有它、没有查询串', async () => {
  // 两条都要验：调用方显式传的、以及采集来的（两条来源都不许漏到 URL）
  for (const [label, input, source] of [
    ['显式传值', { deviceId: VALID_DEVICE_ID }, () => undefined],
    ['采集值', {}, () => COLLECTED_DEVICE_ID],
  ]) {
    const scene = registerScene(input, source)
    await scene.run()
    const { url } = scene.recorder.calls[0]
    const expected = label === '显式传值' ? VALID_DEVICE_ID : COLLECTED_DEVICE_ID
    assert.equal(url, `${scene.http.endpoints.baseUrl}/api/v1/auth/register`, `${label}：URL 就是端点本身，没有查询串`)
    assert.equal(url.includes(expected), false, `${label}：deviceId 的值不许出现在 URL 里`)
    assert.equal(/[?&]/.test(url), false, `${label}：没有 ? / & —— 也就没有 query`)
    assert.equal(bodyOf(scene.recorder).deviceId, expected, `${label}：值只走请求体`)
  }
})

test('采集值被采纳，且只取一次（first-launch 生成并持久化，之后复用）', async () => {
  let calls = 0
  const scene = registerScene({}, () => {
    calls += 1
    return COLLECTED_DEVICE_ID
  })
  const result = await scene.run()
  assert.equal(result.ok, true)
  assert.equal(calls, 1, '采集**只做一次**（不要每拼一次 body 就取一次）')
  assert.equal(bodyOf(scene.recorder).deviceId, COLLECTED_DEVICE_ID, '采集到的合法值进 body')
})

test('调用方显式传了合法值 → 不再采集（采集口抛错也不影响）', async () => {
  let calls = 0
  const scene = registerScene({ deviceId: VALID_DEVICE_ID }, () => {
    calls += 1
    throw new Error('不该被调用')
  })
  const result = await scene.run()
  assert.equal(result.ok, true)
  assert.equal(calls, 0, '有显式值就不要再去读 / 建设备码')
  assert.equal(bodyOf(scene.recorder).deviceId, VALID_DEVICE_ID)
})

test('采集口返回非字符串 / 空白 → 省略该键（不猜、不 stringify）', async () => {
  for (const returned of [undefined, null, '', '   ', 12345, {}]) {
    const scene = registerScene({}, () => returned)
    const result = await scene.run()
    assert.equal(result.ok, true, `采集口返回 ${String(returned)} 时注册照样成功`)
    assert.equal('deviceId' in bodyOf(scene.recorder), false, `采集口返回 ${String(returned)} 时省略该键`)
  }
})

test('R7 防串端点：login / send-verify-code / refresh 的请求体里没有 deviceId（契约只改了 register）', async () => {
  // 一条 transport 覆盖四个端点：先证明「这台设备确实有设备码」，再看别的端点有没有把它带上。
  const recorder = recordingTransport((request) => {
    if (request.method !== 'POST') {throw new Error(`只该发 POST：${request.method}`)}
    const path = pathOf(request.url).split('?')[0]
    if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login' || path === '/api/v1/auth/refresh') {
      return panelOk(SESSION)
    }
    if (path === '/api/v1/auth/send-verify-code') {return panelOk({})}
    throw new Error(`不该被打到的端点：${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => undefined, transport: recorder.transport })
  const lastBody = () => JSON.parse(recorder.calls[recorder.calls.length - 1].body)

  // 对照组：同一个采集口，register **确实**带上了 —— 否则下面「别的端点没有」就是空转（根本没值可串）
  const registered = await register(http, { email: EMAIL, password: PASSWORD }, () => COLLECTED_DEVICE_ID)
  assert.equal(registered.ok, true)
  assert.equal(lastBody().deviceId, COLLECTED_DEVICE_ID, 'register 该带就带（本行是对照，不是空转）')

  for (const [label, call] of [
    ['login', () => login(http, { email: EMAIL, password: PASSWORD })],
    ['send-verify-code', () => sendVerifyCode(http, { email: EMAIL })],
    ['refresh', () => refresh(http, { refreshToken: 'rt-717' })],
  ]) {
    const before = recorder.calls.length
    await call()
    assert.equal(recorder.calls.length, before + 1, `${label}：只打一次`)
    const body = lastBody()
    assert.equal('deviceId' in body, false, `${label}：请求体里**没有** deviceId（#717 契约只改了 register）`)
    assert.equal('device_id' in body, false, `${label}：也没有 snake_case 变体（避免「顺手换个名字」串过去）`)
  }
})

test('默认采集口（真实实现）绝不抛：没有注入时注册也不会被挡住', async () => {
  // 用真实默认值（第三个参数传 undefined 走 `loadRegisterDeviceId`）：
  // Node 里没有 `localStorage`（读 / 写都在 device.ts 里吞掉异常），生成仍应成功或退化为「不传」。
  const scene = registerScene({}, undefined)
  const result = await scene.run()
  assert.equal(result.ok, true, '默认采集口不许把异常抛到注册主流程')
  const body = bodyOf(scene.recorder)
  if ('deviceId' in body) {
    assert.match(body.deviceId, /^[A-Za-z0-9._:-]{8,128}$/, '只要带了就必须是合法形状')
  }
})
