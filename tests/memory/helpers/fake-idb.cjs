'use strict';
/**
 * fake-idb.cjs — 够 vectorstore.js 用的最小 IndexedDB。
 *
 * 只实现 vectorstore.js 实际用到的那一小撮 API：
 *   open / onupgradeneeded / onsuccess、createObjectStore(keyPath)、createIndex(name, keyPath)、
 *   transaction(store, mode) / objectStore / put / delete、index(name).getAll(keyRange).getAllKeys(keyRange)
 *
 * 回调一律走微任务，保证「先挂 onsuccess 再触发」与浏览器一致；不碰真实磁盘、不依赖浏览器。
 */
const IDBKeyRange = {
    only: value => ({ __only: value }),
};

function cloneRecord(rec) {
    return { ...rec };
}

function createIndexedDB({ failOpen = null } = {}) {
    const databases = new Map();

    const database = name => {
        if (!databases.has(name)) databases.set(name, { name, version: 0, stores: new Map() });
        return databases.get(name);
    };

    function makeRequest() {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        req._settle = (fn) => queueMicrotask(() => {
            try {
                fn();
                req.onsuccess?.();
            } catch (err) {
                req.error = err;
                req.onerror?.();
            }
        });
        return req;
    }

    function storeHandle(dbState, storeName, mode) {
        const store = dbState.stores.get(storeName);
        if (!store) throw new Error(`object store not found: ${storeName}`);
        void mode;
        return {
            createIndex(indexName, keyPath) {
                store.indexes.set(indexName, keyPath);
                return { indexName };
            },
            put(record) {
                const key = String(record[store.keyPath]);
                store.records.set(key, cloneRecord(record));
                return makeRequest();
            },
            delete(key) {
                store.records.delete(String(key));
                return makeRequest();
            },
            index(indexName) {
                const keyPath = store.indexes.get(indexName);
                if (!keyPath) throw new Error(`index not found: ${indexName}`);
                const matching = only => [...store.records.values()]
                    .filter(rec => (only === undefined ? true : rec[keyPath] === only));
                return {
                    getAll(range) {
                        const req = makeRequest();
                        const rows = matching(range?.__only).map(cloneRecord);
                        req._settle(() => { req.result = rows; });
                        return req;
                    },
                    getAllKeys(range) {
                        const req = makeRequest();
                        const keys = matching(range?.__only)
                            .map(rec => String(rec[store.keyPath]));
                        req._settle(() => { req.result = keys; });
                        return req;
                    },
                };
            },
        };
    }

    function open(name, version) {
        const req = makeRequest();
        const dbState = database(name);
        const db = {
            objectStoreNames: { contains: n => dbState.stores.has(n) },
            createObjectStore(storeName, { keyPath = 'key' } = {}) {
                dbState.stores.set(storeName, { keyPath, records: new Map(), indexes: new Map() });
                return storeHandle(dbState, storeName, 'readwrite');
            },
            transaction(storeName, mode = 'readonly') {
                const tx = { oncomplete: null, onerror: null, onabort: null };
                queueMicrotask(() => { tx.oncomplete?.(); });
                return {
                    objectStore: () => storeHandle(dbState, storeName, mode),
                    set oncomplete(fn) { tx.oncomplete = fn; },
                    get oncomplete() { return tx.oncomplete; },
                    set onerror(fn) { tx.onerror = fn; },
                    get onerror() { return tx.onerror; },
                    set onabort(fn) { tx.onabort = fn; },
                    get onabort() { return tx.onabort; },
                };
            },
            onversionchange: null,
            onclose: null,
        };
        dbState.version = version;
        req._settle(() => {
            if (failOpen) throw failOpen;
            req.result = db;
            if (!dbState.stores.size) req.onupgradeneeded?.();
            // vectorstore.js 会自己在 onupgradeneeded 里建表；没挂回调时给一个默认表，避免后续抛错。
            if (!dbState.stores.size) {
                dbState.stores.set('vectors', { keyPath: 'key', records: new Map(), indexes: new Map([['chatKey', 'chatKey']]) });
            }
        });
        return req;
    }

    return {
        open,
        IDBKeyRange,
        /** 供断言：某个库/表里现在有多少条记录 */
        dump(name = 'sc_recall_vectors', storeName = 'vectors') {
            return [...(database(name).stores.get(storeName)?.records.values() ?? [])];
        },
        reset() { databases.clear(); },
    };
}

module.exports = { createIndexedDB, IDBKeyRange };
