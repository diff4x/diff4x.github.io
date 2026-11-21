/**
 * comments.js —— Giscus 评论浮窗、评论映射与后台同步索引模块
 */
import { $, makeDraggable } from './shared-utils.js';

const COMMENTS_SYNC_INTERVAL = 10 * 60 * 1000;

function commentToPlainText(md) {
    return String(md || "")
        .replace(/^```.*$/gm, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/^\s{0,3}>+\s?/gm, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/[*~`]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateText(text, max) {
    const chars = Array.from(text || "");
    return chars.length > max ? chars.slice(0, max).join("") + "…" : (text || "");
}

function collectHtmlFiles(node, out = new Map()) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node._f)) {
        for (const item of node._f) {
            if (!Array.isArray(item) || typeof item[0] !== "string") continue;
            const fileName = item[0];
            const info = typeof item[3] === "string" ? item[3] : "";
            const title = fileName.replace(/\.html$/, "");
            out.set(title, { title, fileName, path: "html/" + fileName, localOnly: info.includes("localOnly") });
        }
    }
    for (const key of Object.keys(node)) {
        if (key !== "_f") collectHtmlFiles(node[key], out);
    }
    return out;
}

export function createCommentsModule(ctx) {
    const {
        store,
        dbProxy,
        AsyncUtils,
        emitEvent,
        safeInterval,
        idleRun,
        getWorker,
        onCommentsUpdated,
        captureSnapshot
    } = ctx;

    let comments_first_flag = false;
    let records = [];
    let totalCount = 0;

    const model = {
        ready: false,
        ver: 0,
        sig: "",
        counts: {},
        meta: new Map(),
        index: null
    };

    function updatePopupHeaderWithStamp(stampText) {
        const header = document.getElementById("popup-header");
        if (!header) return;

        let titleEl = document.getElementById("popup-header-title");
        if (!titleEl) {
            titleEl = document.createElement("span");
            titleEl.id = "popup-header-title";
            titleEl.className = "cl-title";
            titleEl.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;";
            header.insertBefore(titleEl, header.firstChild);
        }

        titleEl.textContent = stampText ? `💬 Comment | ${stampText}` : `💬 Comment`;

        const closeBtn = document.getElementById("close-popup");
        if (closeBtn) {
            closeBtn.className = "cl-btn";
            closeBtn.textContent = "Close";
            if (closeBtn.parentElement === header) {
                const btnWrap = document.createElement('div');
                header.insertBefore(btnWrap, closeBtn);
                btnWrap.appendChild(closeBtn);
            }
        }
    }

    function discussion(term) {
        const script = document.createElement('script');
        script.src = "https://giscus.app/client.js";
        script.async = true;
        script.crossOrigin = "anonymous";
        script.setAttribute("data-repo", data_repo);
        script.setAttribute("data-repo-id", data_repo_id);
        script.setAttribute("data-category-id", data_category_id);
        script.setAttribute("data-mapping", "specific");
        script.setAttribute("data-term", term);
        script.setAttribute("data-strict", "1");
        script.setAttribute("data-reactions-enabled", "1");
        script.setAttribute("data-emit-metadata", "1");
        script.setAttribute("data-input-position", "top");
        script.setAttribute("data-theme", "light");
        script.setAttribute("data-lang", "en");
        $("#giscus-container").appendChild(script);
    }

    function loadCmtMapper() {
        if (store.online_flag !== "1") return;
        const maxRetries = 30;
        let attempts = 0;
        const targetUrl = new URL('/src/cmt_mapper.json', window.location.origin).href;
        const checkAndLoad = async () => {
            try {
                let res = ('caches' in window) ? await caches.match(targetUrl, { ignoreSearch: true }) : null;
                if (!res || !res.ok) {
                    if (!navigator.serviceWorker || !navigator.serviceWorker.controller || attempts >= 2) {
                        res = await fetch(targetUrl, { cache: 'no-cache' });
                    }
                }
                if (res && res.ok) {
                    const data = await res.json();
                    records = data.records || [];
                    return;
                }
                throw new Error("Cache Miss");
            } catch (e) {
                attempts++;
                if (attempts < maxRetries) {
                    setTimeout(checkAndLoad, 2000);
                } else {
                    console.error(`[Giscus] 🔴 评论映射表读取超时`);
                }
            }
        };
        idleRun(checkAndLoad);
    }

    function initPopupAndEvents() {
        if (!window._giscusMsgBound) {
            window._giscusMsgBound = true;
            window.addEventListener('message', async (e) => {
                if (e.origin === "https://giscus.app" && e.data?.giscus) {
                    const params = new URLSearchParams(window.location.search);
                    if (params.get("giscus")) {
                        window.history.replaceState({}, document.title, window.location.pathname);
                    }

                    const data = e.data.giscus;
                    if (data.discussion) {
                        totalCount = data.discussion.totalCommentCount || 0;
                        emitEvent("cm_count", totalCount, "content");
                    }
                    if (data.post) {
                        window._suppressCommentPopupUntil = Date.now() + 30 * 60 * 1000;
                        totalCount++;
                        emitEvent("cm_count", totalCount, "content");
                        console.log("新增评论:", data.post);
                    }
                    if (data.error) {
                        if (data.error == "Discussion not found") {
                            emitEvent("cm_count", 0, "content");
                        } else {
                            console.error("Giscus 错误:", data.error);
                        }
                    }
                }
            });
        }

        if (store.online_flag === "1") {
            makeDraggable("#giscus-popup", "#popup-header");
            const closeBtn = $("#close-popup");
            if (closeBtn) {
                closeBtn.addEventListener("click", () => {
                    $("#giscus-popup").style.display = "none";
                });
            }

            const params = new URLSearchParams(window.location.search);
            const giscusCode = params.get("giscus");
            if (giscusCode) {
                $("#giscus-popup").style.display = "flex";
            }
        }
    }

    async function getCommentMapperRecords() {
        if (records && records.length > 0) return records;
        try {
            const res = await fetch('/src/cmt_mapper.json', { cache: 'no-cache' });
            if (res.ok) {
                const data = await res.json();
                return data.records || [];
            }
        } catch (e) { }
        return [];
    }

    async function mapRawComments(raw) {
        const recs = await getCommentMapperRecords();
        await AsyncUtils.waitFor(() => window.lite_data, 90000, 200);
        const files = collectHtmlFiles(window.lite_data.html);
        const titleById = new Map(recs.map(r => [String(r.id), r.title]));

        const mapped = [];
        for (const c of raw) {
            const term = c && c.discussion ? String(c.discussion.title ?? "").trim() : "";
            const articleTitle = titleById.get(term);
            if (!articleTitle) continue;
            const file = files.get(articleTitle);
            if (!file) continue;
            mapped.push({
                id: c.id,
                path: file.path,
                author: (c.author && c.author.login) || "ghost",
                createdAt: c.createdAt,
                updatedAt: c.updatedAt || c.createdAt,
                text: commentToPlainText(c.body),
                url: c.url
            });
        }
        return mapped;
    }

    function pushIndexToWorker() {
        const worker = typeof getWorker === 'function' ? getWorker() : null;
        if (worker && model.index) {
            worker.postMessage({ type: 'SET_COMMENTS', payload: model.index });
        }
    }

    async function applyCommentSnapshot(snap) {
        await AsyncUtils.waitFor(() => window.lite_data, 90000, 200);
        const files = collectHtmlFiles(window.lite_data.html);
        const meta = new Map();
        for (const f of files.values()) meta.set(f.path, f);

        const counts = {};
        const grouped = new Map();
        for (const c of snap.comments) {
            if (!meta.has(c.path)) continue;
            counts[c.path] = (counts[c.path] || 0) + 1;
            let g = grouped.get(c.path);
            if (!g) grouped.set(c.path, g = { path: c.path, texts: [] });
            g.texts.push(c.text);
        }

        model.meta = meta;
        model.counts = counts;
        model.index = Array.from(grouped.values());
        model.sig = snap.sig || "";
        model.ready = true;
        model.ver++;

        window.commentCounts = counts;
        emitEvent('COMMENT_COUNTS', counts, 'side');
        pushIndexToWorker();
        if (typeof onCommentsUpdated === 'function') onCommentsUpdated();
    }

    function pickLatestComments(comments, limit) {
        return comments
            .filter(c => model.meta.has(c.path))
            .map(c => ({ c, ts: Date.parse(c.createdAt) || 0 }))
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit)
            .map(({ c }) => ({
                id: c.id,
                path: c.path,
                title: model.meta.get(c.path).title,
                author: c.author,
                createdAt: c.createdAt,
                text: truncateText(c.text, 200) || "[无文本内容]",
                url: c.url
            }));
    }

    async function notifyNewComments() {
        const openedPopup = document.getElementById('changelog-popup');
        const isOpen = !!openedPopup && openedPopup.style.display !== 'none';
        if (!isOpen) {
            if (store.auto_show_comments === "0") return;
            if (Date.now() < (window._suppressCommentPopupUntil || 0)) return;
        }

        try { await AsyncUtils.waitFor(() => !window.isDataSyncing && window._dataReady, 90000, 200); } catch (e) { }
        if (window.restoreSnapPromise) {
            try { await window.restoreSnapPromise; } catch (e) { }
        }

        try {
            const m = await import('./deferred-features.js');
            m.showChangelog({ dbProxy, emitEvent }, isOpen ? { keepTab: true } : {});
        } catch (e) {
            console.warn("[Comments] 弹出 What's new 失败:", e);
        }
    }

    async function syncComments() {
        if (window._commentSyncing || !navigator.onLine) return;
        window._commentSyncing = true;
        window._lastCommentSyncAt = Date.now();
        try {
            const res = await fetch(`https://raw.githubusercontent.com/${data_repo}/main/comments.json`, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const raw = Array.isArray(json && json.comments) ? json.comments : [];

            const mapped = await mapRawComments(raw);
            const sig = mapped.map(c => `${c.id}@${c.updatedAt}@${c.path}`).sort().join("|");
            if (model.ready && sig === model.sig) return;

            let prevLatest = null;
            try { prevLatest = await dbProxy.get('sys_state', 'comments_latest'); } catch (e) { }

            const snap = { generatedAt: (json && json.generatedAt) || "", sig, comments: mapped };
            await applyCommentSnapshot(snap);

            const latest = pickLatestComments(mapped, 10);
            const curNewest = latest.length ? (Date.parse(latest[0].createdAt) || 0) : 0;
            const prevNewest = Number(prevLatest && prevLatest.newestTs) || 0;
            const newestTs = Math.max(prevNewest, curNewest);
            const hasNew = !!prevLatest && curNewest > prevNewest;

            try {
                await dbProxy.put('sys_state', 'comments_latest', {
                    fetchedAt: Date.now(),
                    generatedAt: snap.generatedAt,
                    newestTs,
                    items: latest
                });
                await dbProxy.put('sys_state', 'comments_cache', snap);
            } catch (e) {
                console.warn("[Comments] 写入 IDB 失败:", e);
            }

            if (hasNew) notifyNewComments();
        } catch (e) {
            console.warn("[Comments] 同步失败:", e);
        } finally {
            window._commentSyncing = false;
        }
    }

    function startCommentSync() {
        if (window._commentSyncStarted) return;
        window._commentSyncStarted = true;

        (async () => {
            try {
                const cached = await dbProxy.get('sys_state', 'comments_cache');
                if (cached && Array.isArray(cached.comments)) await applyCommentSnapshot(cached);
            } catch (e) {
                console.warn("[Comments] 读取本地快照失败:", e);
            }
            await syncComments();
        })();

        window.commentSyncTimer = safeInterval(syncComments, COMMENTS_SYNC_INTERVAL);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible'
                && Date.now() - (window._lastCommentSyncAt || 0) > COMMENTS_SYNC_INTERVAL) {
                syncComments();
            }
        });
    }

    function loadComments(payload) {
        const commentTitle = (payload && typeof payload === 'object') ? payload.title : payload;
        const currentStamp = (payload && typeof payload === 'object') ? payload.stamp : '';

        window._latestCommentTitle = commentTitle;
        window._currentStampText = currentStamp;

        if (currentStamp) updatePopupHeaderWithStamp(currentStamp);

        (async () => {
            try {
                await AsyncUtils.waitFor(() => records && records.length > 0, 5000, 100);
            } catch (e) { }
            if (window._latestCommentTitle !== commentTitle) return;
            const record = records.find(r => r.title === commentTitle);
            if (!record) return;
            if (!comments_first_flag) {
                discussion(record.id);
                comments_first_flag = true;
            } else {
                const giscusFrame = $("#giscus-container iframe");
                if (giscusFrame && giscusFrame.contentWindow) {
                    giscusFrame.contentWindow.postMessage(
                        { giscus: { setConfig: { term: record.id } } },
                        "https://giscus.app"
                    );
                } else {
                    comments_first_flag = false;
                    discussion(record.id);
                    comments_first_flag = true;
                }
            }
        })();
    }

    function toggleCommentsPopup(stampPayload) {
        const popup = $("#giscus-popup");
        if (!popup) return;
        if (popup.style.display == "none" || !popup.style.display) {
            popup.style.display = "flex";
            popup.style.transform = 'none';
            const popupWidth = popup.offsetWidth || 600;
            popup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';

            const stamp = stampPayload || window._currentStampText;
            updatePopupHeaderWithStamp(stamp);

            if (typeof captureSnapshot === 'function') captureSnapshot(false);
        } else {
            popup.style.display = "none";
        }
    }

    function start() {
        loadCmtMapper();
        initPopupAndEvents();
        startCommentSync();
    }

    return {
        model,
        start,
        loadComments,
        toggleCommentsPopup,
        pushIndexToWorker
    };
}
