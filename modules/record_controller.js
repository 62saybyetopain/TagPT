// modules/record_controller.js
import { RecordSchema, getTodayLocalISO } from '../schemas/models.js';
import { executeWrite, getRecord, STORES } from '../database/idb_client.js';
import {
    getTagsGrouped, getFavoriteTags,
    toggleModifier, buildTagString, resetModifiers, getActiveModifiers
} from './tag_manager.js';

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

// 當前抽屜目標區塊（'chiefComplaint' | 'assessment' | 'postTest' | 'summary'）
let _drawerTarget = null;

const _resetState = () => {
    _state = { clientId: null, recordId: null, date: null,
                chiefComplaint: '', assessment: '', postTest: '', summary: '' };
    _drawerTarget = null;
    resetModifiers();
};

// ─── 斷線抹除（裁決 #2/#3：record_controller 自行監聽，不依賴 dispatcher） ───
window.addEventListener('offline', () => {
    _resetState();
    // 清空 DOM 表單（若當前在紀錄頁）
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

// ─── 抽屜 UI ──────────────────────────────────────────────────────────────────

// 每個觸發按鈕帶有 data-target 指定插入目標，以及 data-filter 指定標籤集合
// 合法 filter 值：'chiefComplaint' | 'assessment' | 'postTest' | 'summary'
const TAG_FILTER = {
    chiefComplaint: (grouped) => _flattenGroups(grouped, ['anatomy', 'symptom', 'favorite']),
    assessment:     (grouped) => _flattenGroups(grouped, ['clinical', 'other', 'favorite']),
    postTest:       (grouped) => _flattenGroups(grouped, ['all']),
    summary:        (grouped) => _flattenGroups(grouped, ['all'])
};

const _flattenGroups = (grouped, filters) => {
    if (filters.includes('all')) {
        return Object.entries(grouped).flatMap(([cat, val]) =>
            cat === 'anatomy'
                ? Object.values(val).flat()
                : val
        );
    }
    const result = [];
    filters.forEach(f => {
        if (f === 'favorite') return; // favorites 另外處理
        if (f === 'anatomy' && grouped.anatomy) {
            Object.values(grouped.anatomy).flat().forEach(t => result.push(t));
        } else if (grouped[f]) {
            grouped[f].forEach(t => result.push(t));
        }
    });
    return result;
};

const _bindDrawerEvents = () => {
    // 各區塊的「+ 標籤」按鈕
    document.querySelectorAll('[data-open-drawer]').forEach(btn => {
        btn.addEventListener('click', async () => {
            _drawerTarget = btn.dataset.openDrawer; // e.g. 'chiefComplaint'
            if (!TAG_FILTER[_drawerTarget]) {
                throw new Error(`[RECORD_ERROR] 非法抽屜目標: "${_drawerTarget}"`);
            }
            resetModifiers(); // 規格：每次開啟抽屜重置修飾鍵狀態
            await _openDrawer(_drawerTarget);
        });
    });

    // 插入並關閉
    document.getElementById('btn-drawer-insert')?.addEventListener('click', () => {
        // 方案確認：允許單獨插入修飾鍵（如只點了"前面"）。檢查記憶體中是否有殘留的修飾鍵，若有則化為文字附加，解決只有修飾鍵時無法輸出的問題。
        const activeMods = getActiveModifiers();
        if (activeMods.length > 0) {
            _appendToTarget(activeMods.join(''));
            resetModifiers();
        }
        _closeDrawer();
    });

    // 關閉鈕（不插入）
    document.getElementById('btn-drawer-close')?.addEventListener('click', () => {
        resetModifiers();
        _closeDrawer();
    });

const _openDrawer = async (target) => {
    const drawer = document.getElementById('tag-drawer');
    if (!drawer) throw new Error('[RECORD_ERROR] 找不到 #tag-drawer');

    const [grouped, favorites] = await Promise.all([
        getTagsGrouped(),
        getFavoriteTags()
    ]);

    const filterFn = TAG_FILTER[target];
    const tags = filterFn(grouped);

    // 渲染修飾鍵（規格確認：所有區塊皆固定顯示，不僅限於主訴）
    const modifierArea = document.getElementById('drawer-modifiers');
    if (modifierArea) {
        modifierArea.style.display = 'flex';
        _renderModifiers(modifierArea);
    }

    // 渲染常用標籤
    const favoriteArea = document.getElementById('drawer-favorites');
    if (favoriteArea) {
        _renderTagButtons(favoriteArea, favorites, true);
    }

    // 渲染主要標籤
    const tagArea = document.getElementById('drawer-tags');
    if (tagArea) {
        _renderTagButtons(tagArea, tags, false);
    }

    drawer.showModal ? drawer.showModal() : (drawer.style.display = 'flex');
};

const _closeDrawer = () => {
    const drawer = document.getElementById('tag-drawer');
    if (!drawer) return;
    drawer.close ? drawer.close() : (drawer.style.display = 'none');
    _drawerTarget = null;
};

// ─── 標籤按鈕渲染 ─────────────────────────────────────────────────────────────

const _renderModifiers = (container) => {
    container.innerHTML = '';
    ['前面', '後面', '左側', '右側'].forEach(mod => {
        const btn = document.createElement('button');
        btn.className = 'modifier-btn';
        btn.textContent = mod;
        btn.addEventListener('click', () => {
            const active = toggleModifier(mod);
            // 更新所有修飾鍵按鈕的視覺狀態
            container.querySelectorAll('.modifier-btn').forEach(b => {
                b.classList.toggle('tag-selected', active.includes(b.textContent));
            });
        });
        container.appendChild(btn);
    });
};

const _renderTagButtons = (container, tags, isFavorite) => {
    container.innerHTML = '';
    tags.forEach(tag => {
        const btn = document.createElement('button');
        btn.className = isFavorite ? 'tag-btn tag-btn--favorite' : 'tag-btn';
        btn.textContent = tag.text;
        btn.dataset.tagId = tag.id;
        btn.addEventListener('click', () => {
            // 視覺動畫（規格：微縮放或變色）
            btn.classList.add('tag-selected');
            setTimeout(() => btn.classList.remove('tag-selected'), 300);

            // 組合修飾鍵並附加至目標 textarea
            const str = buildTagString(tag.text);
            _appendToTarget(str);

            // 修飾鍵點選後已被 buildTagString 清空，更新修飾鍵按鈕視覺
            const modifierArea = document.getElementById('drawer-modifiers');
            if (modifierArea) {
                modifierArea.querySelectorAll('.modifier-btn').forEach(b => {
                    b.classList.remove('tag-selected');
                });
            }
        });
        container.appendChild(btn);
    });
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
    if (!elId) {
        throw new Error(`[RECORD_ERROR] 找不到目標欄位對應: "${_drawerTarget}"`);
    }
    const el = document.getElementById(elId);
    if (!el) throw new Error(`[RECORD_ERROR] 找不到 DOM 元素 #${elId}`);

    // 附加文字（以空格分隔，若已有內容）
    el.value = el.value ? `${el.value} ${str}` : str;
    _state[_drawerTarget] = el.value; // 同步回 RAM
};

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