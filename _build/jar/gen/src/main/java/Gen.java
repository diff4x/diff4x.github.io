import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.util.Arrays;

public class Gen {
    private static final Logger logger = LoggerFactory.getLogger(Gen.class);

    public static void main(String[] args) {
        try {
            Config.init();

            if (args.length == 0) {
                clearGenStatus();
                Generator.run();
                writeGenStatus("OK");
            } else {
                String toolName = args[0].toLowerCase();
                String[] toolArgs = Arrays.copyOfRange(args, 1, args.length);

                switch (toolName) {
                    case "tray":
                        // 必须在任何 OAuth / Google 代码之前
                        if (relaunchWithJavawAndExit(args)) {
                            return;
                        }
                        detachConsoleIo();
                        VPNHeartbeatTray.run(toolArgs);
                        break;
                    case "webp":
                        WebpConverter.run(toolArgs);
                        break;
                    case "new":
                        HtmlCreator.run(toolArgs);
                        break;
                    case "bookmark":
                        BookmarkManager.run(toolArgs);
                        break;
                    case "keep2html":
                        Keep2HtmlConverter.run(toolArgs);
                        break;
                    case "stamp":
                        Stamper.run(toolArgs);
                        break;
                    case "synonyms":
                        SynonymBuilder.runStandalone();
                        break;
                    default:
                        logger.warn("Unknown tool entry: {}", toolName);
                        break;
                }
            }
        } catch (Exception e) {
            logger.error("发生致命错误: ", e);
            if (args.length == 0) writeGenStatus("FAIL: " + e);
            // 以非 0 退出码结束, 让调用方（CLI.bat / IDE / CI）能感知失败, 而不是把残缺产物当成功发布
            System.exit(1);
        }
    }

    /** CLI.bat 通过 -Dgen.status=<文件> 指定状态文件; 未指定则不写。成功写 "OK", 失败写 "FAIL: ..." */
    private static void writeGenStatus(String msg) {
        String p = System.getProperty("gen.status");
        if (p == null || p.isEmpty()) return;
        try {
            java.nio.file.Files.write(java.nio.file.Paths.get(p), msg.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception e) {
            logger.warn("写入 gen 状态文件失败: {}", e.toString());
        }
    }

    private static void clearGenStatus() {
        String p = System.getProperty("gen.status");
        if (p == null || p.isEmpty()) return;
        try { java.nio.file.Files.deleteIfExists(java.nio.file.Paths.get(p)); } catch (Exception ignored) { }
    }

    /**
     * 用 javaw 重新拉起当前 jar（同一 args），然后结束当前 java.exe。
     * bat 不用改；托盘进程不再挂在 CMD 上。
     *
     * @return true 表示已重启并应结束 main
     */
    private static boolean relaunchWithJavawAndExit(String[] args) {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) {
            return false;
        }
        if ("true".equalsIgnoreCase(System.getProperty("tray.detached"))) {
            return false;
        }

        try {
            File javaw = new File(System.getProperty("java.home"), "bin\\javaw.exe");
            if (!javaw.isFile()) {
                return false;
            }

            File jarFile = new File(
                    Gen.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            if (!jarFile.isFile() || !jarFile.getName().toLowerCase().endsWith(".jar")) {
                return false; // IDE / classes 目录下不重启
            }

            java.util.List<String> cmd = new java.util.ArrayList<String>();
            cmd.add(javaw.getAbsolutePath());
            cmd.add("-Dfile.encoding=UTF-8");
            cmd.add("-Dtray.detached=true");
            cmd.add("-jar");
            cmd.add(jarFile.getAbsolutePath());
            if (args != null) {
                java.util.Collections.addAll(cmd, args);
            }

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(new File(System.getProperty("user.dir")));
            pb.redirectInput(new File("NUL"));
            pb.redirectOutput(new File("NUL"));
            pb.redirectError(new File("NUL"));
            pb.start();

            System.exit(0);
            return true;
        } catch (Exception e) {
            logger.warn("javaw 重启动失败，继续当前进程: {}", e.toString());
            return false;
        }
    }

    /** 避免 OAuth 等再往控制台写，减少对 CMD 的占用 */
    private static void detachConsoleIo() {
        try {
            // 接管 System.out，通过 logger.info 输出
            PrintStream outStream = new PrintStream(new java.io.OutputStream() {
                private final java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();

                @Override
                public void write(int b) {
                    if (b == '\n') {
                        String line = baos.toString();
                        baos.reset();
                        if (!line.trim().isEmpty()) {
                            logger.info("[STDOUT] {}", line);
                        }
                    } else if (b != '\r') {
                        baos.write(b);
                    }
                }
            }, true, "UTF-8");

            // 接管 System.err，通过 logger.error 输出
            PrintStream errStream = new PrintStream(new java.io.OutputStream() {
                private final java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();

                @Override
                public void write(int b) {
                    if (b == '\n') {
                        String line = baos.toString();
                        baos.reset();
                        if (!line.trim().isEmpty()) {
                            logger.error("[STDERR] {}", line);
                        }
                    } else if (b != '\r') {
                        baos.write(b);
                    }
                }
            }, true, "UTF-8");

            System.setOut(outStream);
            System.setErr(errStream);
            
        } catch (Exception e) {
            logger.warn("配置控制台重定向到 Logger 失败: {}", e.toString());
        }
    }
}
