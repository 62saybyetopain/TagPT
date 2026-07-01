// modules/sync_engine.js
import { ClientSchema, RecordSchema, TagSchema, ColdDirectorySchema } from '../schemas/models.js';
import { executeWrite, getAllRecords, getRecord, STORES } from '../database/idb_client.js';

// ─── SystemLock 解耦（裁決：透過 CustomEvent，不 import dispatcher） ──────────
const lock   = (msg, onCancel) => window.dispatchEvent(new CustomEvent('app:lock', { detail: { msg, onCancel } }));
const unlock = () => window.dispatchEvent(new CustomEvent('app:unlock'));

// ─── Google Drive 備份 ────────────────────────────────────────────────────────
// GIS Token Client 採隱式授權流程（Implicit Flow），純前端無後端可安全使用；
// token 存於模組變數而非 localStorage，避免敏感憑證被持久化至本地儲存。
const _GC_ID = '89111873265-1848u7h9e5kgr5o0d3qqpbr0oie41u1d.apps.googleusercontent.com';
const _DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const _BACKUP_FILENAME = 'physio-backup.json';
let _accessToken = null;

const _getAccessToken = () => new Promise((resolve, reject) => {
    if (_accessToken) return resolve(_accessToken);
    const client = google.accounts.oauth2.initTokenClient({
        client_id: _GC_ID,
        scope: _DRIVE_SCOPE,
        callback: (res) => {
            if (res.error) return reject(new Error(`Google 授權失敗: ${res.error}`));
            _accessToken = res.access_token;
            // access token 有效期 1 小時，提前 5 分鐘清除強制下次重新授權
            setTimeout(() => { _accessToken = null; }, 55 * 60 * 1000);
            resolve(_accessToken);
        }
    });
    client.requestAccessToken();
});

const _findBackupFileId = async (token) => {
    const q = encodeURIComponent(`name='${_BACKUP_FILENAME}' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Drive 查詢失敗: ${res.status}`);
    const data = await res.json();
    return data.files?.[0]?.id || null;
};

export const driveBackup = async () => {
    lock('正在備份至 Google Drive...');
    try {
        const token = await _getAccessToken();
        const payload = {};
        for (const name of SCOPE_STORES.full) {
            payload[name] = await getAllRecords(name);
        }

        const fileId = await _findBackupFileId(token);
        const meta = JSON.stringify({ name: _BACKUP_FILENAME, mimeType: 'application/json' });
        const body = new FormData();
        body.append('metadata', new Blob([meta], { type: 'application/json' }));
        body.append('file',     new Blob([JSON.stringify(payload)], { type: 'application/json' }));

        // 已有舊檔用 PATCH 覆寫，首次用 POST 新建，維持 Drive 內永遠只有一個備份檔
        const url = fileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
        const res = await fetch(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body
        });
        if (!res.ok) throw new Error(`Drive 寫入失敗: ${res.status}`);
        alert('備份成功 ✓');
    } catch (err) {
        if (err.message?.includes('401')) _accessToken = null;
        alert(`[備份失敗] ${err.message}`);
    } finally {
        unlock();
    }
};

export const driveRestore = async () => {
    const confirmed = _showRedConfirm('將從 Google Drive 還原並完全覆蓋目前資料，此操作無法復原。確定繼續？');
    if (!confirmed) return;

    lock('正在從 Google Drive 還原...');
    try {
        const token = await _getAccessToken();
        const fileId = await _findBackupFileId(token);
        if (!fileId) throw new Error('找不到備份檔，請先在電腦端執行至少一次備份');

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`Drive 讀取失敗: ${res.status}`);

        const rawData = await res.text();
        // 直接複用現有 importJSON('full') 邏輯，確保冷資料比對與 Schema 驗證行為一致
        await importJSON(rawData, 'full');
    } catch (err) {
        if (err.message?.includes('401')) _accessToken = null;
        alert(`[還原失敗] ${err.message}`);
    } finally {
        unlock();
    }
};

// ─── Store 組合定義 ───────────────────────────────────────────────────────────
const SCOPE_STORES = {
    clients:  [STORES.CLIENTS, STORES.RECORDS],
    tags:     [STORES.TAGS],
    full:     [STORES.CLIENTS, STORES.RECORDS, STORES.TAGS, STORES.COLD_DIRECTORY]
};

let _currentPeerId = '';
const _refreshPeerId = () => {
    _currentPeerId = Math.floor(100000 + Math.random() * 900000).toString();
    const idDisplay = document.getElementById('p2p-sender-id');
    if (idDisplay) idDisplay.textContent = _currentPeerId;
};

// ─── 設定頁入口（UI 骨架綁定） ───────────────────────────────────────────────

export const loadSettings = () => {
    _refreshPeerId(); // 方案確認：進入設定頁時立刻生成並顯示 ID，讓使用者在點擊傳送前就能看到並告知接收方。

    // 返回按鈕
    document.getElementById('btn-back-dashboard')?.addEventListener('click', () => {
        window.location.hash = '#dashboard';
    });

    // 匯出按鈕
    document.getElementById('btn-export-clients')?.addEventListener('click', () => exportJSON('clients'));
    document.getElementById('btn-export-tags')?.addEventListener('click',   () => exportJSON('tags'));
    document.getElementById('btn-export-full')?.addEventListener('click',   () => exportJSON('full'));

    // 匯入按鈕（觸發 file input）
    document.getElementById('btn-import-clients')?.addEventListener('click', () => {
        _triggerFileInput((data) => importJSON(data, 'clients'));
    });
    document.getElementById('btn-import-tags')?.addEventListener('click', () => {
        _triggerFileInput((data) => importJSON(data, 'tags'));
    });
    document.getElementById('btn-import-full')?.addEventListener('click', () => {
        _triggerFileInput((data) => importJSON(data, 'full'));
    });

    // P2P 按鈕
    document.getElementById('btn-p2p-send-clients')?.addEventListener('click', () => startP2PSend('clients'));
    document.getElementById('btn-p2p-send-tags')?.addEventListener('click',   () => startP2PSend('tags'));
    document.getElementById('btn-p2p-send-full')?.addEventListener('click',   () => startP2PSend('full'));
    document.getElementById('btn-p2p-receive')?.addEventListener('click',     () => startP2PReceive());

    // Google Drive 備份還原
    document.getElementById('btn-drive-backup')?.addEventListener('click', driveBackup);
    document.getElementById('btn-drive-restore')?.addEventListener('click', driveRestore);

    // 冷資料匯出
    document.getElementById('btn-cold-export')?.addEventListener('click', () => {
        if (!dateInput?.value) {
            alert('[錯誤] 請選擇冷資料截止日期');
            return;
        }
        exportColdData(dateInput.value);
    });
};

// ─── JSON 匯出 ────────────────────────────────────────────────────────────────

export const exportJSON = async (scope) => {
    const storeNames = SCOPE_STORES[scope];
    if (!storeNames) throw new Error(`[SYNC_ERROR] 非法匯出範圍: "${scope}"`);

    const confirmed = _showRedConfirm('即將匯出資料，請確認。');
    if (!confirmed) return;

    lock();
    try {
        const payload = {};
        for (const name of storeNames) {
            payload[name] = await getAllRecords(name);
        }
        _downloadJSON(payload, `physio-${scope}-${Date.now()}.json`);
    } catch (err) {
        alert(`[匯出失敗] ${err.message}`);
        throw err;
    } finally {
        unlock();
    }
};

// ─── JSON 匯入 ────────────────────────────────────────────────────────────────

export const importJSON = async (rawData, scope) => {
    const storeNames = SCOPE_STORES[scope];
    if (!storeNames) throw new Error(`[SYNC_ERROR] 非法匯入範圍: "${scope}"`);

    const confirmed = _showRedConfirm('匯入將完全覆蓋現有資料，此操作無法復原。確定繼續？');
    if (!confirmed) return;

    lock();
    try {
        const parsed = _parseJSON(rawData);
        const coldIds = await _getColdIds();

        await executeWrite(storeNames, (stores) => {
            storeNames.forEach(name => stores[name].clear());

            // clients：逐筆過濾冷資料 ID（裁決 #7 JSON 匯入需比對冷資料）
            if (parsed[STORES.CLIENTS]) {
                const hotClients = parsed[STORES.CLIENTS].filter(c => !coldIds.has(c.id));
                if (hotClients.length < parsed[STORES.CLIENTS].length) {
                    console.warn(`[SYNC] 已跳過 ${parsed[STORES.CLIENTS].length - hotClients.length} 筆冷資料個案`);
                }
                hotClients.forEach(c => stores[STORES.CLIENTS].put(ClientSchema(c)));
            }

            if (parsed[STORES.RECORDS]) {
                // 只匯入 clientId 存在於本次匯入熱個案的紀錄
                const hotClientIds = new Set(
                    (parsed[STORES.CLIENTS] || [])
                        .filter(c => !coldIds.has(c.id))
                        .map(c => c.id)
                );
                parsed[STORES.RECORDS]
                    .filter(r => hotClientIds.has(r.clientId))
                    .forEach(r => stores[STORES.RECORDS].put(RecordSchema(r)));
            }

            if (parsed[STORES.TAGS]) {
                parsed[STORES.TAGS].forEach(t => stores[STORES.TAGS].put(TagSchema(t)));
            }

            if (parsed[STORES.COLD_DIRECTORY]) {
                parsed[STORES.COLD_DIRECTORY].forEach(e =>
                    stores[STORES.COLD_DIRECTORY].put(ColdDirectorySchema(e))
                );
            }
        });

        alert('匯入成功');
        window.location.hash = '#dashboard';
    } catch (err) {
        alert(`[匯入失敗] ${err.message}`);
        throw err;
    } finally {
        unlock();
    }
};

// ─── 冷資料匯出 ───────────────────────────────────────────────────────────────

export const exportColdData = async (cutoffDate) => {
    if (!cutoffDate) throw new Error('[SYNC_ERROR] exportColdData 缺少截止日期');

    const confirmed = _showRedConfirm(
        `即將匯出並永久刪除 ${cutoffDate} 以前的個案資料。此操作無法復原，確定繼續？`
    );
    if (!confirmed) return;

    lock();
    try {
        const allClients = await getAllRecords(STORES.CLIENTS);
        const coldClients = allClients.filter(c => c.lastServiceDate <= cutoffDate);

        if (coldClients.length === 0) {
            alert('沒有符合條件的冷資料個案');
            return;
        }

        const coldIds = new Set(coldClients.map(c => c.id));
        const allRecords = await getAllRecords(STORES.RECORDS);
        const coldRecords = allRecords.filter(r => coldIds.has(r.clientId));

        // 打包匯出
        const payload = { clients: coldClients, records: coldRecords };
        _downloadJSON(payload, `physio-cold-${cutoffDate}.json`);

        // _downloadJSON 是同步的 a.click()，無法確認瀏覽器是否真正完成儲存；
        // 要求使用者主動確認檔案已存在裝置後才執行不可逆刪除，為純前端環境下的最小有效防護
        const downloadConfirmed = window.confirm(
            `請確認檔案「physio-cold-${cutoffDate}.json」已成功下載至您的裝置。\n確認後將永久刪除這 ${coldClients.length} 筆個案的熱資料。`
        );
        if (!downloadConfirmed) return;

        // 同一 Transaction：刪熱資料 + 寫冷目錄
        await executeWrite(
            [STORES.CLIENTS, STORES.RECORDS, STORES.COLD_DIRECTORY],
            (stores) => {
                coldClients.forEach(c => {
                    stores[STORES.CLIENTS].delete(c.id);
                    stores[STORES.COLD_DIRECTORY].put(ColdDirectorySchema({ id: c.id }));
                });
                coldRecords.forEach(r => stores[STORES.RECORDS].delete(r.id));
            }
        );

        alert(`已匯出並封存 ${coldClients.length} 筆冷資料個案`);
        window.location.hash = '#dashboard';
    } catch (err) {
        alert(`[冷資料匯出失敗] ${err.message}`);
        throw err;
    } finally {
        unlock();
    }
};

// ─── P2P 發送 ─────────────────────────────────────────────────────────────────

export const startP2PSend = async (scope) => {
    const storeNames = SCOPE_STORES[scope];
    if (!storeNames) throw new Error(`[SYNC_ERROR] 非法 P2P 範圍: "${scope}"`);

    const confirmed = _showRedConfirm('即將透過 P2P 傳送資料，對方將完全覆蓋其本地資料，確定繼續？');
    if (!confirmed) return;

    try {
            const payload = {};
            for (const name of storeNames) {
                payload[name] = await getAllRecords(name);
            }

            let peer = null;
            let timeout = null;

            await new Promise((resolve, reject) => {
                const onCancel = () => {
                    if (timeout) clearTimeout(timeout);
                    if (peer) peer.destroy();
                    reject(new Error('已取消傳送操作'));
                };

                lock(`等待接收方連線...\n您的發送方 ID：${_currentPeerId}`, onCancel);

                peer = new Peer(_currentPeerId); // 方案確認：使用載入頁面時已生成好的 ID，確保 UI 顯示與底層連線使用的是同一個。
                timeout = setTimeout(() => {
                    peer.destroy();
                    reject(new Error('等待連線超時 (60秒)，請檢查網路或重試'));
                }, 60000); 

                peer.on('open', () => {

                peer.on('connection', (conn) => {
                    peer.disconnect(); // 建立連線後立即從公網目錄隱身，阻絕第三方惡意連線
                    // PeerJS 在 peer.on('connection') 觸發時連線已開啟，conn.on('open') 不會再觸發；
                    // 以 conn.open 判斷當前狀態，若尚未開啟則回退監聽，確保兩種時序都能送出資料
                    const doSend = () => {
                        conn.send(JSON.stringify(payload));
                        clearTimeout(timeout);
                        resolve();
                        setTimeout(() => peer.destroy(), 5000);
                    };
                    if (conn.open) {
                        doSend();
                    } else {
                        conn.on('open', doSend);
                    }
                });
            });

            peer.on('error', (err) => {
                clearTimeout(timeout);
                if (peer) peer.destroy();
                reject(new Error(`P2P 錯誤: ${err.message}`));
            });
        });

        alert('P2P 傳送成功');
    } catch (err) {
        alert(`[P2P 傳送狀態] ${err.message}`);
    } finally {
        unlock();
        _refreshPeerId(); // 方案確認：無論連線成功、失敗或手動取消，結束後強制刷新一組新 ID，避免下一次傳送時出現 PeerJS 狀態殘留的問題。
    }
};

// ─── P2P 接收 ─────────────────────────────────────────────────────────────────

export const startP2PReceive = async () => {
    const senderId = document.getElementById('p2p-sender-id-input')?.value.trim();
    if (!senderId) {
        alert('[錯誤] 請輸入發送方 ID');
        return;
    }

    const confirmed = _showRedConfirm('接收後將完全覆蓋本地資料，確定繼續？');
    if (!confirmed) return;

    try {
        let peer = null;
        let timeout = null;

        const rawData = await new Promise((resolve, reject) => {
            const onCancel = () => {
                if (timeout) clearTimeout(timeout);
                if (peer) peer.destroy();
                reject(new Error('已取消接收操作'));
            };

            lock('連線並接收資料中...', onCancel);

            peer = new Peer();
            timeout = setTimeout(() => {
                peer.destroy();
                reject(new Error('P2P 連線超時，請確認發送方 ID 正確且對方尚未取消'));
            }, 30000);

            peer.on('open', () => {
                const conn = peer.connect(senderId);
                conn.on('data', (data) => {
                    clearTimeout(timeout);
                    peer.destroy();
                    resolve(data);
                });
                conn.on('error', (err) => {
                    clearTimeout(timeout);
                    peer.destroy();
                    reject(new Error(`P2P 連線錯誤: ${err.message}`));
                });
            });

            peer.on('error', (err) => {
                clearTimeout(timeout);
                if (peer) peer.destroy();
                reject(new Error(`P2P 初始化錯誤: ${err.message}`));
            });
        });

        // P2P 接收：無條件全量覆蓋，不檢查冷資料 ID（裁決 #7）
        const parsed = _parseJSON(rawData);
        const storeNames = _inferScopeStores(parsed);

        await executeWrite(storeNames, (stores) => {
            storeNames.forEach(name => stores[name].clear());

            if (parsed[STORES.CLIENTS]) {
                parsed[STORES.CLIENTS].forEach(c => stores[STORES.CLIENTS].put(ClientSchema(c)));
            }
            if (parsed[STORES.RECORDS]) {
                parsed[STORES.RECORDS].forEach(r => stores[STORES.RECORDS].put(RecordSchema(r)));
            }
            if (parsed[STORES.TAGS]) {
                parsed[STORES.TAGS].forEach(t => stores[STORES.TAGS].put(TagSchema(t)));
            }
            if (parsed[STORES.COLD_DIRECTORY]) {
                parsed[STORES.COLD_DIRECTORY].forEach(e =>
                    stores[STORES.COLD_DIRECTORY].put(ColdDirectorySchema(e))
                );
            }
        });

        alert('P2P 接收成功，資料已同步');
        window.location.hash = '#dashboard';
    } catch (err) {
        alert(`[P2P 接收狀態] ${err.message}`);
    } finally {
        unlock();
    }
};

// ─── 工具函式 ─────────────────────────────────────────────────────────────────

const _parseJSON = (raw) => {
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        throw new Error('JSON 格式錯誤，無法解析');
    }
};

const _downloadJSON = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};

// inputId 參數已移除：函式從未使用傳入的 ID，始終動態建立 <input>，保留死參數會誤導維護者
const _triggerFileInput = (callback) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const text = await file.text();
        callback(text);
    });
    input.click();
};

const _showRedConfirm = (message) => {
    // 規格：操作前必須彈出紅色視窗二次確認
    // 目前以 window.confirm 作為最小有效實作
    // index.html 定義對應的紅色 <dialog> 後，此處替換為 dialog 呼叫
    return window.confirm(`⚠️ ${message}`);
};

const _getColdIds = async () => {
    const coldEntries = await getAllRecords(STORES.COLD_DIRECTORY);
    return new Set(coldEntries.map(e => e.id));
};

// 從 payload 推斷涉及的 store 範圍（P2P 接收時用）
const _inferScopeStores = (parsed) => {
    const names = [];
    if (parsed[STORES.CLIENTS] || parsed[STORES.RECORDS]) {
        names.push(STORES.CLIENTS, STORES.RECORDS);
    }
    if (parsed[STORES.TAGS]) names.push(STORES.TAGS);
    if (parsed[STORES.COLD_DIRECTORY]) names.push(STORES.COLD_DIRECTORY);
    if (names.length === 0) throw new Error('[SYNC_ERROR] P2P 接收到空白或無法識別的資料結構');
    return names;
};