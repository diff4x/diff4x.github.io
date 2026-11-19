window.top&&window.top.VirtualCursor&&window.top.VirtualCursor.attach(window);const childId="content";window.childId=childId;const store=createStore();store.resource_type="bookmark";let wallpaperTimer=null,panelDomRef=null,faviconStyleEl=null;window.__LITE_BUS__&&window.__LITE_BUS__.close(),window.__LITE_BUS__=new BroadcastChannel("bus");const BUS=window.__LITE_BUS__,ctxId=window.top===window.self?"index":window.childId;window.addEventListener("pagehide",e=>{e.persisted||window.__LITE_BUS__&&(window.__LITE_BUS__.close(),window.__LITE_BUS__=null)}),window.addEventListener("DOMContentLoaded",()=>{store.bookmarkhtml_linksHash=getALinksHash();const e=Array.from(document.querySelectorAll("a")).filter(o=>o.textContent&&o.textContent.trim().length>0).map(o=>({text:o.textContent.trim(),href:o.href,target:o.target||"_blank"}));if(store.bookmark_links=e,store.online_flag==="0"){let o=0;const i=setInterval(()=>{o++,(store.bookmarkhtml_modifing!=="1"||o>310)&&(store.bookmarkhtml_modifing==="1"&&(store.bookmarkhtml_modifing="0"),clearInterval(i),setupDragAndDrop())},100)}loadFaviconsWhenIdle(),initWallpaperModule();const n="https://api.github.com/repos/diff4x/diff4x.github.io",t=60*1e3;let a=null,r=null;document.querySelector("#copyright")?.addEventListener("mouseenter",async function(){if(a&&Date.now()-a.time<t){this.title=a.title;return}if(r){this.title=await r;return}r=fetch(n).then(o=>{if(!o.ok)throw new Error(`HTTP ${o.status}`);return o.json()}).then(o=>{const l=`线上仓库体积：${(o.size/1024).toFixed(2)} MB`;return a={title:l,time:Date.now()},l}).finally(()=>{r=null});try{this.title=await r}catch(o){console.error(o)}}),createCalendar()}),document.addEventListener("keydown",e=>{e.key==="\\"&&emitEvent("quick_search","","index")});function getTabId(){try{return window.top&&window.top.__TAB_ID__||""}catch{return""}}function emitEvent(e,n,t="*"){if(window.__LITE_BUS__)try{window.__LITE_BUS__.postMessage({type:e,payload:n,from:ctxId,target:t,tabId:getTabId()})}catch{}}function createStore(e={}){return new Proxy({},{get(n,t){if(t==="pinyinData")return window.top.pinyinData||{};const a=localStorage.getItem(t);if(a===null)return e[t];try{return JSON.parse(a)}catch{return a}},set(n,t,a){return t==="pinyinData"||localStorage.setItem(t,JSON.stringify(a)),!0},deleteProperty(n,t){return t==="pinyinData"||localStorage.removeItem(t),!0}})}function setupDragAndDrop(){document.querySelectorAll("div").forEach(e=>{e.addEventListener("dragover",n=>{n.preventDefault(),e.classList.add("dragover")}),e.addEventListener("dragleave",()=>{e.classList.remove("dragover")}),e.addEventListener("drop",n=>{n.preventDefault(),e.classList.remove("dragover");const t=e.id,a=n.dataTransfer.getData("text/html"),r=n.dataTransfer.getData("text/uri-list");if(!a&&!r){alert("未获取到链接数据");return}let o="",i="";if(a){const s=new DOMParser().parseFromString(a,"text/html").querySelector("a");s&&(o=s.textContent.trim(),i=s.href)}else r&&(o=r,i=r);if(!i){alert("无法解析链接");return}const l=t+"}"+o+"}"+i;emitEvent("reload_bookmark",null,"index"),location.href=store.protocol_name+"://2{"+encodeURIComponent(l)})})}function getFaviconStyleEl(){return faviconStyleEl||(faviconStyleEl=document.createElement("style"),faviconStyleEl.id="favicon-style",document.head.appendChild(faviconStyleEl)),faviconStyleEl}function collectFaviconTargets(){const e=[];return Array.from(document.querySelectorAll("div")).filter(n=>n.id&&n.id!=="wallpaper-bg"&&n.id!=="wallpaper-panel"&&n.id!=="b1"&&n.id!=="del"&&n.id!=="a").forEach(n=>{Array.from(n.children).filter(a=>a.tagName==="A").forEach((a,r)=>{e.push({divId:n.id,nth:r+1,href:a.href})})}),e}function loadFaviconsWhenIdle(){if(!navigator.onLine){window.addEventListener("online",()=>loadFaviconsWhenIdle(),{once:!0});return}const e=window.requestIdleCallback?r=>window.requestIdleCallback(r,{timeout:2e3}):r=>setTimeout(()=>r({timeRemaining:()=>0,didTimeout:!0}),300),n=collectFaviconTargets();let t=0;function a(r){for(;t<n.length&&(r.timeRemaining()>0||r.didTimeout);)probeAndRenderFavicon(n[t]),t++;t<n.length&&e(a)}e(a)}function probeAndRenderFavicon({divId:e,nth:n,href:t}){let a;try{a=new URL(t).hostname}catch{return}const r=`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(a)}`,o=new Image;o.dataset.faviconProbe="1",o.onload=()=>{appendFaviconRule(e,n,r)},o.onerror=i=>{try{o.onerror=null,o.onload=null,o.src=""}catch{}},o.src=r}function appendFaviconRule(e,n,t){const a=getFaviconStyleEl(),r=`#${CSS.escape(e)} > a:nth-of-type(${n})`;a.appendChild(document.createTextNode(`${r}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;background-image:url("${t}");background-size:contain;background-repeat:no-repeat;background-position:center;vertical-align:-2px;}
`))}function getALinksHash(){const e=document.getElementsByTagName("a");let n="";for(let a of e)n+=a.href+";";let t=2166136261n;for(let a=0;a<n.length;a++)t^=BigInt(n.charCodeAt(a)),t*=16777619n;return t.toString(16)}function initWallpaperModule(){const e=store.wallpaper_config;!e||!Array.isArray(e.list)||e.list.length===0||(document.body.style.background="transparent",document.documentElement.style.background="#000",applyWallpaper(e),startWallpaperTimer(e),createWallpaperPanel(e),window.addEventListener("storage",n=>{if(n.key==="wallpaper_config"){const t=store.wallpaper_config;t&&Array.isArray(t.list)&&t.list.length>0?(applyWallpaper(t),startWallpaperTimer(t),updateWallpaperPanelUI(t)):disableWallpaperUI()}}))}function disableWallpaperUI(){wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null);const e=document.getElementById("wallpaper-bg");e&&(e.style.backgroundImage="none"),document.body.style.background="",document.documentElement.style.background="",document.getElementById("wallpaper-panel")?.remove(),document.getElementById("wallpaper-trigger-btn")?.remove(),document.querySelector(".wp-preview-tooltip")?.remove(),panelDomRef=null}function applyWallpaper(e){const n=document.getElementById("wallpaper-bg");if(!n)return;if(e.list.length===0){n.style.backgroundImage="none";return}e.currentIndex>=e.list.length&&(e.currentIndex=0);const t=e.list[e.currentIndex];n.style.backgroundImage=`url("../../${t}")`,n.style.backgroundSize=e.layout||"contain"}function startWallpaperTimer(e){if(wallpaperTimer&&(clearInterval(wallpaperTimer),wallpaperTimer=null),e.mode==="fixed"||e.list.length<=1)return;const n=Number(e.interval)||36e5;wallpaperTimer=setInterval(()=>{if(document.hidden)return;let t=store.wallpaper_config;if(!(!t||!Array.isArray(t.list)||t.list.length===0)){if(t.mode==="sequential")t.currentIndex=(t.currentIndex+1)%t.list.length;else if(t.mode==="random"){let a;do a=Math.floor(Math.random()*t.list.length);while(a===t.currentIndex&&t.list.length>1);t.currentIndex=a}store.wallpaper_config=t,applyWallpaper(t),updateWallpaperPanelUI(t)}},n)}function createWallpaperPanel(e){if(document.getElementById("wallpaper-trigger-btn"))return;const n=document.createElement("button");n.id="wallpaper-trigger-btn",n.innerHTML="🎨",n.title="壁纸设置面板",document.body.appendChild(n);const t=document.createElement("span");t.className="wp-preview-tooltip",document.body.appendChild(t);const a=document.createElement("div");a.id="wallpaper-panel",panelDomRef=a,document.body.appendChild(a),renderPanelInnerContent(a,e,t),n.onclick=()=>{a.classList.toggle("active")}}function renderPanelInnerContent(e,n,t){e.innerHTML=`
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
    `;const a=e.querySelector("#wp-close-btn");a&&(a.onclick=()=>e.classList.remove("active")),fillWallpaperListItems(n,t),bindPanelEvents(n)}function fillWallpaperListItems(e,n){const t=document.getElementById("wp-list-container");if(!t)return;t.innerHTML="",e.list.forEach((r,o)=>{const i=document.createElement("span");i.className="wp-item";const l=o===e.currentIndex,p=document.createElement("span");p.style.cssText=`overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; ${l?"color:#60a5fa; font-weight:bold;":""}`,p.title=r,p.textContent=`${l?"📌 ":""}${o+1}. ${r.split("/").pop()||r}`;const s=document.createElement("span"),c=document.createElement("button");c.className="wp-set-btn",c.dataset.idx=String(o),c.style.cssText="font-size:10px; cursor:pointer;",c.title="设为当前",c.textContent="设为当前";const d=document.createElement("button");d.className="wp-del-btn",d.dataset.idx=String(o),d.style.cssText="font-size:10px; cursor:pointer; color:#ef4444; margin-left:4px;",d.title="删除",d.textContent="🗑️",s.append(c,d),i.append(p,s),i.onmouseenter=u=>{n.style.backgroundImage=`url("../../${r}")`,n.style.display="block",moveTooltip(u,n)},i.onmousemove=u=>{moveTooltip(u,n)},i.onmouseleave=()=>{n.style.display="none"},t.appendChild(i)});const a=document.getElementById("wp-count-label");a&&(a.textContent=`已添加壁纸 (${e.list.length}张)`),t.querySelectorAll(".wp-set-btn").forEach(r=>{r.onclick=o=>{o.stopPropagation();const i=Number(r.getAttribute("data-idx"));let l=store.wallpaper_config;l&&(l.currentIndex=i,store.wallpaper_config=l,applyWallpaper(l),updateWallpaperPanelUI(l))}}),t.querySelectorAll(".wp-del-btn").forEach(r=>{r.onclick=o=>{o.stopPropagation();const i=Number(r.getAttribute("data-idx"));let l=store.wallpaper_config;if(l){if(l.list.splice(i,1),l.currentIndex>=l.list.length&&(l.currentIndex=Math.max(0,l.list.length-1)),l.list.length===0){delete store.wallpaper_config,disableWallpaperUI();return}store.wallpaper_config=l,applyWallpaper(l),startWallpaperTimer(l),updateWallpaperPanelUI(l)}}})}function moveTooltip(e,n){const t=e.clientX+15,a=e.clientY-110;n.style.left=Math.min(t,window.innerWidth-180)+"px",n.style.top=Math.max(a,10)+"px"}function bindPanelEvents(e){const n=[{val:"fixed",label:"固定单张"},{val:"sequential",label:"顺序轮播"},{val:"random",label:"随机切换"}],t=[{val:5e3,label:"5秒 (测试)"},{val:6e5,label:"10分钟"},{val:36e5,label:"1小时"},{val:216e5,label:"6小时"}],a=[{val:"contain",label:"Contain"},{val:"cover",label:"Cover"},{val:"repeat",label:"Repeat"},{val:"auto",label:"Auto"}],r=()=>{let i=store.wallpaper_config||{};i.mode=document.getElementById("wp-mode-btn").dataset.val,i.interval=Number(document.getElementById("wp-interval-btn").dataset.val),i.layout=document.getElementById("wp-layout-btn").dataset.val,store.wallpaper_config=i,applyWallpaper(i),startWallpaperTimer(i)},o=(i,l,p)=>{const s=document.getElementById(i);if(!s)return;let c=l.findIndex(d=>String(d.val)===String(p));c===-1&&(c=0),s.textContent=l[c].label,s.dataset.val=l[c].val,s.onclick=d=>{d.stopPropagation(),c=(c+1)%l.length,s.textContent=l[c].label,s.dataset.val=l[c].val,r()}};o("wp-mode-btn",n,e.mode||"fixed"),o("wp-interval-btn",t,e.interval||36e5),o("wp-layout-btn",a,e.layout||"contain")}function updateWallpaperPanelUI(e){if(!panelDomRef)return;const n=document.querySelector(".wp-preview-tooltip");fillWallpaperListItems(e,n),bindPanelEvents(e)}function createCalendar(e=document.body){const n=new Date,t=n.getFullYear(),a=n.getMonth(),r=new Date(t,a+1,0).getDate(),o=new Date(t,a,1).getDay(),i=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],l=document.createElement("div");l.id="glass-calendar-host";const p=l.attachShadow({mode:"open"});p.innerHTML=`
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
      <div class="hdr">${i[a]} ${t}</div>
      <div class="grid">
        ${["S","M","T","W","T","F","S"].map(s=>`<div class="cell wkd">${s}</div>`).join("")}
        ${'<div class="cell empty"></div>'.repeat(o)}
        ${Array.from({length:r},(s,c)=>c+1).map(s=>{let c="cell";return s===n.getDate()?c+=" today":s<n.getDate()&&(c+=" past"),`<div class="${c}">${s}</div>`}).join("")}
      </div>
    </div>
  `,e.appendChild(l)}
//# sourceMappingURL=source-map/bookmark.js.map
