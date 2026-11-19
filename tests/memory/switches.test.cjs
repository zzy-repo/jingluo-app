'use strict';
/**
 * 设置开关分组回归 —— 默认关闭、关闭时零外部请求
 *
 * 判据是「网络请求计数为 0」而不是「看起来没报错」：
 * 假 fetch 会记录每一次调用，用例里还配了正向对照，防止零请求断言变成空跑。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('./helpers/host.cjs');
const { createFetch, jsonResponse } = require('./helpers/fake-net.cjs');

const msg = (mes, is_user = false) => ({ mes, is_user });
const chat = () => [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)];

function host(overrides = {}, fetchImpl) {
    const instance = createHost({
        chat: chat(),
        settings: overrides,
        fetch: fetchImpl || createFetch([() => { throw new Error('这条用例不该发请求'); }]),
    });
    instance.ghost([0]);
    return instance;
}

test('默认关闭：默认配置里没有端点、没有 key，客户端不算就绪', () => {
    const instance = host();
    const defaults = instance.hooks.defaultSettings;
    assert.equal(defaults.embUrl, '', '默认端点为空 = 只用本地 BM25');
    assert.equal(defaults.embKey, '');
    assert.equal(defaults.recallEnabled, true, '召回层本身默认开着，但只走本地');

    instance.hooks.syncEmbedderConfig(instance.hooks.getSettings());
    assert.equal(instance.client.configured, false);
    assert.equal(instance.fetch.count(), 0);
});

test('关闭时零外部请求：发消息、刷新召回、补向量三条路径都不联网', async () => {
    const instance = host();
    await instance.hooks.onMessageSent();
    await instance.hooks.refreshRecall();
    assert.equal(await instance.hooks.ensureVectors(), 0);
    await instance.hooks.onChatChanged();

    assert.equal(instance.fetch.count(), 0, 'embedding 没配置时一次请求都不许发');
    assert.match(instance.answer.injected, /木盒/, '没有云端也要靠 BM25 把细节注回去');
});

test('关掉召回 / 预算为 0 时同样零请求，且不注入召回内容', async () => {
    const off = host({ recallEnabled: false });
    await off.hooks.onMessageSent();
    assert.equal(off.fetch.count(), 0);
    assert.doesNotMatch(off.answer.injected, /木盒/);

    const zeroBudget = host({ recallBudgetTokens: 0 });
    await zeroBudget.hooks.onMessageSent();
    assert.equal(zeroBudget.fetch.count(), 0);
    assert.doesNotMatch(zeroBudget.answer.injected, /木盒/);
});

test('正向对照：配上端点后确实会发请求（证明零请求断言不是空跑）', async () => {
    const response = jsonResponse({
        data: [{ index: 0, embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)) }],
    });
    const instance = host(
        { embUrl: 'https://api.example.test/v1', embKey: 'sk-test' },
        createFetch([response, response]),
    );

    assert.equal(await instance.hooks.ensureVectors(), 1);
    assert.ok(instance.fetch.count() > 0, '配置之后必须真的走网络，否则前面的零请求断言没有意义');
    assert.match(instance.fetch.calls[0].url, /\/embeddings$/);
});
