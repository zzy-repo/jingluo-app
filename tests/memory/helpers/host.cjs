'use strict';
/**
 * host.cjs — 用真模块 + 假宿主把 index.js（SillyTavern 扩展入口）跑起来。
 *
 * 做法沿用仓库里已有的约定（src/services/memory/tests/recall.test.cjs 的 createHost）：
 * 只执行 index.js 里 init() 之前的函数定义，跳过 DOM 初始化，然后把它内部函数挂出来。
 *
 * 这里连的是**真模块**：
 *   recall.js / vectorstore.js / embedding.js 都通过 load.cjs 在 vm 里加载，
 *   只有 fetch、indexedDB、setTimeout、Date 这些外部边界是假的 —— 所以断言的是真实调用链。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MEMORY_DIR, loadModule, quietConsole } = require('./load.cjs');
const { createFetch, createTimer, fixedDate } = require('./fake-net.cjs');
const { createIndexedDB, IDBKeyRange } = require('./fake-idb.cjs');

const EXPOSED = ['getSettings', 'getChatStore', 'getChatKey', 'defaultSettings', 'embeddingNamespace',
    'syncEmbedderConfig', 'refreshRecall', 'onMessageSent', 'onChatChanged', 'ensureVectors',
    'clearRecallCache', 'buildRecallText', 'maybeSummarizeTurns', 'updateInjection',
    'buildInjectionBlocks', 'getVisibleAssistantTurns', 'vectorInput', 'recallCacheKey', 'TUNING'];

function indexSource(patch) {
    let source = fs.readFileSync(path.join(MEMORY_DIR, 'index.js'), 'utf8')
        .replace(/^import '[^']+';\n/gm, '')
        .replace(/import \{[\s\S]+?\} from '\.\/connectionutil\.js';/, '')
        .split('(async function init() {')[0];
    if (patch) source = patch(source);
    return source;
}

/**
 * @param {object} [options]
 * @param {string} [options.chatId]
 * @param {Array}  [options.chat]
 * @param {object} [options.settings]      覆盖 defaultSettings 的字段
 * @param {object} [options.fetch]         假 fetch（默认为「谁调用谁炸」的记录版）
 * @param {object} [options.timer]         假 setTimeout（默认同步执行）
 * @param {object} [options.idb]           假 IndexedDB
 * @param {Function} [options.patch]       对 index.js 源码做替换（用于注入桩函数）
 */
function createHost(options = {}) {
    const timer = options.timer || createTimer();
    const fetchImpl = options.fetch || createFetch([() => { throw new Error('memory 回归不允许意外联网'); }]);
    const idb = options.idb || createIndexedDB();
    const DateImpl = options.Date || fixedDate();

    const embedding = loadModule('embedding', {
        globals: { fetch: fetchImpl, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, Date: DateImpl },
    });
    const vectorstore = loadModule('vectorstore', { globals: { indexedDB: idb, IDBKeyRange, Date: DateImpl } });
    const recallModule = loadModule('recall', { globals: { Date: DateImpl } });
    loadModule('timeanchor', { globals: { Date: DateImpl } });

    const answer = { injected: '', promptCalls: 0, records: new Map(), vectorWrites: [] };
    const hostContext = {
        characterId: options.characterId || 'npc',
        chatId: options.chatId || 'chat-A',
        chat: options.chat || [],
        chatMetadata: {},
        extensionSettings: { summaryception: { ...(options.settings || {}) } },
        setExtensionPrompt(_name, text) { answer.promptCalls++; answer.injected = text; },
        async saveMetadata() {},
    };

    const context = {
        console: quietConsole,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        structuredClone,
        Date: DateImpl,
        SillyTavern: { getContext: () => hostContext },
        SCRecall: recallModule.exports,
        SCEmbedding: { client: embedding.exports.client },
        SCVectorStore: vectorstore.exports,
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);

    const expose = EXPOSED.map(name => `${name}: typeof ${name} === 'function' ? ${name} : ${name}`).join(',\n        ');
    const tail = `\n globalThis.hooks = {\n        ${expose},\n        stats: () => _lastRecallStats,\n        reset: () => { clearRecallCache(); },\n    };`;
    const source = indexSource(options.patch) + tail;
    vm.runInContext(source, context, { filename: path.join(MEMORY_DIR, 'index.js') });

    const { hooks } = context;

    const switchTo = (chatId, chat) => {
        hostContext.chatId = chatId;
        hostContext.chat = chat;
        hostContext.chatMetadata = {};
        hooks.clearRecallCache();
        return hooks.getChatStore();
    };

    return {
        answer, context, hooks, hostContext, switchTo,
        modules: { embedding: embedding.exports, vectorstore: vectorstore.exports, recall: recallModule.exports },
        client: embedding.exports.client,
        vstore: vectorstore.exports,
        idb, timer, fetch: fetchImpl,
        /** 设置字段（模拟设置页改动） */
        set: patch => Object.assign(hostContext.extensionSettings.summaryception, patch),
        ghost: indices => { hooks.getChatStore().ghostedIndices = [...indices]; },
    };
}

module.exports = { createHost, indexSource, EXPOSED };
