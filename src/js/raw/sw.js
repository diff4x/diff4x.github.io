importScripts('/src/js/core-list.js?v=1795667183766');
const _scMeta = typeof FILE_MANIFEST === 'object' && FILE_MANIFEST && FILE_MANIFEST['/src/js/site-core.js'];
importScripts('/src/js/site-core.js' + (_scMeta && _scMeta.hash ? ('?v=' + _scMeta.hash) : ''));

self.SW_VERSION = '1795667183766';
self.EMERGENCY = 'repair_command_id=2';

const CACHE_NAME_CORE = 'core-cache-' + BUILD_VERSION;
const CACHE_NAME_MEDIA = 'media-cache';
const MAX_HTML_SNAPSHOT_HISTORY = 10;

function sortFatDataFiles(names) {
    return names.slice().sort((a, b) => {
        const ma = /fat_data_(\d+)\.json$/.exec(a);
        const mb = /fat_data_(\d+)\.json$/.exec(b);
        if (ma && mb) return Number(ma[1]) - Number(mb[1]);
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

function buildCoreListResponse(manifestObj, version, isOfflineFallback) {
    const fatFiles = sortFatDataFiles(
        Object.keys(manifestObj || {})
            .filter(k => k.startsWith('/src/js/data/fat_data_') && k.endsWith('.json'))
            .map(k => k.slice('/src/js/data/'.length))
    );
    const dataIndex = ['lite_data.js', ...fatFiles];
    const body =
        `window.BUILD_VERSION = ${JSON.stringify(String(version || 'offline'))};` +
        `window._isOfflineDataFallback = ${isOfflineFallback ? 'true' : 'false'};` +
        `window.FILE_MANIFEST = ${JSON.stringify(manifestObj || {})};` +
        `window.dataIndex = ${JSON.stringify(dataIndex)};`;
    return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
    });
}
const IS_LOCAL_MODE = (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1' ||
    self.location.protocol === 'file:'
) && self.location.port !== '9000';
const inFlightRequests = new Map();

const getConnectionType = () => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn || !conn.effectiveType) return '4g';
    return conn.effectiveType;
};

let mainDbOpenPromise = null;

function openMainDB() {
    if (mainDbOpenPromise) return mainDbOpenPromise;

    mainDbOpenPromise = self.SiteCore.openMainDB(() => {
        console.warn('⚠️ [SW] MainDB 升级被其他连接阻塞');
    }).then((db) => {
        db.onversionchange = () => {
            db.close();
            mainDbOpenPromise = null;
        };
        db.onclose = () => {
            mainDbOpenPromise = null;
        };
        return db;
    }).catch((err) => {
        mainDbOpenPromise = null;
        throw err;
    });

    return mainDbOpenPromise;
}

const writeLog = async (msg) => {
    try {
        const db = await openMainDB();
        if (!db.objectStoreNames.contains('update_logs')) return;
        const tx = db.transaction('update_logs', 'readwrite');
        tx.objectStore('update_logs').add({ msg, ts: Date.now() });
    } catch (e) { }
};

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const newCache = await caches.open(CACHE_NAME_CORE);
        const cacheNames = await caches.keys();
        let lastCacheName = cacheNames
            .filter(n => n.startsWith('core-cache-') && n !== CACHE_NAME_CORE)
            .sort()
            .pop();
        if (!lastCacheName && cacheNames.includes(CACHE_NAME_CORE)) {
            lastCacheName = CACHE_NAME_CORE;
        }

        let oldManifest = {};
        if (lastCacheName) {
            try {
                const lastCache = await caches.open(lastCacheName);
                const manifestUrl = new URL('/sw-manifest.json', self.location.origin).href;
                const manifestRes = await lastCache.match(manifestUrl);
                if (manifestRes) oldManifest = await manifestRes.json();
            } catch (err) {
                console.warn("⚠️ [SW] Manifest read failed, fallback to full-sync.", err);
                oldManifest = {};
            }
        }

        const CRITICAL_URLS = new Set([
            '/',
            '/index.html',
            '/src/js/site-core.js',
            '/src/js/index.js',
            '/src/js/shared-utils.js',
            '/src/js/book-db.js',
            '/src/js/search-engine.js',
            '/src/js/search-preview.js',
            '/src/js/search-ui.js',
            '/src/js/snapshot.js',
            '/src/js/side.js',
            '/src/js/content.js',
            '/src/js/data/lite_data.js',
            '/src/js/worker.js',
            '/src/wasm/compute_intensive_task_processor.min.js',
            '/src/wasm/compute_intensive_task_processor_bg.wasm'
        ]);
        const cachedUrls = new Set();
        const fallbackUrls = new Set();

        const fetchWithConcurrency = async (urls, maxConcurrent) => {
            const results = [];
            const executing = new Set();

            for (const url of urls) {
                const task = (async () => {
                    try {
                        const response = await fetchWithLock(new Request(url, { cache: 'no-cache' }));
                        if (!response || !response.ok) {
                            throw new Error(`HTTP ${response ? response.status : 'ERR'}`);
                        }
                        if (url !== '/') {
                            if (oldManifest[url]) {
                                await writeLog(`🔄 [SW] 更新文件: ${url}`);
                            } else if (isUpdate) {
                                await writeLog(`✅ [SW] 新增文件: ${url}`);
                            }
                        }
                        await newCache.put(url, response);
                        cachedUrls.add(url);
                    } catch (err) {
                        console.warn(`[SW] Fetch failed: ${url}`, err);
                        if (CRITICAL_URLS.has(url)) {
                            throw err;
                        }
                        if (lastCacheName) {
                            try {
                                const lastCache = await caches.open(lastCacheName);
                                const fallbackRes = await lastCache.match(url);
                                if (fallbackRes) {
                                    await newCache.put(url, fallbackRes);
                                    cachedUrls.add(url);
                                    fallbackUrls.add(url);
                                }
                            } catch (_) { }
                        }
                    }
                })();

                results.push(task);
                executing.add(task);

                const clean = () => executing.delete(task);
                task.then(clean).catch(clean);

                if (executing.size >= maxConcurrent) await Promise.race(executing);
            }
            return Promise.all(results);
        };

        const isUpdate = Object.keys(oldManifest).length > 0;
        self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
            clients.forEach(client => {
                client.postMessage({
                    type: 'SW_UPDATE_STATUS',
                    isUpdate: isUpdate
                });
            });
        });

        const CORE_BUNDLE_THRESHOLD = 15;
        let bundleUpdates = [];
        let standaloneUpdates = [];
        const deferredJobs = [];
        let needSearchCacheClear = false;

        for (const url of allFilesToCache) {
            const meta = FILE_MANIFEST[url];
            const oldMeta = oldManifest[url];

            if (
                url.endsWith('synonyms.js') ||
                url.endsWith('.wasm') ||
                url.endsWith('compute_intensive_task_processor.min.js')
            ) {
                if (!oldMeta || oldMeta.hash !== meta.hash) {
                    needSearchCacheClear = true;
                }
            }

            if (oldMeta && oldMeta.hash !== meta.hash && (url.startsWith('/html/') || url.toLowerCase().endsWith('.md'))) {
                deferredJobs.push(async () => {
                    try {
                        const lastCache = await caches.open(lastCacheName);
                        const oldRes = await lastCache.match(url);
                        if (oldRes) {
                            const oldText = await oldRes.text();
                            const compressedData = await compressText(oldText);

                            const db = await openMainDB();

                            const tx = db.transaction('html_snapshots', 'readwrite');
                            const store = tx.objectStore('html_snapshots');

                            const existing = await new Promise(resolve => {
                                const r = store.get(url);
                                r.onsuccess = () => resolve(r.result || null);
                                r.onerror = () => resolve(null);
                            });

                            let history = [];
                            if (existing) {
                                if (Array.isArray(existing.history)) {
                                    history = existing.history.slice();
                                } else if (typeof existing.text === 'string') {
                                    history = [{ text: existing.text, ts: existing.ts || Date.now() }];
                                }
                            }

                            let snapTs = Date.now();
                            if (url.startsWith('/html/')) {
                                const stampMatch = oldText.match(/id=['"]anchor['"][^>]*>\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
                                if (stampMatch) {
                                    const parsedTs = new Date(
                                        Number(stampMatch[1]), Number(stampMatch[2]) - 1, Number(stampMatch[3]),
                                        Number(stampMatch[4]), Number(stampMatch[5]), Number(stampMatch[6])
                                    ).getTime();
                                    if (Number.isFinite(parsedTs) && parsedTs > 0) snapTs = parsedTs;
                                }
                            } else {
                                const cacheVerMatch = /^core-cache-(\d{13,15})$/.exec(lastCacheName || '');
                                if (cacheVerMatch) {
                                    const parsedTs = Number(cacheVerMatch[1]);
                                    if (Number.isFinite(parsedTs) && parsedTs > 0) snapTs = parsedTs;
                                }
                            }
                            const dupByTs = history.some(item => item && item.ts === snapTs);
                            const lastSnap = history.length > 0 ? history[history.length - 1] : null;
                            let dupByBytes = false;
                            if (lastSnap && lastSnap.text instanceof Uint8Array && lastSnap.text.length === compressedData.length) {
                                dupByBytes = true;
                                for (let bi = 0; bi < compressedData.length; bi++) {
                                    if (lastSnap.text[bi] !== compressedData[bi]) { dupByBytes = false; break; }
                                }
                            }
                            if (!dupByTs && !dupByBytes) {
                                history.push({ text: compressedData, ts: snapTs, compressed: true });
                                if (history.length > MAX_HTML_SNAPSHOT_HISTORY) {
                                    history = history.slice(history.length - MAX_HTML_SNAPSHOT_HISTORY);
                                }
                                store.put({ history }, url);
                            }
                            await new Promise(resolve => {
                                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
                            });
                        }
                    } catch (e) {
                        console.warn(`[SW] 快照生成失败: ${url}`);
                    }
                });
            }

            if (oldMeta && oldMeta.hash === meta.hash) {
                if (lastCacheName === CACHE_NAME_CORE) {
                    cachedUrls.add(url);
                    continue;
                }
                const lastCache = await caches.open(lastCacheName);
                const cachedRes = await lastCache.match(url);
                if (cachedRes) {
                    await newCache.put(url, cachedRes);
                    cachedUrls.add(url);
                    continue;
                }
            }

            if (meta.source === 'core-bundle.json') {
                bundleUpdates.push(url);
            } else {
                standaloneUpdates.push(url);
            }
        }

        if (needSearchCacheClear) {
            deferredJobs.push(async () => {
                try {
                    const db = await openMainDB();
                    if (db.objectStoreNames.contains('sys_state')) {
                        const tx = db.transaction('sys_state', 'readwrite');
                        const done = new Promise(resolve => {
                            tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
                        });
                        tx.objectStore('sys_state').put(BUILD_VERSION, 'pending_search_cache_clear');
                        await done;
                    }
                } catch (err) {
                    console.warn("⚠️ [SW] 标记 search_cache 待清理失败:", err);
                }
            });
        }

        let needBundle = false;
        if (!lastCacheName || bundleUpdates.length > CORE_BUNDLE_THRESHOLD) {
            needBundle = true;
        } else {
            standaloneUpdates.push(...bundleUpdates);
        }

        if (needBundle && bundleUpdates.length > 0) {
            try {
                const bundleRes = await fetch('/src/js/data/core-bundle.json?v=' + BUILD_VERSION, { cache: 'no-cache' });
                const bundleData = await bundleRes.json();
                const putPromises = [];

                for (const url of bundleUpdates) {
                    if (bundleData && Object.prototype.hasOwnProperty.call(bundleData, url)) {
                        let contentType = 'text/plain; charset=utf-8';
                        if (url.endsWith('.html') || url === '/') contentType = 'text/html; charset=utf-8';
                        else if (url.endsWith('.css')) contentType = 'text/css; charset=utf-8';
                        else if (url.endsWith('.json')) contentType = 'application/json; charset=utf-8';
                        else if (url.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
                        else if (url.endsWith('.md')) contentType = 'text/markdown; charset=utf-8';

                        const fakeRes = new Response(bundleData[url], {
                            headers: { 'Content-Type': contentType }
                        });
                        putPromises.push(newCache.put(url, fakeRes).then(() => cachedUrls.add(url)));
                    } else {
                        standaloneUpdates.push(url);
                    }
                }
                await Promise.all(putPromises);
                if (isUpdate) {
                    await writeLog(`✅ [SW] 从大包解压并缓存了 ${putPromises.length} 个文件`);
                }
            } catch (err) {
                console.error("❌ [SW] Core bundle parsing failed", err);
                throw new Error("Core bundle installation failed.");
            }
        }

        if (standaloneUpdates.length > 0) {
            const networkType = getConnectionType();
            let dynamicConcurrency = 4;

            if (networkType === 'slow-2g' || networkType === '2g') {
                dynamicConcurrency = 1;
            } else if (networkType === '3g' || standaloneUpdates.length > 21) {
                dynamicConcurrency = 2;
            }

            await fetchWithConcurrency(standaloneUpdates, dynamicConcurrency);
        }

        if (oldManifest) {
            const newManifestKeys = Object.keys(FILE_MANIFEST);
            const deletedFiles = Object.keys(oldManifest).filter(url => !newManifestKeys.includes(url));
            for (const url of deletedFiles) {
                if (url !== '/') await writeLog(`⛔ [SW] 删除文件: ${url}`);
                if (url.startsWith('/ebook/')) {
                    deferredJobs.push(async () => {
                        try {
                            const mediaCache = await caches.open(CACHE_NAME_MEDIA);
                            await mediaCache.delete(url, { ignoreSearch: true });
                            const enc = encodeURI(url);
                            if (enc !== url) await mediaCache.delete(enc, { ignoreSearch: true });
                        } catch (_) { }
                        await deleteBookFromBookDB(url);
                    });
                }
            }
        }

        if (deferredJobs.length > 0) {
            const queue = deferredJobs.slice();
            await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
                while (queue.length > 0) {
                    const job = queue.shift();
                    try { await job(); } catch (e) { }
                }
            }));
        }

        const committedManifest = {};
        for (const url of cachedUrls) {
            if (fallbackUrls.has(url) && oldManifest[url]) {
                committedManifest[url] = oldManifest[url];
            } else if (FILE_MANIFEST[url]) {
                committedManifest[url] = FILE_MANIFEST[url];
            }
        }
        if (typeof FILE_MANIFEST === 'object' && FILE_MANIFEST) {
            for (const k of Object.keys(FILE_MANIFEST)) {
                if (k.startsWith('/src/js/data/fat_data_') && k.endsWith('.json')) {
                    committedManifest[k] = FILE_MANIFEST[k];
                }
            }
        }
        const manifestSaveUrl = new URL('/sw-manifest.json', self.location.origin).href;
        await newCache.put(manifestSaveUrl, new Response(JSON.stringify(committedManifest), {
            headers: { 'Content-Type': 'application/json' }
        }));
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(name => {
                    if (name.startsWith('core-cache-') && name !== CACHE_NAME_CORE) {
                        return caches.delete(name);
                    }
                })
            );
        }).then(async () => {
            try {
                const db = await openMainDB();
                if (db.objectStoreNames.contains('sys_state')) {
                    const pending = await new Promise(resolve => {
                        const r = db.transaction('sys_state', 'readonly').objectStore('sys_state').get('pending_search_cache_clear');
                        r.onsuccess = () => resolve(r.result);
                        r.onerror = () => resolve(null);
                    });
                    if (pending) {
                        const stores = ['sys_state'];
                        if (db.objectStoreNames.contains('search_cache')) stores.push('search_cache');
                        const tx = db.transaction(stores, 'readwrite');
                        const done = new Promise(resolve => {
                            tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
                        });
                        if (stores.includes('search_cache')) tx.objectStore('search_cache').clear();
                        tx.objectStore('sys_state').put([], 'search_cache_lru');
                        tx.objectStore('sys_state').delete('pending_search_cache_clear');
                        await done;
                        console.warn('🧹 [SW] 激活阶段已清空旧的 search_cache 与 LRU 索引');
                    }
                }
            } catch (err) {
                console.warn('⚠️ [SW] activate 清理 search_cache 失败:', err);
            }
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    if (!event.request.url.startsWith('http')) return;
    if (url.origin !== self.location.origin) return;
    if (url.pathname.endsWith('sw.js')) return;
    if (url.pathname.startsWith('/__api/') || url.pathname === '/__auth' || url.pathname.startsWith('/__auth/') || url.pathname.startsWith('/__oauth/')) return;

    if (IS_LOCAL_MODE) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(async () => {
                    const coreCache = await caches.open(CACHE_NAME_CORE);
                    return (await coreCache.match(event.request, { ignoreSearch: true }))
                        || (await caches.match(event.request));
                })
        );
        return;
    }

    // 线上模式：core-list.js 严格与当前激活 SW 的 BUILD_VERSION / FILE_MANIFEST 对齐，
    // 防止新版 SW waiting 期间旧页面拉回新清单造成“旧代码 + 新数据”版本撕裂
    if (url.pathname.endsWith('core-list.js')) {
        event.respondWith((async () => {
            if (typeof FILE_MANIFEST === 'object' && FILE_MANIFEST && Object.keys(FILE_MANIFEST).length > 0) {
                return buildCoreListResponse(FILE_MANIFEST, BUILD_VERSION, false);
            }
            try {
                const cache = await caches.open(CACHE_NAME_CORE);
                const manifestRes = await cache.match(new URL('/sw-manifest.json', self.location.origin).href);
                if (manifestRes) {
                    const manifestObj = await manifestRes.json();
                    return buildCoreListResponse(manifestObj, BUILD_VERSION, true);
                }
            } catch (err) {
                console.error("❌ [SW] Manifest fallback failed", err);
            }
            try {
                return await fetch(event.request);
            } catch (_) {
                return buildCoreListResponse({}, 'offline', true);
            }
        })());
        return;
    }

    if (
        url.pathname.endsWith('/src/js/site-core.js') ||
        url.pathname.endsWith('/src/js/worker.js') ||
        url.pathname.endsWith('/src/js/synonyms.js') ||
        url.pathname.endsWith('compute_intensive_task_processor.min.js') ||
        url.pathname.endsWith('compute_intensive_task_processor_bg.wasm') ||
        url.pathname.endsWith('compute_intensive_task_processor.wasm')
    ) {
        event.respondWith(
            caches.open(CACHE_NAME_CORE).then(async (cache) => {
                const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
                if (cachedResponse) return cachedResponse;

                const networkResponse = await fetchWithLock(event.request, { cache: 'no-cache' });

                if (networkResponse && networkResponse.status === 200) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            })
        );
        return;
    }

    if (
        url.pathname.startsWith('/audio/') ||
        url.pathname.startsWith('/video/') ||
        url.pathname.startsWith('/gallery/') ||
        url.pathname.startsWith('/ebook/') ||
        url.pathname.includes('/cmaps/') ||
        url.pathname.includes('/third/pdfjs/web/standard_fonts/') ||
        url.pathname.includes('/third/pdfjs/web/iccs/') ||
        url.pathname.includes('/third/pdfjs/web/wasm/') ||
        url.pathname.includes('/third/pdfjs/web/images/') ||
        url.pathname.match(/\.(woff|woff2|eot|ttf|svg)$/)
    ) {
        const isFontAsset = /\.(?:woff2?|eot|ttf)$/i.test(url.pathname);
        event.respondWith(
            caches.open(CACHE_NAME_MEDIA).then(async (cache) => {
                const cached = await cache.match(event.request);
                if (cached) return cached;
                const response = isFontAsset
                    ? await fetchWithLock(event.request)
                    : await fetch(event.request);
                if (response && response.status === 200) {
                    cache.put(event.request, response.clone()).then(() => {
                        if (isFontAsset && url.pathname.startsWith('/src/css/font/') && url.search) {
                            cache.keys().then(keys => {
                                for (const k of keys) {
                                    try {
                                        const ku = new URL(k.url);
                                        if (ku.pathname === url.pathname && ku.search !== url.search) {
                                            cache.delete(k);
                                        }
                                    } catch (_) { }
                                }
                            }).catch(() => { });
                        }
                    });
                }
                return response;
            })
        );
    } else {
        event.respondWith(
            (async () => {
                const reqVer = url.searchParams.get('v');
                const manifestEntry = (typeof FILE_MANIFEST === 'object' && FILE_MANIFEST) ? FILE_MANIFEST[url.pathname] : null;
                if (reqVer && manifestEntry && String(manifestEntry.hash) !== String(reqVer)) {
                    try {
                        return await fetchWithLock(event.request);
                    } catch (_) { }
                }
                const coreCache = await caches.open(CACHE_NAME_CORE);
                const cached = await coreCache.match(event.request, { ignoreSearch: true });
                return cached || fetchWithLock(event.request);
            })()
        );
    }
});

async function fetchWithLock(request, options = {}) {
    const urlStr = typeof request === 'string' ? request : request.url;

    if (inFlightRequests.has(urlStr)) {
        const sharedResponse = await inFlightRequests.get(urlStr);
        return sharedResponse.clone();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, 30000);

    const fetchOptions = { ...options, signal: controller.signal };

    const fetchPromise = fetch(request, fetchOptions)
        .then(res => {
            clearTimeout(timeoutId);
            inFlightRequests.delete(urlStr);
            return res;
        })
        .catch(err => {
            clearTimeout(timeoutId);
            inFlightRequests.delete(urlStr);
            throw err;
        });

    inFlightRequests.set(urlStr, fetchPromise);
    const finalResponse = await fetchPromise;
    return finalResponse.clone();
}

async function compressText(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deleteBookFromBookDB(rawUrl) {
    try {
        if (typeof indexedDB === 'undefined') return;
        let key = String(rawUrl || '').split('#')[0].split('?')[0];
        if (/%[0-9A-Fa-f]{2}/.test(key)) {
            try { key = decodeURIComponent(key); } catch (_) {
                try { key = decodeURI(key); } catch (__) { }
            }
        }
        key = key.replace(/^\/+/, '');
        if (!key) return;

        if (typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            if (!dbs.some(d => d && d.name === 'BookDB')) return;
        }

        const db = await new Promise((resolve) => {
            const req = indexedDB.open('BookDB');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        if (!db) return;
        try {
            const names = [];
            if (db.objectStoreNames.contains('book_extracts')) names.push('book_extracts');
            if (db.objectStoreNames.contains('search_cache')) names.push('search_cache');
            if (names.length > 0) {
                await new Promise((resolve) => {
                    const tx = db.transaction(names, 'readwrite');
                    if (names.includes('book_extracts')) tx.objectStore('book_extracts').delete(key);
                    if (names.includes('search_cache')) {
                        const os = tx.objectStore('search_cache');
                        if (os.indexNames.contains('by_book')) {
                            const curReq = os.index('by_book').openKeyCursor(IDBKeyRange.only(key));
                            curReq.onsuccess = () => {
                                const cur = curReq.result;
                                if (cur) { os.delete(cur.primaryKey); cur.continue(); }
                            };
                        }
                    }
                    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
                });
            }
        } finally {
            db.close();
        }
    } catch (_) { }
}
