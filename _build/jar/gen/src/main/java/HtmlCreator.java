import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public class HtmlCreator {
    private static final Logger logger = LoggerFactory.getLogger(HtmlCreator.class);

    public static void run(String[] args) throws IOException {
        if (args.length < 2) {
            logger.error("Usage: java HtmlCreator <base64_title> <base64_category>");
            return;
        }

        String title = Utils.decodeBase64(args[0]);
        String category = Utils.decodeBase64(args[1]);

        Path templateHtml = Config.buildRoot.resolve(Config.props.getProperty("templateHtml"));

        if (!Files.exists(Config.htmlDir)) {
            logger.error("HTML directory does not exist: {}", Config.htmlDir);
            return;
        }
        if (!Files.exists(templateHtml)) {
            logger.error("Template file not found: {}", templateHtml);
            return;
        }

        Document doc = Jsoup.parse(templateHtml.toFile(), "UTF-8");
        doc.title(title);

        Element anchor = doc.getElementById("anchor");
        if (anchor == null) {
            logger.error("No <span id=\"anchor\"> found in template.");
            return;
        }

        // 动态注入当前时间戳
        String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
        anchor.text(timestamp + "-" + category);

        Path outputFilePath = Config.htmlDir.resolve(title + ".html");
        try (BufferedWriter writer = Files.newBufferedWriter(outputFilePath, StandardCharsets.UTF_8)) {
            writer.write(doc.outerHtml());
        }
    }
}
