const childId = 'content';
const store = createStore();
store.resource_type = "bookmark";

// 事件网关
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
        // 开启一个微型探针，等待 index.js 处理完毕
        const checkLock = setInterval(() => {
            if (store.bookmarkhtml_modifing !== "1") {
                clearInterval(checkLock);
                setupDragAndDrop();
            }
        }, 100);
    }

    loadFaviconsWhenIdle();
    initWallpaperModule();

    const footer_links = document.querySelectorAll('#copyright a');
    let usageLink = null;
    for (let link of footer_links) {
        if (link.textContent.trim() === '[使用说明]') { //[cite: 1]
            usageLink = link;
            break;
        }
    }
    if (usageLink) {
        usageLink.addEventListener('mouseenter', function() {
            if (!this.title) {
                this.title = "正在获取项目体积...";
                fetch('https://api.github.com/repos/diff4x/diff4x.github.io')
                    .then(response => response.json())
                    .then(data => {
                        if (data && data.size) {
                            const sizeInMb = (data.size / 1024).toFixed(2);
                            this.title = `当前项目体积: ${sizeInMb}Mb`;
                        } else {
                            this.title = "获取体积失败";
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching repo data:', error);
                        this.title = "获取体积失败";
                    });
            }
        });
    }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '\\') {
    sendToParent("quick_search", "");
  }
});

// 代理
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

// postMessage 封装
function sendToParent(type, payload) {
  parent.postMessage({ type, payload, from: childId }, '*');
}
function sendToSibling(targetId, type, payload) {
    const targetIframe = window.parent.document.getElementById(targetId)?.contentWindow;
    if (targetIframe) {
        targetIframe.postMessage({ type, payload, from: childId, to: targetId }, '*');
    }
}

// ast
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
      sendToParent('reload_bookmark');
      location.href = store.protocol_name + "://2{" + encodeURIComponent(param);
    });
  });
}

let faviconStyleEl = null;
function getFaviconStyleEl() {
    if (!faviconStyleEl) {
        faviconStyleEl = document.createElement('style');
        faviconStyleEl.id = 'favicon-style';
        document.head.appendChild(faviconStyleEl);
    }
    return faviconStyleEl;
}

// 记录原有 a 标签在其父级 div 中的序号（对应 CSS :nth-of-type），不写回 DOM，只用于生成选择器
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

// 在浏览器/网络空闲时逐个抓取图标，成功的才写入动态样式表
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
        return; // 非法链接跳过
    }
    const faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(hostname)}`;

    // 先用一张探测用的 Image 静默验证图标是否可加载成功，失败(如 404)则捕获并忽略，不写入样式
    const probe = new Image();
    probe.dataset.faviconProbe = '1';
    probe.onload = () => {
        appendFaviconRule(divId, nth, faviconUrl);
    };
    probe.onerror = (err) => {
        // 静默忽略加载失败，不抛出、不写入样式
        try { probe.onerror = null; probe.onload = null; probe.src = ''; } catch (_) {}
    };
    probe.src = faviconUrl;
}

// 只在动态创建的 <style> 块中通过 "#divId > a:nth-of-type(n)::before" 的方式渲染图标
function appendFaviconRule(divId, nth, faviconUrl) {
    const styleEl = getFaviconStyleEl();
    const selector = `#${CSS.escape(divId)} > a:nth-of-type(${nth})`;
    styleEl.appendChild(document.createTextNode(
        `${selector}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;` +
        `background-image:url("${faviconUrl}");background-size:contain;background-repeat:no-repeat;` +
        `background-position:center;vertical-align:-2px;}\n`
    ));
}

// 字符串哈希
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

// ==========================================
// 壁纸管理与轮播引擎模块
// ==========================================
let wallpaperTimer = null;

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
            try { newConfig = JSON.parse(e.newValue); } catch(_){}
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

    // 越界保护
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

let panelDomRef = null;
function createWallpaperPanel(config) {
    if (document.getElementById('wallpaper-trigger-btn')) return;

    const triggerBtn = document.createElement('button');
    triggerBtn.id = 'wallpaper-trigger-btn';
    triggerBtn.innerHTML = '🖼️';
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
            <span>🖼️ 壁纸管理器</span>
            <span style="cursor:pointer; color:#aaa;" onclick="document.getElementById('wallpaper-panel').classList.remove('active')">✕</span>
        </span>
        <span style="font-size:11px; color:#aaa;">已添加壁纸 (${config.list.length}张)</span>
        <span class="wp-list" id="wp-list-container"></span>
        
        <div id="b1" style="display:flex; flex-direction:column; gap:4px; margin-top:4px; font-size:12px;">
            <label>切换模式: 
                <select id="wp-mode-select" style="background:#2a2a2a; color:#eee; border:1px solid #555;">
                    <option value="fixed">固定单张</option>
                    <option value="sequential">顺序轮播</option>
                    <option value="random">随机切换</option>
                </select>
            </label>
            <label>切换频率: 
                <select id="wp-interval-select" style="background:#2a2a2a; color:#eee; border:1px solid #555;">
                    <option value="5000">5秒 (测试)</option>
                    <option value="600000">10分钟</option>
                    <option value="3600000">1小时</option>
                    <option value="21600000">6小时</option>
                </select>
            </label>
            <label>显示布局: 
                <select id="wp-layout-select" style="background:#2a2a2a; color:#eee; border:1px solid #555;">
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                    <option value="repeat">Repeat</option>
                    <option value="auto">Auto</option>
                </select>
            </label>
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
    const modeSelect = document.getElementById('wp-mode-select');
    const intervalSelect = document.getElementById('wp-interval-select');
    const layoutSelect = document.getElementById('wp-layout-select');

    if(modeSelect) modeSelect.value = config.mode || 'fixed';
    if(intervalSelect) intervalSelect.value = config.interval || 3600000;
    if(layoutSelect) layoutSelect.value = config.layout || 'contain';

    const saveChanges = () => {
        let cur = JSON.parse(localStorage.getItem('wallpaper_config')) || {};
        cur.mode = modeSelect.value;
        cur.interval = Number(intervalSelect.value);
        cur.layout = layoutSelect.value;
        localStorage.setItem('wallpaper_config', JSON.stringify(cur));
        applyWallpaper(cur);
        startWallpaperTimer(cur);
    };

    if(modeSelect) modeSelect.onchange = saveChanges;
    if(intervalSelect) intervalSelect.onchange = saveChanges;
    if(layoutSelect) layoutSelect.onchange = saveChanges;
}

function updateWallpaperPanelUI(config) {
    if (!panelDomRef) return;
    const tooltip = document.querySelector('.wp-preview-tooltip');
    fillWallpaperListItems(config, tooltip);
    
    const modeSelect = document.getElementById('wp-mode-select');
    const intervalSelect = document.getElementById('wp-interval-select');
    const layoutSelect = document.getElementById('wp-layout-select');
    if(modeSelect) modeSelect.value = config.mode || 'fixed';
    if(intervalSelect) intervalSelect.value = config.interval || 3600000;
    if(layoutSelect) layoutSelect.value = config.layout || 'contain';
}