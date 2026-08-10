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
                get: function () { return this.innerText; },
                set: function (val) {
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

if (window.top && window.top.VirtualCursor) {
    window.top.VirtualCursor.attach(window);
}

const childId = 'content';
window.childId = childId;
const store = createStore();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

let toc_flag = false;
let isAutoScrolling = false;

let wasmEngineReady = false;
let find_content_matches = null;
let format_markdown = null;
let compute_lcs_diff = null;

let _diffMinimapEl = null;
let _diffMinimapResizeBound = false;
let _diffMinimapResizeTimer = null;
let _diffMinimapActivePre = null;

let _searchMinimapEl = null;
let _searchMinimapResizeBound = false;
let _searchMinimapResizeTimer = null;
let _searchMinimapResizeHandler = null;

let find_content_matches_multi = null;

const wasmInitPromise = (async () => {
    const resolveWasm = (sw) => {
        format_markdown = sw.format_markdown;
        find_content_matches = sw.find_content_matches;
        find_content_matches_multi = sw.find_content_matches_multi; // 挂载 multi 接口
        compute_lcs_diff = sw.compute_lcs_diff;
        wasmEngineReady = true;
    };

    if (window.top && window.top.sharedWasm && window.top.sharedWasm.ready) {
        resolveWasm(window.top.sharedWasm);
        return;
    }

    await new Promise((resolve) => {
        const check = setInterval(() => {
            if (window.top && window.top.sharedWasm && window.top.sharedWasm.ready) {
                clearInterval(check);
                resolveWasm(window.top.sharedWasm);
                resolve();
            }
        }, 20);
    });
})();

if (window.__LITE_BUS__) {
    window.__LITE_BUS__.close();
}
window.__LITE_BUS__ = new BroadcastChannel('bus');
const BUS = window.__LITE_BUS__;

window.addEventListener('unload', () => {
    if (window.__LITE_BUS__) {
        window.__LITE_BUS__.close();
        window.__LITE_BUS__ = null;
    }
});

const ctxId = window.top === window.self ? 'index' : window.childId;
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

window._activeSearchBorders = [];
function clearActiveSearchBorders() {
    if (window._activeSearchBorders.length > 0) {
        window._activeSearchBorders.forEach(el => el.remove());
        window._activeSearchBorders = [];
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}

window._searchMatchRanges = new Map();

BUS.addEventListener('message', (e) => {
    const { type, payload, target, from } = e.data || {};
    if (target !== '*' && target !== ctxId) return;

    switch (type) {
        case "cm_count":
            $("#cm").innerText = "💬 " + payload;
            if (payload !== 0) {
                var str = payload > 1 ? " comments" : " comment";
                $("#cm").title = payload + str;
            }
            $("#cm").style.display = "block";
            break;

        case "LOCAL_SEARCH_COUNT":
            (async () => {
                if (!wasmEngineReady) await wasmInitPromise;
                const resultObj = countMatchesEnhanced(payload);
                emitEvent("LOCAL_SEARCH_RESULT", {
                    keyword: payload,
                    count: resultObj.count,
                    title: document.title,
                    snippets: resultObj.snippets,
                    isTolerantMatch: resultObj.isTolerantMatch
                }, "index");
            })();
            break;

        case "DESTROY_HIGHLIGHT":
            if (CSS.highlights) {
                CSS.highlights.clear();
            }
            if (window._searchMatchRanges) {
                window._searchMatchRanges.clear();
            }
            clearActiveSearchBorders();
            hideSearchMinimap();

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
    emitEvent("lightbox", { status: "0" }, "index");
});
document.addEventListener('keydown', (e) => {
    if (e.key === '\\') {
        emitEvent("quick_search", "", "index");
    }
});

(function initStyles() {
    const style = document.createElement('style');
    style.textContent = "body { opacity: 0; transition: opacity 0.3s ease; }";
    document.documentElement.appendChild(style);
    if (!document.querySelector('link[href*="content.css"]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '../src/css/content.css';
        document.head.appendChild(css);
    }
})();

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
        } catch (e) { return "Invalid Date"; }
    }

    function postProcess(anchor) {
        document.querySelectorAll('pre.consumed').forEach(pre => {
            const spans = Array.from(pre.querySelectorAll('span.lv0')).filter(s => s.className.trim() === 'lv0' && !s.querySelector('span'));
            const total = spans.length;
            spans.forEach((s, i) => s.dataset.index = "[" + (total - i) + "]");
        });

        const paragraphs = Array.from(document.querySelectorAll('p'));
        paragraphs.forEach(paragraph => {
            paragraph.replaceWith(renderP2TableEl(paragraph.textContent));
        });

        const anchorText = anchor ? anchor.innerHTML : "";
        const parts = anchorText.split("-");
        if (parts.length < 2) parts.push("");
        const bar = document.createElement("div");
        bar.id = "bar";

        bar.innerHTML = `
            <span id='s_nav'></span>
            <span id='diff-btn'></span>
            <span id='cm' title='0 comment' style="display:none" onclick='emitEvent("sh_comments", document.getElementById("stamp")?.innerText || "", "index");'>💬</span>
            <span id='stamp' title='${format_date(parts[0])}'>${parts[1]} > ${document.title}</span>
            <div style='top:0;left:0'>
                <div id='processBar' style='height: 3px; background: violet; width: 0%;'></div>
            </div>
        `;
        document.body.appendChild(bar);

        initDiffUI();

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

        if (store.online_flag == "0") {
            document.getElementById("stamp").ondblclick = () => {
                store.jump_from_search = "0";
                location.reload();
            };

            document.getElementById("s_nav").insertAdjacentHTML("afterend",
                `<span style='float: left' id='edit' onclick="location.href='` + store.protocol_name + `://1{' + encodeURIComponent(document.title)">edit</span>`
            );
        }
    }
}

function search() {
    if (store.jump_from_search_ex !== "1") return;
    store.jump_from_search_ex = "0";

    const rawKeyword = (store.keyword || "").trim();
    if (!rawKeyword || !wasmEngineReady) return;

    const contentRoot =
        document.querySelector('pre:not(#diff-pre)') ||
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;

    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip nodes that live inside known non-content UI containers
            let el = node.parentElement;
            while (el && el !== contentRoot) {
                const id = el.id || '';
                const cls = el.className || '';
                if (
                    id === 'bar' || id === 'toc' || id === 'toc-list' || id === 's_nav' ||
                    id === 'gotop' || id === 'diff-minimap' || id === 'search-minimap' || id === 'diff-controls-wrapper' ||
                    id === 'excerpt-pop-btn' ||
                    (typeof cls === 'string' && (
                        cls.includes('active-search-border') ||
                        cls.includes('toc-toggle')
                    ))
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    }, false);

    const textNodes = [];
    let globalText = "";
    const nodeMap = [];
    let currentPos = 0;

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const val = node.nodeValue;
        if (!val) continue;
        textNodes.push(node);
        globalText += val;
        nodeMap.push({ node, start: currentPos, end: currentPos + val.length });
        currentPos += val.length;
    }

    const noise = Number(store.noise_level ?? 5);

    const expandQueryFn = window.top.expandQuery || ((kw) => ({ variants: [] }));
    const { variants } = expandQueryFn(rawKeyword);
    const allKeywords = [rawKeyword, ...variants];

    const resultObj = find_content_matches_multi(globalText, allKeywords, noise);

    const totalMatches = resultObj.count || 0;
    const matchBuffer = resultObj.matches;
    const snippets = resultObj.snippets || [];
    const isTolerantMatch = resultObj.isTolerantMatch || false;

    const matches = [];
    if (matchBuffer && totalMatches > 0) {
        for (let i = 0; i < totalMatches; i++) {
            const base = i * 3;
            matches.push({
                start: matchBuffer[base],
                end: matchBuffer[base + 1],
                noise: matchBuffer[base + 2],
                index: i
            });
        }
    }

    if (matches.length === 0) {
        hideSearchMinimap();
        emitEvent("LOCAL_SEARCH_RESULT", { keyword: rawKeyword, count: 0, title: document.title }, "index");
        return;
    }

    if (!CSS.highlights) {
        console.warn("浏览器不支持 CSS Highlights，高亮渲染已中止。建议升级浏览器。");
        return;
    }

    CSS.highlights.clear();
    window._searchMatchRanges.clear();
    clearActiveSearchBorders();

    const rangesByNoise = new Map();

    nodeMap.forEach(item => {
        const node = item.node;
        const nodeText = node.nodeValue;

        const nodeMatches = matches.filter(m => m.start < item.end && m.end > item.start);
        if (nodeMatches.length === 0) return;

        let mergedNodeMatches = [];
        nodeMatches.sort((a, b) => a.start - b.start).forEach(m => {
            if (mergedNodeMatches.length === 0) {
                mergedNodeMatches.push({ ...m });
                return;
            }
            let last = mergedNodeMatches[mergedNodeMatches.length - 1];
            if (m.start <= last.end) {
                last.end = Math.max(last.end, m.end);
                last.noise = Math.min(last.noise, m.noise); // 重叠区间保留最小 noise
            } else {
                mergedNodeMatches.push({ ...m });
            }
        });

        mergedNodeMatches.forEach(m => {
            const localStart = Math.max(m.start - item.start, 0);
            const localEnd = Math.min(m.end - item.start, nodeText.length);

            if (localEnd > localStart) {
                const range = new Range();
                range.setStart(node, localStart);
                range.setEnd(node, localEnd);

                const noise = m.noise || 0;
                if (!rangesByNoise.has(noise)) rangesByNoise.set(noise, []);
                rangesByNoise.get(noise).push(range);

                if (!window._searchMatchRanges.has(m.index)) {
                    window._searchMatchRanges.set(m.index, []);
                }
                window._searchMatchRanges.get(m.index).push(range);
            }
        });
    });

    const rangesByName = new Map();

    rangesByNoise.forEach((ranges, noise) => {
        const n = Number(noise) || 0;
        const highlightName = n === 0 ? 'search-exact' : `search-noise-${n}`;

        if (!rangesByName.has(highlightName)) {
            rangesByName.set(highlightName, []);
        }
        rangesByName.get(highlightName).push(...ranges);
    });

    let styleEl = document.getElementById('dynamic-search-highlight-styles');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-search-highlight-styles';
        document.head.appendChild(styleEl);
    }

    const cssRules = [];
    rangesByName.forEach((_, highlightName) => {
        if (highlightName === 'search-exact') {
            cssRules.push(`::highlight(search-exact) { background-color: rgba(255, 235, 0, 0.80); color: #000000; }`);
        } else {
            const n = parseInt(highlightName.replace('search-noise-', ''), 10) || 1;
            const alpha = Math.max(0.05, 0.80 - n * 0.07);
            const textColor = n <= 2 ? '#111' : n <= 5 ? '#333' : '#555';
            cssRules.push(
                `::highlight(${highlightName}) { background-color: rgba(255, 235, 0, ${alpha.toFixed(2)}); color: ${textColor}; }`
            );
        }
    });
    styleEl.textContent = cssRules.join('\n');

    rangesByName.forEach((ranges, highlightName) => {
        if (ranges.length === 0) return;

        const highlight = new Highlight();
        ranges.forEach(r => highlight.add(r));

        if (highlightName === 'search-exact') {
            highlight.priority = 100;
        } else {
            const n = parseInt(highlightName.replace('search-noise-', ''), 10) || 5;
            highlight.priority = Math.max(10, 100 - n * 5);
        }

        CSS.highlights.set(highlightName, highlight);
    });

    emitEvent("LOCAL_SEARCH_RESULT", {
        keyword: rawKeyword,
        count: resultObj.count,
        title: document.title,
        snippets: snippets,
        isTolerantMatch: isTolerantMatch
    }, "index");

    let currentIndex = 0;

    window._jumpToSearchIndex = (idx) => {
        if (idx < 0 || idx >= totalMatches) return;
        currentIndex = idx;
        updateIndexDisplay();
    };

    function updateIndexDisplay() {
        let indexDisplay = $("#indexDisplay");
        if (!indexDisplay) {
            indexDisplay = document.createElement("button");
            indexDisplay.id = "indexDisplay";

            const destroyButton = document.createElement("button");
            destroyButton.id = "destroy";
            destroyButton.innerText = "destroy";
            destroyButton.onclick = function () {
                if (CSS.highlights) CSS.highlights.clear();
                clearActiveSearchBorders();
                hideSearchMinimap();
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

        clearActiveSearchBorders();

        const currentGroupRanges = window._searchMatchRanges.get(currentIndex) || [];
        if (currentGroupRanges.length > 0) {
            const fragment = document.createDocumentFragment();

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            currentGroupRanges.forEach(range => {
                const rect = range.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return; // 忽略不可见区间
                minX = Math.min(minX, rect.left);
                minY = Math.min(minY, rect.top);
                maxX = Math.max(maxX, rect.right);
                maxY = Math.max(maxY, rect.bottom);
            });

            if (minX !== Infinity) {
                const box = document.createElement('div');
                box.className = 'active-search-border';
                box.style.cssText = `
                    left: ${window.scrollX + minX - 4}px; 
                    top: ${window.scrollY + minY - 3}px; 
                    width: ${maxX - minX + 8}px; 
                    height: ${maxY - minY + 8}px; 
                `;
                fragment.appendChild(box);
                window._activeSearchBorders.push(box);
            }
            document.body.appendChild(fragment);

            isAutoScrolling = true;
            const firstRange = currentGroupRanges[0];
            const rect = firstRange.getBoundingClientRect();
            const absoluteTop = window.scrollY + rect.top;

            window.scrollTo({
                top: absoluteTop - (window.innerHeight / 2),
                behavior: "smooth"
            });

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
        updateSearchMinimap();
    }
}

function countMatchesEnhanced(kw) {
    if (!kw || kw.trim() === "" || !wasmEngineReady) return { count: 0 };

    const contentRoot =
        document.querySelector('pre:not(#diff-pre)') ||
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;

    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== contentRoot) {
                const id = el.id || '';
                const cls = el.className || '';
                if (
                    id === 'bar' || id === 'toc' || id === 'toc-list' || id === 's_nav' ||
                    id === 'gotop' || id === 'diff-minimap' || id === 'search-minimap' || id === 'diff-controls-wrapper' ||
                    id === 'excerpt-pop-btn' ||
                    (typeof cls === 'string' && (
                        cls.includes('active-search-border') ||
                        cls.includes('toc-toggle')
                    ))
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    }, false);

    let globalText = "";
    while (walker.nextNode()) {
        const val = walker.currentNode.nodeValue;
        if (val) globalText += val;
    }

    const noise = Number(store.noise_level ?? 5);
    const expandQueryFn = window.top.expandQuery || ((keyword) => ({ variants: [] }));
    const { variants } = expandQueryFn(kw);
    const allKeywords = [kw, ...variants];

    const resultObj = find_content_matches_multi(globalText, allKeywords, noise);

    return {
        count: resultObj.count,
        snippets: resultObj.snippets,
        isTolerantMatch: resultObj.isTolerantMatch
    };
}

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
        tocDiv.style.display = "flex";
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
        emitEvent("lightbox", { status: "0" }, "index");
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
            emitEvent("lightbox", { status: "1" }, "index");
            document.body.style.overflow = "hidden";
        });
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') prevImage();
        else if (event.key === 'ArrowRight') nextImage();
        else if (event.key === 'Escape') closeLightbox();
    });

    window.addEventListener('popstate', function (e) {
        if ($('.lightbox')) {
            closeLightbox(true);
        }
    });
}

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

function postion_func() {
    const positions = store.positions || {};
    var pageTitle = document.title;
    var scrollPosition = positions[pageTitle];
    if (scrollPosition !== undefined && store.jump_from_search == "0") {
        window.scrollTo(0, parseInt(scrollPosition));
    }

    let memPositions = Object.assign({}, positions);
    let dirty = false;
    let scrollTimer = null;

    function flushPositions() {
        if (!dirty) return;
        store.positions = memPositions;
        dirty = false;
    }

    window.addEventListener('scroll', function (e) {
        if (isAutoScrolling) return;

        if (scrollTimer !== null) {
            clearTimeout(scrollTimer);
        }

        scrollTimer = setTimeout(function () {
            var pageTitle = document.title;
            var scrollPosition = window.pageYOffset;
            memPositions[pageTitle] = scrollPosition;
            dirty = true;

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

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushPositions();
    });
    window.addEventListener('pagehide', flushPositions);
    window.addEventListener('beforeunload', flushPositions);
}

function go_top() {
    var o = document.createElement('div');
    o.setAttribute("id", "gotop");
    o.innerHTML = "<span>^</span>";
    document.body.appendChild(o);
    o.addEventListener("click", function () {
        window.scrollTo({ top: 0 });
    });
}

function pinyin_func() {
    const dict = window.top.pinyinData;
    if (!dict || Object.keys(dict).length === 0) {
        setTimeout(pinyin_func, 500);
        return;
    }

    let tooltip = document.createElement("div");
    tooltip.className = "pinyin-tooltip";
    document.body.appendChild(tooltip);

    document.addEventListener("mouseup", function (event) {
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

function comments() {
    if (document.title.trim() !== "" && store.online_flag == "1") {
        const stampText = document.getElementById("stamp")?.innerText || "";
        emitEvent("load_comments", {
            title: document.title.trim(),
            stamp: stampText
        }, "index");
    }
}

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
                emitEvent('SAVE_EXCERPT', text, 'index');

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
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) {
                sel.removeAllRanges();
            }
            lastProcessedText = "";
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

async function start() {
    if (wasmInitPromise) {
        await wasmInitPromise;
    }

    await format();
    await code();

    setTimeout(() => {
        postion_func();
        setTimeout(() => {
            search();
        }, 100);
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

function highlightCode(rawText, lang) {
    const effectiveLang = lang || "java";
    if (!window.Prism) {
        return rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }
    return Prism.highlight(rawText, Prism.languages[effectiveLang] || Prism.languages.java, effectiveLang);
}

function updateLineNumbers(el) {
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
    const lineCount = el.innerText.split('\n').length;
    const lines = Array.from({ length: lineCount }, (_, i) => (i + 1).toString().padStart(2, '0'));
    el.style.setProperty('--line-numbers', '"' + lines.join('.\\A ') + '.\\A"');
}

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
            const req = indexedDB.open('MainDB', 3);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
                if (!db.objectStoreNames.contains('update_logs')) db.createObjectStore('update_logs', { autoIncrement: true });
                if (!db.objectStoreNames.contains('search_cache')) db.createObjectStore('search_cache');
                if (!db.objectStoreNames.contains('sys_state')) db.createObjectStore('sys_state');
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
    wrapper.style.cssText = 'line-height: 1rem;padding: 0 3px;background: #cfe4ff;top: 3px;position: fixed;left: 80px;display: flex;align-items: center;gap: 6px;z-index: 100;';

    function createSimSelect(options, defaultVal) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; display:inline-block; cursor:pointer; background:#fff; border:1px solid #ccc; padding:2px 6px; min-width:60px; font-size:12px;';
        const display = document.createElement('span');
        const list = document.createElement('div');
        list.style.cssText = 'position:absolute; top:100%; left:-1px; right:-1px; background:#fff; border:1px solid #ccc; z-index:1000; display:none; max-height:150px; overflow-y:auto;';
        
        let currentVal = defaultVal;
        const updateDisplay = (val) => { const o = options.find(opt => opt.val === val); if(o) { display.textContent = o.label; display.title = o.title; } };
        updateDisplay(currentVal);
        
        options.forEach(opt => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:4px 6px; color:#333;';
            item.textContent = opt.label;
            item.onmouseenter = () => item.style.background = '#eee';
            item.onmouseleave = () => item.style.background = '#fff';
            item.onclick = (e) => {
                e.stopPropagation();
                currentVal = opt.val;
                updateDisplay(currentVal);
                list.style.display = 'none';
                wrap.value = currentVal;
            };
            list.appendChild(item);
        });
        
        wrap.onclick = () => list.style.display = list.style.display === 'none' ? 'block' : 'none';
        document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) list.style.display = 'none'; });
        wrap.append(display, list);
        wrap.value = currentVal;
        return wrap;
    }

    const fromSelect = createSimSelect(options, options[1] ? options[1].val : options[0].val);
    const toSelect = createSimSelect(options, options[0].val);



    const label1 = document.createElement('span');
    label1.textContent = 'based on';
    label1.style.cssText = "font-family: serif!important;"
    const label2 = document.createElement('span');
    label2.textContent = '⇌';
    label2.style.cssText = "font-family: serif!important;"

    const btnStart = document.createElement('button');
    btnStart.textContent = 'diff';
    btnStart.style.cssText = 'margin-left:4px;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'cancel diff';
    btnCancel.style.cssText = 'color: red;margin-left:4px;display:none;';

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
                updateDiffMinimap(diffPre);

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
        hideDiffMinimap();

        window._isDiffMode = false;
        btnStart.textContent = 'diff';
        btnCancel.style.display = 'none';
    };
}

function renderDiffView(oldTokens, newTokens, preTag) {
    const oldKeys = oldTokens.map(t => t.content);
    const newKeys = newTokens.map(t => t.content);

    const diffOps = compute_lcs_diff(oldKeys, newKeys);
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
            const styledTr = content.replace(/^<tr(\s|>)/i, (match, p1) => {
                return `<tr style="background-color: ${bg}; opacity: ${opacity}; border-left: 5px solid ${border};"${p1}`;
            });
            mergedHtml += `${styledTr}\n`;

        } else if (tType === 'code_line') {
            mergedHtml += `<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>\n`;

        } else {
            mergedHtml += `<span style="background-color: ${bg}; display: inline-block; width: 100%; box-sizing: border-box; border-left: 5px solid ${border}; margin-left: -5px; opacity: ${opacity};">${content}</span>\n`;
        }
    });

    preTag.innerHTML = mergedHtml;
    preTag.querySelectorAll('code').forEach(updateLineNumbers);
}

function ensureDiffMinimapEl() {
    if ($("#toc")) $("#toc").style.display = "none";
    if ($("#gotop")) $("#gotop").style.right = "20px";

    if (_diffMinimapEl && document.body.contains(_diffMinimapEl)) return _diffMinimapEl;

    const el = document.createElement('div');
    el.id = 'diff-minimap';
    el.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 20px;
        height: 100vh;
        z-index: 1000;
        pointer-events: none;
        background: rgba(127, 127, 127, 0.08);
        display: none;
    `;
    document.body.appendChild(el);
    _diffMinimapEl = el;
    return el;
}

// 从渲染好的 diff-pre 中提取所有被标记为增/删的行，合并成相邻的「变更块」(hunk)
function collectDiffHunks(diffPre) {
    const marked = diffPre.querySelectorAll('[style*="border-left"]');
    if (marked.length === 0) return [];

    // 🚀 优化：批量读取 offsetTop 替代 getBoundingClientRect，且直接按 DOM 顺序遍历，无需 sort()
    const items = Array.from(marked).map(el => {
        // 直接读取 style 对象属性，比字符串 includes 快
        const isInsert = el.style.borderLeftColor === 'rgb(16, 185, 129)' || el.style.borderLeftColor === '#10b981';
        const type = isInsert ? 'insert' : 'delete';

        return {
            top: el.offsetTop,
            bottom: el.offsetTop + el.offsetHeight,
            type
        };
    });

    const MERGE_GAP = 6;
    const hunks = [];
    let current = null;

    items.forEach(item => {
        if (current && item.top - current.bottom <= MERGE_GAP) {
            current.bottom = Math.max(current.bottom, item.bottom);
            current.types.add(item.type);
        } else {
            current = { top: item.top, bottom: item.bottom, types: new Set([item.type]) };
            hunks.push(current);
        }
    });

    return hunks;
}

function renderDiffMinimapMarks(diffPre) {
    const container = ensureDiffMinimapEl();
    container.innerHTML = '';

    const hunks = collectDiffHunks(diffPre);
    if (hunks.length === 0) {
        container.style.display = 'none';
        return;
    }

    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);

    hunks.forEach(hunk => {
        const topRatio = hunk.top / totalHeight;
        const heightRatio = (hunk.bottom - hunk.top) / totalHeight;

        const isMixed = hunk.types.has('insert') && hunk.types.has('delete');
        const isInsertOnly = hunk.types.has('insert') && !hunk.types.has('delete');
        let background;
        if (isMixed) {
            background = 'linear-gradient(180deg, #ef4444 50%, #10b981 50%)';
        } else if (isInsertOnly) {
            background = '#10b981';
        } else {
            background = '#ef4444';
        }

        const mark = document.createElement('div');
        mark.title = isMixed ? '修改' : (isInsertOnly ? '新增' : '删除');
        mark.style.cssText = `
            position: absolute;
            left: 1px;
            right: 1px;
            top: ${topRatio * 100}%;
            height: max(3px, ${heightRatio * 100}%);
            background: ${background};
            border-radius: 2px;
            pointer-events: auto;
            cursor: pointer;
            box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
        `;
        mark.onclick = () => {
            const targetY = Math.max(0, hunk.top - window.innerHeight / 2);
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        };
        container.appendChild(mark);
    });

    container.style.display = 'block';
}

let _diffMinimapResizeHandler = null;
function updateDiffMinimap(diffPre) {
    _diffMinimapActivePre = diffPre;
    renderDiffMinimapMarks(diffPre);

    if (!_diffMinimapResizeBound) {
        _diffMinimapResizeHandler = () => {
            if (!_diffMinimapActivePre || !document.body.contains(_diffMinimapActivePre)) return;
            clearTimeout(_diffMinimapResizeTimer);
            _diffMinimapResizeTimer = setTimeout(() => {
                renderDiffMinimapMarks(_diffMinimapActivePre);
            }, 150);
        };
        window.addEventListener('resize', _diffMinimapResizeHandler);
        _diffMinimapResizeBound = true;
    }
}

function hideDiffMinimap() {
    if ($("#toc")) $("#toc").style.display = "flex";
    if ($("#gotop")) $("#gotop").style.right = "0";

    _diffMinimapActivePre = null;
    if (_diffMinimapEl) {
        _diffMinimapEl.innerHTML = '';
        _diffMinimapEl.style.display = 'none';
    }

    if (_diffMinimapResizeBound) {
        window.removeEventListener('resize', _diffMinimapResizeHandler);
        _diffMinimapResizeBound = false;
    }
}

// ===== 搜索高亮 minimap（参考 diff minimap 的滚动条定位跳转实现）=====

function ensureSearchMinimapEl() {
    if (_searchMinimapEl && document.body.contains(_searchMinimapEl)) return _searchMinimapEl;

    const el = document.createElement('div');
    el.id = 'search-minimap';
    el.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 20px;
        height: 100vh;
        z-index: 999;
        pointer-events: none;
        background: rgba(127, 127, 127, 0.08);
        display: none;
    `;
    document.body.appendChild(el);
    _searchMinimapEl = el;
    return el;
}

function renderSearchMinimapMarks() {
    const container = ensureSearchMinimapEl();
    container.innerHTML = '';

    if (!window._searchMatchRanges || window._searchMatchRanges.size === 0) {
        container.style.display = 'none';
        return;
    }

    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
    let markCount = 0;

    window._searchMatchRanges.forEach((ranges, matchIndex) => {
        let minTop = Infinity, maxBottom = -Infinity;

        ranges.forEach(range => {
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return; // 忽略不可见区间
            const top = window.scrollY + rect.top;
            const bottom = window.scrollY + rect.bottom;
            minTop = Math.min(minTop, top);
            maxBottom = Math.max(maxBottom, bottom);
        });

        if (minTop === Infinity) return;

        const topRatio = minTop / totalHeight;
        const heightRatio = (maxBottom - minTop) / totalHeight;

        const mark = document.createElement('div');
        mark.title = `匹配 ${matchIndex + 1}`;
        mark.style.cssText = `
            position: absolute;
            left: 1px;
            right: 1px;
            top: ${topRatio * 100}%;
            height: max(3px, ${heightRatio * 100}%);
            background: rgba(255, 200, 0, 0.9);
            border-radius: 2px;
            pointer-events: auto;
            cursor: pointer;
            box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
        `;
        mark.onclick = () => {
            if (typeof window._jumpToSearchIndex === 'function') {
                window._jumpToSearchIndex(matchIndex);
            }
        };
        container.appendChild(mark);
        markCount++;
    });

    container.style.display = markCount > 0 ? 'block' : 'none';
}

function updateSearchMinimap() {
    renderSearchMinimapMarks();

    if (!_searchMinimapResizeBound) {
        _searchMinimapResizeHandler = () => {
            if (!window._searchMatchRanges || window._searchMatchRanges.size === 0) return;
            clearTimeout(_searchMinimapResizeTimer);
            _searchMinimapResizeTimer = setTimeout(() => {
                renderSearchMinimapMarks();
            }, 150);
        };
        window.addEventListener('resize', _searchMinimapResizeHandler);
        _searchMinimapResizeBound = true;
    }
}

function hideSearchMinimap() {
    if (_searchMinimapEl) {
        _searchMinimapEl.innerHTML = '';
        _searchMinimapEl.style.display = 'none';
    }
    if (_searchMinimapResizeBound) {
        window.removeEventListener('resize', _searchMinimapResizeHandler);
        _searchMinimapResizeBound = false;
    }
    window._jumpToSearchIndex = null;
}

function buildRenderedTokens(rawHtml) {
    const container = document.createElement('pre');
    container.innerHTML = rawHtml;

    function renderCodeBlockEl(rawText, lang) {
        const codeEl = document.createElement('code');
        if (lang) codeEl.setAttribute(lang, '');
        codeEl.innerHTML = highlightCode(rawText, lang);
        return codeEl;
    }

    const textNodes = Array.from(container.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
    const outHtmlArr = textNodes.map(node => format_markdown(node.nodeValue));
    textNodes.forEach((node, i) => {
        const fragment = document.createRange().createContextualFragment(outHtmlArr[i]);
        node.replaceWith(fragment);
    });

    container.querySelectorAll('p').forEach(p => {
        p.replaceWith(renderP2TableEl(p.textContent));
    });

    container.querySelectorAll('code').forEach(c => {
        const lang = c.attributes.length > 0 ? c.attributes[0].name : "java";
        const newCode = renderCodeBlockEl(c.textContent.trim(), lang);
        c.replaceWith(newCode);
    });

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