// modules/tag_manager.js
import { TagSchema } from '../schemas/models.js';
import { executeWrite, getAllRecords, getRecord, STORES } from '../database/idb_client.js';

// ─── 組合鍵暫存狀態（RAM only，不寫入 DB）────────────────────────────────────
// 點擊順序決定字串順序，例：先點「前面」再點「右側」→「前面右側」
let _modifierKeys = []; // 最多存放修飾鍵文字，順序由點擊順序決定

const MODIFIER_OPTIONS = ['前面', '後面', '左側', '右側'];

/**
 * 切換修飾鍵選取狀態。已選則移除，未選則加入。
 * @param {string} modifier - 修飾鍵文字，必須是 MODIFIER_OPTIONS 之一
 * @returns {string[]} 當前已選修飾鍵陣列（供 Controller 更新 UI）
 */
export const toggleModifier = (modifier) => {
    if (!MODIFIER_OPTIONS.includes(modifier)) {
        throw new Error(`[TAG_ERROR] 非法修飾鍵: "${modifier}"，合法值為 ${MODIFIER_OPTIONS.join('、')}`);
    }
    const idx = _modifierKeys.indexOf(modifier);
    if (idx === -1) {
        _modifierKeys.push(modifier);
    } else {
        _modifierKeys.splice(idx, 1);
    }
    return [..._modifierKeys];
};

/**
 * 將當前修飾鍵與部位標籤合併為字串，並清空修飾鍵狀態。
 * @param {string} tagText - 部位或標籤文字
 * @returns {string} 合併後的純文字字串，例：「前面右側肩膀」
 */
export const buildTagString = (tagText) => {
    if (!tagText || typeof tagText !== 'string') {
        throw new Error('[TAG_ERROR] buildTagString 收到無效的標籤文字');
    }
    const result = [..._modifierKeys, tagText].join('');
    _modifierKeys = []; // 插入後清空，避免殘留影響下次操作
    return result;
};

/**
 * 清空修飾鍵狀態（例：關閉抽屜時重置）。
 */
export const resetModifiers = () => {
    _modifierKeys = [];
};

/**
 * 讀取當前修飾鍵狀態（供 Controller 渲染 UI 用）。
 * @returns {string[]}
 */
export const getActiveModifiers = () => [..._modifierKeys];


// ─── 標籤查詢 ─────────────────────────────────────────────────────────────────

/**
 * 取得所有標籤，依分類整理為純資料結構，不操作 DOM。
 * 結構：{ anatomy: { shoulder: [...], head: [...] }, symptom: [...], clinical: [...], other: [...] }
 * @returns {Promise<Object>}
 */
export const getTagsGrouped = async () => {
    const allTags = await getAllRecords(STORES.TAGS);

    return allTags.reduce((acc, tag) => {
        if (tag.category === 'anatomy') {
            // anatomy 類別依 subCategory 再分層
            const sub = tag.subCategory || '_uncategorized';
            if (!acc.anatomy) acc.anatomy = {};
            if (!acc.anatomy[sub]) acc.anatomy[sub] = [];
            acc.anatomy[sub].push(tag);
        } else {
            // symptom / clinical / other 扁平陣列
            if (!acc[tag.category]) acc[tag.category] = [];
            acc[tag.category].push(tag);
        }
        return acc;
    }, {});
};

/**
 * 取得所有常用標籤（isFavorite === true）。
 * @returns {Promise<Object[]>}
 */
export const getFavoriteTags = async () => {
    const allTags = await getAllRecords(STORES.TAGS);
    return allTags.filter(tag => tag.isFavorite === true);
};


// ─── 標籤 CRUD ────────────────────────────────────────────────────────────────

/**
 * 新增標籤。
 * @param {{ category: string, subCategory?: string, text: string }} data
 * @returns {Promise<Object>} 已儲存的標籤物件
 */
export const createTag = async (data) => {
    if (!data.category || !data.text) {
        throw new Error('[TAG_ERROR] 新增標籤失敗：category 與 text 為必填欄位');
    }
    const tag = TagSchema(data);
    await executeWrite([STORES.TAGS], (stores) => {
        stores[STORES.TAGS].add(tag);
    });
    return tag;
};

/**
 * 刪除標籤。呼叫前必須由 Controller 傳入二次確認函式。
 * @param {string} tagId
 * @param {() => Promise<boolean>} confirmFn - 回傳 true 才執行刪除
 */
export const deleteTag = async (tagId, confirmFn) => {
    if (typeof confirmFn !== 'function') {
        throw new Error('[TAG_ERROR] deleteTag 必須傳入 confirmFn callback');
    }
    const confirmed = await confirmFn();
    if (!confirmed) return;

    const existing = await getRecord(STORES.TAGS, tagId);
    if (!existing) {
        throw new Error(`[TAG_ERROR] 找不到標籤 ID: "${tagId}"，無法刪除`);
    }

    await executeWrite([STORES.TAGS], (stores) => {
        stores[STORES.TAGS].delete(tagId);
    });
};

/**
 * 切換標籤的常用狀態。
 * @param {string} tagId
 * @returns {Promise<Object>} 更新後的標籤物件
 */
export const toggleFavorite = async (tagId) => {
    const existing = await getRecord(STORES.TAGS, tagId);
    if (!existing) {
        throw new Error(`[TAG_ERROR] 找不到標籤 ID: "${tagId}"，無法切換常用狀態`);
    }
    // Object.freeze 的物件不可直接修改，建立新物件
    const updated = TagSchema({ ...existing, isFavorite: !existing.isFavorite });
    await executeWrite([STORES.TAGS], (stores) => {
        stores[STORES.TAGS].put(updated);
    });
    return updated;
};