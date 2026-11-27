/**
 * 「主库文件在不在」的**唯一**事实来源，以及破坏性动作的**唯一**前置判定（#986 阶段一）。
 *
 * 为什么必须收在一处：迁移 / 清库（`clearAll` 主库）/ 切换（写 `meta.committed_at` + 状态
 * `committed`）/ 恢复（拿备份覆盖主库）这四类动作都会**丢掉现场**，它们的「现在能不能动手」
 * 必须是同一个答案。此前这条判定散在 `state.ts` 与 `orchestrator.ts` 两处，且两处都写成
 * `await deps.sqliteFileExists().catch(() => true)`：
 *
 *   > 检查本身失败  →  按「文件在」处理  →  仍然 `openSqlite()`
 *   > 而驱动会为不存在的库**创建一个空库**（见 `state.ts` 里 `readSqliteWitness` 的注释）
 *   > 于是「一次失败的检查」自己造出了「库在、而且是空的」这条证据，再拿它去放行清库/重迁。
 *
 * 这正好违反同一行上面那句注释自己的理由（「主库文件不存在就不去打开它」）。
 *
 * 三态纪律（类型层 + 运行期各一道闸）：
 *  - `present | absent | unknown` 是封闭联合；`unknown` **不得**折叠成「存在」或「不存在」。
 *  - `judgeMainDbTouch()` 的 `allow: true` 分支只携带 `present | absent`，所以「放行了、但事实
 *    是 unknown」在类型上就构造不出来；分支穷尽用 `assertNever`，将来有人加了第四态却漏判，
 *    这里直接编不过（运行期也不会落到「放行」）。
 *  - 运行期最后一道：`unknown` 一律 `allow: false`，调用方只能停下来（不 open、不清、不切、不恢复）。
 */

/** 主库文件的存在性。`unknown` = 检查本身失败（或没接线），不是「没有」。 */
export type FilePresence = 'present' | 'absent' | 'unknown'

/** 四类破坏性动作。只用于诊断与用例枚举，判定口径完全相同（都是「能不能碰主库」）。 */
export type DestructiveAction = 'migrate' | 'clear' | 'switch' | 'restore'

/** `unknown` 时的 blocked 详情：进闸门页、进状态机诊断，便于现场归因。 */
export const MAIN_DB_PRESENCE_UNKNOWN_DETAIL = 'main-db-presence-unknown'

export type MainDbTouchVerdict =
  | { allow: true; presence: 'present' | 'absent' }
  | { allow: false; presence: 'unknown'; reason: 'presence-unknown'; detail: string }

/**
 * 编译期穷尽检查：联合类型新增成员却漏了分支，这里就编不过（运行期则抛，绝不静默放行）。
 */
export const assertNever = (value: never): never => {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`)
}

/**
 * 读「主库文件在不在」。
 *
 * - 没接线（`check === undefined`）：按生产接线的既有事实处理 —— 原生插件没有 exists 能力，
 *   `wiring.ts` 恒报「在」（见那里的注释与 `ports.ts` 的「缺省视为存在」）。这是**声明过的默认值**，
 *   不是「检查失败被当成存在」：两者在这一行分开成两条路径。
 * - 检查抛错：`unknown`。绝不 `catch(() => true)`，也绝不 `catch(() => false)` ——
 *   前者会去打开一个可能不存在的库（创建空库），后者会把「可能有数据的主库」当成全新安装。
 */
export const readFilePresence = async (
  check: (() => Promise<boolean>) | undefined
): Promise<FilePresence> => {
  if (check === undefined) {
    return 'present'
  }
  try {
    return (await check()) === true ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}

/**
 * 破坏性动作的唯一前置判定（纯函数）。四类动作走同一条分支，口径不因调用方而变。
 *
 * `action` 只进 `detail`（诊断与用例用），不影响放行与否 —— 否则「同一处判定」就不成立了。
 */
export const judgeMainDbTouch = (
  presence: FilePresence,
  action: DestructiveAction
): MainDbTouchVerdict => {
  switch (presence) {
    case 'present':
    case 'absent':
      return { allow: true, presence }
    case 'unknown':
      return {
        allow: false,
        presence,
        reason: 'presence-unknown',
        detail: `${MAIN_DB_PRESENCE_UNKNOWN_DETAIL}:${action}`,
      }
    default:
      return assertNever(presence)
  }
}

/** 读事实 + 判定，一步到位。四处破坏性动作的调用点只用它，不许自己读布尔值。 */
export const resolveMainDbTouch = async (
  check: (() => Promise<boolean>) | undefined,
  action: DestructiveAction
): Promise<MainDbTouchVerdict> => judgeMainDbTouch(await readFilePresence(check), action)
