import init, * as wasm from '../wasm/compute_intensive_task_processor.min.js';

const {
    set_data, build_flat_data, doc_count, search_multi_range,
    set_comments, search_comments, get_snippets
} = wasm;
// 新版 wasm 才有的导出；旧版没有时退化为 build_flat_data + set_data（见 BUILD_DATA）
const build_and_set_data = wasm.build_and_set_data;
// 组合搜索（@ads）同样是新版 wasm 才有的导出；旧版没有时 SEARCH_ADS 会回一个带 error 的空结果
const search_ads_range = wasm.search_ads_range;

let wasmReady = false;
let messageQueue = [];
let lastSavedKw = "";

// 数据就绪门控：BUILD_DATA 完成之前到达的 SEARCH 不能执行，否则 doc_count()==0，
// 会返回“空结果”并被主线程写进持久缓存。
let dataReady = false;
let pendingSearch = null;
// 每次 set_data 之后递增；搜索分片之间若发现版本变了，整体重来，避免一次搜索混用新旧数据
let dataGen = 0;

let latestToken = 0;
const SLICE_MS = 8;
const MIN_SLICE = 16;
const MAX_SLICE = 4096;
let sliceDocs = 256;

const yieldWaiters = [];
const yieldChan = new MessageChannel();
yieldChan.port1.onmessage = () => {
    const resolve = yieldWaiters.shift();
    if (resolve) resolve();
};
const yieldToQueue = () => new Promise(resolve => {
    yieldWaiters.push(resolve);
    yieldChan.port2.postMessage(0);
});

function bumpToken(t) {
    if (typeof t === 'number' && t > latestToken) latestToken = t;
}

function compareResults(a, b) {
    return (b.score - a.score)
        || (b.count - a.count)
        || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
}

// ---- 旧版 wasm 的退化路径：在 JS 里做瘦身与指纹 ----
// 瘦身：html 正文只保留 "localOnly" 标记（主线程只用它判断私有文档），其余类型原样保留
function slimFlat(raw) {
    const n = raw.length;
    const out = new Array(n);
    let i = 0;
    for (; i + 3 < n; i += 4) {
        const content = raw[i + 1];
        out[i] = raw[i];
        out[i + 1] = raw[i + 3] === 'html'
            ? (typeof content === 'string' && content.startsWith('localOnly') ? 'localOnly' : '')
            : content;
        out[i + 2] = raw[i + 2];
        out[i + 3] = raw[i + 3];
    }
    for (; i < n; i++) out[i] = raw[i];
    return out;
}

// 数据指纹：覆盖搜索实际看到的全部文本（含 isOffline 带来的正文差异）
function fingerprintFlat(raw, isOffline) {
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    h1 = Math.imul(h1 ^ (isOffline ? 1 : 0), 16777619);
    for (let k = 0; k < raw.length; k++) {
        const s = raw[k];
        const len = s.length;
        h1 = Math.imul(h1 ^ len, 16777619);
        for (let c = 0; c < len; c++) {
            const code = s.charCodeAt(c);
            h1 = Math.imul(h1 ^ code, 16777619);
            h2 = Math.imul(h2 ^ code, 0x85ebca6b) ^ (h2 >>> 15);
        }
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + '.' + raw.length;
}

// 分片扫描全库：每片约 SLICE_MS，片间让出线程；扫描期间数据被替换（BUILD_DATA 插在两片之间）时
// 丢弃已扫描的部分，用新数据重来。被新搜索取代时返回 null。
// scan(from, to) 返回该文档区间内的命中数组（普通搜索与组合搜索共用）。
async function scanAll(token, scan) {
    for (; ;) {
        const gen = dataGen;
        const total = doc_count();
        const results = [];
        let restart = false;

        for (let from = 0; from < total;) {
            if (token !== latestToken) return null;
            if (gen !== dataGen) { restart = true; break; }

            const to = Math.min(total, from + sliceDocs);
            const t0 = performance.now();
            const part = scan(from, to);
            const dt = performance.now() - t0;
            for (let i = 0; i < part.length; i++) results.push(part[i]);
            from = to;

            const ratio = Math.min(2, Math.max(0.5, SLICE_MS / Math.max(dt, 0.5)));
            sliceDocs = Math.min(MAX_SLICE, Math.max(MIN_SLICE, Math.round(sliceDocs * ratio)));

            if (from < total) await yieldToQueue();
        }
        if (restart || gen !== dataGen) continue;
        if (token !== latestToken) return null;

        results.sort(compareResults);
        return results;
    }
}

async function runSearch(payload) {
    if (payload.ads) return runAdsSearch(payload);

    const kw = payload.keyword;
    const token = payload.token;
    const noise = payload.noise !== undefined ? payload.noise : 5;
    const searchKeywords = payload.searchKeywords || [kw];

    const results = await scanAll(token, (from, to) => search_multi_range(searchKeywords, noise, from, to));
    if (results === null) return;

    let commentHits = [];
    try {
        commentHits = search_comments(searchKeywords, noise);
    } catch (err) {
        console.error("[Worker] 评论搜索失败:", err);
    }
    if (token !== latestToken) return;

    self.postMessage({
        type: 'SEARCH_RESULTS',
        results,
        keyword: kw,
        token,
        commentHits
    });
}

// 组合搜索：plan = { terms: [{ noise, keywords[] }], expr: 表达式树 }，近义词已由主线程按词条展开。
// 评论在 wasm 内并入各文档一起判定（只对正向词条生效），所以这里不再单独搜评论，也不回 commentHits。
async function runAdsSearch(payload) {
    const kw = payload.keyword;
    const token = payload.token;
    const plan = payload.plan || { terms: [], expr: null };

    if (typeof search_ads_range !== 'function') {
        console.error("[Worker] 当前 wasm 没有 search_ads_range，请用新版 lib.rs 重新编译");
        self.postMessage({
            type: 'SEARCH_RESULTS',
            results: [],
            keyword: kw,
            token,
            error: '组合搜索需要新版 wasm（缺少 search_ads_range）'
        });
        return;
    }

    const results = await scanAll(token, (from, to) => search_ads_range(plan, from, to));
    if (results === null) return;

    self.postMessage({ type: 'SEARCH_RESULTS', results, keyword: kw, token });
}

function startSearch(payload) {
    runSearch(payload).catch(err => console.error("[Worker] 搜索失败:", err));
}

function flushPendingSearch() {
    if (!pendingSearch) return;
    const p = pendingSearch;
    pendingSearch = null;
    startSearch(p);
}

async function initWorker() {
    try {
        await init();
        wasmReady = true;

        const queue = messageQueue;
        messageQueue = [];
        for (const msg of queue) {
            processMessage(msg);
        }
    } catch (err) {
        console.error("[Worker] 初始化 Wasm 失败:", err);
    }
}

initWorker();

self.onmessage = function (e) {
    const data = e.data;
    if (data && data.payload) bumpToken(data.payload.token);

    if (!wasmReady) {
        if (data.type === 'SEARCH' || data.type === 'SEARCH_ADS') {
            messageQueue = messageQueue.filter(m => m.type !== 'SEARCH' && m.type !== 'SEARCH_ADS');
        }
        messageQueue.push(data);
        return;
    }
    processMessage(data);
};

function processMessage(data) {
    const { type, payload } = data;

    switch (type) {
        case 'BUILD_DATA': {
            const { liteData, fatData, shadowData, isOffline } = payload;
            try {
                let slim, fp;
                if (typeof build_and_set_data === 'function') {
                    // 一次完成构建 + 入库，并直接返回瘦身数据与指纹，省掉整份语料的两次序列化往返
                    const out = build_and_set_data(liteData, fatData, shadowData, isOffline);
                    slim = out.data;
                    fp = out.fp;
                } else {
                    const raw = build_flat_data(liteData, fatData, shadowData, isOffline);
                    set_data(raw);
                    fp = fingerprintFlat(raw, isOffline);
                    slim = slimFlat(raw);
                }

                dataGen++;
                dataReady = true;

                // 主线程不再收到整份正文，只拿 path/type/localOnly 标记 + 数据指纹
                self.postMessage({ type: 'DATA_READY', payload: { data: slim, fp } });
                flushPendingSearch();
            } catch (err) {
                console.error("[Worker] 数据编译打包失败:", err);
            }
            break;
        }

        case 'SEARCH':
        case 'SEARCH_ADS': {
            const job = type === 'SEARCH_ADS' ? Object.assign({}, payload, { ads: true }) : payload;
            if (!dataReady) {
                // 只保留最新的一次（普通 / 组合不分），数据就绪后再执行
                pendingSearch = job;
                break;
            }
            startSearch(job);
            break;
        }

        case 'CANCEL':
            break;

        case 'SET_COMMENTS': {
            const docs = Array.isArray(payload) ? payload : [];
            set_comments(docs.map(d => ({
                path: d.path,
                texts: (d.texts || []).map(t => (typeof t === 'string' ? t : ''))
            })));
            break;
        }

        case 'SEARCH_COMMENTS': {
            let hits = [];
            try {
                hits = search_comments(
                    payload.searchKeywords || [payload.keyword],
                    payload.noise !== undefined ? payload.noise : 5
                );
            } catch (err) {
                console.error("[Worker] 评论搜索失败:", err);
            }
            self.postMessage({
                type: 'COMMENT_HITS',
                keyword: payload.keyword,
                token: payload.token,
                commentHits: hits
            });
            break;
        }

        case 'SNIPPETS': {
            let snippets = null;
            try {
                snippets = get_snippets(
                    payload.path,
                    payload.searchKeywords || [payload.keyword],
                    payload.noise !== undefined ? payload.noise : 5,
                    payload.maxBody !== undefined ? payload.maxBody : 40,
                    payload.maxComments !== undefined ? payload.maxComments : 30
                );
            } catch (err) {
                console.error("[Worker] snippet 生成失败:", err);
            }
            self.postMessage({
                type: 'SNIPPETS_RESULT',
                reqId: payload.reqId,
                path: payload.path,
                snippets
            });
            break;
        }

        case 'COMMIT_CURSOR': {
            const newKw = payload.keyword;
            let deleteOld = null;
            if (lastSavedKw && newKw.startsWith(lastSavedKw) && newKw.length > lastSavedKw.length) {
                deleteOld = lastSavedKw;
            }
            lastSavedKw = newKw;

            if (deleteOld) {
                self.postMessage({ type: 'DELETE_CACHE', keyword: deleteOld });
            }
            break;
        }

        case 'CLEAR_CURSOR':
            lastSavedKw = "";
            break;
    }
}