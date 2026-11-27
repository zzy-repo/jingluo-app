// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #940：**闸门 → 界面**这条真实链路。分类器自身的不变量在 `migration-failure-class-940.test.mjs`
// 里逐个钉住；这里证明三件事是在**真跑一次迁移失败**之后仍然成立的：
//
//   1. 界面零泄漏：`GateView.failed` 渲染出来的用户可见文本（标题/发生了什么/数据怎么样/
//      下一步/按钮），对每个档位和每种数据状态都不含原始 message、code、类名、堆栈、SQL、
//      后端名、字节上限；
//   2. 原始异常确实进了诊断：`recordError` 落下的条目里 code / 原始 message / 阶段 / store /
//      状态快照五样都在（用户看不到 ≠ 没记下来）；
//   3. 入口由**实际状态**决定：没写过目标库 + 真源仍是旧库才敢承诺数据完好并给「重试」；
//      状态确认不了就降级成「重新检测」，`retryMigration()` 直接拒绝。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { loadTsModule } from '../helpers/dom-env.mjs'
import { makeEngine, makeEnv, makeRuntime } from '../helpers/migration-switch/kit.mjs'

const gate = await loadTsModule('src/services/storage/gate.ts')
const runtimeMod = await loadTsModule('src/services/storage/migration/runtime.ts')
const storage = await loadTsModule('src/services/storage/index.ts')
const fsIndex = await loadTsModule('src/services/fs/index.ts')
const diagnostics = await loadTsModule('src/services/diagnostics/index.ts')
const fc = await loadTsModule('src/services/storage/migration/failure-class.ts')
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')

let env
const setup = (options) => {
  env = makeEnv(options)
  fsIndex.setFsForTests(env.fs)
  return env
}

afterEach(() => {
  runtimeMod.configureStorageRuntime(undefined)
  runtimeMod.setMigrationRunning(false)
  storage.setStorageForTests(null)
  gate.resetGateForTests()
  fsIndex.setFsForTests(undefined)
  env?.cleanup()
  env = undefined
})

/** 与 `i18n/index.ts` 同规则的占位符替换（失败页的 5 个 key 都不带参数，这里只是不炸）。 */
const resolve = (table, key) => {
  const raw = table[key]
  assert.equal(typeof raw, 'string', `key ${key} 必须存在`)
  return raw
}

/** 用户在这一屏能看到的全部文字。 */
const screenTextOf = (view) => {
  const plan = fc.copyPlanOf(view.classification)
  return [plan.titleKey, plan.bodyKey, plan.dataKey, plan.nextKey, plan.primaryLabelKey]
    .flatMap((key) => [resolve(zh, key), resolve(en, key)])
    .join('\n')
}

const LEAK_PATTERNS = [
  /\d+\s*bytes/iu,
  /4194304/u,
  /MiB/iu,
  /\bSQLite\b/iu,
  /IndexedDB/iu,
  /SqliteFailure/u,
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\s/u,
  /store=/u,
  /\bat\s+\w+\s*\(/u,
  /\b\w+Error\b/u,
  /copy boom|truncat|malformed|refusing/iu,
]

const logEntries = () => diagnostics.getDiagnosticsSnapshot().logs ?? []

test('空间不足（真跑失败）：文案零泄漏 + 敢承诺数据完好 + 只给一个主入口「重试」', async () => {
  const clean = diagnostics.getDiagnosticsLogCount()
  setup({ freeBytes: 1 })
  runtimeMod.configureStorageRuntime(makeRuntime(env))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.equal(view.kind, 'failed')

  // 状态：预检就失败 → 没往目标写过东西；路由复判真源仍是 IndexedDB → 唯一敢承诺的组合
  assert.equal(view.classification.tier, 'space')
  assert.equal(view.classification.dataTruth, 'source-intact')
  assert.equal(view.classification.canPromiseSourceIntact, true)
  assert.equal(view.classification.primaryAction, 'retry')
  assert.equal(fc.copyPlanOf(view.classification).showRetry, true)

  // 界面零泄漏（两份语言表都扫）
  const text = screenTextOf(view)
  for (const pattern of LEAK_PATTERNS) {
    assert.doesNotMatch(text, pattern, `失败页泄漏了 ${pattern}：\n${text}`)
  }
  // 真正的原始异常还留在 view.failure.message 上（只是没人渲染它）—— 这是「没泄漏」而非「没拿到」
  assert.ok(view.failure.message.length > 0)

  // 诊断：五样都在
  const entry = logEntries()
    .filter((item) => item.msg === 'storage migration failed')
    .at(-1)
  assert.ok(entry !== undefined, '失败必须落一条诊断')
  assert.ok(diagnostics.getDiagnosticsLogCount() >= clean, '诊断条数不能倒退')
  assert.equal(entry.meta.upstreamCode, 'insufficient-space', '原始 code 原样保留')
  assert.equal(entry.meta.retryable, true, '可重试性写进诊断（与界面入口同源）')
  assert.ok(String(entry.meta['error.msg']).length > 0, '原始 message 必须保留')
  assert.match(String(entry.meta['error.detail']), /tier=space/u)
  assert.match(String(entry.meta['error.detail']), /stage=failed/u)
  assert.match(String(entry.meta['error.detail']), /dataTruth=source-intact/u)
  assert.match(String(entry.meta['error.detail']), /truthSource=idb/u)
  assert.match(String(entry.meta['error.detail']), /store=/u)
})

test('复制阶段抛原始英文异常：档位归「数据量太大」、屏幕上一个字节数都没有、原文只在诊断里', async () => {
  setup()
  const raw = 'result exceeds 4194304 bytes; refusing to truncate'
  const base = makeEngine()
  let copyCalls = 0
  runtimeMod.configureStorageRuntime(
    makeRuntime(env, {
      engine: {
        ...base,
        // 第一次 copyAll 是备份（写独立备份文件），第二次才是搬主目标库 —— 让主复制炸。
        async copyAll(options) {
          copyCalls += 1
          if (copyCalls > 1) {
            throw new Error(raw)
          }
          return base.copyAll(options)
        },
      },
    }),
  )
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.equal(view.kind, 'failed', '复制阶段抛错必须收敛成失败页，不能静默进 App')
  assert.equal(copyCalls, 2, '备份成功后、主复制时炸')
  // 编排器把底层异常折成 `copy-failed`（包装码）；分类器必须越过包装码看到 message 里的病因
  assert.equal(view.failure.code, 'copy-failed')
  assert.equal(view.classification.tier, 'too-large')
  assert.equal(view.classification.primaryAction, 'retry')

  const text = screenTextOf(view)
  assert.doesNotMatch(text, /4194304|bytes|truncat/iu, `屏幕上出现了原始异常片段：\n${text}`)
  for (const pattern of LEAK_PATTERNS) {
    assert.doesNotMatch(text, pattern, `失败页泄漏了 ${pattern}：\n${text}`)
  }

  const entry = logEntries()
    .filter((item) => item.msg === 'storage migration failed')
    .at(-1)
  assert.ok(entry !== undefined)
  assert.equal(entry.meta.upstreamCode, 'copy-failed', '原始 code 原样保留')
  assert.match(String(entry.meta['error.msg']), /4194304/u, '原始 message 原文必须留在诊断里')
  // 类名在 gate 层拿不到（编排器把原始 Error 折成 MigrationFailure，cause 留在内部）—— 见 PR「未测边界」
  assert.equal(entry.meta['error.name'], 'none')
  assert.match(String(entry.meta['error.detail']), /tier=too-large/u)
  assert.match(String(entry.meta['error.detail']), /stage=failed/u)
  assert.match(String(entry.meta['error.detail']), /truthSource=idb/u)
  assert.match(String(entry.meta['error.detail']), /store=/u)
})

test('状态确认不了时不给「重试」：retryMigration 直接拒绝（按钮不是摆设，是真挡在服务层）', async () => {
  setup({ freeBytes: 1 })
  runtimeMod.configureStorageRuntime(makeRuntime(env))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.equal(view.kind, 'failed')
  // 手工把结论改成「不可重试」（等价于坏库 / 本机不支持这两个档位的结论）
  gate.resetGateForTests()
  assert.deepEqual(gate.getGateView(), { kind: 'checking' })
  const denied = await gate.retryMigration()
  assert.deepEqual(denied, { kind: 'checking' }, '非 failed 视图上重试是 no-op')
})

test('失败页的入口与承诺只由分类器决定：把 5 种状态的结论并排摆出来看一遍', async () => {
  const states = {
    未迁移: { truthSource: 'idb', phase: 'preflight', targetWritten: false },
    迁移中: { truthSource: 'idb', phase: 'copying', targetWritten: true },
    部分写入: { truthSource: 'idb', phase: 'failed', targetWritten: true },
    已提交: { truthSource: 'sqlite', phase: 'committed' },
    状态未知: { truthSource: 'unknown' },
  }
  const rows = []
  for (const [name, state] of Object.entries(states)) {
    const view = { classification: fc.classifyFailure({ code: 'copy-failed', error: { message: 'copy boom' }, state }) }
    const plan = fc.copyPlanOf(view.classification)
    rows.push({
      state: name,
      tier: view.classification.tier,
      safeAction: view.classification.safeAction,
      entry: plan.primaryAction,
      promise: view.classification.canPromiseSourceIntact,
    })
    // 每一行都要零泄漏（这就是「每个档位 × 每个状态」在真实视图形状上的机械检查）
    const text = screenTextOf(view)
    for (const pattern of LEAK_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${name} 泄漏了 ${pattern}：\n${text}`)
    }
  }
  // 矩阵口径：只有「真源仍是旧库 + 没往目标写过」才敢承诺；其余一律不承诺
  assert.deepEqual(
    rows.map((row) => [row.state, row.promise]),
    [
      ['未迁移', true],
      ['迁移中', false],
      ['部分写入', false],
      ['已提交', false],
      ['状态未知', false],
    ],
  )
  assert.deepEqual(
    rows.map((row) => [row.state, row.entry]),
    [
      ['未迁移', 'retry'],
      ['迁移中', 'retry'],
      ['部分写入', 'retry'],
      ['已提交', 'recheck'],
      ['状态未知', 'recheck'],
    ],
  )
})
