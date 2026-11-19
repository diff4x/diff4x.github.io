if (window.top !== window.self) {
    window.top.location.href = location.origin;
}

window.data = [];
window.isDataSyncing = false;
window._searchToken = 0;
window.cachedFaviconImg = null;
window.faviconBlinkTimer = null;
if (window.__LITE_BUS__) {
    window.__LITE_BUS__.close();
}
window.__LITE_BUS__ = new BroadcastChannel('bus');
window.sharedWasm = {
    ready: false,
    failed: false,
    weightedKeywords: false,
    format_markdown: null,
    find_content_matches_multi: null,
    compute_lcs_diff: null
};
window._tpZoom = 1;

const BUS = window.__LITE_BUS__;
const ctxId = window.top === window.self ? 'index' : window.childId;
const isLocalEnv = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') && location.port !== '9000';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const idleRun = (fn) => window.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 50);
const AsyncUtils = createAsyncUtils();
const dbProxy = createDBProxy('MainDB', 'chunks');
const searchCacheLRU = createSearchCacheLRU(dbProxy);
const searchResultCache = createSearchResultCache(dbProxy, searchCacheLRU, { onClear: () => clearSearchOverlays() });
const popup = $("#giscus-popup");
const header = $("#popup-header");
const doc_title = document.title;
const iframes = {
    content: $('#content'),
    side: $('#side')
};

const store = createStore({
    resource_type: "",
    content_src: "",
    searchHistory: [],
    force_refresh_cache: "0"
});
store.github_page = github_page;
store.protocol_name = github_page.split(".")[0];
store.online_flag = isLocalEnv ? "0" : "1";
store.bookmarkhtml_modifing = "0";
store.lightbox_stauts = "0";
store.jump_from_search = "0";

const MEDIA_POS_KEY = 'media_positions';
const MEDIA_POS_MAX = 500;
const MEDIA_POS_MIN = 1;
const MEDIA_POS_END_GAP = 2;

function mediaPosKey(src) {
    let s = String(src || '').split('#')[0].split('?')[0];
    try { s = decodeURIComponent(s); } catch (e) { }
    const m = s.match(/(?:^|\/)((?:video|audio)\/.+)$/);
    return m ? m[1] : s.replace(/^(?:\.{1,2}\/|\/)+/, '');
}

function readMediaPositions() {
    try {
        const obj = JSON.parse(localStorage.getItem(MEDIA_POS_KEY));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
}

function getMediaPosition(src) {
    const t = readMediaPositions()[mediaPosKey(src)];
    return (typeof t === 'number' && Number.isFinite(t) && t > 0) ? t : 0;
}

function saveMediaPosition(el) {
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

function saveMediaPositionsIn(root) {
    if (root) root.querySelectorAll('video, audio').forEach(el => saveMediaPosition(el));
}

function resumeMediaPosition(el, src) {
    const saved = getMediaPosition(src);
    if (!saved) return;
    try { el.currentTime = saved; } catch (e) { }
    el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && saved > el.duration - MEDIA_POS_END_GAP) el.currentTime = 0;
    }, { once: true });
}

let searchWorker = null;
let _pendingWorker = null;
let _autocompleteSeq = 0;
let audioInitialized = false;
let comments_first_flag = false;
let records = [];
let totalCount = 0;

const COMMENTS_SYNC_INTERVAL = 10 * 60 * 1000;
const commentHitCache = new Map();
const pageHitCache = new Map();
const snippetCache = new Map();
const pendingSnippets = new Map();
const pendingExpands = new Map();
const termSpecsCache = new Map();
let _snipReqId = 0;
let _expandReqId = 0;
const commentModel = {
    ready: false,
    ver: 0,
    sig: "",
    counts: {},
    meta: new Map(),
    index: null
};
window.commentCounts = {};

import('../wasm/compute_intensive_task_processor.min.js').then(async (wasmModule) => {
    await wasmModule.default();
    window.sharedWasm.format_markdown = wasmModule.format_markdown;
    window.sharedWasm.find_content_matches_multi = wasmModule.find_content_matches_multi;
    window.sharedWasm.compute_lcs_diff = wasmModule.compute_lcs_diff;
    window.sharedWasm.weightedKeywords = typeof wasmModule.supports_weighted_keywords === 'function' && !!wasmModule.supports_weighted_keywords();
    window.sharedWasm.ready = true;
}).catch(err => {
    console.error("[Main] Wasm 模块加载失败:", err);
    window.sharedWasm.failed = true;
});

const executeSelfHealing = async (reason, commandId = null) => {
    console.warn(`🚧  触发站点自愈程序: ${reason}`);
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister();
        }
        if ('caches' in window) {
            const keys = await caches.keys();
            for (const k of keys) await caches.delete(k);
        }
        if (window.indexedDB) {
            indexedDB.deleteDatabase('MainDB');
        }
        sessionStorage.removeItem("sw_reload_guard");
        sessionStorage.removeItem("ss_restore_strict");
        if (commandId !== null && commandId !== undefined) {
            store.repair_command_id = commandId.toString();
        }
    } catch (e) {
        console.error("自愈过程发生异常", e);
    }
    alert(`🚧 需要进行站点修复。\n[${reason}]`);
    window.location.href = window.location.origin;
};

window.VirtualCursor = {
    attach: function (targetWindow) {
        let lastHoverEl = null;
        let selectStartRange = null;
        const doc = targetWindow.document;

        const getCaret = (x, y) => {
            if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
            if (doc.caretPositionFromPoint) {
                const pos = doc.caretPositionFromPoint(x, y);
                if (pos) { const r = doc.createRange(); r.setStart(pos.offsetNode, pos.offset); r.collapse(true); return r; }
            }
            return null;
        };
        const getAncestors = (el) => { const c = []; while (el) { c.push(el); el = el.parentElement; } return c; };
        const maybeFocus = (el) => { if ((el.matches && el.matches('input,textarea,select,[contenteditable]')) || el.tabIndex >= 0) el.focus({ preventScroll: true }); };

        targetWindow.handleSimPointer = function (payload) {
            const { op, x, y, deltaX, deltaY } = payload || {};
            if (op === 'leave') {
                if (lastHoverEl) {
                    const chain = getAncestors(lastHoverEl);
                    lastHoverEl.dispatchEvent(new targetWindow.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
                    chain.forEach(a => a.dispatchEvent(new targetWindow.MouseEvent('mouseleave', { bubbles: false })));
                    lastHoverEl = null;
                }
                return;
            }

            if (op === 'enter') return;
            const safeX = Math.max(0, Math.min(doc.documentElement.clientWidth - 1, x));
            const safeY = Math.max(0, Math.min(doc.documentElement.clientHeight - 1, y));
            const el = doc.elementFromPoint(safeX, safeY);
            if (!el) return;

            const base = { bubbles: true, cancelable: true, view: targetWindow, clientX: x, clientY: y };
            const fire = (type, opts) => el.dispatchEvent(new targetWindow.MouseEvent(type, Object.assign({}, base, opts)));

            switch (op) {
                case 'move':
                    if (el !== lastHoverEl) {
                        const oldChain = lastHoverEl ? getAncestors(lastHoverEl) : [];
                        const newChain = getAncestors(el);
                        const oldSet = new Set(oldChain);
                        let common = null;
                        for (const node of newChain) { if (oldSet.has(node)) { common = node; break; } }
                        if (lastHoverEl) {
                            const oldLi = lastHoverEl ? lastHoverEl.closest('li, .history-row, #menu-b a, div > a') : null;
                            if (oldLi) oldLi.removeAttribute('data-touchpad-hover');
                            lastHoverEl.dispatchEvent(new targetWindow.MouseEvent('mouseout', Object.assign({}, base, { relatedTarget: el })));
                            for (const node of oldChain) { if (node === common) break; node.dispatchEvent(new targetWindow.MouseEvent('mouseleave', Object.assign({}, base, { bubbles: false, relatedTarget: el }))); }
                        }
                        const newLi = el.closest ? el.closest('li, .history-row, #menu-b a, div > a') : null;
                        if (newLi) newLi.setAttribute('data-touchpad-hover', 'true');
                        el.dispatchEvent(new targetWindow.MouseEvent('mouseover', Object.assign({}, base, { relatedTarget: lastHoverEl || null })));
                        const toEnter = [];
                        for (const node of newChain) { if (node === common) break; toEnter.push(node); }
                        toEnter.reverse().forEach(node => node.dispatchEvent(new targetWindow.MouseEvent('mouseenter', Object.assign({}, base, { bubbles: false, relatedTarget: lastHoverEl || null }))));
                        lastHoverEl = el;
                    }
                    fire('mousemove', { button: 0 });
                    break;
                case 'click': {
                    fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 });
                    const targetEl = (el.closest && (el.closest('summary, label') || el)) || el;
                    if (typeof targetEl.click === 'function') targetEl.click();
                    else fire('click', { button: 0 });
                    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') { if (el.paused) el.play().catch(() => { }); else el.pause(); }
                    break;
                }
                case 'dblclick': {
                    fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 });
                    const targetEl = (el.closest && (el.closest('summary, label') || el)) || el;
                    if (typeof targetEl.click === 'function') targetEl.click();
                    else fire('click', { button: 0 });
                    fire('mousedown', { button: 0 }); fire('mouseup', { button: 0 });
                    if (typeof targetEl.click === 'function') targetEl.click();
                    else fire('click', { button: 0 });
                    fire('dblclick', { button: 0 });
                    break;
                }
                case 'auxclick': fire('mousedown', { button: 1 }); fire('mouseup', { button: 1 }); fire('auxclick', { button: 1 }); break;
                case 'contextmenu': fire('contextmenu', { button: 2 }); break;
                case 'drag_start': fire('mousedown', { button: 0 }); break;
                case 'drag_end': fire('mouseup', { button: 0 }); break;
                case 'select_start': { const r = getCaret(x, y); if (r) { selectStartRange = r; const sel = targetWindow.getSelection(); sel.removeAllRanges(); sel.addRange(r); } break; }
                case 'select_move': { if (selectStartRange) { const r = getCaret(x, y); if (r) { const sel = targetWindow.getSelection(); sel.removeAllRanges(); if (sel.setBaseAndExtent) sel.setBaseAndExtent(selectStartRange.startContainer, selectStartRange.startOffset, r.startContainer, r.startOffset); } } break; }
                case 'select_end': selectStartRange = null; fire('mouseup', { button: 0 }); break;

                case 'wheel': {
                    const wheelDeltaX = deltaX || 0;
                    const wheelDeltaY = deltaY || 0;
                    const safeX = Math.max(0, Math.min(doc.documentElement.clientWidth - 1, x));
                    const safeY = Math.max(0, Math.min(doc.documentElement.clientHeight - 1, y));
                    const el = doc.elementFromPoint(safeX, safeY);
                    if (!el) return;

                    fire('wheel', { deltaX: wheelDeltaX, deltaY: wheelDeltaY, deltaMode: 0 });
                    let scrollTarget = el;
                    let handled = false;

                    while (scrollTarget && scrollTarget !== doc.body && scrollTarget !== doc.documentElement) {
                        const style = targetWindow.getComputedStyle(scrollTarget);
                        let canScrollY = (wheelDeltaY !== 0) && (scrollTarget.scrollHeight > scrollTarget.clientHeight) &&
                            (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay');
                        let canScrollX = (wheelDeltaX !== 0) && (scrollTarget.scrollWidth > scrollTarget.clientWidth) &&
                            (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay');

                        if (canScrollY) {
                            if (wheelDeltaY > 0 && Math.ceil(scrollTarget.scrollTop + scrollTarget.clientHeight) >= scrollTarget.scrollHeight) canScrollY = false;
                            if (wheelDeltaY < 0 && scrollTarget.scrollTop <= 0) canScrollY = false;
                        }
                        if (canScrollX) {
                            if (wheelDeltaX > 0 && Math.ceil(scrollTarget.scrollLeft + scrollTarget.clientWidth) >= scrollTarget.scrollWidth) canScrollX = false;
                            if (wheelDeltaX < 0 && scrollTarget.scrollLeft <= 0) canScrollX = false;
                        }

                        if (canScrollY || canScrollX) { handled = true; break; }
                        scrollTarget = scrollTarget.parentElement;
                    }

                    if (handled) {
                        scrollTarget.scrollBy({ left: wheelDeltaX, top: wheelDeltaY, behavior: 'auto' });
                    } else {
                        const mainScroll = doc.scrollingElement || doc.documentElement;
                        mainScroll.scrollBy({ left: wheelDeltaX, top: wheelDeltaY, behavior: 'auto' });
                    }
                    break;
                }
            }
        };
    }
};
window.VirtualCursor.attach(window);

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SW_UPDATE_STATUS') {
            const isUpdate = event.data.isUpdate;
            sessionStorage.setItem("isUpdate", isUpdate ? "1" : "0");
        }
    });
}

if (window._globalWatchdog) {
    clearTimeout(window._globalWatchdog);
    window._globalWatchdog = null;
}
window._globalWatchdog = setTimeout(() => {
    executeSelfHealing("核心数据组装严重超时 (疑似 IDB/Wasm 崩溃)");
}, 60000);

window.addEventListener('pagehide', (e) => {
    if (e.persisted) return;
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
});

window.addEventListener('pagehide', () => {
    if (window._isBombing) return;
    const a = document.getElementById('_audio');
    if (a) saveMediaPosition(a);
});

BUS.addEventListener('message', async (e) => {
    const { type, payload, target, from } = e.data || {};
    if (target !== '*' && target !== ctxId) return;

    switch (type) {
        case 'REQUEST_CATALOG':
            if (window.lite_data) {
                emitEvent('RENDER_CATALOG', window.lite_data, 'side');
            }
            break;
        case "LOCAL_SEARCH_RESULT": {
            const activeKw = payload.keyword || store.keyword;
            const inputEl = document.getElementById("searchInput");
            const liveKw = (inputEl ? inputEl.value.trim() : "") || store.keyword || "";
            if (activeKw && liveKw && normalizeKeyword(activeKw) !== normalizeKeyword(liveKw)) {
                break;
            }
            if (!activeKw || isActionCommand(activeKw)) break;

            let hist = store.last_li_a;
            if (!Array.isArray(hist)) hist = hist ? [hist] : [];
            if (store.resource_type !== "html" || hist.length === 0) break;

            const currentPath = hist[0];
            const path = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;
            const title = payload.title || path.split('/').pop().replace('.html', '');
            const count = typeof payload.count === 'number' ? payload.count : 0;

            if (isAdsQuery(activeKw)) {
                const evalRes = evaluateAdsOverlayForPath(activeKw, path, payload.adsBodyHits);
                if (!evalRes) break;
                const changed = setPageHit(activeKw, {
                    path,
                    title,
                    count,
                    isAds: true,
                    matched: evalRes.matched,
                    viaComment: evalRes.viaComment
                });
                if (changed) rerenderSearchOverlay();
                break;
            }

            const changed = setPageHit(activeKw, {
                path,
                title,
                count
            });
            if (changed) rerenderSearchOverlay();
            break;
        }

        case "SEARCH_CACHE_CLEARED":
            searchResultCache.clearMemory();
            break;

        case "reload_bookmark":
            store.bookmarkhtml_modifing = "1";
            const rawHash = store.bookmarkhtml_linksHash;
            let attempts = 0;
            try {
                while (store.bookmarkhtml_linksHash === rawHash && attempts < 30 && store.resource_type === "bookmark") {
                    if ('caches' in window) {
                        try {
                            const keys = await caches.keys();
                            for (const key of keys) {
                                if (key.startsWith('core-cache-')) {
                                    const cache = await caches.open(key);
                                    await cache.delete('/src/tpl/bookmark.html');
                                }
                            }
                        } catch (err) { console.warn("清理书签缓存失败", err); }
                    }
                    const ifr = document.getElementById(from);
                    if (ifr && ifr.contentWindow) ifr.contentWindow.location.reload();

                    attempts++;
                    await AsyncUtils.wait(1000);
                }
            } finally {
                store.bookmarkhtml_modifing = "0";
                if ('caches' in window) {
                    try {
                        const keys = await caches.keys();
                        for (const key of keys) {
                            if (key.startsWith('core-cache-')) {
                                const cache = await caches.open(key);
                                await cache.add('/src/tpl/bookmark.html');
                            }
                        }
                    } catch (err) { console.warn("回填书签缓存失败", err); }
                }
            }
            break;

        case "image":
            store.resource_type = "image";
            iframes.content.src = "about:blank";
            setTimeout(async () => {
                const html = await generateDoc('image', { imageUrl: '../' + store.image_path });
                const doc = iframes.content.contentWindow.document;
                doc.open();
                doc.write(html);
                doc.close();
            }, 20);
            break;

        case "video":
            store.resource_type = "video";
            iframes.content.src = "about:blank";
            setTimeout(async () => {
                const html = await generateDoc('video', { videoUrl: '../' + store.video_path });
                const doc = iframes.content.contentWindow.document;
                doc.open();
                doc.write(html);
                doc.close();
            }, 20);
            break;

        case "pdf":
            await AsyncUtils.wait(50);
            $("#content").src = "src/tpl/pdf.html?file=../../" + store.pdf_path;
            $("#content").focus();
            break;

        case "epub":
            await AsyncUtils.wait(50);
            $("#content").src = "src/tpl/epub.html?book=../../" + store.epub_path;
            $("#content").focus();
            break;

        case "txt":
            await AsyncUtils.wait(50);
            $("#content").src = "src/tpl/txt.html?file=../../" + store.txt_path;
            $("#content").focus();
            break;

        case "audio":
            await AsyncUtils.wait(50);
            const last = store.song_path.split("/").length - 1;
            const song = store.song_path.split("/")[last];
            audio(song, store.song_path.split(song)[0]);
            break;

        case "mask":
            payload.op == "add" ? $("#content").classList.add("mask") : $("#content").classList.remove("mask");
            break;

        case "adj_side_width":
            adj_side_width(payload.op);
            break;

        case "lightbox": {
            const b = payload.status == "1";
            $("#side").classList.toggle("hide", b);
            $("#search").classList.toggle("hide", b);
            $("#content").classList.toggle("mask2", b);
            if ($("#audio")) {
                if ($("#audio").style.display !== "none") {
                    $("#audio").classList.toggle("hide", b);
                }
            }
            if ($("#audio_btn")) {
                if ($("#audio_btn").style.display !== "none") {
                    $("#audio_btn").classList.toggle("hide", b);
                }
            }
            break;
        }

        case "quick_search":
            $("#searchInput").focus();
            break;

        case "load_comments":
            const commentTitle = (payload && typeof payload === 'object') ? payload.title : payload;
            const currentStamp = (payload && typeof payload === 'object') ? payload.stamp : '';

            window._latestCommentTitle = commentTitle;
            window._currentStampText = currentStamp;

            if (currentStamp) {
                updatePopupHeaderWithStamp(currentStamp);
            }

            const checkRecordsAndLoad = async () => {
                try {
                    await AsyncUtils.waitFor(() => records && records.length > 0, 5000, 100);
                } catch (e) { }
                if (window._latestCommentTitle !== commentTitle) {
                    return;
                }
                const record = records.find(r => r.title === commentTitle);
                if (!record) return;
                if (!comments_first_flag) {
                    discussion(record.id);
                    comments_first_flag = true;
                } else {
                    const giscusFrame = $("#giscus-container iframe");
                    if (giscusFrame && giscusFrame.contentWindow) {
                        giscusFrame.contentWindow.postMessage(
                            { giscus: { setConfig: { term: record.id } } },
                            "https://giscus.app"
                        );
                    } else {
                        comments_first_flag = false;
                        discussion(record.id);
                        comments_first_flag = true;
                    }
                }
            };
            checkRecordsAndLoad();
            break;

        case "sh_comments":
            const popup = $("#giscus-popup");
            if (popup.style.display == "none" || !popup.style.display) {
                popup.style.display = "flex";
                popup.style.transform = 'none';
                const popupWidth = popup.offsetWidth || 600;
                popup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';

                const stamp = payload || window._currentStampText;
                updatePopupHeaderWithStamp(stamp);

                if (typeof takeSnapshot === 'function') takeSnapshot(false);
            } else {
                popup.style.display = "none";
            }
            break;

        case "show_changelog":
            import('./deferred-features.js').then(m => m.showChangelog({ dbProxy, emitEvent }));
            break;

        case "play_fav_list":
            const existingPlayer = $("#audio");
            const existingHeader = existingPlayer ? existingPlayer.querySelector('.header') : null;
            if (existingPlayer && existingHeader && existingHeader.textContent === 'Favorite Songs') {
                if (existingPlayer.style.display === 'none') {
                    const toggleBtn = $("#audio_btn");
                    if (toggleBtn) toggleBtn.click();
                }
                break;
            }
            store.resource_type = "audio";
            const firstFav = store.favList[0];
            store.song_path = firstFav;
            if (!existingPlayer) {
                const fileName = firstFav.split("/").pop();
                const dir = firstFav.includes("/") ? firstFav.substring(0, firstFav.lastIndexOf('/') + 1) : "audio/";
                audio(fileName, dir);
            }
            setTimeout(() => {
                const buttons = document.querySelectorAll('#audio button');
                const favListBtn = Array.from(buttons).find(b => b.textContent === 'Favorite Songs');
                if (favListBtn) {
                    favListBtn.click();
                }
                const playerContainer = $("#audio");
                if (playerContainer && playerContainer.style.display === 'none') {
                    const toggleBtn = $("#audio_btn");
                    if (toggleBtn) toggleBtn.click();
                }
            }, 50);
            break;

        case "OPEN_EXCERPTS_NOTEBOOK":
            import('./excerpts.js').then(m => m.ExcerptsUIManager.openAndRefresh());
            break;

        case "SAVE_EXCERPT":
            let bookName = "html";
            if (store.resource_type === 'txt' && store.txt_path) bookName = store.txt_path.split('/').pop();
            else if (store.resource_type === 'pdf' && store.pdf_path) bookName = store.pdf_path.split('/').pop();
            else if (store.resource_type === 'epub' && store.epub_path) bookName = store.epub_path.split('/').pop();

            import('./excerpts.js').then(({ ExcerptsSys, ExcerptsUIManager }) => {
                ExcerptsSys.save(bookName, payload).then(() => {
                    if (document.getElementById('excerpts-popup') && document.getElementById('excerpts-popup').style.display !== 'none') {
                        ExcerptsUIManager.openAndRefresh();
                    }
                }).catch(e => console.error("摘抄失败", e));
            });
            break;

        case 'SHOW_GLOBAL_BOOKMARKS':
            import('./deferred-features.js').then(m => m.showGlobalBookmarkMenu(payload.x, payload.y, payload.source));
            break;

        case 'CLOSE_GLOBAL_BOOKMARKS':
            if (window._closeGlobalMenu) window._closeGlobalMenu();
            break;

        case "PLAY_PRESET_AUDIO":
            store.resource_type = "audio";
            store.song_path = payload;
            const fileName = payload.split('/').pop();
            const dir = payload.substring(0, payload.lastIndexOf('/') + 1);

            audio(fileName, dir);

            setTimeout(() => {
                const slpBtn = document.getElementById("btn_slp");
                if (slpBtn && !slpBtn.classList.contains("active2")) {
                    slpBtn.click();
                }
                const playerContainer = document.getElementById("audio");
                if (playerContainer && playerContainer.style.display !== 'none') {
                    const toggleBtn = document.getElementById("audio_btn");
                    if (toggleBtn) toggleBtn.click();
                }
            }, 100);

            emitEvent('#audio a', payload, 'side');
            emitEvent('show_current', null, 'side');
            break;
        default:
            break;
    }
});

window.addEventListener('message', async (e) => {
    if (e.origin === "https://giscus.app" && e.data?.giscus) {
        const params = new URLSearchParams(window.location.search);
        if (params.get("giscus")) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        const data = e.data.giscus;
        if (data.discussion) {
            totalCount = data.discussion.totalCommentCount || 0;
            emitEvent("cm_count", totalCount, "content");
        }
        if (data.post) {
            window._suppressCommentPopupUntil = Date.now() + 30 * 60 * 1000;
            totalCount++;
            emitEvent("cm_count", totalCount, "content");
            console.log("新增评论:", data.post);
        }
        if (data.error) {
            if (data.error == "Discussion not found") {
                emitEvent("cm_count", 0, "content");
            } else {
                console.error("Giscus 错误:", data.error);
            }
        }
        return;
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        if (document.activeElement !== $("#searchInput")) {
            e.preventDefault();
            $("#searchInput").focus();
        }
    }
});
window.onload = () => {
    if (window.location.search.includes('repair=1')) {
        executeSelfHealing("URL手动指令");
        return;
    }

    setTimeout(() => {
        if (navigator.onLine) {
            fetch('/sw.js?_bypass=' + Date.now(), { cache: 'no-store' })
                .then(res => res.text())
                .then(text => {
                    const match = text.match(/repair_command_id\s*=\s*(\d+)/);
                    if (match) {
                        const remoteId = parseInt(match[1], 10);
                        const localId = parseInt(store.repair_command_id || '0', 10);

                        if (localId === 0) {
                            store.repair_command_id = remoteId.toString();
                            return;
                        }

                        if (remoteId > localId) {
                            executeSelfHealing(`接收到远端修复指令: ${remoteId}`, remoteId);
                        }
                    }
                }).catch(() => { });
        }
    }, 2000);

    if (store.layout_content_flex && store.layout_side_flex) {
        $("#content").style.flex = store.layout_content_flex;
        $("#side").style.flex = store.layout_side_flex;
        requestAnimationFrame(() => {
            adj_search_right();
        });
    }

    search_box();

    iframes.side.src = "src/tpl/side.html";

    snap();
    sw();

    AsyncUtils.wait(10).then(() => loadScripts(6));

    cmt_mapper();
    comments();
    startCommentSync();
    loadPinyinData();

    updateTitle();
    setTimeout(() => {
        updateTitle();
        window.updateTitleTimer = safeInterval(updateTitle, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds());

    window.alertTimer = safeInterval(ls_alert, 60000);

    idleRun(() => {
        import('./deferred-features.js').then(m => {
            m.initBackupReminder({ iframes, safeInterval });
            if (store.online_flag === "0") {
                m.initDueTasksPingPong();
            }
        });
    });

    if (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
        import('./touchpad.js').then(m => m.initTouchpad({ emitEvent }));
    }
}

function emitEvent(type, payload, target = '*') {
    if (!window.__LITE_BUS__) return;
    try {
        window.__LITE_BUS__.postMessage({
            type,
            payload,
            from: ctxId,
            target
        });
    } catch (e) { }
}

function createStore(defaults = {}) {
    return new Proxy({}, {
        get(_, prop) {
            if (prop === 'SearchCache') return searchResultCache;

            if (prop === 'pinyinData') {
                return window.top.pinyinData || {};
            }

            const val = localStorage.getItem(prop);
            if (val === null)
                return defaults[prop];
            try {
                return JSON.parse(val);
            } catch {
                return val;
            }
        },

        set(_, prop, value) {
            if (prop === 'SearchCache') {
                console.warn("store.SearchCache 是只读内置对象，禁止覆盖！");
                return false;
            }
            if (prop === 'pinyinData') {
                return true;
            }
            localStorage.setItem(prop, JSON.stringify(value));
            return true;
        },

        deleteProperty(_, prop) {
            if (prop === 'SearchCache')
                return false;

            if (prop === 'pinyinData') return true;

            localStorage.removeItem(prop);
            return true;
        }
    });
}

function createSearchCacheLRU(db, max = 500) {
    let order = null;
    let loading = null;
    let persistTimer = null;
    let gen = 0;

    const schedulePersist = () => {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            if (order) db.put('sys_state', 'search_cache_lru', order.slice()).catch(() => { });
        }, 1000);
    };

    const load = () => {
        if (order) return Promise.resolve(order);
        if (!loading) {
            const myGen = gen;
            loading = (async () => {
                let saved = [];
                let keys = [];
                try { saved = await db.get('sys_state', 'search_cache_lru'); } catch (e) { }
                try { keys = await db.getAllKeys('search_cache'); } catch (e) { }
                if (!Array.isArray(saved)) saved = [];
                const existing = new Set(keys.filter(k => typeof k === 'string'));
                const savedSet = new Set(saved);
                const unknown = [...existing].filter(k => !savedSet.has(k));
                const known = saved.filter(k => existing.has(k));
                if (myGen === gen) order = unknown.concat(known);
                return order || [];
            })();
        }
        return loading;
    };

    const touch = async (key) => {
        const list = await load();
        const i = list.lastIndexOf(key);
        if (i !== -1) list.splice(i, 1);
        list.push(key);
        schedulePersist();
    };

    const touchAndEvict = async (key) => {
        await touch(key);
        const list = order;
        if (!list || list.length <= max) return;
        const victims = list.splice(0, list.length - max);
        schedulePersist();
        await Promise.all(victims.map(k => db.delete('search_cache', k).catch(() => { })));
    };

    const forget = (key) => {
        if (!order) return;
        const i = order.lastIndexOf(key);
        if (i !== -1) { order.splice(i, 1); schedulePersist(); }
    };

    const reset = () => {
        gen++;
        order = [];
        loading = null;
        clearTimeout(persistTimer);
        db.put('sys_state', 'search_cache_lru', []).catch(() => { });
    };

    return { keys: () => load(), touch, touchAndEvict, forget, reset };
}

function createSearchResultCache(db, lru, { memMax = 48, flushDelay = 400, onClear = () => { } } = {}) {
    const mem = new Map();
    const dirty = new Map();
    let flushTimer = null;
    let flushing = false;
    let epoch = 0;

    const keyPrefix = () => `n${Number(store.noise_level ?? 5)}|l${Number(store.synonyms_enabled ?? 1)}|`;
    const makeKey = (kw) => {
        const norm = normalizeKeyword(kw);
        return norm ? keyPrefix() + norm : '';
    };
    const stripKeyPrefix = (k) => (typeof k === 'string' ? k.replace(/^n\d+\|l[01]\|/, '') : '');
    const unpackEntry = (raw) => {
        if (Array.isArray(raw)) return { results: raw, termSpecs: null };
        if (raw && Array.isArray(raw.results)) {
            return { results: raw.results, termSpecs: Array.isArray(raw.termSpecs) ? raw.termSpecs : null };
        }
        return null;
    };

    const memGet = (k) => {
        const v = mem.get(k);
        if (v === undefined) return undefined;
        mem.delete(k);
        mem.set(k, v);
        return v;
    };
    const memSet = (k, v) => {
        mem.delete(k);
        mem.set(k, v);
        if (mem.size > memMax) mem.delete(mem.keys().next().value);
    };

    const flush = async () => {
        flushTimer = null;
        if (flushing) return;
        flushing = true;
        try {
            while (dirty.size > 0) {
                const startEpoch = epoch;
                const [k, v] = dirty.entries().next().value;
                dirty.delete(k);
                if (!mem.has(k)) continue;
                try {
                    await db.put('search_cache', k, v);
                    if (epoch !== startEpoch || !mem.has(k)) {
                        await db.delete('search_cache', k).catch(() => { });
                        lru.forget(k);
                        continue;
                    }
                    await lru.touchAndEvict(k);
                } catch (e) { }
            }
        } finally {
            flushing = false;
        }
    };

    const getMeta = async (kw) => {
        try {
            const normKw = normalizeKeyword(kw);
            if (!normKw) return null;
            const pfx = keyPrefix();
            const fullKey = pfx + normKw;

            let exact = memGet(fullKey);
            if (exact === undefined && (await lru.keys()).includes(fullKey)) {
                exact = await db.get('search_cache', fullKey);
                if (exact) memSet(fullKey, exact);
                else lru.forget(fullKey);
            }
            if (exact) {
                const unpacked = unpackEntry(exact);
                if (unpacked) {
                    lru.touch(fullKey);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: true, fromCache: true };
                }
            }
            if ((store.synonyms_enabled ?? 1) === 1) return null;

            const isPrefix = (k) => {
                if (typeof k !== 'string' || !k.startsWith(pfx)) return false;
                const sub = k.slice(pfx.length);
                return sub.length > 2 && sub !== normKw && normKw.startsWith(sub);
            };
            const byLenDesc = (a, b) => b.length - a.length;

            for (const key of Array.from(mem.keys()).filter(isPrefix).sort(byLenDesc)) {
                const unpacked = unpackEntry(memGet(key));
                if (unpacked && unpacked.results.length > 0) {
                    lru.touch(key);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: false, fromCache: true };
                }
            }
            const candidates = (await lru.keys())
                .filter(k => isPrefix(k) && !mem.has(k))
                .sort(byLenDesc)
                .slice(0, 3);
            for (const key of candidates) {
                const raw = await db.get('search_cache', key);
                const unpacked = unpackEntry(raw);
                if (unpacked && unpacked.results.length > 0) {
                    memSet(key, raw);
                    lru.touch(key);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: false, fromCache: true };
                }
                if (raw === undefined) lru.forget(key);
            }
            return null;
        } catch (e) { return null; }
    };

    const SEARCH_CACHE_MAX_HITS = 300;
    const set = async (kw, results, termSpecs = null) => {
        const fullKey = makeKey(kw);
        if (!fullKey || !Array.isArray(results) || results.length > SEARCH_CACHE_MAX_HITS) return;
        const val = Array.isArray(termSpecs) && termSpecs.length > 0 ? { results, termSpecs } : results;
        memSet(fullKey, val);
        dirty.set(fullKey, val);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, flushDelay);
    };

    const remove = async (kw, opts = {}) => {
        try {
            const normKw = normalizeKeyword(kw);
            if (!normKw) return;
            const delKeys = new Set([keyPrefix() + normKw]);
            if (opts && opts.allVariants) {
                for (const k of mem.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
                for (const k of dirty.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
                for (const k of await lru.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
            }
            for (const k of delKeys) {
                mem.delete(k);
                dirty.delete(k);
                lru.forget(k);
                await db.delete('search_cache', k);
            }
        } catch (e) { }
    };

    const clearMemory = () => {
        epoch++;
        mem.clear();
        dirty.clear();
        clearTimeout(flushTimer);
        flushTimer = null;
        onClear();
    };

    const clear = async () => {
        clearMemory();
        try {
            await db.clear('search_cache');
            lru.reset();
            emitEvent('SEARCH_CACHE_CLEARED', null, 'index');
        } catch (e) { }
    };

    const boundNs = new Map();
    const bindNamespace = async (slot, next) => {
        if (typeof slot !== 'string' || typeof next !== 'string') return false;
        if (boundNs.get(slot) === next) return false;
        boundNs.set(slot, next);
        const key = 'search_cache_ns:' + slot;
        let saved;
        try { saved = await db.get('sys_state', key); } catch (e) { saved = undefined; }
        if (boundNs.get(slot) !== next) return false;
        if (saved === next) return false;
        await clear();
        try { await db.put('sys_state', key, next); } catch (e) { }
        return true;
    };

    window.addEventListener('pagehide', () => { if (dirty.size > 0) flush(); });

    return { getMeta, set, remove, clear, clearMemory, bindNamespace, stripKeyPrefix };
}

function createDBProxy(dbName, storeName) {
    let dbInstance = null;
    let initPromise = null;

    const init = async () => {
        if (dbInstance) return dbInstance;
        if (initPromise) return initPromise;

        initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName, 3);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(storeName))
                    db.createObjectStore(storeName);
                if (!db.objectStoreNames.contains('update_logs'))
                    db.createObjectStore('update_logs', { autoIncrement: true });
                if (!db.objectStoreNames.contains('search_cache'))
                    db.createObjectStore('search_cache');
                if (!db.objectStoreNames.contains('sys_state'))
                    db.createObjectStore('sys_state');
                if (!db.objectStoreNames.contains('html_snapshots'))
                    db.createObjectStore('html_snapshots');
            };

            request.onsuccess = (e) => {
                dbInstance = e.target.result;
                initPromise = null;

                dbInstance.onclose = () => {
                    dbInstance = null;
                };

                dbInstance.onversionchange = () => {
                    dbInstance.close();
                    dbInstance = null;
                };

                resolve(dbInstance);
            };

            request.onerror = (e) => {
                initPromise = null;
                reject(e.target.error);
            };
        });

        return initPromise;
    };

    return {
        async save(id, payload) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(tx.error || e.target.error);
                try {
                    tx.objectStore(storeName).put(payload, id);
                } catch (err) {
                    reject(err);
                }
            });
        },

        async getAll() {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly');
                const request = tx.objectStore(storeName).getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = (e) => reject(request.error);
            });
        },

        async addLog(msg) {
            const db = await init();
            return new Promise((resolve) => {
                const tx = db.transaction('update_logs', 'readwrite');
                tx.objectStore('update_logs').add({ msg, ts: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        },

        async getLogs() {
            const db = await init();
            return new Promise((resolve) => {
                const tx = db.transaction('update_logs', 'readonly');
                const req = tx.objectStore('update_logs').getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        },

        async clearLogs() {
            const db = await init();
            return new Promise((resolve) => {
                const tx = db.transaction('update_logs', 'readwrite');
                tx.objectStore('update_logs').clear();
                tx.oncomplete = () => resolve();
            });
        },

        async delete(idOrStore, key) {
            const db = await init();
            const targetStore = key !== undefined ? idOrStore : storeName;
            const targetKey = key !== undefined ? key : idOrStore;
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(tx.error);
                tx.objectStore(targetStore).delete(targetKey);
            });
        },

        async get(targetStore, key) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readonly');
                const req = tx.objectStore(targetStore).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        },

        async saveBatch(entries) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(tx.error || (e && e.target && e.target.error));
                try {
                    const os = tx.objectStore(storeName);
                    for (const { id, payload } of entries) {
                        os.put(payload, id);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        },

        async put(targetStore, key, value) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(tx.error || (e && e.target && e.target.error));
                try {
                    tx.objectStore(targetStore).put(value, key);
                } catch (err) {
                    reject(err);
                }
            });
        },

        async clear(targetStore) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
                tx.objectStore(targetStore).clear();
            });
        },

        async getAllKeys(targetStore) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readonly');
                const req = tx.objectStore(targetStore).getAllKeys();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }
    };
}

async function loadScripts(concurrency) {
    console.time("⏱️ loadScripts 总耗时");

    window.isDataSyncing = true;
    prewarmSearchWorker();
    window._chunksPrefetch = dbProxy.getAll();
    window._chunksPrefetch.catch(() => { });

    const injectScript = (src) => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src; script.type = "text/javascript"; script.charset = "UTF-8";
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = () => reject(new Error(`加载失败: ${src}`));
        document.body.appendChild(script);
    });
    const now = Date.now();

    try {
        try {
            await injectScript(`src/js/core-list.js?t=${now}`);
        } catch (e) {
            window.FILE_MANIFEST = window.FILE_MANIFEST || {};
            window.dataIndex = [];
            window._isOfflineDataFallback = true;
        }

        window.shadowIndex = [];
        if (store.online_flag === "0") {
            try {
                await injectScript(`src/js/data/shadowIndex.js?t=${now}`);
            } catch (e) {
                console.warn("未探测到私有影子数据");
            }
        }

        try {
            const litePath = "/src/js/data/lite_data.js";
            const liteHash = FILE_MANIFEST[litePath] ? FILE_MANIFEST[litePath].hash : now;
            await injectScript(`src/js/data/lite_data.js?v=${liteHash}`);
            if (!window.LITE_DATA)
                throw new Error(`lite_data.js 内无有效数据`);
            window.lite_data = window.LITE_DATA;
        } catch (e) {
            console.error("❌ 致命错误：侧边栏数据彻底崩溃", e);
            window.lite_data = { html: {}, image: {}, video: {}, audio: {}, ebook: {} };
        }

        if (iframes?.side?.contentDocument?.readyState === 'complete') {
            emitEvent('RENDER_CATALOG', window.lite_data, 'side');
        } else {
            await new Promise(resolve => {
                iframes.side.addEventListener('load', resolve, { once: true });
            });
            emitEvent('RENDER_CATALOG', window.lite_data, 'side');
        }

        window.restoreSnapPromise = restore_snap();

        window.restoreSnapPromise
            .catch(err => {
                console.warn("⚠️ 快照恢复中止或超时:", err);
            })
            .finally(() => {
                $("#search").style.display = "block";
            });

        const rawIndex = Array.isArray(window.dataIndex) ? window.dataIndex : [];
        const fatFiles = rawIndex.filter(f => typeof f === 'string' && f.startsWith('fat_data_'));

        await loadDataInBatches(fatFiles, now, concurrency);
    } catch (err) {
        console.error("❌ 核心流程中断，降级处理:", err);
        consumeRefreshCelebration();
    } finally {
        window.isDataSyncing = false;
        if (window._globalWatchdog) {
            clearTimeout(window._globalWatchdog);
            window._globalWatchdog = null;
        }
    }

    console.timeEnd("⏱️ loadScripts 总耗时");
}

function createSearchWorker() {
    const worker = new Worker('src/js/worker.js', { type: 'module' });
    worker.onmessage = async (e) => {
        const { type, results, keyword, token, payload, commentHits } = e.data;

        if (type === 'DELETE_CACHE') {
            const normO = normalizeKeyword(keyword);
            const inHist = (store.searchHistory || []).some(h => normalizeKeyword(h.keyword) === normO);
            if (!inHist) store.SearchCache.remove(keyword);
            return;
        }

        if (type === 'COMMENT_HITS') {
            if (token !== window._searchToken) return;
            if (setCommentHits(keyword, commentHits || [])) rerenderSearchOverlay();
            return;
        }

        if (type === 'SYNONYMS_READY') {
            window._synonymsReady = true;
            window.synonymIndex = payload || { version: '', groups: [] };
            onSynonymsLoaded().catch(() => { });
            return;
        }

        if (type === 'EXPAND_RESULT') {
            const cb = pendingExpands.get(e.data.reqId);
            if (Array.isArray(e.data.results)) {
                for (const it of e.data.results) {
                    if (it && it.text && Array.isArray(it.specs)) {
                        cacheTermSpecs(it.text, !!it.like, it.specs);
                    }
                }
            }
            if (cb) {
                pendingExpands.delete(e.data.reqId);
                cb(e.data.results || []);
            }
            return;
        }

        if (type === 'SNIPPETS_RESULT') {
            const cb = pendingSnippets.get(e.data.reqId);
            if (cb) {
                pendingSnippets.delete(e.data.reqId);
                cb(e.data.snippets);
            }
            return;
        }

        if (type === 'ENGINE_ERROR') {
            window._engineError = e.data.error || '搜索引擎异常';
            sfPaintStatus(window._currentRenderedKeyword || ($("#searchInput") && $("#searchInput").value) || '');
            return;
        }

        if (type === 'SEARCH_RESULTS') {
            if (token !== window._searchToken) {
                console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                return;
            }
            const curNs = computeQueryContextSig();
            if (e.data.ns && e.data.ns !== curNs) {
                console.log(`[Search] 拦截到跨设置结果 "${keyword}"，已丢弃。`);
                return;
            }

            window._engineError = '';
            if (Array.isArray(commentHits)) setCommentHits(keyword, commentHits);
            if (e.data.error) window._adsStatus = { error: e.data.error };

            const activeKw = keyword || store.keyword;
            if (Array.isArray(e.data.termSpecs) && e.data.termSpecs.length > 0) {
                cacheTermSpecs(activeKw, (store.synonyms_enabled ?? 1) === 1, e.data.termSpecs);
            }
            if (Array.isArray(e.data.adsTermSpecs)) {
                for (const ts of e.data.adsTermSpecs) {
                    if (ts && ts.text && Array.isArray(ts.keywords)) {
                        cacheTermSpecs(ts.text, !!ts.like, ts.keywords);
                    }
                }
            }
            if (e.data.synApplied === false) window._searchSentWithoutSyn = true;

            if (activeKw && !isReservedSearchCommand(activeKw)) {
                clearTimeout(window._idbWriteTimer);
                window._idbWriteTimer = setTimeout(() => {
                    searchWorker.postMessage({ type: 'COMMIT_CURSOR', payload: { keyword: activeKw } });
                }, 600);
            }

            const nsMatched = !e.data.ns || e.data.ns === curNs;
            processAndShowResults(results, activeKw, {
                noCache: e.data.synApplied === false || !nsMatched,
                termSpecs: e.data.termSpecs || null
            });
        } else if (type === 'DATA_READY') {
            window._engineError = '';
            invalidateSearch();
            const slim = Array.isArray(payload) ? payload : ((payload && payload.data) || []);
            window.data = slim;
            window._dataReady = true;
            window._dataFp = (payload && !Array.isArray(payload) && payload.fp) || ('len' + slim.length);
            snippetCache.clear();
            termSpecsCache.clear();
            const nsPromise = bindCoreNamespace();
            await finalizeDataLoad();
            if (await nsPromise) {
                invalidateSearch();
                rerunActiveSearch();
            }
        }
    };
    worker.onerror = (err) => {
        console.error('[Worker] 运行时错误:', err);
        window._engineError = '搜索引擎线程崩溃，请刷新或修复站点';
        sfPaintStatus(window._currentRenderedKeyword || ($("#searchInput") && $("#searchInput").value) || '');
    };
    worker.onmessageerror = (err) => {
        console.error('[Worker] 消息反序列化失败:', err);
        window._engineError = '搜索引擎通信异常';
        sfPaintStatus(window._currentRenderedKeyword || ($("#searchInput") && $("#searchInput").value) || '');
    };
    if (commentModel.index) worker.postMessage({ type: 'SET_COMMENTS', payload: commentModel.index });
    return worker;
}

function prewarmSearchWorker() {
    if (searchWorker || _pendingWorker) return;
    try {
        _pendingWorker = createSearchWorker();
    } catch (e) {
        console.warn("[Worker] 预热失败，将在数据加载阶段重试:", e);
    }
}

async function loadDataInBatches(files, now, concurrency) {
    const cachedChunks = await (window._chunksPrefetch || dbProxy.getAll());
    window._chunksPrefetch = null;
    const cachedMap = new Map(cachedChunks.map(c => [c.id, c.fingerprint]));
    const chunkDataMap = new Map(cachedChunks.map(c => [c.id, c.data]));

    if (window._isOfflineDataFallback || (files.length === 0 && cachedChunks.length > 0)) {
        window._isOfflineDataFallback = true;
        files = cachedChunks.map(c => c.id);
    }
    const validFatFiles = new Set(files);

    if (!window._isOfflineDataFallback) {
        for (const cached of cachedChunks) {
            if (!validFatFiles.has(cached.id)) {
                await dbProxy.delete(cached.id);
                await dbProxy.addLog(`🧹 [IDB] 清理过期废弃切片: ${cached.id}`);
                console.log(`🧹 [IDB] 清理废弃切片: ${cached.id}`);
            }
        }
    }

    const filesToFetch = [];
    files.forEach(src => {
        const webPath = "/src/js/data/" + src;
        const newHash = FILE_MANIFEST[webPath] ? FILE_MANIFEST[webPath].hash : null;
        if (cachedMap.get(src) !== newHash)
            filesToFetch.push(src);
    });

    if (!searchWorker) {
        searchWorker = _pendingWorker || createSearchWorker();
        _pendingWorker = null;
    }

    const buildAndPushData = async () => {
        let fat_data_merged = {};
        files.forEach(src => {
            const chunkData = chunkDataMap.get(src);
            if (chunkData) Object.assign(fat_data_merged, chunkData);
        });

        let shadow_data_merged = {};
        const shadowDataChunks = new Map();
        if (store.online_flag === "0" && window.shadowIndex.length > 0) {
            await Promise.allSettled(window.shadowIndex.map(async (src) => {
                try {
                    const res = await fetch(`src/js/data/${src}?t=${now}`, { cache: 'no-store' });
                    if (res.ok) shadowDataChunks.set(src, await res.json());
                } catch (e) { console.warn(`影子数据拉取失败`, e); }
            }));
        }
        shadowDataChunks.forEach(chunk => Object.assign(shadow_data_merged, chunk));

        try {
            const isOffline = store.online_flag === "0";

            searchWorker.postMessage({
                type: 'BUILD_DATA',
                payload: {
                    liteData: window.lite_data || {},
                    fatData: fat_data_merged,
                    shadowData: shadow_data_merged,
                    isOffline: isOffline
                }
            });

        } catch (e) {
            console.error("❌ 数据推送 Worker 异常，降级处理:", e);
            window.data = [];
            await finalizeDataLoad();
        }

        fat_data_merged = null;
        chunkDataMap.clear();
    };

    if (filesToFetch.length === 0) {
        await buildAndPushData();
        return;
    }

    const fetchedEntries = [];
    let failedCount = 0;

    for (let i = 0; i < filesToFetch.length; i += concurrency) {
        const batch = filesToFetch.slice(i, i + concurrency);

        const results = await Promise.allSettled(
            batch.map(async src => {
                const webPath = "/src/js/data/" + src;
                const newHash = FILE_MANIFEST[webPath]?.hash ?? now;

                const controller = new AbortController();
                const timeoutTimer = setTimeout(() => controller.abort(), 60000);
                try {
                    const response = await fetch(`src/js/data/${src}?v=${newHash}`, { cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);

                    const chunkData = await response.json();
                    if (!chunkData || typeof chunkData !== 'object')
                        throw new Error(`结构无效`);

                    fetchedEntries.push({
                        src,
                        isExisted: cachedMap.has(src),
                        payload: { id: src, fingerprint: newHash, data: chunkData }
                    });
                } finally {
                    clearTimeout(timeoutTimer);
                }
            })
        );

        results.forEach((res, index) => {
            if (res.status === 'rejected') {
                failedCount++;
                console.error(`❌ 切片 ${batch[index]} 拉取失败:`, res.reason);
            }
        });
    }

    if (fetchedEntries.length > 0) {
        if (failedCount === 0) {
            for (const entry of fetchedEntries) {
                chunkDataMap.set(entry.src, entry.payload.data);
            }
            await dbProxy.saveBatch(fetchedEntries.map(e => ({ id: e.src, payload: e.payload })));
            await store.SearchCache.clear();
            if (cachedMap.size > 0) {
                for (const entry of fetchedEntries) {
                    await dbProxy.addLog(entry.isExisted ? `🔄 更新: ${entry.src}` : `✅ 新增: ${entry.src}`);
                }
            }
        } else {
            console.warn(`⚠️ 本轮 ${failedCount}/${filesToFetch.length} 个切片拉取失败，跳过落盘以避免切片版本不一致`);
        }
    }

    await buildAndPushData();
}

function consumeRefreshCelebration() {
    if (store.force_refresh_cache !== "1") return;
    store.force_refresh_cache = "0";
    const runCelebration = () => {
        import('./deferred-features.js').then(m => {
            idleRun(m.playConfetti);
            if (store.auto_show_changelog !== "0") {
                setTimeout(() => m.showChangelog({ dbProxy, emitEvent }), 800);
            }
        });
    };
    if (window.restoreSnapPromise) {
        window.restoreSnapPromise.then(() => {
            runCelebration();
            window.restoreSnapPromise = null;
        });
    } else {
        runCelebration();
    }
}

async function finalizeDataLoad() {
    try {
        if (!window._isOfflineDataFallback && Array.isArray(window.data) && window.data.length > 0) {
            const currentMediaPaths = new Set();
            for (let i = 0; i < window.data.length; i += 4) {
                const type = window.data[i + 3];
                if (['image', 'video', 'audio', 'ebook'].includes(type)) {
                    currentMediaPaths.add(window.data[i + 2]);
                }
            }

            const oldMediaListRaw = await dbProxy.get('sys_state', 'media_paths_snapshot');

            if (!oldMediaListRaw) {
                await dbProxy.put('sys_state', 'media_paths_snapshot', Array.from(currentMediaPaths));
            } else {
                const oldMediaPaths = new Set(oldMediaListRaw);
                let hasMediaUpdates = false;
                const deletedPaths = [];

                for (const path of currentMediaPaths) {
                    if (!oldMediaPaths.has(path)) {
                        await dbProxy.addLog(`✅ 新增媒体: /${path}`);
                        hasMediaUpdates = true;
                    }
                }

                for (const path of oldMediaPaths) {
                    if (!currentMediaPaths.has(path)) {
                        await dbProxy.addLog(`⛔ 删除媒体: /${path}`);
                        deletedPaths.push(path);
                        hasMediaUpdates = true;
                    }
                }

                if (deletedPaths.length > 0 && 'caches' in window) {
                    try {
                        const mediaCache = await caches.open('media-cache');
                        await Promise.all(deletedPaths.map(p => mediaCache.delete('/' + p, { ignoreSearch: true })));
                    } catch (e) { }
                }

                if (hasMediaUpdates) {
                    await dbProxy.put('sys_state', 'media_paths_snapshot', Array.from(currentMediaPaths));
                }
            }
        }
    } catch (err) {
        console.warn("媒体资源 Diff 侦测失败", err);
    }

    consumeRefreshCelebration();
}

function sw() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
            if (reg.waiting && navigator.serviceWorker.controller) {
                promptUpdate(reg.waiting);
            }

            let isUpdating = false;
            const checkUpdate = async () => {
                if (isUpdating || !navigator.onLine) return;
                isUpdating = true;
                try {
                    if (reg.active) {
                        await reg.update();
                    }
                } catch (e) {
                    console.warn("SW update 触发中止:", e);
                } finally {
                    isUpdating = false;
                }
            };

            checkUpdate();

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    checkUpdate();
                }
            });

            if (window.updateTimer) {
                clearInterval(window.updateTimer);
            }
            window.updateTimer = safeInterval(checkUpdate, store.online_flag === "0" ? update_interval_local : update_interval);

            function promptUpdate(swObj) {
                if (store.online_flag === "0") {
                    swObj.postMessage({ type: 'SKIP_WAITING' });
                } else {
                    AsyncUtils.waitFor(() => {
                        try {
                            const win = iframes.side.contentWindow;
                            return win && typeof win.buildCatalogFromLiteData === 'function';
                        } catch (e) {
                            return false;
                        }
                    }, 10000, 150).then(() => {
                        emitEvent('show_update_banner', null, 'side');
                    }).catch(() => {
                        emitEvent('show_update_banner', null, 'side');
                    });
                }
            }

            reg.addEventListener('updatefound', () => {
                const newSW = reg.installing;
                newSW.addEventListener('statechange', () => {
                    if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
                        promptUpdate(newSW);
                    }
                });
            });

            if (!window._swMsgBound) {
                window._swMsgBound = true;
                BUS.addEventListener('message', (e) => {
                    if (e.data && e.data.type === 'execute_update') {
                        const latestWaitingWorker = reg.waiting;
                        if (latestWaitingWorker) {
                            latestWaitingWorker.postMessage({ type: 'SKIP_WAITING' });
                        }
                    }
                });
            }
        }).catch(err => console.error('SW 注册失败:', err));
    }
}

function upgradeSearchHistoryBox(oldEl) {
    if (!oldEl || oldEl.tagName !== 'SELECT') return oldEl;

    const selCs = getComputedStyle(oldEl);
    const selBg = (selCs.backgroundColor && selCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && selCs.backgroundColor !== 'transparent')
        ? selCs.backgroundColor : '#fff';
    const selBorder = (selCs.borderTopWidth && parseFloat(selCs.borderTopWidth) > 0)
        ? `${selCs.borderTopWidth} ${selCs.borderTopStyle || 'solid'} ${selCs.borderTopColor || '#767676'}`
        : '1px solid #767676';
    const selRadius = selCs.borderRadius || '2px';
    const selFont = selCs.fontFamily || 'Arial, "Microsoft YaHei", sans-serif';
    const selFontSize = selCs.fontSize || '13.3333px';

    if (!document.getElementById('sh-custom-style')) {
        const st = document.createElement('style');
        st.id = 'sh-custom-style';
        st.textContent = `
#searchHistory{box-sizing:border-box;overflow-y:auto;overflow-x:hidden;background-color:${selBg};border:${selBorder};border-radius:${selRadius};font-family:${selFont};font-size:${selFontSize};line-height:normal;color:#000;user-select:none;-webkit-user-select:none;outline:none}
#searchHistory .sh-opt{display:block;box-sizing:border-box;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;padding:0 4px 1px;min-height:1.2em;line-height:1.35}
#searchHistory .sh-opt:hover{background-color:aliceblue}
#searchHistory .sh-opt.sh-selected{background-color:#dcdcdc;color:#000}
`;
        document.head.appendChild(st);
    }

    const box = document.createElement('div');
    box.id = 'searchHistory';
    box.setAttribute('role', 'listbox');
    box.tabIndex = 0;
    box.style.cssText = oldEl.style.cssText;

    let _selectedIdx = -1;
    Object.defineProperty(box, 'options', {
        get() { return this.querySelectorAll('.sh-opt'); }
    });
    Object.defineProperty(box, 'selectedIndex', {
        get() {
            const opts = this.options;
            return (_selectedIdx >= 0 && _selectedIdx < opts.length) ? _selectedIdx : -1;
        },
        set(val) {
            const opts = this.options;
            const next = (typeof val === 'number' && val >= 0 && val < opts.length) ? val : -1;
            _selectedIdx = next;
            opts.forEach((el, i) => {
                const sel = i === next;
                el.classList.toggle('sh-selected', sel);
                el.setAttribute('aria-selected', sel ? 'true' : 'false');
                if (sel) el.scrollIntoView({ block: 'nearest' });
            });
        }
    });
    box.syncHeight = function () {
        const opts = this.options;
        if (!opts.length) {
            this.style.display = 'none';
            return;
        }
        const rowH = (opts[0] && opts[0].offsetHeight) || Math.ceil(parseFloat(getComputedStyle(this).fontSize || '13.33') * 1.35) || 18;
        const rows = Math.max(2, Math.min(10, opts.length));
        this.style.height = (rows * rowH + 2) + 'px';
    };

    oldEl.parentNode.replaceChild(box, oldEl);
    return box;
}

function makeHistoryOption(keyword, isHistory = true) {
    const opt = document.createElement('div');
    opt.className = 'sh-opt';
    opt.setAttribute('role', 'option');
    opt.textContent = keyword;
    Object.defineProperty(opt, 'text', {
        get() { return this.textContent; },
        set(v) { this.textContent = v; }
    });
    if (!isHistory) {
        opt.style.color = '#64748b';
        opt.style.fontStyle = 'italic';
    }
    return opt;
}

function search_box() {
    const elSearchInput = $("#searchInput");
    const elSearchHistory = upgradeSearchHistoryBox($("#searchHistory"));
    const elSearchResults = upgradeSearchResultsBox($("#searchResults"));
    elSearchInput.setAttribute("autocomplete", "off");

    function showSearchHistoryByTime() {
        const elSearchHistory = $("#searchHistory");
        elSearchHistory.innerHTML = "";
        const history = [...(store.searchHistory || [])];
        if (history.length === 0) {
            elSearchHistory.style.display = "none";
            return;
        }
        elSearchHistory.style.display = "block";
        history.sort((a, b) => b.timestamp - a.timestamp);
        history.forEach(item => {
            elSearchHistory.appendChild(makeHistoryOption(item.keyword, true));
        });
        if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
    }

    async function loadContent(selectedIndex) {
        const option = elSearchResults.options[selectedIndex];

        if (store.online_flag === "1" && option.dataset.localOnly === "true") {
            alert("🔒 访问受限：仅限本地查阅。");
            return;
        }
        const activeKw = window._currentRenderedKeyword || (elSearchInput ? elSearchInput.value.trim() : "");
        if (activeKw && !isActionCommand(activeKw)) {
            store.keyword = activeKw;
        }
        var type = option.dataset.type;
        var title = option.dataset.title;
        var path = option.dataset.path;
        if (type == "html") {
            emitEvent('#html a', path, 'side')
        } else if (type == "image") {
            emitEvent('#gallery a', path, 'side')
        } else if (type == "video") {
            emitEvent('#video a', path, 'side')
        } else if (type == "pdf" || type == "epub" || type == "txt") {
            emitEvent('#ebook a', path, 'side')
        } else if (type == "audio") {
            emitEvent('#audio a', path, 'side')
        }
        emitEvent('show_current', null, 'side');
    }

    function clickOrChange(select, handler) {
        let isHandling = false;
        const trigger = (idx) => {
            if (isHandling || idx < 0) return;
            isHandling = true;
            handler(idx);
            setTimeout(() => { isHandling = false; }, 150);
        };
        if (select.tagName !== 'SELECT') {
            select.addEventListener('click', (e) => {
                const opt = e.target.closest && e.target.closest('.sr-opt, .sh-opt');
                if (!opt) return;
                const idx = Array.prototype.indexOf.call(select.options, opt);
                if (idx >= 0) {
                    select.selectedIndex = idx;
                    trigger(idx);
                }
            });
            select.addEventListener('keydown', (e) => {
                const opts = select.options;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    elSearchInput.focus();
                    return;
                }
                if (!opts.length) return;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const cur = select.selectedIndex;
                    select.selectedIndex = cur < 0 ? 0 : (cur + 1) % opts.length;
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const cur = select.selectedIndex;
                    select.selectedIndex = cur <= 0 ? opts.length - 1 : cur - 1;
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (select.selectedIndex >= 0) trigger(select.selectedIndex);
                }
            });
            return;
        }
        const wrap = function () {
            trigger(this.selectedIndex);
        };
        const isMobile = /Mobi|Android/i.test(navigator.userAgent);
        if (isMobile) {
            select.addEventListener('change', wrap);
        } else {
            select.addEventListener('click', wrap);
            select.addEventListener('change', wrap);
        }
    }

    function initHistoryBox(status) {
        elSearchHistory.innerHTML = "";
        elSearchHistory.style.display = status === 1 ? "block" : "none";
    }

    function recordSearchHistory(keyword) {
        const kw = (keyword || "").trim();
        if (!kw || isActionCommand(kw)) return;
        const history = [...(store.searchHistory || [])];
        const i = history.findIndex(item => item.keyword === kw);
        if (i !== -1) history.splice(i, 1);
        history.unshift({ keyword: kw, timestamp: Date.now() });
        history.sort((a, b) => b.timestamp - a.timestamp);
        if (history.length > 100) history.length = 100;
        store.searchHistory = history;
    }

    let searchDebounceTimer = null;
    let composing = false;

    const scheduleSearch = (val, delay) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            const trimmed = val.trim();
            if (isActionCommand(trimmed)) return;
            search(trimmed);
            store.keyword = val;
        }, isAdsQuery(val) ? Math.max(delay, 450) : delay);
    };

    const onValueSettled = (val, delay = 150) => {
        const trimmed = val.trim();
        if (trimmed === "") {
            clearTimeout(searchDebounceTimer);
            invalidateSearch();
            _autocompleteSeq++;
            updateSearchResults([]);
            showSearchHistoryByTime();
            return;
        }

        if (isActionCommand(trimmed)) {
            clearTimeout(searchDebounceTimer);
            invalidateSearch();
            _autocompleteSeq++;
            updateSearchResults([]);
            initHistoryBox(0);
            return;
        }

        invalidateSearch();
        scheduleSearch(val, delay);

        initHistoryBox(1);
        updateAutocompleteSuggestions(val).catch(err => console.warn("联想渲染失败", err));
    };

    elSearchInput.addEventListener("compositionstart", function () {
        composing = true;
        clearTimeout(searchDebounceTimer);
    });
    elSearchInput.addEventListener("compositionend", function () {
        composing = false;
        onValueSettled(this.value, 0);
    });
    elSearchInput.addEventListener("input", function (e) {
        if (composing || e.isComposing) return;
        onValueSettled(this.value);
    });

    elSearchInput.addEventListener("focus", function () {
        if (this.value.trim() !== "") {
            updateAutocompleteSuggestions(this.value).catch(err => console.warn("联想渲染失败", err));
            return;
        }
        showSearchHistoryByTime();
        elSearchHistory.selectedIndex = -1;
    });

    elSearchInput.addEventListener("click", function () {
        this.select();
    });

    elSearchInput.addEventListener("keydown", function (e) {
        if (composing || e.isComposing || e.keyCode === 229) return;
        const val = this.value.trim();
        if (e.keyCode === 40 || e.keyCode === 13 || e.key === "Enter") {
            e.preventDefault();
            if (val === "@bomb") {
                import('./deferred-features.js').then(m => m.bomb({ iframes }));
                this.value = "";
                initHistoryBox(0);
                return;
            }
            if (val === "@rebirth") {
                import('./deferred-features.js').then(m => m.rebirth({ iframes }));
                this.value = "";
                initHistoryBox(0);
                return;
            }
            const select = $("#searchResults");
            select.focus();
            select.selectedIndex = -1;
            recordSearchHistory(val);
        }
    });

    function refreshHistoryList() {
        const elSearchHistory = $("#searchHistory");
        const elSearchInput = $("#searchInput");
        const val = elSearchInput.value.trim();
        elSearchHistory.innerHTML = "";
        const history = store.searchHistory || [];

        if (val === "") {
            showSearchHistoryByTime();
        } else {
            const matchingHistory = history.filter(item =>
                item.keyword.startsWith(val) || item.keyword.includes(val)
            );
            if (matchingHistory.length === 0) {
                showSearchHistoryByTime();
            } else {
                matchingHistory.forEach(item => {
                    elSearchHistory.appendChild(makeHistoryOption(item.keyword, true));
                });
                if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
            }
        }
    }

    elSearchHistory.addEventListener("contextmenu", async function (e) {
        const optEl = e.target.closest && e.target.closest('.sh-opt');
        if (optEl || e.target.tagName === 'OPTION') {
            e.preventDefault();
            e.stopPropagation();
            const keywordToDelete = (optEl || e.target).text;

            let history = [...(store.searchHistory || [])];
            const newHistory = history.filter(item => item.keyword !== keywordToDelete);
            if (newHistory.length !== history.length) {
                store.searchHistory = newHistory;
            }

            await store.SearchCache.remove(keywordToDelete, { allVariants: true });

            const currentVal = $("#searchInput").value.trim();
            if (currentVal !== "") {
                await updateAutocompleteSuggestions(currentVal);
            } else {
                refreshHistoryList();
            }
        }
    });
    elSearchHistory.title = "右击删除";

    clickOrChange(elSearchHistory, function (index) {
        elSearchInput.value = elSearchHistory.options[index].text;
        if (!document.body.classList.contains('touchpad-active')) {
            elSearchInput.focus();
        }
        const e = elSearchInput.value;
        search(e);
        store.keyword = e;
    });
    clickOrChange(elSearchResults, function (index) {
        loadContent(index);
        initHistoryBox(0);
        recordSearchHistory(elSearchInput.value);
    });

    $("#clear").addEventListener("click", function () {
        elSearchInput.value = "";
        invalidateSearch();
        updateSearchResults([]);
        initHistoryBox(0);
        store.keyword = "";
        store.jump_from_search = "0";
        store.jump_from_search_ex = "0";
        emitEvent('DESTROY_HIGHLIGHT', null, 'content');
    });

    const layoutObserver = new ResizeObserver(() => {
        if (!$("#content") || !$("#search") || !$("#searchResults")) return;
        const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
        $("#searchResults").style.maxWidth = maxW + "px";
        $("#searchResults").style.left = (0 - $("#searchResults").offsetWidth) + "px";
        sfLayout();
    });
    if ($("#content")) {
        layoutObserver.observe($("#content"));
    }

    updateSearchResults([]);
    $("#search").style.right = ($("#side").offsetWidth + 4) + "px";

    let previewBox = document.getElementById('center-snippet-preview');
    if (!previewBox) {
        previewBox = document.createElement('div');
        previewBox.id = 'center-snippet-preview';

        let header = document.createElement('div');
        header.id = 'preview-header';

        let scrollWrapper = document.createElement('div');
        scrollWrapper.id = 'preview-scroll-wrapper';

        let scrollContent = document.createElement('div');
        scrollContent.id = 'preview-scroll-content';

        scrollWrapper.appendChild(scrollContent);
        previewBox.appendChild(header);
        previewBox.appendChild(scrollWrapper);
        document.getElementById('stage').appendChild(previewBox);
    }

    let previewScrollFrame = null;
    let previewTimeoutId = null;
    let previewScrollGen = 0;
    let currentScrollY = 0;
    let lastHoveredPath = null;
    let hoverSnippetTimer = null;
    let isPaused = true;

    function formatCountdown(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '';
        const total = Math.max(0, Math.ceil(sec));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function attachPreviewCountdown(mediaEl) {
        const old = document.getElementById('preview-countdown');
        if (old) old.remove();
        if (!previewBox || !mediaEl) return;

        const badge = document.createElement('div');
        badge.id = 'preview-countdown';
        badge.style.cssText = 'position:absolute;right:8px;bottom:6px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,0.65);color:#abb2bf;font-size:11px;font-family:monospace;line-height:1.4;pointer-events:none;z-index:10;display:none;';
        previewBox.appendChild(badge);

        const update = () => {
            const dur = mediaEl.duration;
            if (!Number.isFinite(dur) || dur <= 0) {
                badge.style.display = 'none';
                return;
            }
            badge.textContent = formatCountdown(dur - (mediaEl.currentTime || 0));
            badge.style.display = 'block';
        };

        mediaEl.addEventListener('loadedmetadata', update);
        mediaEl.addEventListener('durationchange', update);
        mediaEl.addEventListener('timeupdate', update);
        mediaEl.addEventListener('seeked', update);
        update();
    }

    function stopPreviewScroll() {
        previewScrollGen++;
        if (previewTimeoutId) { clearTimeout(previewTimeoutId); previewTimeoutId = null; }
        if (previewScrollFrame) { cancelAnimationFrame(previewScrollFrame); previewScrollFrame = null; }
    }

    function resetPreviewScroll(scrollContent) {
        stopPreviewScroll();
        currentScrollY = 0;
        if (scrollContent) scrollContent.style.transform = 'translateY(0px)';
    }

    function destroyMediaPreview() {
        const badge = document.getElementById('preview-countdown');
        if (badge) badge.remove();
        if (previewBox) {
            previewBox.removeAttribute('data-active');
            previewBox.style.display = 'none';
        }
        lastHoveredPath = null;
        clearTimeout(hoverSnippetTimer);
        resetSearchHighlights();
        publishSearchHighlights();
        isPaused = true;
        const scrollContent = document.getElementById('preview-scroll-content');
        resetPreviewScroll(scrollContent);
        if (scrollContent) {
            saveMediaPositionsIn(scrollContent);
            scrollContent.innerHTML = '';
        }
    }

    window.addEventListener('blur', () => {
        destroyMediaPreview();
        initHistoryBox(0);
    });
    document.addEventListener('mousedown', (e) => {
        const searchWrap = document.getElementById('search');
        if (searchWrap && !searchWrap.contains(e.target)) {
            initHistoryBox(0);
        }
    });

    const handleMiddleClick = (e) => {
        if (e.button === 1) {
            e.preventDefault();
            const clearBtn = document.getElementById('clear');
            if (clearBtn) clearBtn.click();
            destroyMediaPreview();
        }
    };

    elSearchResults.addEventListener('mousedown', handleMiddleClick);

    const elSearchHistoryNode = document.getElementById('searchHistory');
    if (elSearchHistoryNode) elSearchHistoryNode.addEventListener('mousedown', handleMiddleClick);

    const elSearchInputNode = document.getElementById('searchInput');
    if (elSearchInputNode) elSearchInputNode.addEventListener('mousedown', handleMiddleClick);

    function showSnippetPreview(resultData, data) {
        stopPreviewScroll();
        const body = (data && data.body) || { hits: 0, more: 0, items: [] };
        const cm = (data && data.comments) || { hits: 0, docs: 0, more: 0, items: [] };
        if (body.items.length === 0 && cm.items.length === 0) {
            previewBox.removeAttribute('data-active');
            previewBox.style.display = 'none';
            return;
        }

        const header = document.getElementById('preview-header');
        const scrollWrapper = document.getElementById('preview-scroll-wrapper');
        const scrollContent = document.getElementById('preview-scroll-content');
        previewBox.style.display = 'flex';
        requestAnimationFrame(() => {
            previewBox.setAttribute('data-active', 'true');
        });
        header.style.color = '#abb2bf';

        const titleSpan = document.createElement('span');
        titleSpan.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%;';
        titleSpan.textContent = resultData.title;
        const countSpan = document.createElement('span');
        countSpan.style.cssText = 'color: #61afef; font-size: 11px; white-space: nowrap;';
        countSpan.textContent = [
            body.hits > 0 ? `正文: ${body.hits}` : '',
            cm.docs > 0 ? `评论: ${cm.docs}` : ''
        ].filter(Boolean).join('  ');
        const bar = document.createElement('div');
        bar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';
        bar.append(titleSpan, countSpan);
        header.replaceChildren(bar);

        const useHL = searchHighlightSupported();
        resetSearchHighlights();

        const buildBlock = () => {
            const block = document.createElement('div');
            block.className = 'loop-block';

            const addSection = (label, items, more, isComment) => {
                if (items.length === 0) return;
                const title = document.createElement('div');
                title.style.cssText = 'color: #e5c07b; font-size: 11px; font-weight: bold; margin: 0 0 6px;';
                title.textContent = label + (more > 0 ? ` (+${more})` : '');
                block.appendChild(title);

                items.forEach((item, k) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'margin-bottom: 12px; border-bottom: 1px dashed #4b5263; padding-bottom: 8px;';
                    const tag = document.createElement('span');
                    tag.style.cssText = 'color: #61afef; font-size: 11px;';
                    tag.textContent = isComment ? `[#${item.c + 1}]` : `[${k + 1}]`;
                    const text = document.createTextNode(' ' + item.t); 
                    row.append(tag, text);
                    block.appendChild(row);

                    if (!useHL) return;
                    for (const [s, e, n] of item.h) {
                        const r = new Range();
                        r.setStart(text, s + 1);
                        r.setEnd(text, e + 1);
                        getSearchHighlight(n).add(r);
                    }
                });
            };
            addSection(`正文: ${body.hits}`, body.items, body.more, false);
            addSection(`评论: ${cm.docs}`, cm.items, cm.more, true);
            return block;
        };

        const first = buildBlock();
        scrollContent.replaceChildren(first);
        publishSearchHighlights();
        currentScrollY = 0;
        scrollContent.style.transform = `translateY(0px)`;

        const gen = ++previewScrollGen;
        previewTimeoutId = setTimeout(() => {
            previewTimeoutId = null;
            if (gen !== previewScrollGen) return;
            const blockHeight = first.offsetHeight;
            const visibleHeight = scrollWrapper.offsetHeight;
            if (blockHeight <= visibleHeight) return;

            scrollContent.appendChild(buildBlock());
            const SCROLL_PX_PER_SEC = 60;
            let lastTs = 0;
            const autoScroll = (ts) => {
                if (gen !== previewScrollGen) return;
                const dt = lastTs ? Math.min(ts - lastTs, 100) : 0;
                lastTs = ts;
                if (!isPaused && dt > 0) {
                    currentScrollY = (currentScrollY + SCROLL_PX_PER_SEC * dt / 1000) % blockHeight;
                    scrollContent.style.transform = `translateY(-${currentScrollY}px)`;
                }
                previewScrollFrame = requestAnimationFrame(autoScroll);
            };
            previewScrollFrame = requestAnimationFrame(autoScroll);
        }, 10);
    }

    elSearchResults.addEventListener('mousemove', (e) => {
        const optEl = e.target.closest && e.target.closest('.sr-opt');
        if (optEl) {
            const path = optEl.dataset.path;
            const type = optEl.dataset.type;
            const isLocalOnly = optEl.dataset.localOnly === "true";

            if (optEl.dataset.localOnly === "true" && store.online_flag === "1") {
                optEl.title = "";
                if (lastHoveredPath !== path) {
                    destroyMediaPreview();
                    lastHoveredPath = path;
                }
                return;
            }

            const isMedia = type === 'video' || type === 'audio' || /\.(mp4|webm|ogg|mp3|wav|flac|m4a)$/i.test(path);
            const isImage = type === 'image' || /\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/i.test(path);

            if (type === 'html') {
                optEl.title = "右击滚动/停止";
            } else if (isMedia) {
                optEl.title = "右击播放/停止";
            } else {
                optEl.title = "";
            }

            if (path === lastHoveredPath) return;

            clearTimeout(hoverSnippetTimer);
            if (isMedia || previewBox.querySelector('video, audio')) destroyMediaPreview();
            lastHoveredPath = path;

            if (isMedia) return;

            isPaused = true;
            previewBox.style.borderColor = '#61afef';

            const header = document.getElementById('preview-header');
            const scrollWrapper = document.getElementById('preview-scroll-wrapper');
            const scrollContent = document.getElementById('preview-scroll-content');

            previewBox.classList.toggle('image-preview-mode', isImage);

            if (isImage) {
                resetPreviewScroll(scrollContent);
                previewBox.style.display = 'flex';
                requestAnimationFrame(() => previewBox.setAttribute('data-active', 'true'));
                const imgEl = document.createElement('img');
                imgEl.src = path;
                imgEl.style.cssText = 'max-width: 450px; max-height: 350px; object-fit: contain;';
                imgEl.alt = 'Preview';
                scrollContent.replaceChildren(imgEl);
                return;
            }

            const resultData = window._currentResultMap && window._currentResultMap.get(path);
            const keyword = window._currentRenderedKeyword || elSearchInput.value.trim();
            if (!resultData || !keyword) return;

            hoverSnippetTimer = setTimeout(async () => {
                if (lastHoveredPath !== path) return;
                const data = await requestSnippets(path, keyword);
                if (lastHoveredPath !== path || !data) return;
                showSnippetPreview(resultData, data);
            }, 60);
        }
    });

    elSearchResults.addEventListener('contextmenu', (e) => {
        const optEl = e.target.closest && e.target.closest('.sr-opt');
        if (optEl) {
            e.preventDefault();
            const path = optEl.dataset.path;
            const type = optEl.dataset.type;

            if (optEl.dataset.localOnly === "true" && store.online_flag === "1") {
                return;
            }

            const isMedia = type === 'video' || type === 'audio' || /\.(mp4|webm|ogg|mp3|wav|flac|m4a)$/i.test(path);

            if (isMedia) {
                const scrollContent = document.getElementById('preview-scroll-content');
                let mediaEl = scrollContent.querySelector('video, audio');

                if (mediaEl && mediaEl.dataset.path === path) {
                    if (mediaEl.paused) {
                        const playPromise = mediaEl.play();
                        if (playPromise !== undefined) {
                            playPromise.catch(err => {
                                if (err.name !== 'AbortError') {
                                    console.warn("Auto-play prevented", err);
                                }
                            });
                        }
                        scrollContent.querySelectorAll('.wave-bar').forEach(b => b.classList.remove('paused'));
                    } else {
                        mediaEl.pause();
                        scrollContent.querySelectorAll('.wave-bar').forEach(b => b.classList.add('paused'));
                    }
                } else {
                    saveMediaPositionsIn(scrollContent);
                    resetPreviewScroll(scrollContent);
                    previewBox.style.display = 'flex';
                    previewBox.classList.add('image-preview-mode');
                    requestAnimationFrame(() => previewBox.setAttribute('data-active', 'true'));

                    const isVideo = type === 'video' || /\.(mp4|webm|ogg)$/i.test(path);
                    if (isVideo) {
                        const vidEl = document.createElement('video');
                        vidEl.src = path;
                        vidEl.dataset.path = path;
                        vidEl.loop = true;
                        vidEl.style.cssText = 'max-width: 450px; max-height: 350px; width: 100%; outline: none; object-fit: contain;';
                        scrollContent.replaceChildren(vidEl);
                    } else {
                        if (!document.getElementById('wave-bars-style')) {
                            const st = document.createElement('style');
                            st.id = 'wave-bars-style';
                            st.textContent = '.wave-bars { display: flex; align-items: flex-end; gap: 4px; height: 40px; justify-content: center; } .wave-bar { width: 5px; background: #61afef; border-radius: 2px; animation: waveAnim 0.8s ease-in-out infinite alternate; } .wave-bar.paused { animation-play-state: paused !important; } @keyframes waveAnim { 0% { height: 10px; } 100% { height: 100%; } } .wb-1 { animation-delay: 0s; } .wb-2 { animation-delay: 0.2s; } .wb-3 { animation-delay: 0.4s; } .wb-4 { animation-delay: 0.6s; } .wb-5 { animation-delay: 0.8s; }';
                            document.head.appendChild(st);
                        }
                        const filename = path.split('/').pop();
                        const wrapEl = document.createElement('div');
                        wrapEl.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%;';
                        const titleEl = document.createElement('div');
                        titleEl.style.cssText = 'margin-bottom:20px; color:#abb2bf; font-size:14px; text-align:center; word-break:break-all; padding: 0 15px;';
                        titleEl.textContent = filename;
                        const barsEl = document.createElement('div');
                        barsEl.className = 'wave-bars';
                        for (let bi = 1; bi <= 5; bi++) {
                            const bItem = document.createElement('div');
                            bItem.className = `wave-bar wb-${bi}`;
                            barsEl.appendChild(bItem);
                        }
                        wrapEl.append(titleEl, barsEl);
                        const audEl = document.createElement('audio');
                        audEl.src = path;
                        audEl.dataset.path = path;
                        audEl.loop = true;
                        audEl.style.display = 'none';
                        scrollContent.replaceChildren(wrapEl, audEl);
                    }

                    mediaEl = scrollContent.querySelector('video, audio');
                    mediaEl.volume = 0.1;
                    attachPreviewCountdown(mediaEl);
                    resumeMediaPosition(mediaEl, path);
                    const playPromise = mediaEl.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(err => {
                            if (err.name !== 'AbortError') {
                                console.warn("Auto-play prevented", err);
                            }
                        });
                    }
                }
                return;
            }

            if (type === 'html' && previewBox.style.display === 'flex' && !previewBox.classList.contains('image-preview-mode')) {
                isPaused = !isPaused;
                previewBox.style.borderColor = !isPaused ? '#e5c07b' : '#61afef';
                const header = document.getElementById('preview-header');
                if (header) header.style.color = !isPaused ? '#e5c07b' : '#abb2bf';
            }
        }
    });

    elSearchResults.addEventListener('mouseleave', () => {
        destroyMediaPreview();
    });

    elSearchResults.addEventListener('click', () => {
        destroyMediaPreview();
    });
}

function processAndShowResults(results, keyword, options = {}) {
    const provisional = !!options.provisional;
    const fromCache = !!options.fromCache;
    const base = results || [];
    let finalResults = base.slice();

    let activeKw = keyword || store.keyword || "";
    if (!activeKw) {
        const inputEl = document.getElementById("searchInput");
        activeKw = inputEl ? inputEl.value.trim() : "";
    }

    let history = store.last_li_a;
    if (!Array.isArray(history)) history = history ? [history] : [];

    let currentIndex = -1;

    if (store.resource_type === "html" && history.length > 0) {
        const currentPath = history[0];
        const strippedPath = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;

        currentIndex = finalResults.findIndex(r => r.path === currentPath || r.path === strippedPath);
    }

    if (activeKw !== "" && !isActionCommand(activeKw)) {
        if (!isAdsQuery(activeKw) && !provisional && !fromCache && !options.noCache) {
            store.SearchCache.set(activeKw, base, options.termSpecs || null);
        }
        if (currentIndex === -1) emitEvent('LOCAL_SEARCH_COUNT', activeKw, 'content');
    }

    if (currentIndex !== -1) {
        const currentItem = finalResults.splice(currentIndex, 1)[0];
        finalResults.unshift(currentItem);
        updateSearchResults(finalResults, activeKw);
        return;
    }

    updateSearchResults(finalResults, activeKw);
}

async function search(rawKeyword) {
    if (typeof rawKeyword !== "string" || !rawKeyword.trim() || isActionCommand(rawKeyword)) {
        invalidateSearch();
        updateSearchResults([]);
        return;
    }
    const kw = rawKeyword.trim();

    if (isAdsQuery(kw)) {
        searchAds(kw);
        return;
    }

    const currentToken = ++window._searchToken;
    const meta = await store.SearchCache.getMeta(kw);

    if (currentToken !== window._searchToken) return;

    const useSyn = (store.synonyms_enabled ?? 1) === 1;
    if (meta && meta.exact) {
        if (Array.isArray(meta.termSpecs) && meta.termSpecs.length > 0) {
            cacheTermSpecs(kw, useSyn, meta.termSpecs);
        }
        cancelWorkerSearch(currentToken);
        requestCommentHits(kw, currentToken);
        processAndShowResults(meta.results, kw, { fromCache: true });
        if (useSyn && !hasTermSpecs(kw, true)) {
            ensureTermSpecs([{ text: kw, like: true }]).then(() => {
                if (normalizeKeyword(window._currentRenderedKeyword) === normalizeKeyword(kw)) {
                    rerenderSearchOverlay();
                }
            });
        }
        return;
    }
    if (meta) {
        processAndShowResults(meta.results, kw, { provisional: true, fromCache: true });
    }

    try {
        if (!searchWorker) {
            console.warn("搜索引擎尚未就绪");
            return;
        }

        if (useSyn && !window._synonymsReady) window._searchSentWithoutSyn = true;

        searchWorker.postMessage({
            type: 'SEARCH',
            payload: {
                keyword: kw,
                noise: Number(store.noise_level ?? 5),
                synonymsEnabled: useSyn,
                token: currentToken,
                ns: computeQueryContextSig()
            }
        });

    } catch (err) {
        console.error("web worker 通信失败", err);
    }
}

function cancelWorkerSearch(token) {
    if (searchWorker) searchWorker.postMessage({ type: 'CANCEL', payload: { token } });
}

function invalidateSearch() {
    cancelWorkerSearch(++window._searchToken);
}

function clearSearchOverlays() {
    commentHitCache.clear();
    pageHitCache.clear();
    snippetCache.clear();
}

const SEARCH_ALGO_VER = 9;

function hashText(str) {
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619);
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 15);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function computeCoreNamespace() {
    return [
        'v' + SEARCH_ALGO_VER,
        'd:' + (window._dataFp || 'pending')
    ].join('|');
}

function computeQueryContextSig() {
    return [
        computeCoreNamespace(),
        'l:' + Number(store.synonyms_enabled ?? 1),
        'n:' + Number(store.noise_level ?? 5)
    ].join('|');
}

async function bindCoreNamespace({ force = false } = {}) {
    if (!window._dataFp && !force) return false;
    try {
        return await store.SearchCache.bindNamespace('core', computeCoreNamespace());
    } catch (e) { return false; }
}

async function bindSynonymsNamespace() {
    if (!window._synonymsReady || !window.synonymIndex) return false;
    try {
        const idx = window.synonymIndex;
        const sigPart = idx.sig
            ? String(idx.sig)
            : (Array.isArray(idx.groups) && idx.groups.length > 0 ? JSON.stringify(idx.groups) : String(idx.version || '0'));
        const fp = 'syn:' + hashText(String(idx.version || '') + '|' + sigPart);
        return await store.SearchCache.bindNamespace('syn', fp);
    } catch (e) { return false; }
}

function rerunActiveSearch() {
    const el = document.getElementById("searchInput");
    const kw = el ? el.value.trim() : "";
    if (kw && (isAdsQuery(kw) || !isReservedSearchCommand(kw))) search(kw);
}

async function onSynonymsLoaded() {
    const changed = await bindSynonymsNamespace();
    const missed = !!window._searchSentWithoutSyn;
    window._searchSentWithoutSyn = false;
    termSpecsCache.clear();
    clearSearchOverlays();
    if (changed || missed) {
        invalidateSearch();
        rerunActiveSearch();
    }
    const activeKw = ($("#searchInput")?.value || store.keyword || '').trim();
    if (activeKw && store.resource_type === 'html' && (store.synonyms_enabled ?? 1) === 1) {
        emitEvent('REFRESH_HIGHLIGHT', { keyword: activeKw }, 'content');
    }
}

let _privateSrc = null;
let _privateSet = null;
function isPrivatePath(p) {
    const data = window.data;
    if (!Array.isArray(data)) return false;
    if (_privateSrc !== data) {
        _privateSet = new Set();
        for (let i = 2; i < data.length; i += 4) {
            const info = data[i - 1];
            if (typeof info === 'string' && info.startsWith('localOnly')) _privateSet.add(data[i]);
        }
        _privateSrc = data;
    }
    return _privateSet.has(p);
}

function pageOverlayKey(kw) {
    return isAdsQuery(kw) ? String(kw).trim() : normalizeKeyword(kw);
}

function setPageHit(kw, entry) {
    const key = pageOverlayKey(kw);
    if (!key) return false;
    let m = pageHitCache.get(key);
    pageHitCache.delete(key);
    if (!m) m = new Map();
    const prev = m.get(entry.path);
    m.delete(entry.path);
    m.set(entry.path, entry);
    pageHitCache.set(key, m);
    if (pageHitCache.size > 100) pageHitCache.delete(pageHitCache.keys().next().value);
    return !prev
        || prev.count !== entry.count
        || !!prev.matched !== !!entry.matched
        || !!prev.viaComment !== !!entry.viaComment;
}

function evaluateAdsOverlayForPath(kw, path, adsBodyHits) {
    if (!Array.isArray(adsBodyHits)) return null;
    const plan = parseAdsQuery(kw);
    if (!plan.ok || plan.terms.length !== adsBodyHits.length) return null;

    let cmtTexts = null;
    if (commentModel.ready && Array.isArray(commentModel.index)) {
        const doc = commentModel.index.find(d => d && d.path === path);
        if (doc && Array.isArray(doc.texts)) cmtTexts = doc.texts;
    }

    const cmtHits = plan.terms.map((t, idx) => {
        if (adsBodyHits[idx] || !cmtTexts || cmtTexts.length === 0) return false;
        const specs = buildTermSpecs(t.text, !!t.like);
        const out = [];
        for (const text of cmtTexts) {
            if (!text) continue;
            srCollectMatches(Array.from(text), specs, t.noise, out);
            if (out.length > 0) return true;
        }
        return false;
    });

    const evalNode = (n, useComments) => {
        if (n.op === 'term') {
            const hit = !!adsBodyHits[n.term] || (useComments && !!cmtHits[n.term]);
            return n.neg ? !hit : hit;
        }
        if (n.op === 'and') return n.args.every(a => evalNode(a, useComments));
        if (n.op === 'or') return n.args.some(a => evalNode(a, useComments));
        return false;
    };

    const matched = evalNode(plan.expr, true);
    const matchedBodyOnly = evalNode(plan.expr, false);
    return {
        matched,
        viaComment: matched && !matchedBodyOnly
    };
}

function applyPageOverlay(results, keyword) {
    if (!keyword || isActionCommand(keyword)) return results;
    const entries = pageHitCache.get(pageOverlayKey(keyword));
    if (!entries || entries.size === 0) return results;

    const strip = (p) => (p.startsWith('../') ? p.substring(3) : p);
    const indexByPath = new Map();
    results.forEach((r, i) => indexByPath.set(strip(r.path), i));

    const adsMode = isAdsQuery(keyword);
    const out = results.slice();
    const removed = new Set();
    const added = [];
    let latest = null;
    for (const e of entries.values()) {
        latest = e;
        const i = indexByPath.get(e.path);
        if (adsMode) {
            if (i !== undefined) {
                if (e.matched) {
                    out[i] = Object.assign({}, out[i], { viaComment: !!e.viaComment });
                } else {
                    removed.add(i);
                }
            } else if (e.matched) {
                added.push({
                    title: e.title,
                    path: e.path,
                    type: 'html',
                    count: e.count,
                    localOnly: isPrivatePath(e.path),
                    viaComment: !!e.viaComment
                });
            }
            continue;
        }
        if (i !== undefined) {
            const mergedCount = e.count > 0 ? e.count : (out[i].count || 0);
            out[i] = Object.assign({}, out[i], { count: mergedCount });
        } else if (e.count > 0) {
            added.push({ title: e.title, path: e.path, type: 'html', count: e.count, localOnly: isPrivatePath(e.path) });
        }
    }
    const li = latest ? indexByPath.get(latest.path) : undefined;
    if (li !== undefined && !removed.has(li) && li !== 0) {
        const latestItem = out[li];
        const filtered = out.filter((_, idx) => idx !== li && !removed.has(idx));
        filtered.unshift(latestItem);
        return added.length ? added.reverse().concat(filtered) : filtered;
    }
    const filtered = removed.size > 0 ? out.filter((_, idx) => !removed.has(idx)) : out;
    return added.length ? added.reverse().concat(filtered) : filtered;
}

function buildAdsPositiveTerms(kw) {
    const plan = parseAdsQuery(kw);
    if (!plan.ok) return null;
    const posIdx = new Set();
    const collect = (n) => {
        if (!n) return;
        if (n.op === 'term') { if (!n.neg) posIdx.add(n.term); }
        else if (Array.isArray(n.args)) n.args.forEach(collect);
    };
    collect(plan.expr);
    const terms = [];
    for (const idx of [...posIdx].sort((a, b) => a - b)) {
        const t = plan.terms[idx];
        if (!t) continue;
        const keywords = buildTermSpecs(t.text, !!t.like);
        if (keywords.length > 0) {
            terms.push({ text: t.text, like: !!t.like, noise: t.noise, keywords });
        }
    }
    return terms;
}
window.buildAdsPositiveTerms = buildAdsPositiveTerms;

function requestSnippets(path, keyword) {
    const worker = searchWorker;
    if (!worker) return Promise.resolve(null);
    const noise = Number(store.noise_level ?? 5);
    const useSyn = (store.synonyms_enabled ?? 1) === 1;
    const ads = isAdsQuery(keyword);
    const key = [ads ? keyword.trim() : normalizeKeyword(keyword), noise, useSyn ? 1 : 0, commentModel.ver, path].join('|');

    const hit = snippetCache.get(key);
    if (hit) {
        snippetCache.delete(key);
        snippetCache.set(key, hit);
        return Promise.resolve(hit);
    }

    let adsTerms = null;
    if (ads) {
        adsTerms = buildAdsPositiveTerms(keyword);
        if (!adsTerms || adsTerms.length === 0) return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const reqId = ++_snipReqId;
        pendingSnippets.set(reqId, (data) => {
            if (data) {
                snippetCache.set(key, data);
                if (snippetCache.size > 40) snippetCache.delete(snippetCache.keys().next().value);
            }
            resolve(data);
        });
        worker.postMessage({
            type: 'SNIPPETS',
            payload: ads
                ? {
                    reqId, path, keyword,
                    adsTerms: adsTerms.map(x => ({ text: x.text, like: !!x.like, noise: x.noise })),
                    maxBody: 40, maxComments: 30
                }
                : {
                    reqId, path, keyword, noise,
                    synonymsEnabled: useSyn,
                    maxBody: 40, maxComments: 30
                }
        });
    });
}

const SYN_HL_BIT = 0x100;
const SEARCH_HL_STYLE = [[0.80, '#000'], [0.65, '#111'], [0.52, '#111'], [0.42, '#333'], [0.34, '#333'], [0.28, '#333']];
const SEARCH_SYN_HL_STYLE = [[0.55, '#000'], [0.45, '#111'], [0.38, '#111'], [0.32, '#333'], [0.26, '#333'], [0.22, '#333']];
const SEARCH_SYN2_HL_STYLE = [[0.38, '#000'], [0.32, '#111'], [0.27, '#111'], [0.23, '#333'], [0.19, '#333'], [0.16, '#333']];
const searchHlTier = (noise) => Math.min(((noise | 0) >> 8) & 3, 2);
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

function searchHighlightSupported() {
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
    if (!(window.CSS && CSS.highlights)) return;
    searchHl.forEach((h, slot) => {
        if (h && h.size > 0) CSS.highlights.set(searchHlNameBySlot(slot), h);
        else CSS.highlights.delete(searchHlNameBySlot(slot));
    });
}

function toHalfwidth(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        out += code === 12288 ? ' ' : (code >= 65281 && code <= 65374 ? String.fromCharCode(code - 65248) : str[i]);
    }
    return out;
}

function termSpecsKey(kw, useSyn) {
    return normalizeKeyword(kw) + '|' + (useSyn ? 1 : 0);
}

function cacheTermSpecs(kw, useSyn, specs) {
    const key = termSpecsKey(kw, useSyn);
    if (!key || !Array.isArray(specs) || specs.length === 0) return;
    termSpecsCache.delete(key);
    termSpecsCache.set(key, specs.slice());
    if (termSpecsCache.size > 256) termSpecsCache.delete(termSpecsCache.keys().next().value);
}

function hasTermSpecs(kw, useSyn) {
    return !useSyn || !window._synonymsReady || termSpecsCache.has(termSpecsKey(kw, true));
}

function ensureTermSpecs(items) {
    if (!Array.isArray(items) || items.length === 0 || !window._synonymsReady) return Promise.resolve();
    const worker = searchWorker || _pendingWorker;
    if (!worker) return Promise.resolve();
    const missing = items.filter(it => it && it.text && it.like && !termSpecsCache.has(termSpecsKey(it.text, true)));
    if (missing.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
        const reqId = ++_expandReqId;
        const timer = setTimeout(() => {
            pendingExpands.delete(reqId);
            resolve();
        }, 1500);
        pendingExpands.set(reqId, () => {
            clearTimeout(timer);
            resolve();
        });
        worker.postMessage({
            type: 'EXPAND_QUERY',
            payload: { reqId, items: missing.map(it => ({ text: it.text, like: true })) }
        });
    });
}

function buildTermSpecs(kw, useSyn) {
    const half = toHalfwidth(String(kw || ''));
    const compact = half.replace(/\s+/g, '');
    if (!compact) return [];
    if (useSyn) {
        const cached = termSpecsCache.get(termSpecsKey(half, true));
        if (Array.isArray(cached) && cached.length > 0) return cached.slice();
    }
    return [{ text: compact, weight: 100, tier: 0 }];
}
window.buildTermSpecs = buildTermSpecs;
window.hasTermSpecs = hasTermSpecs;
window.ensureTermSpecs = ensureTermSpecs;

function getSearchKeywords(kw) {
    return buildTermSpecs(kw, (store.synonyms_enabled ?? 1) === 1);
}

function showSearchHistoryByTime() {
    const elSearchHistory = $("#searchHistory");
    if (!elSearchHistory) return;
    elSearchHistory.innerHTML = "";
    const history = [...(store.searchHistory || [])];
    if (history.length === 0) {
        elSearchHistory.style.display = "none";
        return;
    }
    elSearchHistory.style.display = "block";
    history.sort((a, b) => b.timestamp - a.timestamp);
    history.forEach(item => {
        elSearchHistory.appendChild(makeHistoryOption(item.keyword, true));
    });
    if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
}

async function updateAutocompleteSuggestions(val) {
    const seq = ++_autocompleteSeq;
    const elSearchHistory = $("#searchHistory");
    elSearchHistory.innerHTML = "";

    if (!val || val.trim() === "") {
        showSearchHistoryByTime();
        return;
    }

    const query = val.trim().toLowerCase();
    const suggestionMap = new Map();

    const history = store.searchHistory || [];
    history.forEach(item => {
        if (item.keyword.toLowerCase().includes(query)) {
            suggestionMap.set(item.keyword, { isHistory: true, ts: item.timestamp || 0 });
        }
    });

    try {
        const cacheKeys = await searchCacheLRU.keys();
        if (seq !== _autocompleteSeq) return;
        cacheKeys.forEach(key => {
            if (typeof key !== 'string') return;
            const kw = searchResultCache.stripKeyPrefix(key);
            if (kw && kw.toLowerCase().includes(query) && !suggestionMap.has(kw)) {
                suggestionMap.set(kw, { isHistory: false, ts: 0 });
            }
        });
    } catch (e) {
        console.warn("读取缓存 Key 失败", e);
    }

    const rawList = Array.from(suggestionMap.entries()).map(([keyword, meta]) => ({
        keyword,
        lower: keyword.toLowerCase(),
        isHistory: meta.isHistory,
        ts: meta.ts
    }));

    rawList.sort((a, b) => b.keyword.length - a.keyword.length);

    const filteredSuggestions = [];
    for (const item of rawList) {
        if (item.lower === query) {
            filteredSuggestions.push(item);
            continue;
        }
        const isRedundant = filteredSuggestions.some(existing =>
            !item.isHistory && existing.lower.startsWith(item.lower)
        );
        if (!isRedundant) {
            filteredSuggestions.push(item);
        }
    }

    if (filteredSuggestions.length === 0) {
        elSearchHistory.style.display = "none";
        return;
    }

    filteredSuggestions.sort((a, b) => {
        const aEx = a.lower === query ? 1 : 0;
        const bEx = b.lower === query ? 1 : 0;
        if (aEx !== bEx) return bEx - aEx;
        const aPr = a.lower.startsWith(query) ? 1 : 0;
        const bPr = b.lower.startsWith(query) ? 1 : 0;
        if (aPr !== bPr) return bPr - aPr;
        if (a.isHistory !== b.isHistory) return a.isHistory ? -1 : 1;
        if (a.isHistory && a.ts !== b.ts) return b.ts - a.ts;
        return a.keyword.length - b.keyword.length;
    });

    elSearchHistory.style.display = "block";
    filteredSuggestions.forEach(item => {
        elSearchHistory.appendChild(makeHistoryOption(item.keyword, item.isHistory));
    });

    if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
}

function normalizeKeyword(kw) {
    if (!kw || typeof kw !== 'string') return '';
    return toHalfwidth(kw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isActionCommand(kw) {
    return typeof kw === 'string' && /^@(bomb|rebirth)$/.test(kw.trim());
}

function isReservedSearchCommand(kw) {
    return isActionCommand(kw) || isAdsQuery(kw);
}

const ADS_PREFIX_RE = /^[@＠][\[［【]/;

function isAdsQuery(kw) {
    return typeof kw === 'string' && ADS_PREFIX_RE.test(kw.trimStart());
}

const ADS_MAX_DEPTH = 8;
const ADS_USAGE = '@[a&!(b|c)]飞机[31]大炮[]机枪[0]';

class AdsSyntaxError extends Error { }

function adsHoldsOnEmpty(n) {
    if (n.op === 'term') return n.neg;
    return n.op === 'and' ? n.args.every(adsHoldsOnEmpty) : n.args.some(adsHoldsOnEmpty);
}

function parseAdsQuery(raw) {
    const fail = (error) => ({ ok: false, error });
    const src = String(raw).trim()
        .replace(/＠/g, '@').replace(/[【［]/g, '[').replace(/[】］]/g, ']');
    if (!/^@\[/.test(src)) return fail('格式: ' + ADS_USAGE);

    const close = src.indexOf(']', 2);
    if (close < 0) return fail('缺少 ]，如 ' + ADS_USAGE);
    const es = src.slice(2, close)
        .replace(/＆/g, '&').replace(/｜/g, '|').replace(/！/g, '!').replace(/（/g, '(').replace(/）/g, ')')
        .replace(/\s+/g, '').toLowerCase();
    if (!es) return fail('表达式为空');
    const bad = /[^a-z&|!()]/.exec(es);
    if (bad) return fail(`非法字符「${bad[0]}」(仅限 & | ! ( ) a~z)`);

    const rest = src.slice(close + 1);
    const defNoise = Math.min(5, Math.max(0, Number(store.noise_level ?? 5) || 0));
    const defLike = (store.synonyms_enabled ?? 1) === 1 ? 1 : 0;
    const terms = [];
    const re = /([^\[\]]*)\[([^\[\]]*)\]/y;
    let at = 0, m;
    while ((m = re.exec(rest)) !== null) {
        at = re.lastIndex;
        const n = terms.length + 1;
        const text = m[1].trim();
        const digits = m[2].replace(/\s+/g, '');
        if (!text) return fail(`第 ${n} 个 [] 前缺词`);
        if (!/^[0-9]*$/.test(digits)) return fail(`第 ${n} 个 [${m[2]}] 仅限数字`);
        if (digits.length > 2) return fail(`第 ${n} 个 [${digits}] 最多 2 位`);
        if (digits.length >= 1 && Number(digits[0]) > 5) return fail(`第 ${n} 个 [${digits}] 噪值需为 0~5`);
        if (digits.length === 2 && Number(digits[1]) > 1) return fail(`第 ${n} 个 [${digits}] 近义需为 0/1`);
        terms.push({
            text,
            noise: digits.length >= 1 ? Number(digits[0]) : defNoise,
            like: digits.length === 2 ? Number(digits[1]) : defLike
        });
    }
    const tail = rest.slice(at).trim();
    if (tail) return fail(/[\[\]]/.test(tail) ? '方括号未配对' : `「${tail}」后缺 []`);
    if (terms.length === 0) return fail('缺少词与 []，如 ' + ADS_USAGE);
    if (terms.length > 26) return fail('最多 26 个词 (a~z)');

    let pos = 0;
    const used = new Set();
    const parseOr = (depth) => {
        const xs = [parseAnd(depth)];
        while (es[pos] === '|') { pos++; xs.push(parseAnd(depth)); }
        return xs.length === 1 ? xs[0] : { k: 'or', xs };
    };
    const parseAnd = (depth) => {
        const xs = [parseUnary(depth)];
        while (es[pos] === '&') { pos++; xs.push(parseUnary(depth)); }
        return xs.length === 1 ? xs[0] : { k: 'and', xs };
    };
    const parseUnary = (depth) => {
        const c = es[pos];
        if (c === undefined) throw new AdsSyntaxError('表达式不完整');
        if (c === '!') { pos++; return { k: 'not', x: parseUnary(depth) }; }
        if (c === '(') {
            if (depth >= ADS_MAX_DEPTH) throw new AdsSyntaxError('括号嵌套过深');
            pos++;
            const e = parseOr(depth + 1);
            if (es[pos] !== ')') throw new AdsSyntaxError('缺少 )');
            pos++;
            return e;
        }
        if (c >= 'a' && c <= 'z') { pos++; used.add(c); return { k: 'var', ch: c }; }
        throw new AdsSyntaxError(`「${c}」前缺内容`);
    };
    let tree;
    try {
        tree = parseOr(0);
        if (pos < es.length) {
            throw new AdsSyntaxError(es[pos] === ')' ? '多余的 )' : `「${es[pos - 1]}」「${es[pos]}」间缺 & 或 |`);
        }
    } catch (e) {
        if (e instanceof AdsSyntaxError) return fail(e.message);
        throw e;
    }

    for (const ch of [...used].sort()) {
        if (ch.charCodeAt(0) - 97 >= terms.length) return fail(`未知形参 ${ch}(共 ${terms.length} 词)`);
    }
    for (let i = 0; i < terms.length; i++) {
        if (!used.has(String.fromCharCode(97 + i))) {
            return fail(`词「${terms[i].text}」未在表达式中使用`);
        }
    }

    const wire = (n, neg) => {
        if (n.k === 'var') return { op: 'term', term: n.ch.charCodeAt(0) - 97, neg };
        if (n.k === 'not') return wire(n.x, !neg);
        const op = (n.k === 'and') !== neg ? 'and' : 'or';
        return { op, args: n.xs.map(x => wire(x, neg)).flatMap(a => a.op === op ? a.args : [a]) };
    };
    const expr = wire(tree, false);
    if (adsHoldsOnEmpty(expr)) {
        return fail('至少需一个正向词');
    }

    const show = (n, parent) => {
        if (n.k === 'var') { const t = terms[n.ch.charCodeAt(0) - 97]; return `${t.text}[${t.noise}${t.like ? '·近' : ''}]`; }
        if (n.k === 'not') return n.x.k === 'var' ? '非' + show(n.x) : '非(' + show(n.x, null) + ')';
        const s = n.xs.map(x => show(x, n.k)).join(n.k === 'and' ? ' 且 ' : ' 或 ');
        return parent && parent !== n.k ? `(${s})` : s;
    };
    return { ok: true, terms, expr, summary: show(tree, null) };
}
window.parseAdsQuery = parseAdsQuery;

function searchAds(kw) {
    const token = ++window._searchToken;
    const plan = parseAdsQuery(kw);
    if (!plan.ok) {
        cancelWorkerSearch(token);
        window._adsStatus = { error: plan.error };
        updateSearchResults([], kw);
        return;
    }
    if (!searchWorker) {
        console.warn("搜索引擎尚未就绪");
        return;
    }

    let synMissed = false;
    const terms = plan.terms.map(t => {
        if (t.like && !window._synonymsReady) synMissed = true;
        return { text: t.text, noise: t.noise, like: !!t.like };
    });
    if (synMissed) window._searchSentWithoutSyn = true;

    window._adsStatus = { summary: plan.summary };
    sfPaintStatus(kw);
    searchWorker.postMessage({
        type: 'SEARCH_ADS',
        payload: { keyword: kw, token, ns: computeQueryContextSig(), plan: { terms, expr: plan.expr } }
    });
}

const SF_BAR_WIDTH = 270;

function sfState() {
    if (!window._sfState) {
        let saved = null;
        try { saved = store.search_filter; } catch (e) { }
        saved = saved && typeof saved === 'object' ? saved : {};
        window._sfState = {
            off: Array.isArray(saved.off) ? saved.off.filter(k => typeof k === 'string' && k && k !== 'comment' && k !== 'other') : [],
            ymOff: []
        };
    }
    return window._sfState;
}

function sfSave() {
    try { store.search_filter = { off: window._sfState ? window._sfState.off : [] }; } catch (e) { }
}

let _sfStampSrc = null, _sfStampFp = null, _sfStampMap = null;
function sfStampMap() {
    const src = window.lite_data, fp = window._dataFp;
    if (_sfStampMap && _sfStampSrc === src && _sfStampFp === fp) return _sfStampMap;
    const map = new Map();
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        const f = node._f;
        if (Array.isArray(f)) {
            for (const it of f) {
                if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[3] === 'string') {
                    const stamp = it[3].split('-')[0];
                    if (/^\d{14}$/.test(stamp)) map.set('html/' + it[0], stamp);
                }
            }
        }
        for (const k in node) if (k !== '_f') walk(node[k]);
    };
    walk(src && src.html);
    _sfStampSrc = src;
    _sfStampFp = fp;
    _sfStampMap = map;
    return map;
}

function sfYmOf(r) {
    if (r.type !== 'html') return '';
    const p = String(r.path || '').replace(/^\.\.\//, '');
    const stamp = sfStampMap().get(p) || '';
    return stamp.length >= 6 ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}` : '';
}

function sfExtOf(r) {
    if (r.type === 'html') return 'html';
    const m = /\.([A-Za-z0-9]+)$/.exec(r.path || '');
    return m ? m[1].toLowerCase() : '(无)';
}

function sfStats(results) {
    const exts = new Map();
    const yms = new Map();
    for (const r of results) {
        const e = sfExtOf(r);
        exts.set(e, (exts.get(e) || 0) + 1);
        if (r.type === 'html') {
            const ym = sfYmOf(r);
            if (ym) yms.set(ym, (yms.get(ym) || 0) + 1);
        }
    }
    return { exts, yms };
}

function sfActive() {
    const s = sfState();
    return s.off.length > 0 || s.ymOff.length > 0;
}

function sfApply(results) {
    const s = sfState();
    const stats = sfStats(results);
    const off = new Set(s.off);
    const ymOff = new Set(s.ymOff);
    if (off.size === 0 && ymOff.size === 0) return { list: results, total: results.length, stats };

    const list = results.filter(r => {
        if (off.has(sfExtOf(r))) return false;
        if (ymOff.size > 0 && r.type === 'html') {
            const ym = sfYmOf(r);
            if (ym && ymOff.has(ym)) return false;
        }
        return true;
    });
    return { list, total: results.length, stats };
}

function sfSyncEngine() {
    const n = Number(store.noise_level ?? 5);
    const l = Number(store.synonyms_enabled ?? 1);
    const bar = document.getElementById('sf-bar');
    if (!bar) return;
    const noiseEl = bar.querySelector('#sf-noise');
    if (noiseEl) {
        noiseEl.value = String(n);
        const valSpan = noiseEl.querySelector('.sf-noise-val');
        if (valSpan) valSpan.textContent = String(n);
        noiseEl.querySelectorAll('[data-noise]').forEach(it => {
            it.classList.toggle('active', Number(it.dataset.noise) === n);
        });
    }
    bar.querySelector('#sf-like').checked = l === 1;
}

async function sfApplyEngine(key, value) {
    invalidateSearch();
    store[key] = value;
    sfSyncEngine();
    clearSearchOverlays();
    if (searchWorker) searchWorker.postMessage({ type: 'CLEAR_CURSOR', payload: { keyword: '' } });
    invalidateSearch();
    rerunActiveSearch();
    const activeKw = ($("#searchInput")?.value || store.keyword || '').trim();
    if (activeKw && !isActionCommand(activeKw) && store.resource_type === 'html') {
        emitEvent('REFRESH_HIGHLIGHT', { keyword: activeKw }, 'content');
    }
}

function sfInjectStyle() {
    if (document.getElementById('sf-style')) return;
    const st = document.createElement('style');
    st.id = 'sf-style';
    st.textContent = `
#sf-bar{box-sizing:border-box;display:none;flex-wrap:wrap;align-items:center;gap:2px 6px;margin:0 0 2px;padding:2px 5px;font-size:12px;white-space:nowrap;background:#fff;border:1px solid #999}
#sf-bar select,#sf-bar input,#sf-bar button{font-size:12px;user-select:text;-webkit-user-select:text}
#sf-bar details{position:relative}
#sf-bar summary{cursor:pointer}
#sf-bar #sf-noise{position:relative;display:inline-flex;align-items:center;gap:2px;padding:0 4px;border:1px solid #767676;border-radius:2px;background:#fff;cursor:pointer}
#sf-bar #sf-noise .sf-noise-menu{position:absolute;z-index:30;top:100%;left:-1px;margin-top:2px;min-width:100%;background:#fff;border:1px solid #767676;box-shadow:0 2px 6px rgba(0,0,0,0.15);display:none}
#sf-bar #sf-noise.open .sf-noise-menu{display:block}
#sf-bar #sf-noise .sf-noise-opt{padding:1px 6px;text-align:center}
#sf-bar #sf-noise .sf-noise-opt:hover,#sf-bar #sf-noise .sf-noise-opt.active{background:aliceblue;font-weight:bold}
#sf-bar .sf-pop{position:absolute;z-index:20;top:100%;left:0;margin-top:4px;min-width:130px;max-height:320px;overflow:auto;padding:4px 6px;background:#fff;border:1px solid #999;box-shadow:0 2px 6px rgba(0,0,0,0.15)}
#sf-bar .sf-pop-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;color:#555;font-size:11px}
#sf-bar .sf-pop label{display:block}
#sf-bar hr{margin:4px 0}
#sf-count{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:center}
#sf-count.sf-hot{font-weight:bold}
#sf-status{flex-basis:100%;white-space:normal;word-break:break-all;color:#444}
#sf-status:empty{display:none}
`;
    document.head.appendChild(st);
}

function sfReset() {
    Object.assign(sfState(), { off: [], ymOff: [] });
    sfSave();
    rerenderSearchOverlay();
}

function sfInvertExt(bar) {
    const keys = [...bar.querySelectorAll('.sf-list input[data-k]')].map(i => i.dataset.k);
    if (!keys.length) return;
    const s = sfState();
    const off = new Set(s.off);
    for (const k of keys) { if (off.has(k)) off.delete(k); else off.add(k); }
    s.off = [...off];
    sfSave();
    rerenderSearchOverlay();
}

function sfInvertYm(bar) {
    const keys = [...bar.querySelectorAll('.sf-ym-list input[data-ym]')].map(i => i.dataset.ym);
    if (!keys.length) return;
    const s = sfState();
    const ymOff = new Set(s.ymOff);
    for (const k of keys) { if (ymOff.has(k)) ymOff.delete(k); else ymOff.add(k); }
    s.ymOff = [...ymOff];
    sfSave();
    rerenderSearchOverlay();
}

function sfBuildBar() {
    sfInjectStyle();
    const bar = document.createElement('div');
    bar.id = 'sf-bar';
    const noiseOpts = [0, 1, 2, 3, 4, 5].map(n => `<div class="sf-noise-opt" data-noise="${n}">${n}</div>`).join('');
    bar.innerHTML =
        `<span title="字间允许无关字数 (0~5)">噪 <span id="sf-noise" tabindex="0"><span class="sf-noise-val">5</span><span>▾</span><div class="sf-noise-menu">${noiseOpts}</div></span></span>` +
        `<label title="同义词扩展"><input type="checkbox" id="sf-like">近义</label>` +
        `<span id="sf-count" aria-live="polite"></span>` +
        `<details id="sf-sfx"><summary>筛选</summary><div class="sf-pop">` +
        `<div class="sf-pop-hd"><span>类型</span><button type="button" id="sf-inv" title="反选类型">反选</button></div>` +
        `<div class="sf-list"></div>` +
        `<div id="sf-ym-sec" hidden><hr>` +
        `<div class="sf-pop-hd"><span>年月 (.html)</span><button type="button" id="sf-ym-inv" title="反选年月">反选</button></div>` +
        `<div class="sf-ym-list"></div></div>` +
        `</div></details>` +
        `<button type="button" id="sf-reset" title="重置筛选">重置</button>` +
        `<div id="sf-status"></div>`;

    const noiseBox = bar.querySelector('#sf-noise');
    noiseBox.addEventListener('click', (e) => {
        const opt = e.target.closest && e.target.closest('.sf-noise-opt');
        if (opt) {
            e.stopPropagation();
            noiseBox.classList.remove('open');
            sfApplyEngine('noise_level', Number(opt.dataset.noise));
            return;
        }
        noiseBox.classList.toggle('open');
    });

    bar.querySelector('#sf-sfx').addEventListener('toggle', () => sfLayout());
    bar.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
            bar.querySelector('#sf-sfx').open = false;
            noiseBox.classList.remove('open');
        }
    });
    document.addEventListener('click', (e) => {
        const d = bar.querySelector('#sf-sfx');
        if (d.open && !d.contains(e.target)) d.open = false;
        if (noiseBox.classList.contains('open') && !noiseBox.contains(e.target)) noiseBox.classList.remove('open');
    });

    bar.addEventListener('change', (e) => {
        const t = e.target;
        const s = sfState();
        if (t.id === 'sf-like') { sfApplyEngine('synonyms_enabled', t.checked ? 1 : 0); return; }
        if (t.dataset && t.dataset.k !== undefined) {
            s.off = s.off.filter(x => x !== t.dataset.k);
            if (!t.checked) s.off.push(t.dataset.k);
        } else if (t.dataset && t.dataset.ym !== undefined) {
            s.ymOff = s.ymOff.filter(x => x !== t.dataset.ym);
            if (!t.checked) s.ymOff.push(t.dataset.ym);
        } else {
            return;
        }
        sfSave();
        rerenderSearchOverlay();
    });
    bar.addEventListener('click', (e) => {
        if (e.target.id === 'sf-reset') sfReset();
        else if (e.target.id === 'sf-inv') sfInvertExt(bar);
        else if (e.target.id === 'sf-ym-inv') sfInvertYm(bar);
    });
    return bar;
}

function sfSyncPanel(bar, stats) {
    const s = sfState();
    const exts = [...stats.exts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const yms = [...stats.yms].sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0));
    const sig = exts.map(e => e.join(':')).join(',') + '|' + yms.map(y => y.join(':')).join(',');

    const list = bar.querySelector('.sf-list');
    const ymSec = bar.querySelector('#sf-ym-sec');
    const ymList = bar.querySelector('.sf-ym-list');

    if (bar._sfSig !== sig) {
        list.textContent = '';
        if (exts.length === 0) {
            list.textContent = '无条目';
        } else {
            const frag = document.createDocumentFragment();
            exts.forEach(([k, n]) => {
                const lbl = document.createElement('label');
                const inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.dataset.k = k;
                lbl.append(inp, document.createTextNode(` ${k === '(无)' ? '无后缀' : '.' + k} (${n})`));
                frag.appendChild(lbl);
            });
            list.appendChild(frag);
        }
        ymList.textContent = '';
        if (yms.length > 0) {
            ymSec.hidden = false;
            const ymFrag = document.createDocumentFragment();
            yms.forEach(([ym, n]) => {
                const lbl = document.createElement('label');
                const inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.dataset.ym = ym;
                lbl.append(inp, document.createTextNode(` ${ym} (${n})`));
                ymFrag.appendChild(lbl);
            });
            ymList.appendChild(ymFrag);
        } else {
            ymSec.hidden = true;
        }
        bar._sfSig = sig;
    }
    list.querySelectorAll('input[data-k]').forEach(cb => {
        cb.checked = !s.off.includes(cb.dataset.k);
    });
    ymList.querySelectorAll('input[data-ym]').forEach(cb => {
        cb.checked = !s.ymOff.includes(cb.dataset.ym);
    });
}

function sfPaintStatus(keyword) {
    const el = document.getElementById('sf-status');
    if (!el) return;
    if (window._engineError) {
        el.textContent = '⚠️ ' + window._engineError;
        return;
    }
    const info = isAdsQuery(keyword) ? window._adsStatus : null;
    el.textContent = info ? (info.error || info.summary || '') : '';
}

function sfLayout() {
    const bar = document.getElementById('sf-bar');
    const box = document.getElementById('searchResults');
    if (!bar || !box || bar.style.display === 'none') return;

    const cs = getComputedStyle(box);
    const abs = cs.position === 'absolute';
    bar.style.position = abs ? 'absolute' : 'relative';

    const search = document.getElementById('search');
    const content = document.getElementById('content');
    const maxW = (search && content) ? Math.max(0, content.clientWidth - search.offsetWidth - 10) : 0;
    const barW = maxW > 0 ? Math.min(SF_BAR_WIDTH, maxW) : SF_BAR_WIDTH;
    bar.style.maxWidth = '';
    bar.style.width = barW + 'px';
    bar.style.left = (-barW) + 'px';

    const zi = parseInt(cs.zIndex, 10);
    const hist = document.getElementById('searchHistory');
    const histZi = hist ? parseInt(getComputedStyle(hist).zIndex, 10) : NaN;
    const baseZi = Math.max(Number.isFinite(zi) ? zi : 0, Number.isFinite(histZi) ? histZi : 0);
    bar.style.zIndex = String(baseZi + 10);

    const sfx = bar.querySelector('#sf-sfx');
    const pop = bar.querySelector('.sf-pop');
    if (sfx && pop) {
        pop.style.left = '';
        pop.style.right = '';
        pop.style.maxWidth = '';
        const desiredLeft = Math.max(0, bar.offsetWidth - sfx.offsetLeft);
        pop.style.left = desiredLeft + 'px';
        const sfxRect = sfx.getBoundingClientRect();
        const popLeftOnScreen = sfxRect.left + desiredLeft;
        const rightSpace = window.innerWidth - popLeftOnScreen - 8;
        if (rightSpace >= 120) {
            pop.style.maxWidth = rightSpace + 'px';
        } else {
            pop.style.left = 'auto';
            pop.style.right = '0px';
            pop.style.maxWidth = Math.max(120, sfxRect.right - 8) + 'px';
        }
    }

    if (abs) {
        let base = parseFloat(box.dataset.sfBaseTop);
        if (!Number.isFinite(base)) {
            box.style.top = '';
            base = parseFloat(cs.top);
            if (!Number.isFinite(base)) {
                const inp = document.getElementById('searchInput');
                base = inp ? inp.offsetTop + inp.offsetHeight + 2 : 0;
            }
            box.dataset.sfBaseTop = String(base);
        }
        bar.style.top = base + 'px';
        box.style.top = (base + bar.offsetHeight + 2) + 'px';
    } else {
        bar.style.top = '';
    }
}

function sfRestoreResultsTop() {
    const box = document.getElementById('searchResults');
    if (box && box.dataset.sfBaseTop !== undefined) {
        box.style.top = '';
        delete box.dataset.sfBaseTop;
    }
}

function sfRefreshBar(keyword, sf) {
    const kw = (keyword || '').trim();
    let bar = document.getElementById('sf-bar');
    const want = !!kw && (isAdsQuery(kw) || !isReservedSearchCommand(kw));
    if (!want) {
        if (bar) { bar.style.display = 'none'; sfRestoreResultsTop(); }
        return;
    }
    if (!bar) {
        const box = document.getElementById('searchResults');
        if (!box || !box.parentNode) return;
        bar = sfBuildBar();
        box.parentNode.insertBefore(bar, box);
    }
    bar.style.display = 'flex';

    const ads = isAdsQuery(kw);
    sfSyncEngine();
    sfSyncPanel(bar, sf.stats);

    const total = sf.total, shown = sf.list.length;
    const info = ads ? window._adsStatus : null;
    const countEl = bar.querySelector('#sf-count');
    let txt;
    if (info && info.error) txt = '';
    else if (total === 0) txt = '0 条';
    else if (shown < total) txt = `${shown}/${total}`;
    else txt = `${total} 条`;
    countEl.textContent = txt;
    countEl.classList.toggle('sf-hot', total > 0 && shown < total);
    bar.querySelector('#sf-reset').style.visibility = sfActive() ? 'visible' : 'hidden';
    sfPaintStatus(kw);

    sfLayout();
}

function upgradeSearchResultsBox(oldEl) {
    if (!oldEl || oldEl.tagName !== 'SELECT') return oldEl;

    const selCs = getComputedStyle(oldEl);
    const selBg = (selCs.backgroundColor && selCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && selCs.backgroundColor !== 'transparent')
        ? selCs.backgroundColor : '#fff';
    const selBorder = (selCs.borderTopWidth && parseFloat(selCs.borderTopWidth) > 0)
        ? `${selCs.borderTopWidth} ${selCs.borderTopStyle || 'solid'} ${selCs.borderTopColor || '#767676'}`
        : '1px solid #767676';
    const selRadius = selCs.borderRadius || '2px';
    const selFont = selCs.fontFamily || 'Arial, "Microsoft YaHei", sans-serif';
    const selFontSize = selCs.fontSize || '13.3333px';

    const types = ['', 'html', 'image', 'video', 'audio', 'pdf', 'epub', 'txt'];
    const typeStyles = {};
    for (const t of types) {
        const opt = document.createElement('option');
        if (t) opt.dataset.type = t;
        opt.textContent = 'M';
        oldEl.appendChild(opt);
        const cs = getComputedStyle(opt);
        typeStyles[t || 'default'] = {
            color: cs.color,
            bg: cs.backgroundColor
        };
    }
    oldEl.innerHTML = '';

    if (!document.getElementById('sr-custom-style')) {
        const def = typeStyles.default || {};
        const typeRules = types.filter(Boolean).map(t => {
            const s = typeStyles[t];
            if (!s) return '';
            const decls = [];
            if (s.color && s.color !== def.color) decls.push(`color:${s.color}`);
            if (s.bg && s.bg !== def.bg && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent') {
                decls.push(`background-color:${s.bg}`);
            }
            return decls.length ? `#searchResults .sr-opt[data-type="${t}"]{${decls.join(';')}}` : '';
        }).filter(Boolean).join('\n');

        const hlRules = [
            ...SEARCH_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-${b}{background-color:rgba(255,235,0,${Math.min(0.92, a + 0.08)});color:${c}}`),
            ...SEARCH_SYN_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-syn-${b}{background-color:rgba(56,189,248,${Math.min(0.75, a + 0.08)});color:${c}}`),
            ...SEARCH_SYN2_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-syn2-${b}{background-color:rgba(56,189,248,${Math.min(0.60, a + 0.06)});color:${c}}`)
        ].join('\n');

        const st = document.createElement('style');
        st.id = 'sr-custom-style';
        st.textContent = `
#searchResults{box-sizing:content-box;background-color:${selBg};border:${selBorder};border-radius:${selRadius};font-family:${selFont};font-size:${selFontSize};line-height:normal;user-select:none;-webkit-user-select:none;outline:none}
#searchResults .sr-opt{display:block;box-sizing:border-box;min-width:100%;width:max-content;white-space:pre;cursor:default;padding:0 4px 1px;min-height:1.2em;line-height:1.35;${def.color ? `color:${def.color};` : ''}}
#searchResults .sr-opt:hover{background-color:aliceblue}
${typeRules}
#searchResults .sr-opt.sr-selected{background-color:#dcdcdc;color:#000}
#searchResults:focus .sr-opt.sr-selected{background-color:Highlight;color:HighlightText}
#searchResults .sr-hl{margin:0;padding:0;border-radius:1px;font:inherit}
${hlRules}
`;
        document.head.appendChild(st);
    }

    const box = document.createElement('div');
    box.id = 'searchResults';
    box.setAttribute('role', 'listbox');
    box.tabIndex = 0;
    box.style.cssText = oldEl.style.cssText;

    let _selectedIdx = -1;
    Object.defineProperty(box, 'options', {
        get() { return this.querySelectorAll('.sr-opt'); }
    });
    Object.defineProperty(box, 'selectedIndex', {
        get() {
            const opts = this.options;
            return (_selectedIdx >= 0 && _selectedIdx < opts.length) ? _selectedIdx : -1;
        },
        set(val) {
            const opts = this.options;
            const next = (typeof val === 'number' && val >= 0 && val < opts.length) ? val : -1;
            _selectedIdx = next;
            opts.forEach((el, i) => {
                const sel = i === next;
                el.classList.toggle('sr-selected', sel);
                el.setAttribute('aria-selected', sel ? 'true' : 'false');
                if (sel) el.scrollIntoView({ block: 'nearest' });
            });
        }
    });

    oldEl.parentNode.replaceChild(box, oldEl);
    return box;
}

const SR_HARD_BREAK_RE = /[\n\r。！？；!?;]/;

function srAsciiLower(ch) {
    return toHalfwidth(ch).toLowerCase();
}

function srEffectiveNoise(kwLen, noiseLevel) {
    return kwLen > 25 ? 0 : Math.min(noiseLevel, Math.floor(kwLen / 2));
}

function srNormalizeKeywords(keywords) {
    const out = [];
    for (let idx = 0; idx < keywords.length; idx++) {
        const item = keywords[idx];
        if (!item) continue;
        const text = typeof item === 'string' ? item : item.text;
        if (!text) continue;
        const chars = [];
        for (const ch of text) {
            if (!/\s/.test(ch)) chars.push(srAsciiLower(ch));
        }
        if (chars.length === 0) continue;
        const tier = typeof item === 'string' ? (idx === 0 ? 0 : 1) : Number(item.tier ?? (idx === 0 ? 0 : 1));
        const maxNoise = typeof item === 'string' ? Infinity : Number(item.maxNoise ?? Infinity);
        const weight = typeof item === 'string' ? (tier === 0 ? 100 : 70) : Number(item.weight ?? (tier === 0 ? 100 : 70));
        out.push({ chars, tier, maxNoise, weight });
    }
    return out;
}

function srTryMatchAt(chars, i, kwChars, effNoise) {
    const len = chars.length;
    const kwLen = kwChars.length;
    let kIdx = 0;
    let j = i;
    let currentGap = 0;
    let totalNoise = 0;
    let spaceRun = 0;
    let last = i;

    while (j < len && kIdx < kwLen) {
        const ch = chars[j];
        if (srAsciiLower(ch) === kwChars[kIdx]) {
            kIdx++;
            currentGap = 0;
            spaceRun = 0;
            last = j;
        } else {
            if (kIdx > 0 && SR_HARD_BREAK_RE.test(ch)) break;
            if (/\s/.test(ch)) {
                spaceRun++;
                if (spaceRun > 1) {
                    currentGap++;
                    totalNoise++;
                    if (currentGap > effNoise) break;
                }
            } else {
                currentGap++;
                totalNoise++;
                if (currentGap > effNoise) break;
            }
        }
        j++;
        if (kIdx === kwLen) break;
    }

    return kIdx === kwLen ? [i, last + 1, totalNoise] : null;
}

function srCollectMatches(chars, keywords, noiseLevel, out) {
    const normKws = srNormalizeKeywords(keywords);
    const textLen = chars.length;
    for (const kw of normKws) {
        const kwChars = kw.chars;
        const kwLen = kwChars.length;
        if (kwLen === 0) continue;
        const effNoise = srEffectiveNoise(kwLen, Math.min(noiseLevel, kw.maxNoise));
        const first = kwChars[0];
        for (let i = 0; i < textLen; i++) {
            if (srAsciiLower(chars[i]) !== first) continue;
            const hit = srTryMatchAt(chars, i, kwChars, effNoise);
            if (hit) out.push([hit[0], hit[1], hit[2], kw.tier, kw.weight]);
        }
    }
}

function computeTitleMatchRanges(title, keyword) {
    if (!title || !keyword || typeof keyword !== 'string') return [];
    const kw = keyword.trim();
    if (!kw || /^@(bomb$|rebirth$)/.test(kw)) return [];

    const chars = Array.from(title);
    if (chars.length === 0) return [];

    const allHits = [];
    if (isAdsQuery(kw)) {
        const posTerms = buildAdsPositiveTerms(kw);
        if (!posTerms || posTerms.length === 0) return [];
        for (const t of posTerms) {
            srCollectMatches(chars, t.keywords, t.noise, allHits);
        }
    } else {
        const noise = Number(store.noise_level ?? 5);
        srCollectMatches(chars, getSearchKeywords(kw), noise, allHits);
    }

    if (allHits.length === 0) return [];
    allHits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

    const merged = [];
    for (const hit of allHits) {
        const last = merged[merged.length - 1];
        if (last && hit[0] < last[1]) {
            const lastLen = last[1] - last[0];
            const hitLen = hit[1] - hit[0];
            if (
                hit[3] < last[3] ||
                (hit[3] === last[3] && hit[2] < last[2]) ||
                (hit[3] === last[3] && hit[2] === last[2] && hit[4] > last[4]) ||
                (hit[3] === last[3] && hit[2] === last[2] && hit[4] === last[4] && hitLen > lastLen)
            ) {
                merged[merged.length - 1] = hit;
            }
            continue;
        }
        merged.push(hit);
    }
    return merged.map(h => [h[0], h[1], Math.min(h[2], 255) | (Math.min(h[3], 3) << 8)]);
}

function updateSearchResults(results, keyword) {
    const kwKey = pageOverlayKey(keyword);
    if (kwKey !== window._sfLastKw) {
        window._sfLastKw = kwKey;
        const s = sfState();
        if (s.ymOff.length > 0) s.ymOff = [];
    }

    window._baseRenderedResults = results;
    results = applyCommentOverlay(applyPageOverlay(results, keyword), keyword);

    const sf = sfApply(results);
    results = sf.list;
    const adsMode = isAdsQuery(keyword);

    window._currentResultMap = new Map(results.map(r => [r.path, r]));
    window._currentRenderedKeyword = keyword || "";

    let resultsBox = $('#searchResults');
    resultsBox.innerHTML = '';

    if (results.length === 0) {
        resultsBox.style.display = "none";
    } else {
        let markedUrls = new Set();
        try {
            if (iframes.side && iframes.side.contentWindow && iframes.side.contentWindow.MarkSystem) {
                markedUrls = iframes.side.contentWindow.MarkSystem.urls;
            }
        } catch (e) {
            console.warn("无法穿透获取 Mark 系统状态", e);
        }

        const fragment = document.createDocumentFragment();

        results.forEach(result => {
            const option = document.createElement('div');
            option.className = 'sr-opt';
            option.setAttribute('role', 'option');

            const isPrivate = (result.localOnly === true || result.info === "localOnly");
            const title = result.type === "html" ? result.title.replace(/\.html$/, '') : result.title;
            const countStr = (result.commentOnly || adsMode) ? "" : ` [${result.count}]`;
            const commentStr = adsMode
                ? (result.viaComment ? " [💬]" : "")
                : (result.commentHits ? ` [💬 ${result.commentHits}]` : "");

            const prefix = isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";
            if (prefix) option.appendChild(document.createTextNode(prefix));

            const titleRanges = computeTitleMatchRanges(title, keyword);
            if (titleRanges.length === 0) {
                option.appendChild(document.createTextNode(title));
            } else {
                const chars = Array.from(title);
                let cursor = 0;
                for (const [s, e, n] of titleRanges) {
                    if (s > cursor) {
                        option.appendChild(document.createTextNode(chars.slice(cursor, s).join('')));
                    }
                    const mark = document.createElement('mark');
                    mark.className = `sr-hl ${searchHlTier(n) === 0 ? 'sr-hl-' : (searchHlTier(n) === 1 ? 'sr-hl-syn-' : 'sr-hl-syn2-')}${searchHlBucket(n)}`;
                    mark.textContent = chars.slice(s, e).join('');
                    option.appendChild(mark);
                    cursor = e;
                }
                if (cursor < chars.length) {
                    option.appendChild(document.createTextNode(chars.slice(cursor).join('')));
                }
            }

            const suffix = `${countStr}${commentStr}`;
            if (suffix) option.appendChild(document.createTextNode(suffix));

            option.style.opacity = (isPrivate ? (store.online_flag === "1" ? 0.5 : 1) : 1);
            option.dataset.path = result.path;
            option.dataset.type = result.type;
            if (isPrivate) {
                option.dataset.localOnly = "true";
            }
            if (markedUrls.has(result.path)) {
                option.style.textDecoration = "line-through";
            }

            fragment.appendChild(option);
        });

        resultsBox.appendChild(fragment);
        resultsBox.style.display = "block";

        const firstOpt = resultsBox.options[0];
        const rowH = (firstOpt && firstOpt.offsetHeight) || Math.ceil(parseFloat(getComputedStyle(resultsBox).fontSize || '13.33') * 1.35) || 18;
        const visibleRows = Math.max(2, Math.min(10, resultsBox.options.length));
        resultsBox.style.height = (visibleRows * rowH) + "px";

        if ($("#content") && $("#search")) {
            const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
            resultsBox.style.maxWidth = maxW + "px";
        }

        resultsBox.style.left = `-${resultsBox.offsetWidth}px`;
        resultsBox.selectedIndex = -1;
    }

    sfRefreshBar(keyword, sf);
}

async function generateDoc(type, payload) {
    const { iframeCommonLogic, imageLogic, videoLogic } = await import('./lightbox-logic.js');
    const commonStyles = `@charset "UTF-8";@import url("../src/css/font.css");html,body,pre,textarea{font-family:'Noto Serif SC'}html{background-color:#000;touch-action:none;}body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;position:relative;overflow:hidden;touch-action:none;}.span-container{position:absolute;bottom:10px;right:10px;background:plum;z-index:999}.span-container span{margin-bottom:5px;padding:0 10px;cursor:pointer}.hide{opacity:.2!important}#f{display:none}`;

    const baseTag = `<base href="${window.location.href}">`;
    const viewportMeta = `<meta name="viewport" content="width=1024, viewport-fit=cover" />`;
    let htmlStr = '';

    if (type === 'image') {
        const { imageUrl } = payload;
        const jsUrl = JSON.stringify(imageUrl);

        htmlStr = `<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}${viewportMeta}<style>${commonStyles} img{z-index:1;max-height:100vh;max-width:100vw;visibility:hidden}#loader{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999}.bar-spinner{width:40px;height:40px;position:relative;animation:spin 1s linear infinite}.bar{width:4px;height:20px;background:pink;border-radius:2px;position:absolute;top:10px;left:18px;transform-origin:center bottom}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body>
        <div id="loader"><div class="bar-spinner"><div class="bar"></div></div></div>
        <img id="img">
        <div class="span-container"><span id="addbg">As Wallpaper</span><span id="fs" title="全屏(或按鼠标中键)">[F]</span><span id="c"></span><span id="p">prev</span><span id="i"></span><span id="n">next</span><span id="f"></span></div>
        <script>
            (function() {
                var _img = document.getElementById('img');
                var _loader = document.getElementById('loader');
                
                if (_img) {
                    _img.onload = function() { 
                        if(_loader) _loader.style.display = 'none'; 
                        _img.style.visibility = 'visible'; 
                    };
                    _img.onerror = function() { 
                        if(_loader) _loader.style.display = 'none'; 
                    };
                }

                setTimeout(function() {
                    if (_img) _img.src = ${jsUrl};
                }, 40);

                try {
                    (${iframeCommonLogic.toString()})();
                    (${imageLogic.toString()})();
                } catch(e) {
                    console.warn(e);
                }
            })();
        </script></body></html>`;
    }
    if (type === 'video') {
        const { videoUrl } = payload;
        const isMkv = videoUrl.toLowerCase().endsWith('.mkv');
        const filename = videoUrl.split('/').pop();
        const basename = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
        const vttUrl = isMkv ? `video/vtt/${basename}.vtt` : '';

        const jsVideoUrl = JSON.stringify(videoUrl);
        const jsVttUrl = JSON.stringify(vttUrl);
        const jsIsMkv = JSON.stringify(isMkv);

        const trackHtml = isMkv ? `<track id="main-track" label="中文" kind="subtitles" srclang="zh" default>` : '';
        const delayUiHtml = isMkv ? `<span id="delay-info" title="按 [ 提前0.5s，按 ] 延后0.5s" style="color:#ffeb3b;margin-right:10px;">偏移: 0.0s</span>` : '';

        htmlStr = `<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}${viewportMeta}<style>${commonStyles} video{max-width:100%;max-height:100%}video::cue{font-size:26px;color:#fff;background:rgba(0,0,0,0.9);text-shadow:2px 2px 4px rgba(0,0,0,0.8);font-family:'Noto Serif SC'}</style></head><body>
        
        <video id="video" controls loop playsinline>${trackHtml}</video>
        
        <div class="span-container">${delayUiHtml}<span id="fs" title="全屏(或按鼠标中键)">[F]</span><span id="c"></span><span id="p">prev</span><span id="i"></span><span id="n">next</span><span id="f"></span></div>
        <script>
            (function() {
                var _video = document.getElementById('video');
                var _track = document.getElementById('main-track');

                setTimeout(function() {
                    if (_video) {
                        _video.src = ${jsVideoUrl};
                        
                        if (${jsIsMkv} && _track) {
                            _track.src = ${jsVttUrl};
                        }
                    }
                }, 60);

                try {
                    (${iframeCommonLogic.toString()})();
                    (${videoLogic.toString()})();
                } catch(e) {
                    console.warn('Video iframe logic init error:', e);
                }
            })();
        </script></body></html>`;
    }
    return htmlStr.replace(/>\s+</g, '><').replace(/\n/g, '').trim();
}

function takeSnapshot(reload = false) {
    try {
        const state = {
            search_kw: $("#searchInput") ? $("#searchInput").value.trim() : ""
        };
        let mainPath = null;
        let mainType = null;
        let videoState = null;
        try {
            const cWin = iframes.content.contentWindow;
            const cDoc = iframes.content.contentDocument;
            const href = cWin.location.href;

            if (href.includes('/html/')) {
                mainType = 'html';
                let history = store.last_li_a;
                if (!Array.isArray(history)) history = history ? [history] : [];
                mainPath = history.length > 0 ? history[0] : "src/tpl/bookmark.html";
            } else if (href.includes('pdf.html')) {
                mainType = 'pdf';
                mainPath = store.pdf_path;
            } else if (href.includes('epub.html')) {
                mainType = 'epub';
                mainPath = store.epub_path;
            } else if (href.includes('txt.html')) {
                mainType = 'txt';
                mainPath = store.txt_path;
            } else if (cDoc && cDoc.getElementById('img')) {
                mainType = 'image';
                mainPath = store.image_path;
            } else if (cDoc && cDoc.getElementById('video')) {
                mainType = 'video';
                mainPath = store.video_path;
                const vEl = cDoc.getElementById('video');
                videoState = { currentTime: vEl.currentTime, volume: vEl.volume, isPaused: vEl.paused };
            }
        } catch (e) { console.warn("主屏状态读取失败", e); }

        state.main_type = mainType;
        state.main_path = mainPath;
        state.video_strict = videoState;
        const audioEl = document.getElementById('_audio');
        if (audioEl) {
            const currentLi = document.querySelector('#_playlist li.current');
            let aPath = currentLi ? currentLi.dataset.path : null;
            if (!aPath && audioEl.src) {
                try {
                    aPath = decodeURIComponent(new URL(audioEl.src).pathname);
                    if (aPath.includes('/audio/')) aPath = "../audio/" + aPath.split('/audio/')[1];
                } catch (e) { }
            }
            const activeBtns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.classList.contains('active2'))
                .map(b => b.textContent);
            const audioContainer = document.getElementById('audio');
            const isHidden = audioContainer ? audioContainer.style.display === 'none' : false;
            state.audio_strict = {
                path: aPath || store.song_path,
                time: audioEl.currentTime,
                volume: audioEl.volume,
                isPaused: audioEl.paused,
                header: document.querySelector('.header')?.innerText || '',
                modes: activeBtns,
                isHidden: isHidden
            };
        }
        sessionStorage.setItem("ss_restore_strict", JSON.stringify(state));
    } catch (e) {
        console.error("快照捕捉失败", e);
    }

    if (reload) {
        window.location.reload();
    }
}

function snap() {
    if ('serviceWorker' in navigator) {
        let isRefreshing = false;
        let currentController = navigator.serviceWorker.controller;

        navigator.serviceWorker.addEventListener('controllerchange', async () => {
            if (window._isBombing || isRefreshing) return;

            if (navigator.serviceWorker.controller === currentController) {
                return;
            }

            if (!currentController) {
                currentController = navigator.serviceWorker.controller;
                return;
            }

            await Promise.resolve();
            isRefreshing = true;
            store.force_refresh_cache = "1";
            takeSnapshot(true);
        });
    }
}

async function restore_snap() {
    if (window._snapRestored) return;
    window._snapRestored = true;
    const restoreStateStr = sessionStorage.getItem("ss_restore_strict");
    if (!restoreStateStr) {
        iframes.content.src = "src/tpl/bookmark.html";
        return;
    }
    sessionStorage.removeItem("ss_restore_strict");
    let state;
    try {
        state = JSON.parse(restoreStateStr);
    } catch (e) {
        iframes.content.src = "src/tpl/bookmark.html";
        return;
    }
    await AsyncUtils.waitFor(() => {
        try {
            const sideDoc = iframes.side.contentDocument;
            return window.lite_data && sideDoc && sideDoc.querySelector('a[data-path]');
        } catch (e) {
            return false;
        }
    }, 15000);
    await AsyncUtils.wait(100);

    const checkDataIntegrity = (bucket, path) => {
        if (!window.lite_data || !window.lite_data[bucket] || !path) return false;

        let clean = path.replace(/^\.\.\//, '');
        if (bucket === 'html' && clean.startsWith('html/')) clean = clean.substring(5);
        else if (bucket === 'image' && clean.startsWith('gallery/')) clean = clean.substring(8);
        else if (bucket === 'video' && clean.startsWith('video/')) clean = clean.substring(6);
        else if (bucket === 'audio' && clean.startsWith('audio/')) clean = clean.substring(6);
        else if (bucket === 'ebook' && clean.startsWith('ebook/')) clean = clean.substring(6);

        if (bucket === 'html') {
            let found = false;
            const targetFileName = clean.split('/').pop();
            const scanNode = (node) => {
                if (found || !node || typeof node !== 'object') return;
                if (Array.isArray(node._f) && node._f.some(f => f[0] === targetFileName)) {
                    found = true;
                    return;
                }
                for (const key of Object.keys(node)) {
                    if (key !== '_f') scanNode(node[key]);
                }
            };
            scanNode(window.lite_data[bucket]);
            return found;
        }

        let parts = clean.split('/');
        if (parts.length === 1) parts = ['_uncategorized', parts[0]];
        const fileName = parts.pop();
        let curr = window.lite_data[bucket];
        for (const p of parts) {
            if (!curr || !curr[p])
                return false;
            curr = curr[p];
        }

        return curr && curr._f && Array.isArray(curr._f) && curr._f.some(f => f[0] === fileName);
    };

    let needsBookmarkFallback = false;
    if (state.main_type && state.main_path) {
        let bucket = state.main_type;
        if (['pdf', 'epub', 'txt'].includes(bucket)) bucket = 'ebook';
        if (bucket === 'image') bucket = 'image';
        if (!checkDataIntegrity(bucket, state.main_path)) {
            console.warn(`🚨 ${bucket} 目录结构已变或文件丢失，正在销毁脏数据:`, state.main_path);

            if (bucket === 'image') { store.imagelist = []; store.image_path = ""; }
            else if (bucket === 'video') { store.videolist = []; store.video_path = ""; }
            else if (bucket === 'ebook') { store.pdf_path = ""; store.epub_path = ""; store.txt_path = ""; }
            else if (bucket === 'html') { store.last_html = ""; }

            let hist = store.last_li_a;
            if (Array.isArray(hist)) store.last_li_a = hist.filter(p => p !== state.main_path);

            state.main_type = null;
            state.main_path = null;
            needsBookmarkFallback = true;
        }
    }

    if (state.audio_strict && state.audio_strict.path) {
        if (!checkDataIntegrity('audio', state.audio_strict.path)) {
            console.warn(`🚨 audio 目录结构已变，正在销毁音频脏数据:`, state.audio_strict.path);
            store.playlist = [];
            store.song_path = "";
            state.audio_strict = null;
            needsBookmarkFallback = true;
        }
    }
    if (needsBookmarkFallback) {
        store.resource_type = "bookmark";
        store.content_src = "src/tpl/bookmark.html";
        store.lightbox_stauts = "0";
        iframes.content.src = "src/tpl/bookmark.html";

        emitEvent('update_bookmark_menu', null, 'side');
    }

    try {
        if (state.main_type && state.main_path) {
            let sel = state.main_type;
            if (['pdf', 'epub', 'txt'].includes(sel)) sel = 'ebook';
            if (sel === 'image') sel = 'gallery';
            emitEvent('#' + sel + ' a', state.main_path, 'side');
            emitEvent('show_current', null, 'side');
            if (state.main_type === 'video' && state.video_strict) {
                await AsyncUtils.waitFor(() => {
                    const v = iframes.content.contentDocument?.getElementById('video');
                    return v && v.readyState >= 1;
                }, 5000);
                const vEl = iframes.content.contentDocument.getElementById('video');
                if (vEl) {
                    vEl.currentTime = state.video_strict.currentTime || 0;
                    vEl.volume = state.video_strict.volume ?? 0.2;
                    if (state.video_strict.isPaused) {
                        vEl.pause();
                    } else {
                        vEl.play().catch(() => { });
                    }
                }
            }
        } else {
            iframes.content.src = "src/tpl/bookmark.html";
        }
    } catch (e) {
        console.warn("主视图恢复中止:", e.message);
    }

    try {
        const a = state.audio_strict;
        if (a) {
            const targetPath = a.path;
            const fileName = targetPath.split('/').pop();
            const dir = targetPath.split(fileName)[0];

            await AsyncUtils.waitFor(() => window.lite_data && Object.keys(window.lite_data).length > 0, 15000);

            if (typeof audio === 'function' && !window._audioTriggered && !$('#_audio')) {
                window._audioTriggered = true;
                audio(fileName, dir);
            }

            if (a.header === 'All') {
                await AsyncUtils.waitFor(() => window.data && window.data.length > 0, 15000);
                const allBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'All');
                allBtn?.click();
            } else if (a.header === 'Favorite Songs') {
                const favBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Favorite Songs');
                favBtn?.click();
            }

            await AsyncUtils.waitFor(() =>
                Array.from(document.querySelectorAll('#_playlist li'))
                    .some(li => li.dataset.path === targetPath)
                , 5000);

            const targetLi = Array.from(document.querySelectorAll('#_playlist li'))
                .find(li => li.dataset.path === targetPath);
            targetLi?.click();

            await AsyncUtils.waitFor(() => {
                const el = $('#_audio');
                return el && el.readyState >= 1;
            }, 5000);

            const audioEl = $('#_audio');
            if (audioEl) {
                audioEl.muted = true;
                audioEl.currentTime = a.time || 0;
                audioEl.volume = a.volume ?? 0.3;
                await AsyncUtils.wait(100);
                const getBtn = (t) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === t);

                a.modes?.forEach(m => {
                    if (m !== 'List Loop') {
                        getBtn(m)?.click();
                    }
                });

                audioEl.muted = false;
                if (a.isPaused) {
                    audioEl.pause();
                } else {
                    audioEl.play().catch(() => { });
                }

                const container = $('#audio');
                if (container) {
                    container.style.display = a.isHidden ? 'none' : 'block';
                    if (typeof adj_search_right === 'function') adj_search_right();
                }
            }
        }
    } catch (e) {
        console.warn("音频恢复中止:", e.message);
    }

    try {
        if (state.search_kw) {
            await AsyncUtils.waitFor(() => window.data && window.data.length > 0, 15000);
            $('#searchInput').value = state.search_kw;
            search(state.search_kw);
        }
    } catch (e) {
        console.warn("搜索框恢复中止:", e.message);
    }
}

function audio(_song, _level) {
    saveMediaPosition($("#_audio"));
    const oldAudio = $("#audio"); if (oldAudio) oldAudio.remove();
    const oldBtn = $("#audio_btn"); if (oldBtn) oldBtn.remove();
    audioInitialized = true;

    let playMode = 'list';
    let songs = store.playlist || [];
    let currentSongIndex = Math.max(0, songs.indexOf(_song));

    const stage = document.getElementById('stage');
    const existingAudio = document.getElementById("audio");
    if (existingAudio) existingAudio.remove();
    const existingBtn = document.getElementById("audio_btn");
    if (existingBtn) existingBtn.remove();

    stage.insertAdjacentHTML('beforeend', `<div id="audio"> <div class="audio-progress"><div class="audio-progress-bar" id="a_bar"></div></div> <div class="audio_div"> <div class="header" id="a_hdr">${(_level && _level.includes("audio/")) ? (_level.split("audio/")[1] || "未分类/") : "未分类/"}</div> <ul class="playlist" id="_playlist"></ul><br> <button id="btn_prv">Prev</button><button id="btn_nxt">Next</button><br> <button id="btn_favs">Favorite Songs</button><button id="btn_all">All</button><br> <button id="btn_shf">Shuffle</button><button id="btn_slp">Single Loop</button><button id="btn_llp">List Loop</button><br> <button id="fav">+Fav-</button><audio id="_audio" controls></audio><button id="btn_cls">destroy</button> </div> </div>`);
    document.body.insertAdjacentHTML('beforeend', `<button id="audio_btn" title="单击显隐, 双击销毁"> 🎵 </button>`);

    const playerContainer = $("#audio"), progressBar = $("#a_bar"), header = $("#a_hdr"),
        playlistElement = $("#_playlist"), audioPlayer = $("#_audio"),
        prevButton = $("#btn_prv"), nextButton = $("#btn_nxt"),
        favListBtn = $("#btn_favs"), allBtn = $("#btn_all"),
        shuffleButton = $("#btn_shf"), singleLoopButton = $("#btn_slp"), listLoopButton = $("#btn_llp"),
        favBtn = $("#fav"), buttonElement = $("#audio_btn"), closeBtn = $("#btn_cls"),
        progressContainer = playerContainer.querySelector('.audio-progress');
    audioPlayer.volume = 0.15;

    const renderListHTML = (list) => list.map((s, i) =>
        `<li data-idx="${i}" data-path="${s.includes('/') ? s : _level + s}" title="${s.includes('/') ? s.split(s.split('/').pop())[0].split('audio/')[1] : ''}">${s.split('/').pop()}</li>`
    ).join('');
    const loadPlaylist = (newSongs, titleText) => {
        if (!newSongs || newSongs.length === 0) return;
        songs = newSongs; currentSongIndex = 0; header.textContent = titleText;
        playlistElement.innerHTML = renderListHTML(songs);
        playlistElement.firstElementChild.click();
    };

    playlistElement.onclick = (e) => {
        if (e.target.tagName === 'LI') {
            currentSongIndex = parseInt(e.target.dataset.idx);
            playSong();
        }
    };

    progressContainer.onclick = (e) => {
        const percent = (e.clientY - progressContainer.getBoundingClientRect().top) / progressContainer.clientHeight;
        audioPlayer.currentTime = percent * audioPlayer.duration;
    };
    prevButton.onclick = () => {
        currentSongIndex = playMode === 'shuffle' ? Math.floor(Math.random() * songs.length) : (currentSongIndex - 1 + songs.length) % songs.length;
        playSong();
    };
    nextButton.onclick = () => {
        currentSongIndex = playMode === 'shuffle' ? Math.floor(Math.random() * songs.length) : (currentSongIndex + 1) % songs.length;
        playSong();
    };
    favListBtn.onclick = () => loadPlaylist(store.favList, 'Favorite Songs');
    allBtn.onclick = () => {
        if (!window.data || window.data.length === 0) return;
        const allSongs = [];
        for (let i = 3; i < window.data.length; i += 4) {
            if (window.data[i] === "audio") allSongs.push(window.data[i - 1]);
        }
        loadPlaylist(allSongs, 'All');
    };
    const updateModeUI = () => {
        shuffleButton.classList.toggle("active2", playMode === 'shuffle');
        singleLoopButton.classList.toggle("active2", playMode === 'single');
        listLoopButton.classList.toggle("active2", playMode === 'list');
    };
    shuffleButton.onclick = () => { playMode = playMode === 'shuffle' ? 'list' : 'shuffle'; updateModeUI(); };
    singleLoopButton.onclick = () => { playMode = playMode === 'single' ? 'list' : 'single'; updateModeUI(); };
    listLoopButton.onclick = () => { playMode = playMode === 'list' ? 'single' : 'list'; updateModeUI(); };
    favBtn.onclick = () => {
        let items = store.favList || [];
        const currentSrc = decodeURIComponent(audioPlayer.src);
        let purePath = currentSrc.includes('/audio/') ? "audio/" + currentSrc.split('/audio/')[1] : currentSrc;
        if (items.includes(purePath)) {
            items = items.filter(item => item !== purePath);
            favBtn.classList.remove("active");
        } else {
            items.push(purePath);
            favBtn.classList.add("active");
        }
        store.favList = items;
        backfill();
        emitEvent('UPDATE_FAV_LIST', null, 'side');
    };
    closeBtn.onclick = () => {
        saveMediaPosition(audioPlayer);
        playerContainer.remove();
        buttonElement.remove();
        if ($("#search") && $("#side")) $("#search").style.right = ($("#side").offsetWidth + 4) + "px";
    };
    buttonElement.onclick = () => {
        if (!$("#audio")) return;
        playerContainer.style.display = playerContainer.style.display !== 'none' ? 'none' : 'block';
        if (typeof adj_search_right === 'function') adj_search_right();
    };
    buttonElement.ondblclick = closeBtn.onclick;
    audioPlayer.ontimeupdate = () => {
        progressBar.style.height = (audioPlayer.currentTime / audioPlayer.duration) * 100 + "%";
    };

    audioPlayer.onended = () => {
        if (playMode === 'single') audioPlayer.play().catch(() => { });
        else nextButton.click();
    };
    const syncUIState = () => {
        const currentSrc = decodeURIComponent(audioPlayer.src);
        let purePath = currentSrc.includes('/audio/') ? "audio/" + currentSrc.split('/audio/')[1] : currentSrc;
        favBtn.classList.toggle("active", (store.favList || []).includes(purePath));
        const listItems = Array.from(playlistElement.children);
        listItems.forEach((item, index) => item.classList.toggle("current", index === currentSongIndex));

        const currentLi = listItems[currentSongIndex];
        if (currentLi) {
            const originalDisplay = playerContainer.style.display;
            playerContainer.style.display = "block";
            currentLi.scrollIntoView({ block: 'center' });
            playerContainer.style.display = originalDisplay;
        }
    };
    const backfill = () => {
        const favItems = store.favList || [];
        Array.from(playlistElement.children).forEach(item => {
            item.classList.toggle("fav", favItems.some(f => f.endsWith(item.textContent)));
        });
    };
    const playSong = () => {
        const targetLi = playlistElement.children[currentSongIndex];
        if (!targetLi) return;
        saveMediaPosition(audioPlayer);
        audioPlayer.src = targetLi.dataset.path;
        audioPlayer.play().catch(e => { });
        syncUIState();
        backfill();
    };

    updateModeUI();
    if (typeof adj_search_right === 'function') adj_search_right();


    playlistElement.innerHTML = renderListHTML(songs);
    backfill();
    playSong();
}

function cmt_mapper() {
    if (store.online_flag !== "1") return;
    const maxRetries = 300;
    let attempts = 0;
    const targetUrl = new URL('/src/cmt_mapper.json', window.location.origin).href;
    const checkAndLoad = async () => {
        try {
            const cachedRes = await caches.match(targetUrl, { ignoreSearch: true });
            if (cachedRes && cachedRes.ok) {
                const data = await cachedRes.json();
                records = data.records || [];
                return;
            } else {
                throw new Error("Cache Miss");
            }
        } catch (e) {
            attempts++;
            if (attempts < maxRetries) {
                setTimeout(checkAndLoad, 2000);
            } else {
                console.error(`[Giscus] 🔴 评论映射表读取超时0`);
            }
        }
    };

    idleRun(checkAndLoad);
}

async function comments() {
    if (store.online_flag === "1") {
        makeDraggable("#giscus-popup", "#popup-header");
        $("#close-popup").addEventListener("click", () => {
            $("#giscus-popup").style.display = "none";
        });

        const params = new URLSearchParams(window.location.search);
        const giscusCode = params.get("giscus");
        if (giscusCode) {
            $("#giscus-popup").style.display = "flex";
        }
    }
}

function commentToPlainText(md) {
    return String(md || "")
        .replace(/^```.*$/gm, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/^\s{0,3}>+\s?/gm, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/[*~`]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateText(text, max) {
    const chars = Array.from(text || "");
    return chars.length > max ? chars.slice(0, max).join("") + "…" : (text || "");
}

function collectHtmlFiles(node, out = new Map()) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node._f)) {
        for (const item of node._f) {
            if (!Array.isArray(item) || typeof item[0] !== "string") continue;
            const fileName = item[0];
            const info = typeof item[3] === "string" ? item[3] : "";
            const title = fileName.replace(/\.html$/, "");
            out.set(title, { title, fileName, path: "html/" + fileName, localOnly: info.includes("localOnly") });
        }
    }
    for (const key of Object.keys(node)) {
        if (key !== "_f") collectHtmlFiles(node[key], out);
    }
    return out;
}

async function getCommentMapperRecords() {
    if (records && records.length > 0) return records;
    try {
        const res = await fetch('/src/cmt_mapper.json', { cache: 'no-cache' });
        if (res.ok) {
            const data = await res.json();
            return data.records || [];
        }
    } catch (e) { }
    return [];
}

async function mapRawComments(raw) {
    const recs = await getCommentMapperRecords();
    await AsyncUtils.waitFor(() => window.lite_data, 90000, 200);
    const files = collectHtmlFiles(window.lite_data.html);
    const titleById = new Map(recs.map(r => [String(r.id), r.title]));

    const mapped = [];
    for (const c of raw) {
        const term = c && c.discussion ? String(c.discussion.title ?? "").trim() : "";
        const articleTitle = titleById.get(term);
        if (!articleTitle) continue;
        const file = files.get(articleTitle);
        if (!file) continue;
        mapped.push({
            id: c.id,
            path: file.path,
            author: (c.author && c.author.login) || "ghost",
            createdAt: c.createdAt,
            updatedAt: c.updatedAt || c.createdAt,
            text: commentToPlainText(c.body),
            url: c.url
        });
    }
    return mapped;
}

function pushCommentIndexToWorker() {
    const worker = searchWorker || _pendingWorker;
    if (worker && commentModel.index) {
        worker.postMessage({ type: 'SET_COMMENTS', payload: commentModel.index });
    }
}

async function applyCommentSnapshot(snap) {
    await AsyncUtils.waitFor(() => window.lite_data, 90000, 200);
    const files = collectHtmlFiles(window.lite_data.html);
    const meta = new Map();
    for (const f of files.values()) meta.set(f.path, f);

    const counts = {};
    const grouped = new Map();
    for (const c of snap.comments) {
        if (!meta.has(c.path)) continue;
        counts[c.path] = (counts[c.path] || 0) + 1;
        let g = grouped.get(c.path);
        if (!g) grouped.set(c.path, g = { path: c.path, texts: [] });
        g.texts.push(c.text);
    }

    commentModel.meta = meta;
    commentModel.counts = counts;
    commentModel.index = Array.from(grouped.values());
    commentModel.sig = snap.sig || "";
    commentModel.ready = true;
    commentModel.ver++;

    termSpecsCache.clear();
    snippetCache.clear();
    window.commentCounts = counts;
    emitEvent('COMMENT_COUNTS', counts, 'side');
    pushCommentIndexToWorker();
    refreshCommentOverlayForCurrentKeyword();
}

function pickLatestComments(comments, limit) {
    return comments
        .filter(c => commentModel.meta.has(c.path))
        .map(c => ({ c, ts: Date.parse(c.createdAt) || 0 }))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map(({ c }) => ({
            id: c.id,
            path: c.path,
            title: commentModel.meta.get(c.path).title,
            author: c.author,
            createdAt: c.createdAt,
            text: truncateText(c.text, 200) || "[无文本内容]",
            url: c.url
        }));
}

async function syncComments() {
    if (window._commentSyncing || !navigator.onLine) return;
    window._commentSyncing = true;
    window._lastCommentSyncAt = Date.now();
    try {
        const res = await fetch(`https://raw.githubusercontent.com/${data_repo}/main/comments.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const raw = Array.isArray(json && json.comments) ? json.comments : [];

        const mapped = await mapRawComments(raw);
        const sig = mapped.map(c => `${c.id}@${c.updatedAt}@${c.path}`).sort().join("|");
        if (commentModel.ready && sig === commentModel.sig) return;

        let prevLatest = null;
        try { prevLatest = await dbProxy.get('sys_state', 'comments_latest'); } catch (e) { }

        const snap = { generatedAt: (json && json.generatedAt) || "", sig, comments: mapped };
        await applyCommentSnapshot(snap);

        const latest = pickLatestComments(mapped, 10);
        const curNewest = latest.length ? (Date.parse(latest[0].createdAt) || 0) : 0;
        const prevNewest = Number(prevLatest && prevLatest.newestTs) || 0;
        const newestTs = Math.max(prevNewest, curNewest);
        const hasNew = !!prevLatest && curNewest > prevNewest;

        try {
            await dbProxy.put('sys_state', 'comments_latest', {
                fetchedAt: Date.now(),
                generatedAt: snap.generatedAt,
                newestTs,
                items: latest
            });
            await dbProxy.put('sys_state', 'comments_cache', snap);
        } catch (e) {
            console.warn("[Comments] 写入 IDB 失败:", e);
        }

        if (hasNew) notifyNewComments();
    } catch (e) {
        console.warn("[Comments] 同步失败:", e);
    } finally {
        window._commentSyncing = false;
    }
}

async function notifyNewComments() {
    const openedPopup = document.getElementById('changelog-popup');
    const isOpen = !!openedPopup && openedPopup.style.display !== 'none';
    if (!isOpen) {
        if (store.auto_show_comments === "0") return;
        if (Date.now() < (window._suppressCommentPopupUntil || 0)) return;
    }

    try { await AsyncUtils.waitFor(() => !window.isDataSyncing && window._dataReady, 90000, 200); } catch (e) { }
    if (window.restoreSnapPromise) {
        try { await window.restoreSnapPromise; } catch (e) { }
    }

    try {
        const m = await import('./deferred-features.js');
        m.showChangelog({ dbProxy, emitEvent }, isOpen ? { keepTab: true } : {});
    } catch (e) {
        console.warn("[Comments] 弹出 What's new 失败:", e);
    }
}

function startCommentSync() {
    if (window._commentSyncStarted) return;
    window._commentSyncStarted = true;

    (async () => {
        try {
            const cached = await dbProxy.get('sys_state', 'comments_cache');
            if (cached && Array.isArray(cached.comments)) await applyCommentSnapshot(cached);
        } catch (e) {
            console.warn("[Comments] 读取本地快照失败:", e);
        }
        await syncComments();
    })();

    window.commentSyncTimer = safeInterval(syncComments, COMMENTS_SYNC_INTERVAL);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible'
            && Date.now() - (window._lastCommentSyncAt || 0) > COMMENTS_SYNC_INTERVAL) {
            syncComments();
        }
    });
}

function setCommentHits(kw, hits) {
    const norm = normalizeKeyword(kw);
    if (!norm) return false;
    const sig = JSON.stringify(hits);
    const prev = commentHitCache.get(norm);
    commentHitCache.delete(norm);
    commentHitCache.set(norm, { ver: commentModel.ver, hits, sig });
    if (commentHitCache.size > 100) commentHitCache.delete(commentHitCache.keys().next().value);
    return (prev ? prev.sig : "[]") !== sig;
}

function requestCommentHits(kw, token) {
    if (!commentModel.ready || !searchWorker) return;
    const norm = normalizeKeyword(kw);
    if (!norm || isReservedSearchCommand(kw)) return;
    const entry = commentHitCache.get(norm);
    if (entry && entry.ver === commentModel.ver) return;
    searchWorker.postMessage({
        type: 'SEARCH_COMMENTS',
        payload: {
            keyword: kw,
            noise: Number(store.noise_level ?? 5),
            synonymsEnabled: (store.synonyms_enabled ?? 1) === 1,
            token
        }
    });
}

function refreshCommentOverlayForCurrentKeyword() {
    const kw = window._currentRenderedKeyword;
    if (!kw) return;
    if (isAdsQuery(kw)) { rerunActiveSearch(); return; }
    if (isReservedSearchCommand(kw)) return;
    requestCommentHits(kw, window._searchToken);
}

function rerenderSearchOverlay() {
    if (!window._baseRenderedResults) return;
    updateSearchResults(window._baseRenderedResults, window._currentRenderedKeyword);
}

function applyCommentOverlay(results, keyword) {
    if (!keyword || isReservedSearchCommand(keyword) || !commentModel.ready) return results;
    const entry = commentHitCache.get(normalizeKeyword(keyword));
    const hits = entry && entry.hits;
    if (!hits || hits.length === 0) return results;

    const hitMap = new Map(hits.map(h => [h.path, h.count]));
    const matched = new Set();
    const merged = results.map(r => {
        if (r.type !== 'html') return r;
        const p = r.path.startsWith('../') ? r.path.substring(3) : r.path;
        const count = hitMap.get(p);
        if (!count) return r;
        matched.add(p);
        return Object.assign({}, r, { commentHits: count });
    });

    for (const h of hits) {
        if (matched.has(h.path)) continue;
        const meta = commentModel.meta.get(h.path);
        if (!meta) continue;
        merged.push({
            title: meta.fileName,
            path: h.path,
            type: 'html',
            count: 0,
            localOnly: meta.localOnly,
            commentHits: h.count,
            commentOnly: true
        });
    }
    return merged;
}

function updatePopupHeaderWithStamp(stampText) {
    const header = document.getElementById("popup-header");
    if (!header) return;

    let titleEl = document.getElementById("popup-header-title");
    if (!titleEl) {
        titleEl = document.createElement("span");
        titleEl.id = "popup-header-title";
        titleEl.className = "cl-title";
        titleEl.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;";
        header.insertBefore(titleEl, header.firstChild);
    }

    titleEl.textContent = stampText ? `💬 Comment | ${stampText}` : `💬 Comment`;

    const closeBtn = document.getElementById("close-popup");
    if (closeBtn) {
        closeBtn.className = "cl-btn";
        closeBtn.textContent = "Close";
        if (closeBtn.parentElement === header) {
            const btnWrap = document.createElement('div');
            header.insertBefore(btnWrap, closeBtn);
            btnWrap.appendChild(closeBtn);
        }
    }
}

function discussion(term) {
    const script = document.createElement('script');
    script.src = "https://giscus.app/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.setAttribute("data-repo", data_repo);
    script.setAttribute("data-repo-id", data_repo_id);
    script.setAttribute("data-category-id", data_category_id);
    script.setAttribute("data-mapping", "specific");
    script.setAttribute("data-term", term);
    script.setAttribute("data-strict", "1");
    script.setAttribute("data-reactions-enabled", "1");
    script.setAttribute("data-emit-metadata", "1");
    script.setAttribute("data-input-position", "top");
    script.setAttribute("data-theme", "light");
    script.setAttribute("data-lang", "en");
    $("#giscus-container").appendChild(script);
}

function adj_search_right() {
    const audio = document.getElementById("audio");
    const search = document.getElementById("search");
    const side = document.getElementById("side");
    let w = 0;
    if (audio && window.getComputedStyle(audio).display !== "none") {
        w = audio.offsetWidth;
    }
    if (search && side) {
        search.style.right = (side.offsetWidth + 4 + w) + "px";
    }
}

function adj_side_width(op) {
    const contentFlex = parseInt(window.getComputedStyle($("#content")).flexGrow) || 85;
    const sideFlex = parseInt(window.getComputedStyle($("#side")).flexGrow) || 15;
    var d = 5, max = 85, min = 15;

    switch (op) {
        case "+":
            $("#content").style.flex = ((contentFlex - d) < min ? contentFlex : contentFlex - d).toString();
            $("#side").style.flex = ((sideFlex + d) > max ? sideFlex : sideFlex + d).toString();
            break;
        case "-":
            $("#content").style.flex = ((contentFlex + d) > max ? contentFlex : contentFlex + d).toString();
            $("#side").style.flex = ((sideFlex - d) < min ? sideFlex : sideFlex - d).toString();
            break;
    }

    store.layout_content_flex = $("#content").style.flex;
    store.layout_side_flex = $("#side").style.flex;
    adj_search_right();
}

function makeDraggable(popupSelector, headerSelector) {
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

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const scale = window._tpZoom || 1;
        const left = initialLeft + (e.clientX - startX) / scale;
        const top = initialTop + (e.clientY - startY) / scale;

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    });
}

function createAsyncUtils() {
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (condition, timeout = 10000, interval = 50) => {
        const startTime = Date.now();
        while (!condition()) {
            if (Date.now() - startTime > timeout) {
                throw new Error("等待超时");
            }
            await wait(interval);
        }
    };

    return {
        wait,
        waitFor
    };
}

function loadPinyinData(maxRetries = 300) {
    let attempts = 0;
    const checkAndLoad = async () => {
        try {
            const targetUrl = new URL('/src/js/pinyinData.js', window.location.origin).href;
            const cachedRes = await caches.match(targetUrl, { ignoreSearch: true });
            if (cachedRes && cachedRes.ok) {
                const scriptText = await cachedRes.text();
                const pinyinScript = document.createElement("script");
                pinyinScript.type = "text/javascript";
                pinyinScript.charset = "UTF-8";
                pinyinScript.textContent = scriptText;
                document.body.appendChild(pinyinScript);
                pinyinScript.remove();
            } else {
                throw new Error("Cache Miss");
            }
        } catch (e) {
            attempts++;
            if (attempts < maxRetries) {
                setTimeout(checkAndLoad, 2000);
            } else {
                console.error("❌ pinyinData.js 等待 SW 下载超时");
            }
        }
    };
    idleRun(checkAndLoad);
}


function safeInterval(fn, interval, maxDrift = interval * 2) {
    let last = Date.now();
    return setInterval(() => {
        const now = Date.now();
        const drift = now - last;
        if (drift > maxDrift) {
            last = now;
            return;
        }
        last = now;
        fn();
    }, interval);
}

function ls_alert() {
    const runCheck = () => {
        var alertSizeB = 1024 * 1024 * 4;
        var totalBytes = 0;

        for (var key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                totalBytes += localStorage.getItem(key).length * 2;
            }
        }

        var totalSizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
        const searchInput = $("#searchInput");

        if (totalBytes > alertSizeB) {
            alert("localStorage > " + totalSizeMB + " MB !");
        }
    };
    idleRun(runCheck);
}

function updateTitle() {
    const now = new Date();
    const h = now.getHours();
    const mm = String(now.getMinutes()).padStart(2, "0");
    const hh = String(h).padStart(2, "0");
    const time = `${hh}:${mm}`;
    const isRestTime = (h >= 23 || h < 6);
    document.title = isRestTime ? `${time} - 该睡觉了` : `${time} - ${doc_title}`;
    if (isRestTime) {
        startFaviconBlink();
    } else {
        stopFaviconBlink();
    }
}
function startFaviconBlink() {
    if (window.faviconBlinkTimer) return;
    const faviconLink = document.getElementById('favicon');
    if (!faviconLink) return;

    const originalSrc = faviconLink.getAttribute('href');

    const toggleOpacityAndApply = (img, opacity) => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, 16, 16);
        ctx.globalAlpha = opacity;
        ctx.drawImage(img, 0, 0, 16, 16);

        faviconLink.href = canvas.toDataURL('image/x-icon');
    };

    const initBlink = (img) => {
        let isVisible = true;
        window.faviconBlinkTimer = setInterval(() => {
            isVisible = !isVisible;
            toggleOpacityAndApply(img, isVisible ? 1 : 0);
        }, 500);
    };

    if (window.cachedFaviconImg) {
        initBlink(window.cachedFaviconImg);
    } else {
        const img = new Image();
        img.onload = function () {
            window.cachedFaviconImg = img;
            initBlink(img);
        };
        img.src = originalSrc;
    }
}
function stopFaviconBlink() {
    if (window.faviconBlinkTimer) {
        clearInterval(window.faviconBlinkTimer);
        window.faviconBlinkTimer = null;
    }
    const faviconLink = document.getElementById('favicon');
    if (faviconLink && window.cachedFaviconImg) {
        faviconLink.href = window.cachedFaviconImg.src;
    }
}