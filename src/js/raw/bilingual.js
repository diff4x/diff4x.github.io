(function () {
    if(store.online_flag === "1") {
        document.getElementById('control-panel').classList.add("hidden")
    } else {
        const zhText = document.getElementById('zhText');
        const engText = document.getElementById('engText');
        const toggleBtn = document.getElementById('toggleBtn');
        const saveBtn = document.getElementById('saveBtn');
        const statusBar = document.getElementById('status-bar');
        const lockScreen = document.getElementById('lock-screen');
        const lockMsg = document.getElementById('lock-msg');

        const DOC_KEY = document.title.trim();
        let insertMode = false;

        const DB_NAME = "AlignDrafts";
        const STORE_NAME = "draft_texts";

        function initDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = e => {
                    if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                        e.target.result.createObjectStore(STORE_NAME);
                    }
                };
                req.onsuccess = e => resolve(e.target.result);
                req.onerror = e => reject(e);
            });
        }

        async function saveDraft(text) {
            const db = await initDB();
            return new Promise(resolve => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                tx.objectStore(STORE_NAME).put(text, DOC_KEY);
                tx.oncomplete = () => {
                    const now = new Date();
                    statusBar.textContent = `已自动暂存 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
                    resolve();
                };
            });
        }

        async function loadDraft() {
            const db = await initDB();
            return new Promise(resolve => {
                const tx = db.transaction(STORE_NAME, "readonly");
                const req = tx.objectStore(STORE_NAME).get(DOC_KEY);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            });
        }

        async function destroyDraft() {
            const db = await initDB();
            return new Promise(resolve => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                tx.objectStore(STORE_NAME).delete(DOC_KEY);
                tx.oncomplete = () => resolve();
            });
        }

        let debounceTimer;
        function triggerAutoSave() {
            clearTimeout(debounceTimer);
            statusBar.textContent = "检测到输入，等待保存...";
            debounceTimer = setTimeout(() => {
                saveDraft(zhText.innerText);
            }, 2000);
        }

        function syncHeight() {
            zhText.style.height = "auto";
            const targetHeight = Math.max(engText.clientHeight, zhText.scrollHeight);
            engText.style.height = targetHeight + "px";
            zhText.style.height = targetHeight + "px";
        }

        toggleBtn.addEventListener('click', () => {
            insertMode = !insertMode;
            toggleBtn.textContent = "快速换行: " + (insertMode ? "开" : "关");

            if (insertMode) {
                toggleBtn.style.background = "#e74c3c";
                toggleBtn.style.color = "white";
                toggleBtn.style.borderColor = "#e74c3c";
            } else {
                toggleBtn.style.background = "";
                toggleBtn.style.color = "";
                toggleBtn.style.borderColor = "";
            }
        });

        zhText.addEventListener('input', () => {
            syncHeight();
            triggerAutoSave();
        });

        window.addEventListener('resize', syncHeight);

        zhText.addEventListener('click', () => {
            if (!insertMode) return;
            const sel = window.getSelection();
            if (sel.rangeCount > 0 && sel.isCollapsed && zhText.contains(sel.anchorNode)) {
                insertAtCursor(zhText, "\n  ");
                syncHeight();
                triggerAutoSave();
            }
        });

        function insertAtCursor(field, text) {
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            sel.removeAllRanges();
            sel.addRange(range);
        }

        async function bootstrap() {
            try {
                const draftText = await loadDraft();
                if (draftText !== undefined && draftText !== null && draftText !== zhText.innerText) {
                    lockMsg.textContent = "发现本地草稿，正在回填反序列化...";
                    await new Promise(r => setTimeout(r, 200));
                    zhText.innerText = draftText;
                    statusBar.textContent = "已恢复上次草稿";
                } else {
                    statusBar.textContent = "就绪 (暂无草稿)";
                }
            } catch (e) {
                console.error("IDB 读取失败", e);
            } finally {
                syncHeight();
                lockScreen.style.display = "none";
            }
        }

        bootstrap();

        saveBtn.addEventListener('click', () => {
            clearTimeout(debounceTimer);

            const htmlClone = document.documentElement.cloneNode(true);

            const clonedZhText = htmlClone.querySelector('#zhText');
            clonedZhText.textContent = zhText.innerText;

            htmlClone.querySelector('#engText').style.height = '';
            clonedZhText.style.height = '';
            
            const clonedToggleBtn = htmlClone.querySelector('#toggleBtn');
            if (clonedToggleBtn) {
                clonedToggleBtn.textContent = "快速换行: 关";
                clonedToggleBtn.style.background = "";
                clonedToggleBtn.style.color = "";
                clonedToggleBtn.style.borderColor = "";
            }

            const garbageSelectors = [
                '#bar',
                '#gotop',
                '.pinyin-tooltip',
                '#giscus-popup',
                'link[href*="content.css"]'
            ];
            garbageSelectors.forEach(selector => {
                htmlClone.querySelectorAll(selector).forEach(el => el.remove());
            });

            const htmlString = "<!DOCTYPE html>\n" + htmlClone.outerHTML;
            const textarea = document.createElement('textarea');
            textarea.value = htmlString;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);

            const safeTitle = document.title.trim() || "Unknown";
            const protocolUrl = localStorage.getItem("protocol_name").replace(/"/g, '') + `://5{` + encodeURIComponent(safeTitle);
            window.location.href = protocolUrl;

            destroyDraft();

            lockScreen.style.display = "flex";
            lockScreen.innerHTML = "⌛固化中..";
        });
    }
})();