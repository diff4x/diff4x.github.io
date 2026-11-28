/**
 * excerpts.js —— 个人摘抄本（ExcerptsDB 持久化与浮窗管理，运行于主线程，按需懒加载）
 */
import { makeDraggable, copyTextFallback } from './shared-utils.js';


// --- ExcerptsDB 数据层 ---

export const ExcerptsSys = {
    dbName: 'ExcerptsDB',
    storeName: 'books',
    _db: null,
    _initPromise: null,
    init: async function () {
        if (this._db) return this._db;
        if (this._initPromise) return this._initPromise;
        this._initPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                if (!e.target.result.objectStoreNames.contains(this.storeName)) {
                    e.target.result.createObjectStore(this.storeName);
                }
            };
            req.onsuccess = (e) => {
                const db = e.target.result;
                this._db = db;
                this._initPromise = null;
                db.onversionchange = () => {
                    db.close();
                    if (this._db === db) this._db = null;
                };
                db.onclose = () => {
                    if (this._db === db) this._db = null;
                };
                resolve(db);
            };
            req.onerror = () => {
                this._initPromise = null;
                reject(req.error);
            };
        });
        return this._initPromise;
    },
    close: function () {
        if (this._db) {
            try { this._db.close(); } catch (_) { }
            this._db = null;
        }
        this._initPromise = null;
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
            let keys = null;
            let vals = null;
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            keysReq.onsuccess = () => { keys = keysReq.result || []; };
            valsReq.onsuccess = () => { vals = valsReq.result || []; };
            tx.oncomplete = () => {
                const books = [];
                const len = Math.min(keys ? keys.length : 0, vals ? vals.length : 0);
                for (let i = 0; i < len; i++) {
                    const data = vals[i];
                    if (data) {
                        const count = Array.isArray(data.excerpts) ? data.excerpts.length : 0;
                        books.push({ name: keys[i], createdAt: data.createdAt, updatedAt: data.updatedAt, count });
                    }
                }
                resolve(books);
            };
            tx.onerror = () => reject(tx.error || keysReq.error || valsReq.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
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
                    if (!excerptsArray || excerptsArray.length === 0) {
                        store.delete(bookName);
                    } else {
                        record.excerpts = excerptsArray;
                        record.updatedAt = Date.now();
                        const putReq = store.put(record, bookName);
                        putReq.onerror = () => reject(putReq.error);
                    }
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

// --- 摘抄本浮窗 UI ---

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

            const ok = await copyTextFallback(textToCopy);
            if (ok) {
                this.openAndRefresh();
            } else {
                alert("写入剪贴板失败，请检查浏览器权限。");
            }
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
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;padding:6px 8px;";
            nameSpan.title = book.name;
            nameSpan.textContent = book.name;
            const countSpan = document.createElement('span');
            countSpan.style.cssText = "background:#f1f5f9; padding:1px 5px; border-radius:8px; font-size:10px; color:#64748b; font-weight:normal; flex-shrink:0;";
            countSpan.textContent = String(book.count);
            labelZone.append(nameSpan, countSpan);

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

            row.append(textarea, idLabel);
            zone.appendChild(row);
        });

        requestAnimationFrame(() => {
            zone.querySelectorAll('.exc-item-text').forEach(ta => {
                ta.style.height = '1px';
                ta.style.height = ta.scrollHeight + 'px';
            });
        });
    }
};

