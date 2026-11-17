window.top&&window.top.VirtualCursor&&window.top.VirtualCursor.attach(window);const childId="content";window.childId=childId;const store=createStore();store.resource_type="bookmark";let wallpaperTimer=null,panelDomRef=null,faviconStyleEl=null;window.__LITE_BUS__&&window.__LITE_BUS__.close(),window.__LITE_BUS__=new BroadcastChannel("bus");const BUS=window.__LITE_BUS__,ctxId=window.top===window.self?"index":window.childId;window.addEventListener("pagehide",t=>{t.persisted||window.__LITE_BUS__&&(window.__LITE_BUS__.close(),window.__LITE_BUS__=null)}),window.addEventListener("DOMContentLoaded",()=>{store.bookmarkhtml_linksHash=getALinksHash();const t=Array.from(document.querySelectorAll("a")).filter(l=>l.textContent&&l.textContent.trim().length>0).map(l=>({text:l.textContent.trim(),href:l.href,target:l.target||"_blank"}));if(store.bookmark_links=t,store.online_flag==="0"){const l=setInterval(()=>{store.bookmarkhtml_modifing!=="1"&&(clearInterval(l),setupDragAndDrop())},100)}loadFaviconsWhenIdle(),initWallpaperModule();const n="https://api.github.com/repos/diff4x/diff4x.github.io",e=60*1e3;let a=null,r=null;document.querySelector("#copyright")?.addEventListener("mouseenter",async function(){if(a&&Date.now()-a.time<e){this.title=a.title;return}if(r){this.title=await r;return}r=fetch(n).then(l=>{if(!l.ok)throw new Error(`HTTP ${l.status}`);return l.json()}).then(l=>{const o=`线上仓库体积：${(l.size/1024).toFixed(2)} MB`;return a={title:o,time:Date.now()},o}).finally(()=>{r=null});try{this.title=await r}catch(l){console.error(l)}}),createCalendar()}),document.addEventListener("keydown",t=>{t.key==="\\"&&emitEvent("quick_search","","index")});function emitEvent(t,n,e="*"){if(window.__LITE_BUS__)try{window.__LITE_BUS__.postMessage({type:t,payload:n,from:ctxId,target:e})}catch{}}function createStore(t={}){return new Proxy({},{get(n,e){if(e==="pinyinData")return window.top.pinyinData||{};const a=localStorage.getItem(e);if(a===null)return t[e];try{return JSON.parse(a)}catch{return a}},set(n,e,a){return e==="pinyinData"||localStorage.setItem(e,JSON.stringify(a)),!0},deleteProperty(n,e){return e==="pinyinData"||localStorage.removeItem(e),!0}})}function setupDragAndDrop(){document.querySelectorAll("div").forEach(t=>{t.addEventListener("dragover",n=>{n.preventDefault(),t.classList.add("dragover")}),t.addEventListener("dragleave",()=>{t.classList.remove("dragover")}),t.addEventListener("drop",n=>{n.preventDefault(),t.classList.remove("dragover");const e=t.id,a=n.dataTransfer.getData("text/html"),r=n.dataTransfer.getData("text/uri-list");if(!a&&!r){alert("未获取到链接数据");return}let l="",i="";if(a){const s=new DOMParser().parseFromString(a,"text/html").querySelector("a");s&&(l=s.textContent.trim(),i=s.href)}else r&&(l=r,i=r);if(!i){alert("无法解析链接");return}const o=e+"}"+l+"}"+i;emitEvent("reload_bookmark",null,"index"),location.href=store.protocol_name+"://2{"+encodeURIComponent(o)})})}function getFaviconStyleEl(){return faviconStyleEl||(faviconStyleEl=document.createElement("style"),faviconStyleEl.id="favicon-style",document.head.appendChild(faviconStyleEl)),faviconStyleEl}function collectFaviconTargets(){const t=[];return Array.from(document.querySelectorAll("div")).filter(n=>n.id&&n.id!=="wallpaper-bg"&&n.id!=="wallpaper-panel"&&n.id!=="b1"&&n.id!=="del"&&n.id!=="a").forEach(n=>{Array.from(n.children).filter(a=>a.tagName==="A").forEach((a,r)=>{t.push({divId:n.id,nth:r+1,href:a.href})})}),t}function loadFaviconsWhenIdle(){const t=window.requestIdleCallback?r=>window.requestIdleCallback(r,{timeout:2e3}):r=>setTimeout(()=>r({timeRemaining:()=>0,didTimeout:!0}),300),n=collectFaviconTargets();let e=0;function a(r){for(;e<n.length&&(r.timeRemaining()>0||r.didTimeout);)probeAndRenderFavicon(n[e]),e++;e<n.length&&t(a)}t(a)}function probeAndRenderFavicon({divId:t,nth:n,href:e}){let a;try{a=new URL(e).hostname}catch{return}const r=`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(a)}`,l=new Image;l.dataset.faviconProbe="1",l.onload=()=>{appendFaviconRule(t,n,r)},l.onerror=i=>{try{l.onerror=null,l.onload=null,l.src=""}catch{}},l.src=r}function appendFaviconRule(t,n,e){const a=getFaviconStyleEl(),r=`#${CSS.escape(t)} > a:nth-of-type(${n})`;a.appendChild(document.createTextNode(`${r}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;background-image:url("${e}");background-size:contain;background-repeat:no-repeat;background-position:center;vertical-align:-2px;}
`))}function getALinksHash(){const t=document.getElementsByTagName("a");let n="";for(let a of t)n+=a.href+";";let e=2166136261n;for(let a=0;a<n.length;a++)e^=BigInt(n.charCodeAt(a)),e*=16777619n;return e.toString(16)}function initWallpaperModule(){const t=store.wallpaper_config;!t||!Array.isArray(t.list)||t.list.length===0||(document.body.style.background="transparent",document.documentElement.style.background="#000",applyWallpaper(t),startWallpaperTimer(t),createWallpaperPanel(t),window.addEventListener("storage",n=>{if(n.key==="wallpaper_config"){const e=store.wallpaper_config;e&&Array.isArray(e.list)&&e.list.length>0?(applyWallpaper(e),startWallpaperTimer(e),updateWallpaperPanelUI(e)):disableWallpaperUI()}}))}function disableWallpaperUI(){wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null);const t=document.getElementById("wallpaper-bg");t&&(t.style.backgroundImage="none"),document.body.style.background="",document.documentElement.style.background="",document.getElementById("wallpaper-panel")?.remove(),document.getElementById("wallpaper-trigger-btn")?.remove(),document.querySelector(".wp-preview-tooltip")?.remove(),panelDomRef=null}function applyWallpaper(t){const n=document.getElementById("wallpaper-bg");if(!n)return;if(t.list.length===0){n.style.backgroundImage="none";return}t.currentIndex>=t.list.length&&(t.currentIndex=0);const e=t.list[t.currentIndex];n.style.backgroundImage=`url("../../${e}")`,n.style.backgroundSize=t.layout||"contain"}function startWallpaperTimer(t){if(wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null),t.mode==="fixed"||t.list.length<=1)return;const n=Number(t.interval)||36e5;wallpaperTimer=setInterval(()=>{if(document.hidden)return;let e=store.wallpaper_config;if(!(!e||!Array.isArray(e.list)||e.list.length===0)){if(e.mode==="sequential")e.currentIndex=(e.currentIndex+1)%e.list.length;else if(e.mode==="random"){let a;do a=Math.floor(Math.random()*e.list.length);while(a===e.currentIndex&&e.list.length>1);e.currentIndex=a}store.wallpaper_config=e,applyWallpaper(e),updateWallpaperPanelUI(e)}},n)}function createWallpaperPanel(t){if(document.getElementById("wallpaper-trigger-btn"))return;const n=document.createElement("button");n.id="wallpaper-trigger-btn",n.innerHTML="🎨",n.title="壁纸设置面板",document.body.appendChild(n);const e=document.createElement("span");e.className="wp-preview-tooltip",document.body.appendChild(e);const a=document.createElement("div");a.id="wallpaper-panel",panelDomRef=a,document.body.appendChild(a),renderPanelInnerContent(a,t,e),n.onclick=()=>{a.classList.toggle("active")}}function renderPanelInnerContent(t,n,e){t.innerHTML=`
        <span style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:4px; display:flex; justify-content:space-between;">
            <span>🎨 壁纸管理器</span>
            <span id="wp-close-btn" style="cursor:pointer; color:#aaa;">✕</span>
        </span>
        <span id="wp-count-label" style="font-size:11px; color:#aaa;">已添加壁纸 (${n.list.length}张)</span>
        <span class="wp-list" id="wp-list-container"></span>
        
        <div id="b1" style="display:flex; flex-direction:column; gap:4px; margin-top:4px; font-size:12px;">
            <label>切换模式: <button id="wp-mode-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">固定单张</button></label>
            <label>切换频率: <button id="wp-interval-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">1小时</button></label>
            <label>显示布局: <button id="wp-layout-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">Contain</button></label>
        </div>
    `;const a=t.querySelector("#wp-close-btn");a&&(a.onclick=()=>t.classList.remove("active")),fillWallpaperListItems(n,e),bindPanelEvents(n)}function fillWallpaperListItems(t,n){const e=document.getElementById("wp-list-container");if(!e)return;e.innerHTML="",t.list.forEach((r,l)=>{const i=document.createElement("span");i.className="wp-item";const o=l===t.currentIndex;i.innerHTML=`
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; ${o?"color:#60a5fa; font-weight:bold;":""}" title="${r}">
                ${o?"📌 ":""}${l+1}. ${r.split("/").pop()||r}
            </span>
            <span>
                <button class="wp-set-btn" data-idx="${l}" style="font-size:10px; cursor:pointer;" title="设为当前">设为当前</button>
                <button class="wp-del-btn" data-idx="${l}" style="font-size:10px; cursor:pointer; color:#ef4444;" title="删除">🗑️</button>
            </span>
        `,i.onmouseenter=c=>{n.style.backgroundImage=`url("../../${r}")`,n.style.display="block",moveTooltip(c,n)},i.onmousemove=c=>{moveTooltip(c,n)},i.onmouseleave=()=>{n.style.display="none"},e.appendChild(i)});const a=document.getElementById("wp-count-label");a&&(a.textContent=`已添加壁纸 (${t.list.length}张)`),e.querySelectorAll(".wp-set-btn").forEach(r=>{r.onclick=l=>{l.stopPropagation();const i=Number(r.getAttribute("data-idx"));let o=store.wallpaper_config;o&&(o.currentIndex=i,store.wallpaper_config=o,applyWallpaper(o),updateWallpaperPanelUI(o))}}),e.querySelectorAll(".wp-del-btn").forEach(r=>{r.onclick=l=>{l.stopPropagation();const i=Number(r.getAttribute("data-idx"));let o=store.wallpaper_config;if(o){if(o.list.splice(i,1),o.currentIndex>=o.list.length&&(o.currentIndex=Math.max(0,o.list.length-1)),o.list.length===0){delete store.wallpaper_config,disableWallpaperUI();return}store.wallpaper_config=o,applyWallpaper(o),startWallpaperTimer(o),updateWallpaperPanelUI(o)}}})}function moveTooltip(t,n){const e=t.clientX+15,a=t.clientY-110;n.style.left=Math.min(e,window.innerWidth-180)+"px",n.style.top=Math.max(a,10)+"px"}function bindPanelEvents(t){const n=[{val:"fixed",label:"固定单张"},{val:"sequential",label:"顺序轮播"},{val:"random",label:"随机切换"}],e=[{val:5e3,label:"5秒 (测试)"},{val:6e5,label:"10分钟"},{val:36e5,label:"1小时"},{val:216e5,label:"6小时"}],a=[{val:"contain",label:"Contain"},{val:"cover",label:"Cover"},{val:"repeat",label:"Repeat"},{val:"auto",label:"Auto"}],r=()=>{let i=store.wallpaper_config||{};i.mode=document.getElementById("wp-mode-btn").dataset.val,i.interval=Number(document.getElementById("wp-interval-btn").dataset.val),i.layout=document.getElementById("wp-layout-btn").dataset.val,store.wallpaper_config=i,applyWallpaper(i),startWallpaperTimer(i)},l=(i,o,c)=>{const s=document.getElementById(i);if(!s)return;let d=o.findIndex(p=>String(p.val)===String(c));d===-1&&(d=0),s.textContent=o[d].label,s.dataset.val=o[d].val,s.onclick=p=>{p.stopPropagation(),d=(d+1)%o.length,s.textContent=o[d].label,s.dataset.val=o[d].val,r()}};l("wp-mode-btn",n,t.mode||"fixed"),l("wp-interval-btn",e,t.interval||36e5),l("wp-layout-btn",a,t.layout||"contain")}function updateWallpaperPanelUI(t){if(!panelDomRef)return;const n=document.querySelector(".wp-preview-tooltip");fillWallpaperListItems(t,n),bindPanelEvents(t)}function createCalendar(t=document.body){const n=new Date,e=n.getFullYear(),a=n.getMonth(),r=new Date(e,a+1,0).getDate(),l=new Date(e,a,1).getDay(),i=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],o=document.createElement("div");o.id="glass-calendar-host";const c=o.attachShadow({mode:"open"});c.innerHTML=`
    <style>
      :host {
        display: inline-block;
        all: initial;
      }
      .calendar-box {
        top: 100px;
        right: 30px;
        position: absolute;
        box-sizing: border-box;
        padding: 14px; 
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.05); 
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px); 
        border: 1px solid rgba(255, 255, 255, 0.25);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1); 
        color: #fff;
        font-family: system-ui, -apple-system, sans-serif; 
        font-size: 12px; 
        text-align: center;
        margin: 0;
      }
      .hdr { 
        font-weight: bold; 
        margin-bottom: 10px; 
        letter-spacing: 1px; 
      }
      .grid { 
        display: grid; 
        grid-template-columns: repeat(7, 1fr); 
        gap: 4px; 
      }
      .cell {
        aspect-ratio: 1; 
        display: flex; 
        align-items: center; 
        justify-content: center;
        border-radius: 4px; 
        background: rgba(255, 255, 255, 0.1); 
        transition: 0.2s;
      }
      .wkd { background: transparent; opacity: 0.6; font-size: 10px; }
      .empty { background: transparent; }
      .today { background: rgb(0 255 49 / 30%); font-weight: bold; }
      .past { background: rgba(255, 255, 255, 0.03); color: #a8a8a8 }
    </style>
    <div class="calendar-box">
      <div class="hdr">${i[a]} ${e}</div>
      <div class="grid">
        ${["S","M","T","W","T","F","S"].map(s=>`<div class="cell wkd">${s}</div>`).join("")}
        ${'<div class="cell empty"></div>'.repeat(l)}
        ${Array.from({length:r},(s,d)=>d+1).map(s=>{let d="cell";return s===n.getDate()?d+=" today":s<n.getDate()&&(d+=" past"),`<div class="${d}">${s}</div>`}).join("")}
      </div>
    </div>
  `,t.appendChild(o)}
//# sourceMappingURL=source-map/bookmark.js.map
