import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public class Utils {
    private static final Logger logger = LoggerFactory.getLogger(Utils.class);
    public static final ObjectMapper JSON_MAPPER = new ObjectMapper();

    public static String decodeBase64(String base64) {
        if (base64 == null || base64.isEmpty()) return "";
        return new String(Base64.getDecoder().decode(base64), StandardCharsets.UTF_8);
    }

    public static void executeCmdCommand(String label, String command) {
        new Thread(() -> {
            try {
                ProcessBuilder builder = new ProcessBuilder("cmd.exe", "/c", command);
                builder.redirectErrorStream(true);
                Process process = builder.start();
                process.waitFor();
            } catch (Exception ex) {
                logger.error("Failed to execute CMD command: {}", command, ex);
            }
        }).start();
    }
}
