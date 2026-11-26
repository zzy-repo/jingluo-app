// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #909（1/5 高水位检测）：启动时库里 sessions=0 但高水位 > 0 → 判定「库从有到无」。
// 三条必须能分开：新装（无标记不报）/ 用户自己删光（显式路径同步更新标记，不报）/ 被系统清除（报）。
//
// 被测对象是真代码（src/services/protection/**），文件系统用 fs 模块的内存实现（setFsForTests，
// 不复制它的代码），存储用本文件的内存替身（ProtectionStorage 窄接口）。
//
// 故障注入：
//   [N1] 原生标记写失败（ENOSPC）→ 抛 InfraError(quota)，且**不**改用 localStorage 后假装成功
//   [N2] 原生标记读失败 → 抛，不去读 localStorage 那份更旧的
//   [N3] 标记被改一个字节（校验和损坏）→ 读出 null，并记一条诊断
//   [N4] Web 端 localStorage 被清 → 无标记，不报（已知盲区，钉住现状）
//
// 负向对照：把 detectDataLoss 的「dbSessions === 0」改成「dbSessions >= 0」→ [D1] 变红
// （库里还有会话也被判丢失）。
//
//   node tests/run-layer.mjs unit --only protection-highwater-909
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtection, localStore, makeSession, memoryStorage, records, resetRecords, setupProtection } from '../helpers/protection-env.mjs'

const P = await loadProtection()
const { FsError, createMemoryFs, detectDataLoss, HIGHWATER_PATH, HIGHWATER_LOCAL_KEY, resetProtectionDiagnosticsForTests } = P

/** 会话数 → 假库：用 n 条占位会话；`env.count.value = k` 时按 k 重建 */
const fill = (n) => Array.from({ length: n }, (_, index) => makeSession(`s${index}`))
const setup = ({ native, sessions = 0 } = {}) => {
  const env = setupProtection(P, { native, sessions: fill(sessions) })
  const count = {
    get value() {
      return env.state.sessions.length
    },
    set value(n) {
      env.state.sessions = fill(n)
    },
  }
  return { ...env, count }
}

test('D1 新装：无标记、库为空 → 不报，也不写标记（0 条没有信息量）', async () => {
  const { protection, fs } = setup({ native: true })
  assert.equal(await protection.checkAtStartup(), null)
  assert.equal(await fs.read(HIGHWATER_PATH), undefined, '新装不该留下标记文件')
})

test('D2 用户自己删光：显式路径把标记更新成 0 → 下次启动不报', async () => {
  const one = setup({ native: true, sessions: 2 })
  await one.protection.afterSave()
  one.count.value = 0
  await one.protection.afterExplicitChange()
  assert.equal((await one.protection.highwater.read()).mark.sessions, 0, '显式删除后标记按实际数更新')
  assert.equal(await one.protection.checkAtStartup(), null, '用户自己删光不得误报')
})

test('D3 被系统清除：库归零但标记还在 → 判定丢失，且「忽略后新建会话」下次启动仍报', async () => {
  const env = setup({ native: true, sessions: 4 })
  env.now.value += 1000
  await env.protection.afterSave()
  // 系统整库删除：库没了，原生标记（独立于 WebView 存储）还在
  env.count.value = 0
  const lost = await env.protection.checkAtStartup()
  assert.deepEqual(
    { expected: lost?.expectedSessions, at: lost?.lastSeenAt },
    { expected: 4, at: env.now.value },
    '必须报出丢失前的会话数与时间'
  )
  // 用户没处理，只是新建了一条会话
  env.count.value = 1
  const again = await env.protection.checkAtStartup()
  assert.equal(again?.expectedSessions, 4, '丢失状态必须持续到用户确认或恢复，不能因为新建会话就消失')
})

test('D4 导入整包替换（commit 后）：标记按替换后的实际数更新，旧的更高水位不残留', async () => {
  const env = setup({ native: true, sessions: 9 })
  await env.protection.afterSave()
  env.count.value = 2
  await env.protection.afterExplicitChange()
  assert.equal((await env.protection.highwater.read()).mark.sessions, 2)
  assert.equal(await env.protection.checkAtStartup(), null, '替换后库里有 2 条，不报')
  env.count.value = 0
  const lost = await env.protection.checkAtStartup()
  assert.equal(lost?.expectedSessions, 2, '之后若再被清掉，判据是替换后的 2，不是历史峰值 9')
})

test('D5 只升不降：保存路径上会话数变少（并发删除还没走显式路径）不把标记调低', async () => {
  const env = setup({ native: true, sessions: 5 })
  await env.protection.afterSave()
  env.count.value = 4
  await env.protection.afterSave()
  assert.equal((await env.protection.highwater.read()).mark.sessions, 5, '非显式路径只升不降')
})

test('D6 确认「知道了」：清掉丢失状态，之后按实际数重新计', async () => {
  const env = setup({ native: true, sessions: 3 })
  await env.protection.afterSave()
  env.count.value = 0
  assert.ok(await env.protection.checkAtStartup())
  await env.protection.acknowledgeLoss()
  assert.equal(await env.protection.checkAtStartup(), null)
})

test('N1 原生写失败（ENOSPC）：抛 quota，且不改用 localStorage 假装成功', async () => {
  const env = setup({ native: true, sessions: 2 })
  env.fs.injectEnospc()
  await assert.rejects(() => env.protection.highwater.write(2), (error) => error.name === 'InfraError' && error.kind === 'quota')
  assert.equal(env.local.map.has(HIGHWATER_LOCAL_KEY), false, '禁止降级到 localStorage')
  assert.equal(await env.fs.read(HIGHWATER_PATH), undefined, '失败不得留下半成品标记')
  // 经入口调用时不抛（保护层故障不许打断主流程），但标记必须仍然是「没写上」
  await env.protection.afterSave()
  env.fs.injectEnospc()
  await env.protection.afterSave()
  const text = new TextDecoder().decode(await env.fs.read(HIGHWATER_PATH))
  assert.match(text, /"sessions":2/, '第一次成功的标记还在')
})

test('N2 原生读失败：抛，不去读 localStorage 里那份更旧的标记', async () => {
  const env = setup({ native: true })
  env.local.map.set(HIGHWATER_LOCAL_KEY, '{"v":1,"sessions":9,"at":1,"schema":15,"checksum":"x"}')
  const original = env.fs.read
  env.fs.read = async () => {
    throw new FsError('unavailable', 'injected read failure')
  }
  await assert.rejects(() => env.protection.highwater.read(), (error) => error.kind === 'unavailable')
  env.fs.read = original
})

test('N3 标记被改一个字节：读出 null（校验和不过），并记一条诊断', async () => {
  resetProtectionDiagnosticsForTests()
  resetRecords()
  const env = setup({ native: true, sessions: 2 })
  await env.protection.afterSave()
  const bytes = await env.fs.read(HIGHWATER_PATH)
  bytes[bytes.length - 3] ^= 0x1
  await env.fs.writeAtomic(HIGHWATER_PATH, bytes)
  const { mark } = await env.protection.highwater.read()
  assert.equal(mark, null, '校验和不过的标记等于没有标记，不许将错就错')
  assert.ok(
    records().some((entry) => entry.message === 'protection.highwater-read failed'),
    '损坏必须留一条诊断'
  )
})

test('N4 Web 端 localStorage 被清：无标记，不报（已知盲区）', async () => {
  const env = setup({ native: false, sessions: 6 })
  await env.protection.afterSave()
  assert.equal((await env.protection.highwater.read()).source, 'web')
  env.local.map.clear()
  env.count.value = 0
  assert.equal(await env.protection.checkAtStartup(), null, 'localStorage 被清后无从判断，不报')
})

test('N5 Web 端无 localStorage：写入返回 unsupported（可区分），不抛、不假装成功', async () => {
  const fs = createMemoryFs()
  fs.supported = false
  const highwater = P.createHighwater({ fs, storage: memoryStorage({ sessions: fill(1) }), now: () => 1, local: undefined })
  const result = await highwater.write(1)
  assert.deepEqual({ status: result.status, changed: result.changed }, { status: 'unsupported', changed: false })
})

test('纯函数：库里还有会话 / 标记为 0 / 无标记都不报', () => {
  assert.equal(detectDataLoss(3, { sessions: 9, at: 1, schema: 15 }).lost, false)
  assert.equal(detectDataLoss(0, { sessions: 0, at: 1, schema: 15 }).lost, false)
  assert.equal(detectDataLoss(0, null).lost, false)
  assert.equal(detectDataLoss(0, { sessions: 2, at: 5, schema: 15 }).lost, true)
})
