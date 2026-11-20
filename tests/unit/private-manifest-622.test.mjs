// [layer: unit | 纯 Node，零浏览器零网络 | 耗时: <1s]
//
// 私有清单（Issue #622）：internal 变体读私有清单，失败回退公网。
//
// 为什么这些断言在 L0：整条链路是**纯判定** —— 「要不要发这个请求」「用哪份清单」「选中哪一条」
// 全都能用注入的 fetch 替身一次跑完，不需要真端点、真令牌、真 APK。私有端点本身（鉴权 / 限流 /
// 路径穿越）由 `deploy/dl-release/test/private-releases-read.test.mjs` 钉住（#621，9 条），两层不重叠。
//
// 每行对应 #622 验收表的一格；`table()` 把行 id 与说明写进失败信息，红了一行就知道是哪一格。
//
// 一个**故意的**设计：私有清单里混入 `standard` 条目时，本文件断言它**不被选中**，同时断言
// 「清单行数没变」—— 后者证明我们**没有**在 `fetchManifest` 里再写一层变体过滤（#484 的硬规矩：
// 筛选只有 `selectUpdate` 一份）。只断言「没被选中」的话，加一层过滤也照样绿。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const {
  PRIVATE_MANIFEST_TOKEN_HEADER,
  RELEASE_BASES,
  fetchManifest,
  parseManifest,
  selectUpdate,
} = await loadTsModule('src/services/updateManifest.ts')

/** 注入表的默认值（`tests/helpers/injected.mjs` 装的那份，全部来自 config/endpoints.json） */
const BASE_ENDPOINTS = globalThis.__ENDPOINTS__
/** 私有清单端点：形状对齐 #621 的线上契约（完整路径，不是 base） */
const PRIVATE_URL = 'https://dl.rose7.cn/api/v1/releases/internal'
/** 一眼假的令牌：任何断言里出现它都说明它跑到了不该去的地方 */
const TOKEN = 'tok-622-should-stay-in-header'

/** 已装版本（都低于两份清单里的候选，保证「能不能选中」不是版本号挡的） */
const INSTALLED = 18

const row = (overrides) => ({
  version: '1.4.0',
  versionCode: 19,
  artifactVariant: 'internal',
  buildType: 'prerelease',
  size: 5_000_000,
  file: 'apk/deepseek-chat-1.4.0-internal.apk',
  changes: ['1.4.0 的说明'],
  sha256: 'b'.repeat(64),
  ...overrides,
})

/** 线上实际上就是这么分工的：公网清单里没有 internal 条目，私有清单里没有 standard 条目 */
const PUBLIC_BODY = JSON.stringify({
  latest: '1.4.1',
  releases: [row({ version: '1.4.1', versionCode: 20, artifactVariant: 'standard', buildType: 'stable', file: 'apk/deepseek-chat-1.4.1.apk', sha256: 'a'.repeat(64) })],
})
/** 私有清单的响应体 = #621 端点实际形状（`releases` 数组 + 服务端补的 apkName / downloadUrl） */
const privateBody = (releases) =>
  JSON.stringify({ ok: true, latest: releases[0]?.version ?? null, count: releases.length, skipped: 0, releases })
const PRIVATE_BODY = privateBody([
  row({ apkName: 'deepseek-chat-1.4.0-internal.apk', downloadUrl: '/api/v1/releases/internal/download?file=deepseek-chat-1.4.0-internal.apk' }),
])

/**
 * 按行装环境：注入值（enabled / url / token）+ 变体（`__INTERNAL_BUILD__`）+ fetch 替身。
 * 两个常量都是**懒读**的（见 updateManifest.ts 的 privateManifestConfig / isInternalVariant），
 * 所以同一进程里逐行替换即可，不必重开进程。
 */
const install = ({ enabled = true, token = TOKEN, variant = 'internal', url = PRIVATE_URL } = {}) => {
  globalThis.__INTERNAL_BUILD__ = variant === 'internal'
  globalThis.__ENDPOINTS__ = Object.freeze({
    ...BASE_ENDPOINTS,
    update: Object.freeze({ privateManifest: Object.freeze({ enabled, url, token }) }),
  })
}

/** fetch 替身：记住每一次调用（URL + init），按计划回答私有端点 / 公网两台 base */
const makeFetch = ({ private: privatePlan, public: publicPlan = PUBLIC_BODY } = {}) => {
  const calls = []
  const respond = (body) => ({ ok: true, status: 200, text: async () => body })
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (url === PRIVATE_URL) {
      if (privatePlan === 'network') {
        throw new TypeError('fetch failed')
      }
      if (typeof privatePlan === 'number') {
        return { ok: false, status: privatePlan, text: async () => '' }
      }
      return respond(privatePlan ?? PRIVATE_BODY)
    }
    // 公网两台 base：默认两台都好（回退到哪台都算成功）
    const known = RELEASE_BASES.some((base) => url === `${base}/releases.json`)
    assert.ok(known, `公网请求只能打到 RELEASE_BASES 里的机器，收到 ${url}`)
    if (publicPlan === 'network') {
      throw new TypeError('fetch failed')
    }
    if (typeof publicPlan === 'number') {
      return { ok: false, status: publicPlan, text: async () => '' }
    }
    return respond(publicPlan)
  }
  return {
    fn,
    calls,
    /** 打到私有端点的调用（断言「零请求」就看它） */
    private: () => calls.filter((call) => call.url === PRIVATE_URL),
    public: () => calls.filter((call) => call.url !== PRIVATE_URL),
  }
}

/**
 * 一行 = 一份注入值 × 一个装机变体 × 一套 fetch 计划 → 期望结论。
 *   `privateCalls` 期望打到私有端点的次数（0 = 一个字节都不许发）
 *   `source` 期望清单来源；`check` 里再断言选中的是哪一条
 */
const CASES = [
  {
    id: 'C1',
    what: 'enabled:false + internal 变体 → 私有端点零请求（默认关，公网用户永不请求）',
    config: { enabled: false },
    variant: 'internal',
    plan: { private: PRIVATE_BODY },
    privateCalls: 0,
    source: 'public',
    check: ({ result }) => {
      assert.equal(result.rows.length, 1, '拿到的是公网清单')
      assert.equal(selectUpdate(result.rows, INSTALLED, 'internal', 'prerelease').release, undefined,
        '公网清单里没有 internal 条目 —— 这正是 #377 的现场')
    },
  },
  {
    id: 'C2',
    what: 'enabled:true + standard 变体 → 私有端点零请求（standard 包永不带令牌/永不请求）',
    config: { enabled: true },
    variant: 'standard',
    plan: { private: PRIVATE_BODY },
    privateCalls: 0,
    source: 'public',
    check: ({ result }) => {
      const picked = selectUpdate(result.rows, INSTALLED, 'standard', 'stable')
      assert.equal(picked.release?.versionCode, 20, 'standard 变体照常从公网清单选中 1.4.1')
    },
  },
  {
    id: 'C3',
    what: 'enabled:true + internal + 私有 200 → 用私有清单，且能选中 internal 条目',
    config: { enabled: true },
    variant: 'internal',
    plan: { private: PRIVATE_BODY },
    privateCalls: 1,
    source: 'private',
    check: ({ result, fetch }) => {
      assert.equal(result.base, 'https://dl.rose7.cn', 'base 必须是回了清单那台机器（拼 file 用）')
      assert.equal(fetch.public().length, 0, '私有清单拿到了就不该再打公网')
      const picked = selectUpdate(result.rows, INSTALLED, 'internal', 'prerelease')
      assert.equal(picked.release?.versionCode, 19, 'internal 变体终于有候选了（#377 的解法）')
      assert.equal(picked.release?.artifactVariant, 'internal')
    },
  },
  {
    id: 'C4',
    what: '私有 401 → 静默回退公网（不报错），公网清单照常可用',
    config: { enabled: true },
    variant: 'internal',
    plan: { private: 401 },
    privateCalls: 1,
    source: 'public',
    check: ({ result }) => {
      const std = selectUpdate(result.rows, INSTALLED, 'standard', 'stable')
      assert.equal(std.release?.versionCode, 20, '回退后公网清单照常选出 standard')
      const internal = selectUpdate(result.rows, INSTALLED, 'internal', 'prerelease')
      assert.equal(internal.release, undefined)
      assert.equal(internal.reason, 'no-internal-variant', 'internal 侧给可解释的 reason，不是异常')
    },
  },
  {
    id: 'C5',
    what: '私有网络失败（连不上）→ 静默回退公网（不报错）',
    config: { enabled: true },
    variant: 'internal',
    plan: { private: 'network' },
    privateCalls: 1,
    source: 'public',
    check: ({ result }) => {
      assert.equal(result.rows.length, 1)
      assert.equal(selectUpdate(result.rows, INSTALLED, 'standard', 'stable').release?.versionCode, 20)
    },
  },
  {
    id: 'C6',
    what: '私有 200 但清单被写脏（INVALID_RELEASE）→ 也算失败，静默回退公网',
    config: { enabled: true },
    variant: 'internal',
    plan: { private: JSON.stringify({ releases: [row({ buildType: 'release' })] }) },
    privateCalls: 1,
    source: 'public',
    check: ({ result }) => {
      assert.equal(result.rows.length, 1, '脏清单不能冒充好清单，用的是公网那份')
    },
  },
  {
    id: 'C7',
    what: '私有清单里混入 standard 条目 → 不被选中（变体不符），且没有第二层过滤',
    config: { enabled: true },
    variant: 'internal',
    plan: {
      private: privateBody([
        // 版本号更高：「如果只看版本号，这条会赢」—— 断言它没赢
        row({ version: '1.4.2', versionCode: 24, artifactVariant: 'standard', buildType: 'stable', file: 'apk/deepseek-chat-1.4.2.apk', sha256: 'c'.repeat(64) }),
        row({ versionCode: 19 }),
      ]),
    },
    privateCalls: 1,
    source: 'private',
    check: ({ result }) => {
      assert.equal(result.rows.length, 2, 'fetchManifest 不做变体过滤（筛选只有 selectUpdate 一份）')
      const picked = selectUpdate(result.rows, INSTALLED, 'internal', 'prerelease')
      assert.equal(picked.release?.versionCode, 19, 'standard 条目再新也不能装到 internal 包上')
      assert.equal(picked.release?.artifactVariant, 'internal')
    },
  },
  {
    id: 'C8',
    what: '注入值里没有 update 段（裁剪构建 / 旧产物）→ 当作关闭，零请求、不抛错',
    config: null,
    variant: 'internal',
    plan: { private: PRIVATE_BODY },
    privateCalls: 0,
    source: 'public',
    check: ({ result }) => {
      assert.equal(result.rows.length, 1)
    },
  },
  {
    id: 'C9',
    what: 'enabled:true 但注入的 url / token 是空串 → 当作关闭（不打必然失败的请求）',
    config: { enabled: true, url: '', token: '' },
    variant: 'internal',
    plan: { private: PRIVATE_BODY },
    privateCalls: 0,
    source: 'public',
    check: ({ result }) => {
      assert.equal(result.rows.length, 1)
    },
  },
]

// 一行一个 test：`ok/not ok` 直接对上验收表的行，红了不用再翻是第几行
for (const head of CASES) {
  test(`[${head.id}] ${head.what}`, async () => {
    const fetch = makeFetch(head.plan)
    const variant = head.variant
    if (head.config === null) {
      // 裁剪构建：整段 update 都不存在
      globalThis.__INTERNAL_BUILD__ = variant === 'internal'
      globalThis.__ENDPOINTS__ = BASE_ENDPOINTS
    } else {
      install({ ...head.config, variant })
    }
    let result
    try {
      result = await fetchManifest(new AbortController().signal, fetch.fn)
    } catch (error) {
      error.message = `[#622 ${head.id}] ${head.what}\n  ↳ 不该抛错，却抛了：${error.message}`
      throw error
    }
    assert.equal(fetch.private().length, head.privateCalls, '私有端点调用次数不对')
    assert.equal(result.source, head.source, '清单来源不对')
    head.check({ result, fetch })
  })
}

// ---------------------------------------------------------------------------
// 令牌：只进请求头，不进 URL / 不进日志 / 不进埋点
// ---------------------------------------------------------------------------

test('令牌只在 X-DL-Token 请求头里：URL 不带、参数不带、返回的清单里也不带', async () => {
  install()
  const fetch = makeFetch({ private: PRIVATE_BODY })
  const result = await fetchManifest(new AbortController().signal, fetch.fn)
  const [call] = fetch.private()
  assert.equal(call.url, PRIVATE_URL, '私有端点 URL 里不许出现令牌')
  assert.equal(call.url.includes(TOKEN), false)
  assert.equal(call.init.headers[PRIVATE_MANIFEST_TOKEN_HEADER], TOKEN, '令牌只在请求头')
  assert.deepEqual(Object.keys(call.init.headers), [PRIVATE_MANIFEST_TOKEN_HEADER], '只带这一枚头')
  assert.equal(JSON.stringify(result).includes(TOKEN), false, '清单结果里不许带令牌')
  // 隐私边界：凭据不随请求发出（cookie/tls 证书都不需要）
  assert.equal(call.init.credentials, 'omit')
  assert.equal(call.init.redirect, 'error')
})

test('私有清单失败时抛出的错误既不进日志也不含令牌（回退后错误来自公网那台）', async () => {
  install()
  const fetch = makeFetch({ private: 401, public: 502 })
  // 私有 401 被静默吞掉；公网两台都 502 → 抛公网的短码
  await assert.rejects(fetchManifest(new AbortController().signal, fetch.fn), (error) => {
    assert.match(error.message, /MANIFEST_HTTP_502/)
    assert.equal(error.message.includes(TOKEN), false, '错误信息里不许有令牌')
    assert.equal(error.message.includes(PRIVATE_URL), false, '错误信息里不许有私有端点地址')
    return true
  })
})

/**
 * 静态扫描：`src/` 里除了 `src/services/updateManifest.ts`，没有任何文件提到私有清单 / 令牌头。
 * 这条守的是「以后某个 PR 顺手把令牌打进诊断或日志」—— L0 只能断言这里没有，能不能扩散出去看它。
 */
test('静态扫描：私有清单与令牌头只出现在 updateManifest.ts（且该文件不碰任何日志通道）', () => {
  const SOURCE_DIR = path.join(ROOT, 'src')
  const SKIP = /\.d\.ts$/
  const walk = (dir) => {
    const out = []
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        out.push(...walk(full))
      } else if (/\.(ts|tsx)$/.test(name) && !SKIP.test(name)) {
        out.push(full)
      }
    }
    return out
  }
  const hits = []
  for (const file of walk(SOURCE_DIR)) {
    const text = readFileSync(file, 'utf8')
    if (/privateManifest|X-DL-Token|PRIVATE_MANIFEST_TOKEN_HEADER/.test(text)) {
      hits.push(path.relative(ROOT, file).split(path.sep).join('/'))
    }
  }
  assert.deepEqual(hits, ['src/services/updateManifest.ts'],
    '私有清单/令牌只允许在本文件出现（写日志或埋点的人会先撞上这条）')

  const text = readFileSync(path.join(SOURCE_DIR, 'services', 'updateManifest.ts'), 'utf8')
  for (const forbidden of ['console.', 'recordEvent', 'recordError', 'diagnostics/']) {
    assert.equal(text.includes(forbidden), false,
      `updateManifest.ts 不许出现 ${forbidden}（令牌与私有端点不许进日志/埋点）`)
  }
})

// ---------------------------------------------------------------------------
// 构建期注入：配置形状与 fail-fast（rspack.config.ts 的 privateManifestInjection）
// ---------------------------------------------------------------------------

test('配置落位：config/endpoints.json 有 update.privateManifest，且默认关闭 + url 为空', () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, 'config', 'endpoints.json'), 'utf8'))
  const segment = config.update?.privateManifest
  assert.ok(segment, 'config/endpoints.json 必须有 update.privateManifest')
  assert.equal(segment.enabled, false, '默认关：公网 / standard 用户永不请求')
  assert.equal(segment.url, '', '默认不给端点（enabled:false 时它没有意义）')
  assert.equal(segment.tokenEnv, 'DL_PRIVATE_TOKEN', '令牌来源：这个环境变量，构建期注入')
  assert.equal(Object.hasOwn(segment, 'token'), false, 'JSON 里**不许**出现令牌本身（只放变量名）')
})

test('构建期 fail-fast：enabled=true + url 空 / 非法 / internal 构建缺令牌 → 构建中止', async () => {
  const { privateManifestInjection } = await loadTsModule('rspack.config.ts')
  const endpoint = 'https://dl.rose7.cn/api/v1/releases/internal'
  // 逐条负向：每一种都必须在**建配置时**就抛（不是等到运行期静默回退公网 ——
  // 那会让「配错了」表现为「内测用户永远看到公网清单」，是最贵的假绿）
  const badCases = [
    { segment: { enabled: true, url: '' }, hint: /update\.privateManifest\.url 为空/ },
    { segment: { enabled: true }, hint: /update\.privateManifest\.url 为空/ },
    { segment: { enabled: true, url: 'dl.rose7.cn/api/v1/releases/internal' }, hint: /不是合法的绝对 URL/ },
    { segment: { enabled: true, url: 'http://dl.rose7.cn/api/v1/releases/internal' }, hint: /必须是 https/ },
    { segment: { enabled: true, url: 'https://dl.rose7.cn/' }, hint: /必须是完整端点/ },
    { segment: { enabled: true, url: `${endpoint}?token=leak` }, hint: /不许带凭据/ },
    { segment: { enabled: true, url: endpoint, tokenEnv: 'bad name' }, hint: /tokenEnv 必须是环境变量名/ },
  ]
  for (const { segment, hint } of badCases) {
    assert.throws(() => privateManifestInjection(segment, true), hint,
      `这一行必须抛：${JSON.stringify(segment)}`)
  }
  // 开关关着（默认）时一条都不校验：空 url / 空 tokenEnv 不该拦住正常出包
  assert.deepEqual(privateManifestInjection({ enabled: false, url: '', tokenEnv: '' }, false),
    { enabled: false, url: '', token: '' })
  assert.deepEqual(privateManifestInjection(undefined, false), { enabled: false, url: '', token: '' })
  // internal 构建开了开关却没有令牌 → 也必须在构建期中止（否则内测包永远静默走公网）
  delete process.env.DL_PRIVATE_TOKEN
  assert.throws(
    () => privateManifestInjection({ enabled: true, url: endpoint, tokenEnv: 'DL_PRIVATE_TOKEN' }, true),
    /构建环境没有 DL_PRIVATE_TOKEN/
  )
  try {
    process.env.DL_PRIVATE_TOKEN = TOKEN
    // 有令牌 → internal 注入三段（含令牌原文，它只作为 X-DL-Token 使用）
    assert.deepEqual(privateManifestInjection({ enabled: true, url: endpoint, tokenEnv: 'DL_PRIVATE_TOKEN' }, true),
      { enabled: true, url: endpoint, token: TOKEN })
    // 同样的配置，**standard 构建**整段按关闭注入：产物里连端点与令牌都不出现
    assert.deepEqual(privateManifestInjection({ enabled: true, url: endpoint, tokenEnv: 'DL_PRIVATE_TOKEN' }, false),
      { enabled: false, url: '', token: '' })
  } finally {
    delete process.env.DL_PRIVATE_TOKEN
  }
})

test('私有清单复用公网那套解析与筛选（不写第二份）：parseManifest 与 selectUpdate 是同一个', async () => {
  // 行形状与公网条目完全相同 —— 私有清单只是多两个服务端补的字段（apkName / downloadUrl），
  // parseManifest 按 unknown 字段忽略它们，不产生第二条解析路径。
  const rows = parseManifest(JSON.parse(PRIVATE_BODY))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].artifactVariant, 'internal')
  assert.equal(rows[0].sha256?.length, 64)
  assert.equal(Object.hasOwn(rows[0], 'downloadUrl'), false, '服务端附加字段不进 UpdateRelease')
  assert.equal(selectUpdate(rows, INSTALLED, 'internal', 'prerelease').release?.versionCode, 19)
  assert.equal(selectUpdate(rows, INSTALLED, 'standard', 'stable').release, undefined)
})
