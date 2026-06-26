// modules/tag_settings_controller.js
import {
    getTagsGrouped, getFavoriteTags,
    createTag, deleteTag, toggleFavorite
} from './tag_manager.js';

// 規格書定義的固定解剖部位清單（subCategory 合法值）
const ANATOMY_SUB_CATEGORIES = [
    '頭', '頸', '肩', '胸', '上手臂', '下手臂',
    '腹', '上背', '腰', '後臀', '骨盆前側', '大腿', '小腿', '足', '關節'
];

const TAG_CATEGORIES = [
    { key: 'anatomy',  label: '身體部位' },
    { key: 'symptom',  label: '個案主訴症狀' },
    { key: 'clinical', label: '臨床判斷' },
    { key: 'other',    label: '其他標籤' }
];

// ─── 設定頁標籤 UI 入口 ───────────────────────────────────────────────────────

export const loadTagSettings = async () => {
    const container = document.getElementById('tag-settings-container');
    if (!container) throw new Error('[TAG_SETTINGS_ERROR] 找不到 #tag-settings-container');

    container.innerHTML = '';
    await _renderAllCategories(container);
};

// ─── 渲染所有分類區塊 ─────────────────────────────────────────────────────────

const _renderAllCategories = async (container) => {
    const grouped = await getTagsGrouped();

    TAG_CATEGORIES.forEach(({ key, label }) => {
        const section = document.createElement('details');
        section.className = 'tag-category-section';
        section.open = false;

        const summary = document.createElement('summary');
        summary.className = 'tag-category-title';
        summary.textContent = label;
        section.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'tag-category-body';
        body.dataset.category = key;

        if (key === 'anatomy') {
            _renderAnatomySection(body, grouped.anatomy || {});
        } else {
            _renderFlatSection(body, key, grouped[key] || []);
        }

        section.appendChild(body);
        container.appendChild(section);
    });
};

// ─── 解剖部位區塊（二層：subCategory → 標籤列表） ────────────────────────────

const _renderAnatomySection = (container, anatomyGrouped) => {
    ANATOMY_SUB_CATEGORIES.forEach(sub => {
        const subSection = document.createElement('details');
        subSection.className = 'tag-sub-section';

        const subSummary = document.createElement('summary');
        subSummary.className = 'tag-sub-title';
        subSummary.textContent = sub;
        subSection.appendChild(subSummary);

        const tagList = document.createElement('div');
        tagList.className = 'tag-list';
        tagList.dataset.sub = sub;

        const tags = anatomyGrouped[sub] || [];
        tags.forEach(tag => tagList.appendChild(_createTagEl(tag)));

        // 新增肌肉標籤按鈕
        const addBtn = _createAddButton('新增肌肉標籤', async () => {
            await _handleCreateTag('anatomy', sub, tagList);
        });

        subSection.appendChild(tagList);
        subSection.appendChild(addBtn);
        container.appendChild(subSection);
    });
};

// ─── 非解剖分類區塊（扁平列表） ──────────────────────────────────────────────

const _renderFlatSection = (container, category, tags) => {
    const tagList = document.createElement('div');
    tagList.className = 'tag-list';
    tagList.dataset.category = category;

    tags.forEach(tag => tagList.appendChild(_createTagEl(tag)));

    const addBtn = _createAddButton('新增標籤', async () => {
        await _handleCreateTag(category, '', tagList);
    });

    container.appendChild(tagList);
    container.appendChild(addBtn);
};

// ─── 單一標籤元素 ─────────────────────────────────────────────────────────────

const _createTagEl = (tag) => {
    const el = document.createElement('div');
    el.className = 'tag-item';
    el.dataset.tagId = tag.id;

    const textSpan = document.createElement('span');
    textSpan.className = 'tag-item-text';
    textSpan.textContent = tag.text;

    const favoriteBtn = document.createElement('button');
    favoriteBtn.className = tag.isFavorite ? 'btn-favorite active' : 'btn-favorite';
    favoriteBtn.textContent = tag.isFavorite ? '★' : '☆';
    favoriteBtn.title = '切換常用';
    favoriteBtn.addEventListener('click', async () => {
        const updated = await toggleFavorite(tag.id);
        // 即時更新按鈕視覺，不重新渲染整頁
        favoriteBtn.className = updated.isFavorite ? 'btn-favorite active' : 'btn-favorite';
        favoriteBtn.textContent = updated.isFavorite ? '★' : '☆';
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-tag';
    deleteBtn.textContent = '刪除';
    deleteBtn.addEventListener('click', async () => {
        await deleteTag(tag.id, () => Promise.resolve(
            window.confirm(`確定要永久刪除標籤「${tag.text}」？`)
        ));
        // 刪除成功後移除該元素
        el.remove();
    });

    el.appendChild(textSpan);
    el.appendChild(favoriteBtn);
    el.appendChild(deleteBtn);
    return el;
};

// ─── 新增標籤流程 ─────────────────────────────────────────────────────────────

const _handleCreateTag = async (category, subCategory, listEl) => {
    const text = window.prompt('請輸入標籤文字（必填）：');
    if (text === null) return; // 使用者取消
    if (!text.trim()) {
        alert('[錯誤] 標籤文字不可為空');
        return;
    }

    const tag = await createTag({
        category,
        subCategory,
        text: text.trim()
    });

    // 新增成功後即時插入 DOM，不重新渲染整頁
    listEl.appendChild(_createTagEl(tag));
};

// ─── 工具函式 ─────────────────────────────────────────────────────────────────

const _createAddButton = (label, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'btn-add-tag';
    btn.textContent = `+ ${label}`;
    btn.addEventListener('click', onClick);
    return btn;
};