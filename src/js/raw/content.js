(function interceptTextarea() {
    const observer = new MutationObserver((mutations, obs) => {
        const zhText = document.getElementById('zhText');
        if (zhText) {
            patchValueProperty(zhText);
            obs.disconnect();
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('DOMContentLoaded', () => observer.disconnect());

    let highlightTimer = null;
    function patchValueProperty(el) {
        if (!Object.getOwnPropertyDescriptor(el, 'value')) {
            Object.defineProperty(el, 'value', {
                get: function () { return this.innerText; },
                set: function (val) {
                    this.innerText = val;
                    clearTimeout(highlightTimer);
                    highlightTimer = setTimeout(() => {
                        try {
                            const nav = document.getElementById('s_nav');
                            const isSearchActive = nav && nav.innerHTML.trim() !== '';
                            if (isSearchActive) {
                                nav.innerHTML = '';
                                sessionStorage.setItem('jump_from_search_ex', JSON.stringify("1"));
                                if (typeof search === 'function') {
                                    search();
                                }
                            }
                        } catch (e) {
                            console.error("恢复高亮失败:", e);
                        }
                    }, 150);
                }
            });
        }
    }
})();

if (window.top === window.self) {
    window.location.href = location.origin;
} else if (window.parent !== window.top) {
    window.top.location.href = location.origin;
}

if (window.top && window.top.VirtualCursor) {
    window.top.VirtualCursor.attach(window);
}

const childId = 'content';
window.childId = childId;
const store = createStore();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

let toc_flag = false;
let isAutoScrolling = false;

let wasmEngineReady = false;
let format_markdown = null;
let compute_lcs_diff = null;

let _diffMinimapEl = null;
let _diffMinimapResizeBound = false;
let _diffMinimapResizeTimer = null;
let _diffMinimapActivePre = null;

let _searchMinimapEl = null;
let _searchMinimapResizeBound = false;
let _searchMinimapResizeTimer = null;
let _searchMinimapResizeHandler = null;

let find_content_matches_multi = null;

const SYN_HL_BIT = 0x100;
const SEARCH_HL_STYLE = [[0.80, '#000'], [0.65, '#111'], [0.52, '#111'], [0.42, '#333'], [0.34, '#333'], [0.28, '#333']];
const SEARCH_SYN_HL_STYLE = [[0.55, '#000'], [0.45, '#111'], [0.38, '#111'], [0.32, '#333'], [0.26, '#333'], [0.22, '#333']];
const SEARCH_SYN2_HL_STYLE = [[0.38, '#000'], [0.32, '#111'], [0.27, '#111'], [0.23, '#333'], [0.19, '#333'], [0.16, '#333']];
const searchHlTier = (noise) => Math.min(((noise | 0) >> 8) & 3, 2);
const searchHlWeight = (noise) => (noise >>> 16) & 255;
const searchHlIsSyn = (noise) => searchHlTier(noise) > 0;
const searchHlBucket = (noise) => Math.min(Math.max((noise | 0) & 0xff, 0), SEARCH_HL_STYLE.length - 1);
const searchHlSlot = (noise) => searchHlTier(noise) * SEARCH_HL_STYLE.length + searchHlBucket(noise);
const searchHlNameBySlot = (slot) => {
    const tierSize = SEARCH_HL_STYLE.length;
    if (slot < tierSize) return (slot <= 0 ? 'search-exact' : `search-noise-${slot}`);
    if (slot < tierSize * 2) return `search-syn-${slot - tierSize}`;
    return `search-syn2-${slot - tierSize * 2}`;
};
const searchHl = [];
let wasmSupportsWeighted = false;

function adaptContentKeywords(keywords) {
    if (!Array.isArray(keywords)) return [];
    if (wasmSupportsWeighted) return keywords;
    return keywords
        .map(item => (typeof item === 'string' ? item : (item && typeof item.text === 'string' ? item.text : '')))
        .filter(Boolean);
}

function buildContentTermSpecs(keyword, synonymsEnabled) {
    if (window.top && typeof window.top.buildTermSpecs === 'function') {
        return adaptContentKeywords(window.top.buildTermSpecs(keyword, synonymsEnabled));
    }
    const raw = String(keyword || '');
    const compact = raw.replace(/\s+/g, '');
    if (!compact) return [];
    return wasmSupportsWeighted ? [{ text: compact, weight: 100, tier: 0 }] : [compact];
}

function ensureSearchHighlightStyle() {
    if (document.getElementById('search-hl-static')) return;
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

function getSearchHighlight(noise) {
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

function resetSearchHighlights() {
    searchHl.forEach(h => { if (h) h.clear(); });
}

function publishSearchHighlights() {
    searchHl.forEach((h, slot) => {
        if (h && h.size > 0) CSS.highlights.set(searchHlNameBySlot(slot), h);
        else CSS.highlights.delete(searchHlNameBySlot(slot));
    });
}

const wasmInitPromise = (async () => {
    const resolveWasm = (sw) => {
        format_markdown = sw.format_markdown;
        find_content_matches_multi = sw.find_content_matches_multi;
        compute_lcs_diff = sw.compute_lcs_diff;
        wasmSupportsWeighted = !!sw.weightedKeywords;
        wasmEngineReady = true;
    };

    if (window.top && window.top.sharedWasm && window.top.sharedWasm.ready) {
        resolveWasm(window.top.sharedWasm);
        return;
    }

    await new Promise((resolve) => {
        const check = setInterval(() => {
            if (window.top && window.top.sharedWasm && window.top.sharedWasm.ready) {
                clearInterval(check);
                resolveWasm(window.top.sharedWasm);
                resolve();
            }
        }, 20);
    });
})();

if (window.__LITE_BUS__) {
    window.__LITE_BUS__.close();
}
window.__LITE_BUS__ = new BroadcastChannel('bus');
const BUS = window.__LITE_BUS__;

window.addEventListener('pagehide', (e) => {
    if (e.persisted) return;
    emitEvent("lightbox", { status: "0" }, "index");
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
});

const ctxId = window.top === window.self ? 'index' : window.childId;
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
    } catch (e) { }
}

window._activeSearchBorders = [];
function clearActiveSearchBorders() {
    if (window._activeSearchBorders.length > 0) {
        window._activeSearchBorders.forEach(el => el.remove());
        window._activeSearchBorders = [];
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}

window._searchMatchRanges = new Map();

BUS.addEventListener('message', (e) => {
    const { type, payload, target, from, tabId } = e.data || {};
    const myTab = getTabId();
    if (tabId && myTab && tabId !== myTab) return;
    if (target !== '*' && target !== ctxId) return;

    switch (type) {
        case "cm_count":
            $("#cm").innerText = "💬 " + payload;
            if (payload !== 0) {
                var str = payload > 1 ? " comments" : " comment";
                $("#cm").title = payload + str;
            }
            $("#cm").style.display = "block";
            break;

        case "LOCAL_SEARCH_COUNT":
            (async () => {
                if (!wasmEngineReady) await wasmInitPromise;
                const resultObj = await countMatchesEnhanced(payload);
                emitEvent("LOCAL_SEARCH_RESULT", {
                    keyword: payload,
                    count: resultObj.count,
                    adsBodyHits: resultObj.adsBodyHits,
                    title: document.title
                }, "index");
            })();
            break;

        case "LOCAL_SEARCH_SNIPPETS":
            (async () => {
                if (!wasmEngineReady) await wasmInitPromise;
                const reqId = payload && payload.reqId;
                const kw = payload && payload.keyword;
                const maxBody = (payload && typeof payload.maxBody === 'number') ? payload.maxBody : 40;
                const body = await buildLocalSnippets(kw, maxBody);
                emitEvent("LOCAL_SEARCH_SNIPPETS_RESULT", { reqId, body }, "index");
            })();
            break;

        case "DESTROY_HIGHLIGHT":
            _searchSeq++;
            if (CSS.highlights) {
                CSS.highlights.clear();
            }
            if (window._searchMatchRanges) {
                window._searchMatchRanges.clear();
            }
            clearActiveSearchBorders();
            hideSearchMinimap();

            const destroyBtn = document.getElementById("destroy");
            if (destroyBtn) {
                destroyBtn.click();
            } else {
                document.querySelectorAll(".match-highlight").forEach(h => {
                    h.parentNode.replaceChild(document.createTextNode(h.textContent), h);
                });
                const nav = document.getElementById("s_nav");
                if (nav) nav.innerHTML = "";
            }

            store.jump_from_search = "0";
            store.jump_from_search_ex = "0";
            break;

        case "REFRESH_HIGHLIGHT":
            (async () => {
                if (window._isDiffMode) return;
                if (!payload || !payload.keyword) return;
                if (!wasmEngineReady) await wasmInitPromise;
                store.keyword = payload.keyword;
                store.jump_from_search_ex = "1";
                search(true);
            })();
            break;

        default:
            break;
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        emitEvent("quick_search", "", "index");
    }
});

(function initStyles() {
    const style = document.createElement('style');
    style.id = 'content-init-fade';
    style.textContent = "body { opacity: 0; transition: opacity 0.3s ease; }";
    document.documentElement.appendChild(style);
    if (!document.querySelector('link[href*="font.css"]')) {
        const fcss = document.createElement('link');
        fcss.rel = 'stylesheet';
        fcss.href = '../src/css/font.css';
        document.head.appendChild(fcss);
    }
    if (!document.querySelector('link[href*="content.css"]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '../src/css/content.css';
        document.head.appendChild(css);
    }
})();

function createStore(defaults = {}) {
    return window.top.SiteCore.createStore(defaults);
}

async function format() {
    return new Promise((resolve) => {
        const anchorNode = document.querySelector("#anchor");

        try {
            const preTag = document.querySelector('pre');
            if (!preTag) {
                postProcess(anchorNode);
                resolve();
                return;
            }

            const textNodes = Array.from(preTag.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);

            window._rawHtmlForDiff = preTag.innerHTML;

            let outHtmlArr = [];

            textNodes.forEach(node => {
                outHtmlArr.push(format_markdown(node.nodeValue));
            });
            textNodes.forEach((node, i) => {
                const fragment = document.createRange().createContextualFragment(outHtmlArr[i]);
                node.replaceWith(fragment);
            });

            postProcess(anchorNode);
            resolve();

        } catch (error) {
            console.error("[Wasm] 渲染引擎解析失败:", error);
            postProcess(anchorNode);
            resolve();
        }
    });

    function format_date(datePart) {
        if (!datePart || datePart.length < 14) return "Unknown Date";
        try {
            const year = datePart.substring(0, 4);
            const month = parseInt(datePart.substring(4, 6)) - 1;
            const day = datePart.substring(6, 8);
            const hours = datePart.substring(8, 10);
            const minutes = datePart.substring(10, 12);
            const seconds = datePart.substring(12, 14);
            const date = new Date(year, month, day, hours, minutes, seconds);
            const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' };
            return date.toLocaleDateString('en-US', options);
        } catch (e) { return "Invalid Date"; }
    }

    function postProcess(anchor) {
        document.querySelectorAll('pre.consumed').forEach(pre => {
            const spans = Array.from(pre.querySelectorAll('span.lv0')).filter(s => s.className.trim() === 'lv0' && !s.querySelector('span'));
            const total = spans.length;
            spans.forEach((s, i) => s.dataset.index = "[" + (total - i) + "]");
        });

        const paragraphs = Array.from(document.querySelectorAll('p'));
        paragraphs.forEach(paragraph => {
            paragraph.replaceWith(renderP2TableEl(paragraph.textContent));
        });

        const anchorText = anchor ? anchor.innerHTML : "";
        const parts = anchorText.split("-");
        if (parts.length < 2) parts.push("");
        const bar = document.createElement("div");
        bar.id = "bar";

        bar.innerHTML = `
            <span id='s_nav'></span>
            <span id='diff-btn'></span>
            <span id='cm' title='0 comment' style="display:none">💬</span>
            <span id='stamp' title='${format_date(parts[0])}'>${parts[1]} > ${document.title}</span>
            <div style='top:0;left:0'>
                <div id='processBar' style='height: 3px; background: violet; width: 0%;'></div>
            </div>
        `;
        document.body.appendChild(bar);
        const cmEl = document.getElementById("cm");
        if (cmEl) {
            cmEl.addEventListener("click", () => {
                emitEvent("sh_comments", document.getElementById("stamp")?.innerText || "", "index");
            });
        }

        initDiffUI();

        let ticking = false;
        window.addEventListener("scroll", () => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
                    const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
                    const scrolled = scrollHeight === 0 ? 0 : (scrollTop / scrollHeight) * 100;
                    document.getElementById("processBar").style.width = `${scrolled}%`;
                    ticking = false;
                });
                ticking = true;
            }
        });

        if (store.online_flag == "0") {
            document.getElementById("stamp").ondblclick = () => {
                store.jump_from_search = "0";
                location.reload();
            };

            document.getElementById("s_nav").insertAdjacentHTML("afterend",
                `<span style='float: left' id='edit' title='用 VS Code 编辑并自动监听保存重载'>edit</span>`
            );
            const editEl = document.getElementById("edit");
            if (editEl) {
                const LIVE_EDIT_KEY = '__swamp_live_edit__';
                const LIVE_SCROLL_KEY = '__swamp_live_edit_scroll__';
                let liveAbort = null;
                let liveWatchActive = false;

                const callApi = async (method, endpoint, body = null, options = {}) => {
                    if (window.top && typeof window.top.callLocalApi === "function") {
                        return window.top.callLocalApi(method, endpoint, body, options);
                    }
                    const m = await import("/src/js/shared-utils.js");
                    return m.callLocalApi(method, endpoint, body, options);
                };

                const setEditIndicator = (watching) => {
                    liveWatchActive = watching;
                    if (watching) {
                        editEl.textContent = "edit ●";
                        editEl.style.color = "#16a34a";
                        editEl.title = "实时监听 VS Code 保存中（左键切回 VS Code，右键停止监听）";
                    } else {
                        editEl.textContent = "edit";
                        editEl.style.color = "";
                        editEl.title = "用 VS Code 编辑并自动监听保存重载";
                    }
                };

                const stopLiveWatch = (clearSession = true) => {
                    if (liveAbort) {
                        try { liveAbort.abort(); } catch (_) { }
                        liveAbort = null;
                    }
                    if (clearSession) {
                        try { sessionStorage.removeItem(LIVE_EDIT_KEY); } catch (_) { }
                    }
                    setEditIndicator(false);
                };

                const startLiveWatch = (initialSig) => {
                    if (!initialSig) return;
                    if (liveAbort) {
                        try { liveAbort.abort(); } catch (_) { }
                    }
                    const ctrl = new AbortController();
                    liveAbort = ctrl;
                    setEditIndicator(true);

                    (async () => {
                        let curSig = initialSig;
                        let consecutiveErrors = 0;
                        while (!ctrl.signal.aborted) {
                            try {
                                const qs = `title=${encodeURIComponent(document.title)}&sig=${encodeURIComponent(curSig)}`;
                                const res = await callApi('GET', `/__api/ops/watch-html?${qs}`, null, { signal: ctrl.signal });
                                if (ctrl.signal.aborted) return;
                                consecutiveErrors = 0;
                                if (res && res.changed && res.sig) {
                                    curSig = res.sig;
                                    try {
                                        sessionStorage.setItem(LIVE_EDIT_KEY, JSON.stringify({ title: document.title, sig: curSig }));
                                        const y = window.pageYOffset || document.documentElement.scrollTop || 0;
                                        sessionStorage.setItem(LIVE_SCROLL_KEY, JSON.stringify({ title: document.title, y }));
                                    } catch (_) { }
                                    store.jump_from_search = "0";
                                    location.reload();
                                    return;
                                }
                            } catch (err) {
                                if (ctrl.signal.aborted || (err && err.name === 'AbortError')) return;
                                if (err && (err.status === 401 || err.status === 404)) {
                                    stopLiveWatch(true);
                                    return;
                                }
                                consecutiveErrors++;
                                if (consecutiveErrors > 10) {
                                    stopLiveWatch(false);
                                    return;
                                }
                                await new Promise(r => setTimeout(r, 2000));
                            }
                        }
                    })();
                };

                // 重载后立即还原滚动位置并延续当前页监听态（切到其他文章自动清理）
                try {
                    const savedScroll = JSON.parse(sessionStorage.getItem(LIVE_SCROLL_KEY) || 'null');
                    if (savedScroll && savedScroll.title === document.title && Number.isFinite(savedScroll.y)) {
                        sessionStorage.removeItem(LIVE_SCROLL_KEY);
                        const targetY = savedScroll.y;
                        requestAnimationFrame(() => {
                            window.scrollTo(0, targetY);
                            setTimeout(() => window.scrollTo(0, targetY), 80);
                        });
                    }
                    const savedLive = JSON.parse(sessionStorage.getItem(LIVE_EDIT_KEY) || 'null');
                    if (savedLive && savedLive.title === document.title && savedLive.sig) {
                        startLiveWatch(savedLive.sig);
                    } else if (savedLive && savedLive.title !== document.title) {
                        sessionStorage.removeItem(LIVE_EDIT_KEY);
                    }
                } catch (_) { }

                editEl.addEventListener("click", async () => {
                    try {
                        const res = await callApi('POST', '/__api/ops/edit', { title: document.title });
                        if (res && res.sig) {
                            try {
                                sessionStorage.setItem(LIVE_EDIT_KEY, JSON.stringify({ title: document.title, sig: res.sig }));
                            } catch (_) { }
                            startLiveWatch(res.sig);
                        }
                    } catch (err) {
                        alert('❌ 打开编辑失败：' + (err && err.message ? err.message : String(err)));
                    }
                });

                editEl.addEventListener("contextmenu", (e) => {
                    if (!liveWatchActive) return;
                    e.preventDefault();
                    stopLiveWatch(true);
                });

                const abortOnLeave = () => {
                    if (liveAbort) {
                        try { liveAbort.abort(); } catch (_) { }
                        liveAbort = null;
                    }
                };
                window.addEventListener("pagehide", abortOnLeave);
                window.addEventListener("beforeunload", abortOnLeave);
            }
        }
    }
}

const PAGE_BLOCK_SEL = 'p,div,li,ul,ol,dl,dt,dd,table,thead,tbody,tfoot,tr,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,header,footer,figure,figcaption';

function makeBlockBreakDetector() {
    const cache = new WeakMap();
    const blockOf = (node) => {
        const el = node.parentElement;
        if (!el) return null;
        let b = cache.get(el);
        if (b === undefined) {
            b = el.closest(PAGE_BLOCK_SEL);
            cache.set(el, b);
        }
        return b;
    };
    let prev;
    return (node) => {
        const cur = blockOf(node);
        const isBreak = prev !== undefined && cur !== prev;
        prev = cur;
        return isBreak;
    };
}

function getTopAdsPosTerms(rawKeyword) {
    if (window.top && typeof window.top.buildAdsPositiveTerms === 'function') {
        return window.top.buildAdsPositiveTerms(rawKeyword) || [];
    }
    return [];
}

function evaluateAdsPage(globalText, rawKeyword) {
    const rawMatches = [];
    let adsBodyHits = null;
    const titleText = document.title || '';

    if (window.top && typeof window.top.parseAdsQuery === 'function') {
        const plan = window.top.parseAdsQuery(rawKeyword);
        if (plan && plan.ok && Array.isArray(plan.terms)) {
            const posSet = new Set();
            const collectPos = (n) => {
                if (!n) return;
                if (n.op === 'term') { if (!n.neg) posSet.add(n.term); }
                else if (Array.isArray(n.args)) n.args.forEach(collectPos);
            };
            collectPos(plan.expr);

            adsBodyHits = plan.terms.map((t, idx) => {
                const kws = buildContentTermSpecs(t.text, !!t.like);
                if (posSet.has(idx)) {
                    const res = find_content_matches_multi(globalText, kws, t.noise);
                    const buf = res.matches;
                    const cnt = res.count || 0;
                    for (let i = 0; i < cnt; i++) {
                        rawMatches.push({ start: buf[i * 3], end: buf[i * 3 + 1], noise: buf[i * 3 + 2] });
                    }
                    if (cnt > 0) return true;
                    return (find_content_matches_multi(titleText, kws, t.noise).count || 0) > 0;
                }
                return (find_content_matches_multi(titleText, kws, t.noise).count || 0) > 0
                    || (find_content_matches_multi(globalText, kws, t.noise).count || 0) > 0;
            });
            return { rawMatches, adsBodyHits };
        }
    }

    const posTerms = getTopAdsPosTerms(rawKeyword);
    for (const t of posTerms) {
        const res = find_content_matches_multi(globalText, adaptContentKeywords(t.keywords), t.noise);
        const buf = res.matches;
        const cnt = res.count || 0;
        for (let i = 0; i < cnt; i++) {
            rawMatches.push({ start: buf[i * 3], end: buf[i * 3 + 1], noise: buf[i * 3 + 2] });
        }
    }
    return { rawMatches, adsBodyHits };
}

function mergeMatchSpans(rawMatches) {
    rawMatches.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const m of rawMatches) {
        const last = merged[merged.length - 1];
        if (last && m.start < last.end) {
            const lastLen = last.end - last.start;
            const curLen = m.end - m.start;
            const lastNoise = last.noise & 255;
            const curNoise = m.noise & 255;
            const lastTier = searchHlTier(last.noise);
            const curTier = searchHlTier(m.noise);
            const lastWeight = searchHlWeight(last.noise);
            const curWeight = searchHlWeight(m.noise);
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

async function ensureContentTermSpecs(keyword) {
    if (!keyword || !window.top || typeof window.top.ensureTermSpecs !== 'function') return;
    if (/^[@＠][\[［【]/.test(keyword)) {
        if (typeof window.top.parseAdsQuery === 'function') {
            const plan = window.top.parseAdsQuery(keyword);
            if (plan && plan.ok && Array.isArray(plan.terms)) {
                await window.top.ensureTermSpecs(
                    plan.terms.filter(t => t && t.like).map(t => ({ text: t.text, like: true }))
                );
            }
        }
    } else if ((store.synonyms_enabled ?? 1) === 1) {
        await window.top.ensureTermSpecs([{ text: keyword, like: true }]);
    }
}

function analyzePageMatches(globalText, rawKeyword) {
    if (/^@(bomb|rebirth)$/.test(rawKeyword)) {
        return { matches: [], titleHits: 0, adsBodyHits: null };
    }
    const isAds = /^[@＠][\[［【]/.test(rawKeyword);
    let rawMatches = [];
    let adsBodyHits = null;
    let titleHits = 0;
    const titleText = document.title || '';

    if (isAds) {
        const evaluated = evaluateAdsPage(globalText, rawKeyword);
        rawMatches = evaluated.rawMatches;
        adsBodyHits = evaluated.adsBodyHits;
        if (titleText) {
            const titleRaw = [];
            for (const posTerm of getTopAdsPosTerms(rawKeyword)) {
                const tm = find_content_matches_multi(titleText, adaptContentKeywords(posTerm.keywords), posTerm.noise);
                const arr = tm.matches;
                const cnt = tm.count || 0;
                for (let k = 0; k < cnt; k++) {
                    titleRaw.push({ start: arr[k * 3], end: arr[k * 3 + 1], noise: arr[k * 3 + 2] });
                }
            }
            titleHits = mergeMatchSpans(titleRaw).length;
        }
    } else {
        const noise = Number(store.noise_level ?? 5);
        const synonymsEnabled = (store.synonyms_enabled ?? 1) === 1;
        const kws = buildContentTermSpecs(rawKeyword, synonymsEnabled);
        const res = find_content_matches_multi(globalText, kws, noise);
        const buf = res.matches;
        const cnt = res.count || 0;
        for (let i = 0; i < cnt; i++) {
            rawMatches.push({ start: buf[i * 3], end: buf[i * 3 + 1], noise: buf[i * 3 + 2] });
        }
        if (titleText) {
            titleHits = find_content_matches_multi(titleText, kws, noise).count || 0;
        }
    }

    const merged = mergeMatchSpans(rawMatches);
    return {
        matches: merged.map((m, index) => ({ ...m, index })),
        titleHits,
        adsBodyHits
    };
}

let _searchSeq = 0;

async function search(preserveScroll = false) {
    if (window._isDiffMode) return;
    if (store.jump_from_search_ex !== "1") return;
    store.jump_from_search_ex = "0";

    const rawKeyword = (store.keyword || "").trim();
    if (!rawKeyword || !wasmEngineReady) return;
    const mySeq = ++_searchSeq;
    await ensureContentTermSpecs(rawKeyword);
    if (mySeq !== _searchSeq) return;

    const { globalText, nodeMap } = collectPageSearchText(true);

    const { matches, titleHits, adsBodyHits } = analyzePageMatches(globalText, rawKeyword);
    const totalMatches = matches.length;
    const totalReportCount = totalMatches + (titleHits || 0);

    if (matches.length === 0) {
        if (CSS.highlights) CSS.highlights.clear();
        resetSearchHighlights();
        if (window._searchMatchRanges) window._searchMatchRanges.clear();
        clearActiveSearchBorders();
        hideSearchMinimap();
        const nav = $("#s_nav");
        if (nav) nav.innerHTML = "";
        emitEvent("LOCAL_SEARCH_RESULT", { keyword: rawKeyword, count: totalReportCount, adsBodyHits, title: document.title }, "index");
        return;
    }

    if (!CSS.highlights) {
        console.warn("浏览器不支持 CSS Highlights，高亮渲染已中止。建议升级浏览器。");
        return;
    }

    CSS.highlights.clear();
    window._searchMatchRanges.clear();
    clearActiveSearchBorders();

    ensureSearchHighlightStyle();
    resetSearchHighlights();

    let mi = 0;
    nodeMap.forEach(item => {
        const node = item.node;
        const nodeText = node.nodeValue;

        while (mi < matches.length && matches[mi].end <= item.start) mi++;
        for (let k = mi; k < matches.length && matches[k].start < item.end; k++) {
            const hit = matches[k];
            if (hit.end <= item.start) continue;

            const localStart = Math.max(hit.start - item.start, 0);
            const localEnd = Math.min(hit.end - item.start, nodeText.length);

            if (localEnd > localStart) {
                const range = new Range();
                range.setStart(node, localStart);
                range.setEnd(node, localEnd);

                getSearchHighlight(hit.noise || 0).add(range);

                if (!window._searchMatchRanges.has(hit.index)) {
                    window._searchMatchRanges.set(hit.index, []);
                }
                window._searchMatchRanges.get(hit.index).push(range);
            }
        }
    });

    publishSearchHighlights();

    emitEvent("LOCAL_SEARCH_RESULT", {
        keyword: rawKeyword,
        count: totalReportCount,
        adsBodyHits,
        title: document.title
    }, "index");

    let currentIndex = 0;

    window._jumpToSearchIndex = (idx) => {
        if (idx < 0 || idx >= totalMatches) return;
        currentIndex = idx;
        updateIndexDisplay();
    };

    function updateIndexDisplay(noScroll = false) {
        let indexDisplay = $("#indexDisplay");
        if (!indexDisplay) {
            indexDisplay = document.createElement("button");
            indexDisplay.id = "indexDisplay";

            const destroyButton = document.createElement("button");
            destroyButton.id = "destroy";
            destroyButton.innerText = "destroy";
            destroyButton.onclick = function () {
                _searchSeq++;
                if (CSS.highlights) CSS.highlights.clear();
                resetSearchHighlights();
                if (window._searchMatchRanges) window._searchMatchRanges.clear();
                clearActiveSearchBorders();
                hideSearchMinimap();
                const nav = $("#s_nav");
                if (nav) nav.innerHTML = "";
                store.jump_from_search = "0";
                store.jump_from_search_ex = "0";
            };

            const nav = $("#s_nav");
            if (nav) {
                nav.appendChild(indexDisplay);
                nav.appendChild(destroyButton);
            }
        }

        indexDisplay.innerText = " " + (currentIndex + 1) + " / " + totalMatches;

        clearActiveSearchBorders();

        const currentGroupRanges = window._searchMatchRanges.get(currentIndex) || [];
        if (currentGroupRanges.length > 0) {
            const fragment = document.createDocumentFragment();

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            currentGroupRanges.forEach(range => {
                const rect = range.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return;
                minX = Math.min(minX, rect.left);
                minY = Math.min(minY, rect.top);
                maxX = Math.max(maxX, rect.right);
                maxY = Math.max(maxY, rect.bottom);
            });

            if (minX !== Infinity) {
                const box = document.createElement('div');
                box.className = 'active-search-border';
                box.style.cssText = `
                    left: ${window.scrollX + minX - 4}px; 
                    top: ${window.scrollY + minY - 3}px; 
                    width: ${maxX - minX + 8}px; 
                    height: ${maxY - minY + 8}px; 
                `;
                fragment.appendChild(box);
                window._activeSearchBorders.push(box);
            }
            document.body.appendChild(fragment);

            if (!noScroll) {
                isAutoScrolling = true;
                const firstRange = currentGroupRanges[0];
                const rect = firstRange.getBoundingClientRect();
                const absoluteTop = window.scrollY + rect.top;

                window.scrollTo({
                    top: absoluteTop - (window.innerHeight / 2),
                    behavior: "smooth"
                });

                setTimeout(() => { isAutoScrolling = false; }, 600);
            }
        }
    }

    function createNavigationButtons() {
        const prevButton = document.createElement("button");
        prevButton.innerText = "prev";
        prevButton.onclick = () => {
            currentIndex = (currentIndex - 1 + totalMatches) % totalMatches;
            updateIndexDisplay();
        };

        const nextButton = document.createElement("button");
        nextButton.innerText = "next";
        nextButton.onclick = () => {
            currentIndex = (currentIndex + 1) % totalMatches;
            updateIndexDisplay();
        };

        const nav = $("#s_nav");
        if (nav) {
            nav.appendChild(prevButton);
            nav.appendChild(nextButton);
        }
    }

    if (totalMatches > 0) {
        const nav = $("#s_nav");
        if (nav) nav.innerHTML = "";
        createNavigationButtons();
        updateIndexDisplay(preserveScroll);
        updateSearchMinimap();
    }
}

function collectPageSearchText(withNodeMap = false) {
    const contentRoot =
        document.querySelector('pre:not(#diff-pre)') ||
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;

    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== contentRoot) {
                const tag = el.tagName ? el.tagName.toUpperCase() : '';
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
                    return NodeFilter.FILTER_REJECT;
                }
                const id = el.id || '';
                const cls = el.className || '';
                if (
                    id === 'bar' || id === 'toc' || id === 'toc-list' || id === 's_nav' ||
                    id === 'gotop' || id === 'diff-minimap' || id === 'search-minimap' || id === 'diff-controls-wrapper' ||
                    id === 'excerpt-pop-btn' || id === 'pinyin-tooltip' ||
                    id === 'anchor' || id === 'lock-screen' || id === 'control-panel' ||
                    (typeof cls === 'string' && (
                        cls.includes('active-search-border') ||
                        cls.includes('toc-toggle')
                    ))
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    }, false);

    let globalText = "";
    const nodeMap = withNodeMap ? [] : null;
    let currentPos = 0;
    const isBlockBreak = makeBlockBreakDetector();

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const val = node.nodeValue;
        if (!val) continue;
        if (isBlockBreak(node)) {
            globalText += "\n";
            currentPos += 1;
        }
        globalText += val;
        if (withNodeMap) {
            nodeMap.push({ node, start: currentPos, end: currentPos + val.length });
        }
        currentPos += val.length;
    }

    return { globalText, nodeMap };
}

function stepBackCodePoints(str, u16Idx, count) {
    let i = Math.max(0, Math.min(str.length, u16Idx));
    let n = 0;
    while (i > 0 && n < count) {
        i--;
        const c = str.charCodeAt(i);
        if (c >= 0xDC00 && c <= 0xDFFF && i > 0) {
            const p = str.charCodeAt(i - 1);
            if (p >= 0xD800 && p <= 0xDBFF) i--;
        }
        n++;
    }
    return i;
}

function stepForwardCodePoints(str, u16Idx, count) {
    let i = Math.max(0, Math.min(str.length, u16Idx));
    let n = 0;
    while (i < str.length && n < count) {
        const c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
            const nx = str.charCodeAt(i + 1);
            if (nx >= 0xDC00 && nx <= 0xDFFF) i++;
        }
        i++;
        n++;
    }
    return i;
}

function countCodePoints(str, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) {
        const c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < to) {
            const nx = str.charCodeAt(i + 1);
            if (nx >= 0xDC00 && nx <= 0xDFFF) i++;
        }
        n++;
    }
    return n;
}

function buildSnippetsFromMatches(text, matches, maxBody = 40) {
    if (!text || !Array.isArray(matches) || matches.length === 0) {
        return { hits: 0, docs: 0, more: 0, items: [] };
    }
    const SNIP_BEFORE = 20;
    const SNIP_AFTER = 40;
    const SNIP_MAX_CHARS = 140;
    const groups = [];

    for (const m of matches) {
        const start = m.start;
        const end = m.end;
        const hlNoise = (m.noise || 0) & 0x3ff;
        const ws = stepBackCodePoints(text, start, SNIP_BEFORE);
        const we = stepForwardCodePoints(text, end, SNIP_AFTER);
        const last = groups[groups.length - 1];
        let merge = false;
        if (last && ws <= last.we) {
            const newWe = Math.max(last.we, we);
            if (countCodePoints(text, last.ws, newWe) <= SNIP_MAX_CHARS) {
                merge = true;
            }
        }
        if (merge) {
            if (we > last.we) last.we = we;
            last.hits.push({ start, end, noise: hlNoise });
        } else {
            groups.push({ ws, we, hits: [{ start, end, noise: hlNoise }] });
        }
    }

    const items = groups.map(g => {
        const prefix = g.ws > 0;
        const suffix = g.we < text.length;
        const t = (prefix ? '...' : '') + text.slice(g.ws, g.we) + (suffix ? '...' : '');
        const base = prefix ? 3 : 0;
        const h = [];
        let minNoise = 0xFFFFFFFF;
        for (const hit of g.hits) {
            const s16 = base + (hit.start - g.ws);
            const e16 = base + (hit.end - g.ws);
            h.push([s16, e16, hit.noise]);
            if (hit.noise < minNoise) minNoise = hit.noise;
        }
        return { t, h, n: minNoise };
    });

    items.sort((a, b) => a.n - b.n);
    const more = items.length > maxBody ? items.length - maxBody : 0;
    if (more > 0) items.length = maxBody;
    return { hits: matches.length, docs: 0, more, items };
}

async function buildLocalSnippets(kw, maxBody = 40) {
    if (!kw || kw.trim() === "" || !wasmEngineReady) {
        return { hits: 0, docs: 0, more: 0, items: [] };
    }
    const trimmed = kw.trim();
    await ensureContentTermSpecs(trimmed);
    const { globalText } = collectPageSearchText(false);
    const res = analyzePageMatches(globalText, trimmed);
    return buildSnippetsFromMatches(globalText, res.matches, maxBody);
}

async function countMatchesEnhanced(kw) {
    if (!kw || kw.trim() === "" || !wasmEngineReady) return { count: 0, adsBodyHits: null };
    await ensureContentTermSpecs(kw.trim());

    const { globalText } = collectPageSearchText(false);

    const res = analyzePageMatches(globalText, kw.trim());
    return {
        count: res.matches.length + (res.titleHits || 0),
        adsBodyHits: res.adsBodyHits
    };
}

function toc() {
    const headings = $$("h1, h2, h3, h4, h5, h6");
    if (headings.length > 2) {
        toc_flag = true;
        let tocHTML = "<div id='toc-list'><ul>";
        let stack = [];
        let counters = [0, 0, 0, 0, 0, 0];

        headings.forEach(function (heading) {
            let id = heading.innerText.replace(/\s+/g, "_").toLowerCase();
            let count = 1;
            while (document.getElementById(id)) {
                id = heading.innerText.replace(/\s+/g, "_").toLowerCase() + "_" + count++;
            }
            heading.id = id;

            const level = parseInt(heading.tagName[1]);
            for (let i = level; i < counters.length; i++) counters[i] = 0;
            counters[level - 1]++;

            let numberString = counters.slice(0, level).join(".");
            heading.setAttribute("data-number", numberString);

            while (level <= stack.length) {
                tocHTML += "</ul></li>";
                stack.pop();
            }

            tocHTML += "<li><a href='#" + heading.id + "' data='" + heading.id + "'><span class='toc_a_no'>" + numberString + "</span>&nbsp; " + heading.innerText + "</a><ul>";
            stack.push(level);
        });

        while (stack.length > 0) {
            tocHTML += "</ul></li>";
            stack.pop();
        }

        const tocDiv = document.createElement("div");
        tocDiv.id = "toc";
        tocDiv.style.display = "flex";
        tocDiv.innerHTML = tocHTML + "</ul></div><div id='toc-toggle' class='toc-toggle'>目 录</div>";
        document.body.appendChild(tocDiv);

        $("#toc-toggle").addEventListener("click", function () {
            const tocList = $("#toc-list");
            tocList.classList.toggle("hidden");
        });
    }
}
function getClosestH() {
    const hElements = $$("h1, h2, h3, h4, h5, h6");
    let minDistance = Number.MAX_VALUE;
    let closestH = null;
    hElements.forEach((hElement) => {
        const distanceToTop = hElement.getBoundingClientRect().top;
        if (distanceToTop >= 0 && distanceToTop < minDistance) {
            minDistance = distanceToTop;
            closestH = hElement;
        }
    });
    return closestH;
}

function lightbox() {
    var images = $$('img');
    if (images.length === 0) return;

    var currentIndex = 0;
    var scale = 1.0;
    var maxScale = 10.0;
    var minScale = 0.5;
    var scaleStep = 0.1;
    var dragMoved = false;

    function enableDrag(target) {
        target.dataset.tx = target.dataset.tx || 0;
        target.dataset.ty = target.dataset.ty || 0;
        let isDragging = false;
        let startX = 0, startY = 0;

        const onMove = (e) => {
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            const tx = clientX - startX;
            const ty = clientY - startY;

            if (Math.abs(tx) > 5 || Math.abs(ty) > 5) {
                dragMoved = true;
            }

            target.dataset.tx = tx;
            target.dataset.ty = ty;
            target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            if (e.cancelable) e.preventDefault();
        };

        const onUp = () => {
            isDragging = false;
            target.style.cursor = "grab";
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);

            setTimeout(() => dragMoved = false, 100);
        };

        const onDown = (e) => {
            if (e.touches && e.touches.length > 1) return;
            isDragging = true;
            dragMoved = false;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            startX = clientX - parseFloat(target.dataset.tx);
            startY = clientY - parseFloat(target.dataset.ty);
            target.style.cursor = "grabbing";

            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);

            if (!e.touches && e.cancelable) e.preventDefault();
        };

        target.addEventListener('mousedown', onDown);
        target.addEventListener('touchstart', onDown, { passive: false });
        target.style.cursor = "grab";
    }

    function closeLightbox(isFromPopState = false) {
        var lightbox = $('.lightbox');
        if (lightbox) lightbox.remove();
        scale = 1.0;
        emitEvent("lightbox", { status: "0" }, "index");
        document.body.style.overflow = "";

        if (isFromPopState !== true && history.state && history.state.lightboxOpen) {
            history.back();
        }
    }

    function prevImage() {
        scale = 1.0;
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        updateImage();
    }

    function nextImage() {
        scale = 1.0;
        currentIndex = (currentIndex + 1) % images.length;
        updateImage();
    }

    function updateImage() {
        var lightboxImg = $('.lightbox-img');
        lightboxImg.src = images[currentIndex].src;
        lightboxImg.dataset.tx = 0;
        lightboxImg.dataset.ty = 0;
        lightboxImg.style.transition = "none";
        lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;

        var info = $('.lightbox-info');
        if (info) info.innerHTML = (currentIndex + 1) + '/' + images.length;
    }

    function openLightbox(index, count) {
        if (!history.state || !history.state.lightboxOpen) {
            history.pushState({ lightboxOpen: true }, "");
        }

        currentIndex = index;
        var lightbox = document.createElement('div');
        lightbox.classList.add('lightbox');
        lightbox.style.display = 'flex';
        lightbox.style.alignItems = 'center';
        lightbox.style.justifyContent = 'center';

        lightbox.addEventListener('click', function (e) {
            if (e.target === lightbox && !dragMoved) {
                closeLightbox();
            }
        });
        document.body.appendChild(lightbox);

        var topCloseBtn = document.createElement('div');
        topCloseBtn.innerHTML = '✕';
        topCloseBtn.style.cssText = 'position: absolute; top: 15px; right: 20px; color: #fff; font-size: 28px; z-index: 105; cursor: pointer; padding: 10px; opacity: 0.7; user-select: none; font-family: sans-serif;';
        topCloseBtn.addEventListener('click', closeLightbox);
        lightbox.appendChild(topCloseBtn);

        var nav = document.createElement('span');
        nav.classList.add('lightbox-nav', 'noselect');
        lightbox.appendChild(nav);

        if (count !== 1) {
            var prevBtn = document.createElement('span');
            prevBtn.innerHTML = 'prev';
            prevBtn.addEventListener('click', prevImage);
            nav.appendChild(prevBtn);

            var info = document.createElement('span');
            info.classList.add('lightbox-info');
            info.innerHTML = (currentIndex + 1) + '/' + images.length;
            nav.appendChild(info);

            var nextBtn = document.createElement('span');
            nextBtn.innerHTML = 'next';
            nextBtn.addEventListener('click', nextImage);
            nav.appendChild(nextBtn);
        }

        var closeBtn = document.createElement('span');
        closeBtn.innerHTML = 'close';
        closeBtn.addEventListener('click', closeLightbox);
        nav.appendChild(closeBtn);

        var lightboxImg = document.createElement('img');
        lightboxImg.src = images[index].src;
        lightboxImg.alt = 'Image';
        lightboxImg.classList.add('lightbox-img');
        lightboxImg.addEventListener('dblclick', closeLightbox);

        lightboxImg.dataset.tx = 0;
        lightboxImg.dataset.ty = 0;
        lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;
        enableDrag(lightboxImg);

        lightboxImg.addEventListener('wheel', function (event) {
            event.preventDefault();
            if (event.deltaY < 0) scale = Math.min(scale + scaleStep, maxScale);
            else scale = Math.max(scale - scaleStep, minScale);
            lightboxImg.style.transform = `translate(${lightboxImg.dataset.tx}px, ${lightboxImg.dataset.ty}px) scale(${scale})`;
        });

        let initialDistance = 0;
        let initialScale = 1.0;

        lightboxImg.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                initialDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                initialScale = scale;
            }
        }, { passive: false });

        lightboxImg.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                if (e.cancelable) e.preventDefault();

                const currentDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );

                scale = initialScale * (currentDistance / initialDistance);
                scale = Math.max(minScale, Math.min(scale, maxScale));

                lightboxImg.style.transform = `translate(${lightboxImg.dataset.tx}px, ${lightboxImg.dataset.ty}px) scale(${scale})`;
            }
        }, { passive: false });

        lightbox.appendChild(lightboxImg);

        bindSwipeGestures(lightbox, {
            onLeft: nextImage,
            onRight: prevImage
        });
    }

    function bindSwipeGestures(element, callbacks, thresholdPercent = 0.15) {
        let startX = 0, startY = 0;
        let isMultiTouch = false;

        element.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                isMultiTouch = true;
                return;
            }
            isMultiTouch = false;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
            if (e.touches.length > 1) {
                isMultiTouch = true;
            }
        }, { passive: false });

        element.addEventListener('touchend', (e) => {
            if (isMultiTouch) return;
            if (scale > 1.05) return;

            if (e.changedTouches.length !== 1) return;
            const deltaX = e.changedTouches[0].clientX - startX;
            const deltaY = e.changedTouches[0].clientY - startY;
            const dynamicThreshold = Math.min(window.innerWidth, window.innerHeight) * thresholdPercent;

            if (Math.abs(deltaX) > dynamicThreshold || Math.abs(deltaY) > dynamicThreshold) {
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0 && callbacks.onRight) callbacks.onRight();
                    else if (deltaX < 0 && callbacks.onLeft) callbacks.onLeft();
                }
            } else {
                var lightboxImg = $('.lightbox-img');
                if (lightboxImg && scale === 1.0) {
                    lightboxImg.dataset.tx = 0;
                    lightboxImg.dataset.ty = 0;
                    lightboxImg.style.transition = "transform 0.25s ease-out";
                    lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;
                    setTimeout(() => lightboxImg.style.transition = "none", 260);
                }
            }
        });
    }

    images.forEach(function (img, index) {
        img.addEventListener('click', function () {
            openLightbox(index, images.length);
            emitEvent("lightbox", { status: "1" }, "index");
            document.body.style.overflow = "hidden";
        });
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') prevImage();
        else if (event.key === 'ArrowRight') nextImage();
        else if (event.key === 'Escape') closeLightbox();
    });

    window.addEventListener('popstate', function (e) {
        if ($('.lightbox')) {
            closeLightbox(true);
        }
    });
}

function bindCodeEditHandlers(root) {
    root.querySelectorAll('code').forEach((e) => {
        e.ondblclick = (event) => {
            event.stopPropagation();
            e.contentEditable = "true";
            e.style.outline = "none";
            e.classList.add("is-editing");
            e.focus();
        };

        e.oninput = () => {
            updateLineNumbers(e);
        };

        e.onblur = () => {
            e.contentEditable = "false";
            e.classList.remove("is-editing");
        };
    });
}

const NON_LANG_ATTRS = new Set([
    'class', 'style', 'id', 'title', 'hidden', 'contenteditable', 'spellcheck',
    'draggable', 'tabindex', 'dir', 'lang', 'translate', 'autofocus'
]);

function getCodeLang(codeEl) {
    for (const attr of codeEl.attributes) {
        const name = attr.name;
        if (attr.value !== '') continue;
        if (NON_LANG_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-') || /^on[a-z]+$/.test(name)) continue;
        return name;
    }
    return 'java';
}

function copyTextToClipboard(text) {
    function legacyCopy() {
        const active = document.activeElement;
        const sel = window.getSelection();
        const savedRanges = [];
        for (let i = 0; i < sel.rangeCount; i++) savedRanges.push(sel.getRangeAt(i));

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

        sel.removeAllRanges();
        savedRanges.forEach(r => sel.addRange(r));
        if (active && active.focus) active.focus({ preventScroll: true });
        return ok;
    }

    if (legacyCopy()) return Promise.resolve(true);
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    return Promise.resolve(false);
}

const codeToolsObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => entries.forEach(({ target }) => target._alignCodeTools && target._alignCodeTools()))
    : null;

function initCodeTools(root = document) {
    root.querySelectorAll('code').forEach((codeEl) => {
        const prev = codeEl.previousSibling;
        if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList.contains('code-tools')) return;

        const tools = document.createElement('div');
        tools.className = 'code-tools';

        const langEl = document.createElement('span');
        langEl.className = 'code-lang';
        langEl.dataset.lang = getCodeLang(codeEl).toUpperCase();

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy';
        btn.title = '复制代码';
        btn.setAttribute('aria-label', '复制代码');

        let resetTimer = null;
        btn.onclick = async (e) => {
            e.stopPropagation();
            const ok = await copyTextToClipboard(codeEl.innerText.replace(/\n+$/, ''));
            btn.dataset.state = ok ? 'ok' : 'fail';
            btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed');
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
                delete btn.dataset.state;
                btn.setAttribute('aria-label', '复制代码');
            }, 1500);
        };

        tools.append(btn, langEl);
        codeEl.before(tools);

        const align = () => {
            const c = codeEl.getBoundingClientRect();
            if (!c.width) return;
            tools.style.marginLeft = '0px';
            const t = tools.getBoundingClientRect();
            tools.style.marginLeft = Math.max(0, c.right - t.right) + 'px';
        };
        codeEl._alignCodeTools = tools._alignCodeTools = align;
        align();
        if (codeToolsObserver) {
            codeToolsObserver.observe(codeEl);
            codeToolsObserver.observe(tools);
        }
    });
}

async function code() {
    const codeElements = $$('code');
    if (codeElements.length === 0) return;

    enableCodeHoverHighlight();

    return new Promise((resolve) => {
        const highlightAll = () => {
            $$("code").forEach((e) => {
                const lang = e.attributes.length > 0 ? e.attributes[0].name : "java";

                const rawContent = e.textContent.trim();
                e.innerHTML = highlightCode(rawContent, lang);
                updateLineNumbers(e);
            });
            bindCodeEditHandlers(document);
            initCodeTools(document);
            resolve();
        };

        if (!window.Prism) {
            const script = document.createElement('script');
            script.src = '../src/third/prism/prism.js';
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '../src/third/prism/prism.css';
            document.head.appendChild(link);
            document.head.appendChild(script);
            script.onload = highlightAll;
        } else {
            highlightAll();
        }
    });
}
function enableCodeHoverHighlight(targetDocument = document) {
    targetDocument.addEventListener('mousemove', (e) => {
        const code = e.target.closest('code');
        const pre = code ? code.closest('pre') : null;

        if (code && pre) {
            if (getComputedStyle(pre).position === 'static') {
                pre.style.position = 'relative';
            }
            if (getComputedStyle(code).position === 'static') {
                code.style.position = 'relative';
                code.style.zIndex = '1';
            }

            let highlighter = pre.querySelector('.code-line-highlighter');
            if (!highlighter) {
                highlighter = targetDocument.createElement('div');
                highlighter.className = 'code-line-highlighter';
                highlighter.style.cssText = `
                    position: absolute;
                    background-color: rgba(150, 150, 150, 0.15);
                    pointer-events: none;
                    z-index: 0;
                    display: none;
                    transition: top 0.05s ease-out;
                    border-radius: 2px;
                `;
                pre.appendChild(highlighter);
            }

            const codeStyle = getComputedStyle(code);
            let lh = parseFloat(codeStyle.lineHeight);
            if (isNaN(lh)) lh = parseFloat(codeStyle.fontSize) * 1.2;

            const codePaddingTop = parseFloat(codeStyle.paddingTop) || 0;
            const codeRect = code.getBoundingClientRect();

            if (e.clientY < codeRect.top || e.clientY > codeRect.bottom ||
                e.clientX < codeRect.left || e.clientX > codeRect.right) {
                highlighter.style.display = 'none';
                return;
            }

            const offsetY = e.clientY - codeRect.top - codePaddingTop;
            if (offsetY < 0) {
                highlighter.style.display = 'none';
                return;
            }

            const lineIndex = Math.floor(offsetY / lh);
            const maxLines = Math.round((codeRect.height - codePaddingTop - (parseFloat(codeStyle.paddingBottom) || 0)) / lh);

            if (lineIndex >= 0 && lineIndex < maxLines) {
                highlighter.style.display = 'block';
                highlighter.style.top = (code.offsetTop + codePaddingTop + lineIndex * lh) + 'px';
                highlighter.style.height = lh + 'px';
                highlighter.style.left = code.offsetLeft + 'px';
                highlighter.style.width = code.offsetWidth + 'px';
            } else {
                highlighter.style.display = 'none';
            }

        } else {
            targetDocument.querySelectorAll('.code-line-highlighter').forEach(el => {
                el.style.display = 'none';
            });
        }
    });

    targetDocument.addEventListener('mouseleave', () => {
        targetDocument.querySelectorAll('.code-line-highlighter').forEach(el => {
            el.style.display = 'none';
        });
    });
}

function postion_func() {
    const positions = store.positions || {};
    var pageTitle = document.title;
    var scrollPosition = positions[pageTitle];
    if (scrollPosition !== undefined && store.jump_from_search == "0") {
        window.scrollTo(0, parseInt(scrollPosition));
    }

    let memPositions = Object.assign({}, positions);
    let dirty = false;
    let scrollTimer = null;

    function flushPositions() {
        if (window._isBombing || (window.top && window.top._isBombing)) return;
        if (!dirty) return;
        store.positions = memPositions;
        dirty = false;
    }

    window.addEventListener('scroll', function (e) {
        if (isAutoScrolling) return;

        if (scrollTimer !== null) {
            clearTimeout(scrollTimer);
        }

        scrollTimer = setTimeout(function () {
            var pageTitle = document.title;
            var scrollPosition = window.pageYOffset;
            memPositions[pageTitle] = scrollPosition;
            dirty = true;

            if ($("#gotop")) {
                document.body.scrollTop > 500 || document.documentElement.scrollTop > 500
                    ? $("#gotop").style.display = "block"
                    : $("#gotop").style.display = "none";
            }

            if (getClosestH() != null && toc_flag) {
                var aTags = $("#toc-list").querySelectorAll("a");
                for (let i = 0; i < aTags.length; i++) {
                    if (aTags[i].getAttribute("data") == getClosestH().id)
                        aTags[i].classList.add("toc_locate");
                    else
                        aTags[i].classList.remove("toc_locate");
                }
            }
        }, 300);

    }, false);

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushPositions();
    });
    window.addEventListener('pagehide', flushPositions);
    window.addEventListener('beforeunload', flushPositions);
}

function go_top() {
    var o = document.createElement('div');
    o.setAttribute("id", "gotop");
    o.innerHTML = "<span>^</span>";
    document.body.appendChild(o);
    o.addEventListener("click", function () {
        window.scrollTo({ top: 0 });
    });
}

function getSelectedTextCompat() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|search|url|tel|password)$/i.test(active.type)))) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
            return active.value.slice(start, end).trim();
        }
    }
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : '';
}

function getSelectionEndRect(sel, fallbackEvent) {
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
                    if (sel.anchorNode === sel.focusNode) {
                        isBackward = sel.focusOffset < sel.anchorOffset;
                    } else {
                        isBackward = !!(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
                    }
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
}

function positionExcerptBelowCaret(btn, sel, fallbackEvent) {
    const endRect = getSelectionEndRect(sel, fallbackEvent);
    if (!endRect) return false;
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
    return true;
}

function pinyin_func() {
    if (window.__PINYIN_INIT__) return;
    window.__PINYIN_INIT__ = true;

    document.querySelectorAll('#pinyin-tooltip, .pinyin-tooltip').forEach(el => el.remove());

    const tooltip = document.createElement("div");
    tooltip.id = "pinyin-tooltip";
    tooltip.className = "pinyin-tooltip";
    tooltip.style.cssText = 'position: fixed; z-index: 2147483647; display: none; pointer-events: none; background: #222; color: #fff; padding: 3px 8px; border-radius: 4px; font-size: 13px; line-height: 1.4; white-space: nowrap; box-shadow: 0 3px 10px rgba(0,0,0,0.3);';
    document.body.appendChild(tooltip);

    let shownAt = 0;
    const hide = () => { tooltip.style.display = "none"; };

    window.addEventListener("mousedown", hide, true);
    document.addEventListener("scroll", () => {
        if (performance.now() - shownAt > 150) hide();
    }, true);

    window.addEventListener("mouseup", function (event) {
        if (event.target && event.target.closest && event.target.closest('#excerpt-pop-btn')) return;
        setTimeout(() => {
            const dict = window.top && window.top.pinyinData;
            if (!dict) { hide(); return; }
            const text = getSelectedTextCompat();
            const chars = Array.from(text);
            if (chars.length === 1 && dict[chars[0]]) {
                tooltip.innerText = dict[chars[0]];
                tooltip.style.visibility = 'hidden';
                tooltip.style.display = 'block';
                const tw = tooltip.offsetWidth || 48;
                const th = tooltip.offsetHeight || 24;
                const sel = window.getSelection();
                const rect = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).getBoundingClientRect() : null;
                const anchorX = (rect && (rect.width > 0 || rect.height > 0)) ? (rect.left + rect.width / 2) : event.clientX;
                const anchorTop = (rect && rect.height > 0) ? rect.top : event.clientY;
                const anchorBottom = (rect && rect.height > 0) ? rect.bottom : event.clientY;
                const left = Math.max(8, Math.min(window.innerWidth - tw - 8, anchorX - tw / 2));
                const top = anchorTop - th - 6 >= 8 ? (anchorTop - th - 6) : Math.min(window.innerHeight - th - 8, anchorBottom + 6);
                tooltip.style.left = Math.round(left) + "px";
                tooltip.style.top = Math.round(top) + "px";
                tooltip.style.visibility = 'visible';
                shownAt = performance.now();
            } else {
                hide();
            }
        }, 10);
    }, true);
}

function comments() {
    if (document.title.trim() !== "" && store.online_flag == "1") {
        const stampText = document.getElementById("stamp")?.innerText || "";
        emitEvent("load_comments", {
            title: document.title.trim(),
            stamp: stampText
        }, "index");
    }
}

function initExcerptTrigger() {
    if (window.__EXCERPT_INIT__) return;
    window.__EXCERPT_INIT__ = true;

    document.querySelectorAll('#excerpt-pop-btn').forEach(el => el.remove());

    const btn = document.createElement('div');
    btn.id = 'excerpt-pop-btn';
    btn.textContent = '✏️';
    btn.style.cssText = 'position: fixed; background: #516194; color: rgb(255, 255, 255); padding: 0 5px; border-radius: 6px; cursor: pointer; z-index: 2147483647; box-shadow: rgba(0, 0, 0, 0.4) 0px 4px 12px; display: none; user-select: none;';
    document.body.appendChild(btn);

    let lastProcessedText = "";
    let shownAt = 0;

    const doExcerpt = () => {
        const text = getSelectedTextCompat();
        if (Array.from(text).length > 1) {
            emitEvent('SAVE_EXCERPT', text, 'index');

            const oldText = btn.textContent;
            btn.textContent = '✅ 已摘抄';
            btn.style.background = '#10b981';
            setTimeout(() => {
                btn.style.display = 'none';
                btn.textContent = oldText;
                btn.style.background = '#516194';
                const sel = window.getSelection();
                if (sel) sel.removeAllRanges();
                lastProcessedText = "";
            }, 800);
        }
    };

    const shieldEvents = ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerdown', 'pointerup'];

    shieldEvents.forEach(evt => {
        window.addEventListener(evt, (e) => {
            if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) {
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (evt === 'mousedown') {
                    e.preventDefault();
                }

                if (evt === 'click') {
                    doExcerpt();
                }
            }
        }, true);
    });

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    window.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;
        if (e.button !== 0 || (isMac && e.ctrlKey)) return;
        btn.style.display = 'none';
        const isEditableTarget = e.target && (
            e.target.isContentEditable ||
            e.target.tagName === 'TEXTAREA' ||
            e.target.tagName === 'INPUT' ||
            (e.target.closest && e.target.closest('[contenteditable]'))
        );
        if (!isEditableTarget) {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) {
                sel.removeAllRanges();
            }
        }
        lastProcessedText = "";
    }, true);

    document.addEventListener('scroll', () => {
        if (performance.now() - shownAt > 150) {
            btn.style.display = 'none';
        }
    }, true);

    window.addEventListener('mouseup', (e) => {
        if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;

        setTimeout(() => {
            const text = getSelectedTextCompat();

            if (Array.from(text).length > 1) {
                if (text !== lastProcessedText) {
                    if (positionExcerptBelowCaret(btn, window.getSelection(), e)) {
                        lastProcessedText = text;
                        shownAt = performance.now();
                    }
                }
            } else {
                btn.style.display = 'none';
                lastProcessedText = "";
            }
        }, 10);
    }, true);
}

async function start() {
    pinyin_func();
    initExcerptTrigger();

    if (wasmInitPromise) {
        await wasmInitPromise;
    }

    await format();
    await code();

    setTimeout(() => {
        postion_func();
        setTimeout(() => {
            search();
        }, 100);
    }, 50);

    comments();
    go_top();
    setTimeout(toc, 500);
    setTimeout(lightbox, 500);

    requestAnimationFrame(() => {
        document.body.style.opacity = 1;
    });
}

function renderP2TableEl(rawText) {
    const lines = rawText.trim().split('\n');
    const table = document.createElement('table');
    table.className = 'p2tbl';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    lines.forEach(line => {
        const tr = document.createElement('tr');
        line.split("|").map(c => c.trim()).forEach(cell => {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    return table;
}

function highlightCode(rawText, lang) {
    const effectiveLang = lang || "java";
    if (!window.Prism) {
        return rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }
    return Prism.highlight(rawText, Prism.languages[effectiveLang] || Prism.languages.java, effectiveLang);
}

function updateLineNumbers(el) {
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
    const lineCount = el.innerText.split('\n').length;
    const lines = Array.from({ length: lineCount }, (_, i) => (i + 1).toString().padStart(2, '0'));
    el.style.setProperty('--line-numbers', '"' + lines.join('.\\A ') + '.\\A"');
}

async function initDiffUI() {
    const originalBtn = document.getElementById('diff-btn');
    if (!originalBtn) return;

    function formatSnapshotTime(ts) {
        if (!ts) return '未知时间';
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function normalizeSnapshotHistory(rec) {
        if (!rec) return [];
        let list = [];
        if (Array.isArray(rec.history)) {
            list = rec.history.filter(item =>
                item && (typeof item.text === 'string' || item.text instanceof Uint8Array)
            );
        } else if (typeof rec.text === 'string' || rec.text instanceof Uint8Array) {
            list = [{ text: rec.text, ts: rec.ts || 0, compressed: rec.compressed }];
        }
        return list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    let historyList = [];
    try {
        const rawPath = location.pathname;
        const decodedPath = decodeURI(rawPath);
        const fileName = decodedPath.split('/').pop();

        const tryKeys = [
            decodedPath, rawPath,
            decodedPath.startsWith('/') ? decodedPath.substring(1) : '/' + decodedPath,
            '/html/' + fileName, 'html/' + fileName
        ];

        const idb = await window.top.SiteCore.openMainDB();

        if (idb.objectStoreNames.contains('html_snapshots')) {
            const tx = idb.transaction('html_snapshots', 'readonly');
            const store = tx.objectStore('html_snapshots');

            let record = null;
            for (const k of tryKeys) {
                const res = await new Promise(resolve => {
                    const r = store.get(k);
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => resolve(null);
                });
                if (res) { record = res; break; }
            }
            historyList = normalizeSnapshotHistory(record);
        }
        idb.close();
    } catch (e) {
        console.warn("[Diff] 历史记录读取失败", e);
    }

    if (historyList.length === 0) {
        originalBtn.remove();
        return;
    }

    const totalVersions = historyList.length + 1;
    const options = [];
    options.push({ val: 'current', label: `v${totalVersions}`, title: '最新版' });
    for (let i = 0; i < historyList.length; i++) {
        const vNum = totalVersions - 1 - i;
        options.push({ val: String(i), label: `v${vNum}`, title: formatSnapshotTime(historyList[i].ts) });
    }

    const wrapper = document.createElement('span');
    wrapper.id = 'diff-controls-wrapper';
    wrapper.style.cssText = 'line-height: 1rem;padding: 0 3px;background: #cfe4ff;top: 3px;position: fixed;left: 80px;display: flex;align-items: center;gap: 6px;z-index: 100;';

    function createSimSelect(options, defaultVal) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; display:inline-block; cursor:pointer; background:#fff; border:1px solid #ccc; padding:2px 6px; min-width:60px; font-size:12px;';
        const display = document.createElement('span');
        const list = document.createElement('div');
        list.style.cssText = 'position:absolute; top:100%; left:-1px; right:-1px; background:#fff; border:1px solid #ccc; z-index:1000; display:none; max-height:150px; overflow-y:auto;';
        
        let currentVal = defaultVal;
        const updateDisplay = (val) => { const o = options.find(opt => opt.val === val); if(o) { display.textContent = o.label; display.title = o.title; } };
        updateDisplay(currentVal);
        
        options.forEach(opt => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:4px 6px; color:#333;';
            item.textContent = opt.label;
            item.onmouseenter = () => item.style.background = '#eee';
            item.onmouseleave = () => item.style.background = '#fff';
            item.onclick = (e) => {
                e.stopPropagation();
                currentVal = opt.val;
                updateDisplay(currentVal);
                list.style.display = 'none';
                wrap.value = currentVal;
            };
            list.appendChild(item);
        });
        
        wrap.onclick = () => list.style.display = list.style.display === 'none' ? 'block' : 'none';
        document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) list.style.display = 'none'; });
        wrap.append(display, list);
        wrap.value = currentVal;
        return wrap;
    }

    const fromSelect = createSimSelect(options, options[1] ? options[1].val : options[0].val);
    const toSelect = createSimSelect(options, options[0].val);



    const label1 = document.createElement('span');
    label1.textContent = 'based on';
    label1.style.cssText = "font-family: serif!important;"
    const label2 = document.createElement('span');
    label2.textContent = '⇌';
    label2.style.cssText = "font-family: serif!important;"

    const btnStart = document.createElement('button');
    btnStart.textContent = 'diff';
    btnStart.style.cssText = 'margin-left:4px;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'cancel diff';
    btnCancel.style.cssText = 'color: red;margin-left:4px;display:none;';

    originalBtn.parentNode.insertBefore(wrapper, originalBtn);
    originalBtn.remove();

    wrapper.appendChild(toSelect);
    wrapper.appendChild(label1);
    wrapper.appendChild(fromSelect);
    wrapper.appendChild(label2);
    wrapper.appendChild(btnStart);
    wrapper.appendChild(btnCancel);

    btnStart.onclick = () => {
        if (window._diffBusy) return;

        const fromVal = fromSelect.value;
        const toVal = toSelect.value;
        if (fromVal === toVal) {
            alert('⚠️ 对比起点和终点不能是同一个版本');
            return;
        }

        // 若搜索正处于当前页结果导航状态，立即清理高亮并通知主页面触发一次搜索 clear，避免与 diff 干扰
        const sNav = document.getElementById('s_nav');
        const isSearchNavActive =
            (sNav && sNav.innerHTML.trim() !== '') ||
            (window._searchMatchRanges && window._searchMatchRanges.size > 0) ||
            (window._activeSearchBorders && window._activeSearchBorders.length > 0);
        if (isSearchNavActive) {
            _searchSeq++;
            if (CSS.highlights) CSS.highlights.clear();
            resetSearchHighlights();
            if (window._searchMatchRanges) window._searchMatchRanges.clear();
            clearActiveSearchBorders();
            hideSearchMinimap();
            if (sNav) sNav.innerHTML = "";
            store.jump_from_search = "0";
            store.jump_from_search_ex = "0";
            emitEvent("CLEAR_SEARCH", null, "index");
        }

        window._diffBusy = true;
        btnStart.textContent = ' ⏳ 计算中... ';

        requestAnimationFrame(async () => {
            try {
                const oldTokens = await getTokensForSource(fromVal, historyList);
                const newTokens = await getTokensForSource(toVal, historyList);

                const originalPre = document.querySelector('pre:not(#diff-pre)');
                const compStyle = window.getComputedStyle(originalPre);
                const originMarginTop = compStyle.marginTop;
                const originMarginBottom = compStyle.marginBottom;

                originalPre.style.display = 'none';

                let diffPre = document.getElementById('diff-pre');
                if (!diffPre) {
                    diffPre = document.createElement('pre');
                    diffPre.id = 'diff-pre';
                    diffPre.className = originalPre.className;
                    originalPre.parentNode.insertBefore(diffPre, originalPre.nextSibling);
                }
                diffPre.style.marginTop = originMarginTop;
                diffPre.style.marginBottom = originMarginBottom;

                renderDiffView(oldTokens, newTokens, diffPre);
                updateDiffMinimap(diffPre);

                window._isDiffMode = true;
                btnStart.textContent = 're-diff';
                btnCancel.style.display = 'inline';
            } finally {
                window._diffBusy = false;
            }
        });
    };

    btnCancel.onclick = () => {
        if (window._diffBusy) return;

        const originalPre = document.querySelector('pre:not(#diff-pre)');
        const diffPre = document.getElementById('diff-pre');

        if (diffPre) diffPre.remove();
        if (originalPre) originalPre.style.display = 'block';
        hideDiffMinimap();

        window._isDiffMode = false;
        btnStart.textContent = 'diff';
        btnCancel.style.display = 'none';
    };
}

function renderDiffView(oldTokens, newTokens, preTag) {
    const oldKeys = oldTokens.map(t => t.content);
    const newKeys = newTokens.map(t => t.content);

    const diffOps = compute_lcs_diff(oldKeys, newKeys);
    let mergedHtml = "";

    const isBlank = (t) => {
        return t.content
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;|\u00A0/g, '')
            .trim() === '';
    };

    let codeLineIdx = 0;
    const emit = (html, tType) => {
        if (tType === 'code_line') {
            mergedHtml += (codeLineIdx++ > 0 ? '\n' : '') + html;
        } else {
            mergedHtml += `${html}\n`;
        }
    };

    diffOps.forEach(op => {
        const isInsert = op.type === 'insert';
        const isDelete = op.type === 'delete';
        const isEqual = op.type === 'equal';

        const token = isEqual || isInsert ? newTokens[op.newIdx] : oldTokens[op.oldIdx];
        const tType = token.type;
        const content = token.content;

        if (tType === 'code_start') {
            mergedHtml += content;
            codeLineIdx = 0;
            return;
        }
        if (tType === 'code_end') {
            mergedHtml += `${content}\n`;
            return;
        }

        if (isEqual) {
            emit(content, tType);
            return;
        }

        if (tType === 'table_start' || tType === 'table_end') {
            mergedHtml += `${content}\n`;
            return;
        }

        if (isBlank(token)) {
            emit(content, tType);
            return;
        }

        const bg = isInsert ? "rgba(52, 211, 153, 0.25)" : "rgba(248, 113, 113, 0.25)";
        const border = isInsert ? "#10b981" : "#ef4444";
        const opacity = isDelete ? "0.75" : "1";

        if (tType === 'table_row') {
            const styledTr = content.replace(/^<tr(\s|>)/i, (match, p1) => {
                return `<tr style="background-color: ${bg}; opacity: ${opacity}; border-left: 5px solid ${border};"${p1}`;
            });
            mergedHtml += `${styledTr}\n`;

        } else if (tType === 'code_line') {
            emit(`<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>`, tType);

        } else {
            mergedHtml += `<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>\n`;
        }
    });

    preTag.innerHTML = mergedHtml;
    preTag.querySelectorAll('code').forEach(updateLineNumbers);
}

function ensureDiffMinimapEl() {
    if ($("#toc")) $("#toc").style.display = "none";
    if ($("#gotop")) $("#gotop").style.right = "20px";

    if (_diffMinimapEl && document.body.contains(_diffMinimapEl)) return _diffMinimapEl;

    const el = document.createElement('div');
    el.id = 'diff-minimap';
    el.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 20px;
        height: 100vh;
        z-index: 1000;
        pointer-events: none;
        background: rgba(127, 127, 127, 0.08);
        display: none;
    `;
    document.body.appendChild(el);
    _diffMinimapEl = el;
    return el;
}

function collectDiffHunks(diffPre) {
    const marked = diffPre.querySelectorAll('[style*="border-left"]');
    if (marked.length === 0) return [];
    const items = Array.from(marked).map(el => {
        const isInsert = el.style.borderLeftColor === 'rgb(16, 185, 129)' || el.style.borderLeftColor === '#10b981';
        const type = isInsert ? 'insert' : 'delete';

        const rect = el.getBoundingClientRect();
        return {
            top: rect.top + window.scrollY,
            bottom: rect.bottom + window.scrollY,
            type
        };
    });

    const MERGE_GAP = 6;
    const hunks = [];
    let current = null;

    items.forEach(item => {
        if (current && item.top - current.bottom <= MERGE_GAP) {
            current.bottom = Math.max(current.bottom, item.bottom);
            current.types.add(item.type);
        } else {
            current = { top: item.top, bottom: item.bottom, types: new Set([item.type]) };
            hunks.push(current);
        }
    });

    return hunks;
}

function renderDiffMinimapMarks(diffPre) {
    const container = ensureDiffMinimapEl();
    container.innerHTML = '';

    const hunks = collectDiffHunks(diffPre);
    if (hunks.length === 0) {
        container.style.display = 'none';
        return;
    }

    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);

    hunks.forEach(hunk => {
        const topRatio = hunk.top / totalHeight;
        const heightRatio = (hunk.bottom - hunk.top) / totalHeight;

        const isMixed = hunk.types.has('insert') && hunk.types.has('delete');
        const isInsertOnly = hunk.types.has('insert') && !hunk.types.has('delete');
        let background;
        if (isMixed) {
            background = 'linear-gradient(180deg, #ef4444 50%, #10b981 50%)';
        } else if (isInsertOnly) {
            background = '#10b981';
        } else {
            background = '#ef4444';
        }

        const mark = document.createElement('div');
        mark.title = isMixed ? '修改' : (isInsertOnly ? '新增' : '删除');
        mark.style.cssText = `
            position: absolute;
            left: 1px;
            right: 1px;
            top: ${topRatio * 100}%;
            height: max(3px, ${heightRatio * 100}%);
            background: ${background};
            border-radius: 2px;
            pointer-events: auto;
            cursor: pointer;
            box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
        `;
        mark.onclick = () => {
            const targetY = Math.max(0, hunk.top - window.innerHeight / 2);
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        };
        container.appendChild(mark);
    });

    container.style.display = 'block';
}

let _diffMinimapResizeHandler = null;
function updateDiffMinimap(diffPre) {
    _diffMinimapActivePre = diffPre;
    renderDiffMinimapMarks(diffPre);

    if (!_diffMinimapResizeBound) {
        _diffMinimapResizeHandler = () => {
            if (!_diffMinimapActivePre || !document.body.contains(_diffMinimapActivePre)) return;
            clearTimeout(_diffMinimapResizeTimer);
            _diffMinimapResizeTimer = setTimeout(() => {
                renderDiffMinimapMarks(_diffMinimapActivePre);
            }, 150);
        };
        window.addEventListener('resize', _diffMinimapResizeHandler);
        _diffMinimapResizeBound = true;
    }
}

function hideDiffMinimap() {
    if ($("#toc")) $("#toc").style.display = "flex";
    if ($("#gotop")) $("#gotop").style.right = "0";

    _diffMinimapActivePre = null;
    if (_diffMinimapEl) {
        _diffMinimapEl.innerHTML = '';
        _diffMinimapEl.style.display = 'none';
    }

    if (_diffMinimapResizeBound) {
        window.removeEventListener('resize', _diffMinimapResizeHandler);
        _diffMinimapResizeBound = false;
    }
}

function ensureSearchMinimapEl() {
    if (_searchMinimapEl && document.body.contains(_searchMinimapEl)) return _searchMinimapEl;

    const el = document.createElement('div');
    el.id = 'search-minimap';
    el.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 20px;
        height: 100vh;
        z-index: 999;
        pointer-events: none;
        background: rgba(127, 127, 127, 0.08);
        display: none;
    `;
    document.body.appendChild(el);
    _searchMinimapEl = el;
    return el;
}

function renderSearchMinimapMarks() {
    const container = ensureSearchMinimapEl();
    container.innerHTML = '';

    if (!window._searchMatchRanges || window._searchMatchRanges.size === 0) {
        container.style.display = 'none';
        return;
    }

    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
    let markCount = 0;

    window._searchMatchRanges.forEach((ranges, matchIndex) => {
        let minTop = Infinity, maxBottom = -Infinity;

        ranges.forEach(range => {
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            const top = window.scrollY + rect.top;
            const bottom = window.scrollY + rect.bottom;
            minTop = Math.min(minTop, top);
            maxBottom = Math.max(maxBottom, bottom);
        });

        if (minTop === Infinity) return;

        const topRatio = minTop / totalHeight;
        const heightRatio = (maxBottom - minTop) / totalHeight;

        const mark = document.createElement('div');
        mark.title = `匹配 ${matchIndex + 1}`;
        mark.style.cssText = `
            position: absolute;
            left: 1px;
            right: 1px;
            top: ${topRatio * 100}%;
            height: max(3px, ${heightRatio * 100}%);
            background: rgba(255, 200, 0, 0.9);
            border-radius: 2px;
            pointer-events: auto;
            cursor: pointer;
            box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
        `;
        mark.onclick = () => {
            if (typeof window._jumpToSearchIndex === 'function') {
                window._jumpToSearchIndex(matchIndex);
            }
        };
        container.appendChild(mark);
        markCount++;
    });

    container.style.display = markCount > 0 ? 'block' : 'none';
}

function updateSearchMinimap() {
    renderSearchMinimapMarks();

    if (!_searchMinimapResizeBound) {
        _searchMinimapResizeHandler = () => {
            if (!window._searchMatchRanges || window._searchMatchRanges.size === 0) return;
            clearTimeout(_searchMinimapResizeTimer);
            _searchMinimapResizeTimer = setTimeout(() => {
                renderSearchMinimapMarks();
            }, 150);
        };
        window.addEventListener('resize', _searchMinimapResizeHandler);
        _searchMinimapResizeBound = true;
    }
}

function hideSearchMinimap() {
    if (_searchMinimapEl) {
        _searchMinimapEl.innerHTML = '';
        _searchMinimapEl.style.display = 'none';
    }
    if (_searchMinimapResizeBound) {
        window.removeEventListener('resize', _searchMinimapResizeHandler);
        _searchMinimapResizeBound = false;
    }
    window._jumpToSearchIndex = null;
}

function buildRenderedTokens(rawHtml) {
    const container = document.createElement('pre');
    container.innerHTML = rawHtml;

    function renderCodeBlockEl(rawText, lang) {
        const codeEl = document.createElement('code');
        if (lang) codeEl.setAttribute(lang, '');
        codeEl.innerHTML = highlightCode(rawText, lang);
        return codeEl;
    }

    const textNodes = Array.from(container.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
    const outHtmlArr = textNodes.map(node => format_markdown(node.nodeValue));
    textNodes.forEach((node, i) => {
        const fragment = document.createRange().createContextualFragment(outHtmlArr[i]);
        node.replaceWith(fragment);
    });

    container.querySelectorAll('p').forEach(p => {
        p.replaceWith(renderP2TableEl(p.textContent));
    });

    container.querySelectorAll('code').forEach(c => {
        const lang = c.attributes.length > 0 ? c.attributes[0].name : "java";
        const newCode = renderCodeBlockEl(c.textContent.trim(), lang);
        c.replaceWith(newCode);
    });

    const tokens = [];
    let currentLineHtml = "";

    function flushText() {
        if (!currentLineHtml) return;
        const lines = currentLineHtml.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (i === lines.length - 1 && lines[i] === "") continue;
            tokens.push({ type: 'html_line', content: lines[i] });
        }
        currentLineHtml = "";
    }

    container.childNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TABLE' && node.classList.contains('p2tbl')) {
            flushText();
            tokens.push({ type: 'table_start', content: '<table class="p2tbl"><tbody>' });
            node.querySelectorAll('tr').forEach(tr => {
                tokens.push({ type: 'table_row', content: tr.outerHTML });
            });
            tokens.push({ type: 'table_end', content: '</tbody></table>' });

        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'CODE') {
            flushText();
            const attrs = Array.from(node.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
            tokens.push({ type: 'code_start', content: `<code ${attrs}>` });

            const codeLines = node.innerHTML.split('\n');
            codeLines.forEach((line, idx) => {
                if (idx === codeLines.length - 1 && line === "") return;
                tokens.push({ type: 'code_line', content: line });
            });
            tokens.push({ type: 'code_end', content: '</code>' });

        } else {
            currentLineHtml += node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : (node.nodeValue || '');
        }
    });
    flushText();

    const isGhostEmpty = (t) => {
        if (t.type !== 'html_line') return false;
        const pureText = t.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
        return pureText === '';
    };

    while (tokens.length > 0 && isGhostEmpty(tokens[0])) {
        tokens.shift();
    }
    while (tokens.length > 0 && isGhostEmpty(tokens[tokens.length - 1])) {
        tokens.pop();
    }

    return tokens;
}
async function decompressText(buffer) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
}
async function getTokensForSource(value, historyList) {
    if (value === 'current') {
        const preTag = document.querySelector('pre:not(#diff-pre)');
        return buildRenderedTokens(window._rawHtmlForDiff || (preTag ? preTag.innerHTML : ""));
    }

    const item = historyList[Number(value)];
    if (!item) return [];

    let rawText = "";
    if (item.compressed && item.text instanceof Uint8Array) {
        rawText = await decompressText(item.text);
    } else {
        rawText = item.text;
    }

    const match = rawText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    const rawHtml = match ? match[1] : rawText;

    return buildRenderedTokens(rawHtml);
}