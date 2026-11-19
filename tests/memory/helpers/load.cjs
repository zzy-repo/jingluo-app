'use strict';
/**
 * load.cjs — 把 src/services/memory/ 下的「块级浏览器脚本」在 Node 里跑起来。
 *
 * 为什么不能直接 require：
 *   仓库根 package.json 是 "type": "module"，所以 src/services/memory/*.js 会被当成 ESM，
 *   require() 拿到的是空对象（没有 recallSync），15 项旧回归在仓库内因此全红。
 *   这些文件本身是 `(function(){ ... module.exports = X })()` 的浏览器脚本，用 vm 执行、
 *   自己提供 window/module/exports 才是它们的真实运行形态（SillyTavern 里就是这样加载的）。
 *
 * window 语义：用一个 Proxy 转发到测试进程的 globalThis，
 *   - 测试里 `globalThis.SCEmbedding = {...}`    → 模块内 window.SCEmbedding 能读到
 *   - 测试里 `globalThis.window = { SCTimeAnchor }` → 模块内 window.SCTimeAnchor 读到覆盖值
 *   与浏览器里「模块共享同一个 window」的行为一致。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MEMORY_DIR = path.resolve(__dirname, '../../../src/services/memory');

const FILES = {
    recall: 'recall.js',
    vectorstore: 'vectorstore.js',
    embedding: 'embedding.js',
    timeanchor: 'timeanchor.js',
    index: 'index.js',
};

const VERBOSE = process.env.MEMORY_TEST_VERBOSE === '1';

const quietConsole = {
    log() {},
    info() {},
    warn() {},
    error(...args) { if (VERBOSE) console.error(...args); },
    debug() {},
};

/** 默认的时间函数：立即执行，不真的等。需要断言退避时间的用例自己注入记录版。 */
const immediateSetTimeout = (fn) => { fn(); return 0; };

function windowBridge() {
    return new Proxy({}, {
        get(_target, key) {
            const override = globalThis.window;
            if (override && typeof override === 'object' && key in override) return override[key];
            return globalThis[key];
        },
        set(_target, key, value) {
            const override = globalThis.window;
            if (override && typeof override === 'object') override[key] = value;
            else globalThis[key] = value;
            return true;
        },
        has(_target, key) {
            const override = globalThis.window;
            return Boolean(override && typeof override === 'object' && key in override) || key in globalThis;
        },
    });
}

/**
 * @param {string} name  FILES 里的键，或直接给文件名
 * @param {object} [opts]
 * @param {object} [opts.globals]      额外注入的全局（fetch / setTimeout / indexedDB / Date …）
 * @param {string} [opts.source]       直接给源码（index.js 抽取用）
 * @param {object} [opts.after]        执行完源码后再追加的脚本 { 名字: 函数 } —— 把内部函数挂到 hooks 上
 */
function loadModule(name, opts = {}) {
    const file = FILES[name] || name;
    const filePath = path.isAbsolute(file) ? file : path.resolve(MEMORY_DIR, file);
    const source = opts.source !== undefined ? opts.source : fs.readFileSync(filePath, 'utf8');
    const host = opts.globals || {};
    const moduleStub = { exports: {} };

    const sandbox = {
        module: moduleStub,
        exports: moduleStub.exports,
        window: windowBridge(),
        console: host.console || quietConsole,
        fetch: host.fetch,
        Date: host.Date || Date,
        AbortSignal: host.AbortSignal || { timeout: ms => ({ aborted: false, timeoutMs: ms }) },
        setTimeout: host.setTimeout || immediateSetTimeout,
        clearTimeout: host.clearTimeout || (() => {}),
        setInterval: host.setInterval || (() => 0),
        clearInterval: host.clearInterval || (() => {}),
        indexedDB: host.indexedDB,
        IDBKeyRange: host.IDBKeyRange,
        structuredClone: host.structuredClone || structuredClone,
        queueMicrotask,
    };
    if (typeof opts.after === 'function') {
        // 由调用方自行注入（拿到 sandbox 之后才追加脚本）
        opts.after = opts.after.bind(null, sandbox);
    }
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: filePath });
    if (typeof opts.after === 'function') opts.after(sandbox);

    const exports = moduleStub.exports;
    return {
        exports,
        sandbox,
        /** 在同一个上下文里再跑一段脚本，用来暴露内部函数 */
        expose(code) {
            vm.runInContext(code, sandbox, { filename: `${filePath}#expose` });
            return sandbox;
        },
    };
}

module.exports = { loadModule, MEMORY_DIR, FILES, quietConsole, immediateSetTimeout, windowBridge };
