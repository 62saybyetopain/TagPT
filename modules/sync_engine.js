// modules/sync_engine.js
import { ClientSchema, RecordSchema, TagSchema, ColdDirectorySchema } from '../schemas/models.js';
import { executeWrite, getAllRecords, getRecord, STORES } from '../database/idb_client.js';

// ─── SystemLock 解耦（裁決：透過 CustomEvent，不 import dispatcher） ──────────
const lock   = () => window.dispatchEvent(new CustomEvent('app:lock'));
const unlock = () => window.dispatchEvent(new CustomEvent('app:unlock'));

// ─── Store 組合定義 ───────────────────────────────────────────────────────────
const SCOPE_STORES = {
    clients:  [STORES.CLIENTS, STORES.RECORDS],
    tags:     [STORES.TAGS],
    full:     [STORES.CLIENTS, STORES.RECORDS, STORES.TAGS, STORES.COLD_DIRECTORY]
};

// ─── 設定頁入口（UI 骨架綁定） ───────────────────────────────────────────────

export const loadSettings = () => {
    // 匯出按鈕
    document.getElementById('btn-export-clients')?.addEventListener('click', () => exportJSON('clients'));
    document.getElementById('btn-export-tags')?.addEventListener('click',   () => exportJSON('tags'));
    document.getElementById('btn-export-full')?.addEventListener('click',   () => exportJSON('full'));

    // 匯入按鈕（觸發 file input）
    document.getElementById('btn-import-clients')?.addEventListener('click', () => {
        _triggerFileInput('import-file-clients', (data) => importJSON(data, 'clients'));
    });
    document.getElementById('btn-import-tags')?.addEventListener('click', () => {
        _triggerFileInput('import-file-tags', (data) => importJSON(data, 'tags'));
    });
    document.getElementById('btn-import-full')?.addEventListener('click', () => {
        _triggerFileInput('import-file-full', (data) => importJSON(data, 'full'));
    });

    // P2P 按鈕
    document.getElementById('btn-p2p-send-clients')?.addEventListener('click', () => startP2PSend('clients'));
    document.getElementById('btn-p2p-send-tags')?.addEventListener('click',   () => startP2PSend('tags'));
    document.getElementById('btn-p2p-send-full')?.addEventListener('click',   () => startP2PSend('full'));
    document.getElementById('btn-p2p-receive')?.addEventListener('click',     () => startP2PReceive());

    // 冷資料匯出
    document.getElementById('btn-cold-export')?.addEventListener('click', () => {
        const dateInput = document.getElementById('cold-export-date');
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

    lock();
    try {
        const payload = {};
        for (const name of storeNames) {
            payload[name] = await getAllRecords(name);
        }

        const peer = new Peer(); // PeerJS 全域變數，來自 CDN
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                peer.destroy();
                reject(new Error('P2P 初始化超時，請檢查網路連線'));
            }, 30000);

            peer.on('open', (id) => {
                // 顯示發送方 ID 供接收方輸入
                const idDisplay = document.getElementById('p2p-sender-id');
                if (idDisplay) idDisplay.textContent = id;

                peer.on('connection', (conn) => {
                    // 方案確認：一旦有首個接收方成功建立連線，立即呼叫 disconnect() 斷開信令伺服器。
                    // 確保底層資料傳輸通道保持開啟，但徹底拒絕任何第三方的後續連線竊取資料，阻絕外流攻擊面。
                    peer.disconnect();

                    conn.on('open', () => {
                        conn.send(JSON.stringify(payload));
                        clearTimeout(timeout);
                        resolve();
                        // 資料傳輸屬非同步，延遲 5 秒後徹底銷毀實例釋放記憶體
                        setTimeout(() => peer.destroy(), 5000);
                    });
                });
            });

            peer.on('error', (err) => {
                clearTimeout(timeout);
                peer.destroy();
                reject(new Error(`P2P 錯誤: ${err.message}`));
            });
        });

        alert('P2P 傳送成功');
    } catch (err) {
        alert(`[P2P 傳送失敗] ${err.message}`);
        throw err;
    } finally {
        unlock();
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

    lock();
    try {
        const rawData = await new Promise((resolve, reject) => {
            const peer = new Peer();
            const timeout = setTimeout(() => {
                peer.destroy();
                reject(new Error('P2P 連線超時（30 秒），請確認發送方 ID 正確且對方已就緒'));
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
        alert(`[P2P 接收失敗] ${err.message}`);
        throw err;
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

const _triggerFileInput = (inputId, callback) => {
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