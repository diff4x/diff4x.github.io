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
    format_markdown: null,
    find_content_matches: null,
    compute_lcs_diff: null
};
window._tpZoom = 1;

const BUS = window.__LITE_BUS__;
const ctxId = window.top === window.self ? 'index' : window.childId;
const isLocalEnv = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') && location.port !== '9000';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const idleRun = (fn) => window.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(50);
const AsyncUtils = createAsyncUtils();
const dbProxy = createDBProxy('MainDB', 'chunks');
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


let searchWorker = null;
let audioInitialized = false;
let comments_first_flag = false;
let records = [];
let totalCount = 0;


import('./synonyms.js').then(module => {
    window.top.expandQuery = module.expandQuery;
}).catch(err => {
    console.warn("⚠️ 近义词扩展模块加载失败，将降级为无近义词模式:", err);
});

import('../wasm/compute_intensive_task_processor.min.js').then(async (wasmModule) => {
    await wasmModule.default();
    window.sharedWasm.format_markdown = wasmModule.format_markdown;
    window.sharedWasm.find_content_matches = wasmModule.find_content_matches;
    window.sharedWasm.find_content_matches_multi = wasmModule.find_content_matches_multi; // 新增注入
    window.sharedWasm.compute_lcs_diff = wasmModule.compute_lcs_diff;
    window.sharedWasm.ready = true;
}).catch(err => {
    console.error("[Main] Wasm 模块加载失败:", err);
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

window.addEventListener('unload', () => {
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
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

            let hist = store.last_li_a;
            if (!Array.isArray(hist)) hist = hist ? [hist] : [];
            let globalResults = (await store.SearchCache.get(activeKw)) || [];

            if (store.resource_type === "html" && hist.length > 0) {
                const currentPath = hist[0];
                const strippedPath = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;
                const existingIndex = globalResults.findIndex(r => r.path === currentPath || r.path === strippedPath);

                if (existingIndex !== -1) {
                    const item = globalResults.splice(existingIndex, 1)[0];
                    if (payload.snippets) {
                        item.snippets = payload.snippets;
                        item.isTolerantMatch = payload.isTolerantMatch;
                    }
                    if (typeof payload.count === 'number') {
                        item.count = payload.count;
                    }
                    globalResults.unshift(item);
                } else if (payload.count > 0) {
                    let isActuallyPrivate = false;
                    if (window.data && window.data.length > 0) {
                        for (let i = 2; i < window.data.length; i += 4) {
                            if (window.data[i] === currentPath || window.data[i] === strippedPath) {
                                if (typeof window.data[i - 1] === 'string' && window.data[i - 1].startsWith('localOnly')) {
                                    isActuallyPrivate = true;
                                }
                                break;
                            }
                        }
                    }

                    globalResults.unshift({
                        title: payload.title || currentPath.split('/').pop().replace('.html', ''),
                        path: currentPath,
                        type: "html",
                        count: payload.count,
                        localOnly: isActuallyPrivate,
                        snippets: payload.snippets,
                        isTolerantMatch: payload.isTolerantMatch
                    });
                }
            }

            if (activeKw && !activeKw.startsWith('@')) {
                store.SearchCache.set(activeKw, globalResults);
            }

            updateSearchResults(globalResults, activeKw);
            break;
        }

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
            setTimeout(() => {
                const doc = iframes.content.contentWindow.document;
                doc.open();
                doc.write(generateDoc('image', { imageUrl: '../' + store.image_path }));
                doc.close();
            }, 20);
            break;

        case "video":
            store.resource_type = "video";
            iframes.content.src = "about:blank";
            setTimeout(() => {
                const doc = iframes.content.contentWindow.document;
                doc.open();
                doc.write(generateDoc('video', { videoUrl: '../' + store.video_path }));
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
            showChangelog();
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
            ExcerptsUIManager.openAndRefresh();
            break;

        case "SAVE_EXCERPT":
            let bookName = "html";
            if (store.resource_type === 'txt' && store.txt_path) bookName = store.txt_path.split('/').pop();
            else if (store.resource_type === 'pdf' && store.pdf_path) bookName = store.pdf_path.split('/').pop();
            else if (store.resource_type === 'epub' && store.epub_path) bookName = store.epub_path.split('/').pop();

            ExcerptsSys.save(bookName, payload).then(() => {
                if (document.getElementById('excerpts-popup') && document.getElementById('excerpts-popup').style.display !== 'none') {
                    ExcerptsUIManager.openAndRefresh();
                }
            }).catch(e => console.error("摘抄失败", e));
            break;

        case 'SHOW_GLOBAL_BOOKMARKS':
            showGlobalBookmarkMenu(payload.x, payload.y, payload.source);
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
    loadPinyinData();

    updateTitle();
    setTimeout(() => {
        updateTitle();
        window.updateTitleTimer = safeInterval(updateTitle, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds());

    window.alertTimer = safeInterval(ls_alert, 60000);

    initBackupReminder();

    if (store.online_flag === "0") {
        initDueTasksPingPong();
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
            if (prop === 'SearchCache') {
                return {
                    get: async (kw) => {
                        try {
                            const meta = await store.SearchCache.getMeta(kw);
                            return (meta && meta.exact) ? meta.results : null;
                        } catch (e) { return null; }
                    },
                    getMeta: async (kw) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (!normKw) return null;
                            let res = await dbProxy.get('search_cache', normKw);
                            if (res) {
                                return { results: res, exact: true, sourceKey: normKw };
                            }
                            
                            const keys = await dbProxy.getAllKeys('search_cache');
                            const matchingKeys = keys.filter(k => typeof k === 'string' && normKw.startsWith(k) && k.length > 2);
                            if (matchingKeys.length > 0) {
                                matchingKeys.sort((a, b) => b.length - a.length);
                                const bestKey = matchingKeys[0];
                                const broaderResults = await dbProxy.get('search_cache', bestKey);
                                if (broaderResults && broaderResults.results.length > 0) {
                                    return { results: broaderResults.results, exact: false, sourceKey: bestKey };
                                }
                            }
                            return null;
                        } catch (e) { return null; }
                    },
                    set: async (kw, results) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (!normKw) return;
                            await dbProxy.put('search_cache', normKw, results);
                            const keys = await dbProxy.getAllKeys('search_cache');
                            if (keys.length > 500) {
                                const keysToDelete = keys.slice(0, keys.length - 500);
                                for (let k of keysToDelete) await dbProxy.delete('search_cache', k);
                            }
                        } catch (e) { }
                    },

                    remove: async (kw) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (normKw) {
                                await dbProxy.delete('search_cache', normKw);
                            }
                        } catch (e) { }
                    },

                    clear: async () => {
                        try { await dbProxy.clear('search_cache'); } catch (e) { }
                    }
                };
            }

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

async function loadDataInBatches(files, now, concurrency) {
    const cachedChunks = await dbProxy.getAll();
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
        searchWorker = new Worker('src/js/worker.js', { type: 'module' });
        searchWorker.onmessage = async (e) => {
            const { type, results, keyword, token, inheritFrom, payload } = e.data;

            if (type === 'DELETE_CACHE') {
                store.SearchCache.remove(keyword);
                return;
            }

            if (type === 'SEARCH_RESULTS') {
                if (token !== window._searchToken) {
                    console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                    return;
                }

                const activeKw = keyword || store.keyword;

                if (activeKw) {
                    let sourceCache = await store.SearchCache.get(activeKw);
                    let isExactMatch = true;

                    if ((!sourceCache || sourceCache.length === 0) && inheritFrom) {
                        sourceCache = await store.SearchCache.get(inheritFrom);
                        isExactMatch = false;
                    }

                    if (token !== window._searchToken) return;

                    if (sourceCache && sourceCache.length > 0) {
                        results.forEach(newItem => {
                            const oldItem = sourceCache.find(o => o.path === newItem.path);
                            if (oldItem) {
                                if (isExactMatch) {
                                    if (oldItem.count > newItem.count) {
                                        newItem.count = oldItem.count;
                                    }
                                    if (oldItem.snippets) {
                                        newItem.snippets = oldItem.snippets;
                                        newItem.isTolerantMatch = oldItem.isTolerantMatch;
                                    }
                                }
                            }
                        });

                        if (isExactMatch) {
                            sourceCache.forEach(oldItem => {
                                if (oldItem.snippets && !results.some(r => r.path === oldItem.path)) {
                                    results.push(JSON.parse(JSON.stringify(oldItem)));
                                }
                            });
                        }
                    }
                }

                if (activeKw && !activeKw.startsWith('@')) {
                    clearTimeout(window._idbWriteTimer);
                    window._idbWriteTimer = setTimeout(() => {
                        searchWorker.postMessage({ type: 'COMMIT_CURSOR', payload: { keyword: activeKw } });
                    }, 600);
                }

                processAndShowResults(results, activeKw);
            }

            else if (type === 'DATA_READY') {
                window.data = payload;
                await finalizeDataLoad();
            }
        };
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
            if (window.restoreSnapPromise) {
                window.restoreSnapPromise.then(() => {
                    idleRun(playConfetti);
                    if (store.auto_show_changelog !== "0") {
                        setTimeout(showChangelog, 800);
                    }
                    window.restoreSnapPromise = null;
                });
            } else {
                idleRun(playConfetti);
                if (store.auto_show_changelog !== "0") {
                    setTimeout(showChangelog, 800);
                }
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

    elSearchInput.addEventListener("input", async function () {
        const val = this.value;

        if (val.startsWith('@noise=')) {
            const n = parseInt(val.split('=')[1]);
            if (!isNaN(n) && n >= 0 && n <= 5) {
                store.noise_level = n;
                elSearchInput.value = "";
                elSearchInput.placeholder = `已将搜索宽容度设为: ${n}`;
                setTimeout(() => elSearchInput.placeholder = "Search...", 2000);
                store.SearchCache.clear();
                if (searchWorker) searchWorker.postMessage({ type: 'CLEAR_CURSOR', payload: { keyword: "" } });
            }
            return;
        }

        if (val.startsWith('@synonyms=')) {
            const n = parseInt(val.split('=')[1], 10);
            if (n === 0 || n === 1) {
                store.synonyms_enabled = n;
                elSearchInput.value = "";
                elSearchInput.placeholder = n === 1 ? "已开启近义搜索" : "已停用近义搜索";
                setTimeout(() => elSearchInput.placeholder = "Search...", 2000);
                // 近义词是否参与匹配会改变结果集，必须让旧缓存全部失效，
                // 否则会出现"设置已切换，但看到的还是旧结果"的问题。
                store.SearchCache.clear();
                if (searchWorker) searchWorker.postMessage({ type: 'CLEAR_CURSOR', payload: { keyword: "" } });
            } else {
                elSearchInput.placeholder = "@synonyms 只能是 0 或 1";
                setTimeout(() => elSearchInput.placeholder = "Search...", 2000);
                elSearchInput.value = "";
            }
            return;
        }

        if (val.trim() === "") {
            clearTimeout(searchDebounceTimer);
            updateSearchResults([]);
            showSearchHistoryByTime();
            return;
        }

        const history = store.searchHistory || [];
        const matchingHistory = history.filter(item =>
            item.keyword.startsWith(val) || item.keyword.includes(val)
        );
        initHistoryBox(1);
        await updateAutocompleteSuggestions(val);

        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            search(val.trim());
            store.keyword = val;
        }, 150);
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
        const val = this.value.trim();
        if (e.keyCode === 40 || e.keyCode === 13 || e.key === "Enter") {
            e.preventDefault();
            if (val.startsWith("@noise=")) {
                const n = parseInt(val.split("=")[1], 10);
                if (!isNaN(n) && n >= 0 && n <= 5) {
                    store.noise_level = n;
                    this.value = "";
                    this.placeholder = `已将搜索宽容度设为: ${n}`;
                    setTimeout(() => this.placeholder = "Search...", 2000);
                    store.SearchCache.clear();
                    if (searchWorker) searchWorker.postMessage({ type: "CLEAR_CURSOR", payload: { keyword: "" } });
                } else {
                    this.placeholder = "宽容度只能是 0~5（当前输入无效）";
                    setTimeout(() => this.placeholder = "Search...", 2500);
                    this.value = "";
                }
                return;
            }
            if (val.startsWith("@synonyms=")) {
                const n = parseInt(val.split("=")[1], 10);
                if (n === 0 || n === 1) {
                    store.synonyms_enabled = n;
                    this.value = "";
                    this.placeholder = n === 1 ? "已开启近义搜索" : "已停用近义搜索";
                    setTimeout(() => this.placeholder = "Search...", 2000);
                    store.SearchCache.clear();
                    if (searchWorker) searchWorker.postMessage({ type: "CLEAR_CURSOR", payload: { keyword: "" } });
                } else {
                    this.placeholder = "@synonyms 只能是 0 或 1（当前输入无效）";
                    setTimeout(() => this.placeholder = "Search...", 2500);
                    this.value = "";
                }
                return;
            }
            if (val === "@bomb") {
                bomb();
                this.value = "";
                return;
            }
            if (val === "@rebirth") {
                rebirth();
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
    let isPaused = true;

    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    function destroyMediaPreview() {
        if (previewBox) previewBox.style.display = 'none';
        lastHoveredPath = null;
        isPaused = true;
        if (previewTimeoutId) clearTimeout(previewTimeoutId);
        if (previewScrollFrame) cancelAnimationFrame(previewScrollFrame);
        const scrollContent = document.getElementById('preview-scroll-content');
        if (scrollContent) scrollContent.innerHTML = '';
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

            if (type === 'html') {
                e.target.title = "右击滚动或停止";
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

            const resultData = (window._currentRenderedResults || []).find(r => r.path === path);
            const keyword = window._currentRenderedKeyword || elSearchInput.value.trim();

            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            
            const synonymsEnabled = (store.synonyms_enabled ?? 1) === 1;
            const expandQueryFn = window.top.expandQuery || ((kw) => ({ variants: [] }));
            const { variants } = synonymsEnabled ? expandQueryFn(keyword) : { variants: [] };
            const allKeywords = [keyword, ...variants];

            const buildSnippetRegexMulti = (kws) => {
                const parts = kws.map(kw => {
                    const cleanKw = kw.replace(/\s+/g, "");
                    const kwLen = cleanKw.length;
                    const tokens = cleanKw.split("").map(c => escapeRegExp(c));
                    const baseNoise = Number(store.noise_level ?? 5);
                    const effectiveNoise = kwLen > 25 ? 0 : baseNoise;
                    
                    return effectiveNoise === 0 
                        ? tokens.join("\\s*") 
                        : tokens.join(`\\s*(?:\\S\\s*){0,${effectiveNoise}}?`);
                });
                return new RegExp(`(${parts.join('|')})`, 'gi');
            };

            const getMatchNoise = (rawMatchText) => {
                const cleanMatchLen = rawMatchText.replace(/\s+/g, "").length;
                let bestNoise = 999;
                for (const kw of allKeywords) {
                    const cleanKwLen = kw.replace(/\s+/g, "").length;
                    const noise = cleanMatchLen - cleanKwLen;
                    if (noise >= 0 && noise < bestNoise) {
                        bestNoise = noise;
                    }
                }
                return bestNoise === 999 ? 0 : bestNoise;
            };

            if (resultData && resultData.snippets && resultData.snippets.length > 0) {
                previewBox.style.display = 'flex';
                header.style.color = '#abb2bf';

                const hlRegex = buildSnippetRegexMulti(allKeywords);

                let snipsWithNoise = resultData.snippets.map(snip => {
                    const text = typeof snip === 'string' ? snip : (snip && (snip.text || snip.snip)) || '';
                    let minNoise = 999;
                    let match;
                    hlRegex.lastIndex = 0;
                    while ((match = hlRegex.exec(text)) !== null) {
                        const noise = getMatchNoise(match[0]);
                        if (noise < minNoise) minNoise = noise;
                    }
                    return { text, noise: minNoise };
                }).filter(item => item.noise !== 999);

                if (snipsWithNoise.length === 0) {
                    previewBox.style.display = 'none';
                    return;
                }

                snipsWithNoise.sort((a, b) => a.noise - b.noise);

                let displayCount = snipsWithNoise.length;
                let countStr = displayCount == 1 ? `1 snippet` : `${displayCount} snippets`;
                header.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75%;">${resultData.title}</span>
                        <span style="color: #61afef; font-size: 11px; white-space: nowrap;">${countStr}</span>
                    </div>
                `;

                let singleHtml = snipsWithNoise.map((item, index) => {
                    let intervals = [];
                    let match;
                    hlRegex.lastIndex = 0;

                    while ((match = hlRegex.exec(item.text)) !== null) {
                        intervals.push({
                            start: match.index,
                            end: match.index + match[0].length,
                            text: match[0]
                        });
                        hlRegex.lastIndex = match.index + 1;
                    }

                    let merged = [];
                    intervals.sort((a, b) => a.start - b.start).forEach(iv => {
                        if (merged.length === 0) {
                            merged.push(iv);
                            return;
                        }
                        let last = merged[merged.length - 1];
                        if (iv.start <= last.end) {
                            last.end = Math.max(last.end, iv.end); 
                        } else {
                            merged.push(iv);
                        }
                    });

                    let parts = [];
                    let lastIdx = 0;
                    merged.forEach(m => {
                        let before = item.text.substring(lastIdx, m.start);
                        parts.push(before.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

                        let rawMatch = item.text.substring(m.start, m.end);
                        let safeMatch = rawMatch.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

                        let noise = getMatchNoise(rawMatch);
                        let alpha = noise === 0 ? 0.80 : Math.max(0.3, 0.80 - noise * 0.1);
                        let textColor = '#111111';
                        let fontWeight = noise <= 1 ? 'bold' : 'normal';
                        let hlStyle = `background-color: rgba(255, 235, 0, ${alpha.toFixed(2)}); color: ${textColor}; font-weight: ${fontWeight};`;

                        parts.push(`<span style="${hlStyle}">${safeMatch}</span>`);
                        lastIdx = m.end;
                    });

                    let after = item.text.substring(lastIdx);
                    parts.push(after.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

                    return `<div style="margin-bottom: 12px; border-bottom: 1px dashed #4b5263; padding-bottom: 8px;"><span style="color: #61afef; font-size: 11px;">[${index + 1}]</span> ${parts.join('')}</div>`;
                }).join('');

                scrollContent.innerHTML = `<div class="loop-block">${singleHtml}</div><div class="loop-block">${singleHtml}</div>`;
                currentScrollY = 0;
                scrollContent.style.transform = `translateY(0px)`;

                previewTimeoutId = setTimeout(() => {
                    const loopBlock = scrollContent.querySelector('.loop-block');
                    if (!loopBlock) return;

                    const blockHeight = loopBlock.offsetHeight;
                    const visibleHeight = scrollWrapper.offsetHeight;

                    if (blockHeight > visibleHeight) {
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
                    } else {
                        scrollContent.innerHTML = `<div class="loop-block">${singleHtml}</div>`;
                    }
                }, 10);
            }
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
    let finalResults = [...(results || [])];

    if (provisional) {
        finalResults = finalResults.map(r => {
            const copy = Object.assign({}, r);
            delete copy.snippets;
            delete copy.isTolerantMatch;
            return copy;
        });
    }

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

    if (!provisional && activeKw !== "" && !activeKw.startsWith('@')) {
        store.SearchCache.set(activeKw, finalResults).then(() => {
            if (currentIndex === -1) {
                emitEvent('LOCAL_SEARCH_COUNT', activeKw, 'content');
            }
        });
    } else if (provisional && currentIndex === -1 && activeKw && !activeKw.startsWith('@')) {
        emitEvent('LOCAL_SEARCH_COUNT', activeKw, 'content');
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
        updateSearchResults([]);
        return;
    }
    const kw = rawKeyword.trim();

    const currentToken = ++window._searchToken;
    const meta = await store.SearchCache.getMeta(kw);

    if (meta && meta.results && currentToken === window._searchToken) {
        if (meta.exact) {
            processAndShowResults(meta.results, kw, { provisional: false });
            return;
        }
        processAndShowResults(meta.results, kw, { provisional: true });
    }

    try {
        if (!searchWorker) {
            console.warn("搜索引擎尚未就绪");
            return;
        }

        const synonymsEnabled = (store.synonyms_enabled ?? 1) === 1;
        const expandQueryFn = window.top.expandQuery || ((kw) => ({ variants: [] }));
        const { variants } = synonymsEnabled ? expandQueryFn(kw) : { variants: [] };

        searchWorker.postMessage({
            type: 'SEARCH',
            payload: { 
                keyword: kw, 
                noise: Number(store.noise_level ?? 5),
                token: currentToken, 
                searchKeywords: [kw, ...variants]
            }
        });

    } catch (err) {
        console.error("web worker 通信失败", err);
    }
}

async function updateAutocompleteSuggestions(val) {
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
        const cacheKeys = await dbProxy.getAllKeys('search_cache');
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

function updateSearchResults(results, keyword) {
    window._currentRenderedResults = results;
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

            option.text = (isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "") + `${title} [${result.count}]`;

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
}

const iframeCommonLogic = function () {
    window.$ = (s) => document.querySelector(s);
    window.$$ = (s) => document.querySelectorAll(s);
    window.createStore = function (defaults = {}) {
        return new Proxy({}, {
            get(_, prop) {
                const val = localStorage.getItem(prop);
                if (val === null) return defaults[prop];
                try { return JSON.parse(val); } catch { return val; }
            },
            set(_, prop, value) {
                localStorage.setItem(prop, JSON.stringify(value));
                return true;
            },
            deleteProperty(_, prop) {
                localStorage.removeItem(prop);
                return true;
            }
        });
    };
    window.childId = 'content';

    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
    }
    window.__LITE_BUS__ = new BroadcastChannel('bus');
    const BUS = window.__LITE_BUS__;

    window.addEventListener('unload', () => {
        if (window.__LITE_BUS__) {
            window.__LITE_BUS__.close();
            window.__LITE_BUS__ = null;
        }
    });

    const ctxId = window.top === window.self ? 'index' : window.childId;
    window.emitEvent = function (type, payload, target = '*') {
        BUS.postMessage({
            type,
            payload,
            from: ctxId,
            target
        });
    }

    if (window.top && window.top.VirtualCursor) {
        window.top.VirtualCursor.attach(window);
    }

    BUS.addEventListener('message', (e) => {
        const { type, payload, target } = e.data || {};
        if (target !== '*' && target !== ctxId) return;
        if (type === 'SIM_POINTER') {
            window.handleSimPointer(payload);
        }
    });

    window.bindSwipeGestures = function (element, callbacks, thresholdPercent = 0.15) {
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

            const currentScale = callbacks.getScale ? callbacks.getScale() : 1.0;
            if (currentScale > 1.05) return;

            if (e.changedTouches.length !== 1) return;
            const deltaX = e.changedTouches[0].clientX - startX;
            const deltaY = e.changedTouches[0].clientY - startY;

            const dynamicThreshold = Math.min(window.innerWidth, window.innerHeight) * thresholdPercent;

            if (Math.abs(deltaX) > dynamicThreshold || Math.abs(deltaY) > dynamicThreshold) {
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0 && callbacks.onRight) callbacks.onRight();
                    else if (deltaX < 0 && callbacks.onLeft) callbacks.onLeft();
                } else {
                    if (callbacks.onVertical) callbacks.onVertical();
                }
            } else {
                if (callbacks.onSnapBack) callbacks.onSnapBack();
            }
        });
    };
};

const imageLogic = function () {
    const store = createStore({ lightbox_stauts: "0" });
    const img = $('#img');
    const loader = $('#loader');

    if (img.src.split("/").pop().startsWith("pano_")) {
        img.style.border = "2px red solid";
        img.title = "双击进入全景";
    } else {
        img.style.border = "none";
        img.title = "";
    }

    let scale = 1.0;
    const maxScale = 10.0;
    const minScale = 0.5;
    const scaleStep = 0.1;
    let dragMoved = false;

    img.addEventListener('wheel', e => {
        e.preventDefault();
        scale = Math.max(minScale, Math.min(scale + (e.deltaY < 0 ? scaleStep : -scaleStep), maxScale));
        img.style.transform = `translate(${img.dataset.tx || 0}px, ${img.dataset.ty || 0}px) scale(${scale})`;
    });

    let initialDistance = 0;
    let initialScale = 1.0;

    img.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialScale = scale;
        }
    }, { passive: false });

    img.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            if (e.cancelable) e.preventDefault();
            const currentDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            scale = initialScale * (currentDistance / initialDistance);
            scale = Math.max(minScale, Math.min(scale, maxScale));
            img.style.transform = `translate(${img.dataset.tx}px, ${img.dataset.ty}px) scale(${scale})`;
        }
    }, { passive: false });

    function enableDrag(target) {
        let isDragging = false, startX = 0, startY = 0;
        target.dataset.tx = target.dataset.tx || 0;
        target.dataset.ty = target.dataset.ty || 0;

        const onMove = (e) => {
            if (!isDragging) return;
            if (e.touches && e.touches.length > 1) return;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const tx = clientX - startX, ty = clientY - startY;

            if (Math.abs(tx) > 5 || Math.abs(ty) > 5) {
                dragMoved = true;
            }

            target.dataset.tx = tx; target.dataset.ty = ty;
            target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            if (e.cancelable) e.preventDefault();
        };

        const onUp = () => {
            isDragging = false; target.style.cursor = "grab";
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
    };

    enableDrag(img);

    const path = store.image_path || ("gallery/" + decodeURIComponent(img.src).split("/gallery/")[1]);
    const imagelist = store.imagelist || [];
    const idx = imagelist.indexOf(path);
    const _cat = path.split(path.split("/").pop())[0].split("gallery/")[1];
    const category = (!_cat || _cat === "") ? "未分类" : _cat;

    const go = (nPath) => {
        scale = 1.0;
        img.style.transition = "none";
        img.dataset.tx = 0; img.dataset.ty = 0;
        img.style.transform = `translate(0px, 0px) scale(1.0)`;

        store.image_path = nPath;
        emitEvent("image", null, "index");
        emitEvent("image", "#gallery a", "side");
    };

    $("#p").onclick = () => go(imagelist[(idx - 1 + imagelist.length) % imagelist.length]);
    $("#n").onclick = () => go(imagelist[(idx + 1) % imagelist.length]);
    $("#i").innerHTML = `${idx + 1}/${imagelist.length}<input style='width:60px' id='jump' onclick='select(this)'>`;
    $("#c").innerHTML = `[${category}]`;

    const sc = $(".span-container");
    if (store.lightbox_stauts === "1") sc.classList.add("hide");
    $("#f").onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== "1" ? "1" : "0";
        store.lightbox_stauts === "1" ? sc.classList.add("hide") : sc.classList.remove("hide");
        emitEvent("lightbox", { status: store.lightbox_stauts }, "index")
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = window.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;

        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== "1") $("#f").click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === "1") $("#f").click();
        }
    };

    const fsBtn = $("#fs");
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    $("#jump").onkeypress = (e) => {
        if (e.keyCode === 13) {
            e.preventDefault();
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0 && val <= imagelist.length) go(imagelist[val - 1]);
        }
    };

    document.onkeydown = e => {
        if (e.code === 'Space') { e.preventDefault(); $('#jump').focus(); }
        else if (e.key === 'ArrowLeft') $("#p").click();
        else if (e.key === 'ArrowRight') $("#n").click();
    };

    if (window.bindSwipeGestures) {
        window.bindSwipeGestures(document.body, {
            onLeft: () => $("#n").click(),
            onRight: () => $("#p").click(),
            getScale: () => scale,
            onSnapBack: () => {
                if (scale === 1.0) {
                    img.dataset.tx = 0;
                    img.dataset.ty = 0;
                    img.style.transition = "transform 0.25s ease-out";
                    img.style.transform = `translate(0px, 0px) scale(1.0)`;
                    setTimeout(() => img.style.transition = "none", 260);
                }
            }
        });
    }

    $$("img").forEach(im => {
        const pop = () => { if (im.src.split("/").pop().startsWith("pano_")) window.open("src/tpl/pano.html?src=" + im.src, "_blank"); };
        im.ondblclick = pop;
        let lastTap = 0;
        im.ontouchend = (e) => { const now = Date.now(); if (now - lastTap < 300) { pop(); e.preventDefault(); } lastTap = now; };
    });

    $("#addbg").addEventListener('click', (e) => {
        e.stopPropagation();
        try {
            let config = store.wallpaper_config || {
                list: [],
                currentIndex: 0,
                mode: 'fixed',
                interval: 3600000,
                layout: 'contain'
            };

            if (!config.list.includes(path)) {
                config.list.push(path);
                store.wallpaper_config = config;
            }
        } catch (err) {
            console.error("添加壁纸失败", err);
        }
    });
};

const videoLogic = function () {
    const store = createStore({ lightbox_stauts: "0" });
    const video = $('#video');
    const path = store.video_path || ("video/" + decodeURIComponent($('#source').src).split("/video/")[1]);
    const videolist = store.videolist || [];
    const idx = videolist.indexOf(path);
    const _cat = path.split(path.split("/").pop())[0].split("video/")[1];
    const category = (!_cat || _cat === "") ? "未分类" : _cat;
    const go = (nPath) => {
        store.video_path = nPath;
        emitEvent("video", null, "index");
        emitEvent("video", "#video a", "side");
    };

    $("#p").onclick = () => go(videolist[(idx - 1 + videolist.length) % videolist.length]);
    $("#n").onclick = () => go(videolist[(idx + 1) % videolist.length]);
    $("#i").innerHTML = `${idx + 1}/${videolist.length}<input style='width:60px' id='jump' onclick='select(this)'>`;
    $("#c").innerHTML = `[${category}]`;

    const sc = $(".span-container");
    if (store.lightbox_stauts === "1") sc.classList.add("hide");
    $("#f").onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== "1" ? "1" : "0";
        store.lightbox_stauts === "1" ? sc.classList.add("hide") : sc.classList.remove("hide");
        emitEvent("lightbox", { status: store.lightbox_stauts }, "index");
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = window.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;

        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== "1") $("#f").click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === "1") $("#f").click();
        }
    };

    const fsBtn = $("#fs");
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    if (window.bindSwipeGestures) {
        window.bindSwipeGestures(document.body, { onLeft: () => $("#n").click(), onRight: () => $("#p").click() });
    }

    $("#jump").onkeypress = (e) => {
        if (e.keyCode === 13) {
            e.preventDefault();
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0 && val <= videolist.length) go(videolist[val - 1]);
        }
    };

    video.volume = 0.2;
    let currentOffset = 0;
    window.adjustDelay = function (seconds) {
        const track = video.textTracks[0];
        if (!track || !track.cues || track.cues.length === 0) return;
        for (let i = 0; i < track.cues.length; i++) {
            track.cues[i].startTime += seconds;
            track.cues[i].endTime += seconds;
        }
        currentOffset += seconds;
        const di = document.getElementById('delay-info');
        if (di) di.innerText = `偏移: ${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(1)}s`;
    };

    document.onkeydown = e => {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();
        if (key === '[') adjustDelay(-0.5);
        else if (key === ']') adjustDelay(0.5);
        else if (key === 'z') $("#p").click();
        else if (key === 'c') $("#n").click();
        else if (e.key === 'ArrowRight' || key === 'd') video.currentTime += 3;
        else if (e.key === 'ArrowLeft' || key === 'a') video.currentTime -= 3;
        else if (e.key === 'ArrowUp' || key === 'w') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }
        else if (e.key === 'ArrowDown' || key === 's') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
        else if (e.code === 'Space' || key === ' ') {
            if (document.activeElement === video) return;
            e.preventDefault();
            video.paused ? video.play() : video.pause();
        } else if (key === 'x') {
            document.fullscreenElement !== video ? video.requestFullscreen() : document.exitFullscreen();
        }
    };
};

function generateDoc(type, payload) {
    const commonStyles = `@charset "UTF-8";@import url("../src/css/font.css");html,body,pre,textarea{font-family:'Noto Serif SC'}html{background-color:#000;touch-action:none;}body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;position:relative;overflow:hidden;touch-action:none;}.span-container{position:absolute;bottom:10px;right:10px;background:plum;z-index:999}.span-container span{margin-bottom:5px;padding:0 10px;cursor:pointer}.hide{opacity:.2!important}#f{display:none}`;

    const baseTag = `<base href="${window.location.href}">`;
    // const viewportMeta = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>`;
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
        if (searchInput) {
            searchInput.setAttribute("title", totalSizeMB + " MB");
        }

        if (totalBytes > alertSizeB) {
            alert("localStorage > " + totalSizeMB + " MB !");
        }
    };
    idleRun(runCheck);
}

async function showChangelog() {
    let popup = $('#changelog-popup');

    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'changelog-popup';
        popup.classList.add('elastic-anim');

        const header = document.createElement('div');
        header.id = 'changelog-header';

        header.innerHTML = `
            <span class="cl-title">What's new?</span>
            <div style="display:flex; align-items:center;">
                <label style="margin-right: 15px; font-size: 12px; color: #555; cursor: pointer; display: flex; align-items: center; white-space: nowrap;">
                    <input type="checkbox" id="auto-show-changelog-cb" style="margin-right: 4px;">更新后自动弹窗
                </label>
                <button id="clear-changelog" class="cl-btn">Clear log</button>
                <button id="close-changelog" class="cl-btn">Close</button>
            </div>
        `;

        const content = document.createElement('div');
        content.id = 'changelog-content';
        popup.append(header, content);
        document.body.appendChild(popup);
        document.getElementById('stage').appendChild(popup);

        const autoShowCb = $('#auto-show-changelog-cb');
        if (store.auto_show_changelog === null || store.auto_show_changelog === undefined) {
            store.auto_show_changelog = "1";
        }
        autoShowCb.checked = store.auto_show_changelog === "1";
        autoShowCb.onchange = (e) => {
            store.auto_show_changelog = e.target.checked ? "1" : "0";
        };

        $('#close-changelog').onclick = () => popup.style.display = 'none';
        $('#clear-changelog').onclick = async () => {
            if (confirm("确定要清空所有更新记录吗？")) {
                await dbProxy.clearLogs();
                $('#changelog-content').innerHTML = '<div style="color: gray;">暂无记录</div>';
            }
        };
        makeDraggable('#changelog-popup', '#changelog-header');

        content.addEventListener('click', (e) => {
            const link = e.target.closest('.log-link');
            if (link) {
                const path = link.dataset.path;
                const bucket = link.dataset.bucket;
                let typeSelector = '';

                if (bucket === 'html') typeSelector = '#html a';
                else if (bucket === 'gallery') typeSelector = '#gallery a';
                else if (bucket === 'video') typeSelector = '#video a';
                else if (bucket === 'audio') typeSelector = '#audio a';
                else if (bucket === 'ebook') typeSelector = '#ebook a';

                if (typeSelector) {
                    emitEvent(typeSelector, path, 'side');
                    emitEvent('show_current', null, 'side');
                }
            }
        });
    }

    popup.style.display = 'flex';

    popup.style.transform = 'none';
    const popupWidth = popup.offsetWidth || 600;
    popup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';

    const content = $('#changelog-content');
    content.innerHTML = '<div style="color: gray;">加载中...</div>';

    try {
        const logs = await dbProxy.getLogs();
        if (logs.length === 0) {
            content.innerHTML = '<div style="color: gray;">暂无记录</div>';
            return;
        }
        logs.sort((a, b) => b.ts - a.ts);

        let html = '';
        let lastTs = null;
        let seenPaths = new Set();

        const privatePaths = new Set();
        if (window.data && window.data.length > 0) {
            // data 结构循环: [title, info, path, type]
            for (let i = 0; i < window.data.length; i += 4) {
                const info = window.data[i + 1];
                const path = window.data[i + 2];
                if (typeof info === 'string' && info.includes('localOnly')) {
                    privatePaths.add(path);
                }
            }
        }

        logs.forEach(log => {
            if (lastTs !== null && (lastTs - log.ts > 60000)) {
                html += `<div style="margin: 4px 0; color: lightgray;overflow: hidden;">------------------------------------------------------------------------------------------------------------------------</div>`;
            }
            lastTs = log.ts;

            const d = new Date(log.ts);
            const dateStr = `[${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;

            let textColor = '#333333';
            let isAddOrUpdate = false;

            if (/删除/.test(log.msg)) {
                textColor = '#cc0000';
            } else if (/新增/.test(log.msg)) {
                textColor = '#008000';
                isAddOrUpdate = true;
            } else if (/更新/.test(log.msg)) {
                textColor = '#0033cc';
                isAddOrUpdate = true;
            }

            let msgHtml = log.msg;

            const match = log.msg.match(/(\/)?(html|gallery|video|audio|ebook)\/(.+)$/);

            if (match) {
                const fullMatch = match[0];
                const bucket = match[2];
                const rawPath = match[3].split('?')[0].trim();
                const cleanPath = `${bucket}/${rawPath}`;
                const isPrivate = privatePaths.has(cleanPath);
                const lockIcon = isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";

                if (!seenPaths.has(cleanPath)) {
                    seenPaths.add(cleanPath);

                    if (isAddOrUpdate) {
                        const displayHtml = lockIcon + fullMatch;
                        const linkHtml = `<span class="log-link" data-path="${cleanPath}" data-bucket="${bucket}" style="cursor: pointer; text-decoration: underline; font-weight: bold;" title="在侧栏中定位并打开">${displayHtml}</span>`;
                        msgHtml = log.msg.replace(fullMatch, linkHtml);
                    } else {
                        if (lockIcon) {
                            msgHtml = log.msg.replace(fullMatch, lockIcon + fullMatch);
                        }
                    }
                } else {
                    if (lockIcon) {
                        msgHtml = log.msg.replace(fullMatch, lockIcon + fullMatch);
                    }
                }
            }
            html += `<div style="color: ${textColor}; margin-bottom: 2px;">${dateStr} ${msgHtml}</div>`;
        });
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div style="color: red;">读取日志失败</div>';
    }
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

function playConfetti() {
    const startAnimation = () => {
        var defaults = {
            spread: 360,
            ticks: 50,
            gravity: 0,
            decay: 0.94,
            startVelocity: 30,
            colors: ['FFE400', 'FFBD00', 'E89400', 'FFCA6C', 'FDFFB8']
        };

        function shoot() {
            confetti({
                ...defaults,
                particleCount: 40,
                scalar: 1.2,
                shapes: ['star']
            });

            confetti({
                ...defaults,
                particleCount: 10,
                scalar: 0.75,
                shapes: ['circle']
            });
        }

        setTimeout(shoot, 0);
        setTimeout(shoot, 100);
        setTimeout(shoot, 200);
    };

    if (window.confetti) {
        startAnimation();
        return;
    }

    const script = document.createElement('script');
    script.src = "src/third/other/confetti.browser.min.js";
    script.onload = () => {
        script.remove();
        startAnimation();
    };
    script.onerror = () => console.warn("confetti.browser.min.js 加载失败");
    document.body.appendChild(script);
}

const PROTOCOL_OPTIONS = [
    { key: 'favList', label: '音乐收藏' },
    { key: 'marks', label: '条目标记' },
    { key: 'last_li_a', label: '导航历史' },
    { key: 'layout', label: '侧栏宽度' },
    { key: 'positions', label: '滚动位置' },
    { key: 'searchHistory', label: '搜索历史' },
    { key: 'pdfjs', label: 'PDF 阅读进度' },
    { key: 'bibi', label: 'EPUB 阅读进度' },
    { key: 'txt', label: 'TXT 阅读进度' },
    { key: 'excerpts', label: '摘抄薄' }
];

const ProtocolUIFactory = {
    create: (config) => {
        const overlay = document.createElement('div');
        overlay.className = 'proto-overlay';

        const box = document.createElement('div');
        box.className = 'proto-box';

        const checkboxesHTML = (config.options || []).map(opt =>
            `<label class="proto-label"><input type="checkbox" checked value="${opt.key}"> ${opt.label}</label>`
        ).join('');

        box.innerHTML = `<h2 class="proto-h2"><span>${config.title}</span></h2>
                         <div class="proto-desc">${config.desc}</div>
                         <div class="proto-list">${checkboxesHTML}</div>
                         <div class="proto-btn-group">${config.buttons}<button class="proto-btn-cancel">返回</button></div>`;

        overlay.appendChild(box);
        document.getElementById('stage').appendChild(overlay);

        const lockButtons = (text) => {
            box.querySelectorAll('button').forEach(btn => {
                btn.disabled = true;
                if (!btn.classList.contains('proto-btn-cancel')) btn.innerText = text;
            });
        };

        const closePanel = () => { overlay.remove(); if (typeof $ !== 'undefined' && $("#searchInput")) $("#searchInput").value = ""; };
        box.querySelector('.proto-btn-cancel').onclick = closePanel;

        if (config.onReady) {
            config.onReady(box, closePanel, lockButtons);
        }
    }
};

const restoreData = async (data, selections) => {
    if (selections.includes('favList') && data.favList !== undefined) store.favList = data.favList;
    if (selections.includes('marks') && data.marks !== undefined) store.ss_marks_lifepod = data.marks;
    if (selections.includes('last_li_a') && data.last_li_a !== undefined) store.last_li_a = data.last_li_a;
    if (selections.includes('layout') && data.layout_content_flex !== undefined) store.layout_content_flex = data.layout_content_flex;
    if (selections.includes('layout') && data.layout_side_flex !== undefined) store.layout_side_flex = data.layout_side_flex;
    if (selections.includes('positions') && data.positions !== undefined) store.positions = data.positions;
    if (selections.includes('searchHistory') && data.searchHistory !== undefined) store.searchHistory = data.searchHistory;
    if (selections.includes('pdfjs') && data['pdfjs.history'] !== undefined) store['pdfjs.history'] = data['pdfjs.history'];
    if (selections.includes('bibi') && data.BibiBiscuits) for (const [k, v] of Object.entries(data.BibiBiscuits)) localStorage.setItem(k, v);
    if (selections.includes('txt') && data.txts) for (const [k, v] of Object.entries(data.txts)) localStorage.setItem(k, v);
    if (selections.includes('excerpts') && data.excerpts_backup !== undefined && typeof ExcerptsSys !== 'undefined') {
        try {
            const db = await ExcerptsSys.init();
            await new Promise((res, rej) => { const txClear = db.transaction(ExcerptsSys.storeName, 'readwrite'); txClear.objectStore(ExcerptsSys.storeName).clear(); txClear.oncomplete = () => res(); txClear.onerror = () => rej(txClear.error); });
            await new Promise((res, rej) => { const txPut = db.transaction(ExcerptsSys.storeName, 'readwrite'); const storePut = txPut.objectStore(ExcerptsSys.storeName); for (const [bookName, bookObj] of Object.entries(data.excerpts_backup)) { storePut.put(bookObj, bookName); } txPut.oncomplete = () => res(); txPut.onerror = () => rej(txPut.error); });
        } catch (err) { console.error("恢复失败: ", err); }
    }
};

function bomb() {
    ProtocolUIFactory.create({
        title: '数据清理',
        desc: `选择需要保留的数据模块，其余将根据操作方案清理。`,
        options: PROTOCOL_OPTIONS,
        buttons: `<button id="btn-plan-a" class="proto-btn btn-warn">保留所选，清理其余</button><button id="btn-plan-b" class="proto-btn btn-info">导出所选，全部清理</button><button id="btn-plan-c" class="proto-btn btn-danger">全部清理</button>`,
        onReady: (box, closePanel, lockButtons) => {
            const doWipe = async () => {
                localStorage.clear(); sessionStorage.clear();
                document.cookie.split(";").forEach(c => document.cookie = `${c.split("=")[0].trim()}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`);
                const clearTasks = [];
                if (window.indexedDB && indexedDB.databases) {
                    clearTasks.push(indexedDB.databases().then(dbs => Promise.all(dbs.map(db => new Promise(res => {
                        const r = indexedDB.deleteDatabase(db.name); r.onsuccess = res; r.onerror = res; r.onblocked = res;
                    })))).catch(() => { }));
                }
                if ('caches' in window) clearTasks.push(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
                if ('serviceWorker' in navigator) clearTasks.push(navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
                await Promise.all(clearTasks);
                await new Promise(resolve => setTimeout(resolve, 300));
            };

            const getSelectedData = async (selections) => {
                let data = { timestamp: Date.now() };
                if (selections.includes('favList')) data.favList = store.favList || [];
                if (selections.includes('marks')) {
                    let marksArray = [];
                    try {
                        if (iframes.side && iframes.side.contentWindow && iframes.side.contentWindow.MarkSystem) {
                            marksArray = Array.from(iframes.side.contentWindow.MarkSystem.urls);
                        }
                    } catch (e) {
                        console.warn("无法穿透获取 Mark 数据", e);
                    }
                    data.marks = marksArray;
                }
                if (selections.includes('last_li_a')) data.last_li_a = store.last_li_a || [];
                if (selections.includes('layout')) { data.layout_content_flex = store.layout_content_flex; data.layout_side_flex = store.layout_side_flex; }
                if (selections.includes('positions')) data.positions = store.positions || {};
                if (selections.includes('searchHistory')) data.searchHistory = store.searchHistory || [];
                if (selections.includes('pdfjs')) data['pdfjs.history'] = store['pdfjs.history'] || {};
                if (selections.includes('bibi')) { data.BibiBiscuits = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('BibiBiscuit')) data.BibiBiscuits[k] = localStorage.getItem(k); } }
                if (selections.includes('txt')) { data.txts = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('txt.history')) data.txts[k] = localStorage.getItem(k); } }
                if (selections.includes('excerpts') && typeof ExcerptsSys !== 'undefined') { data.excerpts_backup = {}; try { const booksMeta = await ExcerptsSys.getAllBooks(); await Promise.all(booksMeta.map(async (b) => { const bData = await ExcerptsSys.getBookData(b.name); data.excerpts_backup[b.name] = bData; })); } catch (err) { console.error("摘抄备份异常: ", err); } }
                return data;
            };

            box.querySelector('#btn-plan-a').onclick = async () => {
                window._isBombing = true; lockButtons("正在保存选中数据...");
                const selections = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
                const backupData = await getSelectedData(selections);
                await doWipe();
                const mockSelections = Object.keys(backupData).map(k => {
                    if (k === 'BibiBiscuits') return 'bibi';
                    if (k === 'txts') return 'txt';
                    if (k === 'excerpts_backup') return 'excerpts';
                    return k;
                });
                await restoreData(backupData, mockSelections);
                if (typeof takeSnapshot === 'function') takeSnapshot(true); else window.location.reload();
            };

            box.querySelector('#btn-plan-b').onclick = async () => {
                window._isBombing = true; lockButtons("正在导出...");
                const selections = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
                const backupData = await getSelectedData(selections);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' }));
                a.download = `backup_${Date.now()}.json`;
                document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
                setTimeout(async () => { lockButtons("执行清理..."); await doWipe(); window.location.reload(); }, 1500);
            };

            box.querySelector('#btn-plan-c').onclick = async () => {
                window._isBombing = true; lockButtons("正在清理...");
                await doWipe(); window.location.reload();
            };
        }
    });
}

function rebirth() {
    ProtocolUIFactory.create({
        title: '数据恢复',
        desc: '请选择备份文件，系统将识别并恢复所选模块。',
        options: [],
        buttons: `
            <button id="btn-file-select" class="proto-btn">选择文件</button>
            <input type="file" id="rebirth-file" accept=".json" style="display:none;">
            <button id="btn-exec-rebirth" class="proto-btn btn-warn" disabled>执行恢复</button>
        `,
        onReady: (box, closePanel, lockButtons) => {
            const fileInput = box.querySelector('#rebirth-file');
            const listArea = box.querySelector('.proto-list');
            const execBtn = box.querySelector('#btn-exec-rebirth');
            let loadedData = null;

            box.querySelector('#btn-file-select').onclick = () => fileInput.click();

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        loadedData = JSON.parse(event.target.result);
                        listArea.innerHTML = ''; // 清空提示

                        PROTOCOL_OPTIONS.forEach(opt => {
                            let hasData = false;
                            switch (opt.key) {
                                case 'favList': hasData = loadedData.favList !== undefined; break;
                                case 'marks': hasData = loadedData.marks !== undefined; break;
                                case 'last_li_a': hasData = loadedData.last_li_a !== undefined; break;
                                case 'layout': hasData = loadedData.layout_content_flex !== undefined; break;
                                case 'positions': hasData = loadedData.positions !== undefined; break;
                                case 'searchHistory': hasData = loadedData.searchHistory !== undefined; break;
                                case 'pdfjs': hasData = loadedData['pdfjs.history'] !== undefined; break;
                                case 'bibi': hasData = !!loadedData.BibiBiscuits; break;
                                case 'txt': hasData = !!loadedData.txts; break;
                                case 'excerpts': hasData = !!loadedData.excerpts_backup; break;
                            }
                            if (hasData) {
                                listArea.insertAdjacentHTML('beforeend', `<label class="proto-label"><input type="checkbox" checked value="${opt.key}"> ${opt.label}</label>`);
                            }
                        });

                        if (listArea.innerHTML === '') listArea.innerHTML = '<div style="color:red; font-size:12px;">未识别到有效数据模块</div>';
                        else execBtn.disabled = false;
                    } catch (err) { alert("文件解析失败"); }
                };
                reader.readAsText(file);
            };

            execBtn.onclick = async () => {
                const selections = Array.from(box.querySelectorAll('input:checked')).map(cb => cb.value);
                if (selections.length === 0) return;
                lockButtons("恢复中...");
                if (typeof $ !== 'undefined' && $("#clear")) $("#clear").click();
                await restoreData(loadedData, selections);
                if (typeof takeSnapshot === 'function') takeSnapshot(true); else window.location.reload();
            };
        }
    });
}

function initBackupReminder() {
    const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

    const checkBackupStatus = async () => {
        const lastBackupStr = localStorage.getItem('last_backup_timestamp');
        const now = Date.now();

        if (!lastBackupStr) {
            localStorage.setItem('last_backup_timestamp', now.toString());
            return;
        }

        if (now - parseInt(lastBackupStr, 10) > BACKUP_INTERVAL_MS) {
            if (confirm("距离上次备份已超过 7 天。\n是否重新下载备份？")) {

                await (async function () {
                    let data = { timestamp: Date.now() };

                    data.favList = store.favList || [];
                    data.last_li_a = store.last_li_a || [];
                    data.layout_content_flex = store.layout_content_flex;
                    data.layout_side_flex = store.layout_side_flex;
                    data.positions = store.positions || {};
                    data.searchHistory = store.searchHistory || [];
                    data['pdfjs.history'] = store['pdfjs.history'] || {};

                    let marksArray = [];
                    try {
                        if (iframes.side && iframes.side.contentWindow && iframes.side.contentWindow.MarkSystem) {
                            marksArray = Array.from(iframes.side.contentWindow.MarkSystem.urls);
                        }
                    } catch (e) {
                        console.warn("自动备份: 无法穿透获取 Mark 数据", e);
                    }
                    data.marks = marksArray;

                    data.BibiBiscuits = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        let k = localStorage.key(i);
                        if (k.startsWith('BibiBiscuit')) data.BibiBiscuits[k] = localStorage.getItem(k);
                    }

                    data.txts = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        let k = localStorage.key(i);
                        if (k.startsWith('txt.history')) data.txts[k] = localStorage.getItem(k);
                    }

                    if (typeof ExcerptsSys !== 'undefined') {
                        data.excerpts_backup = {};
                        try {
                            const booksMeta = await ExcerptsSys.getAllBooks();
                            await Promise.all(booksMeta.map(async (b) => {
                                const bData = await ExcerptsSys.getBookData(b.name);
                                data.excerpts_backup[b.name] = bData;
                            }));
                        } catch (err) {
                            console.error("自动备份: 摘抄备份异常", err);
                        }
                    }

                    const a = document.createElement('a');
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    a.href = URL.createObjectURL(blob);
                    a.download = `backup_${Date.now()}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(a.href);
                })();

                localStorage.setItem('last_backup_timestamp', now.toString());

            } else {
                const delayOneDay = now - BACKUP_INTERVAL_MS + 24 * 60 * 60 * 1000;
                localStorage.setItem('last_backup_timestamp', delayOneDay.toString());
            }
        }
    };

    setTimeout(checkBackupStatus, 5000);

    if (typeof safeInterval === 'function') {
        safeInterval(checkBackupStatus, 24 * 60 * 60 * 1000);
    }
}

const ExcerptsSys = {
    dbName: 'ExcerptsDB',
    storeName: 'books',
    init: async function () {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(this.storeName);
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        });
    },
    save: async function (bookName, text) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(bookName);

            getReq.onsuccess = () => {
                let record = getReq.result;
                const now = Date.now();
                if (!record) {
                    record = { createdAt: now, updatedAt: now, excerpts: [] };
                }
                const newId = record.excerpts.length > 0 ? record.excerpts[record.excerpts.length - 1].id + 1 : 1;
                record.excerpts.push({ id: newId, text: text, ts: now });
                record.updatedAt = now;
                const putReq = store.put(record, bookName);
                putReq.onerror = () => reject(putReq.error);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    getAllBooks: async function () {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.getAllKeys();
            req.onsuccess = async () => {
                const keys = req.result;
                const books = [];
                for (let key of keys) {
                    const data = await new Promise(res => {
                        const r = store.get(key);
                        r.onsuccess = () => res(r.result);
                    });
                    if (data) {
                        books.push({ name: key, createdAt: data.createdAt, updatedAt: data.updatedAt, count: data.excerpts.length });
                    }
                }
                resolve(books);
            };
            req.onerror = () => reject(req.error);
        });
    },
    getBookData: async function (bookName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(bookName);
            req.onsuccess = () => resolve(req.result || { excerpts: [] });
            req.onerror = () => reject(req.error);
        });
    },
    overwriteBook: async function (bookName, excerptsArray) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(bookName);
            getReq.onsuccess = () => {
                let record = getReq.result;
                if (record) {
                    record.excerpts = excerptsArray;
                    record.updatedAt = Date.now();
                    const putReq = store.put(record, bookName);
                    putReq.onerror = () => reject(putReq.error);
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    deleteBook: async function (bookName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(bookName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
};
const ExcerptsUIManager = {
    currentBook: null,
    allBooksCache: [],
    sortConfig: { type: 'updated', asc: false },

    initPanel: function () {
        if (document.getElementById('excerpts-popup')) return;

        const html = `
        <div id="excerpts-popup" class="elastic-anim" style="display:none; position:absolute; top:10%; left:50%; transform:translateX(-50%); width:800px; max-width:90%; box-sizing:border-box; height:800px; background:#fff; border:1px solid #333; box-shadow:0 5px 20px rgba(0,0,0,0.3); z-index:10001; flex-direction:column; border-radius:4px; overflow:hidden;">
            <div id="excerpts-header" style="height:35px; background:#eee; cursor:move; display:flex; justify-content:space-between; align-items:center; padding:0 15px; flex-shrink:0; border-bottom:1px solid #ccc; user-select:none; font-size:14px; color:#333;">
                <span class="cl-title" style="color: red;">Excerpts</span>
                <div><button id="close-excerpts" class="cl-btn" style="margin-left: 10px; cursor: pointer; padding: 1px 6px;">Close</button></div>
            </div>
            
            <div style="flex:1; display:flex; overflow:hidden; background:#f8fafc;">
                <div style="width:240px; border-right:1px solid #e2e8f0; display:flex; flex-direction:column; padding:5px; gap:10px; flex-shrink:0; background:antiquewhite;">
                    <input type="text" id="exc-search" placeholder="搜索过滤键名..." style="width:100%; padding:6px 10px; border:1px solid #cbd5e1; box-sizing:border-box; outline:none; font-size:12px; background:#fff;">
                    <div style="display:flex; gap:6px;">
                        <button id="sort-create" style="flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #cbd5e1; border-radius:4px; cursor:pointer; color:#64748b;">创建时间</button>
                        <button id="sort-update" style="flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #10b981; border-radius:4px; cursor:pointer; font-weight:bold; color:#10b981;">修改时间 ▽</button>
                    </div>
                    <div id="exc-book-list" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:5px; margin-top:4px; padding-right:2px;"></div>
                </div>
                
                <div id="exc-records-zone" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; background:#fff;">
                    <div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px; letter-spacing:0.5px;">请在左侧选择一个摘抄薄查看明细</div>
                </div>
            </div>
            
            <div style="background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; align-items:center; justify-content:flex-end; flex-shrink:0;">
                <button id="exc-btn-save">应用修改</button>
                <button id="exc-btn-save-and-copy">应用修改然后复制</button>
            </div>
        </div>`;

        document.getElementById('stage').insertAdjacentHTML('beforeend', html);
        this.bindPanelEvents();
    },

    bindPanelEvents: function () {
        const popup = document.getElementById('excerpts-popup');
        const searchInput = document.getElementById('exc-search');

        makeDraggable("#excerpts-popup", "#excerpts-header");

        document.getElementById('close-excerpts').onclick = () => popup.style.display = "none";
        searchInput.oninput = () => this.renderLeftList();

        document.getElementById('sort-create').onclick = () => this.toggleSort('created');
        document.getElementById('sort-update').onclick = () => this.toggleSort('updated');

        document.getElementById('exc-btn-save').onclick = async () => {
            if (!this.currentBook) return alert("当前未选中任何摘抄表");

            const items = document.querySelectorAll('.exc-item-text');
            const updatedExcerpts = [];
            items.forEach(el => {
                const id = parseInt(el.dataset.id);
                const text = el.value.trim();
                if (text) {
                    updatedExcerpts.push({ id, text, ts: Date.now() });
                }
            });
            await ExcerptsSys.overwriteBook(this.currentBook, updatedExcerpts);

            const data = await ExcerptsSys.getBookData(this.currentBook);
            if (!data.excerpts || data.excerpts.length === 0) {
                this.openAndRefresh();
                return;
            }
        };

        document.getElementById('exc-btn-save-and-copy').onclick = async () => {
            if (!this.currentBook) return alert("当前未选中任何摘抄表");

            const items = document.querySelectorAll('.exc-item-text');
            const updatedExcerpts = [];
            items.forEach(el => {
                const id = parseInt(el.dataset.id);
                const text = el.value.trim();
                if (text) {
                    updatedExcerpts.push({ id, text, ts: Date.now() });
                }
            });
            await ExcerptsSys.overwriteBook(this.currentBook, updatedExcerpts);

            const data = await ExcerptsSys.getBookData(this.currentBook);
            if (!data.excerpts || data.excerpts.length === 0) {
                this.openAndRefresh();
                return;
            }

            const textToCopy = data.excerpts.map(e => e.text.trim()).join('\n\n\n');

            navigator.clipboard.writeText(textToCopy).then(() => {
                this.openAndRefresh();
            }).catch(() => {
                alert("写入剪贴板失败，请检查浏览器权限。");
            });
        };
    },

    toggleSort: function (type) {
        if (this.sortConfig.type === type) {
            this.sortConfig.asc = !this.sortConfig.asc;
        } else {
            this.sortConfig.type = type;
            this.sortConfig.asc = false;
        }

        const cBtn = document.getElementById('sort-create');
        const uBtn = document.getElementById('sort-update');
        cBtn.style.cssText = uBtn.style.cssText = "flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #cbd5e1; border-radius:4px; cursor:pointer; color:#64748b;";

        const activeBtn = type === 'created' ? cBtn : uBtn;
        activeBtn.style.cssText = "flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #10b981; color:#10b981; font-weight:bold; border-radius:4px; cursor:pointer;";
        activeBtn.textContent = (type === 'created' ? '创建时间 ' : '修改时间 ') + (this.sortConfig.asc ? '▲' : '▽');

        this.renderLeftList();
    },

    openAndRefresh: async function () {
        this.initPanel();

        const excPopup = document.getElementById('excerpts-popup');
        excPopup.style.display = "flex";

        excPopup.style.transform = 'none';
        const popupWidth = excPopup.offsetWidth || 800;
        excPopup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';
        this.allBooksCache = await ExcerptsSys.getAllBooks();

        if (
            this.currentBook &&
            !this.allBooksCache.some(b => b.name === this.currentBook)
        ) {
            this.currentBook = null;
        }
        this.renderLeftList();

        if (this.currentBook) {
            await this.renderRightRecords();
        } else {
            document.getElementById('exc-records-zone').innerHTML = `
                <div style="
                    color:#94a3b8;
                    text-align:center;
                    margin-top:25vh;
                    font-size:13px;
                    letter-spacing:0.5px;
                ">
                    请在左侧选择一个摘抄薄查看明细
                </div>
            `;
        }
    },

    renderLeftList: function () {
        const listContainer = document.getElementById('exc-book-list');
        const filterKw = document.getElementById('exc-search').value.toLowerCase().trim();
        listContainer.innerHTML = '';

        let filtered = this.allBooksCache.filter(b => b.name.toLowerCase().includes(filterKw));

        filtered.sort((a, b) => {
            const field = this.sortConfig.type === 'created' ? 'createdAt' : 'updatedAt';
            return this.sortConfig.asc ? a[field] - b[field] : b[field] - a[field];
        });

        filtered.forEach(book => {
            const item = document.createElement('div');
            item.className = 'exc-book-item-row';
            item.style.cssText = `
                background:#fff; border:1px solid #e2e8f0;
                cursor:pointer; font-size:12px; display:flex; align-items:center;
                transition:all 0.15s; gap:6px; position:relative; overflow:hidden;
            `;
            if (this.currentBook === book.name) {
                item.style.borderColor = '#10b981';
                item.style.background = '#e8fbf3';
                item.style.fontWeight = 'bold';
            }

            const delAction = document.createElement('button');
            delAction.innerHTML = '✕';
            delAction.style.cssText = "background:transparent; border:none; color:#f87171; cursor:pointer; font-size:11px; padding:2px 4px; font-weight:bold; border-radius:3px; display:none; transition: all 0.15s; flex-shrink:0; line-height:1;";
            delAction.onmouseover = () => delAction.style.background = '#fee2e2';
            delAction.onmouseout = () => delAction.style.background = 'transparent';

            delAction.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`此操作不可逆, 确定要删除 [${book.name}] 的相关摘抄吗？`)) {
                    await ExcerptsSys.deleteBook(book.name);
                    if (this.currentBook === book.name) this.currentBook = null;
                    this.openAndRefresh();
                }
            };

            const labelZone = document.createElement('div');
            labelZone.style.cssText = "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; justify-content:space-between; align-items:center; gap:6px;";
            labelZone.innerHTML = `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;padding:6px 8px;" title="${book.name}">${book.name}</span><span style="background:#f1f5f9; padding:1px 5px; border-radius:8px; font-size:10px; color:#64748b; font-weight:normal; flex-shrink:0;">${book.count}</span>`;

            const handleItemSelect = () => {
                this.currentBook = book.name;
                this.renderLeftList();
                this.renderRightRecords();
            };
            labelZone.onclick = handleItemSelect;

            item.onmouseenter = () => delAction.style.display = 'inline-block';
            item.onmouseleave = () => delAction.style.display = 'none';

            item.append(labelZone, delAction);
            listContainer.appendChild(item);
        });
    },

    renderRightRecords: async function () {
        const zone = document.getElementById('exc-records-zone');
        zone.innerHTML = '<div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px;">加载条目中...</div>';

        const data = await ExcerptsSys.getBookData(this.currentBook);
        zone.innerHTML = '';

        if (!data.excerpts || data.excerpts.length === 0) {
            zone.innerHTML = '<div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px;">当前摘抄薄空空如也</div>';
            return;
        }

        data.excerpts.forEach(item => {
            const row = document.createElement('div');
            row.style.cssText = "position:relative; display:flex; align-items:flex-start; transition:all 0.2s; padding:0; margin:0 0 2rem 0; border-bottom:1px dashed #cbd5e1;";

            const idLabel = document.createElement('div');
            idLabel.style.cssText = "width:32px; height:22px; background:#f1f5f9; color:#64748b; text-align:center; border-radius:4px; font-size:11px; font-weight:bold; font-family:monospace; flex-shrink:0; cursor:default; transition:all 0.2s; line-height:22px; margin: 3px 0px 0px 10px";
            idLabel.textContent = item.id;
            idLabel.title = "点击移除该记录";

            idLabel.onmouseenter = () => {
                idLabel.dataset.orig = idLabel.textContent;
                idLabel.textContent = "✕";
                idLabel.style.color = "#ef4444";
                idLabel.style.background = "#fee2e2";
                idLabel.style.cursor = "pointer";
            };
            idLabel.onmouseleave = () => {
                idLabel.textContent = idLabel.dataset.orig;
                idLabel.style.color = "#64748b";
                idLabel.style.background = "#f1f5f9";
                idLabel.style.cursor = "default";
            };
            idLabel.onclick = () => row.remove();

            const textarea = document.createElement('textarea');
            textarea.className = 'exc-item-text';
            textarea.dataset.id = item.id;
            textarea.value = item.text;

            textarea.style.cssText = "flex:1; border:none; border-radius:0; padding:0 0 0 15px; margin:0; font-size:14px; color:#334155; resize:none; overflow:hidden; outline:none; line-height:1.7; background:transparent; font-family:inherit; display:block;";

            textarea.onfocus = () => { row.style.borderBottomColor = '#10b981'; };
            textarea.onblur = () => { row.style.borderBottomColor = '#cbd5e1'; };

            const adjustHeight = function () {
                this.style.height = '1px';
                this.style.height = this.scrollHeight + 'px';
            };

            textarea.addEventListener('input', adjustHeight);
            setTimeout(() => adjustHeight.call(textarea), 0);

            row.append(textarea, idLabel);
            zone.appendChild(row);
        });
    }
};

function showGlobalBookmarkMenu(x, y, source) {
    let absoluteX = x;
    let absoluteY = y;

    if (source === 'side' && $('#side')) {
        const sideRect = $('#side').getBoundingClientRect();
        absoluteX += sideRect.left;
        absoluteY += sideRect.top;
    }

    let menu = document.getElementById('global-bookmark-menu');
    if (menu) menu.remove();

    menu = document.createElement('div');
    menu.id = 'global-bookmark-menu';

    menu.style.cssText = `position: fixed; z-index: 100000; background: rgb(51 51 51); border-radius: 4px; box-shadow: rgba(0, 0, 0, 0.4) 0px 4px 12px; display: flex; flex-direction: column; overflow-y: auto; min-width: 150px; visibility: visible; left: 1007.27px; top: 1.5px;`;

    const links = store.bookmark_links || [];
    if (links.length === 0) {
        return;
    } else {
        links.forEach(item => {
            const a = document.createElement("a");
            a.href = item.href;
            a.target = item.target || "_blank";
            a.textContent = item.text;
            a.style.cssText = `
                display: block; padding: 4px 16px; color: #f8fafc; text-decoration: none;
                white-space: nowrap; transition: background 0.2s; cursor: pointer;
            `;
            a.onmouseenter = () => a.style.background = '#555';
            a.onmouseleave = () => a.style.background = 'transparent';
            menu.appendChild(a);
        });
    }

    document.body.appendChild(menu);
    let hoverCloseTimer = null;

    menu.addEventListener('mouseenter', () => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    });

    menu.addEventListener('mouseleave', () => {
        hoverCloseTimer = setTimeout(() => {
            if (menu && document.body.contains(menu)) {
                menu.remove();

                document.removeEventListener('click', closeMenu);
                window._closeGlobalMenu = null;
            }
        }, 500);
    });

    let menuWidth = menu.offsetWidth;
    let menuHeight = menu.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (menuHeight > viewportHeight) {
        menu.style.maxHeight = viewportHeight + 'px';
        menuHeight = viewportHeight;
    }

    let targetLeft = absoluteX - menuWidth / 2;
    let targetTop = absoluteY;

    if (targetLeft < 0) {
        targetLeft = 0;
    }
    if (targetTop < 0) {
        targetTop = 0;
    } else if (targetTop + menuHeight > viewportHeight) {
        targetTop = viewportHeight - menuHeight;
    }

    menu.style.left = targetLeft + 'px';
    menu.style.top = targetTop + 'px';
    menu.style.visibility = 'visible';

    const closeMenu = (ev) => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }

        if (menu && ev && !menu.contains(ev.target)) {
            menu.remove();
        } else if (menu && !ev) {
            menu.remove();
        }

        document.removeEventListener('click', closeMenu);
        window._closeGlobalMenu = null;
    };
}

function initDueTasksPingPong() {
    const JSON_URL = '/_build/secrets/upcoming_tasks.json';
    const CHECK_INTERVAL = 5 * 60 * 1000;
    const SNOOZE_KEY = 'task_snooze_until';

    let bounceTimer = null;
    let initialized = false;

    const box = document.createElement('div');
    box.id = 'task-pingpong-box';
    box.innerHTML = `
        <button class="close-btn" title="暂时屏蔽15分钟">×</button>
        <h3>⚠️ 任务到期</h3>
        <ul id="task-pingpong-list"></ul>
    `;
    document.body.appendChild(box);

    const closeBtn = box.querySelector('.close-btn');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const snoozeUntil = Date.now() + 15 * 60 * 1000;
        localStorage.setItem(SNOOZE_KEY, snoozeUntil);
        stopAnimation();
        box.style.display = 'none';
    });

    box.addEventListener('mouseenter', () => {
        stopAnimation();
    });

    box.addEventListener('mouseleave', () => {
        if (box.style.display === 'block') {
            startAnimation();
        }
    });

    const MOVE_SPEED = 0.2;
    let posX = 0, posY = 0;
    let vx = MOVE_SPEED, vy = MOVE_SPEED;

    function startAnimation() {
        if (bounceTimer) return;
        box.style.display = 'block';

        if (!initialized) {
            const maxX = window.innerWidth - box.offsetWidth;
            const maxY = window.innerHeight - box.offsetHeight;
            posX = maxX / 2;
            posY = maxY / 2;
            initialized = true;
        }

        function frame() {
            const currentMaxX = window.innerWidth - box.offsetWidth;
            const currentMaxY = window.innerHeight - box.offsetHeight;
            posX += vx;
            posY += vy;

            if (posX <= 0) {
                posX = 0;
                vx = -vx;
            } else if (posX >= currentMaxX) {
                posX = currentMaxX;
                vx = -vx;
            }

            if (posY <= 0) {
                posY = 0;
                vy = -vy;
            } else if (posY >= currentMaxY) {
                posY = currentMaxY;
                vy = -vy;
            }

            box.style.left = posX + 'px';
            box.style.top = posY + 'px';
            bounceTimer = requestAnimationFrame(frame);
        }

        bounceTimer = requestAnimationFrame(frame);
    }

    function stopAnimation() {
        if (bounceTimer) {
            cancelAnimationFrame(bounceTimer);
            bounceTimer = null;
        }
    }

    async function checkTasks() {
        const snoozeTime = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
        if (Date.now() < snoozeTime) return;

        try {
            const response = await fetch(JSON_URL + '?t=' + Date.now(), { cache: 'no-store' });
            if (!response.ok) return;

            const tasks = await response.json();
            const listContainer = document.getElementById('task-pingpong-list');

            if (Array.isArray(tasks) && tasks.length > 0) {
                listContainer.innerHTML = tasks.map(t => {
                    const dueDateStr = t.due ? t.due.split('T')[0] : '无截止时间';
                    return `<li>${t.title} <span style="font-size:11px;opacity:0.9;">(${dueDateStr})</span></li>`;
                }).join('');

                box.style.display = 'block';
                if (!bounceTimer) startAnimation();
            } else {
                stopAnimation();
                box.style.display = 'none';
            }
        } catch (err) {
            console.warn('获取任务 JSON 失败:', err);
        }
    }

    setInterval(checkTasks, CHECK_INTERVAL);
    checkTasks();
}

(function () {
    'use strict';
    const isMobile = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isMobile) return;

    const TAP_MOVE_THRESHOLD = 8;
    const DOUBLE_TAP_WINDOW = 300;
    const DOUBLE_TAP_DIST = 30;
    const MOVE_SENSITIVITY = 1.1;
    const MIN_ZOOM = 1, MAX_ZOOM = 3;

    document.body.classList.add('touchpad-active');

    const stage = document.getElementById('stage');
    const contentFrame = document.getElementById('content');
    const sideFrame = document.getElementById('side');
    if (!stage || !contentFrame) return;

    stage.style.transformOrigin = '0 0';

    const panel = document.getElementById('touchpad-panel') || (() => {
        const p = document.createElement('div');
        p.id = 'touchpad-panel';
        document.body.appendChild(p);
        return p;
    })();

    panel.innerHTML = `
    <div class="tp-col-scroll" style="width: 15%; min-width: 50px; display: flex; flex-direction: column;">
        <div class="tp-btn tp-scroll-btn" data-scroll="-160" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:var(--tp-accent); font-weight:bold;">▲</div>
        <div class="tp-btn tp-scroll-btn" data-scroll="160" style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--tp-accent); font-weight:bold;">▼</div>
    </div>
    <div class="tp-col-move" style="touch-action: none;"></div>
    <div class="tp-col-zoom" style="width: 15%; min-width: 50px; display: flex; flex-direction: column; border-right: 1px solid var(--tp-line); border-left: 1px solid var(--tp-line);">
        <div class="tp-btn" data-btn="zoom_in" style="flex:1; font-size:18px!important; font-weight:bold; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">+</div>
        <div class="tp-btn" data-btn="zoom_out" style="flex:1; font-size:18px!important; font-weight:bold; display:flex; align-items:center; justify-content:center; color:#cfd3dc;">-</div>
    </div>
    <div class="tp-col-buttons" style="width: 20%; min-width: 64px; display: flex; flex-direction: column;">
        <div class="tp-btn" data-btn="select_toggle" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">框选</div>
        <div class="tp-btn" data-btn="drag_toggle" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">拖拽</div>
        <div class="tp-btn" data-btn="dblclick" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">左双击</div>
        <div class="tp-btn" data-btn="auxclick" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">中击</div>
        <div class="tp-btn" data-btn="contextmenu" style="flex:1; display:flex; align-items:center; justify-content:center; color:#cfd3dc;">右击</div>
        <div class="tp-btn" data-btn="toggle_log" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">日志</div>
    </div>
    `;

    const colMove = panel.querySelector('.tp-col-move');
    const btns = panel.querySelectorAll('[data-btn]');

    const cursorEl = document.createElement('div');
    cursorEl.id = 'tp-cursor';
    document.body.appendChild(cursorEl);

    const cursor = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    let zoom = 1, panX = 0, panY = 0;
    let currentTargetId = null;
    let isSelectMode = false;
    let cursorFeedbackTimer = null;

    function playCursorClickFeedback() {
        if (!cursorEl) return;
        cursorEl.classList.remove('tp-cursor-click', 'tp-cursor-down');
        void cursorEl.offsetWidth; // force reflow so animation restarts
        cursorEl.classList.add('tp-cursor-down');
        clearTimeout(cursorFeedbackTimer);
        cursorFeedbackTimer = setTimeout(() => {
            cursorEl.classList.remove('tp-cursor-down');
            cursorEl.classList.add('tp-cursor-click');
            setTimeout(() => cursorEl.classList.remove('tp-cursor-click'), 340);
        }, 90);
    }

    function applyTransform() {
        const transformStr = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        stage.style.transformOrigin = '0 0';
        stage.style.transform = transformStr;
    }

    function doZoom(delta) {
        const oldZoom = zoom;
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
        window._tpZoom = zoom;
        if (zoom === oldZoom) return;

        panX = (window.innerWidth / 2) - cursor.x * zoom;
        panY = (stage.clientHeight / 2) - cursor.y * zoom;

        clampPan();
        applyTransform();
        updateCursorVisual();
    }

    function clampCursor() {
        cursor.x = Math.max(0, Math.min(stage.clientWidth - 1, cursor.x));
        cursor.y = Math.max(0, Math.min(stage.clientHeight - 1, cursor.y));
    }

    function clampPan() {
        const vw = window.innerWidth, vh = stage.clientHeight;
        const scaledW = stage.clientWidth * zoom;
        const scaledH = stage.clientHeight * zoom;
        const minPanX = Math.min(0, vw - scaledW);
        const minPanY = Math.min(0, vh - scaledH);
        panX = Math.max(minPanX, Math.min(0, panX));
        panY = Math.max(minPanY, Math.min(0, panY));
    }

    function logicalToScreen(lx, ly) {
        const r = stage.getBoundingClientRect();
        return { x: r.left + lx * zoom, y: r.top + ly * zoom };
    }

    function updateCursorVisual() {
        const p = logicalToScreen(cursor.x, cursor.y);
        cursorEl.style.left = p.x + 'px';
        cursorEl.style.top = p.y + 'px';
    }

    function resolveHit(lx, ly) {
        const s = logicalToScreen(lx, ly);
        // elementFromPoint() returns null for points on/outside the viewport boundary.
        // Clamp defensively so an edge-pinned cursor still resolves to the element under it.
        const px = Math.max(0, Math.min(window.innerWidth - 1, s.x));
        const py = Math.max(0, Math.min(document.documentElement.clientHeight - 1, s.y));
        const topEl = document.elementFromPoint(px, py);
        if (!topEl) return { kind: 'none' };

        if (topEl === contentFrame) {
            return { kind: 'frame', id: 'content', x: lx - contentFrame.offsetLeft, y: ly - contentFrame.offsetTop };
        }
        if (sideFrame && topEl === sideFrame) {
            return { kind: 'frame', id: 'side', x: lx - sideFrame.offsetLeft, y: ly - sideFrame.offsetTop };
        }
        return { kind: 'local', el: topEl, screenX: s.x, screenY: s.y };
    }

    function sendToFrame(frameId, op, x, y, extra) {
        const payload = Object.assign({ op, x, y }, extra);
        try {
            if (frameId === 'content' && contentFrame.contentWindow && contentFrame.contentWindow.handleSimPointer) {
                contentFrame.contentWindow.handleSimPointer(payload);
            } else if (frameId === 'side' && sideFrame.contentWindow && sideFrame.contentWindow.handleSimPointer) {
                sideFrame.contentWindow.handleSimPointer(payload);
            } else {
                emitEvent('SIM_POINTER', payload, frameId);
            }
        } catch (e) {
            emitEvent('SIM_POINTER', payload, frameId);
        }
    }

    let localHoverEl = null;
    function getAncestors(el) {
        const chain = [];
        let cur = el;
        while (cur) { chain.push(cur); cur = cur.parentElement; }
        return chain;
    }
    const FOCUSABLE_SEL = 'input,textarea,select,[contenteditable],[contenteditable="true"]';
    function maybeFocus(el) {
        if (!el || typeof el.focus !== 'function') return;
        if ((el.matches && el.matches(FOCUSABLE_SEL)) || el.tabIndex >= 0) {
            el.focus({ preventScroll: true });
        }
    }

    function updateLocalHover(newEl, base) {
        if (newEl === localHoverEl) return;
        const oldChain = localHoverEl ? getAncestors(localHoverEl) : [];
        const newChain = getAncestors(newEl);
        const oldSet = new Set(oldChain);
        let common = null;
        for (const el of newChain) { if (oldSet.has(el)) { common = el; break; } }

        if (localHoverEl) {
            localHoverEl.dispatchEvent(new MouseEvent('mouseout', Object.assign({}, base, { relatedTarget: newEl })));
            for (const el of oldChain) {
                if (el === common) break;
                el.dispatchEvent(new MouseEvent('mouseleave', Object.assign({}, base, { bubbles: false, relatedTarget: newEl })));
            }
        }
        newEl.dispatchEvent(new MouseEvent('mouseover', Object.assign({}, base, { relatedTarget: localHoverEl || null })));
        const toEnter = [];
        for (const el of newChain) { if (el === common) break; toEnter.push(el); }
        toEnter.reverse().forEach(el => {
            el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, base, { bubbles: false, relatedTarget: localHoverEl || null })));
        });
        localHoverEl = newEl;
    }

    function clearLocalHover() {
        if (!localHoverEl) return;
        const chain = getAncestors(localHoverEl);
        localHoverEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: null }));
        chain.forEach(a => {
            a.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, relatedTarget: null }));
        });
        localHoverEl = null;
    }

    function dispatchLocal(op, el, screenX, screenY, extra) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: screenX, clientY: screenY };
        const fire = (type, opts) => el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, opts)));
        switch (op) {
            case 'move':
                updateLocalHover(el, base);
                fire('mousemove', { button: 0 });
                break;
            case 'click':
                fire('mousedown', { button: 0 });
                maybeFocus(el);
                fire('mouseup', { button: 0 });
                fire('click', { button: 0 });
                setTimeout(() => routeOp('move'), 50);
                if (el.tagName && el.tagName.toUpperCase() === 'OPTION') {
                    const selectEl = el.closest('select');
                    if (selectEl) {
                        selectEl.value = el.value;
                        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                        selectEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    }
                }

                if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                    if (el.paused) el.play().catch(() => { });
                    else el.pause();
                }
                break;
            case 'dblclick':
                fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                fire('mousedown', { button: 0 }); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                fire('dblclick', { button: 0 });
                break;
            case 'auxclick':
                fire('mousedown', { button: 1 }); fire('mouseup', { button: 1 }); fire('auxclick', { button: 1 });
                break;
            case 'contextmenu':
                fire('contextmenu', { button: 2 });
                setTimeout(() => routeOp('move'), 50);
                break;
            case 'wheel': {
                const deltaY = (extra && extra.deltaY) || 0;
                el.dispatchEvent(new WheelEvent('wheel', Object.assign({}, base, { deltaY, deltaMode: 0 })));
                let scrollTarget = el;
                let found = false;
                while (scrollTarget && scrollTarget !== document.body && scrollTarget !== document.documentElement) {
                    const style = window.getComputedStyle(scrollTarget);
                    const isListbox = scrollTarget.tagName === 'SELECT';
                    const overflowsY = scrollTarget.scrollHeight > scrollTarget.clientHeight;
                    const scrollableY = overflowsY && (isListbox ||
                        style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay');
                    if (scrollableY) { found = true; break; }
                    scrollTarget = scrollTarget.parentElement;
                }

                if (found) {
                    const atTop = scrollTarget.scrollTop <= 0;
                    const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 1;
                    if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                        found = false; // this scroll unit is exhausted in this direction, hand off
                    } else {
                        scrollTarget.scrollBy({ top: deltaY, behavior: 'auto' });
                    }
                }

                if (!found) {
                    sendToFrame('content', 'wheel', 0, 0, { deltaY });
                }
                break;
            }
            case 'drag_start':
                fire('mousedown', { button: 0 });
                break;
            case 'drag_end':
                fire('mouseup', { button: 0 });
                break;
        }
    }

    function routeOp(op, extra) {
        const hit = resolveHit(cursor.x, cursor.y);
        const targetId = hit.kind === 'frame' ? hit.id : (hit.kind === 'local' ? 'index' : null);

        if (targetId !== currentTargetId) {
            if (currentTargetId === 'index') clearLocalHover();
            else if (currentTargetId) sendToFrame(currentTargetId, 'leave', 0, 0, {});

            if (hit.kind === 'frame') sendToFrame(hit.id, 'enter', hit.x, hit.y, {});
            currentTargetId = targetId;
        }

        if (hit.kind === 'frame') {
            sendToFrame(hit.id, op, hit.x, hit.y, extra);
        } else if (hit.kind === 'local') {
            dispatchLocal(op, hit.el, hit.screenX, hit.screenY, extra || {});
        }
    }

    const EDGE_ZONE = 0.15;
    const EDGE_MAX_MULT = 4;

    function edgeAccelFactor(pos, max) {
        const zone = max * EDGE_ZONE;
        if (zone <= 0) return 1;
        if (pos < zone) return 1 + (1 - pos / zone) * (EDGE_MAX_MULT - 1);
        if (pos > max - zone) return 1 + (1 - (max - pos) / zone) * (EDGE_MAX_MULT - 1);
        return 1;
    }

    function sendOverflowWheel(overflowX, overflowY) {
        if (Math.abs(overflowX) <= 0.1 && Math.abs(overflowY) <= 0.1) return;
        const mult = Math.max(edgeAccelFactor(cursor.x, stage.clientWidth), edgeAccelFactor(cursor.y, stage.clientHeight));
        routeOp('wheel', {
            deltaX: overflowX * zoom / MOVE_SENSITIVITY * mult,
            deltaY: overflowY * zoom / MOVE_SENSITIVITY * mult
        });
    }

    const activePointers = new Map();
    let moveState = null;
    let pendingTap = null;
    let edgeHoldRaf = null;

    function edgeHoldLoop() {
        edgeHoldRaf = null;
        if (!moveState || !moveState.moved) return;

        const nearLeft = cursor.x < stage.clientWidth * EDGE_ZONE;
        const nearRight = cursor.x > stage.clientWidth * (1 - EDGE_ZONE);
        const nearTop = cursor.y < stage.clientHeight * EDGE_ZONE;
        const nearBottom = cursor.y > stage.clientHeight * (1 - EDGE_ZONE);

        if (nearLeft || nearRight || nearTop || nearBottom) {
            const multX = Math.max(edgeAccelFactor(cursor.x, stage.clientWidth), 1);
            const multY = Math.max(edgeAccelFactor(cursor.y, stage.clientHeight), 1);
            const BASE_HOLD_SPEED = 6; // logical px per frame at full acceleration
            const dx = (nearLeft ? -1 : nearRight ? 1 : 0) * BASE_HOLD_SPEED * (multX - 1);
            const dy = (nearTop ? -1 : nearBottom ? 1 : 0) * BASE_HOLD_SPEED * (multY - 1);
            if (dx || dy) {
                routeOp('wheel', { deltaX: dx * zoom, deltaY: dy * zoom });
            }
        }
        edgeHoldRaf = requestAnimationFrame(edgeHoldLoop);
    }

    colMove.addEventListener('pointerdown', (e) => {
        colMove.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 1) {
            moveState = {
                pointerId: e.pointerId,
                startX: e.clientX, startY: e.clientY,
                lastX: e.clientX, lastY: e.clientY,
                lastTime: performance.now(),
                moved: false,
            };

            if (isSelectMode) routeOp('select_start');
            if (!edgeHoldRaf) edgeHoldRaf = requestAnimationFrame(edgeHoldLoop);
        }
    });

    colMove.addEventListener('pointermove', (e) => {
        e.preventDefault();
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (moveState && e.pointerId === moveState.pointerId) {
            const now = performance.now();
            const dt = Math.max(1, now - moveState.lastTime);
            moveState.lastTime = now;

            const dx = e.clientX - moveState.lastX;
            const dy = e.clientY - moveState.lastY;
            moveState.lastX = e.clientX; moveState.lastY = e.clientY;

            const totalMoved = Math.hypot(e.clientX - moveState.startX, e.clientY - moveState.startY);
            if (totalMoved > TAP_MOVE_THRESHOLD) moveState.moved = true;

            if (moveState.moved) {
                const velocity = Math.hypot(dx, dy) / dt;

                const BASE_SENSITIVITY = 1.15;
                const ACCEL_THRESHOLD = 0.5;
                const ACCEL_FACTOR = 2.0;
                const MAX_SENSITIVITY = 5.0;

                let dynamicSensitivity = BASE_SENSITIVITY;
                if (velocity > ACCEL_THRESHOLD) {
                    dynamicSensitivity += (velocity - ACCEL_THRESHOLD) * ACCEL_FACTOR;
                }
                dynamicSensitivity = Math.min(dynamicSensitivity, MAX_SENSITIVITY);

                let logicalDx = (dx / zoom) * dynamicSensitivity;
                let logicalDy = (dy / zoom) * dynamicSensitivity;


                let oldCursorX = cursor.x;
                let oldCursorY = cursor.y;

                if (Math.abs(logicalDx) >= 0.1) {
                    let hit = resolveHit(cursor.x, cursor.y);
                    let target = null;
                    let win = window;

                    if (hit.kind === 'frame') {
                        let frameWin = hit.id === 'content' ? contentFrame.contentWindow : (hit.id === 'side' ? sideFrame.contentWindow : null);
                        if (frameWin) {
                            win = frameWin;
                            let safeX = Math.max(0, Math.min(win.document.documentElement.clientWidth - 1, hit.x));
                            let safeY = Math.max(0, Math.min(win.document.documentElement.clientHeight - 1, hit.y));
                            target = win.document.elementFromPoint(safeX, safeY);
                        }
                    } else if (hit.kind === 'local') {
                        target = hit.el;
                    }

                    if (target) {
                        let unconsumedX = logicalDx;
                        let scrollTarget = target;

                        while (scrollTarget) {
                            const isDoc = scrollTarget === win.document.documentElement;
                            const isBody = scrollTarget === win.document.body;
                            const isRoot = isDoc || isBody;
                            const style = win.getComputedStyle(scrollTarget);

                            let canScrollX = false;
                            if (isDoc || isBody) {
                                canScrollX = scrollTarget.scrollWidth > scrollTarget.clientWidth;
                            } else {
                                canScrollX = (scrollTarget.scrollWidth > scrollTarget.clientWidth) &&
                                    (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay');
                            }

                            if (canScrollX) {
                                let availableX = unconsumedX > 0
                                    ? Math.ceil(scrollTarget.scrollWidth - scrollTarget.scrollLeft - scrollTarget.clientWidth)
                                    : scrollTarget.scrollLeft;

                                if (availableX > 0) {
                                    let consume = Math.sign(unconsumedX) * Math.min(Math.abs(unconsumedX), availableX);
                                    const before = scrollTarget.scrollLeft;
                                    scrollTarget.scrollLeft += consume;
                                    const actualDelta = scrollTarget.scrollLeft - before;
                                    unconsumedX -= actualDelta;
                                }
                            }
                            if (Math.abs(unconsumedX) < 0.1) break;

                            if (isBody) { scrollTarget = win.document.documentElement; continue; }
                            if (isDoc) break;
                            scrollTarget = scrollTarget.parentElement;
                        }
                        logicalDx = unconsumedX;
                    }
                }

                cursor.x += logicalDx;
                cursor.y += logicalDy;
                clampCursor();

                let overflowX = (oldCursorX + logicalDx) - cursor.x;
                let overflowY = (oldCursorY + logicalDy) - cursor.y;

                panX = (window.innerWidth / 2) - cursor.x * zoom;
                panY = (stage.clientHeight / 2) - cursor.y * zoom;
                clampPan();

                applyTransform();
                updateCursorVisual();
                routeOp(isSelectMode ? 'select_move' : 'move');

                sendOverflowWheel(overflowX, overflowY);
            }
        }
    });

    function endPointer(e) {
        const wasSingle = activePointers.size === 1;
        activePointers.delete(e.pointerId);

        if (wasSingle && edgeHoldRaf) {
            cancelAnimationFrame(edgeHoldRaf);
            edgeHoldRaf = null;
        }

        if (wasSingle && moveState && e.pointerId === moveState.pointerId) {
            if (isSelectMode && moveState.moved) {
                routeOp('select_end');
            } else if (!moveState.moved) {
                const now = Date.now();
                if (pendingTap &&
                    now - pendingTap.time < DOUBLE_TAP_WINDOW &&
                    Math.hypot(e.clientX - pendingTap.x, e.clientY - pendingTap.y) < DOUBLE_TAP_DIST) {
                    clearTimeout(pendingTap.timer);
                    pendingTap = null;
                    playCursorClickFeedback();
                    routeOp('dblclick');
                } else {
                    if (pendingTap) clearTimeout(pendingTap.timer);
                    const tap = { time: now, x: e.clientX, y: e.clientY };
                    tap.timer = setTimeout(() => {
                        playCursorClickFeedback();
                        routeOp('click');
                        pendingTap = null;
                    }, DOUBLE_TAP_WINDOW);
                    pendingTap = tap;
                }
            }
            moveState = null;
        }
    }
    colMove.addEventListener('pointerup', endPointer);
    colMove.addEventListener('pointercancel', endPointer);

    let isDragMode = false;

    btns.forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (btn.dataset.btn !== 'drag_toggle') btn.classList.add('tp-active');
        });

        btn.addEventListener('pointerup', () => {
            const act = btn.dataset.btn;

            if (act === 'drag_toggle') {
                isDragMode = !isDragMode;
                btn.classList.toggle('tp-active', isDragMode);
                routeOp(isDragMode ? 'drag_start' : 'drag_end');
                return;
            }
            if (act === 'zoom_in') {
                doZoom(0.25);
                btn.classList.remove('tp-active');
                return;
            }
            if (act === 'zoom_out') {
                doZoom(-0.25);
                btn.classList.remove('tp-active');
                return;
            }
            if (act === 'select_toggle') {
                isSelectMode = !isSelectMode;
                btn.classList.toggle('tp-active', isSelectMode);
                cursorEl.classList.toggle('tp-cursor-text', isSelectMode);
                return;
            }

            btn.classList.remove('tp-active');
            if (act === 'dblclick' || act === 'auxclick' || act === 'contextmenu') {
                playCursorClickFeedback();
            }
            routeOp(act);
        });

        const release = () => {
            if (btn.dataset.btn !== 'drag_toggle') btn.classList.remove('tp-active');
        };
        btn.addEventListener('pointercancel', release);
    });

    panel.querySelectorAll('.tp-scroll-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.classList.add('tp-active');
            routeOp('wheel', { deltaY: parseInt(btn.dataset.scroll, 10) });
        });
        const release = () => btn.classList.remove('tp-active');
        btn.addEventListener('pointerup', release);
        btn.addEventListener('pointercancel', release);
    });

    panX = (window.innerWidth / 2) - cursor.x * zoom;
    panY = (stage.clientHeight / 2) - cursor.y * zoom;
    clampPan();

    applyTransform();
    updateCursorVisual();

    const mobileConsole = document.createElement('div');
    mobileConsole.style.cssText = 'position:fixed; bottom:var(--tp-height); left:0; width:100%; height:25vh; background:rgba(0,0,0,0.85); color:#0f0; font-family:monospace; font-size:11px; overflow-y:auto; z-index:999999; display:none; padding:8px; box-sizing:border-box; word-break:break-all; pointer-events:auto;';
    document.body.appendChild(mobileConsole);

    window.top._logToMobile = function (level, args) {
        const msg = document.createElement('div');
        msg.style.color = level === 'error' ? '#ff4d4f' : level === 'warn' ? '#faad14' : (level === 'info' ? '#1890ff' : '#52c41a');
        msg.style.marginBottom = '4px';
        msg.style.borderBottom = '1px solid rgba(255,255,255,0.1)';

        const msgText = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }
            return a;
        }).join(' ');

        msg.innerText = `[${level.toUpperCase()}] ${msgText}`;
        mobileConsole.appendChild(msg);
        mobileConsole.scrollTop = mobileConsole.scrollHeight;
    };

    function hijackWindow(win) {
        if (!win || win._consoleHijacked) return;
        win._consoleHijacked = true;

        const _originals = { log: win.console.log, error: win.console.error, warn: win.console.warn, info: win.console.info };

        ['log', 'error', 'warn', 'info'].forEach(method => {
            if (!win.console[method]) return;
            win.console[method] = function (...args) {
                _originals[method].apply(win.console, args);
                if (window.top && window.top._logToMobile) window.top._logToMobile(method, args);
            };
        });

        const _timeMap = new Map();
        const _origTime = win.console.time;
        const _origTimeEnd = win.console.timeEnd;
        if (_origTime && _origTimeEnd) {
            win.console.time = function (label = 'default') {
                _origTime.call(win.console, label);
                _timeMap.set(label, win.performance.now());
            };
            win.console.timeEnd = function (label = 'default') {
                _origTimeEnd.call(win.console, label);
                if (_timeMap.has(label)) {
                    const duration = (win.performance.now() - _timeMap.get(label)).toFixed(4);
                    if (window.top && window.top._logToMobile) window.top._logToMobile('info', [`${label}: ${duration} ms`]);
                    _timeMap.delete(label);
                }
            };
        }

        win.addEventListener('error', function (event) {
            if (event.target && (event.target.tagName === 'IMG' || event.target.tagName === 'SCRIPT' || event.target.tagName === 'LINK')) {
                if (window.top && window.top._logToMobile) window.top._logToMobile('error', ['Resource 404/Error:', event.target.src || event.target.href]);
            } else {
                if (window.top && window.top._logToMobile) window.top._logToMobile('error', ['Uncaught Error:', event.message, 'at', event.filename, ':' + event.lineno]);
            }
        }, true);

        win.addEventListener('unhandledrejection', function (event) {
            if (window.top && window.top._logToMobile) window.top._logToMobile('error', ['Unhandled Promise Rejection:', event.reason]);
        });

        const _origFetch = win.fetch;
        if (_origFetch) {
            win.fetch = function (...args) {
                return _origFetch.apply(this, args).then(res => {
                    if (!res.ok && window.top && window.top._logToMobile) {
                        window.top._logToMobile('error', ['Fetch Error:', res.status, res.url]);
                    }
                    return res;
                }).catch(err => {
                    if (window.top && window.top._logToMobile) window.top._logToMobile('error', ['Fetch Failed:', args[0], err]);
                    throw err;
                });
            };
        }
    }

    hijackWindow(window);

    document.querySelectorAll('iframe').forEach(ifr => {
        try { hijackWindow(ifr.contentWindow); } catch (e) { }

        ifr.addEventListener('load', () => {
            try { hijackWindow(ifr.contentWindow); } catch (e) { }
        });
    });

    const logBtn = panel.querySelector('[data-btn="toggle_log"]');
    if (logBtn) {
        logBtn.addEventListener('pointerup', () => {
            mobileConsole.style.display = mobileConsole.style.display === 'none' ? 'block' : 'none';
        });
    }
})();