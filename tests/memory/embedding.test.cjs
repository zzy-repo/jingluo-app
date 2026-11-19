'use strict';
/**
 * embedding 客户端分组回归 —— 成功 / 无配置 / 4xx / 5xx / 超时 / 维度不一致
 *
 * 全部走假 fetch + 假时钟：不发真实请求、不 sleep、结果与机器时间无关。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./helpers/load.cjs');
const { createFetch, createTimer, fixedDate, jsonResponse } = require('./helpers/fake-net.cjs');
const { createHost } = require('./helpers/host.cjs');

const VECTOR_1024 = () => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));

function client({ fetch, timer = createTimer(), Date: DateImpl = fixedDate(), url = 'https://api.example.test/v1', key = 'sk-test', model = 'Qwen/Qwen3-Embedding-0.6B' } = {}) {
    const mod = loadModule('embedding', {
        globals: { fetch, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, Date: DateImpl },
    });
    const instance = new mod.exports.EmbeddingClient();
    if (url !== null) instance.configure({ url, key, model });
    return { instance, timer, mod };
}

const openAiBody = vectors => jsonResponse({ data: vectors.map((embedding, index) => ({ index, embedding })) });

// ─── 成功 ────────────────────────────────────────────────────────────

test('成功：OpenAI 兼容端点，请求体与鉴权头正确，返回按 index 归位', async () => {
    const fetch = createFetch([openAiBody([[0, 1], [1, 0]])]);
    const { instance } = client({ fetch });

    const vectors = await instance.embedBatch(['第一条', '第二条']);
    assert.deepEqual(vectors, [[0, 1], [1, 0]]);

    const call = fetch.calls[0];
    assert.equal(call.url, 'https://api.example.test/v1/embeddings');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, 'Bearer sk-test');
    assert.deepEqual(JSON.parse(call.body), {
        model: 'Qwen/Qwen3-Embedding-0.6B',
        input: ['第一条', '第二条'],
    });
    assert.equal(fetch.count(), 1);
});

test('成功：Gemini 端点走 batchEmbedContents，key 进 query', async () => {
    const fetch = createFetch([jsonResponse({ embeddings: [{ values: [0.5, 0.5] }] })]);
    const { instance } = client({ fetch, url: 'https://generativelanguage.googleapis.com', model: 'text-embedding-004' });

    const vectors = await instance.embedBatch(['一条']);
    assert.deepEqual(vectors, [[0.5, 0.5]]);
    assert.match(fetch.calls[0].url, /\/v1beta\/models\/text-embedding-004:batchEmbedContents\?key=sk-test$/);
    assert.deepEqual(JSON.parse(fetch.calls[0].body).requests[0].content.parts[0].text, '一条');
});

test('成功：probe() 记录维度并把客户端标成 ready', async () => {
    const fetch = createFetch([openAiBody([VECTOR_1024()])]);
    const { instance } = client({ fetch });
    assert.equal(instance.ready, false);
    assert.equal(await instance.probe(), 1024);
    assert.equal(instance.ready, true);
    assert.equal(instance.dimensions, 1024);
    assert.equal(instance.lastError, '');
});

// ─── 无配置 ──────────────────────────────────────────────────────────

test('无配置：configured 为 false，embedBatch / probe 直接抛错且一次请求都不发', async () => {
    const fetch = createFetch([]);
    const { instance } = client({ fetch, url: '' });
    assert.equal(instance.configured, false);
    await assert.rejects(() => instance.embedBatch(['x']), /未配置/);
    await assert.rejects(() => instance.probe(), /未配置/);
    assert.equal(fetch.count(), 0);

    const onlyModel = client({ fetch, url: '', model: 'Qwen/Qwen3-Embedding-0.6B' }).instance;
    assert.equal(onlyModel.configured, false, '只填模型名不算配置完成');
});

// ─── HTTP 错误 ───────────────────────────────────────────────────────

test('HTTP 4xx：不重试，错误里带状态码，lastError 留痕', async () => {
    const fetch = createFetch([jsonResponse({ error: 'bad key' }, { status: 401 })]);
    const { instance, timer } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['x']), /HTTP 401/);
    assert.equal(fetch.count(), 1, '4xx 属于不可重试错误');
    assert.deepEqual(timer.delays, []);
    assert.match(instance.lastError, /HTTP 401/);
});

test('HTTP 5xx：按 4 次上限重试，退避 1.2s → 2.4s → 4.8s（假时钟记录，不真的等）', async () => {
    const fetch = createFetch([jsonResponse('upstream boom', { status: 500 })]);
    const { instance, timer } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['x']), /HTTP 500/);
    assert.equal(fetch.count(), 4);
    assert.deepEqual(timer.delays, [1200, 2400, 4800]);
    assert.match(instance.lastError, /HTTP 500/);
});

test('HTTP 429：优先用 Retry-After（秒），上限 20s', async () => {
    const fetch = createFetch([jsonResponse('slow down', { status: 429, headers: { 'retry-after': '60' } })]);
    const { instance, timer } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['x']), /HTTP 429/);
    assert.equal(timer.delays[0], 20000, '60s 要被 maxDelay 夹到 20s');
    assert.equal(fetch.count(), 4);
});

test('HTTP 429：Retry-After 是绝对时间时按固定时钟换算', async () => {
    const DateImpl = fixedDate('2026-11-20T00:00:00.000Z');
    const retryAt = new Date(DateImpl.fixed + 5000).toUTCString();
    const fetch = createFetch([jsonResponse('slow down', { status: 429, headers: { 'retry-after': retryAt } })]);
    const { instance, timer } = client({ fetch, Date: DateImpl });
    await assert.rejects(() => instance.embedBatch(['x']), /HTTP 429/);
    assert.equal(timer.delays[0], 5000);
});

test('成功重试：5xx 之后拿到 200，最终返回向量且只算一次成功', async () => {
    const fetch = createFetch([
        jsonResponse('boom', { status: 503 }),
        openAiBody([[0, 1]]),
    ]);
    const { instance, timer } = client({ fetch });
    const vectors = await instance.embedBatch(['x']);
    assert.deepEqual(vectors, [[0, 1]]);
    assert.equal(fetch.count(), 2);
    assert.deepEqual(timer.delays, [1200]);
});

// ─── 超时 / 网络 ─────────────────────────────────────────────────────

test('超时：AbortSignal 超时立刻失败，不做无意义重试', async () => {
    const fetch = createFetch([() => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })]);
    const { instance, timer } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['x']), /超时/);
    assert.equal(fetch.count(), 1);
    assert.deepEqual(timer.delays, []);
});

test('网络不可达：包成 NETWORK 错误并可重试，最终仍抛错', async () => {
    const fetch = createFetch([() => new TypeError('fetch failed')]);
    const { instance, timer } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['x']), /网络不可达/);
    assert.equal(fetch.count(), 4);
    assert.equal(timer.delays.length, 3);
});

// ─── 返回体与维度 ────────────────────────────────────────────────────

test('返回条数不符：按失败处理，不会把错位的向量塞进去', async () => {
    const fetch = createFetch([openAiBody([[0, 1]])]);
    const { instance } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['a', 'b']), /返回条数不符/);
});

test('返回格式异常：缺 data 数组时报错而不是静默返回空', async () => {
    const fetch = createFetch([jsonResponse({ result: [] })]);
    const { instance } = client({ fetch });
    await assert.rejects(() => instance.embedBatch(['a']), /返回格式异常/);
});

test('维度不一致：端点返回 768 维时，索引层拒收，绝不把错维度写进向量库', async () => {
    const chat = [{ mes: '玄霜扇藏在木盒里面', is_user: false }, { mes: '玄霜扇到底放在哪里', is_user: true }];
    const wrongDim = jsonResponse({
        data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }],
    });
    const host = createHost({
        chat,
        settings: { embUrl: 'https://api.example.test/v1', embKey: 'sk-test' },
        fetch: createFetch([wrongDim, wrongDim]),
    });
    host.ghost([0]);

    host.hooks.syncEmbedderConfig(host.hooks.getSettings());
    assert.equal(host.client.configured, true, '配了端点后客户端才算就绪');
    const stored = await host.hooks.ensureVectors();
    assert.equal(stored, 0, '768 维向量一条都不该入库');
    assert.equal(host.idb.dump().length, 0);
});

test('维度一致（正向对照）：1024 维正常入库，同一 session 能看到记录', async () => {
    const chat = [{ mes: '玄霜扇藏在木盒里面', is_user: false }, { mes: '玄霜扇到底放在哪里', is_user: true }];
    const ok = jsonResponse({ data: [{ index: 0, embedding: VECTOR_1024() }] });
    const host = createHost({
        chat,
        settings: { embUrl: 'https://api.example.test/v1', embKey: 'sk-test' },
        fetch: createFetch([ok, ok]),
    });
    host.ghost([0]);

    const stored = await host.hooks.ensureVectors();
    assert.equal(stored, 1);
    const records = host.idb.dump();
    assert.equal(records.length, 1);
    assert.equal(records[0].vec.length, 1024);
    assert.equal(records[0].model, 'Qwen/Qwen3-Embedding-0.6B');
});
