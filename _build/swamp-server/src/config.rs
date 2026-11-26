use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Deserialize, Default, Debug)]
struct SwampToml {
    #[serde(default)]
    site: SiteToml,
    #[serde(default)]
    giscus: GiscusToml,
    #[serde(default)]
    server: ServerToml,
    #[serde(default)]
    build: BuildToml,
    #[serde(default)]
    media: MediaToml,
    #[serde(default)]
    tray: TrayToml,
    #[serde(default)]
    local: LocalToml,
    #[serde(default)]
    pack: PackToml,
    #[serde(default)]
    synonyms: SynonymsToml,
}

#[derive(Deserialize, Default, Debug)]
struct PackToml {
    skip_apply_doc_regex: Option<String>,
    presets_json: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct SynonymsToml {
    custom_json: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct SiteToml {
    github_page: Option<String>,
    readme_md: Option<String>,
    update_interval_ms: Option<u64>,
    update_interval_local_ms: Option<u64>,
}

#[derive(Deserialize, Default, Debug)]
struct GiscusToml {
    repo: Option<String>,
    repo_id: Option<String>,
    category_id: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct ServerToml {
    port: Option<u16>,
    sim_port: Option<u16>,
    log_level: Option<String>,
    watch_assets: Option<bool>,
}

#[derive(Deserialize, Default, Debug)]
struct BuildToml {
    slice_size_kb: Option<usize>,
    exclude_html_regex: Option<Vec<String>>,
    prune_missing_images: Option<bool>,
    prune_max_lines: Option<usize>,
    private_prefix_check: Option<bool>,
    allow_empty_gitignore: Option<bool>,
    #[serde(default)]
    media_exclude: MediaExcludeToml,
    #[serde(default)]
    precache: PrecacheToml,
}

#[derive(Deserialize, Default, Debug)]
struct MediaExcludeToml {
    gallery: Option<Vec<String>>,
    video: Option<Vec<String>>,
    audio: Option<Vec<String>>,
    ebook: Option<Vec<String>>,
}

#[derive(Deserialize, Default, Debug)]
struct PrecacheToml {
    include: Option<Vec<String>>,
    exclude: Option<Vec<String>>,
}

#[derive(Deserialize, Default, Debug)]
struct MediaToml {
    webp_quality: Option<u8>,
    img_max_width: Option<u32>,
    webp_output_dir: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct TrayToml {
    heartbeat_url: Option<String>,
    heartbeat_interval_sec: Option<u64>,
    tasks_poll_interval_sec: Option<u64>,
    due_within_days: Option<i64>,
}

#[derive(Deserialize, Default, Debug)]
struct LocalToml {
    vscode_path: Option<String>,
    katrain_dir: Option<String>,
    img_input_dir: Option<String>,
    webp_output_dir2: Option<String>,
    keep_takeout_zip_folder: Option<String>,
    port: Option<u16>,
    log_level: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub repo_root: PathBuf,
    pub build_dir: PathBuf,
    pub html_dir: PathBuf,
    pub gallery_dir: PathBuf,
    pub audio_dir: PathBuf,
    pub video_dir: PathBuf,
    pub ebook_dir: PathBuf,
    pub data_dir: PathBuf,
    pub js_raw_dir: PathBuf,
    pub js_out_dir: PathBuf,
    pub css_raw_dir: PathBuf,
    pub css_out_dir: PathBuf,
    pub font_raw_css: PathBuf,
    pub font_out_css: PathBuf,
    pub index_html: PathBuf,
    pub bookmark_html: PathBuf,
    pub template_html: PathBuf,
    pub swamp_toml_path: PathBuf,
    pub discussion_id_mapper: PathBuf,
    pub legacy_cmt_mapper: PathBuf,
    pub oov_report_file: PathBuf,
    pub synonyms_sha_file: PathBuf,
    pub cilin_file: PathBuf,
    pub legacy_cilin_file: PathBuf,
    pub legacy_synonyms_custom_file: PathBuf,
    pub gitignore_file: PathBuf,
    pub privy_dir: PathBuf,
    pub backup_dir: PathBuf,

    pub github_page: String,
    pub readme_md: String,
    pub data_repo: String,
    pub data_repo_id: String,
    pub data_category_id: String,
    pub update_interval_ms: u64,
    pub update_interval_local_ms: u64,

    pub slice_size_bytes: usize,
    pub exclude_html_regex: Vec<String>,
    pub prune_missing_images: bool,
    pub prune_max_lines: usize,
    pub private_prefix_check: bool,
    pub allow_empty_gitignore: bool,
    pub gallery_exclude_dirs: Vec<String>,
    pub video_exclude_dirs: Vec<String>,
    pub audio_exclude_dirs: Vec<String>,
    pub ebook_exclude_dirs: Vec<String>,
    pub precache_include: Vec<String>,
    pub precache_exclude: Vec<String>,

    // Media / Keep
    pub webp_quality: u8,
    pub img_max_width: u32,
    pub webp_output_dir: PathBuf,
    pub img_input_dir: Option<PathBuf>,
    pub webp_output_dir2: Option<PathBuf>,
    pub keep_takeout_zip_folder: Option<PathBuf>,

    // Tray / Heartbeat / Tasks
    pub heartbeat_url: String,
    pub heartbeat_interval_sec: u64,
    pub tasks_poll_interval_sec: u64,
    pub due_within_days: i64,

    // Server / Local tools
    pub port: u16,
    pub sim_port: u16,
    pub log_level: String,
    pub watch_assets: bool,
    pub vscode_path: String,
    pub katrain_dir: String,
}

impl ServerConfig {
    pub fn load(
        explicit_root: Option<PathBuf>,
        port_override: Option<u16>,
        log_level_override: Option<String>,
        is_sim: bool,
    ) -> Result<Self, String> {
        let repo_root = discover_repo_root(explicit_root)?;
        let build_dir = fs::canonicalize(repo_root.join("_build"))
            .map_err(|e| format!("无法定位 _build 目录: {}", e))?;

        let main_toml_path = build_dir.join("swamp.toml");
        let main_toml: SwampToml = if main_toml_path.is_file() {
            let raw = fs::read_to_string(&main_toml_path)
                .map_err(|e| format!("读取 swamp.toml 失败: {}", e))?;
            let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
            toml::from_str(clean).map_err(|e| format!("解析 swamp.toml 失败: {}", e))?
        } else {
            SwampToml::default()
        };

        let privy_dir = build_dir.join("privy");
        let local_toml_path = if privy_dir.join("local.toml").is_file() {
            privy_dir.join("local.toml")
        } else {
            build_dir.join("secrets").join("local.toml")
        };
        let local_toml: SwampToml = if local_toml_path.is_file() {
            let raw = fs::read_to_string(&local_toml_path)
                .map_err(|e| format!("读取 {} 失败: {}", local_toml_path.display(), e))?;
            let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
            toml::from_str(clean).map_err(|e| format!("解析 {} 失败: {}", local_toml_path.display(), e))?
        } else {
            SwampToml::default()
        };

        let mut legacy = HashMap::new();
        let legacy_main = build_dir.join("config.properties");
        if legacy_main.is_file() {
            if let Ok(m) = parse_properties_file(&legacy_main) {
                legacy.extend(m);
            }
        }
        let mut legacy_local = HashMap::new();
        for cand in [
            build_dir.join("secrets").join("local.properties"),
            privy_dir.join("local.properties"),
        ] {
            if cand.is_file() {
                if let Ok(m) = parse_properties_file(&cand) {
                    legacy_local.extend(m);
                }
            }
        }

        let pick_legacy = |k: &str| -> Option<String> {
            legacy_local
                .get(k)
                .or_else(|| legacy.get(k))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };

        let pick_local_str = |toml_local: Option<String>, toml_main: Option<String>, prop_key: &str| -> Option<String> {
            toml_local
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| legacy_local.get(prop_key).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
                .or_else(|| toml_main.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
                .or_else(|| legacy.get(prop_key).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        };

        let resolve_dir = |raw: Option<String>| -> Option<PathBuf> {
            raw.map(|s| {
                let p = PathBuf::from(s);
                if p.is_absolute() {
                    normalize_path(&p)
                } else {
                    normalize_path(&build_dir.join(p))
                }
            })
        };

        let base_port = local_toml
            .local
            .port
            .or(local_toml.server.port)
            .or_else(|| legacy_local.get("port").and_then(|s| s.trim().parse().ok()))
            .or(main_toml.server.port)
            .or_else(|| legacy.get("port").and_then(|s| s.trim().parse().ok()))
            .unwrap_or(8000);

        let sim_port = local_toml
            .server
            .sim_port
            .or(main_toml.server.sim_port)
            .unwrap_or(9000);

        let port = port_override.unwrap_or(if is_sim { sim_port } else { base_port });

        let default_log = if is_sim {
            "info".to_string()
        } else {
            pick_local_str(
                local_toml.local.log_level.or(local_toml.server.log_level),
                main_toml.server.log_level,
                "log_level",
            )
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_else(|| "error".to_string())
        };
        let log_level = log_level_override
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or(default_log);

        let watch_assets = local_toml
            .server
            .watch_assets
            .or(main_toml.server.watch_assets)
            .unwrap_or(true);

        // 可执行路径与外部进程目录仅信任本机私有的 _build/privy/local.toml（不信任入库的 swamp.toml）
        let pick_private_only = |toml_local: Option<String>, prop_key: &str| -> Option<String> {
            toml_local
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    legacy_local
                        .get(prop_key)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
        };

        let vscode_path =
            pick_private_only(local_toml.local.vscode_path, "vscode_path")
                .unwrap_or_else(|| "code".to_string());

        let katrain_dir =
            pick_private_only(local_toml.local.katrain_dir, "katrain_dir").unwrap_or_default();

        let img_input_dir =
            resolve_dir(pick_private_only(local_toml.local.img_input_dir, "imgInputDir"));

        let default_webp_dir = repo_root.join("gallery").join("img");
        let webp_output_dir = if let Some(local_dir) = resolve_dir(local_toml.media.webp_output_dir) {
            local_dir
        } else if let Some(main_dir) = resolve_dir(
            main_toml
                .media
                .webp_output_dir
                .or_else(|| pick_legacy("webpOutputDir")),
        ) {
            // 来自入库配置的输出目录必须约束在仓库根目录内
            if main_dir.starts_with(&repo_root) {
                main_dir
            } else {
                default_webp_dir
            }
        } else {
            default_webp_dir
        };

        let webp_output_dir2 = resolve_dir(
            pick_private_only(local_toml.local.webp_output_dir2, "webpOutputDir2")
                .or_else(|| pick_private_only(None, "gallery_img_outputDir2")),
        );

        let keep_takeout_zip_folder = resolve_dir(pick_private_only(
            local_toml.local.keep_takeout_zip_folder,
            "keep_takeout_zip_folder",
        ));

        let webp_quality = local_toml
            .media
            .webp_quality
            .or(main_toml.media.webp_quality)
            .or_else(|| pick_legacy("webpQuality").and_then(|s| s.parse().ok()))
            .unwrap_or(80)
            .clamp(1, 100);

        let img_max_width = local_toml
            .media
            .img_max_width
            .or(main_toml.media.img_max_width)
            .or_else(|| pick_legacy("imgMaxWidth").and_then(|s| s.parse().ok()))
            .unwrap_or(800);

        let raw_heartbeat_url = local_toml
            .tray
            .heartbeat_url
            .or(main_toml.tray.heartbeat_url)
            .or_else(|| pick_legacy("URL_TO_CHECK"))
            .unwrap_or_else(|| "https://www.google.com".to_string());
        let heartbeat_url = if raw_heartbeat_url.starts_with("https://")
            || raw_heartbeat_url.starts_with("http://")
        {
            raw_heartbeat_url
        } else {
            "https://www.google.com".to_string()
        };

        let heartbeat_interval_sec = local_toml
            .tray
            .heartbeat_interval_sec
            .or(main_toml.tray.heartbeat_interval_sec)
            .unwrap_or(10)
            .max(3);

        let tasks_poll_interval_sec = local_toml
            .tray
            .tasks_poll_interval_sec
            .or(main_toml.tray.tasks_poll_interval_sec)
            .unwrap_or(300)
            .max(30);

        let due_within_days = local_toml
            .tray
            .due_within_days
            .or(main_toml.tray.due_within_days)
            .unwrap_or(7)
            .max(1);

        let github_page = main_toml
            .site
            .github_page
            .or_else(|| pick_legacy("github_page"))
            .unwrap_or_else(|| "diff4x.github.io".to_string());

        let readme_md = normalize_web_path(
            &main_toml
                .site
                .readme_md
                .or_else(|| pick_legacy("readme_md"))
                .unwrap_or_else(|| "/README.md".to_string()),
        );

        let data_repo = main_toml
            .giscus
            .repo
            .or_else(|| pick_legacy("data-repo"))
            .unwrap_or_default();
        let data_repo_id = main_toml
            .giscus
            .repo_id
            .or_else(|| pick_legacy("data-repo-id"))
            .unwrap_or_default();
        let data_category_id = main_toml
            .giscus
            .category_id
            .or_else(|| pick_legacy("data-category-id"))
            .unwrap_or_default();

        let update_interval_ms = main_toml
            .site
            .update_interval_ms
            .or_else(|| pick_legacy("update_interval").and_then(|s| s.parse().ok()))
            .unwrap_or(10000);
        let update_interval_local_ms = main_toml
            .site
            .update_interval_local_ms
            .or_else(|| pick_legacy("update_interval_local").and_then(|s| s.parse().ok()))
            .unwrap_or(2000);

        let slice_size_kb = main_toml
            .build
            .slice_size_kb
            .or_else(|| pick_legacy("sliceSize").and_then(|s| s.parse().ok()))
            .unwrap_or(300);

        let exclude_html_regex = main_toml.build.exclude_html_regex.unwrap_or_else(|| {
            pick_legacy("exclude")
                .map(|s| {
                    s.split('|')
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect()
                })
                .unwrap_or_else(|| vec!["^_[^_].*".to_string()])
        });

        let prune_missing_images = main_toml
            .build
            .prune_missing_images
            .or_else(|| pick_legacy("prune_missing_images").map(|s| s.eq_ignore_ascii_case("true")))
            .unwrap_or(false);
        let prune_max_lines = main_toml
            .build
            .prune_max_lines
            .or_else(|| pick_legacy("prune_max_lines").and_then(|s| s.parse().ok()))
            .unwrap_or(30);
        let private_prefix_check = main_toml
            .build
            .private_prefix_check
            .or_else(|| pick_legacy("private_prefix_check").map(|s| !s.eq_ignore_ascii_case("false")))
            .unwrap_or(true);
        let allow_empty_gitignore = main_toml
            .build
            .allow_empty_gitignore
            .or_else(|| pick_legacy("allow_empty_gitignore").map(|s| s.eq_ignore_ascii_case("true")))
            .unwrap_or(false);

        let split_pipe = |k: &str| -> Vec<String> {
            pick_legacy(k)
                .map(|s| {
                    s.split('|')
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        };

        let gallery_exclude_dirs = main_toml
            .build
            .media_exclude
            .gallery
            .unwrap_or_else(|| {
                let v = split_pipe("galleryDirExcludeDirs");
                if v.is_empty() {
                    vec!["img".to_string(), "xx".to_string()]
                } else {
                    v
                }
            });
        let video_exclude_dirs = main_toml
            .build
            .media_exclude
            .video
            .unwrap_or_else(|| split_pipe("videoDirExcludeDirs"));
        let audio_exclude_dirs = main_toml
            .build
            .media_exclude
            .audio
            .unwrap_or_else(|| split_pipe("audioDirExcludeDirs"));
        let ebook_exclude_dirs = main_toml
            .build
            .media_exclude
            .ebook
            .unwrap_or_else(|| split_pipe("ebookDirExcludeDirs"));

        let precache_include = main_toml.build.precache.include.unwrap_or_else(|| {
            pick_legacy("coreFiles")
                .map(|s| {
                    s.split('|')
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });
        let precache_exclude = main_toml.build.precache.exclude.unwrap_or_default();

        let html_candidate = normalize_path(&repo_root.join("html"));
        let html_dir = fs::canonicalize(&html_candidate).unwrap_or(html_candidate);
        let temp_dir = build_dir.join("temp");
        let backup_dir = temp_dir.join("backup");

        Ok(Self {
            gallery_dir: repo_root.join("gallery"),
            audio_dir: repo_root.join("audio"),
            video_dir: repo_root.join("video"),
            ebook_dir: repo_root.join("ebook"),
            data_dir: repo_root.join("src").join("js").join("data"),
            js_raw_dir: repo_root.join("src").join("js").join("raw"),
            js_out_dir: repo_root.join("src").join("js"),
            css_raw_dir: repo_root.join("src").join("css").join("raw"),
            css_out_dir: repo_root.join("src").join("css"),
            font_raw_css: repo_root.join("src").join("css").join("font").join("font.css"),
            font_out_css: repo_root.join("src").join("css").join("font.css"),
            index_html: repo_root.join("index.html"),
            bookmark_html: repo_root.join("src").join("tpl").join("bookmark.html"),
            template_html: repo_root.join("src").join("tpl").join("new.html"),
            swamp_toml_path: main_toml_path,
            discussion_id_mapper: repo_root.join("src").join("discussion_id_mapper.json"),
            legacy_cmt_mapper: repo_root.join("src").join("cmt_mapper.json"),
            oov_report_file: backup_dir.join("oov_report.txt"),
            synonyms_sha_file: backup_dir.join("synonyms.sha256"),
            cilin_file: build_dir
                .join("swamp-server")
                .join("assets")
                .join("cilin.txt"),
            legacy_cilin_file: build_dir
                .join("rust")
                .join("swamp-server")
                .join("assets")
                .join("cilin.txt"),
            legacy_synonyms_custom_file: build_dir.join("synonyms").join("synonyms_custom.json"),
            gitignore_file: repo_root.join(".gitignore"),
            privy_dir,
            backup_dir,
            repo_root,
            build_dir,
            html_dir,
            github_page,
            readme_md,
            data_repo,
            data_repo_id,
            data_category_id,
            update_interval_ms,
            update_interval_local_ms,
            slice_size_bytes: slice_size_kb * 1024,
            exclude_html_regex,
            prune_missing_images,
            prune_max_lines,
            private_prefix_check,
            allow_empty_gitignore,
            gallery_exclude_dirs,
            video_exclude_dirs,
            audio_exclude_dirs,
            ebook_exclude_dirs,
            precache_include,
            precache_exclude,
            webp_quality,
            img_max_width,
            webp_output_dir,
            img_input_dir,
            webp_output_dir2,
            keep_takeout_zip_folder,
            heartbeat_url,
            heartbeat_interval_sec,
            tasks_poll_interval_sec,
            due_within_days,
            port,
            sim_port,
            log_level,
            watch_assets,
            vscode_path,
            katrain_dir,
        })
    }
}

pub fn normalize_web_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    if s.is_empty() {
        return String::new();
    }
    if s.starts_with('/') {
        s
    } else {
        format!("/{}", s)
    }
}

pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

pub fn discover_repo_root(explicit: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return fs::canonicalize(&p)
            .map_err(|e| format!("指定的仓库根目录无效 ({}): {}", p.display(), e));
    }

    let mut seeds = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            seeds.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        seeds.push(cwd);
    }

    for seed in seeds {
        let mut cur: Option<&Path> = Some(seed.as_path());
        while let Some(dir) = cur {
            let has_cfg = dir.join("_build").join("swamp.toml").is_file()
                || dir.join("_build").join("config.properties").is_file();
            if dir.join("index.html").is_file() && has_cfg {
                return fs::canonicalize(dir)
                    .map_err(|e| format!("无法规范化仓库根目录: {}", e));
            }
            cur = dir.parent();
        }
    }

    Err("未自动定位到仓库根目录（需包含 index.html 与 _build/swamp.toml），请通过 --root 指定".to_string())
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn parse_properties_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("读取配置文件失败 ({}): {}", path.display(), e))?;
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);

    let mut map = HashMap::new();
    let mut logical_line = String::new();
    let mut continuing = false;

    for raw_line in text.lines() {
        let trimmed_end = raw_line.trim_end_matches('\r');
        if !continuing {
            let t = trimmed_end.trim_start();
            if t.is_empty() || t.starts_with('#') || t.starts_with('!') {
                continue;
            }
            logical_line.clear();
            logical_line.push_str(t);
        } else {
            logical_line.push_str(trimmed_end.trim_start());
        }

        let bs_count = logical_line
            .chars()
            .rev()
            .take_while(|&c| c == '\\')
            .count();
        if bs_count % 2 == 1 {
            logical_line.pop();
            continuing = true;
            continue;
        }
        continuing = false;

        if let Some(eq_pos) = logical_line.find('=') {
            let key = logical_line[..eq_pos].trim().to_string();
            let val = unescape_prop_value(logical_line[eq_pos + 1..].trim());
            if !key.is_empty() {
                map.insert(key, val);
            }
        }
    }

    Ok(map)
}

fn unescape_prop_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek().copied() {
                Some('\\') => {
                    chars.next();
                    out.push('\\');
                }
                Some(':') => {
                    chars.next();
                    out.push(':');
                }
                Some('=') => {
                    chars.next();
                    out.push('=');
                }
                _ => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}


pub const DEFAULT_SKIP_APPLY_REGEX: &str =
    r"^(APPLY_AND_VERIFY|UPGRADE_.*|PATCH_NOTES|README_PATCH)\.md$";

const PACK_BEGIN: &str = "# === PACK-PRESETS-BEGIN ===";
const PACK_END: &str = "# === PACK-PRESETS-END ===";
const SYN_BEGIN: &str = "# === SYNONYMS-CUSTOM-BEGIN ===";
const SYN_END: &str = "# === SYNONYMS-CUSTOM-END ===";

fn load_swamp_toml_struct(path: &Path) -> SwampToml {
    let Ok(raw) = fs::read_to_string(path) else {
        return SwampToml::default();
    };
    let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    toml::from_str(clean).unwrap_or_default()
}

fn replace_marked_block(
    swamp_toml_path: &Path,
    begin_marker: &str,
    end_marker: &str,
    new_inner: &str,
) -> Result<(), String> {
    if new_inner.contains(begin_marker) || new_inner.contains(end_marker) {
        return Err("配置内容不能包含内部区块边界标记".to_string());
    }
    let raw = fs::read_to_string(swamp_toml_path)
        .map_err(|e| format!("读取 swamp.toml 失败: {}", e))?;
    let use_crlf = raw.contains("\r\n");
    let norm = raw.replace("\r\n", "\n");
    let block = format!("{}\n{}\n{}", begin_marker, new_inner.trim(), end_marker);

    let updated = match (norm.find(begin_marker), norm.find(end_marker)) {
        (Some(s), Some(e)) if e > s => {
            format!("{}{}{}", &norm[..s], block, &norm[e + end_marker.len()..])
        }
        (None, None) => format!("{}\n\n{}\n", norm.trim_end(), block),
        _ => {
            return Err(format!(
                "swamp.toml 中的配置区块标记 ({} / {}) 缺失或乱序，已拒绝写回以防损坏配置",
                begin_marker, end_marker
            ));
        }
    };

    // 写盘前先用 TOML 解析器完整校验，确保不会写出语法损坏或重复段头的 swamp.toml
    let check_clean = updated.strip_prefix('\u{FEFF}').unwrap_or(&updated);
    toml::from_str::<SwampToml>(check_clean)
        .map_err(|e| format!("写回前 TOML 校验失败，已中止保存: {}", e))?;

    let final_text = if use_crlf {
        updated.replace('\n', "\r\n")
    } else {
        updated
    };
    crate::api_files::write_atomic(swamp_toml_path, &final_text, false)
}

pub fn read_pack_presets(cfg: &ServerConfig) -> (String, Vec<serde_json::Value>) {
    let parsed = load_swamp_toml_struct(&cfg.swamp_toml_path);
    let skip_re = parsed
        .pack
        .skip_apply_doc_regex
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SKIP_APPLY_REGEX.to_string());

    if let Some(ref pj) = parsed.pack.presets_json {
        if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(pj.trim()) {
            return (skip_re, arr);
        }
    }

    let legacy = cfg.build_dir.join("pack_apply").join("presets.json");
    if legacy.is_file() {
        if let Ok(raw) = fs::read_to_string(&legacy) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.strip_prefix('\u{FEFF}').unwrap_or(&raw)) {
                let s = v
                    .get("skipApplyDocRegex")
                    .and_then(|x| x.as_str())
                    .unwrap_or(DEFAULT_SKIP_APPLY_REGEX)
                    .to_string();
                let arr = v
                    .get("presets")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default();
                return (s, arr);
            }
        }
    }

    (skip_re, Vec::new())
}

pub fn save_pack_presets(
    cfg: &ServerConfig,
    skip_regex: &str,
    presets: &[serde_json::Value],
) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(presets)
        .map_err(|e| format!("序列化预设 JSON 失败: {}", e))?;
    if pretty.contains("'''") {
        return Err("预设名称或路径不能包含连续三个单引号 '''".to_string());
    }
    let skip_escaped = serde_json::to_string(skip_regex)
        .map_err(|e| format!("序列化正则失败: {}", e))?;
    let inner = format!(
        "[pack]\nskip_apply_doc_regex = {}\npresets_json = '''\n{}\n'''",
        skip_escaped, pretty
    );
    replace_marked_block(&cfg.swamp_toml_path, PACK_BEGIN, PACK_END, &inner)
}

fn is_non_empty_synonyms_json(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return false;
    };
    let Some(obj) = v.as_object() else {
        return false;
    };
    obj.values().any(|val| match val {
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(m) => !m.is_empty(),
        _ => false,
    })
}

pub fn read_synonyms_custom_json(cfg: &ServerConfig) -> String {
    let parsed = load_swamp_toml_struct(&cfg.swamp_toml_path);
    if let Some(cj) = parsed.synonyms.custom_json {
        let trimmed = cj.trim();
        if !trimmed.is_empty() && (is_non_empty_synonyms_json(trimmed) || !cfg.legacy_synonyms_custom_file.is_file()) {
            return trimmed.to_string();
        }
    }
    if cfg.legacy_synonyms_custom_file.is_file() {
        if let Ok(raw) = fs::read_to_string(&cfg.legacy_synonyms_custom_file) {
            let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).trim();
            if !clean.is_empty() {
                return clean.to_string();
            }
        }
    }
    "{\n  \"dropEqCodes\": [],\n  \"pruneWords\": {},\n  \"splitFixes\": {},\n  \"stopExpand\": [],\n  \"groups\": [],\n  \"aliases\": {}\n}".to_string()
}

pub fn save_synonyms_custom_json(cfg: &ServerConfig, raw_json: &str) -> Result<String, String> {
    let val: serde_json::Value = serde_json::from_str(raw_json.trim())
        .map_err(|e| format!("JSON 语法错误: {}", e))?;
    if !val.is_object() {
        return Err("自定义同义词根节点必须是 JSON 对象 { ... }".to_string());
    }
    let pretty = serde_json::to_string_pretty(&val)
        .map_err(|e| format!("格式化 JSON 失败: {}", e))?;
    if pretty.contains("'''") {
        return Err("JSON 中不能包含连续三个单引号 '''".to_string());
    }
    let inner = format!("[synonyms]\ncustom_json = '''\n{}\n'''", pretty);
    replace_marked_block(&cfg.swamp_toml_path, SYN_BEGIN, SYN_END, &inner)?;
    Ok(pretty)
}
