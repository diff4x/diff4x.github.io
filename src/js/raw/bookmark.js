
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



