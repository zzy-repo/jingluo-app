// [layer: unit | 纯 Node，零浏览器，不发网络请求 | 耗时: <1s]
//
// N2 设置项持久化矩阵（域 9 · 设置与持久化）—— #362 / #367
//
// 覆盖功能点（9 条）：F9-01 主题 · F9-02 字号/字重/行距 · F9-03 思考显示 · F9-04 快速/专家模式（持久化半边）
// · F9-05 回车行为 · F9-06 界面语言 · F9-07 TTS/智能搜索/侧边栏 · F9-08 更新渠道（键归更新链路）· F9-13 脏值容错
//
// 三列 × 14 行（表在 `tests/fixtures/domain08-09/settings-matrix.mjs`）：
//   ① 合法值：调写入口 → 立即生效 + **正好落在那一个键上**（多写一个键也算失败）
//   ② 脏值：手改坏 / 老版本残留 → 冷启动回落默认，不把非法值渲染出去
//   ③ 冷启动读回：进程重启（同模块换 URL 再导入）后值还在
//
// 另外两条契约级断言：
//   ④ 更新渠道的存储键归更新链路（`updateManifest.ts` 的 `chat-demo:update-channel`），
//      初值仍是「按包版本号推断」，用户选过的优先 —— 见 N2-d 里的出处说明
//   ⑤ 写入的键集合 ⊆ 表里声明的键集合：任何人偷偷新增 `chat-demo:*` 键都会被这条拦下
//
//   node --test tests/unit/domain09-settings-persistence.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixtureUrl, installEndpointsGlobals, installTsResolve } from '../helpers/dom-env.mjs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// 装配走公共入口（#408 收尾批）：collector 替身 + `.js→.ts` + 构建期注入值。
// 「只换 src/services/ 下的采集层」这条按父模块的判定原样保留（走 onResolve）。
installTsResolve({
  onResolve: (specifier, context) => (
    /(?:^|\.\/)collector\.js$/.test(specifier) && context.parentURL?.includes('/src/services/')
      ? fixtureUrl('domain08-09/collector-stub.mjs')
      : undefined
  ),
})
installEndpointsGlobals({ resetLogRecords: false })

/** 最小 localStorage（settings.ts / apiConfig.ts 都只做 get / set / remove） */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

/** 浏览器语言：语言回落相关的两行按 zh 浏览器取口径（N2-e 再验 en 浏览器） */
const setBrowserLocale = (language) => {
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true })
}
setBrowserLocale('zh-CN')

const settingsUrl = new URL('../../src/services/settings.ts', import.meta.url).href
const apiUrl = new URL('../../src/services/api/apiConfig.ts', import.meta.url).href

/** 冷启动：同一个模块以不同 URL 再导入一次，等价于应用重启后重新初始化 store */
let bootCount = 0
const boot = async () => {
  bootCount += 1
  const [settings, api] = await Promise.all([
    import(`${settingsUrl}?boot=${bootCount}`),
    import(`${apiUrl}?boot=${bootCount}`),
  ])
  return { settings, api }
}

/**
 * 把「存储内容」写进假 localStorage：
 * - 字符串 = 这一行主键的值（脏值场景最常见）
 * - 对象 = 多键一起 seed（例如 chat-mode 与它的兼容键 thinking）
 */
const seed = (row, spec) => {
  storage.clear()
  if (typeof spec === 'string') {
    assert.equal(row.keys.length >= 1, true, `${row.id} 没有主键却按字符串 seed`)
    storage.set(row.keys[0], spec)
    return
  }
  for (const [key, value] of Object.entries(spec)) storage.set(key, value)
}

/** 一行 × 一个合法值的落盘期望：声明的键 + 写入口顺带写的兼容键 */
const expectedStores = (row, item) => ({ [row.keys[0]]: item.store, ...(item.also ?? {}) })

const { SETTING_ROWS, UPDATE_CHANNEL_CONTRACT, DEFAULT_KIND } = await import(
  '../fixtures/domain08-09/settings-matrix.mjs'
)

test('N2-a 合法值：写入口立即生效，且只落在那一个键上', async () => {
  const checked = []
  for (const row of SETTING_ROWS) {
    if (!row.write) continue
    for (const item of row.legal) {
      storage.clear()
      const mods = await boot()
      const value = 'value' in item ? item.value : item.store
      row.write(mods, value)
      assert.deepEqual(
        Object.fromEntries(storage),
        expectedStores(row, item),
        `${row.id} ${row.label}：落盘的键与值必须正好是声明的那一个（多写/少写都不行）`
      )
      assert.deepEqual(row.read(mods), item.expect, `${row.id} ${row.label}：写入后应立即生效`)
      checked.push(`${row.id}/${item.store}`)
    }
  }
  console.log(`  ·  合法值：${checked.length} 个取值覆盖 ${SETTING_ROWS.filter((r) => r.write).length} 个设置项`)
  assert.ok(checked.length >= 25, '合法值覆盖数应 ≥ 25（表被剪了就要在这里同步口径）')
})

test('N2-b 脏值：非法枚举 / 空串 / 大小写变体一律回落默认，不把非法值留在 state 里', async () => {
  const failures = []
  let cases = 0
  for (const row of SETTING_ROWS) {
    if (!row.read) continue
    for (const item of row.dirty ?? []) {
      cases += 1
      seed(row, item.store)
      const mods = await boot()
      const actual = row.read(mods)
      if (JSON.stringify(actual) !== JSON.stringify(item.expect)) {
        failures.push(
          `${row.id} ${row.label}：脏值 ${JSON.stringify(item.store)} 期望 ${JSON.stringify(item.expect)}，实际 ${JSON.stringify(actual)}`
        )
      }
    }
  }
  console.log(`  ·  脏值：${cases} 个用例覆盖 ${SETTING_ROWS.filter((r) => (r.dirty ?? []).length).length} 个设置项`)
  assert.deepEqual(failures, [])
})

test('N2-c 冷启动读回：合法值重启后还在（13 个 chat-demo 键族）', async () => {
  const failures = []
  let cases = 0
  for (const row of SETTING_ROWS) {
    if (!row.read) continue
    for (const item of row.legal) {
      cases += 1
      seed(row, expectedStores(row, item))
      const mods = await boot()
      const actual = row.read(mods)
      if (JSON.stringify(actual) !== JSON.stringify(item.expect)) {
        failures.push(
          `${row.id} ${row.label}：冷启动后期望 ${JSON.stringify(item.expect)}，实际 ${JSON.stringify(actual)}`
        )
      }
    }
  }
  console.log(`  ·  冷启动读回：${cases} 个取值`)
  assert.deepEqual(failures, [])
})

test('N2-d 更新渠道：键归更新链路（chat-demo:update-channel），初值仍按包版本号推断', async () => {
  // 随 556067a（#470，#412 第 3 项）变更：这条原来断言「更新渠道不持久化、文件里没有任何存储痕迹」。
  // #412 有意让「切到仅稳定版」被记住（否则重开设置就回到按包版本号猜的默认值），所以口径改成：
  //   - 推断仍是兜底：初值 = readUpdateChannel(版本号里有没有 `-` ? prerelease : stable)；
  //   - 读写**只许**走 updateManifest.ts（键与脏值回落都在那儿），组件里不许直接摸存储。
  const source = readFileSync(
    fileURLToPath(new URL('../../src/components/settings/AppUpdateField.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(
    source,
    UPDATE_CHANNEL_CONTRACT.derive,
    `更新渠道的初值必须仍以包版本号推断作兜底（${UPDATE_CHANNEL_CONTRACT.file}）`
  )
  // 注释里出现 `localStorage` / `chat-demo:` 是正常的（在讲缓存来源），只剥注释后再查真正的读写
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const forbidden of UPDATE_CHANNEL_CONTRACT.forbidden) {
    assert.doesNotMatch(code, forbidden, `更新渠道的存储读写必须走 service，组件里不许自己摸：${forbidden}`)
  }

  // ① 键声明在更新链路而不是设置矩阵：整个 src/ 里只有一处写这个字面量
  const service = readFileSync(
    fileURLToPath(new URL(`../../${UPDATE_CHANNEL_CONTRACT.service.file}`, import.meta.url)),
    'utf8'
  )
  assert.match(
    service,
    new RegExp(`UPDATE_CHANNEL_KEY = '${UPDATE_CHANNEL_CONTRACT.service.key}'`),
    `更新渠道的键必须声明在 ${UPDATE_CHANNEL_CONTRACT.service.file}`
  )
  assert.doesNotMatch(
    service,
    /readUpdateChannel\(\s*\)/,
    'readUpdateChannel 必须要求调用方给 fallback：脏值要回落到「按包版本号推断」，不能回落到硬编码猜测'
  )

  // ② 数据层：把 12 个设置写一遍，存储里不应冒出任何 update/channel 键（这一项不归设置矩阵管）
  storage.clear()
  const mods = await boot()
  for (const row of SETTING_ROWS) {
    if (!row.write) continue
    const item = row.legal[0]
    row.write(mods, 'value' in item ? item.value : item.store)
  }
  const keys = [...storage.keys()]
  assert.deepEqual(
    keys.filter((key) => /update|channel/i.test(key)),
    [],
    '设置项的写入口不许顺手写更新渠道的键（那一项由 updateManifest.ts 管，两处各写一遍必然漂移）'
  )
})

test('N2-e 写入的键集合 ⊆ 表里声明的键集合（防止偷偷新增 chat-demo:* 键）', async () => {
  storage.clear()
  const mods = await boot()
  for (const row of SETTING_ROWS) {
    if (!row.write) continue
    for (const item of row.legal) {
      row.write(mods, 'value' in item ? item.value : item.store)
    }
  }
  const declared = new Set(SETTING_ROWS.flatMap((row) => row.keys))
  const undeclared = [...storage.keys()].filter((key) => !declared.has(key))
  console.log(`  ·  键审计：写入 ${storage.size} 个键，声明 ${declared.size} 个`)
  assert.deepEqual(undeclared, [], `出现了表外存储键：${undeclared.join(', ')}（要么加进表，要么别写）`)
  for (const key of storage.keys()) {
    assert.match(key, /^chat-demo:/, `设置项存储键必须带 chat-demo: 前缀：${key}`)
  }
  // 声明的键都真的被写出来了（防止「表里有、代码里没有」）
  const neverWritten = [...declared].filter(
    (key) => key !== 'chat-demo:location' && !storage.has(key) && key !== 'chat-demo:thinking'
  )
  assert.deepEqual(neverWritten, [], `表里声明但代码从没写过的键：${neverWritten.join(', ')}`)
})

test('N2-f 语言回落跟浏览器语言走（zh / en 两种宿主）', async () => {
  // 语言：没存过 → 浏览器语言；存了脏值 → 也按浏览器语言
  for (const [language, expected] of [
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['en-US', 'en-US'],
    ['fr-FR', 'en-US'],
  ]) {
    setBrowserLocale(language)
    seed({ keys: ['chat-demo:locale'] }, { 'chat-demo:locale': 'klingon' })
    const mods = await boot()
    assert.equal(mods.settings.useSettings.getState().locale, expected, `浏览器 ${language} 应回落 ${expected}`)
  }
  // 位置：zh 浏览器要求「国家 + 省市」齐全，en 浏览器只保留国家（与旧行为一致）
  setBrowserLocale('en-US')
  seed({ keys: ['chat-demo:location'] }, { 'chat-demo:location': '{"region":"CN"}' })
  let mods = await boot()
  assert.deepEqual(mods.settings.useSettings.getState().location, { region: 'CN' }, 'en 浏览器只留国家')
  seed({ keys: ['chat-demo:location'] }, { 'chat-demo:location': '{"region":"CN","province":"110000"}' })
  mods = await boot()
  assert.deepEqual(mods.settings.useSettings.getState().location, { region: 'CN' }, 'en 浏览器丢掉省市')
  setBrowserLocale('zh-CN')
  assert.equal(DEFAULT_KIND, 'deepseek', '标准构建的默认渠道应是 DeepSeek 官方')
})

test('N2-g 覆盖账：14 行落 9 个功能点', () => {
  const fns = [...new Set(SETTING_ROWS.map((row) => row.fn))].sort()
  assert.equal(SETTING_ROWS.length, 14, '矩阵行数应为 14（与域 9 盘点文档 §8.3 对齐）')
  assert.deepEqual(
    fns,
    ['F9-01', 'F9-02', 'F9-03', 'F9-04', 'F9-05', 'F9-06', 'F9-07', 'F9-08', 'F9-13'],
    'N2 直接覆盖的 9 个功能点'
  )
  const withDirty = SETTING_ROWS.filter((row) => (row.dirty ?? []).length > 0)
  assert.equal(withDirty.length, 13, '除「更新渠道」那一行（无键）外都要有脏值列')
})
