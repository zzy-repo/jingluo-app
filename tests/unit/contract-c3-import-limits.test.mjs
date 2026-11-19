// [layer: unit | 纯 Node，只 import 常量与读源码文本 | 耗时: <1s]
//
// C3 —— 导入上限的**常量链**自洽（Issue #407 / 防 #152）
//
// 历史事故 #152：导入包的「大小上限」与「总时间预算」是两处独立阈值，谁被单独调一下、
// 另一个没跟着动，不等式立刻不成立 —— 线上表现是**合法的大包被预算判死**
// （#38 / #152 同族：200MB 的包在 30 分钟预算下只够 114KB/s，低于这个速率就永远下不完）。
// 后来 #153 又加了「解压总量闸」：它必须比**压缩体**上限宽松（否则合法包在解压阶段被误杀），
// 又必须是个有限值（否则几个 GB 的炸弹照样过）。
//
// 本契约锁三条链：
//   L1 单一来源：`DEFAULT_MAX_IMPORT_BYTES` 是唯一数字，`LIMITS.importMaxBytes` 与
//      `urlImport.MAX_ARCHIVE_BYTES` 都只是转出（改一处必须全链路跟着动）；
//   L2 上限 ↔ 总预算自洽：`importMaxBytes ÷ importMaxTotalMs` 必须落在「移动网络做得到」的
//      带宽区间里 —— 太小 = 合法包被判死，太大 = 预算形同没有；
//   L3 压缩体 ↔ 解压体自洽：`MAX_INFLATE_TOTAL_BYTES` 必须 ≥ 压缩体上限且 ≤ 它的 8 倍。
//
// 判据只写**不等式与区间**，不钉实现：把 200MB 改成 256MB 且总预算同步调整，本契约仍然是绿的；
// 只改一个数（#152 的现场）立刻红。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, readText, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../src/services/chat/history/importLimit.ts')
const { LIMITS } = await import('../../src/services/limits.ts')

// `urlImport.ts` 依赖链含 TS 非可擦语法（enum / 参数属性），裸 `node --test` 下 import 会抛
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX —— 契约层不该因此要求「必须带 transform-types 跑」，
// 所以这一处改成**读源码断言转出关系**：它要的本来也只是「有没有另写一份数字」。
const URL_IMPORT = 'src/services/chat/history/urlImport.ts'
const urlImportText = readText(URL_IMPORT)
const MAX_ARCHIVE_BYTES_IS_ALIAS = /export const MAX_ARCHIVE_BYTES = DEFAULT_MAX_IMPORT_BYTES\b/.test(urlImportText)

const MB = 1024 * 1024
/** 移动网络必须稳定的最低速率（与 limits.ts 注释里的门槛同一个数，#152 的判据） */
const MIN_ACCEPTABLE_BYTES_PER_SEC = 100_000
/** 反向门槛：预算大到这个速率以下都能下完，等于没有上限（现值的 10 倍余量） */
const MAX_SENSIBLE_BYTES_PER_SEC = 1_000_000

/**
 * 解压总量闸在 `zipReader.ts` 里是模块私有常量（不导出 —— 导出就等于允许别人改这一处），
 * 所以这里从源码文本里取值：`const MAX_INFLATE_TOTAL_BYTES = 800 * 1024 * 1024`。
 * 读不到就当成契约被改名/被搬走 → 直接红，绝不静默跳过。
 */
const readNumberConst = (relative, name) => {
  const matched = readText(relative).match(new RegExp(`const ${name} = ([0-9_\\s*]+)\\n`))
  assert.ok(matched, `${relative} 里找不到 \`const ${name} = <算式>\`（被改名/被搬走了？契约要跟着改）`)
  const value = Number(new Function(`return (${matched[1].replace(/_/g, '')})`)())
  assert.ok(Number.isFinite(value) && value > 0, `${name} 解析结果不是正数：${matched[1]}`)
  return value
}

const ZIP_READER = 'src/services/chat/history/zipReader.ts'
const MAX_INFLATE_TOTAL_BYTES = readNumberConst(ZIP_READER, 'MAX_INFLATE_TOTAL_BYTES')
const MAX_INFLATE_RATIO = readNumberConst(ZIP_READER, 'MAX_INFLATE_RATIO')
const requiredBytesPerSec = LIMITS.importMaxBytes / (LIMITS.importMaxTotalMs / 1000)

/** 一行 = 一条「必须成立的关系」。改成合法的新数值时这些行仍然是绿的（锁语义不锁数字） */
const ROWS = [
  {
    id: 'L1a',
    what: '导入上限只有一个来源：LIMITS 与 urlImport 都必须是 DEFAULT_MAX_IMPORT_BYTES（不许各写一份数字）',
    check: () => {
      assert.equal(LIMITS.importMaxBytes, DEFAULT_MAX_IMPORT_BYTES)
      assert.ok(
        MAX_ARCHIVE_BYTES_IS_ALIAS,
        `${URL_IMPORT} 里 MAX_ARCHIVE_BYTES 不再转发 DEFAULT_MAX_IMPORT_BYTES（另写了一份数字 = #34 的纪律被打破）`
      )
    },
  },
  {
    id: 'L1b',
    what: '上限的量级仍在「200MB 这一档」（±0 次幂级漂移 = 有人在测试里顺手改了默认值）',
    check: () => {
      assert.ok(
        DEFAULT_MAX_IMPORT_BYTES >= 64 * MB && DEFAULT_MAX_IMPORT_BYTES <= 512 * MB,
        `上限跑出了 64–512MB 这一档：${DEFAULT_MAX_IMPORT_BYTES} 字节`
      )
    },
  },
  {
    id: 'L2a',
    what: '上限 ÷ 总预算 ≥ 最低可接受带宽（#152：太小 = 合法大包被预算判死）',
    check: () => {
      assert.ok(
        requiredBytesPerSec >= MIN_ACCEPTABLE_BYTES_PER_SEC,
        `只够 ${Math.round(requiredBytesPerSec)}B/s（< ${MIN_ACCEPTABLE_BYTES_PER_SEC}）：` +
          `上限 ${DEFAULT_MAX_IMPORT_BYTES} 字节 / 预算 ${LIMITS.importMaxTotalMs}ms 不自洽 —— ` +
          '要么放长 importMaxTotalMs，要么调小上限（改一个必须同步另一个）'
      )
    },
  },
  {
    id: 'L2b',
    what: '上限 ÷ 总预算 ≤ 反向门槛（#152 的另一面：预算大到任何速率都能下完 = 没有预算）',
    check: () => {
      assert.ok(
        requiredBytesPerSec <= MAX_SENSIBLE_BYTES_PER_SEC,
        `${Math.round(requiredBytesPerSec)}B/s 太低，${LIMITS.importMaxTotalMs}ms 的预算形同虚设`
      )
    },
  },
  {
    id: 'L2c',
    what: '停滞窗口 / 单块读超时都必须短于总预算（否则一次卡顿就能吃光整个预算，用户只看到「超时」）',
    check: () => {
      assert.ok(LIMITS.importStallMs < LIMITS.importMaxTotalMs)
      assert.ok(LIMITS.importChunkReadMs < LIMITS.importStallMs, '单块读超时不能长于停滞窗口（判定顺序会打架）')
      assert.ok(LIMITS.importConnectMs < LIMITS.importMaxTotalMs)
    },
  },
  {
    id: 'L3a',
    what: '解压总量闸 ≥ 压缩体上限（否则合法包在解压阶段被误杀 —— 上限白设）',
    check: () => {
      assert.ok(
        MAX_INFLATE_TOTAL_BYTES >= DEFAULT_MAX_IMPORT_BYTES,
        `解压闸 ${MAX_INFLATE_TOTAL_BYTES} 小于压缩体上限 ${DEFAULT_MAX_IMPORT_BYTES}`
      )
    },
  },
  {
    id: 'L3b',
    what: '解压总量闸 ≤ 压缩体上限的 8 倍（否则炸弹照样过：现值为 4 倍）',
    check: () => {
      assert.ok(
        MAX_INFLATE_TOTAL_BYTES <= 8 * DEFAULT_MAX_IMPORT_BYTES,
        `解压闸 ${MAX_INFLATE_TOTAL_BYTES} 超过压缩体上限的 8 倍，等于没有这道闸`
      )
    },
  },
  {
    id: 'L3c',
    what: '压缩比闸仍在「只拦炸弹、不误伤正常备份」的区间（20 ~ 1000，实测正常文本 3:1~10:1、炸弹 1004:1）',
    check: () => {
      assert.ok(MAX_INFLATE_RATIO >= 20 && MAX_INFLATE_RATIO <= 1000, `MAX_INFLATE_RATIO=${MAX_INFLATE_RATIO}`)
    },
  },
]

test('C3 导入上限常量链自洽（防 #152 #153）', tableTest('C3', ROWS, (row) => row.check()))

// 只留诊断、不钉具体数字：整套关系在「同步调整」的前提下仍然自称一体（锁语义不锁实现）。
// 反例：「只改一个」——只把 importMaxTotalMs 放长 10 倍 → L2b 红；只把解压闸降到 100MB → L3a 红。
test('C3 现值留档（诊断用，不参与判定）', (t) => {
  t.diagnostic(
    `现值：上限 ${DEFAULT_MAX_IMPORT_BYTES / MB}MB ÷ 预算 ${LIMITS.importMaxTotalMs / 1000}s ` +
      `= 需稳定 ${Math.round(requiredBytesPerSec / 1024)}KB/s；解压闸 ${MAX_INFLATE_TOTAL_BYTES / MB}MB；` +
      `压缩比闸 ${MAX_INFLATE_RATIO}:1`
  )
})
