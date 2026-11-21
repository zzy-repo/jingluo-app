// [layer: unit | 依赖: 无（纯 Node + zustand 内存 store + 读源码，零浏览器零网络） | 耗时: <1s]
//
// Issue #711 —— **设置弹窗侧边栏下线「记忆」分组**（只切 UI 入口，记忆服务不动）。
//
// 背景：#398 曾为「窗口记忆」在设置弹窗里加了第三个分组 `memory`，组里只有一个 embedding 开关
// （`data-testid="memory-embedding-toggle"`，写 `settings.embeddingEnabled`）。#711 把这个入口撤掉：
// 侧边栏只剩「通用设置」「数据管理」，`SettingsSection` **直接收窄**成 `'general' | 'data'`
// （不是「留着值但入口不可达」—— 靠 tsc 让残留引用报错），渲染分支与只服务它的组件一起删。
//
// 本文件钉住四件事（与 issue 验收表一一对应）：
//   T1 侧边栏数据只剩两项，顺序与图标不变（general → 齿轮，data → 数据）
//   T2 旧值兜底：store 里残留 `'memory'`（老包/回滚留下的脏值）→ 收敛成 `general`，不崩不空白
//   T3 旧调用方 `openSettings('memory')`（JS 侧不受 tsc 管）→ 打开的仍是设置，落在 `general`
//   T4 收窄后两项仍可切换（general / data），别的入口（账户与消费）仍落 `data`
//
// 另加三条「没被顺手改坏」的护栏：
//   T5 类型真的收窄了（源码层面；**硬门是 `npx tsc`**：留一处 `'memory'` 就 TS2322）
//   T6 i18n 两组 key 在 zh.ts / en.ts **两份**里都删干净，两项的 label key 仍在
//   T7 `src/services/memory/**` 与 `settings.embeddingEnabled` 一字未动（本期只切入口）
//
// 负向对照（N1，同进程）：把「记忆」入口加回侧边栏源码形状 → T1 的判据必须红。
//
// 为什么不渲染 `.tsx`：仓内还没有 Node 侧 JSX 装配（`.tsx` 裸 import 不了），组件层证据走
// 真浏览器截图 + `docs/ui/711-settings-no-memory/{390,360}/metrics.json`（tab 数 / 「记忆」文案 /
// `memory-embedding-toggle` 命中数为 0）。这里测的是**所有入口共用的那一份状态契约 + 接线形状**。
//
//   node --test tests/unit/settings-memory-section-off-711.test.mjs
//   node tests/run-layer.mjs unit --only settings-memory-section-off-711
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// 构建期注入值（`__ENDPOINTS__` / `__API_ORIGIN__`）与 `.js → .ts` 解析钩子：共享装配，
// 不各抄一份（#407 / #362 §2 D7）。`settingsDialogState` 会连带加载 `apiConfig`。
import { installResolveHooks } from '../helpers/contract.mjs'
import { installEndpointsGlobals, ROOT } from '../helpers/dom-env.mjs'

installEndpointsGlobals()
installResolveHooks()

const dialog = await import('../../src/components/settings/settingsDialogState.ts')
const memoryGate = await import('../../src/services/memory/embeddingGate.ts')
const settingsStore = await import('../../src/services/settings.ts')

const DIALOG_FILE = 'src/components/settings/SettingsDialog.tsx'
const STATE_FILE = 'src/components/settings/settingsDialogState.ts'
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

const reset = () => {
  dialog.useSettingsDialog.setState({
    open: false,
    section: 'general',
    accountConsumeOpen: false,
    accountConsumeTab: 'cards',
  })
}

/**
 * 从 `SettingsDialog.tsx` 的 `sections` 数组里抠出**真接线**：每项的 `value` / `label` / `icon`。
 *
 * 不重写一份「侧边栏应该长什么样」的假数据 —— 判据读组件源码里那个数组本体，
 * 所以组件真被改回三项时这里立刻看得见（N1 用同一个函数跑假源码证明它会红）。
 */
const sidebarOf = (source) => {
  const start = source.indexOf('const sections:')
  assert.notEqual(start, -1, '找不到侧边栏数组 `const sections:`（被改名/搬走了？先核对再改判据）')
  const end = source.indexOf('\n]', start)
  assert.notEqual(end, -1, '找不到侧边栏数组的结尾 `]`')
  const block = source.slice(start, end)
  return {
    values: [...block.matchAll(/value: '([A-Za-z]+)'/gu)].map((match) => match[1]),
    labels: [...block.matchAll(/label: '([A-Za-z]+)'/gu)].map((match) => match[1]),
    icons: [...block.matchAll(/icon: <(Icon[A-Za-z0-9]+) \/>/gu)].map((match) => match[1]),
  }
}

/** 判据本体：侧边栏**只**允许「通用设置 + 数据管理」，顺序与图标保持原样 */
const assertSidebarSections = (source, { whence }) => {
  const { values, labels, icons } = sidebarOf(source)
  assert.deepEqual(values, ['general', 'data'], `${whence}：侧边栏必须只剩两项，顺序 general → data`)
  assert.deepEqual(
    labels,
    ['settingDialogAsideGeneralOptionLabel', 'settingDialogAsideDataOptionLabel'],
    `${whence}：两项的文案 key 不许换`
  )
  assert.deepEqual(
    icons,
    ['IconSettingsOutline16', 'IconDataOutline16'],
    `${whence}：两项的图标不许换（#711 只删「记忆」这一项）`
  )
}

// ------------------------------------------------------------------ T1 侧边栏只剩两项

test('T1 侧边栏只剩 general / data 两项，顺序与图标不变', () => {
  const source = sourceOf(DIALOG_FILE)
  assertSidebarSections(source, { whence: 'SettingsDialog.tsx' })

  // 「记忆」这一项的三个痕迹都得没有：值、文案 key、图标（`IconThinkOutline16` 只服务它）
  const start = source.indexOf('const sections:')
  const block = source.slice(start, source.indexOf('\n]', start))
  for (const banned of ['memory', 'IconThinkOutline16', 'settingDialogAsideMemoryOptionLabel']) {
    assert.equal(block.includes(banned), false, `侧边栏数组里不许再有 \`${banned}\``)
  }
})

// ------------------------------------------------------------------ T2 旧值兜底（store 脏值）

test("T2 store 里残留 section: 'memory' → 收敛成 general（组件 useState 初始化器走同一条路）", () => {
  reset()
  // 模拟旧版本留下 / 手工塞进来的脏值：绕过 openSettings 直接写 store（组件读的就是这个字段）
  dialog.useSettingsDialog.setState({ open: true, section: 'memory' })
  const raw = dialog.useSettingsDialog.getState().section
  assert.equal(raw, 'memory', '前提：脏值确实进得来（store 不做校验，收敛放在读入侧）')

  // `SettingsDialog` 的 `useState(() => normalizeSettingsSection(store.section))` 就是这一条
  const landed = dialog.normalizeSettingsSection(raw)
  assert.equal(landed, 'general', "残留的 'memory' 必须回落到「通用设置」")
  assert.equal(
    dialog.normalizeSettingsSection('data'),
    'data',
    '合法值不许被顺手改掉（回落只对非法值生效）'
  )
  assert.equal(dialog.normalizeSettingsSection('general'), 'general', '合法值原样返回')

  // 其它脏值同一条口径：老包 / 手工塞值 / 未来有人手滑
  for (const dirty of ['memory', '', 'settings', 'GENERAL', 'Memory', 0, null, undefined, {}]) {
    assert.equal(
      dialog.normalizeSettingsSection(dirty),
      'general',
      `非法 section ${JSON.stringify(dirty)} 必须回落到 general`
    )
  }
})

// ------------------------------------------------------------------ T3 旧调用方传脏值

test("T3 openSettings('memory')（JS 调用方，tsc 管不到）→ 该照常打开，但落在 general", () => {
  reset()
  assert.doesNotThrow(() => dialog.openSettings('memory'), '旧调用方传脏值不许崩')

  const now = dialog.useSettingsDialog.getState()
  assert.equal(now.open, true, '该打开的仍要打开（不能因为值非法就静默不动）')
  assert.equal(now.section, 'general', '非法值必须落在「通用设置」')

  // 收敛发生在**写进 store 之前**：store 里不该出现过 'memory'（否则读 state.section 的每一处都要各自兜）
  for (const dirty of ['memory', '', null]) {
    reset()
    dialog.openSettings(dirty)
    assert.notEqual(
      dialog.useSettingsDialog.getState().section,
      'memory',
      `openSettings(${JSON.stringify(dirty)}) 不许把 'memory' 写进 store`
    )
  }
  // 组件侧也过一遍同一个收敛函数（local state 切换只会写合法值，这条是最后一道）
  const source = sourceOf(DIALOG_FILE)
  assert.match(
    source,
    /useState\(\(\) =>\s*normalizeSettingsSection\(useSettingsDialog\.getState\(\)\.section\)\s*\)/u,
    'SettingsDialog 挂载时必须把 store 里的 section 过一遍 normalizeSettingsSection'
  )
})

// ------------------------------------------------------------------ T4 两项仍可切换

test('T4 收窄后两项仍可切换；账户与消费入口仍落「数据管理」', () => {
  for (const target of ['general', 'data']) {
    reset()
    dialog.openSettings(target)
    assert.equal(
      dialog.useSettingsDialog.getState().section,
      target,
      `「${target}」仍要能作为落点（收窄不等于弄坏既有入口）`
    )
  }
  reset()
  dialog.openAccountConsume()
  assert.equal(
    dialog.useSettingsDialog.getState().section,
    'data',
    '付款回跳 / 额度 CTA 仍走「设置 → 数据管理 → 账户与消费」'
  )
})

// ------------------------------------------------------------------ T5 类型收窄

test("T5 SettingsSection 直接收窄成 'general' | 'data'（硬门是 npx tsc，这里钉住形状）", () => {
  const source = sourceOf(STATE_FILE)
  assert.match(
    source,
    /export type SettingsSection = 'general' \| 'data'/u,
    "必须是「直接收窄」：保留 'memory' 但入口不可达不算完成（issue 明确要求）"
  )
  assert.equal(
    /export type SettingsSection = [^\n]*'memory'/u.test(source),
    false,
    "SettingsSection 的联合里不许出现 'memory'"
  )
  // 收敛函数必须由状态层导出（组件与 openSettings 共用同一份，不各写一遍）
  assert.match(
    source,
    /export const normalizeSettingsSection = \(value: unknown\): SettingsSection =>/u,
    '收敛函数必须 export：两个调用点（组件读入 / openSettings 写入前）共用同一份'
  )
})

// ------------------------------------------------------------------ T6 i18n 两份都删干净

test('T6 记忆分组的两组 i18n key 在 zh / en 两份里都没了；两项的 label key 仍在', () => {
  const banned = [
    'settingDialogAsideMemoryOptionLabel',
    'settingDialogMemoryEmbeddingLabel',
    'settingDialogMemoryEmbeddingDescription',
    'settingDialogMemoryEmbeddingOn',
    'settingDialogMemoryEmbeddingOff',
    'settingDialogMemoryEmbeddingNoEndpoint',
    'settingDialogMemoryEmbeddingNoCredential',
  ]
  for (const file of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
    const source = sourceOf(file)
    for (const key of banned) {
      assert.equal(source.includes(`${key}:`), false, `${file} 里不该再定义 \`${key}\`（两份都要删）`)
    }
    // 反向：留下来那两项的文案必须还在（删孤立 key 不等于把别人的 key 一起删了）
    for (const kept of ['settingDialogAsideGeneralOptionLabel', 'settingDialogAsideDataOptionLabel']) {
      assert.equal(source.includes(`${kept}:`), true, `${file} 里必须仍有 \`${kept}\``)
    }
  }
})

// ------------------------------------------------------------------ T7 记忆服务未动

test('T7 记忆服务与 embeddingEnabled 持久化没动：删的是 UI 入口，不是存储', () => {
  assert.equal(typeof memoryGate.embed, 'function', 'src/services/memory/embeddingGate.ts 的 embed() 仍在')
  assert.equal(typeof memoryGate.isEmbeddingEnabled, 'function', 'isEmbeddingEnabled() 仍在（门没被拆）')
  assert.equal(
    settingsStore.useSettings.getState().embeddingEnabled,
    false,
    'embeddingEnabled 仍默认关闭：本期不动持久化与迁移，删入口不等于改默认值'
  )
  assert.equal(
    typeof settingsStore.setEmbeddingEnabled,
    'function',
    'setEmbeddingEnabled() 的写入口仍在（删的是 UI 入口）'
  )
})

// ------------------------------------------------------------------ N1 负向对照

test('[N1] 负向对照：把「记忆」项加回侧边栏 → T1 的判据必红（证明不是空跑）', () => {
  // 还原 #398 的形状：三行 `sections`（值 / 文案 key / 图标都照当年的写法）
  const withMemory = [
    'const sections: … = [',
    "  { value: 'general', label: 'settingDialogAsideGeneralOptionLabel', icon: <IconSettingsOutline16 /> },",
    "  { value: 'memory', label: 'settingDialogAsideMemoryOptionLabel', icon: <IconThinkOutline16 /> },",
    "  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },",
    ']',
  ].join('\n')

  // 对照前提：抠出来的确实是三项（否则下面的 throws 可能只是抠解析失败，看着红其实没判）
  assert.deepEqual(sidebarOf(withMemory).values, ['general', 'memory', 'data'], '对照前提：加回去确实三项')
  assert.throws(
    () => assertSidebarSections(withMemory, { whence: '负向对照' }),
    /只剩两项/u,
    '判据必须把「三项」判红 —— 否则 T1 就是一条永远绿的空跑用例'
  )

  // 同一个判据对**当前真源码**必须不抛：红只对回归成立，不是恒红
  assert.doesNotThrow(() => assertSidebarSections(sourceOf(DIALOG_FILE), { whence: '当前真源码' }))
})
