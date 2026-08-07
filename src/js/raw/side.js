if (window.top && window.top.VirtualCursor) {
    window.top.VirtualCursor.attach(window);
}

const childId = "side";

const RIGHT_CLICK_DOUBLE_MS = 300;
const RIGHT_CLICK_DISTANCE = 8;
const RECENT_WINDOW_MS = 4320 * 60 * 1000;
const HOVER_PREVIEW_DELAY_MS = 350;
const DUAL_CLICK_DELAY_MS = 250;

let flag_jump_from_search = false;
let lastRightClickTime = 0;
let lastRightClickX = 0;
let lastRightClickY = 0;
let rightClickTimer = null;

let previewTooltip = null;
let hoverTimeout = null;
let lastMouseX = 0;
let lastMouseY = 0;

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function createStore(defaults = {}) {
    return new Proxy({}, {
        get(_, key) {
            const raw = localStorage.getItem(key);
            if (raw === null) return defaults[key];
            try { return JSON.parse(raw); } catch { return raw; }
        },
        set(_, key, value) {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        },
        deleteProperty(_, key) {
            localStorage.removeItem(key);
            return true;
        }
    });
}

function emitEvent(type, payload, target = "*") {
    if (!window.__LITE_BUS__) return;
    try {
        window.__LITE_BUS__.postMessage({ type, payload, from: ctxId, target });
    } catch { }
}

function parse_date(stamp) {
    if (!stamp || stamp.length < 14) return null;
    return new Date(
        stamp.substring(0, 4), stamp.substring(4, 6) - 1, stamp.substring(6, 8),
        stamp.substring(8, 10), stamp.substring(10, 12), stamp.substring(12, 14)
    );
}

function getFileNameFromPath(path) {
    return path.split("/").pop();
}

window.childId = childId;

const store = createStore({ last_li_a: [] });

if (window.__LITE_BUS__) window.__LITE_BUS__.close();
window.__LITE_BUS__ = new BroadcastChannel("bus");
const BUS = window.__LITE_BUS__;
const ctxId = window.top === window.self ? "index" : window.childId;

window.addEventListener("unload", () => {
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
});

BUS.addEventListener("message", e => {
    const { type, payload, target, from } = e.data || {};
    if (target !== "*" && target !== ctxId) return;

    switch (type) {
        case "RENDER_CATALOG":
            buildCatalogFromLiteData(payload);
            break;

        case "show_update_banner": {
            if (document.getElementById("update-banner")) return;
            const banner = document.createElement("div");
            banner.id = "update-banner";
            banner.innerText = "发现新版本, 点击更新";
            banner.onclick = () => {
                emitEvent("execute_update", null, "index");
                banner.remove();
            };
            document.body.prepend(banner);
            break;
        }

        case "#html a":
        case "#gallery a":
        case "#video a":
        case "#audio a":
        case "#ebook a": {
            const el = document.querySelector(`${type}[data-path="${CSS.escape(payload)}"]`);
            if (el) {
                if (type === "#html a") flag_jump_from_search = true;
                el.click();
            }
            break;
        }

        case "show_current":
            show_current();
            break;

        case "UPDATE_FAV_LIST":
            render_fav_trigger();
            break;

        default:
            break;
    }
});

window.addEventListener("contextmenu", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    const now = Date.now();
    const dx = e.clientX - lastRightClickX;
    const dy = e.clientY - lastRightClickY;
    const isDouble = (now - lastRightClickTime) <= RIGHT_CLICK_DOUBLE_MS
        && Math.sqrt(dx * dx + dy * dy) <= RIGHT_CLICK_DISTANCE;

    lastRightClickTime = now;
    lastRightClickX = e.clientX;
    lastRightClickY = e.clientY;

    if (isDouble) {
        clearTimeout(rightClickTimer);
        lastRightClickTime = 0;
        return;
    }

    e.preventDefault();
    rightClickTimer = setTimeout(() => {
        emitEvent("SHOW_GLOBAL_BOOKMARKS", { x: e.clientX, y: e.clientY, source: "side" }, "index");
    }, RIGHT_CLICK_DOUBLE_MS);
});

document.addEventListener("keydown", e => {
    if (e.key === "\\") emitEvent("quick_search", null, "index");
});

window.onload = () => {
    if (store.online_flag === "0") {
        document.querySelectorAll("a.admin").forEach(a => a.classList.remove("hidden"));
    }

    adj_width();
    go_top();

    bindDualClick(document.getElementById("a1"), e => {
        e.preventDefault();
        window.top.location.href = store.protocol_name + "://4";
    }, e => {
        e.preventDefault();
        window.top.location.href = store.protocol_name + "://6";
    }, DUAL_CLICK_DELAY_MS);

    document.getElementById("a2").setAttribute("href", store.protocol_name + "://3{/Dropbox/diff4x.github.io");
    document.getElementById("a3").setAttribute("href", store.protocol_name + "://8");
};

function buildCatalogFromLiteData(data) {
    if (!data || typeof data !== "object") return;

    const containers = {
        html: $("#html"),
        image: $("#gallery"),
        ebook: $("#ebook"),
        video: $("#video"),
        audio: $("#audio")
    };
    const pathPrefixes = { html: "html/", image: "gallery/", video: "video/", audio: "audio/", ebook: "ebook/" };

    Object.keys(containers).forEach(key => {
        const container = containers[key];
        if (!container) return;
        container.innerHTML = "";
        const branch = data[key];
        if (!branch) return;
        renderStructuredTree(branch, container, key, pathPrefixes[key]);
    });

    document.body.style.opacity = 1;
    document.body.style.transition = "opacity 0.3s ease";

    if (!window._eventsBound) {
        if (typeof click_func === "function") click_func();
        if (typeof dbl_click_func === "function") dbl_click_func();
        if (typeof hover_func === "function") hover_func();
        window._eventsBound = true;
    }

    if (typeof updateRecentLinks === "function") updateRecentLinks();

    if (!window._markSystemBound) { mark(); window._markSystemBound = true; }
    if (!window._menuSystemBound) { menu(); window._menuSystemBound = true; }
}

function renderStructuredTree(node, container, type, pathPrefix) {
    if (!node || typeof node !== "object") return;

    Object.keys(node)
        .filter(key => key !== "_f")
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .forEach(key => {
            const catSpan = document.createElement("span");
            catSpan.className = "category inactive";
            catSpan.textContent = key === "_uncategorized" ? "未分类" : key;

            const ul = document.createElement("ul");
            ul.className = "hidden";
            catSpan.onclick = () => {
                const isHidden = ul.classList.toggle("hidden");
                catSpan.className = isHidden ? "category inactive" : "category active";
            };

            container.append(catSpan, ul);

            const childPrefix = key === "_uncategorized" ? pathPrefix : pathPrefix + key + "/";
            renderStructuredTree(node[key], ul, type, childPrefix);
        });

    if (!Array.isArray(node._f)) return;

    const isOnline = store.online_flag === "1";
    const files = node._f.slice().sort((a, b) => {
        if (type === "html") {
            const stampA = (a[3] || "").split("-")[0];
            const stampB = (b[3] || "").split("-")[0];
            if (stampA && stampB && stampA !== stampB) return stampB > stampA ? 1 : -1;
        }
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    const frag = document.createDocumentFragment();
    files.forEach(([name, , itemType, flags]) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        const isLocalOnly = typeof flags === "string" && flags.includes("localOnly");

        if (type === "html") {
            a.href = "../../html/" + name;
            a.target = "content";
            if (typeof flags === "string" && flags.includes("-")) {
                a.dataset.stamp = flags.split("-")[0];
            }
            a.dataset.path = "html/" + name;
        } else {
            if (type === "ebook" && itemType) a.dataset.type = itemType;
            a.dataset.path = pathPrefix + name;
        }

        if (isLocalOnly) {
            a.dataset.localOnly = "true";
            a.classList.add(isOnline ? "locked" : "unlocked");
        }

        a.textContent = type === "html" ? name.replace(/\.html$/, "") : name;
        li.appendChild(a);
        frag.appendChild(li);
    });
    container.appendChild(frag);
}

function createMarkButton(path) {
    const btn = document.createElement("span");
    btn.className = "mark-btn";
    btn.dataset.path = path;
    btn.textContent = window.MarkSystem.urls.has(path) ? "[UnMark]" : "[Mark]";

    btn.addEventListener("click", async e => {
        e.preventDefault();
        e.stopPropagation();
        const marked = await window.MarkSystem.toggle(path);
        btn.textContent = marked ? "[UnMark]" : "[Mark]";
        document.querySelectorAll(`[data-path="${CSS.escape(path)}"]`).forEach(el => {
            el.classList.toggle("item-marked", marked);
        });
    });

    return btn;
}

async function mark() {
    const markSystem = {
        dbName: "SideDB",
        storeName: "marks",
        urls: new Set(),
        db: null,

        async init() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(this.dbName, 1);

                req.onupgradeneeded = e => {
                    e.target.result.createObjectStore(this.storeName, { keyPath: "url" });
                };

                req.onsuccess = e => {
                    this.db = e.target.result;

                    const legacy = store.ss_marks_lifepod;
                    const mode = legacy ? "readwrite" : "readonly";
                    const os = this.db.transaction(this.storeName, mode).objectStore(this.storeName);
                    if (legacy && Array.isArray(legacy)) {
                        try {
                            os.clear();
                            legacy.forEach(url => os.put({ url }));
                            delete store.ss_marks_lifepod;
                        } catch { /* ignore migration errors */ }
                    }

                    const getAllReq = os.getAll();
                    getAllReq.onsuccess = () => {
                        this.urls = new Set(getAllReq.result.map(r => r.url));
                        resolve();
                    };
                };

                req.onerror = () => reject(req.error);
            });
        },

        async toggle(url) {
            const exists = this.urls.has(url);
            const os = this.db.transaction(this.storeName, "readwrite").objectStore(this.storeName);
            if (exists) { this.urls.delete(url); os.delete(url); }
            else { this.urls.add(url); os.put({ url }); }
            return !exists;
        },

        restoreDOM() {
            document.querySelectorAll("a[data-path]").forEach(a => {
                const path = a.dataset.path;
                if (path) a.classList.toggle("item-marked", this.urls.has(path));
            });
            document.querySelectorAll(".history-list span[data-path]").forEach(el => {
                const path = el.dataset.path;
                if (path) el.classList.toggle("item-marked", this.urls.has(path));
            });
        }
    };

    window.MarkSystem = markSystem;
    await markSystem.init();

    document.querySelectorAll("li").forEach(li => {
        const a = li.querySelector("a");
        if (!a || !a.dataset.path) return;
        const path = a.dataset.path;
        if (markSystem.urls.has(path)) a.classList.add("item-marked");
        li.appendChild(createMarkButton(path));
    });

    markSystem.restoreDOM();
}

function bindDelegatedClick(containerSelector, childSelector, handler) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    container.addEventListener("click", e => {
        const target = e.target.closest(childSelector);
        if (!target || !container.contains(target)) return;

        if (store.online_flag === "1" && target.dataset.localOnly === "true") {
            e.preventDefault();
            e.stopPropagation();
            if (!window._alertLocked) {
                window._alertLocked = true;
                alert("🔒 访问受限：仅限本地查阅。");
                setTimeout(() => { window._alertLocked = false; }, 300);
            }
            return false;
        }

        handler(target, e);
    });
}

function getSiblingLinks(a) {
    return Array.from(a.parentElement.parentElement.children)
        .filter(el => el.tagName === "LI")
        .map(li => li.querySelector("a"))
        .filter(Boolean);
}

function setCurrent(a) {
    $$("li").forEach(li => li.classList.remove("current"));
    a.parentElement.classList.add("current");
}

function click_func() {
    bindDelegatedClick("#html", "a", a => {
        emitEvent("mask", { op: "add" }, "index");
        store.resource_type = "html";
        store.last_html = a.dataset.path;

        if (flag_jump_from_search) {
            flag_jump_from_search = false;
            if (store.giscus_jump != "1") store.jump_from_search_ex = "1";
            store.giscus_jump = "0";
        } else {
            store.jump_from_search = "0";
            if (store.keyword && store.keyword.trim() !== "") store.jump_from_search_ex = "1";
        }

        setCurrent(a);
        recordHistory(a.dataset.path);

        const date = parse_date(a.dataset.stamp);
        if (date) {
            a.setAttribute("title", date.toLocaleDateString("en-US", {
                year: "numeric", month: "long", day: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short"
            }));
        }
    });

    bindDelegatedClick("#ebook", "a", a => {
        emitEvent("mask", { op: "add" }, "index");
        switch (a.dataset.type) {
            case "txt": store.txt_path = a.dataset.path; break;
            case "pdf": store.pdf_path = a.dataset.path; break;
            case "epub": store.epub_path = a.dataset.path; break;
        }
        store.resource_type = a.dataset.type;
        emitEvent(a.dataset.type, null, "index");
        setCurrent(a);
        recordHistory(a.dataset.path);
    });

    bindDelegatedClick("#video", "a", a => {
        emitEvent("mask", { op: "add" }, "index");
        store.videolist = getSiblingLinks(a).map(el => el.dataset.path);
        store.resource_type = "video";
        store.video_path = a.dataset.path;
        emitEvent("video", null, "index");
        setCurrent(a);
        recordHistory(a.dataset.path);
    });

    bindDelegatedClick("#audio", "a", a => {
        store.playlist = getSiblingLinks(a).map(el => el.textContent);
        store.resource_type = "audio";
        store.song_path = a.dataset.path;
        emitEvent("audio", null, "index");
        setCurrent(a);
        recordHistory(a.dataset.path);
    });

    bindDelegatedClick("#gallery", "a", a => {
        emitEvent("mask", { op: "add" }, "index");
        store.imagelist = getSiblingLinks(a).map(el => el.dataset.path);
        store.resource_type = "image";
        store.image_path = a.dataset.path;
        emitEvent("image", null, "index");
        setCurrent(a);
        recordHistory(a.dataset.path);
    });

    $("#a a").addEventListener("click", () => emitEvent("mask", { op: "remove" }, "index"));
    store.resource_type = "bookmark";
}

function copyToClipboard(text) {
    text = text.replace(/\[(?:Mark|UnMark)\]/g, "").trim();

    function fallbackCopy(s) {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.left = "-9999px";
        ta.readOnly = true;
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, s.length);
        try { document.execCommand("copy"); }
        catch (err) { console.warn("复制失败", err); }
        document.body.removeChild(ta);
    }

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function dbl_click_func() {
    ["#gallery", "#audio", "#video", "#ebook"].forEach(sel => {
        const container = document.querySelector(sel);
        if (!container) return;
        container.addEventListener("dblclick", e => {
            const li = e.target.closest("li");
            if (li && container.contains(li)) copyToClipboard(li.textContent.trim());
        });
    });

    const htmlContainer = document.querySelector("#html");
    if (htmlContainer) {
        htmlContainer.addEventListener("dblclick", e => {
            const li = e.target.closest("li");
            if (li && htmlContainer.contains(li)) copyToClipboard(li.textContent.trim() + ".html");
        });
    }
}

function bindDualClick(el, onSingle, onDouble, delay = DUAL_CLICK_DELAY_MS) {
    let timer = null;
    el.addEventListener("click", e => {
        e.preventDefault();
        if (e.detail === 1) {
            timer = setTimeout(() => { timer = null; onSingle(e); }, delay);
        } else if (e.detail === 2) {
            if (timer) { clearTimeout(timer); timer = null; }
            onDouble(e);
        }
    });
}

function makeMenuLink(text, onClick) {
    const a = document.createElement("a");
    a.textContent = text;
    a.className = "o";
    a.onclick = onClick;
    return a;
}

function flashMenu(menuEl) {
    menuEl.style.display = "none";
    setTimeout(() => { menuEl.style.display = ""; }, 100);
}

function renderHistoryList(container) {
    container.innerHTML = "";

    let history = store.last_li_a;
    if (!Array.isArray(history)) history = history ? [history] : [];

    if (history.length === 0) {
        const empty = document.createElement("span");
        empty.className = "history-empty";
        empty.textContent = "空";
        container.appendChild(empty);
    } else {
        history.forEach(path => {
            const row = document.createElement("span");
            row.className = "history-row";
            row.dataset.path = path;
            if (window.MarkSystem.urls.has(path)) row.classList.add("item-marked");

            const label = document.createElement("span");
            label.className = "history-label-text";
            label.textContent = getFileNameFromPath(path);
            label.title = path;
            row.appendChild(label);

            row.appendChild(createMarkButton(path));

            row.addEventListener("click", e => {
                e.stopPropagation();
                if (e.target.classList.contains("mark-btn")) return;
                const link = document.querySelector(`a[data-path="${CSS.escape(path)}"]`);
                if (link) { link.click(); show_current(); }
                else console.warn("未找到对应DOM节点", path);
            });

            container.appendChild(row);
        });
    }

    container.style.display = "flex";
}

async function menu() {
    const menuEl = $("#menu-b");
    const btnB = $("#b");
    if (!menuEl || !btnB) return;

    let hideTimer = null;
    btnB.addEventListener("mouseenter", () => {
        if (hideTimer) clearTimeout(hideTimer);
        menuEl.style.visibility = "visible";
        menuEl.style.opacity = "1";
        menuEl.style.pointerEvents = "auto";
    });
    btnB.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(() => {
            menuEl.style.visibility = "hidden";
            menuEl.style.opacity = "0";
            menuEl.style.pointerEvents = "none";
        }, 200);
    });

    const a1 = document.getElementById("a1");
    const insertOrAppend = el => (a1 ? menuEl.insertBefore(el, a1) : menuEl.appendChild(el));

    const whatsNew = makeMenuLink("What's new?", () => {
        emitEvent("show_changelog", null, "index");
        flashMenu(menuEl);
    });
    insertOrAppend(whatsNew);

    const excerpts = makeMenuLink("Excerpts", () => {
        emitEvent("OPEN_EXCERPTS_NOTEBOOK", null, "index");
        flashMenu(menuEl);
    });
    insertOrAppend(excerpts);

    const historyWrapper = document.createElement("div");
    historyWrapper.className = "history-wrapper";
    historyWrapper.id = "historyWrapper";

    const historyLabel = document.createElement("a");
    historyLabel.className = "o history-label";
    historyLabel.textContent = "History";

    const historyList = document.createElement("div");
    historyList.className = "history-list";

    historyWrapper.append(historyLabel, historyList);
    menuEl.insertBefore(historyWrapper, excerpts);

    let historyHideTimer = null;
    historyWrapper.addEventListener("mouseenter", () => {
        if (historyHideTimer) { clearTimeout(historyHideTimer); historyHideTimer = null; }
        renderHistoryList(historyList);
    });
    historyWrapper.addEventListener("mouseleave", () => {
        historyHideTimer = setTimeout(() => { historyList.style.display = "none"; }, 1000);
    });

    render_fav_trigger();
}

function render_fav_trigger() {
    const existing = document.querySelector(".fav-trigger-btn");
    if (existing) existing.remove();

    const favList = store.favList;
    if (!favList || !Array.isArray(favList) || favList.length === 0) return;

    const btn = document.createElement("a");
    btn.className = "fav-trigger-btn o";
    btn.textContent = `Fav (${favList.length})`;
    btn.onclick = () => {
        document.querySelectorAll("#audio li").forEach(li => li.classList.remove("current"));
        emitEvent("play_fav_list", null, "index");
    };
    document.getElementById("historyWrapper").after(btn);
}

function recordHistory(path) {
    if (!path) return;
    let history = store.last_li_a;
    if (!Array.isArray(history)) history = history ? [history] : [];
    history = history.filter(p => p !== path);
    history.unshift(path);
    if (history.length > 50) history = history.slice(0, 50);
    store.last_li_a = history;
}

function updateRecentLinks() {
    const cutoff = new Date(Date.now() - RECENT_WINDOW_MS);

    $$("ul").forEach(ul => {
        const links = ul.querySelectorAll("a");
        const total = links.length;
        let recentCount = 0;

        links.forEach(a => {
            if (!a.hasAttribute("data-stamp")) return;
            if (parse_date(a.dataset.stamp) >= cutoff) {
                a.classList.add("recent");
                recentCount++;
            } else {
                a.classList.remove("recent");
            }
        });

        const category = ul.previousElementSibling;
        if (!category || !category.classList.contains("category")) return;

        if (recentCount > 0) {
            const ratio = 0.2 + (recentCount / total) * 0.8;
            category.style.backgroundColor = `rgba(255, 100, 100, ${ratio})`;
            category.setAttribute("data-count", `[${recentCount}/${total}]`);
        } else {
            category.style.backgroundColor = "";
            category.setAttribute("data-count", `[${total}]`);
        }
    });
}

function show_current() {
    const current = $("li.current");
    if (!current) return;

    $$("ul").forEach(ul => ul.classList.add("hidden"));
    $$(".category").forEach(c => { c.classList.remove("active"); c.classList.add("inactive"); });

    if (store.resource_type === "bookmark") return;

    let node = current;
    while (node) {
        const ul = node.closest("ul");
        if (!ul) break;
        ul.classList.remove("hidden");

        const category = ul.previousElementSibling;
        if (category && category.classList.contains("category")) {
            category.classList.remove("inactive");
            category.classList.add("active");
        }
        node = ul.parentElement.closest("li, ul");
    }

    setTimeout(() => current.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
}

function adj_width() {
    $("#c").addEventListener("click", () => emitEvent("adj_side_width", { op: "+" }, "index"));
    $("#d").addEventListener("click", () => emitEvent("adj_side_width", { op: "-" }, "index"));
}

function go_top() {
    const btn = document.createElement("div");
    btn.id = "gotop";
    btn.innerHTML = "<span>^</span>";
    btn.addEventListener("click", () => {
        document.documentElement.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.body.appendChild(btn);

    let ticking = false;
    window.addEventListener("scroll", () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
            const scrollTop = document.body.scrollTop || document.documentElement.scrollTop;
            $("#gotop").style.display = scrollTop > 500 ? "block" : "none";
            ticking = false;
        });
    }, { passive: true });
}

function initPreviewTooltip() {
    if (previewTooltip) return;
    previewTooltip = document.createElement("div");
    previewTooltip.id = "side-preview-tooltip";
    document.body.appendChild(previewTooltip);
}

function movePreviewTooltip() {
    if (!previewTooltip) return;
    const x = Math.min(lastMouseX + 15, window.innerWidth - 200);
    const y = Math.min(lastMouseY + 15, window.innerHeight - 150);
    previewTooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function bindHoverPreview(selector, type) {
    const container = document.querySelector(selector);
    if (!container) return;

    container.addEventListener("mouseover", e => {
        const a = e.target.closest("a");
        if (!a || !container.contains(a)) return;
        if (a.getAttribute("data-local-only") === "true" && store.online_flag !== "0") return;
        if (e.relatedTarget && a.contains(e.relatedTarget)) return;

        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (hoverTimeout) clearTimeout(hoverTimeout);

        hoverTimeout = setTimeout(() => {
            const src = "../../" + a.dataset.path;
            if (type === "image") {
                previewTooltip.innerHTML = `<img src="${src}" class="preview-media" />`;
            } else if (type === "video") {
                previewTooltip.innerHTML = `<video src="${src}" preload="metadata" muted class="preview-media"></video>`;
                const video = previewTooltip.querySelector("video");
                video.addEventListener("loadeddata", () => { video.currentTime = 0.5; });
            }
            movePreviewTooltip();
            previewTooltip.style.display = "block";
        }, HOVER_PREVIEW_DELAY_MS);
    });

    container.addEventListener("mousemove", e => {
        const a = e.target.closest("a");
        if (!a || !container.contains(a)) return;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (previewTooltip.style.display === "block") movePreviewTooltip();
    });

    container.addEventListener("mouseout", e => {
        const a = e.target.closest("a");
        if (!a || !container.contains(a)) return;
        if (e.relatedTarget && a.contains(e.relatedTarget)) return;

        if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
        previewTooltip.style.display = "none";
        previewTooltip.innerHTML = "";
    });
}

function hover_func() {
    initPreviewTooltip();
    bindHoverPreview("#gallery", "image");
    bindHoverPreview("#video", "video");
}

if (window.top?.lite_data) {
    buildCatalogFromLiteData(window.top.lite_data);
} else {
    emitEvent("index", "REQUEST_CATALOG", null);
}