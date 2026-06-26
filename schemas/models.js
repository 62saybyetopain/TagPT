// schemas/models.js

// 內部工具：僅供產生預設值使用
const generateId = () => crypto.randomUUID();

// 方案確認：改用包含時區偏移的計算，解決標準 ISO 字串因 UTC 時間導致本地跨日時少一天的錯誤。此為純前端無伺服器架構下，處理本地時間戳的業界成熟作法，不產生外部依賴。
export const getTodayLocalISO = () => {
    const date = new Date();
    const tzOffset = date.getTimezoneOffset() * 60000;
    return (new Date(date - tzOffset)).toISOString().split('T')[0];
};
/**
 * @function ClientSchema
 * @description 個案資料結構。凍結物件防止業務層意外修改。
 */
export const ClientSchema = (data = {}) => Object.freeze({
    id: data.id || generateId(),
    name: data.name || '',
    contact: data.contact || '',
    profession: data.profession || '',
    exerciseHabit: data.exerciseHabit || '',
    medicalHistory: data.medicalHistory || '',
    notes: data.notes || '',
    lastServiceDate: data.lastServiceDate || getTodayLocalISO()
});

/**
 * @function RecordSchema
 * @description 服務紀錄結構。
 */
export const RecordSchema = (data = {}) => Object.freeze({
    id: data.id || generateId(),
    clientId: data.clientId || '', // 關聯個案 ID
    date: data.date || getTodayLocalISO(), 
    chiefComplaint: data.chiefComplaint || '',
    assessment: data.assessment || '',
    postTest: data.postTest || '',
    summary: data.summary || ''
});

/**
 * @function TagSchema
 * @description 系統標籤結構。
 */
export const TagSchema = (data = {}) => Object.freeze({
    id: data.id || generateId(),
    category: data.category || '', // e.g., 'anatomy', 'symptom', 'clinical'
    subCategory: data.subCategory || '', // e.g., 'head', 'shoulder' (解剖部位專用)
    text: data.text || '',
    isFavorite: Boolean(data.isFavorite) // 強制轉型布林值
});

/**
 * @function ColdDirectorySchema
 * @description 冷資料目錄結構，僅存唯讀 ID。
 */
export const ColdDirectorySchema = (data = {}) => Object.freeze({
    id: data.id
});