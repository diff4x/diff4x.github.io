window.top&&window.top.VirtualCursor&&window.top.VirtualCursor.attach(window);const childId="content";window.childId=childId;const store=createStore();store.resource_type="bookmark";let wallpaperTimer=null,panelDomRef=null,faviconStyleEl=null;window.__LITE_BUS__&&window.__LITE_BUS__.close(),window.__LITE_BUS__=new BroadcastChannel("bus");const BUS=window.__LITE_BUS__,ctxId=window.top===window.self?"index":window.childId;window.addEventListener("pagehide",e=>{e.persisted||window.__LITE_BUS__&&(window.__LITE_BUS__.close(),window.__LITE_BUS__=null)}),window.addEventListener("DOMContentLoaded",()=>{store.bookmarkhtml_linksHash=getALinksHash();const e=Array.from(document.querySelectorAll("a")).filter(a=>a.textContent&&a.textContent.trim().length>0).map(a=>({text:a.textContent.trim(),href:a.href,target:a.target||"_blank"}));if(store.bookmark_links=e,store.online_flag==="0"){let a=0;const i=setInterval(()=>{a++,(store.bookmarkhtml_modifing!=="1"||a>310)&&(store.bookmarkhtml_modifing==="1"&&(store.bookmarkhtml_modifing="0"),clearInterval(i),setupDragAndDrop())},100)}loadFaviconsWhenIdle(),initWallpaperModule();const t="https://api.github.com/repos/diff4x/diff4x.github.io",n=60*1e3;let o=null,r=null;document.querySelector("#copyright")?.addEventListener("mouseenter",async function(){if(o&&Date.now()-o.time<n){this.title=o.title;return}if(r){this.title=await r;return}r=fetch(t).then(a=>{if(!a.ok)throw new Error(`HTTP ${a.status}`);return a.json()}).then(a=>{const l=`线上仓库体积：${(a.size/1024).toFixed(2)} MB`;return o={title:l,time:Date.now()},l}).finally(()=>{r=null});try{this.title=await r}catch(a){console.error(a)}}),createCalendar(),document.addEventListener("click",a=>{if(a.button!==0||a.ctrlKey||a.metaKey||a.shiftKey||a.altKey)return;const i=a.target.closest&&a.target.closest("a");if(!i||!/\bREADME\b/i.test((i.textContent||"").trim()))return;a.preventDefault();let l="";try{const d=new URL(i.href,location.href);l=decodeURIComponent((d.hash||"").slice(1))}catch{}emitEvent("OPEN_MD_VIEWER",{hash:l},"index")})}),document.addEventListener("keydown",e=>{e.key==="\\"&&emitEvent("quick_search","","index")});function getTabId(){try{return window.top&&window.top.__TAB_ID__||""}catch{return""}}function emitEvent(e,t,n="*"){if(window.__LITE_BUS__)try{window.__LITE_BUS__.postMessage({type:e,payload:t,from:ctxId,target:n,tabId:getTabId()})}catch{}}function createStore(e={}){return window.top.SiteCore.createStore(e)}function setupDragAndDrop(){document.querySelectorAll("div").forEach(e=>{e.addEventListener("dragover",t=>{t.preventDefault(),e.classList.add("dragover")}),e.addEventListener("dragleave",()=>{e.classList.remove("dragover")}),e.addEventListener("drop",async t=>{t.preventDefault(),e.classList.remove("dragover");const n=e.id,o=t.dataTransfer.getData("text/html"),r=t.dataTransfer.getData("text/uri-list");if(!o&&!r){alert("未获取到链接数据");return}let a="",i="";if(o){const s=new DOMParser().parseFromString(o,"text/html").querySelector("a");s&&(a=s.textContent.trim(),i=s.href)}else r&&(a=r,i=r);if(!i){alert("无法解析链接");return}const l=n+"}"+a+"}"+i;let d="";try{window.top&&typeof window.top.sealProtocolUrl=="function"?d=await window.top.sealProtocolUrl(2,l):d=await(await import("/src/js/shared-utils.js")).sealProtocolUrl(2,l)}catch(c){alert("❌ 本地协议封包失败："+(c&&c.message?c.message:String(c)));return}emitEvent("reload_bookmark",null,"index"),location.href=d})})}function getFaviconStyleEl(){return faviconStyleEl||(faviconStyleEl=document.createElement("style"),faviconStyleEl.id="favicon-style",document.head.appendChild(faviconStyleEl)),faviconStyleEl}function collectFaviconTargets(){const e=[];return Array.from(document.querySelectorAll("div")).filter(t=>t.id&&t.id!=="wallpaper-bg"&&t.id!=="wallpaper-panel"&&t.id!=="b1"&&t.id!=="del"&&t.id!=="a").forEach(t=>{Array.from(t.children).filter(o=>o.tagName==="A").forEach((o,r)=>{e.push({divId:t.id,nth:r+1,href:o.href})})}),e}function loadFaviconsWhenIdle(){if(!navigator.onLine){window.addEventListener("online",()=>loadFaviconsWhenIdle(),{once:!0});return}const e=window.requestIdleCallback?r=>window.requestIdleCallback(r,{timeout:2e3}):r=>setTimeout(()=>r({timeRemaining:()=>0,didTimeout:!0}),300),t=collectFaviconTargets();let n=0;function o(r){for(;n<t.length&&(r.timeRemaining()>0||r.didTimeout);)probeAndRenderFavicon(t[n]),n++;n<t.length&&e(o)}e(o)}function probeAndRenderFavicon({divId:e,nth:t,href:n}){let o;try{o=new URL(n).hostname}catch{return}const r=`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(o)}`,a=new Image;a.dataset.faviconProbe="1",a.onload=()=>{appendFaviconRule(e,t,r)},a.onerror=i=>{try{a.onerror=null,a.onload=null,a.src=""}catch{}},a.src=r}function appendFaviconRule(e,t,n){const o=getFaviconStyleEl(),r=`#${CSS.escape(e)} > a:nth-of-type(${t})`;o.appendChild(document.createTextNode(`${r}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;background-image:url("${n}");background-size:contain;background-repeat:no-repeat;background-position:center;vertical-align:-2px;}
`))}function getALinksHash(){const e=document.getElementsByTagName("a");let t="";for(let o of e)t+=o.href+";";let n=2166136261n;for(let o=0;o<t.length;o++)n^=BigInt(t.charCodeAt(o)),n*=16777619n;return n.toString(16)}function initWallpaperModule(){const e=store.wallpaper_config;!e||!Array.isArray(e.list)||e.list.length===0||(document.body.style.background="transparent",document.documentElement.style.background="#000",applyWallpaper(e),startWallpaperTimer(e),createWallpaperPanel(e),window.addEventListener("storage",t=>{if(t.key==="wallpaper_config"){const n=store.wallpaper_config;n&&Array.isArray(n.list)&&n.list.length>0?(applyWallpaper(n),startWallpaperTimer(n),updateWallpaperPanelUI(n)):disableWallpaperUI()}}))}function disableWallpaperUI(){wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null);const e=document.getElementById("wallpaper-bg");e&&(e.style.backgroundImage="none"),document.body.style.background="",document.documentElement.style.background="",document.getElementById("wallpaper-panel")?.remove(),document.getElementById("wallpaper-trigger-btn")?.remove(),document.querySelector(".wp-preview-tooltip")?.remove(),panelDomRef=null}function applyWallpaper(e){const t=document.getElementById("wallpaper-bg");if(!t)return;if(e.list.length===0){t.style.backgroundImage="none";return}e.currentIndex>=e.list.length&&(e.currentIndex=0);const n=e.list[e.currentIndex];t.style.backgroundImage=`url("../../${n}")`,t.style.backgroundSize=e.layout||"contain"}function startWallpaperTimer(e){if(wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null),e.mode==="fixed"||e.list.length<=1)return;const t=Number(e.interval)||36e5;wallpaperTimer=setInterval(()=>{if(document.hidden)return;let n=store.wallpaper_config;if(!(!n||!Array.isArray(n.list)||n.list.length===0)){if(n.mode==="sequential")n.currentIndex=(n.currentIndex+1)%n.list.length;else if(n.mode==="random"){let o;do o=Math.floor(Math.random()*n.list.length);while(o===n.currentIndex&&n.list.length>1);n.currentIndex=o}store.wallpaper_config=n,applyWallpaper(n),updateWallpaperPanelUI(n)}},t)}function createWallpaperPanel(e){if(document.getElementById("wallpaper-trigger-btn"))return;const t=document.createElement("button");t.id="wallpaper-trigger-btn",t.innerHTML="🎨",t.title="壁纸设置面板",document.body.appendChild(t);const n=document.createElement("span");n.className="wp-preview-tooltip",document.body.appendChild(n);const o=document.createElement("div");o.id="wallpaper-panel",panelDomRef=o,document.body.appendChild(o),renderPanelInnerContent(o,e,n),t.onclick=()=>{o.classList.toggle("active")}}function renderPanelInnerContent(e,t,n){e.innerHTML=`
        <span style="font-weight:bold; border-bottom:1px solid #444; padding-bottom:4px; display:flex; justify-content:space-between;">
            <span>🎨 壁纸管理器</span>
            <span id="wp-close-btn" style="cursor:pointer; color:#aaa;">✕</span>
        </span>
        <span id="wp-count-label" style="font-size:11px; color:#aaa;">已添加壁纸 (${t.list.length}张)</span>
        <span class="wp-list" id="wp-list-container"></span>
        
        <div id="b1" style="display:flex; flex-direction:column; gap:4px; margin-top:4px; font-size:12px;">
            <label>切换模式: <button id="wp-mode-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">固定单张</button></label>
            <label>切换频率: <button id="wp-interval-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">1小时</button></label>
            <label>显示布局: <button id="wp-layout-btn" style="background:#2a2a2a; color:#eee; border:1px solid #555; padding:2px 8px; cursor:pointer;">Contain</button></label>
        </div>
    `;const o=e.querySelector("#wp-close-btn");o&&(o.onclick=()=>e.classList.remove("active")),fillWallpaperListItems(t,n),bindPanelEvents(t)}function fillWallpaperListItems(e,t){const n=document.getElementById("wp-list-container");if(!n)return;n.innerHTML="",e.list.forEach((r,a)=>{const i=document.createElement("span");i.className="wp-item";const l=a===e.currentIndex,d=document.createElement("span");d.style.cssText=`overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; ${l?"color:#60a5fa; font-weight:bold;":""}`,d.title=r,d.textContent=`${l?"📌 ":""}${a+1}. ${r.split("/").pop()||r}`;const c=document.createElement("span"),s=document.createElement("button");s.className="wp-set-btn",s.dataset.idx=String(a),s.style.cssText="font-size:10px; cursor:pointer;",s.title="设为当前",s.textContent="设为当前";const p=document.createElement("button");p.className="wp-del-btn",p.dataset.idx=String(a),p.style.cssText="font-size:10px; cursor:pointer; color:#ef4444; margin-left:4px;",p.title="删除",p.textContent="🗑️",c.append(s,p),i.append(d,c),i.onmouseenter=u=>{t.style.backgroundImage=`url("../../${r}")`,t.style.display="block",moveTooltip(u,t)},i.onmousemove=u=>{moveTooltip(u,t)},i.onmouseleave=()=>{t.style.display="none"},n.appendChild(i)});const o=document.getElementById("wp-count-label");o&&(o.textContent=`已添加壁纸 (${e.list.length}张)`),n.querySelectorAll(".wp-set-btn").forEach(r=>{r.onclick=a=>{a.stopPropagation();const i=Number(r.getAttribute("data-idx"));let l=store.wallpaper_config;l&&(l.currentIndex=i,store.wallpaper_config=l,applyWallpaper(l),updateWallpaperPanelUI(l))}}),n.querySelectorAll(".wp-del-btn").forEach(r=>{r.onclick=a=>{a.stopPropagation();const i=Number(r.getAttribute("data-idx"));let l=store.wallpaper_config;if(l){if(l.list.splice(i,1),l.currentIndex>=l.list.length&&(l.currentIndex=Math.max(0,l.list.length-1)),l.list.length===0){delete store.wallpaper_config,disableWallpaperUI();return}store.wallpaper_config=l,applyWallpaper(l),startWallpaperTimer(l),updateWallpaperPanelUI(l)}}})}function moveTooltip(e,t){const n=e.clientX+15,o=e.clientY-110;t.style.left=Math.min(n,window.innerWidth-180)+"px",t.style.top=Math.max(o,10)+"px"}function bindPanelEvents(e){const t=[{val:"fixed",label:"固定单张"},{val:"sequential",label:"顺序轮播"},{val:"random",label:"随机切换"}],n=[{val:5e3,label:"5秒 (测试)"},{val:6e5,label:"10分钟"},{val:36e5,label:"1小时"},{val:216e5,label:"6小时"}],o=[{val:"contain",label:"Contain"},{val:"cover",label:"Cover"},{val:"repeat",label:"Repeat"},{val:"auto",label:"Auto"}],r=()=>{let i=store.wallpaper_config||{};i.mode=document.getElementById("wp-mode-btn").dataset.val,i.interval=Number(document.getElementById("wp-interval-btn").dataset.val),i.layout=document.getElementById("wp-layout-btn").dataset.val,store.wallpaper_config=i,applyWallpaper(i),startWallpaperTimer(i)},a=(i,l,d)=>{const c=document.getElementById(i);if(!c)return;let s=l.findIndex(p=>String(p.val)===String(d));s===-1&&(s=0),c.textContent=l[s].label,c.dataset.val=l[s].val,c.onclick=p=>{p.stopPropagation(),s=(s+1)%l.length,c.textContent=l[s].label,c.dataset.val=l[s].val,r()}};a("wp-mode-btn",t,e.mode||"fixed"),a("wp-interval-btn",n,e.interval||36e5),a("wp-layout-btn",o,e.layout||"contain")}function updateWallpaperPanelUI(e){if(!panelDomRef)return;const t=document.querySelector(".wp-preview-tooltip");fillWallpaperListItems(e,t),bindPanelEvents(e)}function createCalendar(e=document.body){const t=new Date,n=t.getFullYear(),o=t.getMonth(),r=new Date(n,o+1,0).getDate(),a=new Date(n,o,1).getDay(),i=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],l=document.createElement("div");l.id="glass-calendar-host";const d=l.attachShadow({mode:"open"});d.innerHTML=`
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
      <div class="hdr">${i[o]} ${n}</div>
      <div class="grid">
        ${["S","M","T","W","T","F","S"].map(c=>`<div class="cell wkd">${c}</div>`).join("")}
        ${'<div class="cell empty"></div>'.repeat(a)}
        ${Array.from({length:r},(c,s)=>s+1).map(c=>{let s="cell";return c===t.getDate()?s+=" today":c<t.getDate()&&(s+=" past"),`<div class="${s}">${c}</div>`}).join("")}
      </div>
    </div>
  `,e.appendChild(l)}
//# sourceMappingURL=source-map/bookmark.js.map
