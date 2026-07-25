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

    const btnGuestbook = document.getElementById('btn-guestbook');
    if (btnGuestbook) {
        btnGuestbook.addEventListener('click', () => {
            sendToParent('show_guestbook', null);
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
        .filter(div => div.id && div.id !== 'del' && div.id !== 'a')
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