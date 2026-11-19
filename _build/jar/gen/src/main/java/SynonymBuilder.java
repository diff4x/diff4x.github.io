import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * SynonymBuilder —— 内聚于 gen.jar 的同义词词林 + DF 软加权 + 现代词覆盖构建器 (v5.0)
 *
 * 功能：
 * 1. 读取 cilin.txt 与 synonyms_custom.json（支持 exclusive 独占覆盖、stopExpand 停扩、单向 aliases）。
 * 2. 仅基于公开、非排除的 HTML（标题 + 去 #anchor 正文）与公开媒体标题做词表 FMM 分词统计 DF，
 *    绝对不触碰 shadowDataMap（__ 私有页面），保护隐私且防止私密更新引起公网缓存抖动。
 * 3. 将 DF 按文档占比量化为 :1..:6 分桶后缀（方案 A 软加权，不删词林行，私密页与评论靠 Bloom 兜底）。
 * 4. 双重哈希防抖（temp/synonyms.sha256）：仅在源码或目标产物变化时重编译并调用 esbuild 压缩至 src/js/synonyms.js。
 * 5. 生成纯本地诊断报告 temp/oov_report.txt（高频未收录英文技术词与中文 OOV 候选词）。
 */
public class SynonymBuilder {
    private static final Logger logger = LoggerFactory.getLogger(SynonymBuilder.class);

    public static final String SYN_ALGO_VERSION = "cilin-1hop-df-v5.0";
    private static final Pattern WHITESPACE_SPLIT = Pattern.compile("[\\s\\u3000]+");
    private static final Pattern TAIL_LATIN_SUFFIX = Pattern.compile("^([\\u4e00-\\u9fff]+)[a-z\\.]$");
    private static final Pattern ANCHOR_PREFIX = Pattern.compile("^\\d{14}-\\S+\\s*");
    private static final Pattern URL_PATTERN = Pattern.compile("https?://\\S+");
    private static final Pattern ASCII_TOKEN_PATTERN = Pattern.compile("(?<![a-zA-Z0-9_])[a-zA-Z][a-zA-Z0-9_+#-]{1,23}(?![a-zA-Z0-9_])");
    private static final Pattern SHORT_ALPHA_NUM = Pattern.compile("^[a-z]\\d+$");

    private static final Set<String> ASCII_STOP_WORDS = new HashSet<String>(Arrays.asList(
            "the", "and", "for", "with", "from", "this", "that", "have", "are", "was", "were", "not", "you", "your",
            "but", "all", "can", "had", "her", "one", "our", "out", "day", "get", "has", "him", "his", "how", "its",
            "may", "new", "now", "old", "see", "two", "way", "who", "did", "let", "put", "say", "she", "too", "use",
            "will", "just", "more", "some", "into", "than", "then", "them", "they", "what", "when", "where", "which",
            "while", "would", "there", "their", "about", "could", "other", "these", "first", "after", "never", "still",
            "been", "only", "also", "very", "even", "most", "much", "such", "make", "like", "time", "over", "here",
            "in", "if", "is", "to", "it", "as", "by", "of", "on", "at", "or", "no", "so", "up", "do", "be", "we",
            "he", "me", "my", "an", "us", "am", "ok", "vs", "cd", "rd", "md", "del", "dir", "set", "rem", "cls",
            "http", "https", "www", "com", "org", "net", "html", "htm", "webp", "png", "jpg", "jpeg", "gif", "svg",
            "mp4", "mp3", "m4a", "mkv", "pdf", "epub", "txt", "json", "exe", "dll", "zip", "bin", "cfg", "log",
            "def", "return", "import", "print", "self", "true", "false", "none", "null", "class", "else", "elif",
            "try", "except", "finally", "pass", "break", "continue", "const", "var", "function", "void",
            "int", "char", "str", "float", "bool", "list", "dict", "type", "args", "name", "value", "item",
            "items", "key", "keys", "file", "path", "src", "out", "build", "run", "test", "info", "error",
            "warn", "debug", "config", "default", "index", "main", "init", "start", "stop", "open", "close", "read",
            "write", "load", "save", "add", "pop", "end", "max", "min", "sum", "len", "range", "append", "remove",
            "sort", "sorted", "title", "upper", "lower", "strip", "split", "join", "replace", "format", "echo",
            "setlocal", "exit", "pause", "call", "goto", "exist", "delims", "tokens", "users", "user", "data",
            "window", "mode", "lib", "target", "failed", "install", "using", "used", "each"
    ));

    private static final String CJK_EDGE_STOP_CHARS =
            "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严呀啊呢吧吗嘛哦哇啦呐呗兮矣乎哉焉";

    private static final Set<Character> CJK_EDGE_STOP_SET = new HashSet<Character>();
    static {
        for (int i = 0; i < CJK_EDGE_STOP_CHARS.length(); i++) {
            CJK_EDGE_STOP_SET.add(CJK_EDGE_STOP_CHARS.charAt(i));
        }
    }

    static class CustomGroup {
        String c5;
        boolean exclusive;
        List<String> words;

        CustomGroup(String c5, boolean exclusive, List<String> words) {
            this.c5 = c5;
            this.exclusive = exclusive;
            this.words = words;
        }
    }

    static class CustomConfig {
        Set<String> dropEqCodes = new HashSet<String>();
        Map<String, Set<String>> pruneWords = new HashMap<String, Set<String>>();
        Map<String, List<String>> splitFixes = new HashMap<String, List<String>>();
        Set<String> stopExpand = new HashSet<String>();
        List<CustomGroup> groups = new ArrayList<CustomGroup>();
        Map<String, List<String>> aliases = new LinkedHashMap<String, List<String>>();
    }

    static class CilinEntry {
        String code7;
        char rel;
        List<String> words;

        CilinEntry(String code7, char rel, List<String> words) {
            this.code7 = code7;
            this.rel = rel;
            this.words = words;
        }
    }

    static class TokenStat {
        String display;
        int df;
        int tf;
        Map<String, Integer> caseCounts = new HashMap<String, Integer>();

        void record(String raw, boolean newDoc) {
            tf++;
            if (newDoc) df++;
            Integer prev = caseCounts.get(raw);
            int next = (prev == null ? 0 : prev) + 1;
            caseCounts.put(raw, next);
            if (display == null || next > caseCounts.getOrDefault(display, 0)) {
                display = raw;
            }
        }
    }

    /**
     * 独立命令行入口：java -jar gen.jar synonyms
     * 直接从已生成的 fat_data_*.json 与 lite_data.js 统计公开 DF 并按需重建 synonyms.js。
     */
    public static void runStandalone() {
        Map<Integer, String> publicDocs = new TreeMap<Integer, String>();
        if (Config.dataDir != null && Files.exists(Config.dataDir)) {
            try (Stream<Path> files = Files.list(Config.dataDir)) {
                files.filter(p -> {
                    String n = p.getFileName().toString();
                    return n.startsWith(Config.FILE_FAT_DATA_PREFIX) && n.endsWith(".json");
                }).sorted().forEach(p -> {
                    try {
                        JsonNode root = Utils.JSON_MAPPER.readTree(p.toFile());
                        if (root != null && root.isObject()) {
                            Iterator<Map.Entry<String, JsonNode>> it = root.fields();
                            while (it.hasNext()) {
                                Map.Entry<String, JsonNode> e = it.next();
                                String val = e.getValue().asText("");
                                if (val.isEmpty() || "localOnly".equals(val)) continue;
                                String cleaned = ANCHOR_PREFIX.matcher(val).replaceFirst("");
                                try {
                                    publicDocs.put(Integer.parseInt(e.getKey()), cleaned);
                                } catch (NumberFormatException ignored) { }
                            }
                        }
                    } catch (IOException ex) {
                        logger.warn("[Synonyms] 读取切片失败: {}", p.getFileName(), ex);
                    }
                });
            } catch (IOException e) {
                logger.warn("[Synonyms] 扫描 dataDir 失败", e);
            }
        }

        Map<String, Object> liteTree = null;
        if (Config.dataDir != null) {
            Path liteFile = Config.dataDir.resolve(Config.FILE_LITE_DATA);
            if (Files.exists(liteFile)) {
                try {
                    String raw = new String(Files.readAllBytes(liteFile), StandardCharsets.UTF_8);
                    int s = raw.indexOf('{');
                    int e = raw.lastIndexOf('}');
                    if (s >= 0 && e > s) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> parsed = Utils.JSON_MAPPER.readValue(raw.substring(s, e + 1), Map.class);
                        liteTree = parsed;
                    }
                } catch (Exception ex) {
                    logger.warn("[Synonyms] 读取 lite_data.js 失败，跳过媒体标题补充", ex);
                }
            }
        }

        buildIfNeeded(publicDocs, liteTree);
    }

    /**
     * 主构建入口：由 Generator.run() 在 generateManifest() 之前调用。
     *
     * @param publicDocsForDf 仅包含公开、非排除 HTML 的文本（标题 + 去 #anchor 正文），严禁传入私有内容
     * @param liteDataTree    站点目录树，用于提取公开媒体标题补充 DF=1
     * @return true 表示写入了新的 synonyms.js；false 表示无变化跳过或缺少源文件
     */
    public static boolean buildIfNeeded(Map<Integer, String> publicDocsForDf, Map<String, Object> liteDataTree) {
        long t0 = System.currentTimeMillis();
        Path cilinPath = Config.cilinFile;
        if (cilinPath == null || !Files.exists(cilinPath)) {
            logger.warn("[Synonyms] 未找到词林源文件 {}，跳过 synonyms.js 自动生成。", cilinPath);
            return false;
        }

        try {
            CustomConfig custom = loadCustomConfig(Config.synonymsCustomFile);

            // 1. 收集 exclusive 自定义词与 stopExpand 停扩词（均从词林 '=' 组剥离，但保留在 lexicon）
            Set<String> blockedFromCilinEq = new HashSet<String>(custom.stopExpand);
            for (CustomGroup g : custom.groups) {
                if (g.exclusive) {
                    for (String w : g.words) {
                        blockedFromCilinEq.add(w.toLowerCase(Locale.ROOT));
                    }
                }
            }

            // 2. 清洗词林并构建全量词表（供 FMM 分词统计 DF 与 OOV）
            List<CilinEntry> cilinEntries = new ArrayList<CilinEntry>(17000);
            Map<String, List<String>> demotedLexByC5 = new LinkedHashMap<String, List<String>>();
            Set<String> lexicon = new HashSet<String>(80000);
            int maxLexLen = 2;

            List<String> rawLines = Files.readAllLines(cilinPath, StandardCharsets.UTF_8);
            for (String rawLine : rawLines) {
                String line = rawLine.trim();
                if (line.length() < 9) continue;
                String code7 = line.substring(0, 7);
                char rel = line.charAt(7);
                if (rel != '=' && rel != '#' && rel != '@') continue;
                String body = line.substring(8).trim();
                if (body.isEmpty()) continue;

                List<String> rawTokens = tokenizeCilinBody(body, custom.splitFixes);
                Set<String> pruneSet = custom.pruneWords.get(code7);
                List<String> words = new ArrayList<String>(rawTokens.size());
                Set<String> seen = new HashSet<String>();

                for (String tok : rawTokens) {
                    String norm = toHalfwidth(tok).trim();
                    if (norm.length() < 2) continue;
                    if (pruneSet != null && pruneSet.contains(norm)) continue;
                    String k = norm.toLowerCase(Locale.ROOT);
                    if (!seen.add(k)) continue;

                    if (rel == '=' && blockedFromCilinEq.contains(k)) {
                        String c5 = code7.substring(0, 5);
                        demotedLexByC5.computeIfAbsent(c5, x -> new ArrayList<String>()).add(norm);
                        continue;
                    }
                    words.add(norm);
                }

                if (words.isEmpty()) continue;
                char outRel = rel;
                if (rel == '=' && (custom.dropEqCodes.contains(code7) || words.size() < 2)) {
                    outRel = '@';
                }
                cilinEntries.add(new CilinEntry(code7, outRel, words));
                for (String w : words) {
                    String k = w.toLowerCase(Locale.ROOT);
                    lexicon.add(k);
                    if (k.length() > maxLexLen && k.length() <= 12) maxLexLen = k.length();
                }
            }

            // 将被 exclusive/stopExpand 剥离的词保留在 '@' 词表行中，保护 DP 分词边界
            for (Map.Entry<String, List<String>> e : demotedLexByC5.entrySet()) {
                List<String> dedup = new ArrayList<String>();
                Set<String> seen = new HashSet<String>();
                for (String w : e.getValue()) {
                    String k = w.toLowerCase(Locale.ROOT);
                    if (seen.add(k)) {
                        dedup.add(w);
                        lexicon.add(k);
                        if (k.length() > maxLexLen && k.length() <= 12) maxLexLen = k.length();
                    }
                }
                if (!dedup.isEmpty()) {
                    cilinEntries.add(new CilinEntry(e.getKey() + "99", '@', dedup));
                }
            }

            for (CustomGroup g : custom.groups) {
                for (String w : g.words) {
                    String k = w.toLowerCase(Locale.ROOT);
                    lexicon.add(k);
                    if (k.length() > maxLexLen && k.length() <= 12) maxLexLen = k.length();
                }
            }
            for (Map.Entry<String, List<String>> e : custom.aliases.entrySet()) {
                String sk = e.getKey().toLowerCase(Locale.ROOT);
                lexicon.add(sk);
                if (sk.length() > maxLexLen && sk.length() <= 12) maxLexLen = sk.length();
                for (String tw : e.getValue()) {
                    String tk = tw.toLowerCase(Locale.ROOT);
                    lexicon.add(tk);
                    if (tk.length() > maxLexLen && tk.length() <= 12) maxLexLen = tk.length();
                }
            }

            // 3. FMM 分词统计公开 HTML 的 DF + 同步采集 OOV 候选词
            Map<String, Integer> dfMap = new HashMap<String, Integer>(16384);
            Map<String, TokenStat> asciiOov = new HashMap<String, TokenStat>();
            Map<String, TokenStat> cjkOov = new HashMap<String, TokenStat>();
            int totalPublicDocs = 0;

            if (publicDocsForDf != null) {
                for (String rawText : publicDocsForDf.values()) {
                    if (rawText == null || rawText.trim().isEmpty()) continue;
                    totalPublicDocs++;
                    scanDocumentForDfAndOov(rawText, lexicon, maxLexLen, dfMap, asciiOov, cjkOov);
                }
            }

            // 4. 用公开媒体文件名补充 DF=1（不增加 totalPublicDocs，避免稀释 HTML 占比）
            if (liteDataTree != null) {
                List<String> publicMediaTitles = new ArrayList<String>();
                for (String bucket : Arrays.asList("image", "audio", "video", "ebook")) {
                    collectPublicMediaTitles(liteDataTree.get(bucket), publicMediaTitles);
                }
                for (String mediaTitle : publicMediaTitles) {
                    Set<String> hits = fmmExtractWords(toHalfwidth(mediaTitle).toLowerCase(Locale.ROOT), lexicon, maxLexLen, null);
                    for (String w : hits) {
                        if (!dfMap.containsKey(w)) {
                            dfMap.put(w, 1);
                        }
                    }
                }
            }

            // 5. 写入本地新词诊断报告 temp/oov_report.txt
            writeOovReport(totalPublicDocs, asciiOov, cjkOov);

            // 6. 拼装带 :1..:6 分桶 DF 标记的 CILIN_RAW_DATA
            StringBuilder cilinRawSb = new StringBuilder(900 * 1024);
            int dfTaggedWordCount = 0;
            int eqGroupCount = 0;
            for (int idx = 0; idx < cilinEntries.size(); idx++) {
                CilinEntry entry = cilinEntries.get(idx);
                if (entry.rel == '=') eqGroupCount++;
                if (idx > 0) cilinRawSb.append('\n');
                cilinRawSb.append(entry.code7).append(entry.rel).append('|');
                for (int j = 0; j < entry.words.size(); j++) {
                    if (j > 0) cilinRawSb.append(' ');
                    String w = entry.words.get(j);
                    int df = dfMap.getOrDefault(w.toLowerCase(Locale.ROOT), 0);
                    int bucket = dfToBucket(df, totalPublicDocs);
                    cilinRawSb.append(escapeTemplateLiteral(w));
                    if (bucket > 0) {
                        cilinRawSb.append(':').append(bucket);
                        dfTaggedWordCount++;
                    }
                }
            }

            // 7. 序列化自定义双向组与单向别名，填充 JS 模板
            List<Map<String, Object>> groupsOut = new ArrayList<Map<String, Object>>(custom.groups.size());
            for (CustomGroup g : custom.groups) {
                Map<String, Object> item = new LinkedHashMap<String, Object>();
                item.put("c5", g.c5);
                item.put("words", g.words);
                groupsOut.add(item);
            }

            String versionJson = Utils.JSON_MAPPER.writeValueAsString(SYN_ALGO_VERSION);
            String groupsJson = safeJsonForJs(Utils.JSON_MAPPER.writeValueAsString(groupsOut));
            String aliasesJson = safeJsonForJs(Utils.JSON_MAPPER.writeValueAsString(custom.aliases));

            String rawJs = buildJsTemplate()
                    .replace("__SYN_ALGO_VERSION__", versionJson)
                    .replace("__CUSTOM_SYNONYM_GROUPS__", groupsJson)
                    .replace("__CUSTOM_ONEWAY_ALIASES__", aliasesJson)
                    .replace("__CILIN_RAW_DATA__", cilinRawSb.toString());

            byte[] rawJsBytes = rawJs.getBytes(StandardCharsets.UTF_8);
            String rawSha = sha256Hex(rawJsBytes);

            // 8. 双重哈希防抖：仅在源码或目标文件变化时重新压缩并落盘
            Path outPath = Config.jsOutputDir.resolve("synonyms.js").normalize();
            Files.createDirectories(Config.synonymsDir);
            Files.createDirectories(outPath.getParent());
            Path shaStateFile = Config.synonymsDir.resolve("synonyms.sha256");

            if (Files.exists(outPath) && Files.exists(shaStateFile)) {
                String saved = new String(Files.readAllBytes(shaStateFile), StandardCharsets.UTF_8).trim();
                String[] parts = saved.split("\\|");
                if (parts.length == 2 && parts[0].equals(rawSha)) {
                    String currentOutSha = sha256Hex(Files.readAllBytes(outPath));
                    if (parts[1].equals(currentOutSha)) {
//                        logger.info("[Synonyms] 词林与 DF 分桶无变化（公开文档 {}, 活跃词 {}, 耗时 {}ms），跳过重建。",
//                                totalPublicDocs, dfMap.size(), System.currentTimeMillis() - t0);
                        return false;
                    }
                }
            }

            Path rawTempPath = Config.synonymsDir.resolve("synonyms.raw.js");
            Files.write(rawTempPath, rawJsBytes);

            boolean minified = tryMinifyWithEsbuild(rawTempPath, outPath);
            if (!minified) {
                Files.write(outPath, rawJsBytes);
            }

            String outSha = sha256Hex(Files.readAllBytes(outPath));
            Files.write(shaStateFile, (rawSha + "|" + outSha).getBytes(StandardCharsets.UTF_8));

//            logger.info("[Synonyms] 已生成 {} ({} bytes, minified={}, 公开文档={}, 词林等义组={}, 自定义组={}, 单向别名={}, DF标注词次={}, 耗时={}ms)",
//                    outPath.getFileName(),
//                    Files.size(outPath),
//                    minified,
//                    totalPublicDocs,
//                    eqGroupCount,
//                    custom.groups.size(),
//                    custom.aliases.size(),
//                    dfTaggedWordCount,
//                    System.currentTimeMillis() - t0);
            return true;

        } catch (Exception e) {
            logger.error("[Synonyms] 构建 synonyms.js 失败", e);
            return false;
        }
    }

    private static CustomConfig loadCustomConfig(Path path) throws IOException {
        CustomConfig cfg = new CustomConfig();
        if (path == null || !Files.exists(path)) {
            logger.warn("[Synonyms] 未找到 {}，将仅使用基础词林规则。", path);
            return cfg;
        }
        JsonNode root = Utils.JSON_MAPPER.readTree(path.toFile());
        if (root == null || !root.isObject()) return cfg;

        if (root.has("dropEqCodes") && root.get("dropEqCodes").isArray()) {
            for (JsonNode n : root.get("dropEqCodes")) {
                String code = n.asText("").trim();
                if (!code.isEmpty()) cfg.dropEqCodes.add(code);
            }
        }
        if (root.has("pruneWords") && root.get("pruneWords").isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = root.get("pruneWords").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (!e.getValue().isArray()) continue;
                Set<String> set = new HashSet<String>();
                for (JsonNode w : e.getValue()) {
                    String s = toHalfwidth(w.asText("")).trim();
                    if (!s.isEmpty()) set.add(s);
                }
                if (!set.isEmpty()) cfg.pruneWords.put(e.getKey(), set);
            }
        }
        if (root.has("splitFixes") && root.get("splitFixes").isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = root.get("splitFixes").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (!e.getValue().isArray()) continue;
                List<String> parts = new ArrayList<String>();
                for (JsonNode p : e.getValue()) {
                    String s = p.asText("").trim();
                    if (!s.isEmpty()) parts.add(s);
                }
                if (!parts.isEmpty()) cfg.splitFixes.put(e.getKey(), parts);
            }
        }
        if (root.has("stopExpand") && root.get("stopExpand").isArray()) {
            for (JsonNode n : root.get("stopExpand")) {
                String s = toHalfwidth(n.asText("")).trim().toLowerCase(Locale.ROOT);
                if (s.length() >= 2) cfg.stopExpand.add(s);
            }
        }
        if (root.has("groups") && root.get("groups").isArray()) {
            for (JsonNode g : root.get("groups")) {
                if (!g.isObject() || !g.has("words") || !g.get("words").isArray()) continue;
                String c5 = g.has("c5") ? g.get("c5").asText("Zz00Z").trim() : "Zz00Z";
                if (c5.length() >= 5) c5 = c5.substring(0, 5);
                else c5 = "Zz00Z";
                boolean exclusive = !g.has("exclusive") || g.get("exclusive").asBoolean(true);

                List<String> words = new ArrayList<String>();
                Set<String> seen = new HashSet<String>();
                for (JsonNode wn : g.get("words")) {
                    String w = toHalfwidth(wn.asText("")).trim();
                    if (w.length() < 2) continue;
                    String k = w.toLowerCase(Locale.ROOT);
                    if (seen.add(k)) words.add(w);
                }
                if (words.size() >= 2) {
                    cfg.groups.add(new CustomGroup(c5, exclusive, words));
                }
            }
        }
        if (root.has("aliases") && root.get("aliases").isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = root.get("aliases").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                String src = toHalfwidth(e.getKey()).trim();
                if (src.length() < 2 || !e.getValue().isArray()) continue;
                String sk = src.toLowerCase(Locale.ROOT);
                List<String> targets = new ArrayList<String>();
                Set<String> seen = new HashSet<String>();
                for (JsonNode tn : e.getValue()) {
                    String tw = toHalfwidth(tn.asText("")).trim();
                    if (tw.length() < 2) continue;
                    String tk = tw.toLowerCase(Locale.ROOT);
                    if (!tk.equals(sk) && seen.add(tk)) {
                        targets.add(tw);
                    }
                }
                if (!targets.isEmpty()) {
                    cfg.aliases.put(src, targets);
                }
            }
        }
        return cfg;
    }

    private static List<String> tokenizeCilinBody(String body, Map<String, List<String>> splitFixes) {
        List<String> out = new ArrayList<String>();
        for (String tok : WHITESPACE_SPLIT.split(body)) {
            if (tok.isEmpty()) continue;
            List<String> fixed = splitFixes.get(tok);
            if (fixed != null) {
                out.addAll(fixed);
                continue;
            }
            if (tok.indexOf('…') >= 0) {
                for (String p : tok.split("…")) {
                    if (!p.isEmpty()) out.add(p);
                }
                continue;
            }
            if (tok.indexOf('，') >= 0) {
                for (String p : tok.split("，")) {
                    if (!p.isEmpty()) out.add(p);
                }
                continue;
            }
            Matcher m = TAIL_LATIN_SUFFIX.matcher(tok);
            if (m.matches()) {
                tok = m.group(1);
            }
            out.add(tok);
        }
        return out;
    }

    private static void scanDocumentForDfAndOov(
            String rawText,
            Set<String> lexicon,
            int maxLexLen,
            Map<String, Integer> dfMap,
            Map<String, TokenStat> asciiOov,
            Map<String, TokenStat> cjkOov) {

        String norm = toHalfwidth(rawText);
        String lower = norm.toLowerCase(Locale.ROOT);

        List<String> unmatchedCjkRuns = new ArrayList<String>();
        Set<String> seenLex = fmmExtractWords(lower, lexicon, maxLexLen, unmatchedCjkRuns);
        for (String w : seenLex) {
            Integer prev = dfMap.get(w);
            dfMap.put(w, prev == null ? 1 : prev + 1);
        }

        // ASCII 技术词 / 缩写 OOV 扫描
        String noUrl = URL_PATTERN.matcher(norm).replaceAll(" ");
        Matcher am = ASCII_TOKEN_PATTERN.matcher(noUrl);
        Set<String> seenAsciiInDoc = new HashSet<String>();
        while (am.find()) {
            String tok = am.group();
            String tl = tok.toLowerCase(Locale.ROOT);
            if (lexicon.contains(tl) || ASCII_STOP_WORDS.contains(tl)) continue;
            if (SHORT_ALPHA_NUM.matcher(tl).matches()) continue;
            if (tok.length() == 2 && !isAllUpperAscii(tok)) continue;
            boolean isNewDoc = seenAsciiInDoc.add(tl);
            TokenStat stat = asciiOov.get(tl);
            if (stat == null) {
                stat = new TokenStat();
                asciiOov.put(tl, stat);
            }
            stat.record(tok, isNewDoc);
        }

        // 中文 OOV 候选扫描（基于 FMM 未命中残片中的 2~4 字连续中文串）
        Set<String> seenCjkInDoc = new HashSet<String>();
        for (String run : unmatchedCjkRuns) {
            int rlen = run.length();
            if (rlen < 2) continue;
            int maxGram = Math.min(4, rlen);
            for (int L = 2; L <= maxGram; L++) {
                for (int i = 0; i <= rlen - L; i++) {
                    String gram = run.substring(i, i + L);
                    if (lexicon.contains(gram)) continue;
                    if (CJK_EDGE_STOP_SET.contains(gram.charAt(0))
                            || CJK_EDGE_STOP_SET.contains(gram.charAt(L - 1))) {
                        continue;
                    }
                    boolean isNewDoc = seenCjkInDoc.add(gram);
                    TokenStat stat = cjkOov.get(gram);
                    if (stat == null) {
                        stat = new TokenStat();
                        cjkOov.put(gram, stat);
                    }
                    stat.record(gram, isNewDoc);
                }
            }
        }
    }

    private static Set<String> fmmExtractWords(
            String lower,
            Set<String> lexicon,
            int maxLexLen,
            List<String> unmatchedCjkRuns) {

        Set<String> seen = new HashSet<String>();
        int n = lower.length();
        StringBuilder unmatched = unmatchedCjkRuns != null ? new StringBuilder() : null;

        int i = 0;
        while (i < n) {
            boolean matched = false;
            int maxL = Math.min(maxLexLen, n - i);
            for (int L = maxL; L >= 2; L--) {
                String sub = lower.substring(i, i + L);
                if (lexicon.contains(sub)) {
                    seen.add(sub);
                    if (unmatched != null && unmatched.length() > 0) {
                        unmatchedCjkRuns.add(unmatched.toString());
                        unmatched.setLength(0);
                    }
                    i += L;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                char ch = lower.charAt(i);
                if (unmatched != null) {
                    if (ch >= '\u4e00' && ch <= '\u9fff') {
                        unmatched.append(ch);
                    } else if (unmatched.length() > 0) {
                        unmatchedCjkRuns.add(unmatched.toString());
                        unmatched.setLength(0);
                    }
                }
                i++;
            }
        }
        if (unmatched != null && unmatched.length() > 0) {
            unmatchedCjkRuns.add(unmatched.toString());
        }
        return seen;
    }

    @SuppressWarnings("unchecked")
    private static void collectPublicMediaTitles(Object nodeObj, List<String> out) {
        if (!(nodeObj instanceof Map)) return;
        Map<String, Object> map = (Map<String, Object>) nodeObj;
        Object fObj = map.get("_f");
        if (fObj instanceof List) {
            for (Object itemObj : (List<?>) fObj) {
                String fileName = null;
                String info = "";
                if (itemObj instanceof Object[]) {
                    Object[] arr = (Object[]) itemObj;
                    if (arr.length > 0 && arr[0] != null) fileName = String.valueOf(arr[0]);
                    if (arr.length > 3 && arr[3] != null) info = String.valueOf(arr[3]);
                } else if (itemObj instanceof List) {
                    List<?> lst = (List<?>) itemObj;
                    if (!lst.isEmpty() && lst.get(0) != null) fileName = String.valueOf(lst.get(0));
                    if (lst.size() > 3 && lst.get(3) != null) info = String.valueOf(lst.get(3));
                }
                if (fileName == null || info.contains("localOnly")) continue;
                int dot = fileName.lastIndexOf('.');
                String title = dot > 0 ? fileName.substring(0, dot) : fileName;
                if (title.length() >= 2) out.add(title);
            }
        }
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!"_f".equals(e.getKey())) {
                collectPublicMediaTitles(e.getValue(), out);
            }
        }
    }

    private static void writeOovReport(
            int totalPublicDocs,
            Map<String, TokenStat> asciiOov,
            Map<String, TokenStat> cjkOov) {
        try {
            Files.createDirectories(Config.synonymsDir);
            Path reportPath = Config.synonymsDir.resolve("oov_report.txt");

            int minDf = totalPublicDocs >= 50 ? 2 : 1;
            int minTf = totalPublicDocs >= 50 ? 3 : 2;

            List<TokenStat> ascList = new ArrayList<TokenStat>();
            for (TokenStat s : asciiOov.values()) {
                if (s.df >= minDf && s.tf >= minTf) ascList.add(s);
            }
            ascList.sort((a, b) -> {
                int c = Integer.compare(b.df, a.df);
                if (c != 0) return c;
                c = Integer.compare(b.tf, a.tf);
                return c != 0 ? c : a.display.compareToIgnoreCase(b.display);
            });

            List<TokenStat> cjkRaw = new ArrayList<TokenStat>();
            for (TokenStat s : cjkOov.values()) {
                if (s.df >= minDf && s.tf >= minTf) cjkRaw.add(s);
            }
            cjkRaw.sort((a, b) -> {
                int c = Integer.compare(b.df, a.df);
                if (c != 0) return c;
                c = Integer.compare(b.tf, a.tf);
                if (c != 0) return c;
                return Integer.compare(b.display.length(), a.display.length());
            });

            // 抑制被同频/高频更长词完全吸收的残片子串（如 神经网络 吸收 神经网）
            List<TokenStat> cjkFiltered = new ArrayList<TokenStat>();
            for (TokenStat cand : cjkRaw) {
                boolean absorbed = false;
                for (TokenStat kept : cjkFiltered) {
                    if (kept.display.length() > cand.display.length()
                            && kept.display.contains(cand.display)
                            && kept.tf >= cand.tf * 0.7) {
                        absorbed = true;
                        break;
                    }
                }
                if (!absorbed) {
                    cjkFiltered.add(cand);
                    if (cjkFiltered.size() >= 80) break;
                }
            }

            StringBuilder sb = new StringBuilder();
            String now = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
            sb.append("# 本地新词雷达报告 (oov_report.txt) — 仅本地参考，请勿提交或发布\n");
            sb.append("# 生成时间: ").append(now)
              .append(" | 公开统计文档数: ").append(totalPublicDocs)
              .append(" | 筛选阈值: DF >= ").append(minDf).append(", TF >= ").append(minTf).append("\n");
            sb.append("# 用法: 挑出值得扩展的高频词，补入 synonyms_custom.json 的 groups 或 aliases 后重新运行 gen 即可。\n\n");

            sb.append("== [1] 高频未收录英文/技术术语 Top 60 ==\n");
            int ascLimit = Math.min(60, ascList.size());
            for (int i = 0; i < ascLimit; i++) {
                TokenStat s = ascList.get(i);
                sb.append(String.format("%2d. %-24s DF=%-4d TF=%d%n", i + 1, s.display, s.df, s.tf));
            }
            if (ascLimit == 0) sb.append("(暂无达到阈值的候选词)\n");

            sb.append("\n== [2] 高频未收录中文候选词 Top 60 ==\n");
            int cjkLimit = Math.min(60, cjkFiltered.size());
            for (int i = 0; i < cjkLimit; i++) {
                TokenStat s = cjkFiltered.get(i);
                sb.append(String.format("%2d. %-10s DF=%-4d TF=%d%n", i + 1, s.display, s.df, s.tf));
            }
            if (cjkLimit == 0) sb.append("(暂无达到阈值的候选词)\n");

            Files.write(reportPath, sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            logger.warn("[Synonyms] 写入 oov_report.txt 失败", e);
        }
    }

    private static boolean tryMinifyWithEsbuild(Path inputFile, Path outputFile) {
        if (Config.esbuildPath == null || Config.esbuildPath.isEmpty()) return false;
        File esbuild = new File(Config.esbuildPath);
        if (!esbuild.isFile()) return false;

        try {
            ProcessBuilder pb = new ProcessBuilder(
                    esbuild.getAbsolutePath(),
                    inputFile.toAbsolutePath().toString(),
                    "--outfile=" + outputFile.toAbsolutePath().toString(),
                    "--minify",
                    "--target=es2020",
                    "--charset=utf8"
            );
            pb.redirectErrorStream(true);
            Process proc = pb.start();
            StringBuilder logBuf = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    logBuf.append(line).append('\n');
                }
            }
            int code = proc.waitFor();
            if (code == 0 && Files.exists(outputFile)) {
                return true;
            }
            logger.warn("[Synonyms] esbuild 压缩失败 (exit={}): {}", code, logBuf.toString().trim());
        } catch (Exception e) {
            logger.warn("[Synonyms] 调用 esbuild 异常，降级为直接输出未压缩版本", e);
        }
        return false;
    }

    private static int dfToBucket(int df, int totalDocs) {
        if (df <= 0) return 0;
        if (df == 1) return 1;
        if (df <= 3) return 2;
        if (totalDocs <= 0) return 3;
        double ratio = (double) df / (double) totalDocs;
        if (ratio <= 0.08) return 3;
        if (ratio <= 0.20) return 4;
        if (ratio <= 0.40) return 5;
        return 6;
    }

    private static boolean isAllUpperAscii(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 'A' || c > 'Z') return false;
        }
        return !s.isEmpty();
    }

    private static String toHalfwidth(String str) {
        if (str == null || str.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(str.length());
        for (int i = 0; i < str.length(); i++) {
            char ch = str.charAt(i);
            if (ch == '\u3000') {
                sb.append(' ');
            } else if (ch >= '\uFF01' && ch <= '\uFF5E') {
                sb.append((char) (ch - 0xFEE0));
            } else {
                sb.append(ch);
            }
        }
        return sb.toString();
    }

    private static String escapeTemplateLiteral(String s) {
        return s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${");
    }

    private static String safeJsonForJs(String json) {
        return json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(data);
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static String buildJsTemplate() {
        StringBuilder sb = new StringBuilder(32768);
        appendJsTemplatePart1(sb);
        appendJsTemplatePart2(sb);
        return sb.toString();
    }

    private static void appendJsTemplatePart1(StringBuilder sb) {
        sb.append("/**\n");
        sb.append(" * synonyms.js —— 语料 DF 软加权 + 现代词覆盖近义扩展引擎 (v5.0，运行于 Worker 线程)\n");
        sb.append(" * 由 gen.jar (SynonymBuilder) 从 cilin.txt + synonyms_custom.json + 公开语料 DF 自动构建。\n");
        sb.append(" */\n");
        sb.append("\n");
        sb.append("const SYN_ALGO_VERSION = __SYN_ALGO_VERSION__;\n");
        sb.append("const MAX_VARIANTS = 16;\n");
        sb.append("const LRU_CAPACITY = 256;\n");
        sb.append("const MIN_ABS_SCORE = 0.15;\n");
        sb.append("\n");
        sb.append("// DF 分桶表（0 = 公网语料未出现，保留作入口并靠 Bloom 兜底本地私密页与动态评论）\n");
        sb.append("const DF_CAND_MULT = [0.62, 1.00, 1.12, 1.18, 1.00, 0.68, 0.38];\n");
        sb.append("const DF_SENSE_CONTRIB = [0.00, 0.25, 0.45, 0.60, 0.35, 0.10, 0.00];\n");
        sb.append("\n");
        sb.append("const CUSTOM_SYNONYM_GROUPS = __CUSTOM_SYNONYM_GROUPS__;\n");
        sb.append("const CUSTOM_ONEWAY_ALIASES = __CUSTOM_ONEWAY_ALIASES__;\n");
        sb.append("const CILIN_RAW_DATA = `__CILIN_RAW_DATA__`;\n");
        sb.append("\n");
        sb.append("const CJK_CHAR_RE = /[\\u4e00-\\u9fff]/;\n");
        sb.append("const ASCII_ALNUM_RE = /[a-z0-9]/;\n");
        sb.append("\n");
        sb.append("function toHalfwidth(str) {\n");
        sb.append("    let out = \"\";\n");
        sb.append("    for (let i = 0; i < str.length; i++) {\n");
        sb.append("        const code = str.charCodeAt(i);\n");
        sb.append("        if (code === 0x3000) {\n");
        sb.append("            out += \" \";\n");
        sb.append("        } else if (code >= 0xFF01 && code <= 0xFF5E) {\n");
        sb.append("            out += String.fromCharCode(code - 0xFEE0);\n");
        sb.append("        } else {\n");
        sb.append("            out += str.charAt(i);\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("    return out;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// =========================================================================\n");
        sb.append("// 1. 索引构建（流式扫行 + DF 分桶解析 + 单向别名 + FNV 指纹）\n");
        sb.append("// =========================================================================\n");
        sb.append("const eqGroups = [];\n");
        sb.append("const wordToEq = new Map();\n");
        sb.append("const wordToAlias = new Map();\n");
        sb.append("const wordDf = new Map();\n");
        sb.append("const lexicon = new Map();\n");
        sb.append("\n");
        sb.append("let maxLexLen = 2;\n");
        sb.append("let rawLineCount = 0;\n");
        sb.append("\n");
        sb.append("let sigH1 = 0x811c9dc5;\n");
        sb.append("let sigH2 = 0x1b873593;\n");
        sb.append("function feedSig(str) {\n");
        sb.append("    for (let i = 0; i < str.length; i++) {\n");
        sb.append("        const c = str.charCodeAt(i);\n");
        sb.append("        sigH1 = Math.imul(sigH1 ^ c, 0x01000193);\n");
        sb.append("        sigH2 = Math.imul(sigH2 ^ c, 0x85ebca6b) ^ (sigH2 >>> 15);\n");
        sb.append("    }\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function recordWordDf(key, bucket) {\n");
        sb.append("    if (bucket <= 0) return;\n");
        sb.append("    const prev = wordDf.get(key) || 0;\n");
        sb.append("    if (bucket > prev) wordDf.set(key, bucket);\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function parseWordAndDf(tok) {\n");
        sb.append("    const len = tok.length;\n");
        sb.append("    if (len >= 4 && tok.charCodeAt(len - 2) === 58) {\n");
        sb.append("        const d = tok.charCodeAt(len - 1) - 48;\n");
        sb.append("        if (d >= 1 && d <= 6) {\n");
        sb.append("            return { word: tok.slice(0, len - 2), df: d };\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("    return { word: tok, df: 0 };\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function addLexCode(word, code5, isEq) {\n");
        sb.append("    const key = word.toLowerCase();\n");
        sb.append("    if (key.length < 2) return;\n");
        sb.append("    if (key.length > maxLexLen && key.length <= 12) maxLexLen = key.length;\n");
        sb.append("    let entry = lexicon.get(key);\n");
        sb.append("    if (!entry) {\n");
        sb.append("        entry = { eq: !!isEq, codes5: [code5] };\n");
        sb.append("        lexicon.set(key, entry);\n");
        sb.append("    } else {\n");
        sb.append("        if (isEq) entry.eq = true;\n");
        sb.append("        if (entry.codes5.length < 8 && entry.codes5.indexOf(code5) === -1) {\n");
        sb.append("            entry.codes5.push(code5);\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function registerEqGroup(code7, c5, words, isCustom) {\n");
        sb.append("    const gid = eqGroups.length;\n");
        sb.append("    eqGroups.push({\n");
        sb.append("        code: code7,\n");
        sb.append("        c5,\n");
        sb.append("        c1: c5.charAt(0),\n");
        sb.append("        words,\n");
        sb.append("        custom: !!isCustom\n");
        sb.append("    });\n");
        sb.append("    for (let pos = 0; pos < words.length; pos++) {\n");
        sb.append("        const w = words[pos];\n");
        sb.append("        const key = w.toLowerCase();\n");
        sb.append("        let arr = wordToEq.get(key);\n");
        sb.append("        if (!arr) {\n");
        sb.append("            arr = [];\n");
        sb.append("            wordToEq.set(key, arr);\n");
        sb.append("        }\n");
        sb.append("        arr.push({ gid, pos });\n");
        sb.append("        addLexCode(w, c5, true);\n");
        sb.append("    }\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// 1.1 加载自定义双向同义词组（构建期已执行 exclusive 冲突剥离）\n");
        sb.append("for (let i = 0; i < CUSTOM_SYNONYM_GROUPS.length; i++) {\n");
        sb.append("    const entry = CUSTOM_SYNONYM_GROUPS[i];\n");
        sb.append("    const grp = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.words) ? entry.words : null);\n");
        sb.append("    const c5 = (!Array.isArray(entry) && entry && typeof entry.c5 === \"string\" && entry.c5.length >= 5)\n");
        sb.append("        ? entry.c5.slice(0, 5)\n");
        sb.append("        : \"Zz00Z\";\n");
        sb.append("    if (!grp || grp.length < 2) continue;\n");
        sb.append("    const cleaned = [];\n");
        sb.append("    const seen = new Set();\n");
        sb.append("    for (let j = 0; j < grp.length; j++) {\n");
        sb.append("        const w = toHalfwidth(String(grp[j] || \"\")).trim();\n");
        sb.append("        if (w.length < 2) continue;\n");
        sb.append("        const k = w.toLowerCase();\n");
        sb.append("        if (seen.has(k)) continue;\n");
        sb.append("        seen.add(k);\n");
        sb.append("        cleaned.push(w);\n");
        sb.append("    }\n");
        sb.append("    if (cleaned.length >= 2) {\n");
        sb.append("        feedSig(c5 + \":\" + cleaned.join(\"|\"));\n");
        sb.append("        registerEqGroup(\"Zz\" + String(i).padStart(5, \"0\"), c5, cleaned, true);\n");
        sb.append("    }\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// 1.2 加载自定义单向别名（src -> targets，反向不污染）\n");
        sb.append("if (CUSTOM_ONEWAY_ALIASES && typeof CUSTOM_ONEWAY_ALIASES === \"object\") {\n");
        sb.append("    const aliasKeys = Object.keys(CUSTOM_ONEWAY_ALIASES);\n");
        sb.append("    for (let i = 0; i < aliasKeys.length; i++) {\n");
        sb.append("        const rawSrc = toHalfwidth(String(aliasKeys[i] || \"\")).trim();\n");
        sb.append("        if (rawSrc.length < 2) continue;\n");
        sb.append("        const sk = rawSrc.toLowerCase();\n");
        sb.append("        const rawTargets = CUSTOM_ONEWAY_ALIASES[aliasKeys[i]];\n");
        sb.append("        if (!Array.isArray(rawTargets) || rawTargets.length === 0) continue;\n");
        sb.append("        const cleaned = [];\n");
        sb.append("        const seen = new Set();\n");
        sb.append("        for (let j = 0; j < rawTargets.length; j++) {\n");
        sb.append("            const tw = toHalfwidth(String(rawTargets[j] || \"\")).trim();\n");
        sb.append("            if (tw.length < 2) continue;\n");
        sb.append("            const tk = tw.toLowerCase();\n");
        sb.append("            if (tk === sk || seen.has(tk)) continue;\n");
        sb.append("            seen.add(tk);\n");
        sb.append("            cleaned.push(tw);\n");
        sb.append("            addLexCode(tw, \"Zz00A\", false);\n");
        sb.append("        }\n");
        sb.append("        if (cleaned.length > 0) {\n");
        sb.append("            feedSig(\"A:\" + sk + \">\" + cleaned.join(\"|\"));\n");
        sb.append("            wordToAlias.set(sk, cleaned);\n");
        sb.append("            addLexCode(rawSrc, \"Zz00A\", true);\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// 1.3 流式加载预清洗词林数据（含 :1..:6 分桶 DF）\n");
        sb.append("const rawStr = CILIN_RAW_DATA || \"\";\n");
        sb.append("const rawLen = rawStr.length;\n");
        sb.append("feedSig(String(rawLen));\n");
        sb.append("\n");
        sb.append("let lineStart = 0;\n");
        sb.append("while (lineStart < rawLen) {\n");
        sb.append("    let lineEnd = rawStr.indexOf(\"\\n\", lineStart);\n");
        sb.append("    if (lineEnd === -1) lineEnd = rawLen;\n");
        sb.append("    let end = lineEnd;\n");
        sb.append("    if (end > lineStart && rawStr.charCodeAt(end - 1) === 13) end--;\n");
        sb.append("\n");
        sb.append("    if (end > lineStart) {\n");
        sb.append("        const line = rawStr.slice(lineStart, end);\n");
        sb.append("        rawLineCount++;\n");
        sb.append("        feedSig(line);\n");
        sb.append("\n");
        sb.append("        const sep = line.indexOf(\"|\");\n");
        sb.append("        if (sep >= 8) {\n");
        sb.append("            const code7 = line.slice(0, 7);\n");
        sb.append("            const rel = line.charAt(7);\n");
        sb.append("            const c5 = code7.slice(0, 5);\n");
        sb.append("            const rawTokens = line.slice(sep + 1).split(\" \");\n");
        sb.append("            const words = [];\n");
        sb.append("            for (let j = 0; j < rawTokens.length; j++) {\n");
        sb.append("                const tok = rawTokens[j];\n");
        sb.append("                if (!tok) continue;\n");
        sb.append("                const parsed = parseWordAndDf(tok);\n");
        sb.append("                if (parsed.word.length < 2) continue;\n");
        sb.append("                if (parsed.df > 0) recordWordDf(parsed.word.toLowerCase(), parsed.df);\n");
        sb.append("                words.push(parsed.word);\n");
        sb.append("            }\n");
        sb.append("\n");
        sb.append("            if (rel === \"=\" && words.length >= 2) {\n");
        sb.append("                registerEqGroup(code7, c5, words, false);\n");
        sb.append("            } else {\n");
        sb.append("                for (let j = 0; j < words.length; j++) {\n");
        sb.append("                    addLexCode(words[j], c5, false);\n");
        sb.append("                }\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("    lineStart = lineEnd + 1;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("const DATA_SIG = SYN_ALGO_VERSION + \":\" + (sigH1 >>> 0).toString(36) + (sigH2 >>> 0).toString(36);\n");
        sb.append("\n");
        sb.append("// =========================================================================\n");
        sb.append("// 2. 语义树距离、位置显著度、DF 软加权与语素加权辅助函数\n");
        sb.append("// =========================================================================\n");
        sb.append("function lcaLevel5(a, b) {\n");
        sb.append("    if (a === b) return 5;\n");
        sb.append("    if (a.charCodeAt(0) !== b.charCodeAt(0)) return 0;\n");
        sb.append("    if (a.charCodeAt(1) !== b.charCodeAt(1)) return 1;\n");
        sb.append("    if (a.charCodeAt(2) === b.charCodeAt(2) && a.charCodeAt(3) === b.charCodeAt(3)) return 4;\n");
        sb.append("    return 2;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function queryPosSalience(pos, senseCount) {\n");
        sb.append("    if (senseCount <= 1) return 1 / (1 + 0.02 * Math.min(pos, 15));\n");
        sb.append("    return 1 / (1 + 0.07 * Math.min(pos, 15));\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function candPosSalience(pos) {\n");
        sb.append("    return 1 / (1 + 0.18 * Math.log(1 + pos));\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function groupCohesion(len) {\n");
        sb.append("    if (len <= 2) return 0.76;\n");
        sb.append("    if (len === 3) return 0.84;\n");
        sb.append("    if (len <= 12) return 1.0;\n");
        sb.append("    return 1 / (1 + 0.10 * Math.log(len / 12));\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function dfCandMult(key) {\n");
        sb.append("    const b = wordDf.get(key) || 0;\n");
        sb.append("    return DF_CAND_MULT[b] || DF_CAND_MULT[0];\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function senseDfBoost(group, excludeKey) {\n");
        sb.append("    let activity = 0;\n");
        sb.append("    const ws = group.words;\n");
        sb.append("    for (let i = 0; i < ws.length; i++) {\n");
        sb.append("        const k = ws[i].toLowerCase();\n");
        sb.append("        if (k === excludeKey) continue;\n");
        sb.append("        const b = wordDf.get(k) || 0;\n");
        sb.append("        if (b > 0) activity += DF_SENSE_CONTRIB[b];\n");
        sb.append("    }\n");
        sb.append("    return 1 + 0.32 * Math.log(1 + activity);\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function sharedCjkRatio(a, b) {\n");
        sb.append("    if (a.length < 2 || b.length < 2) return 0;\n");
        sb.append("    let hit = 0;\n");
        sb.append("    for (let i = 0; i < a.length; i++) {\n");
        sb.append("        const ch = a[i];\n");
        sb.append("        if (a.indexOf(ch) !== i) continue;\n");
        sb.append("        if (CJK_CHAR_RE.test(ch) && b.indexOf(ch) !== -1) hit++;\n");
        sb.append("    }\n");
        sb.append("    return hit / Math.max(a.length, b.length);\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function contextLcaBoost(c5, ctxCodes5) {\n");
        sb.append("    if (!ctxCodes5 || ctxCodes5.length === 0) return 1.0;\n");
        sb.append("    let best = 0;\n");
        sb.append("    for (let i = 0; i < ctxCodes5.length; i++) {\n");
        sb.append("        const lv = lcaLevel5(c5, ctxCodes5[i]);\n");
        sb.append("        if (lv > best) best = lv;\n");
        sb.append("        if (best === 5) break;\n");
        sb.append("    }\n");
        sb.append("    if (best >= 5) return 1.85;\n");
        sb.append("    if (best >= 4) return 1.45;\n");
        sb.append("    if (best >= 2) return 1.18;\n");
        sb.append("    if (best >= 1) return 1.08;\n");
        sb.append("    return 1.0;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// =========================================================================\n");
        sb.append("// 3. 单词一跳扩展核心（DF 义项消歧 + DF 候选软加权 + 单向别名 + K/L 降权）\n");
        sb.append("// =========================================================================\n");
        sb.append("function expandSingleWord(rawWord, ctxCodes5, isWholeQuery, limit, existsInCorpus) {\n");
        sb.append("    const key = rawWord.toLowerCase();\n");
        sb.append("    const refs = wordToEq.get(key) || [];\n");
        sb.append("    const aliasTargets = wordToAlias.get(key) || null;\n");
        sb.append("    if (refs.length === 0 && (!aliasTargets || aliasTargets.length === 0)) return [];\n");
        sb.append("\n");
        sb.append("    const srcSenseWeights = new Map();\n");
        sb.append("    let hasDisambiguateBoost = false;\n");
        sb.append("    const nonCustomRefs = [];\n");
        sb.append("    for (let i = 0; i < refs.length; i++) {\n");
        sb.append("        if (!eqGroups[refs[i].gid].custom) nonCustomRefs.push(refs[i]);\n");
        sb.append("    }\n");
        sb.append("    const ncCount = nonCustomRefs.length;\n");
        sb.append("\n");
        sb.append("    for (let i = 0; i < refs.length; i++) {\n");
        sb.append("        const { gid, pos } = refs[i];\n");
        sb.append("        const g = eqGroups[gid];\n");
        sb.append("\n");
        sb.append("        let wSense;\n");
        sb.append("        if (g.custom) {\n");
        sb.append("            wSense = 1.5;\n");
        sb.append("        } else {\n");
        sb.append("            wSense = queryPosSalience(pos, ncCount) * groupCohesion(g.words.length) * senseDfBoost(g, key);\n");
        sb.append("            if (g.c1 === \"K\") wSense *= 0.22;\n");
        sb.append("            else if (g.c1 === \"L\") wSense *= 0.55;\n");
        sb.append("            if (ctxCodes5 && ctxCodes5.length > 0) {\n");
        sb.append("                const boost = contextLcaBoost(g.c5, ctxCodes5);\n");
        sb.append("                if (boost >= 1.18) hasDisambiguateBoost = true;\n");
        sb.append("                wSense *= boost;\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("        srcSenseWeights.set(gid, wSense);\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    const wholePolysemy = isWholeQuery && ncCount >= 3;\n");
        sb.append("    const compPolysemy = !isWholeQuery && ncCount >= 3 && !hasDisambiguateBoost;\n");
        sb.append("    const effLimit = compPolysemy\n");
        sb.append("        ? Math.min(limit, 4)\n");
        sb.append("        : (wholePolysemy ? Math.min(limit, ncCount >= 4 ? 6 : 8) : limit);\n");
        sb.append("\n");
        sb.append("    const allowedGids = new Set();\n");
        sb.append("    if (wholePolysemy || compPolysemy) {\n");
        sb.append("        for (let i = 0; i < ncCount; i++) {\n");
        sb.append("            const { gid, pos } = nonCustomRefs[i];\n");
        sb.append("            if (pos > 2) {\n");
        sb.append("                srcSenseWeights.set(gid, srcSenseWeights.get(gid) * (wholePolysemy ? 0.55 : 0.48));\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("        const rankedNc = nonCustomRefs.slice().sort((a, b) =>\n");
        sb.append("            (srcSenseWeights.get(b.gid) - srcSenseWeights.get(a.gid)) || (a.pos - b.pos)\n");
        sb.append("        );\n");
        sb.append("        const maxSenses = (compPolysemy || ncCount >= 4) ? 2 : 3;\n");
        sb.append("        for (let i = 0; i < Math.min(maxSenses, rankedNc.length); i++) {\n");
        sb.append("            allowedGids.add(rankedNc[i].gid);\n");
        sb.append("        }\n");
        sb.append("        for (let i = 0; i < refs.length; i++) {\n");
        sb.append("            if (eqGroups[refs[i].gid].custom) allowedGids.add(refs[i].gid);\n");
        sb.append("        }\n");
        sb.append("    } else {\n");
        sb.append("        for (let i = 0; i < refs.length; i++) allowedGids.add(refs[i].gid);\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    const cands = new Map();\n");
        sb.append("    if (aliasTargets && aliasTargets.length > 0) {\n");
        sb.append("        for (let j = 0; j < aliasTargets.length; j++) {\n");
        sb.append("            const tw = aliasTargets[j];\n");
        sb.append("            const tk = tw.toLowerCase();\n");
        sb.append("            if (tk === key) continue;\n");
        sb.append("            cands.set(tk, {\n");
        sb.append("                word: tw,\n");
        sb.append("                key: tk,\n");
        sb.append("                score: 1.75 - j * 0.03,\n");
        sb.append("                custom: true,\n");
        sb.append("                alias: true,\n");
        sb.append("                bestGid: -2,\n");
        sb.append("                bestGidContrib: 1.75\n");
        sb.append("            });\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    for (let i = 0; i < refs.length; i++) {\n");
        sb.append("        const { gid } = refs[i];\n");
        sb.append("        if (!allowedGids.has(gid)) continue;\n");
        sb.append("        const g = eqGroups[gid];\n");
        sb.append("        const wSense = srcSenseWeights.get(gid);\n");
        sb.append("        const ws = g.words;\n");
        sb.append("\n");
        sb.append("        for (let j = 0; j < ws.length; j++) {\n");
        sb.append("            const cw = ws[j];\n");
        sb.append("            if (cw.length < 2) continue;\n");
        sb.append("            const ck = cw.toLowerCase();\n");
        sb.append("            if (ck === key) continue;\n");
        sb.append("\n");
        sb.append("            let rec = cands.get(ck);\n");
        sb.append("            if (!rec) {\n");
        sb.append("                rec = {\n");
        sb.append("                    word: cw,\n");
        sb.append("                    key: ck,\n");
        sb.append("                    score: 0,\n");
        sb.append("                    custom: false,\n");
        sb.append("                    alias: false,\n");
        sb.append("                    bestGid: -1,\n");
        sb.append("                    bestGidContrib: 0\n");
        sb.append("                };\n");
        sb.append("                cands.set(ck, rec);\n");
        sb.append("            }\n");
        sb.append("            if (g.custom) {\n");
        sb.append("                rec.custom = true;\n");
        sb.append("                rec.alias = false;\n");
        sb.append("            }\n");
        sb.append("            const contrib = wSense * (g.custom ? 1.2 : (candPosSalience(j) * dfCandMult(ck)));\n");
        sb.append("            rec.score += contrib;\n");
        sb.append("            if (contrib > rec.bestGidContrib) {\n");
        sb.append("                rec.bestGidContrib = contrib;\n");
        sb.append("                rec.bestGid = gid;\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    const scored = [];\n");
        sb.append("    for (const rec of cands.values()) {\n");
        sb.append("        if (rec.custom) {\n");
        sb.append("            scored.push({\n");
        sb.append("                word: rec.word,\n");
        sb.append("                key: rec.key,\n");
        sb.append("                score: rec.alias ? Math.min(1.85, rec.score) : Math.min(2.0, 1.5 + rec.score * 0.25),\n");
        sb.append("                custom: true,\n");
        sb.append("                alias: !!rec.alias,\n");
        sb.append("                hop: 1,\n");
        sb.append("                gid: rec.bestGid\n");
        sb.append("            });\n");
        sb.append("            continue;\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        let finalScore = rec.score * (1 + 0.12 * sharedCjkRatio(rawWord, rec.word));\n");
        sb.append("        const lenDiff = Math.abs(rec.word.length - rawWord.length);\n");
        sb.append("        if (rawWord.length <= 2 && rec.word.length >= 4) {\n");
        sb.append("            finalScore *= 0.78;\n");
    }

    private static void appendJsTemplatePart2(StringBuilder sb) {
        sb.append("        } else if (lenDiff >= 3) {\n");
        sb.append("            finalScore *= 0.85;\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        if (finalScore < MIN_ABS_SCORE) continue;\n");
        sb.append("\n");
        sb.append("        scored.push({\n");
        sb.append("            word: rec.word,\n");
        sb.append("            key: rec.key,\n");
        sb.append("            score: finalScore,\n");
        sb.append("            custom: false,\n");
        sb.append("            alias: false,\n");
        sb.append("            hop: 1,\n");
        sb.append("            gid: rec.bestGid\n");
        sb.append("        });\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    scored.sort((a, b) =>\n");
        sb.append("        ((b.custom ? 1 : 0) - (a.custom ? 1 : 0)) ||\n");
        sb.append("        (b.score - a.score) ||\n");
        sb.append("        (a.word.length - b.word.length)\n");
        sb.append("    );\n");
        sb.append("\n");
        sb.append("    let topRegular = 0;\n");
        sb.append("    for (let i = 0; i < scored.length; i++) {\n");
        sb.append("        if (!scored[i].custom) {\n");
        sb.append("            topRegular = scored[i].score;\n");
        sb.append("            break;\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("    const minAccept = Math.max(MIN_ABS_SCORE, topRegular * 0.30);\n");
        sb.append("    const maxPerGroup = allowedGids.size >= 2\n");
        sb.append("        ? Math.max(3, Math.ceil(effLimit * ((wholePolysemy || compPolysemy) ? 0.5 : 0.6)))\n");
        sb.append("        : effLimit;\n");
        sb.append("    const groupCounts = new Map();\n");
        sb.append("    const picked = [];\n");
        sb.append("    const hasCorpusCheck = typeof existsInCorpus === \"function\";\n");
        sb.append("\n");
        sb.append("    for (let i = 0; i < scored.length && picked.length < effLimit; i++) {\n");
        sb.append("        const item = scored[i];\n");
        sb.append("        if (!item.custom) {\n");
        sb.append("            if (item.score < minAccept) continue;\n");
        sb.append("            if (item.gid >= 0 && (groupCounts.get(item.gid) || 0) >= maxPerGroup) continue;\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        if (hasCorpusCheck && !existsInCorpus(item.word)) continue;\n");
        sb.append("\n");
        sb.append("        if (isWholeQuery) {\n");
        sb.append("            if (item.key.indexOf(key) !== -1) continue;\n");
        sb.append("            let redundant = false;\n");
        sb.append("            for (let p = 0; p < picked.length; p++) {\n");
        sb.append("                const pv = picked[p];\n");
        sb.append("                if (item.key.indexOf(pv.key) !== -1 && (!item.custom || pv.custom)) {\n");
        sb.append("                    redundant = true;\n");
        sb.append("                    break;\n");
        sb.append("                }\n");
        sb.append("            }\n");
        sb.append("            if (redundant) continue;\n");
        sb.append("\n");
        sb.append("            for (let p = picked.length - 1; p >= 0; p--) {\n");
        sb.append("                const prev = picked[p];\n");
        sb.append("                if (\n");
        sb.append("                    prev.key.indexOf(item.key) !== -1 &&\n");
        sb.append("                    (!prev.custom || item.custom) &&\n");
        sb.append("                    item.score >= prev.score * 0.75\n");
        sb.append("                ) {\n");
        sb.append("                    picked.splice(p, 1);\n");
        sb.append("                    if (prev.gid >= 0) {\n");
        sb.append("                        groupCounts.set(prev.gid, Math.max(0, (groupCounts.get(prev.gid) || 1) - 1));\n");
        sb.append("                    }\n");
        sb.append("                }\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        picked.push(item);\n");
        sb.append("        if (item.gid >= 0) {\n");
        sb.append("            groupCounts.set(item.gid, (groupCounts.get(item.gid) || 0) + 1);\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    return picked;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// =========================================================================\n");
        sb.append("// 4. 全词表 DP 最优分词（2+2 优于 3+1 + 空格硬边界 + 英文词边界保护）\n");
        sb.append("// =========================================================================\n");
        sb.append("function hasValidAsciiBoundary(lower, start, end) {\n");
        sb.append("    if (ASCII_ALNUM_RE.test(lower.charAt(start)) && start > 0 && ASCII_ALNUM_RE.test(lower.charAt(start - 1))) {\n");
        sb.append("        return false;\n");
        sb.append("    }\n");
        sb.append("    if (ASCII_ALNUM_RE.test(lower.charAt(end - 1)) && end < lower.length && ASCII_ALNUM_RE.test(lower.charAt(end))) {\n");
        sb.append("        return false;\n");
        sb.append("    }\n");
        sb.append("    return true;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function segmentChunkDP(chunk, offset) {\n");
        sb.append("    const lower = chunk.toLowerCase();\n");
        sb.append("    const n = lower.length;\n");
        sb.append("    const dp = new Float64Array(n + 1);\n");
        sb.append("    const prev = new Int32Array(n + 1);\n");
        sb.append("    const prevType = new Int8Array(n + 1);\n");
        sb.append("    prev.fill(-1);\n");
        sb.append("\n");
        sb.append("    for (let i = 0; i < n; i++) {\n");
        sb.append("        if (dp[i] >= dp[i + 1]) {\n");
        sb.append("            dp[i + 1] = dp[i];\n");
        sb.append("            prev[i + 1] = i;\n");
        sb.append("            prevType[i + 1] = 0;\n");
        sb.append("        }\n");
        sb.append("        const maxEnd = Math.min(n, i + maxLexLen);\n");
        sb.append("        for (let j = i + 2; j <= maxEnd; j++) {\n");
        sb.append("            if (!hasValidAsciiBoundary(lower, i, j)) continue;\n");
        sb.append("            const sub = lower.slice(i, j);\n");
        sb.append("            const lex = lexicon.get(sub);\n");
        sb.append("            if (!lex) continue;\n");
        sb.append("            const len = j - i;\n");
        sb.append("            const gain = len * 2.0 + (len - 1) * 0.8 + (lex.eq ? 0.30 : 0.10);\n");
        sb.append("            const cand = dp[i] + gain;\n");
        sb.append("            if (cand > dp[j]) {\n");
        sb.append("                dp[j] = cand;\n");
        sb.append("                prev[j] = i;\n");
        sb.append("                prevType[j] = lex.eq ? 2 : 1;\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    const spans = [];\n");
        sb.append("    let cur = n;\n");
        sb.append("    while (cur > 0) {\n");
        sb.append("        const p = prev[cur];\n");
        sb.append("        if (p < 0) break;\n");
        sb.append("        if (prevType[cur] > 0) {\n");
        sb.append("            const text = chunk.slice(p, cur);\n");
        sb.append("            const lex = lexicon.get(text.toLowerCase());\n");
        sb.append("            spans.push({\n");
        sb.append("                start: offset + p,\n");
        sb.append("                end: offset + cur,\n");
        sb.append("                text,\n");
        sb.append("                eq: prevType[cur] === 2,\n");
        sb.append("                codes5: lex ? lex.codes5 : []\n");
        sb.append("            });\n");
        sb.append("        }\n");
        sb.append("        cur = p;\n");
        sb.append("    }\n");
        sb.append("    spans.reverse();\n");
        sb.append("    return spans;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function segmentQueryChunksDP(chunks) {\n");
        sb.append("    const spans = [];\n");
        sb.append("    let offset = 0;\n");
        sb.append("    for (let i = 0; i < chunks.length; i++) {\n");
        sb.append("        const chunk = chunks[i];\n");
        sb.append("        const part = segmentChunkDP(chunk, offset);\n");
        sb.append("        for (let j = 0; j < part.length; j++) spans.push(part[j]);\n");
        sb.append("        offset += chunk.length;\n");
        sb.append("    }\n");
        sb.append("    return spans;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("// =========================================================================\n");
        sb.append("// 5. 顶层查询扩展入口（绝对置信度权重映射 + 语料 Bloom 非词校验）\n");
        sb.append("// =========================================================================\n");
        sb.append("const queryCache = new Map();\n");
        sb.append("\n");
        sb.append("function clearSynonymCache() {\n");
        sb.append("    queryCache.clear();\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function toWeightedSpecs(detail) {\n");
        sb.append("    const specs = [];\n");
        sb.append("    for (let i = 0; i < detail.length; i++) {\n");
        sb.append("        const it = detail[i];\n");
        sb.append("        if (it.custom && !it.dual) {\n");
        sb.append("            specs.push({ text: it.word, weight: it.alias ? 85 : 88, maxNoise: 0, tier: 1 });\n");
        sb.append("            continue;\n");
        sb.append("        }\n");
        sb.append("        if (!it.custom && it.score < MIN_ABS_SCORE) continue;\n");
        sb.append("        const absNorm = Math.min(1, Math.max(0, (it.score - MIN_ABS_SCORE) / (0.85 - MIN_ABS_SCORE)));\n");
        sb.append("        if (it.dual) {\n");
        sb.append("            specs.push({\n");
        sb.append("                text: it.word,\n");
        sb.append("                weight: Math.round(25 + 30 * absNorm),\n");
        sb.append("                maxNoise: 0,\n");
        sb.append("                tier: 2\n");
        sb.append("            });\n");
        sb.append("        } else {\n");
        sb.append("            specs.push({\n");
        sb.append("                text: it.word,\n");
        sb.append("                weight: Math.round(35 + 45 * absNorm),\n");
        sb.append("                maxNoise: 0,\n");
        sb.append("                tier: 1\n");
        sb.append("            });\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("    return specs;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function computeExpand(rawQuery, maxVariants, existsInCorpus) {\n");
        sb.append("    const trimmed = toHalfwidth(String(rawQuery || \"\")).trim();\n");
        sb.append("    if (!trimmed) return { variants: [], items: [], detail: [] };\n");
        sb.append("\n");
        sb.append("    const chunks = trimmed.split(/\\s+/).filter(Boolean);\n");
        sb.append("    const clean = chunks.join(\"\");\n");
        sb.append("    if (clean.length < 2) return { variants: [], items: [], detail: [] };\n");
        sb.append("    const cleanLower = clean.toLowerCase();\n");
        sb.append("\n");
        sb.append("    // 情况 A：单块整词直接命中 '='、自定义词库或单向别名\n");
        sb.append("    if (chunks.length === 1 && (wordToEq.has(cleanLower) || wordToAlias.has(cleanLower))) {\n");
        sb.append("        const items = expandSingleWord(clean, null, true, maxVariants, existsInCorpus);\n");
        sb.append("        return {\n");
        sb.append("            variants: items.map(x => x.word),\n");
        sb.append("            items: toWeightedSpecs(items),\n");
        sb.append("            detail: items\n");
        sb.append("        };\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    // 情况 B：单块整词恰好是 '#' 或 '@' 独立词/专名（含 stopExpand 保护词），不拆开乱扩\n");
        sb.append("    if (chunks.length === 1 && lexicon.has(cleanLower)) {\n");
        sb.append("        return { variants: [], items: [], detail: [] };\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    // 情况 C：按空白分块执行 DP 最优切分 + 全句共享上下文消歧\n");
        sb.append("    const spans = segmentQueryChunksDP(chunks);\n");
        sb.append("    const expandable = spans.filter(s => s.eq);\n");
        sb.append("    if (expandable.length === 0) return { variants: [], items: [], detail: [] };\n");
        sb.append("\n");
        sb.append("    const perSpanCands = expandable.map(sp => {\n");
        sb.append("        const ctxCodes = [];\n");
        sb.append("        for (let i = 0; i < spans.length; i++) {\n");
        sb.append("            if (spans[i] === sp) continue;\n");
        sb.append("            const cs = spans[i].codes5;\n");
        sb.append("            for (let j = 0; j < cs.length; j++) ctxCodes.push(cs[j]);\n");
        sb.append("        }\n");
        sb.append("        const perLimit = expandable.length === 1 ? maxVariants : Math.min(10, maxVariants);\n");
        sb.append("        const items = expandSingleWord(sp.text, ctxCodes, false, perLimit, existsInCorpus);\n");
        sb.append("        return { span: sp, items };\n");
        sb.append("    }).filter(x => x.items.length > 0);\n");
        sb.append("\n");
        sb.append("    if (perSpanCands.length === 0) return { variants: [], items: [], detail: [] };\n");
        sb.append("\n");
        sb.append("    const hasCorpusCheck = typeof existsInCorpus === \"function\";\n");
        sb.append("    const composed = [];\n");
        sb.append("\n");
        sb.append("    // C.1 单槽替换\n");
        sb.append("    for (let i = 0; i < perSpanCands.length; i++) {\n");
        sb.append("        const { span, items } = perSpanCands[i];\n");
        sb.append("        const prefix = clean.slice(0, span.start);\n");
        sb.append("        const suffix = clean.slice(span.end);\n");
        sb.append("        for (let j = 0; j < items.length; j++) {\n");
        sb.append("            const it = items[j];\n");
        sb.append("            const w = prefix + it.word + suffix;\n");
        sb.append("            const k = w.toLowerCase();\n");
        sb.append("            if (hasCorpusCheck) {\n");
        sb.append("                if (!lexicon.has(k) && !existsInCorpus(w)) continue;\n");
        sb.append("            } else if (!it.custom && it.score < 0.25 && !lexicon.has(k)) {\n");
        sb.append("                continue;\n");
        sb.append("            }\n");
        sb.append("            composed.push({\n");
        sb.append("                word: w,\n");
        sb.append("                key: k,\n");
        sb.append("                score: it.score * (1 + 0.06 * Math.min(span.text.length, 4)),\n");
        sb.append("                custom: !!it.custom,\n");
        sb.append("                alias: !!it.alias,\n");
        sb.append("                hop: 1,\n");
        sb.append("                dual: false,\n");
        sb.append("                from: span.text + \"→\" + it.word\n");
        sb.append("            });\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    // C.2 双槽联合替换：仅保留词表词或语料 Bloom 命中的组合\n");
        sb.append("    if (perSpanCands.length >= 2) {\n");
        sb.append("        const ranked = perSpanCands\n");
        sb.append("            .map((entry, idx) => ({\n");
        sb.append("                entry,\n");
        sb.append("                idx,\n");
        sb.append("                priority:\n");
        sb.append("                    entry.span.text.length * 0.5 +\n");
        sb.append("                    Math.min(entry.items[0].score, 2.0) +\n");
        sb.append("                    (entry.items[0].custom ? 0.6 : 0)\n");
        sb.append("            }))\n");
        sb.append("            .sort((x, y) => (y.priority - x.priority) || (y.idx - x.idx));\n");
        sb.append("\n");
        sb.append("        let a = ranked[0].entry;\n");
        sb.append("        let b = ranked[1].entry;\n");
        sb.append("        if (a.span.start > b.span.start) {\n");
        sb.append("            const tmp = a;\n");
        sb.append("            a = b;\n");
        sb.append("            b = tmp;\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        const topA = a.items.slice(0, 3);\n");
        sb.append("        const topB = b.items.slice(0, 3);\n");
        sb.append("        const p1 = clean.slice(0, a.span.start);\n");
        sb.append("        const mid = clean.slice(a.span.end, b.span.start);\n");
        sb.append("        const p3 = clean.slice(b.span.end);\n");
        sb.append("\n");
        sb.append("        for (let i = 0; i < topA.length; i++) {\n");
        sb.append("            for (let j = 0; j < topB.length; j++) {\n");
        sb.append("                const w = p1 + topA[i].word + mid + topB[j].word + p3;\n");
        sb.append("                const k = w.toLowerCase();\n");
        sb.append("                if (!lexicon.has(k) && !(hasCorpusCheck && existsInCorpus(w))) continue;\n");
        sb.append("                const sA = Math.min(topA[i].score, 1.0);\n");
        sb.append("                const sB = Math.min(topB[j].score, 1.0);\n");
        sb.append("                const dualScore = Math.min(sA, sB) * 0.80;\n");
        sb.append("                if (dualScore < MIN_ABS_SCORE && !(topA[i].custom && topB[j].custom)) continue;\n");
        sb.append("                composed.push({\n");
        sb.append("                    word: w,\n");
        sb.append("                    key: k,\n");
        sb.append("                    score: dualScore,\n");
        sb.append("                    custom: !!(topA[i].custom && topB[j].custom),\n");
        sb.append("                    alias: false,\n");
        sb.append("                    hop: 1,\n");
        sb.append("                    dual: true,\n");
        sb.append("                    from: a.span.text + \"→\" + topA[i].word + \" & \" + b.span.text + \"→\" + topB[j].word\n");
        sb.append("                });\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    composed.sort((x, y) =>\n");
        sb.append("        ((y.custom ? 1 : 0) - (x.custom ? 1 : 0)) ||\n");
        sb.append("        ((x.dual ? 1 : 0) - (y.dual ? 1 : 0)) ||\n");
        sb.append("        (y.score - x.score)\n");
        sb.append("    );\n");
        sb.append("\n");
        sb.append("    const picked = [];\n");
        sb.append("    for (let i = 0; i < composed.length && picked.length < maxVariants; i++) {\n");
        sb.append("        const c = composed[i];\n");
        sb.append("        if (c.key === cleanLower || c.key.indexOf(cleanLower) !== -1) continue;\n");
        sb.append("\n");
        sb.append("        let dup = false;\n");
        sb.append("        for (let p = 0; p < picked.length; p++) {\n");
        sb.append("            const pv = picked[p];\n");
        sb.append("            if (c.key === pv.key) {\n");
        sb.append("                dup = true;\n");
        sb.append("                break;\n");
        sb.append("            }\n");
        sb.append("            if (c.key.indexOf(pv.key) !== -1 && (!c.custom || pv.custom) && (!pv.dual || c.dual)) {\n");
        sb.append("                dup = true;\n");
        sb.append("                break;\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("        if (dup) continue;\n");
        sb.append("\n");
        sb.append("        for (let p = picked.length - 1; p >= 0; p--) {\n");
        sb.append("            const prev = picked[p];\n");
        sb.append("            if (\n");
        sb.append("                prev.key.indexOf(c.key) !== -1 &&\n");
        sb.append("                (!prev.custom || c.custom) &&\n");
        sb.append("                (!c.dual || prev.dual) &&\n");
        sb.append("                c.score >= prev.score * 0.75\n");
        sb.append("            ) {\n");
        sb.append("                picked.splice(p, 1);\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("\n");
        sb.append("        picked.push(c);\n");
        sb.append("    }\n");
        sb.append("\n");
        sb.append("    return {\n");
        sb.append("        variants: picked.map(x => x.word),\n");
        sb.append("        items: toWeightedSpecs(picked),\n");
        sb.append("        detail: picked\n");
        sb.append("    };\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function expandQuery(query, options) {\n");
        sb.append("    const limit = (options && typeof options.maxVariants === \"number\" && options.maxVariants > 0)\n");
        sb.append("        ? Math.min(32, Math.floor(options.maxVariants))\n");
        sb.append("        : MAX_VARIANTS;\n");
        sb.append("    const existsInCorpus = options && typeof options.existsInCorpus === \"function\"\n");
        sb.append("        ? options.existsInCorpus\n");
        sb.append("        : null;\n");
        sb.append("    const tag = (options && options.cacheTag ? String(options.cacheTag) : (existsInCorpus ? \"b\" : \"0\"));\n");
        sb.append("    const norm = toHalfwidth(String(query || \"\")).trim().toLowerCase().replace(/\\s+/g, \" \");\n");
        sb.append("    const cacheKey = limit + \"|\" + tag + \"|\" + norm;\n");
        sb.append("    const hit = queryCache.get(cacheKey);\n");
        sb.append("    if (hit) {\n");
        sb.append("        queryCache.delete(cacheKey);\n");
        sb.append("        queryCache.set(cacheKey, hit);\n");
        sb.append("        return { variants: hit.variants.slice(), items: hit.items.slice() };\n");
        sb.append("    }\n");
        sb.append("    const res = computeExpand(query, limit, existsInCorpus);\n");
        sb.append("    queryCache.set(cacheKey, res);\n");
        sb.append("    if (queryCache.size > LRU_CAPACITY) {\n");
        sb.append("        queryCache.delete(queryCache.keys().next().value);\n");
        sb.append("    }\n");
        sb.append("    return { variants: res.variants.slice(), items: res.items.slice() };\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("function debugExpandQuery(query, maxVariants = MAX_VARIANTS, options = null) {\n");
        sb.append("    const existsInCorpus = options && typeof options.existsInCorpus === \"function\"\n");
        sb.append("        ? options.existsInCorpus\n");
        sb.append("        : null;\n");
        sb.append("    return computeExpand(query, maxVariants, existsInCorpus);\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("const synonymIndex = {\n");
        sb.append("    version: SYN_ALGO_VERSION,\n");
        sb.append("    sig: DATA_SIG,\n");
        sb.append("    maxVariants: MAX_VARIANTS,\n");
        sb.append("    groups: [DATA_SIG],\n");
        sb.append("    stats: {\n");
        sb.append("        eqGroups: eqGroups.length,\n");
        sb.append("        aliases: wordToAlias.size,\n");
        sb.append("        dfWords: wordDf.size,\n");
        sb.append("        lexiconSize: lexicon.size,\n");
        sb.append("        rawLines: rawLineCount\n");
        sb.append("    }\n");
        sb.append("};\n");
        sb.append("\n");
        sb.append("if (typeof globalThis !== \"undefined\") {\n");
        sb.append("    globalThis.expandQuery = expandQuery;\n");
        sb.append("    globalThis.debugExpandQuery = debugExpandQuery;\n");
        sb.append("    globalThis.clearSynonymCache = clearSynonymCache;\n");
        sb.append("    globalThis.synonymIndex = synonymIndex;\n");
        sb.append("}\n");
        sb.append("\n");
        sb.append("export { expandQuery, debugExpandQuery, clearSynonymCache, synonymIndex };\n");
        sb.append("\n");
    }
}
