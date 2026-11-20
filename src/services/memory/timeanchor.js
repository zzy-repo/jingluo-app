/**
 * timeanchor.js — 时间锚（精简版）
 *
 * 思路取自 Horae/utils/timeUtils.js：把"昨天/上周三/三天前/去年"这类相对表述
 * 归一成"天"，好让记忆条目带上时间语义。
 *
 * 这里只保留召回层用得到的两个能力：
 *   1. ageLabel(turns)  —— 给召回块加"[约 120 轮前]"前缀，让模型知道这是旧事。
 *   2. parseRelativeTerms(text) —— 从文本里认出显式时间词，供后续做时间加权。
 *
 * 暴露：window.SCTimeAnchor
 */
(function () {
    'use strict';

    const VERSION = '0.1.0';

    const CN_NUM = {
        零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
        十一: 11, 十二: 12, 十五: 15, 二十: 20, 三十: 30,
    };

    function cnToInt(str) {
        if (!str) return NaN;
        if (/^\d+$/.test(str)) return parseInt(str, 10);
        if (Object.hasOwn(CN_NUM, str)) return CN_NUM[str];
        // 简单的"二十三""三十五"之类
        const m = str.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
        if (m) {
            const tens = m[1] ? CN_NUM[m[1]] : 1;
            const ones = m[2] ? CN_NUM[m[2]] : 0;
            return tens * 10 + ones;
        }
        return NaN;
    }

    /** 轮数 → 人话标签。轮数只是近似，别假装精确。 */
    function ageLabel(turns) {
        const t = Math.max(0, Math.round(Number(turns) || 0));
        if (t === 0) return '[刚刚] ';
        if (t <= 6) return `[约 ${t} 轮前] `;
        if (t <= 40) return `[约 ${Math.round(t / 2) * 2} 轮前] `;
        return `[约 ${Math.round(t / 10) * 10} 轮前] `;
    }

    const DAY_TERMS = [
        { re: /大前天/, days: 3 },
        { re: /前天/, days: 2 },
        { re: /昨天|昨日/, days: 1 },
        { re: /今天|今日|刚才|刚刚/, days: 0 },
        { re: /明天|明日/, days: -1 },
        { re: /后天/, days: -2 },
        { re: /(上上周|上周|这周|本周|下周)/, days: 7 },
        { re: /(上个月|上月|这个月|本月|下个月)/, days: 30 },
        { re: /(去年|今年|明年)/, days: 365 },
    ];

    /**
     * 从文本中提取显式时间词。
     * @returns {{days:number|null, matched:string}}
     */
    function parseRelativeTerms(text) {
        const src = String(text || '');
        if (!src) return { days: null, matched: '' };

        // "三天前 / 两个月前 / 五年前"
        const m = src.match(/([0-9一二两三四五六七八九十]{1,3})\s*(天|日|周|个?月|年)\s*(前|以前|之前)/);
        if (m) {
            const n = cnToInt(m[1]);
            const unit = m[2];
            let days = NaN;
            if (/天|日/.test(unit)) days = n;
            else if (/周/.test(unit)) days = n * 7;
            else if (/月/.test(unit)) days = n * 30;
            else if (/年/.test(unit)) days = n * 365;
            if (Number.isFinite(days)) return { days, matched: m[0] };
        }

        for (const term of DAY_TERMS) {
            const hit = src.match(term.re);
            if (hit) return { days: term.days, matched: hit[0] };
        }

        return { days: null, matched: '' };
    }

    /** 天数 → 人话。 */
    function formatDays(days) {
        const d = Number(days);
        if (!Number.isFinite(d)) return '';
        if (d === 0) return '当天';
        if (d < 0) return `${Math.abs(d)} 天后`;
        if (d === 1) return '一天前';
        if (d < 7) return `${d} 天前`;
        if (d < 30) return `${Math.round(d / 7)} 周前`;
        if (d < 365) return `${Math.round(d / 30)} 个月前`;
        return `${Math.round(d / 365)} 年前`;
    }

    const api = { VERSION, ageLabel, parseRelativeTerms, formatDays, cnToInt };
    if (typeof window !== 'undefined') window.SCTimeAnchor = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
