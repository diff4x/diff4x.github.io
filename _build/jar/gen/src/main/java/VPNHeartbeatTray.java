import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.net.HttpURLConnection;
import java.net.URL;

public class VPNHeartbeatTray {
    private static final Logger logger = LoggerFactory.getLogger(VPNHeartbeatTray.class);
    private static TrayIcon trayIcon;
    private static Image greenIcon, redIcon;

    public static void run(String[] args) throws Exception {
        if (!SystemTray.isSupported()) {
            logger.warn("System tray is not supported!");
            return;
        }
        initResources();
        SystemTray.getSystemTray().add(trayIcon);

        // 与原来一致：只起心跳，主线程尽快结束
        startLoop();

        // Tasks / OAuth 不挡启动，依附同一进程
        startTasksLoop();
    }

    /** VPN 心跳 */
    private static void startLoop() {
        new Thread(() -> {
            while (true) {
                try {
                    URL url = new URL(Config.urlToCheck);
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    connection.setRequestMethod("GET"); connection.setConnectTimeout(3000); connection.setReadTimeout(3000); connection.connect();
                    if (connection.getResponseCode() == 200) {
                        trayIcon.setImage(greenIcon); trayIcon.setToolTip("VPN Heartbeat: Online");
                    } else {
                        trayIcon.setImage(redIcon); trayIcon.setToolTip("VPN Heartbeat: Offline (non-200)");
                    }
                    connection.disconnect();
                } catch (Exception ex) {
                    trayIcon.setImage(redIcon); trayIcon.setToolTip("VPN Heartbeat: Offline (fail)");
                }
                try { Thread.sleep(10000); } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    /**
     * Google Tasks：OAuth + 定时拉取，全部在后台线程
     * 失败只打日志，不影响托盘和心跳
     */
    private static void startTasksLoop() {
        Thread t = new Thread(() -> {
            GoogleTasksService tasksService;
            try {
                // 首次会在这里弹浏览器 / 等本地回环；只阻塞本线程
                try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
                tasksService = new GoogleTasksService();
            } catch (Exception e) {
                logger.error("Google Tasks 授权或初始化失败，托盘继续运行", e);
                return;
            }

            while (true) {
                try {
                    tasksService.fetchAndWriteUpcomingTasks();
                } catch (Exception e) {
                    logger.error("拉取 Google Tasks 失败", e);
                }
                try {
                    Thread.sleep(Config.TASKS_POLL_INTERVAL_MS);
                } catch (InterruptedException e) {
                    logger.info("Tasks 轮询线程退出");
                    break;
                }
            }
        }, "GoogleTasks-Poller");
        t.start();
    }

    private static void initResources() {
        PopupMenu popup = new PopupMenu();
        MenuItem exitItem = new MenuItem("Exit");
        exitItem.addActionListener(e -> System.exit(0));

        addMenuItem(popup, "Event Viewer", "Start-Process mmc.exe eventvwr.msc -Verb runAs");
        addMenuItem(popup, "Device Manager", "Start-Process mmc.exe devmgmt.msc -Verb runAs");
        addMenuItem(popup, "Services", "Start-Process mmc.exe services.msc -Verb runAs");
        addMenuItem(popup, "Static Web Server", "static-web-server.exe -d . -p 8000 -g info");
        popup.add(exitItem);

        greenIcon = createIcon(Color.GREEN);
        redIcon = createIcon(Color.RED);
        trayIcon = new TrayIcon(redIcon, "VPN Heartbeat", popup);
        trayIcon.setImageAutoSize(true);
    }

    private static void addMenuItem(PopupMenu menu, String label, String powershellCmd) {
        MenuItem item = new MenuItem(label);
        item.addActionListener(e -> Utils.executeCmdCommand(label, "powershell -Command \"" + powershellCmd + "\""));
        menu.add(item);
    }

    private static Image createIcon(Color color) {
        int size = 16;
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g2d = image.createGraphics();
        g2d.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        GradientPaint gp = new GradientPaint(0, 0, color.brighter(), size, size, color.darker());
        g2d.setPaint(gp);
        g2d.fillOval(0, 0, size - 1, size - 1);
        g2d.dispose();
        return image;
    }
}