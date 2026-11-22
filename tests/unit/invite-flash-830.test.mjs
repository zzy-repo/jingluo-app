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
//   ① **初始态恒为 hidden** → 第一帧渲染 `''`（DOM 里 0 个 `invite-*`），落定后也不会"先有后无"；
//   ② 拿到数据 → 一次性落成品；骨架仍在类型/视图里（重试等场景可用），但它**不许**当初始态，
//      骨架 → 内容只增不减；
//   ③ 时间线不会出现「可见 → 隐藏」（main 路径 hidden→ready；失败路径 hidden→failed，两者都单调）；
//   ④ 源码里不许再出现写死的 `useState<InviteState>({ phase: 'loading' })`，也不许在 reload 里无条件落
//      loading / 先清成 hidden（删掉修复 → 立刻红）。
//
// **#819-v2（2026-11-22，本文件的第二次口径变更）**：上一版把初始态的判据挂到
// `settings/public.invitation_code_enabled` 上（"确认开着才从骨架起跳"）。那条判据现在**整个撤掉** ——
// 可见性的真值来自 `GET /user/aff`（#819-v2：面板可见性 = 已登录 + aff 拿到邀请码），初始态因此恒为
// `hidden`。这比上一版**更严**：无论开关怎么写，第一帧都必须是 0 个 `invite-*` 节点，骨架永不作初始态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

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

/**
 * 假后端：#819-v2 起面板**只**该打 `GET /user/aff`。
 * `settings/public` 仍然登记着（万一有人把开关读回来也不至于炸得莫名其妙），但下面 ① 断言
 * 「一条都没打过」—— 可见性与开关解耦这件事在请求层面同样被钉住。
 */
const inviteScene = ({ aff = AFF } = {}) => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'GET' && path === '/api/v1/settings/public') {
      return panelOk({
        registration_enabled: true,
        invitation_code_enabled: false,
        affiliate_enabled: false,
      })
    }
    if (request.method === 'GET' && path === '/api/v1/user/aff') {
      if (aff === null) {
        return jsonReply(503, { code: 'HTTP_503', message: 'upstream down' })
      }
      return panelOk(aff)
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

test('① 初始态恒为 hidden，第一帧渲染 0 个 invite-* 节点（#830 的硬要求，#819-v2 更严）', async () => {
  const initial = initialInviteState()
  assert.deepEqual(initial, { phase: 'hidden' }, '初始态必须是 hidden（不是 loading、不看任何开关）')

  const firstFrame = inviteRender(initial)
  assert.equal(firstFrame, '', 'hidden 时面板返回 null —— 第一帧 DOM 里什么都没有')
  assert.equal(inviteNodeCount(firstFrame), 0, '第一帧必须 0 个 invite-* 节点（闪现的病灶就死在这一行）')

  // 服务端没给邀请码 → 结论仍是 hidden：hidden → hidden，全程没有可见帧
  const scene = inviteScene({ aff: { ...AFF, aff_code: '' } })
  const settled = await loadInvite({ aff: scene.consume.aff })
  assert.deepEqual(settled, { phase: 'hidden' }, '没拿到 aff_code → 落 hidden')
  assert.equal(inviteNodeCount(inviteRender(settled)), 0, '落定后依然 0 个 invite-* 节点')

  // 解耦钉：整条链路不许再问 settings/public（可见性 = 已登录 + aff 有码）
  assert.deepEqual(scene.sequence(), ['GET /api/v1/user/aff'], '只打 aff，不读 settings/public')
})

// ─────────────────────────────────── ② 开关 true：骨架仍在，但它是"会变成内容"的那一个

test('② 拿到 aff 数据 → 一次性落成品；骨架可渲染但**不作**初始态，节点只增不减', async () => {
  assert.deepEqual(initialInviteState(), { phase: 'hidden' }, '初始态恒为 hidden（真值来自 GET /user/aff）')

  // 骨架能力保留（重试等场景仍可用），但它是"会变成内容"的那一个，不是要被抹掉的
  const skeleton = inviteRender({ phase: 'loading' })
  assert.ok(hasTestId(skeleton, 'invite-panel'), '骨架也是面板自己的占位（invite-panel），不是别处的空壳')
  assert.ok(hasTestId(skeleton, 'panel-loading'), '骨架里是面板自己的加载块（panel-loading）')
  assert.match(skeleton, /正在加载/u, '骨架文案取自 zh 文案表（不写死英文）')

  const scene = inviteScene()
  const settled = await loadInvite({ aff: scene.consume.aff })
  assert.equal(settled.phase, 'ready', '已登录 + aff 有码 → 数据态')
  const content = inviteRender(settled)
  assert.ok(hasTestId(content, 'invite-stats'), '内容态有统计块')
  assert.ok(hasTestId(content, 'invite-code-value'), '内容态有邀请码')
  assert.ok(
    inviteNodeCount(content) >= inviteNodeCount(skeleton),
    '骨架 → 内容只增不减（不会被抹成空）'
  )
})

// ─────────────────────────────────────────── ③ 时间线折叠：两条路径都不出现「可见 → 隐藏」

test('③ 时间线折叠：hidden → ready（有码）/ hidden → hidden（无码）/ hidden → failed，都不回落', async () => {
  /** 把「初始帧 → 结论帧」折成可见性序列（true = 那一刻 DOM 里有 invite-* 节点） */
  const timeline = async (aff) => {
    const scene = inviteScene({ aff })
    const first = initialInviteState()
    const settled = await loadInvite({ aff: scene.consume.aff })
    return {
      frames: [first, settled],
      visible: [inviteNodeCount(inviteRender(first)) > 0, inviteNodeCount(inviteRender(settled)) > 0],
    }
  }

  const none = await timeline({ ...AFF, aff_code: '' })
  assert.deepEqual(none.visible, [false, false], '没有邀请码：第一帧与落定都没有 invite-* 节点（0 帧闪现）')

  const ok = await timeline(AFF)
  assert.deepEqual(ok.visible, [false, true], '有邀请码：0 个 → 成品（只有"无 → 有"，不存在"先可见后隐藏"）')

  const failed = await timeline(null)
  assert.deepEqual(failed.visible, [false, true], 'aff 失败：0 个 → 错误块（同样是"无 → 有"，不是回落）')

  // 反面口径：把"先渲染后下结论"写回去（初始可见 + 结论 hidden）就是闪现本身
  const flash = [{ phase: 'loading' }, { phase: 'hidden' }]
  assert.deepEqual(
    flash.map((state) => inviteNodeCount(inviteRender(state))),
    [inviteNodeCount(inviteRender({ phase: 'loading' })), 0],
    '这就是 #830 复现出来的抖动形状：先 >0、后归 0'
  )
})

// ─────────────────────────────────────────────── ④ 源码落位：初值必须走 initialInviteState

test('④ InvitePanel 的初值走 initialInviteState()（不许写死 loading，也不许再看 settings/public 开关）', () => {
  const source = stripComments(readSource('src/components/consume/InvitePanel.tsx'))

  assert.ok(source.includes('initialInviteState()'), '初值必须走 initialInviteState()（恒 hidden）')
  assert.ok(
    /useState<InviteState>\(\(\) => initialInviteState\(\)\)/u.test(source),
    '`useState` 要传惰性初值函数（每次挂载都从 hidden 起跳）'
  )
  assert.ok(
    !/useState<InviteState>\(\{\s*phase:\s*'loading'\s*\}\)/u.test(source),
    '禁止再写死 `{ phase: \'loading\' }` 初值 —— 那就是 #830 的病灶'
  )
  assert.ok(
    !/setState\(\{\s*phase:\s*'loading'\s*\}\)/u.test(source),
    'reload() 里也不许无条件落 loading（重试 / 登录态变化时会重新引入闪现）'
  )
  assert.ok(
    !/setState\(initialInviteState\(\)\)/u.test(source),
    '#819-v2：reload() 也不许先把态清回 hidden —— 那会在重试时引入"有 → 无 → 有"'
  )
  assert.ok(
    !/getAuthFlags|invitationCodeEnabled/.test(source),
    '#819-v2：可见性与 settings/public 的开关解耦 —— 容器里不许再出现开关判断'
  )
})
