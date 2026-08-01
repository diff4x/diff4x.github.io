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

// 统一的消息分发入口（只有一个）
self.onmessage = function(e) {
    if (!wasmReady) {
        // 如果还未就绪，先压入队列暂存，不丢弃任务
        messageQueue.push(e.data);
        return;
    }
    processMessage(e.data);
};

// 实际处理业务逻辑的分发函数
function processMessage(data) {
    const { type, payload } = data;

    switch (type) {
        case 'BUILD_DATA':
            const { liteData, fatData, shadowData, isOffline } = payload;
            try {
                // 🚀 优化 2：剥离所有 MessagePack.encode 动作，直接传递 JS 对象给 Wasm
                const rawResult = build_flat_data(
                    liteData,
                    fatData,
                    shadowData,
                    isOffline
                );
                
                // 此时 rawResult 已经是一个原生的 JS 数组 (Array of Strings)
                // 直接灌入 Wasm 内存池
                set_data(rawResult);

                // 🚀 优化 3：利用 V8 高效的结构化克隆算法 (Structured Clone) 直接把数组扔给主线程，替代 ArrayBuffer
                self.postMessage({ type: 'DATA_READY', payload: rawResult });
            } catch (err) {
                console.error("[Worker] 数据编译打包失败:", err);
            }
            break;

        case 'SET_DATA':
            // 接收数组直接存入
            set_data(payload);
            break;

        case 'SEARCH':
            const kw = payload.keyword;
            const noise = payload.noise !== undefined ? payload.noise : 3;
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
                inheritFrom // 附带继承凭证下发给主线程
            });
            break;

        case 'COMMIT_CURSOR':
            const newKw = payload.keyword;
            let deleteOld = null;
            if (lastSavedKw && newKw.startsWith(lastSavedKw) && newKw.length > lastSavedKw.length) {
                deleteOld = lastSavedKw;
            }
            lastSavedKw = newKw;
            
            // 如果触发了剪枝条件，反向命令主线程删掉旧缓存
            if (deleteOld) {
                self.postMessage({ type: 'DELETE_CACHE', keyword: deleteOld });
            }
            break;

        case 'CLEAR_CURSOR':
            // 【修复】：此前写成 `if (lastSavedKw === payload.keyword)`，
            // 而唯一的调用方（切换 @noise 宽容度时）永远传的是 payload.keyword === ""，
            // 这个条件几乎不可能成立（除非游标本来就是空的），导致"清空游标"这个动作
            // 实际上从来没有真正执行过。lastSavedKw 会带着旧宽容度下确认过的关键词
            // 继续存活，后续搜索仍可能通过 inheritFrom 机制继承到旧宽容度算出的结果。
            // CLEAR_CURSOR 语义就是"无条件清空"，不需要也不应该比较 keyword。
            lastSavedKw = "";
            break;
    }
}