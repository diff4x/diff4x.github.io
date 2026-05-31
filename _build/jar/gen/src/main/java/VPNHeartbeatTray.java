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
        if (!SystemTray.isSupported()) { logger.warn("System tray is not supported!"); return; }
        initResources();
        SystemTray.getSystemTray().add(trayIcon);
        startLoop();
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
