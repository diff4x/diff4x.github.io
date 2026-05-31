import java.io.File;
import java.nio.file.Path;
import java.util.*;

public class MediaScanner {

    public static void scanMedia(
            Path sourceDir,
            String basePath,
            Set<String> validExtensions,
            String mediaType,
            Set<String> localOnlySet,
            List<String> excludeDirs,
            List<MediaNode> outputList) {

        File directory = sourceDir.toFile();
        if (!directory.exists() || !directory.isDirectory()) return;

        scanDirectoryRecursive(directory, basePath, validExtensions, mediaType, localOnlySet, excludeDirs, outputList, false);
    }

    private static void scanDirectoryRecursive(
            File dir, String basePath, Set<String> validExtensions, String mediaType,
            Set<String> localOnlySet, List<String> excludeDirs, List<MediaNode> outputList, boolean parentIsLocalOnly) {

        File[] files = dir.listFiles();
        if (files == null) return;
        Arrays.sort(files, Comparator.comparing(File::getName));

        for (File file : files) {
            if (file.isDirectory() && excludeDirs != null && excludeDirs.contains(file.getName())) {
                continue;
            }

            String relativePath = basePath + file.getName();
            boolean isLocalOnly = parentIsLocalOnly || localOnlySet.contains(file.getName()) || localOnlySet.contains(relativePath);

            if (file.isDirectory()) {
                scanDirectoryRecursive(file, basePath + file.getName() + "/", validExtensions, mediaType, localOnlySet, excludeDirs, outputList, isLocalOnly);
            } else if (file.isFile()) {
                String name = file.getName().toLowerCase();
                int dotIndex = name.lastIndexOf('.');
                String ext = (dotIndex == -1) ? "" : name.substring(dotIndex + 1);

                if (validExtensions.contains(ext)) {
                    String link = basePath + file.getName();
                    String finalType = mediaType;
                    
                    if ("ebook".equals(mediaType)) {
                        finalType = ext; 
                    }
                    
                    // 直接实例化精简后的 MediaNode
                    outputList.add(new MediaNode(isLocalOnly ? "localOnly" : "", link, finalType));
                }
            }
        }
    }
}
