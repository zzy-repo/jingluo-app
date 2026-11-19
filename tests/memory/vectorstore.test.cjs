'use strict';
/**
 * vectorstore 分组回归 —— 按模型/维度命名空间隔离、模型切换不串、检索过滤、清理
 *
 * 用内存版 IndexedDB（helpers/fake-idb.cjs）跑真模块，不碰浏览器、不碰网络。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./helpers/load.cjs');
const { createIndexedDB, IDBKeyRange } = require('./helpers/fake-idb.cjs');

const MODEL_A = 'Qwen/Qwen3-Embedding-0.6B';
const MODEL_B = 'BAAI/bge-m3';
const ns = (url, model, dim) => JSON.stringify([url, model, dim]);
const vec = (head, dim = 8) => Array.from({ length: dim }, (_, i) => (i === 0 ? head : 0));
/** vm 沙箱里返回的数组原型不同，跨 realm 一律转成本 realm 的数组再比。 */
const idxs = hits => Array.from(hits, h => h.idx);

function freshStore() {
    const idb = createIndexedDB();
    const mod = loadModule('vectorstore', { globals: { indexedDB: idb, IDBKeyRange } });
    return { store: mod.exports, idb };
}

test('命名空间隔离：不同端点/模型/维度写进去的记录互不可见', async () => {
    const { store } = freshStore();
    const nsA = ns('https://a.example/v1', MODEL_A, 1024);
    const nsB = ns('https://b.example/v1', MODEL_A, 1024);
    await store.putMany('npc::A', [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1, 1024) }], MODEL_A, 1024, nsA);
    await store.putMany('npc::A', [{ idx: 1, text: '青木弓藏在石台下面', vec: vec(1, 1024) }], MODEL_A, 1024, nsB);

    const onlyA = await store.search('npc::A', vec(1, 1024), { namespace: nsA });
    assert.deepEqual(idxs(onlyA), [0]);

    const onlyB = await store.search('npc::A', vec(1, 1024), { namespace: nsB });
    assert.deepEqual(idxs(onlyB), [1]);

    const anyNamespace = await store.search('npc::A', vec(1, 1024), {});
    assert.deepEqual(idxs(anyNamespace).sort(), [0, 1], '不传命名空间时才看全部');
});

test('模型切换不串：换模型后旧模型的向量既不命中也不被当成新结果', async () => {
    const { store } = freshStore();
    const nsA = ns('https://api.example/v1', MODEL_A, 1024);
    const nsB = ns('https://api.example/v1', MODEL_B, 1024);
    await store.putMany('npc::A', [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1, 1024) }], MODEL_A, 1024, nsA);

    assert.deepEqual(idxs(await store.search('npc::A', vec(1, 1024), { namespace: nsB })), []);
    assert.deepEqual(idxs(await store.search('npc::A', vec(1, 1024), { namespace: nsA })), [0]);

    // 用新模型重算同一条消息：同一 key 覆盖，不会留下两份互相打架的记录
    await store.putMany('npc::A', [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1, 1024) }], MODEL_B, 1024, nsB);
    assert.deepEqual(idxs(await store.search('npc::A', vec(1, 1024), { namespace: nsA })), []);
    assert.deepEqual(idxs(await store.search('npc::A', vec(1, 1024), { namespace: nsB })), [0]);
    assert.equal((await store.stats('npc::A')).count, 1);
});

test('维度不一致的查询被跳过，不会拿错维度的相似度排序', async () => {
    const { store } = freshStore();
    const nsA = ns('https://api.example/v1', MODEL_A, 1024);
    await store.putMany('npc::A', [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1, 1024) }], MODEL_A, 1024, nsA);
    assert.deepEqual(idxs(await store.search('npc::A', vec(1, 512), { namespace: nsA })), []);
    assert.deepEqual(idxs(await store.search('npc::A', [], { namespace: nsA })), []);
});

test('检索过滤：exclude / allowed / expectedTexts / topK 都生效', async () => {
    const { store } = freshStore();
    const rows = [
        { idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1) },
        { idx: 1, text: '青木弓藏在石台下面', vec: vec(1) },
        { idx: 2, text: '紫铜镜藏在地板下面', vec: vec(1) },
    ];
    await store.putMany('npc::A', rows, MODEL_A, 8, 'ns');

    const excluded = await store.search('npc::A', vec(1), { exclude: new Set([0]), namespace: 'ns' });
    assert.deepEqual(idxs(excluded).sort(), [1, 2]);

    const allowed = await store.search('npc::A', vec(1), { allowed: new Set([2]), namespace: 'ns' });
    assert.deepEqual(idxs(allowed), [2]);

    const stale = await store.search('npc::A', vec(1), {
        namespace: 'ns',
        expectedTexts: new Map([[0, rows[0].text], [1, '这段话被改过了'], [2, rows[2].text]]),
    });
    assert.deepEqual(idxs(stale).sort(), [0, 2], '原文改过的记录不能当命中');

    const limited = await store.search('npc::A', vec(1), { namespace: 'ns', topK: 1 });
    assert.equal(limited.length, 1);
});

test('清理：remove 只删一条，clearChat 只清自己的会话并同步内存缓存', async () => {
    const { store } = freshStore();
    await store.putMany('npc::A', [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec(1) }], MODEL_A, 8, 'ns');
    await store.putMany('npc::B', [{ idx: 0, text: '紫铜镜藏在地板下面', vec: vec(1) }], MODEL_A, 8, 'ns');

    await store.remove('npc::A', 0);
    assert.equal((await store.loadAll('npc::A')).size, 0);

    await store.putMany('npc::A', [{ idx: 3, text: '玄霜扇有一道裂纹', vec: vec(1) }], MODEL_A, 8, 'ns');
    assert.equal((await store.loadAll('npc::A')).size, 1);

    const cleared = await store.clearChat('npc::A');
    assert.equal(cleared, 1);
    assert.equal((await store.loadAll('npc::A')).size, 0, '清完之后缓存里也不能还留着');
    assert.equal((await store.loadAll('npc::B')).size, 1, '别的会话不受影响');
});

test('余弦：维度不一致直接判 0，零向量不参与相似度', async () => {
    const { store } = freshStore();
    assert.equal(store.cosine([1, 0], [1, 0]), 1);
    assert.equal(store.cosine([1, 0], [1, 0, 1]), 0);
    assert.equal(store.cosine([], [1]), 0);
    assert.equal(store.cosine([0, 0], [1, 1]), 0);
});
