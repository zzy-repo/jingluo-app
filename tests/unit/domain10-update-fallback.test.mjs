// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// 域10 · 检查更新的三个剩余项（Issue #412，承接 #309 第 3/5 条与 #310 期望第 4 条）
//
// 三件事各自对应一段「以前没有断言、于是没人知道它到底成不成立」的行为：
//   A. 缓存兜底：检查失败时用上次成功的清单展示（带结构版本 / 时间戳 / 上限 / 读时重校验）；
//   B. 手动下载兜底：失败时给一条能真的拿到安装包的路（缓存里的最新 file，或下载站首页）；
//   C. 渠道下拉语义：切「仅稳定版」到底改变了什么 —— 请求参数不变（清单只有一份），
//      **候选筛选变了**（prerelease 条目必须被过滤），且选择要持久化（重开设置仍成立）。
//
// 为什么这些断言放在 L0 而不是集成层：三条都是纯判定（解析 / 筛选 / 序列化 / 反序列化），
// 验的是「逻辑真的变了没有」，不是「DOM 长什么样」。DOM 那半截（缓存标注上屏、下拉重开后仍是
// 原值）由 tests/integration/domain10-update-check-flow.test.mjs 的 C7/C8/C9 隔着真浏览器钉住。
//
// 表驱动：一行 = 一种「已装版本 × 变体 × 渠道 × 清单」或「一份存储内容」。`table()` 把行 id 与
// 说明直接写进失败信息里，红了不用再猜是哪一行。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
installTsResolve()

const {
  MANIFEST_CACHE_KEY,
  MANIFEST_CACHE_MAX_AGE_MS,
  MANIFEST_CACHE_MAX_RELEASES,
  MANIFEST_CACHE_VERSION,
  PRIMARY_RELEASE_BASE,
  RELEASE_HOME_URL,
  fetchManifest,
  manualDownloadTarget,
  parseManifest,
  readManifestSnapshot,
  releaseUrl,
  saveManifestSnapshot,
  clearManifestSnapshot,
  selectUpdate,
} = await loadTsModule('src/services/updateManifest.ts')

/**
 * localStorage 的最小替身：`failOn` 让某一次写操作抛错（配额满 / 隐私模式），
 * 用来断言「存储不可用时界面不被带崩」——那是缓存这类"锦上添花"功能最常见的线上事故。
 */
const memoryStorage = (initial = {}, { failOn = null } = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failOn === 'set') throw new Error('QUOTA_EXCEEDED')
      map.set(key, String(value))
    },
    removeItem: (key) => {
      if (failOn === 'remove') throw new Error('STORAGE_UNAVAILABLE')
      map.delete(key)
    },
  }
}

const rel = (version, versionCode, artifactVariant, buildType) => ({
  version,
  versionCode,
  artifactVariant,
  buildType,
  size: 5_000_000,
  file: `apk/deepseek-chat-${version}.apk`,
  changes: [`${version} 的说明`],
  sha256: 'a'.repeat(64),
})

/**
 * 逐行跑：`check(row)` 抛错时把 `id` 与 `what` 一起写进报错，失败信息不用再回头翻表。
 * （与 tests/helpers/contract.mjs 的 tableTest 同一思路，但契约层那份带 `[C2]` 前缀，
 * 这里不复用 —— 契约层的前缀是它自己的语义，混用会让日志分不清是哪一层红的。）
 */
const table = (rows, check) => {
  for (const row of rows) {
    try {
      check(row)
    } catch (error) {
      error.message = `[#412 ${row.id}] ${row.what}\n  ↳ ${error.message}`
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// C. 档位固定（#876：渠道功能下线，用户侧只剩一档 = 原来的「稳定版」）
//
// 原来这一节是「渠道下拉语义」表驱动：切渠道 → 候选结论跟着变。渠道删掉之后，能钉的只剩两件事：
//   ① 请求仍然只有一个地址（`/releases.json`，档位从来不是请求参数）——防止下一个人以为
//      「选了稳定版就该去 /stable/releases.json」；
//   ② `buildType: 'prerelease'` 的记录**永远**不进候选（哪怕它是内测包、哪怕它 code 更高）。
// 第 ② 条的后果（内测 beta 包目前没有候选）单独由 private-manifest-622 的用例钉住。
// ---------------------------------------------------------------------------

/** #377 现场：1.4.1 只发 standard、1.4.0 只发 internal（变体维度断链） */
const BROKEN = [rel('1.4.1', 20, 'standard', 'stable'), rel('1.4.0', 19, 'internal', 'prerelease')]
/** 两个变体都发齐 */
const COMPLETE = [
  rel('1.4.1', 20, 'standard', 'stable'),
  rel('1.4.1', 20, 'internal', 'stable'),
  rel('1.4.0', 19, 'internal', 'prerelease'),
]
/** 只发了更高的预发布内测包 */
const BETA_ONLY = [rel('1.4.1-beta.1', 21, 'internal', 'prerelease'), rel('1.4.0', 19, 'internal', 'prerelease')]
/** 同变体下「稳定版 code 20」与「预发布 code 21」并存：档位真的在筛 */
const STABLE_AND_BETA = [
  rel('1.4.0-beta.2', 21, 'standard', 'prerelease'),
  rel('1.4.0', 20, 'standard', 'stable'),
]

/** 一行 = 一份清单 × 一台已装包 → 唯一的期望结论（#876：没有 channel 维度了） */
const CHANNEL_ROWS = [
  {
    id: 'S1',
    what: '#876 后果：更高只有预发布内测包 → 没有候选，reason=up-to-date（预发布不进候选）',
    manifest: BETA_ONLY,
    installed: 19,
    variant: 'internal',
    expect: { code: undefined, reason: 'up-to-date' },
  },
  {
    id: 'S2',
    what: '变体维度断链（#377）：没有候选，reason 必须说「内测包没发」而不是「已是最新」',
    manifest: BROKEN,
    installed: 19,
    variant: 'internal',
    expect: { code: undefined, reason: 'no-internal-variant' },
  },
  {
    id: 'S3',
    what: '稳定版与预发布并存 → 跳过预发布，选中稳定那条（code 20，不是 21）',
    manifest: STABLE_AND_BETA,
    installed: 19,
    variant: 'standard',
    expect: { code: 20, reason: undefined },
  },
  {
    id: 'S4',
    what: '变体发齐 → 内测包装到 internal 的 1.4.1（这一格坏了就是 #377 复发）',
    manifest: COMPLETE,
    installed: 19,
    variant: 'internal',
    expect: { code: 20, reason: undefined },
  },
]

/** 与组件里的一条检查等价：同一个请求（清单地址与档位无关）→ 解析 → 筛选 */
const runCheck = async (row) => {
  const urls = []
  const request = async (url) => {
    urls.push(String(url))
    return { ok: true, text: async () => JSON.stringify({ releases: row.manifest }) }
  }
  const fetched = await fetchManifest(new AbortController().signal, request)
  return {
    urls,
    selection: selectUpdate(fetched.rows, row.installed, row.variant),
  }
}

test('#876 C 档位固定为 stable：清单只有一个地址，prerelease 条目永远不进候选（表驱动）', async () => {
  const requested = new Set()
  for (const row of CHANNEL_ROWS) {
    const result = await runCheck(row)
    for (const url of result.urls) {
      requested.add(url)
    }
    table([row], (item) => {
      assert.equal(
        result.selection.release?.versionCode,
        item.expect.code,
        `${item.id}：候选结论不对（选中 ${result.selection.release?.version ?? '无'}）`
      )
      assert.equal(result.selection.reason, item.expect.reason, `${item.id}：无候选的原因不对`)
    })
  }
  assert.deepEqual(
    [...requested],
    [`${PRIMARY_RELEASE_BASE}/releases.json`],
    `四份清单只该请求同一个地址（档位不参与请求构造），实际请求过：${[...requested].join(', ')}`
  )
})

// ---------------------------------------------------------------------------
// A. 清单快照缓存（结构版本 / 时间戳 / 上限 / 读时重校验）
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0)
const SAVED_AT = NOW - 2 * HOUR

/** 写一份合法缓存后按需改字段，用来造「结构坏了」的各种现场 */
const rawCache = (over = {}) =>
  JSON.stringify({
    version: MANIFEST_CACHE_VERSION,
    savedAt: SAVED_AT,
    base: PRIMARY_RELEASE_BASE,
    rows: [rel('1.4.0', 19, 'internal', 'stable')],
    ...over,
  })

const CACHE_ROWS = [
  {
    id: 'K1',
    what: '没有缓存（键不存在）→ undefined：界面该退回原来的失败文案',
    raw: undefined,
    expected: 'undefined',
  },
  {
    id: 'K2',
    what: '不是 JSON → undefined（用户手改过 / 旧版本写坏）',
    raw: '{不是 JSON',
    expected: 'undefined',
  },
  {
    id: 'K3',
    what: '结构版本不符 → undefined（不做字段猜测式迁移）',
    raw: rawCache({ version: MANIFEST_CACHE_VERSION + 1 }),
    expected: 'undefined',
  },
  {
    id: 'K4',
    what: '缺 savedAt → undefined（没有「上次成功时间」就没法标注「可能不是最新」）',
    raw: rawCache({ savedAt: undefined }),
    expected: 'undefined',
  },
  {
    id: 'K5',
    what: 'savedAt 在 30 天之外 → undefined（太旧的列表比失败文案更容易误导）',
    raw: rawCache({ savedAt: NOW - MANIFEST_CACHE_MAX_AGE_MS - 1 }),
    expected: 'undefined',
  },
  {
    id: 'K6',
    what: 'savedAt 在未来（改过系统时间）→ undefined（那样的时间戳没法标「上次成功时间」）',
    raw: rawCache({ savedAt: NOW + HOUR }),
    expected: 'undefined',
  },
  {
    id: 'K7',
    what: 'base 不在分发机白名单 → undefined（拼出来的下载地址会指到别处）',
    raw: rawCache({ base: 'https://evil.example' }),
    expected: 'undefined',
  },
  {
    id: 'K8',
    what: '记录里带非法 buildType:"release"（#330 现场）→ 整份不可信，undefined',
    raw: rawCache({ rows: [{ ...rel('1.4.0', 19, 'internal', 'stable'), buildType: 'release' }] }),
    expected: 'undefined',
  },
  {
    id: 'K9',
    what: '记录里 file 路径非法（不是 apk/<name>.apk）→ 整份不可信，undefined',
    raw: rawCache({ rows: [{ ...rel('1.4.0', 19, 'internal', 'stable'), file: '../etc/passwd' }] }),
    expected: 'undefined',
  },
  {
    id: 'K10',
    what: '结构完整 → 读出来（时间 / 分发机 / 条数都要对得上）',
    raw: rawCache(),
    expected: 'ok',
  },
]

test('#412 A 缓存读取：任何一项不合格都整份丢弃，合格的能原样读回（表驱动）', () => {
  table(CACHE_ROWS, (row) => {
    const storage = memoryStorage(row.raw === undefined ? {} : { [MANIFEST_CACHE_KEY]: row.raw })
    const snapshot = readManifestSnapshot(NOW, storage)
    if (row.expected === 'undefined') {
      assert.equal(snapshot, undefined, `${row.id} ${row.what}`)
      return
    }
    assert.ok(snapshot !== undefined, `${row.id} 合格缓存却没读出来：${row.what}`)
    assert.equal(snapshot.savedAt, SAVED_AT, '上次成功时间必须原样读回（界面要展示它）')
    assert.equal(snapshot.base, PRIMARY_RELEASE_BASE, '分发机必须原样读回（file 要拼在它上面）')
    assert.equal(snapshot.rows.length, 1, '条数必须对得上')
    assert.equal(snapshot.rows[0].versionCode, 19, '记录内容必须对得上')
  })
})

test('#412 A 缓存写入：键名 / 结构版本 / 条数上限 / 字符上限，一个都不许省', () => {
  const storage = memoryStorage()
  assert.equal(saveManifestSnapshot({ rows: parseManifest({ releases: COMPLETE }), base: PRIMARY_RELEASE_BASE, savedAt: NOW }, storage), true)
  assert.ok(MANIFEST_CACHE_KEY.startsWith('chat-demo:'), '缓存键必须是 chat-demo: 前缀')

  const stored = JSON.parse(storage.getItem(MANIFEST_CACHE_KEY))
  assert.equal(stored.version, MANIFEST_CACHE_VERSION, '落库必须带结构版本（否则改结构后旧数据会被当新数据读）')
  assert.equal(stored.savedAt, NOW, '落库必须带成功时间戳')
  assert.equal(stored.base, PRIMARY_RELEASE_BASE, '落库必须带真的回了清单的分发机')
  assert.equal(stored.rows.length, 3, '三条记录都应落库')

  // 条数上限：灌 3× 上限的版本，落库后不许超过 MANIFEST_CACHE_MAX_RELEASES，且保留的是最新的那批
  const flood = Array.from({ length: MANIFEST_CACHE_MAX_RELEASES * 3 }, (_, index) =>
    rel(`1.5.${index}`, 100 + index, 'internal', 'stable')
  )
  const flooded = memoryStorage()
  assert.equal(saveManifestSnapshot({ rows: flood, base: PRIMARY_RELEASE_BASE, savedAt: NOW }, flooded), true)
  const capped = JSON.parse(flooded.getItem(MANIFEST_CACHE_KEY)).rows
  assert.equal(capped.length, MANIFEST_CACHE_MAX_RELEASES, '条数必须被压到上限（缓存不许无限增长）')
  assert.equal(capped[0].versionCode, 100 + MANIFEST_CACHE_MAX_RELEASES * 3 - 1, '截断后第一个必须是最新版本')

  // 字符上限：一条记录的 changes 就写满上限级别 → 丢到只剩这一条还超，就整体放弃（不许写半份）
  const heavy = rel('1.6.0', 300, 'internal', 'stable')
  heavy.changes = Array.from({ length: 200 }, () => '说'.repeat(2000))
  const heavyStorage = memoryStorage()
  assert.equal(
    saveManifestSnapshot({ rows: [heavy], base: PRIMARY_RELEASE_BASE, savedAt: NOW }, heavyStorage),
    false,
    '序列化超过字符上限且无法再丢记录时必须放弃写入'
  )
  assert.equal(heavyStorage.getItem(MANIFEST_CACHE_KEY), null, '放弃写入时不许留下半份缓存')
  assert.equal(readManifestSnapshot(NOW, heavyStorage), undefined, '放弃写入后读出来必须是 undefined')
})

test('#412 A 缓存不可用时静默降级：不抛错、不影响本次检查', () => {
  const broken = memoryStorage({}, { failOn: 'set' })
  assert.equal(
    saveManifestSnapshot({ rows: parseManifest({ releases: COMPLETE }), base: PRIMARY_RELEASE_BASE }, broken),
    false,
    'setItem 抛错时要返回 false（缓存是兜底，不许把检查链路带崩）'
  )
  assert.equal(readManifestSnapshot(NOW, memoryStorage()), undefined, '没存过时读到 undefined')
  assert.equal(readManifestSnapshot(NOW), undefined, '没有 localStorage 也没有入参时读到 undefined')
  assert.doesNotThrow(() => clearManifestSnapshot(memoryStorage({}, { failOn: 'remove' })), '清缓存失败不许抛')
})

// ---------------------------------------------------------------------------
// B. 手动下载兜底入口
// ---------------------------------------------------------------------------

const manualRows = [
  {
    id: 'M1',
    what: '有缓存且能选出可装版本 → 直链指向那条记录的 file，拼在**缓存里的那个 base** 上',
    snapshot: { savedAt: SAVED_AT, base: PRIMARY_RELEASE_BASE, rows: parseManifest({ releases: COMPLETE }) },
    current: { code: 19, variant: 'internal' },
    url: `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.4.1.apk`,
    fromCache: true,
  },
  {
    id: 'M2',
    what: '#876：缓存来自回退机，直链也统一拼在**主**分发机上（两台同机同 webroot，两边都有这个文件）',
    snapshot: {
      savedAt: SAVED_AT,
      base: 'https://dl.rose7.cn',
      rows: parseManifest({ releases: COMPLETE }),
    },
    current: { code: 19, variant: 'internal' },
    url: `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.4.1.apk`,
    fromCache: true,
  },
  {
    id: 'M3',
    what: '变体断链（缓存里没有本机变体的包）→ 退到下载站首页，不许把 standard 包塞给 internal',
    snapshot: { savedAt: SAVED_AT, base: PRIMARY_RELEASE_BASE, rows: parseManifest({ releases: BROKEN }) },
    current: { code: 19, variant: 'internal' },
    url: RELEASE_HOME_URL,
    fromCache: false,
  },
  {
    id: 'M4',
    what: '缓存里只有更高的预发布 → 退到下载站首页（预发布不进候选，不把它当稳定版发出去）',
    snapshot: { savedAt: SAVED_AT, base: PRIMARY_RELEASE_BASE, rows: parseManifest({ releases: BETA_ONLY }) },
    current: { code: 19, variant: 'internal' },
    url: RELEASE_HOME_URL,
    fromCache: false,
  },
  {
    id: 'M5',
    what: '完全没有缓存 → 退到下载站首页（失败态唯一还能走的路）',
    snapshot: undefined,
    current: { code: 19, variant: 'internal' },
    url: RELEASE_HOME_URL,
    fromCache: false,
  },
]

test('#412 B 手动下载兜底：能选到就给直链、选不到就退下载站首页（表驱动）', () => {
  table(manualRows, (row) => {
    const target = manualDownloadTarget(row.snapshot, row.current)
    assert.equal(target.url, row.url, `${row.id} ${row.what}`)
    assert.equal(target.fromCache, row.fromCache, `${row.id} 来源标记不对`)
  })
  // 兜底地址必须是公开 HTTPS 下载站（不是首选机的裸 HTTP，也不是某个文件的拼法）
  assert.match(RELEASE_HOME_URL, /^https:\/\/[^/]+\/$/, '下载站首页必须是一个 https 目录地址')
  assert.equal(releaseUrl('apk/deepseek-chat-1.4.0.apk'), `${PRIMARY_RELEASE_BASE}/apk/deepseek-chat-1.4.0.apk`)
})
