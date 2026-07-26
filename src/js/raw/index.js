if (window.top !== window.self) {
    window.top.location.href = location.origin;
}

window.data = [];
window.isDataSyncing = false;
window._searchToken = 0;
window.cachedFaviconImg = null;
window.faviconBlinkTimer = null;

const store = createStore({
    resource_type: "",
    content_src: "",
    searchHistory: [],
    force_refresh_cache: "0"
});
store.github_page = github_page;
store.protocol_name = github_page.split(".")[0];
// 端口隔离仿线上
const isLocalEnv = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:') && location.port !== '9000';
store.online_flag = isLocalEnv ? "0" : "1";
store.bookmarkhtml_modifing = "0";
store.lightbox_stauts = "0";
store.jump_from_search = "0";

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

let searchWorker = null;
let audioInitialized = false;
let comments_first_flag = false;
let records = [];
let totalCount = 0;
let params = {
    left: 0,
    top: 0,
    currentX: 0,
    currentY: 0,
    dragging: false
};

// 事件网关
window.addEventListener('message', async (e) => {
    if (e.origin === "https://giscus.app" && e.data?.giscus) {
        const params = new URLSearchParams(window.location.search);
        if (params.get("giscus")) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        const data = e.data.giscus;
        if (data.discussion) {
            totalCount = data.discussion.totalCommentCount || 0;
            sendToIframe("content", "cm_count", totalCount);
        }
        if (data.post) {
            totalCount++;
            sendToIframe("content", "cm_count", totalCount);
            console.log("新增评论:", data.post);
        }
        if (data.error) {
            if (data.error == "Discussion not found") {
                sendToIframe("content", "cm_count", 0);
            } else {
                console.error("Giscus 错误:", data.error);
            }
        }
        return;
    }
    
    const { type, payload, from } = e.data || {};
    if (!type || !from) return;
    switch (type) {
        case "LOCAL_SEARCH_RESULT":
            let hist = store.last_li_a;
            if (!Array.isArray(hist)) hist = hist ? [hist] : [];
            let globalResults = (await store.SearchCache.get(payload.keyword || store.keyword)) || [];
            
            if (store.resource_type === "html" && hist.length > 0) {
                const currentPath = hist[0];
                const strippedPath = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;
                const existingIndex = globalResults.findIndex(r => r.path === currentPath || r.path === strippedPath);
                
                if (existingIndex !== -1) {
                    const item = globalResults.splice(existingIndex, 1)[0];
                    // item.count = payload.count;
                    if (payload.snippets) {
                        item.snippets = payload.snippets;
                        item.isTolerantMatch = payload.isTolerantMatch;
                    }
                    globalResults.unshift(item);
                } else if (payload.count > 0) {
                    let isActuallyPrivate = false;
                    if (window.data && window.data.length > 0) {
                        // window.data 的结构是 [title, info, path, type] 循环
                        for (let i = 2; i < window.data.length; i += 4) {
                            if (window.data[i] === currentPath || window.data[i] === strippedPath) {
                                // i - 1 是 info 字段 (即 val1)
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

            const activeKw = payload.keyword || store.keyword;
            if (activeKw && !activeKw.startsWith('@')) {
                store.SearchCache.set(activeKw, globalResults);
            }

            updateSearchResults(globalResults);
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
                if (!record) return; // 此时如果还找不到，才是真的没有
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
                        // 如果 giscus_flag 是 true，但 iframe 被意外销毁或还没渲染完，兜底重载
                        comments_first_flag = false;
                        discussion(record.id);
                        comments_first_flag = true;
                    }
                }
            };
            checkRecordsAndLoad();
            break;

        case "sh_comments":
        if ($("#giscus-popup").style.display == "none") {
            $("#giscus-popup").style.display = "flex";
            const stamp = payload || window._currentStampText;
            updatePopupHeaderWithStamp(stamp);
            
            if (typeof takeSnapshot === 'function') takeSnapshot(false);
        } else {
            $("#giscus-popup").style.display = "none";
        }
        break;

        case "show_changelog":
            showChangelog();
            break;

        case "show_guestbook":
            showGuestbook();
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
                // 如果当前控制面板正好打开着，实时刷新右侧或左侧技术数
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

        default:
            break;
    }
});

// 其它监听
document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        if (document.activeElement !== $("#searchInput")) {
            e.preventDefault();
            $("#searchInput").focus();
        }
    }
});
window.onload = () => {
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

    // 低优先级
    cmt_mapper();
    comments();
    loadPinyinData();

    updateTitle();
    setTimeout(() => {
        updateTitle();
        window.updateTitleTimer = safeInterval(updateTitle, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds()); // 分钟对齐

    window.alertTimer = safeInterval(ls_alert, 60000);

    initBackupReminder();
}

// postMessage 封装
function sendToIframe(targetId, type, payload) {
    const ids = (targetId === '*' || targetId === 'all') ? Object.keys(iframes) : [targetId];
    ids.forEach(id => {
        const target = iframes[id];
        if (target && target.contentWindow) {
            target.contentWindow.postMessage({
                type,
                payload,
                from: 'parent',
                to: id
            }, '*');
        }
    });
}

// 通用代理 
function createStore(defaults = {}) {
    return new Proxy({}, {
        get(_, prop) {
            if (prop === 'SearchCache') {
                return {
                    get: async (kw) => {
                        try { 
                            const normKw = normalizeKeyword(kw);
                            if (!normKw) return null;

                            // 1. 尝试精确归一化命中
                            let res = await dbProxy.get('search_cache', normKw);
                            if (res) return res;

                            // 2. 前缀模糊降级 (Prefix Fallback)
                            // 逻辑：如果用户输入的词更长，去缓存里找有没有“它是其前缀的较短缓存”（即更宽泛的超集缓存）
                            // 例如用户输入 "javascript"，缓存里有 "java"
                            const keys = await dbProxy.getAllKeys('search_cache');
                            // 筛选出所有是 normKw 前缀的缓存 key (要求 key 长度大于 2，避免单个字母误伤)
                            const matchingKeys = keys.filter(k => typeof k === 'string' && normKw.startsWith(k) && k.length > 2);
                            
                            if (matchingKeys.length > 0) {
                                // 按 key 长度降序排序，优先取最长的那个前缀（最接近当前输入）
                                matchingKeys.sort((a, b) => b.length - a.length);
                                const bestKey = matchingKeys[0];
                                const broaderResults = await dbProxy.get('search_cache', bestKey);
                                
                                if (broaderResults && broaderResults.length > 0) {
                                    // 命中前缀降级：直接返回更宽泛的缓存作为“秒开预热”
                                    // (注：由于是超集，它包含所有匹配项，可直接呈现，后台 Worker 会随后计算出精确结果并自然覆盖)
                                    return broaderResults;
                                }
                            }

                            return null; 
                        } catch (e) { 
                            return null; 
                        }
                    },

                    set: async (kw, results) => {
                        try {
                            const normKw = normalizeKeyword(kw);
                            if (!normKw) return;

                            await dbProxy.put('search_cache', normKw, results);
                            const keys = await dbProxy.getAllKeys('search_cache');
                            if (keys.length > 500) {
                                const keysToDelete = keys.slice(0, keys.length - 500);
                                for (let k of keysToDelete) { 
                                    await dbProxy.delete('search_cache', k); 
                                }
                            }
                        } catch (e) {
                            console.warn("IDB 缓存写入失败", e);
                        }
                    },

                    remove: async (kw) => {
                        try { 
                            const normKw = normalizeKeyword(kw);
                            if (normKw) {
                                await dbProxy.delete('search_cache', normKw); 
                            }
                        } catch (e) {}
                    },

                    clear: async () => {
                        try { await dbProxy.clear('search_cache'); } catch (e) {}
                    }
                };
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

            localStorage.setItem(prop, JSON.stringify(value));
            return true;
        },

        deleteProperty(_, prop) {
            if (prop === 'SearchCache')
                return false;

            localStorage.removeItem(prop);
            return true;
        }
    });
}

// IndexedDB 代理
function createDBProxy(dbName, storeName) {
    const init = async () => {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(storeName)) 
                    db.createObjectStore(storeName);
                if (!db.objectStoreNames.contains('update_logs')) 
                    db.createObjectStore('update_logs', { autoIncrement: true });
                if (!db.objectStoreNames.contains('search_cache')) 
                    db.createObjectStore('search_cache');
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
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
                tx.onerror = () => reject(tx.error);
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
                tx.onerror = () => reject(tx.error);
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

// 核心引擎
async function loadScripts(concurrency) {
    // 挂锁
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
        // 注入哈希账本与公开索引
        // 主线程 index.js 和 Service Worker 线程 sw.js, 两者是完全不同的平行宇宙
        try {
            await injectScript(`src/js/core-list.js?t=${now}`);
        } catch (e) {
            // 离线或冷启动异常时的统一保底方案
            window.FILE_MANIFEST = window.FILE_MANIFEST || {};
            window.dataIndex = [];
            window._isOfflineDataFallback = true;
        }

        // 线下探测并注入影子索引
        window.shadowIndex = [];
        if (store.online_flag === "0") {
            try {
                await injectScript(`src/js/data/shadowIndex.js?t=${now}`);
            } catch (e) {
                console.warn("未探测到私有影子数据");
            }
        }

        // 注入轻量目录
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

        // 通知侧边栏渲染目录
        if (iframes?.side?.contentDocument?.readyState === 'complete') {
            sendToIframe('side', 'RENDER_CATALOG', window.lite_data);
        } else {
            await new Promise(resolve => {
                iframes.side.addEventListener('load', resolve, { once: true });
            });
            sendToIframe('side', 'RENDER_CATALOG', window.lite_data);
        }

        // 恢复快照
        window.restoreSnapPromise = restore_snap();

        window.restoreSnapPromise
            .catch(err => {
                console.warn("⚠️ 快照恢复中止或超时:", err);
            })
            .finally(() => {
                $("#search").style.display = "block";
                // document.documentElement.style.setProperty("background-color", "#cae4ff", "important");
            });
        
        // 静默下载胖数据
        const fatFiles = window.dataIndex.filter(f => f.startsWith('fat_data_'));

        // 数据拼装
        await loadDataInBatches(fatFiles, now, concurrency);
    } catch (err) {
        console.error("❌ 核心流程中断，降级处理:", err);
    } finally {
        // 解锁
        window.isDataSyncing = false;
    }
}

// 数据拼装
async function loadDataInBatches(files, now, concurrency) {
    // 取出老本
    const cachedChunks = await dbProxy.getAll();
    const cachedMap = new Map(cachedChunks.map(c => [c.id, c.fingerprint]));
    const chunkDataMap = new Map(cachedChunks.map(c => [c.id, c.data]));

    // 离线重构
    if (window._isOfflineDataFallback) {
        files = cachedChunks.map(c => c.id);
    }
    const validFatFiles = new Set(files);

    // 在线垃圾清理
    if (!window._isOfflineDataFallback) {
        for (const cached of cachedChunks) {
            if (!validFatFiles.has(cached.id)) {
                await dbProxy.delete(cached.id);
                await dbProxy.addLog(`🧹 [IDB] 清理过期废弃切片: ${cached.id}`);
                console.log(`🧹 [IDB] 清理废弃切片: ${cached.id}`);
            }
        }
    }

    // 拟定请求
    const filesToFetch = [];
    files.forEach(src => {
        const webPath = "/src/js/data/" + src;
        const newHash = FILE_MANIFEST[webPath] ? FILE_MANIFEST[webPath].hash : null;
        if (cachedMap.get(src) !== newHash) 
            filesToFetch.push(src);
    });

    // worker 注册
    window._lastSavedKw = "";
    if (!searchWorker) {
        searchWorker = new Worker('src/js/worker.js', { type: 'module' });
        searchWorker.onmessage = async (e) => {
            const { type, results, keyword, token } = e.data;
            if (type === 'SEARCH_RESULTS') {
                
                // 如果回来的 Token 不是目前最新的，说明是过期/滞后的结果，直接丢弃
                if (token !== window._searchToken) {
                    console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                    return;
                }

                const activeKw = keyword || store.keyword;

                if (activeKw) {
                    // 1. 尝试获取当前词的缓存
                    let sourceCache = await store.SearchCache.get(activeKw);
                    let isExactMatch = true; // 新增：标记是否为当前词的精确缓存
                    
                    // 2. 如果当前词没有缓存，触发了贪吃蛇剪枝逻辑，则尝试继承上一个短词的富集缓存
                    if ((!sourceCache || sourceCache.length === 0) && window._lastSavedKw && activeKw.startsWith(window._lastSavedKw)) {
                        sourceCache = await store.SearchCache.get(window._lastSavedKw);
                        isExactMatch = false; // 借用旧词缓存，标记为 false
                    }
                    
                    // 3. 异步等待后，再次核对 Token，防止被新输入插队
                    if (token !== window._searchToken) return;

                    if (sourceCache && sourceCache.length > 0) {
                        results.forEach(newItem => {
                            const oldItem = sourceCache.find(o => o.path === newItem.path);
                            if (oldItem) {
                                // 🚀 修复：必须限制只有在“精确命中同一个词”时，才能继承旧数据！
                                // 绝不能将短词（前缀）的庞大命中数，强行覆盖长词的真实命中数
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
                        
                        // 核心修复 2：只有精确命中同一个词时，才把 Worker 漏掉的巨型页面补回来（防止不同词的结果混入列表）
                        if (isExactMatch) {
                            sourceCache.forEach(oldItem => {
                                if (oldItem.snippets && !results.some(r => r.path === oldItem.path)) {
                                    results.push(JSON.parse(JSON.stringify(oldItem))); 
                                }
                            });
                        }
                    }
                }

                // 缓存入库
                // 搜索缓存和搜索历史不需要强行绑定成 1:1 的关系，因为它们的职责不同
                // 搜索历史记录的是“有意识的显式行为”（回车或点击条目）。它的目的是让用户能找回自己曾经明确查找过、关注过的内容，属于“用户资产”。
                // 搜索缓存记录的是“无意识的瞬时计算结果”（只要输入框在变，哪怕只打了一个字）。它的目的是作为瞬时性能垫脚石, 提供极致的输入响应速度，属于“系统缓存”。
                if (activeKw && !activeKw.startsWith('@')) {
                    clearTimeout(window._idbWriteTimer);
                    // 输入防抖
                    window._idbWriteTimer = setTimeout(async () => {
                        // 子串剪枝追踪算法 (贪吃蛇)
                        // 如果有旧词，且新词以旧词开头，且新词更长，删掉旧词
                        if (window._lastSavedKw && activeKw.startsWith(window._lastSavedKw) && activeKw.length > window._lastSavedKw.length) {
                            await store.SearchCache.remove(window._lastSavedKw);
                        }
                        // 存入完整的新词，更新追踪游标
                        // store.SearchCache.set(activeKw, results);
                        window._lastSavedKw = activeKw;
                    }, 600);
                }

                processAndShowResults(results, activeKw);
            }
        };
    }

    const buildAndPushData = async () => {
        // 合并胖数据和影子数据
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

        // 💥 Wasm 接管：通过序列化 JSON，把递归合并的任务直接推给底层的 Rust
        try {
            // 动态加载 Wasm 模块供主线程组装数据
            const wasm = await import('../wasm/compute_intensive_task_processor.min.js');
            await wasm.default(); // 初始化
            
            const isOffline = store.online_flag === "0";
            
            window.data = wasm.build_flat_data(
                JSON.stringify(window.lite_data || {}),
                JSON.stringify(fat_data_merged),
                JSON.stringify(shadow_data_merged),
                isOffline
            );
        } catch (e) {
            console.error("Wasm 数据组装引擎崩溃，请检查依赖:", e);
            window.data = []; // 异常兜底
        }

        // 全量喂给 worker 
        searchWorker.postMessage({ type: 'SET_DATA', payload: window.data });

        // 洗盘子释放内存
        fat_data_merged = null;
        chunkDataMap.clear();

        // 结束与撒花逻辑...
        if (store.force_refresh_cache === "1") {
            store.force_refresh_cache = "0";
            const triggerConfetti = () => {
                if (window.restoreSnapPromise) {
                    window.restoreSnapPromise.then(() => { 
                        idleRun(playConfetti); 
                        window.restoreSnapPromise = null; 
                    });
                } else { idleRun(playConfetti); }
            };
            triggerConfetti();
        }
    };

    // 无更新时, 直接拼装
    if (filesToFetch.length === 0) {
        await buildAndPushData();
        return;
    }

    // 有更新时, 翻新后才能继续拼装, 缓存作废 
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
                    // 现在这里的 newHash 就有值了
                    const response = await fetch(`src/js/data/${src}?v=${newHash}`, { cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    
                    const chunkData = await response.json();
                    if (!chunkData || typeof chunkData !== 'object') 
                        throw new Error(`结构无效`);
                    
                    chunkDataMap.set(src, chunkData);
                    await dbProxy.save(src, { id: src, fingerprint: newHash, data: chunkData });
                    await dbProxy.addLog(cachedMap.has(src) ? `🔄 更新: ${src}` : `✅ 新增: ${src}`);
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

// 代理拦截
function sw() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
            // 开局先捞一遍有没有处于等待激活状态的“僵尸”新版本
            if (reg.waiting && navigator.serviceWorker.controller) {
                promptUpdate(reg.waiting);
            }

            let isUpdating = false;
            const checkUpdate = async () => {
                // console.log("checkUpdate..");
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

            // 开局侦查
            checkUpdate();

            // 防移动端休眠
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    checkUpdate();
                }
            });

            // 保底的轮询
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
                        } catch(e) { 
                            return false; 
                        }
                    }, 10000, 150).then(() => {
                        sendToIframe('side', 'show_update_banner', null);
                    }).catch(() => {
                        sendToIframe('side', 'show_update_banner', null);
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
                window.addEventListener('message', (e) => {
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

// 搜索框
function search_box() {
    const elSearchInput = $("#searchInput");
    const elSearchHistory = $("#searchHistory");
    const elSearchResults = $("#searchResults");
    elSearchInput.setAttribute("autocomplete", "off");

    // 搜索历史排序
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

    // 通知右栏所选条目
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
            sendToIframe('side', '#html a', path);
        } else if (type == "image") {
            sendToIframe('side', '#gallery a', path);
        } else if (type == "video") {
            sendToIframe('side', '#video a', path);
        } else if (type == "pdf" || type == "epub" || type == "txt") {
            sendToIframe('side', '#ebook a', path);
        } else if (type == "pdf" || type == "epub" || type == "txt") {
            sendToIframe('side', '#ebook a', path);
        } else if (type == "audio") {
            sendToIframe('side', '#audio a', path);
        }
        sendToIframe('side', 'show_current');
    }

    // 选择列表动作平台适配
    function clickOrChange(select, handler) {
        let isHandling = false;
        const wrap = function () {
            if (isHandling || this.selectedIndex < 0) return;
            isHandling = true;
            handler(this.selectedIndex);
            // 150毫秒内，无视一切因为 click 和 change 同时触发导致的并发事件
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

    // 搜索历史清空
    function initHistoryBox(status) {
        elSearchHistory.innerHTML = "";
        elSearchHistory.style.display = status === 1 ? "block" : "none";
    }

    // 搜索框监听
    elSearchInput.addEventListener("input", async function () {
        // 判空与核弹
        const val = this.value;
        if (val.trim() === "") {
            updateSearchResults([]);
            showSearchHistoryByTime();
            return;
        } else if (val === "@bomb") {
            bomb();
            return;
        } else if (val === '@rebirth') {
            rebirth();
            return;
        }

        // 即时搜索
        search(val.trim());
        store.keyword = val;

        // 提示补全
        const history = store.searchHistory || [];
        const matchingHistory = history.filter(item =>
            item.keyword.startsWith(val) || item.keyword.includes(val)
        );
        initHistoryBox(1);
        await updateAutocompleteSuggestions(val);
    });

    // 焦点
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

    // 单击
    elSearchInput.addEventListener("click", function () {
        this.select();
    });

    // 按键
    elSearchInput.addEventListener("keydown", function (e) {
        let select = $('#searchResults');
        if (e.keyCode === 40 || e.keyCode === 13 || e.key === "Enter") {
            e.preventDefault();
            select.focus();
            select.selectedIndex = -1;
            const keyword = elSearchInput.value.trim();
            if (keyword !== "") {
                const history = [...(store.searchHistory || [])]
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

    // 右击删除记录
    elSearchHistory.addEventListener("contextmenu", async function (e) {
        if (e.target.tagName === 'OPTION') {
            e.preventDefault();
            e.stopPropagation();
            const keywordToDelete = e.target.text;
            
            // 1. 如果它存在于搜索历史中，从历史中剔除
            let history = [...(store.searchHistory || [])];
            const newHistory = history.filter(item => item.keyword !== keywordToDelete);
            if (newHistory.length !== history.length) {
                store.searchHistory = newHistory;
            }
            
            // 2. 无论它是历史还是孤儿缓存，从 IndexedDB 缓存池中彻底抹除
            await store.SearchCache.remove(keywordToDelete);
            
            // 🚀 修复点：如果被删除的词刚好是当前的贪吃蛇游标，必须将其销毁，防止成为幽灵游标
            if (window._lastSavedKw === keywordToDelete) {
                window._lastSavedKw = "";
            }

            // 3. 刷新下拉框视图
            const currentVal = $("#searchInput").value.trim();
            if (currentVal !== "") {
                // 如果用户正在输入联想，局部重新计算联想列表（使刚删除的词瞬间消失，不重置视图）
                await updateAutocompleteSuggestions(currentVal);
            } else {
                // 如果输入框为空，刷新历史列表
                refreshHistoryList();
            }
        }
    });
    elSearchHistory.title = "右击删除该记录";

    // 列表动作
    clickOrChange(elSearchHistory, function (index) {
        elSearchInput.value = elSearchHistory.options[index].text;
        elSearchInput.focus();
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

    // 清理
    $("#clear").addEventListener("click", function () {
        elSearchInput.value = "";
        updateSearchResults([]);
        initHistoryBox(0);
        store.keyword = "";
        store.jump_from_search = "0";
        store.jump_from_search_ex = "0";
        sendToIframe('content', 'DESTROY_HIGHLIGHT', null);
    });

    // 位置联动
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

    // snippet
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
        document.body.appendChild(previewBox);
    }

    let previewScrollFrame = null;
    let previewTimeoutId = null;
    let currentScrollY = 0;
    let lastHoveredPath = null;
    let isPaused = true;

    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // ---------------- [新增] 集中处理销毁预览与媒体的辅助函数 ----------------
    function destroyMediaPreview() {
        if (previewBox) previewBox.style.display = 'none';
        lastHoveredPath = null;
        isPaused = true;
        if (previewTimeoutId) clearTimeout(previewTimeoutId);
        if (previewScrollFrame) cancelAnimationFrame(previewScrollFrame);
        const scrollContent = document.getElementById('preview-scroll-content');
        if (scrollContent) scrollContent.innerHTML = ''; // 清空内容即销毁 audio/video，停止播放
    }

    // ---------------- [新增] 全局失焦 (Alt-Tab 切后台) 时销毁 ----------------
    window.addEventListener('blur', destroyMediaPreview);

    // ---------------- [修改/新增] 统一的中击清除逻辑 ----------------
    const handleMiddleClick = (e) => {
        // 使用 mousedown 判断 button === 1，在 select/option 等表单控件中兼容性更强
        if (e.button === 1) { 
            e.preventDefault();
            const clearBtn = document.getElementById('clear');
            if (clearBtn) clearBtn.click();
            destroyMediaPreview();
        }
    };

    // 搜索结果列表中击
    elSearchResults.addEventListener('mousedown', handleMiddleClick);
    
    // 历史记录列表中击
    const elSearchHistoryNode = document.getElementById('searchHistory');
    if (elSearchHistoryNode) elSearchHistoryNode.addEventListener('mousedown', handleMiddleClick);

    // [新增] 搜索框本身中击
    const elSearchInputNode = document.getElementById('searchInput');
    if (elSearchInputNode) elSearchInputNode.addEventListener('mousedown', handleMiddleClick);

    // ---------------- 核心悬浮逻辑 (mousemove) ----------------
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

            // 1. 设置 Title 提示
            if (type === 'html') {
                e.target.title = "右击滚动或停止";
            } else if (isMedia) {
                e.target.title = "右击播放或停止";
            } else {
                e.target.title = "";
            }

            // 2. 避免同一条目重复触发渲染
            if (path === lastHoveredPath) return; 
            
            // 如果切换了 Hover 的条目，先销毁上一个预览和媒体
            destroyMediaPreview();
            lastHoveredPath = path;

            // 如果是媒体，只更新提示，**不弹出窗口**，等待右击
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

            // --- Html 渲染代码保持原有逻辑不变 ---
            const resultData = (window._currentRenderedResults || []).find(r => r.path === path);
            const keyword = elSearchInput.value.trim();
            
            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // 🚀 重新定义高亮正则：严格模式允许任意空白符，宽容模式允许至多3个杂字
            const buildSnippetRegex = (kw, isTolerant) => {
                const cleanKw = kw.replace(/\s+/g, "");
                const tokens = cleanKw.split("").map(c => escapeRegExp(c));
                
                if (!isTolerant) {
                    // 严格模式：字与字之间，仅允许存在空白符（空格、换行、Tab等）
                    return new RegExp(`(${tokens.join("\\s*")})`, 'gi');
                } else {
                    // 宽容模式：字与字之间，允许存在至多 3 个任意杂字
                    return new RegExp(`(${tokens.join("\\s*(?:[\\s\\S]{0,3}?)\\s*")})`, 'gi');
                }
            };

            if (resultData && resultData.snippets && resultData.snippets.length > 0) {
                previewBox.style.display = 'flex';
                header.style.color = '#abb2bf';
                
                let displayCount = resultData.snippets.length;
                let countStr = displayCount == 1 ? `1 snippet` : `${displayCount} snippets`;
                
                header.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75%;">${resultData.title}</span>
                        <span style="color: #61afef; font-size: 11px; white-space: nowrap;">${countStr}</span>
                    </div>
                `;

                const isTolerant = resultData.isTolerantMatch;
                const hlRegex = buildSnippetRegex(keyword, isTolerant);

                const hlStyle = isTolerant 
                    ? 'color: #f59e0b; font-weight: bold; background: rgba(252, 211, 77, 0.2); border-bottom: 1px dashed #f59e0b;' 
                    : 'color: #e5c07b; font-weight: bold; background: rgba(229, 192, 123, 0.2);';

                let singleHtml = resultData.snippets.map((snip, index) => {
                    let safeSnip = snip.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    let highlighted = safeSnip.replace(hlRegex, `<span style="${hlStyle}">$1</span>`);
                    return `<div style="margin-bottom: 12px; border-bottom: 1px dashed #4b5263; padding-bottom: 8px;"><span style="color: #61afef; font-size: 11px;">[${index + 1}]</span> ${highlighted}</div>`;
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

    // ---------------- 核心右击逻辑 (contextmenu) ----------------
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
                    // 状态：如果在播放同一个媒体，切换播放/暂停
                    if (mediaEl.paused) {
                        mediaEl.play();
                        // 恢复波浪线动画
                        scrollContent.querySelectorAll('.wave-bar').forEach(b => b.classList.remove('paused'));
                    } else {
                        mediaEl.pause();
                        // 暂停波浪线动画
                        scrollContent.querySelectorAll('.wave-bar').forEach(b => b.classList.add('paused'));
                    }
                } else {
                    // 状态：首次右击，生成弹窗，注入内容并自动播放
                    previewBox.style.display = 'flex';
                    previewBox.classList.add('image-preview-mode'); // 复用无 Header 背景
                    
                    const isVideo = type === 'video' || /\.(mp4|webm|ogg)$/i.test(path);
                    if (isVideo) {
                        scrollContent.innerHTML = `<video src="${path}" data-path="${path}" loop style="max-width: 450px; max-height: 350px; width: 100%; outline: none; object-fit: contain;"></video>`;
                    } else {
                        const filename = path.split('/').pop();
                        // 音频：加入 CSS 动态波浪线和标题
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
                    
                    // 初始化 10% 音量与播放
                    mediaEl = scrollContent.querySelector('video, audio');
                    mediaEl.volume = 0.1;
                    mediaEl.play().catch(err => console.warn("Auto-play prevented", err));
                }
                return; // 处理完毕，结束执行
            }

            // 对于 HTML 条目，原有逻辑：切换是否暂停滚动
            if (type === 'html' && previewBox.style.display === 'flex' && !previewBox.classList.contains('image-preview-mode')) {
                isPaused = !isPaused; 
                previewBox.style.borderColor = !isPaused ? '#e5c07b' : '#61afef';
                const header = document.getElementById('preview-header');
                if (header) header.style.color = !isPaused ? '#e5c07b' : '#abb2bf';
            }
        }
    });

    // ---------------- 鼠标离开 ----------------
    elSearchResults.addEventListener('mouseleave', () => {
        destroyMediaPreview();
    });
    
    // ---------------- 左键点击打开 ----------------
    elSearchResults.addEventListener('click', () => {
        destroyMediaPreview();
    });
}
function processAndShowResults(results, keyword) {
    let finalResults = [...(results || [])];

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

    // [修复点 1] 无论如何，先把最新的结果写入缓存。解决原版因 early return 导致完全没有缓存的问题。
    // 🚀 修复点：严格阻断 @ 开头的控制符指令污染持久化缓存数据库
    if (activeKw !== "" && !activeKw.startsWith('@')) {
        // [修复点 2] 连贯异步链：保证写入 IDB 完成后再发送指令，彻底终结与 LOCAL_SEARCH_RESULT 的竞态错位
        store.SearchCache.set(activeKw, finalResults).then(() => {
            if (currentIndex === -1) {
                sendToIframe('content', 'LOCAL_SEARCH_COUNT', activeKw);
            }
        });
    }

    // [修复点 3] 将针对当前页面的置顶处理和 UI 渲染移到缓存动作下方
    if (currentIndex !== -1) {
        const currentItem = finalResults.splice(currentIndex, 1)[0];
        finalResults.unshift(currentItem);
        updateSearchResults(finalResults);
        return;
    }

    // 不满足特殊条件时，正常显示
    updateSearchResults(finalResults);
}

// 搜索
async function search(rawKeyword) {
    if (typeof rawKeyword !== "string" || !rawKeyword.trim()) {
        updateSearchResults([]);
        return;
    }
    const kw = rawKeyword.trim();
    
    // 发起新搜索前，Token 自增并记录当前请求的版本
    const currentToken = ++window._searchToken; 
    const cached = await store.SearchCache.get(kw);
    if (cached) {
        // 如果命中缓存，也要比对 Token，防止缓存的瞬间读取覆盖了后面新输入的请求
        if (currentToken === window._searchToken) {
            processAndShowResults(cached, kw);
        }
        return;
    }
    
    try {
        if (!searchWorker) {
            console.warn("搜索引擎尚未就绪");
            return;
        }
        searchWorker.postMessage({
            type: 'SEARCH',
            payload: { keyword: kw, token: currentToken } // 把 Token 传给 Worker
        });
    } catch (err) {
        console.error("web worker 通信失败", err);
    }
}

// 提示补全
async function updateAutocompleteSuggestions(val) {
    const elSearchHistory = $("#searchHistory");
    elSearchHistory.innerHTML = "";
    
    if (!val || val.trim() === "") {
        showSearchHistoryByTime();
        return;
    }

    const query = val.trim().toLowerCase();
    const suggestionMap = new Map(); // keyword -> isHistory (boolean)

    // 第一级：用户搜索历史 (正式条目)
    const history = store.searchHistory || [];
    history.forEach(item => {
        if (item.keyword.toLowerCase().includes(query)) {
            suggestionMap.set(item.keyword, true); // true 代表正式历史
        }
    });

    // 第二级：IndexedDB 缓存池的 Key (联想词/孤儿缓存)
    try {
        const cacheKeys = await dbProxy.getAllKeys('search_cache');
        cacheKeys.forEach(key => {
            if (typeof key === 'string' && key.toLowerCase().includes(query)) {
                // 如果该词不在历史中，则标记为纯联想词
                if (!suggestionMap.has(key)) {
                    suggestionMap.set(key, false); // false 代表联想词
                }
            }
        });
    } catch (e) {
        console.warn("读取缓存 Key 失败", e);
    }

    const rawList = Array.from(suggestionMap.entries()).map(([keyword, isHistory]) => ({ keyword, isHistory }));
    
    // 最长的、最完整的词条排前
    rawList.sort((a, b) => b.keyword.length - a.keyword.length);

    // 冗余前缀剪枝
    const filteredSuggestions = [];
    for (const item of rawList) {
        const itemLower = item.keyword.toLowerCase();
        if (itemLower === query) {
            filteredSuggestions.push(item);
            continue;
        }
        // 🚀 修复点：严禁剪枝用户真实的历史记录（isHistory 为 true 时免疫剪枝）
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

// 键名归一
function normalizeKeyword(kw) {
    if (!kw || typeof kw !== 'string') return '';
    return kw.trim().toLowerCase().replace(/\s+/g, '');
}

// 搜索结果填充
function updateSearchResults(results) {
    // 将最新结果挂载到全局供 Hover 读取
    window._currentRenderedResults = results;

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

            // option.text = (isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "") + `${title} [${result.count}]`;
            const tolerantTag = result.isTolerantMatch ? " ❓" : "";
            option.text = (isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "") + `${title} [${result.count}]${tolerantTag}`;

            option.style.opacity = (isPrivate ? (store.online_flag === "1" ? 0.5 : 1) : 1);
            option.dataset.path = result.path;
            option.dataset.type = result.type;
            if (isPrivate) {
                option.dataset.localOnly = "true";
            }
            if (markedUrls.has(result.path)) {
                option.style.textDecoration = "line-through";
            }
            
            fragment.appendChild(option); // 装入虚拟容器
        });
        
        resultsBox.appendChild(fragment); 
        resultsBox.setAttribute("size", Math.max(2, Math.min(10, resultsBox.options.length)));
        resultsBox.style.display = "block";
        
        // 根据当前已稳定的视口计算出真实的极限宽度
        if ($("#content") && $("#search")) {
            const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
            resultsBox.style.maxWidth = maxW + "px";
        }
        
        resultsBox.style.left = `-${resultsBox.offsetWidth}px`;
        resultsBox.selectedIndex = -1;
    }
}

// doc 公共逻辑
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
    window.sendToParent = function (type, payload) {
        parent.postMessage({ type, payload, from: childId }, '*');
    };
    window.sendToSibling = function (targetId, type, payload) {
        const target = window.parent.document.getElementById(targetId)?.contentWindow;
        if (target) target.postMessage({ type, payload, from: childId, to: targetId }, '*');
    };

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

// doc-gallery 专属逻辑
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

    window.enableDrag = function (target) {
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

    window.enableDrag(img);

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
        sendToParent("image"); sendToSibling('side', '#gallery a', nPath);
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
        sendToParent("lightbox", { status: store.lightbox_stauts });
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
};

// doc-video 专属逻辑
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
        sendToParent("video"); sendToSibling('side', '#video a', nPath);
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
        sendToParent("lightbox", { status: store.lightbox_stauts });
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

// doc 引擎
function generateDoc(type, payload) {
    const commonStyles = `@charset "UTF-8";@import url("../src/css/font.css");html,body,pre,textarea{font-family:'Noto Serif SC'}html{background-color:#000;touch-action:none;}body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;position:relative;overflow:hidden;touch-action:none;}.span-container{position:absolute;bottom:10px;right:10px;background:plum;z-index:999}.span-container span{margin-bottom:5px;padding:0 10px;cursor:pointer}.hide{opacity:.2!important}#f{display:none}`;
    
    const baseTag = `<base href="${window.location.href}">`;
    const viewportMeta = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>`;
    let htmlStr = '';
    
    if (type === 'image') {
        const { imageUrl } = payload;
        const jsUrl = JSON.stringify(imageUrl);

        htmlStr = `<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}${viewportMeta}<style>${commonStyles} img{z-index:1;max-height:100vh;max-width:100vw;visibility:hidden}#loader{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999}.bar-spinner{width:40px;height:40px;position:relative;animation:spin 1s linear infinite}.bar{width:4px;height:20px;background:pink;border-radius:2px;position:absolute;top:10px;left:18px;transform-origin:center bottom}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body>
        <div id="loader"><div class="bar-spinner"><div class="bar"></div></div></div>
        <img id="img">
        <div class="span-container"><span id="fs" title="全屏(或按鼠标中键)">[F]</span><span id="c"></span><span id="p">prev</span><span id="i"></span><span id="n">next</span><span id="f"></span></div>
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

// 快照封装
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

// 状态快照
function snap() {
    if ('serviceWorker' in navigator) {
        let isRefreshing = false;
        let hadController = !!navigator.serviceWorker.controller;
        
        navigator.serviceWorker.addEventListener('controllerchange', async () => {
            const lastReload = sessionStorage.getItem("sw_reload_guard");
            const now = Date.now();

            if (lastReload && (now - parseInt(lastReload) < 5000)) {
                    console.error("🚨 检测到 SW 无限刷新死循环，已强制阻断！");
                    return;
            }

            if (window._isBombing || isRefreshing) return;

            if (!hadController) {
                hadController = true;
                return;
            }

            await Promise.resolve();
            isRefreshing = true;
            store.force_refresh_cache = "1";

            sessionStorage.setItem("sw_reload_guard", now.toString());
            takeSnapshot(true);
        });
    }
}

// 快照恢复
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
        console.error("快照解析失败，已丢弃脏数据", e);
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

    // 目录树核对
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
                // 如果已经找到，或者当前节点无效，直接跳出
                if (found || !node || typeof node !== 'object') return;
                // 检查当前目录的文件列表
                if (Array.isArray(node._f) && node._f.some(f => f[0] === targetFileName)) {
                    found = true;
                    return;
                }
                // 递归深入子文件夹
                for (const key of Object.keys(node)) {
                    if (key !== '_f') scanNode(node[key]);
                }
            };
            scanNode(window.lite_data[bucket]);
            return found;
        }

        // 对于保留了完整路径的资源 (Image/Video/Audio/Ebook)，继续顺藤摸瓜
        let parts = clean.split('/');
        if (parts.length === 1) parts = ['_uncategorized', parts[0]];
        const fileName = parts.pop();
        let curr = window.lite_data[bucket];
        for (const p of parts) {
            // 目录发生重组或被删除
            if (!curr || !curr[p]) 
                return false;
            curr = curr[p];
        }

        // 终点查验：在对应目录的 _f 数组中确认该文件是否存在
        return curr && curr._f && Array.isArray(curr._f) && curr._f.some(f => f[0] === fileName);
    };

    // 校验主视图 (涵盖 html, gallery, video, ebook)
    let needsBookmarkFallback = false;
    if (state.main_type && state.main_path) {
        let bucket = state.main_type;
        // 统一映射到 LITE_DATA 的大桶名
        if (['pdf', 'epub', 'txt'].includes(bucket)) bucket = 'ebook';
        if (bucket === 'image') bucket = 'image';
        if (!checkDataIntegrity(bucket, state.main_path)) {
            console.warn(`🚨 ${bucket} 目录结构已变或文件丢失，正在销毁脏数据:`, state.main_path);

            // 清洗 ls：重置该分类的数组和路径记录
            if (bucket === 'image') { store.imagelist = []; store.image_path = ""; }
            else if (bucket === 'video') { store.videolist = []; store.video_path = ""; }
            else if (bucket === 'ebook') { store.pdf_path = ""; store.epub_path = ""; store.txt_path = ""; }
            else if (bucket === 'html') { store.last_html = ""; }

            // 清洗导航历史中的遗留死链
            let hist = store.last_li_a;
            if (Array.isArray(hist)) store.last_li_a = hist.filter(p => p !== state.main_path);
  
            state.main_type = null;
            state.main_path = null;
            needsBookmarkFallback = true;
        }
    }

    // 校验音频隐藏视图
    if (state.audio_strict && state.audio_strict.path) {
        if (!checkDataIntegrity('audio', state.audio_strict.path)) {
            console.warn(`🚨 audio 目录结构已变，正在销毁音频脏数据:`, state.audio_strict.path);
            store.playlist = [];
            store.song_path = "";
            state.audio_strict = null;
            needsBookmarkFallback = true; // 音频出问题也可以考虑回退或至少不报错
        }
    }
    // 如果发现解体，强制跳回书签页，修复全局标识
    if (needsBookmarkFallback) {
        store.resource_type = "bookmark";
        store.content_src = "src/tpl/bookmark.html";
        store.lightbox_stauts = "0";
        iframes.content.src = "src/tpl/bookmark.html";

        // 发送更新菜单指令，切断后续异常链条
        sendToIframe('side', 'update_bookmark_menu', null);
    }

    try {
        if (state.main_type && state.main_path) {
            let sel = state.main_type;
            if (['pdf', 'epub', 'txt'].includes(sel)) sel = 'ebook';
            if (sel === 'image') sel = 'gallery';
            sendToIframe('side', '#' + sel + ' a', state.main_path);
            sendToIframe('side', 'show_current');
            // 独立还原视频进度
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

    // 音频
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

    // 搜索框
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

// 音频播放器
function audio(_song, _level) {
    const oldAudio = $("#audio"); if (oldAudio) oldAudio.remove();
    const oldBtn = $("#audio_btn"); if (oldBtn) oldBtn.remove();
    audioInitialized = true;

    let playMode = 'list';
    let songs = store.playlist || [];
    let currentSongIndex = Math.max(0, songs.indexOf(_song));

    document.body.insertAdjacentHTML('beforeend', `<div id="audio"> <div class="audio-progress"><div class="audio-progress-bar" id="a_bar"></div></div> <div class="audio_div"> <div class="header" id="a_hdr">${(_level && _level.includes("audio/")) ? (_level.split("audio/")[1] || "未分类/") : "未分类/"}</div> <ul class="playlist" id="_playlist"></ul><br> <button id="btn_prv">Prev</button><button id="btn_nxt">Next</button><br> <button id="btn_favs">Favorite Songs</button><button id="btn_all">All</button><br> <button id="btn_shf">Shuffle</button><button id="btn_slp">Single Loop</button><button id="btn_llp">List Loop</button><br> <button id="fav">+Fav-</button><audio id="_audio" controls></audio><button id="btn_cls">destroy</button> </div> </div> <button id="audio_btn" title="单击显隐, 双击销毁"> 🎵 </button>`);

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
        sendToIframe('side', 'UPDATE_FAV_LIST', null);
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

// 评论映射
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

// 评论窗口
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

// giscus 挂载
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

// 调整搜索框边距
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

// 调整右栏宽度
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

// 通用拖拽
function makeDraggable(popupSelector, headerSelector) {
    const popup = $(popupSelector);
    const header = $(headerSelector);
    if (!popup || !header) return;

    let isDragging = false;
    let startX = 0, startY = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        
        const rect = popup.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;

        popup.style.width = rect.width + 'px';
        popup.style.height = rect.height + 'px';
        
        popup.style.position = 'fixed';
        popup.style.margin = '0';
        popup.style.transform = 'none';

        header.style.cursor = 'moving';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const left = e.clientX - startX;
        const top = e.clientY - startY;
        
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

// 防死锁工具
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

// 拼音文件加载
function loadPinyinData(maxRetries = 300) {
    // 30次 容忍 SW 在后台下 1 分钟
    let attempts = 0;
    const checkAndLoad = async () => {
        try {
            // 构建绝对路径，用于匹配SW缓存里的Key
            const targetUrl = new URL('/src/js/pinyinData.js', window.location.origin).href;
            // 去翻底层缓存抽屉
            const cachedRes = await caches.match(targetUrl, { ignoreSearch: true });
            if (cachedRes && cachedRes.ok) {
                // 拿到后把js代码以纯文本形式抽出来
                const scriptText = await cachedRes.text();
                // 用“内联代码块”的方式注入内存
                const pinyinScript = document.createElement("script");
                pinyinScript.type = "text/javascript";
                pinyinScript.charset = "UTF-8";
                pinyinScript.textContent = scriptText;
                document.body.appendChild(pinyinScript);
                // 注入后秒删 DOM 节点
                pinyinScript.remove();
            } else {
                // 抽屉里暂时还没有,抛出异常触发重试
                throw new Error("Cache Miss");
            }
        } catch (e) {
            attempts++;
            if (attempts < maxRetries) {
                // 再翻一遍抽屉
                setTimeout(checkAndLoad, 2000);
            } else {
                console.error("❌ pinyinData.js 等待 SW 下载超时");
            }
        }
    };
    // 浏览器完全空闲时才去翻抽屉
    idleRun(checkAndLoad);
}

// 安全版定时器
function safeInterval(fn, interval, maxDrift = interval * 2) {
    let last = Date.now();
    return setInterval(() => {
        const now = Date.now();
        const drift = now - last;
        // 如果时间跳变太大（比如休眠）直接跳过，不执行 fn
        if (drift > maxDrift) {
            last = now;
            return;
        }
        last = now;
        fn();
    }, interval);
}

// localStorage容量告警
function ls_alert() {
    const runCheck = () => {
        // 4MB 告警线
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

// 日志弹出层
async function showChangelog() {
    let popup = $('#changelog-popup');

    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'changelog-popup';

        const header = document.createElement('div');
        header.id = 'changelog-header';
        header.innerHTML = `<span class="cl-title">What's new?</span><div><button id="clear-changelog" class="cl-btn">Clear log</button><button id="close-changelog" class="cl-btn">Close</button></div>`;

        const content = document.createElement('div');
        content.id = 'changelog-content';
        popup.append(header, content);
        document.body.appendChild(popup);

        $('#close-changelog').onclick = () => popup.style.display = 'none';
        $('#clear-changelog').onclick = async () => {
            if (confirm("确定要清空所有更新记录吗？")) {
                await dbProxy.clearLogs();
                $('#changelog-content').innerHTML = '<div style="color: gray;">暂无记录</div>';
            }
        };
        makeDraggable('#changelog-popup', '#changelog-header');
    }

    popup.style.display = 'flex';
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
        logs.forEach(log => {
            if (lastTs !== null && (lastTs - log.ts > 60000)) {
                html += `<div style="color: #000; margin: 4px 0; overflow: hidden; white-space: nowrap; font-weight: bold; opacity: 0.5;">------------------------------------------------------------------------------------------------------------------------</div>`;
            }
            lastTs = log.ts;

            const d = new Date(log.ts);
            const dateStr = `[${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;

            let textColor = '#333333';
            if (/删除/.test(log.msg)) {
                textColor = '#cc0000';
            } else if (/新增/.test(log.msg)) {
                textColor = '#008000';
            } else if (/更新/.test(log.msg)) {
                textColor = '#0033cc';
            }

            html += `<div style="color: ${textColor}; margin-bottom: 2px;">${dateStr} ${log.msg}</div>`;
        });
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div style="color: red;">读取日志失败</div>';
    }
}

// 留言薄弹出层
function showGuestbook() {
    let popup = $('#guestbook-popup');

    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'guestbook-popup';
        popup.style.cssText = 'position: fixed; top: 10vh; left: calc(50vw - 320px); width: 640px; height: 80vh; background: #fff; z-index: 10001; display: none; flex-direction: column; border: 1px solid #333; box-shadow: 0 5px 20px rgba(0, 0, 0, 0.3); border-radius: 4px; overflow: hidden;';

        const header = document.createElement('div');
        header.id = 'guestbook-header';
        header.style.cssText = 'height: 35px; background: #eee; cursor: move; display: flex; justify-content: space-between; align-items: center; padding: 0 15px; user-select: none; flex-shrink: 0; border-bottom: 1px solid #ccc; font-size: 14px; color: #333;';
        header.innerHTML = `<span class="cl-title">Guestbook</span><div><button id="close-guestbook" class="cl-btn" style="cursor: pointer; padding: 1px 6px;">Close</button></div>`;

        const content = document.createElement('div');
        content.id = 'guestbook-content';
        content.style.cssText = 'flex: 1; overflow: hidden; background: #fafafa; display: flex;';
        
        content.innerHTML = `<iframe src="https://docs.google.com/forms/d/e/1FAIpQLScR2uk18TnJyaKM05n9Y1CJooXqxRHniHB5qsIS3tQ0lFNBew/viewform?embedded=true" width="100%" height="100%" frameborder="0" marginheight="0" marginwidth="0">Loading…</iframe>`;

        popup.append(header, content);
        document.body.appendChild(popup);

        $('#close-guestbook').onclick = () => popup.style.display = 'none';
        makeDraggable('#guestbook-popup', '#guestbook-header');
    }

    popup.style.display = 'flex';
}

// 标签页时钟
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
        img.onload = function() {
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

// 撒花特效
function playConfetti() {
    const startAnimation1 = () => {
        const end = Date.now() + 5 * 1000;
        const colors = ['#bb0000', '#ffffff'];
        (function frame() {
            confetti({
                particleCount: 2,
                angle: 60,
                spread: 55,
                origin: { x: 0 },
                colors
            });

            confetti({
                particleCount: 2,
                angle: 120,
                spread: 55,
                origin: { x: 1 },
                colors
            });

            if (Date.now() < end) {
                requestAnimationFrame(frame);
            }
        })();
    };

    const startAnimation2 = () => {
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

    const startAnimation = () => {
        const animations = [startAnimation1, startAnimation2];
        const randomAnimation = animations[Math.floor(Math.random() * animations.length)];
        randomAnimation();
    };

    if (window.confetti) {
        startAnimation();
        return;
    }

    const script = document.createElement('script');
    script.src = "src/js/confetti.browser.min.js";
    script.onload = () => {
        script.remove();
        startAnimation();
    };
    script.onerror = () => console.warn("confetti.browser.min.js 加载失败");
    document.body.appendChild(script);
}

// 配置字典
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

// UI 工厂
const ProtocolUIFactory = {
    create: (config) => {
        const overlay = document.createElement('div');
        overlay.className = 'proto-overlay';

        const box = document.createElement('div');
        box.className = 'proto-box';

        // 若 options 为空，则生成空列表供后续动态填充
        const checkboxesHTML = (config.options || []).map(opt => 
            `<label class="proto-label"><input type="checkbox" checked value="${opt.key}"> ${opt.label}</label>`
        ).join('');

        box.innerHTML = `<h2 class="proto-h2"><span>${config.title}</span></h2>
                         <div class="proto-desc">${config.desc}</div>
                         <div class="proto-list">${checkboxesHTML}</div>
                         <div class="proto-btn-group">${config.buttons}<button class="proto-btn-cancel">返回</button></div>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

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

// --- 数据恢复核心逻辑 ---
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
        } catch(err) { console.error("恢复失败: ", err); }
    }
};

// 数据重置 (Bomb)
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
                if (selections.includes('excerpts') && typeof ExcerptsSys !== 'undefined') { data.excerpts_backup = {}; try { const booksMeta = await ExcerptsSys.getAllBooks(); await Promise.all(booksMeta.map(async (b) => { const bData = await ExcerptsSys.getBookData(b.name); data.excerpts_backup[b.name] = bData; })); } catch(err) { console.error("摘抄备份异常: ", err); } }
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

// 数据导入 (Rebirth)
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
                            switch(opt.key) {
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

// 定时备份
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
                        } catch(err) { 
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

                // 只有真正完成备份后才更新时间
                localStorage.setItem('last_backup_timestamp', now.toString());

            } else {
                // 取消后一天后再提醒
                const delayOneDay = now - BACKUP_INTERVAL_MS + 24 * 60 * 60 * 1000;
                localStorage.setItem('last_backup_timestamp', delayOneDay.toString());
            }
        }
    };

    setTimeout(checkBackupStatus, 5000);
    
    // 如果一直挂着网页不关，利用现成的 safeInterval 每天做一次静默巡检
    if (typeof safeInterval === 'function') {
        safeInterval(checkBackupStatus, 24 * 60 * 60 * 1000); 
    }
}

// 摘抄库引擎
const ExcerptsSys = {
    dbName: 'ExcerptsDB',
    storeName: 'books',
    init: async function() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(this.storeName);
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        });
    },
    save: async function(bookName, text) {
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
    // 获取所有书目元数据（用于左侧列表与过滤排序）
    getAllBooks: async function() {
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
    // 读取某本书的全部摘抄条目
    getBookData: async function(bookName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(bookName);
            req.onsuccess = () => resolve(req.result || { excerpts: [] });
            req.onerror = () => reject(req.error);
        });
    },
    // 回写覆写整本书的摘抄包
    overwriteBook: async function(bookName, excerptsArray) {
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
    // 删除当前表
    deleteBook: async function(bookName) {
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

    initPanel: function() {
        if (document.getElementById('excerpts-popup')) return;

        const html = `
        <div id="excerpts-popup" style="display:none; position:fixed; top:10vh; left:calc(50vw - 400px); width:800px; height:80vh; background:#fff; border:1px solid #333; box-shadow:0 5px 20px rgba(0,0,0,0.3); z-index:10001; flex-direction:column; border-radius:4px; overflow:hidden;">
            <div id="excerpts-header" style="height:35px; background:#eee; cursor:move; display:flex; justify-content:space-between; align-items:center; padding:0 15px; flex-shrink:0; border-bottom:1px solid #ccc; user-select:none; font-size:14px; color:#333;">
                <span class="cl-title" style="color: red;">Excerpts</span>
                <div><button id="close-excerpts" class="cl-btn" style="margin-left: 10px; cursor: pointer; padding: 1px 6px;">Close</button></div>
            </div>
            
            <div style="flex:1; display:flex; overflow:hidden; background:#f8fafc;">
                <!-- （内部布局与原代码保持一致，省略未改动部分）... -->
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
        
        document.body.insertAdjacentHTML('beforeend', html);
        this.bindPanelEvents();
    },

    bindPanelEvents: function() {
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

    toggleSort: function(type) {
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

    openAndRefresh: async function() {
        this.initPanel();
        document.getElementById('excerpts-popup').style.display = "flex";
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

    renderLeftList: function() {
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

    renderRightRecords: async function() {
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

            const adjustHeight = function() {
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

// 全局右键书签列表
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