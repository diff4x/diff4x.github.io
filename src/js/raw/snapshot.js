/**
 * snapshot.js —— 页面现场快照捕捉与热更新恢复（运行于主线程，按需懒加载）
 */
import { $ } from './shared-utils.js';


// --- 现场捕捉 ---

export function takeSnapshot(ctx, reload = false) {
    const { store, iframes } = ctx;
    try {
        const state = {
            search_kw: $("#searchInput") ? $("#searchInput").value.trim() : ""
        };
        let mainPath = null;
        let mainType = null;
        let videoState = null;
        try {
            const cWin = iframes.content.contentWindow;
            const cDoc = iframes.content.contentDocument;
            const href = cWin.location.href;

            if (href.includes('/html/')) {
                mainType = 'html';
                let currentHtml = store.last_html || '';
                if (!currentHtml) {
                    try {
                        const p = decodeURIComponent(cWin.location.pathname || '');
                        const idx = p.indexOf('/html/');
                        if (idx !== -1) currentHtml = p.slice(idx + 1);
                    } catch (_) { }
                }
                let history = store.last_li_a;
                if (!Array.isArray(history)) history = history ? [history] : [];
                mainPath = currentHtml || (history.length > 0 ? history[0] : "src/tpl/bookmark.html");
            } else if (href.includes('pdf.html')) {
                mainType = 'pdf';
                mainPath = store.pdf_path;
            } else if (href.includes('epub.html')) {
                mainType = 'epub';
                mainPath = store.epub_path;
            } else if (href.includes('txt.html')) {
                mainType = 'txt';
                mainPath = store.txt_path;
            } else if (cDoc && cDoc.getElementById('img')) {
                mainType = 'image';
                mainPath = store.image_path;
            } else if (cDoc && cDoc.getElementById('video')) {
                mainType = 'video';
                mainPath = store.video_path;
                const vEl = cDoc.getElementById('video');
                videoState = { currentTime: vEl.currentTime, volume: vEl.volume, isPaused: vEl.paused };
            }
        } catch (e) { console.warn("主屏状态读取失败", e); }

        state.main_type = mainType;
        state.main_path = mainPath;
        state.video_strict = videoState;

        const audioEl = document.getElementById('_audio');
        if (audioEl) {
            const currentLi = document.querySelector('#_playlist li.current');
            let aPath = currentLi ? currentLi.dataset.path : null;
            if (!aPath && audioEl.src) {
                try {
                    aPath = decodeURIComponent(new URL(audioEl.src).pathname);
                    if (aPath.includes('/audio/')) aPath = "audio/" + aPath.split('/audio/')[1];
                } catch (e) { }
            }
            if (typeof aPath === 'string') {
                aPath = aPath.replace(/^(?:\.\.\/|\.\/|\/)+/, '');
            }
            const activeBtns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.classList.contains('active2'))
                .map(b => b.textContent);
            const audioContainer = document.getElementById('audio');
            const isHidden = audioContainer ? audioContainer.style.display === 'none' : false;
            state.audio_strict = {
                path: aPath || store.song_path,
                time: audioEl.currentTime,
                volume: audioEl.volume,
                isPaused: audioEl.paused,
                header: document.querySelector('.header')?.innerText || '',
                modes: activeBtns,
                isHidden: isHidden
            };
        }
        sessionStorage.setItem("ss_restore_strict", JSON.stringify(state));
    } catch (e) {
        console.error("快照捕捉失败", e);
    }

    if (reload) {
        window.location.reload();
    }
}


// --- 刷新恢复与脏状态清理 ---

export async function restoreSnap(ctx) {
    const { store, iframes, AsyncUtils, emitEvent, adjSearchRight, openAudio, runSearch } = ctx;
    if (window._snapRestored) return;
    window._snapRestored = true;

    const restoreStateStr = sessionStorage.getItem("ss_restore_strict");
    if (!restoreStateStr) {
        iframes.content.src = "src/tpl/bookmark.html";
        return;
    }
    sessionStorage.removeItem("ss_restore_strict");
    let state;
    try {
        state = JSON.parse(restoreStateStr);
    } catch (e) {
        iframes.content.src = "src/tpl/bookmark.html";
        return;
    }

    await AsyncUtils.waitFor(() => {
        try {
            const sideDoc = iframes.side.contentDocument;
            return window.lite_data && sideDoc && sideDoc.querySelector('a[data-path]');
        } catch (e) {
            return false;
        }
    }, 15000);
    await AsyncUtils.wait(100);

    const checkDataIntegrity = (bucket, path) => {
        if (!window.lite_data || !window.lite_data[bucket] || !path) return false;

        let clean = path.replace(/^\.\.\//, '');
        if (bucket === 'html' && clean.startsWith('html/')) clean = clean.substring(5);
        else if (bucket === 'image' && clean.startsWith('gallery/')) clean = clean.substring(8);
        else if (bucket === 'video' && clean.startsWith('video/')) clean = clean.substring(6);
        else if (bucket === 'audio' && clean.startsWith('audio/')) clean = clean.substring(6);
        else if (bucket === 'ebook' && clean.startsWith('ebook/')) clean = clean.substring(6);

        if (bucket === 'html') {
            let found = false;
            const targetFileName = clean.split('/').pop();
            const scanNode = (node) => {
                if (found || !node || typeof node !== 'object') return;
                if (Array.isArray(node._f) && node._f.some(f => f[0] === targetFileName)) {
                    found = true;
                    return;
                }
                for (const key of Object.keys(node)) {
                    if (key !== '_f') scanNode(node[key]);
                }
            };
            scanNode(window.lite_data[bucket]);
            return found;
        }

        let parts = clean.split('/');
        if (parts.length === 1) parts = ['_uncategorized', parts[0]];
        const fileName = parts.pop();
        let curr = window.lite_data[bucket];
        for (const p of parts) {
            if (!curr || !curr[p]) return false;
            curr = curr[p];
        }

        return curr && curr._f && Array.isArray(curr._f) && curr._f.some(f => f[0] === fileName);
    };

    let needsBookmarkFallback = false;
    if (state.main_type && state.main_path) {
        let bucket = state.main_type;
        if (['pdf', 'epub', 'txt'].includes(bucket)) bucket = 'ebook';
        if (bucket === 'image') bucket = 'image';
        if (!checkDataIntegrity(bucket, state.main_path)) {
            console.warn(`🚨 ${bucket} 目录结构已变或文件丢失，正在销毁脏数据:`, state.main_path);

            if (bucket === 'image') { store.imagelist = []; store.image_path = ""; }
            else if (bucket === 'video') { store.videolist = []; store.video_path = ""; }
            else if (bucket === 'ebook') { store.pdf_path = ""; store.epub_path = ""; store.txt_path = ""; }
            else if (bucket === 'html') { store.last_html = ""; }

            let hist = store.last_li_a;
            if (Array.isArray(hist)) store.last_li_a = hist.filter(p => p !== state.main_path);

            state.main_type = null;
            state.main_path = null;
            needsBookmarkFallback = true;
        }
    }

    if (state.audio_strict && state.audio_strict.path) {
        if (!checkDataIntegrity('audio', state.audio_strict.path)) {
            console.warn(`🚨 audio 目录结构已变，正在销毁音频脏数据:`, state.audio_strict.path);
            store.playlist = [];
            store.song_path = "";
            state.audio_strict = null;
            needsBookmarkFallback = true;
        }
    }
    if (needsBookmarkFallback) {
        store.resource_type = "bookmark";
        store.content_src = "src/tpl/bookmark.html";
        store.lightbox_stauts = "0";
        iframes.content.src = "src/tpl/bookmark.html";
        emitEvent('update_bookmark_menu', null, 'side');
    }

    try {
        if (state.main_type && state.main_path) {
            let sel = state.main_type;
            if (['pdf', 'epub', 'txt'].includes(sel)) sel = 'ebook';
            if (sel === 'image') sel = 'gallery';
            emitEvent('#' + sel + ' a', state.main_path, 'side');
            emitEvent('show_current', null, 'side');
            if (state.main_type === 'video' && state.video_strict) {
                await AsyncUtils.waitFor(() => {
                    const v = iframes.content.contentDocument?.getElementById('video');
                    return v && v.readyState >= 1;
                }, 5000);
                const vEl = iframes.content.contentDocument.getElementById('video');
                if (vEl) {
                    vEl.currentTime = state.video_strict.currentTime || 0;
                    vEl.volume = state.video_strict.volume ?? 0.2;
                    if (state.video_strict.isPaused) vEl.pause();
                    else vEl.play().catch(() => { });
                }
            }
        } else {
            iframes.content.src = "src/tpl/bookmark.html";
        }
    } catch (e) {
        console.warn("主视图恢复中止:", e.message);
    }

    try {
        const a = state.audio_strict;
        if (a && a.path) {
            const normAudio = (p) => String(p || '').replace(/^(?:\.\.\/|\.\/|\/)+/, '');
            const targetPath = normAudio(a.path);
            const lastSlash = targetPath.lastIndexOf('/');
            const fileName = lastSlash >= 0 ? targetPath.slice(lastSlash + 1) : targetPath;
            const dir = lastSlash >= 0 ? targetPath.slice(0, lastSlash + 1) : 'audio/';

            await AsyncUtils.waitFor(() => window.lite_data && Object.keys(window.lite_data).length > 0, 15000);

            if (typeof openAudio === 'function' && !window._audioTriggered && !$('#_audio')) {
                window._audioTriggered = true;
                await openAudio(fileName, dir);
            }

            if (a.header === 'All') {
                await AsyncUtils.waitFor(() => window.data && window.data.length > 0, 15000);
                const allBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'All');
                allBtn?.click();
            } else if (a.header === 'Favorite Songs') {
                const favBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Favorite Songs');
                favBtn?.click();
            }

            await AsyncUtils.waitFor(() =>
                Array.from(document.querySelectorAll('#_playlist li'))
                    .some(li => normAudio(li.dataset.path) === targetPath)
                , 5000);

            const targetLi = Array.from(document.querySelectorAll('#_playlist li'))
                .find(li => normAudio(li.dataset.path) === targetPath);
            targetLi?.click();

            await AsyncUtils.waitFor(() => {
                const el = $('#_audio');
                return el && el.readyState >= 1;
            }, 5000);

            const audioEl = $('#_audio');
            if (audioEl) {
                audioEl.muted = true;
                audioEl.currentTime = a.time || 0;
                audioEl.volume = a.volume ?? 0.3;
                await AsyncUtils.wait(100);
                const getBtn = (t) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === t);

                a.modes?.forEach(m => {
                    if (m !== 'List Loop') getBtn(m)?.click();
                });

                audioEl.muted = false;
                if (a.isPaused) audioEl.pause();
                else audioEl.play().catch(() => { });

                const container = $('#audio');
                if (container) {
                    container.style.display = a.isHidden ? 'none' : 'block';
                    if (typeof adjSearchRight === 'function') adjSearchRight();
                }
            }
        }
    } catch (e) {
        console.warn("音频恢复中止:", e.message);
    }

    try {
        if (state.search_kw) {
            await AsyncUtils.waitFor(() => window.data && window.data.length > 0, 15000);
            const inp = $('#searchInput');
            if (inp && inp.value.trim() === '') {
                inp.value = state.search_kw;
                if (typeof runSearch === 'function') runSearch(state.search_kw);
            }
        }
    } catch (e) {
        console.warn("搜索框恢复中止:", e.message);
    }
}
