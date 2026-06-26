// database/idb_client.js

const DB_NAME = 'PhysioDB';
const DB_VERSION = 1;

export const STORES = {
    CLIENTS: 'clients',
    RECORDS: 'records',
    TAGS: 'tags',
    COLD_DIRECTORY: 'cold_directory'
};

let dbInstance = null;

/**
 * @description 初始化資料庫與索引。若裝置觸發空間回收，在此會拋出大聲報錯。
 */
export const initDB = () => {
    return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if (!db.objectStoreNames.contains(STORES.CLIENTS)) {
                const store = db.createObjectStore(STORES.CLIENTS, { keyPath: 'id' });
                // 用於搜尋與冷資料比對
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('lastServiceDate', 'lastServiceDate', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORES.RECORDS)) {
                const store = db.createObjectStore(STORES.RECORDS, { keyPath: 'id' });
                // 用於關聯查詢與歷史排序
                store.createIndex('clientId', 'clientId', { unique: false });
                store.createIndex('date', 'date', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORES.TAGS)) {
                const store = db.createObjectStore(STORES.TAGS, { keyPath: 'id' });
                // 用於標籤分類渲染與常用過濾
                store.createIndex('category', 'category', { unique: false });
                store.createIndex('isFavorite', 'isFavorite', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORES.COLD_DIRECTORY)) {
                db.createObjectStore(STORES.COLD_DIRECTORY, { keyPath: 'id' });
            }
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve(dbInstance);
        };

        request.onerror = (event) => {
            reject(new Error(`[DB_ERROR] IndexedDB 初始化失敗: ${event.target.error}`));
        };
    });
};

// 方案確認：將底層 I/O 嚴格分離為「寫入 (含回滾)」與「讀取」兩種獨立行為。解決原本過度抽象導致讀取結果被 `resolve(true)` 覆蓋的問題。此寫法確保了資料庫層 (Layer 3) 與邏輯層 (Layer 4) 之間的合約清晰且低耦合。
export const executeWrite = async (storeNames, callback) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, 'readwrite');
        const stores = storeNames.reduce((acc, name) => {
            acc[name] = transaction.objectStore(name);
            return acc;
        }, {});

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = (e) => reject(e.target.error);
        transaction.onabort = () => reject(new Error('[DB_ABORT] 操作中斷回滾'));

        try {
            callback(stores, transaction);
        } catch (error) {
            transaction.abort();
            reject(error);
        }
    });
};

// 讀取專用：正確回傳 Request.result
export const getRecord = async (storeName, id) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const request = transaction.objectStore(storeName).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const getAllRecords = async (storeName) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

// 方案確認：新增基於 Index 的查詢封裝。利用 IDBKeyRange 支援精確匹配或範圍查詢（如日期篩選），將過濾負載完全交給 IndexedDB 底層引擎，避免 Layer 4 產生記憶體溢出 (OOM) 風險。
export const queryByIndex = async (storeName, indexName, queryValue) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index(indexName);
        
        // 判斷 queryValue 是單一值還是 IDBKeyRange 範圍
        const request = index.getAll(queryValue);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};