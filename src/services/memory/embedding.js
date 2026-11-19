/**
 * embedding.js — 云端 embedding 客户端（v1：embedding 也放云端）
 *
 * 请求格式与错误分类照搬 Horae/core/vectorManager.js 的 _buildApiEmbeddingRequest / _embedApi：
 *   - OpenAI 兼容：POST {base}/embeddings  { model, input: [texts] } → data[].embedding
 *   - Gemini：POST {base}/v1beta/models/{model}:batchEmbedContents → embeddings[].values
 * 这样用户手上的 key（OpenAI / 硅基流动 / DeepSeek 兼容端点 / Gemini）都能直接用。
 *
 * 暴露：window.SCEmbedding = { VERSION, client }
 */
(function () {
    'use strict';

    const VERSION = '0.1.0';

    const RETRY = Object.freeze({
        maxAttempts: 4,
        baseDelay: 1200,
        maxDelay: 20000,
        requestTimeoutMs: 12000,
        retryableStatuses: [429, 500, 502, 503, 504],
    });

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function parseRetryAfter(resp) {
        try {
            const raw = resp.headers.get('retry-after');
            if (!raw) return 0;
            const secs = Number(raw);
            if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
            const when = Date.parse(raw);
            return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
        } catch (_) {
            return 0;
        }
    }

    class EmbeddingClient {
        constructor() {
            this._url = '';
            this._key = '';
            this._model = '';
            this._dimensions = 0;
            this._ready = false;
            this._lastError = '';
            this._queue = Promise.resolve();   // 串行队列：embedding 端点并发很低，排队比并发安全
        }

        get ready() { return this._ready; }
        get dimensions() { return this._dimensions; }
        get model() { return this._model; }
        get lastError() { return this._lastError; }

        /** 配置变更时重置就绪状态，下次使用会重新探测维度。 */
        configure({ url, key, model }) {
            const changed = url !== this._url || key !== this._key || model !== this._model;
            this._url = String(url || '').trim();
            this._key = String(key || '').trim();
            this._model = String(model || '').trim();
            if (changed) {
                this._ready = false;
                this._dimensions = 0;
            }
            return changed;
        }

        get configured() {
            return Boolean(this._url && this._model);
        }

        /** 探活 + 探测维度。失败抛错，由调用方决定是否降级到 BM25。 */
        async probe() {
            if (!this.configured) throw new Error('embedding 未配置（缺少 URL 或模型名）');
            const vecs = await this.embedBatch(['dimension probe']);
            if (!vecs || !vecs[0]) throw new Error('embedding 返回为空');
            this._dimensions = vecs[0].length;
            this._ready = true;
            this._lastError = '';
            return this._dimensions;
        }

        /** 批量 embedding。会自动排队、单批上限由调用方控制，内部负责重试。 */
        async embedBatch(texts) {
            const list = (texts || []).map(t => String(t ?? '').slice(0, 3000));
            if (list.length === 0) return [];
            if (!this.configured) throw new Error('embedding 未配置');
            const req = this._buildRequest(list); // Capture provider, key and model when queued.
            const run = () => this._embedWithRetry(req, list.length);
            this._queue = this._queue.then(run, run);   // 上一个失败也不阻塞后续
            return this._queue;
        }

        async _embedWithRetry(req, count) {
            let attempt = 0;
            let lastErr = null;
            while (attempt < RETRY.maxAttempts) {
                attempt++;
                try {
                    return await this._embedOnce(req, count);
                } catch (err) {
                    lastErr = err;
                    const retryable = err && (err.retryable || err.code === 'NETWORK' || err.code === 'RATE');
                    if (!retryable || attempt >= RETRY.maxAttempts) break;
                    const backoff = Math.min(RETRY.maxDelay, RETRY.baseDelay * Math.pow(2, attempt - 1));
                    const wait = Math.min(RETRY.maxDelay, err.retryAfterMs || backoff);
                    console.warn(`[SCEmbedding] 第 ${attempt} 次失败（${err.message}），${Math.round(wait)}ms 后重试`);
                    await sleep(wait);
                }
            }
            this._lastError = lastErr ? lastErr.message : 'unknown';
            throw lastErr || new Error('embedding 请求失败');
        }

        _isGemini() {
            return /gemini|generativelanguage|googleapis/i.test(`${this._url} ${this._model}`);
        }

        _buildRequest(texts) {
            if (!this._isGemini()) {
                const base = this._url.replace(/\/+$/, '').replace(/\/embeddings$/i, '');
                return {
                    endpoint: `${base}/embeddings`,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this._key}`,
                    },
                    body: JSON.stringify({ model: this._model, input: texts }),
                    parse: json => {
                        if (!json || !Array.isArray(json.data)) throw new Error('返回格式异常：缺少 data 数组');
                        return json.data
                            .slice()
                            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                            .map(d => d.embedding);
                    },
                };
            }

            const base = this._url
                .replace(/\/+$/, '')
                .replace(/\/chat\/completions$/i, '')
                .replace(/\/embeddings$/i, '')
                .replace(/\/v\d+(beta\d*)?(?:\/.*)?$/i, '');
            const modelName = this._model.startsWith('models/') ? this._model : `models/${this._model}`;
            const isGoogle = /googleapis\.com|generativelanguage/i.test(base);
            return {
                endpoint: `${base}/v1beta/${modelName}:batchEmbedContents${isGoogle ? `?key=${encodeURIComponent(this._key)}` : ''}`,
                headers: isGoogle
                    ? { 'Content-Type': 'application/json' }
                    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this._key}` },
                body: JSON.stringify({
                    requests: texts.map(text => ({ model: modelName, content: { parts: [{ text }] } })),
                }),
                parse: json => {
                    if (!json || !Array.isArray(json.embeddings)) throw new Error('返回格式异常：缺少 embeddings 数组');
                    return json.embeddings.map(e => e.values);
                },
            };
        }

        async _embedOnce(req, count) {
            let resp;
            try {
                resp = await fetch(req.endpoint, {
                    method: 'POST', headers: req.headers, body: req.body,
                    signal: AbortSignal.timeout(RETRY.requestTimeoutMs),
                });
            } catch (err) {
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('embedding 请求超时');
                // TypeError 在浏览器里通常意味着 CORS / DNS / 连接被拒
                const wrapped = new Error(`网络不可达：${err && err.message ? err.message : err}`);
                wrapped.code = 'NETWORK';
                throw wrapped;
            }

            if (!resp.ok) {
                const bodyText = await resp.text().catch(() => '');
                const err = new Error(`HTTP ${resp.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
                err.status = resp.status;
                err.retryable = RETRY.retryableStatuses.includes(resp.status);
                if (resp.status === 429) err.code = 'RATE';
                err.retryAfterMs = parseRetryAfter(resp);
                throw err;
            }

            const json = await resp.json().catch(() => null);
            const vectors = req.parse(json);
            if (!Array.isArray(vectors) || vectors.length !== count) {
                throw new Error(`返回条数不符：期望 ${count}，实际 ${Array.isArray(vectors) ? vectors.length : 0}`);
            }
            return vectors;
        }
    }

    const client = new EmbeddingClient();

    if (typeof window !== 'undefined') {
        window.SCEmbedding = { VERSION, client, EmbeddingClient };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { VERSION, client, EmbeddingClient };
    }
})();
