// modules/tag_manager.js
import { TagSchema } from '../schemas/models.js';
import { executeWrite, getAllRecords, getRecord, STORES } from '../database/idb_client.js';

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
// 方案確認：徹底移除冗餘的修飾鍵陣列狀態與 getFavoriteTags 等未使用的方法，使 tag_manager 成為純粹與 DB 溝通的 Layer，符合單一職責原則。


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