import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class Config {
    public static final String CONFIG_FILE = "config.properties";

    public static final String PATH_GITIGNORE = "../.gitignore";
    public static final String PATH_CORE_BUNDLE_OUT = "../src/js/data/core-bundle.json";
    public static final String WEB_ROUTE_DATA = "/src/js/data/";
    public static final String WEB_ROUTE_FAT_DATA_PREFIX = "/src/js/data/fat_data_";
    public static final String WEB_ROUTE_CORE_LIST = "/src/js/core-list.js";

    public static final String FILE_LITE_DATA = "lite_data.js";
    public static final String FILE_FAT_DATA_PREFIX = "fat_data_";
    public static final String FILE_CORE_LIST = "core-list.js";
    public static final String FILE_CORE_BUNDLE = "core-bundle.json";
    public static final String FILE_SW_JS = "sw.js";

    public static final String PATH_UNCATEGORIZED = "html/未分类/";
    public static final String PREFIX_HTML = "html/";
    public static final String PREFIX_GALLERY = "gallery/";
    public static final String PREFIX_VIDEO = "video/";
    public static final String PREFIX_AUDIO = "audio/";
    public static final String PREFIX_EBOOK = "ebook/";

    /** credentials.json 路径（相对工作目录或绝对路径） */
    public static final String CREDENTIALS_FILE = "secrets/credentials.json";
    /** token 持久化目录（会生成 StoredCredential） */
    public static final String TOKENS_DIR = "secrets/tokens";
    /** 临期任务 JSON 输出路径 */
    public static final String TASKS_JSON_PATH = "secrets/upcoming_tasks.json";
    /** 拉取间隔（毫秒），例如 5 分钟 */
    public static final long TASKS_POLL_INTERVAL_MS = 5 * 60 * 1000L;
    /** 临期窗口：未来 N 天内的任务（含已过期未完成） */
    public static final int DUE_WITHIN_DAYS = 7;


    public static Path buildRoot;
    public static Path htmlDir;
    public static Path galleryDir;
    public static Path audioDir;
    public static Path videoDir;
    public static Path ebookDir;
    public static Path dataDir;
    public static Path indexHtml;
    public static Path jsInputDir;
    public static File cmtMapper;
    public static Path tempDir;

    public static List<Pattern> excludePatterns;
    public static List<String> galleryDirExcludeDirs;
    public static List<String> audioDirExcludeDirs;
    public static List<String> videoDirExcludeDirs;
    public static List<String> ebookDirExcludeDirs;

    public static int sliceSize;
    public static String urlToCheck;
    public static String cwebpPath;
    public static String webpOutputDir2;
    public static Properties props = new Properties();

    public static void init() throws IOException {
        try {
            Path jarDir = Paths.get(Config.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
            if (jarDir != null && jarDir.getFileName() != null && jarDir.getFileName().toString().equals("jar")) {
                buildRoot = jarDir.getParent();
            } else {
                buildRoot = jarDir != null ? jarDir : Paths.get(".");
            }
        } catch (Exception e) {
            buildRoot = Paths.get(".");
        }

        try (InputStream input = Files.newInputStream(buildRoot.resolve(CONFIG_FILE))) {
            props.load(input);
        }

        htmlDir = buildRoot.resolve(props.getProperty("htmlDir"));
        galleryDir = buildRoot.resolve(props.getProperty("galleryDir"));
        audioDir = buildRoot.resolve(props.getProperty("audioDir"));
        videoDir = buildRoot.resolve(props.getProperty("videoDir"));
        ebookDir = buildRoot.resolve(props.getProperty("ebookDir"));
        dataDir = buildRoot.resolve(props.getProperty("dataDir"));
        indexHtml = buildRoot.resolve(props.getProperty("indexHtml"));
        jsInputDir = buildRoot.resolve(props.getProperty("js_input_dir"));
        cmtMapper = buildRoot.resolve(props.getProperty("cmt_mapper")).toFile();
        tempDir = buildRoot.resolve(props.getProperty("tempDir", "temp"));

        urlToCheck = props.getProperty("URL_TO_CHECK", "http://diff4x.github.io/ping.txt");
        cwebpPath = buildRoot.resolve(props.getProperty("cwebpPath")).normalize().toAbsolutePath().toString();
        String op2 = props.getProperty("gallery_img_outputDir2", "");
        webpOutputDir2 = op2.isEmpty() ? "" : buildRoot.resolve(op2).toAbsolutePath().toString();

        excludePatterns = Arrays.stream(props.getProperty("exclude", "").split("\\|"))
                .map(String::trim).filter(s -> !s.isEmpty()).map(Pattern::compile).collect(Collectors.toList());

        galleryDirExcludeDirs = Arrays.stream(props.getProperty("galleryDirExcludeDirs", "").split("\\|")).map(String::trim).collect(Collectors.toList());
        audioDirExcludeDirs = Arrays.stream(props.getProperty("audioDirExcludeDirs", "").split("\\|")).map(String::trim).collect(Collectors.toList());
        videoDirExcludeDirs = Arrays.stream(props.getProperty("videoDirExcludeDirs", "").split("\\|")).map(String::trim).collect(Collectors.toList());
        ebookDirExcludeDirs = Arrays.stream(props.getProperty("ebookDirExcludeDirs", "").split("\\|")).map(String::trim).collect(Collectors.toList());

        sliceSize = Integer.parseInt(props.getProperty("sliceSize", "1024")) * 1024;
    }
}