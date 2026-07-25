// 触发 SW 更新检查
self.SW_VERSION = '1785010167103';
importScripts('/src/js/core-list.js?v=1785010167103');

// 缓存池隔离命名
const CACHE_NAME_CORE = 'core-cache-' + BUILD_VERSION;
const CACHE_NAME_MEDIA = 'media-cache';

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

// ===================================================================
// 全局网络调度器 (防止多线程踩踏与缓存击穿)
// ===================================================================
const inFlightRequests = new Map();

async function fetchWithLock(request, options = {}) {
    const urlStr = typeof request === 'string' ? request : request.url;
    
    // 如果这个 URL 正在被下载（无论是主线程还是 SW 安装线程发起的），直接白嫖它的 Promise
    if (inFlightRequests.has(urlStr)) {
        const sharedResponse = await inFlightRequests.get(urlStr);
        return sharedResponse.clone(); // 必须 clone，满足多路并发的分发
    }

    const fetchPromise = fetch(request, options).then(res => {
        inFlightRequests.delete(urlStr);
        return res;
    }).catch(err => {
        inFlightRequests.delete(urlStr);
        throw err;
    });

    inFlightRequests.set(urlStr, fetchPromise);
    const finalResponse = await fetchPromise;
    return finalResponse.clone();
}

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
                    // 💥 接入全局锁：如果此时主线程也在请求这个文件，它们会自动合并为 1 个真实网络请求
                    const response = await fetchWithLock(new Request(url, { cache: 'no-cache' }));
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
                // 🚨 核心计算引擎(胶水/Wasm)，走规则 3.5 按需穿透缓存，不阻塞 SW 安装
                if (
                    !url.endsWith('/src/js/worker.js') && 
                    !url.endsWith('compute_intensive_task_processor.min.js') && 
                    !url.endsWith('compute_intensive_task_processor.wasm')) {
                    standaloneUpdates.push(url);
                }
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

    // [规则 3] 本地虚拟服务器：强制网络优先
    if (IS_LOCAL_MODE) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(() => caches.match(event.request))
        );
        return; 
    }

    // [规则 3.5] 核心引擎按需穿透 + 全局锁 + SW 安装豁免
    // 胶水/Wasm 属于动态异步引入：它们是在 JS 运行到 import(...) 时才由浏览器临时动态发起的，时机具有不确定性, Wasm体积大、首屏非绝对同步强依赖, 所以不能让它首屏无脑抢带宽

    // index.js 这些常规首屏声明必须走 SW, 不能走 3.5 的由主线程按需加载 
    // SW 在后台下载和主线程直接发起下载，它们走的是同一条物理网络通道，吞吐量一样。区别在于一个是立即并发, 一个是串行阻塞
    // 主线程实时下载：浏览器必须先下载解析 HTML, 遇到 <script src="index.js"> 发现需要这个文件, 这时才开始发起网络请求, 由此耽误了宝贵的时间
    // SW 后台预加载：当 SW 注册成功后，它在后台是独立于主线程运行的。不需要等 HTML 解析到哪一步，只要 SW 激活，后台就已经在全速并发抓取了。当主线程渲染到需要它的时候，可能文件在后台已经错峰下载大半甚至完成了

    // 列入核心清单 => 参与文件 hash 计算进行自更新
    // sw 安装时跳过 => 极速完成 SW 激活
    // fetchWithLock => 防止主线程与 iframe 的高并发踩踏击穿
    if (url.pathname.endsWith('/src/js/worker.js') || 
        url.pathname.endsWith('compute_intensive_task_processor.min.js') ||
        url.pathname.endsWith('compute_intensive_task_processor.wasm')) { 
        
        event.respondWith(
            caches.open(CACHE_NAME_CORE).then(async (cache) => {
                const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
                if (cachedResponse) return cachedResponse;
                
                // 直接使用全局锁发起网络请求
                const networkResponse = await fetchWithLock(event.request, { cache: 'no-cache' });
                
                if (networkResponse && networkResponse.status === 200) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            })
        );
        return;
    }

    // [规则 4] Lazy Caching：请求命中后永久化为离线资产
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
    } 
    // [规则 5] Cache-First：核心强缓存静默策略
    // 对于常规文件 (index.js, index.css 等)：虽然它们还在 install 队列中，但由于接入了 fetchWithLock，如果主线程和 SW 安装线程在第 1 毫秒同时索要这些文件，浏览器底层只会被发出 1个 HTTP 请求
    else {
        event.respondWith(
            // ignoreSearch: 忽略URL的时间戳或哈希参数，保证离线状态下能够稳定命中
            caches.match(event.request, { ignoreSearch: true }).then(cached => {
                return cached || fetchWithLock(event.request);
            })
        );
    }
});
