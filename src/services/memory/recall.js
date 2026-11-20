/**
 * recall.js — 细节召回层（混合检索）
 *
 * 上游 Summaryception 只有"压缩"一条腿：所有摘要片段按时间顺序整体注入，
 * 压缩时丢掉的细节就永久丢失。本模块补第二条腿：
 * 对**已 ghost 的原始消息**做检索，每轮只把最相关的原文按 token 预算塞回去。
 *
 * v1 的打分 = 云端向量余弦 + 本地 BM25 + 可选时间衰减：
 *   - 纯向量在专名/编号上很弱（"艾琳"和"艾莲"可能比"她"更远），
 *   - 纯 BM25 在近义改写上很弱（"那把剑" vs "长剑"），
 *   两者缺一不可，所以做混合而不是二选一。
 *
 * 三种调用方式：
 *   recallSync()   —— 只用 BM25，同步返回。embedding 没配/挂了/超时都走这条，保证永不阻塞生成。
 *   recallAsync()  —— 混合检索，需要网络往返。由 index.js 在收到消息后预热缓存。
 *   renderBlocks() —— 共用的预算裁剪与渲染。
 *
 * 暴露：window.SCRecall
 */
(function () {
    'use strict';

    const VERSION = '0.2.0';

    const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
    const TOKEN_RE = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g;

    const STOPWORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'to', 'in', 'on',
        'at', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
        'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'my',
        'your', 'his', 'her', 'their', 'our', 'as', 'by', 'from', 'not', 'no', 'do', 'did',
        'does', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'just', 'very',
        'really', 'about', 'into', 'out', 'up', 'down', 'over', 'again', 'there', 'here',
        'what', 'when', 'where', 'who', 'how', 'why', 'all', 'any', 'some', 'one', 'two',
    ]);

    const CJK_SKIP_SINGLE = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '和', '就', '也', '都', '很']);

    // ─── 分词 / 估 token ───

    function tokenize(text) {
        const out = [];
        if (!text) return out;
        const matches = String(text).toLowerCase().match(TOKEN_RE);
        if (!matches) return out;
        for (const raw of matches) {
            if (CJK_CHAR.test(raw)) {
                const chars = Array.from(raw);
                if (chars.length === 1) {
                    if (!CJK_SKIP_SINGLE.has(chars[0])) out.push(chars[0]);
                    continue;
                }
                for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
            } else {
                if (raw.length < 2) continue;
                if (STOPWORDS.has(raw)) continue;
                out.push(raw);
            }
        }
        return out;
    }

    // 用整数累计未取整的估值：CJK = 1 token，其他字符 = 1/3.6 token。
    // 拼完全部正文、分隔符和标签后才取整，预算试算与 estimateTokens 共用同一口径。
    const TOKEN_UNITS = 18;
    const OTHER_UNITS = 5;
    const charUnits = ch => CJK_CHAR.test(ch) ? TOKEN_UNITS : OTHER_UNITS;

    function tokenUnits(text) {
        let units = 0;
        for (const ch of text) units += charUnits(ch);
        return units;
    }

    function estimateTokens(text) {
        return text ? Math.ceil(tokenUnits(text) / TOKEN_UNITS) : 0;
    }

    // ─── 数据准备 ───

    function messageText(msg) {
        if (!msg || typeof msg.mes !== 'string') return '';
        return msg.mes;
    }

    function buildQueryText(chat, turns, ghostedSet) {
        const parts = [];
        for (let i = chat.length - 1; i >= 0 && parts.length < turns; i--) {
            if (ghostedSet.has(i)) continue;
            const msg = chat[i];
            if (!msg || msg.is_user === undefined) continue;
            if (msg.is_system) continue;
            const text = messageText(msg).trim();
            if (!text || text.startsWith('/')) continue;
            parts.push(text.slice(-1200));
        }
        return parts.reverse().join('\n');
    }

    /** 候选池 = 已 ghost 的原始消息。它们正是模型当前看不到、且压缩时可能已经丢掉的那部分。 */
    function collectCandidates(chat, store, fullText = false) {
        const ghosted = Array.isArray(store && store.ghostedIndices) ? store.ghostedIndices : [];
        const ghostedSet = new Set(ghosted);
        const docs = [];
        for (const i of ghostedSet) {
            if (!Number.isInteger(i) || i < 0 || i >= chat.length) continue;
            const msg = chat[i];
            if (!msg || msg.is_user === undefined) continue;
            const text = messageText(msg).trim();
            if (text.length < 8) continue;
            docs.push({ idx: i, text: fullText ? text : text.slice(0, 4000) });
        }
        docs.sort((a, b) => a.idx - b.idx);
        return { docs, ghostedSet };
    }

    // ─── BM25（本地，零成本） ───

    let _cache = { docs: [], index: null };

    function buildIndex(docs) {
        const df = new Map();
        const entries = [];
        let totalLen = 0;
        for (const doc of docs) {
            const terms = tokenize(doc.text);
            if (terms.length === 0) continue;
            const tf = new Map();
            for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
            for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
            entries.push({ idx: doc.idx, tf, len: terms.length });
            totalLen += terms.length;
        }
        return { entries, df, n: entries.length, avgdl: entries.length ? totalLen / entries.length : 1 };
    }

    function getIndex(docs) {
        // 相同长度、索引和 ghost 数不足以区分另一档会话或就地编辑。对实际索引内容做精确比较。
        if (_cache.index && docs.length === _cache.docs.length && docs.every((doc, i) => (
            doc.idx === _cache.docs[i].idx && doc.text === _cache.docs[i].text
        ))) return _cache.index;
        _cache = { docs, index: buildIndex(docs) };
        return _cache.index;
    }

    function scoreBM25(index, queryTokens, k1 = 1.2, b = 0.75) {
        const scores = new Array(index.entries.length).fill(0);
        if (!queryTokens.length || index.entries.length === 0) return scores;

        const qtf = new Map();
        for (const t of queryTokens) qtf.set(t, (qtf.get(t) || 0) + 1);

        for (const [term, qn] of qtf) {
            const df = index.df.get(term);
            if (!df) continue;
            const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
            const qBoost = Math.min(qn, 3);
            for (let i = 0; i < index.entries.length; i++) {
                const e = index.entries[i];
                const f = e.tf.get(term);
                if (!f) continue;
                const denom = f + k1 * (1 - b + b * (e.len / (index.avgdl || 1)));
                scores[i] += idf * ((f * (k1 + 1)) / denom) * qBoost;
            }
        }
        return scores;
    }

    function lexicalRanking(docs, queryText) {
        if (!docs.length) return new Map();
        const index = getIndex(docs);
        if (index.entries.length === 0) return new Map();
        const scores = scoreBM25(index, tokenize(queryText));
        let max = 0;
        for (const v of scores) if (v > max) max = v;
        if (max <= 0) return new Map();
        const out = new Map();
        index.entries.forEach((e, i) => {
            if (scores[i] > 0) out.set(e.idx, scores[i] / max);
        });
        return out;
    }

    // ─── 区间合并 / 预算渲染 ───

    function windowRadius(radius) {
        const n = radius == null || radius === '' ? 2 : Number(radius);
        return Math.max(0, Math.min(4, Number.isFinite(n) ? Math.floor(n) : 2));
    }

    /** 单个命中点的窗口：不跨过模型已经能看到的消息。 */
    function windowFor(idx, ghostedSet, chat, radius) {
        const r = windowRadius(radius);
        let start = idx;
        while (start > 0 && idx - start < r && ghostedSet.has(start - 1) && chat[start - 1]) start--;
        let end = idx;
        while (end + 1 < chat.length && end - idx < r && ghostedSet.has(end + 1) && chat[end + 1]) end++;
        return [start, end];
    }

    function buildWindows(hitIdxs, ghostedSet, chat, radius = 2) {
        return normalizeRanges(Array.from(hitIdxs, idx => windowFor(idx, ghostedSet, chat, radius)));
    }

    const mergeRanges = buildWindows;

    function normalizeRanges(ranges) {
        ranges.sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const rg of ranges) {
            const last = out[out.length - 1];
            if (last && rg[0] <= last[1] + 1) last[1] = Math.max(last[1], rg[1]);
            else out.push(rg);
        }
        return out;
    }

    /**
     * 按名次依次开窗，名额只发给"新开的区间"。
     *
     * 关键差别：命中点落进已有区间（或把两个已有区间桥接起来）时不消耗名额，
     * 所以"相邻两条消息各占一个 topK 名额"这种浪费不会发生；
     * 名额没满就继续往下取，直到凑够 topK 个不同区间或候选耗尽。
     */
    function selectRanges(rankedIdxs, ghostedSet, chat, radius, topK, maxCovered = 0) {
        const quota = Math.max(1, Number(topK) || 6);
        const coverCap = Math.max(0, Number(maxCovered) || 0);
        let ranges = [];

        for (const idx of rankedIdxs) {
            const [s0, e0] = windowFor(idx, ghostedSet, chat, radius);

            const bridged = [];
            const rest = [];
            for (const rg of ranges) {
                if (s0 <= rg[1] + 1 && e0 + 1 >= rg[0]) bridged.push(rg);
                else rest.push(rg);
            }

            if (bridged.length === 0 && ranges.length >= quota) continue;   // 要开新区间但名额已满

            const merged = [s0, e0];
            for (const rg of bridged) {
                merged[0] = Math.min(merged[0], rg[0]);
                merged[1] = Math.max(merged[1], rg[1]);
            }
            const next = normalizeRanges([...rest, merged]);

            // 覆盖条数上限：区间被"桥接"时名额不会减少，所以必须另设总覆盖量的闸，
            // 否则点在长会话里密布时会并成一个巨区间，把整段历史吞进来。
            if (coverCap > 0) {
                const covered = next.reduce((acc, [s, e]) => acc + (e - s + 1), 0);
                if (covered > coverCap) continue;
            }

            ranges = next;
        }

        return normalizeRanges(ranges);
    }

    /**
     * Reciprocal Rank Fusion（Cormack et al., SIGIR 2009）：
     * 只用名次、不用分数量纲，天然免疫"高基线相似度被 max 归一化压平"的问题。
     * score = Σ w_i / (k + rank_i)
     */
    function rrfFuse(rankedLists, k = 60) {
        const K = Math.max(1, Number(k) || 60);
        const fused = new Map();
        for (const { idxs, weight } of rankedLists) {
            if (!weight) continue;
            idxs.forEach((idx, i) => {
                fused.set(idx, (fused.get(idx) || 0) + weight * (1 / (K + i + 1)));
            });
        }
        return fused;
    }

    function timeLabel(idx, chat, opts) {
        const anchor = typeof window !== 'undefined' && window.SCTimeAnchor;
        return opts.recallTimeLabels && typeof anchor?.ageLabel === 'function'
            ? anchor.ageLabel(Math.max(0, chat.length - 1 - idx)) || ''
            : '';
    }

    // 先定位词面证据，再朝两侧留上下文。按 code point 裁剪，省略号也占预算。
    function excerptFocus(text, queryText, units) {
        const terms = new Set(tokenize(queryText));
        if (!terms.size) return [0, 0];
        const pattern = new RegExp(TOKEN_RE.source, 'gi');
        for (const match of text.matchAll(pattern)) {
            const raw = match[0];
            if (!CJK_CHAR.test(raw)) {
                if (terms.has(raw.toLowerCase()) && tokenUnits(raw) <= units) {
                    return [match.index, match.index + raw.length];
                }
                continue;
            }
            for (let i = 0; i < raw.length; i++) {
                const n = raw.length === 1 ? 1 : 2;
                if (!terms.has(raw.slice(i, i + n)) || n * TOKEN_UNITS > units) continue;
                let end = i + n;
                while (end < raw.length && (end - i + 1) * TOKEN_UNITS <= units
                    && terms.has(raw.slice(end - 1, end + 1))) end++;
                return [match.index + i, match.index + end];
            }
        }
        return [0, 0];
    }

    function boundedExcerpt(text, maxUnits, queryText = '', marker = '…') {
        if (maxUnits < OTHER_UNITS) return '';
        let markerUnits = tokenUnits(marker);
        let [start, end] = excerptFocus(text, queryText, maxUnits - 2 * markerUnits);
        if (queryText && start === end && markerUnits) {
            [start, end] = excerptFocus(text, queryText, maxUnits);
            if (start !== end) { marker = ''; markerUnits = 0; }
        }
        let used = tokenUnits(text.slice(start, end))
            + (start > 0 ? markerUnits : 0) + (end < text.length ? markerUnits : 0);
        let preferLeft = true;
        while (true) {
            let moved = false;
            for (const left of [preferLeft, !preferLeft]) {
                if (left ? start === 0 : end === text.length) continue;
                let pos = left ? start - 1 : end;
                if (left && pos > 0 && text.charCodeAt(pos) >= 0xdc00 && text.charCodeAt(pos) <= 0xdfff
                    && text.charCodeAt(pos - 1) >= 0xd800 && text.charCodeAt(pos - 1) <= 0xdbff) pos--;
                const ch = String.fromCodePoint(text.codePointAt(pos));
                const edge = left ? pos === 0 : end + ch.length === text.length;
                const cost = charUnits(ch) - (edge ? markerUnits : 0);
                if (used + cost > maxUnits) continue;
                used += cost;
                if (left) start = pos;
                else end += ch.length;
                preferLeft = !left;
                moved = true;
                break;
            }
            if (!moved) break;
        }
        if (start === end || !text.slice(start, end).trim()) {
            return marker ? boundedExcerpt(text, maxUnits, '', '') : '';
        }
        return (start > 0 ? marker : '') + text.slice(start, end) + (end < text.length ? marker : '');
    }

    function budgetUnits(budget) {
        return Math.max(0, Math.floor(Number(budget) || 0)) * TOKEN_UNITS;
    }

    // 保留旧的区间渲染接口；常规召回使用下方的命中优先打包，不会先合并再截断。
    function renderBlocks(ranges, chat, budget, stats, opts = {}) {
        const blocks = [];
        const cap = budgetUnits(budget);
        let used = 0;
        stats.hits = Number(stats.hits) || 0;
        for (const [start, end] of ranges) {
            const lines = [];
            for (let i = start; i <= end; i++) {
                const text = messageText(chat[i]).trim();
                if (text) lines.push(text);
            }
            if (!lines.length) continue;
            const label = timeLabel(start, chat, opts);
            const overhead = tokenUnits(label) + (blocks.length ? OTHER_UNITS : 0);
            let body = lines.join('\n');
            if (used + overhead + tokenUnits(body) > cap) {
                if (blocks.length) continue;
                body = boundedExcerpt(body, cap - overhead);
                if (!body) continue;
            }
            blocks.push(label + body);
            used += overhead + tokenUnits(body);
            stats.hits++;
        }
        const text = blocks.join('\n');
        stats.tokens = estimateTokens(text);
        return text;
    }

    /** 先给所有符合条件的命中留预算，再按距命中远近回填上下文；最后才按时序渲染。 */
    function packRanked(rankedIdxs, ghostedSet, chat, budget, topK, stats, opts, queryText) {
        const cap = budgetUnits(budget);
        const coverCap = topK * 3;
        const picked = new Map();
        const entries = new Map();
        const labels = new Map();
        let used = 0;
        let ranges = 0;

        function entry(idx) {
            if (!entries.has(idx)) {
                const text = messageText(chat[idx]).trim();
                entries.set(idx, { text, units: tokenUnits(text) });
            }
            return entries.get(idx);
        }

        function label(idx) {
            if (!labels.has(idx)) {
                const text = timeLabel(idx, chat, opts);
                labels.set(idx, { text, units: tokenUnits(text) });
            }
            return labels.get(idx);
        }

        // 整段试算后再提交，避免桥上的原文占了预算、命中本身却放不进去。
        function plan(start, parts, units) {
            if (picked.size + parts.length > coverCap) return null;
            const end = start + parts.length - 1;
            const left = picked.has(start - 1);
            const right = picked.has(end + 1);
            const nextRanges = ranges + 1 - Number(left) - Number(right);
            if (nextRanges > topK) return null;
            const delta = units + (parts.length - Number(picked.size === 0)) * OTHER_UNITS
                + (left ? 0 : label(start).units) - (right ? label(end + 1).units : 0);
            return used + delta <= cap ? { start, parts, nextRanges, delta } : null;
        }

        function commit({ start, parts, nextRanges, delta }) {
            parts.forEach((part, i) => picked.set(start + i, part.text));
            ranges = nextRanges;
            used += delta;
        }

        function add(idx, part) {
            if (!part.text || picked.has(idx)) return false;
            const single = plan(idx, [part], part.units);
            if (!single) return false;
            commit(single);
            return true;
        }

        const maxGap = Math.min(3, windowRadius(opts.recallWindowRadius));
        function tryBridge(idx, part) {
            // Limit bridge context so it cannot repeatedly displace later hits.
            if (stats.bridged || !maxGap || ranges < topK || picked.has(idx - 1) || picked.has(idx + 1)) return false;
            const options = [];
            for (const dir of [-1, 1]) {
                const parts = [part];
                let units = part.units;
                for (let pos = idx + dir; parts.length + picked.size <= coverCap; pos += dir) {
                    if (picked.has(pos)) {
                        const start = dir < 0 ? pos + 1 : idx;
                        const bridge = plan(start, dir < 0 ? parts.reverse() : parts, units);
                        if (bridge) options.push(bridge);
                        break;
                    }
                    if (parts.length > maxGap || !ghostedSet.has(pos) || !chat[pos]) break;
                    const gap = entry(pos);
                    if (!gap.text) break;
                    parts.push(gap);
                    units += gap.units;
                }
            }
            if (!options.length) return false;
            options.sort((a, b) => a.parts.length - b.parts.length || a.delta - b.delta || a.start - b.start);
            commit(options[0]);
            stats.bridged = (stats.bridged || 0) + 1;
            return true;
        }

        function addInOrder(indexes, allowBridge = false) {
            const added = new Set();
            let pending = indexes;
            // 后面的候选若连起已有区间，先前因区间名额或标签开销放弃的消息可能就能放入。
            while (pending.length && picked.size < coverCap) {
                const deferred = [];
                let progressed = false;
                for (const idx of pending) {
                    if (picked.size >= coverCap) break;
                    const part = entry(idx);
                    if (!part.text || picked.has(idx)) continue;
                    if (add(idx, part) || (allowBridge && tryBridge(idx, part))) {
                        added.add(idx);
                        progressed = true;
                    } else deferred.push(idx);
                }
                if (!progressed) break;
                pending = deferred;
            }
            return added;
        }

        const topIdx = rankedIdxs[0];
        const top = entry(topIdx);
        const needsExcerpt = top.units + label(topIdx).units > cap;
        if (needsExcerpt) {
            const text = boundedExcerpt(top.text, cap - label(topIdx).units, queryText);
            if (text && add(topIdx, { text, units: tokenUnits(text) })) stats.excerpts = 1;
        }
        const anchors = addInOrder(rankedIdxs, true);
        if (picked.has(topIdx)) anchors.add(topIdx);

        const neighborPriority = new Map();
        for (let rank = 0; rank < rankedIdxs.length && picked.size < coverCap; rank++) {
            const idx = rankedIdxs[rank];
            if (!anchors.has(idx)) continue;
            const [start, end] = windowFor(idx, ghostedSet, chat, opts.recallWindowRadius);
            for (let j = start; j <= end; j++) {
                if (picked.has(j)) continue;
                const distance = Math.abs(idx - j);
                const previous = neighborPriority.get(j);
                if (!previous || distance < previous.distance) neighborPriority.set(j, { idx: j, distance, rank });
            }
        }
        const neighbors = [...neighborPriority.values()]
            .sort((a, b) => a.distance - b.distance || a.rank - b.rank || a.idx - b.idx);
        addInOrder(neighbors.map(x => x.idx));

        const lines = [];
        let prev = -2;
        for (const idx of [...picked.keys()].sort((a, b) => a - b)) {
            lines.push((idx === prev + 1 ? '' : label(idx).text) + picked.get(idx));
            prev = idx;
        }
        const text = lines.join('\n');
        stats.hits = stats.ranges = ranges;
        stats.covered = picked.size;
        stats.anchors = anchors.size;
        stats.tokens = estimateTokens(text);
        if (!text) stats.reason = 'budget-exhausted';
        return text;
    }

    function prepareRecall(chat, store, settings, stats) {
        const budget = Math.floor(Number(settings.recallBudgetTokens) || 0);
        const topK = Math.max(1, Math.floor(Number(settings.recallTopK) || 6));
        const threshold = Math.max(0, Number(settings.recallMinScore) || 0);
        if (budget <= 0) { stats.reason = 'budget=0'; return null; }
        if (!Array.isArray(chat) || chat.length < 2) { stats.reason = 'short-chat'; return null; }

        const { docs, ghostedSet } = collectCandidates(chat, store, true);
        stats.candidates = docs.length;
        if (!docs.length) { stats.reason = 'no-candidates'; return null; }

        const queryText = buildQueryText(chat, Math.max(1, Number(settings.recallQueryTurns) || 3), ghostedSet);
        if (!queryText.trim()) { stats.reason = 'empty-query'; return null; }
        return { budget, topK, threshold, docs, ghostedSet, queryText };
    }

    function sortLexical(docs, queryText) {
        return [...lexicalRanking(docs, queryText)].sort((a, b) => b[1] - a[1]);
    }

    // ─── 同步路径：只有 BM25（降级默认） ───

    function recallSync({ chat, store, settings }) {
        const stats = { mode: 'lexical', candidates: 0, hits: 0, tokens: 0, reason: '' };
        try {
            const s = settings || {};
            const request = prepareRecall(chat, store, s, stats);
            if (!request) return { text: '', stats };
            const { budget, topK, threshold, docs, ghostedSet, queryText } = request;
            const lex = sortLexical(docs, queryText);
            if (!lex.length) { stats.reason = 'no-overlap'; return { text: '', stats }; }

            const ranked = lex.filter(([, score]) => score >= threshold).map(([idx]) => idx);
            if (!ranked.length) { stats.reason = 'below-threshold'; return { text: '', stats }; }
            stats.points = ranked.length;
            const text = packRanked(ranked, ghostedSet, chat, budget, topK, stats, s, queryText);
            return { text, stats };
        } catch (err) {
            console.warn('[SCRecall] lexical failed:', err);
            return { text: '', stats: { ...stats, reason: 'exception' } };
        }
    }

    // ─── 异步路径：云端向量 + 本地 BM25 ───

    function validQueryVector(vec) {
        if (!vec?.length) return false;
        let nonzero = false;
        for (const value of vec) {
            if (!Number.isFinite(value)) return false;
            if (value !== 0) nonzero = true;
        }
        return nonzero;
    }

    async function recallAsync({ chat, store, settings, chatKey, vectorOptions }) {
        const stats = { mode: 'hybrid', candidates: 0, hits: 0, tokens: 0, vecCount: 0, reason: '' };
        const fallback = reason => {
            const result = recallSync({ chat, store, settings });
            return { ...result, stats: { ...result.stats, vecCount: 0, fallbackReason: reason } };
        };
        try {
            const embedder = typeof window !== 'undefined' && window.SCEmbedding?.client;
            const vstore = typeof window !== 'undefined' && window.SCVectorStore;
            if (!vstore) return fallback('vector-unavailable');
            // #397：不可用的原因由 API 层给出（渠道不支持 / 地址非法 / 没配 Key），不再是笼统的 unavailable
            if (!embedder?.configured) return fallback((embedder && embedder.configReason) || 'vector-unavailable');

            const s = settings || {};
            const wVec = Math.max(0, Number(s.recallWeightVector ?? 0.7));
            const wLex = Math.max(0, Number(s.recallWeightLexical ?? 0.3));
            const halfLife = Math.max(0, Number(s.recallHalfLife) || 0);
            if (!wVec) return fallback('vector-disabled');

            const request = prepareRecall(chat, store, s, stats);
            if (!request) return { text: '', stats };
            const { budget, topK, threshold, docs, ghostedSet, queryText } = request;
            const allowed = new Set(docs.map(doc => doc.idx));

            let queryVec;
            try {
                // Keep the newest input when the embedding client caps a long query.
                // #397：embedBatch 不抛错，失败给空 vectors + 原因 —— 据此静默退化为 BM25，不阻塞对话
                const embedded = await embedder.embedBatch([queryText.slice(-3000)]);
                queryVec = embedded.ok ? embedded.vectors?.[0] : undefined;
                if (!validQueryVector(queryVec)) {
                    return fallback(embedded.ok ? 'invalid-query-vector' : (embedded.reason || 'embedding-failed'));
                }
            } catch (err) {
                console.warn('[SCRecall] embedding failed, falling back to lexical:', err?.message);
                return fallback('embedding-failed');
            }

            let hits;
            try {
                hits = await vstore.search(chatKey, queryVec, { topK: 30, ...vectorOptions, allowed });
            } catch (err) {
                console.warn('[SCRecall] vector search failed, falling back to lexical:', err?.message);
                return fallback('vector-search-failed');
            }

            // 即使后端未执行过滤，也不接纳候选池之外、重复、无效或已过期的命中。
            const vecIdxs = [];
            const vecSet = new Set();
            const expected = vectorOptions?.expectedTexts;
            for (const hit of Array.isArray(hits) ? hits : []) {
                if (!hit || !allowed.has(hit.idx) || vecSet.has(hit.idx)) continue;
                if (!Number.isFinite(hit.similarity) || hit.similarity <= 0) continue;
                if (expected && (!expected.has(hit.idx) || (hit.text !== undefined && hit.text !== expected.get(hit.idx)))) continue;
                vecSet.add(hit.idx);
                vecIdxs.push(hit.idx);
            }
            if (!vecIdxs.length) return fallback('no-valid-vectors');
            stats.vecCount = vecIdxs.length;

            const lexIdxs = sortLexical(docs, queryText).map(([idx]) => idx);
            const fused = rrfFuse(
                [{ idxs: vecIdxs, weight: wVec }, { idxs: lexIdxs, weight: wLex }],
                s.recallRrfK,
            );
            const currentTurn = chat.length - 1;
            let maxFused = 0;
            for (const v of fused.values()) if (v > maxFused) maxFused = v;

            const scored = [];
            for (const [idx, score] of fused) {
                const age = Math.max(0, currentTurn - idx);
                const adjusted = halfLife > 0 ? score * Math.pow(0.5, age / halfLife) : score;
                if (adjusted > 0 && adjusted / maxFused >= threshold) scored.push({ idx, score: adjusted });
            }
            if (!scored.length) { stats.reason = 'below-threshold'; return { text: '', stats }; }
            scored.sort((a, b) => b.score - a.score);

            // 保留原有的双路一致优先；预算打包前不截掉后续可能适合的候选点。
            const lexSet = new Set(wLex ? lexIdxs : []);
            const consensus = [];
            const remainder = [];
            for (const { idx } of scored) {
                if (vecSet.has(idx) && lexSet.has(idx)) consensus.push(idx);
                else remainder.push(idx);
            }
            const ranked = [...consensus, ...remainder];
            stats.consensus = consensus.length;
            stats.points = ranked.length;
            const text = packRanked(ranked, ghostedSet, chat, budget, topK, stats, s, queryText);
            return { text, stats };
        } catch (err) {
            console.warn('[SCRecall] hybrid failed, falling back to lexical:', err?.message);
            return fallback('hybrid-exception');
        }
    }

    const SCRecall = {
        VERSION,
        tokenize,
        estimateTokens,
        recallSync,
        recallAsync,
        renderBlocks,
        buildWindows,
        mergeRanges,
        selectRanges,
        rrfFuse,
        collectCandidates,
        buildQueryText,
        debugQuery: text => tokenize(text),
    };

    if (typeof window !== 'undefined') window.SCRecall = SCRecall;
    if (typeof module !== 'undefined' && module.exports) module.exports = SCRecall;
})();
