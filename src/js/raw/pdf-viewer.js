/**
 * pdf-viewer.js —— PDF.js v6.5.438 站内增强与 Wasm 书内搜索桥接模块
 * 兼容严格 CSP（script-src 'self' 'wasm-unsafe-eval'; style-src 'self'），全程零内联脚本与零内联样式属性。
 */
import {
    searchHlTier,
    searchHlBucket,
    adaptKeywordsForWasm,
    collectAdsPositiveIndices,
    evalAdsExpr,
    mergeWasmMatchSpans,
    collectWasmMatches,
    buildMergedGroupSnippets
} from './shared-utils.js';
import { BookDB, normalizeBookKey, buildBookSearchCacheKey } from './book-db.js';

// =========================================================================
// 0. 基础环境：VirtualCursor、SiteCore、BUS 通信、安全选项双锁
// =========================================================================
if (window.top && window.top.VirtualCursor) {
    try { window.top.VirtualCursor.attach(window); } catch (_) { }
}

const childId = 'content';
window.childId = childId;
const ctxId = window.top === window.self ? 'index' : childId;

if (window.__LITE_BUS__) {
    try { window.__LITE_BUS__.close(); } catch (_) { }
}
window.__LITE_BUS__ = new BroadcastChannel('bus');
const BUS = window.__LITE_BUS__;

function getTabId() {
    try { return (window.top && window.top.__TAB_ID__) || ''; } catch (_) { return ''; }
}

function emitEvent(type, payload, target = '*') {
    if (!window.__LITE_BUS__) return;
    try {
        window.__LITE_BUS__.postMessage({
            type,
            payload,
            from: ctxId,
            target,
            tabId: getTabId()
        });
    } catch (_) { }
}

// 监听 webviewerloaded（同时挂在 document 与 parent.document，覆盖同源 iframe 派发）
function lockPdfSecurityOptions(evt) {
    if (evt && evt.detail && evt.detail.source && evt.detail.source !== window) return;
    const opts = window.PDFViewerApplicationOptions;
    if (opts && typeof opts.set === 'function') {
        opts.set('enableScripting', false);
    }
}
document.addEventListener('webviewerloaded', lockPdfSecurityOptions);
try {
    if (window.parent && window.parent !== window && window.parent.document) {
        window.parent.document.addEventListener('webviewerloaded', lockPdfSecurityOptions);
    }
} catch (_) { }
lockPdfSecurityOptions();

// =========================================================================
// 1. 交互增强：横向滚轮、双击切换手型/选择、反色、中击全屏、拼音、摘抄
// =========================================================================
const viewerCont = document.getElementById('viewerContainer');
const scrollHor = document.getElementById('scrollHorizontal');
const cursorHan = document.getElementById('cursorHandTool');
const cursorSel = document.getElementById('cursorSelectTool');
const reverseColorBtn = document.getElementById('reverseColor');
const scopeBtn = document.getElementById('pdfSearchScope');
const viewFindBtn = document.getElementById('viewFindButton');

function wheelScrollLeft(event) {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (viewerCont) viewerCont.scrollLeft += event.deltaY;
}

let wheelBound = false;
function syncHorizontalWheelMode(mode) {
    if (!viewerCont) return;
    const isHor = typeof mode === 'number'
        ? mode === 1
        : !!(scrollHor && scrollHor.classList.contains('toggled'));
    if (isHor && !wheelBound) {
        viewerCont.addEventListener('wheel', wheelScrollLeft, { passive: false });
        wheelBound = true;
    } else if (!isHor && wheelBound) {
        viewerCont.removeEventListener('wheel', wheelScrollLeft);
        wheelBound = false;
    }
}

if (viewerCont) {
    viewerCont.addEventListener('dblclick', (e) => {
        const app = window.PDFViewerApplication;
        if (app && app.pdfViewer && app.pdfViewer.annotationEditorMode > 0) return;
        const target = e.target;
        if (target && target.closest && target.closest('.annotationEditorLayer, input, textarea, select, button, [contenteditable]')) {
            return;
        }
        if (cursorHan && cursorHan.classList.contains('toggled')) {
            if (cursorSel) cursorSel.click();
        } else if (cursorHan) {
            cursorHan.click();
        }
    });
}

if (reverseColorBtn && viewerCont) {
    reverseColorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const active = viewerCont.classList.toggle('reverseColor');
        reverseColorBtn.classList.toggle('is-active', active);
    });
}

document.body.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const parentDoc = window.parent && window.parent.document;
    if (!parentDoc) return;
    const isFullscreen = !!parentDoc.fullscreenElement;
    const tb = document.querySelector('.toolbar');

    if (!isFullscreen) {
        if (tb) tb.classList.add('pdf-fs-hide');
        if (viewerCont) viewerCont.classList.add('pdf-fs-top');
        parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
        emitEvent('lightbox', { status: '1' }, 'index');
    } else {
        if (tb) tb.classList.remove('pdf-fs-hide');
        if (viewerCont) viewerCont.classList.remove('pdf-fs-top');
        if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
        emitEvent('lightbox', { status: '0' }, 'index');
    }
});

function syncToolbarOnParentFullscreen() {
    try {
        const isFs = !!(window.parent && window.parent.document && window.parent.document.fullscreenElement);
        if (!isFs) {
            const tb = document.querySelector('.toolbar');
            if (tb) tb.classList.remove('pdf-fs-hide');
            if (viewerCont) viewerCont.classList.remove('pdf-fs-top');
        }
    } catch (_) { }
}
try {
    if (window.parent && window.parent.document) {
        window.parent.document.addEventListener('fullscreenchange', syncToolbarOnParentFullscreen);
    }
} catch (_) { }

// 拼音悬浮提示
(function initPinyinTooltip() {
    const tooltip = document.createElement('div');
    tooltip.className = 'pinyin-tooltip';
    document.body.appendChild(tooltip);

    document.addEventListener('mousedown', () => {
        tooltip.style.display = 'none';
    });

    document.addEventListener('mouseup', (event) => {
        if (event.target && event.target.closest && event.target.closest('#excerpt-pop-btn')) return;
        const dict = window.top && window.top.pinyinData;
        if (!dict) {
            tooltip.style.display = 'none';
            return;
        }
        const selection = (window.getSelection() ? window.getSelection().toString() : '').trim();
        const chars = Array.from(selection);
        if (chars.length === 1 && dict[chars[0]]) {
            tooltip.textContent = dict[chars[0]];
            tooltip.style.left = Math.min(window.innerWidth - 80, event.clientX + 6) + 'px';
            tooltip.style.top = Math.max(8, event.clientY - 30) + 'px';
            tooltip.style.display = 'block';
        } else {
            tooltip.style.display = 'none';
        }
    });
})();

// 划词摘抄浮窗
(function initExcerptTrigger() {
    let btn = document.getElementById('excerpt-pop-btn');
    if (btn) return;
    btn = document.createElement('div');
    btn.id = 'excerpt-pop-btn';
    btn.textContent = '✏️';
    document.body.appendChild(btn);

    let lastProcessedText = '';

    const getSelectionEndRect = (sel, fallbackEvent) => {
        if (sel && sel.rangeCount > 0) {
            try {
                if (sel.focusNode) {
                    const caret = document.createRange();
                    caret.setStart(sel.focusNode, sel.focusOffset);
                    caret.collapse(true);
                    const rect = caret.getBoundingClientRect();
                    if (rect && rect.height > 0) return rect;

                    if (sel.focusNode.nodeType === Node.TEXT_NODE && sel.focusNode.length > 0) {
                        const r2 = document.createRange();
                        if (sel.focusOffset > 0) {
                            r2.setStart(sel.focusNode, sel.focusOffset - 1);
                            r2.setEnd(sel.focusNode, sel.focusOffset);
                            const rr = r2.getBoundingClientRect();
                            if (rr && rr.height > 0) {
                                return { left: rr.right, right: rr.right, top: rr.top, bottom: rr.bottom, width: 0, height: rr.height };
                            }
                        } else {
                            r2.setStart(sel.focusNode, 0);
                            r2.setEnd(sel.focusNode, 1);
                            const rr = r2.getBoundingClientRect();
                            if (rr && rr.height > 0) {
                                return { left: rr.left, right: rr.left, top: rr.top, bottom: rr.bottom, width: 0, height: rr.height };
                            }
                        }
                    }
                }
            } catch (_) { }

            try {
                const range = sel.getRangeAt(0);
                const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 || r.height > 0);
                if (rects.length > 0) {
                    let isBackward = false;
                    if (sel.anchorNode && sel.focusNode) {
                        isBackward = sel.anchorNode === sel.focusNode
                            ? sel.focusOffset < sel.anchorOffset
                            : !!(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
                    }
                    const r = isBackward ? rects[0] : rects[rects.length - 1];
                    const x = isBackward ? r.left : r.right;
                    return { left: x, right: x, top: r.top, bottom: r.bottom, width: 0, height: r.height };
                }
            } catch (_) { }
        }
        if (fallbackEvent && typeof fallbackEvent.clientX === 'number') {
            return {
                left: fallbackEvent.clientX,
                right: fallbackEvent.clientX,
                top: fallbackEvent.clientY - 12,
                bottom: fallbackEvent.clientY + 6,
                width: 0,
                height: 18
            };
        }
        return null;
    };

    const doExcerpt = () => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (Array.from(text).length > 1) {
            emitEvent('SAVE_EXCERPT', text, 'index');
            btn.textContent = '✅ 已摘抄';
            btn.classList.add('is-done');
            setTimeout(() => {
                btn.style.display = 'none';
                btn.textContent = '✏️';
                btn.classList.remove('is-done');
                if (sel) sel.removeAllRanges();
                lastProcessedText = '';
            }, 800);
        }
    };

    ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerdown', 'pointerup'].forEach(evt => {
        window.addEventListener(evt, (e) => {
            if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) {
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (evt === 'mousedown') e.preventDefault();
                if (evt === 'click') doExcerpt();
            }
        }, true);
    });

    document.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;
        btn.style.display = 'none';
        lastProcessedText = '';
    });

    document.addEventListener('mouseup', (e) => {
        if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;
        setTimeout(() => {
            const sel = window.getSelection();
            const text = sel ? sel.toString().trim() : '';
            if (Array.from(text).length > 1) {
                if (text !== lastProcessedText) {
                    const endRect = getSelectionEndRect(sel, e);
                    if (endRect) {
                        btn.style.visibility = 'hidden';
                        btn.style.display = 'block';
                        const bw = btn.offsetWidth || 32;
                        const bh = btn.offsetHeight || 24;
                        const endX = (endRect.left + endRect.right) / 2;
                        const left = Math.max(8, Math.min(window.innerWidth - bw - 8, endX - bw / 2));
                        let top = endRect.bottom + 6;
                        if (top + bh > window.innerHeight - 8 && endRect.top - bh - 6 >= 8) {
                            top = endRect.top - bh - 6;
                        } else {
                            top = Math.max(8, Math.min(window.innerHeight - bh - 8, top));
                        }
                        btn.style.left = Math.round(left) + 'px';
                        btn.style.top = Math.round(top) + 'px';
                        btn.style.visibility = 'visible';
                        lastProcessedText = text;
                    }
                }
            } else {
                btn.style.display = 'none';
                lastProcessedText = '';
            }
        }, 10);
    });
})();

// =========================================================================
// 2. CSS Custom Highlight + PDF.js v6.5.438 文本层适配
// =========================================================================
const HL_SUPPORTED = !!(window.CSS && CSS.highlights && typeof Highlight !== 'undefined');
const TIER_SIZE = 6;
const pdfHlPools = new Array(TIER_SIZE * 3).fill(null);
const activeHitPool = HL_SUPPORTED ? (() => { const h = new Highlight(); h.priority = 200; return h; })() : null;

function pdfHlNameBySlot(slot) {
    if (slot < TIER_SIZE) return `pdf-hl-${slot}`;
    if (slot < TIER_SIZE * 2) return `pdf-syn-${slot - TIER_SIZE}`;
    return `pdf-syn2-${slot - TIER_SIZE * 2}`;
}

function pdfHlSlot(noise) {
    return searchHlTier(noise) * TIER_SIZE + searchHlBucket(noise);
}

function getPdfHlPool(slot) {
    if (!pdfHlPools[slot]) {
        const h = new Highlight();
        const tier = Math.floor(slot / TIER_SIZE);
        const bucket = slot % TIER_SIZE;
        h.priority = tier === 0 ? (100 - bucket * 10) : (tier === 1 ? (40 - bucket * 5) : (20 - bucket * 3));
        pdfHlPools[slot] = h;
    }
    return pdfHlPools[slot];
}

function publishPdfHighlights() {
    if (!HL_SUPPORTED) return;
    for (let slot = 0; slot < pdfHlPools.length; slot++) {
        const h = pdfHlPools[slot];
        const name = pdfHlNameBySlot(slot);
        if (h && h.size > 0) CSS.highlights.set(name, h);
        else CSS.highlights.delete(name);
    }
    if (activeHitPool && activeHitPool.size > 0) CSS.highlights.set('pdf-active-hit', activeHitPool);
    else CSS.highlights.delete('pdf-active-hit');
}

// 兼容 PDF.js v6.5.438：TextLayerBuilder.#renderingDone 私有化，
// 改由 pageView._textHighlighter（即 textLayer.highlighter）读取 textDivs / textContentItemsStr / enabled
function getRenderedTextLayerInfo(pageView) {
    if (!pageView || !pageView.textLayer) return null;
    const hl = pageView._textHighlighter || pageView.textLayer.highlighter;
    if (hl && hl.enabled && Array.isArray(hl.textDivs) && hl.textDivs.length > 0) {
        return {
            textDivs: hl.textDivs,
            textContentItemsStr: Array.isArray(hl.textContentItemsStr) ? hl.textContentItemsStr : []
        };
    }
    // 兜底兼容旧结构
    const tl = pageView.textLayer;
    if (tl.renderingDone && Array.isArray(tl.textDivs) && tl.textDivs.length > 0) {
        return {
            textDivs: tl.textDivs,
            textContentItemsStr: Array.isArray(tl.textContentItemsStr) ? tl.textContentItemsStr : []
        };
    }
    return null;
}

const State = {
    docGen: 0,
    pdfDoc: null,
    numPages: 0,
    title: '',
    bookKey: '',
    pages: [],
    extractedCount: 0,
    extractDone: false,
    extractBoosted: false,
    extractPromise: null,
    extractWaiters: [],
    sections: [],
    groupUnit: '页',
    outlinePromise: null,
    activeSearchToken: 0,
    lastSearch: null,
    activeHit: null,
    pendingJump: null,
    jumpSeq: 0,
    pageRangesMap: new Map(),
    searchScope: 'txt',
    provider: null
};

function syncScopeUI(scope) {
    State.searchScope = scope === 'global' ? 'global' : 'txt';
    if (!scopeBtn) return;
    const isGlobal = State.searchScope === 'global';
    scopeBtn.textContent = isGlobal ? '搜全站' : '搜本书';
    scopeBtn.classList.toggle('is-global', isGlobal);
    scopeBtn.title = isGlobal
        ? '当前为全站搜索，点击切回搜本书'
        : '当前为搜本书，点击切换为搜全站';
}

function openMainBookSearch({ forceBook = false } = {}) {
    const bridge = window.top && (window.top.__DOC_SEARCH_BRIDGE__ || window.top.__TXT_SEARCH_BRIDGE__);
    if (forceBook && bridge && typeof bridge.setScope === 'function' && State.searchScope !== 'txt') {
        bridge.setScope('txt', { rerun: false });
    }
    emitEvent('quick_search', '', 'index');
}

window.addEventListener('keydown', (e) => {
    const cmd = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (cmd && (e.key === 'f' || e.key === 'F' || e.keyCode === 70)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openMainBookSearch({ forceBook: true });
        return;
    }
    if (e.key === '\\' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (document.activeElement && document.activeElement.tagName || '').toUpperCase();
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
            e.preventDefault();
            e.stopImmediatePropagation();
            openMainBookSearch({ forceBook: false });
        }
    }
}, true);

if (viewFindBtn) {
    viewFindBtn.title = '搜本书 (Ctrl+F / \\)';
    viewFindBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        openMainBookSearch({ forceBook: true });
    }, true);
}

if (scopeBtn) {
    scopeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bridge = window.top && (window.top.__DOC_SEARCH_BRIDGE__ || window.top.__TXT_SEARCH_BRIDGE__);
        const next = State.searchScope === 'txt' ? 'global' : 'txt';
        syncScopeUI(next);
        if (bridge && typeof bridge.setScope === 'function') {
            bridge.setScope(next, { rerun: true });
        }
    });
}

BUS.addEventListener('message', (e) => {
    const { type, target, tabId } = e.data || {};
    const myTab = getTabId();
    if (tabId && myTab && tabId !== myTab) return;
    if (target !== '*' && target !== 'content') return;
    if (type === 'DESTROY_HIGHLIGHT') clearAllHighlights();
});

// =========================================================================
// 3. 文本拼接、大纲解析与后台静默预提取（BookDB 持久化）
// =========================================================================
function buildPageTextFromStrings(strList) {
    const items = new Array(strList.length);
    let text = '';
    for (let i = 0; i < strList.length; i++) {
        const s = typeof strList[i] === 'string' ? strList[i] : '';
        if (i > 0 && text.length > 0 && s.length > 0) {
            const prevCh = text.charCodeAt(text.length - 1);
            const nextCh = s.charCodeAt(0);
            const isPrevAscii = (prevCh >= 48 && prevCh <= 57) || (prevCh >= 65 && prevCh <= 90) || (prevCh >= 97 && prevCh <= 122);
            const isNextAscii = (nextCh >= 48 && nextCh <= 57) || (nextCh >= 65 && nextCh <= 90) || (nextCh >= 97 && nextCh <= 122);
            if (isPrevAscii && isNextAscii) text += ' ';
        }
        const start = text.length;
        text += s;
        items[i] = { start, end: text.length };
    }
    return { text, items };
}

function buildFixedPageSections(numPages) {
    const sections = [];
    if (numPages <= 30) {
        for (let p = 1; p <= numPages; p++) {
            sections.push({
                index: sections.length,
                title: `第 ${p} 页`,
                startPage: p,
                endPage: p,
                label: `p.${p}`
            });
        }
        return { sections, groupUnit: '页' };
    }
    const step = numPages <= 200 ? 20 : (numPages <= 600 ? 30 : 50);
    for (let s = 1; s <= numPages; s += step) {
        const e = Math.min(numPages, s + step - 1);
        const pct = (((s - 1) / Math.max(1, numPages)) * 100).toFixed(0) + '%';
        sections.push({
            index: sections.length,
            title: s === e ? `第 ${s} 页` : `第 ${s}–${e} 页`,
            startPage: s,
            endPage: e,
            label: pct
        });
    }
    return { sections, groupUnit: '段' };
}

async function resolveDestPageNumber(pdfDoc, dest) {
    try {
        let explicit = dest;
        if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest);
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const ref = explicit[0];
        if (Number.isInteger(ref)) return ref + 1;
        if (ref && typeof ref === 'object') {
            const idx = await pdfDoc.getPageIndex(ref);
            return Number.isInteger(idx) ? idx + 1 : null;
        }
    } catch (_) { }
    return null;
}

async function parseOutlineSections(pdfDoc, docGen) {
    const numPages = pdfDoc.numPages || 0;
    try {
        const outline = await pdfDoc.getOutline();
        if (docGen !== State.docGen) return;
        if (!Array.isArray(outline) || outline.length === 0) {
            const fb = buildFixedPageSections(numPages);
            State.sections = fb.sections;
            State.groupUnit = fb.groupUnit;
            return;
        }

        const flat = [];
        const walk = (items, depth) => {
            for (const it of items) {
                if (!it) continue;
                const title = String(it.title || '').replace(/\0/g, '').trim();
                if (title && it.dest) flat.push({ title, dest: it.dest, depth });
                if (depth < 1 && Array.isArray(it.items) && it.items.length > 0 && flat.length < 400) {
                    walk(it.items, depth + 1);
                }
            }
        };
        walk(outline, 0);

        const resolved = [];
        for (let i = 0; i < flat.length; i++) {
            if (docGen !== State.docGen) return;
            const p = await resolveDestPageNumber(pdfDoc, flat[i].dest);
            if (p && p >= 1 && p <= numPages) {
                resolved.push({ title: flat[i].title, page: p, order: i });
            }
        }
        if (docGen !== State.docGen) return;

        resolved.sort((a, b) => a.page - b.page || a.order - b.order);
        const dedup = [];
        for (const item of resolved) {
            if (dedup.length > 0 && dedup[dedup.length - 1].page === item.page) continue;
            dedup.push(item);
        }

        if (dedup.length < 2) {
            const fb = buildFixedPageSections(numPages);
            State.sections = fb.sections;
            State.groupUnit = fb.groupUnit;
            return;
        }

        const sections = [];
        if (dedup[0].page > 1) {
            sections.push({
                index: 0,
                title: '封面 / 前言',
                startPage: 1,
                endPage: dedup[0].page - 1,
                label: 'p.1'
            });
        }
        for (let i = 0; i < dedup.length; i++) {
            const startPage = dedup[i].page;
            const endPage = i + 1 < dedup.length ? Math.max(startPage, dedup[i + 1].page - 1) : numPages;
            sections.push({
                index: sections.length,
                title: dedup[i].title,
                startPage,
                endPage,
                label: `p.${startPage}`
            });
        }
        State.sections = sections;
        State.groupUnit = '节';
    } catch (_) {
        if (docGen !== State.docGen) return;
        const fb = buildFixedPageSections(numPages);
        State.sections = fb.sections;
        State.groupUnit = fb.groupUnit;
    }
}

function getSectionForPage(pageNumber) {
    const secs = State.sections;
    if (!secs || secs.length === 0) {
        return { index: pageNumber - 1, title: `第 ${pageNumber} 页`, startPage: pageNumber, endPage: pageNumber, label: `p.${pageNumber}` };
    }
    let lo = 0, hi = secs.length - 1, ans = secs[0];
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (secs[mid].startPage <= pageNumber) { ans = secs[mid]; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

function idleYield() {
    if (State.extractBoosted) return new Promise(r => setTimeout(r, 0));
    if (typeof requestIdleCallback === 'function') {
        return new Promise(r => requestIdleCallback(() => r(), { timeout: 220 }));
    }
    return new Promise(r => setTimeout(r, 24));
}

function notifyExtractProgress() {
    for (const fn of State.extractWaiters) {
        try { fn(State.extractedCount, State.numPages); } catch (_) { }
    }
}

function startBackgroundPreExtraction(pdfDoc, docGen) {
    const numPages = pdfDoc.numPages || 0;
    const bookKey = State.bookKey;
    State.pages = new Array(numPages);
    State.extractedCount = 0;
    State.extractDone = false;
    State.extractBoosted = false;

    let outlineRestored = false;
    State.outlinePromise = null;

    State.extractPromise = (async () => {
        if (bookKey) {
            const cached = await BookDB.getExtract(bookKey);
            if (docGen !== State.docGen) return;
            if (cached && cached.kind === 'pdf6' && cached.numPages === numPages && Array.isArray(cached.pages) && cached.pages.length === numPages) {
                State.pages = cached.pages;
                State.extractedCount = numPages;
                State.extractDone = true;
                if (Array.isArray(cached.sections) && cached.sections.length > 0) {
                    State.sections = cached.sections;
                    State.groupUnit = cached.groupUnit || State.groupUnit;
                    outlineRestored = true;
                }
                if (!outlineRestored) State.outlinePromise = parseOutlineSections(pdfDoc, docGen);
                notifyExtractProgress();
                return;
            }
        }

        State.outlinePromise = parseOutlineSections(pdfDoc, docGen);

        try {
            const oneRendered = window.PDFViewerApplication && window.PDFViewerApplication.pdfViewer && window.PDFViewerApplication.pdfViewer.onePageRendered;
            if (oneRendered) {
                await Promise.race([oneRendered, new Promise(r => setTimeout(r, 350))]);
            } else {
                await new Promise(r => setTimeout(r, 250));
            }
        } catch (_) { }

        let nextPage = 1;
        while (nextPage <= numPages) {
            if (docGen !== State.docGen) return;
            const batchSize = State.extractBoosted ? 6 : 3;
            const batchPages = [];
            for (let k = 0; k < batchSize && nextPage <= numPages; k++, nextPage++) {
                batchPages.push(nextPage);
            }

            await Promise.all(batchPages.map(async (pNum) => {
                try {
                    const pdfPage = await pdfDoc.getPage(pNum);
                    if (docGen !== State.docGen) return;
                    const tc = await pdfPage.getTextContent({ disableNormalization: true });
                    if (docGen !== State.docGen) return;
                    const strList = (tc && Array.isArray(tc.items))
                        ? tc.items.filter(it => it && typeof it.str === 'string').map(it => it.str)
                        : [];
                    const built = buildPageTextFromStrings(strList);
                    State.pages[pNum - 1] = {
                        pageNumber: pNum,
                        text: built.text,
                        items: built.items
                    };
                } catch (_) {
                    if (docGen !== State.docGen) return;
                    State.pages[pNum - 1] = { pageNumber: pNum, text: '', items: [] };
                } finally {
                    if (docGen === State.docGen) State.extractedCount++;
                }
            }));

            if (docGen !== State.docGen) return;
            notifyExtractProgress();
            if (nextPage <= numPages) await idleYield();
        }

        if (docGen === State.docGen) {
            State.extractDone = true;
            notifyExtractProgress();

            if (bookKey) {
                const pOutline = State.outlinePromise;
                Promise.resolve(pOutline).then(() => {
                    if (docGen !== State.docGen) return;
                    BookDB.putExtract(bookKey, 'pdf6', {
                        kind: 'pdf6',
                        numPages,
                        pages: State.pages,
                        sections: State.sections,
                        groupUnit: State.groupUnit
                    }, { numPages, groupUnit: State.groupUnit });
                }).catch(() => { });
            }
        }
    })();
}

// =========================================================================
// 4. 文本层 Range 映射（兼容单 TextNode 与 v6 嵌套节点）与按页增量着色
// =========================================================================
function clearPageHighlights(pageIndex) {
    const prev = State.pageRangesMap.get(pageIndex);
    if (prev && prev.length > 0) {
        for (const entry of prev) {
            const pool = pdfHlPools[entry.slot];
            if (pool) pool.delete(entry.range);
        }
        State.pageRangesMap.delete(pageIndex);
    }
}

function clearAllHighlights() {
    State.pageRangesMap.clear();
    for (let i = 0; i < pdfHlPools.length; i++) {
        if (pdfHlPools[i]) pdfHlPools[i].clear();
    }
    if (activeHitPool) activeHitPool.clear();
    State.activeHit = null;
    State.pendingJump = null;
    publishPdfHighlights();
}

function addRangesInsideElement(el, fromOffset, toOffset, outRanges) {
    if (!el || toOffset <= fromOffset) return;
    if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) {
        const node = el.firstChild;
        const f = Math.max(0, Math.min(node.length, fromOffset));
        const t = Math.max(f, Math.min(node.length, toOffset));
        if (t > f) {
            try {
                const r = new Range();
                r.setStart(node, f);
                r.setEnd(node, t);
                outRanges.push(r);
            } catch (_) { }
        }
        return;
    }

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
        const len = node.length;
        const nextPos = pos + len;
        if (nextPos > fromOffset && pos < toOffset) {
            const f = Math.max(0, fromOffset - pos);
            const t = Math.min(len, toOffset - pos);
            if (t > f) {
                try {
                    const r = new Range();
                    r.setStart(node, f);
                    r.setEnd(node, t);
                    outRanges.push(r);
                } catch (_) { }
            }
        }
        pos = nextPos;
        if (pos >= toOffset) break;
    }
}

function mapSpanToTextLayerRanges(textDivs, itemsMeta, matchStart, matchEnd) {
    const ranges = [];
    if (!Array.isArray(textDivs) || textDivs.length === 0 || !Array.isArray(itemsMeta) || itemsMeta.length === 0) {
        return ranges;
    }

    let lo = 0, hi = itemsMeta.length - 1, idx = itemsMeta.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (itemsMeta[mid].end > matchStart) { idx = mid; hi = mid - 1; }
        else lo = mid + 1;
    }

    for (let i = idx; i < itemsMeta.length && i < textDivs.length; i++) {
        const meta = itemsMeta[i];
        if (meta.start >= matchEnd) break;
        const div = textDivs[i];
        if (!div) continue;
        const from = Math.max(0, matchStart - meta.start);
        const to = Math.min(meta.end - meta.start, matchEnd - meta.start);
        if (to > from) addRangesInsideElement(div, from, to, ranges);
    }
    return ranges;
}

function computeLiveHitsForLayer(liveText, last) {
    const sw = window.top && window.top.sharedWasm;
    if (!sw || !sw.ready || typeof sw.find_content_matches_multi !== 'function') return [];
    if (last.isAds && Array.isArray(last.adsPositiveTerms)) {
        const raw = [];
        for (const pt of last.adsPositiveTerms) {
            raw.push(...collectWasmMatches(sw, liveText, pt.wasmKeywords, pt.noise, pt.termIdx));
        }
        return mergeWasmMatchSpans(raw).map(m => ({ localStart: m.start, localEnd: m.end, noise: m.noise }));
    }
    return collectWasmMatches(sw, liveText, last.wasmKeywords, last.noise, 0)
        .map(m => ({ localStart: m.start, localEnd: m.end, noise: m.noise }));
}

function paintPageHighlights(pageIndex) {
    if (!HL_SUPPORTED) return;
    clearPageHighlights(pageIndex);

    const last = State.lastSearch;
    if (!last) {
        publishPdfHighlights();
        return;
    }

    const app = window.PDFViewerApplication;
    const pageView = app && app.pdfViewer && app.pdfViewer.getPageView(pageIndex);
    const tlInfo = getRenderedTextLayerInfo(pageView);
    if (!tlInfo) return;

    const pageHits = last.pageHitsMap.get(pageIndex);
    if (!pageHits || pageHits.length === 0) return;

    const pageData = State.pages[pageIndex];
    let itemsMeta = (pageData && Array.isArray(pageData.items) && pageData.items.length === tlInfo.textDivs.length)
        ? pageData.items
        : null;
    let hitsToPaint = pageHits;

    if (!itemsMeta && tlInfo.textContentItemsStr.length === tlInfo.textDivs.length) {
        const live = buildPageTextFromStrings(tlInfo.textContentItemsStr);
        itemsMeta = live.items;
        hitsToPaint = computeLiveHitsForLayer(live.text, last);
    }
    if (!itemsMeta) return;

    const added = [];
    for (const hit of hitsToPaint) {
        const slot = pdfHlSlot(hit.noise);
        const pool = getPdfHlPool(slot);
        const ranges = mapSpanToTextLayerRanges(tlInfo.textDivs, itemsMeta, hit.localStart, hit.localEnd);
        for (const r of ranges) {
            pool.add(r);
            added.push({ slot, range: r });
        }
    }
    if (added.length > 0) State.pageRangesMap.set(pageIndex, added);

    if (activeHitPool && State.activeHit && State.activeHit.pageIndex === pageIndex) {
        activeHitPool.clear();
        const activeRanges = mapSpanToTextLayerRanges(tlInfo.textDivs, itemsMeta, State.activeHit.localStart, State.activeHit.localEnd);
        for (const r of activeRanges) activeHitPool.add(r);
    }

    publishPdfHighlights();
}

function paintAllRenderedPages() {
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfViewer) return;
    const total = app.pdfViewer.pagesCount || 0;
    for (let i = 0; i < total; i++) {
        const pv = app.pdfViewer.getPageView(i);
        if (getRenderedTextLayerInfo(pv)) paintPageHighlights(i);
    }
}

// =========================================================================
// 5. Wasm 宽容 + 近义搜索与分组聚合
// =========================================================================
async function waitForSharedWasm(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const sw = window.top && window.top.sharedWasm;
        if (sw && sw.ready && typeof sw.find_content_matches_multi === 'function') return sw;
        if (sw && sw.failed) return null;
        await new Promise(r => setTimeout(r, 40));
    }
    return null;
}

function u16ToCodePointIdx(str, u16Idx) {
    const clamped = Math.max(0, Math.min(str.length, u16Idx));
    let cp = 0;
    for (let i = 0; i < clamped; i++) {
        const c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < clamped) {
            const n = str.charCodeAt(i + 1);
            if (n >= 0xDC00 && n <= 0xDFFF) i++;
        }
        cp++;
    }
    return cp;
}

function buildCompactPreview(pageText, localStart, localEnd, noise, allPageHits = null) {
    const BEFORE = 10, AFTER = 18;
    const s = Math.max(0, localStart - BEFORE);
    const e = Math.min(pageText.length, localEnd + AFTER);
    const pre = s > 0 ? '…' : '';
    const suf = e < pageText.length ? '…' : '';
    const cleanSlice = pageText.slice(s, e).replace(/[\t\r\n]/g, ' ');
    const preview = pre + cleanSlice + suf;
    const shift = pre.length;

    if (Array.isArray(allPageHits) && allPageHits.length > 0) {
        const highlights = [];
        for (const m of allPageHits) {
            if (m.end <= s) continue;
            if (m.start >= e) break;
            const rs = shift + (Math.max(s, m.start) - s);
            const re = shift + (Math.min(e, m.end) - s);
            if (re > rs) {
                highlights.push([u16ToCodePointIdx(preview, rs), u16ToCodePointIdx(preview, re), m.noise]);
            }
        }
        if (highlights.length > 0) return { preview, highlights };
    }
    const hs = u16ToCodePointIdx(preview, shift + (localStart - s));
    const he = u16ToCodePointIdx(preview, shift + (localEnd - s));
    return { preview, highlights: [[hs, he, noise]] };
}

function buildSnippetItem(hit, radius = 64, samePageHits = null) {
    const pageData = State.pages[hit.pageIndex];
    if (!pageData || !pageData.text) return null;
    const text = pageData.text;
    const s = Math.max(0, hit.localStart - radius);
    const e = Math.min(text.length, hit.localEnd + radius);
    const pre = (s > 0 ? '…' : '') + `[p.${hit.pageNumber}] `;
    const suf = e < text.length ? '…' : '';
    const body = text.slice(s, e).replace(/[\t\r\n]/g, ' ');
    const t = pre + body + suf;
    const shift = pre.length;

    const h = [];
    const candidates = samePageHits || [hit];
    for (const item of candidates) {
        if (item.pageIndex !== hit.pageIndex) continue;
        if (item.localEnd <= s || item.localStart >= e) continue;
        const rs = Math.max(s, item.localStart) - s + shift;
        const re = Math.min(e, item.localEnd) - s + shift;
        if (re > rs) h.push([rs, re, item.noise]);
    }
    return { t, h };
}

async function runPdfSearch({ keyword, specs, noise, synonymsEnabled, adsPlan, token, reportStatus, cacheMeta }) {
    State.activeSearchToken = token;
    clearAllHighlights();

    const isAds = !!(adsPlan && Array.isArray(adsPlan.terms) && adsPlan.terms.length > 0 && adsPlan.expr);
    if (!keyword || !State.pdfDoc || (!isAds && (!Array.isArray(specs) || specs.length === 0))) {
        State.lastSearch = null;
        return { totalHits: 0, shownHits: 0, truncated: false, groups: [], groupUnit: State.groupUnit };
    }

    if (!State.extractDone && State.extractPromise) {
        State.extractBoosted = true;
        const onProg = (done, total) => {
            if (token === State.activeSearchToken && typeof reportStatus === 'function') {
                reportStatus(`正在提取 PDF 文本 ${done}/${total} 页...`);
            }
        };
        onProg(State.extractedCount, State.numPages);
        State.extractWaiters.push(onProg);
        try {
            await State.extractPromise;
        } finally {
            State.extractWaiters = State.extractWaiters.filter(fn => fn !== onProg);
        }
        if (token !== State.activeSearchToken) return null;
    }

    if (State.outlinePromise) {
        await State.outlinePromise;
        if (token !== State.activeSearchToken) return null;
    }

    const totalChars = State.pages.reduce((sum, p) => sum + ((p && p.text) ? p.text.trim().length : 0), 0);
    if (totalChars === 0) {
        State.lastSearch = null;
        return {
            keyword,
            totalHits: 0,
            shownHits: 0,
            truncated: false,
            groups: [],
            groupUnit: State.groupUnit,
            statusMsg: '该 PDF 无可选文本层（可能为扫描版）'
        };
    }

    const canCache = !!(State.bookKey && (!cacheMeta || cacheMeta.canCache !== false));
    const queryKey = canCache ? buildBookSearchCacheKey({
        bookSig: `pdf6:${State.numPages}:${State.sections.length}`,
        algoVer: (cacheMeta && cacheMeta.algoVer) || 11,
        synVer: (cacheMeta && cacheMeta.synVer) || '',
        keyword,
        noise,
        useSyn: !!synonymsEnabled,
        adsPlan: isAds ? adsPlan : null
    }) : '';

    if (canCache && queryKey) {
        const cached = await BookDB.getSearch(State.bookKey, queryKey);
        if (token !== State.activeSearchToken) return null;
        if (cached && Array.isArray(cached.hits) && Array.isArray(cached.groupMeta)) {
            const swLive = window.top && window.top.sharedWasm;
            const weighted = !!(swLive && swLive.weightedKeywords);
            let cachedWasmKws = [];
            let cachedAdsPos = null;
            if (isAds) {
                const terms = adsPlan.terms.map((t, idx) => ({
                    termIdx: idx,
                    noise: t.noise,
                    wasmKeywords: adaptKeywordsForWasm(t.specs, weighted)
                }));
                cachedAdsPos = collectAdsPositiveIndices(adsPlan.expr).map(idx => terms[idx]).filter(Boolean);
            } else {
                cachedWasmKws = adaptKeywordsForWasm(specs, weighted);
            }

            const groupMap = new Map();
            for (const gm of cached.groupMeta) {
                groupMap.set(gm.groupIndex, {
                    type: 'txt-group',
                    path: `txt-group:${gm.groupIndex}`,
                    groupIndex: gm.groupIndex,
                    title: gm.title,
                    percent: gm.percent,
                    count: gm.count,
                    hits: []
                });
            }
            const pageHitsMap = new Map();
            const hasExplicitPageHits = Array.isArray(cached.pageHitsEntries);
            if (hasExplicitPageHits) {
                for (const [pi, arr] of cached.pageHitsEntries) pageHitsMap.set(pi, arr);
            }
            for (const h of cached.hits) {
                const g = groupMap.get(h.sectionIdx);
                if (g) g.hits.push(h);
                if (!hasExplicitPageHits) {
                    let pArr = pageHitsMap.get(h.pageIndex);
                    if (!pArr) { pArr = []; pageHitsMap.set(h.pageIndex, pArr); }
                    pArr.push({ localStart: h.localStart, localEnd: h.localEnd, noise: h.noise });
                }
            }
            const groups = Array.from(groupMap.values()).sort((a, b) => a.groupIndex - b.groupIndex);
            State.lastSearch = {
                keyword,
                isAds,
                adsPositiveTerms: cachedAdsPos,
                wasmKeywords: cachedWasmKws,
                noise,
                hits: cached.hits,
                groups,
                groupMap,
                pageHitsMap
            };
            paintAllRenderedPages();
            return {
                keyword,
                totalHits: cached.totalHits,
                shownHits: cached.hits.length,
                truncated: !!cached.truncated,
                groups,
                groupUnit: cached.groupUnit || State.groupUnit
            };
        }
    }

    const sw = await waitForSharedWasm();
    if (token !== State.activeSearchToken) return null;
    if (!sw) throw new Error('Wasm 搜索引擎未就绪');

    if (typeof reportStatus === 'function') reportStatus('搜索中...');
    const MAX_RECORDED_HITS = 1500;

    const hits = [];
    const groupMap = new Map();
    const pageHitsMap = new Map();
    let totalHits = 0;

    const recordPageMatches = (pi, pageData, sec, matchList) => {
        const pHits = pageHitsMap.get(pi) || [];
        for (const m of matchList) {
            const localStart = m.start;
            const localEnd = m.end;
            const packedNoise = m.noise;
            totalHits++;
            pHits.push({ localStart, localEnd, noise: packedNoise });

            let g = groupMap.get(sec.index);
            if (!g) {
                g = {
                    type: 'txt-group',
                    path: `txt-group:${sec.index}`,
                    groupIndex: sec.index,
                    title: sec.title,
                    percent: sec.label,
                    count: 0,
                    hits: []
                };
                groupMap.set(sec.index, g);
            }
            g.count++;

            if (hits.length < MAX_RECORDED_HITS) {
                const compact = buildCompactPreview(pageData.text, localStart, localEnd, packedNoise, matchList);
                const hitObj = {
                    hitIndex: hits.length,
                    pageIndex: pi,
                    pageNumber: pageData.pageNumber,
                    sectionIdx: sec.index,
                    localStart,
                    localEnd,
                    noise: packedNoise,
                    termIdx: typeof m.termIdx === 'number' ? m.termIdx : 0,
                    percent: `p.${pageData.pageNumber}`,
                    preview: compact.preview,
                    highlights: compact.highlights
                };
                hits.push(hitObj);
                g.hits.push(hitObj);
            }
        }
        if (pHits.length > 0) pageHitsMap.set(pi, pHits);
    };

    let sliceStart = performance.now();
    let wasmKeywords = [];
    let adsPositiveTerms = null;

    if (isAds) {
        const terms = adsPlan.terms.map((t, idx) => ({
            termIdx: idx,
            noise: t.noise,
            wasmKeywords: adaptKeywordsForWasm(t.specs, !!sw.weightedKeywords)
        }));
        const posIndices = collectAdsPositiveIndices(adsPlan.expr);
        const posSet = new Set(posIndices);
        adsPositiveTerms = posIndices.map(idx => terms[idx]).filter(Boolean);

        const secs = (State.sections && State.sections.length > 0)
            ? State.sections
            : buildFixedPageSections(State.numPages).sections;

        for (const sec of secs) {
            if (token !== State.activeSearchToken) return null;
            const startPi = Math.max(0, sec.startPage - 1);
            const endPi = Math.min(State.pages.length - 1, sec.endPage - 1);
            if (endPi < startPi) continue;

            const termHitCache = new Map();
            const termMatchesByPage = new Map();

            const hasTermInSection = (tIdx) => {
                if (termHitCache.has(tIdx)) return termHitCache.get(tIdx);
                const term = terms[tIdx];
                if (!term || term.wasmKeywords.length === 0) {
                    termHitCache.set(tIdx, false);
                    return false;
                }
                const keepAll = posSet.has(tIdx);
                let found = false;
                let byPage = null;
                for (let pi = startPi; pi <= endPi; pi++) {
                    const pageData = State.pages[pi];
                    if (!pageData || !pageData.text) continue;
                    const matches = collectWasmMatches(sw, pageData.text, term.wasmKeywords, term.noise, tIdx);
                    if (matches.length > 0) {
                        found = true;
                        if (!keepAll) break;
                        if (!byPage) { byPage = new Map(); termMatchesByPage.set(tIdx, byPage); }
                        byPage.set(pi, matches);
                    }
                }
                termHitCache.set(tIdx, found);
                return found;
            };

            if (evalAdsExpr(adsPlan.expr, hasTermInSection)) {
                for (const pIdx of posIndices) hasTermInSection(pIdx);
                for (let pi = startPi; pi <= endPi; pi++) {
                    const pageData = State.pages[pi];
                    if (!pageData || !pageData.text) continue;
                    const raw = [];
                    for (const pIdx of posIndices) {
                        const byPage = termMatchesByPage.get(pIdx);
                        const m = byPage && byPage.get(pi);
                        if (m && m.length > 0) raw.push(...m);
                    }
                    if (raw.length > 0) recordPageMatches(pi, pageData, sec, mergeWasmMatchSpans(raw));
                }
            }

            if (performance.now() - sliceStart >= 10) {
                await new Promise(r => setTimeout(r, 0));
                sliceStart = performance.now();
            }
        }
    } else {
        wasmKeywords = adaptKeywordsForWasm(specs, !!sw.weightedKeywords);
        for (let pi = 0; pi < State.pages.length; pi++) {
            if (token !== State.activeSearchToken) return null;
            const pageData = State.pages[pi];
            if (!pageData || !pageData.text) continue;

            const matches = collectWasmMatches(sw, pageData.text, wasmKeywords, noise, 0);
            if (matches.length > 0) {
                recordPageMatches(pi, pageData, getSectionForPage(pageData.pageNumber), matches);
            }

            if (performance.now() - sliceStart >= 10) {
                await new Promise(r => setTimeout(r, 0));
                sliceStart = performance.now();
            }
        }
    }

    if (token !== State.activeSearchToken) return null;

    const groups = Array.from(groupMap.values()).sort((a, b) => a.groupIndex - b.groupIndex);
    const truncated = totalHits > hits.length;
    State.lastSearch = { keyword, isAds, adsPositiveTerms, wasmKeywords, noise, hits, groups, groupMap, pageHitsMap };

    if (canCache && queryKey) {
        const groupMeta = groups.map(g => ({
            groupIndex: g.groupIndex,
            title: g.title,
            percent: g.percent,
            count: g.count
        }));
        BookDB.putSearch(State.bookKey, queryKey, 'pdf', {
            keyword,
            isAds,
            totalHits,
            truncated,
            groupUnit: State.groupUnit,
            hits,
            groupMeta,
            pageHitsEntries: truncated ? Array.from(pageHitsMap.entries()) : null
        });
    }

    paintAllRenderedPages();

    return {
        keyword,
        totalHits,
        shownHits: hits.length,
        truncated,
        groups,
        groupUnit: State.groupUnit
    };
}

function getPdfSnippets(path) {
    const last = State.lastSearch;
    if (!last || typeof path !== 'string') return null;

    if (path.startsWith('txt-group:')) {
        const gIdx = Number(path.slice('txt-group:'.length));
        const g = last.groupMap.get(gIdx);
        if (!g) return null;
        const { items, more } = buildMergedGroupSnippets(g.hits, {
            maxItems: 40,
            radius: 54,
            maxWindowChars: 170,
            snapToNewline: false,
            getUnitKey: (h) => h.pageIndex,
            getUnitText: (h) => (State.pages[h.pageIndex] && State.pages[h.pageIndex].text) || '',
            getPrefix: (h, s) => (s > 0 ? '…' : '') + `[p.${h.pageNumber}] `
        });
        return {
            body: { hits: g.count, more: more + Math.max(0, g.count - g.hits.length), items },
            comments: { hits: 0, docs: 0, more: 0, items: [] }
        };
    }

    if (path.startsWith('txt-hit:')) {
        const hIdx = Number(path.slice('txt-hit:'.length));
        const h = last.hits[hIdx];
        if (!h) return null;
        const g = last.groupMap.get(h.sectionIdx);
        const it = buildSnippetItem(h, 130, g ? g.hits : [h]);
        return {
            body: { hits: 1, more: 0, items: it ? [it] : [] },
            comments: { hits: 0, docs: 0, more: 0, items: [] }
        };
    }
    return null;
}

// =========================================================================
// 6. 跨页锚记定位、居中滚动与脉冲反馈
// =========================================================================
function flashPulseAtRect(rect) {
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const el = document.createElement('div');
    el.className = 'pdf-hit-pulse';
    el.style.left = (rect.left - 4) + 'px';
    el.style.top = (rect.top - 3) + 'px';
    el.style.width = Math.max(18, rect.width + 8) + 'px';
    el.style.height = Math.max(18, rect.height + 6) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
}

function centerRectInViewer(rect) {
    if (!viewerCont || !rect) return;
    const vr = viewerCont.getBoundingClientRect();
    const targetTop = viewerCont.scrollTop + (rect.top - vr.top) - (vr.height - rect.height) / 2;
    const targetLeft = viewerCont.scrollLeft + (rect.left - vr.left) - (vr.width - rect.width) / 2;
    viewerCont.scrollTop = Math.max(0, targetTop);
    viewerCont.scrollLeft = Math.max(0, targetLeft);
}

function focusHitOnRenderedPage(hit) {
    const app = window.PDFViewerApplication;
    const pageView = app && app.pdfViewer && app.pdfViewer.getPageView(hit.pageIndex);
    const tlInfo = getRenderedTextLayerInfo(pageView);
    if (!tlInfo) return false;

    const pageData = State.pages[hit.pageIndex];
    let itemsMeta = (pageData && Array.isArray(pageData.items) && pageData.items.length === tlInfo.textDivs.length)
        ? pageData.items
        : null;
    let targetStart = hit.localStart;
    let targetEnd = hit.localEnd;

    if (!itemsMeta && tlInfo.textContentItemsStr.length === tlInfo.textDivs.length) {
        const live = buildPageTextFromStrings(tlInfo.textContentItemsStr);
        itemsMeta = live.items;
        const liveHits = State.lastSearch ? computeLiveHitsForLayer(live.text, State.lastSearch) : [];
        if (liveHits.length > 0) {
            let best = liveHits[0];
            let bestDist = Math.abs(best.localStart - hit.localStart);
            for (const lh of liveHits) {
                const d = Math.abs(lh.localStart - hit.localStart);
                if (d < bestDist) { bestDist = d; best = lh; }
            }
            targetStart = best.localStart;
            targetEnd = best.localEnd;
        }
    }
    if (!itemsMeta) return false;

    const ranges = mapSpanToTextLayerRanges(tlInfo.textDivs, itemsMeta, targetStart, targetEnd);
    if (HL_SUPPORTED && activeHitPool) {
        activeHitPool.clear();
        for (const r of ranges) activeHitPool.add(r);
        publishPdfHighlights();
    }

    const firstRect = ranges.length > 0 ? ranges[0].getBoundingClientRect() : null;
    if (firstRect && (firstRect.width > 0 || firstRect.height > 0)) {
        centerRectInViewer(firstRect);
        requestAnimationFrame(() => {
            const updated = ranges[0].getBoundingClientRect();
            flashPulseAtRect(updated);
        });
    }
    return true;
}

function jumpToPdfHit(hitIndex) {
    const last = State.lastSearch;
    if (!last) return;
    const hit = last.hits[hitIndex];
    if (!hit) return;

    State.activeHit = hit;
    const seq = ++State.jumpSeq;

    if (focusHitOnRenderedPage(hit)) {
        State.pendingJump = null;
        return;
    }

    State.pendingJump = { hit, seq };
    const app = window.PDFViewerApplication;
    if (app && app.pdfViewer) app.page = hit.pageNumber;
}

// =========================================================================
// 7. 绑定 PDF.js v6.5.438 生命周期与主站桥接
// =========================================================================
function onPdfDocumentReady(pdfDoc) {
    if (!pdfDoc || pdfDoc === State.pdfDoc) return;
    State.docGen++;
    const docGen = State.docGen;
    State.pdfDoc = pdfDoc;
    State.numPages = pdfDoc.numPages || 0;
    State.lastSearch = null;
    clearAllHighlights();

    const params = new URLSearchParams(window.location.search);
    const fileUrl = params.get('file') || '';
    State.title = decodeURIComponent((fileUrl.split('/').pop() || document.title || 'PDF').split('#')[0]);
    State.bookKey = (docGen === 1 && fileUrl) ? normalizeBookKey(fileUrl) : '';

    const initSections = buildFixedPageSections(State.numPages);
    State.sections = initSections.sections;
    State.groupUnit = initSections.groupUnit;

    startBackgroundPreExtraction(pdfDoc, docGen);

    const bridge = window.top && (window.top.__DOC_SEARCH_BRIDGE__ || window.top.__TXT_SEARCH_BRIDGE__);
    if (bridge) {
        if (!State.provider) {
            State.provider = {
                kind: 'pdf',
                title: State.title,
                runSearch: runPdfSearch,
                getSnippets: getPdfSnippets,
                jumpTo: jumpToPdfHit,
                clearHighlights: clearAllHighlights,
                onScopeChange: syncScopeUI
            };
            bridge.register(State.provider);
        } else {
            State.provider.title = State.title;
        }
    }
}

window.addEventListener('pagehide', (e) => {
    if (e.persisted) return;
    try {
        if (window.parent && window.parent.document) {
            window.parent.document.removeEventListener('fullscreenchange', syncToolbarOnParentFullscreen);
            window.parent.document.removeEventListener('webviewerloaded', lockPdfSecurityOptions);
        }
    } catch (_) { }
    State.docGen++;
    clearAllHighlights();
    const bridge = window.top && (window.top.__DOC_SEARCH_BRIDGE__ || window.top.__TXT_SEARCH_BRIDGE__);
    if (bridge && State.provider) bridge.unregister(State.provider);
    if (window.__LITE_BUS__) {
        try { window.__LITE_BUS__.close(); } catch (_) { }
        window.__LITE_BUS__ = null;
    }
});

async function initPdfSearchBridge() {
    let tries = 0;
    while (!window.PDFViewerApplication && tries < 200) {
        await new Promise(r => setTimeout(r, 25));
        tries++;
    }
    const app = window.PDFViewerApplication;
    if (!app) return;
    try { await app.initializedPromise; } catch (_) { }

    syncHorizontalWheelMode(app.pdfViewer ? app.pdfViewer.scrollMode : undefined);

    if (app.eventBus) {
        app.eventBus.on('scrollmodechanged', (evt) => {
            syncHorizontalWheelMode(evt && typeof evt.mode === 'number' ? evt.mode : undefined);
        });
        app.eventBus.on('documentinit', () => {
            syncHorizontalWheelMode(app.pdfViewer ? app.pdfViewer.scrollMode : undefined);
            if (app.pdfDocument) onPdfDocumentReady(app.pdfDocument);
        });
        app.eventBus.on('textlayerrendered', (evt) => {
            if (!evt || !Number.isInteger(evt.pageNumber)) return;
            const pageIndex = evt.pageNumber - 1;
            if (State.lastSearch) paintPageHighlights(pageIndex);
            if (State.pendingJump && State.pendingJump.hit.pageIndex === pageIndex) {
                const pj = State.pendingJump;
                State.pendingJump = null;
                focusHitOnRenderedPage(pj.hit);
            }
        });
        app.eventBus.on('namedaction', (evt) => {
            if (evt && evt.action === 'Find') {
                if (app.findBar && app.findBar.opened) app.findBar.close();
                openMainBookSearch({ forceBook: true });
            }
        });
    }

    if (app.pdfDocument) onPdfDocumentReady(app.pdfDocument);
}

initPdfSearchBridge();
