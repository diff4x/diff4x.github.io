/**
 * search-ui.js —— 搜索框交互、历史联想、自定义结果列表、过滤工具条 (#sf-bar)
 * 以及搜索结果高亮渲染。
 */
import {
    $,
    SEARCH_HL_STYLE,
    SEARCH_SYN_HL_STYLE,
    SEARCH_SYN2_HL_STYLE,
    searchHlTier,
    searchHlBucket
} from './shared-utils.js';
import {
    isActionCommand,
    isAdsQuery,
    isReservedSearchCommand,
    normalizeDocPath,
    pageOverlayKey
} from './search-engine.js';
import { createSearchPreviewController } from './search-preview.js';

const SF_BAR_WIDTH = 270;

function upgradeSearchHistoryBox(oldEl) {
    if (!oldEl || oldEl.tagName !== 'SELECT') return oldEl;

    const selCs = getComputedStyle(oldEl);
    const selBg = (selCs.backgroundColor && selCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && selCs.backgroundColor !== 'transparent')
        ? selCs.backgroundColor : '#fff';
    const selBorder = (selCs.borderTopWidth && parseFloat(selCs.borderTopWidth) > 0)
        ? `${selCs.borderTopWidth} ${selCs.borderTopStyle || 'solid'} ${selCs.borderTopColor || '#767676'}`
        : '1px solid #767676';
    const selRadius = selCs.borderRadius || '2px';
    const selFont = selCs.fontFamily || 'Arial, "Microsoft YaHei", sans-serif';
    const selFontSize = selCs.fontSize || '13.3333px';

    if (!document.getElementById('sh-custom-style')) {
        const st = document.createElement('style');
        st.id = 'sh-custom-style';
        st.textContent = `
#searchHistory{box-sizing:border-box;overflow-y:auto;overflow-x:hidden;background-color:${selBg};border:${selBorder};border-radius:${selRadius};font-family:${selFont};font-size:${selFontSize};line-height:normal;color:#000;user-select:none;-webkit-user-select:none;outline:none}
#searchHistory .sh-opt{display:block;box-sizing:border-box;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;padding:0 4px 1px;min-height:1.2em;line-height:1.35}
#searchHistory .sh-opt:hover{background-color:aliceblue}
#searchHistory .sh-opt.sh-selected{background-color:#dcdcdc;color:#000}
`;
        document.head.appendChild(st);
    }

    const box = document.createElement('div');
    box.id = 'searchHistory';
    box.setAttribute('role', 'listbox');
    box.tabIndex = 0;
    box.style.cssText = oldEl.style.cssText;

    let _selectedIdx = -1;
    Object.defineProperty(box, 'options', {
        get() { return this.querySelectorAll('.sh-opt'); }
    });
    Object.defineProperty(box, 'selectedIndex', {
        get() {
            const opts = this.options;
            return (_selectedIdx >= 0 && _selectedIdx < opts.length) ? _selectedIdx : -1;
        },
        set(val) {
            const opts = this.options;
            const next = (typeof val === 'number' && val >= 0 && val < opts.length) ? val : -1;
            _selectedIdx = next;
            opts.forEach((el, i) => {
                const sel = i === next;
                el.classList.toggle('sh-selected', sel);
                el.setAttribute('aria-selected', sel ? 'true' : 'false');
                if (sel) el.scrollIntoView({ block: 'nearest' });
            });
        }
    });
    box.syncHeight = function () {
        const opts = this.options;
        if (!opts.length) {
            this.style.display = 'none';
            return;
        }
        const rowH = (opts[0] && opts[0].offsetHeight) || Math.ceil(parseFloat(getComputedStyle(this).fontSize || '13.33') * 1.35) || 18;
        const rows = Math.max(2, Math.min(10, opts.length));
        this.style.height = (rows * rowH + 2) + 'px';
    };

    oldEl.parentNode.replaceChild(box, oldEl);
    return box;
}

function makeHistoryOption(keyword, isHistory = true) {
    const opt = document.createElement('div');
    opt.className = 'sh-opt';
    opt.setAttribute('role', 'option');
    opt.textContent = keyword;
    Object.defineProperty(opt, 'text', {
        get() { return this.textContent; },
        set(v) { this.textContent = v; }
    });
    if (!isHistory) {
        opt.style.color = '#64748b';
        opt.style.fontStyle = 'italic';
    }
    return opt;
}

function upgradeSearchResultsBox(oldEl) {
    if (!oldEl || oldEl.tagName !== 'SELECT') return oldEl;

    const selCs = getComputedStyle(oldEl);
    const selBg = (selCs.backgroundColor && selCs.backgroundColor !== 'rgba(0, 0, 0, 0)' && selCs.backgroundColor !== 'transparent')
        ? selCs.backgroundColor : '#fff';
    const selBorder = (selCs.borderTopWidth && parseFloat(selCs.borderTopWidth) > 0)
        ? `${selCs.borderTopWidth} ${selCs.borderTopStyle || 'solid'} ${selCs.borderTopColor || '#767676'}`
        : '1px solid #767676';
    const selRadius = selCs.borderRadius || '2px';
    const selFont = selCs.fontFamily || 'Arial, "Microsoft YaHei", sans-serif';
    const selFontSize = selCs.fontSize || '13.3333px';

    const types = ['', 'html', 'image', 'video', 'audio', 'pdf', 'epub', 'txt'];
    const typeStyles = {};
    for (const t of types) {
        const opt = document.createElement('option');
        if (t) opt.dataset.type = t;
        opt.textContent = 'M';
        oldEl.appendChild(opt);
        const cs = getComputedStyle(opt);
        typeStyles[t || 'default'] = { color: cs.color, bg: cs.backgroundColor };
    }
    oldEl.innerHTML = '';

    if (!document.getElementById('sr-custom-style')) {
        const def = typeStyles.default || {};
        const typeRules = types.filter(Boolean).map(t => {
            const s = typeStyles[t];
            if (!s) return '';
            const decls = [];
            if (s.color && s.color !== def.color) decls.push(`color:${s.color}`);
            if (s.bg && s.bg !== def.bg && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent') {
                decls.push(`background-color:${s.bg}`);
            }
            return decls.length ? `#searchResults .sr-opt[data-type="${t}"]{${decls.join(';')}}` : '';
        }).filter(Boolean).join('\n');

        const hlRules = [
            ...SEARCH_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-${b}{background-color:rgba(255,235,0,${Math.min(0.92, a + 0.08)});color:${c}}`),
            ...SEARCH_SYN_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-syn-${b}{background-color:rgba(56,189,248,${Math.min(0.75, a + 0.08)});color:${c}}`),
            ...SEARCH_SYN2_HL_STYLE.map(([a, c], b) => `#searchResults .sr-hl-syn2-${b}{background-color:rgba(56,189,248,${Math.min(0.60, a + 0.06)});color:${c}}`)
        ].join('\n');

        const st = document.createElement('style');
        st.id = 'sr-custom-style';
        st.textContent = `
#searchResults{box-sizing:content-box;background-color:${selBg};border:${selBorder};border-radius:${selRadius};font-family:${selFont};font-size:${selFontSize};line-height:normal;user-select:none;-webkit-user-select:none;outline:none}
#searchResults .sr-opt{display:block;box-sizing:border-box;min-width:100%;width:max-content;white-space:pre;cursor:default;padding:0 4px 1px;min-height:1.2em;line-height:1.35;${def.color ? `color:${def.color};` : ''}}
#searchResults .sr-opt:hover{background-color:aliceblue}
${typeRules}
#searchResults .sr-opt.sr-selected{background-color:#dcdcdc;color:#000}
#searchResults:focus .sr-opt.sr-selected{background-color:Highlight;color:HighlightText}
#searchResults .sr-opt.sr-txt-group{font-weight:600;color:#1e3a8a;border-top:1px solid #eef2f7}
#searchResults .sr-opt.sr-txt-group:first-child{border-top:none}
#searchResults .sr-opt.sr-txt-hit{padding-left:18px;color:#334155;font-size:0.95em;background-color:#fafcff}
#searchResults .sr-opt.sr-txt-hit:hover{background-color:#e8f2ff}
#searchResults .sr-opt.sr-txt-hit.sr-txt-active{background-color:#fef3c7;color:#000}
#searchResults .sr-txt-meta{color:#64748b;font-weight:normal;font-size:0.9em}
#searchResults .sr-hl{margin:0;padding:0;border-radius:1px;font:inherit}
${hlRules}
`;
        document.head.appendChild(st);
    }

    const box = document.createElement('div');
    box.id = 'searchResults';
    box.setAttribute('role', 'listbox');
    box.tabIndex = 0;
    box.style.cssText = oldEl.style.cssText;

    let _selectedIdx = -1;
    Object.defineProperty(box, 'options', {
        get() { return this.querySelectorAll('.sr-opt'); }
    });
    Object.defineProperty(box, 'selectedIndex', {
        get() {
            const opts = this.options;
            return (_selectedIdx >= 0 && _selectedIdx < opts.length) ? _selectedIdx : -1;
        },
        set(val) {
            const opts = this.options;
            const next = (typeof val === 'number' && val >= 0 && val < opts.length) ? val : -1;
            _selectedIdx = next;
            opts.forEach((el, i) => {
                const sel = i === next;
                el.classList.toggle('sr-selected', sel);
                el.setAttribute('aria-selected', sel ? 'true' : 'false');
                if (sel) el.scrollIntoView({ block: 'nearest' });
            });
        }
    });

    oldEl.parentNode.replaceChild(box, oldEl);
    return box;
}

export function createSearchUI(ctx) {
    const { store, iframes, emitEvent, engine, getActiveWorker, runActionCommand, exitLightbox } = ctx;

    let _autocompleteSeq = 0;
    let _sfStampSrc = null, _sfStampFp = null, _sfStampMap = null;
    let _initialized = false;
    let _txtState = {
        keyword: '',
        totalHits: 0,
        shownHits: 0,
        groupUnit: '节',
        groups: [],
        error: '',
        expanded: new Set(),
        activeHitIndex: -1
    };

    function sfState() {
        if (!window._sfState) {
            let saved = null;
            try { saved = store.search_filter; } catch (e) { }
            saved = saved && typeof saved === 'object' ? saved : {};
            window._sfState = {
                off: Array.isArray(saved.off) ? saved.off.filter(k => typeof k === 'string' && k && k !== 'comment' && k !== 'other') : [],
                ymOff: []
            };
        }
        return window._sfState;
    }

    function sfSave() {
        try { store.search_filter = { off: window._sfState ? window._sfState.off : [] }; } catch (e) { }
    }

    function sfStampMap() {
        const src = window.lite_data, fp = window._dataFp;
        if (_sfStampMap && _sfStampSrc === src && _sfStampFp === fp) return _sfStampMap;
        const map = new Map();
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            const f = node._f;
            if (Array.isArray(f)) {
                for (const it of f) {
                    if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[3] === 'string') {
                        const stamp = it[3].split('-')[0];
                        if (/^\d{14}$/.test(stamp)) map.set('html/' + it[0], stamp);
                    }
                }
            }
            for (const k in node) if (k !== '_f') walk(node[k]);
        };
        walk(src && src.html);
        _sfStampSrc = src;
        _sfStampFp = fp;
        _sfStampMap = map;
        return map;
    }

    function sfYmOf(r) {
        if (r.type !== 'html') return '';
        const p = String(r.path || '').replace(/^\.\.\//, '');
        const stamp = sfStampMap().get(p) || '';
        return stamp.length >= 6 ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}` : '';
    }

    function sfExtOf(r) {
        if (r.type === 'html') return 'html';
        const m = /\.([A-Za-z0-9]+)$/.exec(r.path || '');
        return m ? m[1].toLowerCase() : '(无)';
    }

    function sfStats(results) {
        const exts = new Map();
        const yms = new Map();
        for (const r of results) {
            const e = sfExtOf(r);
            exts.set(e, (exts.get(e) || 0) + 1);
            if (r.type === 'html') {
                const ym = sfYmOf(r);
                if (ym) yms.set(ym, (yms.get(ym) || 0) + 1);
            }
        }
        return { exts, yms };
    }

    function sfActive() {
        const s = sfState();
        return s.off.length > 0 || s.ymOff.length > 0;
    }

    function sfApply(results) {
        const s = sfState();
        const stats = sfStats(results);
        const off = new Set(s.off);
        const ymOff = new Set(s.ymOff);
        if (off.size === 0 && ymOff.size === 0) return { list: results, total: results.length, stats };

        const list = results.filter(r => {
            if (off.has(sfExtOf(r))) return false;
            if (ymOff.size > 0 && r.type === 'html') {
                const ym = sfYmOf(r);
                if (ym && ymOff.has(ym)) return false;
            }
            return true;
        });
        return { list, total: results.length, stats };
    }

    function sfSyncEngine() {
        const n = Number(store.noise_level ?? 5);
        const l = Number(store.synonyms_enabled ?? 1);
        const bar = document.getElementById('sf-bar');
        if (!bar) return;
        const noiseEl = bar.querySelector('#sf-noise');
        if (noiseEl) {
            noiseEl.value = String(n);
            const valSpan = noiseEl.querySelector('.sf-noise-val');
            if (valSpan) valSpan.textContent = String(n);
            noiseEl.querySelectorAll('[data-noise]').forEach(it => {
                it.classList.toggle('active', Number(it.dataset.noise) === n);
            });
        }
        bar.querySelector('#sf-like').checked = l === 1;
    }

    async function sfApplyEngine(key, value) {
        engine.invalidateSearch();
        store[key] = value;
        sfSyncEngine();
        engine.clearSearchOverlays();
        const w = getActiveWorker();
        if (w) w.postMessage({ type: 'CLEAR_CURSOR', payload: { keyword: '' } });
        engine.invalidateSearch();
        engine.rerunActiveSearch();
        const activeKw = ($("#searchInput")?.value || store.keyword || '').trim();
        if (activeKw && !isActionCommand(activeKw) && store.resource_type === 'html') {
            emitEvent('REFRESH_HIGHLIGHT', { keyword: activeKw }, 'content');
        }
    }

    function sfInjectStyle() {
        if (document.getElementById('sf-style')) return;
        const st = document.createElement('style');
        st.id = 'sf-style';
        st.textContent = `
#sf-bar{box-sizing:border-box;display:none;flex-wrap:wrap;align-items:center;gap:2px 6px;margin:0 0 2px;padding:2px 5px;font-size:12px;white-space:nowrap;background:#fff;border:1px solid #999}
#sf-bar select,#sf-bar input,#sf-bar button{font-size:12px;user-select:text;-webkit-user-select:text}
#sf-bar details{position:relative}
#sf-bar summary{cursor:pointer}
#sf-bar #sf-noise{position:relative;display:inline-flex;align-items:center;gap:2px;padding:0 4px;border:1px solid #767676;border-radius:2px;background:#fff;cursor:pointer}
#sf-bar #sf-noise .sf-noise-menu{position:absolute;z-index:30;top:100%;left:-1px;margin-top:2px;min-width:100%;background:#fff;border:1px solid #767676;box-shadow:0 2px 6px rgba(0,0,0,0.15);display:none}
#sf-bar #sf-noise.open .sf-noise-menu{display:block}
#sf-bar #sf-noise .sf-noise-opt{padding:1px 6px;text-align:center}
#sf-bar #sf-noise .sf-noise-opt:hover,#sf-bar #sf-noise .sf-noise-opt.active{background:aliceblue;font-weight:bold}
#sf-bar .sf-pop{position:absolute;z-index:20;top:100%;left:0;margin-top:4px;min-width:130px;max-height:320px;overflow:auto;padding:4px 6px;background:#fff;border:1px solid #999;box-shadow:0 2px 6px rgba(0,0,0,0.15)}
#sf-bar .sf-pop-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;color:#555;font-size:11px}
#sf-bar .sf-pop label{display:block}
#sf-bar hr{margin:4px 0}
#sf-bar #sf-scope{padding:0 5px;border:1px solid #767676;border-radius:2px;background:#f8fafc;color:#334155;cursor:pointer;line-height:1.4}
#sf-bar #sf-scope.is-txt{background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-weight:bold}
#sf-count{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:center}
#sf-count.sf-hot{font-weight:bold}
#sf-status{flex-basis:100%;white-space:normal;word-break:break-all;color:#444}
#sf-status:empty{display:none}
`;
        document.head.appendChild(st);
    }

    function sfReset() {
        Object.assign(sfState(), { off: [], ymOff: [] });
        sfSave();
        rerenderSearchOverlay();
    }

    function sfInvertExt(bar) {
        const keys = [...bar.querySelectorAll('.sf-list input[data-k]')].map(i => i.dataset.k);
        if (!keys.length) return;
        const s = sfState();
        const off = new Set(s.off);
        for (const k of keys) { if (off.has(k)) off.delete(k); else off.add(k); }
        s.off = [...off];
        sfSave();
        rerenderSearchOverlay();
    }

    function sfInvertYm(bar) {
        const keys = [...bar.querySelectorAll('.sf-ym-list input[data-ym]')].map(i => i.dataset.ym);
        if (!keys.length) return;
        const s = sfState();
        const ymOff = new Set(s.ymOff);
        for (const k of keys) { if (ymOff.has(k)) ymOff.delete(k); else ymOff.add(k); }
        s.ymOff = [...ymOff];
        sfSave();
        rerenderSearchOverlay();
    }

    function sfBuildBar() {
        sfInjectStyle();
        const bar = document.createElement('div');
        bar.id = 'sf-bar';
        const noiseOpts = [0, 1, 2, 3, 4, 5].map(n => `<div class="sf-noise-opt" data-noise="${n}">${n}</div>`).join('');
        bar.innerHTML =
            `<button type="button" id="sf-scope" hidden title="切换文内 / 全站搜索">本书</button>` +
            `<span title="字间允许无关字数 (0~5)">噪 <span id="sf-noise" tabindex="0"><span class="sf-noise-val">5</span><span>▾</span><div class="sf-noise-menu">${noiseOpts}</div></span></span>` +
            `<label title="同义词扩展"><input type="checkbox" id="sf-like">近义</label>` +
            `<span id="sf-count" aria-live="polite"></span>` +
            `<details id="sf-sfx"><summary>筛选</summary><div class="sf-pop">` +
            `<div class="sf-pop-hd"><span>类型</span><button type="button" id="sf-inv" title="反选类型">反选</button></div>` +
            `<div class="sf-list"></div>` +
            `<div id="sf-ym-sec" hidden><hr>` +
            `<div class="sf-pop-hd"><span>年月 (.html)</span><button type="button" id="sf-ym-inv" title="反选年月">反选</button></div>` +
            `<div class="sf-ym-list"></div></div>` +
            `</div></details>` +
            `<button type="button" id="sf-reset" title="重置筛选">重置</button>` +
            `<div id="sf-status"></div>`;

        const noiseBox = bar.querySelector('#sf-noise');
        noiseBox.addEventListener('click', (e) => {
            const opt = e.target.closest && e.target.closest('.sf-noise-opt');
            if (opt) {
                e.stopPropagation();
                noiseBox.classList.remove('open');
                sfApplyEngine('noise_level', Number(opt.dataset.noise));
                return;
            }
            noiseBox.classList.toggle('open');
        });

        bar.querySelector('#sf-sfx').addEventListener('toggle', () => sfLayout());
        bar.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                bar.querySelector('#sf-sfx').open = false;
                noiseBox.classList.remove('open');
            }
        });
        document.addEventListener('click', (e) => {
            const d = bar.querySelector('#sf-sfx');
            if (d.open && !d.contains(e.target)) d.open = false;
            if (noiseBox.classList.contains('open') && !noiseBox.contains(e.target)) noiseBox.classList.remove('open');
        });

        bar.addEventListener('change', (e) => {
            const t = e.target;
            const s = sfState();
            if (t.id === 'sf-like') { sfApplyEngine('synonyms_enabled', t.checked ? 1 : 0); return; }
            if (t.dataset && t.dataset.k !== undefined) {
                s.off = s.off.filter(x => x !== t.dataset.k);
                if (!t.checked) s.off.push(t.dataset.k);
            } else if (t.dataset && t.dataset.ym !== undefined) {
                s.ymOff = s.ymOff.filter(x => x !== t.dataset.ym);
                if (!t.checked) s.ymOff.push(t.dataset.ym);
            } else {
                return;
            }
            sfSave();
            rerenderSearchOverlay();
        });
        bar.addEventListener('click', (e) => {
            if (e.target.id === 'sf-scope') {
                const next = engine.isTxtScope() ? 'global' : 'txt';
                engine.setSearchScope(next, { rerun: true });
            }
            else if (e.target.id === 'sf-reset') sfReset();
            else if (e.target.id === 'sf-inv') sfInvertExt(bar);
            else if (e.target.id === 'sf-ym-inv') sfInvertYm(bar);
        });
        return bar;
    }

    function sfSyncPanel(bar, stats) {
        const s = sfState();
        const exts = [...stats.exts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const yms = [...stats.yms].sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0));
        const sig = exts.map(e => e.join(':')).join(',') + '|' + yms.map(y => y.join(':')).join(',');

        const list = bar.querySelector('.sf-list');
        const ymSec = bar.querySelector('#sf-ym-sec');
        const ymList = bar.querySelector('.sf-ym-list');

        if (bar._sfSig !== sig) {
            list.textContent = '';
            if (exts.length === 0) {
                list.textContent = '无条目';
            } else {
                const frag = document.createDocumentFragment();
                exts.forEach(([k, n]) => {
                    const lbl = document.createElement('label');
                    const inp = document.createElement('input');
                    inp.type = 'checkbox';
                    inp.dataset.k = k;
                    lbl.append(inp, document.createTextNode(` ${k === '(无)' ? '无后缀' : '.' + k} (${n})`));
                    frag.appendChild(lbl);
                });
                list.appendChild(frag);
            }
            ymList.textContent = '';
            if (yms.length > 0) {
                ymSec.hidden = false;
                const ymFrag = document.createDocumentFragment();
                yms.forEach(([ym, n]) => {
                    const lbl = document.createElement('label');
                    const inp = document.createElement('input');
                    inp.type = 'checkbox';
                    inp.dataset.ym = ym;
                    lbl.append(inp, document.createTextNode(` ${ym} (${n})`));
                    ymFrag.appendChild(lbl);
                });
                ymList.appendChild(ymFrag);
            } else {
                ymSec.hidden = true;
            }
            bar._sfSig = sig;
        }
        list.querySelectorAll('input[data-k]').forEach(cb => {
            cb.checked = !s.off.includes(cb.dataset.k);
        });
        ymList.querySelectorAll('input[data-ym]').forEach(cb => {
            cb.checked = !s.ymOff.includes(cb.dataset.ym);
        });
    }

    function sfPaintStatus(keyword) {
        let el = document.getElementById('sf-status');
        if (engine.isTxtScope()) {
            const msg = window._txtStatus || '';
            const kw = (keyword || '').trim();
            const bar = document.getElementById('sf-bar');
            if (kw && msg && (!bar || bar.style.display === 'none')) {
                sfRefreshBar(kw, { txtHits: _txtState.totalHits, txtGroups: _txtState.groups.length, pending: true });
                el = document.getElementById('sf-status');
            }
            if (el) el.textContent = msg;
            sfLayout();
            return;
        }
        if (!el) return;
        if (window._engineError) {
            el.textContent = '⚠️ ' + window._engineError;
            return;
        }
        const info = isAdsQuery(keyword) ? window._adsStatus : null;
        el.textContent = info ? (info.error || info.summary || '') : '';
    }

    function sfLayout() {
        const bar = document.getElementById('sf-bar');
        const box = document.getElementById('searchResults');
        if (!bar || !box || bar.style.display === 'none') return;

        const cs = getComputedStyle(box);
        const abs = cs.position === 'absolute';
        bar.style.position = abs ? 'absolute' : 'relative';

        const searchEl = document.getElementById('search');
        const content = document.getElementById('content');
        const maxW = (searchEl && content) ? Math.max(0, content.clientWidth - searchEl.offsetWidth - 10) : 0;
        const barW = maxW > 0 ? Math.min(SF_BAR_WIDTH, maxW) : SF_BAR_WIDTH;
        bar.style.maxWidth = '';
        bar.style.width = barW + 'px';
        bar.style.left = (-barW) + 'px';

        const zi = parseInt(cs.zIndex, 10);
        const hist = document.getElementById('searchHistory');
        const histZi = hist ? parseInt(getComputedStyle(hist).zIndex, 10) : NaN;
        const baseZi = Math.max(Number.isFinite(zi) ? zi : 0, Number.isFinite(histZi) ? histZi : 0);
        bar.style.zIndex = String(baseZi + 10);

        const sfx = bar.querySelector('#sf-sfx');
        const pop = bar.querySelector('.sf-pop');
        if (sfx && pop) {
            pop.style.left = '';
            pop.style.right = '';
            pop.style.maxWidth = '';
            const desiredLeft = Math.max(0, bar.offsetWidth - sfx.offsetLeft);
            pop.style.left = desiredLeft + 'px';
            const sfxRect = sfx.getBoundingClientRect();
            const popLeftOnScreen = sfxRect.left + desiredLeft;
            const rightSpace = window.innerWidth - popLeftOnScreen - 8;
            if (rightSpace >= 120) {
                pop.style.maxWidth = rightSpace + 'px';
            } else {
                pop.style.left = 'auto';
                pop.style.right = '0px';
                pop.style.maxWidth = Math.max(120, sfxRect.right - 8) + 'px';
            }
        }

        if (abs) {
            let base = parseFloat(box.dataset.sfBaseTop);
            if (!Number.isFinite(base)) {
                box.style.top = '';
                base = parseFloat(cs.top);
                if (!Number.isFinite(base)) {
                    const inp = document.getElementById('searchInput');
                    base = inp ? inp.offsetTop + inp.offsetHeight + 2 : 0;
                }
                box.dataset.sfBaseTop = String(base);
            }
            bar.style.top = base + 'px';
            box.style.top = (base + bar.offsetHeight + 2) + 'px';
        } else {
            bar.style.top = '';
        }
    }

    function sfRestoreResultsTop() {
        const box = document.getElementById('searchResults');
        if (box && box.dataset.sfBaseTop !== undefined) {
            box.style.top = '';
            delete box.dataset.sfBaseTop;
        }
    }

    function sfRefreshBar(keyword, sf) {
        const kw = (keyword || '').trim();
        let bar = document.getElementById('sf-bar');
        const want = !!kw && (isAdsQuery(kw) || !isReservedSearchCommand(kw));
        if (!want) {
            if (bar) { bar.style.display = 'none'; sfRestoreResultsTop(); }
            return;
        }
        if (!bar) {
            const box = document.getElementById('searchResults');
            if (!box || !box.parentNode) return;
            bar = sfBuildBar();
            box.parentNode.insertBefore(bar, box);
        }
        bar.style.display = 'flex';

        const inTxt = engine.isTxtScope();
        const hasTxt = engine.hasTxtProvider();
        const scopeBtn = bar.querySelector('#sf-scope');
        if (scopeBtn) {
            scopeBtn.hidden = !hasTxt;
            scopeBtn.textContent = inTxt ? '本书' : '全站';
            scopeBtn.classList.toggle('is-txt', inTxt);
            scopeBtn.title = inTxt ? '当前搜本书，点击切换为全站搜索' : '当前搜全站，点击切换为本书搜索';
        }
        const sfxEl = bar.querySelector('#sf-sfx');
        const resetEl = bar.querySelector('#sf-reset');
        if (sfxEl) sfxEl.style.display = inTxt ? 'none' : '';
        if (resetEl) resetEl.style.display = inTxt ? 'none' : '';

        sfSyncEngine();
        const countEl = bar.querySelector('#sf-count');

        if (inTxt) {
            const totalHits = sf && typeof sf.txtHits === 'number' ? sf.txtHits : 0;
            const totalGroups = sf && typeof sf.txtGroups === 'number' ? sf.txtGroups : 0;
            const unit = (sf && sf.groupUnit) || _txtState.groupUnit || '节';
            const hasErr = !!(sf && sf.error);
            countEl.textContent = (hasErr || (sf && sf.pending))
                ? ''
                : (totalHits === 0 ? '0 处' : `${totalHits} 处 / ${totalGroups} ${unit}`);
            countEl.classList.toggle('sf-hot', !hasErr && totalHits > 0);
            const statusEl = bar.querySelector('#sf-status');
            if (statusEl) statusEl.textContent = window._txtStatus || '';
            sfLayout();
            return;
        }

        const ads = isAdsQuery(kw);
        sfSyncPanel(bar, sf.stats);

        const total = sf.total, shown = sf.list.length;
        const info = ads ? window._adsStatus : null;
        let txt;
        if (info && info.error) txt = '';
        else if (total === 0) txt = '0 条';
        else if (shown < total) txt = `${shown}/${total}`;
        else txt = `${total} 条`;
        countEl.textContent = txt;
        countEl.classList.toggle('sf-hot', total > 0 && shown < total);
        if (resetEl) resetEl.style.visibility = sfActive() ? 'visible' : 'hidden';
        sfPaintStatus(kw);

        sfLayout();
    }

    function appendHighlightedText(parent, text, ranges) {
        if (!ranges || ranges.length === 0) {
            parent.appendChild(document.createTextNode(text));
            return;
        }
        const chars = Array.from(text);
        let cursor = 0;
        for (const [s, e, n] of ranges) {
            const cs = Math.max(cursor, Math.min(s, chars.length));
            const ce = Math.max(cs, Math.min(e, chars.length));
            if (cs > cursor) parent.appendChild(document.createTextNode(chars.slice(cursor, cs).join('')));
            if (ce > cs) {
                const mark = document.createElement('mark');
                mark.className = `sr-hl ${searchHlTier(n) === 0 ? 'sr-hl-' : (searchHlTier(n) === 1 ? 'sr-hl-syn-' : 'sr-hl-syn2-')}${searchHlBucket(n)}`;
                mark.textContent = chars.slice(cs, ce).join('');
                parent.appendChild(mark);
            }
            cursor = ce;
        }
        if (cursor < chars.length) parent.appendChild(document.createTextNode(chars.slice(cursor).join('')));
    }

    function renderTxtResults({ preserveScroll = false } = {}) {
        const resultsBox = $('#searchResults');
        if (!resultsBox) return;
        const prevScrollTop = preserveScroll ? resultsBox.scrollTop : 0;

        const kw = _txtState.keyword || '';
        const groups = _txtState.groups || [];
        window._currentRenderedKeyword = kw;
        const resultMap = new Map();

        resultsBox.innerHTML = '';

        if (groups.length === 0) {
            resultsBox.style.display = 'none';
        } else {
            const frag = document.createDocumentFragment();
            for (const g of groups) {
                const isMulti = g.hits.length > 1;
                const isExpanded = isMulti && _txtState.expanded.has(g.groupIndex);
                const gPath = `txt-group:${g.groupIndex}`;
                resultMap.set(gPath, {
                    path: gPath,
                    type: 'txt-group',
                    title: `${g.title} (${g.percent})`,
                    groupIndex: g.groupIndex,
                    count: g.count
                });

                const gOpt = document.createElement('div');
                gOpt.className = 'sr-opt sr-txt-group';
                gOpt.setAttribute('role', 'option');
                gOpt.dataset.path = gPath;
                gOpt.dataset.type = 'txt-group';
                gOpt.dataset.groupIndex = String(g.groupIndex);

                const caret = isMulti ? (isExpanded ? '▾ ' : '▸ ') : '• ';
                gOpt.appendChild(document.createTextNode(caret));
                appendHighlightedText(gOpt, g.title, engine.computeTitleMatchRanges(g.title, kw));
                const metaSpan = document.createElement('span');
                metaSpan.className = 'sr-txt-meta';
                metaSpan.textContent = ` [${g.count}] · ${g.percent}`;
                gOpt.appendChild(metaSpan);
                frag.appendChild(gOpt);

                if (isExpanded) {
                    g.hits.forEach((h, idx) => {
                        const hPath = `txt-hit:${h.hitIndex}`;
                        resultMap.set(hPath, {
                            path: hPath,
                            type: 'txt-hit',
                            title: `${g.title} · #${idx + 1} (${h.percent})`,
                            hitIndex: h.hitIndex,
                            groupIndex: g.groupIndex
                        });

                        const hOpt = document.createElement('div');
                        hOpt.className = 'sr-opt sr-txt-hit' + (h.hitIndex === _txtState.activeHitIndex ? ' sr-txt-active' : '');
                        hOpt.setAttribute('role', 'option');
                        hOpt.dataset.path = hPath;
                        hOpt.dataset.type = 'txt-hit';
                        hOpt.dataset.hitIndex = String(h.hitIndex);
                        hOpt.dataset.groupIndex = String(g.groupIndex);

                        const noSpan = document.createElement('span');
                        noSpan.className = 'sr-txt-meta';
                        noSpan.textContent = `↳ #${idx + 1} `;
                        hOpt.appendChild(noSpan);
                        appendHighlightedText(hOpt, h.preview, h.highlights);
                        const pctSpan = document.createElement('span');
                        pctSpan.className = 'sr-txt-meta';
                        pctSpan.textContent = `  (${h.percent})`;
                        hOpt.appendChild(pctSpan);
                        frag.appendChild(hOpt);
                    });
                }
            }

            resultsBox.appendChild(frag);
            resultsBox.style.display = 'block';

            const firstOpt = resultsBox.options[0];
            const rowH = (firstOpt && firstOpt.offsetHeight) || Math.ceil(parseFloat(getComputedStyle(resultsBox).fontSize || '13.33') * 1.35) || 18;
            const visibleRows = Math.max(2, Math.min(12, resultsBox.options.length));
            resultsBox.style.height = (visibleRows * rowH) + 'px';

            if ($("#content") && $("#search")) {
                const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
                resultsBox.style.maxWidth = maxW + 'px';
            }
            resultsBox.style.left = `-${resultsBox.offsetWidth}px`;
            resultsBox.selectedIndex = -1;
            if (preserveScroll) resultsBox.scrollTop = prevScrollTop;
        }

        window._currentResultMap = resultMap;
        sfRefreshBar(kw, {
            txtHits: _txtState.totalHits,
            txtGroups: groups.length,
            groupUnit: _txtState.groupUnit,
            error: _txtState.error
        });
    }

    function showTxtResults(res, keyword) {
        _txtState = {
            keyword: keyword || '',
            totalHits: (res && res.totalHits) || 0,
            shownHits: (res && res.shownHits) || 0,
            groupUnit: (res && res.groupUnit) || '节',
            groups: (res && Array.isArray(res.groups)) ? res.groups : [],
            error: (res && res.error) || '',
            expanded: new Set(),
            activeHitIndex: -1
        };
        renderTxtResults({ preserveScroll: false });
    }

    function onScopeChange(scope, provider) {
        const inp = $("#searchInput");
        if (inp) {
            inp.placeholder = scope === 'txt'
                ? `搜本书..`
                : 'search..';
        }
        _txtState = { keyword: '', totalHits: 0, shownHits: 0, groupUnit: '节', groups: [], error: '', expanded: new Set(), activeHitIndex: -1 };
        const bar = document.getElementById('sf-bar');
        if (bar) {
            const scopeBtn = bar.querySelector('#sf-scope');
            if (scopeBtn) {
                scopeBtn.hidden = !provider;
                scopeBtn.textContent = scope === 'txt' ? '本书' : '全站';
                scopeBtn.classList.toggle('is-txt', scope === 'txt');
            }
        }
    }

    function updateSearchResults(results, keyword) {
        const kwKey = pageOverlayKey(keyword);
        if (kwKey !== window._sfLastKw) {
            window._sfLastKw = kwKey;
            const s = sfState();
            if (s.ymOff.length > 0) s.ymOff = [];
        }

        window._baseRenderedResults = results;
        results = engine.applyCommentOverlay(engine.applyPageOverlay(results, keyword), keyword);

        const sf = sfApply(results);
        results = sf.list;
        const adsMode = isAdsQuery(keyword);

        window._currentResultMap = new Map(results.map(r => [r.path, r]));
        window._currentRenderedKeyword = keyword || "";

        const resultsBox = $('#searchResults');
        if (!resultsBox) return;
        resultsBox.innerHTML = '';

        if (results.length === 0) {
            resultsBox.style.display = "none";
        } else {
            let markedUrls = new Set();
            try {
                if (iframes.side && iframes.side.contentWindow && iframes.side.contentWindow.MarkSystem) {
                    markedUrls = iframes.side.contentWindow.MarkSystem.urls;
                }
            } catch (e) {
                console.warn("无法穿透获取 Mark 系统状态", e);
            }

            const fragment = document.createDocumentFragment();

            results.forEach(result => {
                const option = document.createElement('div');
                option.className = 'sr-opt';
                option.setAttribute('role', 'option');

                const isPrivate = (result.localOnly === true || result.info === "localOnly");
                const title = result.type === "html" ? result.title.replace(/\.html$/, '') : result.title;
                const countStr = (result.commentOnly || adsMode) ? "" : ` [${result.count}]`;
                const commentStr = adsMode
                    ? (result.viaComment ? " [💬]" : "")
                    : (result.commentHits ? ` [💬 ${result.commentHits}]` : "");

                const prefix = isPrivate ? (store.online_flag === "1" ? "🔒 " : "🔓 ") : "";
                if (prefix) option.appendChild(document.createTextNode(prefix));

                let matchTitle = title;
                if (result.type !== "html") {
                    const dotIdx = title.lastIndexOf('.');
                    if (dotIdx > 0) matchTitle = title.slice(0, dotIdx);
                }
                const titleRanges = engine.computeTitleMatchRanges(matchTitle, keyword);
                if (titleRanges.length === 0) {
                    option.appendChild(document.createTextNode(title));
                } else {
                    const chars = Array.from(title);
                    let cursor = 0;
                    for (const [s, e, n] of titleRanges) {
                        if (s > cursor) {
                            option.appendChild(document.createTextNode(chars.slice(cursor, s).join('')));
                        }
                        const mark = document.createElement('mark');
                        mark.className = `sr-hl ${searchHlTier(n) === 0 ? 'sr-hl-' : (searchHlTier(n) === 1 ? 'sr-hl-syn-' : 'sr-hl-syn2-')}${searchHlBucket(n)}`;
                        mark.textContent = chars.slice(s, e).join('');
                        option.appendChild(mark);
                        cursor = e;
                    }
                    if (cursor < chars.length) {
                        option.appendChild(document.createTextNode(chars.slice(cursor).join('')));
                    }
                }

                const suffix = `${countStr}${commentStr}`;
                if (suffix) option.appendChild(document.createTextNode(suffix));

                option.style.opacity = (isPrivate ? (store.online_flag === "1" ? 0.5 : 1) : 1);
                option.dataset.path = result.path;
                option.dataset.type = result.type;
                if (isPrivate) option.dataset.localOnly = "true";
                if (markedUrls.has(result.path)) option.style.textDecoration = "line-through";

                fragment.appendChild(option);
            });

            resultsBox.appendChild(fragment);
            resultsBox.style.display = "block";

            const firstOpt = resultsBox.options[0];
            const rowH = (firstOpt && firstOpt.offsetHeight) || Math.ceil(parseFloat(getComputedStyle(resultsBox).fontSize || '13.33') * 1.35) || 18;
            const visibleRows = Math.max(2, Math.min(10, resultsBox.options.length));
            resultsBox.style.height = (visibleRows * rowH) + "px";

            if ($("#content") && $("#search")) {
                const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
                resultsBox.style.maxWidth = maxW + "px";
            }

            resultsBox.style.left = `-${resultsBox.offsetWidth}px`;
            resultsBox.selectedIndex = -1;
        }

        sfRefreshBar(keyword, sf);
    }

    function processAndShowResults(results, keyword, options = {}) {
        const provisional = !!options.provisional;
        const fromCache = !!options.fromCache;
        const base = results || [];
        let finalResults = base.slice();

        let activeKw = keyword || store.keyword || "";
        if (!activeKw) {
            const inputEl = document.getElementById("searchInput");
            activeKw = inputEl ? inputEl.value.trim() : "";
        }

        let history = store.last_li_a;
        if (!Array.isArray(history)) history = history ? [history] : [];

        let currentIndex = -1;
        let isBilingualOpen = false;
        if (store.resource_type === "html" && history.length > 0) {
            const currentPath = history[0];
            const strippedPath = normalizeDocPath(currentPath);
            currentIndex = finalResults.findIndex(r => r.path === currentPath || normalizeDocPath(r.path) === strippedPath);
            try {
                const cdoc = iframes && iframes.content && iframes.content.contentDocument;
                isBilingualOpen = !!(cdoc && (cdoc.getElementById('zhText') || cdoc.getElementById('engText')));
            } catch (_) { }
        }

        if (activeKw !== "" && !isActionCommand(activeKw)) {
            if (!isAdsQuery(activeKw) && !provisional && !fromCache && !options.noCache) {
                engine.searchResultCache.set(activeKw, base, options.termSpecs || null);
            }
            if (currentIndex === -1 || isBilingualOpen) emitEvent('LOCAL_SEARCH_COUNT', activeKw, 'content');
        }

        if (currentIndex !== -1) {
            const currentItem = finalResults.splice(currentIndex, 1)[0];
            finalResults.unshift(currentItem);
            updateSearchResults(finalResults, activeKw);
            return;
        }

        updateSearchResults(finalResults, activeKw);
    }

    function rerenderSearchOverlay() {
        if (!window._baseRenderedResults) return;
        updateSearchResults(window._baseRenderedResults, window._currentRenderedKeyword);
    }

    function showSearchHistoryByTime() {
        const elSearchHistory = $("#searchHistory");
        if (!elSearchHistory) return;
        elSearchHistory.innerHTML = "";
        const history = [...(store.searchHistory || [])];
        if (history.length === 0) {
            elSearchHistory.style.display = "none";
            return;
        }
        elSearchHistory.style.display = "block";
        history.sort((a, b) => b.timestamp - a.timestamp);
        history.forEach(item => {
            elSearchHistory.appendChild(makeHistoryOption(item.keyword, true));
        });
        if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
    }

    async function updateAutocompleteSuggestions(val) {
        const seq = ++_autocompleteSeq;
        const elSearchHistory = $("#searchHistory");
        elSearchHistory.innerHTML = "";

        if (!val || val.trim() === "") {
            showSearchHistoryByTime();
            return;
        }

        const query = val.trim().toLowerCase();
        const suggestionMap = new Map();

        const history = store.searchHistory || [];
        history.forEach(item => {
            if (item.keyword.toLowerCase().includes(query)) {
                suggestionMap.set(item.keyword, { isHistory: true, ts: item.timestamp || 0 });
            }
        });

        try {
            const cacheKeys = await engine.searchCacheLRU.keys();
            if (seq !== _autocompleteSeq) return;
            cacheKeys.forEach(key => {
                if (typeof key !== 'string') return;
                const kw = engine.searchResultCache.stripKeyPrefix(key);
                if (kw && kw.toLowerCase().includes(query) && !suggestionMap.has(kw)) {
                    suggestionMap.set(kw, { isHistory: false, ts: 0 });
                }
            });
        } catch (e) {
            console.warn("读取缓存 Key 失败", e);
        }

        const rawList = Array.from(suggestionMap.entries()).map(([keyword, meta]) => ({
            keyword,
            lower: keyword.toLowerCase(),
            isHistory: meta.isHistory,
            ts: meta.ts
        }));
        rawList.sort((a, b) => b.keyword.length - a.keyword.length);

        const filteredSuggestions = [];
        for (const item of rawList) {
            if (item.lower === query) {
                filteredSuggestions.push(item);
                continue;
            }
            const isRedundant = filteredSuggestions.some(existing =>
                !item.isHistory && existing.lower.startsWith(item.lower)
            );
            if (!isRedundant) filteredSuggestions.push(item);
        }

        if (filteredSuggestions.length === 0) {
            elSearchHistory.style.display = "none";
            return;
        }

        filteredSuggestions.sort((a, b) => {
            const aEx = a.lower === query ? 1 : 0;
            const bEx = b.lower === query ? 1 : 0;
            if (aEx !== bEx) return bEx - aEx;
            const aPr = a.lower.startsWith(query) ? 1 : 0;
            const bPr = b.lower.startsWith(query) ? 1 : 0;
            if (aPr !== bPr) return bPr - aPr;
            if (a.isHistory !== b.isHistory) return a.isHistory ? -1 : 1;
            if (a.isHistory && a.ts !== b.ts) return b.ts - a.ts;
            return a.keyword.length - b.keyword.length;
        });

        elSearchHistory.style.display = "block";
        filteredSuggestions.forEach(item => {
            elSearchHistory.appendChild(makeHistoryOption(item.keyword, item.isHistory));
        });
        if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
    }

    function init() {
        if (_initialized) return;
        _initialized = true;

        const elSearchInput = $("#searchInput");
        const elSearchHistory = upgradeSearchHistoryBox($("#searchHistory"));
        const elSearchResults = upgradeSearchResultsBox($("#searchResults"));
        elSearchInput.setAttribute("autocomplete", "off");

        async function loadContent(selectedIndex) {
            const option = elSearchResults.options[selectedIndex];
            if (!option) return;

            if (option.dataset.type === 'txt-group') {
                const gIdx = Number(option.dataset.groupIndex);
                const group = _txtState.groups.find(g => g.groupIndex === gIdx);
                const provider = engine.getTxtProvider();
                if (!group) return;
                if (group.hits.length === 1 && provider && typeof provider.jumpTo === 'function') {
                    _txtState.activeHitIndex = group.hits[0].hitIndex;
                    provider.jumpTo(group.hits[0].hitIndex);
                    return;
                }
                if (_txtState.expanded.has(gIdx)) _txtState.expanded.delete(gIdx);
                else _txtState.expanded.add(gIdx);
                renderTxtResults({ preserveScroll: true });
                return;
            }

            if (option.dataset.type === 'txt-hit') {
                const hitIndex = Number(option.dataset.hitIndex);
                const provider = engine.getTxtProvider();
                _txtState.activeHitIndex = hitIndex;
                elSearchResults.querySelectorAll('.sr-txt-active').forEach(el => el.classList.remove('sr-txt-active'));
                option.classList.add('sr-txt-active');
                if (provider && typeof provider.jumpTo === 'function') provider.jumpTo(hitIndex);
                return;
            }

            if (store.online_flag === "1" && option.dataset.localOnly === "true") {
                alert("🔒 访问受限：仅限本地查阅。");
                return;
            }
            const activeKw = window._currentRenderedKeyword || (elSearchInput ? elSearchInput.value.trim() : "");
            if (activeKw && !isActionCommand(activeKw)) store.keyword = activeKw;

            const type = option.dataset.type;
            const path = option.dataset.path;
            if (typeof exitLightbox === 'function') exitLightbox();
            if (type == "html") emitEvent('#html a', path, 'side');
            else if (type == "image") emitEvent('#gallery a', path, 'side');
            else if (type == "video") emitEvent('#video a', path, 'side');
            else if (type == "pdf" || type == "epub" || type == "txt") emitEvent('#ebook a', path, 'side');
            else if (type == "audio") emitEvent('#audio a', path, 'side');
            emitEvent('show_current', null, 'side');
        }

        function clickOrChange(select, handler) {
            let isHandling = false;
            const trigger = (idx) => {
                if (isHandling || idx < 0) return;
                isHandling = true;
                handler(idx);
                setTimeout(() => { isHandling = false; }, 150);
            };
            if (select.tagName !== 'SELECT') {
                select.addEventListener('click', (e) => {
                    const opt = e.target.closest && e.target.closest('.sr-opt, .sh-opt');
                    if (!opt) return;
                    const idx = Array.prototype.indexOf.call(select.options, opt);
                    if (idx >= 0) {
                        select.selectedIndex = idx;
                        trigger(idx);
                    }
                });
                select.addEventListener('keydown', (e) => {
                    const opts = select.options;
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        elSearchInput.focus();
                        return;
                    }
                    if (!opts.length) return;
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        const cur = select.selectedIndex;
                        select.selectedIndex = cur < 0 ? 0 : (cur + 1) % opts.length;
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        const cur = select.selectedIndex;
                        select.selectedIndex = cur <= 0 ? opts.length - 1 : cur - 1;
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (select.selectedIndex >= 0) trigger(select.selectedIndex);
                    }
                });
                return;
            }
            const wrap = function () { trigger(this.selectedIndex); };
            const isMobile = /Mobi|Android/i.test(navigator.userAgent);
            if (isMobile) select.addEventListener('change', wrap);
            else {
                select.addEventListener('click', wrap);
                select.addEventListener('change', wrap);
            }
        }

        function initHistoryBox(status) {
            elSearchHistory.innerHTML = "";
            elSearchHistory.style.display = status === 1 ? "block" : "none";
        }

        function recordSearchHistory(keyword) {
            const kw = (keyword || "").trim();
            if (!kw || isActionCommand(kw)) return;
            const history = [...(store.searchHistory || [])];
            const i = history.findIndex(item => item.keyword === kw);
            if (i !== -1) history.splice(i, 1);
            history.unshift({ keyword: kw, timestamp: Date.now() });
            history.sort((a, b) => b.timestamp - a.timestamp);
            if (history.length > 100) history.length = 100;
            store.searchHistory = history;
        }

        let searchDebounceTimer = null;
        let composing = false;

        const scheduleSearch = (val, delay) => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                const trimmed = val.trim();
                if (isActionCommand(trimmed)) return;
                engine.search(trimmed);
                store.keyword = val;
            }, isAdsQuery(val) ? Math.max(delay, 450) : delay);
        };

        const onValueSettled = (val, delay = 150) => {
            const trimmed = val.trim();
            if (trimmed === "") {
                clearTimeout(searchDebounceTimer);
                engine.invalidateSearch();
                _autocompleteSeq++;
                window._txtStatus = '';
                const provider = engine.getTxtProvider();
                if (engine.isTxtScope() && provider && typeof provider.clearHighlights === 'function') {
                    provider.clearHighlights();
                }
                updateSearchResults([]);
                showSearchHistoryByTime();
                return;
            }
            if (isActionCommand(trimmed)) {
                clearTimeout(searchDebounceTimer);
                engine.invalidateSearch();
                _autocompleteSeq++;
                updateSearchResults([]);
                initHistoryBox(0);
                return;
            }

            engine.invalidateSearch();
            scheduleSearch(val, delay);

            initHistoryBox(1);
            updateAutocompleteSuggestions(val).catch(err => console.warn("联想渲染失败", err));
        };

        elSearchInput.addEventListener("compositionstart", function () {
            composing = true;
            clearTimeout(searchDebounceTimer);
        });
        elSearchInput.addEventListener("compositionend", function () {
            composing = false;
            onValueSettled(this.value, 0);
        });
        elSearchInput.addEventListener("input", function (e) {
            if (composing || e.isComposing) return;
            onValueSettled(this.value);
        });

        elSearchInput.addEventListener("focus", function () {
            if (this.value.trim() !== "") {
                updateAutocompleteSuggestions(this.value).catch(err => console.warn("联想渲染失败", err));
                return;
            }
            showSearchHistoryByTime();
            elSearchHistory.selectedIndex = -1;
        });

        elSearchInput.addEventListener("click", function () { this.select(); });

        elSearchInput.addEventListener("keydown", function (e) {
            if (composing || e.isComposing || e.keyCode === 229) return;
            const val = this.value.trim();
            if (e.key === "Escape") {
                const searchEl = document.getElementById('search');
                if (searchEl && searchEl.dataset.fsTemp === '1') {
                    delete searchEl.dataset.fsTemp;
                    searchEl.classList.add('hide');
                }
                elSearchInput.blur();
                initHistoryBox(0);
                return;
            }
            if (e.keyCode === 40 || e.keyCode === 13 || e.key === "Enter") {
                e.preventDefault();
                if (val === "@bomb" || val === "@rebirth") {
                    if (typeof runActionCommand === 'function') runActionCommand(val);
                    this.value = "";
                    initHistoryBox(0);
                    return;
                }
                const select = $("#searchResults");
                select.focus();
                select.selectedIndex = -1;
                recordSearchHistory(val);
            }
        });

        function refreshHistoryList() {
            const val = elSearchInput.value.trim();
            elSearchHistory.innerHTML = "";
            const history = store.searchHistory || [];
            if (val === "") {
                showSearchHistoryByTime();
            } else {
                const matchingHistory = history.filter(item =>
                    item.keyword.startsWith(val) || item.keyword.includes(val)
                );
                if (matchingHistory.length === 0) {
                    showSearchHistoryByTime();
                } else {
                    matchingHistory.forEach(item => {
                        elSearchHistory.appendChild(makeHistoryOption(item.keyword, true));
                    });
                    if (typeof elSearchHistory.syncHeight === 'function') elSearchHistory.syncHeight();
                }
            }
        }

        elSearchHistory.addEventListener("contextmenu", async function (e) {
            const optEl = e.target.closest && e.target.closest('.sh-opt');
            if (optEl || e.target.tagName === 'OPTION') {
                e.preventDefault();
                e.stopPropagation();
                const keywordToDelete = (optEl || e.target).text;

                let history = [...(store.searchHistory || [])];
                const newHistory = history.filter(item => item.keyword !== keywordToDelete);
                if (newHistory.length !== history.length) store.searchHistory = newHistory;

                await engine.searchResultCache.remove(keywordToDelete, { allVariants: true });

                const currentVal = $("#searchInput").value.trim();
                if (currentVal !== "") await updateAutocompleteSuggestions(currentVal);
                else refreshHistoryList();
            }
        });
        elSearchHistory.title = "右击删除";

        clickOrChange(elSearchHistory, function (index) {
            elSearchInput.value = elSearchHistory.options[index].text;
            if (!document.body.classList.contains('touchpad-active')) elSearchInput.focus();
            const e = elSearchInput.value;
            engine.search(e);
            store.keyword = e;
        });
        clickOrChange(elSearchResults, function (index) {
            loadContent(index);
            initHistoryBox(0);
            recordSearchHistory(elSearchInput.value);
        });

        $("#clear").addEventListener("click", function () {
            elSearchInput.value = "";
            engine.invalidateSearch();
            window._txtStatus = '';
            _txtState = { keyword: '', totalHits: 0, shownHits: 0, groupUnit: '节', groups: [], error: '', expanded: new Set(), activeHitIndex: -1 };
            const provider = engine.getTxtProvider();
            if (provider && typeof provider.clearHighlights === 'function') provider.clearHighlights();
            updateSearchResults([]);
            initHistoryBox(0);
            store.keyword = "";
            store.jump_from_search = "0";
            store.jump_from_search_ex = "0";
            emitEvent('DESTROY_HIGHLIGHT', null, 'content');
            const searchEl = document.getElementById('search');
            if (searchEl && searchEl.dataset.fsTemp === '1') {
                delete searchEl.dataset.fsTemp;
                searchEl.classList.add('hide');
            }
        });

        const layoutObserver = new ResizeObserver(() => {
            if (!$("#content") || !$("#search") || !$("#searchResults")) return;
            const maxW = Math.max(0, $("#content").clientWidth - $("#search").offsetWidth - 10);
            $("#searchResults").style.maxWidth = maxW + "px";
            $("#searchResults").style.left = (0 - $("#searchResults").offsetWidth) + "px";
            sfLayout();
        });
        if ($("#content")) layoutObserver.observe($("#content"));

        updateSearchResults([]);
        $("#search").style.right = ($("#side").offsetWidth + 4) + "px";

        const previewCtrl = createSearchPreviewController({
            store,
            elSearchResults,
            elSearchInput,
            requestSnippets: engine.requestSnippets
        });

        window.addEventListener('blur', () => {
            previewCtrl.destroyMediaPreview();
            initHistoryBox(0);
        });
        document.addEventListener('mousedown', (e) => {
            const searchWrap = document.getElementById('search');
            if (searchWrap && !searchWrap.contains(e.target)) initHistoryBox(0);
        });

        const handleMiddleClick = (e) => {
            if (e.button === 1) {
                e.preventDefault();
                const clearBtn = document.getElementById('clear');
                if (clearBtn) clearBtn.click();
                previewCtrl.destroyMediaPreview();
            }
        };
        elSearchResults.addEventListener('mousedown', handleMiddleClick);
        elSearchHistory.addEventListener('mousedown', handleMiddleClick);
        elSearchInput.addEventListener('mousedown', handleMiddleClick);
    }

    engine.setUIHandlers({
        showResults: processAndShowResults,
        showTxtResults,
        updateResults: updateSearchResults,
        rerenderOverlay: rerenderSearchOverlay,
        paintStatus: sfPaintStatus,
        onScopeChange
    });

    return {
        init,
        updateSearchResults,
        processAndShowResults,
        rerenderSearchOverlay,
        sfPaintStatus,
        sfLayout
    };
}
