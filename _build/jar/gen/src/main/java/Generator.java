import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.CRC32;

public class Generator {
    private static final Logger logger = LoggerFactory.getLogger(Generator.class);
    private static final Pattern anchorPattern = Pattern.compile("<span id=\"anchor\">(\\d+)-(.+)</span>");
    private static final Map<String, Object> liteDataTree = new HashMap<>();
    private static final List<Pattern> gitIgnorePatterns = new ArrayList<>();
    private static final Set<String> localOnlySet = new HashSet<>();
    private static final Pattern SEO_PREFIX_PATTERN = Pattern.compile("^\\d{14}-[^\\s]+\\s*");

    public static void run() throws Exception {
        gitIgnorePatterns.clear(); localOnlySet.clear();
        initLiteDataTree();
        injectScriptToIndexHtml();
        parseGitIgnore();

        Utils.JSON_MAPPER.configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
        ObjectNode rootNode = (Config.cmtMapper.exists() && Config.cmtMapper.length() > 0) ? (ObjectNode) Utils.JSON_MAPPER.readTree(Config.cmtMapper) : Utils.JSON_MAPPER.createObjectNode();
        ArrayNode records = rootNode.has("records") ? (ArrayNode) rootNode.get("records") : rootNode.putArray("records");
        ArrayNode orphanIds = rootNode.has("orphanIds") ? (ArrayNode) rootNode.get("orphanIds") : rootNode.putArray("orphanIds");

        Set<String> currentTitles = new HashSet<>();
        final int[] maxId = {0};
        for (JsonNode r : records) if (r.get("id").asInt() > maxId[0]) maxId[0] = r.get("id").asInt();

        ObjectNode coreBundle = Utils.JSON_MAPPER.createObjectNode();
        Map<Integer, String> fatDataMap = new TreeMap<>();
        Map<Integer, String> shadowDataMap = new TreeMap<>();
        List<SeoArticle> seoList = new ArrayList<>();

        processHtmlFilesAndImages(coreBundle, records, currentTitles, maxId, fatDataMap, shadowDataMap, seoList);

        orphanIds.removeAll();
        for (JsonNode r : records) if (!currentTitles.contains(r.get("title").asText())) orphanIds.add(r.get("id").asInt());
        try (FileWriter writer = new FileWriter(Config.cmtMapper)) { Utils.JSON_MAPPER.writeValue(writer, rootNode); }

        scanAllMedias();

        List<String> generatedDataFiles = generateLiteAndFatData(fatDataMap, String.valueOf(Config.dataDir), Config.sliceSize);
        if (!shadowDataMap.isEmpty()) { generateShadowData(shadowDataMap, String.valueOf(Config.dataDir), Config.sliceSize); }

        String newBuildVersion = generateManifest(Config.htmlDir, Config.dataDir, projectRootPath(), coreBundle, generatedDataFiles);
        if (newBuildVersion != null) {
            updateSwVersion(newBuildVersion);
        }

        if (seoList != null && !seoList.isEmpty()) {
            injectSeoToIndexHtml(seoList);
            generateSitemap(seoList);
            generateRobotsTxt();
        }
    }

    private static void initLiteDataTree() {
        liteDataTree.clear();
        liteDataTree.put("html", new HashMap<String, Object>());
        liteDataTree.put("image", new HashMap<String, Object>());
        liteDataTree.put("ebook", new HashMap<String, Object>());
        liteDataTree.put("video", new HashMap<String, Object>());
        liteDataTree.put("audio", new HashMap<String, Object>());
    }

    private static void injectScriptToIndexHtml() throws IOException {
        String scriptBlock = "<script>\n  const github_page = \"" + Config.props.getProperty("github_page") + "\";\n" +
                "  const data_repo = \"" + Config.props.getProperty("data-repo") + "\";\n" +
                "  const data_repo_id = \"" + Config.props.getProperty("data-repo-id") + "\";\n" +
                "  const data_category_id = \"" + Config.props.getProperty("data-category-id") + "\";\n" +
                "  const update_interval = " + Config.props.getProperty("update_interval") + ";\n" +
                "  const update_interval_local = " + Config.props.getProperty("update_interval_local") + ";\n</script>";

        String html = new String(Files.readAllBytes(Config.indexHtml), StandardCharsets.UTF_8);
        String beginTag = "<" + "!-- PARAM-BEGIN --" + ">";
        String endTag   = "<" + "!-- PARAM-END --" + ">";

        int begin = html.indexOf(beginTag);
        int end   = html.indexOf(endTag);

        if (begin != -1 && end != -1 && end > begin) {
            String before = html.substring(0, begin + beginTag.length());
            String after = html.substring(end);
            Files.write(Config.indexHtml, (before + "\n" + scriptBlock + "\n" + after).getBytes(StandardCharsets.UTF_8));
        } else {
            logger.warn("未在 index.html 中找到起止标记，跳过注入。");
        }
    }

    private static void parseGitIgnore() {
        Path gitIgnorePath = Paths.get(Config.PATH_GITIGNORE);
        if (!Files.exists(gitIgnorePath)) return;
        try {
            List<String> lines = Files.readAllLines(gitIgnorePath, StandardCharsets.UTF_8);
            for (String line : lines) {
                line = line.trim();
                if (!line.isEmpty() && !line.startsWith("#")) {
                    if (line.startsWith("/")) line = line.substring(1); 
                    String raw = line;
                    if (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);
                    localOnlySet.add(raw);
                    localOnlySet.add(raw.replace('/', '\\'));
                    String regex = line.replace(".", "\\.").replace("*", ".*").replace("?", ".");
                    if (line.endsWith("/")) regex = "^.*" + regex + ".*$";
                    else if (!regex.contains(".*")) regex = "^.*" + regex + ".*$";
                    else regex = "^.*" + regex + "$";
                    gitIgnorePatterns.add(Pattern.compile(regex, Pattern.CASE_INSENSITIVE));
                }
            }
        } catch (IOException e) { logger.warn("无法读取 .gitignore", e); }
    }

    private static void processHtmlFilesAndImages(ObjectNode coreBundle, ArrayNode records, Set<String> currentTitles, int[] maxId, Map<Integer, String> fatDataMap, Map<Integer, String> shadowDataMap, List<SeoArticle> seoList) {
        Set<String> imageSet = buildGalleryImageSet();
        Set<String> usedImagesSet = new HashSet<>();
        Pattern fullImgPattern = Pattern.compile("^\\s*(\\.\\./gallery/[^\\s\"'<>]+\\.(?:jpg|jpeg|png|gif|webp))\\s*$", Pattern.CASE_INSENSITIVE);
        Pattern flatImgPattern = Pattern.compile("^\\s*([^\\s\"'<>/\\\\]+\\.(?:jpg|jpeg|png|gif|webp))\\s*$", Pattern.CASE_INSENSITIVE);

        try (Stream<Path> htmlFiles = Files.list(Config.htmlDir)) {
            htmlFiles.filter(p -> p.toString().endsWith(".html")).sorted().forEach(path -> {
                String fileName = path.getFileName().toString().replace(".html", "");
                String relativeHtmlPath = "html/" + path.getFileName().toString();
                boolean isGitIgnored = gitIgnorePatterns.stream().anyMatch(p -> p.matcher(relativeHtmlPath).matches());
                boolean isExcludedData = isExcluded(fileName);

                try {
                    List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
                    List<String> newLines = new ArrayList<>(lines.size());
                    StringBuilder htmlContentBuilder = new StringBuilder();
                    boolean fileModified = false;

                    for (String line : lines) {
                        boolean keepLine = true;
                        Matcher mFull = fullImgPattern.matcher(line);
                        Matcher mFlat = flatImgPattern.matcher(line);

                        if (mFull.matches()) {
                            String imgRef = mFull.group(1);
                            if (!imageSet.contains(imgRef)) keepLine = false;
                            else usedImagesSet.add(imgRef);
                        } else if (mFlat.matches()) {
                            String virtualFullPath = "../gallery/img/" + mFlat.group(1);
                            if (!imageSet.contains(virtualFullPath)) keepLine = false;
                            else usedImagesSet.add(virtualFullPath);
                        }

                        if (keepLine) {
                            newLines.add(line);
                            htmlContentBuilder.append(line).append("\n"); 
                        } else {
                            fileModified = true;
                        }
                    }

                    if (fileModified) Files.write(path, newLines, StandardCharsets.UTF_8);
                    String htmlContent = htmlContentBuilder.toString();

                    if (!isGitIgnored && !isExcludedData) coreBundle.put("/" + Config.PREFIX_HTML + path.getFileName().toString(), htmlContent);

                    Document doc = Jsoup.parse(htmlContent);
                    String timeStamp = doc.getElementById("anchor") != null ? Objects.requireNonNull(doc.getElementById("anchor")).text() : "";
                    String title = doc.title().trim();
                    if (title.isEmpty()) title = fileName;

                    int currentRecordId = -1;
                    if (!title.isEmpty()) {
                        currentTitles.add(title);
                        boolean exists = false;
                        for (JsonNode r : records) {
                            if (r.get("title").asText().equals(title)) {
                                currentRecordId = r.get("id").asInt(); exists = true; break;
                            }
                        }
                        if (!exists) {
                            currentRecordId = ++maxId[0];
                            ObjectNode newRecord = Utils.JSON_MAPPER.createObjectNode();
                            newRecord.put("id", currentRecordId); newRecord.put("title", title);
                            records.add(newRecord);
                        }

                        String cleanText = doc.body().text().replaceAll("\r\n|\r|\n", " ").replaceAll(" +", " ").replaceAll("\\$\\{", "&#36;{").replaceAll("`", "&#715;");

                        if (!isGitIgnored && !isExcludedData) {
                            fatDataMap.put(currentRecordId, cleanText);
                            // 提取 SEO 摘要, 截取前 200 个字符作为摘要
                            String summaryText = SEO_PREFIX_PATTERN.matcher(cleanText)
                                    .replaceFirst("")
                                    .trim();
                            String summary = summaryText.length() > 200
                                    ? summaryText.substring(0, 200) + "..."
                                    : summaryText;
                            seoList.add(new SeoArticle(title, timeStamp, summary));
                        } else if (isGitIgnored) {
                            fatDataMap.put(currentRecordId, "localOnly");
                            shadowDataMap.put(currentRecordId, cleanText);
                        } else {
                            fatDataMap.put(currentRecordId, "");
                        }
                    }

                    String virtualPath = Config.PATH_UNCATEGORIZED + fileName + ".html";
                    Matcher matcher = anchorPattern.matcher(htmlContent);
                    if (matcher.find()) virtualPath = Config.PREFIX_HTML + matcher.group(2).replace("|", "/") + "/" + fileName + ".html";

                    String finalInfo = timeStamp;
                    if (isGitIgnored) finalInfo = finalInfo.isEmpty() ? "localOnly" : finalInfo + "-localOnly";

                    addPathToTree("html", virtualPath, new Object[]{currentRecordId, "html", finalInfo});

                } catch (IOException e) { throw new RuntimeException(e); }
            });

            generateIdleImageList(imageSet, usedImagesSet);
        } catch (Exception e) { logger.error("⚠️ HTML 主控流发生异常", e); }
    }

    private static Set<String> buildGalleryImageSet() {
        Set<String> imageSet = new HashSet<>();
        if (!Files.exists(Config.galleryDir)) return imageSet;
        try (Stream<Path> walk = Files.walk(Config.galleryDir)) {
            walk.filter(Files::isRegularFile).forEach(p -> {
                String name = p.getFileName().toString().toLowerCase();
                if (name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") || name.endsWith(".gif") || name.endsWith(".webp")) {
                    String absolutePathStr = p.toAbsolutePath().normalize().toString().replace("\\", "/");
                    int galleryIdx = absolutePathStr.lastIndexOf("/gallery/");
                    if (galleryIdx != -1) imageSet.add("../gallery/" + absolutePathStr.substring(galleryIdx + 9));
                }
            });
        } catch (IOException e) { logger.error("⚠️ 读取相册目录失败", e); }
        return imageSet;
    }

    private static void generateIdleImageList(Set<String> imageSet, Set<String> usedImagesSet) {
        try {
            List<String> idleList = new ArrayList<>();
            for (String webPath : imageSet) {
                if (!usedImagesSet.contains(webPath) && webPath.startsWith("../gallery/img/")) {
                    idleList.add(webPath.replace("../gallery/img/", ""));
                }
            }
            Path imgDir = Config.galleryDir.resolve("img");
            if (!Files.exists(imgDir)) Files.createDirectories(imgDir);
            Path idleListPath = imgDir.resolve("idle-list.txt");

            if (!idleList.isEmpty()) {
                Collections.sort(idleList);
                Files.write(idleListPath, idleList, StandardCharsets.UTF_8);
            } else if (Files.exists(idleListPath)) Files.delete(idleListPath);
        } catch (IOException e) { logger.error("⚠️ 生成闲置列表失败", e); }
    }

    private static void scanAllMedias() {
        List<MediaNode> galleryList = new ArrayList<>();
        MediaScanner.scanMedia(Config.galleryDir, "gallery/", new HashSet<>(Arrays.asList("jpg", "jpeg", "png", "webp", "gif")), "image", localOnlySet, Config.galleryDirExcludeDirs, galleryList);

        List<MediaNode> audioList = new ArrayList<>();
        MediaScanner.scanMedia(Config.audioDir, "audio/", new HashSet<>(Arrays.asList("mp3", "wav", "flac", "m4a")), "audio", localOnlySet, Config.audioDirExcludeDirs, audioList);

        List<MediaNode> videoList = new ArrayList<>();
        MediaScanner.scanMedia(Config.videoDir, "video/", new HashSet<>(Arrays.asList("mp4", "avi", "mov", "wmv", "mkv", "flv", "webm", "ogg", "ogv", "3gp")), "video", localOnlySet, Config.videoDirExcludeDirs, videoList);

        List<MediaNode> ebookList = new ArrayList<>();
        MediaScanner.scanMedia(Config.ebookDir, "ebook/", new HashSet<>(Arrays.asList("epub", "pdf", "mobi", "txt")), "ebook", localOnlySet, Config.ebookDirExcludeDirs, ebookList);

        appendMediaToTree("image", galleryList);
        appendMediaToTree("audio", audioList);
        appendMediaToTree("video", videoList);
        appendMediaToTree("ebook", ebookList);
    }

    private static void appendMediaToTree(String bucket, List<MediaNode> mediaList) {
        for (MediaNode node : mediaList) {
            boolean isLocal = "localOnly".equals(node.local) || "1".equals(node.local) || "true".equalsIgnoreCase(node.local);
            String finalInfo = isLocal ? "localOnly" : "";
            addPathToTree(bucket, node.link, new Object[]{-1, node.type, finalInfo});
        }
    }

    private static void addPathToTree(String bucket, String path, Object[] fileData) {
        String cleanPath = path;
        if (bucket.equals("html") && cleanPath.startsWith(Config.PREFIX_HTML)) cleanPath = cleanPath.substring(5);
        else if (bucket.equals("image") && cleanPath.startsWith(Config.PREFIX_GALLERY)) cleanPath = cleanPath.substring(8);
        else if (bucket.equals("video") && cleanPath.startsWith(Config.PREFIX_VIDEO)) cleanPath = cleanPath.substring(6);
        else if (bucket.equals("audio") && cleanPath.startsWith(Config.PREFIX_AUDIO)) cleanPath = cleanPath.substring(6);
        else if (bucket.equals("ebook") && cleanPath.startsWith(Config.PREFIX_EBOOK)) cleanPath = cleanPath.substring(6);

        String[] parts = cleanPath.split("/");
        if (parts.length == 1) parts = new String[]{"_uncategorized", parts[0]};

        @SuppressWarnings("unchecked")
        Map<String, Object> currentNode = (Map<String, Object>) liteDataTree.get(bucket);

        for (int i = 0; i < parts.length - 1; i++) {
            @SuppressWarnings("unchecked")
            Map<String, Object> nextNode = (Map<String, Object>) currentNode.computeIfAbsent(parts[i], k -> new HashMap<String, Object>());
            currentNode = nextNode;
        }

        @SuppressWarnings("unchecked")
        List<Object[]> files = (List<Object[]>) currentNode.computeIfAbsent("_f", k -> new ArrayList<Object[]>());
        files.add(new Object[]{parts[parts.length - 1], fileData[0], fileData[1], fileData[2]});
    }

    private static boolean isExcluded(String fileName) {
        for (Pattern pattern : Config.excludePatterns) if (pattern.matcher(fileName).matches()) return true;
        return false;
    }

    private static List<String> generateLiteAndFatData(Map<Integer, String> fatDataMap, String outputDir, int sliceSize) throws IOException {
        File dir = new File(outputDir);
        if (dir.exists()) deleteDirectoryContents(dir); else dir.mkdirs();
        List<String> fileNames = new ArrayList<>();

        File liteFile = new File(dir, Config.FILE_LITE_DATA);
        try (Writer writer = new OutputStreamWriter(Files.newOutputStream(liteFile.toPath()), StandardCharsets.UTF_8)) {
            String jsonContent = Utils.JSON_MAPPER.writeValueAsString(liteDataTree);
            writer.write("window.LITE_DATA = " + jsonContent + ";");
        }
        fileNames.add(liteFile.getName());

        int fileIndex = 1; int currentSize = 0;
        String arrayName = Config.FILE_FAT_DATA_PREFIX + fileIndex;

        File currentFile = new File(dir, arrayName + ".json");
        Writer writer = new OutputStreamWriter(Files.newOutputStream(currentFile.toPath()), StandardCharsets.UTF_8);
        writer.write("{");
        boolean firstElement = true;

        for (Map.Entry<Integer, String> entry : fatDataMap.entrySet()) {
            String elementJson = "\"" + entry.getKey() + "\":" + Utils.JSON_MAPPER.writeValueAsString(entry.getValue());
            int elementEstimatedSize = elementJson.length() * 3;

            if (currentSize + elementEstimatedSize > sliceSize && !firstElement) {
                writer.write("}"); writer.close(); fileNames.add(currentFile.getName());
                fileIndex++; arrayName = Config.FILE_FAT_DATA_PREFIX + fileIndex;
                currentFile = new File(dir, arrayName + ".json");
                writer = new OutputStreamWriter(new FileOutputStream(currentFile), StandardCharsets.UTF_8);
                writer.write("{");
                currentSize = 0; firstElement = true;
            }
            writer.write((firstElement ? "" : ",") + elementJson);
            currentSize += elementEstimatedSize; firstElement = false;
        }

        writer.write("}"); writer.close(); fileNames.add(currentFile.getName());

        return fileNames;
    }

    private static void generateShadowData(Map<Integer, String> shadowDataMap, String outputDir, int sliceSize) throws IOException {
        File dir = new File(outputDir);
        if (!dir.exists()) dir.mkdirs();

        List<String> fileNames = new ArrayList<>();
        int fileIndex = 1; int currentSize = 0;
        String arrayName = "shadow_data_" + fileIndex;

        File currentFile = new File(dir, arrayName + ".json");
        Writer writer = new OutputStreamWriter(Files.newOutputStream(currentFile.toPath()), StandardCharsets.UTF_8);
        writer.write("{");
        boolean firstElement = true;

        for (Map.Entry<Integer, String> entry : shadowDataMap.entrySet()) {
            String elementJson = "\"" + entry.getKey() + "\":" + Utils.JSON_MAPPER.writeValueAsString(entry.getValue());
            int elementEstimatedSize = elementJson.length() * 3;

            if (currentSize + elementEstimatedSize > sliceSize && !firstElement) {
                writer.write("}"); writer.close(); fileNames.add(currentFile.getName());
                fileIndex++; arrayName = "shadow_data_" + fileIndex;
                currentFile = new File(dir, arrayName + ".json");
                writer = new OutputStreamWriter(new FileOutputStream(currentFile), StandardCharsets.UTF_8);
                writer.write("{");
                currentSize = 0; firstElement = true;
            }
            writer.write((firstElement ? "" : ",") + elementJson);
            currentSize += elementEstimatedSize; firstElement = false;
        }

        writer.write("}"); writer.close(); fileNames.add(currentFile.getName());

        File indexFile = new File(dir, "shadowIndex.js");
        try (Writer indexWriter = new OutputStreamWriter(new FileOutputStream(indexFile), StandardCharsets.UTF_8)) {
            indexWriter.write("window.shadowIndex = " + Utils.JSON_MAPPER.writeValueAsString(fileNames) + ";");
        }
    }

    private static String generateManifest(Path htmlDir, Path dataDir, Path projectRoot, ObjectNode coreBundle, List<String> generatedDataFiles) {
        try {
            Path fileListPath = Config.jsInputDir.resolve(Config.FILE_CORE_LIST);
            Files.createDirectories(fileListPath.getParent());
            Map<String, FileMeta> swManifest = new LinkedHashMap<>();

            try (Stream<Path> htmlWalk = Files.list(htmlDir)) {
                htmlWalk.filter(p -> p.toString().endsWith(".html")).sorted().forEach(p -> {
                    String fileName = p.getFileName().toString().replace(".html", "");
                    boolean isGitIgnored = false;
                    String relativeHtmlPath = "html/" + p.getFileName().toString();

                    for (Pattern pattern : gitIgnorePatterns) {
                        if (pattern.matcher(relativeHtmlPath).matches()) { isGitIgnored = true; break; }
                    }

                    if (!isGitIgnored) {
                        if (isExcluded(fileName)) swManifest.put("/" + Config.PREFIX_HTML + p.getFileName(), new FileMeta(calculateFingerprint(p), "no_cache"));
                        else swManifest.put("/" + Config.PREFIX_HTML + p.getFileName(), new FileMeta(calculateFingerprint(p), Config.FILE_CORE_BUNDLE));
                    }
                });
            }

            for (String df : generatedDataFiles) {
                Path p = dataDir.resolve(df);
                swManifest.put(Config.WEB_ROUTE_DATA + p.getFileName(), new FileMeta(calculateFingerprint(p), "standalone"));
            }

            String coreFilesProp = Config.props.getProperty("coreFiles", "");
            if (!coreFilesProp.isEmpty()) {
                for (String path : coreFilesProp.split("\\|")) {
                    String webPath = path.trim();
                    if (webPath.isEmpty()) continue;
                    Path physicalFile = findPhysicalFile(projectRoot, webPath);
                    String hash = calculateFingerprint(physicalFile);
                    if (webPath.equals("/") || webPath.endsWith(".html") || webPath.endsWith(".css") || webPath.endsWith(".json")) {
                        try {
                            coreBundle.put(webPath, new String(Files.readAllBytes(physicalFile), StandardCharsets.UTF_8));
                            swManifest.put(webPath, new FileMeta(hash, Config.FILE_CORE_BUNDLE));
                        } catch (IOException e) { swManifest.put(webPath, new FileMeta(hash, "standalone")); }
                    } else swManifest.put(webPath, new FileMeta(hash, "standalone"));
                }
            }

            try (FileWriter writer = new FileWriter(Config.PATH_CORE_BUNDLE_OUT)) { Utils.JSON_MAPPER.writeValue(writer, coreBundle); }

            boolean hasChanged = false; String oldVersion = null; Map<String, String> oldHashes = new HashMap<>();
            if (Files.exists(fileListPath)) {
                String oldContent = new String(Files.readAllBytes(fileListPath), StandardCharsets.UTF_8);
                Matcher vMatcher = Pattern.compile("const BUILD_VERSION = '(\\d+)';").matcher(oldContent);
                if (vMatcher.find()) oldVersion = vMatcher.group(1);
                Matcher compressedMatcher = Pattern.compile("`([^`]+)`").matcher(oldContent);
                if (compressedMatcher.find()) {
                    String[] groups = compressedMatcher.group(1).split(";");
                    for (String group : groups) {
                        if (group.isEmpty()) continue;
                        int pipeIndex = group.indexOf('|');
                        if (pipeIndex == -1) continue;
                        String dir = group.substring(0, pipeIndex);
                        String filesStr = group.substring(pipeIndex + 1);
                        for (String f : filesStr.split("\\*")) {
                            String[] parts = f.split(":");
                            if (parts.length >= 2) oldHashes.put(dir + parts[0], parts[1]);
                        }
                    }
                }
            }

            if (oldVersion == null || oldHashes.size() != swManifest.size()) hasChanged = true;
            else {
                for (Map.Entry<String, FileMeta> entry : swManifest.entrySet()) {
                    if (!entry.getValue().hash.equals(oldHashes.get(entry.getKey()))) { hasChanged = true; break; }
                }
            }

            if (!hasChanged) return null;

            String buildVersion = String.valueOf(System.currentTimeMillis());
            StringBuilder sb = new StringBuilder();
            sb.append("const BUILD_VERSION = '").append(buildVersion).append("';\nconst FILE_MANIFEST = {};\n");

            Map<String, List<String>> grouped = new HashMap<>();
            for (Map.Entry<String, FileMeta> entry : swManifest.entrySet()) {
                String fullPath = entry.getKey();
                int lastSlash = fullPath.lastIndexOf('/');
                String dir = fullPath.substring(0, lastSlash + 1);
                String name = fullPath.substring(lastSlash + 1);

                String srcFlag = "0"; 
                if (entry.getValue().source.equals(Config.FILE_CORE_BUNDLE)) srcFlag = "1";
                else if (entry.getValue().source.equals("no_cache")) srcFlag = "2";
                grouped.computeIfAbsent(dir, k -> new ArrayList<>()).add(name + ":" + entry.getValue().hash + ":" + srcFlag);
            }

            List<String> dirStrings = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : grouped.entrySet()) dirStrings.add(entry.getKey() + "|" + String.join("*", entry.getValue()));

            sb.append("`").append(String.join(";", dirStrings)).append("`");
            sb.append(".split(';').forEach(g => { if(!g)return; let [d, f] = g.split('|'); f.split('*').forEach(i => { let [n, h, s] = i.split(':'); let src = 'standalone'; if(s === '1') src = '").append(Config.FILE_CORE_BUNDLE).append("'; else if(s === '2') src = 'no_cache'; FILE_MANIFEST[d+n] = { hash: h, source: src }; }); });\n");
            sb.append("const allFilesToCache = Object.keys(FILE_MANIFEST).filter(p => !p.includes('").append(Config.WEB_ROUTE_FAT_DATA_PREFIX).append("') && FILE_MANIFEST[p].source !== 'no_cache');\n");
            sb.append("\nif (typeof window !== 'undefined') { window.dataIndex = ").append(Utils.JSON_MAPPER.writeValueAsString(generatedDataFiles)).append("; }\n");

            Files.write(fileListPath, sb.toString().getBytes(StandardCharsets.UTF_8));
            return buildVersion;

        } catch (IOException e) { logger.error("生成清单失败", e); return null; }
    }

    private static Path projectRootPath() { return Paths.get("..").toAbsolutePath().normalize(); }

    private static Path findPhysicalFile(Path projectRoot, String webPath) {
        String rootStr = projectRoot.toAbsolutePath().normalize().toString();
        if (rootStr.endsWith("\\src") || rootStr.endsWith("/src")) rootStr = rootStr.substring(0, rootStr.length() - 4);
        Path realRoot = Paths.get(rootStr);
        String localPath = webPath.equals("/") ? "index.html" : (webPath.startsWith("/") ? webPath.substring(1) : webPath);
        Path p = realRoot.resolve(localPath).normalize();
        if (!Files.exists(p)) {
            Path tryInsideSrc = realRoot.resolve("src").resolve(localPath).normalize();
            if (Files.exists(tryInsideSrc)) return tryInsideSrc;
            if (p.toString().contains("src\\src") || p.toString().contains("src/src")) p = Paths.get(p.toString().replace("src\\src", "src").replace("src/src", "src"));
        }
        return p;
    }

    private static String calculateFingerprint(Path path) {
        if (!path.toFile().exists()) return "0_0";
        try {
            CRC32 crc = new CRC32(); crc.update(Files.readAllBytes(path));
            return Long.toHexString(crc.getValue());
        } catch (Exception e) { return "0_0"; }
    }

    private static void deleteDirectoryContents(File dir) throws IOException {
        File[] files = dir.listFiles();
        if (files != null) {
            for (File file : files) {
                if (file.isDirectory()) deleteDirectoryContents(file);
                if (!file.delete()) throw new IOException("无法删除: " + file.getAbsolutePath());
            }
        }
    }

    private static void updateSwVersion(String buildVersion) {
        try {
            Path swPath = Config.jsInputDir.resolve(Config.FILE_SW_JS);
            if (Files.exists(swPath)) {
                List<String> lines = Files.readAllLines(swPath, StandardCharsets.UTF_8);
                boolean foundVersion = false;
                for (int i = 0; i < lines.size(); i++) {
                    String line = lines.get(i).trim();
                    if (line.startsWith("self.SW_VERSION")) { lines.set(i, "self.SW_VERSION = '" + buildVersion + "';"); foundVersion = true; }
                    else if (line.startsWith("importScripts") && (line.contains(Config.FILE_CORE_LIST) || line.contains("Config.WEB_ROUTE_CORE_LIST"))) {
                        lines.set(i, "importScripts('" + Config.WEB_ROUTE_CORE_LIST + "?v=" + buildVersion + "');");
                    }
                }
                if (!foundVersion) lines.add(0, "self.SW_VERSION = '" + buildVersion + "';");
                Files.write(swPath, lines, StandardCharsets.UTF_8);
            }
        } catch (IOException ignored) {}
    }

    private static void injectSeoToIndexHtml(List<SeoArticle> seoList) throws IOException {
        Path indexPath = Config.indexHtml;
        if (!Files.exists(indexPath)) {
            return;
        }

        String html = new String(Files.readAllBytes(indexPath),StandardCharsets.UTF_8);
        Document indexDoc = Jsoup.parse(html);
        String siteTitle = indexDoc.title();

        seoList.sort((a, b) -> b.stamp.compareTo(a.stamp));

        String domain = Config.props.getProperty("github_page");
        String baseUrl = "https://" + domain + "/";

        StringBuilder sb = new StringBuilder();
        sb.append("<!-- SEO-BEGIN -->\n<div id=\"seo-content\" class=\"sr-only\">\n");
        sb.append("<h1>").append(siteTitle).append("</h1>\n");
        sb.append("<p>本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航</p>\n");
        sb.append("<h2>最新内容</h2>\n");

        StringBuilder jsonLd = new StringBuilder();
        jsonLd.append("<script type=\"application/ld+json\">\n{\n");
        jsonLd.append("  \"@context\": \"https://schema.org\",\n");
        jsonLd.append("  \"@type\": \"Blog\",\n");
        String safeSiteTitle = siteTitle.replace("\"", "\\\"");
        jsonLd.append("  \"name\": \"").append(safeSiteTitle).append("\",\n");
        jsonLd.append("  \"url\": \"").append(baseUrl).append("\",\n");
        jsonLd.append("  \"description\": \"本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航\",\n");
        jsonLd.append("  \"blogPost\": [\n");

        Pattern imgPattern = Pattern.compile(
                "([a-zA-Z0-9_\\-]+\\.(?:jpg|jpeg|png|gif|webp))",
                Pattern.CASE_INSENSITIVE);

        int limit = Math.min(50, seoList.size());

        for (int i = 0; i < limit; i++) {
            SeoArticle a = seoList.get(i);
            String formattedDate = a.stamp;
            if (formattedDate != null && formattedDate.length() >= 8) {
                formattedDate = formattedDate.substring(0, 4) + "-"
                        + formattedDate.substring(4, 6) + "-"
                        + formattedDate.substring(6, 8);
            }

            String safeTitle = a.title
                    .replace("\"", "\\\"")
                    .replace("\n", " ");

            Matcher matcher = imgPattern.matcher(a.summary);
            List<String> imageUrls = new ArrayList<>();
            StringBuffer textBuffer = new StringBuffer();

            while (matcher.find()) {
                String file = matcher.group(1);
                imageUrls.add(baseUrl + "gallery/img/" + file);
                matcher.appendReplacement(textBuffer, "");
            }
            matcher.appendTail(textBuffer);

            String pureText = textBuffer.toString()
                    .replaceAll("\\s+", " ")
                    .trim();

            // ---------- HTML ----------
            sb.append("<article>\n");
            sb.append("<h3>").append(a.title).append("</h3>\n");
            if (!pureText.isEmpty()) {
                sb.append("<p>")
                        .append(pureText)
                        .append("</p>\n");
            }

            if (!imageUrls.isEmpty()) {
                sb.append("<div class=\"seo-images\">\n");
                for (int j = 0; j < imageUrls.size(); j++) {
                    sb.append("<img src=\"")
                            .append(imageUrls.get(j))
                            .append("\" alt=\"")
                            .append(a.title)
                            .append(" 截图")
                            .append(j + 1)
                            .append("\">\n");
                }
                sb.append("</div>\n");
            }
            sb.append("<time datetime=\"")
                    .append(formattedDate)
                    .append("\">")
                    .append(formattedDate)
                    .append("</time>\n");
            sb.append("</article>\n");

            // ---------- JSON-LD ----------
            jsonLd.append("    {\n");
            jsonLd.append("      \"@type\": \"BlogPosting\",\n");
            jsonLd.append("      \"headline\": \"")
                    .append(safeTitle)
                    .append("\",\n");

            if (!imageUrls.isEmpty()) {
                jsonLd.append("      \"image\": [\n");
                for (int j = 0; j < imageUrls.size(); j++) {
                    jsonLd.append("        \"")
                            .append(imageUrls.get(j))
                            .append("\"");
                    if (j != imageUrls.size() - 1) {
                        jsonLd.append(",");
                    }
                    jsonLd.append("\n");
                }
                jsonLd.append("      ],\n");
            }
            jsonLd.append("      \"datePublished\": \"")
                    .append(formattedDate)
                    .append("\"\n");
            jsonLd.append("    }");
            if (i != limit - 1) {
                jsonLd.append(",");
            }
            jsonLd.append("\n");
        }

        sb.append("</div>\n");
        jsonLd.append("  ]\n}\n</script>\n");
        sb.append(jsonLd);
        sb.append("<!-- SEO-END -->");

        String beginTag = "<!-- SEO-BEGIN -->";
        String endTag = "<!-- SEO-END -->";

        int begin = html.indexOf(beginTag);
        int end = html.indexOf(endTag);

        if (begin != -1 && end != -1 && end > begin) {
            String before = html.substring(0, begin);
            String after = html.substring(end + endTag.length());

            Files.write(
                    indexPath,
                    (before + sb + after).getBytes(StandardCharsets.UTF_8));
        } else {
            logger.warn("未在 index.html 中找到 <!-- SEO-BEGIN --> 或 <!-- SEO-END --> 标记，跳过注入。");
        }
    }

    private static void generateSitemap(List<SeoArticle> seoList) throws IOException {
        if (seoList.isEmpty()) return;

        // 取最新一篇文章的时间作为整个站点的更新时间
        String latestStamp = seoList.get(0).stamp;
        String latestDate = latestStamp;
        if (latestStamp != null && latestStamp.length() >= 8) {
            latestDate = latestStamp.substring(0, 4) + "-" + latestStamp.substring(4, 6) + "-" + latestStamp.substring(6, 8);
        }

        String domain = Config.props.getProperty("github_page");

        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
                "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
                "  <url>\n" +
                "    <loc>https://" + domain + "/</loc>\n" +
                "    <lastmod>" + latestDate + "</lastmod>\n" +
                "    <changefreq>daily</changefreq>\n" +
                "    <priority>1.0</priority>\n" +
                "  </url>\n" +
                "</urlset>";

        Path sitemapPath = Config.indexHtml.getParent().resolve("sitemap.xml");
        Files.write(sitemapPath, xml.getBytes(StandardCharsets.UTF_8));
    }

    private static void generateRobotsTxt() throws IOException {
        String domain = Config.props.getProperty("github_page");

        String content = "User-agent: *\n" +
                "Allow: /\n" +
                "Disallow: /_build/\n" +
                "Disallow: /src/\n" +
                "Disallow: /html/\n" +
                "Disallow: /gallery/\n" +
                "Disallow: /video/\n" +
                "Disallow: /audio/\n" +
                "Disallow: /ebook/\n\n" +
                "Sitemap: https://" + domain + "/sitemap.xml\n";

        Path robotsPath = Config.indexHtml.getParent().resolve("robots.txt");
        Files.write(robotsPath, content.getBytes(StandardCharsets.UTF_8));
    }

    static class FileMeta {
        String hash; String source;
        FileMeta(String h, String s) { hash = h; source = s; }
    }

    static class SeoArticle {
        String title, stamp, summary;
        SeoArticle(String title, String stamp, String summary) {
            this.title = title;
            this.stamp = stamp;
            this.summary = summary;
        }
    }
}
