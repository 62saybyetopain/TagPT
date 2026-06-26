// modules/profile_controller.js
import { ClientSchema, getTodayLocalISO } from '../schemas/models.js';
import {
    executeWrite, getRecord, getAllRecords, queryByIndex, STORES
} from '../database/idb_client.js';

const PAGE_SIZE = 20;

// ─── 視圖工具 ─────────────────────────────────────────────────────────────────
const getAppContainer = () => {
    const el = document.getElementById('app');
    if (!el) throw new Error('[PROFILE_ERROR] 找不到 #app 容器');
    return el;
};

const cloneTemplate = (templateId) => {
    const tpl = document.getElementById(templateId);
    if (!tpl) throw new Error(`[PROFILE_ERROR] 找不到 template#${templateId}`);
    return tpl.content.cloneNode(true);
};

// ─── 首頁 Dashboard (M1) ─────────────────────────────────────────────────────

let _dashboardClients = []; // 搜尋結果快取（記憶體，不寫 DB）

/**
 * 渲染首頁個案列表。
 * @param {number} page - 頁碼，從 0 開始
 */
export const loadDashboard = async (page = 0) => {
    const container = getAppContainer();
    container.innerHTML = '';
    container.appendChild(cloneTemplate('tpl-dashboard'));

    _dashboardClients = await getAllRecords(STORES.CLIENTS);
    _renderDashboardList(_dashboardClients, page);

    // 搜尋綁定
    const searchInput = document.getElementById('dashboard-search');
    if (!searchInput) throw new Error('[PROFILE_ERROR] 找不到 #dashboard-search');
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = _dashboardClients.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.phone.toLowerCase().includes(q) ||
            c.lastServiceDate.includes(q)
        );
        _renderDashboardList(filtered, 0);
    });

    // 創建個案
    document.getElementById('btn-create-client')?.addEventListener('click', () => {
        _showCreateClientModal();
    });

    // 進入系統設定
    document.getElementById('btn-settings')?.addEventListener('click', () => {
        window.location.hash = '#settings';
    });
};

const _renderDashboardList = (clients, page) => {
    const listEl = document.getElementById('client-list');
    if (!listEl) throw new Error('[PROFILE_ERROR] 找不到 #client-list');

    const total = clients.length;
    const start = page * PAGE_SIZE;
    const pageItems = clients.slice(start, start + PAGE_SIZE);

    listEl.innerHTML = '';
    pageItems.forEach(client => {
        const row = document.createElement('div');
        row.className = 'client-row';
        row.dataset.clientId = client.id;
        row.innerHTML = `
            <span class="client-name">${_escHtml(client.name)}</span>
            <span class="client-contact">${_escHtml(client.phone)}</span>
            <span class="client-date">${_escHtml(client.lastServiceDate)}</span>
            <button class="btn-delete-client" data-id="${_escHtml(client.id)}">刪除</button>
        `;
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-client')) return;
            window.location.hash = `#client/${client.id}`;
        });
        row.querySelector('.btn-delete-client')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 方案確認：等待刪除完成，若回傳 true (使用者有確認刪除)，則直接重新呼叫 loadDashboard 以更新畫面，解決手動重整的問題。
            const isDeleted = await deleteClient(client.id);
            if (isDeleted) loadDashboard(page); 
        });
        listEl.appendChild(row);
    });

    _renderPagination('dashboard-pagination', total, page, (p) => {
        _renderDashboardList(clients, p);
    });
};

// ─── 個案檔案首頁 (M3) ───────────────────────────────────────────────────────

/**
 * 渲染單一個案檔案頁，含服務紀錄列表。
 * @param {string} clientId
 * @param {number} recordPage
 */
export const loadProfile = async (clientId, recordPage = 0) => {
    const client = await getRecord(STORES.CLIENTS, clientId);
    if (!client) {
        console.error(`[PROFILE_ERROR] 找不到個案 ID: "${clientId}"，跳轉首頁`);
        window.location.hash = '#dashboard';
        return;
    }

    const container = getAppContainer();
    container.innerHTML = '';
    container.appendChild(cloneTemplate('tpl-profile'));

    _fillProfileForm(client);
    await _renderRecordList(clientId, recordPage);

    // 儲存個案資料（含 ID 修改）與點擊回饋
    document.getElementById('btn-save-client')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const originalText = btn.textContent;
        btn.textContent = '處理中...';
        await _saveClient(client);
        btn.textContent = '已儲存 ✓';
        setTimeout(() => btn.textContent = originalText, 1500);
    });

    // 新增服務紀錄
    document.getElementById('btn-create-record')?.addEventListener('click', () => {
        window.location.hash = `#record/${clientId}`;
    });

    // 返回首頁
    document.getElementById('btn-back-dashboard')?.addEventListener('click', () => {
        window.location.hash = '#dashboard';
    });
};

const _fillProfileForm = (client) => {
    // 對齊新 Schema 的所有欄位
    const fields = ['id', 'name', 'phone', 'line', 'fb', 'email', 'profession', 'exerciseHabit', 'medicalHistory', 'notes'];
    fields.forEach(key => {
        const el = document.getElementById(`client-${key}`);
        if (el) el.value = client[key] || '';
    });
};

const _renderRecordList = async (clientId, page) => {
    const allRecords = await queryByIndex(STORES.RECORDS, 'clientId', clientId);
    // 依日期降冪排序
    allRecords.sort((a, b) => b.date.localeCompare(a.date));

    const listEl = document.getElementById('record-list');
    if (!listEl) throw new Error('[PROFILE_ERROR] 找不到 #record-list');

    const total = allRecords.length;
    const start = page * PAGE_SIZE;
    const pageItems = allRecords.slice(start, start + PAGE_SIZE);

    listEl.innerHTML = '';
    pageItems.forEach(record => {
        const row = document.createElement('div');
        row.className = 'record-row';
        row.innerHTML = `
            <span class="record-date">${_escHtml(record.date)}</span>
            <span class="record-summary">${_escHtml(record.summary)}</span>
            <button class="btn-delete-record" data-id="${_escHtml(record.id)}">刪除</button>
        `;
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-record')) return;
            window.location.hash = `#record/${clientId}/${record.id}`;
        });
        row.querySelector('.btn-delete-record')?.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRecord(record.id, clientId, page);
        });
        listEl.appendChild(row);
    });

    _renderPagination('record-pagination', total, page, (p) => {
        _renderRecordList(clientId, p);
    });
};

// ─── 個案 CRUD ────────────────────────────────────────────────────────────────

const _showCreateClientModal = () => {
    const name = window.prompt('請輸入個案姓名（必填）：');
    if (name === null) return; // 使用者取消
    if (!name.trim()) {
        alert('[錯誤] 姓名為必填欄位');
        return;
    }
    _createClient(name.trim());
};

const _createClient = async (name) => {
    const client = ClientSchema({ name, lastServiceDate: getTodayLocalISO() });
    await executeWrite([STORES.CLIENTS], (stores) => {
        stores[STORES.CLIENTS].add(client);
    });
    window.location.hash = `#client/${client.id}`;
};

/**
 * 儲存個案資料，含 ID 修改的冷資料對接邏輯（裁決 #8）。
 * @param {Object} originalClient - 原始個案物件（含舊 id）
 */
const _saveClient = async (originalClient) => {
    const newId = document.getElementById('client-id')?.value.trim();
    if (!newId) {
        alert('[錯誤] 個案 ID 不可為空');
        return;
    }

    const updatedData = {
        id: newId,
        name: document.getElementById('client-name')?.value.trim() || '',
        phone: document.getElementById('client-phone')?.value.trim() || '',
        line: document.getElementById('client-line')?.value.trim() || '',
        fb: document.getElementById('client-fb')?.value.trim() || '',
        email: document.getElementById('client-email')?.value.trim() || '',
        profession: document.getElementById('client-profession')?.value.trim() || '',
        exerciseHabit: document.getElementById('client-exerciseHabit')?.value.trim() || '',
        medicalHistory: document.getElementById('client-medicalHistory')?.value.trim() || '',
        notes: document.getElementById('client-notes')?.value.trim() || '',
        lastServiceDate: originalClient.lastServiceDate
    };

    const idChanged = newId !== originalClient.id;

    if (idChanged) {
        // 檢查新 ID 是否與現有熱資料衝突
        const conflict = await getRecord(STORES.CLIENTS, newId);
        if (conflict) {
            alert(`[錯誤] ID "${newId}" 已存在於個案資料庫，無法使用`);
            return;
        }

        // 檢查新 ID 是否對應冷資料（若是，同一 Transaction 刪除冷資料 ID）
        const coldEntry = await getRecord(STORES.COLD_DIRECTORY, newId);

        // 取得該個案所有紀錄，準備更新 clientId
        const relatedRecords = await queryByIndex(STORES.RECORDS, 'clientId', originalClient.id);

        const updatedClient = ClientSchema(updatedData);

        await executeWrite(
            [STORES.CLIENTS, STORES.RECORDS, STORES.COLD_DIRECTORY],
            (stores) => {
                // 裁決順序：先 put 新個案，再 delete 舊個案，避免 add 因 key 衝突失敗
                stores[STORES.CLIENTS].put(updatedClient);
                stores[STORES.CLIENTS].delete(originalClient.id);

                // 更新所有關聯紀錄的 clientId
                relatedRecords.forEach(record => {
                    stores[STORES.RECORDS].put({ ...record, clientId: newId });
                });

                // 若命中冷資料，刪除冷資料目錄中的該 ID
                if (coldEntry) {
                    stores[STORES.COLD_DIRECTORY].delete(newId);
                }
            }
        );

        // 路由更新至新 ID
        window.location.hash = `#client/${newId}`;
    } else {
        // ID 未變更，直接 put 更新
        const updatedClient = ClientSchema(updatedData);
        await executeWrite([STORES.CLIENTS], (stores) => {
            stores[STORES.CLIENTS].put(updatedClient);
        });
    }
};

export const deleteClient = async (clientId) => {
    const confirmed = window.confirm('確定要永久刪除此個案及其所有服務紀錄？此操作無法復原。');
    // 方案確認：修改為回傳 boolean 狀態給外部呼叫方，判斷是否需重新整理畫面
    if (!confirmed) return false;

    const relatedRecords = await queryByIndex(STORES.RECORDS, 'clientId', clientId);

    await executeWrite([STORES.CLIENTS, STORES.RECORDS], (stores) => {
        stores[STORES.CLIENTS].delete(clientId);
        relatedRecords.forEach(r => stores[STORES.RECORDS].delete(r.id));
    });

    window.location.hash = '#dashboard';
    return true; 
};

export const deleteRecord = async (recordId, clientId, currentPage) => {
    const confirmed = window.confirm('確定要永久刪除此服務紀錄？此操作無法復原。');
    if (!confirmed) return;

    await executeWrite([STORES.RECORDS], (stores) => {
        stores[STORES.RECORDS].delete(recordId);
    });

    await _renderRecordList(clientId, currentPage);
};

// ─── 每日冷熱資料比對（供 dispatcher 呼叫）──────────────────────────────────

/**
 * 比對熱資料與冷資料目錄，若 ID 重複則自動刪除冷資料目錄中的該筆。
 * 裁決：熱資料存在 = 個案已回歸熱庫，冷資料目錄不應再持有該 ID。
 */
export const checkColdAndHotDataOverlap = async () => {
    const [hotClients, coldEntries] = await Promise.all([
        getAllRecords(STORES.CLIENTS),
        getAllRecords(STORES.COLD_DIRECTORY)
    ]);

    const hotIdSet = new Set(hotClients.map(c => c.id));
    const overlappingIds = coldEntries
        .map(e => e.id)
        .filter(id => hotIdSet.has(id));

    if (overlappingIds.length === 0) return;

    await executeWrite([STORES.COLD_DIRECTORY], (stores) => {
        overlappingIds.forEach(id => stores[STORES.COLD_DIRECTORY].delete(id));
    });

    console.warn(`[SCHEDULER] 已從冷資料目錄移除 ${overlappingIds.length} 筆重複 ID: ${overlappingIds.join(', ')}`);
};

// ─── 工具函式 ─────────────────────────────────────────────────────────────────

const _escHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

const _renderPagination = (containerId, total, currentPage, onPageChange) => {
    const el = document.getElementById(containerId);
    if (!el) return;

    const totalPages = Math.ceil(total / PAGE_SIZE);
    el.innerHTML = '';

    if (totalPages <= 1) return;

    for (let i = 0; i < totalPages; i++) {
        const btn = document.createElement('button');
        btn.textContent = i + 1;
        btn.className = i === currentPage ? 'page-btn active' : 'page-btn';
        btn.addEventListener('click', () => onPageChange(i));
        el.appendChild(btn);
    }
};