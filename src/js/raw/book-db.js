/**
 * book-db.js —— 只读电子书专用 IndexedDB 缓存层（BookDB，运行于主线程 / 阅读器 iframe）
 * 持久化电子书提取文本与书内检索结果，按条数/字节双上限 LRU 淘汰，仅在删书时定向清理。
 */

// 库名与 Schema 版本
export const BOOK_DB_NAME = 'BookDB';
export const BOOK_DB_VERSION = 1;
export const BOOK_EXTRACT_STORE = 'book_extracts';
export const BOOK_SEARCH_STORE = 'search_cache';
export const BOOK_SCHEMA_VER = 1;

// 存储上限与压缩阈值
export const BOOK_DB_LIMITS = {
    MAX_EXTRACT_BOOKS: 30,                       // 最多缓存提取书本数
    MAX_EXTRACT_BYTES: 32 * 1024 * 1024,         // 提取总字节上限 (压缩后, B)
    MAX_SINGLE_EXTRACT_BYTES: 12 * 1024 * 1024,  // 单本提取上限 (B)
    MAX_SEARCH_ENTRIES: 600,                     // 书内搜索总条数上限
    MAX_SEARCH_PER_BOOK: 80,                     // 单本搜索条数上限
    MAX_SEARCH_BYTES: 16 * 1024 * 1024,          // 书内搜索总字节上限 (B)
    MAX_SINGLE_SEARCH_BYTES: 512 * 1024,         // 单条搜索结果上限 (B)
    COMPRESS_THRESHOLD: 4096,                    // 启用 deflate-raw 压缩阈值 (B)
    TOUCH_THROTTLE_MS: 60 * 1000                 // 重复命中更新 lastAccess 节流 (ms)
};
const MEM_SEARCH_MAX = 48;                       // 内存热缓存条数上限

// 内存 LRU 运行态
const memSearchLRU = new Map();


// --- 内存热缓存 ---

function memGet(key) {
    if (!memSearchLRU.has(key)) return undefined;
    const val = memSearchLRU.get(key);
    memSearchLRU.delete(key);
    memSearchLRU.set(key, val);
    return val;
}

function memSet(key, val) {
    memSearchLRU.delete(key);
    memSearchLRU.set(key, val);
    if (memSearchLRU.size > MEM_SEARCH_MAX) {
        memSearchLRU.delete(memSearchLRU.keys().next().value);
    }
}

function memDeleteByBook(bookKey) {
    const prefix = bookKey + '\0';
    for (const k of Array.from(memSearchLRU.keys())) {
        if (k.startsWith(prefix)) memSearchLRU.delete(k);
    }
}


// --- 键名规范化与缓存键构造 ---

function toHalfwidthLocal(str) {
    let out = '';
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += c === 12288 ? ' ' : (c >= 65281 && c <= 65374 ? String.fromCharCode(c - 65248) : s[i]);
    }
    return out;
}

export function normalizeBookKey(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return '';
    let s = rawPath.split('#')[0].split('?')[0].trim();
    if (!s || /^(?:blob:|data:|javascript:)/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            if (typeof location !== 'undefined' && u.origin !== location.origin) return '';
            s = u.pathname;
        } catch (_) {
            return '';
        }
    }
    if (/%[0-9A-Fa-f]{2}/.test(s)) {
        try { s = decodeURIComponent(s); } catch (_) {
            try { s = decodeURI(s); } catch (__) { }
        }
    }
    s = s.replace(/\\/g, '/').replace(/^(?:\.\.\/|\.\/|\/)+/, '');
    return s;
}

export function buildBookSearchCacheKey({
    bookSig = '',
    algoVer = 1,
    synVer = '',
    keyword = '',
    noise = 5,
    useSyn = false,
    adsPlan = null
} = {}) {
    const norm = (s) => toHalfwidthLocal(s).trim().toLowerCase().replace(/\s+/g, ' ');
    if (adsPlan && Array.isArray(adsPlan.terms) && adsPlan.terms.length > 0 && adsPlan.expr) {
        const anyLike = adsPlan.terms.some(t => t && t.like);
        const synTag = anyLike ? (synVer || '1') : '0';
        const canonTerms = adsPlan.terms.map(t => [norm(t.text), Number(t.noise ?? 5), t.like ? 1 : 0]);
        return `v${algoVer}|${bookSig}|ads|s:${synTag}|p:${JSON.stringify({ t: canonTerms, e: adsPlan.expr })}`;
    }
    const normKw = norm(keyword);
    const synTag = useSyn ? (synVer || '1') : '0';
    return `v${algoVer}|${bookSig}|n:${Number(noise ?? 5)}|s:${synTag}|q:${normKw}`;
}


// --- 压缩编解码与配额判断 ---

async function encodePayload(obj, forceCompress = false) {
    const json = JSON.stringify(obj);
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const rawBytes = encoder ? encoder.encode(json) : null;
    const rawLen = rawBytes ? rawBytes.byteLength : json.length * 2;

    if (
        typeof CompressionStream === 'function' &&
        (forceCompress || rawLen >= BOOK_DB_LIMITS.COMPRESS_THRESHOLD)
    ) {
        try {
            const stream = new Blob([rawBytes || json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
            const buf = await new Response(stream).arrayBuffer();
            const compressed = new Uint8Array(buf);
            if (compressed.byteLength < rawLen) {
                return { compressed: true, payload: compressed, byteSize: compressed.byteLength };
            }
        } catch (_) { }
    }
    return { compressed: false, payload: obj, byteSize: rawLen };
}

async function decodePayload(record) {
    if (!record) return null;
    if (!record.compressed) return record.payload ?? null;
    if (typeof DecompressionStream !== 'function') return null;
    try {
        const bytes = record.payload instanceof Uint8Array
            ? record.payload
            : new Uint8Array(record.payload);
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const text = await new Response(stream).text();
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function isQuotaError(err) {
    if (!err) return false;
    return err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014;
}


// --- BookDB 主接口 ---

export const BookDB = {
    _db: null,
    _openPromise: null,

    async init() {
        if (typeof indexedDB === 'undefined') return null;
        if (this._db) return this._db;
        if (this._openPromise) return this._openPromise;

        this._openPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(BOOK_DB_NAME, BOOK_DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(BOOK_EXTRACT_STORE)) {
                    const s1 = db.createObjectStore(BOOK_EXTRACT_STORE, { keyPath: 'bookKey' });
                    s1.createIndex('by_lastAccess', 'lastAccess', { unique: false });
                }
                if (!db.objectStoreNames.contains(BOOK_SEARCH_STORE)) {
                    const s2 = db.createObjectStore(BOOK_SEARCH_STORE, { keyPath: 'entryKey' });
                    s2.createIndex('by_book', 'bookKey', { unique: false });
                    s2.createIndex('by_lastAccess', 'lastAccess', { unique: false });
                }
            };
            req.onsuccess = (e) => {
                const db = e.target.result;
                this._db = db;
                this._openPromise = null;
                db.onversionchange = () => {
                    try { db.close(); } catch (_) { }
                    if (this._db === db) this._db = null;
                };
                db.onclose = () => {
                    if (this._db === db) this._db = null;
                };
                resolve(db);
            };
            req.onerror = () => {
                this._openPromise = null;
                reject(req.error);
            };
        });

        try {
            return await this._openPromise;
        } catch (err) {
            console.warn('[BookDB] 打开失败，降级为纯内存模式:', err);
            return null;
        }
    },

    close() {
        if (this._db) {
            try { this._db.close(); } catch (_) { }
            this._db = null;
        }
        this._openPromise = null;
    },

    // --- 书籍提取缓存 ---
    async getExtract(rawBookKey) {
        const bookKey = normalizeBookKey(rawBookKey);
        if (!bookKey) return null;
        try {
            const db = await this.init();
            if (!db) return null;
            const rec = await new Promise((resolve) => {
                const tx = db.transaction(BOOK_EXTRACT_STORE, 'readonly');
                const req = tx.objectStore(BOOK_EXTRACT_STORE).get(bookKey);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (!rec || rec.v !== BOOK_SCHEMA_VER) return null;
            const data = await decodePayload(rec);
            if (!data) return null;

            const now = Date.now();
            if (now - (rec.lastAccess || 0) >= BOOK_DB_LIMITS.TOUCH_THROTTLE_MS) {
                this._touchRecord(BOOK_EXTRACT_STORE, bookKey, now);
            }
            return data;
        } catch (_) {
            return null;
        }
    },

    async putExtract(rawBookKey, kind, dataObj, meta = {}) {
        const bookKey = normalizeBookKey(rawBookKey);
        if (!bookKey || !dataObj) return false;
        try {
            const db = await this.init();
            if (!db) return false;
            const encoded = await encodePayload(dataObj, true);
            if (encoded.byteSize > BOOK_DB_LIMITS.MAX_SINGLE_EXTRACT_BYTES) {
                console.warn(`[BookDB] 跳过超大提取缓存 (${(encoded.byteSize / 1048576).toFixed(1)}MB): ${bookKey}`);
                return false;
            }
            const now = Date.now();
            const record = {
                bookKey,
                kind: kind || 'pdf',
                v: BOOK_SCHEMA_VER,
                meta,
                compressed: encoded.compressed,
                payload: encoded.payload,
                byteSize: encoded.byteSize,
                createdAt: now,
                lastAccess: now
            };

            const writeOnce = () => new Promise((resolve, reject) => {
                const tx = db.transaction(BOOK_EXTRACT_STORE, 'readwrite');
                tx.objectStore(BOOK_EXTRACT_STORE).put(record);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            });

            try {
                await writeOnce();
            } catch (err) {
                if (isQuotaError(err)) {
                    await this._emergencyEvict();
                    await writeOnce();
                } else {
                    throw err;
                }
            }
            await this.evictExtracts(bookKey);
            return true;
        } catch (err) {
            console.warn('[BookDB] 写入提取缓存失败:', err);
            return false;
        }
    },

    async evictExtracts(protectBookKey = '') {
        try {
            const db = await this.init();
            if (!db) return 0;
            const rows = await new Promise((resolve) => {
                const tx = db.transaction(BOOK_EXTRACT_STORE, 'readonly');
                const idx = tx.objectStore(BOOK_EXTRACT_STORE).index('by_lastAccess');
                const list = [];
                const req = idx.openCursor(null, 'next');
                req.onsuccess = () => {
                    const cur = req.result;
                    if (cur) {
                        const v = cur.value;
                        list.push({ bookKey: v.bookKey, byteSize: v.byteSize || 0, lastAccess: v.lastAccess || 0 });
                        cur.continue();
                    } else {
                        resolve(list);
                    }
                };
                req.onerror = () => resolve(list);
            });

            let totalCount = rows.length;
            let totalBytes = rows.reduce((s, r) => s + r.byteSize, 0);
            const victims = [];
            for (const row of rows) {
                if (totalCount <= BOOK_DB_LIMITS.MAX_EXTRACT_BOOKS && totalBytes <= BOOK_DB_LIMITS.MAX_EXTRACT_BYTES) {
                    break;
                }
                if (row.bookKey === protectBookKey) continue;
                victims.push(row.bookKey);
                totalCount--;
                totalBytes -= row.byteSize;
            }
            if (victims.length === 0) return 0;

            await new Promise((resolve) => {
                const tx = db.transaction(BOOK_EXTRACT_STORE, 'readwrite');
                const os = tx.objectStore(BOOK_EXTRACT_STORE);
                for (const k of victims) os.delete(k);
                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            });
            return victims.length;
        } catch (_) {
            return 0;
        }
    },

    // --- 书内搜索缓存 ---
    async getSearch(rawBookKey, queryKey) {
        const bookKey = normalizeBookKey(rawBookKey);
        if (!bookKey || !queryKey) return null;
        const entryKey = `${bookKey}\0${queryKey}`;

        const memHit = memGet(entryKey);
        if (memHit !== undefined) return memHit;

        try {
            const db = await this.init();
            if (!db) return null;
            const rec = await new Promise((resolve) => {
                const tx = db.transaction(BOOK_SEARCH_STORE, 'readonly');
                const req = tx.objectStore(BOOK_SEARCH_STORE).get(entryKey);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (!rec || rec.v !== BOOK_SCHEMA_VER) return null;
            const data = await decodePayload(rec);
            if (!data) return null;

            memSet(entryKey, data);
            const now = Date.now();
            if (now - (rec.lastAccess || 0) >= BOOK_DB_LIMITS.TOUCH_THROTTLE_MS) {
                this._touchRecord(BOOK_SEARCH_STORE, entryKey, now);
            }
            return data;
        } catch (_) {
            return null;
        }
    },

    async putSearch(rawBookKey, queryKey, kind, dataObj) {
        const bookKey = normalizeBookKey(rawBookKey);
        if (!bookKey || !queryKey || !dataObj) return false;
        const entryKey = `${bookKey}\0${queryKey}`;
        memSet(entryKey, dataObj);

        try {
            const db = await this.init();
            if (!db) return false;
            const encoded = await encodePayload(dataObj, false);
            if (encoded.byteSize > BOOK_DB_LIMITS.MAX_SINGLE_SEARCH_BYTES) return false;

            const now = Date.now();
            const record = {
                entryKey,
                bookKey,
                kind: kind || 'txt',
                v: BOOK_SCHEMA_VER,
                compressed: encoded.compressed,
                payload: encoded.payload,
                byteSize: encoded.byteSize,
                createdAt: now,
                lastAccess: now
            };

            const writeOnce = () => new Promise((resolve, reject) => {
                const tx = db.transaction(BOOK_SEARCH_STORE, 'readwrite');
                tx.objectStore(BOOK_SEARCH_STORE).put(record);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            });

            try {
                await writeOnce();
            } catch (err) {
                if (isQuotaError(err)) {
                    await this._emergencyEvict();
                    await writeOnce();
                } else {
                    throw err;
                }
            }
            await this.evictSearchCache(bookKey, entryKey);
            return true;
        } catch (err) {
            console.warn('[BookDB] 写入搜索缓存失败:', err);
            return false;
        }
    },

    async evictSearchCache(bookKey = '', protectEntryKey = '') {
        try {
            const db = await this.init();
            if (!db) return 0;

            const rows = await new Promise((resolve) => {
                const tx = db.transaction(BOOK_SEARCH_STORE, 'readonly');
                const idx = tx.objectStore(BOOK_SEARCH_STORE).index('by_lastAccess');
                const list = [];
                const req = idx.openCursor(null, 'next');
                req.onsuccess = () => {
                    const cur = req.result;
                    if (cur) {
                        const v = cur.value;
                        list.push({
                            entryKey: v.entryKey,
                            bookKey: v.bookKey,
                            byteSize: v.byteSize || 0,
                            lastAccess: v.lastAccess || 0
                        });
                        cur.continue();
                    } else {
                        resolve(list);
                    }
                };
                req.onerror = () => resolve(list);
            });

            const victims = new Set();
            let totalCount = rows.length;
            let totalBytes = rows.reduce((s, r) => s + r.byteSize, 0);

            if (bookKey) {
                const bookRows = rows.filter(r => r.bookKey === bookKey);
                let bookCount = bookRows.length;
                for (const row of bookRows) {
                    if (bookCount <= BOOK_DB_LIMITS.MAX_SEARCH_PER_BOOK) break;
                    if (row.entryKey === protectEntryKey) continue;
                    victims.add(row.entryKey);
                    bookCount--;
                    totalCount--;
                    totalBytes -= row.byteSize;
                }
            }

            for (const row of rows) {
                if (totalCount <= BOOK_DB_LIMITS.MAX_SEARCH_ENTRIES && totalBytes <= BOOK_DB_LIMITS.MAX_SEARCH_BYTES) {
                    break;
                }
                if (victims.has(row.entryKey) || row.entryKey === protectEntryKey) continue;
                victims.add(row.entryKey);
                totalCount--;
                totalBytes -= row.byteSize;
            }

            if (victims.size === 0) return 0;

            await new Promise((resolve) => {
                const tx = db.transaction(BOOK_SEARCH_STORE, 'readwrite');
                const os = tx.objectStore(BOOK_SEARCH_STORE);
                for (const k of victims) {
                    os.delete(k);
                    memSearchLRU.delete(k);
                }
                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            });
            return victims.size;
        } catch (_) {
            return 0;
        }
    },

    // --- 删除书籍清理与内部维护 ---
    async deleteBook(rawBookKey) {
        const bookKey = normalizeBookKey(rawBookKey);
        if (!bookKey) return { deletedExtract: false, deletedSearches: 0 };
        memDeleteByBook(bookKey);

        try {
            const db = await this.init();
            if (!db) return { deletedExtract: false, deletedSearches: 0 };

            let deletedExtract = false;
            let deletedSearches = 0;

            await new Promise((resolve) => {
                const tx = db.transaction([BOOK_EXTRACT_STORE, BOOK_SEARCH_STORE], 'readwrite');
                const extStore = tx.objectStore(BOOK_EXTRACT_STORE);
                const schStore = tx.objectStore(BOOK_SEARCH_STORE);

                const checkExt = extStore.getKey(bookKey);
                checkExt.onsuccess = () => {
                    if (checkExt.result !== undefined) {
                        deletedExtract = true;
                        extStore.delete(bookKey);
                    }
                };

                const idx = schStore.index('by_book');
                const range = IDBKeyRange.only(bookKey);
                const curReq = idx.openKeyCursor(range);
                curReq.onsuccess = () => {
                    const cur = curReq.result;
                    if (cur) {
                        schStore.delete(cur.primaryKey);
                        deletedSearches++;
                        cur.continue();
                    }
                };

                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            });

            return { deletedExtract, deletedSearches };
        } catch (_) {
            return { deletedExtract: false, deletedSearches: 0 };
        }
    },

    async getAllBookKeys() {
        try {
            const db = await this.init();
            if (!db) return [];
            const keys = new Set();
            await new Promise((resolve) => {
                const tx = db.transaction([BOOK_EXTRACT_STORE, BOOK_SEARCH_STORE], 'readonly');
                const r1 = tx.objectStore(BOOK_EXTRACT_STORE).getAllKeys();
                r1.onsuccess = () => {
                    for (const k of (r1.result || [])) if (typeof k === 'string') keys.add(k);
                };
                const idx = tx.objectStore(BOOK_SEARCH_STORE).index('by_book');
                const r2 = idx.openKeyCursor(null, 'nextunique');
                r2.onsuccess = () => {
                    const cur = r2.result;
                    if (cur) {
                        if (typeof cur.key === 'string') keys.add(cur.key);
                        cur.continue();
                    }
                };
                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            });
            return Array.from(keys);
        } catch (_) {
            return [];
        }
    },

    async pruneDeletedBooks(validBookKeysSet) {
        if (!(validBookKeysSet instanceof Set)) return [];
        const storedKeys = await this.getAllBookKeys();
        if (storedKeys.length === 0) return [];
        const removed = [];
        for (const key of storedKeys) {
            if (!validBookKeysSet.has(key)) {
                const res = await this.deleteBook(key);
                if (res.deletedExtract || res.deletedSearches > 0) {
                    removed.push({ bookKey: key, ...res });
                }
            }
        }
        return removed;
    },

    _touchRecord(storeName, key, now) {
        this.init().then((db) => {
            if (!db) return;
            const tx = db.transaction(storeName, 'readwrite');
            const os = tx.objectStore(storeName);
            const req = os.get(key);
            req.onsuccess = () => {
                const rec = req.result;
                if (rec) {
                    rec.lastAccess = now;
                    os.put(rec);
                }
            };
        }).catch(() => { });
    },

    async _emergencyEvict() {
        try {
            const db = await this.init();
            if (!db) return;
            const trimHalf = (storeName, keyField) => new Promise((resolve) => {
                const tx = db.transaction(storeName, 'readwrite');
                const os = tx.objectStore(storeName);
                const idx = os.index('by_lastAccess');
                const keys = [];
                const req = idx.openKeyCursor(null, 'next');
                req.onsuccess = () => {
                    const cur = req.result;
                    if (cur) {
                        keys.push(cur.primaryKey);
                        cur.continue();
                    } else {
                        const cut = Math.ceil(keys.length / 2);
                        for (let i = 0; i < cut; i++) os.delete(keys[i]);
                    }
                };
                tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            });
            await trimHalf(BOOK_SEARCH_STORE, 'entryKey');
            await trimHalf(BOOK_EXTRACT_STORE, 'bookKey');
            memSearchLRU.clear();
        } catch (_) { }
    }
};
