import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Arrays;

public class Gen {
    private static final Logger logger = LoggerFactory.getLogger(Gen.class);

    public static void main(String[] args) {
        try {
            Config.init(); 

            if (args.length == 0) {
                Generator.run();
            } else {
                String toolName = args[0].toLowerCase();
                String[] toolArgs = Arrays.copyOfRange(args, 1, args.length);

                switch (toolName) {
                    case "tray": VPNHeartbeatTray.run(toolArgs); break;
                    case "webp": WebpConverter.run(toolArgs); break;
                    case "new": HtmlCreator.run(toolArgs); break;
                    case "bookmark": BookmarkManager.run(toolArgs); break;
                    case "keep2html": Keep2HtmlConverter.run(toolArgs); break;
                    case "stamp": Stamper.run(toolArgs); break;
                    default: logger.warn("Unknown tool entry: {}", toolName); break;
                }
            }
        } catch (Exception e) {
            logger.error("发生致命错误: ", e);
        }
    }
}
