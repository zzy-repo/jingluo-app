// 存储契约套件的注册器与「故障点扫描」工具。
//
// 用例标题约定：`[仓储][主题] 断言内容 ← 来源`。来源是特征化测试（`char-session` / `char-staging` /
// `char-blob` / `char-rollback`）里对应的那条，或 `types.ts` 里该方法的注释（`types:方法名`）。
//
// ## 钩子（全部由各后端 runner 提供，套件本体不碰任何具体后端）
//
// - `create(): Promise<StorageBackend>`  必填。返回**全新、空**的后端。
// - `teardown(backend): Promise<void>`   可选。每条用例结束后调用（关连接、删库）。
// - `reopen(backend): Promise<StorageBackend>`  可选。关掉传入的后端，在**同一份底层存储**上重新打开。
// - `inject`  可选。故障注入，见 `injectDoc`。没有它，所有 `needs: ['inject']` 的用例 skip。
// - `openErrors`  可选。`{ unavailable, blocked, versionTooNew }`，每项是 `() => Promise<unknown>`：
//   runner 自己造好那个条件、跑一次真正的 open、**把 reject 的原因返回**（不得抛）。缺项则对应用例 skip。
// - `errorClasses`  可选。`{ StorageUnavailableError, StorageBlockedError, StorageVersionTooNewError }`。
// - `capabilities`  可选。`{ rejectsNonCloneable?: boolean }`：后端自报的能力。`rejectsNonCloneable` = 把函数等
//   不可克隆值写进会话时，后端自己会失败（IDB 的结构化克隆如此，JSON 序列化的 SQLite 不会），
//   这时 `save` 才有「剔字段重试」可言；缺省视为 false，相关用例 skip。
// - `knownDeviations`  可选。`[{ match, reason }]`：title 含 `match` 的契约用例是「已知偏离」：后端与 types.ts 注释
//   不一致、尚未修复。它们以 node:test 的 todo 运行（失败不拖红），汇总里单列为 KNOWN-RED；一旦转绿就报
//   FIXED?，提醒删掉这条登记。只减不增，每条必须带 reason。**不得用它去掩盖契约本身写错的用例。**
// - `seedLegacy`  可选。`() => Promise<{ open, expected }>`：runner 用旧版 schema 建库并写入数据，
//   `open()` 打开它（触发升级），`expected` 是逐条比对用的期望值，形状见 `upgrade.mjs`。
//
// 注：skip 不算绿。每个被 skip 的用例都登记进 `report.skipped`，并在 `after` 里打印汇总。
import { after, describe, test } from 'node:test'

export const injectDoc = `
inject.failNextWrite(kind, { at = 'any', nth = 1, times = 1, id }) → { restore(), hits(), errorName }

  kind   'quota' | 'clone' | 'unavailable' | 'unknown'   注入的底层错误，须被后端映射进同名分类
  at     'any' | 'session' | 'summary' | 'blob' | 'asset' | 'attachment' | 'memory' | 'staging'
         要打的「写点」：会话详情 / 摘要 / 原件 / 应用素材 / 附件元数据与全文 / 记忆 / 两个暂存区。
         逻辑名由 runner 映射到自己的物理存储（IDB 的 store 名、SQLite 的表名都只出现在 runner 里）。
         「写」包括新增 / 覆盖 / 删除 / 清空，不包括读。
  nth    第几次命中的写操作开始失败（从 1 数；只数 at 匹配的写）
  times  连续失败几次；Infinity = 此后一律失败
  id     只匹配写的是这个主键 / 键的操作（让批量里「只有一个」失败）；不传 = 不按键过滤
  hits() 到目前为止 at 匹配的写操作次数（含失败的那几次）。hits() < nth 说明注入点没被走到，用例据此判空转
  errorName  这次注入的底层错误的 name（后端自己的映射输入，如 'QuotaExceededError'）
  restore() 撤销注入，必须幂等
`

export const MAX_FAULT_POINTS = 120

export const runSuite = ({ name, create, teardown, reopen, inject, openErrors, errorClasses, capabilities, seedLegacy, knownDeviations = [], registrars }) => {
  const report = { name, passed: [], failed: [], skipped: [], knownRed: [], fixed: [] }
  describe(`storage contract: ${name}`, () => {
    const hooks = { create, teardown, reopen, inject, openErrors, errorClasses, capabilities, seedLegacy }
    const suite = {
      report,
      /** `needs` ∈ inject | reopen | seedLegacy | errorClasses | openErrors.<k> | cap.<name> */
      case(title, body, { needs = [] } = {}) {
        const missing = needs.filter((need) => {
          if (need === 'inject') return typeof inject?.failNextWrite !== 'function'
          if (need.startsWith('openErrors.')) return typeof openErrors?.[need.slice(11)] !== 'function'
          if (need.startsWith('cap.')) return capabilities?.[need.slice(4)] !== true
          return hooks[need] === undefined
        })
        if (missing.length > 0) {
          const reason = `runner 未提供 ${missing.join(' / ')}`
          report.skipped.push({ title, reason })
          test(title, { skip: reason }, () => {})
          return
        }
        const deviation = knownDeviations.find((item) => title.includes(item.match))
        test(title, deviation === undefined ? {} : { todo: deviation.reason }, async (t) => {
          const backend = await create()
          let current = backend
          t.after(async () => {
            await teardown?.(current)
          })
          const ctx = {
            backend,
            t,
            ...hooks,
            /** 用例里 reopen 之后，把新实例登记回来，teardown 才会关对。 */
            adopt: (next) => {
              current = next
              return next
            },
          }
          try {
            await body(ctx)
          } catch (error) {
            const first = String(error?.message ?? error).split('\n')[0]
            if (deviation === undefined) report.failed.push({ title, error: first })
            else report.knownRed.push({ title, reason: deviation.reason, error: first })
            throw error
          }
          if (deviation === undefined) report.passed.push(title)
          else report.fixed.push(title)
        })
      },
    }
    for (const register of registrars) register(suite)
    after(() => printReport(report))
  })
  return report
}

export const printReport = (report) => {
  const lines = [
    `── storage contract「${report.name}」：通过 ${report.passed.length} / 失败 ${report.failed.length} / 已知偏离 ${report.knownRed.length} / 跳过 ${report.skipped.length}（跳过与已知偏离都不算绿）`,
  ]
  for (const { title, reason } of report.skipped) lines.push(`  SKIP  ${title}\n        ${reason}`)
  for (const { title, reason, error } of report.knownRed) lines.push(`  KNOWN-RED  ${title}\n        登记原因：${reason}\n        实际失败：${error}`)
  for (const title of report.fixed) lines.push(`  FIXED?  ${title}\n        已知偏离登记的用例现在通过了：请删掉 knownDeviations 里对应条目`)
  console.log(lines.join('\n'))
}
