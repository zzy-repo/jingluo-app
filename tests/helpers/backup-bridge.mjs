// `BackupFile` 原生桥替身（内存文件系统）—— 备份一族的用例共用这一份。
//
// 为什么抽出来（check:test-duplication R1 逐字重复 ≥20 行，基线只减不增）：`backup-core-993`
// 与 `backup-safety-retention-1005` 原先各抄一份 30 行，除了「故意要分歧」的那几处（失败注入 /
// 删除计数）逐字相同；而在 run-layer 的合并批次里，两份替身**抢同一个全局**
// （`globalThis.__bridge` / `__native` 是进程级的，谁后装谁生效），后跑的文件就会拿错替身
// 报出「明明是 pass 的用例红了」的假红 —— 同一类进程级串扰的另一面。
//
// 语义照抄原生 `BackupFilePlugin.java`：`<name>.part` → 校验 → rename、默认拒绝同名覆盖、
// 唯一白名单是 `status.json`。**这里只有「原生侧行为」，不含任何断言口径。**
//
//   import { createBackupBridge } from '../helpers/backup-bridge.mjs'
//   const native = createBackupBridge()
//   const { bridge, committed } = native
//   native.install()                       // 装上 globalThis.__bridge / __native（native=true）
//   native.reset()                         // 每个用例开头复位（盘 / 临时文件 / 注入开关 / 删除计数）
//   native.state.freeBytes = 0             // 段落旋钮：容量、失败注入、删除失败名单
import { createHash } from 'node:crypto'

import { onTestStateReset } from './merged-tracker.mjs'

/**
 * 唯一允许同名替换的文件名（原生侧白名单，见 `BackupFilePlugin.OVERWRITABLE_NAME`）。
 * 用例里应当再与 `core.STATUS_FILE_NAME` 对一次 —— 两边一旦漂开必须红。
 */
export const STATUS_FILE_NAME = 'status.json'

const DEFAULT_FREE_BYTES = 1024 * 1024 * 1024

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const codedError = (code, message = code) => Object.assign(new Error(message), { code })

/**
 * 造一份替身。返回的对象上：
 *   `bridge`  交给 `@capacitor/core` 替身的 `registerPlugin()` 用的桥本身；
 *   `state`   段落旋钮（见下），用例可读可写；
 *   `committed` / `removeCalls` / `removeFails`  与桥共享的同一份容器（清空即可复位，别整体替换）；
 *   `install()` / `reset()`  装全局、逐用例复位。
 *
 * `state` 字段：
 *   `committed`  已提交文件 name → 字节；
 *   `pending`    正在写的临时文件（`<name>.part`）或 null；
 *   `failMode`   `'chunk'` 写块失败 / `'verify'` 收尾校验失败 / null 正常；
 *   `failName`   只让这一个文件名写块失败（null = 不限文件）；
 *   `removeCalls`/`removeFails`  `remove` 的调用计数与「删这些名字就抛错」的注入点；
 *   `freeBytes`  `freeBytes()` 报的剩余空间。
 */
export const createBackupBridge = ({ freeBytes = DEFAULT_FREE_BYTES } = {}) => {
  const committed = new Map()
  const removeCalls = new Map()
  const removeFails = new Set()

  const state = {
    committed,
    pending: null,
    failMode: null,
    failName: null,
    removeCalls,
    removeFails,
    freeBytes,
  }

  const pendingBytes = () => Buffer.concat(state.pending ? state.pending.chunks : [])

  const bridge = {
    begin: async ({ name, allowOverwrite }) => {
      // 语义照抄原生 `begin`：默认拒绝同名覆盖，唯一例外是「调用方明确要求 + 名字在白名单里」
      const mayOverwrite = allowOverwrite === true && name === STATUS_FILE_NAME
      if (committed.has(name) && !mayOverwrite) {
        throw codedError('TARGET_EXISTS')
      }
      state.pending = { name, chunks: [], mayOverwrite }
      return { name }
    },
    writeChunk: async ({ data }) => {
      const failThisFile = state.failName === null || state.pending?.name === state.failName
      if (state.failMode === 'chunk' && failThisFile) {
        throw codedError('WRITE_FAILED', '写入备份失败')
      }
      state.pending.chunks.push(Buffer.from(data, 'base64'))
    },
    finish: async ({ name }) => {
      if (!state.pending) {
        throw codedError('NO_WRITE')
      }
      if (state.failMode === 'verify') {
        state.pending = null
        throw codedError('CHECKSUM_MISMATCH', '校验值与落盘内容不一致')
      }
      const bytes = pendingBytes()
      const mayOverwrite = state.pending.mayOverwrite
      state.pending = null
      // 原生 `finish` 在 rename 之前还会再查一次：非白名单目标即使走到这里也不许覆盖
      if (committed.has(name) && !mayOverwrite) {
        throw codedError('TARGET_EXISTS', '同名备份已存在')
      }
      committed.set(name, bytes)
      return { name, sizeBytes: bytes.length, sha256: hex(bytes) }
    },
    abort: async () => {
      state.pending = null
    },
    list: async () => ({
      files: [...committed.entries()].map(([name, bytes]) => ({
        name,
        sizeBytes: bytes.length,
        mtimeMs: Date.now(),
      })),
    }),
    readChunk: async ({ name, offset, length }) => {
      const bytes = committed.get(name)
      if (!bytes) {
        throw codedError('NOT_FOUND')
      }
      const slice = bytes.subarray(offset, Math.min(offset + length, bytes.length))
      return { data: Buffer.from(slice).toString('base64'), eof: offset + slice.length >= bytes.length }
    },
    hash: async ({ name }) => {
      const bytes = committed.get(name)
      if (!bytes) {
        throw codedError('NOT_FOUND')
      }
      return { sha256: hex(bytes), sizeBytes: bytes.length }
    },
    remove: async ({ name }) => {
      // 计数与失败注入都是「清理路径」的观测点：用来钉「同一个文件不许被反复尝试删除」、
      // 以及「删不掉也要照样把备份做完」。
      removeCalls.set(name, (removeCalls.get(name) ?? 0) + 1)
      if (removeFails.has(name)) {
        throw codedError('WRITE_FAILED', '删除失败')
      }
      committed.delete(name)
    },
    freeBytes: async () => ({ bytes: state.freeBytes }),
  }

  /** 装全局：`@capacitor/core` 的替身靠它判原生 / 拿桥（与真桥的两处入口一致） */
  const install = () => {
    globalThis.__bridge = bridge
    globalThis.__native = true
    return bridge
  }

  /** 逐用例复位：盘清空、临时文件丢掉、注入开关归位、删除计数清零、容量回到默认 */
  const reset = () => {
    committed.clear()
    removeCalls.clear()
    removeFails.clear()
    state.pending = null
    state.failMode = null
    state.failName = null
    state.freeBytes = DEFAULT_FREE_BYTES
  }

  return { bridge, state, committed, removeCalls, removeFails, STATUS_NAME: STATUS_FILE_NAME, install, reset }
}

/**
 * **进程内唯一的那一份** —— 用例请用这个，不要自己 `createBackupBridge()` 造第二份。
 *
 * 为什么必须唯一：被测源码 `src/services/backup/nativeBackupFs.ts` 在模块顶层
 * `const bridge = registerPlugin('BackupFile')` 只抓**一次**，而模块在合并批次里是同一个实例
 * （同 URL 缓存），抓到的桥此后不再变。各文件造各自的实例时，后跑的文件把自己的盘装进全局，
 * 被测代码却还在写第一张盘 → 单文件跑 9/9 绿、批内报 3 例红（DEGRADED）。这与
 * `math-blocks-821` 的冷却缓存、`update-gate` 的解析 hook 是同一类**进程级单例**问题。
 *
 * 复位的两个口子：用例自己 `reset()`（单文件路径），以及登记给合并入口的
 * `onTestStateReset()`（一批里换文件时清一次，见 `helpers/merged-tracker.mjs` 第 3 类）。
 */
export const backupBridge = createBackupBridge()

onTestStateReset(() => backupBridge.reset())
