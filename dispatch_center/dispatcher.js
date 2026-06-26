// dispatch_center/dispatcher.js
import { getTodayLocalISO } from '../schemas/models.js';

// ─── SystemLock ───────────────────────────────────────────────────────────────
// 直接操作 #global-freezer DOM，不抽象成 class（簡單至上原則）
const SystemLock = {
    acquire() {
        document.getElementById('global-freezer').style.display = 'flex';
    },
    release() {
        document.getElementById('global-freezer').style.display = 'none';
    }
};

// 允許 sync_engine 透過 CustomEvent 觸發鎖定，避免循環依賴
window.addEventListener('app:lock', () => SystemLock.acquire());
window.addEventListener('app:unlock', () => SystemLock.release());


// ─── 持久化儲存警告 ───────────────────────────────────────────────────────────
const requestPersistentStorage = async () => {
    if (!navigator.storage?.persist) return;
    const granted = await navigator.storage.persist();
    if (!granted) {
        const banner = document.getElementById('eviction-warning-banner');
        if (banner) banner.style.display = 'block';
    }
};


// ─── 斷線攔截 ─────────────────────────────────────────────────────────────────
// 裁決 #2/#3：Dispatcher 只負責觸發 SystemLock，不清空表單
window.addEventListener('offline', () => {
    SystemLock.acquire();
});

window.addEventListener('online', () => {
    SystemLock.release();
});


// ─── 路由 ─────────────────────────────────────────────────────────────────────
// 裁決 #5：Hash Router 歸屬 dispatcher.js
// 支援四種合法路由：#dashboard | #settings | #client/:id | #record/:clientId/:recordId

const VIEWS = {
    DASHBOARD: 'dashboard',
    SETTINGS: 'settings',
    CLIENT: 'client',
    RECORD: 'record'
};

// 動態 import 避免循環依賴，且僅在需要時才載入對應模組
const routeHandlers = {
    async [VIEWS.DASHBOARD]() {
        const { loadDashboard } = await import('../modules/profile_controller.js');
        loadDashboard();
    },
    async [VIEWS.SETTINGS]() {
    // 方案確認：根據合約「Dispatcher 控制 DOM 切換」，在平行呼叫 Settings 的兩個 Controller 前，必須由 Dispatcher 負責清空畫面並掛載 tpl-settings 骨架，避免後續事件綁定撲空導致靜默失敗。
    const app = document.getElementById('app');
    const tpl = document.getElementById('tpl-settings');
    if (app && tpl) {
        app.innerHTML = '';
        app.appendChild(tpl.content.cloneNode(true));
    }

    const [{ loadSettings }, { loadTagSettings }] = await Promise.all([
        import('../modules/sync_engine.js'),
        import('../modules/tag_settings_controller.js')
    ]);
    await Promise.all([loadSettings(), loadTagSettings()]);
},
async [VIEWS.CLIENT](id) {
        if (!id) return navigateTo('#dashboard');
        const { loadProfile } = await import('../modules/profile_controller.js');
        loadProfile(id);
    },
    async [VIEWS.RECORD](clientId, recordId) {
        if (!clientId) return navigateTo('#dashboard');
        const { loadRecord } = await import('../modules/record_controller.js');
        loadRecord(clientId, recordId || null);
    }
};

const parseHash = (hash) => {
    // '' 或 '#' 預設導向 dashboard
    const raw = (hash || '').replace('#', '').trim();
    if (!raw || raw === VIEWS.DASHBOARD) return { view: VIEWS.DASHBOARD, params: [] };

    const parts = raw.split('/');
    const view = parts[0];

    if (view === VIEWS.SETTINGS) return { view: VIEWS.SETTINGS, params: [] };
    if (view === VIEWS.CLIENT && parts[1]) return { view: VIEWS.CLIENT, params: [parts[1]] };
    if (view === VIEWS.RECORD && parts[1]) return { view: VIEWS.RECORD, params: [parts[1], parts[2]] };

    // 非法路由：大聲報錯並退回首頁
    console.error(`[ROUTER_ERROR] 非法路由: "${hash}"，自動跳轉至首頁`);
    return { view: VIEWS.DASHBOARD, params: [] };
};

const handleRoute = async () => {
    const { view, params } = parseHash(window.location.hash);
    const handler = routeHandlers[view];
    if (!handler) {
        console.error(`[ROUTER_ERROR] 找不到路由處理器: "${view}"`);
        return;
    }
    try {
        await handler(...params);
    } catch (err) {
        console.error(`[ROUTER_ERROR] 路由執行失敗: ${err.message}`);
    }
};

export const navigateTo = (hash) => {
    window.location.hash = hash;
};

window.addEventListener('hashchange', handleRoute);


// ─── 每日冷熱資料比對排程 ─────────────────────────────────────────────────────
// 裁決 #4：讀取 localStorage 判斷今日是否已執行，避免重複比對
const LAST_OVERLAP_CHECK_KEY = 'lastOverlapCheck';

const runDailyOverlapCheck = async () => {
    const today = getTodayLocalISO();
    if (localStorage.getItem(LAST_OVERLAP_CHECK_KEY) === today) return;

    try {
        const { checkColdAndHotDataOverlap } = await import('../modules/profile_controller.js');
        await checkColdAndHotDataOverlap();
        localStorage.setItem(LAST_OVERLAP_CHECK_KEY, today);
    } catch (err) {
        // 大聲報錯：排程失敗不靜默，但不阻斷 App 啟動
        console.error(`[SCHEDULER_ERROR] 每日冷熱比對失敗: ${err.message}`);
    }
};


// ─── 全域錯誤攔截 ─────────────────────────────────────────────────────────────
window.addEventListener('error', (event) => {
    console.error(`[GLOBAL_ERROR] ${event.message}`, event);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error(`[UNHANDLED_REJECTION] ${event.reason}`);
});


// ─── 初始化入口 ───────────────────────────────────────────────────────────────
export const initApp = async () => {
    await requestPersistentStorage();
    await runDailyOverlapCheck();
    await handleRoute(); // 處理首次載入的 Hash
};