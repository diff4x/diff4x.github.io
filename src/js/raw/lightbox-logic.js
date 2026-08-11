/**
 * lightbox-logic.js
 * 图片/视频灯箱弹出层内的交互逻辑。
 * 仅在用户点开图片或视频时，被 index.js 的 generateDoc() 动态 import，
 * 通过 iframeCommonLogic.toString()/imageLogic.toString()/videoLogic.toString()
 * 注入生成的 <iframe> 文档里执行。三者互不依赖外部闭包变量，可安全序列化。
 */
export const iframeCommonLogic = function () {
    window.$ = (s) => document.querySelector(s);
    window.$$ = (s) => document.querySelectorAll(s);
    window.createStore = function (defaults = {}) {
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
    };
    window.childId = 'content';

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
    window.emitEvent = function (type, payload, target = '*') {
        BUS.postMessage({
            type,
            payload,
            from: ctxId,
            target
        });
    }

    if (window.top && window.top.VirtualCursor) {
        window.top.VirtualCursor.attach(window);
    }

    BUS.addEventListener('message', (e) => {
        const { type, payload, target } = e.data || {};
        if (target !== '*' && target !== ctxId) return;
        if (type === 'SIM_POINTER') {
            window.handleSimPointer(payload);
        }
    });

    window.bindSwipeGestures = function (element, callbacks, thresholdPercent = 0.15) {
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

            const currentScale = callbacks.getScale ? callbacks.getScale() : 1.0;
            if (currentScale > 1.05) return;

            if (e.changedTouches.length !== 1) return;
            const deltaX = e.changedTouches[0].clientX - startX;
            const deltaY = e.changedTouches[0].clientY - startY;

            const dynamicThreshold = Math.min(window.innerWidth, window.innerHeight) * thresholdPercent;

            if (Math.abs(deltaX) > dynamicThreshold || Math.abs(deltaY) > dynamicThreshold) {
                if (Math.abs(deltaX) > Math.abs(deltaY)) {
                    if (deltaX > 0 && callbacks.onRight) callbacks.onRight();
                    else if (deltaX < 0 && callbacks.onLeft) callbacks.onLeft();
                } else {
                    if (callbacks.onVertical) callbacks.onVertical();
                }
            } else {
                if (callbacks.onSnapBack) callbacks.onSnapBack();
            }
        });
    };
};

export const imageLogic = function () {
    const store = createStore({ lightbox_stauts: "0" });
    const img = $('#img');
    const loader = $('#loader');

    if (img.src.split("/").pop().startsWith("pano_")) {
        img.style.border = "2px red solid";
        img.title = "双击进入全景";
    } else {
        img.style.border = "none";
        img.title = "";
    }

    let scale = 1.0;
    const maxScale = 10.0;
    const minScale = 0.5;
    const scaleStep = 0.1;
    let dragMoved = false;

    img.addEventListener('wheel', e => {
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
        if (e.touches.length === 2) {
            if (e.cancelable) e.preventDefault();
            const currentDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            scale = initialScale * (currentDistance / initialDistance);
            scale = Math.max(minScale, Math.min(scale, maxScale));
            img.style.transform = `translate(${img.dataset.tx}px, ${img.dataset.ty}px) scale(${scale})`;
        }
    }, { passive: false });

    function enableDrag(target) {
        let isDragging = false, startX = 0, startY = 0;
        target.dataset.tx = target.dataset.tx || 0;
        target.dataset.ty = target.dataset.ty || 0;

        const onMove = (e) => {
            if (!isDragging) return;
            if (e.touches && e.touches.length > 1) return;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const tx = clientX - startX, ty = clientY - startY;

            if (Math.abs(tx) > 5 || Math.abs(ty) > 5) {
                dragMoved = true;
            }

            target.dataset.tx = tx; target.dataset.ty = ty;
            target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            if (e.cancelable) e.preventDefault();
        };

        const onUp = () => {
            isDragging = false; target.style.cursor = "grab";
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
    };

    enableDrag(img);

    const path = store.image_path || ("gallery/" + decodeURIComponent(img.src).split("/gallery/")[1]);
    const imagelist = store.imagelist || [];
    const idx = imagelist.indexOf(path);
    const _cat = path.split(path.split("/").pop())[0].split("gallery/")[1];
    const category = (!_cat || _cat === "") ? "未分类" : _cat;

    const go = (nPath) => {
        scale = 1.0;
        img.style.transition = "none";
        img.dataset.tx = 0; img.dataset.ty = 0;
        img.style.transform = `translate(0px, 0px) scale(1.0)`;

        store.image_path = nPath;
        emitEvent("image", null, "index");
        emitEvent("image", "#gallery a", "side");
    };

    $("#p").onclick = () => go(imagelist[(idx - 1 + imagelist.length) % imagelist.length]);
    $("#n").onclick = () => go(imagelist[(idx + 1) % imagelist.length]);
    $("#i").innerHTML = `${idx + 1}/${imagelist.length}<input style='width:60px' id='jump' onclick='select(this)'>`;
    $("#c").innerHTML = `[${category}]`;

    const sc = $(".span-container");
    if (store.lightbox_stauts === "1") sc.classList.add("hide");
    $("#f").onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== "1" ? "1" : "0";
        store.lightbox_stauts === "1" ? sc.classList.add("hide") : sc.classList.remove("hide");
        emitEvent("lightbox", { status: store.lightbox_stauts }, "index")
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = window.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;

        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== "1") $("#f").click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === "1") $("#f").click();
        }
    };

    const fsBtn = $("#fs");
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    $("#jump").onkeypress = (e) => {
        if (e.keyCode === 13) {
            e.preventDefault();
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0 && val <= imagelist.length) go(imagelist[val - 1]);
        }
    };

    document.onkeydown = e => {
        if (e.code === 'Space') { e.preventDefault(); $('#jump').focus(); }
        else if (e.key === 'ArrowLeft') $("#p").click();
        else if (e.key === 'ArrowRight') $("#n").click();
    };

    if (window.bindSwipeGestures) {
        window.bindSwipeGestures(document.body, {
            onLeft: () => $("#n").click(),
            onRight: () => $("#p").click(),
            getScale: () => scale,
            onSnapBack: () => {
                if (scale === 1.0) {
                    img.dataset.tx = 0;
                    img.dataset.ty = 0;
                    img.style.transition = "transform 0.25s ease-out";
                    img.style.transform = `translate(0px, 0px) scale(1.0)`;
                    setTimeout(() => img.style.transition = "none", 260);
                }
            }
        });
    }

    $$("img").forEach(im => {
        const pop = () => { if (im.src.split("/").pop().startsWith("pano_")) window.open("src/tpl/pano.html?src=" + im.src, "_blank"); };
        im.ondblclick = pop;
        let lastTap = 0;
        im.ontouchend = (e) => { const now = Date.now(); if (now - lastTap < 300) { pop(); e.preventDefault(); } lastTap = now; };
    });

    $("#addbg").addEventListener('click', (e) => {
        e.stopPropagation();
        try {
            let config = store.wallpaper_config || {
                list: [],
                currentIndex: 0,
                mode: 'fixed',
                interval: 3600000,
                layout: 'contain'
            };

            if (!config.list.includes(path)) {
                config.list.push(path);
                store.wallpaper_config = config;
            }
        } catch (err) {
            console.error("添加壁纸失败", err);
        }
    });
};

export const videoLogic = function () {
    const store = createStore({ lightbox_stauts: "0" });
    const video = $('#video');
    const path = store.video_path || ("video/" + decodeURIComponent($('#source').src).split("/video/")[1]);
    const videolist = store.videolist || [];
    const idx = videolist.indexOf(path);
    const _cat = path.split(path.split("/").pop())[0].split("video/")[1];
    const category = (!_cat || _cat === "") ? "未分类" : _cat;
    const go = (nPath) => {
        store.video_path = nPath;
        emitEvent("video", null, "index");
        emitEvent("video", "#video a", "side");
    };

    $("#p").onclick = () => go(videolist[(idx - 1 + videolist.length) % videolist.length]);
    $("#n").onclick = () => go(videolist[(idx + 1) % videolist.length]);
    $("#i").innerHTML = `${idx + 1}/${videolist.length}<input style='width:60px' id='jump' onclick='select(this)'>`;
    $("#c").innerHTML = `[${category}]`;

    const sc = $(".span-container");
    if (store.lightbox_stauts === "1") sc.classList.add("hide");
    $("#f").onclick = () => {
        store.lightbox_stauts = store.lightbox_stauts !== "1" ? "1" : "0";
        store.lightbox_stauts === "1" ? sc.classList.add("hide") : sc.classList.remove("hide");
        emitEvent("lightbox", { status: store.lightbox_stauts }, "index");
    };

    const toggleFullscreen = (e) => {
        if (e) e.preventDefault();
        const parentDoc = window.parent.document;
        const isFullscreen = !!parentDoc.fullscreenElement;

        if (!isFullscreen) {
            parentDoc.documentElement.requestFullscreen().catch(err => console.warn(err));
            if (store.lightbox_stauts !== "1") $("#f").click();
        } else {
            if (parentDoc.exitFullscreen) parentDoc.exitFullscreen();
            if (store.lightbox_stauts === "1") $("#f").click();
        }
    };

    const fsBtn = $("#fs");
    if (fsBtn) fsBtn.onclick = toggleFullscreen;

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1) toggleFullscreen(e);
    });

    if (window.bindSwipeGestures) {
        window.bindSwipeGestures(document.body, { onLeft: () => $("#n").click(), onRight: () => $("#p").click() });
    }

    $("#jump").onkeypress = (e) => {
        if (e.keyCode === 13) {
            e.preventDefault();
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0 && val <= videolist.length) go(videolist[val - 1]);
        }
    };

    video.volume = 0.2;
    let currentOffset = 0;
    window.adjustDelay = function (seconds) {
        const track = video.textTracks[0];
        if (!track || !track.cues || track.cues.length === 0) return;
        for (let i = 0; i < track.cues.length; i++) {
            track.cues[i].startTime += seconds;
            track.cues[i].endTime += seconds;
        }
        currentOffset += seconds;
        const di = document.getElementById('delay-info');
        if (di) di.innerText = `偏移: ${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(1)}s`;
    };

    document.onkeydown = e => {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();
        if (key === '[') adjustDelay(-0.5);
        else if (key === ']') adjustDelay(0.5);
        else if (key === 'z') $("#p").click();
        else if (key === 'c') $("#n").click();
        else if (e.key === 'ArrowRight' || key === 'd') video.currentTime += 3;
        else if (e.key === 'ArrowLeft' || key === 'a') video.currentTime -= 3;
        else if (e.key === 'ArrowUp' || key === 'w') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }
        else if (e.key === 'ArrowDown' || key === 's') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }
        else if (e.code === 'Space' || key === ' ') {
            if (document.activeElement === video) return;
            e.preventDefault();
            video.paused ? video.play() : video.pause();
        } else if (key === 'x') {
            document.fullscreenElement !== video ? video.requestFullscreen() : document.exitFullscreen();
        }
    };
};

