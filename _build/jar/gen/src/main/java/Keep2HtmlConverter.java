import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public class Keep2HtmlConverter {

    private static final Charset UTF8 = StandardCharsets.UTF_8;
    private static final Logger logger = LoggerFactory.getLogger(Keep2HtmlConverter.class);

    public static void run(String[] args) throws Exception {
        String zipFolderStr = Config.props.getProperty("keep_takeout_zip_folder");
        if (zipFolderStr == null) {
            logger.error("配置文件中缺少 keep_takeout_zip_folder");
            return;
        }

        Path keepZipFolder = Paths.get(zipFolderStr);
        Path resizeBufferDir = keepZipFolder.resolve("resized");
        Path templateHtml = Config.buildRoot.resolve(Config.props.getProperty("templateHtml")).normalize();
        Path htmlDir = Config.htmlDir;
        Path cwebpPath = Paths.get(Config.cwebpPath);
        Path webpOutputDir = Config.buildRoot.resolve(Config.props.getProperty("webpOutputDir")).normalize();
        int webpQuality = Integer.parseInt(Config.props.getProperty("webpQuality", "80"));
        int imgMaxWidth = Integer.parseInt(Config.props.getProperty("imgMaxWidth", "800"));

        if (!Files.exists(keepZipFolder)) {
            logger.error("Takeout ZIP 目录不存在: {}", keepZipFolder);
            return;
        }

        Path latestZip = findLatestZip(keepZipFolder);
        Path unzipDir = ensureUnzipped(latestZip);

        List<Path> jsonFiles = listJsonFiles(unzipDir);
        if (jsonFiles.isEmpty()) {
            logger.warn("未能在解压目录中找到任何 .json 文件！请确认压缩包内容。");
            return;
        }

        String template = new String(Files.readAllBytes(templateHtml), UTF8);

        if (args.length == 0) {
            for (Path jf : jsonFiles) {
                processSingleJson(jf, template, htmlDir, cwebpPath, webpOutputDir,
                        webpQuality, imgMaxWidth, resizeBufferDir);
            }
        } else if (args.length >= 2) {
            processMerged(jsonFiles, template, htmlDir, Utils.decodeBase64(args[0]),
                    Utils.decodeBase64(args[1]), cwebpPath, webpOutputDir, webpQuality,
                    imgMaxWidth, resizeBufferDir);
        }
    }

    /** 找到最新 zip 文件 */
    private static Path findLatestZip(Path folder) throws IOException {
        return Files.list(folder)
                .filter(p -> p.toString().toLowerCase().endsWith(".zip"))
                .max(Comparator.comparingLong(p -> p.toFile().lastModified()))
                .orElseThrow(() -> new RuntimeException("目录中没有 ZIP 文件: " + folder));
    }

    /** 【关键修复2】：确保已解压 zip 文件（智能防空目录欺骗） */
    private static Path ensureUnzipped(Path zip) throws IOException {
        Path destDir = zip.getParent().resolve(stripExt(zip.getFileName().toString()));
        boolean needUnzip = true;

        if (Files.exists(destDir)) {
            // 如果目录存在，检查里面是否有文件，防止被上次崩溃残留的空目录欺骗
            try (Stream<Path> stream = Files.list(destDir)) {
                if (stream.findAny().isPresent()) {
                    needUnzip = false; // 里面有文件，说明是真的解压过了
                }
            }
        }

        if (needUnzip) {
            unzip(zip, destDir);
        }
        return destDir;
    }

    /** 【关键修复3】：使用原生 Java 库解压 zip */
    private static void unzip(Path zip, Path destDir) throws IOException {
        Files.createDirectories(destDir);
        try (ZipFile zf = new ZipFile(zip.toFile())) {
            Enumeration<? extends ZipEntry> entries = zf.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                Path outPath = destDir.resolve(entry.getName());
                if (entry.isDirectory()) {
                    Files.createDirectories(outPath);
                } else {
                    Files.createDirectories(outPath.getParent());
                    try (InputStream is = zf.getInputStream(entry)) {
                        Files.copy(is, outPath, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
        }
    }

    /** 列出所有 JSON 文件 */
    private static List<Path> listJsonFiles(Path dir) throws IOException {
        try {
            return Files.walk(dir)
                    .filter(p -> Files.isRegularFile(p) && p.toString().toLowerCase().endsWith(".json"))
                    .sorted()
                    .collect(Collectors.toList());
        } catch (IOException e) {
            logger.error("遍历 JSON 文件失败: {}", e.getMessage(), e);
            throw e;
        }
    }

    /** 处理单个 JSON → HTML */
    private static void processSingleJson(Path jf, String template, Path htmlDir,
                                          Path cwebpPath, Path webpOutputDir,
                                          int webpQuality, int imgMaxWidth, Path resizeBufferDir)
            throws IOException, InterruptedException {

        JsonNode root = readJson(jf);

        if (!root.path("isArchived").asBoolean() || root.path("isTrashed").asBoolean()) return;

        String category = null;
        boolean hasSingle = false;
        for (JsonNode label : root.path("labels")) {
            String labelName = label.path("name").asText();
            if ("single".equals(labelName)) {
                hasSingle = true;
            } else {
                category = labelName;
            }
        }
        if (!hasSingle || category == null) return;

        // 【修改点】：判断是否为“日记”分类，并动态设定实际的输出目录
        boolean isDiary = "日记".equals(category);
        Path targetWebpOutputDir = isDiary ? webpOutputDir.resolveSibling("diary") : webpOutputDir;

        String articleTitle = root.path("title").asText();
        String ts = format14(root.path("createdTimestampUsec").asLong() / 1000);
        String textContent = root.path("textContent").asText();

        JsonNode attachments = root.path("attachments");

        List<JsonNode> sortedAttachments = new ArrayList<>();
        if (attachments.isArray()) {
            attachments.forEach(sortedAttachments::add);
        }
        sortedAttachments.sort(Comparator.comparingLong(a -> parsePrefix(a.path("filePath").asText())));
        for (int i = 0; i < sortedAttachments.size(); i++) {
            JsonNode att = sortedAttachments.get(i);
            String filePath = att.path("filePath").asText();
            Path imgPath = jf.getParent().resolve(filePath);

            // 【修改点】：使用 targetWebpOutputDir 而不是原始的 webpOutputDir
            String newFileName = compressAndReturnNewName(
                    imgPath, cwebpPath, resizeBufferDir, webpQuality, imgMaxWidth, targetWebpOutputDir
            );

            // 【修改点】：针对日记应用指定的路径格式
            String replacement = isDiary ? ("../gallery/diary/" + newFileName) : newFileName;
            textContent = textContent.replace("[[IMG" + (i + 1) + "]]", replacement);
        }

        String html = template
                .replace("<title></title>", "<title>" + articleTitle + "</title>")
                .replace("<span id=\"anchor\"></span>", "<span id=\"anchor\">" + ts + "-" + category + "</span>")
                .replaceAll("(?s)<pre>.*?</pre>", "<pre>\n" + textContent + "\n</pre>");

        Files.write(htmlDir.resolve(articleTitle + ".html"), html.getBytes(UTF8));
        clearDir(resizeBufferDir);
    }

    /** 处理合并模式 */
    private static void processMerged(List<Path> jsonFiles, String template, Path htmlDir,
                                      String tagName, String category,
                                      Path cwebpPath, Path webpOutputDir,
                                      int webpQuality, int imgMaxWidth, Path resizeBufferDir)
            throws IOException, InterruptedException {

        List<JsonNode> notes = new ArrayList<>();
        for (Path jf : jsonFiles) {
            JsonNode root = readJson(jf);
            if (!root.path("isArchived").asBoolean() || root.path("isTrashed").asBoolean()) continue;
            for (JsonNode label : root.path("labels")) {
                if (tagName.equals(label.path("name").asText())) {
                    notes.add(root);
                    break;
                }
            }
        }

        notes.sort(Comparator.comparingLong(n -> n.path("createdTimestampUsec").asLong()));

        StringBuilder stb = new StringBuilder();
        for (JsonNode note : notes) {
            String t = note.path("title").asText();
            String c = note.path("textContent").asText();

            JsonNode attachments = note.path("attachments");
            if (attachments.isArray() && attachments.size() > 0) {
                List<JsonNode> sortedAttachments = new ArrayList<>();
                attachments.forEach(sortedAttachments::add);
                sortedAttachments.sort(Comparator.comparingLong(a -> parsePrefix(a.path("filePath").asText())));

                for (int i = 0; i < sortedAttachments.size(); i++) {
                    JsonNode att = sortedAttachments.get(i);
                    String filePath = att.path("filePath").asText();
                    Path imgPath = jsonFiles.get(0).getParent().resolve(filePath);

                    String newFileName = compressAndReturnNewName(
                            imgPath, cwebpPath, resizeBufferDir, webpQuality, imgMaxWidth, webpOutputDir
                    );
                    c = c.replace("[[IMG" + (i + 1) + "]]", newFileName);
                }
            }
            stb.append("# ").append(t).append("\n").append(c).append("\n\n");
            clearDir(resizeBufferDir);
        }

        String ts = format14(System.currentTimeMillis());
        String html = template
                .replace("<title></title>", "<title>" + tagName + "</title>")
                .replace("<span id=\"anchor\"></span>", "<span id=\"anchor\">" + ts + "-" + category + "</span>")
                .replaceAll("(?s)<pre>.*?</pre>", "<pre>\n" + stb + "\n</pre>");

        Files.write(htmlDir.resolve(tagName + ".html"), html.getBytes(UTF8));
    }

    private static JsonNode readJson(Path jsonPath) throws IOException {
        try (BufferedReader reader = Files.newBufferedReader(jsonPath, UTF8)) {
            return Utils.JSON_MAPPER.readTree(reader);
        }
    }

    private static String compressAndReturnNewName(Path imgPath, Path cwebpPath,
                                                   Path resizeBufferDir, int quality,
                                                   int maxWidth, Path outWebpPath)
            throws IOException, InterruptedException {

        if (!Files.exists(imgPath)) {
            logger.warn("图片文件不存在，跳过压缩: {}", imgPath);
            return imgPath.getFileName().toString();
        }

        String fileName = imgPath.getFileName().toString().toLowerCase();
        String webpFileName = new SimpleDateFormat("yyyyMMddHHmmssSSS").format(new Date()) + ".webp";
        Path webpFile = outWebpPath.resolve(webpFileName);

        Path gif2webpPath = cwebpPath.getParent().resolve("gif2webp");

        if (fileName.endsWith(".gif")) {
            List<String> cmd = new ArrayList<>();
            cmd.add(gif2webpPath.toAbsolutePath().toString());
            cmd.add("-q");
            cmd.add(String.valueOf(quality));

            try {
                BufferedImage img = ImageIO.read(imgPath.toFile());
                if (img != null && img.getWidth() > maxWidth) {
                    cmd.add("-resize");
                    cmd.add(String.valueOf(maxWidth));
                    cmd.add("0");
                }
            } catch (Exception e) {
                logger.warn("无法读取 GIF 尺寸，将不做缩放: {}", imgPath, e);
            }

            cmd.add(imgPath.toAbsolutePath().toString());
            cmd.add("-o");
            cmd.add(webpFile.toAbsolutePath().toString());

            ProcessBuilder pb = new ProcessBuilder(cmd);
            int exitCode = pb.start().waitFor();
            if (exitCode != 0) {
                logger.error("gif2webp 转换失败，退出码：{}，文件：{}", exitCode, webpFile.getFileName());
            }
            return webpFileName;
        }

        BufferedImage img = ImageIO.read(imgPath.toFile());
        if (img == null) throw new IOException("无法读取图片: " + imgPath);

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

        Files.createDirectories(resizeBufferDir);
        Files.createDirectories(outWebpPath);
        Path resizedFile = resizeBufferDir.resolve(imgPath.getFileName());
        ImageIO.write(processedImg, "jpg", resizedFile.toFile());

        ProcessBuilder pb = new ProcessBuilder(
                cwebpPath.toAbsolutePath().toString(),
                "-q", String.valueOf(quality),
                resizedFile.toAbsolutePath().toString(),
                "-o", webpFile.toAbsolutePath().toString()
        );

        int exitCode = pb.start().waitFor();
        if (exitCode != 0) {
            logger.error("cwebp 转换失败，退出码：{}，文件：{}", exitCode, webpFile.getFileName());
        }
        return webpFileName;
    }

    private static String format14(long millis) {
        return new SimpleDateFormat("yyyyMMddHHmmss").format(new Date(millis));
    }

    private static void clearDir(Path dir) throws IOException {
        if (Files.exists(dir)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                for (Path file : stream) {
                    Files.deleteIfExists(file);
                }
            }
        }
    }

    private static String stripExt(String name) {
        int i = name.lastIndexOf('.');
        return (i > 0) ? name.substring(0, i) : name;
    }

    private static long parsePrefix(String filePath) {
        try {
            String prefix = filePath.split("\\.")[0];
            return Long.parseLong(prefix, 16);
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }
}
