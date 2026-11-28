/**
 * search-preview.js —— 中央悬浮预览窗（运行于主线程）
 * 统一提供搜索结果与 What's new 的摘要滚动、图片预览及音视频右键试播。
 */
import {
    escapeHtml,
    encodePathSegments,
    saveMediaPosition,
    saveMediaPositionsIn,
    resumeMediaPosition,
    searchHighlightSupported,
    getSearchHighlight,
    resetSearchHighlights,
    publishSearchHighlights
} from './shared-utils.js';

// 音频波形样式与滚动参数
const HOVER_SNIPPET_DELAY_MS = 60;   // 悬停请求摘要防抖 (ms)
const SCROLL_PX_PER_SEC = 60;        // 自动滚屏速度 (px/s)
const WAVE_STYLE_ID = 'wave-bars-style';
const WAVE_STYLE_TEXT =
    '.wave-bars { display: flex; align-items: flex-end; gap: 4px; height: 40px; justify-content: center; }' +
    '.wave-bar { width: 5px; background: #61afef; border-radius: 2px; animation: waveAnim 0.8s ease-in-out infinite alternate; }' +
    '.wave-bar.paused { animation-play-state: paused !important; }' +
    '@keyframes waveAnim { 0% { height: 10px; } 100% { height: 100%; } }' +
    '.wb-1 { animation-delay: 0s; } .wb-2 { animation-delay: 0.2s; } .wb-3 { animation-delay: 0.4s; } .wb-4 { animation-delay: 0.6s; } .wb-5 { animation-delay: 0.8s; }';


// --- 预览容器与媒体播控辅助 ---

function ensureWaveBarsStyle() {
    if (document.getElementById(WAVE_STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = WAVE_STYLE_ID;
    st.textContent = WAVE_STYLE_TEXT;
    document.head.appendChild(st);
}

export function getPreviewBoxParts() {
    let box = document.getElementById('center-snippet-preview');
    if (!box) {
        box = document.createElement('div');
        box.id = 'center-snippet-preview';

        const header = document.createElement('div');
        header.id = 'preview-header';

        const wrapper = document.createElement('div');
        wrapper.id = 'preview-scroll-wrapper';

        const content = document.createElement('div');
        content.id = 'preview-scroll-content';

        wrapper.appendChild(content);
        box.append(header, wrapper);
        (document.getElementById('stage') || document.body).appendChild(box);
    }
    return {
        box,
        header: box.querySelector('#preview-header'),
        wrapper: box.querySelector('#preview-scroll-wrapper'),
        content: box.querySelector('#preview-scroll-content')
    };
}

export function stopPreviewMedia(content) {
    if (!content) return;
    content.querySelectorAll('video, audio').forEach(m => {
        saveMediaPosition(m);
        try {
            m.pause();
            m.removeAttribute('src');
            m.load();
        } catch (e) { }
    });
}

export function safePlayMedia(mediaEl) {
    const p = mediaEl.play();
    if (p !== undefined) {
        p.catch(err => {
            if (err.name !== 'AbortError') console.warn('Auto-play prevented', err);
        });
    }
}

function formatCountdown(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    const total = Math.max(0, Math.ceil(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function removePreviewCountdown() {
    const old = document.getElementById('preview-countdown');
    if (old) old.remove();
}

function attachPreviewCountdown(previewBox, mediaEl) {
    removePreviewCountdown();
    if (!previewBox || !mediaEl) return;

    const badge = document.createElement('div');
    badge.id = 'preview-countdown';
    badge.style.cssText = 'position:absolute;right:8px;bottom:6px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,0.65);color:#abb2bf;font-size:11px;font-family:monospace;line-height:1.4;pointer-events:none;z-index:10;display:none;';
    previewBox.appendChild(badge);

    const update = () => {
        const dur = mediaEl.duration;
        if (!Number.isFinite(dur) || dur <= 0) {
            badge.style.display = 'none';
            return;
        }
        badge.textContent = formatCountdown(dur - (mediaEl.currentTime || 0));
        badge.style.display = 'block';
    };

    mediaEl.addEventListener('loadedmetadata', update);
    mediaEl.addEventListener('durationchange', update);
    mediaEl.addEventListener('timeupdate', update);
    mediaEl.addEventListener('seeked', update);
    update();
}


// --- 独立图片与音视频预览 ---

export function showStandaloneImagePreview(path, isStillCurrent) {
    const { box, content } = getPreviewBoxParts();
    removePreviewCountdown();
    stopPreviewMedia(content);

    box.classList.add('image-preview-mode');
    box.style.borderColor = '#61afef';
    content.style.transform = '';

    const img = document.createElement('img');
    img.alt = 'Preview';
    img.style.cssText = 'max-width: 450px; max-height: 350px; object-fit: contain;';
    img.onerror = () => {
        if (!isStillCurrent || isStillCurrent()) {
            content.innerHTML = '';
            box.style.display = 'none';
        }
    };
    img.src = encodePathSegments(path);
    content.replaceChildren(img);
    box.style.display = 'flex';
    requestAnimationFrame(() => box.setAttribute('data-active', 'true'));
}

export function toggleStandaloneMediaPreview(path, kind, opts = {}) {
    const { box, content } = getPreviewBoxParts();
    let mediaEl = content.querySelector('video, audio');

    if (mediaEl && mediaEl.dataset.path === path && (!opts.isOwner || opts.isOwner())) {
        if (mediaEl.paused) {
            safePlayMedia(mediaEl);
            content.querySelectorAll('.wave-bar').forEach(b => b.classList.remove('paused'));
        } else {
            mediaEl.pause();
            content.querySelectorAll('.wave-bar').forEach(b => b.classList.add('paused'));
        }
        return;
    }

    stopPreviewMedia(content);
    removePreviewCountdown();
    if (typeof opts.onClaim === 'function') opts.onClaim();

    box.classList.add('image-preview-mode');
    box.style.borderColor = '#61afef';
    content.style.transform = '';
    box.style.display = 'flex';
    requestAnimationFrame(() => box.setAttribute('data-active', 'true'));

    if (kind === 'video') {
        mediaEl = document.createElement('video');
        mediaEl.style.cssText = 'max-width: 450px; max-height: 350px; width: 100%; outline: none; object-fit: contain;';
        content.replaceChildren(mediaEl);
    } else {
        ensureWaveBarsStyle();
        const filename = path.split('/').pop();
        const wrapEl = document.createElement('div');
        wrapEl.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%;';
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'margin-bottom:20px; color:#abb2bf; font-size:14px; text-align:center; word-break:break-all; padding: 0 15px;';
        titleEl.textContent = filename;
        const barsEl = document.createElement('div');
        barsEl.className = 'wave-bars';
        for (let bi = 1; bi <= 5; bi++) {
            const bItem = document.createElement('div');
            bItem.className = `wave-bar wb-${bi}`;
            barsEl.appendChild(bItem);
        }
        wrapEl.append(titleEl, barsEl);

        mediaEl = document.createElement('audio');
        mediaEl.style.display = 'none';
        content.replaceChildren(wrapEl, mediaEl);

        const bars = content.querySelectorAll('.wave-bar');
        const syncBars = () => bars.forEach(b => b.classList.toggle('paused', mediaEl.paused));
        mediaEl.addEventListener('play', syncBars);
        mediaEl.addEventListener('pause', syncBars);
        syncBars();
    }

    mediaEl.dataset.path = path;
    mediaEl.loop = true;
    mediaEl.volume = 0.1;
    mediaEl.src = encodePathSegments(path);
    if (opts.withCountdown) attachPreviewCountdown(box, mediaEl);
    resumeMediaPosition(mediaEl, path);
    safePlayMedia(mediaEl);
}


// --- 搜索列表预览控制器 ---

export function createSearchPreviewController(ctx) {
    const { store, elSearchResults, elSearchInput, requestSnippets } = ctx;
    const { box: previewBox } = getPreviewBoxParts();

    let previewScrollFrame = null;
    let previewTimeoutId = null;
    let previewScrollGen = 0;
    let currentScrollY = 0;
    let lastHoveredPath = null;
    let hoverSnippetTimer = null;
    let isPaused = true;

    function stopPreviewScroll() {
        previewScrollGen++;
        if (previewTimeoutId) { clearTimeout(previewTimeoutId); previewTimeoutId = null; }
        if (previewScrollFrame) { cancelAnimationFrame(previewScrollFrame); previewScrollFrame = null; }
    }

    function resetPreviewScroll(scrollContent) {
        stopPreviewScroll();
        currentScrollY = 0;
        if (scrollContent) scrollContent.style.transform = 'translateY(0px)';
    }

    function destroyMediaPreview() {
        removePreviewCountdown();
        if (previewBox) {
            previewBox.removeAttribute('data-active');
            previewBox.style.display = 'none';
        }
        lastHoveredPath = null;
        clearTimeout(hoverSnippetTimer);
        resetSearchHighlights();
        publishSearchHighlights();
        isPaused = true;
        const scrollContent = document.getElementById('preview-scroll-content');
        resetPreviewScroll(scrollContent);
        if (scrollContent) {
            saveMediaPositionsIn(scrollContent);
            scrollContent.innerHTML = '';
        }
    }

    function showSnippetPreview(resultData, data) {
        stopPreviewScroll();
        const body = (data && data.body) || { hits: 0, more: 0, items: [] };
        const cm = (data && data.comments) || { hits: 0, docs: 0, more: 0, items: [] };
        if (body.items.length === 0 && cm.items.length === 0) {
            previewBox.removeAttribute('data-active');
            previewBox.style.display = 'none';
            return;
        }

        const header = document.getElementById('preview-header');
        const scrollWrapper = document.getElementById('preview-scroll-wrapper');
        const scrollContent = document.getElementById('preview-scroll-content');
        previewBox.style.display = 'flex';
        requestAnimationFrame(() => {
            previewBox.setAttribute('data-active', 'true');
        });
        header.style.color = '#abb2bf';

        const titleSpan = document.createElement('span');
        titleSpan.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%;';
        titleSpan.textContent = resultData.title;
        const countSpan = document.createElement('span');
        countSpan.style.cssText = 'color: #61afef; font-size: 11px; white-space: nowrap;';
        countSpan.textContent = [
            body.hits > 0 ? `正文: ${body.hits}` : '',
            cm.docs > 0 ? `评论: ${cm.docs}` : ''
        ].filter(Boolean).join('  ');
        const bar = document.createElement('div');
        bar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';
        bar.append(titleSpan, countSpan);
        header.replaceChildren(bar);

        const useHL = searchHighlightSupported();
        resetSearchHighlights();

        const buildBlock = () => {
            const block = document.createElement('div');
            block.className = 'loop-block';

            const addSection = (label, items, more, isComment) => {
                if (items.length === 0) return;
                const title = document.createElement('div');
                title.style.cssText = 'color: #e5c07b; font-size: 11px; font-weight: bold; margin: 0 0 6px;';
                title.textContent = label + (more > 0 ? ` (+${more})` : '');
                block.appendChild(title);

                items.forEach((item, k) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'margin-bottom: 12px; border-bottom: 1px dashed #4b5263; padding-bottom: 8px;';
                    const tag = document.createElement('span');
                    tag.style.cssText = 'color: #61afef; font-size: 11px;';
                    tag.textContent = isComment ? `[#${item.c + 1}]` : `[${k + 1}]`;
                    const text = document.createTextNode(' ' + item.t);
                    row.append(tag, text);
                    block.appendChild(row);

                    if (!useHL) return;
                    const maxLen = text.length;
                    for (const [s, e, n] of item.h) {
                        const rs = Math.max(0, Math.min(maxLen, s + 1));
                        const re = Math.max(rs, Math.min(maxLen, e + 1));
                        if (re <= rs) continue;
                        const r = new Range();
                        r.setStart(text, rs);
                        r.setEnd(text, re);
                        getSearchHighlight(n).add(r);
                    }
                });
            };
            addSection(`正文: ${body.hits}`, body.items, body.more, false);
            addSection(`评论: ${cm.docs}`, cm.items, cm.more, true);
            return block;
        };

        const first = buildBlock();
        scrollContent.replaceChildren(first);
        publishSearchHighlights();
        currentScrollY = 0;
        scrollContent.style.transform = `translateY(0px)`;

        const gen = ++previewScrollGen;
        previewTimeoutId = setTimeout(() => {
            previewTimeoutId = null;
            if (gen !== previewScrollGen) return;
            const blockHeight = first.offsetHeight;
            const visibleHeight = scrollWrapper.offsetHeight;
            if (blockHeight <= visibleHeight) return;

            scrollContent.appendChild(buildBlock());
            let lastTs = 0;
            const autoScroll = (ts) => {
                if (gen !== previewScrollGen) return;
                const dt = lastTs ? Math.min(ts - lastTs, 100) : 0;
                lastTs = ts;
                if (!isPaused && dt > 0) {
                    currentScrollY = (currentScrollY + SCROLL_PX_PER_SEC * dt / 1000) % blockHeight;
                    scrollContent.style.transform = `translateY(-${currentScrollY}px)`;
                }
                previewScrollFrame = requestAnimationFrame(autoScroll);
            };
            previewScrollFrame = requestAnimationFrame(autoScroll);
        }, 10);
    }

    elSearchResults.addEventListener('mousemove', (e) => {
        const optEl = e.target.closest && e.target.closest('.sr-opt');
        if (!optEl) return;

        const path = optEl.dataset.path;
        const type = optEl.dataset.type;

        if (optEl.dataset.localOnly === "true" && store.online_flag === "1") {
            optEl.title = "";
            if (lastHoveredPath !== path) {
                destroyMediaPreview();
                lastHoveredPath = path;
            }
            return;
        }

        const isTxtAnchor = type === 'txt-group' || type === 'txt-hit';
        const isMedia = !isTxtAnchor && (type === 'video' || type === 'audio' || /\.(mp4|webm|ogg|mp3|wav|flac|m4a)$/i.test(path));
        const isImage = !isTxtAnchor && (type === 'image' || /\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/i.test(path));

        if (type === 'html' || isTxtAnchor) optEl.title = "右击滚动/停止";
        else if (isMedia) optEl.title = "右击播放/停止";
        else optEl.title = "";

        if (path === lastHoveredPath) return;

        clearTimeout(hoverSnippetTimer);
        if (isMedia || previewBox.querySelector('video, audio')) destroyMediaPreview();
        lastHoveredPath = path;

        if (isMedia) return;

        isPaused = true;
        previewBox.style.borderColor = '#61afef';
        previewBox.classList.toggle('image-preview-mode', isImage);

        const scrollContent = document.getElementById('preview-scroll-content');
        if (isImage) {
            resetPreviewScroll(scrollContent);
            showStandaloneImagePreview(path, () => lastHoveredPath === path);
            return;
        }

        const resultData = window._currentResultMap && window._currentResultMap.get(path);
        const keyword = window._currentRenderedKeyword || elSearchInput.value.trim();
        if (!resultData || !keyword) return;

        hoverSnippetTimer = setTimeout(async () => {
            if (lastHoveredPath !== path) return;
            const data = await requestSnippets(path, keyword);
            if (lastHoveredPath !== path || !data) return;
            showSnippetPreview(resultData, data);
        }, HOVER_SNIPPET_DELAY_MS);
    });

    elSearchResults.addEventListener('contextmenu', (e) => {
        const optEl = e.target.closest && e.target.closest('.sr-opt');
        if (!optEl) return;

        e.preventDefault();
        const path = optEl.dataset.path;
        const type = optEl.dataset.type;

        if (optEl.dataset.localOnly === "true" && store.online_flag === "1") return;

        const isTxtAnchor = type === 'txt-group' || type === 'txt-hit';
        const isMedia = !isTxtAnchor && (type === 'video' || type === 'audio' || /\.(mp4|webm|ogg|mp3|wav|flac|m4a)$/i.test(path));
        if (isMedia) {
            const isVideo = type === 'video' || /\.(mp4|webm|ogg)$/i.test(path);
            stopPreviewScroll();
            currentScrollY = 0;
            toggleStandaloneMediaPreview(path, isVideo ? 'video' : 'audio', { withCountdown: true });
            return;
        }

        if ((type === 'html' || isTxtAnchor) && previewBox.style.display === 'flex' && !previewBox.classList.contains('image-preview-mode')) {
            isPaused = !isPaused;
            previewBox.style.borderColor = !isPaused ? '#e5c07b' : '#61afef';
            const header = document.getElementById('preview-header');
            if (header) header.style.color = !isPaused ? '#e5c07b' : '#abb2bf';
        }
    });

    elSearchResults.addEventListener('mouseleave', () => destroyMediaPreview());
    elSearchResults.addEventListener('click', () => destroyMediaPreview());

    return { destroyMediaPreview };
}
