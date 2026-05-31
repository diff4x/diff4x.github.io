import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.StringSelection;
import java.awt.datatransfer.Transferable;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class WebpConverter {
    private static final Logger logger = LoggerFactory.getLogger(WebpConverter.class);

    public static void run(String[] args) throws Exception {
        // 解析 CLI.bat 传过来的四个参数
        String _maxWidth = (args.length > 0 && !args[0].isEmpty()) ? args[0].trim() : "800";
        String _webpQuality = (args.length > 1 && !args[1].isEmpty()) ? args[1].trim() : "80";
        String _change_output_dir = (args.length > 2 && !args[2].isEmpty()) ? args[2].trim() : "0";
        boolean update_img_mapping = args.length > 3 && args[3].trim().equals("1");

        int maxWidth = Integer.parseInt(_maxWidth);
        int webpQuality = Integer.parseInt(_webpQuality);

        // 使用 Config 加载真实的源路径，完美还原原有逻辑
        Path imgInputDir = Config.buildRoot.resolve(Config.props.getProperty("imgInputDir")).normalize();
        Path imgResizedOutputDir = Config.buildRoot.resolve(Config.props.getProperty("imgResizedOutputDir")).normalize();
        Path cwebpPath = Config.buildRoot.resolve(Config.props.getProperty("cwebpPath")).normalize();

        String outputDirProp = _change_output_dir.equals("0") ? "webpOutputDir" : "webpOutputDir2";
        Path webpOutputDir = Config.buildRoot.resolve(Config.props.getProperty(outputDirProp)).normalize();

        Path htmlDir = Config.htmlDir;
        List<String> excludeFiles = Arrays.stream(Config.props.getProperty("exclude", "").split("\\|"))
                .map(String::trim)
                .collect(Collectors.toList());

        // 1. 生成起始no（时间戳形式）
        long no = Long.parseLong(new SimpleDateFormat("yyyyMMddHHmmss").format(new Date()));

        // 2. 清空imgResizedOutputDir目录所有文件
        if (Files.exists(imgResizedOutputDir)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(imgResizedOutputDir)) {
                for (Path file : stream) {
                    try { Files.deleteIfExists(file); } catch (IOException e) { logger.warn("删除文件失败: " + file, e); }
                }
            }
        } else {
            Files.createDirectories(imgResizedOutputDir);
        }

        Path historyDir = imgInputDir.resolve("history");
        if (!Files.exists(historyDir)) Files.createDirectories(historyDir);
        if (!Files.exists(webpOutputDir)) Files.createDirectories(webpOutputDir);

        // 用于收集文件名映射
        Map<String, String> records = new HashMap<>();

        long startTime = System.currentTimeMillis();
        int totalImages = 0;
        int successCount = 0;
        int failCount = 0;
        long totalOriginalSize = 0L;
        long totalWebpSize = 0L;
        int update_img_mapping_html_cnt = 0;

        try (DirectoryStream<Path> stream = Files.newDirectoryStream(imgInputDir)) {
            for (Path path : stream) {
                if (!Files.isRegularFile(path)) continue;
                String fileNameLower = path.getFileName().toString().toLowerCase();
                if (!(fileNameLower.endsWith(".jpg") || fileNameLower.endsWith(".png"))) continue;

                totalImages++;

                BufferedImage img = ImageIO.read(path.toFile());
                if (img == null) continue;

                BufferedImage processedImg = img;

                if (img.getWidth() > maxWidth) {
                    int newHeight = img.getHeight() * maxWidth / img.getWidth();
                    BufferedImage scaled = new BufferedImage(maxWidth, newHeight, BufferedImage.TYPE_INT_RGB);
                    Graphics2D g = scaled.createGraphics();
                    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    g.drawImage(img, 0, 0, maxWidth, newHeight, null);
                    g.dispose();
                    processedImg = scaled;
                }

                // 保存缩放后的图片
                Path resizedFile = imgResizedOutputDir.resolve(path.getFileName());
                ImageIO.write(processedImg, "jpg", resizedFile.toFile());

                try { totalOriginalSize += Files.size(path); } catch (IOException e) { }

                // webp文件名和路径
                String webpFileName = no++ + ".webp";
                records.put(path.getFileName().toString().toLowerCase(), webpFileName);
                Path webpFile = webpOutputDir.resolve(webpFileName);

                ProcessBuilder pb = new ProcessBuilder(
                        cwebpPath.toAbsolutePath().toString(),
                        "-q", String.valueOf(webpQuality),
                        resizedFile.toAbsolutePath().toString(),
                        "-o", webpFile.toAbsolutePath().toString()
                );

                Process process = pb.start();
                int exitCode = process.waitFor();

                if (exitCode != 0) {
                    logger.error("cwebp转换失败，退出码：" + exitCode + "，文件：" + webpFile.getFileName());
                    failCount++;
                    continue;
                }

                try { totalWebpSize += Files.size(webpFile); } catch (IOException e) { }

                // 移动原始文件到history目录
                Path target = historyDir.resolve(path.getFileName());
                try {
                    Files.move(path, target, StandardCopyOption.REPLACE_EXISTING);
                    successCount++;
                } catch (IOException e) {
                    failCount++;
                }
            }
        }

        // 处理结束后清理 resized 目录
        if (Files.exists(imgResizedOutputDir)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(imgResizedOutputDir)) {
                for (Path file : stream) {
                    try { Files.deleteIfExists(file); } catch (IOException e) { }
                }
            }
        }

        long elapsedMs = System.currentTimeMillis() - startTime;

        // 执行 HTML 内的映射替换逻辑
        if (update_img_mapping) {
            try (DirectoryStream<Path> htmlFiles = Files.newDirectoryStream(htmlDir, "*.html")) {
                for (Path htmlFile : htmlFiles) {
                    String htmlFileName = htmlFile.getFileName().toString();
                    if (excludeFiles.contains(htmlFileName)) continue;
                    String content = new String(Files.readAllBytes(htmlFile), StandardCharsets.UTF_8);
                    boolean replaced = false;

                    for (Map.Entry<String, String> entry : records.entrySet()) {
                        String oldName = entry.getKey();
                        String newName = entry.getValue();

                        Pattern pattern = Pattern.compile("(?i)" + Pattern.quote(oldName));
                        Matcher matcher = pattern.matcher(content);
                        if (matcher.find()) {
                            content = matcher.replaceAll(newName);
                            replaced = true;
                        }
                    }
                    if (replaced) {
                        Files.write(htmlFile, content.getBytes(StandardCharsets.UTF_8));
                        update_img_mapping_html_cnt++;
                    }
                }
            }
        }

        // 把处理后的结果写入剪贴板
        StringBuilder stb = new StringBuilder();
        for (String s : records.values()) {
            stb.append(s).append("\n");
        }
        if (stb.length() > 0) {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            Transferable transferableText = new StringSelection(stb.toString());
            clipboard.setContents(transferableText, null);
        }

        // 还原结束后的提示弹窗 (JFrame & JOptionPane)
        JFrame frame = new JFrame();
        frame.setAlwaysOnTop(true);
        frame.setLocationRelativeTo(null);
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.setVisible(true);

        String originalSizeStr = String.format("%.2f MB", totalOriginalSize / 1024.0 / 1024.0);
        String webpSizeStr = String.format("%.2f MB", totalWebpSize / 1024.0 / 1024.0);
        double seconds = elapsedMs / 1000.0;
        String timeStr = String.format("%.2f 秒", seconds);

        String message = String.format(
                "操作完成！\n" +
                        "总图片数：%d\n" +
                        "处理成功：%d\n" +
                        "处理失败：%d\n" +
                        "处理前总大小：%s\n" +
                        "处理后总大小：%s\n" +
                        "更新的html数量：%d\n" +
                        "总耗时：%s s\n" +
                        "生成的WebP文件名已复制到剪贴板！",
                totalImages, successCount, failCount, originalSizeStr, webpSizeStr, update_img_mapping_html_cnt, timeStr
        );

        JOptionPane.showMessageDialog(frame, message);
        frame.dispose();
    }
}