import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Objects;

public class BookmarkManager {

    public static void run(String[] args) throws Exception {
        if (args.length < 1) {
            throw new IllegalArgumentException("缺少参数：应传入 Base64 编码的 blockId|title|href");
        }

        // 解码参数
        String decoded = Utils.decodeBase64(args[0]);
        String[] parts = decoded.split("\\|", 3);
        if (parts.length < 3) {
            throw new IllegalArgumentException("参数格式错误，应为 blockId|title|href，当前为：" + decoded);
        }

        String blockId = parts[0].trim();
        String xTitle = parts[1].trim();
        String xHref = parts[2].trim();
        if (xTitle.isEmpty()) xTitle = xHref;

        // 读取 bookmark.html 模板
        Path bookmarkHtml = Config.buildRoot.resolve(Config.props.getProperty("bookmarkHtml"));
        Document doc = Jsoup.parse(bookmarkHtml.toFile(), "UTF-8");

        // 查找匹配的 <a> 标签
        Element matchedA = null;
        for (Element a : doc.select("a")) {
            if (a.attr("href").trim().equals(xHref)) {
                matchedA = a;
                break;
            }
        }

        if ("del".equals(blockId)) {
            // 情况 1：删除标签
            if (matchedA != null) {
                Element next = matchedA.nextElementSibling();
                matchedA.remove();
                if (next != null && next.tagName().equalsIgnoreCase("br")) {
                    next.remove();
                }
                Files.write(bookmarkHtml, doc.outerHtml().getBytes(StandardCharsets.UTF_8), StandardOpenOption.TRUNCATE_EXISTING);
            }
        } else {
            // 非删除操作，找到目标块
            Element targetBlock = doc.getElementById(blockId);
            if (targetBlock == null) {
                throw new IllegalArgumentException("未找到指定块ID: " + blockId);
            }

            if (matchedA != null) {
                // 同块置顶 与 不同块移动 逻辑
                Element next = matchedA.nextElementSibling();
                matchedA.remove();
                if (next != null && next.tagName().equalsIgnoreCase("br")) next.remove();

                Element newA = doc.createElement("a");
                newA.text(xTitle);
                newA.attr("href", xHref);
                newA.attr("target", "_blank");

                Element br = doc.createElement("br");
                targetBlock.prependChild(br);
                targetBlock.prependChild(newA);
            } else {
                // 情况 2：新增标签
                Element newA = doc.createElement("a");
                newA.text(xTitle);
                newA.attr("href", xHref);
                newA.attr("target", "_blank");
                Element br = doc.createElement("br");

                targetBlock.prependChild(br);
                targetBlock.prependChild(newA);
            }
        }

        // 写回文件，并更新 end_flag 强刷前端
        Objects.requireNonNull(doc.getElementById("end_flag")).attr("href", String.valueOf(System.currentTimeMillis()));
        Files.write(bookmarkHtml, doc.outerHtml().getBytes(StandardCharsets.UTF_8), StandardOpenOption.TRUNCATE_EXISTING);
    }
}