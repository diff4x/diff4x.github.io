// 触发 SW 更新检查
self.SW_VERSION = '1784650687062';
importScripts('/src/js/core-list.js?v=1784650687062');

// 缓存池隔离命名
const CACHE_NAME_CORE = 'core-cache-' + BUILD_VERSION;
const CACHE_NAME_MEDIA = 'media-cache';
const CACHE_NAME_MODEL = 'model-cache';

const IS_LOCAL_MODE = (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1' || self.location.protocol === 'file:') && self.location.port !== '9000';

// 日志工具
const writeLog = async (msg) => {
    const dbName = 'MainDB';
    try {
        // 冗余建表, 防止sw线程与主线程陷入初始化竞争
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, 1); 
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
                if (!db.objectStoreNames.contains('update_logs')) db.createObjectStore('update_logs', { autoIncrement: true });
                if (!db.objectStoreNames.contains('search_cache')) db.createObjectStore('search_cache');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject();
        });
        
        if (!db.objectStoreNames.contains('update_logs')) return;
        const tx = db.transaction('update_logs', 'readwrite');
        tx.objectStore('update_logs').add({ msg, ts: Date.now() });
    } catch(e) {}
};

// 链路探测
const getConnectionType = () => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn || !conn.effectiveType) return '4g'; 
    return conn.effectiveType; 
};

// ===================================================================
// SW 安装 (资源下载与增量更新)
// ===================================================================
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const newCache = await caches.open(CACHE_NAME_CORE);
        
        // --- 阶段 A: 环境与依赖准备 ---
        
        // 1. 尝试反序列化上一版 manifest
        const cacheNames = await caches.keys();
        const lastCacheName = cacheNames
            .filter(n => n.startsWith('core-cache-') && n !== CACHE_NAME_CORE)
            .sort().pop();
        
        let oldManifest = {};
        if (lastCacheName) {
            try {
                const lastCache = await caches.open(lastCacheName);
                const manifestUrl = new URL('/sw-manifest.json', self.location.origin).href;
                const manifestRes = await lastCache.match(manifestUrl);
                if (manifestRes) oldManifest = await manifestRes.json();
            } catch (err) {
                console.warn("⚠️ [SW] Manifest read failed, fallback to full-sync.", err);
                oldManifest = {}; // 解析异常降级为空对象，触发全量更新以防更新死锁
            }
        }

        // 2. 封装内部使用的并发请求器
        const fetchWithConcurrency = async (urls, maxConcurrent) => {
            const results = [];
            const executing = new Set();

            for (const url of urls) {
                const task = (async () => {
                    try {
                        const response = await fetch(new Request(url, { cache: 'no-cache' }));
                        if (response.ok) {
                            if (url !== '/') {
                                const logMsg = oldManifest[url] ? `🔄 [SW] 更新文件: ${url}` : `✅ [SW] 新增文件: ${url}`;
                                await writeLog(logMsg);
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

        // --- 阶段 B: 任务分拣与调度 ---
        
        const CORE_BUNDLE_THRESHOLD = 15; // 大包请求触发阈值
        let bundleUpdates = [];    
        let standaloneUpdates = []; 

        for (const url of allFilesToCache) {
            const meta = FILE_MANIFEST[url]; 
            const oldMeta = oldManifest[url];

            // 1. 缓存继承：Hash 无变化直接从旧缓存池硬链接复制
            if (oldMeta && oldMeta.hash === meta.hash) {
                if (lastCacheName === CACHE_NAME_CORE) continue; 
                const lastCache = await caches.open(lastCacheName);
                const cachedRes = await lastCache.match(url);
                if (cachedRes) {
                    await newCache.put(url, cachedRes);
                    continue; 
                }
            }

            // 2. 请求分类
            if (meta.source === 'core-bundle.json') {
                bundleUpdates.push(url);
            } else {
                standaloneUpdates.push(url);
            }
        }

        // 3. 启发式判断：更新量极小则将 bundle 退级散件拉取
        let needBundle = false;
        if (!lastCacheName || bundleUpdates.length > CORE_BUNDLE_THRESHOLD) {
            needBundle = true;
        } else {
            standaloneUpdates.push(...bundleUpdates);
        }

        // --- 阶段 C: 核心执行 ---

        // 任务 1：内存解压大包并映射缓存
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
                        
                        const fakeRes = new Response(bundleData[url], { headers: { 'Content-Type': contentType } });
                        putPromises.push(newCache.put(url, fakeRes));
                    }
                }
                await Promise.all(putPromises);
                await writeLog(`✅ [SW] 从大包解压并缓存了 ${putPromises.length} 个文件`);
            } catch (err) {
                console.error("❌ [SW] Core bundle parsing failed", err);
                throw new Error("Core bundle installation failed."); // 异常时中断 Install，强制保留旧版 SW 兜底
            }
        }

        // 任务 2：动态并发拉取散件
        if (standaloneUpdates.length > 0) {
            const networkType = getConnectionType();
            let dynamicConcurrency = 4;
            
            if (networkType === 'slow-2g' || networkType === '2g') {
                dynamicConcurrency = 1; // 弱网强制串行防堵塞
            } else if (networkType === '3g' || standaloneUpdates.length > 20) {
                dynamicConcurrency = 2; // 批量大吞吐时降频，防设备 I/O 拥塞
            }
            
            await fetchWithConcurrency(standaloneUpdates, dynamicConcurrency);
        }

        // --- 阶段 D: 扫尾工作 ---

        // 1. 记录已废弃被删除的文件
        if (oldManifest) {
            const newManifestKeys = Object.keys(FILE_MANIFEST);
            const deletedFiles = Object.keys(oldManifest).filter(url => !newManifestKeys.includes(url));
            for (const url of deletedFiles) {
                if (url !== '/') await writeLog(`⛔ [SW] 删除文件: ${url}`);
            }
        }

        // 2. 序列化当前的 sw-manifest 并持久化至 Cache Storage
        const manifestSaveUrl = new URL('/sw-manifest.json', self.location.origin).href;
        await newCache.put(manifestSaveUrl, new Response(JSON.stringify(FILE_MANIFEST), {
            headers: { 'Content-Type': 'application/json' }
        }));
        
    })());
});

// ===================================================================
// SW 激活 (旧缓存清理与正式接管)
// ===================================================================
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

// ===================================================================
// 客户端监听
// ===================================================================
self.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ===================================================================
// 请求拦截与缓存分发
// ===================================================================
self.addEventListener('fetch', event => {
    // 放行所有跨域请求，让浏览器原生处理外部 API 和 CDN
    if (!event.request.url.startsWith('http')) return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    // [规则 1] 豁免自身请求，交由浏览器底层协商
    if (url.pathname.endsWith('sw.js')) return; 

    // [规则 2] 断网环境核心文件兜底：反序列化旧缓存包装后返回
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

    // [规则 3] Lazy Caching：模型权重文件请求命中后永久化为离线资产
    if (
        url.pathname.includes('/last-page/') || 
        url.pathname.endsWith('llm-worker.js')
    ) {
        event.respondWith(
            caches.open(CACHE_NAME_MODEL).then(async (cache) => {
                const cachedResponse = await cache.match(event.request);
                if (cachedResponse) return cachedResponse;
                
                const response = await fetch(event.request, { cache: 'no-cache' });
                if (response.status === 200) {
                    cache.put(event.request, response.clone());
                }
                return response;
            })
        );
        return;
    }

    // [规则 4] 本地虚拟服务器：强制网络优先
    if (IS_LOCAL_MODE) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return; 
    }

    // [规则 5] Lazy Caching：媒体文件请求命中后永久化为离线资产
    if (
        url.pathname.startsWith('/audio/') || 
        url.pathname.startsWith('/video/') || // ⚠️ 长视频受 HTTP 206 限制无法按范围进行缓存
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
        return;
    } 

    // [规则 6] Cache-First：核心强缓存静默策略
    else {
        event.respondWith(
            // ignoreSearch: 忽略URL的时间戳或哈希参数，保证离线状态下能够稳定命中
            caches.match(event.request, { ignoreSearch: true }).then(cached => {
                return cached || fetch(event.request);
            })
        );
    }
});
