if (window.top === window.self) {
  window.location.href = location.origin;
} else if (window.parent !== window.top) {
  window.top.location.href = location.origin;
}

const childId = 'side';
const store = createStore({ last_li_a: [] });
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
let flag_jump_from_search = false;

// 双击状态机
let lastRightClickTime = 0;
let lastRightClickX = 0;
let lastRightClickY = 0;
let rightClickTimer = null;
const RIGHT_CLICK_DOUBLE_MS = 300;
const RIGHT_CLICK_DISTANCE = 8;

// 事件网关
window.addEventListener('message', (e) => {
    const { type, payload, to } = e.data || {};
    
    if (type === 'RENDER_CATALOG') {
        buildCatalogFromLiteData(payload);
        return;
    }

    if (to && to !== childId) return;
    switch (type) {
        case 'show_update_banner':
            if (document.getElementById('update-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'update-banner';
            banner.innerText = '发现新版本, 点击更新';
            banner.onclick = () => { sendToParent('execute_update', null); banner.remove(); };
            document.body.prepend(banner); 
            break;
        case '#html a':
        case '#gallery a':
        case '#video a':
        case '#audio a':
        case '#ebook a':
            const targetEl = document.querySelector(`${type}[data-path="${CSS.escape(payload)}"]`);
            if (targetEl) {
                if (type === "#html a") flag_jump_from_search = true;
                targetEl.click();
            }
            break;
        case 'show_current':
            show_current();
            break;
        case 'UPDATE_FAV_LIST':
            render_fav_trigger();
            break;
        default:
            break;
    }
});

// 其它监听
document.addEventListener('keydown', (e) => {
    if (e.key === '\\') sendToParent("quick_search","");
});
window.addEventListener('contextmenu', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const now = Date.now();
    const deltaTime = now - lastRightClickTime;
    const deltaX = e.clientX - lastRightClickX;
    const deltaY = e.clientY - lastRightClickY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    const isDoubleClick = deltaTime <= RIGHT_CLICK_DOUBLE_MS && distance <= RIGHT_CLICK_DISTANCE;

    lastRightClickTime = now;
    lastRightClickX = e.clientX;
    lastRightClickY = e.clientY;

    if (isDoubleClick) {
        clearTimeout(rightClickTimer);
        lastRightClickTime = 0; 
        return;
    }
    e.preventDefault(); 
    
    rightClickTimer = setTimeout(() => {
        sendToParent('SHOW_GLOBAL_BOOKMARKS', {
            x: e.clientX,
            y: e.clientY,
            source: 'side' // 或 'content'
        });
    }, RIGHT_CLICK_DOUBLE_MS);
});
window.onload = () => {
    if (store.online_flag === "0") {
        document.querySelectorAll('a.admin').forEach(a => { a.classList.remove("hidden"); });
    }

    adj_width();
    go_top();

    const a1Btn = document.getElementById("a1");
    bindDualClick(
        a1Btn, 
        function (e) { e.preventDefault(); window.top.location.href = store.protocol_name + "://4"; }, 
        function (e) { e.preventDefault(); window.top.location.href = store.protocol_name + "://6"; }, 
        250
    );

    document.getElementById("a2").setAttribute("href", store.protocol_name+"://3{/Dropbox/diff4x.github.io");
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

// ls 代理
function createStore(defaults = {}) {
    return new Proxy({}, {
        get(_, prop) {
            const val = localStorage.getItem(prop);
            if (val === null) return defaults[prop];
            try { return JSON.parse(val); } catch { return val; }
        },
        set(_, prop, value) {
            localStorage.setItem(prop, JSON.stringify(value));
            return true;
        },
        deleteProperty(_, prop) {
            localStorage.removeItem(prop);
            return true;
        }
    });
}

// 目录构建
function buildCatalogFromLiteData(liteData) {
    if (!liteData || typeof liteData !== 'object') return;

    const containers = {
        'html': $('#html'),
        'image': $('#gallery'), 
        'ebook': $('#ebook'),
        'video': $('#video'),
        'audio': $('#audio')
    };

    Object.keys(containers).forEach(type => {
        const container = containers[type];
        if (!container) return;
        container.innerHTML = ''; 

        const rootNode = liteData[type];
        if (!rootNode) return;

        let basePrefix = '';
        if (type === 'html') basePrefix = 'html/';
        else if (type === 'image') basePrefix = 'gallery/';
        else if (type === 'video') basePrefix = 'video/';
        else if (type === 'audio') basePrefix = 'audio/';
        else if (type === 'ebook') basePrefix = 'ebook/';

        renderStructuredTree(rootNode, container, type, basePrefix);
    });
 
    document.body.style.opacity = 1;
    document.body.style.transition = "opacity 0.3s ease";

    if (!window._eventsBound) {
        if (typeof click_func === 'function') click_func(); 
        if (typeof dbl_click_func === 'function') dbl_click_func();
        window._eventsBound = true;
    }
    if (typeof updateRecentLinks === 'function') updateRecentLinks();

    store.wallpaperPaths = get_wallpaperPaths();

    if (!window._markSystemBound) {
        mark();
        window._markSystemBound = true;
    }

    if (!window._menuSystemBound) {
        menu();
        window._menuSystemBound = true;
    }
}

// 核心渲染
function renderStructuredTree(node, parentElement, bucketType, currentPrefix) {
    if (!node || typeof node !== 'object') return;

    // 优先渲染所有的文件夹
    const subDirs = Object.keys(node).filter(k => k !== '_f').sort((a, b) => a < b ? -1 : (a > b ? 1 : 0));
    subDirs.forEach(dirName => {
        const span = document.createElement('span');
        span.className = 'category inactive';
        span.textContent = dirName === '_uncategorized' ? '未分类' : dirName;
        
        const ul = document.createElement('ul');
        ul.className = 'hidden';

        span.onclick = () => {
            const isHidden = ul.classList.toggle('hidden');
            span.className = isHidden ? 'category inactive' : 'category active';
        };

        parentElement.append(span, ul);
        
        const nextPrefix = dirName === '_uncategorized' ? currentPrefix : currentPrefix + dirName + '/';
        renderStructuredTree(node[dirName], ul, bucketType, nextPrefix);
    });

    // 渲染当前层级下的叶子文件
    if (Array.isArray(node._f)) {
        const sortedFiles = node._f.sort((a, b) => {
            if (bucketType === 'html') {
                const stampA = (a[3] || "").split('-')[0];
                const stampB = (b[3] || "").split('-')[0];
                if (stampA && stampB && stampA !== stampB) return stampB > stampA ? 1 : -1;
            }
            return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
        });

        const frag = document.createDocumentFragment();
        const isOnline = store.online_flag === "1";
        sortedFiles.forEach(([fileName, id, type, info]) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            let title = fileName;

            // localOnly 嗅探
            const isPrivate = typeof info === 'string' && info.includes('localOnly');

            if (bucketType === 'html') {
                a.href = '../../html/' + fileName; 
                a.target = 'content';
                if (typeof info === 'string' && info.includes('-')) a.dataset.stamp = info.split('-')[0];
                a.dataset.path = 'html/' + fileName;
            } else {
                if (bucketType === 'ebook' && type) a.dataset.type = type;
                a.dataset.path = currentPrefix + fileName;
            }

            if (isPrivate) {
                a.dataset.localOnly = "true";

                if (isOnline) {
                    a.classList.add('locked');
                    a.style.opacity = '0.5';
                } else {
                    a.classList.add('unlocked');
                }
            }
            
            a.textContent = bucketType === 'html' ? title.replace(/\.html$/, '') : title;
            li.appendChild(a);
            frag.appendChild(li); 
        });
        parentElement.appendChild(frag);
    }
}

// 条目标记
async function mark() {
    const MarkSystem = {
        dbName: 'SideDB',
        storeName: 'marks',
        urls: new Set(), 
        db: null,

        async init() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(this.dbName, 1);
                req.onupgradeneeded = (e) => {
                    e.target.result.createObjectStore(this.storeName, { keyPath: 'url' });
                };
                req.onsuccess = (e) => {
                    this.db = e.target.result;
                    const lifepod = store.ss_marks_lifepod;
                    const txMode = lifepod ? 'readwrite' : 'readonly';
                    const tx = this.db.transaction(this.storeName, txMode);
                    const idbStore = tx.objectStore(this.storeName);

                    if (lifepod && Array.isArray(lifepod)) {
                        try {
                            idbStore.clear();
                            lifepod.forEach(url => idbStore.put({ url }));
                            delete store.ss_marks_lifepod;
                        } catch (err) {}
                    }

                    const getAllReq = idbStore.getAll();
                    getAllReq.onsuccess = () => {
                        this.urls = new Set(getAllReq.result.map(item => item.url));
                        resolve();
                    };
                };
                req.onerror = () => reject(req.error);
            });
        },

        async toggle(url) {
            const isMarked = this.urls.has(url);
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            
            if (isMarked) {
                this.urls.delete(url);
                store.delete(url);
            } else {
                this.urls.add(url);
                store.put({ url });
            }
            return !isMarked; 
        },

        // 状态恢复
        restoreDOM() {
            document.querySelectorAll('a[data-path]').forEach(a => {
                const url = a.dataset.path; 
                if (url) {
                    if (this.urls.has(url)) a.classList.add('item-marked');
                    else a.classList.remove('item-marked');
                }
            });

            document.querySelectorAll('.history-list span[data-path]').forEach(span => {
                const url = span.dataset.path; 
                if (url) {
                    if (this.urls.has(url)) span.classList.add('item-marked');
                    else span.classList.remove('item-marked');
                }
            });
        }
    };

    window.MarkSystem = MarkSystem;
    await MarkSystem.init();

    // 核心改动：为每个 li 注入按钮
    const allItems = document.querySelectorAll('li');
    allItems.forEach(li => {
        const a = li.querySelector('a');
        if (!a || !a.dataset.path) return;

        const path = a.dataset.path;
        const btn = document.createElement('span');
        btn.className = 'mark-btn';
        btn.textContent = '[Mark]';
        
        // 初始化状态
        if (MarkSystem.urls.has(path)) {
            a.classList.add('item-marked');
            btn.textContent = '[UnMark]';
        }

        // 点击事件
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isNowMarked = await MarkSystem.toggle(path);
            
            // 同步所有该路径的 UI
            const targets = document.querySelectorAll(`[data-path="${CSS.escape(path)}"]`);
            targets.forEach(t => {
                if (isNowMarked) t.classList.add('item-marked');
                else t.classList.remove('item-marked');
            });
            
            // 更新按钮文字
            document.querySelectorAll(`.mark-btn[data-path="${CSS.escape(path)}"]`)
                .forEach(b => b.textContent = isNowMarked ? '[UnMark]' : '[Mark]');
        });

        btn.dataset.path = path; // 绑定路径用于查找
        li.appendChild(btn);
    });

    MarkSystem.restoreDOM();
}

// 点击事件
function click_func() {
    function delegateClick(containerSelector, selector, handler) {
        const container = document.querySelector(containerSelector);
        if (!container) return;
        container.addEventListener("click", (e) => {
            const el = e.target.closest(selector);
            if (el && container.contains(el)) {
                if (store.online_flag === "1" && el.dataset.localOnly === "true") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!window._alertLocked) {
                        window._alertLocked = true;
                        alert("🔒 访问受限：仅限本地查阅。");
                        setTimeout(() => {
                            window._alertLocked = false;
                        }, 300);
                    }
                    return false;
                }
                handler(el, e);
            }
        });
    }

    function getGroupLinks(element) {
        return Array.from(element.parentElement.parentElement.children)
            .filter(child => child.tagName === 'LI')
            .map(li => li.querySelector('a')).filter(a => a);
    }

    delegateClick("#html", "a", (a) => {
        sendToParent("mask", { op: "add" });
        store.resource_type = "html";
        store.last_html = a.dataset.path;

        if (!flag_jump_from_search) {
            store.jump_from_search = "0";
            if (store.keyword && store.keyword.trim() !== "") {
                store.jump_from_search_ex = "1";
            }
        } else {
            flag_jump_from_search = false;
            if (store.giscus_jump != "1") store.jump_from_search_ex = "1";
            store.giscus_jump = "0";
        }

        $$('li').forEach(l => l.classList.remove('current'));
        a.parentElement.classList.add('current');
        recordHistory(a.dataset.path);

        const date = parse_date(a.dataset.stamp);
        const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' };
        if (date) {
            a.setAttribute("title", date.toLocaleDateString('en-US', options));
        }
    });

    delegateClick("#ebook", "a", (a) => {
        sendToParent("mask", { op: "add" });
        switch (a.dataset.type) {
            case "txt": store.txt_path = a.dataset.path; break;
            case "pdf": store.pdf_path = a.dataset.path; break;
            case "epub": store.epub_path = a.dataset.path; break;
        }
        store.resource_type = a.dataset.type;
        sendToParent(a.dataset.type);

        $$('li').forEach(l => l.classList.remove('current'));
        a.parentElement.classList.add('current');
        recordHistory(a.dataset.path);
    });

    delegateClick("#video", "a", (a) => {
        sendToParent("mask", { op: "add" });
        store.videolist = getGroupLinks(a).map(x => x.dataset.path);
        store.resource_type = "video";
        store.video_path = a.dataset.path;
        sendToParent("video");

        $$('li').forEach(l => l.classList.remove('current'));
        a.parentElement.classList.add('current');
        recordHistory(a.dataset.path);
    });

    delegateClick("#audio", "a", (a) => {
        store.playlist = getGroupLinks(a).map(x => x.textContent);
        store.resource_type = "audio";
        store.song_path = a.dataset.path;
        sendToParent("audio");

        $$('li').forEach(l => l.classList.remove('current'));
        a.parentElement.classList.add('current');
        recordHistory(a.dataset.path);
    });

    delegateClick("#gallery", "a", (a) => {
        sendToParent("mask", { op: "add" });
        store.imagelist = getGroupLinks(a).map(x => x.dataset.path);
        store.resource_type = "image";
        store.image_path = a.dataset.path;
        sendToParent("image");

        $$('li').forEach(l => l.classList.remove('current'));
        a.parentElement.classList.add('current');
        recordHistory(a.dataset.path);
    });

    $("#a a").addEventListener("click", function () { sendToParent("mask", { op: "remove" }); });
    store.resource_type = "bookmark";
}
function dbl_click_func() {
    function copy_to_clipboard(text) {
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(err => console.warn("复制失败", err));
    }

    ["#gallery", "#audio", "#video", "#ebook"].forEach(sel => {
        const container = document.querySelector(sel);
        if (!container) return;
        container.addEventListener("dblclick", (e) => {
            const li = e.target.closest("li");
            if (li && container.contains(li)) copy_to_clipboard(li.textContent.trim());
        });
    });

    const htmlContainer = document.querySelector("#html");
    if (htmlContainer) {
        htmlContainer.addEventListener("dblclick", (e) => {
            const li = e.target.closest("li");
            if (li && htmlContainer.contains(li)) copy_to_clipboard(li.textContent.trim() + ".html");
        });
    }
}
function bindDualClick(element, onSingleClick, onDoubleClick, delay = 250) {
    let clickTimer = null;
    element.addEventListener('click', function(event) {
        event.preventDefault(); 
        
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { 
            if (typeof onSingleClick === 'function') onSingleClick.call(this, event); 
        }, delay);
    });
    
    element.addEventListener('dblclick', function(event) {
        event.preventDefault(); 
        
        clearTimeout(clickTimer);
        if (typeof onDoubleClick === 'function') onDoubleClick.call(this, event);
    });
}

// 菜单渲染
async function menu() {
    const menuB = $('#menu-b');
    const bContainer = $('#b'); 

    if (menuB && bContainer) {
        let menuBHoverTimer = null;
        bContainer.addEventListener('mouseenter', () => {
            if (menuBHoverTimer) clearTimeout(menuBHoverTimer);
            menuB.style.visibility = 'visible';
            menuB.style.opacity = '1';
            menuB.style.pointerEvents = 'auto';
        });
        bContainer.addEventListener('mouseleave', () => {
            menuBHoverTimer = setTimeout(() => {
                menuB.style.visibility = 'hidden';
                menuB.style.opacity = '0';
                menuB.style.pointerEvents = 'none';
            }, 200); 
        });

        const logBtn = document.createElement('a');
        logBtn.textContent = "What's new?";
        logBtn.style.cursor = 'pointer';
        logBtn.className = 'o';
        logBtn.onclick = () => {
            sendToParent('show_changelog', null);
            menuB.style.display = 'none';
            setTimeout(() => menuB.style.display = '', 100);
        };
        if (menuB.children.length > 1) menuB.insertBefore(logBtn, menuB.children[1]);
        else menuB.appendChild(logBtn);

        const excerptsBtn = document.createElement('a');
        excerptsBtn.textContent = "摘抄本";
        excerptsBtn.style.cursor = 'pointer';
        excerptsBtn.className = 'o';
        excerptsBtn.onclick = () => {
            sendToParent('OPEN_EXCERPTS_NOTEBOOK', null);
            menuB.style.display = 'none';
            setTimeout(() => menuB.style.display = '', 100);
        };
        menuB.insertBefore(excerptsBtn, logBtn.nextSibling);

        const historyWrapper = document.createElement('div');
        historyWrapper.className = 'history-wrapper';
        historyWrapper.id = 'historyWrapper';
        historyWrapper.style.cssText = 'position:relative; display:inline-block;padding: 0;';

        const historyBtn = document.createElement('a');
        historyBtn.textContent = 'History';
        historyBtn.style.cursor = 'pointer';
        historyBtn.className = 'o';
        historyBtn.style.display = 'block'; 
        historyBtn.style.padding = '2px 0 0 10px;';

        const historyList = document.createElement('div');
        historyList.className = 'history-list';
        historyList.style.cssText = 'display:none; position:absolute; left:100%; top:0; background:#fff!important; border:1px solid #ccc; box-shadow:3px 3px 10px rgba(0,0,0,0.2); max-height:60vh; overflow-y:auto; z-index:10001; flex-direction:column; border-radius:4px;';
        
        historyWrapper.appendChild(historyBtn);
        historyWrapper.appendChild(historyList);
        
        if (menuB.children.length > 1) menuB.insertBefore(historyWrapper, menuB.children[2]);
        else menuB.appendChild(historyWrapper);

        let historyHideTimer = null;
        historyWrapper.addEventListener('mouseenter', () => {
            if (historyHideTimer) {
                clearTimeout(historyHideTimer);
                historyHideTimer = null;
            }

            historyList.innerHTML = '';
            let history = store.last_li_a;
            if (!Array.isArray(history)) history = history ? [history] : [];

            if (history.length === 0) {
                const empty = document.createElement('span');
                empty.textContent = '空';
                empty.style.cssText = 'padding:10px 15px; font-size:12px; color:#999;';
                historyList.appendChild(empty);
            } else {
                history.forEach((path, idx) => {
                    const span = document.createElement('span');
                    const filename = path.split('/').pop();
                    span.dataset.path = path;
                    
                    if (window.MarkSystem && window.MarkSystem.urls.has(path)) {
                        span.classList.add('item-marked');
                    }

                    span.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 12px; cursor:pointer; font-size:12px; color:#333; background:#fff; border-bottom:1px solid #f0f0f0; transition:all 0.2s;';

                    const textSpan = document.createElement('span');
                    textSpan.textContent = filename;
                    textSpan.title = path;
                    textSpan.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;';
                    span.appendChild(textSpan);

                    const btn = document.createElement('span');
                    btn.className = 'mark-btn';
                    btn.textContent = window.MarkSystem.urls.has(path) ? '[UnMark]' : '[Mark]';
                    btn.dataset.path = path;

                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        const isNowMarked = await window.MarkSystem.toggle(path);
                        btn.textContent = isNowMarked ? '[UnMark]' : '[Mark]';
                        document.querySelectorAll(`[data-path="${CSS.escape(path)}"]`).forEach(el => {
                            if (isNowMarked) el.classList.add('item-marked');
                            else el.classList.remove('item-marked');
                        });
                        span.className = isNowMarked ? 'item-marked' : '';
                    };

                    span.appendChild(btn);

                    span.onclick = (e) => {
                        e.stopPropagation();
                        if (e.target.classList.contains('mark-btn')) return;

                        const aTag = document.querySelector(`a[data-path="${path}"]`);
                        if (aTag) {
                            aTag.click();
                            show_current();
                        } else {
                            console.warn("未找到对应DOM节点", path);
                        }
                    };
                    
                    historyList.appendChild(span);
                });
            }
            historyList.style.display = 'flex';
        });

        historyWrapper.addEventListener('mouseleave', () => {
            historyHideTimer = setTimeout(() => {
                historyList.style.display = 'none';
            }, 1000);
        });

        render_fav_trigger();
    }
}
function render_fav_trigger() {
    const oldTrigger = document.querySelector('.fav-trigger-btn');
    if (oldTrigger) oldTrigger.remove();

    const favList = store.favList;
    if (!favList || !Array.isArray(favList) || favList.length === 0) {
        return; 
    }

    const favTrigger = document.createElement('a');
    favTrigger.textContent = `Fav (${favList.length})`;
    favTrigger.className = 'fav-trigger-btn o';

    favTrigger.onclick = () => {
        const audioList = document.querySelectorAll('#audio li');
        if(audioList) audioList.forEach(l => l.classList.remove('current'));
        sendToParent('play_fav_list', null);
    };

    const historyNode = document.getElementById('historyWrapper'); 
    historyNode.after(favTrigger);
}

// 导航历史
function recordHistory(path) {
    if (!path) return;
    let history = store.last_li_a;
    if (!Array.isArray(history)) history = history ? [history] : [];
    history = history.filter(p => p !== path); 
    history.unshift(path); 
    if (history.length > 50) history = history.slice(0, 50); 
    store.last_li_a = history;
}

// 最新条目
function updateRecentLinks() {
    let now = new Date();
    let cut_off_point = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    $$("ul").forEach(ul => {
        let links = ul.querySelectorAll("a");
        let totalLinks = links.length;
        let recentCount = 0;

        links.forEach(link => {
            if (link.hasAttribute("data-stamp")) {
                const date = parse_date(link.dataset.stamp);
                if (date >= cut_off_point) {
                    link.classList.add("recent");
                    recentCount++;
                } else {
                    link.classList.remove("recent");
                }
            }
        });

        let categorySpan = ul.previousElementSibling;
        if (categorySpan && categorySpan.classList.contains("category")) {
            if (recentCount > 0) {
                let opacity = 0.2 + (recentCount / totalLinks) * 0.8; 
                categorySpan.style.backgroundColor = `rgba(255, 100, 100, ${opacity})`;
                categorySpan.setAttribute("data-count", `[${recentCount}/${totalLinks}]`);
            } else {
                categorySpan.style.backgroundColor = "";
                categorySpan.setAttribute("data-count", `[${totalLinks}]`);
            }
        }
    });
}

// 其它辅助
function show_current() {
    const current = $('li.current');
    if (!current) return;
    $$('ul').forEach(ul => ul.classList.add('hidden'));
    $$('.category').forEach(span => { span.classList.remove('active'); span.classList.add('inactive'); });
    if (store.resource_type !== "bookmark") {
        let el = current;
        while (el) {
            const parentUl = el.closest('ul');
            if (!parentUl) break;
            parentUl.classList.remove('hidden');
            const categoryLabel = parentUl.previousElementSibling;
            if (categoryLabel && categoryLabel.classList.contains('category')) {
                categoryLabel.classList.remove('inactive');
                categoryLabel.classList.add('active');
            }
            el = parentUl.parentElement.closest('li, ul');
        }
        setTimeout(() => { current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100);
    }
}

function parse_date(dp) {
    if (!dp || dp.length < 14) return null;
    return new Date(dp.substring(0,4), dp.substring(4,6)-1, dp.substring(6,8), dp.substring(8,10), dp.substring(10,12), dp.substring(12,14));
}

function adj_width() {
    $("#c").addEventListener("click", function () { sendToParent("adj_side_width", { op: "+" }); });
    $("#d").addEventListener("click", function () { sendToParent("adj_side_width", { op: "-" }); });
}

function get_wallpaperPaths() {
    return Array.from(document.querySelectorAll('span.category'))
        .filter(span => span.textContent.trim() === 'wallpaper' && span.nextElementSibling?.tagName === 'UL')
        .flatMap(span => Array.from(span.nextElementSibling.querySelectorAll('a')).map(a => a.dataset.path.replace(/^..\//, '')));
}

function go_top() {
    let o = document.createElement('div');
    o.setAttribute("id", "gotop"); o.innerHTML = "<span>^</span>";
    o.addEventListener("click", function () { document.documentElement.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(o);

    let ticking = false;
    window.addEventListener('scroll', function () {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const top = document.body.scrollTop || document.documentElement.scrollTop;
                $("#gotop").style.display = top > 500 ? "block" : "none";
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });
}