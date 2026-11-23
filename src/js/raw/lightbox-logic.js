/**
 * lightbox-logic.js —— 图片 / 视频灯箱渲染与交互模块（零内联脚本，CSP: script-src 'none'）
 */
import { escapeHtml, saveMediaPosition } from './shared-utils.js';

export function safeInlineJson(val) {
    return JSON.stringify(val)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function attachIframeCommon(win) {
    const doc = win.document;
    const $ = (s) => doc.querySelector(s);
    const $$ = (s) => doc.querySelectorAll(s);
    const store = (window.top && window.top.SiteCore)
        ? window.top.SiteCore.createStore({ lightbox_stauts: "0" })
        : new Proxy({}, {
            get(_, prop) {
                const raw = sessionStorage.getItem(prop) ?? localStorage.getItem(prop);
                if (raw === null) return prop === 'lightbox_stauts' ? "0" : undefined;
                try { return JSON.parse(raw); } catch { return raw; }
            },
            set(_, prop, value) {
                sessionStorage.setItem(prop, JSON.stringify(value));
                return true;
            }
        });

    win.childId = 'content';
    if (win.__LITE_BUS__) {
        try { win.__LITE_BUS__.close(); } catch (_) { }
    }
    const BUS = new BroadcastChannel('bus');
    win.__LITE_BUS__ = BUS;

    win.addEventListener('pagehide', (e) => {
        if (e.persisted) return;
        if (win.__LITE_BUS__) {
            try { win.__LITE_BUS__.close(); } catch (_) { }
            win.__LITE_BUS__ = null;
        }
    });

    const ctxId = 'content';
    const getTabId = () => {
        try { return (window.top && window.top.__TAB_ID__) || ''; } catch (_) { return ''; }
    };
    const emitEvent = (type, payload, target = '*') => {
        if (!win.__LITE_BUS__) return;
        try {
            win.__LITE_BUS__.postMessage({ type, payload, from: ctxId, target, tabId: getTabId() });
        } catch (_) { }
    };

    if (window.top && window.top.VirtualCursor) {
        try { window.top.VirtualCursor.attach(win); } catch (_) { }
    }

    BUS.addEventListener('message', (e) => {
        const { type, payload, target, tabId } = e.data || {};
        const myTab = getTabId();
        if (tabId && myTab && tabId !== myTab) return;
        if (target !== '*' && target !== ctxId) return;
        if (type === 'SIM_POINTER' && typeof win.handleSimPointer === 'function') {
            win.handleSimPointer(payload);
        }
    });

    const bindSwipeGestures = (element, callbacks, thresholdPercent = 0.15) => {
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
            if (e.touches.length > 1) isMultiTouch = true;
        }, { passive: false });

        element.addEventListener('touchend', (e) => {
            if (isMultiTouch) return;
            const currentScale = callbacks.getScale ? callbacks.getScale() : 1.0;
            if (currentScale > 1.05) return;
            if (e.changedTouches.length !== 1) return;

            const deltaX = e.changedTouches[0].clientX - startX;
            const deltaY = e.changedTouches[0].clientY - startY;
            const dynamicThreshold = Math.min(win.innerWidth, win.innerHeight) * thresholdPercent;

            if (Math.abs(deltaX) > dynamicThreshold || Math.abs(deltaY) > dynamicThreshold) {
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0 && callbacks.onRight) callbacks.onRight();
                    else if (deltaX < 0 && callbacks.onLeft) callbacks.onLeft();
                } else if (callbacks.onVertical) {
                    callbacks.onVertical();
                }
            } else if (callbacks.onSnapBack) {
                callbacks.onSnapBack();
            }
        });
    };

    const mountIndexJumpInput = (container, idx, total, onJump) => {
        container.textContent = '';
        container.appendChild(doc.createTextNode(`${idx + 1}/${total}`));
        const inp = doc.createElement('input');
        inp.id = 'jump';
        inp.style.width = '60px';
        inp.addEventListener('click', () => inp.select());
        inp.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                const val = parseInt(inp.value, 10);
                if (!Number.isNaN(val) && val > 0 && val <= total) onJump(val - 1);
            }
        });
        container.appendChild(inp);
        return inp;
    };

    return { doc, $, $$, store, emitEvent, bindSwipeGestures, mountIndexJumpInput };
}

function mountImageLogic(win, payload) {
    const { doc, $, $$, store, emitEvent, bindSwipeGestures, mountIndexJumpInput } = attachIframeCommon(win);
    const img = $('#img');
    const loader = $('#loader');
    const imageUrl = (payload && payload.imageUrl) || '';

    if (img) {
        img.onload = () => {
            if (loader) loader.style.display = 'none';
            img.style.visibility = 'visible';
        };
        img.onerror = () => {
            if (loader) loader.style.display = 'none';
        };
    }

    const fileName = imageUrl.split('/').pop() || '';
    if (fileName.startsWith('pano_')) {
        img.style.border = '2px red solid';
        img.title = '双击进入全景';
    } else {
        img.style.border = 'none';
        img.title = '';
    }

    let scale = 1.0;
    const maxScale = 10.0;
    const minScale = 0.5;
    const scaleStep = 0.1;
    let dragMoved = false;

    img.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.max(minScale, Math.min(scale + (e.deltaY < 0 ? scaleStep : -scaleStep), maxScale));
        img.style.transform = `translate(${img.dataset.tx || 0}px, ${img.dataset.ty || 0}px) scale(${scale})`;
    });

    let initialDistance = 0;
    let initialScale = 1.0;

    img.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            initialScale = scale;
        }
    }, { passive: false });

    img.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialDistance > 0) {
            if (e.cancelable) e.preventDefault();
            const currentDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            scale = Math.max(minScale, Math.min(initialScale * (currentDistance / initialDistance), maxScale));
            img.style.transform = `translate(${img.dataset.tx || 0}px, ${img.dataset.ty || 0}px) scale(${scale})`;
        }
    }, { passive: false });

    const enableDrag = (target) => {
        let isDragging = false, startX = 0, startY = 0;
        target.dataset.tx = target.dataset.tx || 0;
        target.dataset.ty = target.dataset.ty || 0;

        const onMove = (e) => {
            if (!isDragging) return;
            if (e.touches && e.touches.length > 1) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const tx = clientX - startX, ty = clientY - startY;
            if (Math.abs(tx) > 5 || Math.abs(ty) > 5) dragMoved = true;
            target.dataset.tx = tx;
            target.dataset.ty = ty;
            target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            if (e.cancelable) e.preventDefault();
        };

        const onUp = () => {
            isDragging = false;
            target.style.cursor = 'grab';
            doc.removeEventListener('mousemove', onMove);
            doc.removeEventListener('mouseup', onUp);
            doc.removeEventListener('touchmove', onMove);
            doc.removeEventListener('touchend', onUp);
            setTimeout(() => { dragMoved = false; }, 100);
        };

        const onDown = (e) => {
            if (e.touches && e.touches.length > 1) return;
            isDragging = true;
            dragMoved = false;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startX = clientX - parseFloat(target.dataset.tx);
            startY = clientY - parseFloat(target.dataset.ty);
            target.style.cursor = 'grabbing';

            doc.addEventListener('mousemove', onMove, { passive: false });
            doc.addEventListener('mouseup', onUp);
            doc.addEventListener('touchmove', onMove, { passive: false });
            doc.addEventListener('touchend', onUp);
            if (!e.touches && e.cancelable) e.preventDefault();
        };

        target.addEventListener('mousedown', onDown);
        target.addEventListener('touchstart', onDown, { passive: false });
        target.style.cursor = 'grab';
    };

    enableDrag(img);

    const path = store.image_path || (imageUrl.includes('/gallery/') ? ('gallery/' + decodeURIComponent(imageUrl).split('/gallery/')[1]) : '');
    const imagelist = Array.isArray(store.imagelist) ? store.imagelist : [];
    const idx = imagelist.indexOf(path);
    const _cat = path.includes('gallery/') ? path.slice(path.indexOf('gallery/') + 8, Math.max(path.indexOf('gallery/') + 8, path.lastIndexOf('/') + 1)) : '';
    const category = (!_cat || _cat === '') ? '未分类' : _cat;

    const go = (nPath) => {
        if (!nPath) return;
        scale = 1.0;
        img.style.transition = 'none';
        img.dataset.tx = 0;
        img.dataset.ty = 0;
        img.style.transform = 'translate(0px, 0px) scale(1.0)';

        store.image_path = nPath;
        emitEvent('image', null, 'index');
        emitEvent('SYNC_CURRENT', nPath, 'side');
    };

    $('#p').onclick = () => { if (imagelist.length) go(imagelist[(idx - 1 + imagelist.length) % imagelist.length]); };
    $('#n').onclick = () => { if (imagelist.length) go(imagelist[(idx + 1) % imagelist.length]); };
    const jumpInput = mountIndexJumpInput($('#i'), idx, imagelist.length, (targetIdx) => go(imagelist[targetIdx]));
    $('#c').textContent = `[${category}]`;

    const sc = $('.span-container');
    if (store.lightbox_stauts === '1') sc.classList.add('hide');
    $('#f').onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== '1' ? '1' : '0';
        sc.classList.toggle('hide', store.lightbox_stauts === '1');
        emitEvent('lightbox', { status: store.lightbox_stauts }, 'index');
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = win.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;
        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== '1') $('#f').click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === '1') $('#f').click();
        }
    };

    const fsBtn = $('#fs');
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    doc.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    doc.onkeydown = (e) => {
        if (doc.activeElement === jumpInput) return;
        if (e.code === 'Space') { e.preventDefault(); jumpInput.focus(); }
        else if (e.key === 'ArrowLeft') $('#p').click();
        else if (e.key === 'ArrowRight') $('#n').click();
    };

    bindSwipeGestures(doc.body, {
        onLeft: () => $('#n').click(),
        onRight: () => $('#p').click(),
        getScale: () => scale,
        onSnapBack: () => {
            if (scale === 1.0) {
                img.dataset.tx = 0;
                img.dataset.ty = 0;
                img.style.transition = 'transform 0.25s ease-out';
                img.style.transform = 'translate(0px, 0px) scale(1.0)';
                setTimeout(() => { img.style.transition = 'none'; }, 260);
            }
        }
    });

    $$('img').forEach((im) => {
        const pop = () => {
            const name = (im.src.split('/').pop() || '');
            if (name.startsWith('pano_')) {
                win.open('src/tpl/pano.html?src=' + encodeURIComponent(im.src), '_blank');
            }
        };
        im.ondblclick = pop;
        let lastTap = 0;
        im.ontouchend = (e) => {
            const now = Date.now();
            if (now - lastTap < 300) { pop(); e.preventDefault(); }
            lastTap = now;
        };
    });

    const addbgBtn = $('#addbg');
    addbgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
            let config = store.wallpaper_config || {
                list: [],
                currentIndex: 0,
                mode: 'fixed',
                interval: 3600000,
                layout: 'contain'
            };
            const added = !!path && !config.list.includes(path);
            if (added) {
                config.list.push(path);
                store.wallpaper_config = config;
            }
            const origText = addbgBtn.textContent;
            addbgBtn.textContent = added ? '已设为壁纸 ✓' : '已在壁纸列表中';
            setTimeout(() => { addbgBtn.textContent = origText; }, 1000);
        } catch (err) {
            console.error('添加壁纸失败', err);
        }
    });

    setTimeout(() => {
        if (img) img.src = imageUrl;
    }, 40);
}

function mountVideoLogic(win, payload) {
    const { doc, $, store, emitEvent, bindSwipeGestures, mountIndexJumpInput } = attachIframeCommon(win);
    const video = $('#video');
    const track = $('#main-track');
    const videoUrl = (payload && payload.videoUrl) || '';
    const isMkv = videoUrl.toLowerCase().endsWith('.mkv');
    const filename = videoUrl.split('/').pop() || '';
    const basename = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
    const vttUrl = isMkv ? `video/vtt/${basename}.vtt` : '';

    const path = store.video_path || (videoUrl.includes('/video/') ? ('video/' + decodeURIComponent(videoUrl).split('/video/')[1]) : '');
    const videolist = Array.isArray(store.videolist) ? store.videolist : [];
    const idx = videolist.indexOf(path);
    const _cat = path.includes('video/') ? path.slice(path.indexOf('video/') + 6, Math.max(path.indexOf('video/') + 6, path.lastIndexOf('/') + 1)) : '';
    const category = (!_cat || _cat === '') ? '未分类' : _cat;

    const go = (nPath) => {
        if (!nPath) return;
        store.video_path = nPath;
        emitEvent('video', null, 'index');
        emitEvent('SYNC_CURRENT', nPath, 'side');
    };

    $('#p').onclick = () => { if (videolist.length) go(videolist[(idx - 1 + videolist.length) % videolist.length]); };
    $('#n').onclick = () => { if (videolist.length) go(videolist[(idx + 1) % videolist.length]); };
    mountIndexJumpInput($('#i'), idx, videolist.length, (targetIdx) => go(videolist[targetIdx]));
    $('#c').textContent = `[${category}]`;

    const sc = $('.span-container');
    if (store.lightbox_stauts === '1') sc.classList.add('hide');
    $('#f').onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== '1' ? '1' : '0';
        sc.classList.toggle('hide', store.lightbox_stauts === '1');
        emitEvent('lightbox', { status: store.lightbox_stauts }, 'index');
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = win.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;
        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== '1') $('#f').click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === '1') $('#f').click();
        }
    };

    const fsBtn = $('#fs');
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    doc.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    bindSwipeGestures(doc.body, {
        onLeft: () => $('#n').click(),
        onRight: () => $('#p').click()
    });

    video.volume = 0.2;
    if (path) video.dataset.path = path;

    win.addEventListener('pagehide', () => {
        if (win._isBombing || (window.top && window.top._isBombing)) return;
        saveMediaPosition(video);
    });

    let currentOffset = 0;
    const adjustDelay = (seconds) => {
        const textTrack = video.textTracks[0];
        if (!textTrack || !textTrack.cues || textTrack.cues.length === 0) return;
        for (let i = 0; i < textTrack.cues.length; i++) {
            const cue = textTrack.cues[i];
            const dur = Math.max(0, cue.endTime - cue.startTime);
            const nextStart = Math.max(0, cue.startTime + seconds);
            cue.startTime = nextStart;
            cue.endTime = nextStart + dur;
        }
        currentOffset += seconds;
        const di = doc.getElementById('delay-info');
        if (di) di.innerText = `偏移: ${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(1)}s`;
    };
    win.adjustDelay = adjustDelay;

    doc.onkeydown = (e) => {
        if (doc.activeElement && doc.activeElement.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();
        if (key === '[') adjustDelay(-0.5);
        else if (key === ']') adjustDelay(0.5);
        else if (key === 'z') $('#p').click();
        else if (key === 'c') $('#n').click();
        else if (e.key === 'ArrowRight' || key === 'd') video.currentTime += 3;
        else if (e.key === 'ArrowLeft' || key === 'a') video.currentTime -= 3;
        else if (e.key === 'ArrowUp' || key === 'w') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }
        else if (e.key === 'ArrowDown' || key === 's') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
        else if (e.code === 'Space' || key === ' ') {
            if (doc.activeElement === video) return;
            e.preventDefault();
            video.paused ? video.play() : video.pause();
        } else if (key === 'x') {
            doc.fullscreenElement !== video ? video.requestFullscreen() : doc.exitFullscreen();
        }
    };

    setTimeout(() => {
        if (video) {
            video.src = videoUrl;
            if (isMkv && track) track.src = vttUrl;
        }
    }, 60);
}

export function generateDoc(type, payload = {}) {
    const commonStyles = `@charset "UTF-8";@import url("../src/css/font.css");html,body,pre,textarea{font-family:'Noto Serif SC'}html{background-color:#000;touch-action:none;}body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;position:relative;overflow:hidden;touch-action:none;}.span-container{position:absolute;bottom:10px;right:10px;background:plum;z-index:999}.span-container span{margin-bottom:5px;padding:0 10px;cursor:pointer}.hide{opacity:.2!important}#f{display:none}`;
    const baseTag = `<base href="${escapeHtml(window.location.href)}">`;
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'self';">`;
    const viewportMeta = `<meta name="viewport" content="width=1024, viewport-fit=cover" />`;

    if (type === 'image') {
        return (`<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}${cspMeta}${viewportMeta}<style>${commonStyles} img{z-index:1;max-height:100vh;max-width:100vw;visibility:hidden}#loader{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999}.bar-spinner{width:40px;height:40px;position:relative;animation:spin 1s linear infinite}.bar{width:4px;height:20px;background:pink;border-radius:2px;position:absolute;top:10px;left:18px;transform-origin:center bottom}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body>` +
            `<div id="loader"><div class="bar-spinner"><div class="bar"></div></div></div>` +
            `<img id="img">` +
            `<div class="span-container"><span id="addbg">As Wallpaper</span><span id="fs" title="全屏(或按鼠标中键)">[F]</span><span id="c"></span><span id="p">prev</span><span id="i"></span><span id="n">next</span><span id="f"></span></div>` +
            `</body></html>`).trim();
    }

    if (type === 'video') {
        const videoUrl = String((payload && payload.videoUrl) || '');
        const isMkv = videoUrl.toLowerCase().endsWith('.mkv');
        const trackHtml = isMkv ? `<track id="main-track" label="中文" kind="subtitles" srclang="zh" default>` : '';
        const delayUiHtml = isMkv ? `<span id="delay-info" title="按 [ 提前0.5s，按 ] 延后0.5s" style="color:#ffeb3b;margin-right:10px;">偏移: 0.0s</span>` : '';

        return (`<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}${cspMeta}${viewportMeta}<style>${commonStyles} video{max-width:100%;max-height:100%}video::cue{font-size:26px;color:#fff;background:rgba(0,0,0,0.9);text-shadow:2px 2px 4px rgba(0,0,0,0.8);font-family:'Noto Serif SC'}</style></head><body>` +
            `<video id="video" controls loop playsinline>${trackHtml}</video>` +
            `<div class="span-container">${delayUiHtml}<span id="fs" title="全屏(或按鼠标中键)">[F]</span><span id="c"></span><span id="p">prev</span><span id="i"></span><span id="n">next</span><span id="f"></span></div>` +
            `</body></html>`).trim();
    }

    return '';
}

export function renderLightboxFrame(iframe, type, payload) {
    if (!iframe || !iframe.contentWindow) return;
    const win = iframe.contentWindow;
    const doc = win.document;
    const html = generateDoc(type, payload);
    doc.open();
    doc.write(html);
    doc.close();
    if (type === 'image') mountImageLogic(win, payload);
    else if (type === 'video') mountVideoLogic(win, payload);
}
