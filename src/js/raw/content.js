// 支援 bilingual
(function interceptTextarea() {
    const observer = new MutationObserver((mutations, obs) => {
        const zhText = document.getElementById('zhText');
        if (zhText) {
            patchValueProperty(zhText);
            obs.disconnect();
        }
    });
    
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('DOMContentLoaded', () => observer.disconnect());

    let highlightTimer = null; 
    function patchValueProperty(el) {
        if (!Object.getOwnPropertyDescriptor(el, 'value')) {
            Object.defineProperty(el, 'value', {
                get: function() { return this.innerText; },
                set: function(val) { 
                    this.innerText = val; 
                    clearTimeout(highlightTimer);
                    highlightTimer = setTimeout(() => {
                        try {
                            const nav = document.getElementById('s_nav');
                            const isSearchActive = nav && nav.innerHTML.trim() !== '';
                            if (isSearchActive) {
                                nav.innerHTML = '';
                                localStorage.setItem('jump_from_search_ex', JSON.stringify("1"));
                                if (typeof search === 'function') {
                                    search();
                                }
                            }
                        } catch (e) {
                            console.error("恢复高亮失败:", e);
                        }
                    }, 150); 
                }
            });
        }
    }
})();

if (window.top === window.self) {
    window.location.href = location.origin;
} else if (window.parent !== window.top) {
    window.top.location.href = location.origin;
}

const childId = 'content';
const store = createStore();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
let toc_flag = false;
let isAutoScrolling = false;

let wasmEngineReady = false;
let find_content_matches = null;
let format_markdown = null;
const wasmInitPromise = import('../wasm/compute_intensive_task_processor.min.js').then(async (wasmModule) => {
    const init = wasmModule.default;
    find_content_matches = wasmModule.find_content_matches;
    format_markdown = wasmModule.format_markdown;
    await init();
    wasmEngineReady = true;
    // console.log("[Content] Rust 渲染与探测引擎加载完毕 (动态引入)");
}).catch(err => {
    console.error("[Content] Wasm 模块动态加载失败:", err);
});

// 事件网关
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}
window.addEventListener('message', (e) => {
    const { type, payload, to } = e.data || {};
    if (to && to !== childId) return;
    switch (type) {
        case "cm_count":
            $("#cm").innerText="💬 "+payload;
            if(payload !== 0){
                var str = payload > 1 ? " comments" : " comment";
                $("#cm").title=payload + str;
            }
            $("#cm").style.display = "block";
            break;
            
        case "LOCAL_SEARCH_COUNT":
            const resultObj = countMatchesEnhanced(payload);
            sendToParent("LOCAL_SEARCH_RESULT", { 
                keyword: payload, 
                count: resultObj.count, 
                title: document.title,
                snippets: resultObj.snippets,
                isTolerantMatch: resultObj.isTolerantMatch 
            });
            break;
            
        case "DESTROY_HIGHLIGHT": 
            const destroyBtn = document.getElementById("destroy");
            if (destroyBtn) {
                destroyBtn.click(); 
            } else {
                document.querySelectorAll(".match-highlight").forEach(h => {
                    h.parentNode.replaceChild(document.createTextNode(h.textContent), h);
                });
                const nav = document.getElementById("s_nav");
                if (nav) nav.innerHTML = "";
            }
            
            store.jump_from_search = "0";
            store.jump_from_search_ex = "0";
            break;
            
        default:
            break;
    }
});
window.addEventListener('unload', () => {
    sendToParent("lightbox", { status: "0" });
});
document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        sendToParent("quick_search", "");
    }
});

// 样式注入
(function initStyles() {
    if (!document.querySelector('link[href*="content.css"]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '../src/css/content.css';
        document.head.appendChild(css);
    }
    document.addEventListener("DOMContentLoaded", () => {
        document.body.style.opacity = 0;
        document.body.style.transition = "opacity 0.3s ease";
    });
})();

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

// 核心渲染
async function format() {
    return new Promise((resolve) => {
        const anchorNode = document.querySelector("#anchor");
        
        try {
            const preTag = document.querySelector('pre');
            if (!preTag) {
                postProcess();
                resolve();
                return;
            }

            const textNodes = Array.from(preTag.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);

            window._rawHtmlForDiff = preTag.innerHTML;

            let outHtmlArr = [];

            textNodes.forEach(node => {
                outHtmlArr.push(format_markdown(node.nodeValue));
            });
            textNodes.forEach((node, i) => {
                const fragment = document.createRange().createContextualFragment(outHtmlArr[i]);
                node.replaceWith(fragment);
            });

            postProcess(anchorNode);
            resolve();

        } catch (error) {
            console.error("[Wasm] 渲染引擎解析失败:", error);
            postProcess(anchorNode);
            resolve();
        }
    });

    function format_date(datePart) {
        if (!datePart || datePart.length < 14) return "Unknown Date";
        try {
            const year = datePart.substring(0, 4);
            const month = parseInt(datePart.substring(4, 6)) - 1;
            const day = datePart.substring(6, 8);
            const hours = datePart.substring(8, 10);
            const minutes = datePart.substring(10, 12);
            const seconds = datePart.substring(12, 14);
            const date = new Date(year, month, day, hours, minutes, seconds);
            const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' };
            return date.toLocaleDateString('en-US', options);
        } catch(e) { return "Invalid Date"; }
    }

    // DOM 收尾
    function postProcess(anchor) {
        // 看过的倒序编号
        document.querySelectorAll('pre.consumed').forEach(pre => {
            const spans = Array.from(pre.querySelectorAll('span.lv0')).filter(s => s.className.trim() === 'lv0' && !s.querySelector('span'));
            const total = spans.length;
            spans.forEach((s, i) => s.dataset.index = "[" + (total - i) + "]");
        });

        // p2tbl
        const paragraphs = Array.from(document.querySelectorAll('p'));
        paragraphs.forEach(paragraph => {
            paragraph.replaceWith(renderP2TableEl(paragraph.textContent));
        });

        // 标题栏
        const anchorText = anchor ? anchor.innerHTML : "";
        const parts = anchorText.split("-");
        if (parts.length < 2) parts.push("");
        const bar = document.createElement("div");
        bar.id = "bar";
        
        bar.innerHTML = `
            <span id='s_nav'></span>
            <span id='diff-btn'></span>
            <span id='cm' title='0 comment' style="display:none" onclick='sendToParent("sh_comments", document.getElementById("stamp")?.innerText || "")'>💬</span>
            <span id='stamp' title='${format_date(parts[0])}'>${parts[1]} > ${document.title}</span>
            <div style='top:0;left:0'>
                <div id='processBar' style='height: 3px; background: violet; width: 0%;'></div>
            </div>
        `;
        document.body.appendChild(bar);

        initDiffUI();

        // 进度条
        let ticking = false;
        window.addEventListener("scroll", () => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
                    const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
                    const scrolled = scrollHeight === 0 ? 0 : (scrollTop / scrollHeight) * 100;
                    document.getElementById("processBar").style.width = `${scrolled}%`;
                    ticking = false;
                });
                ticking = true;
            }
        });

        // 编辑重载
        if (store.online_flag == "0") {
            document.getElementById("stamp").ondblclick = () => {
                store.jump_from_search = "0";
                location.reload();
            };
            
            document.getElementById("s_nav").insertAdjacentHTML("afterend",
                `<span style='float: left' id='edit' onclick="location.href='`+store.protocol_name+`://1{' + encodeURIComponent(document.title)">edit</span>`
            );
        }
    }
}

// 搜索
function search() {
    // 拦截非搜索跳转
    if (store.jump_from_search_ex !== "1") return;
    store.jump_from_search_ex = "0";

    const rawKeyword = (store.keyword || "").trim();
    if (!rawKeyword || !wasmEngineReady) return; // 确保 Wasm 引擎已初始化

    // 1. 遍历 DOM 提取纯文本，建立物理节点与全局文本的偏移量映射表
    // Wasm 无法直接读取 DOM，这部分“采矿”工作必须由 JS 完成
    const element = document.body;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let globalText = "";
    const nodeMap = [];
    let currentPos = 0;
    
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const val = node.nodeValue;
        textNodes.push(node);
        globalText += val;
        nodeMap.push({ node, start: currentPos, end: currentPos + val.length });
        currentPos += val.length;
    }

    // 2. 跨语言调用：将整片文章作为 globalText 发送给 Rust (Wasm)
    // 由底层执行多轨正则匹配、宽容降级、位置合并、摘要提取
    // 返回包含: { count, matches: [{start, end, index}], snippets, isTolerantMatch }
    const resultObj = find_content_matches(globalText, rawKeyword);
    
    const matches = resultObj.matches || [];
    const snippets = resultObj.snippets || [];
    const isTolerantMatch = resultObj.isTolerantMatch || false;

    // 搜索无结果处理
    if (matches.length === 0) {
        sendToParent("LOCAL_SEARCH_RESULT", { keyword: rawKeyword, count: 0, title: document.title });
        return;
    }

    // 3. 渲染高亮：按物理节点进行局部切割
    nodeMap.forEach(item => {
        const node = item.node;
        const nodeText = node.nodeValue;
        
        // 找出所有落在这个节点范围内的匹配项碎片 (Wasm 已经排除了重叠)
        const nodeMatches = matches.filter(m => m.start < item.end && m.end > item.start);
        
        if (nodeMatches.length === 0) return;

        const fragment = document.createDocumentFragment();
        let cursor = 0;

        // 确保局部匹配片段按顺序渲染
        nodeMatches.sort((a, b) => a.start - b.start).forEach(m => {
            const localStart = Math.max(m.start - item.start, 0);
            const localEnd = Math.min(m.end - item.start, nodeText.length);

            // 插入匹配前的未高亮文本
            if (localStart > cursor) {
                fragment.appendChild(document.createTextNode(nodeText.substring(cursor, localStart)));
            }

            // 插入高亮碎片
            if (localEnd > localStart) {
                const span = document.createElement("span");
                span.className = "match-highlight";
                span.setAttribute("data-match-index", m.index); // m.index 是 Wasm 给出的独立分组 ID，用于控制中心化高亮
                
                // 核心 UI 改动：根据 Wasm 返回的降级模式 (Tolerant) 赋予不同警告色
                if (isTolerantMatch) {
                    span.setAttribute("data-tolerant", "true");
                    span.style.cssText = "background-color: #fcd34d !important; color: black !important; border-bottom: 2px dashed #f59e0b; z-index: 10; position: relative;"; // 柔和的琥珀色，带虚线下划线
                } else {
                    span.style.cssText = "background-color: yellow !important; color: black !important; z-index: 10; position: relative;";
                }
                
                span.appendChild(document.createTextNode(nodeText.substring(localStart, localEnd)));
                fragment.appendChild(span);
            }
            cursor = localEnd;
        });

        // 插入尾部剩余文本
        if (cursor < nodeText.length) {
            fragment.appendChild(document.createTextNode(nodeText.substring(cursor)));
        }
        
        // 用包含 span 标签的虚拟节点替换原有的纯文本节点
        node.parentNode.replaceChild(fragment, node);
    });

    // 4. 将高亮摘要统计结果反馈给顶级系统 (index.js)
    sendToParent("LOCAL_SEARCH_RESULT", { 
        keyword: rawKeyword, 
        count: resultObj.count, 
        title: document.title,
        snippets: snippets,
        isTolerantMatch: isTolerantMatch
    });

    // 5. 组装导航面板 (Next / Prev)
    const totalMatches = resultObj.count;
    let currentIndex = 0;

    function updateIndexDisplay() {
        let indexDisplay = $("#indexDisplay");
        if (!indexDisplay) {
            indexDisplay = document.createElement("button");
            indexDisplay.id = "indexDisplay";
            
            const destroyButton = document.createElement("button");
            destroyButton.id = "destroy";
            destroyButton.innerText = "destroy";
            destroyButton.onclick = function () {
                document.querySelectorAll(".match-highlight").forEach(h => {
                    h.parentNode.replaceChild(document.createTextNode(h.textContent), h);
                });
                const nav = $("#s_nav");
                if (nav) nav.innerHTML = "";
                store.jump_from_search = "0";
                store.jump_from_search_ex = "0";
            };

            setTimeout(() => {
                const nav = $("#s_nav");
                if (nav) {
                    nav.appendChild(indexDisplay);
                    nav.appendChild(destroyButton);
                }
            }, 100);
        }

        indexDisplay.innerText = " " + (currentIndex + 1) + " / " + totalMatches;

        // 恢复全部背景色 (清除旧的焦点)
        document.querySelectorAll("span.match-highlight").forEach(s => {
            if (s.dataset.tolerant === "true") {
                s.style.cssText = "background-color: #fcd34d !important; color: black !important; border-bottom: 2px dashed #f59e0b; z-index: 10; position: relative;";
            } else {
                s.style.cssText = "background-color: yellow !important; color: black !important; z-index: 10; position: relative;";
            }
        });

        // 定位当前组所有碎片，涂成红色激活态
        const currentGroup = document.querySelectorAll(`span.match-highlight[data-match-index="${currentIndex}"]`);
        if (currentGroup.length > 0) {
            currentGroup.forEach(s => {
                s.style.cssText = "background-color: red !important; color: white !important; font-weight: bold; z-index: 20; position: relative;";
            });

            // 抑制滚动冲突锁
            isAutoScrolling = true;
            currentGroup[0].scrollIntoView({ block: "center", behavior: "smooth" });
            setTimeout(() => { isAutoScrolling = false; }, 600);
        }
    }

    function createNavigationButtons() {
        const prevButton = document.createElement("button");
        prevButton.innerText = "prev";
        prevButton.onclick = () => {
            currentIndex = (currentIndex - 1 + totalMatches) % totalMatches;
            updateIndexDisplay();
        };

        const nextButton = document.createElement("button");
        nextButton.innerText = "next";
        nextButton.onclick = () => {
            currentIndex = (currentIndex + 1) % totalMatches;
            updateIndexDisplay();
        };

        setTimeout(() => {
            const nav = $("#s_nav");
            if (nav) {
                nav.appendChild(prevButton);
                nav.appendChild(nextButton);
            }
        }, 100);
    }

    if (totalMatches > 0) {
        createNavigationButtons();
        updateIndexDisplay();
    }
}

// 局部探测
function countMatchesEnhanced(kw) {
    if (!kw || kw.trim() === "" || !wasmEngineReady) return { count: 0 };
    
    const element = document.body;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    let globalText = "";
    while (walker.nextNode()) {
        globalText += walker.currentNode.nodeValue;
    }

    // 以前这里要写一堆重复正则，现在一行代码搞定！
    const resultObj = find_content_matches(globalText, kw);

    return { 
        count: resultObj.count, 
        snippets: resultObj.snippets, 
        isTolerantMatch: resultObj.isTolerantMatch 
    };
}

// 内文目录
function toc() {
    const headings = $$("h1, h2, h3, h4, h5, h6");
    if (headings.length > 2) {
        toc_flag = true;
        let tocHTML = "<div id='toc-list'><ul>";
        let stack = [];
        let counters = [0, 0, 0, 0, 0, 0];

        headings.forEach(function (heading) {
            let id = heading.innerText.replace(/\s+/g, "_").toLowerCase();
            let count = 1;
            while (document.getElementById(id)) {
                id = heading.innerText.replace(/\s+/g, "_").toLowerCase() + "_" + count++;
            }
            heading.id = id;

            const level = parseInt(heading.tagName[1]);
            for (let i = level; i < counters.length; i++) counters[i] = 0;
            counters[level - 1]++;

            let numberString = counters.slice(0, level).join(".");
            heading.setAttribute("data-number", numberString);

            while (level <= stack.length) {
                tocHTML += "</ul></li>";
                stack.pop();
            }

            tocHTML += "<li><a href='#" + heading.id + "' data='" + heading.id + "'><span class='toc_a_no'>" + numberString + "</span>&nbsp; " + heading.innerText + "</a><ul>";
            stack.push(level);
        });

        while (stack.length > 0) {
            tocHTML += "</ul></li>";
            stack.pop();
        }

        const tocDiv = document.createElement("div");
        tocDiv.id = "toc";
        tocDiv.style.display = "flex"; // 利用 Flexbox 横向排布
        tocDiv.innerHTML = tocHTML + "</ul></div><div id='toc-toggle' class='toc-toggle'>目 录</div>";
        document.body.appendChild(tocDiv);

        $("#toc-toggle").addEventListener("click", function () {
            const tocList = $("#toc-list");
            tocList.classList.toggle("hidden");
        });
    }
}
function getClosestH() {
    const hElements = $$("h1, h2, h3, h4, h5, h6");
    let minDistance = Number.MAX_VALUE;
    let closestH = null;
    hElements.forEach((hElement) => {
        const distanceToTop = hElement.getBoundingClientRect().top;
        if (distanceToTop >= 0 && distanceToTop < minDistance) {
            minDistance = distanceToTop;
            closestH = hElement;
        }
    });
    return closestH;
}

// 灯箱
function lightbox() {
    var images = $$('img');
    if (images.length === 0) return;

    var currentIndex = 0;
    var scale = 1.0;
    var maxScale = 10.0;
    var minScale = 0.5;
    var scaleStep = 0.1;
    var dragMoved = false;

    function enableDrag(target) {
        target.dataset.tx = target.dataset.tx || 0;
        target.dataset.ty = target.dataset.ty || 0;
        let isDragging = false;
        let startX = 0, startY = 0;

        const onMove = (e) => {
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            const tx = clientX - startX;
            const ty = clientY - startY;
            
            if (Math.abs(tx) > 5 || Math.abs(ty) > 5) {
                dragMoved = true;
            }

            target.dataset.tx = tx;
            target.dataset.ty = ty;
            target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            if (e.cancelable) e.preventDefault();
        };

        const onUp = () => {
            isDragging = false;
            target.style.cursor = "grab";
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            
            setTimeout(() => dragMoved = false, 100);
        };

        const onDown = (e) => {
            if (e.touches && e.touches.length > 1) return;
            isDragging = true;
            dragMoved = false;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            startX = clientX - parseFloat(target.dataset.tx);
            startY = clientY - parseFloat(target.dataset.ty);
            target.style.cursor = "grabbing";
            
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
            
            if (!e.touches && e.cancelable) e.preventDefault();
        };

        target.addEventListener('mousedown', onDown);
        target.addEventListener('touchstart', onDown, { passive: false });
        target.style.cursor = "grab";
    }

    function closeLightbox(isFromPopState = false) {
        var lightbox = $('.lightbox');
        if (lightbox) lightbox.remove();
        scale = 1.0;
        sendToParent("lightbox", { status: "0" });
        document.body.style.overflow = "";
        
        if (isFromPopState !== true && history.state && history.state.lightboxOpen) {
            history.back();
        }
    }

    function prevImage() {
        scale = 1.0;
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        updateImage();
    }

    function nextImage() {
        scale = 1.0;
        currentIndex = (currentIndex + 1) % images.length;
        updateImage();
    }

    function updateImage() {
        var lightboxImg = $('.lightbox-img');
        lightboxImg.src = images[currentIndex].src;
        lightboxImg.dataset.tx = 0;
        lightboxImg.dataset.ty = 0;
        lightboxImg.style.transition = "none"; 
        lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;
        
        var info = $('.lightbox-info');
        if (info) info.innerHTML = (currentIndex + 1) + '/' + images.length;
    }

    function openLightbox(index, count) {
        if (!history.state || !history.state.lightboxOpen) {
            history.pushState({ lightboxOpen: true }, "");
        }
        
        currentIndex = index;
        var lightbox = document.createElement('div');
        lightbox.classList.add('lightbox');
        lightbox.style.display = 'flex';
        lightbox.style.alignItems = 'center';
        lightbox.style.justifyContent = 'center';
        
        lightbox.addEventListener('click', function (e) {
            if (e.target === lightbox && !dragMoved) {
                closeLightbox();
            }
        });
        document.body.appendChild(lightbox);

        var topCloseBtn = document.createElement('div');
        topCloseBtn.innerHTML = '✕';
        topCloseBtn.style.cssText = 'position: absolute; top: 15px; right: 20px; color: #fff; font-size: 28px; z-index: 105; cursor: pointer; padding: 10px; opacity: 0.7; user-select: none; font-family: sans-serif;';
        topCloseBtn.addEventListener('click', closeLightbox);
        lightbox.appendChild(topCloseBtn);

        var nav = document.createElement('span');
        nav.classList.add('lightbox-nav', 'noselect');
        lightbox.appendChild(nav);

        if (count !== 1) {
            var prevBtn = document.createElement('span');
            prevBtn.innerHTML = 'prev';
            prevBtn.addEventListener('click', prevImage);
            nav.appendChild(prevBtn);

            var info = document.createElement('span');
            info.classList.add('lightbox-info');
            info.innerHTML = (currentIndex + 1) + '/' + images.length;
            nav.appendChild(info);

            var nextBtn = document.createElement('span');
            nextBtn.innerHTML = 'next';
            nextBtn.addEventListener('click', nextImage);
            nav.appendChild(nextBtn);
        }

        var closeBtn = document.createElement('span');
        closeBtn.innerHTML = 'close';
        closeBtn.addEventListener('click', closeLightbox);
        nav.appendChild(closeBtn);

        var lightboxImg = document.createElement('img');
        lightboxImg.src = images[index].src;
        lightboxImg.alt = 'Image';
        lightboxImg.classList.add('lightbox-img');
        lightboxImg.addEventListener('dblclick', closeLightbox);
        
        lightboxImg.dataset.tx = 0;
        lightboxImg.dataset.ty = 0;
        lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;
        enableDrag(lightboxImg);

        lightboxImg.addEventListener('wheel', function (event) {
            event.preventDefault();
            if (event.deltaY < 0) scale = Math.min(scale + scaleStep, maxScale);
            else scale = Math.max(scale - scaleStep, minScale);
            lightboxImg.style.transform = `translate(${lightboxImg.dataset.tx}px, ${lightboxImg.dataset.ty}px) scale(${scale})`;
        });

        let initialDistance = 0;
        let initialScale = 1.0;

        lightboxImg.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                initialDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                initialScale = scale;
            }
        }, { passive: false });

        lightboxImg.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                if (e.cancelable) e.preventDefault();
                
                const currentDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                
                scale = initialScale * (currentDistance / initialDistance);
                scale = Math.max(minScale, Math.min(scale, maxScale)); // 限制在 0.5 到 10.0 之间
                
                lightboxImg.style.transform = `translate(${lightboxImg.dataset.tx}px, ${lightboxImg.dataset.ty}px) scale(${scale})`;
            }
        }, { passive: false });

        lightbox.appendChild(lightboxImg);

        bindSwipeGestures(lightbox, {
            onLeft: nextImage,       
            onRight: prevImage
        });
    }

    function bindSwipeGestures(element, callbacks, thresholdPercent = 0.15) {
        let startX = 0, startY = 0;
        let isMultiTouch = false;

        element.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                isMultiTouch = true;
                return;
            }
            isMultiTouch = false;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        element.addEventListener('touchmove', (e) => {
            if (e.touches.length > 1) {
                isMultiTouch = true;
            }
        }, { passive: false });

        element.addEventListener('touchend', (e) => {
            if (isMultiTouch) return;
            if (scale > 1.05) return;

            if (e.changedTouches.length !== 1) return;
            const deltaX = e.changedTouches[0].clientX - startX;
            const deltaY = e.changedTouches[0].clientY - startY;
            const dynamicThreshold = Math.min(window.innerWidth, window.innerHeight) * thresholdPercent;

            if (Math.abs(deltaX) > dynamicThreshold || Math.abs(deltaY) > dynamicThreshold) {
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0 && callbacks.onRight) callbacks.onRight();
                    else if (deltaX < 0 && callbacks.onLeft) callbacks.onLeft();
                }
            } else {
                var lightboxImg = $('.lightbox-img');
                if (lightboxImg && scale === 1.0) {
                    lightboxImg.dataset.tx = 0;
                    lightboxImg.dataset.ty = 0;
                    lightboxImg.style.transition = "transform 0.25s ease-out";
                    lightboxImg.style.transform = `translate(0px, 0px) scale(${scale})`;
                    setTimeout(() => lightboxImg.style.transition = "none", 260);
                }
            }
        });
    }

    images.forEach(function (img, index) {
        img.addEventListener('click', function () {
            openLightbox(index, images.length);
            sendToParent("lightbox", { status: "1" });
            document.body.style.overflow = "hidden";
        });
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') prevImage();
        else if (event.key === 'ArrowRight') nextImage();
        else if (event.key === 'Escape') closeLightbox();
    });

    window.addEventListener('popstate', function(e) {
        if ($('.lightbox')) {
            closeLightbox(true); 
        }
    });
}

// 双击编辑
function bindCodeEditHandlers(root) {
    root.querySelectorAll('code').forEach((e) => {
        e.ondblclick = (event) => {
            event.stopPropagation();
            e.contentEditable = "true";
            e.style.outline = "none";
            e.classList.add("is-editing");
            e.focus();
        };

        e.oninput = () => {
            updateLineNumbers(e);
        };

        e.onblur = () => {
            e.contentEditable = "false";
            e.classList.remove("is-editing");
        };
    });
}

// 着色
async function code() {
    const codeElements = $$('code');
    if (codeElements.length === 0) return;
    
    enableCodeHoverHighlight();

    return new Promise((resolve) => {
        const highlightAll = () => {
            $$("code").forEach((e) => {
                const lang = e.attributes.length > 1 ? e.attributes[0].name : "java";
                
                const rawContent = e.textContent.trim();
                e.innerHTML = highlightCode(rawContent, lang);
                updateLineNumbers(e);
            });
            bindCodeEditHandlers(document);
            resolve();
        };

        if (!window.Prism) {
            const script = document.createElement('script');
            script.src = '../src/third/prism/prism.js';
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '../src/third/prism/prism.css';
            document.head.appendChild(link);
            document.head.appendChild(script);
            script.onload = highlightAll;
        } else {
            highlightAll();
        }
    });
}
function enableCodeHoverHighlight(targetDocument = document) {
    targetDocument.addEventListener('mousemove', (e) => {
        const code = e.target.closest('code');
        const pre = code ? code.closest('pre') : null;

        if (code && pre) {
            if (getComputedStyle(pre).position === 'static') {
                pre.style.position = 'relative';
            }
            if (getComputedStyle(code).position === 'static') {
                code.style.position = 'relative';
                code.style.zIndex = '1';
            }

            let highlighter = pre.querySelector('.code-line-highlighter');
            if (!highlighter) {
                highlighter = targetDocument.createElement('div');
                highlighter.className = 'code-line-highlighter';
                highlighter.style.cssText = `
                    position: absolute;
                    background-color: rgba(150, 150, 150, 0.15);
                    pointer-events: none;
                    z-index: 0;
                    display: none;
                    transition: top 0.05s ease-out;
                    border-radius: 2px;
                `;
                pre.appendChild(highlighter);
            }

            const codeStyle = getComputedStyle(code);
            let lh = parseFloat(codeStyle.lineHeight);
            if (isNaN(lh)) lh = parseFloat(codeStyle.fontSize) * 1.2;
            
            const codePaddingTop = parseFloat(codeStyle.paddingTop) || 0;
            const codeRect = code.getBoundingClientRect();

            if (e.clientY < codeRect.top || e.clientY > codeRect.bottom || 
                e.clientX < codeRect.left || e.clientX > codeRect.right) {
                highlighter.style.display = 'none';
                return;
            }

            const offsetY = e.clientY - codeRect.top - codePaddingTop;
            if (offsetY < 0) { 
                highlighter.style.display = 'none';
                return;
            }

            const lineIndex = Math.floor(offsetY / lh);
            const maxLines = Math.round((codeRect.height - codePaddingTop - (parseFloat(codeStyle.paddingBottom) || 0)) / lh);
            
            if (lineIndex >= 0 && lineIndex < maxLines) {
                highlighter.style.display = 'block';
                highlighter.style.top = (code.offsetTop + codePaddingTop + lineIndex * lh) + 'px';
                highlighter.style.height = lh + 'px';
                highlighter.style.left = code.offsetLeft + 'px';
                highlighter.style.width = code.offsetWidth + 'px';
            } else {
                highlighter.style.display = 'none';
            }

        } else {
            targetDocument.querySelectorAll('.code-line-highlighter').forEach(el => {
                el.style.display = 'none';
            });
        }
    });

    targetDocument.addEventListener('mouseleave', () => {
        targetDocument.querySelectorAll('.code-line-highlighter').forEach(el => {
            el.style.display = 'none';
        });
    });
}

// 页面位置
function postion_func() {
    const positions = store.positions || {};
    var pageTitle = document.title;
    var scrollPosition = positions[pageTitle];
    if (scrollPosition !== undefined && store.jump_from_search == "0") {
        window.scrollTo(0, parseInt(scrollPosition));
    }

    let scrollTimer = null; 

    window.addEventListener('scroll', function (e) {
        if (isAutoScrolling) return;

        if (scrollTimer !== null) {
            clearTimeout(scrollTimer);
        }

        scrollTimer = setTimeout(function() {
            var pageTitle = document.title;
            var scrollPosition = window.pageYOffset;
            const positions = store.positions || {};
            positions[pageTitle] = scrollPosition;
            store.positions = positions;

            if ($("#gotop")) {
                document.body.scrollTop > 500 || document.documentElement.scrollTop > 500
                    ? $("#gotop").style.display = "block"
                    : $("#gotop").style.display = "none";
            }

            if (getClosestH() != null && toc_flag) {
                var aTags = $("#toc-list").querySelectorAll("a");
                for (let i = 0; i < aTags.length; i++) {
                    if (aTags[i].getAttribute("data") == getClosestH().id)
                        aTags[i].classList.add("toc_locate");
                    else
                        aTags[i].classList.remove("toc_locate");
                }
            }
        }, 300);
        
    }, false);
}

// 回顶
function go_top() {
    var o = document.createElement('div');
    o.setAttribute("id", "gotop");
    o.innerHTML = "<span>^</span>";
    document.body.appendChild(o);
    o.addEventListener("click", function () {
        window.scrollTo({ top: 0 });
    });
}

// 拼音
function pinyin_func() {
    const dict = window.top.pinyinData;
    if (!dict || Object.keys(dict).length === 0) {
        setTimeout(pinyin_func, 500);
        return;
    }

    let tooltip = document.createElement("div");
    tooltip.className = "pinyin-tooltip";
    document.body.appendChild(tooltip);

    document.addEventListener("mouseup", function(event) {
        const selection = window.getSelection().toString().trim();
        if (selection.length === 1 && dict[selection]) {
            tooltip.innerText = dict[selection];
            tooltip.style.left = event.pageX + "px";
            tooltip.style.top = event.pageY + "px";
            tooltip.style.display = "block";
        } else {
            tooltip.style.display = "none";
        }
    });
}

// 评论
function comments() {
    if(document.title.trim() !== "" && store.online_flag == "1"){
        const stampText = document.getElementById("stamp")?.innerText || "";
        sendToParent("load_comments", {
            title: document.title.trim(),
            stamp: stampText
        });
    }
}

// 摘抄
function initExcerptTrigger() {
    let btn = document.getElementById('excerpt-pop-btn');
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'excerpt-pop-btn';
        btn.textContent = '✏️';
        btn.style.cssText = 'position: fixed; background: #516194; color: rgb(255, 255, 255); padding: 0 5px; border-radius: 6px; cursor: pointer; z-index: 2147483647; box-shadow: rgba(0, 0, 0, 0.4) 0px 4px 12px; display: none; user-select: none; left: 938px; top: 240px;';
        document.body.appendChild(btn);

        const doExcerpt = () => {
            const sel = window.getSelection();
            const text = sel.toString().trim();
            if (text.length > 1) {
                if (typeof sendToParent === 'function') {
                    sendToParent('SAVE_EXCERPT', text);
                } else {
                    window.parent.postMessage({ type: 'SAVE_EXCERPT', payload: text, from: 'content' }, '*');
                }
                
                const oldText = btn.textContent;
                btn.textContent = '✅ 已摘抄';
                btn.style.background = '#10b981';
                setTimeout(() => {
                    btn.style.display = 'none';
                    btn.textContent = oldText;
                    btn.style.background = '#516194';
                    sel.removeAllRanges(); 
                    lastProcessedText = "";
                }, 800);
            }
        };

        const shieldEvents = ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerdown', 'pointerup'];
        
        shieldEvents.forEach(evt => {
            window.addEventListener(evt, (e) => {
                if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) {
                    
                    e.stopPropagation();
                    e.stopImmediatePropagation(); 

                    if (evt === 'mousedown') {
                        e.preventDefault();
                    }
                    
                    if (evt === 'click') {
                        doExcerpt();
                    }
                }
            }, true);
        });

        let lastProcessedText = "";

        document.addEventListener('mousedown', (e) => {
            if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;
            btn.style.display = 'none';
        });

        document.addEventListener('mouseup', (e) => {
            if (e.target && e.target.closest && e.target.closest('#excerpt-pop-btn')) return;
            
            setTimeout(() => {
                const text = window.getSelection().toString().trim();
                
                if (text.length > 1) {
                    if (text !== lastProcessedText) {
                        btn.style.left = Math.min(e.clientX + 5, window.innerWidth - 80) + 'px';
                        btn.style.top = Math.min(e.clientY + 15, window.innerHeight - 40) + 'px';
                        btn.style.display = 'block';
                        lastProcessedText = text;
                    }
                } else {
                    btn.style.display = 'none';
                    lastProcessedText = "";
                }
            }, 10);
        });
    }
}

// 顺序
async function start() {
    if (wasmInitPromise) {
        await wasmInitPromise;
    }

    await format();  // 基础 Markdown 解析
    await code();    // 等待 Prism 彻底完成 DOM 改造
    
    setTimeout(() => {
        postion_func(); // 先恢复历史位置
        setTimeout(() => {
            search();   // 如果带有搜索词，执行高亮并覆盖历史位置
        }, 100); // 缓冲防止浏览器滚动事件拥堵
    }, 50);

    comments();
    go_top();
    setTimeout(toc, 500);
    setTimeout(lightbox, 500);
    pinyin_func();

    initExcerptTrigger();

    requestAnimationFrame(() => {
        document.body.style.opacity = 1;
    });
}

// 表格渲染, 从 postProcess 中抽出来，供 Diff 复用
function renderP2TableEl(rawText) {
    const lines = rawText.trim().split('\n');
    const table = document.createElement('table');
    table.className = 'p2tbl';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    lines.forEach(line => {
        const tr = document.createElement('tr');
        line.split("|").map(c => c.trim()).forEach(cell => {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    return table;
}

// 代码高亮, 从 code() 中抽出来，供 Diff 复用
function highlightCode(rawText, lang) {
    const effectiveLang = lang || "java";
    if (!window.Prism) {
        // Prism 尚未加载完成时的降级：至少做基础转义，避免破坏 DOM 结构
        return rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }
    return Prism.highlight(rawText, Prism.languages[effectiveLang] || Prism.languages.java, effectiveLang);
}

// 行号计算，供 code() 和 Diff 渲染完成后统一调用
function updateLineNumbers(el) {
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
    const lineCount = el.innerText.split('\n').length;
    const lines = Array.from({length: lineCount}, (_, i) => (i + 1).toString().padStart(2, '0'));
    el.style.setProperty('--line-numbers', '"' + lines.join('.\\A ') + '.\\A"');
}

// Diff UI
async function initDiffUI() {
    const originalBtn = document.getElementById('diff-btn');
    if (!originalBtn) return;

    function formatSnapshotTime(ts) {
        if (!ts) return '未知时间';
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function normalizeSnapshotHistory(rec) {
        if (!rec) return [];
        let list = [];
        if (Array.isArray(rec.history)) {
            list = rec.history.filter(item => 
                item && (typeof item.text === 'string' || item.text instanceof Uint8Array)
            );
        } else if (typeof rec.text === 'string' || rec.text instanceof Uint8Array) {
            list = [{ text: rec.text, ts: rec.ts || 0, compressed: rec.compressed }];
        }
        return list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    let historyList = [];
    try {
        const rawPath = location.pathname;
        const decodedPath = decodeURI(rawPath);
        const fileName = decodedPath.split('/').pop();

        const tryKeys = [
            decodedPath, rawPath,
            decodedPath.startsWith('/') ? decodedPath.substring(1) : '/' + decodedPath,
            '/html/' + fileName, 'html/' + fileName
        ];

        const idb = await new Promise((resolve, reject) => {
            const req = indexedDB.open('MainDB', 2);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('html_snapshots')) db.createObjectStore('html_snapshots');
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });

        if (idb.objectStoreNames.contains('html_snapshots')) {
            const tx = idb.transaction('html_snapshots', 'readonly');
            const store = tx.objectStore('html_snapshots');
            
            let record = null;
            for (const k of tryKeys) {
                const res = await new Promise(resolve => {
                    const r = store.get(k);
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => resolve(null);
                });
                if (res) { record = res; break; }
            }
            historyList = normalizeSnapshotHistory(record);
        }
        idb.close();
    } catch (e) {
        console.warn("[Diff] 历史记录读取失败", e);
    }

    if (historyList.length === 0) {
        originalBtn.remove();
        return;
    }

    const totalVersions = historyList.length + 1;
    const options = [];
    options.push({ val: 'current', label: `v${totalVersions}`, title: '最新版' });
    for (let i = 0; i < historyList.length; i++) {
        const vNum = totalVersions - 1 - i; 
        options.push({ val: String(i), label: `v${vNum}`, title: formatSnapshotTime(historyList[i].ts) });
    }

    const wrapper = document.createElement('span');
    wrapper.id = 'diff-controls-wrapper';
    wrapper.style.cssText = 'position:fixed; left:80px; display:flex; align-items:center; gap:6px; z-index: 100;';
    
    const selectStyle = '';
    const fromSelect = document.createElement('select');
    fromSelect.style.cssText = selectStyle;
    const toSelect = document.createElement('select');
    toSelect.style.cssText = selectStyle;

    options.forEach(opt => {
        const o1 = document.createElement('option');
        o1.value = opt.val; o1.textContent = opt.label; o1.title = opt.title;
        fromSelect.appendChild(o1);

        const o2 = document.createElement('option');
        o2.value = opt.val; o2.textContent = opt.label; o2.title = opt.title;
        toSelect.appendChild(o2);
    });

    toSelect.value = options[0].val; // current (最新版)
    fromSelect.value = options[1] ? options[1].val : options[0].val; // history[0] (上一版)

    const label1 = document.createElement('span');
    label1.textContent = '在';
    const label2 = document.createElement('span');
    label2.textContent = '基础上的改动';

    const btnStart = document.createElement('button');
    btnStart.textContent = 'diff';
    btnStart.style.cssText = 'margin-left:4px;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'cancel diff';
    btnCancel.style.cssText = 'margin-left:4px;display:none;';

    originalBtn.parentNode.insertBefore(wrapper, originalBtn);
    originalBtn.remove(); 

    wrapper.appendChild(toSelect);
    wrapper.appendChild(label1);
    wrapper.appendChild(fromSelect);
    wrapper.appendChild(label2);
    wrapper.appendChild(btnStart);
    wrapper.appendChild(btnCancel);

    btnStart.onclick = () => {
        if (window._diffBusy) return;

        const fromVal = fromSelect.value;
        const toVal = toSelect.value;
        if (fromVal === toVal) {
            alert('⚠️ 对比起点和终点不能是同一个版本');
            return;
        }

        window._diffBusy = true;
        btnStart.textContent = ' ⏳ 计算中... ';

        requestAnimationFrame(async () => {
            try {
                const oldTokens = await getTokensForSource(fromVal, historyList);
                const newTokens = await getTokensForSource(toVal, historyList);
                
                const originalPre = document.querySelector('pre:not(#diff-pre)');
                const compStyle = window.getComputedStyle(originalPre);
                const originMarginTop = compStyle.marginTop;
                const originMarginBottom = compStyle.marginBottom;
                
                originalPre.style.display = 'none'; 
                
                let diffPre = document.getElementById('diff-pre');
                if (!diffPre) {
                    diffPre = document.createElement('pre');
                    diffPre.id = 'diff-pre';
                    diffPre.className = originalPre.className; 
                    originalPre.parentNode.insertBefore(diffPre, originalPre.nextSibling);
                }
                diffPre.style.marginTop = originMarginTop;
                diffPre.style.marginBottom = originMarginBottom;
                
                renderDiffView(oldTokens, newTokens, diffPre);

                window._isDiffMode = true;
                btnStart.textContent = 're-diff';
                btnCancel.style.display = 'inline';
            } finally {
                window._diffBusy = false;
            }
        });
    };

    btnCancel.onclick = () => {
        if (window._diffBusy) return;

        const originalPre = document.querySelector('pre:not(#diff-pre)');
        const diffPre = document.getElementById('diff-pre');
        
        if (diffPre) diffPre.remove();
        if (originalPre) originalPre.style.display = 'block';
        
        window._isDiffMode = false;
        btnStart.textContent = 'diff';
        btnCancel.style.display = 'none';
    };
}

// Diff 渲染器
function renderDiffView(oldTokens, newTokens, preTag) {
    const oldKeys = oldTokens.map(t => t.content);
    const newKeys = newTokens.map(t => t.content);

    const diffOps = computeLCSDiff(oldKeys, newKeys);
    let mergedHtml = "";

    const isBlank = (t) => {
        return t.content
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;|\u00A0/g, '')
            .trim() === '';
    };

    diffOps.forEach(op => {
        const isInsert = op.type === 'insert';
        const isDelete = op.type === 'delete';
        const isEqual = op.type === 'equal';

        const token = isEqual || isInsert ? newTokens[op.newIdx] : oldTokens[op.oldIdx];
        const tType = token.type;
        const content = token.content;

        if (isEqual) {
            mergedHtml += `${content}\n`;
            return;
        }

        if (tType === 'table_start' || tType === 'table_end' || tType === 'code_start' || tType === 'code_end') {
            mergedHtml += `${content}\n`;
            return;
        }

        if (isBlank(token)) {
            mergedHtml += `${content}\n`;
            return;
        }

        const bg = isInsert ? "rgba(52, 211, 153, 0.25)" : "rgba(248, 113, 113, 0.25)";
        const border = isInsert ? "#10b981" : "#ef4444";
        const opacity = isDelete ? "0.75" : "1";

        if (tType === 'table_row') {
            // 🎯 表格粒度放大到 tr 级：直接将背景与透明度注入到 <tr> 标签上
            const styledTr = content.replace(/^<tr(\s|>)/i, (match, p1) => {
                return `<tr style="background-color: ${bg}; opacity: ${opacity}; border-left: 5px solid ${border};"${p1}`;
            });
            mergedHtml += `${styledTr}\n`;

        } else if (tType === 'code_line') {
            // 代码行保持块级行定位
            mergedHtml += `<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>\n`;

        } else {
            // 普通文本行
            mergedHtml += `<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>\n`;
        }
    });

    preTag.innerHTML = mergedHtml;
    preTag.querySelectorAll('code').forEach(updateLineNumbers);
}

// 分词序列化
function buildRenderedTokens(rawHtml) {
    const container = document.createElement('pre');
    container.innerHTML = rawHtml;

    function renderCodeBlockEl(rawText, lang) {
        const codeEl = document.createElement('code');
        if (lang) codeEl.setAttribute(lang, '');
        codeEl.innerHTML = highlightCode(rawText, lang);
        return codeEl;
    }

    // 1. 执行 Wasm 渲染
    const textNodes = Array.from(container.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
    const outHtmlArr = textNodes.map(node => format_markdown(node.nodeValue));
    textNodes.forEach((node, i) => {
        const fragment = document.createRange().createContextualFragment(outHtmlArr[i]);
        node.replaceWith(fragment);
    });

    // 2. 执行表格转换
    container.querySelectorAll('p').forEach(p => {
        p.replaceWith(renderP2TableEl(p.textContent));
    });

    // 3. 执行代码高亮
    container.querySelectorAll('code').forEach(c => {
        const lang = c.attributes.length > 0 ? c.attributes[0].name : "java";
        const newCode = renderCodeBlockEl(c.textContent.trim(), lang);
        c.replaceWith(newCode);
    });

    // 4. 精细化切割
    const tokens = [];
    let currentLineHtml = "";

    function flushText() {
        if (!currentLineHtml) return;
        const lines = currentLineHtml.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (i === lines.length - 1 && lines[i] === "") continue;
            tokens.push({ type: 'html_line', content: lines[i] });
        }
        currentLineHtml = "";
    }

    container.childNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TABLE' && node.classList.contains('p2tbl')) {
            flushText();
            tokens.push({ type: 'table_start', content: '<table class="p2tbl"><tbody>' });
            node.querySelectorAll('tr').forEach(tr => {
                tokens.push({ type: 'table_row', content: tr.outerHTML });
            });
            tokens.push({ type: 'table_end', content: '</tbody></table>' });

        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'CODE') {
            flushText();
            const attrs = Array.from(node.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
            tokens.push({ type: 'code_start', content: `<code ${attrs}>` });
            
            const codeLines = node.innerHTML.split('\n');
            codeLines.forEach((line, idx) => {
                if (idx === codeLines.length - 1 && line === "") return;
                tokens.push({ type: 'code_line', content: line });
            });
            tokens.push({ type: 'code_end', content: '</code>' });

        } else {
            currentLineHtml += node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : (node.nodeValue || '');
        }
    });
    flushText();

    const isGhostEmpty = (t) => {
        if (t.type !== 'html_line') return false;
        const pureText = t.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
        return pureText === '';
    };

    while (tokens.length > 0 && isGhostEmpty(tokens[0])) {
        tokens.shift();
    }
    while (tokens.length > 0 && isGhostEmpty(tokens[tokens.length - 1])) {
        tokens.pop();
    }

    return tokens;
}
async function decompressText(buffer) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
}
async function getTokensForSource(value, historyList) {
    if (value === 'current') {
        const preTag = document.querySelector('pre:not(#diff-pre)');
        return buildRenderedTokens(window._rawHtmlForDiff || (preTag ? preTag.innerHTML : ""));
    }

    const item = historyList[Number(value)];
    if (!item) return [];

    let rawText = "";
    if (item.compressed && item.text instanceof Uint8Array) {
        rawText = await decompressText(item.text);
    } else {
        rawText = item.text;
    }

    const match = rawText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    const rawHtml = match ? match[1] : rawText;

    return buildRenderedTokens(rawHtml);
}

// LCS 逐行对比算法
function computeLCSDiff(oldLines, newLines) {
    let start = 0;
    const N = oldLines.length;
    const M = newLines.length;
    
    // 前缀剪枝
    while (start < N && start < M && oldLines[start] === newLines[start]) {
        start++;
    }
    
    // 后缀剪枝
    let oldEnd = N - 1;
    let newEnd = M - 1;
    while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
        oldEnd--;
        newEnd--;
    }
    
    const result = [];
    
    // 将公共前缀直接作为 equal 压入
    for (let i = 0; i < start; i++) {
        result.push({ type: 'equal', oldIdx: i, newIdx: i });
    }
    
    const trimmedOld = oldLines.slice(start, oldEnd + 1);
    const trimmedNew = newLines.slice(start, newEnd + 1);
    const trimN = trimmedOld.length;
    const trimM = trimmedNew.length;
    
    // 经过剪枝，只有真正在发生变动的极小区间才会进入核心 DP 矩阵
    if (trimN > 0 || trimM > 0) {
        if (trimN * trimM > 25000000) {
            alert("⚠️ 差异区间过大，降级显示。");
            result.push(...trimmedOld.map((_, i) => ({ type: 'delete', oldIdx: start + i })));
            result.push(...trimmedNew.map((_, j) => ({ type: 'insert', newIdx: start + j })));
        } else {
            const dp = new Int32Array((trimN + 1) * (trimM + 1));
            const idx = (i, j) => i * (trimM + 1) + j;
            
            for (let i = 1; i <= trimN; i++) {
                for (let j = 1; j <= trimM; j++) {
                    if (trimmedOld[i - 1] === trimmedNew[j - 1]) {
                        dp[idx(i, j)] = dp[idx(i - 1, j - 1)] + 1;
                    } else {
                        dp[idx(i, j)] = Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
                    }
                }
            }
            
            let i = trimN, j = trimM;
            const diffs = [];
            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && trimmedOld[i - 1] === trimmedNew[j - 1]) {
                    diffs.push({ type: 'equal', oldIdx: start + i - 1, newIdx: start + j - 1 });
                    i--; j--;
                } else if (j > 0 && (i === 0 || dp[idx(i, j - 1)] >= dp[idx(i - 1, j)])) {
                    diffs.push({ type: 'insert', newIdx: start + j - 1 });
                    j--;
                } else if (i > 0 && (j === 0 || dp[idx(i, j - 1)] < dp[idx(i - 1, j)])) {
                    diffs.push({ type: 'delete', oldIdx: start + i - 1 });
                    i--;
                }
            }
            result.push(...diffs.reverse());
        }
    }
    
    // 将公共后缀直接作为 equal 压入
    for (let i = oldEnd + 1, j = newEnd + 1; i < N && j < M; i++, j++) {
        result.push({ type: 'equal', oldIdx: i, newIdx: j });
    }
    
    return result;
}