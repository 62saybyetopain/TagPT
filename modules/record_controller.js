// modules/record_controller.js
import { RecordSchema, getTodayLocalISO } from '../schemas/models.js';
import { executeWrite, getRecord, STORES } from '../database/idb_client.js';
import { getTagsGrouped } from './tag_manager.js';

// ─── RAM 暫存狀態（生命週期：載入表單 → 儲存/離開） ──────────────────────────
let _state = {
    clientId: null,
    recordId: null,   // null = 新增模式
    date: null,
    chiefComplaint: '',
    assessment: '',
    postTest: '',
    summary: ''
};

// 當前抽屜目標區塊與暫存狀態
let _drawerTarget = null;
let _stagedTags = []; // 將暫存區狀態提升至模組頂部，確保所有流程都能安全存取

const _resetState = () => {
    _state = { clientId: null, recordId: null, date: null,
                chiefComplaint: '', assessment: '', postTest: '', summary: '' };
    _drawerTarget = null;
    _stagedTags = []; // 方案確認：直接在 controller 重置暫存陣列，移除對 tag_manager 舊狀態函式的依賴。
};

// ─── 斷線抹除（裁決 #2/#3：record_controller 自行監聽，不依賴 dispatcher） ───
// 此監聽器在模組載入時即全域綁定；加 hash 守衛確保只有使用者實際在紀錄頁時才重置與跳轉，
// 避免在 dashboard 等其他頁面觸發多餘的 hashchange，並消除與 dispatcher SystemLock 的競態
window.addEventListener('offline', () => {
    if (!window.location.hash.startsWith('#record')) return;
    _resetState();
    _clearFormDOM();
    window.location.hash = '#dashboard';
});

const _clearFormDOM = () => {
    ['record-date', 'record-chief-complaint', 'record-assessment',
     'record-post-test', 'record-summary'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
};

// ─── 視圖工具 ─────────────────────────────────────────────────────────────────
const getAppContainer = () => {
    const el = document.getElementById('app');
    if (!el) throw new Error('[RECORD_ERROR] 找不到 #app 容器');
    return el;
};

const cloneTemplate = (templateId) => {
    const tpl = document.getElementById(templateId);
    if (!tpl) throw new Error(`[RECORD_ERROR] 找不到 template#${templateId}`);
    return tpl.content.cloneNode(true);
};

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 載入服務紀錄工作區。
 * @param {string} clientId
 * @param {string|null} recordId - null 為新增模式
 */
export const loadRecord = async (clientId, recordId) => {
    if (!clientId) {
        console.error('[RECORD_ERROR] loadRecord 缺少 clientId，跳轉首頁');
        window.location.hash = '#dashboard';
        return;
    }

    _resetState();
    _state.clientId = clientId;
    _state.recordId = recordId;
    _state.date = getTodayLocalISO();

    const container = getAppContainer();
    container.innerHTML = '';
    container.appendChild(cloneTemplate('tpl-record'));

    // 編輯模式：從 DB 載入既有紀錄填入表單
    if (recordId) {
        const existing = await getRecord(STORES.RECORDS, recordId);
        if (!existing) {
            console.error(`[RECORD_ERROR] 找不到紀錄 ID: "${recordId}"，跳轉個案頁`);
            window.location.hash = `#client/${clientId}`;
            return;
        }
        _state = { ...existing }; // 以 DB 資料覆蓋 RAM 狀態
    }

    _fillFormDOM();
    _bindFormEvents(clientId);
    _bindDrawerEvents();
};

// ─── 表單填入與同步 ───────────────────────────────────────────────────────────

const _fillFormDOM = () => {
    const dateEl = document.getElementById('record-date');
    if (dateEl) dateEl.value = _state.date;

    const fields = [
        ['record-chief-complaint', 'chiefComplaint'],
        ['record-assessment',      'assessment'],
        ['record-post-test',       'postTest'],
        ['record-summary',         'summary']
    ];
    fields.forEach(([elId, key]) => {
        const el = document.getElementById(elId);
        if (el) el.value = _state[key];
    });
};

// 每次 textarea 變動同步回 RAM（不寫 DB）
const _bindFormEvents = (clientId) => {
    const syncField = (elId, key) => {
        const el = document.getElementById(elId);
        if (!el) return;
        el.addEventListener('input', () => { _state[key] = el.value; });
    };

    syncField('record-chief-complaint', 'chiefComplaint');
    syncField('record-assessment',      'assessment');
    syncField('record-post-test',       'postTest');
    syncField('record-summary',         'summary');

    const dateEl = document.getElementById('record-date');
    if (dateEl) dateEl.addEventListener('change', () => { _state.date = dateEl.value; });

    document.getElementById('btn-save-record')?.addEventListener('click', () => {
        _saveRecord();
    });

    document.getElementById('btn-back-profile')?.addEventListener('click', () => {
        window.location.hash = `#client/${clientId}`;
    });

    // 方案確認：從記憶體狀態 (_state) 讀取已輸入的值，若有內容則加上括號標頭組合，最後將字串附加到摘要 DOM 並且即時同步回 _state，維持記憶體與視圖的一致性。
    document.getElementById('btn-copy-to-summary')?.addEventListener('click', () => {
        const parts = [];
        if (_state.chiefComplaint?.trim()) parts.push(`【主訴】${_state.chiefComplaint.trim()}`);
        if (_state.assessment?.trim()) parts.push(`【評估】${_state.assessment.trim()}`);
        if (_state.postTest?.trim()) parts.push(`【後測】${_state.postTest.trim()}`);
        
        if (parts.length === 0) return;
        
        const combinedText = parts.join('\n');
        const summaryEl = document.getElementById('record-summary');
        if (summaryEl) {
            // 若摘要已有些許文字，自動換行後再貼上；若為空則直接貼上
            summaryEl.value = summaryEl.value ? `${summaryEl.value}\n${combinedText}` : combinedText;
            _state.summary = summaryEl.value; 
        }
    });
};

// ─── 抽屜 UI (暫存區與分頁機制) ───────────────────────────────────────────────

let _allTagsCache = []; // 用於搜尋與切換分頁的快取

const _bindDrawerEvents = () => {
    document.querySelectorAll('[data-open-drawer]').forEach(btn => {
        btn.addEventListener('click', async () => {
            _drawerTarget = btn.dataset.openDrawer;
            _stagedTags = []; // 清空暫存區
            await _openDrawer();
        });
    });

    document.getElementById('btn-drawer-insert')?.addEventListener('click', () => {
        if (_stagedTags.length > 0) {
            _appendToTarget(_stagedTags.join('')); // 組合暫存區標籤並插入
        }
        _closeDrawer();
    });

    document.getElementById('btn-drawer-close')?.addEventListener('click', _closeDrawer);

    // 搜尋功能綁定
    const searchInput = document.getElementById('drawer-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => _renderTagsContent(e.target.value));
    }

    // 分頁切換綁定
    document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.drawer-tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            if (searchInput) searchInput.value = ''; // 切換分頁時清空搜尋
            _renderTagsContent();
        });
    });
};

const _openDrawer = async () => {
    const drawer = document.getElementById('tag-drawer');
    if (!drawer) return;

    // 載入所有標籤建立快取
    const grouped = await getTagsGrouped();
    _allTagsCache = Object.values(grouped).flatMap(group => 
        group instanceof Array ? group : Object.values(group).flat()
    );

    _renderStagingArea();
    _renderModifiers(document.getElementById('drawer-modifiers'));
    
    // 預設回到「常用」分頁並清空搜尋
    document.querySelectorAll('.drawer-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.drawer-tab-btn[data-tab="favorite"]')?.classList.add('active');
    const searchInput = document.getElementById('drawer-search-input');
    if (searchInput) searchInput.value = '';

    _renderTagsContent();

    drawer.showModal ? drawer.showModal() : (drawer.style.display = 'flex');
};

const _closeDrawer = () => {
    const drawer = document.getElementById('tag-drawer');
    if (!drawer) return;
    drawer.close ? drawer.close() : (drawer.style.display = 'none');
    _drawerTarget = null;
};

// 方案確認：建立獨立的視覺同步擴充函式，利用 Array.includes 進行確定性狀態比對，避免與 DOM 結構產生多餘的跨檔案耦合。
const _syncButtonsVisualState = () => {
    document.getElementById('drawer-modifiers')?.querySelectorAll('.modifier-btn').forEach(btn => {
        btn.classList.toggle('tag-selected', _stagedTags.includes(btn.textContent));
    });
    document.getElementById('drawer-tags-content')?.querySelectorAll('.tag-btn').forEach(btn => {
        btn.classList.toggle('tag-selected', _stagedTags.includes(btn.textContent));
    });
};

const _renderStagingArea = () => {
    const container = document.getElementById('drawer-staging-area');
    if (!container) return;
    container.innerHTML = '';
    
    if (_stagedTags.length === 0) {
        container.innerHTML = '<span style="color: var(--color-text-muted); font-size: 0.85rem; padding: 4px;">尚未選擇標籤...</span>';
        _syncButtonsVisualState(); // 原因：暫存區歸零時，需即時重置下方所有按鈕的選取高亮狀態
        return;
    }

    _stagedTags.forEach((text, index) => {
        const chip = document.createElement('div');
        chip.className = 'staging-chip';
        chip.textContent = `${text} ✕`;
        chip.addEventListener('click', () => {
            _stagedTags.splice(index, 1);
            _renderStagingArea();
        });
        container.appendChild(chip);
    });
    _syncButtonsVisualState(); // 原因：暫存資料異動時，同步觸發下方視圖的狀態重新著色
};

const _renderModifiers = (container) => {
    if (!container) return;
    container.innerHTML = '';
    ['前面', '後面', '左側', '右側'].forEach(mod => {
        const btn = document.createElement('button');
        btn.className = 'modifier-btn';
        btn.textContent = mod;
        btn.addEventListener('click', () => {
            const idx = _stagedTags.indexOf(mod);
            if (idx > -1) {
                _stagedTags.splice(idx, 1); // 原因：點擊已存在的修飾鍵時執行移除，達成原處點擊切換反選的行為
            } else {
                _stagedTags.push(mod);
            }
            _renderStagingArea();
        });
        container.appendChild(btn);
    });
};

const _renderTagsContent = (searchQuery = '') => {
    const container = document.getElementById('drawer-tags-content');
    const activeTab = document.querySelector('.drawer-tab-btn.active')?.dataset.tab || 'favorite';
    if (!container) return;

    container.innerHTML = '';
    let filteredTags = [];

    // 搜尋模式：無視分頁，全域搜尋
    if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        filteredTags = _allTagsCache.filter(t => t.text.toLowerCase().includes(q));
    } else {
        // 分頁模式
        if (activeTab === 'favorite') {
            filteredTags = _allTagsCache.filter(t => t.isFavorite);
        } else {
            filteredTags = _allTagsCache.filter(t => t.category === activeTab);
        }
    }

    if (filteredTags.length === 0) {
        container.innerHTML = '<p style="color: var(--color-text-muted); font-size: 0.85rem;">無符合的標籤</p>';
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'drawer-tag-grid';
    
    filteredTags.forEach(tag => {
        const btn = document.createElement('button');
        btn.className = 'tag-btn';
        if (tag.isFavorite && !searchQuery) btn.classList.add('tag-btn--favorite');
        btn.textContent = tag.text;
        btn.addEventListener('click', () => {
            const idx = _stagedTags.indexOf(tag.text);
            if (idx > -1) {
                _stagedTags.splice(idx, 1); // 原因：再次點擊普通標籤按鈕時，將其自暫存狀態陣列中剔除
            } else {
                _stagedTags.push(tag.text);
            }
            _renderStagingArea();
        });
        grid.appendChild(btn);
    });
    
    container.appendChild(grid);
    _syncButtonsVisualState(); // 原因：當使用者搜尋或切換分頁時，新渲染出來的按鈕必須立刻同步當前的勾選狀態
};

const _appendToTarget = (str) => {
    if (!_drawerTarget) return;

    const targetMap = {
        chiefComplaint: 'record-chief-complaint',
        assessment:     'record-assessment',
        postTest:       'record-post-test',
        summary:        'record-summary'
    };
    const elId = targetMap[_drawerTarget];
    const el = document.getElementById(elId);
    if (!el) return;

    el.value = el.value ? `${el.value}${str}` : str;
    _state[_drawerTarget] = el.value; 
};
// 方案確認：廢棄原有的 toggleModifier，將點擊標籤/修飾鍵的行為統一簡化為「Push 字串至 _stagedTags 陣列並重繪」。使用者可以在暫存區點擊 ✕ 刪除，最後按下插入時陣列直接 .join('') 輸出純文字。
// ─── 儲存紀錄 ─────────────────────────────────────────────────────────────────

const _saveRecord = async () => {
    // 必填驗證
    if (!_state.clientId) {
        alert('[錯誤] 紀錄缺少關聯個案 ID，無法儲存');
        return;
    }
    if (!_state.date) {
        alert('[錯誤] 日期為必填欄位');
        return;
    }

    const record = RecordSchema({
        id:             _state.recordId || undefined, // 新增時由 Schema 產生
        clientId:       _state.clientId,
        date:           _state.date,
        chiefComplaint: _state.chiefComplaint,
        assessment:     _state.assessment,
        postTest:       _state.postTest,
        summary:        _state.summary
    });

    await executeWrite([STORES.RECORDS], (stores) => {
        stores[STORES.RECORDS].put(record);
    });

    window.location.hash = `#client/${_state.clientId}`;
};