// [fixture | #480 验收测试 | L1 专用：附件存储的**内存版 IndexedDB 落点**]
//
// `src/services/attachments/{store,manager}.ts` 只通过 `../chat/db.js` 的几个入口落库：
// `getChatDB()` 拿库、`saveFiles/loadFile` 存取原件、`reportStorageError` 报错。
// Node 里没有 IndexedDB，所以这里给一份**同形状的内存实现**，让 store/manager 的**真代码**
// （sha256 去重键 `sha256:parserVersion`、引用计数删除、孤儿清扫、状态机）能真跑。
//
// 边界说清楚（#528 评论里同样写明）：
//  - 被替身的是「IndexedDB 引擎本身」，不是我们的存储逻辑；
//  - `db.ts` 的 **v13 schema / 升级路径**因此不在 L1-node 的覆盖范围（那部分由浏览器的
//    golden 用例用真 IndexedDB 覆盖，见 tests/golden/g13-480-doc-attach.test.mjs）；
//  - 表的形状（`attachments` / `attachmentTexts` / `files`）与索引名（`sha256` /
//    `parsedTextPath`）按 `db.ts` 的 v13 定义照抄，抄错了本文件里的断言会立刻红。
const tables = {
  attachments: new Map(),
  attachmentTexts: new Map(),
  files: new Map(),
}

const INDEXES = {
  attachments: ['sha256', 'parsedTextPath'],
}

const indexValues = (table, name, key) => {
  const hits = []
  for (const record of tables[table].values()) {
    if (record[name] === key) {
      hits.push(record)
    }
  }
  return hits
}

const cursorOf = (table) => {
  const entries = [...tables[table].entries()]
  let position = 0
  const step = () => {
    if (position >= entries.length) {
      return null
    }
    const [key, value] = entries[position]
    const cursor = {
      key,
      value,
      delete: async () => {
        tables[table].delete(key)
      },
      continue: async () => {
        position += 1
        return step()
      },
    }
    position += 1
    return cursor
  }
  return async () => step()
}

const objectStoreOf = (table) => ({
  get: async (key) => tables[table].get(key),
  put: async (record) => {
    tables[table].set(record.key ?? record.id, record)
  },
  delete: async (key) => {
    tables[table].delete(key)
  },
  getAll: async () => [...tables[table].values()],
  count: async (key) => (tables[table].has(key) ? 1 : 0),
  index: (name) => ({
    count: async (key) => (INDEXES[table] ?? []).includes(name) ? indexValues(table, name, key).length : 0,
    getAll: async (key) => indexValues(table, name, key),
  }),
  openCursor: cursorOf(table),
  openKeyCursor: cursorOf(table),
})

export const getChatDB = async () => {
  const transaction = (names, mode) => {
    const list = Array.isArray(names) ? names : [names]
    const tx = {
      done: Promise.resolve(),
      store: objectStoreOf(list[0]),
      objectStore: (name) => objectStoreOf(name),
      abort: () => {},
    }
    void mode
    return tx
  }
  return {
    transaction,
    store: objectStoreOf('attachments'),
    get: async (table, key) => tables[table].get(key),
    put: async (table, record) => {
      tables[table].set(record.key ?? record.id, record)
    },
    count: async (table, key) => (tables[table].has(key) ? 1 : 0),
    getAll: async (table) => [...tables[table].values()],
  }
}

export const saveFiles = async (files) => {
  for (const file of files) {
    tables.files.set(file.id, file.blob)
  }
}

export const loadFile = async (key) => tables.files.get(key)

export const reportStorageError = () => () => {}

/** 用例专用：模拟整包导入 `commitStaging()` 的 `files.clear()`（#531 的降级场景） */
export const __clearFiles = () => {
  tables.files.clear()
}

export const __reset = () => {
  for (const table of Object.values(tables)) {
    table.clear()
  }
}

export const __tableOf = (name) => tables[name]
