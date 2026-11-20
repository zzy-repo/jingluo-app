/**
 * vectorstore.js — 向量持久化（IndexedDB）
 *
 * 为什么要 IndexedDB 而不是 chatMetadata：
 *   512 维 float 一条就 2KB。几千条消息直接塞进 chatMetadata 会把聊天文件撑爆，
 *   而且每次 saveMetadata 都要序列化整坨。向量属于"派生数据"，丢了能重算，就该单独存。
 *
 * 存储布局照搬 Horae/core/vectorManager.js 的 _openDB / _saveVector：
 *   keyPath = 'key'（`${chatKey}_${messageIndex}`），附带 chatKey 索引用于按会话取全量。
 *
 * 暴露：window.SCVectorStore
 */
(function () {
    'use strict';

    const VERSION = '0.1.0';
    const DB_NAME = 'sc_recall_vectors';
    const DB_VERSION = 1;
    const STORE = 'vectors';

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'key' });
                    store.createIndex('chatKey', 'chatKey', { unique: false });
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { try { db.close(); } catch (_) {} dbPromise = null; };
                db.onclose = () => { dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    function tx(mode, fn) {
        return openDb().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const store = t.objectStore(STORE);
            let out = null;
            try {
                out = fn(store);
            } catch (e) {
                reject(e);
                return;
            }
            t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        }));
    }

    /** 内存缓存：一个会话的向量全量放这里，检索就不必每次读盘。 */
    const memory = new Map(); // chatKey -> Map<idx, {vec: Float32Array, text, turn}>

    function toFloat32(arr) {
        return arr instanceof Float32Array ? arr : Float32Array.from(arr || []);
    }

    async function putMany(chatKey, rows, model, dim, namespace = '') {
        if (!rows || rows.length === 0) return 0;
        const records = rows.map(r => ({
            key: `${chatKey}_${r.idx}`, chatKey, idx: r.idx, vec: toFloat32(r.vec),
            text: String(r.text || '').slice(0, 4000), turn: r.idx,
            model: model || '', namespace, dim: dim || r.vec?.length || 0, ts: Date.now(),
        }));
        await tx('readwrite', store => {
            for (const rec of records) store.put(rec);
        });
        const bucket = memory.get(chatKey) || new Map();
        for (const rec of records) bucket.set(rec.idx, rec);
        memory.set(chatKey, bucket);
        return rows.length;
    }

    async function loadAll(chatKey) {
        if (memory.has(chatKey)) return memory.get(chatKey);
        const records = await new Promise((resolve, reject) => {
            openDb().then(db => {
                const t = db.transaction(STORE, 'readonly');
                const idx = t.objectStore(STORE).index('chatKey');
                const req = idx.getAll(IDBKeyRange.only(chatKey));
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            }).catch(reject);
        });

        const bucket = new Map();
        for (const rec of records) {
            bucket.set(rec.idx, { ...rec, vec: toFloat32(rec.vec), text: rec.text || '' });
        }
        memory.set(chatKey, bucket);
        return bucket;
    }

    async function remove(chatKey, idx) {
        await tx('readwrite', store => store.delete(`${chatKey}_${idx}`));
        const bucket = memory.get(chatKey);
        if (bucket) bucket.delete(idx);
    }

    async function clearChat(chatKey) {
        const keys = await new Promise((resolve, reject) => {
            openDb().then(db => {
                const t = db.transaction(STORE, 'readonly');
                const idx = t.objectStore(STORE).index('chatKey');
                const req = idx.getAllKeys(IDBKeyRange.only(chatKey));
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            }).catch(reject);
        });
        if (keys.length) await tx('readwrite', store => { for (const k of keys) store.delete(k); });
        memory.delete(chatKey);
        return keys.length;
    }

    function cosine(a, b) {
        if (!a?.length || a.length !== b?.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /**
     * 暴力余弦检索。
     * 为什么要暴力：单个会话 ≤ 几千条，扫一遍几毫秒；上 HNSW 是纯粹的复杂度浪费，
     * 而且要自己维护索引一致性（删消息、分支、改文本全得重建）。
     */
    async function search(chatKey, queryVec, { topK = 20, exclude, allowed, namespace, expectedTexts } = {}) {
        const bucket = await loadAll(chatKey);
        const q = toFloat32(queryVec);
        const hits = [];
        for (const [idx, rec] of bucket) {
            if (exclude?.has(idx) || (allowed && !allowed.has(idx))) continue;
            if (namespace !== undefined && rec.namespace !== namespace) continue;
            if (expectedTexts && expectedTexts.get(idx) !== rec.text) continue;
            if (!q.length || q.length !== rec.vec.length) continue;
            const similarity = cosine(q, rec.vec);
            if (Number.isFinite(similarity)) hits.push({ idx, similarity, text: rec.text });
        }
        hits.sort((a, b) => b.similarity - a.similarity);
        return hits.slice(0, topK);
    }

    async function stats(chatKey) {
        const bucket = await loadAll(chatKey);
        return { count: bucket.size };
    }

    if (typeof window !== 'undefined') {
        window.SCVectorStore = { VERSION, putMany, loadAll, remove, clearChat, search, stats, cosine };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { VERSION, putMany, loadAll, remove, clearChat, search, stats, cosine };
    }
})();
