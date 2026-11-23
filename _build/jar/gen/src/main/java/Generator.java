import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
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
import java.util.stream.Collectors;
import java.util.stream.Stream;
import java.nio.file.StandardCopyOption;
import java.util.zip.CRC32;

public class Generator {
    private static final Logger logger = LoggerFactory.getLogger(Generator.class);
    private static final Pattern anchorPattern = Pattern.compile("<span id=\"anchor\">(\\d+)-(.+)</span>");
    private static final Pattern HEADING_LINE_PATTERN = Pattern.compile("^(#{1,6})\\s+(.*)$");
    private static final Map<String, Object> liteDataTree = new HashMap<>();
    private static final List<Pattern> gitIgnorePatterns = new ArrayList<>();
    private static final Set<String> localOnlySet = new HashSet<>();
    /** 由 `git check-ignore` 判定为"被忽略"的 html 相对路径; 与 gitIgnorePatterns 取并集, 只会让隔离更保守 */
    private static final Set<String> gitIgnoredByGit = new HashSet<>();
    /** 本次构建识别出的私有页（不含 .html）, 供构建末尾的泄漏断言使用 */
    private static final Set<String> privatePageNames = new TreeSet<>();

    public static void run() throws Exception {
        gitIgnorePatterns.clear(); localOnlySet.clear(); gitIgnoredByGit.clear(); privatePageNames.clear();
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
        Map<Integer, String> publicDocsForDf = new TreeMap<>();

        processHtmlFilesAndImages(coreBundle, records, currentTitles, maxId, fatDataMap, shadowDataMap, publicDocsForDf);

        orphanIds.removeAll();
        for (JsonNode r : records) if (!currentTitles.contains(r.get("title").asText())) orphanIds.add(r.get("id").asInt());
        try (Writer writer = Files.newBufferedWriter(Config.cmtMapper.toPath(), StandardCharsets.UTF_8)) { Utils.JSON_MAPPER.writeValue(writer, rootNode); }

        scanAllMedias();

        List<String> generatedDataFiles = generateLiteAndFatData(fatDataMap, String.valueOf(Config.dataDir), Config.sliceSize);
        if (!shadowDataMap.isEmpty()) { generateShadowData(shadowDataMap, String.valueOf(Config.dataDir), Config.sliceSize); }

        // 在生成清单前按公开语料 DF 与现代词配置按需更新 synonyms.js，确保新哈希同轮写入 core-list.js
        SynonymBuilder.buildIfNeeded(publicDocsForDf, liteDataTree);

        String newBuildVersion = generateManifest(Config.htmlDir, Config.dataDir, projectRootPath(), coreBundle, generatedDataFiles);
        if (newBuildVersion != null) {
            updateSwVersion(newBuildVersion);
        }

        // 兜底: 构建产物写完后, 再确认私有页的正文没有出现在任何公网产物里
        assertNoPrivateLeak(shadowDataMap, generatedDataFiles, coreBundle);
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
                "  const update_interval_local = " + Config.props.getProperty("update_interval_local") + ";\n" +
                "  const readme_md = \"" + normalizeWebPath(Config.props.getProperty("readme_md", "/README.md")) + "\";\n</script>";

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

    /**
     * 解析 .gitignore —— 失败即中止。
     * 公私隔离是否生效取决于这里: 找不到 .gitignore 却继续构建, 会把全部私有页正文写进公网产物。
     */
    private static void parseGitIgnore() {
        Path gitIgnorePath = Config.gitignoreFile;
        if (gitIgnorePath == null || !Files.isRegularFile(gitIgnorePath)) {
            throw new IllegalStateException("找不到 .gitignore: " + gitIgnorePath
                    + "。无法判定哪些页面是私有的, 为避免私有正文被发布, 已拒绝构建。");
        }
        List<String> lines;
        try {
            lines = Files.readAllLines(gitIgnorePath, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("无法读取 .gitignore: " + gitIgnorePath, e);
        }
        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            if (line.startsWith("!")) continue; // 否定规则只会让文件"更公开", 宁可忽略; 另由 git check-ignore 兜底
            if (line.startsWith("/")) line = line.substring(1);
            String raw = line;
            if (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);
            localOnlySet.add(raw);
            localOnlySet.add(raw.replace('/', '\\'));
            String regex = globToRegex(line);
            if (line.endsWith("/")) regex = "^.*" + regex + ".*$";
            else if (!line.contains("*")) regex = "^.*" + regex + ".*$";
            else regex = "^.*" + regex + "$";
            try {
                gitIgnorePatterns.add(Pattern.compile(regex, Pattern.CASE_INSENSITIVE));
            } catch (RuntimeException e) {
                throw new IllegalStateException(".gitignore 规则无法解析: \"" + line + "\"（" + e.getMessage() + "）", e);
            }
        }
        boolean allowEmpty = "true".equalsIgnoreCase(Config.props.getProperty("allow_empty_gitignore", "false").trim());
        if (gitIgnorePatterns.isEmpty() && !allowEmpty) {
            throw new IllegalStateException(".gitignore 中没有任何有效规则, 无法确认私有页已被隔离。"
                    + "若确实没有私有内容, 请在 config.properties 设置 allow_empty_gitignore=true。");
        }
//        logger.info("已加载 {} 条 .gitignore 规则", gitIgnorePatterns.size());
    }

    /** 把 glob 转成 Java 正则: * → .*, ? → ., 其余正则元字符一律转义（旧实现只转义了 "."） */
    private static String globToRegex(String glob) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            if (c == '*') sb.append(".*");
            else if (c == '?') sb.append('.');
            else if ("\\.[]{}()+-^$|".indexOf(c) >= 0) sb.append('\\').append(c);
            else sb.append(c);
        }
        return sb.toString();
    }

    /** 私有页判定 = 自带规则命中 或 git 自己认为被忽略（并集: 只会更保守, 绝不会把 git 忽略的文件当成公开） */
    private static boolean isPrivateHtml(String relativeHtmlPath) {
        for (Pattern p : gitIgnorePatterns) if (p.matcher(relativeHtmlPath).matches()) return true;
        return gitIgnoredByGit.contains(relativeHtmlPath);
    }

    /** 一次性询问 git 哪些路径被忽略（--no-index: 即使已被跟踪也按规则判定）。git 不可用时返回空集并告警。 */
    private static Set<String> queryGitIgnored(List<String> relPaths) {
        Set<String> result = new HashSet<>();
        if (relPaths.isEmpty()) return result;
        try {
            ProcessBuilder pb = new ProcessBuilder("git", "check-ignore", "--no-index", "-z", "--stdin");
            pb.directory(Config.projectRoot.toFile());
            pb.redirectError(new File(System.getProperty("os.name", "").toLowerCase().contains("win") ? "NUL" : "/dev/null"));
            Process proc = pb.start();
            try (OutputStream os = proc.getOutputStream()) {
                for (String p : relPaths) { os.write(p.getBytes(StandardCharsets.UTF_8)); os.write(0); }
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            try (InputStream is = proc.getInputStream()) {
                byte[] buf = new byte[8192]; int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            }
            int code = proc.waitFor();
            if (code == 0 || code == 1) {
                for (String p : new String(bos.toByteArray(), StandardCharsets.UTF_8).split("\0")) if (!p.isEmpty()) result.add(p);
//                logger.info("git check-ignore: {} 个页面被 git 判定为忽略", result.size());
            } else {
                logger.warn("git check-ignore 返回 {}（可能不在 git 仓库内）, 仅使用 .gitignore 规则判定私有页", code);
            }
        } catch (IOException | InterruptedException e) {
            logger.warn("无法调用 git 校验忽略规则（{}）, 仅使用 .gitignore 规则判定私有页", e.toString());
        }
        return result;
    }

    private static int intProp(String key, int def) {
        try { return Integer.parseInt(Config.props.getProperty(key, String.valueOf(def)).trim()); }
        catch (NumberFormatException e) { return def; }
    }

    private static void processHtmlFilesAndImages(ObjectNode coreBundle, ArrayNode records, Set<String> currentTitles, int[] maxId, Map<Integer, String> fatDataMap, Map<Integer, String> shadowDataMap, Map<Integer, String> publicDocsForDf) {
        Set<String> imageSet = buildGalleryImageSet();
        Map<String, String> imageLowerToActual = new HashMap<>();
        for (String img : imageSet) imageLowerToActual.put(img.toLowerCase(), img);
        Set<String> usedImagesSet = new HashSet<>();
        Pattern fullImgPattern = Pattern.compile("^\\s*(\\.\\./gallery/[^\\s\"'<>]+\\.(?:jpg|jpeg|png|gif|webp))\\s*$", Pattern.CASE_INSENSITIVE);
        Pattern flatImgPattern = Pattern.compile("^\\s*([^\\s\"'<>/\\\\]+\\.(?:jpg|jpeg|png|gif|webp))\\s*$", Pattern.CASE_INSENSITIVE);

        // 默认只"报告"失效的图片引用, 不再改写源文件。要恢复旧的自动清理行为, 需显式设置 prune_missing_images=true。
        final boolean pruneMissing = "true".equalsIgnoreCase(Config.props.getProperty("prune_missing_images", "false").trim());
        if (pruneMissing && (!Files.isDirectory(Config.galleryDir) || imageSet.isEmpty())) {
            throw new IllegalStateException("prune_missing_images=true, 但 gallery 目录不存在或没有任何图片（" + Config.galleryDir
                    + "）。若继续, 所有页面的图片引用行都会被当作失效并删除, 已拒绝。");
        }
        final boolean checkPrivatePrefix = !"false".equalsIgnoreCase(Config.props.getProperty("private_prefix_check", "true").trim());

        List<Path> htmlList;
        try (Stream<Path> htmlFiles = Files.list(Config.htmlDir)) {
            htmlList = htmlFiles.filter(p -> p.toString().endsWith(".html")).sorted().collect(Collectors.toList());
        } catch (IOException e) {
            throw new IllegalStateException("无法列出 html 目录: " + Config.htmlDir, e);
        }
        if (htmlList.isEmpty()) {
            throw new IllegalStateException("html 目录中没有任何 .html 文件: " + Config.htmlDir + "（拒绝构建空站点）");
        }

        List<String> relPaths = new ArrayList<>();
        for (Path p : htmlList) relPaths.add("html/" + p.getFileName().toString());
        gitIgnoredByGit.clear();
        gitIgnoredByGit.addAll(queryGitIgnored(relPaths));

        List<String> failures = new ArrayList<>();
        List<String> missingImages = new ArrayList<>();
        List<String> caseMismatches = new ArrayList<>();
        Map<Path, List<String>> pendingRewrites = new LinkedHashMap<>();
        int prunedLines = 0;

        for (Path path : htmlList) {
            String fileName = path.getFileName().toString().replace(".html", "");
            String relativeHtmlPath = "html/" + path.getFileName().toString();
            try {
                boolean isGitIgnored = isPrivateHtml(relativeHtmlPath);
                boolean isExcludedData = isExcluded(fileName);
                if (isGitIgnored) {
                    privatePageNames.add(fileName);
                } else if (checkPrivatePrefix && fileName.startsWith("__")) {
                    throw new IllegalStateException("页面以 \"__\" 开头（约定为私有页）, 却未被 .gitignore / git 判定为忽略。"
                            + "请补充 .gitignore 规则, 否则它的正文会被发布（确实要公开可设 private_prefix_check=false）。");
                }

                List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
                List<String> newLines = new ArrayList<>(lines.size());
                StringBuilder htmlContentBuilder = new StringBuilder();
                StringBuilder searchTextBuilder = new StringBuilder();
                boolean fileModified = false;

                for (String line : lines) {
                    boolean keepLine = true;
                    String imgRef = null;
                    Matcher mFull = fullImgPattern.matcher(line);
                    Matcher mFlat = flatImgPattern.matcher(line);
                    if (mFull.matches()) imgRef = mFull.group(1);
                    else if (mFlat.matches()) imgRef = "../gallery/img/" + mFlat.group(1);

                    if (imgRef != null) {
                        if (imageSet.contains(imgRef)) {
                            usedImagesSet.add(imgRef);
                        } else {
                            String actual = imageLowerToActual.get(imgRef.toLowerCase());
                            if (actual != null) {
                                // Windows 下能显示, 但 GitHub Pages（区分大小写）会 404 —— 只告警, 不删
                                usedImagesSet.add(actual);
                                caseMismatches.add(fileName + ": " + imgRef + "  ≠  " + actual);
                            } else {
                                missingImages.add(fileName + ": " + imgRef);
                                if (pruneMissing) { keepLine = false; prunedLines++; }
                            }
                        }
                    }

                    if (keepLine) {
                        newLines.add(line);
                        htmlContentBuilder.append(line).append("\n");
                        Matcher mHeading = HEADING_LINE_PATTERN.matcher(line);
                        searchTextBuilder.append(mHeading.matches() ? mHeading.group(2) : line).append("\n");
                    } else {
                        fileModified = true;
                    }
                }

                if (fileModified) pendingRewrites.put(path, newLines);
                String htmlContent = htmlContentBuilder.toString();

                if (!isGitIgnored && !isExcludedData) coreBundle.put("/" + Config.PREFIX_HTML + path.getFileName().toString(), htmlContent);

                Document doc = Jsoup.parse(htmlContent);
                Document searchDoc = Jsoup.parse(searchTextBuilder.toString());
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

                    String cleanText = searchDoc.body().text().replaceAll("\r\n|\r|\n", " ").replaceAll(" +", " ").replaceAll("\\$\\{", "&#36;{").replaceAll("`", "&#715;");

                    if (!isGitIgnored && !isExcludedData) {
                        fatDataMap.put(currentRecordId, cleanText);
                        String dfText = cleanText;
                        Element anchorInSearch = searchDoc.getElementById("anchor");
                        if (anchorInSearch != null) {
                            anchorInSearch.remove();
                            dfText = searchDoc.body().text().replaceAll("\r\n|\r|\n", " ").replaceAll(" +", " ");
                        }
                        publicDocsForDf.put(currentRecordId, title + " " + dfText);
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

            } catch (Exception e) {
                // 单页失败不再被吞掉: 先继续处理其余页面以便一次性列出全部问题, 最后统一失败
                failures.add(path.getFileName() + "  →  " + e);
                logger.error("页面处理失败: {}", path.getFileName(), e);
            }
        }

        if (!failures.isEmpty()) {
            throw new IllegalStateException("有 " + failures.size() + " 个页面处理失败, 已中止构建以免发布残缺站点:\n  " + String.join("\n  ", failures));
        }
        if (!missingImages.isEmpty()) {
            logger.warn("发现 {} 处指向不存在图片的引用（{}）:\n  {}", missingImages.size(),
                    pruneMissing ? "将按 prune_missing_images=true 清理" : "未改动源文件",
                    String.join("\n  ", missingImages.subList(0, Math.min(30, missingImages.size()))));
        }
        if (!caseMismatches.isEmpty()) {
            logger.warn("发现 {} 处图片引用与 gallery 实际文件名大小写不一致（线上会 404）:\n  {}", caseMismatches.size(),
                    String.join("\n  ", caseMismatches.subList(0, Math.min(30, caseMismatches.size()))));
        }
        if (!pendingRewrites.isEmpty()) applyPrunedRewrites(pendingRewrites, prunedLines);

        generateIdleImageList(imageSet, usedImagesSet);
    }

    /** 仅在 prune_missing_images=true 时执行: 先校验上限、先备份、再改写 */
    private static void applyPrunedRewrites(Map<Path, List<String>> pending, int prunedLines) {
        int cap = intProp("prune_max_lines", 30);
        if (prunedLines > cap) {
            throw new IllegalStateException("本次将删除 " + prunedLines + " 行失效图片引用, 超过安全上限 prune_max_lines=" + cap
                    + "（疑似 gallery 目录异常）。已中止, 未改动任何源文件。");
        }
        try {
            // 注意: 备份目录位于仓库内, 请把 _build/backup/ 加入 .gitignore, 避免被 git add -A 提交
            Path backupDir = Config.buildRoot.resolve("backup").resolve("html_" + new java.text.SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date()));
            Files.createDirectories(backupDir);
            for (Map.Entry<Path, List<String>> e : pending.entrySet()) {
                Files.copy(e.getKey(), backupDir.resolve(e.getKey().getFileName().toString()), StandardCopyOption.REPLACE_EXISTING);
                Files.write(e.getKey(), e.getValue(), StandardCharsets.UTF_8);
            }
            logger.warn("已删除 {} 行失效图片引用（涉及 {} 个文件）, 原文件已备份到 {}", prunedLines, pending.size(), backupDir);
        } catch (IOException ex) {
            throw new IllegalStateException("改写源文件失败", ex);
        }
    }

    /**
     * 构建末尾的隔离断言: 私有页的正文不得出现在任何公网产物里。
     * 取私有正文 25% / 50% / 75% 处各 40 字符作指纹, 三段同时出现在同一产物中才判定泄漏（避免引用同一句话造成误报）。
     */
    private static void assertNoPrivateLeak(Map<Integer, String> shadowDataMap, List<String> generatedDataFiles, ObjectNode coreBundle) {
        if (privatePageNames.isEmpty()) return;
        List<String> problems = new ArrayList<>();
        for (String name : privatePageNames) {
            if (coreBundle.has("/" + Config.PREFIX_HTML + name + ".html")) problems.add("core-bundle.json 含有私有页: " + name);
        }
        List<String> blobs = new ArrayList<>();
        List<String> blobNames = new ArrayList<>();
        try {
            for (String f : generatedDataFiles) {
                blobs.add(new String(Files.readAllBytes(Config.dataDir.resolve(f)), StandardCharsets.UTF_8));
                blobNames.add(f);
            }
            if (Files.exists(Config.coreBundleOut)) {
                blobs.add(new String(Files.readAllBytes(Config.coreBundleOut), StandardCharsets.UTF_8));
                blobNames.add(Config.FILE_CORE_BUNDLE);
            }
            Path syn = Config.jsOutputDir.resolve("synonyms.js");
            if (Files.exists(syn)) {
                blobs.add(new String(Files.readAllBytes(syn), StandardCharsets.UTF_8));
                blobNames.add("synonyms.js");
            }
        } catch (IOException e) {
            throw new IllegalStateException("隔离检查无法读取产物", e);
        }
        for (Map.Entry<Integer, String> e : shadowDataMap.entrySet()) {
            String t = e.getValue();
            if (t == null || t.length() < 200) continue;
            int n = t.length();
            String[] samples = { t.substring(n / 4, n / 4 + 40), t.substring(n / 2, n / 2 + 40), t.substring(n * 3 / 4, n * 3 / 4 + 40) };
            for (int i = 0; i < blobs.size(); i++) {
                boolean all = true;
                for (String sm : samples) if (!blobs.get(i).contains(sm)) { all = false; break; }
                if (all) problems.add("公网产物 " + blobNames.get(i) + " 含有私有页（recordId=" + e.getKey() + "）的正文片段");
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("隔离检查失败, 已中止（请勿提交 / 推送本次产物）:\n  " + String.join("\n  ", problems));
        }
//        logger.info("隔离检查通过: 共 {} 个私有页, 公网产物中未发现其正文", privatePageNames.size());
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
                    String relativeHtmlPath = "html/" + p.getFileName().toString();
                    boolean isGitIgnored = isPrivateHtml(relativeHtmlPath);

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
                List<String> missingCore = new ArrayList<>();
                for (String path : coreFilesProp.split("\\|")) {
                    String webPath = path.trim();
                    if (webPath.isEmpty()) continue;
                    Path physicalFile = findPhysicalFile(projectRoot, webPath);
                    if (!Files.exists(physicalFile)) { missingCore.add(webPath); continue; }
                    String hash = calculateFingerprint(physicalFile);
                    if (webPath.equals("/") || webPath.endsWith(".html") || webPath.endsWith(".css") || webPath.endsWith(".json") || webPath.endsWith(".md")) {
                        try {
                            coreBundle.put(webPath, new String(Files.readAllBytes(physicalFile), StandardCharsets.UTF_8));
                            swManifest.put(webPath, new FileMeta(hash, Config.FILE_CORE_BUNDLE));
                        } catch (IOException e) { swManifest.put(webPath, new FileMeta(hash, "standalone")); }
                    } else swManifest.put(webPath, new FileMeta(hash, "standalone"));
                }
                // 旧实现会给缺失文件记 "0_0" 哈希并照常发布清单, 用户端 SW 安装时 404, 更新直接卡死
                if (!missingCore.isEmpty()) {
                    throw new IllegalStateException("config.properties 的 coreFiles 中有文件不存在:\n  " + String.join("\n  ", missingCore));
                }
            }

            String readmeMdPath = normalizeWebPath(Config.props.getProperty("readme_md", ""));
            if (!readmeMdPath.isEmpty() && !swManifest.containsKey(readmeMdPath)) {
                Path mdFile = findPhysicalFile(projectRoot, readmeMdPath);
                if (Files.exists(mdFile)) {
                    String hash = calculateFingerprint(mdFile);
                    try {
                        coreBundle.put(readmeMdPath, new String(Files.readAllBytes(mdFile), StandardCharsets.UTF_8));
                        swManifest.put(readmeMdPath, new FileMeta(hash, Config.FILE_CORE_BUNDLE));
                    } catch (IOException e) {
                        swManifest.put(readmeMdPath, new FileMeta(hash, "standalone"));
                    }
                }
            }

            try (Writer writer = Files.newBufferedWriter(Config.coreBundleOut, StandardCharsets.UTF_8)) { Utils.JSON_MAPPER.writeValue(writer, coreBundle); }

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

        } catch (IOException e) { throw new IllegalStateException("生成清单失败", e); }
    }

    private static String normalizeWebPath(String p) {
        if (p == null) return "";
        String s = p.trim().replace("\\", "/");
        if (s.isEmpty()) return "";
        return s.startsWith("/") ? s : "/" + s;
    }

    private static Path projectRootPath() { return Config.projectRoot; }

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
            if (!Files.exists(swPath)) throw new IllegalStateException("找不到 " + swPath + ", 无法写入新的 SW 版本号");
            {
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
        } catch (IOException e) { throw new IllegalStateException("更新 sw.js 版本号失败", e); }
    }

    static class FileMeta {
        String hash; String source;
        FileMeta(String h, String s) { hash = h; source = s; }
    }
}
