if (window.top && window.top.VirtualCursor) {
    window.top.VirtualCursor.attach(window);
}

const childId = 'content';
window.childId = childId;
const store = createStore();
store.resource_type = "bookmark";

let wallpaperTimer = null;
let panelDomRef = null;
let faviconStyleEl = null;

if (window.__LITE_BUS__) {
    window.__LITE_BUS__.close();
}
window.__LITE_BUS__ = new BroadcastChannel('bus');
const BUS = window.__LITE_BUS__;

const ctxId = window.top === window.self ? 'index' : window.childId;

window.addEventListener('unload', () => {
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
});

window.addEventListener('DOMContentLoaded', () => {
    store.bookmarkhtml_linksHash = getALinksHash();

    const links = Array.from(document.querySelectorAll('a'))
        .filter(a => a.textContent && a.textContent.trim().length > 0)
        .map(a => ({
            text: a.textContent.trim(),
            href: a.href,
            target: a.target || '_blank'
        }));
    store.bookmark_links = links;

    if (store.online_flag === "0") {
        const checkLock = setInterval(() => {
            if (store.bookmarkhtml_modifing !== "1") {
                clearInterval(checkLock);
                setupDragAndDrop();
            }
        }, 100);
    }

    loadFaviconsWhenIdle();
    initWallpaperModule();

    const githubApi = 'https://api.github.com/repos/diff4x/diff4x.github.io';
    const CACHE_TIME = 60 * 1000;
    let cache = null;
    let pendingRequest = null;
    document.querySelector('#copyright')?.addEventListener('mouseenter', async function () {
    if (cache && Date.now() - cache.time < CACHE_TIME) {
        this.title = cache.title;
        return;
    }
    if (pendingRequest) {
        this.title = await pendingRequest;
        return;
    }
    pendingRequest = fetch(githubApi)
        .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
        })
        .then(data => {
        const sizeMB = data.size / 1024;
        const title = `线上仓库体积：${sizeMB.toFixed(2)} MB`;

        cache = {
            title,
            time: Date.now()
        };

        return title;
        })
        .finally(() => {
        pendingRequest = null;
        });

    try {
        this.title = await pendingRequest;
    } catch (err) {
        console.error(err);
    }
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        emitEvent("quick_search", "", "index");
    }
});

function emitEvent(type, payload, target = '*') {
    if (!window.__LITE_BUS__) return;
    try {
        window.__LITE_BUS__.postMessage({
            type,
            payload,
            from: ctxId,
            target
        });
    } catch (e) { }
}

function createStore(defaults = {}) {
    return new Proxy({}, {
        get(_, prop) {
            if (prop === 'pinyinData') {
                return window.top.pinyinData || {};
            }

            const val = localStorage.getItem(prop);
            if (val === null) return defaults[prop];
            try { return JSON.parse(val); } catch { return val; }
        },
        set(_, prop, value) {
            if (prop === 'pinyinData') {
                return true;
            }

            localStorage.setItem(prop, JSON.stringify(value));
            return true;
        },
        deleteProperty(_, prop) {
            if (prop === 'pinyinData') return true;

            localStorage.removeItem(prop);
            return true;
        }
    });
}

function setupDragAndDrop() {
    document.querySelectorAll('div').forEach(block => {
        block.addEventListener('dragover', e => {
            e.preventDefault();
            block.classList.add('dragover');
        });

        block.addEventListener('dragleave', () => {
            block.classList.remove('dragover');
        });

        block.addEventListener('drop', e => {
            e.preventDefault();
            block.classList.remove('dragover');

            const blockId = block.id;
            const htmlData = e.dataTransfer.getData("text/html");
            const url = e.dataTransfer.getData("text/uri-list");

            if (!htmlData && !url) {
                alert("未获取到链接数据");
                return;
            }

            let linkTitle = "", linkHref = "";
            if (htmlData) {
                const doc = new DOMParser().parseFromString(htmlData, "text/html");
                const a = doc.querySelector("a");
                if (a) {
                    linkTitle = a.textContent.trim();
                    linkHref = a.href;
                }
            } else if (url) {
                linkTitle = url;
                linkHref = url;
            }

            if (!linkHref) {
                alert("无法解析链接");
                return;
            }

            const param = blockId + "}" + linkTitle + "}" + linkHref;
            emitEvent("reload_bookmark", null, "index");
            location.href = store.protocol_name + "://2{" + encodeURIComponent(param);
        });
    });
}

function getFaviconStyleEl() {
    if (!faviconStyleEl) {
        faviconStyleEl = document.createElement('style');
        faviconStyleEl.id = 'favicon-style';
        document.head.appendChild(faviconStyleEl);
    }
    return faviconStyleEl;
}

function collectFaviconTargets() {
    const targets = [];
    Array.from(document.querySelectorAll('div'))
        .filter(div => div.id && div.id !== 'wallpaper-bg' && div.id !== 'wallpaper-panel' && div.id !== 'b1' && div.id !== 'del' && div.id !== 'a')
        .forEach(div => {
            const anchors = Array.from(div.children).filter(el => el.tagName === 'A');
            anchors.forEach((a, idx) => {
                targets.push({ divId: div.id, nth: idx + 1, href: a.href });
            });
        });
    return targets;
}

function loadFaviconsWhenIdle() {
    const runIdle = window.requestIdleCallback
        ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 300);

    const targets = collectFaviconTargets();

    let i = 0;
    function processChunk(deadline) {
        while (i < targets.length && (deadline.timeRemaining() > 0 || deadline.didTimeout)) {
            probeAndRenderFavicon(targets[i]);
            i++;
        }
        if (i < targets.length) {
            runIdle(processChunk);
        }
    }
    runIdle(processChunk);
}

function probeAndRenderFavicon({ divId, nth, href }) {
    let hostname;
    try {
        hostname = new URL(href).hostname;
    } catch {
        return; 
    }
    const faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(hostname)}`;

    const probe = new Image();
    probe.dataset.faviconProbe = '1';
    probe.onload = () => {
        appendFaviconRule(divId, nth, faviconUrl);
    };
    probe.onerror = (err) => {
        try { probe.onerror = null; probe.onload = null; probe.src = ''; } catch (_) { }
    };
    probe.src = faviconUrl;
}

function appendFaviconRule(divId, nth, faviconUrl) {
    const styleEl = getFaviconStyleEl();
    const selector = `#${CSS.escape(divId)} > a:nth-of-type(${nth})`;
    styleEl.appendChild(document.createTextNode(
        `${selector}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;` +
        `background-image:url("${faviconUrl}");background-size:contain;background-repeat:no-repeat;` +
        `background-position:center;vertical-align:-2px;}\n`
    ));
}

function getALinksHash() {
    const aTags = document.getElementsByTagName("a");
    let combined = "";
    for (let a of aTags) {
        combined += a.href + ";";
    }
    let hash = 2166136261n;
    for (let i = 0; i < combined.length; i++) {
        hash ^= BigInt(combined.charCodeAt(i));
        hash *= 16777619n;
    }
    return hash.toString(16);
}

function initWallpaperModule() {
    let config = null;
    try {
        config = JSON.parse(localStorage.getItem('wallpaper_config'));
    } catch (e) {
        config = null;
    }

    if (!config || !Array.isArray(config.list) || config.list.length === 0) {
        return;
    }
    document.body.style.background = "transparent";
    document.documentElement.style.background = "#000";

    applyWallpaper(config);

    startWallpaperTimer(config);

    createWallpaperPanel(config);

    window.addEventListener('storage', (e) => {
        if (e.key === 'wallpaper_config') {
            let newConfig = null;
            try { newConfig = JSON.parse(e.newValue); } catch (_) { }
            if (newConfig) {
                applyWallpaper(newConfig);
                startWallpaperTimer(newConfig);
                updateWallpaperPanelUI(newConfig);
            }
        }
    });
}

function applyWallpaper(config) {
    const bgLayer = document.getElementById('wallpaper-bg');
    if (!bgLayer) return;

    if (config.list.length === 0) {
        bgLayer.style.backgroundImage = 'none';
        return;
    }

    if (config.currentIndex >= config.list.length) {
        config.currentIndex = 0;
    }

    const currentUrl = config.list[config.currentIndex];
    bgLayer.style.backgroundImage = `url("../../${currentUrl}")`;
    bgLayer.style.backgroundSize = config.layout || 'contain';
}

function startWallpaperTimer(config) {
    if (wallpaperTimer) {
        clearInterval(wallpaperTimer);
        wallpaperTimer = null;
    }

    if (config.mode === 'fixed' || config.list.length <= 1) {
        return;
    }

    const interval = Number(config.interval) || 3600000; // 默认1小时

    wallpaperTimer = setInterval(() => {
        let curConfig = JSON.parse(localStorage.getItem('wallpaper_config'));
        if (!curConfig || curConfig.list.length === 0) return;

        if (curConfig.mode === 'sequential') {
            curConfig.currentIndex = (curConfig.currentIndex + 1) % curConfig.list.length;
        } else if (curConfig.mode === 'random') {
            let nextIdx;
            do {
                nextIdx = Math.floor(Math.random() * curConfig.list.length);
            } while (nextIdx === curConfig.currentIndex && curConfig.list.length > 1);
            curConfig.currentIndex = nextIdx;
        }

        localStorage.setItem('wallpaper_config', JSON.stringify(curConfig));
        applyWallpaper(curConfig);
        updateWallpaperPanelUI(curConfig);
    }, interval);
}

function createWallpaperPanel(config) {
    if (document.getElementById('wallpaper-trigger-btn')) return;

    const triggerBtn = document.createElement('button');
    triggerBtn.id = 'wallpaper-trigger-btn';
    triggerBtn.innerHTML = '🎨';
    triggerBtn.title = '壁纸设置面板';
    document.body.appendChild(triggerBtn);

    const tooltip = document.createElement('span');
    tooltip.className = 'wp-preview-tooltip';
    document.body.appendChild(tooltip);

    const panel = document.createElement('div');
    panel.id = 'wallpaper-panel';
    panelDomRef = panel;
    document.body.appendChild(panel);

    renderPanelInnerContent(panel, config, tooltip);

    triggerBtn.onclick = () => {
        panel.classList.toggle('active');
    };
}

function renderPanelInnerContent(panel, config, tooltip) {
    panel.innerHTML = `
        <span style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:4px; display:flex; justify-content:space-between;">
            <span>🎨 壁纸管理器</span>
            <span style="cursor:pointer; color:#aaa;" onclick="document.getElementById('wallpaper-panel').classList.remove('active')">✕</span>
        </span>
        <span style="font-size:11px; color:#aaa;">已添加壁纸 (${config.list.length}张)</span>
        <span class="wp-list" id="wp-list-container"></span>
        
        <div id="b1" style="display:flex; flex-direction:column; gap:4px; margin-top:4px; font-size:12px;">
            <label>切换模式: <button id="wp-mode-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">固定单张</button></label>
            <label>切换频率: <button id="wp-interval-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">1小时</button></label>
            <label>显示布局: <button id="wp-layout-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">Contain</button></label>
        </div>
    `;
    fillWallpaperListItems(config, tooltip);
    bindPanelEvents(config);
}

function fillWallpaperListItems(config, tooltip) {
    const listContainer = document.getElementById('wp-list-container');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    config.list.forEach((url, idx) => {
        const item = document.createElement('span');
        item.className = 'wp-item';

        const isCurrent = idx === config.currentIndex;
        item.innerHTML = `
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; ${isCurrent ? 'color:#60a5fa; font-weight:bold;' : ''}" title="${url}">
                ${isCurrent ? '📌 ' : ''}${idx + 1}. ${url.split('/').pop() || url}
            </span>
            <span>
                <button class="wp-set-btn" data-idx="${idx}" style="font-size:10px; cursor:pointer;" title="设为当前">设为当前</button>
                <button class="wp-del-btn" data-idx="${idx}" style="font-size:10px; cursor:pointer; color:#ef4444;" title="删除">🗑️</button>
            </span>
        `;

        item.onmouseenter = (e) => {
            tooltip.style.backgroundImage = `url("../../${url}")`;
            tooltip.style.display = 'block';
            moveTooltip(e, tooltip);
        };
        item.onmousemove = (e) => {
            moveTooltip(e, tooltip);
        };
        item.onmouseleave = () => {
            tooltip.style.display = 'none';
        };

        listContainer.appendChild(item);
    });

    listContainer.querySelectorAll('.wp-set-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const idx = Number(btn.getAttribute('data-idx'));
            let cur = JSON.parse(localStorage.getItem('wallpaper_config'));
            cur.currentIndex = idx;
            localStorage.setItem('wallpaper_config', JSON.stringify(cur));
            applyWallpaper(cur);
            updateWallpaperPanelUI(cur);
        };
    });

    listContainer.querySelectorAll('.wp-del-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const idx = Number(btn.getAttribute('data-idx'));
            let cur = JSON.parse(localStorage.getItem('wallpaper_config'));
            cur.list.splice(idx, 1);
            if (cur.currentIndex >= cur.list.length) {
                cur.currentIndex = Math.max(0, cur.list.length - 1);
            }
            localStorage.setItem('wallpaper_config', JSON.stringify(cur));

            if (cur.list.length === 0) {
                localStorage.removeItem('wallpaper_config');
                location.reload();
                return;
            }

            applyWallpaper(cur);
            startWallpaperTimer(cur);
            updateWallpaperPanelUI(cur);
        };
    });
}

function moveTooltip(e, tooltip) {
    const x = e.clientX + 15;
    const y = e.clientY - 110;
    tooltip.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    tooltip.style.top = Math.max(y, 10) + 'px';
}

function bindPanelEvents(config) {
    const modeOpts = [
        { val: 'fixed', label: '固定单张' },
        { val: 'sequential', label: '顺序轮播' },
        { val: 'random', label: '随机切换' }
    ];
    const intervalOpts = [
        { val: 5000, label: '5秒 (测试)' },
        { val: 600000, label: '10分钟' },
        { val: 3600000, label: '1小时' },
        { val: 21600000, label: '6小时' }
    ];
    const layoutOpts = [
        { val: 'contain', label: 'Contain' },
        { val: 'cover', label: 'Cover' },
        { val: 'repeat', label: 'Repeat' },
        { val: 'auto', label: 'Auto' }
    ];

    const saveChanges = () => {
        let cur = JSON.parse(localStorage.getItem('wallpaper_config')) || {};
        cur.mode = document.getElementById('wp-mode-btn').dataset.val;
        cur.interval = Number(document.getElementById('wp-interval-btn').dataset.val);
        cur.layout = document.getElementById('wp-layout-btn').dataset.val;
        localStorage.setItem('wallpaper_config', JSON.stringify(cur));
        applyWallpaper(cur);
        startWallpaperTimer(cur);
    };

    const setupCycleBtn = (id, options, currentVal) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        let curIdx = options.findIndex(o => String(o.val) === String(currentVal));
        if (curIdx === -1) curIdx = 0;
        
        btn.textContent = options[curIdx].label;
        btn.dataset.val = options[curIdx].val;

        btn.onclick = (e) => {
            e.stopPropagation();
            curIdx = (curIdx + 1) % options.length;
            btn.textContent = options[curIdx].label;
            btn.dataset.val = options[curIdx].val;
            saveChanges();
        };
    };

    setupCycleBtn('wp-mode-btn', modeOpts, config.mode || 'fixed');
    setupCycleBtn('wp-interval-btn', intervalOpts, config.interval || 3600000);
    setupCycleBtn('wp-layout-btn', layoutOpts, config.layout || 'contain');
}
function updateWallpaperPanelUI(config) {
    if (!panelDomRef) return;
    const tooltip = document.querySelector('.wp-preview-tooltip');
    fillWallpaperListItems(config, tooltip);
    bindPanelEvents(config);
}