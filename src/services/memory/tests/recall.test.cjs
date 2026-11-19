const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const recall = require('../recall.js');
const vec = require('../vectorstore.js');

const msg = (mes, is_user = false) => ({ mes, is_user });
const settings = { recallBudgetTokens: 200, recallTopK: 3, recallWindowRadius: 3, recallQueryTurns: 1 };
const lexical = (chat, ghostedIndices, opts = {}) => recall.recallSync({ chat, store: { ghostedIndices }, settings: { ...settings, ...opts } });

test('Chinese budget keeps the hit instead of truncating an older neighbor', () => {
    const chat = [msg('旧'.repeat(1000)), msg('玄霜扇藏在木盒里面'), msg('玄霜扇在哪里', true)];
    const { text, stats } = lexical(chat, [0, 1]);
    assert.match(text, /玄霜扇藏在木盒里面/);
    assert.doesNotMatch(text, /旧/);
    assert.equal(stats.tokens, recall.estimateTokens(text));
    assert.ok(stats.tokens <= 200);
});

test('an oversized lower-ranked hit does not hide an affordable later hit', () => {
    const chat = [msg('玄霜扇玄霜扇藏在木盒里面'), msg(''), msg('玄霜扇在' + '旧'.repeat(200)),
        msg(''), msg('玄霜扇有一道裂纹'), msg('玄霜扇', true)];
    const { text, stats } = lexical(chat, [0, 2, 4], { recallBudgetTokens: 30 });
    assert.match(text, /木盒.*\n.*裂纹/s);
    assert.ok(stats.tokens <= 30);
});

test('a too-long top hit keeps the matching phrase near the end', () => {
    const { text, stats } = lexical([msg('旧'.repeat(800) + '玄霜扇在这里。'), msg('玄霜扇', true)], [0], { recallBudgetTokens: 35 });
    assert.match(text, /玄霜扇/);
    assert.ok(stats.tokens <= 35);
});

test('BM25 follows same-length chats and same-position edits', () => {
    const a = [msg('玄霜扇藏在木盒里面'), msg('玄霜扇', true)];
    const b = [msg('青木弓藏在石台下面'), msg('青木弓', true)];
    assert.match(lexical(a, [0]).text, /木盒/);
    assert.match(lexical(b, [0]).text, /石台/);
    b[0].mes = '白羽箭藏在石台下面';
    assert.equal(lexical(b, [0]).text, '');
});

function bridgeFixture(gap = 3) {
    const first = msg('玄霜扇玄霜扇玄霜扇在木匣');
    const second = msg('玄霜扇玄霜扇归账房');
    const evidence = msg('玄霜扇的暗号是朱砂');
    const filler = Array.from({ length: gap }, (_, i) => msg(`抄录封签序号：${i}`));
    const chat = [first, msg('这条消息仍然可见'), evidence, ...filler, second, msg('玄霜扇', true)];
    const ghosts = chat.map((_, i) => i).filter(i => i !== 1 && i < chat.length - 1);
    return { chat, ghosts, evidence, second };
}

test('a three-message bridge admits ranked evidence within the original block and coverage caps', t => {
    globalThis.window = { SCTimeAnchor: { ageLabel: age => `【旧事 ${age}】` } };
    t.after(() => { delete globalThis.window; });
    const { chat, ghosts, evidence, second } = bridgeFixture();
    const { text, stats } = lexical(chat, ghosts, { recallTopK: 2, recallTimeLabels: true });
    assert.equal(stats.bridged, 1);
    assert.equal(stats.ranges, 2);
    assert.equal(stats.covered, 6);
    assert.ok(text.includes([evidence.mes, ...chat.slice(3, 6).map(m => m.mes), second.mes].join('\n')));
    assert.equal(stats.tokens, recall.estimateTokens(text));
    assert.equal((text.match(/【旧事/g) || []).length, 2);
});

test('bridges cannot cross visible messages, exceed the radius, or exceed the coverage cap', () => {
    const { chat, ghosts, evidence } = bridgeFixture();
    for (const [ids, opts] of [
        [ghosts.filter(i => i !== 4), { recallTopK: 2 }],
        [ghosts, { recallTopK: 2, recallWindowRadius: 2 }],
        [ghosts, { recallTopK: 2, recallWindowRadius: 0 }],
        [ghosts.filter(i => i !== 0), { recallTopK: 1 }],
    ]) {
        const { text, stats } = lexical(chat, ids, opts);
        assert.equal(stats.bridged || 0, 0);
        assert.ok(!text.includes(evidence.mes));
        assert.ok(stats.covered <= opts.recallTopK * 3);
    }
});

test('an over-budget bridge does not consume coverage with a partial commit', t => {
    globalThis.window = { SCTimeAnchor: { ageLabel: () => '【旧事】' } };
    t.after(() => { delete globalThis.window; });
    const { chat, ghosts, evidence } = bridgeFixture();
    const opts = { recallTopK: 2, recallTimeLabels: true };
    const full = lexical(chat, ghosts, opts);
    const limited = lexical(chat, ghosts, { ...opts, recallBudgetTokens: full.stats.tokens - 1 });
    assert.equal(full.stats.bridged, 1);
    assert.equal(limited.stats.bridged || 0, 0);
    assert.ok(!limited.text.includes(evidence.mes));
    assert.ok(limited.stats.tokens < full.stats.tokens);
    assert.equal(limited.stats.tokens, recall.estimateTokens(limited.text));
});

test('only the first eligible gap is bridged per recall', () => {
    const chat = [msg('玄霜扇玄霜扇玄霜扇在木匣'), msg('这条消息仍然可见'),
        msg('玄霜扇的暗号是朱砂'), msg('先把签子递过来'), msg('玄霜扇玄霜扇归账房'),
        msg('侧门已经关上了'), msg('玄霜扇封存经手表放在最底层的抽屉里'), msg('玄霜扇', true)];
    const { text, stats } = lexical(chat, [0, 2, 3, 4, 5, 6], { recallTopK: 2, recallWindowRadius: 1 });
    assert.equal(stats.bridged, 1);
    assert.match(text, /暗号是朱砂/);
    assert.doesNotMatch(text, /封存经手表/);
});

test('vector scoring rejects mismatched dimensions', () => {
    assert.equal(vec.cosine([1, 0], [1, 0, 1]), 0);
    assert.equal(vec.cosine([1, 0], [1, 0]), 1);
});

// Evaluate the production entry's functions against a stub host, without running its DOM initialization.
function createHost(timers = { setTimeout, clearTimeout }) {
    const file = path.join(__dirname, '../index.js');
    const source = fs.readFileSync(file, 'utf8')
        .replace(/^import '[^']+';\n/gm, '')
        .replace(/import \{[\s\S]+?\} from '\.\/connectionutil\.js';/, '')
        .split('(async function init() {')[0];
    const vector1024 = Array(1024).fill(0);
    vector1024[0] = 1;
    const configurations = [];
    const vectorWrites = [];
    const answer = { pending: null, queryCalls: 0, injected: '', records: new Map() };
    const client = {
        configured: true,
        configure: config => configurations.push(config),
        // #397：embedBatch 改成 { ok, vectors, reason } —— 失败不再抛错
        embedBatch: async texts => ({ ok: true, vectors: texts.map(() => vector1024), reason: '' }),
    };
    const host = {
        characterId: 'npc', chatId: 'A', chat: [], chatMetadata: {}, setExtensionPrompt: (_, text) => { answer.injected = text; },
        extensionSettings: { summaryception: { recallWindowRadius: 2, embModel: 'old-model', embUrl: 'https://example.test/v1' } },
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, ...timers, structuredClone,
        SillyTavern: { getContext: () => host },
        SCRecall: { ...recall, recallAsync: options => {
            answer.queryCalls++;
            answer.pending.started = options;
            answer.pending.entered?.resolve();
            return answer.pending.promise;
        } },
        SCEmbedding: { client },
        SCVectorStore: {
            loadAll: async () => answer.records,
            putMany: async (...args) => vectorWrites.push(args),
        },
    });
    context.window = context;
    vm.runInContext(`${source}\n globalThis.hooks = { getSettings, getChatStore, refreshRecall, onMessageSent, ensureVectors, clearRecallCache };`, context, { filename: file });
    const { hooks } = context;
    const switchTo = (id, messages) => {
        host.chatId = id;
        host.chat = messages;
        host.chatMetadata = {};
        hooks.getChatStore().ghostedIndices = [0, 1];
    };
    return { answer, host, hooks, switchTo, vector1024, configurations, vectorWrites };
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

const namespace = JSON.stringify(['https://example.test/v1', 'Qwen/Qwen3-Embedding-0.6B', 1024]);

test('new question injects current BM25 immediately; late result is discarded', async () => {
    const { hooks, answer, host, switchTo, vector1024 } = createHost();
    const facts = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面')];
    switchTo('A', [...facts, msg('玄霜扇', true)]);
    answer.records.set(0, { namespace, text: facts[0].mes, vec: vector1024 });
    answer.pending = { ...deferred(), entered: deferred() };
    const first = hooks.onMessageSent();
    assert.match(answer.injected, /木盒/);
    await answer.pending.entered.promise;
    assert.equal(answer.queryCalls, 1);
    host.chat[2].mes = '青木弓';
    const second = hooks.onMessageSent();
    assert.match(answer.injected, /石台/);
    answer.pending.resolve({ text: '已过期的云端结果', stats: {} });
    await Promise.all([first, second]);
    assert.doesNotMatch(answer.injected, /已过期/);
});

test('same-query cloud results are adopted, but never appear in another chat', async () => {
    const { hooks, answer, switchTo, vector1024 } = createHost();
    const facts = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面')];
    switchTo('A', [...facts, msg('玄霜扇', true)]);
    answer.records.set(0, { namespace, text: facts[0].mes, vec: vector1024 });
    answer.pending = deferred();
    const first = hooks.onMessageSent();
    answer.pending.resolve({ text: '当轮云端召回', stats: { mode: 'hybrid' } });
    await first;
    assert.match(answer.injected, /当轮云端召回/);
    switchTo('B', [msg('紫铜镜藏在地板下面'), msg('青木弓藏在石台下面'), msg('紫铜镜', true)]);
    await hooks.onMessageSent();
    assert.equal(answer.queryCalls, 1);
    assert.doesNotMatch(answer.injected, /当轮云端召回/);
    assert.match(answer.injected, /地板/);
});

test('old embeddings do not trigger hybrid; reindex uses only 0.6B', async () => {
    const { hooks, answer, switchTo, configurations, vectorWrites } = createHost();
    const facts = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面')];
    switchTo('A', [...facts, msg('玄霜扇', true)]);
    answer.records.set(0, { text: facts[0].mes, vec: Array(4096).fill(1) });
    await hooks.onMessageSent();
    assert.equal(answer.queryCalls, 0);
    assert.equal(hooks.getSettings().recallWindowRadius, 3);
    assert.equal(await hooks.ensureVectors(), 2);
    assert.ok(configurations.every(c => c.model === 'Qwen/Qwen3-Embedding-0.6B'));
    assert.equal(vectorWrites[0][3], 1024);
    assert.equal(vectorWrites[0][4], namespace);
});


test('a slow embedding cannot block the send hook beyond its wait budget', async () => {
    let releaseTimer;
    let waitMs;
    const timers = { setTimeout: (fn, ms) => { releaseTimer = fn; waitMs = ms; }, clearTimeout() {} };
    const { hooks, answer, switchTo, vector1024 } = createHost(timers);
    const facts = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面')];
    switchTo('A', [...facts, msg('玄霜扇', true)]);
    answer.records.set(0, { namespace, text: facts[0].mes, vec: vector1024 });
    answer.pending = { ...deferred(), entered: deferred() };
    const send = hooks.onMessageSent();
    await answer.pending.entered.promise;
    const cloud = hooks.refreshRecall();
    assert.equal(waitMs, 250);
    releaseTimer();
    await send;
    assert.match(answer.injected, /木盒/);
    answer.pending.resolve({ text: '同一查询稍后返回的向量召回', stats: { mode: 'hybrid' } });
    await cloud;
});

test('hybrid rejects stale hits and keeps lexical fallback for the current query', async t => {
    const chat = [msg('玄霜扇藏在木盒里面'), msg('不可召回的一条可见消息'), msg('玄霜扇', true)];
    const store = { ghostedIndices: [0] };
    t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected real network'); });
    globalThis.window = {
        SCEmbedding: { client: { configured: true, embedBatch: async () => ({ ok: true, vectors: [[1]], reason: '' }) } },
        SCVectorStore: { search: async (_key, _query, { allowed }) => {
            assert.deepEqual([...allowed], [0]);
            return [{ idx: 1, similarity: 1 }, { idx: 0, similarity: 0.99, text: '之前版本的原文' }];
        } },
    };
    t.after(() => { delete globalThis.window; });
    const result = await recall.recallAsync({ chat, store, settings, chatKey: 'test',
        vectorOptions: { expectedTexts: new Map([[0, chat[0].mes]]) } });
    assert.equal(result.stats.mode, 'lexical');
    assert.equal(result.stats.fallbackReason, 'no-valid-vectors');
    assert.equal(result.text, lexical(chat, [0]).text);
});

test('the budget includes time labels and separators', t => {
    globalThis.window = { SCTimeAnchor: { ageLabel: () => '【此为旧事】' } };
    t.after(() => { delete globalThis.window; });
    const chat = [msg('玄霜扇在那个木盒里'), msg('不可召回的消息'), msg('玄霜扇昨天已经失窃'), msg('玄霜扇', true)];
    const { text, stats } = lexical(chat, [0, 2], { recallBudgetTokens: 22, recallTimeLabels: true });
    assert.equal(stats.tokens, recall.estimateTokens(text));
    assert.equal(stats.hits, 1);
    assert.match(text, /【此为旧事】/);
    assert.ok(stats.tokens <= 22);
});
