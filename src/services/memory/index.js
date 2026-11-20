/**
 * Summaryception v5.5.4 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import './timeanchor.js';
import './embedding.js';
import './vectorstore.js';
import './recall.js';
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';

const MODULE_NAME = 'summaryception';
const EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
const EMBEDDING_DIMENSIONS = 1024;
const RECALL_WAIT_MS = 250;
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ═══════════════════════════════════════════════════════════════════════
//  TUNING — Centralised operational constants.
//  Change these instead of hunting through function bodies.
// ═══════════════════════════════════════════════════════════════════════

const TUNING = Object.freeze({

    // ── Retry / Resilience ─────────────────────────────────────────
    maxRetries:               5,        // LLM call retry attempts before giving up
    retryBaseDelay:           2_000,    // ms — initial back-off delay
    retryMaxDelay:            60_000,   // ms — ceiling for exponential back-off
    retryBackoffMultiplier:   2,        // exponential growth factor
    retryableStatuses:        [429, 500, 502, 503, 504],
    llmRequestTimeout:        120_000,  // ms — per-request hard timeout
    consecutiveFailureLimit:  3,        // catchup aborts after this many failures in a row

    // ── Backlog / Catchup ──────────────────────────────────────────
    backlogMultiplier:        2,        // overflow > turnsPerSummary × this triggers catchup dialog

    // ── Event Debouncing ───────────────────────────────────────────
    messageReceivedDelay:     500,      // ms — delay after new message before summarisation check
    chatChangedDelay:         100,      // ms — delay after chat switch before UI refresh
    catchupInterBatchDelay:   200,      // ms — breathing room between catchup batches

    // ── Progress Reporting ─────────────────────────────────────────
    ghostProgressInterval:    10,       // update toast every N messages during ghost/unghost
    repairProgressInterval:   5,        // update toast every N messages during repair scan

    // ── Injection Position ─────────────────────────────────────────
    // setExtensionPrompt(name, text, position, depth, scan, role)
    // 前缀缓存只复用从 prompt 开头连续相同的部分，所以拆成两槽：
    // 稳定记忆（摘要链 + 用户笔记）进系统段，极少变化 → 前面的历史不会被它作废。
    stableInjectionPosition:  0,        // 0 = system prompt
    stableInjectionDepth:     0,
    // 本轮回召每轮都变 → 放到聊天最末端，它之后只剩当前输入。
    recallInjectionPosition:  1,        // 1 = in-chat
    recallInjectionDepth:     0,

    // 召回跨轮复用：查询没实质变化时沿用上轮召回文本，让它也能命中前缀缓存。
    recallReuseMinSimilarity: 0.5,      // 相邻两轮查询的 token Jaccard 下限
    recallReuseMaxNewGhosts:  3,        // 期间最多新增几条被压缩掉的消息
    injectionScan:            false,    // watched by World Info?
    injectionRole:            1,        // 0 = system, 1 = user, 2 = assistant

    // ── Toast Durations (ms) ───────────────────────────────────────
    // Named by intent so you can tune notification verbosity in one place.
    toastShort:               1_500,
    toastDefault:             2_000,
    toastMedium:              3_000,
    toastLong:                4_000,
    toastLonger:              5_000,
    toastExtended:            6_000,
    toastError:               8_000,

    // ── Connection UI ──────────────────────────────────────────────
    connectionStatusTimeout:  8_000,    // ms — auto-hide the status indicator
    stopButtonCooldown:       2_000,    // ms — brief disable after clicking Stop
});

// Legacy alias — keeps RETRY_CONFIG references readable without a noisy diff.
const RETRY_CONFIG = Object.freeze({
    maxRetries:         TUNING.maxRetries,
    baseDelay:          TUNING.retryBaseDelay,
    maxDelay:           TUNING.retryMaxDelay,
    backoffMultiplier:  TUNING.retryBackoffMultiplier,
    retryableStatuses:  TUNING.retryableStatuses,
});

// ─── Default Settings ────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 10,
    turnsPerSummary: 3,
    snippetsPerLayer: 20,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    injectionTemplate: '\n\n<auto_injected_historical_context>\n[system guidance: this is a historical summary of messages that occurred prior to the oldest assistant message currently in context for this chat]\n{{summary}}\n</auto_injected_historical_context>\n\n',

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt:
        `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,  // true = mark as summarized but don't hide messages

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    // ─── Detail Recall Layer (recall.js) ─────────────────────────
    // 摘要链负责"不断片"，召回层负责"捞细节"。
    recallEnabled: true,
    recallBudgetTokens: 1200,   // 每轮给召回内容的上限；0 = 关闭召回
    recallTopK: 6,              // 最多召回几个消息区间
    recallMinScore: 0.15,       // 归一化分数下限，低于此值不注入
    recallHalfLife: 0,          // 时间衰减半衰期（轮）；0 = 不衰减
    recallQueryTurns: 3,        // 用最近几条消息拼查询串
    recallWeightVector: 0.7,    // 混合打分中向量余弦的权重
    recallWeightLexical: 0.3,   // 混合打分中 BM25 的权重
    recallTimeLabels: false,    // 召回块前是否加"[约 N 轮前]"
    recallWindowRadius: 3,      // 保住命中消息之后，最多向两侧各补几条
    recallRrfK: 60,             // RRF 平滑常数：越大越平缓，60 是通用默认
    summarySegmentTurns: 0,     // 窗口按整段推进的段长；0 = 用 verbatimTurns
    recallReuseMinSimilarity: 0.5,  // 相邻轮查询相似度下限；0 = 关闭跨轮复用

    // ─── Cloud Embedding（v1：embedding 走云端）───────────────
    embUrl: '',                                  // OpenAI 兼容端点（如 https://api.siliconflow.cn/v1）或 Gemini
    embKey: '',
    embModel: EMBEDDING_MODEL,
    embBatchSize: 16,                            // 补历史时每批条数（云端一般 16~32 最优）

    debugMode: false,
    traceMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const PROMPT_PRESETS = {
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the final response instead of 'you'.

IF prior_context has no content: include establishing details in the generated summary, extend the maximum number of short phrases up to 40.

Priority Elements: Time + location changes + narrative themes and subtext + sensory details that establish tone + atmosphere + mood + plot developments + proper names + character motivations + character interactions + dialogue tone + relationship dynamics + emotional beats + unresolved tensions.

Exclude anything insubstantial, fluff, or events already covered in prior_context.

Write in short *phrases* — up to 20; final response must be a single line:`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    let visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) ghostedCount++;
        if (m.is_hidden || m.is_system) hiddenCount++;
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    // Check for messages that should have been ghosted but aren't
    const unghosteredSummarized = visibleIndices.filter(idx => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace('  ⚠️ WARNING: Found ' + unghosteredSummarized.length + ' visible messages that are BEFORE summarizedUpTo!');
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    const settings = extensionSettings[MODULE_NAME];
    settings.embModel = EMBEDDING_MODEL;
    if (!settings.recallRadiusMigrated) {
        if (settings.recallWindowRadius === 2) settings.recallWindowRadius = defaultSettings.recallWindowRadius;
        settings.recallRadiusMigrated = true;
    }
    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        };
    }
    const store = chatMetadata[MODULE_NAME];

    // Existing migrations
    if (!Array.isArray(store.layers)) store.layers = [];
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];

    // Editable memory center: user notes + stable ids for every snippet.
    if (!Array.isArray(store.memoryNotes)) store.memoryNotes = [];
    if (!Number.isInteger(store.memorySeq)) store.memorySeq = 0;

    // Migrate summarizedUpTo if missing/invalid (e.g. store written by
    // another version of the extension). Comparing against undefined
    // yields NaN → always false → every turn looks "already summarized"
    // while nothing is.
    if (!Number.isInteger(store.summarizedUpTo)) {
        const layer0 = Array.isArray(store.layers[0]) ? store.layers[0] : [];
        const ends = layer0.map(sn => sn?.turnRange?.[1]).filter(Number.isInteger);
        store.summarizedUpTo = ends.length ? Math.max(...ends) : -1;
        log(`Store migration: summarizedUpTo was missing/invalid → derived ${store.summarizedUpTo}`);
    }

    return store;
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
async function repairGhostingForRange(startIdx, endIdx) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;

    // ── Phase 1: Mark metadata ──
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (m.extra?.sc_ghosted) continue;
        if (m.is_hidden && !m.extra?.sc_ghosted) continue;  // user-hidden
        if (m.is_system || !m.mes?.trim()) continue;
        if (m.is_user) continue;

        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }
        repaired++;
    }

    // ── Phase 2: Single range-based /hide ──
    if (!s.disableGhosting && repaired > 0) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(
                `/hide ${startIdx}-${endIdx}`,
                { showOutput: false }
            );
        } catch (e) {
            console.error(LOG_PREFIX, `Failed to ghost range ${startIdx}-${endIdx}:`, e);
        }
    }

    await saveChatStore();
    trace(' Repaired:', repaired);
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

async function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;
    if (!msg.extra) msg.extra = {};
    if (msg.extra.sc_ghosted) return;

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    if (!store.ghostedIndices.includes(messageIndex)) {
        store.ghostedIndices.push(messageIndex);
    }

    // Only visually hide if ghosting is enabled
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${messageIndex}`, { showOutput: false });
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
}

async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Collect indices to unhide
    const toUnhide = store.ghostedIndices && store.ghostedIndices.length > 0
    ? [...store.ghostedIndices]
    : [];

    // Fallback for older saves
    if (toUnhide.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                toUnhide.push(i);
            }
        }
    }

    if (toUnhide.length === 0) return;

    // ── Clear metadata first ──
    for (const idx of toUnhide) {
        if (idx >= 0 && idx < chat.length && chat[idx]?.extra?.sc_ghosted) {
            delete chat[idx].extra.sc_ghosted;
        }
    }

    // ── Single range-based /unhide ──
    // Find the contiguous range (or use min-max for simplicity;
    // /unhide on already-unhidden messages is a no-op)
    const minIdx = Math.min(...toUnhide);
    const maxIdx = Math.max(...toUnhide);

    const progressToast = toastr.info(
        `Unhiding messages ${minIdx}–${maxIdx}...`,
        'Summaryception — Clearing',
        { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
    );

    try {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(
            `/unhide ${minIdx}-${maxIdx}`,
            { showOutput: false }
        );
    } catch (e) {
        log(`Failed to unhide range ${minIdx}-${maxIdx}:`, e);
    }

    store.ghostedIndices = [];
    toastr.clear(progressToast);
    log(`Unghosted ${toUnhide.length} messages via range command`);
}

// ─── REPLACE ghostMessagesUpTo() ─────────────────────────────────────

async function ghostMessagesUpTo(endIndex, startIndex = 0) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    // ── Phase 1: Mark metadata (fast, no DOM/command overhead) ──
    let newlyGhosted = 0;
    const rangeStart = startIndex;  // Only process from startIndex
    const rangeEnd = endIndex;

    for (let i = rangeStart; i <= rangeEnd; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;
        if (!msg.extra) msg.extra = {};
        if (msg.extra.sc_ghosted) continue;

        // Skip messages already hidden by the user (not by us)
        if (msg.is_hidden) {
            log(`Skipping message ${i} — already hidden by user`);
            continue;
        }

        msg.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        newlyGhosted++;
    }

    // ── Phase 2: Single range-based /hide command (the expensive part) ──
    if (!s.disableGhosting && newlyGhosted > 0) {
        try {
            // SillyTavern /hide supports inclusive ranges: /hide start-end
            await SillyTavern.getContext().executeSlashCommandsWithOptions(
                `/hide ${rangeStart}-${rangeEnd}`,
                { showOutput: false }
            );
        } catch (e) {
            console.error(LOG_PREFIX, `Failed to hide range ${rangeStart}-${rangeEnd}:`, e);
        }
    }

    log(`Ghosted messages ${rangeStart}–${rangeEnd} (${newlyGhosted} newly marked)${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`);
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect if the current chat was branched before the summarized point.
 * When ST creates a branch at message N, it copies messages 0..N into a new chat file.
 * But chatMetadata (including our store) is copied as-is, so summarizedUpTo might
 * point beyond the end of the new chat, and snippets may reference turns that
 * no longer exist in this branch.
 *
 * This function detects that condition and trims our store to match reality.
 */
async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0) return;
    if (store.summarizedUpTo < 0) return;

    const chatLength = chat.length;

    // If summarizedUpTo is beyond (or at) the end of the chat, we branched
    if (store.summarizedUpTo >= chatLength) {
        const oldSummarizedUpTo = store.summarizedUpTo;
        log(`Branch detected! summarizedUpTo (${oldSummarizedUpTo}) >= chat length (${chatLength}). Repairing...`);

        // Find the safe cutoff — the last message index that actually exists
        const safeCutoff = chatLength - 1;

        // Remove Layer 0 snippets whose turnRange extends beyond the branch point
        if (store.layers[0]) {
            const before = store.layers[0].length;
            store.layers[0] = store.layers[0].filter(sn => {
                if (sn.pinned) return true; // user-pinned memories survive branch repair
                if (!sn.turnRange) return true; // promoted snippets without turnRange are kept
                return sn.turnRange[1] < chatLength;
            });
            const removed = before - store.layers[0].length;
            if (removed > 0) {
                log(`Removed ${removed} Layer 0 snippets that referenced turns beyond branch point`);
            }
        }

        // Recalculate summarizedUpTo based on remaining snippets
        if (store.layers[0] && store.layers[0].length > 0) {
            const maxEnd = Math.max(...store.layers[0]
            .filter(sn => sn.turnRange)
            .map(sn => sn.turnRange[1]));
            store.summarizedUpTo = maxEnd;
        } else {
            store.summarizedUpTo = -1;
        }

        // Trim ghostedIndices to only include valid indices
        if (store.ghostedIndices) {
            store.ghostedIndices = store.ghostedIndices.filter(idx => idx < chatLength);
        }

        await saveChatStore();

        log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}`);

        toastr.info(
            `Branch detected — trimmed ${oldSummarizedUpTo - store.summarizedUpTo} turns of stale summary data that referenced messages beyond the branch point.`,
            'Summaryception — Branch Repair',
            { timeOut: TUNING.toastExtended }
        );
    }
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Build passage text from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 */
function buildPassageFromRange(chat, startIdx, endIdx) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) continue;

        const speaker = m.is_user ? 'Player' : 'Assistant';
        lines.push(`${speaker}: ${m.mes.trim()}`);
    }
    return lines.join('\n');
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;

function abortSummarization() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const prompt = s.summarizerUserPrompt
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                const result = await Promise.race([
                    sendSummarizerRequest(s, s.summarizerSystemPrompt, prompt),
                    new Promise((_, reject) => {
                        const timer = setTimeout(() => reject(new Error('Request timed out after 120s')), TUNING.llmRequestTimeout);
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted by user'));
                        });
                    }),
                ]);

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

                let trimmed = (result || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                return trimmed;

            } catch (err) {
                lastError = err;
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: TUNING.toastError }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.pauseSummarization) return;
    if (isSummarizing) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

    // 分段滚动：窗口按整段推进，而不是每轮滑出一条。
    // 每轮滑一条会让注入前缀从第一条起就不再匹配，整段可见历史等于每轮重新计费。
    const segment = Math.max(1, Math.floor(Number(s.summarySegmentTurns) || Number(s.verbatimTurns) || 10));
    const windowCeiling = s.verbatimTurns + segment;

    log(`Visible assistant turns: ${visibleTurns.length}, keep: ${s.verbatimTurns}–${windowCeiling}`);

    if (visibleTurns.length <= windowCeiling) return;

    const overflow = visibleTurns.length - windowCeiling;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * TUNING.backlogMultiplier;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > windowCeiling && remaining.length - windowCeiling <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatch');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatch - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatch - EMPTY BATCH');
        return false;
    }

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        if (!store.layers[0]) store.layers[0] = [];
        const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

        // ─── SANITY CHECK ───
        if (passageStart > endIdx) {
            log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
            trace('<<< EXITING summarizeOneBatch - PASSAGE START GREATER THAN END');
            return false;
        }

        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeOneBatch - EMPTY PASSAGE');
            // --- FIX: Advance pointer and save so it doesn't try this empty batch again next turn ---
            store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
            await saveChatStore();
            return true; // Return true so it doesn't think the cycle crashed
        }

        const contextStr = buildFullContext(0);

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: TUNING.toastMedium,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeOneBatch - EMPTY SUMMARY');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        await ghostMessagesUpTo(endIdx, passageStart);

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: TUNING.toastDefault });
        trace('<<< EXITING summarizeOneBatch - SUCCESS');
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

async function summarizeOneBatchFromTurns(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatchFromTurns - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    trace('  batchSize:', batchSize);
    trace('  batch prepared:', batch.length);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    if (!store.layers[0]) store.layers[0] = [];

    // ─── Start from the message AFTER the last summarized one ───
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    trace('  passageStart:', passageStart, 'endIdx:', endIdx);

    // ─── SANITY CHECK: passageStart should always be <= endIdx ───
    if (passageStart > endIdx) {
        trace('  CRITICAL: passageStart > endIdx! This should never happen.');
        trace('  This likely means the batch was already summarized.');
        trace('<<< EXITING - passageStart > endIdx');
        return 'EMPTY_SKIP';
    }

    trace('  About to call buildPassageFromRange...');

    try {
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  buildPassageFromRange returned, length:', storyTxt?.length ?? 'UNDEFINED');

        if (!storyTxt.trim()) {
            trace('  <<< EXITING - storyTxt is empty after trim');
            trace('  This suggests all messages in range [' + passageStart + ', ' + endIdx + '] are hidden or empty');

            // --- FIX: Advance pointer so we don't get stuck on these empty indexes ---
            store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
            await saveChatStore();

            return 'EMPTY_SKIP';
        }

        trace('  About to call buildFullContext...');
        const contextStr = buildFullContext(0);
        trace('  buildFullContext returned, length:', contextStr?.length ?? 'UNDEFINED');

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  callSummarizer returned, length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('  <<< EXITING - summary is empty');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

        await saveChatStore();
        await ghostMessagesUpTo(endIdx, passageStart);
        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        trace('<<< EXITING summarizeOneBatchFromTurns - SUCCESS');
        return true;

    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeOneBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeOneBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {

    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            trace(`  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`);

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const result = await summarizeOneBatchFromTurns(currentVisible);

            if (result === true) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
            } else if (result === 'EMPTY_SKIP') {
                trace('  >>> summarizeOneBatchFromTurns returned EMPTY_SKIP (skipping empty system/hidden cards)');
                consecutiveFailures = 0;
            } else {
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= TUNING.consecutiveFailureLimit) {
                    toastr.error(
                        `${TUNING.consecutiveFailureLimit} consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.`,
                        'Summaryception',
                        { timeOut: TUNING.toastError }
                    );
                    trace(`  ${TUNING.consecutiveFailureLimit} consecutive failures, breaking`);
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, TUNING.catchupInterBatchDelay));
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: TUNING.toastLong }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: TUNING.toastExtended }
            );
        }

        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seedPos = layer.findIndex(sn => !sn.pinned);
        if (seedPos < 0) {
            log(`Layer ${layerIndex}: every snippet is pinned, promotion skipped.`);
            return;
        }
        const [seed] = layer.splice(seedPos, 1);
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: TUNING.toastDefault }
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    // Pinned snippets are user-owned: never merge them away.
    const picks = [];
    for (let i = 0; i < layer.length && picks.length < s.snippetsPerPromotion; i++) {
        if (!layer[i].pinned) picks.push(i);
    }
    if (picks.length < s.snippetsPerPromotion) {
        log(`Layer ${layerIndex}: only ${picks.length} unlocked snippet(s), promotion skipped.`);
        return;
    }
    const toMerge = picks.map(i => layer[i]);
    for (let k = picks.length - 1; k >= 0; k--) layer.splice(picks[k], 1);
    const storyTxt = toMerge.map(sn => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: TUNING.toastMedium, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

/** 最近一次召回层的统计，供 UI / 调试读取。 */
let _lastRecallStats = null;

/**
 * 摘要链（spine）：所有层级的片段，深层（更古老）在前，Layer 0（较新）在后。
 * 这一段保证"叙事不断片"，不参与检索，始终完整注入。
 */
function buildSpineText(store) {
    if (!store || !Array.isArray(store.layers)) return '';
    if (store.layers.every(l => !l || l.length === 0)) return '';

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            snippets.push(sn.text);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn.text);
        }
    }

    return snippets.filter(Boolean).join(' ');
}

/** User-authored memories: always injected, never merged or rewritten. */
function buildMemoryNotesText(store) {
    const notes = Array.isArray(store?.memoryNotes) ? store.memoryNotes : [];
    return notes
        .filter(note => note && String(note.text || '').trim())
        .map(note => `[remembered] ${String(note.text).trim()}`)
        .join('\n');
}

/**
 * 细节召回（detail）：对已 ghost 的原始消息做 BM25 检索，
 * 把和当前对话最相关的原文按 token 预算塞回来。
 *
 * 这是相对上游唯一的行为改变：以前被压缩掉的细节只能靠摘要写到了，
 * 现在只要关键词/语义有重叠，原文还能被重新拉进上下文。
 */
// 当轮没有可用的混合结果时，注入当轮 BM25；绝不复用旧查询的文本。
let _recallCache = null;
let _lexicalRecallCache = null;
let _recallJob = null;
let _recallEpoch = 0;
let _vecIndexBusy = false;
let _vecRebuildBusy = false;
let _messageRevisionId = 0;
const _messageRevisions = new WeakMap();

function clearRecallCache() {
    _recallEpoch++;
    _recallCache = null;
    _lexicalRecallCache = null;
    _lastRecallStats = null;
    if (typeof _recallReuse !== 'undefined') _recallReuse = null;
}

/** 会话级稳定 key：换 chat 就换 key，向量不会串到别的存档。 */
function getChatKey() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata || {};
    const charId = ctx.characterId ?? ctx.this_chid ?? 'x';
    const chatId = ctx.chatId || meta.name || '';
    if (chatId) return `${charId}::${chatId}`;
    const first = (ctx.chat && ctx.chat[0] && ctx.chat[0].mes) || '';
    let h = 0;
    for (let i = 0; i < first.length; i++) h = (h * 31 + first.charCodeAt(i)) | 0;
    return `${charId}::h${h}`;
}

function messageRevision(msg) {
    if (!msg || typeof msg !== 'object') return 0;
    let known = _messageRevisions.get(msg);
    if (!known || known.text !== msg.mes || known.role !== msg.is_user || known.system !== msg.is_system) {
        known = { text: msg.mes, role: msg.is_user, system: msg.is_system, id: ++_messageRevisionId };
        _messageRevisions.set(msg, known);
    }
    return known.id;
}

function embeddingNamespace(s) {
    const url = String(s.embUrl || '').trim().replace(/\/+$/, '').replace(/\/embeddings$/i, '');
    return url ? JSON.stringify([url, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS]) : '';
}

function vectorInput(msg) {
    if (!msg || msg.is_user === undefined || typeof msg.mes !== 'string') return '';
    const text = msg.mes.trim();
    return text.length >= 8 ? text.slice(0, 3000) : '';
}

function recallSettingsFingerprint(s) {
    return JSON.stringify([s.recallBudgetTokens, s.recallTopK, s.recallMinScore, s.recallHalfLife,
        s.recallQueryTurns, s.recallWeightVector, s.recallWeightLexical, s.recallTimeLabels,
        s.recallWindowRadius, s.recallRrfK]);
}

function recallQuery(chat, store, s) {
    return SCRecall.buildQueryText(chat, Math.max(1, Number(s.recallQueryTurns) || 3),
        new Set(store.ghostedIndices || []));
}

function recallCacheKey(chat, store, s) {
    const ghosted = store.ghostedIndices || [];
    return JSON.stringify([_recallEpoch, getChatKey(), chat.length, embeddingNamespace(s),
        recallSettingsFingerprint(s), recallQuery(chat, store, s),
        ghosted.map(i => [i, messageRevision(chat[i])])]);
}

/**
 * 跨轮复用：查询几乎没变时直接沿用上轮召回文本。
 * 内容不变，注入前缀就不会被它打断；同时省掉一次 embedding 与检索。
 * 守门条件是「查询相似 + 压缩只前进了一点点 + 旧消息没被改过」，
 * 避免为了缓存而把上一轮的记忆一直用到跑题。
 */
let _recallReuse = null;

function querySimilarity(a, b) {
    const A = new Set(SCRecall.tokenize(a || ''));
    const B = new Set(SCRecall.tokenize(b || ''));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return shared / (A.size + B.size - shared);
}

function recallReuseCandidate(chat, store, s) {
    const prev = _recallReuse;
    if (!prev?.text) return null;
    if (prev.chatKey !== getChatKey()) return null;
    if (prev.namespace !== embeddingNamespace(s)) return null;
    if (prev.fingerprint !== recallSettingsFingerprint(s)) return null;

    const ghosted = store.ghostedIndices || [];
    const added = ghosted.length - prev.ghostRevisions.length;
    if (added < 0 || added > TUNING.recallReuseMaxNewGhosts) return null;
    for (let i = 0; i < prev.ghostRevisions.length; i++) {
        if (messageRevision(chat[ghosted[i]]) !== prev.ghostRevisions[i]) return null;
    }

    const minSimilarity = Number(s.recallReuseMinSimilarity ?? TUNING.recallReuseMinSimilarity);
    if (!(minSimilarity > 0)) return null;   // 0 或非法值 = 关闭复用，每轮重新检索

    const similarity = querySimilarity(prev.query, recallQuery(chat, store, s));
    return similarity >= minSimilarity ? { ...prev, similarity } : null;
}

function rememberRecallReuse(chat, store, s, text, stats) {
    if (!text) { _recallReuse = null; return; }
    _recallReuse = {
        chatKey: getChatKey(),
        namespace: embeddingNamespace(s),
        fingerprint: recallSettingsFingerprint(s),
        query: recallQuery(chat, store, s),
        ghostRevisions: (store.ghostedIndices || []).map(i => messageRevision(chat[i])),
        text,
        stats,
        at: Date.now(),
    };
}

function syncEmbedderConfig() {
    const embedder = window.SCEmbedding && window.SCEmbedding.client;
    if (!embedder) return null;
    // #397：地址与 Key 不再由记忆模块持有，请求走 app 的 API 层（当前渠道的 baseUrl + 鉴权头 + 超时）
    embedder.configure({ model: EMBEDDING_MODEL });
    return embedder;
}

function buildRecallText(chat, store, settings) {
    const s = settings || getSettings();
    if (!s.recallEnabled || typeof SCRecall === 'undefined') { _lastRecallStats = null; return ''; }
    const key = recallCacheKey(chat, store, s);
    if (_recallCache?.key === key) {
        _lastRecallStats = _recallCache.stats;
        return _recallCache.text;
    }
    const reuse = recallReuseCandidate(chat, store, s);
    if (reuse) {
        _recallCache = { key, text: reuse.text,
            stats: { ...reuse.stats, reused: true, reuseSimilarity: reuse.similarity } };
        _lastRecallStats = _recallCache.stats;
        return reuse.text;
    }

    if (_lexicalRecallCache?.key !== key) {
        _lexicalRecallCache = { key, ...SCRecall.recallSync({ chat, store, settings: s }) };
    }
    _lastRecallStats = _lexicalRecallCache.stats;
    rememberRecallReuse(chat, store, s, _lexicalRecallCache.text, _lexicalRecallCache.stats);
    return _lexicalRecallCache.text;
}

/** At most one live query request; no stale query is queued behind it. */
function refreshRecall() {
    const s = { ...getSettings() };
    if (!s.enabled || !s.recallEnabled || !(Number(s.recallBudgetTokens) > 0)
        || typeof SCRecall === 'undefined' || _vecRebuildBusy) return Promise.resolve();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const key = recallCacheKey(chat, store, s);
    if (_recallCache?.key === key) return Promise.resolve();
    if (_recallJob) return _recallJob.key === key ? _recallJob.promise : Promise.resolve();

    const embedder = syncEmbedderConfig();
    const vstore = window.SCVectorStore;
    if (!embedder?.configured || !vstore) return Promise.resolve();
    const chatKey = getChatKey();
    const namespace = embeddingNamespace(s);
    const ghostedIndices = [...(store.ghostedIndices || [])];
    const expectedTexts = new Map();
    for (const idx of ghostedIndices) {
        const text = vectorInput(chat[idx]);
        if (text) expectedTexts.set(idx, text);
    }
    if (!expectedTexts.size) return Promise.resolve();
    const snapshot = chat.map(msg => msg && ({ mes: msg.mes, is_user: msg.is_user, is_system: msg.is_system }));
    const stillCurrent = () => {
        const live = getSettings();
        return live.enabled && live.recallEnabled
            && recallCacheKey(SillyTavern.getContext().chat, getChatStore(), live) === key;
    };
    const job = { key, promise: null };
    _recallJob = job;
    job.promise = (async () => {
        const bucket = await vstore.loadAll(chatKey);
        if (!stillCurrent() || !Array.from(expectedTexts).some(([idx, text]) => {
            const rec = bucket.get(idx);
            return rec?.namespace === namespace && rec.text === text && rec.vec?.length === EMBEDDING_DIMENSIONS;
        })) return;
        const result = await SCRecall.recallAsync({ chat: snapshot, store: { ghostedIndices }, settings: s,
            chatKey, vectorOptions: { namespace, expectedTexts } });
        if (!stillCurrent()) return;
        _recallCache = { key, ...result };
        rememberRecallReuse(SillyTavern.getContext().chat, getChatStore(), getSettings(), result.text, result.stats);
        updateInjection();
    })().catch(e => log('refreshRecall error:', e)).finally(() => {
        if (_recallJob === job) _recallJob = null;
    });
    return job.promise;
}

/**
 * 把还没向量化的 ghost 消息补进 IndexedDB。
 * 分批、串行、失败即停（下一轮继续）；单次最多处理 maxPerRun 条，避免长时间占用。
 */
async function ensureVectors(maxPerRun = 200, { rebuilding = false } = {}) {
    if (_vecIndexBusy || (_vecRebuildBusy && !rebuilding)) return 0;
    const s = getSettings();
    if (!rebuilding && (!s.enabled || !s.recallEnabled)) return 0;
    const embedder = syncEmbedderConfig();
    const vstore = window.SCVectorStore;
    if (!embedder || !embedder.configured || !vstore) return 0;

    _vecIndexBusy = true;
    let done = 0;
    try {
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        const chatKey = getChatKey();
        const namespace = embeddingNamespace(s);
        const epoch = _recallEpoch;
        const currentIndex = () => {
            const live = getSettings();
            return (rebuilding || (live.enabled && live.recallEnabled)) && getChatKey() === chatKey
                && _recallEpoch === epoch && embeddingNamespace(live) === namespace;
        };
        const bucket = await vstore.loadAll(chatKey);

        const missing = [];
        for (const i of (store.ghostedIndices || [])) {
            const text = vectorInput(chat[i]);
            if (!text) continue;
            const rec = bucket.get(i);
            if (rec?.namespace === namespace && rec.text === text && rec.vec?.length === EMBEDDING_DIMENSIONS) continue;
            missing.push({ idx: i, text });
            if (missing.length >= maxPerRun) break;
        }
        if (missing.length === 0) return 0;

        const batchSize = Math.max(1, Number(s.embBatchSize) || 16);
        for (let i = 0; i < missing.length; i += batchSize) {
            const chunk = missing.slice(i, i + batchSize);
            if (!currentIndex()) break;
            try {
                // #397：embedBatch 不抛错，失败返回空 vectors + 原因 —— 本轮直接停，下一轮再试
                const embedded = await embedder.embedBatch(chunk.map(c => c.text));
                if (!currentIndex()) break;
                if (!embedded.ok || !embedded.vectors.length) {
                    log(`vector indexing stopped at batch ${i / batchSize}: embedding unavailable (${embedded.reason}${embedded.detail ? `: ${embedded.detail}` : ''})`);
                    break;
                }
                const vecs = embedded.vectors;
                const live = SillyTavern.getContext().chat;
                const ghosted = new Set(getChatStore().ghostedIndices);
                const rows = chunk
                    .map((c, j) => ({ ...c, vec: vecs[j] }))
                    .filter(r => Array.isArray(r.vec) && r.vec.length === EMBEDDING_DIMENSIONS
                        && ghosted.has(r.idx) && vectorInput(live[r.idx]) === r.text);
                if (rows.length === 0) break;
                await vstore.putMany(chatKey, rows, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, namespace);
                if (!currentIndex()) break;
                embedder._dimensions = EMBEDDING_DIMENSIONS;
                embedder._ready = true;
                done += rows.length;
            } catch (err) {
                log(`vector indexing stopped at batch ${i / batchSize}:`, err && err.message);
                break;
            }
        }
        if (done > 0) log(`vector index: +${done} (queued ${missing.length})`);
    } catch (e) {
        log('ensureVectors error:', e);
    } finally {
        _vecIndexBusy = false;
    }
    return done;
}

/**
 * 同一份记忆拆成两段注入，因为前缀缓存只认从 prompt 开头连续相同的部分：
 *   stable — 摘要链 + 用户笔记，内容极少变化，放系统段最前；
 *   recall — 本轮回召，每轮都变，放聊天最末端。
 * 旧行为是合成一块插在聊天中间（depth 12）：它既随着 10 轮滑动窗口移动，
 * 又把后面的消息全部作废，等于每轮都在为整段历史重新付费。
 */
function buildInjectionBlocks() {
    const s = getSettings();
    const store = getChatStore();

    const summaryText = [buildSpineText(store), buildMemoryNotesText(store)]
        .filter(Boolean)
        .join('\n');

    let chat = [];
    try {
        chat = SillyTavern.getContext().chat || [];
    } catch (e) {
        trace('buildInjectionBlocks: no chat available', e);
    }
    const recalled = buildRecallText(chat, store, s);

    const template = s.injectionTemplate || '{{summary}}';
    const split = template.includes('{{recalled}}');
    const stable = summaryText
        ? template.replace('{{summary}}', summaryText).replace('{{recalled}}', '').trimEnd()
        : '';
    const recall = recalled
        ? (split ? template.replace('{{summary}}', '').replace('{{recalled}}', recalled).trim() : recalled)
        : '';
    return { stable, recall };
}

/** 预览/复制用：两段按注入顺序拼起来。 */
function assembleSummaryBlock() {
    const { stable, recall } = buildInjectionBlocks();
    return [stable, recall].filter(Boolean).join('\n');
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjected = '';

function updateInjection() {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        const s = getSettings();
        const write = (key, text, position, depth) => setExtensionPrompt(key,
            text || '', position, depth, TUNING.injectionScan, TUNING.injectionRole);
        const stableKey = `${MODULE_NAME}_stable`;
        const recallKey = `${MODULE_NAME}_recall`;

        if (!s.enabled) {
            if (_lastInjected !== '') {
                write(stableKey, '', TUNING.stableInjectionPosition, TUNING.stableInjectionDepth);
                write(recallKey, '', TUNING.recallInjectionPosition, TUNING.recallInjectionDepth);
                _lastInjected = '';
            }
            return;
        }

        const { stable, recall } = buildInjectionBlocks();
        const signature = `${stable}\u0000${recall}`;
        if (signature === _lastInjected) return;

        write(stableKey, stable, TUNING.stableInjectionPosition, TUNING.stableInjectionDepth);
        write(recallKey, recall, TUNING.recallInjectionPosition, TUNING.recallInjectionDepth);
        _lastInjected = signature;

        log(`Injection updated: stable ${stable.length} chars, recall ${recall.length} chars`);
    } catch (e) {
        log('updateInjection error:', e);
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            const chatKey = getChatKey();
            setTimeout(async () => {
                if (getChatKey() !== chatKey) return;
                await maybeSummarizeTurns();
                if (getChatKey() !== chatKey) return;
                if (getSettings().recallEnabled) ensureVectors().catch(e => log('ensureVectors error:', e));
                updateInjection();
                updateUI();
            }, TUNING.messageReceivedDelay);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    log('Chat changed.');
    catchupDismissed = false;
    clearRecallCache();
    updateInjection();
    const epoch = _recallEpoch;
    setTimeout(async () => {
        if (_recallEpoch !== epoch) return;
        await repairIfBranched();
        if (_recallEpoch !== epoch) return;
        if (getSettings().recallEnabled) ensureVectors().catch(e => log('ensureVectors error:', e));
        updateInjection();
        updateUI();
    }, TUNING.chatChangedDelay);
}

function onGenerationStarted() {
    updateInjection();
}

async function onMessageSent() {
    updateInjection(); // Already installed even if the cloud is slow or unavailable.
    let timer;
    try {
        await Promise.race([refreshRecall(), new Promise(resolve => { timer = setTimeout(resolve, RECALL_WAIT_MS); })]);
    } finally {
        clearTimeout(timer);
    }
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                if (getSettings().recallEnabled) {
                    lines.push(`Ghosted (recallable): ${(store.ghostedIndices || []).length}`);
                    const rs = _lastRecallStats;
                    lines.push(rs
                        ? `Last recall: ${rs.hits} block(s), ~${rs.tokens} tokens, mode=${rs.mode || '?'}`
                          + `${rs.vecCount ? `, vec-hits=${rs.vecCount}` : ''}${rs.reason ? ` (${rs.reason})` : ''}`
                          + `${rs.fallbackReason ? ` (fallback: ${rs.fallbackReason})` : ''}`
                        : 'Last recall: not run yet');
                    const eb = window.SCEmbedding && window.SCEmbedding.client;
                    // #397：不可用时带上可诊断原因（渠道不支持 / 没配 Key / 上次失败），不只是一句「未配置」
                    lines.push(eb && eb.configured
                        ? `Embedding: ${eb.model}${eb.ready ? ` (${eb.dimensions}d, ready)` : ` (未探测${eb.reason ? `, 上次失败: ${eb.reason}` : ''})`}`
                        : `Embedding: 未配置（${(eb && window.SCEmbedding.reasonText(eb.configReason)) || '召回退化为纯 BM25'}）`);
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                store.summarizedUpTo = -1;
                store.ghostedIndices = [];

                const { chatMetadata } = SillyTavern.getContext();
                chatMetadata[MODULE_NAME] = store;

                await saveChatStore();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

/**
 * 纯文本运行状态：窗口推进位置 + 本轮召回是否复用。
 * 放在已有的 Layer Stats 区块里，不需要新控件或新页面。
 */
function memoryRunStatusLine() {
    const s = getSettings();
    let windowPart = '';
    try {
        const { chat } = SillyTavern.getContext();
        const visible = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted).length;
        const segment = Math.max(1, Math.floor(Number(s.summarySegmentTurns) || Number(s.verbatimTurns) || 10));
        windowPart = `Window: ${visible} visible turn(s), rolls in blocks of ${segment} (keep ${s.verbatimTurns}–${s.verbatimTurns + segment})`;
    } catch (e) {
        return '';
    }
    const stats = _lastRecallStats;
    const reusePart = stats?.reused
        ? `Recall: reused (similarity ${Number(stats.reuseSimilarity || 0).toFixed(2)})`
        : 'Recall: fresh search';
    return `<div class="sc-layer-stat sc-muted">${windowPart} · ${reusePart}</div>`;
}

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        // ── Detail Recall Layer ──
        $('#sc_recall_enabled').prop('checked', s.recallEnabled);
        $('#sc_recall_budget').val(s.recallBudgetTokens);
        $('#sc_recall_budget_val').text(s.recallBudgetTokens);
        $('#sc_recall_topk').val(s.recallTopK);
        $('#sc_recall_topk_val').text(s.recallTopK);
        $('#sc_recall_min_score').val(Math.round(s.recallMinScore * 100));
        $('#sc_recall_min_score_val').text(Number(s.recallMinScore).toFixed(2));
        $('#sc_recall_half_life').val(s.recallHalfLife);
        $('#sc_recall_half_life_val').text(s.recallHalfLife);
        $('#sc_recall_query_turns').val(s.recallQueryTurns);
        $('#sc_recall_query_turns_val').text(s.recallQueryTurns);
        $('#sc_recall_weight_vector').val(Math.round((s.recallWeightVector ?? 0.7) * 100));
        $('#sc_recall_weight_vector_val').text(Number(s.recallWeightVector ?? 0.7).toFixed(2));
        $('#sc_recall_weight_lexical').val(Math.round((s.recallWeightLexical ?? 0.3) * 100));
        $('#sc_recall_weight_lexical_val').text(Number(s.recallWeightLexical ?? 0.3).toFixed(2));
        $('#sc_recall_time_labels').prop('checked', Boolean(s.recallTimeLabels));
        $('#sc_emb_url').val(s.embUrl);
        $('#sc_emb_key').val(s.embKey);
        $('#sc_emb_model').val(s.embModel);
        $('#sc_emb_batch').val(s.embBatchSize);
        $('#sc_emb_batch_val').text(s.embBatchSize);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        // ── Prompt preset migration & sync ──
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
        } catch (e) { /* no chat loaded */ }

        let statsHtml = '';
        if (s.disableGhosting) {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (metadata only — not visually hidden)</div>`;
        } else {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        }
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        statsHtml += memoryRunStatusLine();

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateMemoryCenter();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append(
            $('<option></option>')
            .val(name)
            .text(`${name}`)
            .attr('title', preview)
        );
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

// ─── Memory Center (editable memory) ─────────────────────────────────

let _memoryQuery = '';
let _memoryFilter = 'all';

/** Stable ids: editing by array index breaks as soon as a snippet is promoted. */
function ensureMemoryIds(store) {
    let changed = false;
    for (const layer of store.layers || []) {
        for (const sn of layer || []) {
            if (sn && !sn.id) { sn.id = `sn_${++store.memorySeq}`; changed = true; }
        }
    }
    for (const note of store.memoryNotes || []) {
        if (note && !note.id) { note.id = `mn_${++store.memorySeq}`; changed = true; }
    }
    return changed;
}

function findMemoryTarget(kind, id) {
    const store = getChatStore();
    if (kind === 'note') {
        const noteIndex = (store.memoryNotes || []).findIndex(n => n && n.id === id);
        return noteIndex < 0 ? null : { kind: 'note', note: store.memoryNotes[noteIndex], noteIndex, id };
    }
    for (let i = 0; i < (store.layers || []).length; i++) {
        const layer = store.layers[i];
        if (!Array.isArray(layer)) continue;
        const layerIndex = layer.findIndex(sn => sn && sn.id === id);
        if (layerIndex >= 0) return { kind: 'snippet', sn: layer[layerIndex], layer: i, layerIndex, id };
    }
    return null;
}

/** Injection order: deepest (oldest) layer first, then Layer 0, then user notes. */
function memoryEntries(store) {
    const items = [];
    for (let i = (store.layers || []).length - 1; i >= 1; i--) {
        for (const sn of store.layers[i] || []) if (sn) items.push({ kind: 'snippet', sn, layer: i });
    }
    for (const sn of store.layers[0] || []) if (sn) items.push({ kind: 'snippet', sn, layer: 0 });
    for (const note of [...(store.memoryNotes || [])].reverse()) if (note) items.push({ kind: 'note', note });
    return items;
}

function memoryMatches(item) {
    const src = item.kind === 'note' ? item.note : item.sn;
    const q = _memoryQuery.trim().toLowerCase();
    if (q && !String(src.text || '').toLowerCase().includes(q)) return false;
    if (_memoryFilter === 'pinned') return item.kind === 'note' || Boolean(src.pinned);
    if (_memoryFilter === 'edited') return Boolean(src.userEdited);
    if (_memoryFilter === 'note') return item.kind === 'note';
    return true;
}

function memoryItemHtml(item) {
    const isNote = item.kind === 'note';
    const src = isNote ? item.note : item.sn;
    const bits = [isNote ? 'User note' : (item.layer === 0 ? 'L0 turn summary' : `L${item.layer} meta-summary`)];
    if (Array.isArray(src.turnRange)) bits.push(`turns ${src.turnRange[0]}–${src.turnRange[1]}`);
    else if (src.mergedCount) bits.push(`merged ${src.mergedCount}`);
    if (src.pinned) bits.push('📌 pinned');
    if (src.userEdited) bits.push('✏️ edited');

    const btn = (act, icon, title, cls = '') =>
        `<button class="sc-memory-btn ${cls}" data-act="${act}" title="${title}"><i class="fa-solid ${icon}"></i></button>`;

    return `<div class="sc-memory-item${src.pinned ? ' is-pinned' : ''}" data-kind="${item.kind}" data-id="${escapeHtml(String(src.id))}">
        <div class="sc-memory-meta">${bits.map(b => `<span>${escapeHtml(b)}</span>`).join('')}</div>
        <div class="sc-memory-text" title="Click to edit">${escapeHtml(String(src.text || ''))}</div>
        <div class="sc-memory-actions">
            ${btn('edit', 'fa-pen', 'Edit')}
            ${isNote ? '' : btn('pin', 'fa-thumbtack', src.pinned ? 'Unpin (allow promotion to merge it)' : 'Pin (never merge this away)')}
            ${src.userEdited ? btn('restore', 'fa-rotate-left', 'Restore the text from before your edit') : ''}
            ${!isNote && Array.isArray(src.turnRange) ? btn('jump', 'fa-location-arrow', 'Locate in chat') : ''}
            ${btn('delete', 'fa-trash', 'Forget this entry', 'is-danger')}
        </div>
    </div>`;
}

function updateMemoryCenter() {
    const store = getChatStore();
    if (ensureMemoryIds(store)) saveChatStore().catch(e => log('memory id save failed:', e));

    const all = memoryEntries(store);
    const shown = all.filter(memoryMatches);
    if (!shown.length) {
        const msg = all.length ? 'No entry matches this filter.' : 'Nothing remembered yet. Chat a few turns, or add a note above.';
        $('#sc_memory_list').html(`<div class="sc-muted sc-memory-empty">${msg}</div>`);
        return;
    }
    const head = `<div class="sc-memory-count">${all.length} entries · ${shown.length} shown · all of them go into the prompt</div>`;
    $('#sc_memory_list').html(head + shown.map(memoryItemHtml).join(''));
}

async function commitMemoryEdit(target, value) {
    const text = String(value || '').trim();
    if (!text) { updateMemoryCenter(); return; }
    if (target.kind === 'note') {
        if (target.note.text !== text) {
            target.note.text = text;
            target.note.updatedAt = Date.now();
        }
    } else {
        const sn = target.sn;
        if (sn.text !== text) {
            if (!sn.userEdited) sn.originalText = sn.text;
            sn.text = text;
            sn.userEdited = true;
            sn.updatedAt = Date.now();
        }
    }
    await saveChatStore();
    updateInjection();
    updateUI();
}

function startMemoryEdit($card) {
    if ($card.find('textarea').length) return;
    const target = findMemoryTarget(String($card.data('kind')), String($card.data('id')));
    if (!target) { updateMemoryCenter(); return; }
    const src = target.kind === 'note' ? target.note : target.sn;
    const state = { done: false };
    const finish = async value => {
        if (state.done) return;
        state.done = true;
        await commitMemoryEdit(target, value);
    };

    const $ta = $('<textarea class="sc-snippet-edit sc-memory-edit"></textarea>')
        .val(String(src.text || ''))
        .on('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                finish($(this).val());
            } else if (e.key === 'Escape') {
                state.done = true;
                updateMemoryCenter();
            }
        })
        .on('blur', function () { finish($(this).val()); });

    $card.find('.sc-memory-text').replaceWith($ta);
    $ta[0].style.height = 'auto';
    $ta[0].style.height = $ta[0].scrollHeight + 'px';
    $ta.trigger('focus').select();
}

function bindMemoryCenterEvents() {
    $(document).on('input', '#sc_memory_search', function () {
        _memoryQuery = String($(this).val() || '');
        updateMemoryCenter();
    });

    $(document).on('change', '#sc_memory_filter', function () {
        _memoryFilter = String($(this).val() || 'all');
        updateMemoryCenter();
    });

    $(document).on('click', '#sc_memory_add', async function () {
        const text = String($('#sc_memory_new').val() || '').trim();
        if (!text) {
            toastr.warning('Write something first.', 'Summaryception');
            return;
        }
        const store = getChatStore();
        store.memoryNotes.push({ id: `mn_${++store.memorySeq}`, text, createdAt: Date.now(), updatedAt: Date.now() });
        $('#sc_memory_new').val('');
        await saveChatStore();
        updateInjection();
        updateUI();
        toastr.success('Memory added', 'Summaryception', { timeOut: TUNING.toastShort });
    });

    $(document).on('click', '#sc_memory_list .sc-memory-text', function () {
        startMemoryEdit($(this).closest('.sc-memory-item'));
    });

    $(document).on('click', '#sc_memory_list [data-act]', async function () {
        const $card = $(this).closest('.sc-memory-item');
        const target = findMemoryTarget(String($card.data('kind')), String($card.data('id')));
        if (!target) { updateMemoryCenter(); return; }

        const action = String($(this).data('act'));
        const src = target.kind === 'note' ? target.note : target.sn;
        const store = getChatStore();

        if (action === 'edit') { startMemoryEdit($card); return; }

        if (action === 'pin') {
            src.pinned = !src.pinned;
        } else if (action === 'restore') {
            if (typeof src.originalText === 'string') src.text = src.originalText;
            delete src.originalText;
            src.userEdited = false;
        } else if (action === 'jump') {
            const idx = Array.isArray(src.turnRange) ? src.turnRange[0] : null;
            const el = idx === null ? null : document.querySelector(`.mes[mesid="${idx}"]`);
            if (!el) {
                toastr.info('That chat message is no longer there.', 'Summaryception');
                return;
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('sc-memory-flash');
            setTimeout(() => el.classList.remove('sc-memory-flash'), 1600);
            return;
        } else if (action === 'delete') {
            if (target.kind === 'note') {
                store.memoryNotes.splice(target.noteIndex, 1);
            } else {
                store.layers[target.layer].splice(target.layerIndex, 1);
                if (target.layer === 0) {
                    const ends = (store.layers[0] || []).filter(sn => sn.turnRange).map(sn => sn.turnRange[1]);
                    store.summarizedUpTo = ends.length ? Math.max(...ends) : -1;
                }
            }
        }

        await saveChatStore();
        updateInjection();
        updateUI();
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bindUIEvents() {
    $(document).on('change', '#sc_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: TUNING.toastMedium }
            );
        }
    });

    $(document).on('change', '#sc_disable_ghosting', function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();

        if ($(this).prop('checked')) {
            toastr.info(
                'Message hiding disabled. Summarized messages will remain visible but still be excluded from LLM context via the sc_ghosted flag.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        }
    });

    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
        // ── Detail Recall Layer（recall.js）──
        { id: '#sc_recall_budget', key: 'recallBudgetTokens', display: '#sc_recall_budget_val' },
        { id: '#sc_recall_topk', key: 'recallTopK', display: '#sc_recall_topk_val' },
        { id: '#sc_recall_min_score', key: 'recallMinScore', display: '#sc_recall_min_score_val', scale: 100 },
        { id: '#sc_recall_half_life', key: 'recallHalfLife', display: '#sc_recall_half_life_val' },
        { id: '#sc_recall_query_turns', key: 'recallQueryTurns', display: '#sc_recall_query_turns_val' },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            // 分数类滑块内部用整数（15）表示小数（0.15），避免 range 的小数步进问题
            getSettings()[sl.key] = sl.scale ? val / sl.scale : val;
            $(sl.display).text(sl.scale ? (val / sl.scale).toFixed(2) : val);
            saveSettings();
            updateInjection();
        });
    }

    $(document).on('change', '#sc_recall_enabled', function () {
        getSettings().recallEnabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
        if (getSettings().recallEnabled) refreshRecall().catch(e => log('refreshRecall error:', e));
    });

    // 混合权重：两个滑块，改了就以新权重重算一次
    const recallWeightSliders = [
        { id: '#sc_recall_weight_vector', key: 'recallWeightVector', display: '#sc_recall_weight_vector_val' },
        { id: '#sc_recall_weight_lexical', key: 'recallWeightLexical', display: '#sc_recall_weight_lexical_val' },
    ];
    for (const sl of recallWeightSliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val / 100;
            $(sl.display).text((val / 100).toFixed(2));
            saveSettings();
        });
        $(document).on('change', sl.id, () => {
            refreshRecall().catch(e => log('refreshRecall error:', e));
        });
    }

    $(document).on('change', '#sc_recall_time_labels', function () {
        getSettings().recallTimeLabels = $(this).prop('checked');
        saveSettings();
        refreshRecall().catch(e => log('refreshRecall error:', e));
    });

    // ── Cloud Embedding 配置 ──
    const embTextInputs = [
        { id: '#sc_emb_url', key: 'embUrl' },
        { id: '#sc_emb_key', key: 'embKey' },
    ];
    for (const inp of embTextInputs) {
        $(document).on('change', inp.id, function () {
            getSettings()[inp.key] = $(this).val().trim();
            saveSettings();
            clearRecallCache();
            syncEmbedderConfig();
            updateInjection();
            if (getSettings().recallEnabled) ensureVectors().catch(e => log('ensureVectors error:', e));
        });
    }

    $(document).on('input', '#sc_emb_batch', function () {
        const val = parseInt($(this).val(), 10);
        getSettings().embBatchSize = val;
        $('#sc_emb_batch_val').text(val);
        saveSettings();
    });

    $(document).on('click', '#sc_emb_probe', async function () {
        const embedder = syncEmbedderConfig();
        if (!embedder) { toastr.error('embedding.js 未加载'); return; }
        const btn = $(this);
        btn.prop('disabled', true).text('探测中…');
        try {
            // #397：probe 不再抛错，失败带可诊断原因（渠道不支持 / 没配 Key / 超时 / 4xx…）
            const result = await embedder.probe();
            if (!result.ok) {
                const why = window.SCEmbedding.reasonText(result.reason) || result.reason;
                toastr.error(`探测失败：${why}${result.detail ? `（${result.detail}）` : ''}`);
                $('#sc_preview').val(`embedding FAILED: ${result.reason}${result.detail ? ` / ${result.detail}` : ''}`);
                return;
            }
            toastr.success(`连接成功：${embedder.model}（${result.dimensions} 维）`);
            $('#sc_preview').val(`embedding OK: ${embedder.model} / ${result.dimensions} dims`);
            refreshRecall().catch(e => log('refreshRecall error:', e));
        } catch (err) {
            toastr.error(`探测失败：${err && err.message ? err.message : err}`);
        } finally {
            btn.prop('disabled', false).text('测试连接');
        }
    });

    $(document).on('click', '#sc_emb_reindex', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('重建中…');
        if (_vecIndexBusy || _vecRebuildBusy) {
            btn.prop('disabled', false).text('重建向量索引');
            toastr.info('已有索引任务在运行，请稍后再试。');
            return;
        }
        _vecRebuildBusy = true;
        clearRecallCache();
        updateInjection();
        const epoch = _recallEpoch;
        try {
            const cleared = await window.SCVectorStore.clearChat(getChatKey());
            let total = 0;
            for (let round = 0; round < 20 && _recallEpoch === epoch; round++) {
                const n = await ensureVectors(200, { rebuilding: true });
                total += n;
                if (n === 0) break;
            }
            if (_recallEpoch === epoch) toastr.success(`已清除 ${cleared} 条旧向量，重建 ${total} 条`);
        } catch (err) {
            toastr.error(`重建失败：${err && err.message ? err.message : err}`);
        } finally {
            _vecRebuildBusy = false;
            btn.prop('disabled', false).text('重建向量索引');
        }
    });

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
        const { chat } = SillyTavern.getContext();
        let repaired = 0;

        const progressToast = toastr.info(
            'Scanning for orphaned messages...',
            'Summaryception — Repair',
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
        );

        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];

            const isStuckHidden = (m.is_system || m.is_hidden)
            && !m.is_user
            && !m.extra?.sc_ghosted
            && m.mes
            && m.mes.trim().length > 0;

            if (isStuckHidden) {
                try {
                    await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                } catch (e) {
                    log(`Repair: failed to unhide ${i}:`, e);
                }

                m.is_system = false;
                delete m.is_hidden;

                repaired++;

                if (repaired % TUNING.repairProgressInterval === 0) {
                    $(progressToast).find('.toast-message').text(
                        `Repairing: found ${repaired} orphaned messages...`
                    );
                }
            }
        }

        toastr.clear(progressToast);

        if (repaired > 0) {
            try {
                const ctx = SillyTavern.getContext();
                if (ctx.saveChat) await ctx.saveChat();
            } catch (e) {
                log('Could not save chat:', e);
            }
            updateUI();
            toastr.success(
                `Repaired ${repaired} orphaned messages. They are now visible to the summarizer again.`,
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info('No orphaned messages found.', 'Summaryception', { timeOut: TUNING.toastMedium });
        }
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;

        try {
            await unghostAllMessages();
        } catch (e) {
            console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
            toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception');
        }

        const store = getChatStore();
        store.layers.length = 0;
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];

        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;

        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }
        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = false;

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            if (visibleTurns.length <= s.verbatimTurns) {
                toastr.info('Nothing to summarize — visible turns are within the verbatim limit.', 'Summaryception');
                return;
            }

            const overflow = visibleTurns.length - s.verbatimTurns;
            toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', { timeOut: TUNING.toastDefault });

            await runCatchup(visibleTurns, overflow);
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: TUNING.toastLong });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), TUNING.stopButtonCooldown);
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $(document).on('click', '#sc_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.layers || !Array.isArray(data.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                await unghostAllMessages();

                store.layers = data.layers;
                store.summarizedUpTo = data.summarizedUpTo ?? -1;
                store.ghostedIndices = data.ghostedIndices || [];

                if (store.summarizedUpTo >= 0) {
                    await ghostMessagesUpTo(store.summarizedUpTo);
                }

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                               'Summaryception',
                               { timeOut: TUNING.toastLong }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) s.savedCustomPrompts = {};

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(
            `Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`,
            'Summaryception',
            { timeOut: TUNING.toastDefault }
        );
    });

    // ── Custom Prompt: Load from named slot ──
    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Delete named slot ──
    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) return;

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Export as .txt ──
    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.text';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!text.trim()) {
                    toastr.warning('File is empty.', 'Summaryception');
                    return;
                }

                const s = getSettings();
                $('#sc_summarizer_user_prompt').val(text);
                s.summarizerUserPrompt = text;
                s.lastCustomPrompt = text;
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                saveSettings();
                updateCustomPromptSlots();

                toastr.success(
                    `Prompt imported from "${file.name}".`,
                    'Summaryception',
                    { timeOut: TUNING.toastMedium }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.', 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_reset_defaults', function () {
        if (!confirm(
            'Reset all Advanced Settings to defaults?\n\n' +
            'This will reset sliders, prompts, injection template, and strip patterns.\n' +
            'It will NOT clear your summary memory or connection settings.'
        )) return;

        const s = getSettings();

        // Reset sliders
        s.verbatimTurns = defaultSettings.verbatimTurns;
        s.turnsPerSummary = defaultSettings.turnsPerSummary;
        s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
        s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;
        s.maxLayers = defaultSettings.maxLayers;

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

        // Reset debug
        s.debugMode = defaultSettings.debugMode;
        s.traceMode = defaultSettings.traceMode;

        saveSettings();
        updateInjection();
        updateUI();

        toastr.success(
            'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
            'Summaryception',
            { timeOut: TUNING.toastLong }
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, TUNING.connectionStatusTimeout);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

    getSettings();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    bindMemoryCenterEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        if (getSettings().recallEnabled) ensureVectors().catch(e => log('ensureVectors error:', e));
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v5.5.4 loaded. Connection Settings available');
    });
})();