/**
 * deferred-features.js
 * 首屏不需要的低频功能集合：更新日志弹窗 / 彩蛋(@bomb,@rebirth) /
 * 一键清档&恢复 / 每周备份提醒 / 全局书签右键菜单 / 本地开发环境的
 * 到期任务提醒球。全部由 index.js 按需动态 import，不进入首屏 bundle。
 *
 * 与主文档共享的"活对象"(实际的 iframe 引用 / IndexedDB 日志代理 /
 * 跨窗口事件总线发送函数 / 安全定时器)通过调用方传入的 ctx 参数注入，
 * 避免在这里重新创建一份状态不一致的副本。
 */

import { ExcerptsSys } from './excerpts.js';

const $ = (selector) => document.querySelector(selector);
const store = new Proxy({}, {
    get(_, key) {
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
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

function makeDraggable(popupSelector, headerSelector) {
    const popup = $(popupSelector);
    const header = $(headerSelector);
    if (!popup || !header) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = popup.offsetLeft;
        initialTop = popup.offsetTop;
        popup.style.position = 'absolute';
        popup.style.margin = '0';
        popup.style.transform = 'translateX(0)';
        header.style.cursor = 'moving';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const scale = window._tpZoom || 1;
        const left = initialLeft + (e.clientX - startX) / scale;
        const top = initialTop + (e.clientY - startY) / scale;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    });
}

// ---- showChangelog(ctx): ctx = { dbProxy, emitEvent } ----
export async function showChangelog(ctx) {
    let popup = $('#changelog-popup');

    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'changelog-popup';
        popup.classList.add('elastic-anim');

        const header = document.createElement('div');
        header.id = 'changelog-header';

        header.innerHTML = `
            <span class="cl-title">What's new?</span>
            <div style="display:flex; align-items:center;">
                <label style="margin-right: 15px; font-size: 12px; color: #555; cursor: pointer; display: flex; align-items: center; white-space: nowrap;">
                    <input type="checkbox" id="auto-show-changelog-cb" style="margin-right: 4px;">更新后自动弹窗
                </label>
                <button id="clear-changelog" class="cl-btn">Clear log</button>
                <button id="close-changelog" class="cl-btn">Close</button>
            </div>
        `;

        const content = document.createElement('div');
        content.id = 'changelog-content';
        popup.append(header, content);
        document.body.appendChild(popup);
        document.getElementById('stage').appendChild(popup);

        const autoShowCb = $('#auto-show-changelog-cb');
        if (store.auto_show_changelog === null || store.auto_show_changelog === undefined) {
            store.auto_show_changelog = "1";
        }
        autoShowCb.checked = store.auto_show_changelog === "1";
        autoShowCb.onchange = (e) => {
            store.auto_show_changelog = e.target.checked ? "1" : "0";
        };

        $('#close-changelog').onclick = () => popup.style.display = 'none';
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
    }

    popup.style.display = 'flex';

    popup.style.transform = 'none';
    const popupWidth = popup.offsetWidth || 600;
    popup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';

    const content = $('#changelog-content');
    content.innerHTML = '<div style="color: gray;">加载中...</div>';

    try {
        const logs = await ctx.dbProxy.getLogs();
        if (logs.length === 0) {
            content.innerHTML = '<div style="color: gray;">暂无记录</div>';
            return;
        }
        logs.sort((a, b) => b.ts - a.ts);

        let html = '';
        let lastTs = null;
        let seenPaths = new Set();

        const privatePaths = new Set();
        if (window.data && window.data.length > 0) {
            // data 结构循环: [title, info, path, type]
            for (let i = 0; i < window.data.length; i += 4) {
                const info = window.data[i + 1];
                const path = window.data[i + 2];
                if (typeof info === 'string' && info.includes('localOnly')) {
                    privatePaths.add(path);
                }
            }
        }

        logs.forEach(log => {
            if (lastTs !== null && (lastTs - log.ts > 60000)) {
                html += `<div style="margin: 4px 0; color: lightgray;overflow: hidden;">------------------------------------------------------------------------------------------------------------------------</div>`;
            }
            lastTs = log.ts;

            const d = new Date(log.ts);
            const dateStr = `[${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;

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

            let msgHtml = log.msg;

            const match = log.msg.match(/(\/)?(html|gallery|video|audio|ebook)\/(.+)$/);

            if (match) {
                const fullMatch = match[0];
                const bucket = match[2];
                const rawPath = match[3].split('?')[0].trim();
                const cleanPath = `${bucket}/${rawPath}`;
                const isPrivate = privatePaths.has(cleanPath);
                const lockIcon = isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";

                if (!seenPaths.has(cleanPath)) {
                    seenPaths.add(cleanPath);

                    if (isAddOrUpdate) {
                        const displayHtml = lockIcon + fullMatch;
                        const linkHtml = `<span class="log-link" data-path="${cleanPath}" data-bucket="${bucket}" style="cursor: pointer; text-decoration: underline; font-weight: bold;" title="在侧栏中定位并打开">${displayHtml}</span>`;
                        msgHtml = log.msg.replace(fullMatch, linkHtml);
                    } else {
                        if (lockIcon) {
                            msgHtml = log.msg.replace(fullMatch, lockIcon + fullMatch);
                        }
                    }
                } else {
                    if (lockIcon) {
                        msgHtml = log.msg.replace(fullMatch, lockIcon + fullMatch);
                    }
                }
            }
            html += `<div style="color: ${textColor}; margin-bottom: 2px;">${dateStr} ${msgHtml}</div>`;
        });
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div style="color: red;">读取日志失败</div>';
    }
}


// ---- playConfetti() / bomb() / rebirth(ctx): ctx = { iframes } ----
export function playConfetti() {
    const startAnimation = () => {
        var defaults = {
            spread: 360,
            ticks: 50,
            gravity: 0,
            decay: 0.94,
            startVelocity: 30,
            colors: ['FFE400', 'FFBD00', 'E89400', 'FFCA6C', 'FDFFB8']
        };

        function shoot() {
            confetti({
                ...defaults,
                particleCount: 40,
                scalar: 1.2,
                shapes: ['star']
            });

            confetti({
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
                localStorage.clear(); sessionStorage.clear();
                document.cookie.split(";").forEach(c => document.cookie = `${c.split("=")[0].trim()}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`);
                const clearTasks = [];
                if (window.indexedDB && indexedDB.databases) {
                    clearTasks.push(indexedDB.databases().then(dbs => Promise.all(dbs.map(db => new Promise(res => {
                        const r = indexedDB.deleteDatabase(db.name); r.onsuccess = res; r.onerror = res; r.onblocked = res;
                    })))).catch(() => { }));
                }
                if ('caches' in window) clearTasks.push(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
                if ('serviceWorker' in navigator) clearTasks.push(navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
                await Promise.all(clearTasks);
                await new Promise(resolve => setTimeout(resolve, 300));
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
                if (selections.includes('pdfjs')) data['pdfjs.history'] = store['pdfjs.history'] || {};
                if (selections.includes('bibi')) { data.BibiBiscuits = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('BibiBiscuit')) data.BibiBiscuits[k] = localStorage.getItem(k); } }
                if (selections.includes('txt')) { data.txts = {}; for (let i = 0; i < localStorage.length; i++) { let k = localStorage.key(i); if (k.startsWith('txt.history')) data.txts[k] = localStorage.getItem(k); } }
                if (selections.includes('excerpts') && typeof ExcerptsSys !== 'undefined') { data.excerpts_backup = {}; try { const booksMeta = await ExcerptsSys.getAllBooks(); await Promise.all(booksMeta.map(async (b) => { const bData = await ExcerptsSys.getBookData(b.name); data.excerpts_backup[b.name] = bData; })); } catch (err) { console.error("摘抄备份异常: ", err); } }
                return data;
            };

            box.querySelector('#btn-plan-a').onclick = async () => {
                window._isBombing = true; lockButtons("正在保存选中数据...");
                const selections = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
                const backupData = await getSelectedData(selections);
                await doWipe();
                const mockSelections = Object.keys(backupData).map(k => {
                    if (k === 'BibiBiscuits') return 'bibi';
                    if (k === 'txts') return 'txt';
                    if (k === 'excerpts_backup') return 'excerpts';
                    return k;
                });
                await restoreData(backupData, mockSelections);
                if (typeof takeSnapshot === 'function') takeSnapshot(true); else window.location.reload();
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
                        listArea.innerHTML = ''; // 清空提示

                        PROTOCOL_OPTIONS.forEach(opt => {
                            let hasData = false;
                            switch (opt.key) {
                                case 'favList': hasData = loadedData.favList !== undefined; break;
                                case 'marks': hasData = loadedData.marks !== undefined; break;
                                case 'last_li_a': hasData = loadedData.last_li_a !== undefined; break;
                                case 'layout': hasData = loadedData.layout_content_flex !== undefined; break;
                                case 'positions': hasData = loadedData.positions !== undefined; break;
                                case 'searchHistory': hasData = loadedData.searchHistory !== undefined; break;
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
                if (typeof takeSnapshot === 'function') takeSnapshot(true); else window.location.reload();
            };
        }
    });
}


// ---- initBackupReminder(ctx): ctx = { iframes, safeInterval } ----
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


// ---- showGlobalBookmarkMenu(x, y, source) ----
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

    const closeMenu = (ev) => {
        if (hoverCloseTimer) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }

        if (menu && ev && !menu.contains(ev.target)) {
            menu.remove();
        } else if (menu && !ev) {
            menu.remove();
        }

        document.removeEventListener('click', closeMenu);
        window._closeGlobalMenu = null;
    };
}


// ---- initDueTasksPingPong() ----
export function initDueTasksPingPong() {
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
                    return `<li>${t.title} <span style="font-size:11px;opacity:0.9;">(${dueDateStr})</span></li>`;
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

    setInterval(checkTasks, CHECK_INTERVAL);
    checkTasks();
}

