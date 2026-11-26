// 存储契约套件入口。只依赖 Node 与 `StorageBackend` 接口：不 import react / zustand / components / app / @capacitor/*，
// 不 import db.ts，不读任何物理存储名。环境搭建（fake-indexeddb、将来的 SQLite）全在各后端 runner 里。
import { register as registerAtomic } from './atomic.mjs'
import { register as registerAttachment } from './attachment.mjs'
import { register as registerBlob } from './blob.mjs'
import { register as registerErrors } from './errors.mjs'
import { register as registerHealth } from './health.mjs'
import { register as registerMemory } from './memory.mjs'
import { register as registerSave } from './save.mjs'
import { register as registerSession } from './session.mjs'
import { register as registerStaging } from './staging.mjs'
import { runSuite } from './suite.mjs'
import { register as registerUpgrade } from './upgrade.mjs'

export const CONTRACT_FILES = ['session', 'save', 'blob', 'attachment', 'memory', 'staging', 'atomic', 'errors', 'health', 'upgrade']
const REGISTRARS = [registerSession, registerSave, registerBlob, registerAttachment, registerMemory, registerStaging, registerAtomic, registerErrors, registerHealth, registerUpgrade]

/**
 * 对任意 `StorageBackend` 实现跑同一套契约。钩子形状见 `suite.mjs` 顶部注释。
 * `extra`：该后端自己的专属用例注册器（`(suite) => void`），与契约本体分开计数、不进契约。
 */
export const runStorageContract = ({ extra = [], ...hooks }) => runSuite({ ...hooks, registrars: [...REGISTRARS, ...extra] })
