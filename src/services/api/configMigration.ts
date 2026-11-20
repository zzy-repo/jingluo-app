import { recordAction } from '../diagnostics/collector.js'
import {
  clearLegacySharedModel,
  getProviderKind,
  isLegacyRelayInUse,
  readConfigValue,
  readLegacySharedModel,
  syncModelFromStorage,
  writeConfigValue,
} from './apiConfig.js'

/**
 * 一次性配置迁移（#339）。
 *
 * 背景：1.2.x 的 `setModel()` 不区分渠道，把所有模型名都写进**共享键** `chat-demo:model`；
 * 现在的代码早已没有写入点，但读取点一直留着（官方渠道曾经拿它当「老用户升级无感」的兜底）。
 * 于是只要那个键里躺过任何名字，切回官方渠道后就会原样发给官方端点 —— 而官方端点只认
 * `deepseek-flash` / `deepseek-v4-pro`，于是 400，且用户在设置页既看不到也改不了那个值。
 *
 * 为什么必须迁移而不是只改读取顺序：残留值留在本地会一直是个「休眠污染源」——换渠道、
 * 换构建、以后谁再读一次共享键，同一个 bug 就复活。读侧已经堵住（apiConfig 的 `storedModel`），
 * 写侧由这里一次性清掉，并用诊断留痕（`config_change / legacy-model / result=migrated`），
 * 出问题时能直接看到「哪个值、多长、什么时候被清掉的」。
 *
 * 幂等：版本号 `chat-demo:config-schema` 到 2 之后直接返回，不再动任何键；
 * 迁移跑在 `src/main.tsx` 里（`initDiagnostics` 之前，collector 是模块级缓冲，早写不会丢）。
 */
export const CONFIG_SCHEMA_KEY = 'chat-demo:config-schema'

/** 1 = 1.2.x / 1.3.0（共享 chat-demo:model 说了算）；2 = 内置渠道只认 spec.defaults（#339） */
export const CONFIG_SCHEMA_VERSION = 2

export type ConfigMigrationResult = {
  /** 这次真的清掉的残留模型名；没有残留 / 老中转仍在用 / 已迁移过时都是 null */
  clearedModel: string | null
  /** 迁移前记录的版本号（没有这个键时按 1 算） */
  from: number
  /** 迁移后的版本号（已是最新版本时不写盘，原样返回） */
  to: number
}

const readSchemaVersion = (): number => {
  // 存储不可用（隐私模式 / 配额满）时 apiConfig 的读取口返回 null：当作最老的版本，
  // 本次按「无残留」处理，不会误删任何东西
  const parsed = Number.parseInt(readConfigValue(CONFIG_SCHEMA_KEY) ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

const writeSchemaVersion = (version: number): void => {
  // 写不进去只会让迁移下次再跑一次（幂等），不阻断启动
  writeConfigValue(CONFIG_SCHEMA_KEY, String(version))
}

/**
 * 跑一次配置迁移（幂等）。返回本次的结果，供单测与诊断对账。
 *
 * 只清「已经不生效」的残留：老中转（共享 `chat-demo:base-url` 不是官方默认地址）时，
 * 地址与模型是同一套配置，模型仍然有效，**不能**动 —— 那是 1.2.3 老用户的正常配置。
 * `chat-demo:base-url` 本身不删（`LEGACY_HOSTS` 已在读取时过滤，另有回归测试锁定）。
 */
export const migrateConfigOnce = (): ConfigMigrationResult => {
  const from = readSchemaVersion()
  if (from >= CONFIG_SCHEMA_VERSION) {
    return { clearedModel: null, from, to: from }
  }
  let clearedModel: string | null = null
  const legacyModel = readLegacySharedModel()
  if (legacyModel && !isLegacyRelayInUse('deepseek')) {
    clearLegacySharedModel()
    clearedModel = legacyModel
    // meta 至少两个键（check:log-coverage 的 R3）：result 给口径，model / length / kind 给取证
    recordAction('config_change', 'legacy-model', {
      result: 'migrated',
      model: legacyModel,
      length: legacyModel.length,
      kind: getProviderKind(),
    })
  }
  writeSchemaVersion(CONFIG_SCHEMA_VERSION)
  // 残留值清掉后同步一次界面 state，否则这一轮仍会按 store 里的旧值发请求
  syncModelFromStorage()
  return { clearedModel, from, to: CONFIG_SCHEMA_VERSION }
}
