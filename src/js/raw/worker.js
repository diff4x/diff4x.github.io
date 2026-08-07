import init, { set_data, search, build_flat_data } from '../wasm/compute_intensive_task_processor.min.js';

let wasmReady = false;
let messageQueue = [];
let lastSavedKw = "";

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
            const results = search(kw, noise);
            
            let inheritFrom = null;
            if (lastSavedKw && kw.startsWith(lastSavedKw)) {
                inheritFrom = lastSavedKw;
            }

            self.postMessage({
                type: 'SEARCH_RESULTS',
                results,
                keyword: kw,
                token: payload.token,
                inheritFrom
            });
            break;

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