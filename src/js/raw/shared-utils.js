/**
 * shared-utils.js —— 主站各 ES 模块共享的基础工具集（零外部依赖）
 * 包含：弹窗拖拽、音视频进度持久化、剪贴板回退、HTML 转义、半角/哈希、CSS Custom Highlight 管理。
 */

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => document.querySelectorAll(selector);

export function createLocalStoreProxy(defaults = {}) {
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
