'use strict';
/**
 * 存储分组回归 —— 会话间隔离、删会话清理、超限淘汰（现状）
 *
 * 真模块 + 内存版 IndexedDB + 假宿主：验证的是「换会话不会串」这条真实链路。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('./helpers/host.cjs');
const { createFetch } = require('./helpers/fake-net.cjs');

const msg = (mes, is_user = false) => ({ mes, is_user });
const vec1024 = () => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const offline = () => createFetch([() => { throw new Error('存储用例不该联网'); }]);

test('会话隔离：两个会话的压缩状态与向量互不干扰', async () => {
    const host = createHost({
        chat: [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)],
        fetch: offline(),
    });
    const storeA = host.switchTo('chat-A', [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)]);
    storeA.ghostedIndices = [0];
    const keyA = host.hooks.getChatKey();

    const storeB = host.switchTo('chat-B', [msg('紫铜镜藏在地板下面'), msg('紫铜镜到底放在哪里', true)]);
    storeB.ghostedIndices = [0];
    const keyB = host.hooks.getChatKey();

    assert.notEqual(keyA, keyB, '会话 key 必须区分（换存档就换 key）');

    await host.vstore.putMany(keyA, [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec1024() }], 'm', 1024, 'ns');
    await host.vstore.putMany(keyB, [{ idx: 0, text: '紫铜镜藏在地板下面', vec: vec1024() }], 'm', 1024, 'ns');

    const bucketA = await host.vstore.loadAll(keyA);
    const bucketB = await host.vstore.loadAll(keyB);
    assert.equal(bucketA.size, 1);
    assert.equal(bucketB.size, 1);
    assert.match(bucketA.get(0).text, /木盒/);
    assert.match(bucketB.get(0).text, /地板/);

    // A 的召回内容不能出现在 B 的上下文里
    const textB = host.hooks.buildRecallText(host.hostContext.chat, host.hooks.getChatStore(), host.hooks.getSettings());
    assert.doesNotMatch(textB, /木盒/);
    assert.match(textB, /地板/);
});

test('删会话清理：清掉一个会话的向量不会连带清掉别的会话', async () => {
    const host = createHost({ chat: [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)], fetch: offline() });
    host.switchTo('chat-A', [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)]);
    const keyA = host.hooks.getChatKey();
    host.switchTo('chat-B', [msg('紫铜镜藏在地板下面'), msg('紫铜镜到底放在哪里', true)]);
    const keyB = host.hooks.getChatKey();

    await host.vstore.putMany(keyA, [{ idx: 0, text: '玄霜扇藏在木盒里面', vec: vec1024() }], 'm', 1024, 'ns');
    await host.vstore.putMany(keyB, [{ idx: 0, text: '紫铜镜藏在地板下面', vec: vec1024() }], 'm', 1024, 'ns');

    const removed = await host.vstore.clearChat(keyA);
    assert.equal(removed, 1);
    assert.equal((await host.vstore.loadAll(keyA)).size, 0);
    assert.equal((await host.vstore.loadAll(keyB)).size, 1, '删 A 不能波及 B');
    assert.equal(host.idb.dump().length, 1, '落盘的记录也要跟着少一条');
});

test('超限淘汰：当前实现没有条数上限（缺口，登记在此）', { todo: '未实现：vectorstore 无 per-chat 上限与淘汰策略，接线（#399）落地后补真实断言' }, async () => {
    const host = createHost({ chat: [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)], fetch: offline() });
    host.switchTo('chat-A', [msg('玄霜扇藏在木盒里面'), msg('玄霜扇到底放在哪里', true)]);
    const key = host.hooks.getChatKey();

    const rows = Array.from({ length: 500 }, (_, i) => ({ idx: i, text: `第 ${i} 条原文，内容够长`, vec: vec1024() }));
    await host.vstore.putMany(key, rows, 'm', 1024, 'ns');
    const bucket = await host.vstore.loadAll(key);

    // 这里断言的是「现状没有上限」：一旦 #399 加上淘汰策略，这条 todo 就该改成真实上限断言。
    assert.ok(bucket.size <= 500, '当前实现不会淘汰，500 条全部保留');
    assert.equal(bucket.size, 500);
});
