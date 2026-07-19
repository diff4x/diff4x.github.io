import { WebWorkerMLCEngineHandler } from "../third/web-llm/web-llm.js";

try {
    const handler = new WebWorkerMLCEngineHandler();
    self.onmessage = (msg) => {
        handler.onmessage(msg);
    };
    console.log("llm-Worker 初始化成功");
} catch (err) {
    console.error("llm-Worker 内部初始化崩溃:", err);
}