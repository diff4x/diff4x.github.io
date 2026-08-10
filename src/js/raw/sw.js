importScripts('/src/js/core-list.js?v=1786340653076');

self.SW_VERSION = '1786340653076';
self.EMERGENCY = 'repair_command_id=2';

const CACHE_NAME_CORE = 'core-cache-' + BUILD_VERSION;
const CACHE_NAME_MEDIA = 'media-cache';
const MAX_HTML_SNAPSHOT_HISTORY = 10;
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

// 统一的 MainDB 打开入口 —— schema 只在这一处定义，
// 避免出现某个调用点漏写 onupgradeneeded 导致 store 缺失/库被锁死的问题。
const MAINDB_NAME = 'MainDB';
const MAINDB_VERSION = 3;
let mainDbOpenPromise = null;

function openMainDB() {
    if (mainDbOpenPromise) return mainDbOpenPromise;

    mainDbOpenPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(MAINDB_NAME, MAINDB_VERSION);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
            if (!db.objectStoreNames.contains('update_logs')) db.createObjectStore('update_logs', { autoIncrement: true });
            if (!db.objectStoreNames.contains('search_cache')) db.createObjectStore('search_cache');
            if (!db.objectStoreNames.contains('sys_state')) db.createObjectStore('sys_state');
            if (!db.objectStoreNames.contains('html_snapshots')) db.createObjectStore('html_snapshots');
        };

        req.onsuccess = (e) => {
            const db = e.target.result;
            // 连接被其他 tab 的版本升级顶掉时，及时释放，避免占用僵死连接
            db.onversionchange = () => {
                db.close();
                mainDbOpenPromise = null;
            };
            resolve(db);
        };

        req.onerror = (e) => {
            mainDbOpenPromise = null;
            reject(e.target.error);
        };

        req.onblocked = () => {
            console.warn('⚠️ [SW] MainDB 升级被其他连接阻塞');
        };
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
        const lastCacheName = cacheNames
            .filter(n => n.startsWith('core-cache-') && n !== CACHE_NAME_CORE)
            .sort()
            .pop();

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

        const fetchWithConcurrency = async (urls, maxConcurrent) => {
            const results = [];
            const executing = new Set();

            for (const url of urls) {
                const task = (async () => {
                    try {
                        const response = await fetchWithLock(new Request(url, { cache: 'no-cache' }));
                        if (response.ok) {
                            if (url !== '/') {
                                if (oldManifest[url]) {
                                    await writeLog(`🔄 [SW] 更新文件: ${url}`);
                                } else if (isUpdate) {
                                    await writeLog(`✅ [SW] 新增文件: ${url}`);
                                }
                            }
                            await newCache.put(url, response);
                        }
                    } catch (err) {
                        console.warn(`[SW] Fetch failed: ${url}`);
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

        for (const url of allFilesToCache) {
            const meta = FILE_MANIFEST[url];
            const oldMeta = oldManifest[url];

            if (url.endsWith('synonyms.js')) {
                if (!oldMeta || oldMeta.hash !== meta.hash) {
                    (async () => {
                        try {
                            const db = await openMainDB();
                            if (db.objectStoreNames.contains('search_cache')) {
                                const tx = db.transaction('search_cache', 'readwrite');
                                tx.objectStore('search_cache').clear();
                                console.warn(`🧹 [SW] 检测到 ${url} 变更，已清空旧的 search_cache`);
                            }
                            // 注意：db 是共享单例连接，这里不再手动 close()，
                            // 否则会影响其他正在使用同一连接的调用方。
                        } catch (err) {
                            console.warn("⚠️ [SW] 清理 search_cache 失败:", err);
                        }
                    })();
                }
            }

            if (oldMeta && oldMeta.hash !== meta.hash && url.startsWith('/html/')) {
                (async () => {
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

                            history.push({ text: compressedData, ts: Date.now(), compressed: true });
                            if (history.length > MAX_HTML_SNAPSHOT_HISTORY) {
                                history = history.slice(history.length - MAX_HTML_SNAPSHOT_HISTORY);
                            }

                            store.put({ history }, url);
                        }
                    } catch (e) {
                        console.warn(`[SW] 快照生成失败: ${url}`);
                    }
                })();
            }

            if (oldMeta && oldMeta.hash === meta.hash) {
                if (lastCacheName === CACHE_NAME_CORE) continue;
                const lastCache = await caches.open(lastCacheName);
                const cachedRes = await lastCache.match(url);
                if (cachedRes) {
                    await newCache.put(url, cachedRes);
                    continue;
                }
            }

            if (meta.source === 'core-bundle.json') {
                bundleUpdates.push(url);
            } else {
                if (
                    !url.endsWith('/src/js/worker.js') &&
                    !url.endsWith('compute_intensive_task_processor.min.js') &&
                    !url.endsWith('compute_intensive_task_processor.wasm')
                ) {
                    standaloneUpdates.push(url);
                }
            }
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
                    if (bundleData[url]) {
                        let contentType = 'text/plain; charset=utf-8';
                        if (url.endsWith('.html') || url === '/') contentType = 'text/html; charset=utf-8';
                        else if (url.endsWith('.css')) contentType = 'text/css; charset=utf-8';
                        else if (url.endsWith('.json')) contentType = 'application/json; charset=utf-8';
                        else if (url.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';

                        const fakeRes = new Response(bundleData[url], {
                            headers: { 'Content-Type': contentType }
                        });
                        putPromises.push(newCache.put(url, fakeRes));
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
            }
        }

        const manifestSaveUrl = new URL('/sw-manifest.json', self.location.origin).href;
        await newCache.put(manifestSaveUrl, new Response(JSON.stringify(FILE_MANIFEST), {
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

    if (url.pathname.endsWith('core-list.js')) {
        event.respondWith(
            fetch(event.request).catch(async () => {
                try {
                    const cache = await caches.open(CACHE_NAME_CORE);
                    const manifestRes = await cache.match(new URL('/sw-manifest.json', self.location.origin).href);

                    if (manifestRes) {
                        const manifestData = await manifestRes.text();
                        const fallbackJS = `window.BUILD_VERSION = 'offline'; window.FILE_MANIFEST = ${manifestData};`;
                        return new Response(fallbackJS, {
                            status: 200,
                            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
                        });
                    }
                } catch (err) {
                    console.error("❌ [SW] Offline mock failed", err);
                }

                return new Response('window.FILE_MANIFEST = {};', {
                    status: 200,
                    headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
                });
            })
        );
        return;
    }

    if (IS_LOCAL_MODE) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    if (
        url.pathname.endsWith('/src/js/worker.js') ||
        url.pathname.endsWith('compute_intensive_task_processor.min.js') ||
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
        url.pathname.match(/\.(woff|woff2|eot|ttf|svg)$/)
    ) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                return cached || fetch(event.request).then(response => {
                    if (response && response.status === 200) {
                        const resClone = response.clone();
                        caches.open(CACHE_NAME_MEDIA).then(cache => cache.put(event.request, resClone));
                    }
                    return response;
                });
            })
        );
    } else {
        event.respondWith(
            caches.match(event.request, { ignoreSearch: true }).then(cached => {
                return cached || fetchWithLock(event.request);
            })
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