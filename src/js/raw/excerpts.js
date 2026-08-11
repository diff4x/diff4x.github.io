/**
 * excerpts.js —— "摘抄笔记本" 功能。
 * 仅在用户触发 OPEN_EXCERPTS_NOTEBOOK / SAVE_EXCERPT 消息时才需要，
 * 由 index.js 按需动态 import。也被 deferred-features.js（备份/清档/恢复功能）
 * 静态引用，以便一并打成同一个懒加载 chunk。
 */

// 与 index.js 中的 $ / makeDraggable 同源的最小实现，
// 避免跨 chunk 传参，保持本模块可独立按需加载。
const $ = (selector) => document.querySelector(selector);

function makeDraggable(popupSelector, headerSelector) {
    const popup = $(popupSelector);
    const header = $(headerSelector);
    if (!popup || !header) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = popup.offsetLeft;
        initialTop = popup.offsetTop;
        popup.style.position = 'absolute';
        popup.style.margin = '0';
        popup.style.transform = 'translateX(0)';
        header.style.cursor = 'moving';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const scale = window._tpZoom || 1;
        const left = initialLeft + (e.clientX - startX) / scale;
        const top = initialTop + (e.clientY - startY) / scale;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    });
}

export const ExcerptsSys = {
    dbName: 'ExcerptsDB',
    storeName: 'books',
    init: async function () {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(this.storeName);
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        });
    },
    save: async function (bookName, text) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(bookName);

            getReq.onsuccess = () => {
                let record = getReq.result;
                const now = Date.now();
                if (!record) {
                    record = { createdAt: now, updatedAt: now, excerpts: [] };
                }
                const newId = record.excerpts.length > 0 ? record.excerpts[record.excerpts.length - 1].id + 1 : 1;
                record.excerpts.push({ id: newId, text: text, ts: now });
                record.updatedAt = now;
                const putReq = store.put(record, bookName);
                putReq.onerror = () => reject(putReq.error);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    getAllBooks: async function () {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.getAllKeys();
            req.onsuccess = async () => {
                const keys = req.result;
                const books = [];
                for (let key of keys) {
                    const data = await new Promise(res => {
                        const r = store.get(key);
                        r.onsuccess = () => res(r.result);
                    });
                    if (data) {
                        books.push({ name: key, createdAt: data.createdAt, updatedAt: data.updatedAt, count: data.excerpts.length });
                    }
                }
                resolve(books);
            };
            req.onerror = () => reject(req.error);
        });
    },
    getBookData: async function (bookName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(bookName);
            req.onsuccess = () => resolve(req.result || { excerpts: [] });
            req.onerror = () => reject(req.error);
        });
    },
    overwriteBook: async function (bookName, excerptsArray) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(bookName);
            getReq.onsuccess = () => {
                let record = getReq.result;
                if (record) {
                    record.excerpts = excerptsArray;
                    record.updatedAt = Date.now();
                    const putReq = store.put(record, bookName);
                    putReq.onerror = () => reject(putReq.error);
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    deleteBook: async function (bookName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(bookName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
};
export const ExcerptsUIManager = {
    currentBook: null,
    allBooksCache: [],
    sortConfig: { type: 'updated', asc: false },

    initPanel: function () {
        if (document.getElementById('excerpts-popup')) return;

        const html = `
        <div id="excerpts-popup" class="elastic-anim" style="display:none; position:absolute; top:10%; left:50%; transform:translateX(-50%); width:800px; max-width:90%; box-sizing:border-box; height:800px; background:#fff; border:1px solid #333; box-shadow:0 5px 20px rgba(0,0,0,0.3); z-index:10001; flex-direction:column; border-radius:4px; overflow:hidden;">
            <div id="excerpts-header" style="height:35px; background:#eee; cursor:move; display:flex; justify-content:space-between; align-items:center; padding:0 15px; flex-shrink:0; border-bottom:1px solid #ccc; user-select:none; font-size:14px; color:#333;">
                <span class="cl-title" style="color: red;">Excerpts</span>
                <div><button id="close-excerpts" class="cl-btn" style="margin-left: 10px; cursor: pointer; padding: 1px 6px;">Close</button></div>
            </div>
            
            <div style="flex:1; display:flex; overflow:hidden; background:#f8fafc;">
                <div style="width:240px; border-right:1px solid #e2e8f0; display:flex; flex-direction:column; padding:5px; gap:10px; flex-shrink:0; background:antiquewhite;">
                    <input type="text" id="exc-search" placeholder="搜索过滤键名..." style="width:100%; padding:6px 10px; border:1px solid #cbd5e1; box-sizing:border-box; outline:none; font-size:12px; background:#fff;">
                    <div style="display:flex; gap:6px;">
                        <button id="sort-create" style="flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #cbd5e1; border-radius:4px; cursor:pointer; color:#64748b;">创建时间</button>
                        <button id="sort-update" style="flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #10b981; border-radius:4px; cursor:pointer; font-weight:bold; color:#10b981;">修改时间 ▽</button>
                    </div>
                    <div id="exc-book-list" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:5px; margin-top:4px; padding-right:2px;"></div>
                </div>
                
                <div id="exc-records-zone" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; background:#fff;">
                    <div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px; letter-spacing:0.5px;">请在左侧选择一个摘抄薄查看明细</div>
                </div>
            </div>
            
            <div style="background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; align-items:center; justify-content:flex-end; flex-shrink:0;">
                <button id="exc-btn-save">应用修改</button>
                <button id="exc-btn-save-and-copy">应用修改然后复制</button>
            </div>
        </div>`;

        document.getElementById('stage').insertAdjacentHTML('beforeend', html);
        this.bindPanelEvents();
    },

    bindPanelEvents: function () {
        const popup = document.getElementById('excerpts-popup');
        const searchInput = document.getElementById('exc-search');

        makeDraggable("#excerpts-popup", "#excerpts-header");

        document.getElementById('close-excerpts').onclick = () => popup.style.display = "none";
        searchInput.oninput = () => this.renderLeftList();

        document.getElementById('sort-create').onclick = () => this.toggleSort('created');
        document.getElementById('sort-update').onclick = () => this.toggleSort('updated');

        document.getElementById('exc-btn-save').onclick = async () => {
            if (!this.currentBook) return alert("当前未选中任何摘抄表");

            const items = document.querySelectorAll('.exc-item-text');
            const updatedExcerpts = [];
            items.forEach(el => {
                const id = parseInt(el.dataset.id);
                const text = el.value.trim();
                if (text) {
                    updatedExcerpts.push({ id, text, ts: Date.now() });
                }
            });
            await ExcerptsSys.overwriteBook(this.currentBook, updatedExcerpts);

            const data = await ExcerptsSys.getBookData(this.currentBook);
            if (!data.excerpts || data.excerpts.length === 0) {
                this.openAndRefresh();
                return;
            }
        };

        document.getElementById('exc-btn-save-and-copy').onclick = async () => {
            if (!this.currentBook) return alert("当前未选中任何摘抄表");

            const items = document.querySelectorAll('.exc-item-text');
            const updatedExcerpts = [];
            items.forEach(el => {
                const id = parseInt(el.dataset.id);
                const text = el.value.trim();
                if (text) {
                    updatedExcerpts.push({ id, text, ts: Date.now() });
                }
            });
            await ExcerptsSys.overwriteBook(this.currentBook, updatedExcerpts);

            const data = await ExcerptsSys.getBookData(this.currentBook);
            if (!data.excerpts || data.excerpts.length === 0) {
                this.openAndRefresh();
                return;
            }

            const textToCopy = data.excerpts.map(e => e.text.trim()).join('\n\n\n');

            navigator.clipboard.writeText(textToCopy).then(() => {
                this.openAndRefresh();
            }).catch(() => {
                alert("写入剪贴板失败，请检查浏览器权限。");
            });
        };
    },

    toggleSort: function (type) {
        if (this.sortConfig.type === type) {
            this.sortConfig.asc = !this.sortConfig.asc;
        } else {
            this.sortConfig.type = type;
            this.sortConfig.asc = false;
        }

        const cBtn = document.getElementById('sort-create');
        const uBtn = document.getElementById('sort-update');
        cBtn.style.cssText = uBtn.style.cssText = "flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #cbd5e1; border-radius:4px; cursor:pointer; color:#64748b;";

        const activeBtn = type === 'created' ? cBtn : uBtn;
        activeBtn.style.cssText = "flex:1; padding:5px; font-size:11px; background:#fff; border:1px solid #10b981; color:#10b981; font-weight:bold; border-radius:4px; cursor:pointer;";
        activeBtn.textContent = (type === 'created' ? '创建时间 ' : '修改时间 ') + (this.sortConfig.asc ? '▲' : '▽');

        this.renderLeftList();
    },

    openAndRefresh: async function () {
        this.initPanel();

        const excPopup = document.getElementById('excerpts-popup');
        excPopup.style.display = "flex";

        excPopup.style.transform = 'none';
        const popupWidth = excPopup.offsetWidth || 800;
        excPopup.style.left = (window.innerWidth - popupWidth) / 2 + 'px';
        this.allBooksCache = await ExcerptsSys.getAllBooks();

        if (
            this.currentBook &&
            !this.allBooksCache.some(b => b.name === this.currentBook)
        ) {
            this.currentBook = null;
        }
        this.renderLeftList();

        if (this.currentBook) {
            await this.renderRightRecords();
        } else {
            document.getElementById('exc-records-zone').innerHTML = `
                <div style="
                    color:#94a3b8;
                    text-align:center;
                    margin-top:25vh;
                    font-size:13px;
                    letter-spacing:0.5px;
                ">
                    请在左侧选择一个摘抄薄查看明细
                </div>
            `;
        }
    },

    renderLeftList: function () {
        const listContainer = document.getElementById('exc-book-list');
        const filterKw = document.getElementById('exc-search').value.toLowerCase().trim();
        listContainer.innerHTML = '';

        let filtered = this.allBooksCache.filter(b => b.name.toLowerCase().includes(filterKw));

        filtered.sort((a, b) => {
            const field = this.sortConfig.type === 'created' ? 'createdAt' : 'updatedAt';
            return this.sortConfig.asc ? a[field] - b[field] : b[field] - a[field];
        });

        filtered.forEach(book => {
            const item = document.createElement('div');
            item.className = 'exc-book-item-row';
            item.style.cssText = `
                background:#fff; border:1px solid #e2e8f0;
                cursor:pointer; font-size:12px; display:flex; align-items:center;
                transition:all 0.15s; gap:6px; position:relative; overflow:hidden;
            `;
            if (this.currentBook === book.name) {
                item.style.borderColor = '#10b981';
                item.style.background = '#e8fbf3';
                item.style.fontWeight = 'bold';
            }

            const delAction = document.createElement('button');
            delAction.innerHTML = '✕';
            delAction.style.cssText = "background:transparent; border:none; color:#f87171; cursor:pointer; font-size:11px; padding:2px 4px; font-weight:bold; border-radius:3px; display:none; transition: all 0.15s; flex-shrink:0; line-height:1;";
            delAction.onmouseover = () => delAction.style.background = '#fee2e2';
            delAction.onmouseout = () => delAction.style.background = 'transparent';

            delAction.onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`此操作不可逆, 确定要删除 [${book.name}] 的相关摘抄吗？`)) {
                    await ExcerptsSys.deleteBook(book.name);
                    if (this.currentBook === book.name) this.currentBook = null;
                    this.openAndRefresh();
                }
            };

            const labelZone = document.createElement('div');
            labelZone.style.cssText = "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; justify-content:space-between; align-items:center; gap:6px;";
            labelZone.innerHTML = `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;padding:6px 8px;" title="${book.name}">${book.name}</span><span style="background:#f1f5f9; padding:1px 5px; border-radius:8px; font-size:10px; color:#64748b; font-weight:normal; flex-shrink:0;">${book.count}</span>`;

            const handleItemSelect = () => {
                this.currentBook = book.name;
                this.renderLeftList();
                this.renderRightRecords();
            };
            labelZone.onclick = handleItemSelect;

            item.onmouseenter = () => delAction.style.display = 'inline-block';
            item.onmouseleave = () => delAction.style.display = 'none';

            item.append(labelZone, delAction);
            listContainer.appendChild(item);
        });
    },

    renderRightRecords: async function () {
        const zone = document.getElementById('exc-records-zone');
        zone.innerHTML = '<div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px;">加载条目中...</div>';

        const data = await ExcerptsSys.getBookData(this.currentBook);
        zone.innerHTML = '';

        if (!data.excerpts || data.excerpts.length === 0) {
            zone.innerHTML = '<div style="color:#94a3b8; text-align:center; margin-top:25vh; font-size:13px;">当前摘抄薄空空如也</div>';
            return;
        }

        data.excerpts.forEach(item => {
            const row = document.createElement('div');
            row.style.cssText = "position:relative; display:flex; align-items:flex-start; transition:all 0.2s; padding:0; margin:0 0 2rem 0; border-bottom:1px dashed #cbd5e1;";

            const idLabel = document.createElement('div');
            idLabel.style.cssText = "width:32px; height:22px; background:#f1f5f9; color:#64748b; text-align:center; border-radius:4px; font-size:11px; font-weight:bold; font-family:monospace; flex-shrink:0; cursor:default; transition:all 0.2s; line-height:22px; margin: 3px 0px 0px 10px";
            idLabel.textContent = item.id;
            idLabel.title = "点击移除该记录";

            idLabel.onmouseenter = () => {
                idLabel.dataset.orig = idLabel.textContent;
                idLabel.textContent = "✕";
                idLabel.style.color = "#ef4444";
                idLabel.style.background = "#fee2e2";
                idLabel.style.cursor = "pointer";
            };
            idLabel.onmouseleave = () => {
                idLabel.textContent = idLabel.dataset.orig;
                idLabel.style.color = "#64748b";
                idLabel.style.background = "#f1f5f9";
                idLabel.style.cursor = "default";
            };
            idLabel.onclick = () => row.remove();

            const textarea = document.createElement('textarea');
            textarea.className = 'exc-item-text';
            textarea.dataset.id = item.id;
            textarea.value = item.text;

            textarea.style.cssText = "flex:1; border:none; border-radius:0; padding:0 0 0 15px; margin:0; font-size:14px; color:#334155; resize:none; overflow:hidden; outline:none; line-height:1.7; background:transparent; font-family:inherit; display:block;";

            textarea.onfocus = () => { row.style.borderBottomColor = '#10b981'; };
            textarea.onblur = () => { row.style.borderBottomColor = '#cbd5e1'; };

            const adjustHeight = function () {
                this.style.height = '1px';
                this.style.height = this.scrollHeight + 'px';
            };

            textarea.addEventListener('input', adjustHeight);
            setTimeout(() => adjustHeight.call(textarea), 0);

            row.append(textarea, idLabel);
            zone.appendChild(row);
        });
    }
};

