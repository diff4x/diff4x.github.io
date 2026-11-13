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
    find_content_matches: null,
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

// [media-pos:begin] 音视频播放位置记录
// localStorage 键 media_positions = { "video/a.mp4": 123.4, "audio/b.mp3": 56.7 }（单位：秒；最近使用的排在后面）。
// 在"关闭前"写入（预览销毁/切换、切歌、销毁播放器、灯箱视频离开）；搜索结果 / What's new 的音视频预览启动时读取并从该位置继续。
// index.js 与 deferred-features.js 各有一份相同的实现；lightbox-logic.js 的 videoLogic 里有一份精简版
// （它会被序列化进 iframe，无法引用外部函数）。键名与数据格式必须保持一致，修改时请一起改。
const MEDIA_POS_KEY = 'media_positions';
const MEDIA_POS_MAX = 500;      // 最多保留的条数，超出时丢弃最旧的
const MEDIA_POS_MIN = 1;        // 播放不足 1 秒不记录
const MEDIA_POS_END_GAP = 2;    // 距结尾不足 2 秒视为已播完，清除记录(下次从头开始)

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

// 关闭 / 销毁 / 切换媒体元素之前调用。没有时长(未加载元数据、直播流)的媒体不记录。
function saveMediaPosition(el) {
    try {
        if (!el) return;
        const dur = el.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const key = mediaPosKey((el.dataset && el.dataset.path) || el.getAttribute('src'));
        if (!key) return;
        const t = el.currentTime;
        const map = readMediaPositions();
        delete map[key];    // 先删再写，让最近使用的排在后面
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

// 预览元素创建后(设置 src 之后)调用：从上一次的位置继续
function resumeMediaPosition(el, src) {
    const saved = getMediaPosition(src);
    if (!saved) return;
    try { el.currentTime = saved; } catch (e) { }
    el.addEventListener('loadedmetadata', () => {
        // 文件可能被替换得更短：位置越界就从头开始
        if (Number.isFinite(el.duration) && saved > el.duration - MEDIA_POS_END_GAP) el.currentTime = 0;
    }, { once: true });
}
// [media-pos:end]


let searchWorker = null;
let _pendingWorker = null;      // A2：预热但尚未"交付"的 Worker
let _autocompleteSeq = 0;       // C4：联想渲染的序号，丢弃过期调用
let audioInitialized = false;
let comments_first_flag = false;
let records = [];
let totalCount = 0;

// ---- 评论同步 / 评论搜索 的共享状态 ----
const COMMENTS_SYNC_INTERVAL = 10 * 60 * 1000;
const commentHitCache = new Map();     // normKw -> { ver, hits: [{path, count}], sig }
const commentModel = {
    ready: false,
    ver: 0,                            // 每次评论数据变化 +1，用来判定 commentHitCache 是否过期
    sig: "",
    counts: {},                        // path -> 评论数（含回复）
    meta: new Map(),                   // path -> { title, fileName, localOnly }
    index: null                        // 发给 Worker 的评论索引 [{ path, texts }]
};
window.commentCounts = {};

import('../wasm/compute_intensive_task_processor.min.js').then(async (wasmModule) => {
    await wasmModule.default();
    window.sharedWasm.format_markdown = wasmModule.format_markdown;
    window.sharedWasm.find_content_matches = wasmModule.find_content_matches;
    window.sharedWasm.find_content_matches_multi = wasmModule.find_content_matches_multi; // 新增注入
    window.sharedWasm.compute_lcs_diff = wasmModule.compute_lcs_diff;
    window.sharedWasm.ready = true;
}).catch(err => {
    console.error("[Main] Wasm 模块加载失败:", err);
    // 通知内容页：不用再等了，降级渲染
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

// 关闭/刷新页面时，记录主音乐播放器的位置
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

            if (activeKw && !isReservedSearchCommand(activeKw)) {
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

    // 移动端触控板模拟层：只有触屏设备才下载这份代码
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
                            const res = await dbProxy.get('search_cache', normKw);
                            if (res) {
                                searchCacheLRU.touch(normKw);
                                return { results: res, exact: true, sourceKey: normKw };
                            }

                            // 前缀回退：扩展关键词的命中集合是前缀命中集合的子集，
                            // 可先用最长的已缓存前缀结果做"临时展示"。
                            // 键列表来自内存里的 LRU 记录，不再每次按键都 getAllKeys。
                            const candidates = (await searchCacheLRU.keys())
                                .filter(k => k.length > 2 && k !== normKw && normKw.startsWith(k))
                                .sort((a, b) => b.length - a.length)
                                .slice(0, 3);
                            for (const key of candidates) {
                                // search_cache 里存的值本身就是结果数组（不是 {results: [...]}）
                                const broader = await dbProxy.get('search_cache', key);
                                if (Array.isArray(broader) && broader.length > 0) {
                                    searchCacheLRU.touch(key);
                                    return { results: broader, exact: false, sourceKey: key };
                                }
                                // 记录里有、库里没有（例如被 SW 在 synonyms 变更时清空）
                                if (broader === undefined) searchCacheLRU.forget(key);
                            }
                            return null;
                        } catch (e) { return null; }
                    },
                    set: async (kw, results) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (!normKw) return;
                            await dbProxy.put('search_cache', normKw, results);
                            await searchCacheLRU.touchAndEvict(normKw);
                        } catch (e) { }
                    },

                    remove: async (kw) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (normKw) {
                                await dbProxy.delete('search_cache', normKw);
                                searchCacheLRU.forget(normKw);
                            }
                        } catch (e) { }
                    },

                    clear: async () => {
                        try {
                            await dbProxy.clear('search_cache');
                            searchCacheLRU.reset();
                        } catch (e) { }
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

// search_cache 的 LRU 记录。
// IDB 的 getAllKeys 按键升序返回，不代表"最近使用"，所以另存一份访问顺序（最旧在前）。
// 记录放在 sys_state，不改变 search_cache 里已有数据的格式；
// IDB 里有、记录里没有的键（旧版本遗留 / 其他标签页写入）视为最旧，优先淘汰。
function createSearchCacheLRU(db, max = 500) {
    let order = null;      // string[]，最旧在前；null 表示尚未加载
    let loading = null;
    let persistTimer = null;
    let gen = 0;           // reset() 之后丢弃仍在途中的旧加载结果

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

    // A2：与下面 core-list → lite_data → side iframe 加载这条串行链并行：
    // Worker 预热（含 Wasm 下载与编译）、IDB 全量读取。原来这两件事要等整条链结束后才开始。
    prewarmSearchWorker();
    window._chunksPrefetch = dbProxy.getAll();
    window._chunksPrefetch.catch(() => { });      // 错误仍由 loadDataInBatches 里的 await 抛出

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

// A2：Worker（含 Wasm 下载与编译）可以在 loadScripts 之前就开始预热，与 core-list / lite_data / IDB 读取并行。
// 但 search() 把 searchWorker 当作"数据已就绪"的闸门，所以预热的实例先放在 _pendingWorker，
// 等 loadDataInBatches 里才赋给 searchWorker。
function createSearchWorker() {
    const worker = new Worker('src/js/worker.js', { type: 'module' });
    worker.onmessage = async (e) => {
        const { type, results, keyword, token, inheritFrom, payload, commentHits } = e.data;

        if (type === 'DELETE_CACHE') {
            store.SearchCache.remove(keyword);
            return;
        }

        // 缓存命中（没走 SEARCH）时单独请求的评论命中
        if (type === 'COMMENT_HITS') {
            if (token !== window._searchToken) return;
            if (setCommentHits(keyword, commentHits || [])) rerenderSearchOverlay();
            return;
        }

        if (type === 'SEARCH_RESULTS') {
            if (token !== window._searchToken) {
                console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                return;
            }

            // Worker 在正文结果之后从评论里找补的命中，渲染时叠加（不写入搜索缓存）
            if (Array.isArray(commentHits)) setCommentHits(keyword, commentHits);

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

            if (activeKw && !isReservedSearchCommand(activeKw)) {
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
    // A2：getAll 在 loadScripts 开头已提前发起，与 core-list / lite_data / side iframe 的等待重叠
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
        // A2：优先使用预热好的 Worker。"数据已就绪"的语义仍由这里对 searchWorker 的赋值体现
        // （search() 以 searchWorker 非空作为闸门），时机与原来一致。
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

    elSearchInput.addEventListener("input", function () {
        const val = this.value;

        if (val.trim() === "") {
            clearTimeout(searchDebounceTimer);
            _autocompleteSeq++;            // 作废仍在途中的联想渲染，避免它们稍后又往已清空的列表里追加
            updateSearchResults([]);
            showSearchHistoryByTime();
            return;
        }

        // C4：先同步安排防抖搜索，再渲染联想。
        // 原先是先 await 联想（含 IDB 读取）再设定时器：打字较快时，较早事件的联想可能更晚完成，
        // 它随后会清掉并重设较新事件的定时器，最终搜索的是旧关键词。
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            search(val.trim());
            store.keyword = val;
        }, 150);

        initHistoryBox(1);
        updateAutocompleteSuggestions(val).catch(err => console.warn("联想渲染失败", err));
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
            if (val.startsWith("@like=")) {
                const n = parseInt(val.split("=")[1], 10);
                if (n === 0 || n === 1) {
                    store.synonyms_enabled = n;
                    this.value = "";
                    this.placeholder = n === 1 ? "已开启近义搜索" : "已停用近义搜索";
                    setTimeout(() => this.placeholder = "Search...", 2000);
                    store.SearchCache.clear();
                    if (searchWorker) searchWorker.postMessage({ type: "CLEAR_CURSOR", payload: { keyword: "" } });
                } else {
                    this.placeholder = "@like 只能是 0 或 1（当前输入无效）";
                    setTimeout(() => this.placeholder = "Search...", 2500);
                    this.value = "";
                }
                return;
            }
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
        if (scrollContent) {
            saveMediaPositionsIn(scrollContent);   // 关闭前记录音视频播放位置
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
                    saveMediaPositionsIn(scrollContent);   // 切换到另一个媒体前，记录旧预览的位置
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

    if (!provisional && activeKw !== "" && !isReservedSearchCommand(activeKw)) {
        store.SearchCache.set(activeKw, finalResults).then(() => {
            if (currentIndex === -1) {
                emitEvent('LOCAL_SEARCH_COUNT', activeKw, 'content');
            }
        });
    } else if (provisional && currentIndex === -1 && activeKw && !isReservedSearchCommand(activeKw)) {
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
            requestCommentHits(kw, currentToken);
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

// 关键词 + 近义词变体（正文搜索与评论搜索共用）
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
        // 键列表来自内存里的 LRU 记录，不再每次按键都 getAllKeys
        const cacheKeys = await searchCacheLRU.keys();
        // 打字快时，较早的调用可能更晚恢复：只让最新一次渲染，避免重复追加 <option>
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

function isReservedSearchCommand(kw) {
    return typeof kw === 'string' && /^@(noise=|like=|bomb$|rebirth$)/.test(kw);
}

function updateSearchResults(results, keyword) {
    // 搜索缓存里保存的始终是纯正文结果；评论命中只在渲染时叠加
    window._baseRenderedResults = results;
    results = applyCommentOverlay(results, keyword);

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

            // 仅评论命中的文章没有正文命中数，只显示 [💬 N]
            const countStr = result.commentOnly ? "" : ` [${result.count}]`;
            const commentStr = result.commentHits ? ` [💬 ${result.commentHits}]` : "";
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
}

async function generateDoc(type, payload) {
    const { iframeCommonLogic, imageLogic, videoLogic } = await import('./lightbox-logic.js');
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
    saveMediaPosition($("#_audio"));   // 旧播放器被替换前记录位置
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
        saveMediaPosition(audioPlayer);   // 销毁播放器前记录位置
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
        saveMediaPosition(audioPlayer);   // 切歌前记录上一首的位置
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
// =====================================================================
// 评论同步：每 10 分钟拉取 comments.json，与 cmt_mapper 匹配后
//   1) 汇总各文章评论数 -> 推给 side，追加到目录项 title
//   2) 最新 10 条评论 -> IDB(sys_state.comments_latest)，供 What's new 悬浮窗读取
//   3) 评论纯文本索引 -> 搜索 Worker，搜索时对正文结果做评论找补
// 匹配规则：giscus 用 data-mapping="specific"，Discussion 标题 = cmt_mapper 的 record.id，
//           record.title = 文章文件名(不含 .html)
// =====================================================================

// 评论正文是 Markdown：去掉图片/链接地址/HTML 标签/引用与标题记号，只留可读文本
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

// 遍历 lite_data.html 目录树 -> Map(标题 -> { title, fileName, path, localOnly })
// 与 side.js 的目录渲染、worker 的 build_flat_data 保持同一套路径规则: "html/" + 文件名
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
    // cmt_mapper() 只在线上环境加载映射表；本地环境/尚未就绪时直接拉取
    try {
        const res = await fetch('/src/cmt_mapper.json', { cache: 'no-cache' });
        if (res.ok) {
            const data = await res.json();
            return data.records || [];
        }
    } catch (e) { }
    return [];
}

// comments.json 的原始评论 -> 只保留能对应到现存文章的评论
async function mapRawComments(raw) {
    const recs = await getCommentMapperRecords();
    await AsyncUtils.waitFor(() => window.lite_data, 90000, 200);
    const files = collectHtmlFiles(window.lite_data.html);
    const titleById = new Map(recs.map(r => [String(r.id), r.title]));

    const mapped = [];
    for (const c of raw) {
        const term = c && c.discussion ? String(c.discussion.title ?? "").trim() : "";
        const articleTitle = titleById.get(term);
        if (!articleTitle) continue;               // 映射表里没有 / orphan
        const file = files.get(articleTitle);
        if (!file) continue;                       // 文章已不存在
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

// 把一份 { sig, comments } 快照应用到运行时：评论数 / 搜索索引 / 搜索结果叠加
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
        // 签名包含映射结果：评论被编辑、或文章/映射表变化导致归属变化，都会触发重建
        const sig = mapped.map(c => `${c.id}@${c.updatedAt}@${c.path}`).sort().join("|");
        if (commentModel.ready && sig === commentModel.sig) return;

        let prevLatest = null;
        try { prevLatest = await dbProxy.get('sys_state', 'comments_latest'); } catch (e) { }

        const snap = { generatedAt: (json && json.generatedAt) || "", sig, comments: mapped };
        await applyCommentSnapshot(snap);

        const latest = pickLatestComments(mapped, 10);
        const curNewest = latest.length ? (Date.parse(latest[0].createdAt) || 0) : 0;
        const prevNewest = Number(prevLatest && prevLatest.newestTs) || 0;
        // 删除评论不应让基线倒退；首次运行(没有基线)不弹窗
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
    // 悬浮窗已经开着：只刷新当前页，不打断
    const openedPopup = document.getElementById('changelog-popup');
    const isOpen = !!openedPopup && openedPopup.style.display !== 'none';
    if (!isOpen) {
        if (store.auto_show_comments === "0") return;
        // 刚在页面里发过评论：自己的评论不弹窗
        if (Date.now() < (window._suppressCommentPopupUntil || 0)) return;
    }

    try { await AsyncUtils.waitFor(() => !window.isDataSyncing, 90000, 200); } catch (e) { }
    if (window.restoreSnapPromise) {
        try { await window.restoreSnapPromise; } catch (e) { }
    }

    try {
        const m = await import('./deferred-features.js');
        // 不指定 tab：文件更新与评论谁的时间新就显示谁
        m.showChangelog({ dbProxy, emitEvent }, isOpen ? { keepTab: true } : {});
    } catch (e) {
        console.warn("[Comments] 弹出 What's new 失败:", e);
    }
}

function startCommentSync() {
    if (window._commentSyncStarted) return;
    window._commentSyncStarted = true;

    (async () => {
        // 先用上次保存的快照：离线时评论数和评论搜索也可用
        try {
            const cached = await dbProxy.get('sys_state', 'comments_cache');
            if (cached && Array.isArray(cached.comments)) await applyCommentSnapshot(cached);
        } catch (e) {
            console.warn("[Comments] 读取本地快照失败:", e);
        }
        await syncComments();
    })();

    window.commentSyncTimer = safeInterval(syncComments, COMMENTS_SYNC_INTERVAL);

    // 睡眠唤醒后 safeInterval 会跳过一次，这里补上
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible'
            && Date.now() - (window._lastCommentSyncAt || 0) > COMMENTS_SYNC_INTERVAL) {
            syncComments();
        }
    });
}

// ---- 评论搜索：结果叠加 ----

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

// 命中搜索缓存时不会走 SEARCH，这里单独让 Worker 算一次评论命中
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
    if (!kw || isReservedSearchCommand(kw)) return;
    requestCommentHits(kw, window._searchToken);
}

function rerenderSearchOverlay() {
    if (!window._baseRenderedResults) return;
    updateSearchResults(window._baseRenderedResults, window._currentRenderedKeyword);
}

// 正文与评论都命中：在该条上标记评论命中数；只有评论命中：追加该文章
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
        if (searchInput) {
            searchInput.setAttribute("title", totalSizeMB + " MB");
        }

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