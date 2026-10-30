import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Google Tasks 后台轮询 + 失败分流。所有状态只在轮询线程内读写，无需加锁。
 *
 * 每轮流程：
 *   1. 心跳显示网络不通            -> 静默跳过（不调 API、不写日志）
 *   2. 没有可用 service            -> 冷却期满才尝试授权（首次授权 / 上次授权失败或被忽略）
 *   3. 拉取任务，失败按类型处理：
 *        网络类：心跳仍显示正常却连续失败 N 次，才记一条单行日志（每次故障一条）
 *        授权类：清除 token 并重新授权；两次授权之间至少间隔 AUTH_COOLDOWN_MS
 *        其他类：首次记完整堆栈，相同"类型+信息"不重复，成功后重置
 */
public final class GoogleTasksPoller {
    private static final Logger logger = LoggerFactory.getLogger(GoogleTasksPoller.class);

    /** 心跳显示正常、但 API 连续网络失败达到该次数，记一条单行日志 */
    private static final int NET_FAIL_LOG_THRESHOLD = 3;
    /** 两次"弹窗授权"之间的最短间隔 */
    private static final long AUTH_COOLDOWN_MS = 4L * 60 * 60 * 1000;
    /** 保持原行为：启动后稍等再开始 */
    private static final long STARTUP_DELAY_MS = 1500;
    /** 启动时最多等心跳首个探测结果多久，避免第一轮被白白跳过 */
    private static final long FIRST_HEARTBEAT_WAIT_MS = 15_000;
    private static final DateTimeFormatter HHMM = DateTimeFormatter.ofPattern("HH:mm");

    private GoogleTasksService service;        // null = 还没有可用的授权
    private long lastAuthAttemptMs;            // 最近一次"弹窗授权"的时间，0 = 从未
    private int netFailCount;                  // 心跳正常下的连续网络失败次数
    private boolean netFailLogged;             // 本次故障的网络类日志是否已记
    private boolean authFailLogged;            // 本次故障的"冷却中"日志是否已记
    private String lastOtherSignature;         // 其他类错误的去重签名

    private GoogleTasksPoller() {
    }

    public static void start() {
        Thread t = new Thread(() -> new GoogleTasksPoller().run(), "GoogleTasks-Poller");
        t.start();
    }

    private void run() {
        try {
            Thread.sleep(STARTUP_DELAY_MS);
            awaitFirstHeartbeat();
            while (true) {
                try {
                    pollOnce();
                } catch (Exception e) {
                    // 分流逻辑自身出错时的兜底；同样去重，避免确定性 bug 每轮刷屏
                    reportOther("Tasks 轮询异常", e);
                }
                Thread.sleep(Config.TASKS_POLL_INTERVAL_MS);
            }
        } catch (InterruptedException e) {
            logger.info("Tasks 轮询线程退出");
        }
    }

    private static void awaitFirstHeartbeat() throws InterruptedException {
        long deadline = System.currentTimeMillis() + FIRST_HEARTBEAT_WAIT_MS;
        while (!VPNHeartbeatTray.hasHeartbeatResult() && System.currentTimeMillis() < deadline) {
            Thread.sleep(200);
        }
    }

    private void pollOnce() {
        if (!VPNHeartbeatTray.isOnline()) {
            netFailCount = 0;   // 断网期间静默，"连续失败"计数就此中断
            return;
        }

        if (service == null) {
            if (!authCooldownPassed()) {
                return;
            }
            if (!authorize()) {
                return;
            }
        }
        fetch();
    }

    /**
     * 创建 service（可能弹出授权页并阻塞，最长 30 分钟，期间只卡本线程）。
     * 只有真的弹出了授权页才计入冷却；没走到授权页的失败（如缺 credentials.json）走去重日志，之后每轮静默重试，文件补上后自动恢复。
     */
    private boolean authorize() {
        try {
            service = new GoogleTasksService();
            if (GoogleTasksService.isInteractiveAuthTriggered()) {
                lastAuthAttemptMs = System.currentTimeMillis();
            }
            return true;
        } catch (Exception e) {
            service = null;
            if (GoogleTasksService.isInteractiveAuthTriggered()) {
                lastAuthAttemptMs = System.currentTimeMillis();
                logger.warn("Google Tasks 授权未完成({})，最早 {} 再次尝试", brief(e), nextAuthTime());
            } else {
                reportOther("Google Tasks 初始化失败", e);
            }
            return false;
        }
    }

    private void fetch() {
        try {
            service.fetchAndWriteUpcomingTasks();
            onSuccess();
        } catch (Exception e) {
            switch (GoogleTasksService.classify(e)) {
                case NETWORK:
                    onNetworkFailure(e);
                    break;
                case AUTH:
                    onAuthFailure(e);
                    break;
                default:
                    reportOther("拉取 Google Tasks 失败", e);
            }
        }
    }

    private void onSuccess() {
        netFailCount = 0;
        netFailLogged = false;
        authFailLogged = false;
        lastOtherSignature = null;
    }

    private void onNetworkFailure(Exception e) {
        if (!VPNHeartbeatTray.isOnline()) {
            // 刚好断网：心跳红灯已经说明原因，不计数、不记录
            netFailCount = 0;
            return;
        }
        // 心跳正常、API 却不通（心跳目标不等于 googleapis 时会这样）：连续 N 次才记一条
        netFailCount++;
        if (netFailCount >= NET_FAIL_LOG_THRESHOLD && !netFailLogged) {
            netFailLogged = true;
            logger.warn("Google Tasks 已连续 {} 次网络失败，但心跳显示网络正常: {}", netFailCount, brief(e));
        }
    }

    private void onAuthFailure(Exception e) {
        if (!authCooldownPassed()) {
            // 刚授权过又失效（或仍在冷却）：不再弹窗，每次故障只记一行
            if (!authFailLogged) {
                authFailLogged = true;
                logger.warn("Google Tasks 授权失效({})，冷却中，最早 {} 再次授权", brief(e), nextAuthTime());
            }
            return;
        }

        // 先计时：保证下面授权成功后立刻重拉时，若仍失效不会递归弹窗
        lastAuthAttemptMs = System.currentTimeMillis();
        logger.warn("Google Tasks 授权失效({})，清除凭证并重新授权", brief(e));
        try {
            GoogleTasksService.clearStoredCredential();
        } catch (Exception ce) {
            // 清不掉就不弹窗：否则 authorize 会直接读回那份已失效的凭证
            reportOther("清除失效凭证失败", ce);
            return;
        }
        service = null;
        if (authorize()) {
            fetch();
        }
    }

    private boolean authCooldownPassed() {
        return lastAuthAttemptMs == 0 || System.currentTimeMillis() - lastAuthAttemptMs >= AUTH_COOLDOWN_MS;
    }

    private String nextAuthTime() {
        long next = lastAuthAttemptMs + AUTH_COOLDOWN_MS;
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(next), ZoneId.systemDefault()).format(HHMM);
    }

    /** 其他类错误：首次记完整堆栈，相同"类型+信息"不再重复；成功后重置 */
    private void reportOther(String what, Throwable e) {
        String signature = e.getClass().getName() + ":" + e.getMessage();
        if (signature.equals(lastOtherSignature)) {
            return;
        }
        lastOtherSignature = signature;
        logger.error(what, e);
    }

    /** 单行摘要：不带堆栈，空白折叠，限长 */
    private static String brief(Throwable e) {
        String s = (e.getClass().getSimpleName() + ": " + e.getMessage()).replaceAll("\\s+", " ").trim();
        return s.length() > 300 ? s.substring(0, 300) + "..." : s;
    }
}
