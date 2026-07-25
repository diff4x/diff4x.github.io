import init, { set_data, search } from '../wasm/compute_intensive_task_processor.min.js';

let wasmReady = false;
let pendingData = null;

// 初始化 WebAssembly 实例
init().then(() => {
    wasmReady = true;
    // console.log("[Worker] Rust Wasm 搜索引擎初始化完毕");
    
    // 如果在加载 Wasm 期间 JS 已经发来了数据，立即注入
    if (pendingData) {
        set_data(pendingData);
        pendingData = null;
    }
});

self.onmessage = function(e) {
    const { type, payload } = e.data;
    
    switch (type) {
        case 'SET_DATA':
            if (wasmReady) {
                // 直接将数据打入 Rust 内存池
                set_data(payload);
            } else {
                // Wasm 尚未加载完，暂存
                pendingData = payload;
            }
            break;
            
        case 'SEARCH':
            if (!wasmReady) {
                console.warn("[Worker] 搜索被丢弃：Wasm 引擎尚未就绪");
                return;
            }
            
            // 调用 Rust 提供的方法，一刀切完成匹配、切片、算分和排序
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