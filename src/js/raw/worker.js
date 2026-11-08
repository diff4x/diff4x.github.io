import init, { set_data, search_multi, build_flat_data, find_content_matches_multi } from '../wasm/compute_intensive_task_processor.min.js';

let wasmReady = false;
let messageQueue = [];
let lastSavedKw = "";

// 评论索引：[{ path, texts: [纯文本评论, ...] }]，由主线程通过 SET_COMMENTS 注入
let commentIndex = [];

// 在评论里找补：对每条评论复用与正文相同的匹配内核（含宽容度/近义词），
// 返回 [{ path, count }]，count = 命中搜索词的评论条数。
function searchComments(keywords, noise) {
    if (!commentIndex.length) return [];
    const hits = [];
    for (const art of commentIndex) {
        let n = 0;
        for (const text of art.texts) {
            if (!text) continue;
            const r = find_content_matches_multi(text, keywords, noise);
            if (r && r.count > 0) n++;
        }
        if (n > 0) hits.push({ path: art.path, count: n });
    }
    hits.sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return hits;
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

self.onmessage = function(e) {
    if (!wasmReady) {
        messageQueue.push(e.data);
        return;
    }
    processMessage(e.data);
};

function processMessage(data) {
    const { type, payload } = data;

    switch (type) {
        case 'BUILD_DATA':
            const { liteData, fatData, shadowData, isOffline } = payload;
            try {
                const rawResult = build_flat_data(
                    liteData,
                    fatData,
                    shadowData,
                    isOffline
                );

                set_data(rawResult);

                self.postMessage({ type: 'DATA_READY', payload: rawResult });
            } catch (err) {
                console.error("[Worker] 数据编译打包失败:", err);
            }
            break;

        case 'SET_DATA':
            set_data(payload);
            break;

        case 'SEARCH':
            const kw = payload.keyword;
            const noise = payload.noise !== undefined ? payload.noise : 5;
            
            const searchKeywords = payload.searchKeywords || [kw]; 
            
            const results = search_multi(searchKeywords, noise);
            
            let inheritFrom = null;
            if (lastSavedKw && kw.startsWith(lastSavedKw)) {
                inheritFrom = lastSavedKw;
            }

            // 正文结果算完之后，再从评论里找补一遍
            let commentHits = [];
            try {
                commentHits = searchComments(searchKeywords, noise);
            } catch (err) {
                console.error("[Worker] 评论搜索失败:", err);
            }

            self.postMessage({
                type: 'SEARCH_RESULTS',
                results,
                keyword: kw,
                token: payload.token,
                inheritFrom,
                commentHits
            });
            break;

        case 'SET_COMMENTS':
            commentIndex = Array.isArray(payload) ? payload : [];
            break;

        // 主线程命中了本地搜索缓存、没有走 SEARCH 时，单独请求评论命中
        case 'SEARCH_COMMENTS': {
            let hits = [];
            try {
                hits = searchComments(payload.searchKeywords || [payload.keyword], payload.noise !== undefined ? payload.noise : 5);
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


        case 'COMMIT_CURSOR':
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

        case 'CLEAR_CURSOR':
            lastSavedKw = "";
            break;
    }
}