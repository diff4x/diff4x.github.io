import com.google.api.client.auth.oauth2.Credential;
import com.google.api.client.extensions.java6.auth.oauth2.AuthorizationCodeInstalledApp;
import com.google.api.client.extensions.jetty.auth.oauth2.LocalServerReceiver;
import com.google.api.client.googleapis.auth.oauth2.GoogleAuthorizationCodeFlow;
import com.google.api.client.googleapis.auth.oauth2.GoogleClientSecrets;
import com.google.api.client.googleapis.javanet.GoogleNetHttpTransport;
import com.google.api.client.http.javanet.NetHttpTransport;
import com.google.api.client.json.JsonFactory;
import com.google.api.client.json.gson.GsonFactory;
import com.google.api.client.util.store.FileDataStoreFactory;
import com.google.api.services.tasks.Tasks;
import com.google.api.services.tasks.TasksScopes;
import com.google.api.services.tasks.model.Task;
import com.google.api.services.tasks.model.TaskList;
import com.google.api.services.tasks.model.TaskLists;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class GoogleTasksService {
    private static final Logger logger = LoggerFactory.getLogger(GoogleTasksService.class);
    private static final String APPLICATION_NAME = "VPNHeartbeatTray-Tasks";
    private static final JsonFactory JSON_FACTORY = GsonFactory.getDefaultInstance();
    private static final List<String> SCOPES = Collections.singletonList(TasksScopes.TASKS_READONLY);

    private final Tasks service;
    private final ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    public GoogleTasksService() throws Exception {
        NetHttpTransport httpTransport = GoogleNetHttpTransport.newTrustedTransport();
        Credential credential = authorize(httpTransport);
        this.service = new Tasks.Builder(httpTransport, JSON_FACTORY, credential)
                .setApplicationName(APPLICATION_NAME)
                .build();
//        logger.info("Google Tasks service ready");
    }

    /**
     * 首次：打开浏览器 + 本地 8888 回环拿 code，换 token 并写入 tokens/
     * 之后：直接读 StoredCredential，过期时库自动用 refresh_token 刷新
     */
    private static Credential authorize(NetHttpTransport httpTransport) throws Exception {
        File credFile = new File(Config.CREDENTIALS_FILE);
        if (!credFile.exists()) {
            throw new IllegalStateException("找不到 credentials.json: " + credFile.getAbsolutePath());
        }

        GoogleClientSecrets clientSecrets = GoogleClientSecrets.load(
                JSON_FACTORY, new InputStreamReader(new FileInputStream(credFile)));

        GoogleAuthorizationCodeFlow flow = new GoogleAuthorizationCodeFlow.Builder(
                httpTransport, JSON_FACTORY, clientSecrets, SCOPES)
                .setDataStoreFactory(new FileDataStoreFactory(new File(Config.TOKENS_DIR)))
                .setAccessType("offline")   // 关键拿到 refresh_token
                .setApprovalPrompt("force") // 若之前没拿到 refresh，可强制再授权一次；稳定后可去掉
                .build();

        LocalServerReceiver receiver = new LocalServerReceiver.Builder()
                .setPort(8888)
                .build();

        // 第一次会弹浏览器；有 token 后直接返回
        return new AuthorizationCodeInstalledApp(flow, receiver, url -> openBrowser(url))
                .authorize("user");
    }

    /**
     * Windows 下可靠打开浏览器；优先 Chrome，失败再回退系统默认 / rundll32
     */
    private static void openBrowser(String url) {
//        logger.info("请在浏览器中打开授权页（若未自动弹出）:\n{}", url);

        // 1) 优先用 Chrome（常见安装路径）
        String[] chromeCandidates = {
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                System.getenv("LOCALAPPDATA") + "\\Google\\Chrome\\Application\\chrome.exe"
        };
        for (String chrome : chromeCandidates) {
            if (chrome != null && new java.io.File(chrome).isFile()) {
                try {
                    new ProcessBuilder(chrome, url).start();
//                    logger.info("已用 Chrome 打开授权页");
                    return;
                } catch (Exception e) {
                    logger.warn("Chrome 启动失败: {}", e.toString());
                }
            }
        }

        // 2) cmd start（走系统默认浏览器）
        try {
            new ProcessBuilder("cmd", "/c", "start", "", url).start();
//            logger.info("已用系统默认浏览器打开授权页");
            return;
        } catch (Exception e) {
            logger.warn("cmd start 失败: {}", e.toString());
        }

        // 3) rundll32
        try {
            Runtime.getRuntime().exec(new String[]{
                    "rundll32", "url.dll,FileProtocolHandler", url
            });
//            logger.info("已用 rundll32 打开授权页");
            return;
        } catch (Exception e) {
            logger.warn("rundll32 失败: {}", e.toString());
        }

        // 4) Desktop（最后兜底）
        try {
            if (java.awt.Desktop.isDesktopSupported()) {
                java.awt.Desktop.getDesktop().browse(java.net.URI.create(url));
                return;
            }
        } catch (Exception e) {
            logger.warn("Desktop.browse 失败: {}", e.toString());
        }

        // 全部失败：弹窗让用户手动复制
        javax.swing.SwingUtilities.invokeLater(() ->
                javax.swing.JOptionPane.showInputDialog(
                        null,
                        "无法自动打开浏览器，请复制下面链接到 Chrome 打开：",
                        "Google 授权",
                        javax.swing.JOptionPane.INFORMATION_MESSAGE,
                        null,
                        null,
                        url
                )
        );
    }

    /**
     * 拉取所有任务列表中、截止时间在 [很久以前, 现在+N天] 且未完成的任务，写 JSON
     */
    public void fetchAndWriteUpcomingTasks() {
        try {
            Instant now = Instant.now();
            // due 只有日期，时间部分会被 API 丢弃；用 RFC3339 字符串即可
            String dueMin = "1970-01-01T00:00:00.000Z"; // 含过期未完成
            String dueMax = now.plus(Config.DUE_WITHIN_DAYS, ChronoUnit.DAYS)
                    .toString(); // 例如 2026-08-07T15:34:00.000Z

            List<Map<String, Object>> result = new ArrayList<>();

            TaskLists lists = service.tasklists().list().setMaxResults(100).execute();
            if (lists.getItems() == null) {
                writeJson(result);
                return;
            }

            for (TaskList list : lists.getItems()) {
                String pageToken = null;
                do {
                    com.google.api.services.tasks.model.Tasks tasksPage = service.tasks()
                            .list(list.getId())
                            .setShowCompleted(false)
                            .setShowHidden(false)
                            .setDueMin(dueMin)
                            .setDueMax(dueMax)
                            .setMaxResults(100)
                            .setPageToken(pageToken)
                            .execute();

                    if (tasksPage.getItems() != null) {
                        for (Task t : tasksPage.getItems()) {
                            Map<String, Object> m = new HashMap<>();
                            m.put("listId", list.getId());
                            m.put("listTitle", list.getTitle());
                            m.put("id", t.getId());
                            m.put("title", t.getTitle());
                            m.put("notes", t.getNotes());
                            m.put("due", t.getDue());
                            m.put("status", t.getStatus());
                            m.put("updated", t.getUpdated());
                            m.put("webViewLink", t.getWebViewLink());
                            result.add(m);
                        }
                    }
                    pageToken = tasksPage.getNextPageToken();
                } while (pageToken != null);
            }

            writeJson(result);
//            logger.info("已写入临期任务 {} 条 -> {}", result.size(), Config.TASKS_JSON_PATH);
        } catch (Exception e) {
            logger.error("拉取 Google Tasks 失败", e);
        }
    }

    private void writeJson(List<Map<String, Object>> data) throws Exception {
        Path path = Paths.get(Config.TASKS_JSON_PATH);
        Path parent = path.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        mapper.writeValue(path.toFile(), data);
    }
}