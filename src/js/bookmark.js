window.top&&window.top.VirtualCursor&&window.top.VirtualCursor.attach(window);const childId="content";window.childId=childId;const store=createStore();store.resource_type="bookmark";let wallpaperTimer=null,panelDomRef=null,faviconStyleEl=null;window.__LITE_BUS__&&window.__LITE_BUS__.close(),window.__LITE_BUS__=new BroadcastChannel("bus");const BUS=window.__LITE_BUS__,ctxId=window.top===window.self?"index":window.childId;window.addEventListener("pagehide",t=>{t.persisted||window.__LITE_BUS__&&(window.__LITE_BUS__.close(),window.__LITE_BUS__=null)}),window.addEventListener("DOMContentLoaded",()=>{store.bookmarkhtml_linksHash=getALinksHash();const t=Array.from(document.querySelectorAll("a")).filter(l=>l.textContent&&l.textContent.trim().length>0).map(l=>({text:l.textContent.trim(),href:l.href,target:l.target||"_blank"}));if(store.bookmark_links=t,store.online_flag==="0"){let l=0;const i=setInterval(()=>{l++,(store.bookmarkhtml_modifing!=="1"||l>50)&&(store.bookmarkhtml_modifing==="1"&&(store.bookmarkhtml_modifing="0"),clearInterval(i),setupDragAndDrop())},100)}loadFaviconsWhenIdle(),initWallpaperModule();const n="https://api.github.com/repos/diff4x/diff4x.github.io",e=60*1e3;let a=null,o=null;document.querySelector("#copyright")?.addEventListener("mouseenter",async function(){if(a&&Date.now()-a.time<e){this.title=a.title;return}if(o){this.title=await o;return}o=fetch(n).then(l=>{if(!l.ok)throw new Error(`HTTP ${l.status}`);return l.json()}).then(l=>{const r=`线上仓库体积：${(l.size/1024).toFixed(2)} MB`;return a={title:r,time:Date.now()},r}).finally(()=>{o=null});try{this.title=await o}catch(l){console.error(l)}}),createCalendar()}),document.addEventListener("keydown",t=>{t.key==="\\"&&emitEvent("quick_search","","index")});function emitEvent(t,n,e="*"){if(window.__LITE_BUS__)try{window.__LITE_BUS__.postMessage({type:t,payload:n,from:ctxId,target:e})}catch{}}function createStore(t={}){return new Proxy({},{get(n,e){if(e==="pinyinData")return window.top.pinyinData||{};const a=localStorage.getItem(e);if(a===null)return t[e];try{return JSON.parse(a)}catch{return a}},set(n,e,a){return e==="pinyinData"||localStorage.setItem(e,JSON.stringify(a)),!0},deleteProperty(n,e){return e==="pinyinData"||localStorage.removeItem(e),!0}})}function setupDragAndDrop(){document.querySelectorAll("div").forEach(t=>{t.addEventListener("dragover",n=>{n.preventDefault(),t.classList.add("dragover")}),t.addEventListener("dragleave",()=>{t.classList.remove("dragover")}),t.addEventListener("drop",n=>{n.preventDefault(),t.classList.remove("dragover");const e=t.id,a=n.dataTransfer.getData("text/html"),o=n.dataTransfer.getData("text/uri-list");if(!a&&!o){alert("未获取到链接数据");return}let l="",i="";if(a){const c=new DOMParser().parseFromString(a,"text/html").querySelector("a");c&&(l=c.textContent.trim(),i=c.href)}else o&&(l=o,i=o);if(!i){alert("无法解析链接");return}const r=e+"}"+l+"}"+i;emitEvent("reload_bookmark",null,"index"),location.href=store.protocol_name+"://2{"+encodeURIComponent(r)})})}function getFaviconStyleEl(){return faviconStyleEl||(faviconStyleEl=document.createElement("style"),faviconStyleEl.id="favicon-style",document.head.appendChild(faviconStyleEl)),faviconStyleEl}function collectFaviconTargets(){const t=[];return Array.from(document.querySelectorAll("div")).filter(n=>n.id&&n.id!=="wallpaper-bg"&&n.id!=="wallpaper-panel"&&n.id!=="b1"&&n.id!=="del"&&n.id!=="a").forEach(n=>{Array.from(n.children).filter(a=>a.tagName==="A").forEach((a,o)=>{t.push({divId:n.id,nth:o+1,href:a.href})})}),t}function loadFaviconsWhenIdle(){if(!navigator.onLine){window.addEventListener("online",()=>loadFaviconsWhenIdle(),{once:!0});return}const t=window.requestIdleCallback?o=>window.requestIdleCallback(o,{timeout:2e3}):o=>setTimeout(()=>o({timeRemaining:()=>0,didTimeout:!0}),300),n=collectFaviconTargets();let e=0;function a(o){for(;e<n.length&&(o.timeRemaining()>0||o.didTimeout);)probeAndRenderFavicon(n[e]),e++;e<n.length&&t(a)}t(a)}function probeAndRenderFavicon({divId:t,nth:n,href:e}){let a;try{a=new URL(e).hostname}catch{return}const o=`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(a)}`,l=new Image;l.dataset.faviconProbe="1",l.onload=()=>{appendFaviconRule(t,n,o)},l.onerror=i=>{try{l.onerror=null,l.onload=null,l.src=""}catch{}},l.src=o}function appendFaviconRule(t,n,e){const a=getFaviconStyleEl(),o=`#${CSS.escape(t)} > a:nth-of-type(${n})`;a.appendChild(document.createTextNode(`${o}::before{content:"";display:inline-block;width:14px;height:14px;margin-right:4px;background-image:url("${e}");background-size:contain;background-repeat:no-repeat;background-position:center;vertical-align:-2px;}
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
    `;const a=t.querySelector("#wp-close-btn");a&&(a.onclick=()=>t.classList.remove("active")),fillWallpaperListItems(n,e),bindPanelEvents(n)}function fillWallpaperListItems(t,n){const e=document.getElementById("wp-list-container");if(!e)return;e.innerHTML="",t.list.forEach((o,l)=>{const i=document.createElement("span");i.className="wp-item";const r=l===t.currentIndex,p=document.createElement("span");p.style.cssText=`overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; ${r?"color:#60a5fa; font-weight:bold;":""}`,p.title=o,p.textContent=`${r?"📌 ":""}${l+1}. ${o.split("/").pop()||o}`;const c=document.createElement("span"),s=document.createElement("button");s.className="wp-set-btn",s.dataset.idx=String(l),s.style.cssText="font-size:10px; cursor:pointer;",s.title="设为当前",s.textContent="设为当前";const d=document.createElement("button");d.className="wp-del-btn",d.dataset.idx=String(l),d.style.cssText="font-size:10px; cursor:pointer; color:#ef4444; margin-left:4px;",d.title="删除",d.textContent="🗑️",c.append(s,d),i.append(p,c),i.onmouseenter=u=>{n.style.backgroundImage=`url("../../${o}")`,n.style.display="block",moveTooltip(u,n)},i.onmousemove=u=>{moveTooltip(u,n)},i.onmouseleave=()=>{n.style.display="none"},e.appendChild(i)});const a=document.getElementById("wp-count-label");a&&(a.textContent=`已添加壁纸 (${t.list.length}张)`),e.querySelectorAll(".wp-set-btn").forEach(o=>{o.onclick=l=>{l.stopPropagation();const i=Number(o.getAttribute("data-idx"));let r=store.wallpaper_config;r&&(r.currentIndex=i,store.wallpaper_config=r,applyWallpaper(r),updateWallpaperPanelUI(r))}}),e.querySelectorAll(".wp-del-btn").forEach(o=>{o.onclick=l=>{l.stopPropagation();const i=Number(o.getAttribute("data-idx"));let r=store.wallpaper_config;if(r){if(r.list.splice(i,1),r.currentIndex>=r.list.length&&(r.currentIndex=Math.max(0,r.list.length-1)),r.list.length===0){delete store.wallpaper_config,disableWallpaperUI();return}store.wallpaper_config=r,applyWallpaper(r),startWallpaperTimer(r),updateWallpaperPanelUI(r)}}})}function moveTooltip(t,n){const e=t.clientX+15,a=t.clientY-110;n.style.left=Math.min(e,window.innerWidth-180)+"px",n.style.top=Math.max(a,10)+"px"}function bindPanelEvents(t){const n=[{val:"fixed",label:"固定单张"},{val:"sequential",label:"顺序轮播"},{val:"random",label:"随机切换"}],e=[{val:5e3,label:"5秒 (测试)"},{val:6e5,label:"10分钟"},{val:36e5,label:"1小时"},{val:216e5,label:"6小时"}],a=[{val:"contain",label:"Contain"},{val:"cover",label:"Cover"},{val:"repeat",label:"Repeat"},{val:"auto",label:"Auto"}],o=()=>{let i=store.wallpaper_config||{};i.mode=document.getElementById("wp-mode-btn").dataset.val,i.interval=Number(document.getElementById("wp-interval-btn").dataset.val),i.layout=document.getElementById("wp-layout-btn").dataset.val,store.wallpaper_config=i,applyWallpaper(i),startWallpaperTimer(i)},l=(i,r,p)=>{const c=document.getElementById(i);if(!c)return;let s=r.findIndex(d=>String(d.val)===String(p));s===-1&&(s=0),c.textContent=r[s].label,c.dataset.val=r[s].val,c.onclick=d=>{d.stopPropagation(),s=(s+1)%r.length,c.textContent=r[s].label,c.dataset.val=r[s].val,o()}};l("wp-mode-btn",n,t.mode||"fixed"),l("wp-interval-btn",e,t.interval||36e5),l("wp-layout-btn",a,t.layout||"contain")}function updateWallpaperPanelUI(t){if(!panelDomRef)return;const n=document.querySelector(".wp-preview-tooltip");fillWallpaperListItems(t,n),bindPanelEvents(t)}function createCalendar(t=document.body){const n=new Date,e=n.getFullYear(),a=n.getMonth(),o=new Date(e,a+1,0).getDate(),l=new Date(e,a,1).getDay(),i=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],r=document.createElement("div");r.id="glass-calendar-host";const p=r.attachShadow({mode:"open"});p.innerHTML=`
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
        ${["S","M","T","W","T","F","S"].map(c=>`<div class="cell wkd">${c}</div>`).join("")}
        ${'<div class="cell empty"></div>'.repeat(l)}
        ${Array.from({length:o},(c,s)=>s+1).map(c=>{let s="cell";return c===n.getDate()?s+=" today":c<n.getDate()&&(s+=" past"),`<div class="${s}">${c}</div>`}).join("")}
      </div>
    </div>
  `,t.appendChild(r)}
//# sourceMappingURL=source-map/bookmark.js.map
