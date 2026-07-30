import init, { set_data, search } from '../wasm/compute_intensive_task_processor.min.js';

let wasmReady = false;
let pendingBuffer = null;

init().then(() => {
    wasmReady = true;

    if (pendingBuffer) {
        set_data(new Uint8Array(pendingBuffer));
        pendingBuffer = null;
    }
});

self.onmessage = function(e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'SET_DATA':
            if (wasmReady) {
                set_data(new Uint8Array(payload));
            } else {
                pendingBuffer = payload;
            }
            break;

        case 'SEARCH':
            if (!wasmReady) {
                console.warn("[Worker] 搜索被丢弃：Wasm 引擎尚未就绪");
                return;
            }
            const results = search(payload.keyword);
            self.postMessage({
                type: 'SEARCH_RESULTS',
                results,
                keyword: payload.keyword,
                token: payload.token
            });
            break;
    }
};