'use strict';
/**
 * fake-net.cjs — 假网络与假时间。
 *
 * 规则（Issue #400 关闭条件 3）：memory 回归不依赖网络、不依赖真实时钟。
 *   - createFetch(): 脚本化的假 fetch，记录每一次请求；用 respond() 决定下一次返回。
 *   - createTimer(): 假 setTimeout，不真的等，只记录请求的延迟（退避序列可断言）。
 *   - fixedDate():  固定 now() 的 Date 替身（retry-after 绝对时间要靠它才稳定）。
 * 任何用例都不许 `sleep`，也不许落到真 fetch 上：本文件导出的 assertNoNetwork 会兜底。
 */

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => lower.get(String(name).toLowerCase()) ?? null },
        async json() { return body; },
        async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
}

function textResponse(text, opts = {}) {
    return jsonResponse(text, opts);
}

/**
 * @param {Array<object|Error|(() => object)>} [script] 依次消费；用完后返回 script 的最后一项
 */
function createFetch(script = []) {
    const calls = [];
    let index = 0;
    const fetch = async (url, init = {}) => {
        calls.push({
            url: String(url),
            method: init.method || 'GET',
            headers: { ...(init.headers || {}) },
            body: init.body,
            signal: init.signal,
        });
        const step = script[Math.min(index, script.length - 1)];
        index++;
        if (step === undefined) throw new Error(`fake fetch 没有排到第 ${index} 次响应：${url}`);
        const value = typeof step === 'function' ? step(calls[calls.length - 1], index) : step;
        if (value instanceof Error) throw value;
        return value;
    };
    fetch.calls = calls;
    fetch.count = () => calls.length;
    fetch.reset = () => { calls.length = 0; index = 0; };
    return fetch;
}

/** 真网络兜底：任何用例里出现真 fetch 调用都直接炸掉，而不是悄悄联网。 */
function forbidRealNetwork() {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args) => {
        calls++;
        throw new Error(`memory 回归禁止真实网络请求：${String(args[0])}`);
    };
    return {
        get calls() { return calls; },
        restore() { if (original === undefined) delete globalThis.fetch; else globalThis.fetch = original; },
    };
}

/**
 * 假 setTimeout：同步执行回调，并把请求的延迟记进 delays。
 * embedding.js 的 sleep(ms) 因此变成「记录 + 立即 resolve」，退避链路可以确定性地断言。
 */
function createTimer() {
    const delays = [];
    const timer = {
        delays,
        setTimeout(fn, ms = 0) { delays.push(ms); fn(); return delays.length; },
        clearTimeout() {},
        total: () => delays.reduce((a, b) => a + b, 0),
    };
    return timer;
}

/** 固定 now() 的 Date 替身；now() 不变，测试就不受机器时间影响。 */
function fixedDate(iso = '2026-11-20T00:00:00.000Z') {
    const fixed = new Date(iso).getTime();
    class FixedDate extends Date {
        constructor(...args) {
            if (args.length === 0) super(fixed);
            else super(...args);
        }
        static now() { return fixed; }
    }
    FixedDate.fixed = fixed;
    return FixedDate;
}

module.exports = { createFetch, forbidRealNetwork, createTimer, fixedDate, jsonResponse, textResponse };
