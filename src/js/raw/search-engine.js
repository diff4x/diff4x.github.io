/**
 * search-engine.js —— 搜索核心状态、IDB LRU 缓存、命名空间失效、ADS 语法解析、
 * 同义词展开缓存、页内/评论叠加层、摘要 RPC 与标题高亮区间匹配。
 */
import { $, toHalfwidth, hashText } from './shared-utils.js';

export const SEARCH_ALGO_VER = 11;

const ADS_PREFIX_RE = /^[@＠][\[［【]/;
const ADS_MAX_DEPTH = 8;
const ADS_USAGE = '@[a&!(b|c)]飞机[31]大炮[]机枪[0]';
const SR_HARD_BREAK_RE = /[\n\r。！？；!?;]/;

class AdsSyntaxError extends Error { }

export function normalizeKeyword(kw) {
    if (!kw || typeof kw !== 'string') return '';
    return toHalfwidth(kw).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isActionCommand(kw) {
    return typeof kw === 'string' && /^@(bomb|rebirth)$/.test(kw.trim());
}

export function isAdsQuery(kw) {
    return typeof kw === 'string' && ADS_PREFIX_RE.test(kw.trimStart());
}

export function isReservedSearchCommand(kw) {
    return isActionCommand(kw) || isAdsQuery(kw);
}

export function pageOverlayKey(kw) {
    return isAdsQuery(kw) ? String(kw).trim() : normalizeKeyword(kw);
}

function adsHoldsOnEmpty(n) {
    if (n.op === 'term') return n.neg;
    return n.op === 'and' ? n.args.every(adsHoldsOnEmpty) : n.args.some(adsHoldsOnEmpty);
}

function srAsciiLower(ch) {
    return toHalfwidth(ch).toLowerCase();
}

function srEffectiveNoise(kwLen, noiseLevel) {
    return kwLen > 25 ? 0 : Math.min(noiseLevel, Math.floor(kwLen / 2));
}

function srNormalizeKeywords(keywords) {
    const out = [];
    for (let idx = 0; idx < keywords.length; idx++) {
        const item = keywords[idx];
        if (!item) continue;
        const text = typeof item === 'string' ? item : item.text;
        if (!text) continue;
        const chars = [];
        for (const ch of text) {
            if (!/\s/.test(ch)) chars.push(srAsciiLower(ch));
        }
        if (chars.length === 0) continue;
        const tier = typeof item === 'string' ? (idx === 0 ? 0 : 1) : Number(item.tier ?? (idx === 0 ? 0 : 1));
        const maxNoise = typeof item === 'string' ? Infinity : Number(item.maxNoise ?? Infinity);
        const weight = typeof item === 'string' ? (tier === 0 ? 100 : 70) : Number(item.weight ?? (tier === 0 ? 100 : 70));
        out.push({ chars, tier, maxNoise, weight });
    }
    return out;
}

function srTryMatchAt(chars, i, kwChars, effNoise) {
    const len = chars.length;
    const kwLen = kwChars.length;
    let kIdx = 0;
    let j = i;
    let currentGap = 0;
    let totalNoise = 0;
    let spaceRun = 0;
    let last = i;

    while (j < len && kIdx < kwLen) {
        const ch = chars[j];
        if (srAsciiLower(ch) === kwChars[kIdx]) {
            kIdx++;
            currentGap = 0;
            spaceRun = 0;
            last = j;
        } else {
            if (kIdx > 0 && SR_HARD_BREAK_RE.test(ch)) break;
            if (/\s/.test(ch)) {
                spaceRun++;
                if (spaceRun > 1) {
                    currentGap++;
                    totalNoise++;
                    if (currentGap > effNoise) break;
                }
            } else {
                currentGap++;
                totalNoise++;
                if (currentGap > effNoise) break;
            }
        }
        j++;
        if (kIdx === kwLen) break;
    }

    return kIdx === kwLen ? [i, last + 1, totalNoise] : null;
}

export function srCollectMatches(chars, keywords, noiseLevel, out) {
    const normKws = srNormalizeKeywords(keywords);
    const textLen = chars.length;
    for (const kw of normKws) {
        const kwChars = kw.chars;
        const kwLen = kwChars.length;
        if (kwLen === 0) continue;
        const effNoise = srEffectiveNoise(kwLen, Math.min(noiseLevel, kw.maxNoise));
        const first = kwChars[0];
        for (let i = 0; i < textLen; i++) {
            if (srAsciiLower(chars[i]) !== first) continue;
            const hit = srTryMatchAt(chars, i, kwChars, effNoise);
            if (hit) out.push([hit[0], hit[1], hit[2], kw.tier, kw.weight]);
        }
    }
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

    return { keys: () => load(), touch, touchAndEvict, forget, reset };
}

function createSearchResultCache(db, lru, store, emitEvent, { memMax = 48, flushDelay = 400, onClear = () => { } } = {}) {
    const mem = new Map();
    const dirty = new Map();
    let flushTimer = null;
    let flushing = false;
    let epoch = 0;

    const keyPrefix = () => `n${Number(store.noise_level ?? 5)}|l${Number(store.synonyms_enabled ?? 1)}|`;
    const makeKey = (kw) => {
        const norm = normalizeKeyword(kw);
        return norm ? keyPrefix() + norm : '';
    };
    const stripKeyPrefix = (k) => (typeof k === 'string' ? k.replace(/^n\d+\|l[01]\|/, '') : '');
    const unpackEntry = (raw) => {
        if (Array.isArray(raw)) return { results: raw, termSpecs: null };
        if (raw && Array.isArray(raw.results)) {
            return { results: raw.results, termSpecs: Array.isArray(raw.termSpecs) ? raw.termSpecs : null };
        }
        return null;
    };

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
                const startEpoch = epoch;
                const [k, v] = dirty.entries().next().value;
                dirty.delete(k);
                if (!mem.has(k)) continue;
                try {
                    await db.put('search_cache', k, v);
                    if (epoch !== startEpoch || !mem.has(k)) {
                        await db.delete('search_cache', k).catch(() => { });
                        lru.forget(k);
                        continue;
                    }
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
            const pfx = keyPrefix();
            const fullKey = pfx + normKw;

            let exact = memGet(fullKey);
            if (exact === undefined && (await lru.keys()).includes(fullKey)) {
                exact = await db.get('search_cache', fullKey);
                if (exact) memSet(fullKey, exact);
                else lru.forget(fullKey);
            }
            if (exact) {
                const unpacked = unpackEntry(exact);
                if (unpacked) {
                    lru.touch(fullKey);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: true, fromCache: true };
                }
            }
            if ((store.synonyms_enabled ?? 1) === 1) return null;

            const isPrefix = (k) => {
                if (typeof k !== 'string' || !k.startsWith(pfx)) return false;
                const sub = k.slice(pfx.length);
                return sub.length > 2 && sub !== normKw && normKw.startsWith(sub);
            };
            const byLenDesc = (a, b) => b.length - a.length;

            for (const key of Array.from(mem.keys()).filter(isPrefix).sort(byLenDesc)) {
                const unpacked = unpackEntry(memGet(key));
                if (unpacked && unpacked.results.length > 0) {
                    lru.touch(key);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: false, fromCache: true };
                }
            }
            const candidates = (await lru.keys())
                .filter(k => isPrefix(k) && !mem.has(k))
                .sort(byLenDesc)
                .slice(0, 3);
            for (const key of candidates) {
                const raw = await db.get('search_cache', key);
                const unpacked = unpackEntry(raw);
                if (unpacked && unpacked.results.length > 0) {
                    memSet(key, raw);
                    lru.touch(key);
                    return { results: unpacked.results, termSpecs: unpacked.termSpecs, exact: false, fromCache: true };
                }
                if (raw === undefined) lru.forget(key);
            }
            return null;
        } catch (e) { return null; }
    };

    const SEARCH_CACHE_MAX_HITS = 300;
    const set = async (kw, results, termSpecs = null) => {
        const fullKey = makeKey(kw);
        if (!fullKey || !Array.isArray(results) || results.length > SEARCH_CACHE_MAX_HITS) return;
        const val = Array.isArray(termSpecs) && termSpecs.length > 0 ? { results, termSpecs } : results;
        memSet(fullKey, val);
        dirty.set(fullKey, val);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, flushDelay);
    };

    const remove = async (kw, opts = {}) => {
        try {
            const normKw = normalizeKeyword(kw);
            if (!normKw) return;
            const delKeys = new Set([keyPrefix() + normKw]);
            if (opts && opts.allVariants) {
                for (const k of mem.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
                for (const k of dirty.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
                for (const k of await lru.keys()) if (stripKeyPrefix(k) === normKw) delKeys.add(k);
            }
            for (const k of delKeys) {
                mem.delete(k);
                dirty.delete(k);
                lru.forget(k);
                await db.delete('search_cache', k);
            }
        } catch (e) { }
    };

    const clearMemory = () => {
        epoch++;
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

    const boundNs = new Map();
    const bindNamespace = async (slot, next) => {
        if (typeof slot !== 'string' || typeof next !== 'string') return false;
        if (boundNs.get(slot) === next) return false;
        boundNs.set(slot, next);
        const key = 'search_cache_ns:' + slot;
        let saved;
        try { saved = await db.get('sys_state', key); } catch (e) { saved = undefined; }
        if (boundNs.get(slot) !== next) return false;
        if (saved === next) return false;
        await clear();
        try { await db.put('sys_state', key, next); } catch (e) { }
        return true;
    };

    window.addEventListener('pagehide', () => { if (dirty.size > 0) flush(); });

    return { getMeta, set, remove, clear, clearMemory, bindNamespace, stripKeyPrefix };
}

export function createSearchEngine(ctx) {
    const { store, dbProxy, emitEvent, getWorker, getActiveWorker, getCommentModel } = ctx;

    const commentHitCache = new Map();
    const pageHitCache = new Map();
    const snippetCache = new Map();
    const pendingSnippets = new Map();
    const pendingExpands = new Map();
    const termSpecsCache = new Map();
    let _snipReqId = 0;
    let _expandReqId = 0;

    let _privateSrc = null;
    let _privateSet = null;

    let txtProvider = null;
    let searchScope = 'global';

    let uiHandlers = {
        showResults: () => { },
        showTxtResults: () => { },
        updateResults: () => { },
        rerenderOverlay: () => { },
        paintStatus: () => { },
        onScopeChange: () => { }
    };

    function hasTxtProvider() {
        return !!txtProvider;
    }

    function getSearchScope() {
        return (searchScope === 'txt' && txtProvider) ? 'txt' : 'global';
    }

    function isTxtScope() {
        return getSearchScope() === 'txt';
    }

    function notifyTxtScope(target) {
        if (txtProvider && typeof txtProvider.onScopeChange === 'function') {
            try { txtProvider.onScopeChange(target); } catch (_) { }
        }
    }

    function setSearchScope(nextScope, { rerun = false } = {}) {
        const target = (nextScope === 'txt' && txtProvider) ? 'txt' : 'global';
        if (searchScope === target) {
            uiHandlers.onScopeChange(target, txtProvider);
            notifyTxtScope(target);
            return;
        }
        invalidateSearch();
        if (searchScope === 'txt' && txtProvider && typeof txtProvider.clearHighlights === 'function') {
            txtProvider.clearHighlights();
        }
        window._txtStatus = '';
        searchScope = target;
        uiHandlers.onScopeChange(target, txtProvider);
        notifyTxtScope(target);
        if (rerun) {
            const el = document.getElementById("searchInput");
            const kw = el ? el.value.trim() : "";
            if (kw) search(kw);
            else uiHandlers.updateResults([]);
        }
    }

    function registerTxtProvider(provider) {
        txtProvider = provider || null;
        window._txtStatus = '';
        if (txtProvider) {
            invalidateSearch();
            searchScope = 'txt';
            uiHandlers.onScopeChange('txt', txtProvider);
            notifyTxtScope('txt');
            uiHandlers.updateResults([], '');
        } else {
            const wasTxt = searchScope === 'txt';
            searchScope = 'global';
            uiHandlers.onScopeChange('global', null);
            if (wasTxt) {
                invalidateSearch();
                uiHandlers.updateResults([], '');
            }
        }
    }

    function unregisterTxtProvider(provider) {
        if (provider && txtProvider && txtProvider !== provider) return;
        registerTxtProvider(null);
    }

    function getTxtProvider() {
        return txtProvider;
    }

    function setUIHandlers(h) {
        uiHandlers = Object.assign(uiHandlers, h || {});
    }

    function clearSearchOverlays() {
        commentHitCache.clear();
        pageHitCache.clear();
        snippetCache.clear();
    }

    function clearTransientCaches() {
        snippetCache.clear();
        termSpecsCache.clear();
    }

    const searchCacheLRU = createSearchCacheLRU(dbProxy);
    const searchResultCache = createSearchResultCache(dbProxy, searchCacheLRU, store, emitEvent, {
        onClear: () => clearSearchOverlays()
    });

    function computeCoreNamespace() {
        return [
            'v' + SEARCH_ALGO_VER,
            'd:' + (window._dataFp || 'pending')
        ].join('|');
    }

    function computeQueryContextSig() {
        return [
            computeCoreNamespace(),
            'l:' + Number(store.synonyms_enabled ?? 1),
            'n:' + Number(store.noise_level ?? 5)
        ].join('|');
    }

    async function bindCoreNamespace({ force = false } = {}) {
        if (!window._dataFp && !force) return false;
        try {
            return await searchResultCache.bindNamespace('core', computeCoreNamespace());
        } catch (e) { return false; }
    }

    async function bindSynonymsNamespace() {
        if (!window._synonymsReady || !window.synonymIndex) return false;
        try {
            const idx = window.synonymIndex;
            const sigPart = idx.sig
                ? String(idx.sig)
                : (Array.isArray(idx.groups) && idx.groups.length > 0 ? JSON.stringify(idx.groups) : String(idx.version || '0'));
            const fp = 'syn:' + hashText(String(idx.version || '') + '|' + sigPart);
            return await searchResultCache.bindNamespace('syn', fp);
        } catch (e) { return false; }
    }

    function cancelWorkerSearch(token) {
        const w = getActiveWorker();
        if (w) w.postMessage({ type: 'CANCEL', payload: { token } });
    }

    function invalidateSearch() {
        cancelWorkerSearch(++window._searchToken);
    }

    function rerunActiveSearch() {
        const el = document.getElementById("searchInput");
        const kw = el ? el.value.trim() : "";
        if (kw && (isAdsQuery(kw) || !isReservedSearchCommand(kw))) search(kw);
    }

    async function onSynonymsLoaded() {
        const changed = await bindSynonymsNamespace();
        const missed = !!window._searchSentWithoutSyn;
        window._searchSentWithoutSyn = false;
        termSpecsCache.clear();
        clearSearchOverlays();
        if (changed || missed) {
            invalidateSearch();
            rerunActiveSearch();
        }
        const activeKw = ($("#searchInput")?.value || store.keyword || '').trim();
        if (activeKw && store.resource_type === 'html' && (store.synonyms_enabled ?? 1) === 1) {
            emitEvent('REFRESH_HIGHLIGHT', { keyword: activeKw }, 'content');
        }
    }

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

    function termSpecsKey(kw, useSyn, raw = false) {
        return normalizeKeyword(kw) + '|' + (useSyn ? 1 : 0) + (raw ? '|raw' : '');
    }

    function cacheTermSpecs(kw, useSyn, specs, raw = false) {
        const key = termSpecsKey(kw, useSyn, raw);
        if (!key || !Array.isArray(specs) || specs.length === 0) return;
        termSpecsCache.delete(key);
        termSpecsCache.set(key, specs.slice());
        if (termSpecsCache.size > 256) termSpecsCache.delete(termSpecsCache.keys().next().value);
    }

    function hasTermSpecs(kw, useSyn, raw = false) {
        return !useSyn || !window._synonymsReady || termSpecsCache.has(termSpecsKey(kw, true, raw));
    }

    function ensureTermSpecs(items) {
        if (!Array.isArray(items) || items.length === 0 || !window._synonymsReady) return Promise.resolve();
        const worker = getWorker();
        if (!worker) return Promise.resolve();
        const missing = items.filter(it => it && it.text && it.like && !termSpecsCache.has(termSpecsKey(it.text, true, !!it.skipCorpusFilter)));
        if (missing.length === 0) return Promise.resolve();
        return new Promise((resolve) => {
            const reqId = ++_expandReqId;
            const timer = setTimeout(() => {
                pendingExpands.delete(reqId);
                resolve();
            }, 1500);
            pendingExpands.set(reqId, () => {
                clearTimeout(timer);
                resolve();
            });
            worker.postMessage({
                type: 'EXPAND_QUERY',
                payload: {
                    reqId,
                    items: missing.map(it => ({
                        text: it.text,
                        like: true,
                        skipCorpusFilter: !!it.skipCorpusFilter
                    }))
                }
            });
        });
    }

    function buildTermSpecs(kw, useSyn, raw = false) {
        const half = toHalfwidth(String(kw || ''));
        const compact = half.replace(/\s+/g, '');
        if (!compact) return [];
        if (useSyn) {
            const cached = termSpecsCache.get(termSpecsKey(half, true, raw));
            if (Array.isArray(cached) && cached.length > 0) return cached.slice();
        }
        return [{ text: compact, weight: 100, tier: 0 }];
    }

    function getSearchKeywords(kw) {
        return buildTermSpecs(kw, (store.synonyms_enabled ?? 1) === 1, isTxtScope());
    }

    function parseAdsQuery(raw) {
        const fail = (error) => ({ ok: false, error });
        const src = String(raw).trim()
            .replace(/＠/g, '@').replace(/[【［]/g, '[').replace(/[】］]/g, ']');
        if (!/^@\[/.test(src)) return fail('格式: ' + ADS_USAGE);

        const close = src.indexOf(']', 2);
        if (close < 0) return fail('缺少 ]，如 ' + ADS_USAGE);
        const es = src.slice(2, close)
            .replace(/＆/g, '&').replace(/｜/g, '|').replace(/！/g, '!').replace(/（/g, '(').replace(/）/g, ')')
            .replace(/\s+/g, '').toLowerCase();
        if (!es) return fail('表达式为空');
        const bad = /[^a-z&|!()]/.exec(es);
        if (bad) return fail(`非法字符「${bad[0]}」(仅限 & | ! ( ) a~z)`);

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
            if (!text) return fail(`第 ${n} 个 [] 前缺词`);
            if (!/^[0-9]*$/.test(digits)) return fail(`第 ${n} 个 [${m[2]}] 仅限数字`);
            if (digits.length > 2) return fail(`第 ${n} 个 [${digits}] 最多 2 位`);
            if (digits.length >= 1 && Number(digits[0]) > 5) return fail(`第 ${n} 个 [${digits}] 噪值需为 0~5`);
            if (digits.length === 2 && Number(digits[1]) > 1) return fail(`第 ${n} 个 [${digits}] 近义需为 0/1`);
            terms.push({
                text,
                noise: digits.length >= 1 ? Number(digits[0]) : defNoise,
                like: digits.length === 2 ? Number(digits[1]) : defLike
            });
        }
        const tail = rest.slice(at).trim();
        if (tail) return fail(/[\[\]]/.test(tail) ? '方括号未配对' : `「${tail}」后缺 []`);
        if (terms.length === 0) return fail('缺少词与 []，如 ' + ADS_USAGE);
        if (terms.length > 26) return fail('最多 26 个词 (a~z)');

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
            if (c === undefined) throw new AdsSyntaxError('表达式不完整');
            if (c === '!') { pos++; return { k: 'not', x: parseUnary(depth) }; }
            if (c === '(') {
                if (depth >= ADS_MAX_DEPTH) throw new AdsSyntaxError('括号嵌套过深');
                pos++;
                const e = parseOr(depth + 1);
                if (es[pos] !== ')') throw new AdsSyntaxError('缺少 )');
                pos++;
                return e;
            }
            if (c >= 'a' && c <= 'z') { pos++; used.add(c); return { k: 'var', ch: c }; }
            throw new AdsSyntaxError(`「${c}」前缺内容`);
        };
        let tree;
        try {
            tree = parseOr(0);
            if (pos < es.length) {
                throw new AdsSyntaxError(es[pos] === ')' ? '多余的 )' : `「${es[pos - 1]}」「${es[pos]}」间缺 & 或 |`);
            }
        } catch (e) {
            if (e instanceof AdsSyntaxError) return fail(e.message);
            throw e;
        }

        for (const ch of [...used].sort()) {
            if (ch.charCodeAt(0) - 97 >= terms.length) return fail(`未知形参 ${ch}(共 ${terms.length} 词)`);
        }
        for (let i = 0; i < terms.length; i++) {
            if (!used.has(String.fromCharCode(97 + i))) {
                return fail(`词「${terms[i].text}」未在表达式中使用`);
            }
        }

        const wire = (n, neg) => {
            if (n.k === 'var') return { op: 'term', term: n.ch.charCodeAt(0) - 97, neg };
            if (n.k === 'not') return wire(n.x, !neg);
            const op = (n.k === 'and') !== neg ? 'and' : 'or';
            return { op, args: n.xs.map(x => wire(x, neg)).flatMap(a => a.op === op ? a.args : [a]) };
        };
        const expr = wire(tree, false);
        if (adsHoldsOnEmpty(expr)) return fail('至少需一个正向词');

        const show = (n, parent) => {
            if (n.k === 'var') { const t = terms[n.ch.charCodeAt(0) - 97]; return `${t.text}[${t.noise}${t.like ? '·近' : ''}]`; }
            if (n.k === 'not') return n.x.k === 'var' ? '非' + show(n.x) : '非(' + show(n.x, null) + ')';
            const s = n.xs.map(x => show(x, n.k)).join(n.k === 'and' ? ' 且 ' : ' 或 ');
            return parent && parent !== n.k ? `(${s})` : s;
        };
        return { ok: true, terms, expr, summary: show(tree, null) };
    }

    function buildAdsPositiveTerms(kw) {
        const plan = parseAdsQuery(kw);
        if (!plan.ok) return null;
        const posIdx = new Set();
        const collect = (n) => {
            if (!n) return;
            if (n.op === 'term') { if (!n.neg) posIdx.add(n.term); }
            else if (Array.isArray(n.args)) n.args.forEach(collect);
        };
        collect(plan.expr);
        const terms = [];
        for (const idx of [...posIdx].sort((a, b) => a - b)) {
            const t = plan.terms[idx];
            if (!t) continue;
            const keywords = buildTermSpecs(t.text, !!t.like);
            if (keywords.length > 0) {
                terms.push({ text: t.text, like: !!t.like, noise: t.noise, keywords });
            }
        }
        return terms;
    }

    // 暴露给 content.js iframe 调用的顶层契约
    window.parseAdsQuery = parseAdsQuery;
    window.buildAdsPositiveTerms = buildAdsPositiveTerms;
    window.buildTermSpecs = buildTermSpecs;
    window.hasTermSpecs = hasTermSpecs;
    window.ensureTermSpecs = ensureTermSpecs;

    function setPageHit(kw, entry) {
        const key = pageOverlayKey(kw);
        if (!key) return false;
        let m = pageHitCache.get(key);
        pageHitCache.delete(key);
        if (!m) m = new Map();
        const prev = m.get(entry.path);
        m.delete(entry.path);
        m.set(entry.path, entry);
        pageHitCache.set(key, m);
        if (pageHitCache.size > 100) pageHitCache.delete(pageHitCache.keys().next().value);
        return !prev
            || prev.count !== entry.count
            || !!prev.matched !== !!entry.matched
            || !!prev.viaComment !== !!entry.viaComment;
    }

    function evaluateAdsOverlayForPath(kw, path, adsBodyHits) {
        if (!Array.isArray(adsBodyHits)) return null;
        const plan = parseAdsQuery(kw);
        if (!plan.ok || plan.terms.length !== adsBodyHits.length) return null;

        const commentModel = getCommentModel();
        let cmtTexts = null;
        if (commentModel && commentModel.ready && Array.isArray(commentModel.index)) {
            const doc = commentModel.index.find(d => d && d.path === path);
            if (doc && Array.isArray(doc.texts)) cmtTexts = doc.texts;
        }

        const cmtHits = plan.terms.map((t, idx) => {
            if (adsBodyHits[idx] || !cmtTexts || cmtTexts.length === 0) return false;
            const specs = buildTermSpecs(t.text, !!t.like);
            const out = [];
            for (const text of cmtTexts) {
                if (!text) continue;
                srCollectMatches(Array.from(text), specs, t.noise, out);
                if (out.length > 0) return true;
            }
            return false;
        });

        const evalNode = (n, useComments) => {
            if (n.op === 'term') {
                const hit = !!adsBodyHits[n.term] || (useComments && !!cmtHits[n.term]);
                return n.neg ? !hit : hit;
            }
            if (n.op === 'and') return n.args.every(a => evalNode(a, useComments));
            if (n.op === 'or') return n.args.some(a => evalNode(a, useComments));
            return false;
        };

        const matched = evalNode(plan.expr, true);
        const matchedBodyOnly = evalNode(plan.expr, false);
        return { matched, viaComment: matched && !matchedBodyOnly };
    }

    function applyPageOverlay(results, keyword) {
        if (!keyword || isActionCommand(keyword)) return results;
        const entries = pageHitCache.get(pageOverlayKey(keyword));
        if (!entries || entries.size === 0) return results;

        const strip = (p) => (p.startsWith('../') ? p.substring(3) : p);
        const indexByPath = new Map();
        results.forEach((r, i) => indexByPath.set(strip(r.path), i));

        const adsMode = isAdsQuery(keyword);
        const out = results.slice();
        const removed = new Set();
        const added = [];
        let latest = null;
        for (const e of entries.values()) {
            latest = e;
            const i = indexByPath.get(e.path);
            if (adsMode) {
                if (i !== undefined) {
                    if (e.matched) out[i] = Object.assign({}, out[i], { viaComment: !!e.viaComment });
                    else removed.add(i);
                } else if (e.matched) {
                    added.push({
                        title: e.title,
                        path: e.path,
                        type: 'html',
                        count: e.count,
                        localOnly: isPrivatePath(e.path),
                        viaComment: !!e.viaComment
                    });
                }
                continue;
            }
            if (i !== undefined) {
                const mergedCount = e.count > 0 ? e.count : (out[i].count || 0);
                out[i] = Object.assign({}, out[i], { count: mergedCount });
            } else if (e.count > 0) {
                added.push({ title: e.title, path: e.path, type: 'html', count: e.count, localOnly: isPrivatePath(e.path) });
            }
        }
        const li = latest ? indexByPath.get(latest.path) : undefined;
        if (li !== undefined && !removed.has(li) && li !== 0) {
            const latestItem = out[li];
            const filtered = out.filter((_, idx) => idx !== li && !removed.has(idx));
            filtered.unshift(latestItem);
            return added.length ? added.reverse().concat(filtered) : filtered;
        }
        const filtered = removed.size > 0 ? out.filter((_, idx) => !removed.has(idx)) : out;
        return added.length ? added.reverse().concat(filtered) : filtered;
    }

    function setCommentHits(kw, hits) {
        const norm = normalizeKeyword(kw);
        if (!norm) return false;
        const commentModel = getCommentModel();
        const sig = JSON.stringify(hits);
        const prev = commentHitCache.get(norm);
        commentHitCache.delete(norm);
        commentHitCache.set(norm, { ver: commentModel ? commentModel.ver : 0, hits, sig });
        if (commentHitCache.size > 100) commentHitCache.delete(commentHitCache.keys().next().value);
        return (prev ? prev.sig : "[]") !== sig;
    }

    function requestCommentHits(kw, token) {
        const commentModel = getCommentModel();
        const worker = getActiveWorker();
        if (!commentModel || !commentModel.ready || !worker) return;
        const norm = normalizeKeyword(kw);
        if (!norm || isReservedSearchCommand(kw)) return;
        const entry = commentHitCache.get(norm);
        if (entry && entry.ver === commentModel.ver) return;
        worker.postMessage({
            type: 'SEARCH_COMMENTS',
            payload: {
                keyword: kw,
                noise: Number(store.noise_level ?? 5),
                synonymsEnabled: (store.synonyms_enabled ?? 1) === 1,
                token
            }
        });
    }

    function refreshCommentOverlayForCurrentKeyword() {
        const kw = window._currentRenderedKeyword;
        if (!kw) return;
        if (isAdsQuery(kw)) { rerunActiveSearch(); return; }
        if (isReservedSearchCommand(kw)) return;
        requestCommentHits(kw, window._searchToken);
    }

    function applyCommentOverlay(results, keyword) {
        const commentModel = getCommentModel();
        if (!keyword || isReservedSearchCommand(keyword) || !commentModel || !commentModel.ready) return results;
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

    function handleLocalSearchResult(payload) {
        const activeKw = payload.keyword || store.keyword;
        const inputEl = document.getElementById("searchInput");
        const liveKw = (inputEl ? inputEl.value.trim() : "") || store.keyword || "";
        if (activeKw && liveKw && normalizeKeyword(activeKw) !== normalizeKeyword(liveKw)) return;
        if (!activeKw || isActionCommand(activeKw)) return;

        let hist = store.last_li_a;
        if (!Array.isArray(hist)) hist = hist ? [hist] : [];
        if (store.resource_type !== "html" || hist.length === 0) return;

        const currentPath = hist[0];
        const path = currentPath.startsWith('../') ? currentPath.substring(3) : currentPath;
        const title = payload.title || path.split('/').pop().replace('.html', '');
        const count = typeof payload.count === 'number' ? payload.count : 0;

        if (isAdsQuery(activeKw)) {
            const evalRes = evaluateAdsOverlayForPath(activeKw, path, payload.adsBodyHits);
            if (!evalRes) return;
            const changed = setPageHit(activeKw, {
                path, title, count,
                isAds: true,
                matched: evalRes.matched,
                viaComment: evalRes.viaComment
            });
            if (changed) uiHandlers.rerenderOverlay();
            return;
        }

        const changed = setPageHit(activeKw, { path, title, count });
        if (changed) uiHandlers.rerenderOverlay();
    }

    function requestSnippets(path, keyword) {
        if (isTxtScope() && txtProvider && typeof txtProvider.getSnippets === 'function') {
            return Promise.resolve(txtProvider.getSnippets(path, keyword));
        }
        const worker = getActiveWorker();
        if (!worker) return Promise.resolve(null);
        const commentModel = getCommentModel();
        const noise = Number(store.noise_level ?? 5);
        const useSyn = (store.synonyms_enabled ?? 1) === 1;
        const ads = isAdsQuery(keyword);
        const key = [ads ? keyword.trim() : normalizeKeyword(keyword), noise, useSyn ? 1 : 0, commentModel ? commentModel.ver : 0, path].join('|');

        const hit = snippetCache.get(key);
        if (hit) {
            snippetCache.delete(key);
            snippetCache.set(key, hit);
            return Promise.resolve(hit);
        }

        let adsTerms = null;
        if (ads) {
            adsTerms = buildAdsPositiveTerms(keyword);
            if (!adsTerms || adsTerms.length === 0) return Promise.resolve(null);
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
                payload: ads
                    ? {
                        reqId, path, keyword,
                        adsTerms: adsTerms.map(x => ({ text: x.text, like: !!x.like, noise: x.noise })),
                        maxBody: 40, maxComments: 30
                    }
                    : {
                        reqId, path, keyword, noise,
                        synonymsEnabled: useSyn,
                        maxBody: 40, maxComments: 30
                    }
            });
        });
    }

    function computeTitleMatchRanges(title, keyword) {
        if (!title || !keyword || typeof keyword !== 'string') return [];
        const kw = keyword.trim();
        if (!kw || /^@(bomb$|rebirth$)/.test(kw)) return [];

        const chars = Array.from(title);
        if (chars.length === 0) return [];

        const allHits = [];
        if (isAdsQuery(kw)) {
            const posTerms = buildAdsPositiveTerms(kw);
            if (!posTerms || posTerms.length === 0) return [];
            for (const t of posTerms) srCollectMatches(chars, t.keywords, t.noise, allHits);
        } else {
            const noise = Number(store.noise_level ?? 5);
            srCollectMatches(chars, getSearchKeywords(kw), noise, allHits);
        }

        if (allHits.length === 0) return [];
        allHits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

        const merged = [];
        for (const hit of allHits) {
            const last = merged[merged.length - 1];
            if (last && hit[0] < last[1]) {
                const lastLen = last[1] - last[0];
                const hitLen = hit[1] - hit[0];
                if (
                    hit[3] < last[3] ||
                    (hit[3] === last[3] && hit[2] < last[2]) ||
                    (hit[3] === last[3] && hit[2] === last[2] && hit[4] > last[4]) ||
                    (hit[3] === last[3] && hit[2] === last[2] && hit[4] === last[4] && hitLen > lastLen)
                ) {
                    merged[merged.length - 1] = hit;
                }
                continue;
            }
            merged.push(hit);
        }
        return merged.map(h => [h[0], h[1], Math.min(h[2], 255) | (Math.min(h[3], 3) << 8)]);
    }

    function searchAds(kw) {
        const token = ++window._searchToken;
        const plan = parseAdsQuery(kw);
        if (!plan.ok) {
            cancelWorkerSearch(token);
            window._adsStatus = { error: plan.error };
            uiHandlers.updateResults([], kw);
            return;
        }
        const worker = getActiveWorker();
        if (!worker) {
            console.warn("搜索引擎尚未就绪");
            return;
        }

        let synMissed = false;
        const terms = plan.terms.map(t => {
            if (t.like && !window._synonymsReady) synMissed = true;
            return { text: t.text, noise: t.noise, like: !!t.like };
        });
        if (synMissed) window._searchSentWithoutSyn = true;

        window._adsStatus = { summary: plan.summary };
        uiHandlers.paintStatus(kw);
        worker.postMessage({
            type: 'SEARCH_ADS',
            payload: { keyword: kw, token, ns: computeQueryContextSig(), plan: { terms, expr: plan.expr } }
        });
    }

    async function searchTxtBook(kw) {
        const provider = txtProvider;
        if (!provider) return;
        if (isAdsQuery(kw)) {
            invalidateSearch();
            if (typeof provider.clearHighlights === 'function') provider.clearHighlights();
            window._txtStatus = '⚠️ 文内搜索不支持组合语法 @[...]';
            uiHandlers.showTxtResults({ totalHits: 0, groups: [], keyword: kw }, kw);
            return;
        }

        const currentToken = ++window._searchToken;
        cancelWorkerSearch(currentToken);
        const useSyn = (store.synonyms_enabled ?? 1) === 1;
        const noise = Number(store.noise_level ?? 5);

        window._txtStatus = '搜索中...';
        uiHandlers.paintStatus(kw);

        if (useSyn) {
            if (!window._synonymsReady) window._searchSentWithoutSyn = true;
            await ensureTermSpecs([{ text: kw, like: true, skipCorpusFilter: true }]);
            if (currentToken !== window._searchToken || !isTxtScope() || txtProvider !== provider) return;
        }

        const specs = buildTermSpecs(kw, useSyn, true);
        const reportStatus = (msg) => {
            if (currentToken !== window._searchToken || !isTxtScope() || txtProvider !== provider) return;
            window._txtStatus = msg || '';
            uiHandlers.paintStatus(kw);
        };
        try {
            const res = await provider.runSearch({
                keyword: kw,
                specs,
                noise,
                synonymsEnabled: useSyn,
                token: currentToken,
                reportStatus
            });
            if (!res || currentToken !== window._searchToken || !isTxtScope() || txtProvider !== provider) return;
            window._txtStatus = res.statusMsg
                || (res.truncated ? `命中较多，已展示前 ${res.shownHits}/${res.totalHits} 处` : '');
            uiHandlers.showTxtResults(res, kw);
        } catch (err) {
            if (currentToken !== window._searchToken) return;
            console.error('[Doc Search] 失败:', err);
            window._txtStatus = '⚠️ 文内检索异常';
            uiHandlers.paintStatus(kw);
        }
    }

    async function search(rawKeyword) {
        if (typeof rawKeyword !== "string" || !rawKeyword.trim() || isActionCommand(rawKeyword)) {
            invalidateSearch();
            window._txtStatus = '';
            if (isTxtScope() && txtProvider && typeof txtProvider.clearHighlights === 'function') {
                txtProvider.clearHighlights();
            }
            uiHandlers.updateResults([]);
            return;
        }
        const kw = rawKeyword.trim();

        if (isTxtScope()) {
            await searchTxtBook(kw);
            return;
        }

        if (isAdsQuery(kw)) {
            searchAds(kw);
            return;
        }

        const currentToken = ++window._searchToken;
        const meta = await searchResultCache.getMeta(kw);

        if (currentToken !== window._searchToken) return;

        const useSyn = (store.synonyms_enabled ?? 1) === 1;
        if (meta && meta.exact) {
            if (Array.isArray(meta.termSpecs) && meta.termSpecs.length > 0) {
                cacheTermSpecs(kw, useSyn, meta.termSpecs);
            }
            cancelWorkerSearch(currentToken);
            requestCommentHits(kw, currentToken);
            uiHandlers.showResults(meta.results, kw, { fromCache: true });
            if (useSyn && !hasTermSpecs(kw, true)) {
                ensureTermSpecs([{ text: kw, like: true }]).then(() => {
                    if (normalizeKeyword(window._currentRenderedKeyword) === normalizeKeyword(kw)) {
                        uiHandlers.rerenderOverlay();
                    }
                });
            }
            return;
        }
        if (meta) {
            uiHandlers.showResults(meta.results, kw, { provisional: true, fromCache: true });
        }

        try {
            const worker = getActiveWorker();
            if (!worker) {
                console.warn("搜索引擎尚未就绪");
                return;
            }

            if (useSyn && !window._synonymsReady) window._searchSentWithoutSyn = true;

            worker.postMessage({
                type: 'SEARCH',
                payload: {
                    keyword: kw,
                    noise: Number(store.noise_level ?? 5),
                    synonymsEnabled: useSyn,
                    token: currentToken,
                    ns: computeQueryContextSig()
                }
            });
        } catch (err) {
            console.error("web worker 通信失败", err);
        }
    }

    function handleWorkerMessage(data) {
        const { type, results, keyword, token, payload, commentHits } = data;

        if (type === 'DELETE_CACHE') {
            const normO = normalizeKeyword(keyword);
            const inHist = (store.searchHistory || []).some(h => normalizeKeyword(h.keyword) === normO);
            if (!inHist) searchResultCache.remove(keyword);
            return true;
        }

        if (type === 'COMMENT_HITS') {
            if (token !== window._searchToken) return true;
            if (setCommentHits(keyword, commentHits || [])) uiHandlers.rerenderOverlay();
            return true;
        }

        if (type === 'SYNONYMS_READY') {
            window._synonymsReady = true;
            window.synonymIndex = payload || { version: '', groups: [] };
            onSynonymsLoaded().catch(() => { });
            return true;
        }

        if (type === 'EXPAND_RESULT') {
            const cb = pendingExpands.get(data.reqId);
            if (Array.isArray(data.results)) {
                for (const it of data.results) {
                    if (it && it.text && Array.isArray(it.specs)) {
                        cacheTermSpecs(it.text, !!it.like, it.specs, !!it.skipCorpusFilter);
                    }
                }
            }
            if (cb) {
                pendingExpands.delete(data.reqId);
                cb(data.results || []);
            }
            return true;
        }

        if (type === 'SNIPPETS_RESULT') {
            const cb = pendingSnippets.get(data.reqId);
            if (cb) {
                pendingSnippets.delete(data.reqId);
                cb(data.snippets);
            }
            return true;
        }

        if (type === 'ENGINE_ERROR') {
            window._engineError = data.error || '搜索引擎异常';
            uiHandlers.paintStatus(window._currentRenderedKeyword || ($("#searchInput") && $("#searchInput").value) || '');
            return true;
        }

        if (type === 'SEARCH_RESULTS') {
            if (token !== window._searchToken) {
                console.log(`[Search] 拦截到滞后结果 "${keyword}"，已丢弃。`);
                return true;
            }
            const curNs = computeQueryContextSig();
            if (data.ns && data.ns !== curNs) {
                console.log(`[Search] 拦截到跨设置结果 "${keyword}"，已丢弃。`);
                return true;
            }

            window._engineError = '';
            if (Array.isArray(commentHits)) setCommentHits(keyword, commentHits);
            if (data.error) window._adsStatus = { error: data.error };

            const activeKw = keyword || store.keyword;
            if (Array.isArray(data.termSpecs) && data.termSpecs.length > 0) {
                cacheTermSpecs(activeKw, (store.synonyms_enabled ?? 1) === 1, data.termSpecs);
            }
            if (Array.isArray(data.adsTermSpecs)) {
                for (const ts of data.adsTermSpecs) {
                    if (ts && ts.text && Array.isArray(ts.keywords)) {
                        cacheTermSpecs(ts.text, !!ts.like, ts.keywords);
                    }
                }
            }
            if (data.synApplied === false) window._searchSentWithoutSyn = true;

            if (activeKw && !isReservedSearchCommand(activeKw)) {
                clearTimeout(window._idbWriteTimer);
                window._idbWriteTimer = setTimeout(() => {
                    const w = getActiveWorker();
                    if (w) w.postMessage({ type: 'COMMIT_CURSOR', payload: { keyword: activeKw } });
                }, 600);
            }

            const nsMatched = !data.ns || data.ns === curNs;
            uiHandlers.showResults(results, activeKw, {
                noCache: data.synApplied === false || !nsMatched,
                termSpecs: data.termSpecs || null
            });
            return true;
        }

        return false;
    }

    return {
        searchCacheLRU,
        searchResultCache,
        setUIHandlers,
        search,
        searchAds,
        invalidateSearch,
        cancelWorkerSearch,
        rerunActiveSearch,
        onSynonymsLoaded,
        clearSearchOverlays,
        clearTransientCaches,
        bindCoreNamespace,
        bindSynonymsNamespace,
        computeQueryContextSig,
        applyPageOverlay,
        applyCommentOverlay,
        handleLocalSearchResult,
        refreshCommentOverlayForCurrentKeyword,
        requestSnippets,
        computeTitleMatchRanges,
        handleWorkerMessage,
        registerTxtProvider,
        unregisterTxtProvider,
        getTxtProvider,
        hasTxtProvider,
        getSearchScope,
        isTxtScope,
        setSearchScope
    };
}
