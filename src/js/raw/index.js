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
let _snipReqId = 0;
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
                case 'click':
                    fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') { if (el.paused) el.play().catch(() => { }); else el.pause(); }
                    break;
                case 'dblclick':
                    fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                    fire('mousedown', { button: 0 }); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                    fire('dblclick', { button: 0 });
                    break;
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
            if (!activeKw || isReservedSearchCommand(activeKw)) break;

            let hist = store.last_li_a;
            if (!Array.isArray(hist)) hist = hist ? [hist] : [];
            if (store.resource_type !== "html" || hist.length === 0) break;

            const currentPath = hist[0];
            const path = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;
            const changed = setPageHit(activeKw, {
                path,
                title: payload.title || path.split('/').pop().replace('.html', ''),
                count: typeof payload.count === 'number' ? payload.count : 0
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
                if (ifr) ifr.contentWindow.location.reload();

                attempts++;
                await AsyncUtils.wait(1000);
            }
            store.bookmarkhtml_modifing = "0";

            if (store.bookmarkhtml_linksHash !== rawHash && 'caches' in window) {
                const cache = await caches.open('core-cache-cache');
                await cache.add('/src/tpl/bookmark.html');
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
                        const isUpdate = sessionStorage.getItem("isUpdate") === "1";

                        if (localId === 0 || !isUpdate) {
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
    loadSynonymsData();

    updateTitle();
    setTimeout(() => {
        updateTitle();
        window.updateTitleTimer = safeInterval(updateTitle, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds());

    window.alertTimer = safeInterval(ls_alert, 60000);

    // 非首屏关键路径的低频功能，等浏览器空闲后再拉取对应 chunk
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

    // keys() 返回内部数组本身，调用方只读（filter 等会产生新数组）
    return { keys: () => load(), touch, touchAndEvict, forget, reset };
}

function createSearchResultCache(db, lru, { memMax = 48, flushDelay = 400, onClear = () => { } } = {}) {
    const mem = new Map();
    const dirty = new Map();
    let flushTimer = null;
    let flushing = false;

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
                const [k, v] = dirty.entries().next().value;
                dirty.delete(k);
                try {
                    await db.put('search_cache', k, v);
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

            let exact = memGet(normKw);
            if (exact === undefined) {
                if ((await lru.keys()).includes(normKw)) {
                    exact = await db.get('search_cache', normKw);
                    if (exact) memSet(normKw, exact);
                    else lru.forget(normKw);
                }
            }
            if (exact) {
                lru.touch(normKw);
                return { results: exact, exact: true, fromCache: true };
            }

            const isPrefix = (k) => k.length > 2 && k !== normKw && normKw.startsWith(k);
            const byLenDesc = (a, b) => b.length - a.length;

            for (const key of Array.from(mem.keys()).filter(isPrefix).sort(byLenDesc)) {
                const broader = memGet(key);
                if (Array.isArray(broader) && broader.length > 0) {
                    lru.touch(key);
                    return { results: broader, exact: false, fromCache: true };
                }
            }
            const candidates = (await lru.keys())
                .filter(k => isPrefix(k) && !mem.has(k))
                .sort(byLenDesc)
                .slice(0, 3);
            for (const key of candidates) {
                const broader = await db.get('search_cache', key);
                if (Array.isArray(broader) && broader.length > 0) {
                    memSet(key, broader);
                    lru.touch(key);
                    return { results: broader, exact: false, fromCache: true };
                }
                if (broader === undefined) lru.forget(key);
            }
            return null;
        } catch (e) { return null; }
    };

    const set = async (kw, results) => {
        const normKw = normalizeKeyword(kw);
        if (!normKw || !Array.isArray(results)) return;
        memSet(normKw, results);
        dirty.set(normKw, results);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, flushDelay);
    };

    const remove = async (kw) => {
        try {
            const normKw = normalizeKeyword(kw);
            if (!normKw) return;
            mem.delete(normKw);
            dirty.delete(normKw);
            await db.delete('search_cache', normKw);
            lru.forget(normKw);
        } catch (e) { }
    };

    const clearMemory = () => {
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

    // 缓存命名空间：把“会改变搜索结果语义的输入”（数据内容、算法版本、noise、同义词词表等）
    // 折叠成指纹，存进 IDB。指纹与上次不同就整体丢弃缓存，而不是靠各处手动 clear()。
    // 按 slot 分开记录，互不影响：core（数据/算法/设置）、syn（同义词词表）。
    const boundNs = new Map();
    const bindNamespace = async (slot, next) => {
        if (typeof slot !== 'string' || typeof next !== 'string') return false;
        if (boundNs.get(slot) === next) return false;
        boundNs.set(slot, next);
        const key = 'search_cache_ns:' + slot;
        let saved;
        try { saved = await db.get('sys_state', key); } catch (e) { saved = undefined; }
        if (boundNs.get(slot) !== next) return false;   // await 期间又被更新，交给后一次调用处理
        if (saved === next) return false;
        await clear();
        try { await db.put('sys_state', key, next); } catch (e) { }
        return true;
    };

    window.addEventListener('pagehide', () => { if (dirty.size > 0) flush(); });

    return { getMeta, set, remove, clear, clearMemory, bindNamespace };
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

        async put(targetStore, key, value) {
            const db = await init();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(targetStore, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(targetStore.error || event.target.error);
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

        const fatFiles = window.dataIndex.filter(f => f.startsWith('fat_data_'));

        await loadDataInBatches(fatFiles, now, concurrency);
    } catch (err) {
        console.error("❌ 核心流程中断，降级处理:", err);
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
            store.SearchCache.remove(keyword);
            return;
        }

        if (type === 'COMMENT_HITS') {
            if (token !== window._searchToken) return;
            if (setCommentHits(keyword, commentHits || [])) rerenderSearchOverlay();
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

        if (type === 'SEARCH_RESULTS') {
            if (token !== window._searchToken) {
                console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                return;
            }

            if (Array.isArray(commentHits)) setCommentHits(keyword, commentHits);
            if (e.data.error) window._adsStatus = { error: e.data.error };

            const activeKw = keyword || store.keyword;

            if (activeKw && !isReservedSearchCommand(activeKw)) {
                clearTimeout(window._idbWriteTimer);
                window._idbWriteTimer = setTimeout(() => {
                    searchWorker.postMessage({ type: 'COMMIT_CURSOR', payload: { keyword: activeKw } });
                }, 600);
            }

            processAndShowResults(results, activeKw, { noCache: window._searchCacheOk === false });
        }

        else if (type === 'DATA_READY') {
            // worker 只回传瘦身后的数据（html 正文已剥离，仅保留 path/type/localOnly 标记）和数据指纹
            const slim = Array.isArray(payload) ? payload : ((payload && payload.data) || []);
            window.data = slim;
            window._dataFp = (payload && !Array.isArray(payload) && payload.fp) || ('len' + slim.length);
            snippetCache.clear();
            // 与 finalizeDataLoad 并行：缓存库卡住时不阻塞界面初始化（bindCoreNamespace 内部已 try/catch，不会 reject）
            const nsPromise = bindCoreNamespace();
            await finalizeDataLoad();
            if (await nsPromise) {
                invalidateSearch();
                rerunActiveSearch();
            }
        }
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

    if (window._isOfflineDataFallback) {
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

    store.SearchCache.clear();
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

                    chunkDataMap.set(src, chunkData);
                    await dbProxy.save(src, { id: src, fingerprint: newHash, data: chunkData });

                    if (store.isUpdate === "1") {
                        await dbProxy.addLog(cachedMap.has(src) ? `🔄 更新: ${src}` : `✅ 新增: ${src}`);
                    }
                } finally {
                    clearTimeout(timeoutTimer);
                }
            })
        );

        results.forEach((res, index) => {
            if (res.status === 'rejected') {
                console.error(`❌ 切片 ${batch[index]} 拉取失败:`, res.reason);
            }
        });
    }

    await buildAndPushData();
}

async function finalizeDataLoad() {
    try {
        const currentMediaPaths = new Set();
        if (window.data && window.data.length > 0) {
            for (let i = 0; i < window.data.length; i += 4) {
                const type = window.data[i + 3];
                if (['image', 'video', 'audio', 'ebook'].includes(type)) {
                    currentMediaPaths.add(window.data[i + 2]);
                }
            }
        }

        const oldMediaListRaw = await dbProxy.get('sys_state', 'media_paths_snapshot');

        if (!oldMediaListRaw) {
            await dbProxy.put('sys_state', 'media_paths_snapshot', Array.from(currentMediaPaths));
        } else {
            const oldMediaPaths = new Set(oldMediaListRaw);
            let hasMediaUpdates = false;

            for (const path of currentMediaPaths) {
                if (!oldMediaPaths.has(path)) {
                    await dbProxy.addLog(`✅ 新增媒体: /${path}`);
                    hasMediaUpdates = true;
                }
            }

            for (const path of oldMediaPaths) {
                if (!currentMediaPaths.has(path)) {
                    await dbProxy.addLog(`⛔ 删除媒体: /${path}`);
                    hasMediaUpdates = true;
                }
            }

            if (hasMediaUpdates) {
                await dbProxy.put('sys_state', 'media_paths_snapshot', Array.from(currentMediaPaths));
            }
        }
    } catch (err) {
        console.warn("媒体资源 Diff 侦测失败", err);
    }

    if (store.force_refresh_cache === "1") {
        store.force_refresh_cache = "0";
        const triggerConfetti = () => {
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
        };
        triggerConfetti();
    }
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

function search_box() {
    const elSearchInput = $("#searchInput");
    const elSearchHistory = $("#searchHistory");
    const elSearchResults = $("#searchResults");
    elSearchInput.setAttribute("autocomplete", "off");

    function showSearchHistoryByTime() {
        const elSearchHistory = $("#searchHistory");
        elSearchHistory.innerHTML = "";
        elSearchHistory.style.display = "block";
        const history = [...(store.searchHistory || [])];
        history.sort((a, b) => b.timestamp - a.timestamp);
        history.forEach(item => {
            const option = document.createElement("option");
            option.text = item.keyword;
            elSearchHistory.appendChild(option);
        });
        elSearchHistory.options.length > 10 ? elSearchHistory.setAttribute("size", "10") : elSearchHistory.setAttribute("size", elSearchHistory.options.length);
    }

    async function loadContent(selectedIndex) {
        const option = elSearchResults.options[selectedIndex];

        if (store.online_flag === "1" && option.dataset.localOnly === "true") {
            alert("🔒 访问受限：仅限本地查阅。");
            return;
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
        const wrap = function () {
            if (isHandling || this.selectedIndex < 0) return;
            isHandling = true;
            handler(this.selectedIndex);
            setTimeout(() => { isHandling = false; }, 150);
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

    let searchDebounceTimer = null;
    let composing = false;

    const scheduleSearch = (val, delay) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            search(val.trim());
            store.keyword = val;
        }, isAdsQuery(val) ? Math.max(delay, 450) : delay);
    };

    const onValueSettled = (val, delay = 150) => {
        if (val.trim() === "") {
            clearTimeout(searchDebounceTimer);
            invalidateSearch();
            _autocompleteSeq++;
            updateSearchResults([]);
            showSearchHistoryByTime();
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
        initHistoryBox(1);
        const history = store.searchHistory;
        history.forEach(item => {
            const option = document.createElement("option");
            option.text = item.keyword;
            elSearchHistory.appendChild(option);
        });
        elSearchHistory.setAttribute("size", Math.max(2, Math.min(10, elSearchHistory.options.length)));
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
                return;
            }
            if (val === "@rebirth") {
                import('./deferred-features.js').then(m => m.rebirth({ iframes }));
                this.value = "";
                return;
            }
            const select = $("#searchResults");
            select.focus();
            select.selectedIndex = -1;
            if (val !== "") {
                const history = [...(store.searchHistory || [])];
                const i = history.findIndex(item => item.keyword === val);
                if (i !== -1) history.splice(i, 1);
                history.push({ keyword: val, timestamp: Date.now() });
                history.sort((a, b) => b.timestamp - a.timestamp);
                store.searchHistory = history;
            }
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
                    const option = document.createElement("option");
                    option.text = item.keyword;
                    elSearchHistory.appendChild(option);
                });
                elSearchHistory.setAttribute("size", Math.max(2, Math.min(10, elSearchHistory.options.length)));
            }
        }
    }

    elSearchHistory.addEventListener("contextmenu", async function (e) {
        if (e.target.tagName === 'OPTION') {
            e.preventDefault();
            e.stopPropagation();
            const keywordToDelete = e.target.text;

            let history = [...(store.searchHistory || [])];
            const newHistory = history.filter(item => item.keyword !== keywordToDelete);
            if (newHistory.length !== history.length) {
                store.searchHistory = newHistory;
            }

            await store.SearchCache.remove(keywordToDelete);

            const currentVal = $("#searchInput").value.trim();
            if (currentVal !== "") {
                await updateAutocompleteSuggestions(currentVal);
            } else {
                refreshHistoryList();
            }
        }
    });
    elSearchHistory.title = "右击删除该记录";

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
        const keyword = elSearchInput.value.trim();
        if (keyword !== "") {
            const history = [...(store.searchHistory || [])];
            const existingIndex = history.findIndex(item => item.keyword === keyword);
            if (existingIndex !== -1) {
                history.splice(existingIndex, 1);
            }
            history.push({
                keyword,
                timestamp: new Date().getTime()
            });
            history.sort((a, b) => b.timestamp - a.timestamp);
            store.searchHistory = history;
        }
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
    let currentScrollY = 0;
    let lastHoveredPath = null;
    let hoverSnippetTimer = null;
    let isPaused = true;

    function destroyMediaPreview() {
        if (previewBox) previewBox.style.display = 'none';
        lastHoveredPath = null;
        clearTimeout(hoverSnippetTimer);
        resetSearchHighlights();
        publishSearchHighlights();
        isPaused = true;
        if (previewTimeoutId) clearTimeout(previewTimeoutId);
        if (previewScrollFrame) cancelAnimationFrame(previewScrollFrame);
        const scrollContent = document.getElementById('preview-scroll-content');
        if (scrollContent) {
            saveMediaPositionsIn(scrollContent);
            scrollContent.innerHTML = '';
        }
    }

    window.addEventListener('blur', destroyMediaPreview);

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
        const body = (data && data.body) || { hits: 0, more: 0, items: [] };
        const cm = (data && data.comments) || { hits: 0, docs: 0, more: 0, items: [] };
        if (body.items.length === 0 && cm.items.length === 0) {
            previewBox.style.display = 'none';
            return;
        }

        const header = document.getElementById('preview-header');
        const scrollWrapper = document.getElementById('preview-scroll-wrapper');
        const scrollContent = document.getElementById('preview-scroll-content');
        previewBox.style.display = 'flex';
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
                title.textContent = label + (more > 0 ? `（另有 ${more} 条未显示）` : '');
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

        previewTimeoutId = setTimeout(() => {
            const blockHeight = first.offsetHeight;
            const visibleHeight = scrollWrapper.offsetHeight;
            if (blockHeight <= visibleHeight) return;

            scrollContent.appendChild(buildBlock());
            const autoScroll = () => {
                if (!isPaused) {
                    currentScrollY += 0.5;
                    if (currentScrollY >= blockHeight) {
                        currentScrollY -= blockHeight;
                    }
                    scrollContent.style.transform = `translateY(-${currentScrollY}px)`;
                }
                previewScrollFrame = requestAnimationFrame(autoScroll);
            };
            previewScrollFrame = requestAnimationFrame(autoScroll);
        }, 10);
    }

    elSearchResults.addEventListener('mousemove', (e) => {
        if (e.target.tagName.toUpperCase() === 'OPTION') {
            const path = e.target.dataset.path;
            const type = e.target.dataset.type;
            const isLocalOnly = e.target.dataset.localOnly === "true";

            if (e.target.dataset.localOnly === "true" && store.online_flag === "1") {
                e.target.title = "";
                if (lastHoveredPath !== path) {
                    destroyMediaPreview();
                    lastHoveredPath = path;
                }
                return;
            }

            const isMedia = type === 'video' || type === 'audio' || /\.(mp4|webm|ogg|mp3|wav|flac|m4a)$/i.test(path);
            const isImage = type === 'image' || /\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/i.test(path);

            const adsMode = isAdsQuery(window._currentRenderedKeyword || elSearchInput.value.trim());
            if (type === 'html') {
                e.target.title = adsMode ? "" : "右击滚动或停止";
            } else if (isMedia) {
                e.target.title = "右击播放或停止";
            } else {
                e.target.title = "";
            }

            if (path === lastHoveredPath) return;

            destroyMediaPreview();
            lastHoveredPath = path;

            if (isMedia) {
                return;
            }

            isPaused = true;
            previewBox.style.borderColor = '#61afef';

            const header = document.getElementById('preview-header');
            const scrollWrapper = document.getElementById('preview-scroll-wrapper');
            const scrollContent = document.getElementById('preview-scroll-content');

            previewBox.classList.toggle('image-preview-mode', isImage);

            if (isImage) {
                previewBox.style.display = 'flex';
                scrollContent.innerHTML = `<img src="${path}" style="max-width: 450px; max-height: 350px; object-fit: contain;" alt="Preview">`;
                return;
            }

            const resultData = window._currentResultMap && window._currentResultMap.get(path);
            const keyword = window._currentRenderedKeyword || elSearchInput.value.trim();
            if (!resultData || !keyword) return;
            if (isAdsQuery(keyword)) return;   // 组合搜索：html 条目不创建预览

            hoverSnippetTimer = setTimeout(async () => {
                const data = await requestSnippets(path, keyword);
                if (lastHoveredPath !== path || !data) return;
                showSnippetPreview(resultData, data);
            }, 30);
        }
    });

    elSearchResults.addEventListener('contextmenu', (e) => {
        if (e.target.tagName.toUpperCase() === 'OPTION') {
            e.preventDefault();
            const path = e.target.dataset.path;
            const type = e.target.dataset.type;

            if (e.target.dataset.localOnly === "true" && store.online_flag === "1") {
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
                    previewBox.style.display = 'flex';
                    previewBox.classList.add('image-preview-mode');

                    const isVideo = type === 'video' || /\.(mp4|webm|ogg)$/i.test(path);
                    if (isVideo) {
                        scrollContent.innerHTML = `<video src="${path}" data-path="${path}" loop style="max-width: 450px; max-height: 350px; width: 100%; outline: none; object-fit: contain;"></video>`;
                    } else {
                        const filename = path.split('/').pop();
                        scrollContent.innerHTML = `
                        <style>
                          .wave-bars { display: flex; align-items: flex-end; gap: 4px; height: 40px; justify-content: center; }
                          .wave-bar { width: 5px; background: #61afef; border-radius: 2px; animation: waveAnim 0.8s ease-in-out infinite alternate; }
                          .wave-bar.paused { animation-play-state: paused !important; }
                          @keyframes waveAnim { 0% { height: 10px; } 100% { height: 100%; } }
                          .wb-1 { animation-delay: 0s; } .wb-2 { animation-delay: 0.2s; } .wb-3 { animation-delay: 0.4s; } .wb-4 { animation-delay: 0.6s; } .wb-5 { animation-delay: 0.8s; }
                        </style>
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%;">
                           <div style="margin-bottom:20px; color:#abb2bf; font-size:14px; text-align:center; word-break:break-all; padding: 0 15px;">${filename}</div>
                           <div class="wave-bars">
                              <div class="wave-bar wb-1"></div><div class="wave-bar wb-2"></div><div class="wave-bar wb-3"></div><div class="wave-bar wb-4"></div><div class="wave-bar wb-5"></div>
                           </div>
                        </div>
                        <audio src="${path}" data-path="${path}" loop style="display:none;"></audio>`;
                    }

                    mediaEl = scrollContent.querySelector('video, audio');
                    mediaEl.volume = 0.1;
                    resumeMediaPosition(mediaEl, path);   // 从上一次的位置继续
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

    if (activeKw !== "" && !isReservedSearchCommand(activeKw)) {
        if (!provisional && !fromCache && !options.noCache) store.SearchCache.set(activeKw, base);
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
    if (typeof rawKeyword !== "string" || !rawKeyword.trim()) {
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

    if (meta && meta.exact) {
        cancelWorkerSearch(currentToken);
        requestCommentHits(kw, currentToken);
        processAndShowResults(meta.results, kw, { fromCache: true });
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

        const synonymsEnabled = (store.synonyms_enabled ?? 1) === 1;
        const synonymsReady = !synonymsEnabled || typeof window.expandQuery === 'function';
        window._searchCacheOk = synonymsReady;
        if (!synonymsReady) window._searchSentWithoutSyn = true;

        searchWorker.postMessage({
            type: 'SEARCH',
            payload: {
                keyword: kw,
                noise: Number(store.noise_level ?? 5),
                token: currentToken,
                searchKeywords: getSearchKeywords(kw)
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

// 修改 lib.rs / worker.js 中匹配、评分、边界语义时递增，旧缓存会因指纹变化被整体丢弃
const SEARCH_ALGO_VER = 3;

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
        'd:' + (window._dataFp || 'pending'),
        'l:' + Number(store.synonyms_enabled ?? 1),
        'n:' + Number(store.noise_level ?? 5)
    ].join('|');
}

// 数据、算法版本、noise、近义开关任一变化 → 缓存整体失效。返回是否发生了失效。
// 数据尚未就绪时不绑定（避免把上个会话仍然有效的缓存误清掉），设置命令用 force 强制绑定。
async function bindCoreNamespace({ force = false } = {}) {
    if (!window._dataFp && !force) return false;
    try {
        return await store.SearchCache.bindNamespace('core', computeCoreNamespace());
    } catch (e) { return false; }
}

async function bindSynonymsNamespace() {
    if (typeof window.expandQuery !== 'function' || !window.synonymIndex) return false;
    try {
        const fp = 'syn:' + hashText(JSON.stringify(window.synonymIndex.groups));
        return await store.SearchCache.bindNamespace('syn', fp);
    } catch (e) { return false; }
}

function rerunActiveSearch() {
    const el = document.getElementById("searchInput");
    const kw = el ? el.value.trim() : "";
    if (kw && (isAdsQuery(kw) || !isReservedSearchCommand(kw))) search(kw);
}

// synonyms.js 是异步加载的：之前发出的搜索可能没带同义词，加载完成后要让这些结果失效并重搜
async function onSynonymsLoaded() {
    const changed = await bindSynonymsNamespace();
    const missed = !!window._searchSentWithoutSyn;
    window._searchSentWithoutSyn = false;
    clearSearchOverlays();
    if (changed || missed) {
        invalidateSearch();
        rerunActiveSearch();
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

function setPageHit(kw, entry) {
    const norm = normalizeKeyword(kw);
    if (!norm) return false;
    let m = pageHitCache.get(norm);
    pageHitCache.delete(norm);
    if (!m) m = new Map();
    const prev = m.get(entry.path);
    m.delete(entry.path);
    m.set(entry.path, entry);
    pageHitCache.set(norm, m);
    if (pageHitCache.size > 100) pageHitCache.delete(pageHitCache.keys().next().value);
    return !prev || prev.count !== entry.count;
}

function applyPageOverlay(results, keyword) {
    if (!keyword || isReservedSearchCommand(keyword)) return results;
    const entries = pageHitCache.get(normalizeKeyword(keyword));
    if (!entries || entries.size === 0) return results;

    const strip = (p) => (p.startsWith('../') ? p.substring(3) : p);
    const indexByPath = new Map();
    results.forEach((r, i) => indexByPath.set(strip(r.path), i));

    const out = results.slice();
    const added = [];
    let latest = null;
    for (const e of entries.values()) {
        latest = e;
        const i = indexByPath.get(e.path);
        if (i !== undefined) {
            out[i] = Object.assign({}, out[i], { count: e.count });
        } else if (e.count > 0) {
            added.push({ title: e.title, path: e.path, type: 'html', count: e.count, localOnly: isPrivatePath(e.path) });
        }
    }
    const li = latest ? indexByPath.get(latest.path) : undefined;
    if (li !== undefined && li !== 0) out.unshift(out.splice(li, 1)[0]);

    return added.length ? added.reverse().concat(out) : out;
}

function requestSnippets(path, keyword) {
    const worker = searchWorker;
    if (!worker) return Promise.resolve(null);
    const noise = Number(store.noise_level ?? 5);
    const key = [normalizeKeyword(keyword), noise, store.synonyms_enabled ?? 1, commentModel.ver, path].join('|');

    const hit = snippetCache.get(key);
    if (hit) {
        snippetCache.delete(key);
        snippetCache.set(key, hit);
        return Promise.resolve(hit);
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
            payload: {
                reqId, path, keyword, noise,
                searchKeywords: getSearchKeywords(keyword),
                maxBody: 40, maxComments: 30
            }
        });
    });
}

const SEARCH_HL_STYLE = [[0.80, '#000'], [0.65, '#111'], [0.52, '#111'], [0.42, '#333'], [0.34, '#333'], [0.28, '#333']];
const searchHlName = (b) => (b <= 0 ? 'search-exact' : `search-noise-${b}`);
const searchHlBucket = (noise) => Math.min(Math.max(noise | 0, 0), SEARCH_HL_STYLE.length - 1);
const searchHl = [];

function searchHighlightSupported() {
    if (!(window.CSS && CSS.highlights && typeof Highlight !== 'undefined')) return false;
    if (!document.getElementById('search-hl-static')) {
        const st = document.createElement('style');
        st.id = 'search-hl-static';
        st.textContent = SEARCH_HL_STYLE
            .map(([a, c], b) => `::highlight(${searchHlName(b)}) { background-color: rgba(255, 235, 0, ${a}); color: ${c}; }`)
            .join('\n');
        document.head.appendChild(st);
    }
    return true;
}
function getSearchHighlight(noise) {
    const b = searchHlBucket(noise);
    if (!searchHl[b]) {
        const h = new Highlight();
        h.priority = 100 - b * 10;
        searchHl[b] = h;
    }
    return searchHl[b];
}
function resetSearchHighlights() {
    searchHl.forEach(h => { if (h) h.clear(); });
}
function publishSearchHighlights() {
    if (!(window.CSS && CSS.highlights)) return;
    searchHl.forEach((h, b) => {
        if (h && h.size > 0) CSS.highlights.set(searchHlName(b), h);
        else CSS.highlights.delete(searchHlName(b));
    });
}

function getSearchKeywords(kw) {
    const synonymsEnabled = (store.synonyms_enabled ?? 1) === 1;
    const expandQueryFn = window.top.expandQuery || ((kw) => ({ variants: [] }));
    const { variants } = synonymsEnabled ? expandQueryFn(kw) : { variants: [] };
    return [kw, ...variants];
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
            suggestionMap.set(item.keyword, true);
        }
    });

    try {
        const cacheKeys = await searchCacheLRU.keys();
        if (seq !== _autocompleteSeq) return;
        cacheKeys.forEach(key => {
            if (typeof key === 'string' && key.toLowerCase().includes(query)) {
                if (!suggestionMap.has(key)) {
                    suggestionMap.set(key, false);
                }
            }
        });
    } catch (e) {
        console.warn("读取缓存 Key 失败", e);
    }

    const rawList = Array.from(suggestionMap.entries()).map(([keyword, isHistory]) => ({ keyword, isHistory }));

    rawList.sort((a, b) => b.keyword.length - a.keyword.length);

    const filteredSuggestions = [];
    for (const item of rawList) {
        const itemLower = item.keyword.toLowerCase();
        if (itemLower === query) {
            filteredSuggestions.push(item);
            continue;
        }
        const isRedundant = filteredSuggestions.some(existing =>
            !item.isHistory && existing.keyword.toLowerCase().startsWith(itemLower)
        );
        if (!isRedundant) {
            filteredSuggestions.push(item);
        }
    }

    if (filteredSuggestions.length === 0) {
        elSearchHistory.style.display = "none";
        return;
    }

    elSearchHistory.style.display = "block";
    filteredSuggestions.forEach(item => {
        const option = document.createElement("option");
        option.text = item.keyword;

        if (!item.isHistory) {
            option.style.color = "#64748b";
            option.style.fontStyle = "italic";
        }

        elSearchHistory.appendChild(option);
    });

    elSearchHistory.setAttribute("size", Math.max(2, Math.min(10, elSearchHistory.options.length)));
}

function normalizeKeyword(kw) {
    if (!kw || typeof kw !== 'string') return '';
    return kw.trim().toLowerCase().replace(/\s+/g, '');
}

// 以 @[ 开头的组合搜索也算保留前缀：不进结果缓存、不统计页内命中、不叠加页面 / 评论 overlay、不通知 content 高亮
function isReservedSearchCommand(kw) {
    return typeof kw === 'string' && (/^@(bomb$|rebirth$)/.test(kw) || isAdsQuery(kw));
}

// [ads-filter:begin] ───────────────────────────────────────────────────────────
// 组合搜索与结果筛选条
//
//  · 组合搜索  @[a&!(b|c)]飞机[31]大炮[]机枪[0]
//      开头的 @[...] 进入组合搜索。第一个 [] 是表达式：运算符 & | ! ( )（优先级 ! > & > |），字母 a~z 是形参；
//      第 n 个字母对应后面第 n 个"词[]"——词写在 [] 的左边，[] 里 0~2 位数字：
//          []   噪值、近义都取全局（筛选条里的噪值 / 近义）
//          [3]  噪值 3（0~5），近义取全局
//          [31] 噪值 3，近义 1（0 关 / 1 开）
//      示例 = 飞机（噪 3、近义） 且 非(大炮（全局）或 机枪（噪 0、近义取全局））。
//      语义是"同一文档内"：包含项可由标题 / 正文 / 评论满足，排除项只看标题 / 正文（不看评论）；
//      解析和近义展开在主线程，匹配在 wasm 里一遍扫完。
//  · 筛选分两类：
//      引擎参数（噪值、近义）→ 改变匹配结果，改后重搜（存在 store.noise_level / store.synonyms_enabled）；
//      视图筛选（后缀、无明确日期、日期范围）→ 只过滤已算好的结果，不重搜、不进缓存。
// ──────────────────────────────────────────────────────────────────────────────
const ADS_PREFIX_RE = /^[@＠][\[［【]/;

function isAdsQuery(kw) {
    return typeof kw === 'string' && ADS_PREFIX_RE.test(kw.trimStart());
}

const ADS_MAX_DEPTH = 8;
const ADS_USAGE = '@[a&!(b|c)]飞机[31]大炮[]机枪[0]';

class AdsSyntaxError extends Error { }

// 表达式在"什么都不含的空文档"上是否成立（成立就会匹配几乎全库，必须拒绝）
function adsHoldsOnEmpty(n) {
    if (n.op === 'term') return n.neg;
    return n.op === 'and' ? n.args.every(adsHoldsOnEmpty) : n.args.some(adsHoldsOnEmpty);
}

// 把整条命令解析成 { terms, expr, summary }；输入是边敲边搜的，半截语法返回 { ok:false, error }，
// 不会被当普通关键词去搜。expr 是引用词条下标的表达式树（非 已用德摩根定律下推到词条上）。
function parseAdsQuery(raw) {
    const fail = (error) => ({ ok: false, error });
    const src = String(raw).trim()
        .replace(/＠/g, '@').replace(/[【［]/g, '[').replace(/[】］]/g, ']');   // 中文输入法下的符号
    if (!/^@\[/.test(src)) return fail('组合搜索以 @[表达式] 开头，例如 ' + ADS_USAGE);

    // 1) 表达式区：第一个 [ ] 之间
    const close = src.indexOf(']', 2);
    if (close < 0) return fail('表达式缺少 ]，例如 ' + ADS_USAGE);
    const es = src.slice(2, close)
        .replace(/＆/g, '&').replace(/｜/g, '|').replace(/！/g, '!').replace(/（/g, '(').replace(/）/g, ')')
        .replace(/\s+/g, '').toLowerCase();
    if (!es) return fail('表达式为空，例如 ' + ADS_USAGE);
    const bad = /[^a-z&|!()]/.exec(es);
    if (bad) return fail(`表达式里不能有「${bad[0]}」（只能用 & | ! ( ) 和字母 a~z）`);

    // 2) 实参区：词[噪值近义] 词[噪值近义] …（词在 [] 的左边）
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
        if (!text) return fail(`第 ${n} 个 [] 前面没有词`);
        if (!/^[0-9]*$/.test(digits)) return fail(`第 ${n} 个 [${m[2]}] 里只能写数字：[] / [噪值] / [噪值近义]`);
        if (digits.length > 2) return fail(`第 ${n} 个 [${digits}] 最多 2 位：噪值 0~5，近义 0 或 1`);
        if (digits.length >= 1 && Number(digits[0]) > 5) return fail(`第 ${n} 个 [${digits}] 的噪值只能是 0~5`);
        if (digits.length === 2 && Number(digits[1]) > 1) return fail(`第 ${n} 个 [${digits}] 的近义只能是 0 或 1`);
        terms.push({
            text,
            noise: digits.length >= 1 ? Number(digits[0]) : defNoise,
            like: digits.length === 2 ? Number(digits[1]) : defLike
        });
    }
    const tail = rest.slice(at).trim();
    if (tail) return fail(/[\[\]]/.test(tail) ? '方括号 [ ] 没有配对' : `「${tail}」后面缺少 []（每个词后面都要跟一个 []，留空表示用全局设置）`);
    if (terms.length === 0) return fail('表达式后面要跟词和 []，例如 ' + ADS_USAGE);
    if (terms.length > 26) return fail('最多 26 个词（字母 a~z）');

    // 3) 表达式语法：or := and ('|' and)* ；and := unary ('&' unary)* ；unary := '!' unary | '(' or ')' | 字母
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
        if (c === undefined) throw new AdsSyntaxError('表达式不完整：运算符后面缺少内容');
        if (c === '!') { pos++; return { k: 'not', x: parseUnary(depth) }; }
        if (c === '(') {
            if (depth >= ADS_MAX_DEPTH) throw new AdsSyntaxError(`括号嵌套太深（最多 ${ADS_MAX_DEPTH} 层）`);
            pos++;
            const e = parseOr(depth + 1);
            if (es[pos] !== ')') throw new AdsSyntaxError('括号没有闭合，缺少 )');
            pos++;
            return e;
        }
        if (c >= 'a' && c <= 'z') { pos++; used.add(c); return { k: 'var', ch: c }; }
        throw new AdsSyntaxError(`「${c}」前面缺少内容`);
    };
    let tree;
    try {
        tree = parseOr(0);
        if (pos < es.length) {
            throw new AdsSyntaxError(es[pos] === ')' ? '多余的 )' : `「${es[pos - 1]}」和「${es[pos]}」之间缺少运算符 & 或 |`);
        }
    } catch (e) {
        if (e instanceof AdsSyntaxError) return fail(e.message);
        throw e;
    }

    // 4) 形参与实参一一对应：第 n 个字母 ↔ 第 n 个词；多出来或没用到的都报错，免得手误悄悄改变含义
    for (const ch of [...used].sort()) {
        if (ch.charCodeAt(0) - 97 >= terms.length) return fail(`表达式里用到了 ${ch}，但后面只有 ${terms.length} 个词`);
    }
    for (let i = 0; i < terms.length; i++) {
        if (!used.has(String.fromCharCode(97 + i))) {
            return fail(`第 ${i + 1} 个词「${terms[i].text}」在表达式里没有对应的 ${String.fromCharCode(97 + i)}`);
        }
    }

    // 5) 转成引擎用的表达式树：非 只出现在词条上（德摩根：非(与)=或(非)、非(或)=与(非)），同运算符嵌套拍平
    const wire = (n, neg) => {
        if (n.k === 'var') return { op: 'term', term: n.ch.charCodeAt(0) - 97, neg };
        if (n.k === 'not') return wire(n.x, !neg);
        const op = (n.k === 'and') !== neg ? 'and' : 'or';
        return { op, args: n.xs.map(x => wire(x, neg)).flatMap(a => a.op === op ? a.args : [a]) };
    };
    const expr = wire(tree, false);
    if (adsHoldsOnEmpty(expr)) {
        return fail('至少要有一个必须出现的词（只有被 ! 排除的词，或 | 里带 !，会匹配几乎所有文档）');
    }

    // 6) 摘要：按用户写的结构显示（保留 非(…)），词条后标出实际生效的噪值 / 近义
    const show = (n, parent) => {
        if (n.k === 'var') { const t = terms[n.ch.charCodeAt(0) - 97]; return `${t.text}（噪${t.noise}${t.like ? '·近义' : ''}）`; }
        if (n.k === 'not') return n.x.k === 'var' ? '非 ' + show(n.x) : '非(' + show(n.x, null) + ')';
        const s = n.xs.map(x => show(x, n.k)).join(n.k === 'and' ? ' 且 ' : ' 或 ');
        return parent && parent !== n.k ? `(${s})` : s;
    };
    return { ok: true, terms, expr, summary: show(tree, null) };
}

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

    // 近义词在主线程按词条展开（expandQuery 挂在 window 上，worker 看不到）
    const expand = window.top.expandQuery;
    let synMissed = false;
    const terms = plan.terms.map(t => {
        let keywords = [t.text];
        if (t.like) {
            if (typeof expand === 'function') keywords = [t.text, ...expand(t.text).variants];
            else synMissed = true;
        }
        return { noise: t.noise, keywords };
    });
    // synonyms.js 是异步加载的：没赶上时由 onSynonymsLoaded 负责重跑
    if (synMissed) window._searchSentWithoutSyn = true;

    window._adsStatus = { summary: plan.summary };
    sfPaintStatus(kw);
    searchWorker.postMessage({ type: 'SEARCH_ADS', payload: { keyword: kw, token, plan: { terms, expr: plan.expr } } });
}

// ── 筛选状态（持久化在 store.search_filter，一经设置一直有效）──────────────────
// 后缀下拉的选项从"原始结果列表"（叠加评论之后、筛选之前）统计：页面和评论条目统归 html，其余按文件后缀。
// "无明确日期"是同一个下拉里的一项，取消勾选即隐藏没有日期的条目；日期范围只约束有明确日期的条目，两者互相独立。
function sfState() {
    if (!window._sfState) {
        let saved = null;
        try { saved = store.search_filter; } catch (e) { }
        saved = saved && typeof saved === 'object' ? saved : {};
        const okDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';
        window._sfState = {
            // 旧版本存过的 comment / other 已不再是独立类别，丢弃
            off: Array.isArray(saved.off) ? saved.off.filter(k => typeof k === 'string' && k && k !== 'comment' && k !== 'other') : [],
            hideUndated: saved.hideUndated === true,
            from: okDate(saved.from),
            to: okDate(saved.to)
        };
    }
    return window._sfState;
}

function sfSave() {
    try { store.search_filter = window._sfState; } catch (e) { }
}

// 日期戳：html 在 lite_data（轻数据第 4 项 "时间戳-localOnly"），图片在文件名，其余类型没有明确日期
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
                if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[3] === 'string') {   // 只遍历 lite_data.html 子树，与 collectHtmlFiles 一致
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

function sfStampOf(r) {
    const p = String(r.path || '').replace(/^\.\.\//, '');
    if (r.type === 'html') return sfStampMap().get(p) || '';
    if (r.type === 'image') {
        const m = /(?:^|\D)(\d{14})(?:\D|$)/.exec(p.split('/').pop() || '');
        if (m && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.test(m[1])) return m[1];
    }
    return '';
}

// 页面与评论条目（commentOnly / viaComment 也是 html 页面）统归 html，其余取文件后缀
function sfExtOf(r) {
    if (r.type === 'html') return 'html';
    const m = /\.([A-Za-z0-9]+)$/.exec(r.path || '');
    return m ? m[1].toLowerCase() : '(无)';
}

// 对原始结果列表统计：各后缀的条目数 + 没有明确日期的条目数
function sfStats(results) {
    const exts = new Map();
    let undated = 0;
    for (const r of results) {
        const e = sfExtOf(r);
        exts.set(e, (exts.get(e) || 0) + 1);
        if (!sfStampOf(r)) undated++;
    }
    return { exts, undated };
}

function sfActive() {
    const s = sfState();
    return s.off.length > 0 || s.hideUndated || !!s.from || !!s.to;
}

// 纯视图过滤：返回 { list, total, stats }（stats 统计的是过滤前的原始列表）
function sfApply(results) {
    const s = sfState();
    const stats = sfStats(results);
    const off = new Set(s.off);
    let from = s.from ? s.from.replace(/-/g, '') + '000000' : '';
    let to = s.to ? s.to.replace(/-/g, '') + '235959' : '';
    if (from && to && from > to) {
        const a = s.to.replace(/-/g, '') + '000000';
        const b = s.from.replace(/-/g, '') + '235959';
        from = a; to = b;
    }
    if (off.size === 0 && !s.hideUndated && !from && !to) return { list: results, total: results.length, stats };

    const list = results.filter(r => {
        if (off.has(sfExtOf(r))) return false;
        if (s.hideUndated || from || to) {
            const stamp = sfStampOf(r);
            if (!stamp) {
                if (s.hideUndated) return false;
            } else if ((from && stamp < from) || (to && stamp > to)) {
                return false;
            }
        }
        return true;
    });
    return { list, total: results.length, stats };
}

// ── 引擎参数：噪值 / 近义存在 store 里，改后清缓存命名空间并重搜 ──────────────────
function sfSyncEngine() {
    const n = Number(store.noise_level ?? 5);
    const l = Number(store.synonyms_enabled ?? 1);
    const bar = document.getElementById('sf-bar');
    if (!bar) return;
    bar.querySelector('#sf-noise').value = String(n);
    bar.querySelector('#sf-like').checked = l === 1;
}

async function sfApplyEngine(key, value) {
    store[key] = value;
    sfSyncEngine();
    clearSearchOverlays();
    await bindCoreNamespace({ force: true });
    if (searchWorker) searchWorker.postMessage({ type: 'CLEAR_CURSOR', payload: { keyword: '' } });
    invalidateSearch();
    rerunActiveSearch();
}

// ── 筛选条 UI：单行，原生控件 ─────────────────────────────────────────────────
function sfInjectStyle() {
    if (document.getElementById('sf-style')) return;
    const st = document.createElement('style');
    st.id = 'sf-style';
    st.textContent = `
#sf-bar{box-sizing:border-box;display:none;flex-wrap:wrap;align-items:center;gap:2px 8px;margin:0 0 2px;padding:2px 4px;font-size:12px;white-space:nowrap;background:#fff;border:1px solid #999}
#sf-bar select,#sf-bar input,#sf-bar button{font-size:12px;user-select:text;-webkit-user-select:text}
#sf-bar details{position:relative}
#sf-bar summary{cursor:pointer}
#sf-bar .sf-pop{position:absolute;z-index:2;top:100%;left:0;margin-top:4px;max-height:320px;overflow:auto;padding:2px 6px;background:#fff;border:1px solid #999}
#sf-bar .sf-pop label{display:block}
#sf-bar hr{margin:2px 0}
#sf-count.sf-hot{font-weight:bold}
#sf-status{flex-basis:100%;white-space:normal;word-break:break-all}
#sf-status:empty{display:none}
`;
    document.head.appendChild(st);
}

function sfFillControls() {
    const bar = document.getElementById('sf-bar');
    if (!bar) return;
    const s = sfState();
    bar.querySelector('#sf-from').value = s.from;
    bar.querySelector('#sf-to').value = s.to;
}

function sfReset() {
    Object.assign(sfState(), { off: [], hideUndated: false, from: '', to: '' });
    sfSave();
    sfFillControls();
    rerenderSearchOverlay();
}

// 反选：只翻转当前下拉里各后缀的勾选状态；"无明确日期"不动
// （否则"取消 pdf 再反选 = 只看 pdf"时，没有日期的 pdf 会被连带隐藏）
function sfInvert(bar) {
    const keys = [...bar.querySelectorAll('.sf-list input[data-k]')].map(i => i.dataset.k).filter(k => k !== '@nodate');
    if (!keys.length) return;
    const s = sfState();
    const off = new Set(s.off);
    for (const k of keys) { if (off.has(k)) off.delete(k); else off.add(k); }
    s.off = [...off];
    sfSave();
    rerenderSearchOverlay();
}

function sfBuildBar() {
    sfInjectStyle();
    const bar = document.createElement('div');
    bar.id = 'sf-bar';
    const noiseOpts = [0, 1, 2, 3, 4, 5].map(n => `<option value="${n}">${n}</option>`).join('');
    bar.innerHTML =
        `<label title="字间允许夹杂的无关字数上限，0~5；组合搜索里 [] 留空或只写噪值的词，近义同理，都取这里的值">噪值 <select id="sf-noise">${noiseOpts}</select></label>` +
        `<label title="近义搜索；组合搜索里 [] 留空或只写一位的词也用它"><input type="checkbox" id="sf-like">近义</label>` +
        `<details id="sf-sfx"><summary>筛选</summary><div class="sf-pop">` +
        `<button type="button" id="sf-inv" title="反选各后缀的勾选状态（不含「无明确日期」）">反选</button>` +
        `<div class="sf-list"></div><hr>` +
        `<label>起 <input type="date" id="sf-from" aria-label="起始日期"></label>` +
        `<label>止 <input type="date" id="sf-to" aria-label="结束日期"></label>` +
        `</div></details>` +
        `<span id="sf-count" aria-live="polite"></span>` +
        `<button type="button" id="sf-reset" title="恢复默认筛选（不影响噪值和近义）">重置</button>` +
        `<div id="sf-status"></div>`;

    // 键盘事件留在条内，避免触发页面级快捷键；Esc 收起下拉
    bar.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') bar.querySelector('#sf-sfx').open = false;
    });
    // 点到条外收起下拉
    document.addEventListener('click', (e) => {
        const d = bar.querySelector('#sf-sfx');
        if (d.open && !d.contains(e.target)) d.open = false;
    });

    bar.addEventListener('change', (e) => {
        const t = e.target;
        const s = sfState();
        if (t.id === 'sf-noise') { sfApplyEngine('noise_level', Number(t.value)); return; }
        if (t.id === 'sf-like') { sfApplyEngine('synonyms_enabled', t.checked ? 1 : 0); return; }
        if (t.dataset && t.dataset.k !== undefined) {
            if (t.dataset.k === '@nodate') {
                s.hideUndated = !t.checked;
            } else {
                s.off = s.off.filter(x => x !== t.dataset.k);
                if (!t.checked) s.off.push(t.dataset.k);
            }
        } else if (t.id === 'sf-from') {
            s.from = t.value;
        } else if (t.id === 'sf-to') {
            s.to = t.value;
        } else {
            return;
        }
        sfSave();
        rerenderSearchOverlay();
    });
    bar.addEventListener('click', (e) => {
        if (e.target.id === 'sf-reset') sfReset();
        else if (e.target.id === 'sf-inv') sfInvert(bar);
    });
    return bar;
}

// 下拉里的勾选列表由原始结果列表统计得出；统计没变时只同步勾选状态，不重建（避免打断正在操作的下拉）。
// 日期输入框在列表之外，重建列表不会动它们。
function sfSyncPanel(bar, stats) {
    const s = sfState();
    const exts = [...stats.exts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const sig = exts.map(e => e.join(':')).join(',') + '|' + stats.undated;
    const list = bar.querySelector('.sf-list');
    if (bar._sfSig !== sig) {
        const row = (k, text, n) => `<label><input type="checkbox" data-k="${k}"> ${text} (${n})</label>`;
        list.innerHTML = exts.length
            ? exts.map(([k, n]) => row(k, k === '(无)' ? '无后缀' : '.' + k, n)).join('') +
              (stats.undated ? '<hr>' + row('@nodate', '无明确日期', stats.undated) : '')
            : '无条目';
        bar._sfSig = sig;
    }
    list.querySelectorAll('input[data-k]').forEach(cb => {
        cb.checked = cb.dataset.k === '@nodate' ? !s.hideUndated : !s.off.includes(cb.dataset.k);
    });
}

function sfPaintStatus(keyword) {
    const el = document.getElementById('sf-status');
    if (!el) return;
    const info = isAdsQuery(keyword) ? window._adsStatus : null;
    el.textContent = info ? (info.error || info.summary || '') : '';
}

// 筛选条放在 #searchResults 正上方，右缘与结果框对齐（结果框靠 left:-宽度 伸向左侧），宽度由内容决定，放不下才折行。
// 结果框是 position:relative 时，条按文档流插在它前面即可把它顶下去；
// 结果框是 position:absolute（本项目的样式）时，条改用绝对定位，并把结果框的 top 下移一个条高。
function sfLayout() {
    const bar = document.getElementById('sf-bar');
    const box = document.getElementById('searchResults');
    if (!bar || !box || bar.style.display === 'none') return;

    const cs = getComputedStyle(box);
    const abs = cs.position === 'absolute';
    // 必须先让条脱离文档流再量任何东西：条在流内会撑大 shrink-to-fit 的 #search，
    // 也会把结果框的静态位置顶下去，量到的宽度和位置都会被条自己污染
    bar.style.position = abs ? 'absolute' : 'relative';
    bar.style.maxWidth = '';
    bar.style.width = 'max-content';

    const search = document.getElementById('search');
    const content = document.getElementById('content');
    const maxW = (search && content) ? Math.max(0, content.clientWidth - search.offsetWidth - 10) : 0;
    if (maxW) bar.style.maxWidth = maxW + 'px';
    bar.style.left = (-bar.offsetWidth) + 'px';
    // 条（及其下拉面板）要压在结果框之上：结果框有 z-index 时取它加一，否则不设
    const zi = parseInt(cs.zIndex, 10);
    bar.style.zIndex = Number.isFinite(zi) ? String(zi + 1) : '';

    if (abs) {
        let base = parseFloat(box.dataset.sfBaseTop);
        if (!Number.isFinite(base)) {
            box.style.top = '';
            base = parseFloat(cs.top);
            if (!Number.isFinite(base)) {
                const inp = document.getElementById('searchInput');
                base = inp ? inp.offsetTop + inp.offsetHeight + 2 : 0;
            }
            if (box.offsetWidth) box.dataset.sfBaseTop = String(base);   // 结果框隐藏时的数值不可靠，不缓存
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
        sfFillControls();
    }
    bar.style.display = 'flex';

    // 组合搜索下噪值 / 近义照常可用：它们是 [] 留空（或只写噪值）的词的默认值，改动后整条重搜
    const ads = isAdsQuery(kw);
    sfSyncEngine();
    sfSyncPanel(bar, sf.stats);

    const total = sf.total, shown = sf.list.length;
    const info = ads ? window._adsStatus : null;
    const countEl = bar.querySelector('#sf-count');
    let txt;
    if (info && info.error) txt = '';
    else if (total === 0) txt = '无结果';
    else if (shown === 0) txt = `全部 ${total} 条被筛选隐藏`;
    else if (shown < total) txt = `${shown} / ${total}`;
    else txt = `共 ${total} 条`;
    countEl.textContent = txt;
    countEl.classList.toggle('sf-hot', total > 0 && shown < total);
    bar.querySelector('#sf-reset').hidden = !sfActive();
    sfPaintStatus(kw);

    sfLayout();
}
// [ads-filter:end]

function updateSearchResults(results, keyword) {
    window._baseRenderedResults = results;
    results = applyCommentOverlay(applyPageOverlay(results, keyword), keyword);

    // 视图筛选只作用于显示：_baseRenderedResults 和结果缓存始终保持未过滤，改筛选不需要重搜
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
            let option = document.createElement('option');
            const isPrivate = (result.localOnly === true || result.info === "localOnly");
            const title = result.type === "html" ? result.title.replace(/\.html$/, '') : result.title;
            // 组合搜索：不显示命中数；评论只用 [💬] 标出"靠评论才满足"的条目，不带数量
            const countStr = (result.commentOnly || adsMode) ? "" : ` [${result.count}]`;
            const commentStr = adsMode
                ? (result.viaComment ? " [💬]" : "")
                : (result.commentHits ? ` [💬 ${result.commentHits}]` : "");
            option.text = (isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "") + `${title}${countStr}${commentStr}`;

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
        resultsBox.setAttribute("size", Math.max(2, Math.min(10, resultsBox.options.length)));
        resultsBox.style.display = "block";

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

    try { await AsyncUtils.waitFor(() => !window.isDataSyncing, 90000, 200); } catch (e) { }
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
            token,
            searchKeywords: getSearchKeywords(kw)
        }
    });
}

function refreshCommentOverlayForCurrentKeyword() {
    const kw = window._currentRenderedKeyword;
    if (!kw) return;
    if (isAdsQuery(kw)) { rerunActiveSearch(); return; }   // 评论参与组合搜索的判定
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

function loadSynonymsData(maxRetries = 300) {
    let attempts = 0;
    const checkAndLoad = async () => {
        try {
            const targetUrl = new URL('/src/js/synonyms.js', window.location.origin).href;
            const cachedRes = await caches.match(targetUrl, { ignoreSearch: true });
            if (cachedRes && cachedRes.ok) {
                const scriptText = await cachedRes.text();
                const synonymsScript = document.createElement("script");
                synonymsScript.type = "text/javascript";
                synonymsScript.charset = "UTF-8";
                synonymsScript.textContent = scriptText;
                document.body.appendChild(synonymsScript);
                synonymsScript.remove();
                onSynonymsLoaded().catch(() => { });
            } else {
                throw new Error("Cache Miss");
            }
        } catch (e) {
            attempts++;
            if (attempts < maxRetries) {
                setTimeout(checkAndLoad, 2000);
            } else {
                console.error("❌ synonyms.js 等待 SW 下载超时，近义搜索将保持停用状态");
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