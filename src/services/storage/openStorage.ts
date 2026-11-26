/**
 * 存储后端工厂的类型签名（Issue #906 阶段 A）。
 *
 * 只有类型，没有实现：真正的 `openStorage` 要到「接上 IndexedDB 后端」那一阶段才有函数体。
 * 放在单独文件里，是为了让「工厂长什么样」有一个可以 import 的名字，而不是埋在文档里。
 */
import type { OpenStorage, StorageBackend } from './types.js'

export type { OpenStorage, StorageBackend }

/**
 * 后端实现登记自己的方式：一个无参异步函数，返回打开好的 `StorageBackend`。
 * Web 端将来是 `openIndexedDbStorage`，Native 端是 `openSqliteStorage`，签名相同，
 * 因此调用方（以及测试替身）不需要知道后面是哪一个。
 */
export type StorageOpener = OpenStorage

/**
 * 选择后端的依据。阶段 A 不决定选择策略，只把「需要做这个选择」记下来：
 * 同一个构建里可能同时有两个可用后端（Capacitor 壳里 WebView 也有 IndexedDB），
 * 选谁是运行时的事，不该编译期写死。
 */
export type StorageBackendKind = 'indexeddb' | 'sqlite'
