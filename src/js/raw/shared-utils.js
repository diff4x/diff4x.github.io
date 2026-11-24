/**
 * shared-utils.js —— 主站各 ES 模块共享的基础工具集（零外部依赖）
 * 包含：弹窗拖拽、音视频进度持久化、剪贴板回退、HTML 转义、半角/哈希、CSS Custom Highlight 管理。
 */

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => document.querySelectorAll(selector);

function getSiteCore() {
    try {
        if (window.top && window.top.SiteCore) return window.top.SiteCore;
    } catch (_) { }
    return (typeof globalThis !== 'undefined' && globalThis.SiteCore) ? globalThis.SiteCore : null;
}

const FALLBACK_BLOCKED_SCHEMES = new Set([
    'javascript', 'data', 'vbscript', 'file', 'blob', 'about',
    'http', 'https', 'ws', 'wss', 'ftp', 'mailto', 'tel'
]);

export function sanitizeProtocolName(raw) {
    const sc = getSiteCore();
    if (sc && typeof sc.sanitizeProtocolName === 'function') return sc.sanitizeProtocolName(raw);
    let s = raw;
    if (typeof s === 'string') {
        try {
            const parsed = JSON.parse(s);
            if (typeof parsed === 'string') s = parsed;
        } catch (_) { }
    }
    s = String(s || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9+.-]{0,31}$/.test(s) || FALLBACK_BLOCKED_SCHEMES.has(s)) return '';
    return s;
}

export function sanitizeAudioList(list) {
    const sc = getSiteCore();
    if (sc && typeof sc.sanitizeAudioList === 'function') return sc.sanitizeAudioList(list);
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

export function createLocalStoreProxy(defaults = {}, opts = {}) {
    const sc = getSiteCore();
    if (sc && typeof sc.createStore === 'function') return sc.createStore(defaults, opts);
    return new Proxy({}, {
        get(_, key) {
            const raw = localStorage.getItem(key);
            if (raw === null) return defaults[key];
            try { return JSON.parse(raw); } catch { return raw; }
        },
        set(_, key, value) {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        },
        deleteProperty(_, key) {
            localStorage.removeItem(key);
            return true;
        }
    });
}

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

export function toHalfwidth(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        out += code === 12288 ? ' ' : (code >= 65281 && code <= 65374 ? String.fromCharCode(code - 65248) : str[i]);
    }
    return out;
}

export function hashText(str) {
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619);
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 15);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function makeDraggable(popupSelector, headerSelector) {
    const popup = $(popupSelector);
    const header = $(headerSelector);
    if (!popup || !header) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = popup.offsetLeft;
        initialTop = popup.offsetTop;
        popup.style.position = 'absolute';
        popup.style.margin = '0';
        popup.style.transform = 'translateX(0)';
        header.style.cursor = 'moving';
        e.preventDefault();
    });

    const onMove = (e) => {
        if (!isDragging) return;
        if (!document.body.contains(popup)) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            return;
        }
        const scale = window._tpZoom || 1;
        const left = initialLeft + (e.clientX - startX) / scale;
        const top = initialTop + (e.clientY - startY) / scale;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    };

    const onUp = () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

export function copyTextFallback(text) {
    const legacyCopy = () => {
        const active = document.activeElement;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { }
        document.body.removeChild(ta);
        if (active && active.focus) active.focus({ preventScroll: true });
        return ok;
    };
    if (legacyCopy()) return Promise.resolve(true);
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    return Promise.resolve(false);
}

// =========================================================================
// 音视频播控进度持久化
// =========================================================================
const MEDIA_POS_KEY = 'media_positions';
const MEDIA_POS_MAX = 500;
const MEDIA_POS_MIN = 1;
const MEDIA_POS_END_GAP = 2;

export function mediaPosKey(src) {
    let s = String(src || '').split('#')[0].split('?')[0];
    try { s = decodeURIComponent(s); } catch (e) { }
    const m = s.match(/(?:^|\/)((?:video|audio)\/.+)$/);
    return m ? m[1] : s.replace(/^(?:\.{1,2}\/|\/)+/, '');
}

export function readMediaPositions() {
    try {
        const obj = JSON.parse(localStorage.getItem(MEDIA_POS_KEY));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
}

export function getMediaPosition(src) {
    const t = readMediaPositions()[mediaPosKey(src)];
    return (typeof t === 'number' && Number.isFinite(t) && t > 0) ? t : 0;
}

export function saveMediaPosition(el) {
    try {
        if (!el) return;
        const dur = el.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const key = mediaPosKey((el.dataset && el.dataset.path) || el.getAttribute('src'));
        if (!key) return;
        const t = el.currentTime;
        const map = readMediaPositions();
        delete map[key];
        if (Number.isFinite(t) && t >= MEDIA_POS_MIN && dur - t > MEDIA_POS_END_GAP) {
            map[key] = Math.round(t * 10) / 10;
        }
        const keys = Object.keys(map);
        if (keys.length > MEDIA_POS_MAX) keys.slice(0, keys.length - MEDIA_POS_MAX).forEach(k => delete map[k]);
        localStorage.setItem(MEDIA_POS_KEY, JSON.stringify(map));
    } catch (e) { }
}

export function saveMediaPositionsIn(root) {
    if (root) root.querySelectorAll('video, audio').forEach(el => saveMediaPosition(el));
}

export function resumeMediaPosition(el, src) {
    const saved = getMediaPosition(src);
    if (!saved) return;
    try { el.currentTime = saved; } catch (e) { }
    el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && saved > el.duration - MEDIA_POS_END_GAP) el.currentTime = 0;
    }, { once: true });
}

// =========================================================================
// CSS Custom Highlight 共享样式与池（供搜索列表高亮与摘要预览复用）
// =========================================================================
export const SYN_HL_BIT = 0x100;
export const SEARCH_HL_STYLE = [[0.80, '#000'], [0.65, '#111'], [0.52, '#111'], [0.42, '#333'], [0.34, '#333'], [0.28, '#333']];
export const SEARCH_SYN_HL_STYLE = [[0.55, '#000'], [0.45, '#111'], [0.38, '#111'], [0.32, '#333'], [0.26, '#333'], [0.22, '#333']];
export const SEARCH_SYN2_HL_STYLE = [[0.38, '#000'], [0.32, '#111'], [0.27, '#111'], [0.23, '#333'], [0.19, '#333'], [0.16, '#333']];

export const searchHlTier = (noise) => Math.min(((noise | 0) >> 8) & 3, 2);
export const searchHlIsSyn = (noise) => searchHlTier(noise) > 0;
export const searchHlBucket = (noise) => Math.min(Math.max((noise | 0) & 0xff, 0), SEARCH_HL_STYLE.length - 1);
export const searchHlSlot = (noise) => searchHlTier(noise) * SEARCH_HL_STYLE.length + searchHlBucket(noise);
export const searchHlNameBySlot = (slot) => {
    const tierSize = SEARCH_HL_STYLE.length;
    if (slot < tierSize) return (slot <= 0 ? 'search-exact' : `search-noise-${slot}`);
    if (slot < tierSize * 2) return `search-syn-${slot - tierSize}`;
    return `search-syn2-${slot - tierSize * 2}`;
};

const searchHl = [];

export function searchHighlightSupported() {
    if (!(window.CSS && CSS.highlights && typeof Highlight !== 'undefined')) return false;
    if (!document.getElementById('search-hl-static')) {
        const st = document.createElement('style');
        const tierSize = SEARCH_HL_STYLE.length;
        st.id = 'search-hl-static';
        st.textContent = [
            ...SEARCH_HL_STYLE.map(([a, c], b) => `::highlight(${searchHlNameBySlot(b)}) { background-color: rgba(255, 235, 0, ${a}); color: ${c}; }`),
            ...SEARCH_SYN_HL_STYLE.map(([a, c], b) => `::highlight(${searchHlNameBySlot(tierSize + b)}) { background-color: rgba(56, 189, 248, ${a}); color: ${c}; }`),
            ...SEARCH_SYN2_HL_STYLE.map(([a, c], b) => `::highlight(${searchHlNameBySlot(tierSize * 2 + b)}) { background-color: rgba(56, 189, 248, ${a}); color: ${c}; }`)
        ].join('\n');
        document.head.appendChild(st);
    }
    return true;
}

export function getSearchHighlight(noise) {
    const slot = searchHlSlot(noise);
    const tier = searchHlTier(noise);
    const bucket = searchHlBucket(noise);
    if (!searchHl[slot]) {
        const h = new Highlight();
        h.priority = tier === 0 ? (100 - bucket * 10) : (tier === 1 ? (40 - bucket * 5) : (20 - bucket * 3));
        searchHl[slot] = h;
    }
    return searchHl[slot];
}

export function resetSearchHighlights() {
    searchHl.forEach(h => { if (h) h.clear(); });
}

export function publishSearchHighlights() {
    if (!(window.CSS && CSS.highlights)) return;
    searchHl.forEach((h, slot) => {
        if (h && h.size > 0) CSS.highlights.set(searchHlNameBySlot(slot), h);
        else CSS.highlights.delete(searchHlNameBySlot(slot));
    });
}

// =========================================================================
// 文内搜索（TXT / PDF / EPUB）共享组合检索与摘要合并工具
// =========================================================================
export function adaptKeywordsForWasm(specs, weighted) {
    if (!Array.isArray(specs)) return [];
    if (weighted) return specs;
    return specs
        .map(s => (typeof s === 'string' ? s : (s && typeof s.text === 'string' ? s.text : '')))
        .filter(Boolean);
}

export function collectAdsPositiveIndices(expr) {
    const pos = new Set();
    const walk = (n) => {
        if (!n) return;
        if (n.op === 'term') {
            if (!n.neg) pos.add(n.term);
        } else if (Array.isArray(n.args)) {
            n.args.forEach(walk);
        }
    };
    walk(expr);
    return [...pos].sort((a, b) => a - b);
}

export function evalAdsExpr(node, hasTermFn) {
    if (!node) return false;
    if (node.op === 'term') {
        const hit = !!hasTermFn(node.term);
        return node.neg ? !hit : hit;
    }
    if (node.op === 'and') {
        for (let i = 0; i < node.args.length; i++) {
            if (!evalAdsExpr(node.args[i], hasTermFn)) return false;
        }
        return true;
    }
    if (node.op === 'or') {
        for (let i = 0; i < node.args.length; i++) {
            if (evalAdsExpr(node.args[i], hasTermFn)) return true;
        }
        return false;
    }
    return false;
}

export function mergeWasmMatchSpans(rawMatches) {
    if (!Array.isArray(rawMatches) || rawMatches.length <= 1) {
        return Array.isArray(rawMatches) ? rawMatches.slice() : [];
    }
    const sorted = rawMatches.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const m of sorted) {
        const last = merged[merged.length - 1];
        if (last && m.start < last.end) {
            const lastTier = searchHlTier(last.noise);
            const curTier = searchHlTier(m.noise);
            const lastNoise = last.noise & 0xff;
            const curNoise = m.noise & 0xff;
            const lastWeight = (last.noise >>> 16) & 0xff;
            const curWeight = (m.noise >>> 16) & 0xff;
            const lastLen = last.end - last.start;
            const curLen = m.end - m.start;
            if (
                curTier < lastTier ||
                (curTier === lastTier && curNoise < lastNoise) ||
                (curTier === lastTier && curNoise === lastNoise && curWeight > lastWeight) ||
                (curTier === lastTier && curNoise === lastNoise && curWeight === lastWeight && curLen > lastLen)
            ) {
                merged[merged.length - 1] = m;
            }
            continue;
        }
        merged.push(m);
    }
    return merged;
}

export function collectWasmMatches(sw, text, wasmKeywords, noise, termIdx = 0, offsetShift = 0) {
    if (!text || !Array.isArray(wasmKeywords) || wasmKeywords.length === 0) return [];
    const res = sw.find_content_matches_multi(text, wasmKeywords, noise);
    const arr = res && res.matches;
    if (!arr || arr.length < 3) return [];
    const out = [];
    for (let i = 0; i < arr.length; i += 3) {
        out.push({
            start: arr[i] + offsetShift,
            end: arr[i + 1] + offsetShift,
            noise: arr[i + 2],
            termIdx
        });
    }
    return out;
}

export function buildMergedGroupSnippets(groupHits, opts) {
    const {
        maxItems = 40,
        radius = 58,
        maxWindowChars = 180,
        snapToNewline = true,
        getUnitKey,
        getUnitText,
        getPrefix
    } = opts || {};

    if (!Array.isArray(groupHits) || groupHits.length === 0) {
        return { items: [], more: 0 };
    }

    const windows = [];
    const byUnit = new Map();

    for (const hit of groupHits) {
        const unitKey = getUnitKey(hit);
        const text = getUnitText(hit);
        if (!text) continue;

        let arr = byUnit.get(unitKey);
        if (!arr) { arr = []; byUnit.set(unitKey, arr); }
        arr.push(hit);

        let s = Math.max(0, hit.localStart - radius);
        let e = Math.min(text.length, hit.localEnd + radius);
        if (snapToNewline) {
            if (s > 0) {
                const nl = text.lastIndexOf('\n', hit.localStart - 1);
                if (nl !== -1 && hit.localStart - nl <= radius) s = nl + 1;
            }
            if (e < text.length) {
                const nl = text.indexOf('\n', hit.localEnd);
                if (nl !== -1 && nl - hit.localEnd <= radius) e = nl;
            }
        }

        const prev = windows[windows.length - 1];
        const tIdx = typeof hit.termIdx === 'number' ? hit.termIdx : 0;
        if (prev && prev.unitKey === unitKey && s <= prev.e && (Math.max(prev.e, e) - prev.s) <= maxWindowChars) {
            if (e > prev.e) prev.e = e;
            prev.termSet.add(tIdx);
        } else {
            windows.push({
                idx: windows.length,
                unitKey,
                hit,
                text,
                s,
                e,
                termSet: new Set([tIdx])
            });
        }
    }

    let selected = windows;
    if (windows.length > maxItems) {
        const allTerms = new Set();
        for (const w of windows) w.termSet.forEach(t => allTerms.add(t));

        selected = windows.slice(0, maxItems);
        if (allTerms.size > 1) {
            const covered = new Set();
            for (const w of selected) w.termSet.forEach(t => covered.add(t));

            const extras = [];
            for (const t of allTerms) {
                if (covered.has(t)) continue;
                const firstWin = windows.find(w => w.termSet.has(t));
                if (firstWin && !extras.includes(firstWin)) {
                    extras.push(firstWin);
                    firstWin.termSet.forEach(x => covered.add(x));
                }
            }
            if (extras.length > 0) {
                const keepCount = Math.max(0, maxItems - extras.length);
                selected = selected.slice(0, keepCount).concat(extras);
                selected.sort((a, b) => a.idx - b.idx);
            }
        }
    }

    const items = [];
    for (const win of selected) {
        const { text, s, e, unitKey, hit } = win;
        const pre = typeof getPrefix === 'function'
            ? getPrefix(hit, s, text)
            : (s > 0 && (!snapToNewline || text[s - 1] !== '\n') ? '…' : '');
        const suf = e < text.length && (!snapToNewline || text[e] !== '\n') ? '…' : '';
        const body = text.slice(s, e).replace(snapToNewline ? /[\t\r]/g : /[\t\r\n]/g, ' ');
        const t = pre + body + suf;
        const shift = pre.length;

        const h = [];
        const unitHits = byUnit.get(unitKey) || [hit];
        for (const item of unitHits) {
            if (item.localEnd <= s) continue;
            if (item.localStart >= e) break;
            const rs = Math.max(s, item.localStart) - s + shift;
            const re = Math.min(e, item.localEnd) - s + shift;
            if (re > rs) h.push([rs, re, item.noise]);
        }
        items.push({ t, h });
    }

    return { items, more: Math.max(0, windows.length - items.length) };
}

// =========================================================================
// 本地伴生服务同源 API 客户端：#fragment 令牌吸收 + X-Swamp-Token 请求封装
// =========================================================================
export const LOCAL_TOKEN_STORAGE = '__swamp_local_token__';

export function ingestLocalTokenFromHash(isLocalEnv) {
    if (!isLocalEnv) return false;
    const h = window.location.hash || '';
    const m = /^#__swamp_token=([0-9a-f]{64})$/i.exec(h);
    if (!m) return false;
    try {
        localStorage.setItem(LOCAL_TOKEN_STORAGE, m[1].toLowerCase());
    } catch (_) { }
    try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_) {
        window.location.hash = '';
    }
    return true;
}

export async function callLocalApi(method, endpoint, body = null, options = {}) {
    const token = (localStorage.getItem(LOCAL_TOKEN_STORAGE) || '').trim();
    if (!token) {
        throw new Error('缺少本地会话令牌，请通过 Swamp 管理窗口点击 Open Site 重新打开本地站点');
    }
    const opts = {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
            'X-Swamp-Token': token
        }
    };
    if (options && options.signal) {
        opts.signal = options.signal;
    }
    if (method !== 'GET' && method !== 'HEAD') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(endpoint, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        const msg = res.status === 401
            ? '本地会话令牌已失效（服务可能已重启），请通过 Swamp 管理窗口点击 Open Site 重新打开本地站点'
            : (data.error || `HTTP ${res.status}`);
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}
