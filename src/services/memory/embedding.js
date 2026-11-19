/**
 * embedding.js — 窗口记忆的 embedding 客户端（v2：请求收进 app 的 API 层，#397）
 *
 * 改造前（PR #396 原型）：本文件自己拼 baseUrl、自己写 Authorization / x-api-key、
 * 自己跑 12s 超时与重试、自己判 HTTP 状态，等于第二套请求栈。
 *
 * 改造后：地址（当前渠道 spec + baseUrl）、鉴权头（spec.auth）、超时（request 的预算）、
 * 错误分类（classifyApiError）全部来自 `src/services/api/embedding.ts`，
 * 本文件只保留三件事：
 *   1. 记住这次用的模型名与已探测维度（维度变了要能判出来）；
 *   2. 把失败翻译成「空向量 + 可诊断原因」，**绝不抛错**——检索据此静默退化为 BM25，不阻塞对话；
 *   3. 给老调用点（`index.js` / `recall.js`）保留 `window.SCEmbedding` 契约。
 *
 * 本文件是 ES module：它 import 的 API 层就是 app 的打包入口那一份，不存在第二份实现。
 * 因此它不再能作为 SillyTavern 的 classic script 独立加载（那个加载方式没有 import 能力），
 * 但仍会在有 window 的环境里挂上 `window.SCEmbedding`，供同目录的 index.js / recall.js 使用。
 *
 * 不打包模型、不做本地推理：这里只有一次 HTTPS 请求。
 */
import { embedTexts, resolveEmbeddingChannel } from '../api/embedding.js';

const VERSION = '0.2.0';

/** 单条输入上限：与原型一致，超长输入由这里截断（上游对 input 长度没有统一约定） */
const MAX_INPUT_CHARS = 3000;

/** 失败原因 → 给人看的中文（日志 / 气泡都只有这一处来源） */
const REASON_TEXT = Object.freeze({
    'channel-unsupported': '当前渠道没有 embedding 端点（只有 OpenAI 兼容渠道有）',
    'invalid-base-url': '渠道地址非法或为空',
    'missing-api-key': '未配置 API Key',
    timeout: '请求超时',
    network: '网络不可达',
    'malformed-response': '上游返回格式异常',
    'count-mismatch': '返回条数与请求不符',
    'dimension-mismatch': '返回维度与预期不一致（模型被换过？）',
    'api-error': '未知失败',
});

/** 机器可读原因 → 中文；`http-<status>` 单独成句 */
export function reasonText(reason) {
    if (!reason) {
        return '';
    }
    if (REASON_TEXT[reason]) {
        return REASON_TEXT[reason];
    }
    const http = /^http-(\d+)$/.exec(reason);
    return http ? `上游返回 HTTP ${http[1]}` : reason;
}

export class EmbeddingClient {
    constructor() {
        this._model = '';
        this._dimensions = 0;
        this._ready = false;
        this._reason = '';
        this._detail = '';
    }

    /** 已探测成功（维度已知） */
    get ready() { return this._ready; }
    get dimensions() { return this._dimensions; }
    get model() { return this._model; }
    /** 最近一次失败的机器可读原因（'' = 没失败过）；召回统计的 fallbackReason 直接用这个 */
    get reason() { return this._reason; }
    get detail() { return this._detail; }
    /** 最近一次失败的完整描述（日志用） */
    get lastError() { return this._reason ? `${this._reason}${this._detail ? `: ${this._detail}` : ''}` : ''; }

    /** 渠道可用（地址 + Key + 端点齐了）。地址与 Key 已不归这里管，统一看 API 层的判定 */
    get configured() { return resolveEmbeddingChannel(this._model).configured; }

    /** 不可用的原因（未配置时给调用方一个可诊断的串，而不是布尔值） */
    get configReason() { return resolveEmbeddingChannel(this._model).reason; }

    /**
     * 只接受模型名。`url` / `key` 参数为兼容旧调用点而保留，**读取即忽略**：
     * 请求地址与鉴权头只认 app 的渠道配置（#397 的核心口径）。
     */
    configure({ model } = {}) {
        const next = String(model || '').trim();
        const changed = next !== this._model;
        this._model = next;
        if (changed) {
            this._ready = false;
            this._dimensions = 0;
        }
        return changed;
    }

    /** 记下这次的结果，供状态面板 / 诊断读 */
    _remember(result) {
        if (result.ok) {
            this._reason = '';
            this._detail = '';
        } else {
            this._reason = result.reason || 'api-error';
            this._detail = result.detail || '';
        }
        return result;
    }

    /**
     * 探活 + 探测维度。
     * **不抛错**：失败返回 `{ ok: false, reason, detail }`，调用方按提示处理即可。
     */
    async probe() {
        const result = this._remember(await embedTexts({ model: this._model, input: ['dimension probe'] }));
        if (!result.ok || !result.vectors.length) {
            this._ready = false;
            this._dimensions = 0;
            return { ok: false, reason: this._reason || 'api-error', detail: this._detail };
        }
        this._dimensions = result.vectors[0].length;
        this._ready = true;
        return { ok: true, dimensions: this._dimensions };
    }

    /**
     * 批量 embedding。**不抛错**：失败返回 `{ ok: false, vectors: [], reason, detail }`。
     * 调用方拿到空数组就退化为 BM25，不需要 try/catch（原型里的 4 次退避重试已随请求栈一起收掉：
     * 重试策略属于 API 层，不在记忆模块里另立一套）。
     */
    async embedBatch(texts) {
        const list = (texts || []).map(text => String(text ?? '').slice(0, MAX_INPUT_CHARS));
        if (list.length === 0) {
            return { ok: true, vectors: [], reason: '' };
        }
        const result = this._remember(await embedTexts({
            model: this._model,
            input: list,
            // 已探测过维度就带上：模型被换掉时这里会给出 dimension-mismatch，而不是把两种维度混进同一个索引
            expectedDimensions: this._dimensions || undefined,
        }));
        if (!result.ok) {
            this._ready = false;
            if (result.reason === 'dimension-mismatch') {
                this._dimensions = 0;
            }
            return { ok: false, vectors: [], reason: this._reason, detail: this._detail };
        }
        if (result.vectors.length && !this._dimensions) {
            this._dimensions = result.vectors[0].length;
            this._ready = true;
        }
        return { ok: true, vectors: result.vectors, reason: '' };
    }
}

const client = new EmbeddingClient();

if (typeof window !== 'undefined') {
    window.SCEmbedding = { VERSION, client, EmbeddingClient, reasonText };
}

export { VERSION, client };
