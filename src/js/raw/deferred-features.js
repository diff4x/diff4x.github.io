/**
 * deferred-features.js —— 懒加载外围功能集合：
 * What's new 更新日志、庆祝彩纸、@bomb/@rebirth 数据管理、7 天备份提醒、
 * 侧栏全局书签菜单、本地到期任务提醒，以及闲时工具（拼音词库、容量监测、夜间标题闪烁）。
 */
import { ExcerptsSys } from './excerpts.js';
import {
    $,
    createLocalStoreProxy,
    escapeHtml,
    makeDraggable
} from './shared-utils.js';
import {
    stopPreviewMedia,
    showStandaloneImagePreview,
    toggleStandaloneMediaPreview
} from './search-preview.js';

const store = createLocalStoreProxy();

let _clRenderSeq = 0;

function formatLogTime(ts) {
    const d = new Date(ts);
    return `[${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

function collectPrivatePaths() {
    const privatePaths = new Set();
    if (window.data && window.data.length > 0) {
        for (let i = 0; i < window.data.length; i += 4) {
            const info = window.data[i + 1];
            const path = window.data[i + 2];
            if (typeof info === 'string' && info.includes('localOnly')) {
                privatePaths.add(path);
            }
        }
    }
    return privatePaths;
}

const CL_MEDIA_KIND_BY_BUCKET = { gallery: 'image', video: 'video', audio: 'audio' };

let _clPreviewPath = null;
let _clOwnsPreview = false;

function hideChangelogPreview() {
    _clPreviewPath = null;
    if (!_clOwnsPreview) return;
    _clOwnsPreview = false;

    const box = document.getElementById('center-snippet-preview');
    if (!box) return;
    const content = box.querySelector('#preview-scroll-content');
    if (content) {
        stopPreviewMedia(content);
        content.innerHTML = '';
    }
    box.removeAttribute('data-active');
    box.style.display = 'none';
}

function bindChangelogMediaPreview(content) {
    const previewKindOf = (link) => {
        const kind = CL_MEDIA_KIND_BY_BUCKET[link.dataset.bucket];
        if (!kind) return null;
        if (link.dataset.localOnly === 'true' && store.online_flag === '1') return null;
        return kind;
    };

    content.addEventListener('mousemove', (e) => {
        const link = e.target.closest && e.target.closest('.log-link');
        const kind = link ? previewKindOf(link) : null;
        if (!kind) {
            hideChangelogPreview();
            return;
        }

        const path = link.dataset.path;
        if (path === _clPreviewPath) return;

        hideChangelogPreview();
        _clPreviewPath = path;
        if (kind === 'image') {
            _clOwnsPreview = true;
            showStandaloneImagePreview(path, () => _clPreviewPath === path);
        }
    });

    content.addEventListener('contextmenu', (e) => {
        const link = e.target.closest && e.target.closest('.log-link');
        if (!link) return;
        const kind = previewKindOf(link);
        if (kind !== 'video' && kind !== 'audio') return;
        e.preventDefault();
        toggleStandaloneMediaPreview(link.dataset.path, kind, {
            isOwner: () => _clOwnsPreview,
            onClaim: () => { _clOwnsPreview = true; }
        });
    });

    content.addEventListener('mouseleave', hideChangelogPreview);
    content.addEventListener('click', hideChangelogPreview);
    window.addEventListener('blur', hideChangelogPreview);
}

async function pickDefaultChangelogTab(ctx) {
    let latestLogTs = 0;
    let latestCommentTs = 0;
    try {
        const logs = await ctx.dbProxy.getLogs();
        for (const log of logs) if (log.ts > latestLogTs) latestLogTs = log.ts;
    } catch (e) { }
    try {
        const data = await ctx.dbProxy.get('sys_state', 'comments_latest');
        if (data && Array.isArray(data.items)) {
            for (const it of data.items) {
                const t = Date.parse(it.createdAt);
                if (t > latestCommentTs) latestCommentTs = t;
            }
        }
    } catch (e) { }
    return latestCommentTs > latestLogTs ? 'comments' : 'files';
}

function applyChangelogTabUI(tab) {
    const popup = $('#changelog-popup');
    if (!popup) return;
    popup.dataset.tab = tab;

    popup.querySelectorAll('.cl-tab').forEach(el => {
        const active = el.dataset.tab === tab;
        el.classList.toggle('active', active);
        el.style.fontWeight = active ? 'bold' : 'normal';
        el.style.textDecoration = active ? 'underline' : 'none';
        el.style.color = active ? '#000' : '#888';
    });

    $('#auto-show-changelog-wrap').style.display = tab === 'files' ? 'flex' : 'none';
    $('#auto-show-comments-wrap').style.display = tab === 'comments' ? 'flex' : 'none';
    $('#clear-changelog').style.display = tab === 'files' ? '' : 'none';
}

async function renderChangelogTab(ctx, tab) {
    const seq = ++_clRenderSeq;
    hideChangelogPreview();
    applyChangelogTabUI(tab);

    const content = $('#changelog-content');
    content.innerHTML = '<div style="color: gray;">加载中...</div>';

    try {
        const html = tab === 'comments'
            ? await buildCommentsHtml(ctx)
            : await buildFilesHtml(ctx);
        if (seq !== _clRenderSeq) return;
        content.innerHTML = html;
    } catch (e) {
        if (seq !== _clRenderSeq) return;
        content.innerHTML = `<div style="color: red;">${tab === 'comments' ? '读取评论失败' : '读取日志失败'}</div>`;
    }
}

export async function showChangelog(ctx, opts = {}) {
    let popup = $('#changelog-popup');
    const wasVisible = !!popup && popup.style.display !== 'none';

    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'changelog-popup';
        popup.classList.add('elastic-anim');

        const header = document.createElement('div');
        header.id = 'changelog-header';

        header.innerHTML = `
            <span class="cl-title">What's new?</span>
            <div style="display:flex; align-items:center;">
                <span id="cl-tabs" style="margin-right: 15px; font-size: 12px; white-space: nowrap; user-select: none;">
                    <span class="cl-tab" data-tab="files" style="cursor: pointer;" title="文件更新记录">文件</span>
                    <span style="color: #aaa;"> | </span>
                    <span class="cl-tab" data-tab="comments" style="cursor: pointer;" title="最新评论">评论</span>
                </span>
                <label id="auto-show-changelog-wrap" style="margin-right: 15px; font-size: 12px; color: #555; cursor: pointer; display: flex; align-items: center; white-space: nowrap;">
                    <input type="checkbox" id="auto-show-changelog-cb" style="margin-right: 4px;">更新后自动弹窗
                </label>
                <label id="auto-show-comments-wrap" style="margin-right: 15px; font-size: 12px; color: #555; cursor: pointer; display: none; align-items: center; white-space: nowrap;">
                    <input type="checkbox" id="auto-show-comments-cb" style="margin-right: 4px;">有新评论后自动弹窗
                </label>
                <button id="clear-changelog" class="cl-btn">Clear log</button>
                <button id="close-changelog" class="cl-btn">Close</button>
            </div>
        `;

        const content = document.createElement('div');
        content.id = 'changelog-content';
        popup.append(header, content);
        (document.getElementById('stage') || document.body).appendChild(popup);

        const autoShowCb = $('#auto-show-changelog-cb');
        if (store.auto_show_changelog === null || store.auto_show_changelog === undefined) {
            store.auto_show_changelog = "1";
        }
        autoShowCb.checked = store.auto_show_changelog === "1";
        autoShowCb.onchange = (e) => {
            store.auto_show_changelog = e.target.checked ? "1" : "0";
        };

        const autoShowCommentsCb = $('#auto-show-comments-cb');
        if (store.auto_show_comments === null || store.auto_show_comments === undefined) {
            store.auto_show_comments = "1";
        }
        autoShowCommentsCb.checked = store.auto_show_comments === "1";
        autoShowCommentsCb.onchange = (e) => {
            store.auto_show_comments = e.target.checked ? "1" : "0";
        };

        header.querySelectorAll('.cl-tab').forEach(el => {
            el.onclick = () => renderChangelogTab(ctx, el.dataset.tab);
        });

        $('#close-changelog').onclick = () => {
            hideChangelogPreview();
            popup.style.display = 'none';
        };
        $('#clear-changelog').onclick = async () => {
            if (confirm("确定要清空所有更新记录吗？")) {
                await ctx.dbProxy.clearLogs();
                $('#changelog-content').innerHTML = '<div style="color: gray;">暂无记录</div>';
            }
        };
        makeDraggable('#changelog-popup', '#changelog-header');

        content.addEventListener('click', (e) => {
            const link = e.target.closest('.log-link');
            if (link) {
                const path = link.dataset.path;
                const bucket = link.dataset.bucket;
                let typeSelector = '';

                if (bucket === 'html') typeSelector = '#html a';
                else if (bucket === 'gallery') typeSelector = '#gallery a';
                else if (bucket === 'video') typeSelector = '#video a';
                else if (bucket === 'audio') typeSelector = '#audio a';
                else if (bucket === 'ebook') typeSelector = '#ebook a';

                if (typeSelector) {
                    ctx.emitEvent(typeSelector, path, 'side');
                    ctx.emitEvent('show_current', null, 'side');
                }
            }
        });

        bindChangelogMediaPreview(content);
    }

    popup.style.display = 'flex';

    const refreshOnly = !!opts.keepTab && wasVisible;
    if (!refreshOnly) {
        popup.style.transform = 'none';
        const popupWidth = popup.offsetWidth || 600;
        popup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';
    }

    let tab;
    if (refreshOnly) tab = popup.dataset.tab || 'files';
    else tab = opts.tab || await pickDefaultChangelogTab(ctx);

    await renderChangelogTab(ctx, tab);
}

async function buildFilesHtml(ctx) {
    const logs = await ctx.dbProxy.getLogs();
    if (logs.length === 0) {
        return '<div style="color: gray;">暂无记录</div>';
    }
    logs.sort((a, b) => b.ts - a.ts);

    let html = '';
    let lastTs = null;
    let seenPaths = new Set();

    const privatePaths = collectPrivatePaths();

    logs.forEach(log => {
        if (lastTs !== null && (lastTs - log.ts > 60000)) {
            html += `<div style="margin: 4px 0; color: lightgray;overflow: hidden;">------------------------------------------------------------------------------------------------------------------------</div>`;
        }
        lastTs = log.ts;

        const dateStr = formatLogTime(log.ts);

        let textColor = '#333333';
        let isAddOrUpdate = false;

        if (/删除/.test(log.msg)) {
            textColor = '#cc0000';
        } else if (/新增/.test(log.msg)) {
            textColor = '#008000';
            isAddOrUpdate = true;
        } else if (/更新/.test(log.msg)) {
            textColor = '#0033cc';
            isAddOrUpdate = true;
        }

        const safeLogMsg = escapeHtml(log.msg);
        let msgHtml = safeLogMsg;

        const match = log.msg.match(/(\/)?(html|gallery|video|audio|ebook)\/(.+)$/);

        if (match) {
            const fullMatch = match[0];
            const safeFullMatch = escapeHtml(fullMatch);
            const bucket = match[2];
            const rawPath = match[3].split('?')[0].trim();
            const cleanPath = `${bucket}/${rawPath}`;
            const isPrivate = privatePaths.has(cleanPath);
            const lockIcon = isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";

            if (!seenPaths.has(cleanPath)) {
                seenPaths.add(cleanPath);

                if (isAddOrUpdate) {
                    const displayHtml = lockIcon + safeFullMatch;
                    const mediaKind = CL_MEDIA_KIND_BY_BUCKET[bucket];
                    const previewable = !!mediaKind && !(isPrivate && store.online_flag === "1");
                    const hint = previewable && mediaKind !== 'image'
                        ? '在侧栏中定位并打开（右击播放或停止预览）'
                        : '在侧栏中定位并打开';
                    const localAttr = isPrivate ? ' data-local-only="true"' : '';
                    const linkHtml = `<span class="log-link" data-path="${escapeHtml(cleanPath)}" data-bucket="${bucket}"${localAttr} style="cursor: pointer; text-decoration: underline; font-weight: bold;" title="${hint}">${displayHtml}</span>`;
                    msgHtml = safeLogMsg.replace(safeFullMatch, linkHtml);
                } else if (lockIcon) {
                    msgHtml = safeLogMsg.replace(safeFullMatch, lockIcon + safeFullMatch);
                }
            } else if (lockIcon) {
                msgHtml = safeLogMsg.replace(safeFullMatch, lockIcon + safeFullMatch);
            }
        }
        html += `<div style="color: ${textColor}; margin-bottom: 2px;">${dateStr} ${msgHtml}</div>`;
    });
    return html;
}

async function buildCommentsHtml(ctx) {
    const data = await ctx.dbProxy.get('sys_state', 'comments_latest');
    const items = data && Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
        return '<div style="color: gray;">暂无评论</div>';
    }

    const privatePaths = collectPrivatePaths();
    let html = '';
    items.forEach(it => {
        const ts = Date.parse(it.createdAt);
        const dateStr = Number.isNaN(ts) ? '[----]' : formatLogTime(ts);
        const lockIcon = privatePaths.has(it.path) ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";
        const linkHtml = `<span class="log-link" data-path="${escapeHtml(it.path)}" data-bucket="html" style="cursor: pointer; text-decoration: underline; font-weight: bold;" title="在侧栏中定位并打开">${lockIcon}${escapeHtml(it.title)}</span>`;

        html += `<div style="margin-bottom: 6px;">`
            + `<div style="color: #0033cc;">${dateStr} 💬 ${escapeHtml(it.author)} → ${linkHtml}</div>`
            + `<div style="color: #333333; margin-left: 12px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(it.text)}</div>`
            + `</div>`;
    });
    return html;
}

let _confettiCanvas = null;
let _confettiFire = null;

function getConfettiFire() {
    if (_confettiCanvas && document.body.contains(_confettiCanvas)) return _confettiFire;

    const stage = document.getElementById('stage') || document.body;

    _confettiCanvas = document.createElement('canvas');
    _confettiCanvas.id = 'confetti-canvas';
    _confettiCanvas.style.cssText = `
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 999999;
        pointer-events: none;
    `;
    stage.appendChild(_confettiCanvas);
    _confettiFire = confetti.create(_confettiCanvas, { resize: true });
    return _confettiFire;
}

export function playConfetti() {
    const startAnimation = () => {
        const fire = getConfettiFire();

        var defaults = {
            spread: 360,
            ticks: 50,
            gravity: 0,
            decay: 0.94,
            startVelocity: 30,
            colors: ['FFE400', 'FFBD00', 'E89400', 'FFCA6C', 'FDFFB8']
        };

        function shoot() {
            fire({
                ...defaults,
                particleCount: 40,
                scalar: 1.2,
                shapes: ['star']
            });

            fire({
                ...defaults,
                particleCount: 10,
                scalar: 0.75,
                shapes: ['circle']
            });
        }

        setTimeout(shoot, 0);
        setTimeout(shoot, 100);
        setTimeout(shoot, 200);
    };

    if (window.confetti) {
        startAnimation();
        return;
    }

    const script = document.createElement('script');
    script.src = "src/third/other/confetti.browser.min.js";
    script.onload = () => {
        script.remove();
        startAnimation();
    };
    script.onerror = () => console.warn("confetti.browser.min.js 加载失败");
    document.body.appendChild(script);
}

const PROTOCOL_OPTIONS = [
    { key: 'favList', label: '音乐收藏' },
    { key: 'marks', label: '条目标记' },
    { key: 'last_li_a', label: '导航历史' },
    { key: 'layout', label: '侧栏宽度' },
    { key: 'positions', label: '滚动位置' },
    { key: 'searchHistory', label: '搜索历史' },
    { key: 'prefs', label: '偏好与播控进度' },
    { key: 'pdfjs', label: 'PDF 阅读进度' },
    { key: 'bibi', label: 'EPUB 阅读进度' },
    { key: 'txt', label: 'TXT 阅读进度' },
    { key: 'excerpts', label: '摘抄薄' }
];

const ProtocolUIFactory = {
    create: (config) => {
        const overlay = document.createElement('div');
        overlay.className = 'proto-overlay';

        const box = document.createElement('div');
        box.className = 'proto-box';

        const checkboxesHTML = (config.options || []).map(opt =>
            `<label class="proto-label"><input type="checkbox" checked value="${opt.key}"> ${opt.label}</label>`
        ).join('');

        box.innerHTML = `<h2 class="proto-h2"><span>${config.title}</span></h2>
                         <div class="proto-desc">${config.desc}</div>
                         <div class="proto-list">${checkboxesHTML}</div>
                         <div class="proto-btn-group">${config.buttons}<button class="proto-btn-cancel">返回</button></div>`;

        overlay.appendChild(box);
        document.getElementById('stage').appendChild(overlay);

        const lockButtons = (text) => {
            box.querySelectorAll('button').forEach(btn => {
                btn.disabled = true;
                if (!btn.classList.contains('proto-btn-cancel')) btn.innerText = text;
            });
        };

        const closePanel = () => { overlay.remove(); if (typeof $ !== 'undefined' && $("#searchInput")) $("#searchInput").value = ""; };
        box.querySelector('.proto-btn-cancel').onclick = closePanel;

        if (config.onReady) {
            config.onReady(box, closePanel, lockButtons);
        }
    }
};

const restoreData = async (data, selections) => {
    if (selections.includes('favList') && data.favList !== undefined) store.favList = data.favList;
    if (selections.includes('marks') && data.marks !== undefined) store.ss_marks_lifepod = data.marks;
    if (selections.includes('last_li_a') && data.last_li_a !== undefined) store.last_li_a = data.last_li_a;
    if (selections.includes('layout') && data.layout_content_flex !== undefined) store.layout_content_flex = data.layout_content_flex;
    if (selections.includes('layout') && data.layout_side_flex !== undefined) store.layout_side_flex = data.layout_side_flex;
    if (selections.includes('positions') && data.positions !== undefined) store.positions = data.positions;
    if (selections.includes('searchHistory') && data.searchHistory !== undefined) store.searchHistory = data.searchHistory;
    if (selections.includes('prefs')) {
        if (data.wallpaper_config !== undefined) store.wallpaper_config = data.wallpaper_config;
        if (data.media_positions !== undefined) store.media_positions = data.media_positions;
        if (data.search_filter !== undefined) store.search_filter = data.search_filter;
        if (data.noise_level !== undefined) store.noise_level = data.noise_level;
        if (data.synonyms_enabled !== undefined) store.synonyms_enabled = data.synonyms_enabled;
    }
    if (selections.includes('pdfjs') && data['pdfjs.history'] !== undefined) store['pdfjs.history'] = data['pdfjs.history'];
    if (selections.includes('bibi') && data.BibiBiscuits) for (const [k, v] of Object.entries(data.BibiBiscuits)) localStorage.setItem(k, v);
    if (selections.includes('txt') && data.txts) for (const [k, v] of Object.entries(data.txts)) localStorage.setItem(k, v);
    if (selections.includes('excerpts') && data.excerpts_backup !== undefined && typeof ExcerptsSys !== 'undefined') {
        try {
            const db = await ExcerptsSys.init();
            await new Promise((res, rej) => { const txClear = db.transaction(ExcerptsSys.storeName, 'readwrite'); txClear.objectStore(ExcerptsSys.storeName).clear(); txClear.oncomplete = () => res(); txClear.onerror = () => rej(txClear.error); });
            await new Promise((res, rej) => { const txPut = db.transaction(ExcerptsSys.storeName, 'readwrite'); const storePut = txPut.objectStore(ExcerptsSys.storeName); for (const [bookName, bookObj] of Object.entries(data.excerpts_backup)) { storePut.put(bookObj, bookName); } txPut.oncomplete = () => res(); txPut.onerror = () => rej(txPut.error); });
        } catch (err) { console.error("恢复失败: ", err); }
    }
};

export function bomb(ctx) {
    ProtocolUIFactory.create({
        title: '数据清理',
        desc: `选择需要保留的数据模块，其余将根据操作方案清理。`,
        options: PROTOCOL_OPTIONS,
        buttons: `<button id="btn-plan-a" class="proto-btn btn-warn">保留所选，清理其余</button><button id="btn-plan-b" class="proto-btn btn-info">导出所选，全部清理</button><button id="btn-plan-c" class="proto-btn btn-danger">全部清理</button>`,
        onReady: (box, closePanel, lockButtons) => {
            const doWipe = async () => {
                window._isBombing = true;
                try {
                    if (ctx?.dbProxy && typeof ctx.dbProxy.close === 'function') ctx.dbProxy.close();
                    if (typeof ExcerptsSys !== 'undefined' && typeof ExcerptsSys.close === 'function') ExcerptsSys.close();
                    if (ctx?.iframes?.side?.contentWindow?.MarkSystem && typeof ctx.iframes.side.contentWindow.MarkSystem.close === 'function') {
                        ctx.iframes.side.contentWindow.MarkSystem.close();
                    }
                    if (ctx?.iframes?.content) ctx.iframes.content.src = 'about:blank';
                    if (ctx?.iframes?.side) ctx.iframes.side.src = 'about:blank';
                } catch (_) { }
                await new Promise(resolve => setTimeout(resolve, 120));
                localStorage.clear(); sessionStorage.clear();
                document.cookie.split(";").forEach(c => document.cookie = `${c.split("=")[0].trim()}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`);
                const clearTasks = [];
                const deleteIdb = (name) => new Promise(res => {
                    const timer = setTimeout(res, 2000);
                    const done = () => { clearTimeout(timer); res(); };
                    try {
                        const r = indexedDB.deleteDatabase(name);
                        r.onsuccess = done; r.onerror = done; r.onblocked = done;
                    } catch (_) { done(); }
                });
                if (window.indexedDB) {
                    if (typeof indexedDB.databases === 'function') {
                        clearTasks.push(indexedDB.databases().then(dbs => {
                            const names = new Set(['MainDB', 'ExcerptsDB', 'SideDB', 'AlignDrafts']);
                            dbs.forEach(d => { if (d && d.name) names.add(d.name); });
                            return Promise.all([...names].map(deleteIdb));
                        }).catch(() => Promise.all(['MainDB', 'ExcerptsDB', 'SideDB', 'AlignDrafts'].map(deleteIdb))));
                    } else {
                        clearTasks.push(Promise.all(['MainDB', 'ExcerptsDB', 'SideDB', 'AlignDrafts'].map(deleteIdb)));
                    }
                }
                if ('caches' in window) clearTasks.push(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
                if ('serviceWorker' in navigator) clearTasks.push(navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
                await Promise.all(clearTasks);
                await new Promise(resolve => setTimeout(resolve, 250));
            };

            const getSelectedData = async (selections) => {
                let data = { timestamp: Date.now() };
                if (selections.includes('favList')) data.favList = store.favList || [];
                if (selections.includes('marks')) {
                    let marksArray = [];
                    try {
                        if (ctx.iframes.side && ctx.iframes.side.contentWindow && ctx.iframes.side.contentWindow.MarkSystem) {
                            marksArray = Array.from(ctx.iframes.side.contentWindow.MarkSystem.urls);
                        }
                    } catch (e) {
                        console.warn("无法穿透获取 Mark 数据", e);
                    }
                    data.marks = marksArray;
                }
                if (selections.includes('last_li_a')) data.last_li_a = store.last_li_a || [];
                if (selections.includes('layout')) { data.layout_content_flex = store.layout_content_flex; data.layout_side_flex = store.layout_side_flex; }
                if (selections.includes('positions')) data.positions = store.positions || {};
                if (selections.includes('searchHistory')) data.searchHistory = store.searchHistory || [];
                if (selections.includes('prefs')) {
                    if (store.wallpaper_config !== undefined) data.wallpaper_config = store.wallpaper_config;
                    if (store.media_positions !== undefined) data.media_positions = store.media_positions;
                    if (store.search_filter !== undefined) data.search_filter = store.search_filter;
                    if (store.noise_level !== undefined) data.noise_level = store.noise_level;
                    if (store.synonyms_enabled !== undefined) data.synonyms_enabled = store.synonyms_enabled;
                }
                if (selections.includes('pdfjs')) data['pdfjs.history'] = store['pdfjs.history'] || {};
                if (selections.includes('bibi')) { data.BibiBiscuits = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('BibiBiscuit')) data.BibiBiscuits[k] = localStorage.getItem(k); } }
                if (selections.includes('txt')) { data.txts = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('txt.history')) data.txts[k] = localStorage.getItem(k); } }
                if (selections.includes('excerpts') && typeof ExcerptsSys !== 'undefined') { data.excerpts_backup = {}; try { const booksMeta = await ExcerptsSys.getAllBooks(); await Promise.all(booksMeta.map(async (b) => { const bData = await ExcerptsSys.getBookData(b.name); data.excerpts_backup[b.name] = bData; })); } catch (err) { console.error("摘抄备份异常: ", err); } }
                return data;
            };

            box.querySelector('#btn-plan-a').onclick = async () => {
                window._isBombing = true; lockButtons("正在保存选中数据...");
                const selections = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
                const takeSnapFn = (ctx && typeof ctx.takeSnapshot === 'function') ? ctx.takeSnapshot : window.takeSnapshot;
                let savedSnapStr = null;
                if (selections.includes('last_li_a') && typeof takeSnapFn === 'function') {
                    await takeSnapFn(false);
                    savedSnapStr = sessionStorage.getItem('ss_restore_strict');
                }
                const backupData = await getSelectedData(selections);
                await doWipe();
                await restoreData(backupData, selections);
                if (savedSnapStr) {
                    try { sessionStorage.setItem('ss_restore_strict', savedSnapStr); } catch (_) { }
                }
                window.location.reload();
            };

            box.querySelector('#btn-plan-b').onclick = async () => {
                window._isBombing = true; lockButtons("正在导出...");
                const selections = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
                const backupData = await getSelectedData(selections);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' }));
                a.download = `backup_${Date.now()}.json`;
                document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
                setTimeout(async () => { lockButtons("执行清理..."); await doWipe(); window.location.reload(); }, 1500);
            };

            box.querySelector('#btn-plan-c').onclick = async () => {
                window._isBombing = true; lockButtons("正在清理...");
                await doWipe(); window.location.reload();
            };
        }
    });
}

export function rebirth(ctx) {
    ProtocolUIFactory.create({
        title: '数据恢复',
        desc: '请选择备份文件，系统将识别并恢复所选模块。',
        options: [],
        buttons: `
            <button id="btn-file-select" class="proto-btn">选择文件</button>
            <input type="file" id="rebirth-file" accept=".json" style="display:none;">
            <button id="btn-exec-rebirth" class="proto-btn btn-warn" disabled>执行恢复</button>
        `,
        onReady: (box, closePanel, lockButtons) => {
            const fileInput = box.querySelector('#rebirth-file');
            const listArea = box.querySelector('.proto-list');
            const execBtn = box.querySelector('#btn-exec-rebirth');
            let loadedData = null;

            box.querySelector('#btn-file-select').onclick = () => fileInput.click();

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        loadedData = JSON.parse(event.target.result);
                        listArea.innerHTML = '';

                        PROTOCOL_OPTIONS.forEach(opt => {
                            let hasData = false;
                            switch (opt.key) {
                                case 'favList': hasData = loadedData.favList !== undefined; break;
                                case 'marks': hasData = loadedData.marks !== undefined; break;
                                case 'last_li_a': hasData = loadedData.last_li_a !== undefined; break;
                                case 'layout': hasData = loadedData.layout_content_flex !== undefined; break;
                                case 'positions': hasData = loadedData.positions !== undefined; break;
                                case 'searchHistory': hasData = loadedData.searchHistory !== undefined; break;
                                case 'prefs': hasData = (loadedData.wallpaper_config !== undefined || loadedData.media_positions !== undefined || loadedData.search_filter !== undefined || loadedData.noise_level !== undefined || loadedData.synonyms_enabled !== undefined); break;
                                case 'pdfjs': hasData = loadedData['pdfjs.history'] !== undefined; break;
                                case 'bibi': hasData = !!loadedData.BibiBiscuits; break;
                                case 'txt': hasData = !!loadedData.txts; break;
                                case 'excerpts': hasData = !!loadedData.excerpts_backup; break;
                            }
                            if (hasData) {
                                listArea.insertAdjacentHTML('beforeend', `<label class="proto-label"><input type="checkbox" checked value="${opt.key}"> ${opt.label}</label>`);
                            }
                        });

                        if (listArea.innerHTML === '') listArea.innerHTML = '<div style="color:red; font-size:12px;">未识别到有效数据模块</div>';
                        else execBtn.disabled = false;
                    } catch (err) { alert("文件解析失败"); }
                };
                reader.readAsText(file);
            };

            execBtn.onclick = async () => {
                const selections = Array.from(box.querySelectorAll('input:checked')).map(cb => cb.value);
                if (selections.length === 0) return;
                lockButtons("恢复中...");
                if (typeof $ !== 'undefined' && $("#clear")) $("#clear").click();
                await restoreData(loadedData, selections);
                const takeSnapFn = (ctx && typeof ctx.takeSnapshot === 'function') ? ctx.takeSnapshot : window.takeSnapshot;
                if (typeof takeSnapFn === 'function') await takeSnapFn(true); else window.location.reload();
            };
        }
    });
}

export function initBackupReminder(ctx) {
    const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

    const checkBackupStatus = async () => {
        const lastBackupStr = localStorage.getItem('last_backup_timestamp');
        const now = Date.now();

        if (!lastBackupStr) {
            localStorage.setItem('last_backup_timestamp', now.toString());
            return;
        }

        if (now - parseInt(lastBackupStr, 10) > BACKUP_INTERVAL_MS) {
            if (confirm("距离上次备份已超过 7 天。\n是否重新下载备份？")) {

                await (async function () {
                    let data = { timestamp: Date.now() };

                    data.favList = store.favList || [];
                    data.last_li_a = store.last_li_a || [];
                    data.layout_content_flex = store.layout_content_flex;
                    data.layout_side_flex = store.layout_side_flex;
                    data.positions = store.positions || {};
                    data.searchHistory = store.searchHistory || [];
                    if (store.wallpaper_config !== undefined) data.wallpaper_config = store.wallpaper_config;
                    if (store.media_positions !== undefined) data.media_positions = store.media_positions;
                    if (store.search_filter !== undefined) data.search_filter = store.search_filter;
                    if (store.noise_level !== undefined) data.noise_level = store.noise_level;
                    if (store.synonyms_enabled !== undefined) data.synonyms_enabled = store.synonyms_enabled;
                    data['pdfjs.history'] = store['pdfjs.history'] || {};

                    let marksArray = [];
                    try {
                        if (ctx.iframes.side && ctx.iframes.side.contentWindow && ctx.iframes.side.contentWindow.MarkSystem) {
                            marksArray = Array.from(ctx.iframes.side.contentWindow.MarkSystem.urls);
                        }
                    } catch (e) {
                        console.warn("自动备份: 无法穿透获取 Mark 数据", e);
                    }
                    data.marks = marksArray;

                    data.BibiBiscuits = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        let k = localStorage.key(i);
                        if (k.startsWith('BibiBiscuit')) data.BibiBiscuits[k] = localStorage.getItem(k);
                    }

                    data.txts = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        let k = localStorage.key(i);
                        if (k.startsWith('txt.history')) data.txts[k] = localStorage.getItem(k);
                    }

                    if (typeof ExcerptsSys !== 'undefined') {
                        data.excerpts_backup = {};
                        try {
                            const booksMeta = await ExcerptsSys.getAllBooks();
                            await Promise.all(booksMeta.map(async (b) => {
                                const bData = await ExcerptsSys.getBookData(b.name);
                                data.excerpts_backup[b.name] = bData;
                            }));
                        } catch (err) {
                            console.error("自动备份: 摘抄备份异常", err);
                        }
                    }

                    const a = document.createElement('a');
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    a.href = URL.createObjectURL(blob);
                    a.download = `backup_${Date.now()}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(a.href);
                })();

                localStorage.setItem('last_backup_timestamp', now.toString());

            } else {
                const delayOneDay = now - BACKUP_INTERVAL_MS + 24 * 60 * 60 * 1000;
                localStorage.setItem('last_backup_timestamp', delayOneDay.toString());
            }
        }
    };

    setTimeout(checkBackupStatus, 5000);

    if (typeof ctx.safeInterval === 'function') {
        ctx.safeInterval(checkBackupStatus, 24 * 60 * 60 * 1000);
    }
}

export function showGlobalBookmarkMenu(x, y, source) {
    let absoluteX = x;
    let absoluteY = y;

    if (source === 'side' && $('#side')) {
        const sideRect = $('#side').getBoundingClientRect();
        absoluteX += sideRect.left;
        absoluteY += sideRect.top;
    }

    let menu = document.getElementById('global-bookmark-menu');
    if (menu) menu.remove();

    menu = document.createElement('div');
    menu.id = 'global-bookmark-menu';

    menu.style.cssText = `position: fixed; z-index: 100000; background: rgb(51 51 51); border-radius: 4px; box-shadow: rgba(0, 0, 0, 0.4) 0px 4px 12px; display: flex; flex-direction: column; overflow-y: auto; min-width: 150px; visibility: visible; left: 1007.27px; top: 1.5px;`;

    const links = store.bookmark_links || [];
    if (links.length === 0) {
        return;
    } else {
        links.forEach(item => {
            const a = document.createElement("a");
            a.href = item.href;
            a.target = item.target || "_blank";
            a.textContent = item.text;
            a.style.cssText = `
                display: block; padding: 4px 16px; color: #f8fafc; text-decoration: none;
                white-space: nowrap; transition: background 0.2s; cursor: pointer;
            `;
            a.onmouseenter = () => a.style.background = '#555';
            a.onmouseleave = () => a.style.background = 'transparent';
            if (/\bREADME\b/i.test(item.text || '')) {
                a.addEventListener('click', (ev) => {
                    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
                    ev.preventDefault();
                    if (window._closeGlobalMenu) window._closeGlobalMenu();
                    let hash = '';
                    try { const u = new URL(item.href, location.href); hash = decodeURIComponent((u.hash || '').slice(1)); } catch (_) { }
                    openMdViewer({ hash });
                });
            }
            menu.appendChild(a);
        });
    }

    document.body.appendChild(menu);
    let hoverCloseTimer = null;

    menu.addEventListener('mouseenter', () => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    });

    menu.addEventListener('mouseleave', () => {
        hoverCloseTimer = setTimeout(() => {
            if (menu && document.body.contains(menu)) {
                menu.remove();

                document.removeEventListener('click', closeMenu);
                window._closeGlobalMenu = null;
            }
        }, 500);
    });

    let menuWidth = menu.offsetWidth;
    let menuHeight = menu.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (menuHeight > viewportHeight) {
        menu.style.maxHeight = viewportHeight + 'px';
        menuHeight = viewportHeight;
    }

    let targetLeft = absoluteX - menuWidth / 2;
    let targetTop = absoluteY;

    if (targetLeft < 0) {
        targetLeft = 0;
    }
    if (targetTop < 0) {
        targetTop = 0;
    } else if (targetTop + menuHeight > viewportHeight) {
        targetTop = viewportHeight - menuHeight;
    }

    menu.style.left = targetLeft + 'px';
    menu.style.top = targetTop + 'px';
    menu.style.visibility = 'visible';

    if (window._closeGlobalMenu) {
        window._closeGlobalMenu();
    }

    const closeMenu = (ev) => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }

        if (menu && (!ev || !menu.contains(ev.target))) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            if (window._closeGlobalMenu === closeMenu) window._closeGlobalMenu = null;
        }
    };
    window._closeGlobalMenu = closeMenu;
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

export function initDueTasksPingPong(ctx = {}) {
    const JSON_URL = '/_build/secrets/upcoming_tasks.json';
    const CHECK_INTERVAL = 5 * 60 * 1000;
    const SNOOZE_KEY = 'task_snooze_until';

    let bounceTimer = null;
    let initialized = false;

    const box = document.createElement('div');
    box.id = 'task-pingpong-box';
    box.innerHTML = `
        <button class="close-btn" title="暂时屏蔽15分钟">×</button>
        <h3>⚠️ 任务到期</h3>
        <ul id="task-pingpong-list"></ul>
    `;
    document.body.appendChild(box);

    const closeBtn = box.querySelector('.close-btn');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const snoozeUntil = Date.now() + 15 * 60 * 1000;
        localStorage.setItem(SNOOZE_KEY, snoozeUntil);
        stopAnimation();
        box.style.display = 'none';
    });

    box.addEventListener('mouseenter', () => {
        stopAnimation();
    });

    box.addEventListener('mouseleave', () => {
        if (box.style.display === 'block') {
            startAnimation();
        }
    });

    const MOVE_SPEED = 0.2;
    let posX = 0, posY = 0;
    let vx = MOVE_SPEED, vy = MOVE_SPEED;

    function startAnimation() {
        if (bounceTimer) return;
        box.style.display = 'block';

        if (!initialized) {
            const maxX = window.innerWidth - box.offsetWidth;
            const maxY = window.innerHeight - box.offsetHeight;
            posX = maxX / 2;
            posY = maxY / 2;
            initialized = true;
        }

        function frame() {
            const currentMaxX = window.innerWidth - box.offsetWidth;
            const currentMaxY = window.innerHeight - box.offsetHeight;
            posX += vx;
            posY += vy;

            if (posX <= 0) {
                posX = 0;
                vx = -vx;
            } else if (posX >= currentMaxX) {
                posX = currentMaxX;
                vx = -vx;
            }

            if (posY <= 0) {
                posY = 0;
                vy = -vy;
            } else if (posY >= currentMaxY) {
                posY = currentMaxY;
                vy = -vy;
            }

            box.style.left = posX + 'px';
            box.style.top = posY + 'px';
            bounceTimer = requestAnimationFrame(frame);
        }

        bounceTimer = requestAnimationFrame(frame);
    }

    function stopAnimation() {
        if (bounceTimer) {
            cancelAnimationFrame(bounceTimer);
            bounceTimer = null;
        }
    }

    async function checkTasks() {
        const snoozeTime = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
        if (Date.now() < snoozeTime) return;

        try {
            const response = await fetch(JSON_URL + '?t=' + Date.now(), { cache: 'no-store' });
            if (!response.ok) return;

            const tasks = await response.json();
            const listContainer = document.getElementById('task-pingpong-list');

            if (Array.isArray(tasks) && tasks.length > 0) {
                listContainer.innerHTML = tasks.map(t => {
                    const dueDateStr = t.due ? t.due.split('T')[0] : '无截止时间';
                    return `<li>${escapeHtml(t.title)} <span style="font-size:11px;opacity:0.9;">(${escapeHtml(dueDateStr)})</span></li>`;
                }).join('');

                box.style.display = 'block';
                if (!bounceTimer) startAnimation();
            } else {
                stopAnimation();
                box.style.display = 'none';
            }
        } catch (err) {
            console.warn('获取任务 JSON 失败:', err);
        }
    }

    const scheduleFn = typeof ctx.safeInterval === 'function' ? ctx.safeInterval : setInterval;
    scheduleFn(checkTasks, CHECK_INTERVAL);
    checkTasks();
}


// =========================================================================
// 闲时外围工具：拼音词库加载、localStorage 告警、夜间催睡标题/图标闪烁
// =========================================================================
export function initIdleUtilities(ctx = {}) {
    const { safeInterval, idleRun, docTitle } = ctx;
    const runIdle = typeof idleRun === 'function'
        ? idleRun
        : (fn => (window.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 50)));
    const schedule = typeof safeInterval === 'function' ? safeInterval : setInterval;
    const baseTitle = docTitle || document.title;

    // 1. 闲时加载拼音词库
    (function loadPinyinData(maxRetries = 30) {
        let attempts = 0;
        const targetUrl = new URL('/src/js/pinyinData.js', window.location.origin).href;
        const checkAndLoad = async () => {
            try {
                let res = (store.online_flag !== "0" && 'caches' in window)
                    ? await caches.match(targetUrl, { ignoreSearch: true })
                    : null;
                if (!res || !res.ok) {
                    if (store.online_flag === "0" || !navigator.serviceWorker || !navigator.serviceWorker.controller || attempts >= 2) {
                        res = await fetch(targetUrl, { cache: store.online_flag === "0" ? 'no-store' : 'no-cache' });
                    }
                }
                if (res && res.ok) {
                    const scriptText = await res.text();
                    const pinyinScript = document.createElement("script");
                    pinyinScript.type = "text/javascript";
                    pinyinScript.charset = "UTF-8";
                    pinyinScript.textContent = scriptText;
                    document.body.appendChild(pinyinScript);
                    pinyinScript.remove();
                    return;
                }
                throw new Error("Cache Miss");
            } catch (e) {
                attempts++;
                if (attempts < maxRetries) setTimeout(checkAndLoad, 2000);
                else console.error("❌ pinyinData.js 加载超时");
            }
        };
        runIdle(checkAndLoad);
    })();

    // 2. 夜间催睡标题与 Favicon 闪烁
    function startFaviconBlink() {
        if (window.faviconBlinkTimer) return;
        const faviconLink = document.getElementById('favicon');
        if (!faviconLink) return;
        const originalSrc = faviconLink.getAttribute('href');

        const toggleOpacityAndApply = (img, opacity) => {
            const canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const c = canvas.getContext('2d');
            if (!c) return;
            c.clearRect(0, 0, 16, 16);
            c.globalAlpha = opacity;
            c.drawImage(img, 0, 0, 16, 16);
            faviconLink.href = canvas.toDataURL('image/x-icon');
        };

        const initBlink = (img) => {
            let isVisible = true;
            window.faviconBlinkTimer = setInterval(() => {
                isVisible = !isVisible;
                toggleOpacityAndApply(img, isVisible ? 1 : 0);
            }, 500);
        };

        if (window.cachedFaviconImg) {
            initBlink(window.cachedFaviconImg);
        } else {
            const img = new Image();
            img.onload = function () {
                window.cachedFaviconImg = img;
                initBlink(img);
            };
            img.src = originalSrc;
        }
    }

    function stopFaviconBlink() {
        if (window.faviconBlinkTimer) {
            clearInterval(window.faviconBlinkTimer);
            window.faviconBlinkTimer = null;
        }
        const faviconLink = document.getElementById('favicon');
        if (faviconLink && window.cachedFaviconImg) {
            faviconLink.href = window.cachedFaviconImg.src;
        }
    }

    function updateTitle() {
        const now = new Date();
        const h = now.getHours();
        const mm = String(now.getMinutes()).padStart(2, "0");
        const hh = String(h).padStart(2, "0");
        const time = `${hh}:${mm}`;
        const isRestTime = (h >= 23 || h < 6);
        document.title = isRestTime ? `${time} - 该睡觉了` : `${time} - ${baseTitle}`;
        if (isRestTime) startFaviconBlink();
        else stopFaviconBlink();
    }

    updateTitle();
    setTimeout(() => {
        updateTitle();
        window.updateTitleTimer = schedule(updateTitle, 60 * 1000);
    }, (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds());

    // 3. localStorage 容量告警
    function lsAlert() {
        runIdle(() => {
            const alertSizeB = 1024 * 1024 * 4;
            let totalBytes = 0;
            for (const key in localStorage) {
                if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
                    totalBytes += localStorage.getItem(key).length * 2;
                }
            }
            if (totalBytes > alertSizeB) {
                alert("localStorage > " + (totalBytes / (1024 * 1024)).toFixed(2) + " MB !");
            }
        });
    }
    window.alertTimer = schedule(lsAlert, 60000);
}


export function openMdViewer(opts = {}) {
    const file = (opts && opts.file) || window.readme_md || store.readme_md || '/README.md';
    const hash = (opts && opts.hash) || '';
    const stage = document.getElementById('stage') || document.body;
    let popup = document.getElementById('md-viewer-popup');

    const stageW = () => stage.clientWidth || window.innerWidth;
    const stageH = () => stage.clientHeight || window.innerHeight;

    if (!popup) {
        if (!document.getElementById('md-viewer-resize-style')) {
            const st = document.createElement('style');
            st.id = 'md-viewer-resize-style';
            st.textContent = `
#md-viewer-popup{position:absolute;background:#fff;border:1px solid #333;box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:10002;flex-direction:column;border-radius:4px;overflow:hidden;box-sizing:border-box}
#md-viewer-popup .md-rz{position:absolute;z-index:12;touch-action:none}
#md-viewer-popup .md-rz-n{top:0;left:8px;right:8px;height:6px;cursor:ns-resize}
#md-viewer-popup .md-rz-s{bottom:0;left:8px;right:8px;height:6px;cursor:ns-resize}
#md-viewer-popup .md-rz-e{top:8px;right:0;bottom:8px;width:6px;cursor:ew-resize}
#md-viewer-popup .md-rz-w{top:8px;left:0;bottom:8px;width:6px;cursor:ew-resize}
#md-viewer-popup .md-rz-nw{top:0;left:0;width:10px;height:10px;cursor:nwse-resize}
#md-viewer-popup .md-rz-ne{top:0;right:0;width:10px;height:10px;cursor:nesw-resize}
#md-viewer-popup .md-rz-sw{bottom:0;left:0;width:10px;height:10px;cursor:nesw-resize}
#md-viewer-popup .md-rz-se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(120,120,120,.55) 50%,rgba(120,120,120,.55) 62%,transparent 62%,transparent 75%,rgba(120,120,120,.55) 75%)}
`;
            document.head.appendChild(st);
        }

        const initW = Math.min(1180, Math.round(stageW() * 0.92));
        const initH = Math.round(stageH() * 0.88);
        const initL = Math.max(0, Math.round((stageW() - initW) / 2));
        const initT = Math.max(8, Math.round((stageH() - initH) / 2));

        popup = document.createElement('div');
        popup.id = 'md-viewer-popup';
        popup.classList.add('elastic-anim');
        popup.style.cssText = 'display:none;left:0px;top:0px;width:100%;height:100%;border-radius:0;';

        const header = document.createElement('div');
        header.id = 'md-viewer-header';
        header.style.cssText = 'height:34px;background:#eee;cursor:default;display:flex;justify-content:space-between;align-items:center;padding:0 12px;flex-shrink:0;border-bottom:1px solid #ccc;user-select:none;font-size:13.5px;color:#222;';
        header.innerHTML = `<span class="cl-title">${store.online_flag === '0' ? 'Markdown Editor' : 'README'}</span><div style="display:flex;align-items:center;gap:6px;"><button id="md-viewer-max" class="cl-btn" title="最大化 / 还原" style="cursor:pointer;padding:1px 8px;">❐</button><button id="md-viewer-close" class="cl-btn" style="cursor:pointer;padding:1px 8px;">Close</button></div>`;

        const iframe = document.createElement('iframe');
        iframe.id = 'md-viewer-frame';
        iframe.allow = 'clipboard-read; clipboard-write';
        iframe.style.cssText = 'flex:1;width:100%;height:100%;border:none;background:#fff;';
        const qs = new URLSearchParams({ file });
        if (hash) qs.set('hash', hash);
        iframe.src = `src/tpl/md_viewer.html?${qs.toString()}`;

        popup.append(header, iframe);
        stage.appendChild(popup);

        // 八方向宽高 resize（支持触控板缩放倍率 window._tpZoom），默认最大化启动
        const MIN_W = 420, MIN_H = 260;
        let maximized = true;
        let savedBox = { left: initL, top: initT, width: initW, height: initH };
        const maxBtn = header.querySelector('#md-viewer-max');

        // 最大化状态下禁止拖动标题栏错位，非最大化时正常拖拽并屏蔽 iframe 捕获鼠标
        header.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('mousedown', (e) => e.stopPropagation());
        });
        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('button')) return;
            if (maximized) {
                e.stopImmediatePropagation();
                return;
            }
            iframe.style.pointerEvents = 'none';
            const restore = () => { iframe.style.pointerEvents = ''; };
            document.addEventListener('mouseup', restore, { once: true });
        });
        makeDraggable('#md-viewer-popup', '#md-viewer-header');

        const toggleMaximize = () => {
            if (!maximized) {
                savedBox = { left: popup.offsetLeft, top: popup.offsetTop, width: popup.offsetWidth, height: popup.offsetHeight };
                popup.style.left = '0px';
                popup.style.top = '0px';
                popup.style.width = '100%';
                popup.style.height = '100%';
                popup.style.borderRadius = '0';
                header.style.cursor = 'default';
                maxBtn.textContent = '❐';
                maximized = true;
            } else {
                const b = savedBox || { left: initL, top: initT, width: initW, height: initH };
                popup.style.left = b.left + 'px';
                popup.style.top = b.top + 'px';
                popup.style.width = b.width + 'px';
                popup.style.height = b.height + 'px';
                popup.style.borderRadius = '4px';
                header.style.cursor = 'move';
                maxBtn.textContent = '⛶';
                maximized = false;
            }
        };
        maxBtn.onclick = toggleMaximize;
        header.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMaximize(); });

        ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(dir => {
            const h = document.createElement('div');
            h.className = `md-rz md-rz-${dir}`;
            h.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                if (maximized) {
                    maximized = false;
                    maxBtn.textContent = '⛶';
                    popup.style.borderRadius = '4px';
                    header.style.cursor = 'move';
                    popup.style.width = popup.offsetWidth + 'px';
                    popup.style.height = popup.offsetHeight + 'px';
                }
                h.setPointerCapture(e.pointerId);
                iframe.style.pointerEvents = 'none';

                const startX = e.clientX, startY = e.clientY;
                const sL = popup.offsetLeft, sT = popup.offsetTop;
                const sW = popup.offsetWidth, sH = popup.offsetHeight;
                const maxW = stageW(), maxH = stageH();

                const onMove = (ev) => {
                    const scale = window._tpZoom || 1;
                    const dx = (ev.clientX - startX) / scale;
                    const dy = (ev.clientY - startY) / scale;
                    let nL = sL, nT = sT, nW = sW, nH = sH;

                    if (dir.includes('e')) nW = Math.max(MIN_W, Math.min(maxW - sL, sW + dx));
                    if (dir.includes('s')) nH = Math.max(MIN_H, Math.min(maxH - sT, sH + dy));
                    if (dir.includes('w')) {
                        const right = sL + sW;
                        nW = Math.max(MIN_W, Math.min(right, sW - dx));
                        nL = right - nW;
                    }
                    if (dir.includes('n')) {
                        const bottom = sT + sH;
                        nH = Math.max(MIN_H, Math.min(bottom, sH - dy));
                        nT = bottom - nH;
                    }
                    popup.style.left = Math.round(nL) + 'px';
                    popup.style.top = Math.round(nT) + 'px';
                    popup.style.width = Math.round(nW) + 'px';
                    popup.style.height = Math.round(nH) + 'px';
                };
                const onUp = () => {
                    h.onpointermove = null;
                    h.onpointerup = null;
                    h.onpointercancel = null;
                    iframe.style.pointerEvents = '';
                };
                h.onpointermove = onMove;
                h.onpointerup = onUp;
                h.onpointercancel = onUp;
            });
            popup.appendChild(h);
        });

        header.querySelector('#md-viewer-close').onclick = () => {
            try {
                if (iframe.contentWindow && iframe.contentWindow._mdDirty && !confirm('有未固化的修改，确定关闭？')) return;
            } catch (_) { }
            popup.style.display = 'none';
        };
    } else if (hash) {
        const iframe = document.getElementById('md-viewer-frame');
        try { iframe?.contentWindow?.postMessage({ type: 'SCROLL_HASH', hash }, location.origin); } catch (_) { }
    }

    popup.style.display = 'flex';
}
