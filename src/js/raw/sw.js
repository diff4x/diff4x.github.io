/**
 * sw.js —— 站点 Service Worker（离线缓存、增量更新、历史快照留档与版本防撕裂）
 * 运行于 ServiceWorkerGlobalScope；经构建器压缩后输出至仓库根目录 /sw.js。
 */
importScripts('/src/js/core-list.js?v=1795784063176');
const _scMeta = typeof FILE_MANIFEST === 'object' && FILE_MANIFEST && FILE_MANIFEST['/src/js/site-core.js'];
importScripts('/src/js/site-core.js' + (_scMeta && _scMeta.hash ? ('?v=' + _scMeta.hash) : ''));

self.SW_VERSION = '1795784063176';
self.EMERGENCY = 'repair_command_id=2';

// 缓存桶与环境标识
const CACHE_NAME_CORE = 'core-cache-' + BUILD_VERSION;
const CACHE_NAME_MEDIA = 'media-cache';
const IS_LOCAL_MODE = (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1' ||
    self.location.protocol === 'file:'
) && self.location.port !== '9000';

// 安装与缓存可调参数
const MAX_HTML_SNAPSHOT_HISTORY = 10;   // 单篇 HTML / MD 最多保留历史快照数
const CORE_BUNDLE_THRESHOLD = 15;       // 变更超过此文件数时走 core-bundle.json 批量解包
const FETCH_TIMEOUT_MS = 30000;         // 单次资源拉取超时 (ms)

// 关键资源清单（任一拉取失败即中止 SW 安装）
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

// 运行态句柄
const inFlightRequests = new Map();
let mainDbOpenPromise = null;


// --- 清单合成、CRC32 校验与网络辅助 ---

const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
    }
    return t;
})();

function calcCrc32Hex(buf) {
    const bytes = new Uint8Array(buf);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16);
}

async function fetchVerifiedAsset(url, expectedHash) {
    const reqUrl = expectedHash ? `${url}?v=${encodeURIComponent(expectedHash)}` : url;
    let res = await fetchWithLock(new Request(reqUrl, { cache: 'no-cache' }));
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'ERR'}`);
    if (!expectedHash) return res;

    let buf = await res.arrayBuffer();
    if (calcCrc32Hex(buf) !== expectedHash) {
        const retryUrl = `${url}?v=${encodeURIComponent(expectedHash)}&_r=${Date.now()}`;
        const retryRes = await fetchWithLock(new Request(retryUrl, { cache: 'reload' }));
        if (!retryRes || !retryRes.ok) throw new Error(`HTTP ${retryRes ? retryRes.status : 'ERR'}`);
        buf = await retryRes.arrayBuffer();
        if (calcCrc32Hex(buf) !== expectedHash) {
            throw new Error(`CRC32 mismatch for ${url}`);
        }
        res = retryRes;
    }

    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(buf.byteLength));
    return new Response(buf, { status: res.status, statusText: res.statusText, headers });
}

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

const getConnectionType = () => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn || !conn.effectiveType) return '4g';
    return conn.effectiveType;
};

async function fetchWithLock(request, options = {}) {
    const urlStr = typeof request === 'string' ? request : request.url;

    if (inFlightRequests.has(urlStr)) {
        const sharedResponse = await inFlightRequests.get(urlStr);
        return sharedResponse.clone();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, FETCH_TIMEOUT_MS);

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


// --- MainDB 连接与日志 ---

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


// --- Service Worker 生命周期事件 ---

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

        const cachedUrls = new Set();
        const fallbackUrls = new Set();
        const pendingLogs = [];

        const fetchWithConcurrency = async (urls, maxConcurrent) => {
            const results = [];
            const executing = new Set();

            for (const url of urls) {
                const task = (async () => {
                    try {
                        const expectedHash = FILE_MANIFEST[url] && FILE_MANIFEST[url].hash ? String(FILE_MANIFEST[url].hash) : '';
                        const response = await fetchVerifiedAsset(url, expectedHash);
                        if (url !== '/') {
                            if (oldManifest[url]) {
                                pendingLogs.push(`🔄 [SW] 更新文件: ${url}`);
                            } else if (isUpdate) {
                                pendingLogs.push(`✅ [SW] 新增文件: ${url}`);
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

                            const db = await openMainDB();
                            await new Promise(resolve => {
                                const tx = db.transaction('html_snapshots', 'readwrite');
                                const store = tx.objectStore('html_snapshots');
                                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();

                                const r = store.get(url);
                                r.onsuccess = () => {
                                    const existing = r.result || null;
                                    let history = [];
                                    if (existing) {
                                        if (Array.isArray(existing.history)) {
                                            history = existing.history.slice();
                                        } else if (typeof existing.text === 'string') {
                                            history = [{ text: existing.text, ts: existing.ts || Date.now() }];
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
                                };
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
                    pendingLogs.push(`✅ [SW] 从大包解压并缓存了 ${putPromises.length} 个文件`);
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
                if (url !== '/') pendingLogs.push(`⛔ [SW] 删除文件: ${url}`);
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
        if (pendingLogs.length > 0) {
            for (const msg of pendingLogs) {
                await writeLog(msg);
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

    // 线上模式由当前活跃 SW 合成 core-list.js，防止新版 waiting 期间旧页面拉回新清单造成版本撕裂
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
        if (event.request.headers.has('range')) {
            event.respondWith(
                fetch(event.request).catch(async () => {
                    const cache = await caches.open(CACHE_NAME_MEDIA);
                    return (await cache.match(event.request)) || new Response('', { status: 503 });
                })
            );
            return;
        }
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
