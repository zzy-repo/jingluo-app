// [layer: unit | 依赖: 无（纯 Node + 真 invitePanelModel / 真 renderToStaticMarkup，零网络） | 耗时: <1s]
//
// #830 —— 账号页邀请区域「闪现后消失」的**渲染顺序**修复（#819 的二次修复）。
//
// 病灶一句话：容器把初始态写死成 `{ phase: 'loading' }`（= 假设开关开着，#209 那类假设），
// 于是开关为 false 的部署上第一帧先画出 86px 的「我的邀请 / Loading…」骨架，
// 等 `loadInvite()` 的 `settings/public` 回来再落 `hidden` —— 一次可见 → 消失的抖动
// （实测 390 / 360 两档：可见 ~48ms / 4 帧，峰值 86px，之后高度归 0）。
//
// 修法（最小改动，两处）：
//   ① `invitePanelModel.ts` 新增纯函数 `initialInviteState(flags)`：**已确认开着**才 `loading`，
//      其余一切情况（读到 false / 还没读到 / 读失败）都从 `hidden` 起跳；
//   ② `InvitePanel.tsx` 的 `useState` 初值与 `reload()` 都改成走它（不再写死 `loading`）。
//
// 本文件钉四件事（① ② 是状态函数，③ 是时间线折叠，④ 是源码落位）：
//   ① 开关 false → 初始态 hidden，渲染 `''`（DOM 里 0 个 `invite-*`）；
//   ② 开关 true  → 初始态 loading（骨架仍在，但它是"最后会变成内容"的那一个，不是要被抹掉的）；
//   ③ 两条路径的时间线都不会出现「可见 → 隐藏」（false: hidden→hidden；true: loading→ready）；
//   ④ 源码里不许再出现写死的 `useState<InviteState>({ phase: 'loading' })`（删掉修复 → 立刻红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId } = await setupAuthPanels()

const { createConsumeClient } = await import('../../src/services/consume/index.ts')
const { InvitePanelView, initialInviteState, loadInvite } = await import(
  '../../src/components/consume/invitePanelModel.ts'
)

const readSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/**
 * 去掉注释再断言：本仓踩过「面板只写在注释里」的坑（#819 的负向对照第一次就被注释骗过），
 * 这里按同一口径处理。
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

const AFF = {
  user_id: 7,
  aff_code: 'INV830',
  aff_count: 3,
  aff_quota: 12.5,
  aff_frozen_quota: 0,
  aff_history_quota: 12.5,
  effective_rebate_rate_percent: 10,
  invitees: [],
}

/** 只认「开关」与「返利」两条端点的假后端（其余端点被打到就炸） */
const inviteScene = ({ invitationCodeEnabled }) => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'GET' && path === '/api/v1/settings/public') {
      return panelOk({
        registration_enabled: true,
        invitation_code_enabled: invitationCodeEnabled,
        affiliate_enabled: invitationCodeEnabled,
      })
    }
    if (request.method === 'GET' && path === '/api/v1/user/aff') {
      return panelOk(AFF)
    }
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const consume = createConsumeClient({ accessToken: () => 'jwt-830', transport: recorder.transport })
  return { consume, ...recorder }
}

const inviteRender = (state) =>
  markupOf(
    InvitePanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      copied: false,
      onCopy() {},
      onRetry() {},
    })
  )

/** 渲染结果里 `invite-*` 节点的个数（等价于浏览器里的 `querySelectorAll('[data-testid^="invite"]')`） */
const inviteNodeCount = (markup) => (markup.match(/data-testid="invite[^"]*"/gu) ?? []).length

// ───────────────────────────────────────── ① 开关 false：第一帧就不许有 invite-* 节点

test('① 开关 false → 初始态就是 hidden，第一帧渲染 0 个 invite-* 节点（#830 的硬要求）', async () => {
  const flags = { invitationCodeEnabled: false }
  const initial = initialInviteState(flags)
  assert.deepEqual(initial, { phase: 'hidden' }, '开关没开 → 初始态必须是 hidden（不是 loading）')

  const firstFrame = inviteRender(initial)
  assert.equal(firstFrame, '', 'hidden 时面板返回 null —— 第一帧 DOM 里什么都没有')
  assert.equal(inviteNodeCount(firstFrame), 0, '第一帧必须 0 个 invite-* 节点（闪现的病灶就死在这一行）')

  // 结论回来（开关 false）之后仍然是 hidden：hidden → hidden，全程没有可见帧
  const scene = inviteScene({ invitationCodeEnabled: false })
  const settled = await loadInvite({ settings: scene.consume.settings, aff: scene.consume.aff })
  assert.deepEqual(settled, { phase: 'hidden' }, '开关 false → 落 hidden（口径没变）')
  assert.equal(inviteNodeCount(inviteRender(settled)), 0, '落定后依然 0 个 invite-* 节点')
})

// ─────────────────────────────────── ② 开关 true：骨架仍在，但它是"会变成内容"的那一个

test('② 开关 true → 初始态 loading（骨架可渲染），落定后是内容态，节点只增不减', async () => {
  const flags = { invitationCodeEnabled: true }
  const initial = initialInviteState(flags)
  assert.deepEqual(initial, { phase: 'loading' }, '已确认开关开着 → 从骨架起跳（不是 hidden，避免空白等待）')

  const skeleton = inviteRender(initial)
  assert.ok(hasTestId(skeleton, 'invite-panel'), '骨架也是面板自己的占位（invite-panel），不是别处的空壳')
  assert.ok(hasTestId(skeleton, 'panel-loading'), '骨架里是面板自己的加载块（panel-loading）')
  assert.match(skeleton, /正在加载/u, '骨架文案取自 zh 文案表（不写死英文）')

  const scene = inviteScene({ invitationCodeEnabled: true })
  const settled = await loadInvite({ settings: scene.consume.settings, aff: scene.consume.aff })
  assert.equal(settled.phase, 'ready', '开关开 + 已登录 → 数据态')
  const content = inviteRender(settled)
  assert.ok(hasTestId(content, 'invite-stats'), '内容态有统计块')
  assert.ok(
    inviteNodeCount(content) >= inviteNodeCount(skeleton),
    '骨架 → 内容只增不减（不会被抹成空）'
  )
})

// ─────────────────────────────────────────── ③ 时间线折叠：两条路径都不出现「可见 → 隐藏」

test('③ 时间线折叠：false 路径全程隐藏；true 路径 loading → ready，永不回落到 hidden', async () => {
  /** 把「初始帧 → 结论帧」折成可见性序列（true = 那一刻 DOM 里有 invite-* 节点） */
  const timeline = async (invitationCodeEnabled) => {
    const scene = inviteScene({ invitationCodeEnabled })
    const first = initialInviteState({ invitationCodeEnabled })
    const settled = await loadInvite({ settings: scene.consume.settings, aff: scene.consume.aff })
    return {
      frames: [first, settled],
      visible: [inviteNodeCount(inviteRender(first)) > 0, inviteNodeCount(inviteRender(settled)) > 0],
    }
  }

  const off = await timeline(false)
  assert.deepEqual(off.visible, [false, false], '开关 false：第一帧与落定都没有 invite-* 节点（0 帧闪现）')

  const on = await timeline(true)
  assert.deepEqual(on.visible, [true, true], '开关 true：第一帧就有骨架，落定是内容 —— 不存在"先可见后隐藏"')

  // 反面口径：把"先渲染后查开关"写回去（初始 loading + 结论 hidden）就是闪现本身
  const flash = [initialInviteState({ invitationCodeEnabled: true }), { phase: 'hidden' }]
  assert.deepEqual(
    flash.map((state) => inviteNodeCount(inviteRender(state))),
    [inviteNodeCount(inviteRender({ phase: 'loading' })), 0],
    '这就是 #830 复现出来的抖动形状：先 >0、后归 0'
  )
})

// ─────────────────────────────────────────────── ④ 源码落位：初值必须走 initialInviteState

test('④ InvitePanel 的初值与 reload 都走 initialInviteState(getAuthFlags())（不许再写死 loading）', () => {
  const source = stripComments(readSource('src/components/consume/InvitePanel.tsx'))

  assert.ok(
    source.includes('initialInviteState(getAuthFlags())'),
    '初值 / 重载都必须按 settings/public 的镜像决定，而不是假设开关开着'
  )
  assert.ok(
    /useState<InviteState>\(\(\) => initialInviteState\(getAuthFlags\(\)\)\)/u.test(source),
    '`useState` 要传惰性初值函数（每次挂载都读当前开关）'
  )
  assert.ok(
    !/useState<InviteState>\(\{\s*phase:\s*'loading'\s*\}\)/u.test(source),
    '禁止再写死 `{ phase: \'loading\' }` 初值 —— 那就是 #830 的病灶'
  )
  assert.ok(
    !/setState\(\{\s*phase:\s*'loading'\s*\}\)/u.test(source),
    'reload() 里也不许无条件落 loading（重试 / 登录态变化时会重新引入闪现）'
  )
})
