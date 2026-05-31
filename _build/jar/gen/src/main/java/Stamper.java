import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Stamper {
    private static final Logger logger = LoggerFactory.getLogger(Stamper.class);

    public static void run(String[] args) throws IOException {
        if (args.length < 1) {
            logger.warn("缺少参数：传入的文件名为空");
            return;
        }

        String fileName = Utils.decodeBase64(args[0]) + ".html";
        Path htmlFile = Config.htmlDir.resolve(fileName);

        if (!Files.exists(htmlFile)) {
            logger.error("文件未找到: " + htmlFile.toAbsolutePath());
            return;
        }

        // 读取 HTML 文件
        String content = new String(Files.readAllBytes(htmlFile), StandardCharsets.UTF_8);
        Pattern pattern = Pattern.compile("<span id=\"anchor\">(\\d{14})-(.*?)</span>");
        Matcher matcher = pattern.matcher(content);

        // 替换 14 位时间戳
        if (matcher.find()) {
            String newTimestamp = new SimpleDateFormat("yyyyMMddHHmmss").format(new Date());
            String replacement = "<span id=\"anchor\">" + newTimestamp + "-" + matcher.group(2) + "</span>";
            content = matcher.replaceFirst(replacement);
            Files.write(htmlFile, content.getBytes(StandardCharsets.UTF_8));
        } else {
            logger.error("未找到 anchor 标签，无法更新时间戳: {}", fileName);
        }
    }
}