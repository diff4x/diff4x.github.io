/**
 * touchpad.js —— 移动端"模拟鼠标/触控板"交互层。
 * 只有触屏设备(isMobile)才需要，桌面端用户完全不下载这份代码。
 * 由 index.js 在检测到触屏后动态 import 并调用 initTouchpad(ctx)，
 * ctx = { emitEvent } 用于向 #content / #side 两个 iframe 转发模拟指针事件。
 */
export function initTouchpad(ctx) {
    'use strict';
    const isMobile = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isMobile) return;


    const TAP_MOVE_THRESHOLD = 8;
    const DOUBLE_TAP_WINDOW = 300;
    const DOUBLE_TAP_DIST = 30;
    const MOVE_SENSITIVITY = 1.1;
    const MIN_ZOOM = 1, MAX_ZOOM = 3;
    const STAGE_RESIZE_MS = 200;        // 略大于 index.css 中 #stage 高度过渡(.18s)
    const TOGGLE_POS_KEY = 'tp-toggle-pos';
    const TOGGLE_DRAG_THRESHOLD = 6;    // 位移超过该值才算"拖动",否则视为点按
    const TOGGLE_EDGE_GAP = 4;

    document.body.classList.add('touchpad-active');

    const stage = document.getElementById('stage');
    const contentFrame = document.getElementById('content');
    const sideFrame = document.getElementById('side');
    if (!stage || !contentFrame) return;

    stage.style.transformOrigin = '0 0';

    const panel = document.getElementById('touchpad-panel') || (() => {
        const p = document.createElement('div');
        p.id = 'touchpad-panel';
        document.body.appendChild(p);
        return p;
    })();

    panel.innerHTML = `
    <div class="tp-col-scroll" style="width: 15%; min-width: 50px; display: flex; flex-direction: column;">
        <div class="tp-btn tp-scroll-btn" data-scroll="-160" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:var(--tp-accent); font-weight:bold;">▲</div>
        <div class="tp-btn tp-scroll-btn" data-scroll="160" style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--tp-accent); font-weight:bold;">▼</div>
    </div>
    <div class="tp-col-move" style="touch-action: none;"></div>
    <div class="tp-col-zoom" style="width: 15%; min-width: 50px; display: flex; flex-direction: column; border-right: 1px solid var(--tp-line); border-left: 1px solid var(--tp-line);">
        <div class="tp-btn" data-btn="zoom_in" style="flex:1; font-size:18px!important; font-weight:bold; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">+</div>
        <div class="tp-btn" data-btn="zoom_out" style="flex:1; font-size:18px!important; font-weight:bold; display:flex; align-items:center; justify-content:center; color:#cfd3dc;">-</div>
    </div>
    <div class="tp-col-buttons" style="width: 20%; min-width: 64px; display: flex; flex-direction: column;">
        <div class="tp-btn" data-btn="select_toggle" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">框选</div>
        <div class="tp-btn" data-btn="drag_toggle" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">拖拽</div>
        <div class="tp-btn" data-btn="dblclick" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">左双击</div>
        <div class="tp-btn" data-btn="auxclick" style="flex:1; border-bottom: 1px solid var(--tp-line); display:flex; align-items:center; justify-content:center; color:#cfd3dc;">中击</div>
        <div class="tp-btn" data-btn="contextmenu" style="flex:1; display:flex; align-items:center; justify-content:center; color:#cfd3dc;">右击</div>
        <div class="tp-slot" aria-hidden="true" style="flex:1; border-top: 1px solid var(--tp-line); pointer-events:none;"></div>
    </div>
    `;

    const colMove = panel.querySelector('.tp-col-move');
    const btns = panel.querySelectorAll('[data-btn]');

    const cursorEl = document.createElement('div');
    cursorEl.id = 'tp-cursor';
    document.body.appendChild(cursorEl);

    const cursor = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    let zoom = 1, panX = 0, panY = 0;
    let currentTargetId = null;
    let isSelectMode = false;
    let cursorFeedbackTimer = null;

    function playCursorClickFeedback() {
        if (!cursorEl) return;
        cursorEl.classList.remove('tp-cursor-click', 'tp-cursor-down');
        void cursorEl.offsetWidth; // force reflow so animation restarts
        cursorEl.classList.add('tp-cursor-down');
        clearTimeout(cursorFeedbackTimer);
        cursorFeedbackTimer = setTimeout(() => {
            cursorEl.classList.remove('tp-cursor-down');
            cursorEl.classList.add('tp-cursor-click');
            setTimeout(() => cursorEl.classList.remove('tp-cursor-click'), 340);
        }, 90);
    }

    function applyTransform() {
        const transformStr = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        stage.style.transformOrigin = '0 0';
        stage.style.transform = transformStr;
    }

    function doZoom(delta) {
        const oldZoom = zoom;
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
        window._tpZoom = zoom;
        if (zoom === oldZoom) return;

        panX = (window.innerWidth / 2) - cursor.x * zoom;
        panY = (stage.clientHeight / 2) - cursor.y * zoom;

        clampPan();
        applyTransform();
        updateCursorVisual();
    }

    function clampCursor() {
        cursor.x = Math.max(0, Math.min(stage.clientWidth - 1, cursor.x));
        cursor.y = Math.max(0, Math.min(stage.clientHeight - 1, cursor.y));
    }

    function clampPan() {
        const vw = window.innerWidth, vh = stage.clientHeight;
        const scaledW = stage.clientWidth * zoom;
        const scaledH = stage.clientHeight * zoom;
        const minPanX = Math.min(0, vw - scaledW);
        const minPanY = Math.min(0, vh - scaledH);
        panX = Math.max(minPanX, Math.min(0, panX));
        panY = Math.max(minPanY, Math.min(0, panY));
    }

    function logicalToScreen(lx, ly) {
        const r = stage.getBoundingClientRect();
        return { x: r.left + lx * zoom, y: r.top + ly * zoom };
    }

    function updateCursorVisual() {
        const p = logicalToScreen(cursor.x, cursor.y);
        cursorEl.style.left = p.x + 'px';
        cursorEl.style.top = p.y + 'px';
    }

    function resolveHit(lx, ly) {
        const s = logicalToScreen(lx, ly);
        // elementFromPoint() returns null for points on/outside the viewport boundary.
        // Clamp defensively so an edge-pinned cursor still resolves to the element under it.
        const px = Math.max(0, Math.min(window.innerWidth - 1, s.x));
        const py = Math.max(0, Math.min(document.documentElement.clientHeight - 1, s.y));
        const topEl = document.elementFromPoint(px, py);
        if (!topEl) return { kind: 'none' };

        if (topEl === contentFrame) {
            return { kind: 'frame', id: 'content', x: lx - contentFrame.offsetLeft, y: ly - contentFrame.offsetTop };
        }
        if (sideFrame && topEl === sideFrame) {
            return { kind: 'frame', id: 'side', x: lx - sideFrame.offsetLeft, y: ly - sideFrame.offsetTop };
        }
        return { kind: 'local', el: topEl, screenX: s.x, screenY: s.y };
    }

    function sendToFrame(frameId, op, x, y, extra) {
        const payload = Object.assign({ op, x, y }, extra);
        try {
            if (frameId === 'content' && contentFrame.contentWindow && contentFrame.contentWindow.handleSimPointer) {
                contentFrame.contentWindow.handleSimPointer(payload);
            } else if (frameId === 'side' && sideFrame.contentWindow && sideFrame.contentWindow.handleSimPointer) {
                sideFrame.contentWindow.handleSimPointer(payload);
            } else {
                ctx.emitEvent('SIM_POINTER', payload, frameId);
            }
        } catch (e) {
            ctx.emitEvent('SIM_POINTER', payload, frameId);
        }
    }

    let localHoverEl = null;
    function getAncestors(el) {
        const chain = [];
        let cur = el;
        while (cur) { chain.push(cur); cur = cur.parentElement; }
        return chain;
    }
    const FOCUSABLE_SEL = 'input,textarea,select,[contenteditable],[contenteditable="true"]';
    function maybeFocus(el) {
        if (!el || typeof el.focus !== 'function') return;
        if ((el.matches && el.matches(FOCUSABLE_SEL)) || el.tabIndex >= 0) {
            el.focus({ preventScroll: true });
        }
    }

    function updateLocalHover(newEl, base) {
        if (newEl === localHoverEl) return;
        const oldChain = localHoverEl ? getAncestors(localHoverEl) : [];
        const newChain = getAncestors(newEl);
        const oldSet = new Set(oldChain);
        let common = null;
        for (const el of newChain) { if (oldSet.has(el)) { common = el; break; } }

        if (localHoverEl) {
            localHoverEl.dispatchEvent(new MouseEvent('mouseout', Object.assign({}, base, { relatedTarget: newEl })));
            for (const el of oldChain) {
                if (el === common) break;
                el.dispatchEvent(new MouseEvent('mouseleave', Object.assign({}, base, { bubbles: false, relatedTarget: newEl })));
            }
        }
        newEl.dispatchEvent(new MouseEvent('mouseover', Object.assign({}, base, { relatedTarget: localHoverEl || null })));
        const toEnter = [];
        for (const el of newChain) { if (el === common) break; toEnter.push(el); }
        toEnter.reverse().forEach(el => {
            el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, base, { bubbles: false, relatedTarget: localHoverEl || null })));
        });
        localHoverEl = newEl;
    }

    function clearLocalHover() {
        if (!localHoverEl) return;
        const chain = getAncestors(localHoverEl);
        localHoverEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: null }));
        chain.forEach(a => {
            a.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, relatedTarget: null }));
        });
        localHoverEl = null;
    }

    function dispatchLocal(op, el, screenX, screenY, extra) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: screenX, clientY: screenY };
        const fire = (type, opts) => el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, opts)));
        switch (op) {
            case 'move':
                updateLocalHover(el, base);
                fire('mousemove', { button: 0 });
                break;
            case 'click':
                fire('mousedown', { button: 0 });
                maybeFocus(el);
                fire('mouseup', { button: 0 });
                fire('click', { button: 0 });
                setTimeout(() => routeOp('move'), 50);
                if (el.tagName && el.tagName.toUpperCase() === 'OPTION') {
                    const selectEl = el.closest('select');
                    if (selectEl) {
                        selectEl.value = el.value;
                        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                        selectEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    }
                }

                if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                    if (el.paused) el.play().catch(() => { });
                    else el.pause();
                }
                break;
            case 'dblclick':
                fire('mousedown', { button: 0 }); maybeFocus(el); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                fire('mousedown', { button: 0 }); fire('mouseup', { button: 0 }); fire('click', { button: 0 });
                fire('dblclick', { button: 0 });
                break;
            case 'auxclick':
                fire('mousedown', { button: 1 }); fire('mouseup', { button: 1 }); fire('auxclick', { button: 1 });
                break;
            case 'contextmenu':
                fire('contextmenu', { button: 2 });
                setTimeout(() => routeOp('move'), 50);
                break;
            case 'wheel': {
                const deltaY = (extra && extra.deltaY) || 0;
                el.dispatchEvent(new WheelEvent('wheel', Object.assign({}, base, { deltaY, deltaMode: 0 })));
                let scrollTarget = el;
                let found = false;
                while (scrollTarget && scrollTarget !== document.body && scrollTarget !== document.documentElement) {
                    const style = window.getComputedStyle(scrollTarget);
                    const isListbox = scrollTarget.tagName === 'SELECT';
                    const overflowsY = scrollTarget.scrollHeight > scrollTarget.clientHeight;
                    const scrollableY = overflowsY && (isListbox ||
                        style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay');
                    if (scrollableY) { found = true; break; }
                    scrollTarget = scrollTarget.parentElement;
                }

                if (found) {
                    const atTop = scrollTarget.scrollTop <= 0;
                    const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 1;
                    if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
                        found = false; // this scroll unit is exhausted in this direction, hand off
                    } else {
                        scrollTarget.scrollBy({ top: deltaY, behavior: 'auto' });
                    }
                }

                if (!found) {
                    sendToFrame('content', 'wheel', 0, 0, { deltaY });
                }
                break;
            }
            case 'drag_start':
                fire('mousedown', { button: 0 });
                break;
            case 'drag_end':
                fire('mouseup', { button: 0 });
                break;
        }
    }

    function routeOp(op, extra) {
        const hit = resolveHit(cursor.x, cursor.y);
        const targetId = hit.kind === 'frame' ? hit.id : (hit.kind === 'local' ? 'index' : null);

        if (targetId !== currentTargetId) {
            if (currentTargetId === 'index') clearLocalHover();
            else if (currentTargetId) sendToFrame(currentTargetId, 'leave', 0, 0, {});

            if (hit.kind === 'frame') sendToFrame(hit.id, 'enter', hit.x, hit.y, {});
            currentTargetId = targetId;
        }

        if (hit.kind === 'frame') {
            sendToFrame(hit.id, op, hit.x, hit.y, extra);
        } else if (hit.kind === 'local') {
            dispatchLocal(op, hit.el, hit.screenX, hit.screenY, extra || {});
        }
    }

    const EDGE_ZONE = 0.15;
    const EDGE_MAX_MULT = 4;

    function edgeAccelFactor(pos, max) {
        const zone = max * EDGE_ZONE;
        if (zone <= 0) return 1;
        if (pos < zone) return 1 + (1 - pos / zone) * (EDGE_MAX_MULT - 1);
        if (pos > max - zone) return 1 + (1 - (max - pos) / zone) * (EDGE_MAX_MULT - 1);
        return 1;
    }

    function sendOverflowWheel(overflowX, overflowY) {
        if (Math.abs(overflowX) <= 0.1 && Math.abs(overflowY) <= 0.1) return;
        const mult = Math.max(edgeAccelFactor(cursor.x, stage.clientWidth), edgeAccelFactor(cursor.y, stage.clientHeight));
        routeOp('wheel', {
            deltaX: overflowX * zoom / MOVE_SENSITIVITY * mult,
            deltaY: overflowY * zoom / MOVE_SENSITIVITY * mult
        });
    }

    const activePointers = new Map();
    let moveState = null;
    let pendingTap = null;
    let edgeHoldRaf = null;

    function edgeHoldLoop() {
        edgeHoldRaf = null;
        if (!moveState || !moveState.moved) return;

        const nearLeft = cursor.x < stage.clientWidth * EDGE_ZONE;
        const nearRight = cursor.x > stage.clientWidth * (1 - EDGE_ZONE);
        const nearTop = cursor.y < stage.clientHeight * EDGE_ZONE;
        const nearBottom = cursor.y > stage.clientHeight * (1 - EDGE_ZONE);

        if (nearLeft || nearRight || nearTop || nearBottom) {
            const multX = Math.max(edgeAccelFactor(cursor.x, stage.clientWidth), 1);
            const multY = Math.max(edgeAccelFactor(cursor.y, stage.clientHeight), 1);
            const BASE_HOLD_SPEED = 6; // logical px per frame at full acceleration
            const dx = (nearLeft ? -1 : nearRight ? 1 : 0) * BASE_HOLD_SPEED * (multX - 1);
            const dy = (nearTop ? -1 : nearBottom ? 1 : 0) * BASE_HOLD_SPEED * (multY - 1);
            if (dx || dy) {
                routeOp('wheel', { deltaX: dx * zoom, deltaY: dy * zoom });
            }
        }
        edgeHoldRaf = requestAnimationFrame(edgeHoldLoop);
    }

    colMove.addEventListener('pointerdown', (e) => {
        colMove.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 1) {
            moveState = {
                pointerId: e.pointerId,
                startX: e.clientX, startY: e.clientY,
                lastX: e.clientX, lastY: e.clientY,
                lastTime: performance.now(),
                moved: false,
            };

            if (isSelectMode) routeOp('select_start');
            if (!edgeHoldRaf) edgeHoldRaf = requestAnimationFrame(edgeHoldLoop);
        }
    });

    colMove.addEventListener('pointermove', (e) => {
        e.preventDefault();
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (moveState && e.pointerId === moveState.pointerId) {
            const now = performance.now();
            const dt = Math.max(1, now - moveState.lastTime);
            moveState.lastTime = now;

            const dx = e.clientX - moveState.lastX;
            const dy = e.clientY - moveState.lastY;
            moveState.lastX = e.clientX; moveState.lastY = e.clientY;

            const totalMoved = Math.hypot(e.clientX - moveState.startX, e.clientY - moveState.startY);
            if (totalMoved > TAP_MOVE_THRESHOLD) moveState.moved = true;

            if (moveState.moved) {
                const velocity = Math.hypot(dx, dy) / dt;

                const BASE_SENSITIVITY = 1.15;
                const ACCEL_THRESHOLD = 0.5;
                const ACCEL_FACTOR = 2.0;
                const MAX_SENSITIVITY = 5.0;

                let dynamicSensitivity = BASE_SENSITIVITY;
                if (velocity > ACCEL_THRESHOLD) {
                    dynamicSensitivity += (velocity - ACCEL_THRESHOLD) * ACCEL_FACTOR;
                }
                dynamicSensitivity = Math.min(dynamicSensitivity, MAX_SENSITIVITY);

                let logicalDx = (dx / zoom) * dynamicSensitivity;
                let logicalDy = (dy / zoom) * dynamicSensitivity;


                let oldCursorX = cursor.x;
                let oldCursorY = cursor.y;

                if (Math.abs(logicalDx) >= 0.1) {
                    let hit = resolveHit(cursor.x, cursor.y);
                    let target = null;
                    let win = window;

                    if (hit.kind === 'frame') {
                        let frameWin = hit.id === 'content' ? contentFrame.contentWindow : (hit.id === 'side' ? sideFrame.contentWindow : null);
                        if (frameWin) {
                            win = frameWin;
                            let safeX = Math.max(0, Math.min(win.document.documentElement.clientWidth - 1, hit.x));
                            let safeY = Math.max(0, Math.min(win.document.documentElement.clientHeight - 1, hit.y));
                            target = win.document.elementFromPoint(safeX, safeY);
                        }
                    } else if (hit.kind === 'local') {
                        target = hit.el;
                    }

                    if (target) {
                        let unconsumedX = logicalDx;
                        let scrollTarget = target;

                        while (scrollTarget) {
                            const isDoc = scrollTarget === win.document.documentElement;
                            const isBody = scrollTarget === win.document.body;
                            const isRoot = isDoc || isBody;
                            const style = win.getComputedStyle(scrollTarget);

                            let canScrollX = false;
                            if (isDoc || isBody) {
                                canScrollX = scrollTarget.scrollWidth > scrollTarget.clientWidth;
                            } else {
                                canScrollX = (scrollTarget.scrollWidth > scrollTarget.clientWidth) &&
                                    (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay');
                            }

                            if (canScrollX) {
                                let availableX = unconsumedX > 0
                                    ? Math.ceil(scrollTarget.scrollWidth - scrollTarget.scrollLeft - scrollTarget.clientWidth)
                                    : scrollTarget.scrollLeft;

                                if (availableX > 0) {
                                    let consume = Math.sign(unconsumedX) * Math.min(Math.abs(unconsumedX), availableX);
                                    const before = scrollTarget.scrollLeft;
                                    scrollTarget.scrollLeft += consume;
                                    const actualDelta = scrollTarget.scrollLeft - before;
                                    unconsumedX -= actualDelta;
                                }
                            }
                            if (Math.abs(unconsumedX) < 0.1) break;

                            if (isBody) { scrollTarget = win.document.documentElement; continue; }
                            if (isDoc) break;
                            scrollTarget = scrollTarget.parentElement;
                        }
                        logicalDx = unconsumedX;
                    }
                }

                cursor.x += logicalDx;
                cursor.y += logicalDy;
                clampCursor();

                let overflowX = (oldCursorX + logicalDx) - cursor.x;
                let overflowY = (oldCursorY + logicalDy) - cursor.y;

                panX = (window.innerWidth / 2) - cursor.x * zoom;
                panY = (stage.clientHeight / 2) - cursor.y * zoom;
                clampPan();

                applyTransform();
                updateCursorVisual();
                routeOp(isSelectMode ? 'select_move' : 'move');

                sendOverflowWheel(overflowX, overflowY);
            }
        }
    });

    function endPointer(e) {
        const wasSingle = activePointers.size === 1;
        activePointers.delete(e.pointerId);

        if (wasSingle && edgeHoldRaf) {
            cancelAnimationFrame(edgeHoldRaf);
            edgeHoldRaf = null;
        }

        if (wasSingle && moveState && e.pointerId === moveState.pointerId) {
            if (isSelectMode && moveState.moved) {
                routeOp('select_end');
            } else if (!moveState.moved) {
                const now = Date.now();
                if (pendingTap &&
                    now - pendingTap.time < DOUBLE_TAP_WINDOW &&
                    Math.hypot(e.clientX - pendingTap.x, e.clientY - pendingTap.y) < DOUBLE_TAP_DIST) {
                    clearTimeout(pendingTap.timer);
                    pendingTap = null;
                    playCursorClickFeedback();
                    routeOp('dblclick');
                } else {
                    if (pendingTap) clearTimeout(pendingTap.timer);
                    const tap = { time: now, x: e.clientX, y: e.clientY };
                    tap.timer = setTimeout(() => {
                        playCursorClickFeedback();
                        routeOp('click');
                        pendingTap = null;
                    }, DOUBLE_TAP_WINDOW);
                    pendingTap = tap;
                }
            }
            moveState = null;
        }
    }
    colMove.addEventListener('pointerup', endPointer);
    colMove.addEventListener('pointercancel', endPointer);

    let isDragMode = false;

    btns.forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (btn.dataset.btn !== 'drag_toggle') btn.classList.add('tp-active');
        });

        btn.addEventListener('pointerup', () => {
            const act = btn.dataset.btn;

            if (act === 'drag_toggle') {
                isDragMode = !isDragMode;
                btn.classList.toggle('tp-active', isDragMode);
                routeOp(isDragMode ? 'drag_start' : 'drag_end');
                return;
            }
            if (act === 'zoom_in') {
                doZoom(0.25);
                btn.classList.remove('tp-active');
                return;
            }
            if (act === 'zoom_out') {
                doZoom(-0.25);
                btn.classList.remove('tp-active');
                return;
            }
            if (act === 'select_toggle') {
                isSelectMode = !isSelectMode;
                btn.classList.toggle('tp-active', isSelectMode);
                cursorEl.classList.toggle('tp-cursor-text', isSelectMode);
                return;
            }

            btn.classList.remove('tp-active');
            if (act === 'dblclick' || act === 'auxclick' || act === 'contextmenu') {
                playCursorClickFeedback();
            }
            routeOp(act);
        });

        const release = () => {
            if (btn.dataset.btn !== 'drag_toggle') btn.classList.remove('tp-active');
        };
        btn.addEventListener('pointercancel', release);
    });

    panel.querySelectorAll('.tp-scroll-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.classList.add('tp-active');
            routeOp('wheel', { deltaY: parseInt(btn.dataset.scroll, 10) });
        });
        const release = () => btn.classList.remove('tp-active');
        btn.addEventListener('pointerup', release);
        btn.addEventListener('pointercancel', release);
    });

    panX = (window.innerWidth / 2) - cursor.x * zoom;
    panY = (stage.clientHeight / 2) - cursor.y * zoom;
    clampPan();

    applyTransform();
    updateCursorVisual();

    /* ==========================================================================
     * 收起 / 展开按钮
     * - 点按:收起/展开触控板(收起后 #stage 占满整屏)
     * - 按住拖动:只能在触控板原本占据的范围内移动,松手后固定并记住位置,
     *   用来避开右下角的更新条幅
     * ========================================================================== */
    const slot = panel.querySelector('.tp-slot');

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'tp-toggle';
    toggleBtn.type = 'button';
    toggleBtn.textContent = '收起';
    toggleBtn.setAttribute('aria-label', '收起/展开触控板');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(toggleBtn);

    let isCollapsed = false;
    let syncTimer = null;
    let toggleDrag = null;

    // 触控板原本占据的矩形。收起时面板只是移出屏幕(offsetHeight 不受 transform 影响),范围依然有效
    function getToggleRange() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const padBottom = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
        return { left: 0, top: vh - panel.offsetHeight, right: vw, bottom: vh - padBottom };
    }

    function clampToggle(left, top) {
        const r = getToggleRange();
        const w = toggleBtn.offsetWidth, h = toggleBtn.offsetHeight;
        return {
            left: Math.max(r.left, Math.min(r.right - w, left)),
            top: Math.max(r.top, Math.min(r.bottom - h, top)),
        };
    }

    // 位置以"占可移动范围的比例"保存,横竖屏/窗口尺寸变化后仍落在触控板范围内
    function toRatio(left, top) {
        const r = getToggleRange();
        const spanX = r.right - r.left - toggleBtn.offsetWidth;
        const spanY = r.bottom - r.top - toggleBtn.offsetHeight;
        return {
            fx: spanX > 0 ? Math.max(0, Math.min(1, (left - r.left) / spanX)) : 1,
            fy: spanY > 0 ? Math.max(0, Math.min(1, (top - r.top) / spanY)) : 1,
        };
    }

    let togglePos = null;
    try {
        const saved = JSON.parse(localStorage.getItem(TOGGLE_POS_KEY));
        if (saved && typeof saved.fx === 'number' && typeof saved.fy === 'number' &&
            isFinite(saved.fx) && isFinite(saved.fy)) {
            togglePos = { fx: Math.max(0, Math.min(1, saved.fx)), fy: Math.max(0, Math.min(1, saved.fy)) };
        }
    } catch (e) { }

    if (!togglePos) {
        // 默认停在原"日志"按钮的位置(右列最下方的预留格)
        const r = getToggleRange();
        const w = toggleBtn.offsetWidth, h = toggleBtn.offsetHeight;
        let left = r.right - w - TOGGLE_EDGE_GAP;
        let top = r.bottom - h - TOGGLE_EDGE_GAP;
        const s = slot && slot.getBoundingClientRect();
        if (s && s.width > 0 && s.height > 0) {
            left = s.left + (s.width - w) / 2;
            top = s.top + (s.height - h) / 2;
        }
        const c = clampToggle(left, top);
        togglePos = toRatio(c.left, c.top);
    }

    function placeToggle(left, top) {
        toggleBtn.style.left = left + 'px';
        toggleBtn.style.top = top + 'px';
    }

    function applyTogglePos() {
        const r = getToggleRange();
        const spanX = Math.max(0, r.right - r.left - toggleBtn.offsetWidth);
        const spanY = Math.max(0, r.bottom - r.top - toggleBtn.offsetHeight);
        placeToggle(r.left + togglePos.fx * spanX, r.top + togglePos.fy * spanY);
    }
    applyTogglePos();
    window.addEventListener('resize', () => { if (!toggleDrag) applyTogglePos(); });

    function setCollapsed(next) {
        if (next === isCollapsed) return;
        isCollapsed = next;
        document.body.classList.toggle('tp-collapsed', next);
        toggleBtn.textContent = next ? '展开' : '收起';
        toggleBtn.setAttribute('aria-expanded', String(!next));
        clearTimeout(syncTimer);

        if (next) {
            // 收起后触控板无法操作:先隐藏光标,并清掉页面里残留的悬停态
            cursorEl.style.visibility = 'hidden';
            if (currentTargetId === 'index') clearLocalHover();
            else if (currentTargetId) sendToFrame(currentTargetId, 'leave', 0, 0, {});
            currentTargetId = null;
        }

        // 等 #stage 的高度过渡结束后,按新的可视高度校正光标与平移,再恢复光标
        syncTimer = setTimeout(() => {
            clampCursor();
            panX = (window.innerWidth / 2) - cursor.x * zoom;
            panY = (stage.clientHeight / 2) - cursor.y * zoom;
            clampPan();
            applyTransform();
            updateCursorVisual();
            if (!isCollapsed) {
                cursorEl.style.visibility = '';
                routeOp('move');
            }
        }, STAGE_RESIZE_MS);
    }

    toggleBtn.addEventListener('pointerdown', (e) => {
        if (toggleDrag) return;
        e.preventDefault();
        toggleBtn.setPointerCapture(e.pointerId);
        toggleDrag = {
            id: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            baseLeft: parseFloat(toggleBtn.style.left) || 0,
            baseTop: parseFloat(toggleBtn.style.top) || 0,
            dragging: false,
        };
    });

    toggleBtn.addEventListener('pointermove', (e) => {
        if (!toggleDrag || e.pointerId !== toggleDrag.id) return;
        e.preventDefault();
        const dx = e.clientX - toggleDrag.startX;
        const dy = e.clientY - toggleDrag.startY;
        if (!toggleDrag.dragging) {
            if (Math.hypot(dx, dy) <= TOGGLE_DRAG_THRESHOLD) return;
            toggleDrag.dragging = true;
            toggleBtn.classList.add('tp-dragging');
        }
        const c = clampToggle(toggleDrag.baseLeft + dx, toggleDrag.baseTop + dy);
        placeToggle(c.left, c.top);
    });

    function endToggleDrag(e, cancelled) {
        if (!toggleDrag || e.pointerId !== toggleDrag.id) return;
        const wasDragging = toggleDrag.dragging;
        toggleDrag = null;
        toggleBtn.classList.remove('tp-dragging');

        if (wasDragging) {
            // 松手即固定:记住位置
            togglePos = toRatio(parseFloat(toggleBtn.style.left) || 0, parseFloat(toggleBtn.style.top) || 0);
            try { localStorage.setItem(TOGGLE_POS_KEY, JSON.stringify(togglePos)); } catch (err) { }
        } else if (!cancelled) {
            setCollapsed(!isCollapsed);
        }
    }
    toggleBtn.addEventListener('pointerup', (e) => endToggleDrag(e, false));
    toggleBtn.addEventListener('pointercancel', (e) => endToggleDrag(e, true));
}
