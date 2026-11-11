import type { CanvasStyleTemplate } from "@/constant/style-templates";

/**
 * 风格模板选择器的分组结果。
 *
 * 用户 2026-11-11 第 03 条：
 *  ① 「个人添加的风格内容置顶在最上方」—— 自定义分类（默认「我的风格」）排在所有内置分类之前；
 *  ② 「同时也添加置顶功能，这样我可以把常用的风格模板置顶」—— 置顶项单独一组，永远在最顶上。
 *
 * 为什么抽成纯函数：分组顺序是最容易写歪、也最难在 UI 里看出问题的地方（分类漏一个、
 * 置顶项在下面又出现一次、搜索后顺序乱了），放这里可以被探针直接钉住。
 */
export type StylePickerSection = {
    /** React key：置顶组固定 `__pinned__`，其余用分类名。 */
    key: string;
    /** 组标题（置顶组由调用方传 i18n 文案，其余就是分类名）。 */
    title: string;
    pinned: boolean;
    items: CanvasStyleTemplate[];
};

export type StylePickerSectionInput = {
    /** 全集（内置在前、自定义在后，与 `getAllStyleTemplates()` 一致）。 */
    templates: readonly CanvasStyleTemplate[];
    /** 内置分类的展示顺序（`STYLE_TEMPLATE_CATEGORIES`）。 */
    categories: readonly string[];
    /** 哪些 id 是用户自己加的 —— 决定「自定义分类整体靠前」。 */
    customIds: ReadonlySet<string>;
    /** 置顶的 id，顺序即置顶组的展示顺序。 */
    pinnedIds: readonly string[];
    /** 置顶组标题（i18n：`canvas.stylePicker.pinnedGroup`）。 */
    pinnedTitle: string;
    /** 搜索关键词（名称 / 正文 / 分类，忽略大小写）。 */
    keyword?: string;
};

export const STYLE_PICKER_PINNED_GROUP_KEY = "__pinned__";

function matchesKeyword(item: CanvasStyleTemplate, keyword: string): boolean {
    if (!keyword) return true;
    return (
        item.label.toLowerCase().includes(keyword) ||
        item.stylePrompt.toLowerCase().includes(keyword) ||
        item.category.toLowerCase().includes(keyword)
    );
}

export function buildStylePickerSections(input: StylePickerSectionInput): StylePickerSection[] {
    const keyword = (input.keyword || "").trim().toLowerCase();
    const visible = input.templates.filter((item) => matchesKeyword(item, keyword));

    // ① 置顶组：按用户置顶的顺序，命中的才出现（搜索时未命中就不占位）。
    //    🔴 置顶项**不再**在下面的分类里重复出现 —— 重复会让用户以为有两份，
    //    也会让「取消置顶」看起来没生效（下面那份还在）。
    const byId = new Map(visible.map((item) => [item.id, item]));
    const pinnedItems: CanvasStyleTemplate[] = [];
    const pinnedSet = new Set<string>();
    for (const id of input.pinnedIds) {
        const item = byId.get(id);
        if (!item || pinnedSet.has(id)) continue;
        pinnedSet.add(id);
        pinnedItems.push(item);
    }

    const sections: StylePickerSection[] = [];
    if (pinnedItems.length) {
        sections.push({ key: STYLE_PICKER_PINNED_GROUP_KEY, title: input.pinnedTitle, pinned: true, items: pinnedItems });
    }

    // ② 其余按分类分组。
    const buckets = new Map<string, CanvasStyleTemplate[]>();
    for (const item of visible) {
        if (pinnedSet.has(item.id)) continue;
        const list = buckets.get(item.category) || [];
        list.push(item);
        buckets.set(item.category, list);
    }

    // ③ 分类顺序：**自定义分类先**（按自定义模板里首次出现的先后），内置分类在后。
    //    这就是「个人添加的风格内容置顶在最上方」——用户自己建的那一档永远在最前。
    const customCategories: string[] = [];
    for (const item of input.templates) {
        if (!input.customIds.has(item.id)) continue;
        const category = String(item.category || "").trim();
        if (!category || customCategories.includes(category)) continue;
        customCategories.push(category);
    }
    const ordered = [...customCategories, ...input.categories].filter((category, index, all) => all.indexOf(category) === index);

    const emitted = new Set<string>();
    for (const category of ordered) {
        const items = buckets.get(category);
        if (!items?.length) continue;
        emitted.add(category);
        sections.push({ key: category, title: category, pinned: false, items });
    }
    // 兜底：分类既不在内置顺序里、也没出现在自定义列表里（手工改过的老数据）也不许丢。
    for (const [category, items] of buckets) {
        if (emitted.has(category)) continue;
        sections.push({ key: category, title: category, pinned: false, items });
    }

    return sections;
}
