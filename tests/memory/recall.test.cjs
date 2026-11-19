'use strict';
/**
 * 召回分组回归 —— BM25 / 向量 / 混合 / RRF 融合 / 预算打包 / 短缝桥接 / 分段滚动
 *
 * 全部离线：embedding 与向量库都是注入的假件（不发请求），时间不参与判断。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./helpers/load.cjs');
const { createHost } = require('./helpers/host.cjs');
const { createFetch } = require('./helpers/fake-net.cjs');

const msg = (mes, is_user = false) => ({ mes, is_user });

const settings = {
    recallBudgetTokens: 200, recallTopK: 3, recallWindowRadius: 3, recallQueryTurns: 3,
    recallMinScore: 0.15, recallWeightVector: 0.7, recallWeightLexical: 0.3,
    recallRrfK: 60, recallHalfLife: 0,
};

/** 每个用例一份干净的模块实例：recall.js 内部有跨调用的 BM25 索引缓存。 */
function fresh() {
    return loadModule('recall').exports;
}

function withVectorModules({ embed, search }, run) {
    const previous = { embedding: globalThis.SCEmbedding, store: globalThis.SCVectorStore };
    globalThis.SCEmbedding = { client: { configured: true, embedBatch: embed } };
    globalThis.SCVectorStore = { search };
    return Promise.resolve()
        .then(run)
        .finally(() => {
            if (previous.embedding === undefined) delete globalThis.SCEmbedding;
            else globalThis.SCEmbedding = previous.embedding;
            if (previous.store === undefined) delete globalThis.SCVectorStore;
            else globalThis.SCVectorStore = previous.store;
        });
}

// ─── BM25 ────────────────────────────────────────────────────────────

test('BM25 只注入与查询有词面交集的那条被压缩消息', () => {
    const recall = fresh();
    const chat = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面'), msg('玄霜扇到底放在哪里', true)];
    const { text, stats } = recall.recallSync({
        chat, store: { ghostedIndices: [0, 1] }, settings: { ...settings, recallWindowRadius: 0 },
    });
    assert.equal(stats.mode, 'lexical');
    assert.equal(stats.hits, 1);
    assert.match(text, /木盒/);
    assert.doesNotMatch(text, /石台/);
    assert.equal(stats.tokens, recall.estimateTokens(text));
    assert.ok(stats.tokens <= settings.recallBudgetTokens);
});

test('BM25 阈值以下不注入，且空查询直接放弃', () => {
    const recall = fresh();
    const chat = [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)];
    const below = recall.recallSync({
        chat, store: { ghostedIndices: [0] }, settings: { ...settings, recallMinScore: 2 },
    });
    assert.equal(below.text, '');
    assert.equal(below.stats.reason, 'below-threshold');

    const noQuery = recall.recallSync({
        chat: [msg('玄霜扇藏在木盒里面'), msg('嗯', true)], store: { ghostedIndices: [0] }, settings,
    });
    assert.equal(noQuery.text, '');
    assert.ok(['empty-query', 'no-candidates', 'no-overlap'].includes(noQuery.stats.reason));
});

test('候选池只看已压缩消息：可见消息永远不会被召回', () => {
    const recall = fresh();
    const chat = [msg('玄霜扇藏在木盒里面'), msg('玄霜扇也在抽屉里'), msg('玄霜扇到底放在哪里', true)];
    const { text, stats } = recall.recallSync({
        chat, store: { ghostedIndices: [0] }, settings,
    });
    assert.equal(stats.candidates, 1);
    assert.match(text, /木盒/);
    assert.doesNotMatch(text, /抽屉/);
});

// ─── 预算打包 ────────────────────────────────────────────────────────

test('预算打包：命中的证据优先，装不下的邻居不挤掉更便宜的命中', () => {
    const recall = fresh();
    const chat = [
        msg('玄霜扇玄霜扇藏在木盒里面'),
        msg(''),
        msg('玄霜扇在' + '旧'.repeat(200)),
        msg(''),
        msg('玄霜扇有一道裂纹'),
        msg('玄霜扇到底放在哪里', true),
    ];
    const { text, stats } = recall.recallSync({
        chat, store: { ghostedIndices: [0, 2, 4] }, settings: { ...settings, recallBudgetTokens: 30, recallTopK: 3 },
    });
    assert.match(text, /木盒/);
    assert.match(text, /裂纹/);
    assert.ok(stats.tokens <= 30);
    assert.equal(stats.tokens, recall.estimateTokens(text));
});

test('预算打包：超长命中截成聚焦片段，仍然保住关键词', () => {
    const recall = fresh();
    const chat = [msg('旧'.repeat(800) + '玄霜扇在这里。'), msg('玄霜扇到底放在哪里', true)];
    const { text, stats } = recall.recallSync({
        chat, store: { ghostedIndices: [0] }, settings: { ...settings, recallBudgetTokens: 35 },
    });
    assert.match(text, /玄霜扇/);
    assert.ok(stats.tokens <= 35);
    assert.equal(stats.excerpts, 1);
});

// ─── 向量 / 混合 / RRF ───────────────────────────────────────────────

test('向量召回：向量库命中直接进注入，命名空间与候选池过滤都透传下去', async () => {
    const recall = fresh();
    const chat = [msg('玄霜扇藏在木盒里面'), msg('青木弓藏在石台下面'), msg('今天天气不错啊'), msg('玄霜扇到底放在哪里', true)];
    const embedCalls = [];
    const searchCalls = [];
    await withVectorModules({
        embed: async texts => { embedCalls.push(texts); return [[1, 0, 0]]; },
        search: async (chatKey, queryVec, options) => {
            searchCalls.push({ chatKey, queryVec, options });
            return [{ idx: 0, similarity: 0.9 }];
        },
    }, async () => {
        const { text, stats } = await recall.recallAsync({
            chat, store: { ghostedIndices: [0, 1] }, settings,
            chatKey: 'npc::chat-A', vectorOptions: { namespace: 'ns-A' },
        });
        assert.equal(stats.mode, 'hybrid');
        assert.equal(stats.vecCount, 1);
        assert.match(text, /木盒/);
        assert.equal(embedCalls.length, 1);
        assert.equal(searchCalls[0].chatKey, 'npc::chat-A');
        assert.equal(searchCalls[0].options.namespace, 'ns-A');
        assert.deepEqual([...searchCalls[0].options.allowed].sort(), [0, 1]);
    });
});

test('混合打分：双路一致命中的点排在最前，只有向量命中的点也能进', async () => {
    const recall = fresh();
    const chat = [
        msg('青木弓藏在石台下面'),          // 只被向量命中
        msg('玄霜扇藏在木盒里面'),          // 向量 + 词面都命中
        msg('玄霜扇到底放在哪里', true),
    ];
    await withVectorModules({
        embed: async () => [[0, 1]],
        search: async () => [{ idx: 0, similarity: 0.99 }, { idx: 1, similarity: 0.5 }],
    }, async () => {
        const { text, stats } = await recall.recallAsync({
            chat, store: { ghostedIndices: [0, 1] }, settings, chatKey: 'k',
        });
        assert.equal(stats.mode, 'hybrid');
        assert.equal(stats.consensus, 1, '词面 + 向量同时命中的点必须被记成一致命中');
        assert.equal(stats.vecCount, 2);
        assert.match(text, /木盒/);
        assert.match(text, /石台/, '只有向量命中的点不能被丢掉');
    });
});

test('混合降级：embedding 失败 / 向量全被过滤都退回 BM25，不抛错', async () => {
    const recall = fresh();
    const chat = [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)];
    const store = { ghostedIndices: [0] };

    await withVectorModules({
        embed: async () => { throw new Error('HTTP 500'); },
        search: async () => [],
    }, async () => {
        const failed = await recall.recallAsync({ chat, store, settings, chatKey: 'k' });
        assert.equal(failed.stats.mode, 'lexical');
        assert.equal(failed.stats.fallbackReason, 'embedding-failed');
        assert.match(failed.text, /木盒/);
    });

    await withVectorModules({
        embed: async () => [[1, 0]],
        search: async () => [{ idx: 0, similarity: 0, text: chat[0].mes }, { idx: 7, similarity: 0.9 }],
    }, async () => {
        const filtered = await recall.recallAsync({ chat, store, settings, chatKey: 'k' });
        assert.equal(filtered.stats.mode, 'lexical');
        assert.equal(filtered.stats.fallbackReason, 'no-valid-vectors');
    });
});

test('RRF 融合只吃名次：分数与量纲无关，权重为 0 的通道不参与', () => {
    const recall = fresh();
    const fused = recall.rrfFuse([
        { idxs: [5, 6], weight: 1 },
        { idxs: [6, 5], weight: 1 },
        { idxs: [9], weight: 0 },
    ], 60);
    // 5 在通道一 rank1 → 1/61，在通道二 rank2 → 1/62
    assert.ok(Math.abs(fused.get(5) - (1 / 61 + 1 / 62)) < 1e-12);
    assert.ok(Math.abs(fused.get(6) - (1 / 62 + 1 / 61)) < 1e-12);
    assert.equal(fused.has(9), false);

    const single = recall.rrfFuse([{ idxs: [1], weight: 1 }], 1);
    assert.equal(single.get(1), 1 / 2);
});

// ─── 短缝桥接 ────────────────────────────────────────────────────────

function bridgeFixture(gap = 3) {
    const first = msg('玄霜扇玄霜扇玄霜扇在木匣');
    const second = msg('玄霜扇玄霜扇归账房');
    const evidence = msg('玄霜扇的暗号是朱砂');
    const filler = Array.from({ length: gap }, (_, i) => msg(`抄录封签序号：${i}`));
    const chat = [first, msg('这条消息仍然可见'), evidence, ...filler, second, msg('玄霜扇到底放在哪里', true)];
    const ghosts = chat.map((_, i) => i).filter(i => i !== 1 && i < chat.length - 1);
    return { chat, ghosts, evidence, second };
}

test('短缝桥接：夹在两条命中之间的证据能被补进来，且不会跨过可见消息', t => {
    const recall = fresh();
    globalThis.window = { SCTimeAnchor: { ageLabel: age => `【旧事 ${age}】` } };
    t.after(() => { delete globalThis.window; });
    const { chat, ghosts, evidence } = bridgeFixture();
    const { text, stats } = recall.recallSync({
        chat, store: { ghostedIndices: ghosts }, settings: { ...settings, recallTopK: 2, recallTimeLabels: true },
    });
    assert.equal(stats.bridged, 1);
    assert.ok(text.includes(evidence.mes), '桥接必须把缺口里的证据带进来');

    const narrower = recall.recallSync({
        chat, store: { ghostedIndices: ghosts }, settings: { ...settings, recallTopK: 1 },
    });
    assert.equal(narrower.stats.bridged || 0, 0);
    assert.ok(!narrower.text.includes(evidence.mes));
    assert.ok(narrower.stats.covered <= 3);
});

// ─── 分段滚动（index.js 的窗口推进规则） ────────────────────────────

function windowHost(settingsOverride, chat) {
    const host = createHost({
        chat,
        settings: { recallEnabled: false, ...settingsOverride },
        fetch: createFetch([() => { throw new Error('分段滚动用例不该联网'); }]),
        // 用桩函数替掉真正会调 LLM 的 summarizeOneBatch：只记录被推进了几批，
        // 并按真实行为把这几条消息标成已压缩，否则 maybeSummarizeTurns 会一直认为还有积压。
        patch: source => `${source}
const __batches = [];
globalThis.__batches = __batches;
const __batchHook = async (turns) => {
    __batches.push(turns.length);
    for (const turn of turns.slice(0, 3)) {
        const target = SillyTavern.getContext().chat[turn.index];
        if (target) target.extra = { ...(target.extra || {}), sc_ghosted: true };
    }
    return true;
};
`.replace('const success = await summarizeOneBatch(visibleTurns);', 'const success = await __batchHook(visibleTurns);'),
    });
    return host;
}

const assistantTurns = count => Array.from({ length: count }, (_, i) => msg(`第 ${i} 条助手消息，内容够长`));

test('分段滚动：可见轮数在「保留 + 段长」之内不动，超出才整段推进一批', async () => {
    const host = windowHost({ verbatimTurns: 10, summarySegmentTurns: 10, turnsPerSummary: 3 }, assistantTurns(20));
    await host.hooks.maybeSummarizeTurns();
    assert.equal(host.context.__batches.length, 0, '20 轮 == 保留 10 + 段长 10，不该触发');

    const hostOver = windowHost({ verbatimTurns: 10, summarySegmentTurns: 10, turnsPerSummary: 3 }, assistantTurns(21));
    await hostOver.hooks.maybeSummarizeTurns();
    assert.equal(hostOver.context.__batches.length, 1, '超出上限必须恰好推进一批');
    assert.equal(hostOver.context.__batches[0], 21);

    const hostSegment = windowHost({ verbatimTurns: 5, summarySegmentTurns: 10, turnsPerSummary: 3 }, assistantTurns(16));
    await hostSegment.hooks.maybeSummarizeTurns();
    assert.equal(hostSegment.context.__batches.length, 1, '段长取 summarySegmentTurns 而不是 verbatimTurns');
});

test('分段滚动：关掉开关或暂停时不推进', async () => {
    const disabled = windowHost({ enabled: false, verbatimTurns: 5, summarySegmentTurns: 5 }, assistantTurns(40));
    await disabled.hooks.maybeSummarizeTurns();
    assert.equal(disabled.context.__batches.length, 0);

    const paused = windowHost({ pauseSummarization: true, verbatimTurns: 5, summarySegmentTurns: 5 }, assistantTurns(40));
    await paused.hooks.maybeSummarizeTurns();
    assert.equal(paused.context.__batches.length, 0);
});
