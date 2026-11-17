/**
 * 右键「批量设置图片参数」的纯逻辑（2026-11-16 用户要求：选中多个图片节点，右键批量改
 * 使用模型 / 画幅比例 / 分辨率，同日补上「风格选择」）。
 *
 * 只做三件不需要 React 的事：挑出该改哪些节点、把用户动过的字段拼成 patch、
 * 把 patch 翻译成真正要写进 `metadata` 的对象（风格得能被「清空」，不能只加不减）。
 *
 * 🔴 档位本身不在这里算：画幅 / 分辨率分别是 `imageAspectOptions` / `imageQualityOptions`
 * （`components/image-settings-panel.tsx`），风格是 `getAllStyleTemplates()`
 * （`constant/style-templates.ts`）。单一来源，别在批量里另抄一份 —— 抄了就会和节点自己的
 * 设置面板对不上（面板里没有的值写进节点，用户点开面板会看到一个点不亮的假档位）。
 */
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** 批量设置里的「不修改」：空串即不动这个字段（绝不能被当成合法值写进节点）。 */
export const IMAGE_BATCH_UNCHANGED = "";

/**
 * 风格下拉里那个显式的「不使用风格」。
 *
 * 空串已经被「保持不变」占了，所以清空必须有个独立哨兵值 —— 否则用户永远没法用批量把
 * 已经挂上的风格一次性摘掉（只能一个个点节点面板里的「清除」）。
 */
export const IMAGE_BATCH_STYLE_CLEAR = "__image_batch_style_clear__";

/** 用户在弹窗里动过的字段（只这四个）。 */
export type ImageBatchPatch = {
    /** 目标模型（`channelId::modelName`）；空 = 不改模型。 */
    model?: string;
    /** 画幅比例 / 尺寸（`metadata.size`，如 `16:9` / `2048x2048` / `auto`）。 */
    size?: string;
    /** 分辨率（`metadata.quality`，`auto` / `high` / `medium` / `low`）。 */
    quality?: string;
    /** 风格模板 id；`IMAGE_BATCH_STYLE_CLEAR` = 清空该节点的风格。 */
    styleTemplateId?: string;
};

export type ImageBatchPatchInput = {
    model?: string;
    size?: string;
    quality?: string;
    styleTemplateId?: string;
};

/**
 * 选区里真正能被批量设置的节点：**只认图片节点**。
 *
 * 图片 / 文本 / 视频混选是常态（用户框选一片画布），所以不能拿「选区大小」当目标数：
 * 对文本节点写 `quality`、对视频节点写 `size`（视频的 `size` 是画面比例，图片的是像素尺寸）
 * 都是坏数据。标注节点（Annotate）也不收 —— 它是画出来的图，没有生成参数可改。
 *
 * 正在生成的节点跳过：参数在任务飞出去之后再改不会影响那一条，只会让「跑完再生成」看起来
 * 像没生效（与视频批量同一条口径）。
 */
export function collectImageBatchTargets(
    nodes: readonly CanvasNodeData[],
    ids: Iterable<string>,
    options?: { isGenerating?: (id: string) => boolean },
): { ids: string[]; skippedGenerating: number } {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const targets: string[] = [];
    let skippedGenerating = 0;
    for (const id of ids) {
        const node = byId.get(id);
        if (!node || node.type !== CanvasNodeType.Image) continue;
        if (options?.isGenerating?.(id)) {
            skippedGenerating += 1;
            continue;
        }
        targets.push(id);
    }
    return { ids: targets, skippedGenerating };
}

/**
 * 把用户改过的字段拼成 patch。**空串一律不写**：
 * `quality: ""` 在画布上等于「没选过」，写进去会把节点从 `high` 悄悄变回默认档。
 * 风格是唯一例外：`IMAGE_BATCH_STYLE_CLEAR` 是有意义的「清空」，必须保留。
 */
export function buildImageBatchPatch(input: ImageBatchPatchInput): ImageBatchPatch {
    const patch: ImageBatchPatch = {};
    const model = String(input.model ?? "").trim();
    if (model) patch.model = model;
    const size = String(input.size ?? "").trim();
    if (size) patch.size = size;
    const quality = String(input.quality ?? "").trim();
    if (quality) patch.quality = quality;
    const styleTemplateId = String(input.styleTemplateId ?? "").trim();
    if (styleTemplateId) patch.styleTemplateId = styleTemplateId;
    return patch;
}

/** patch 里有没有东西可写（四个字段全空 = 用户什么都没选）。 */
export function hasImageBatchChange(patch: ImageBatchPatch): boolean {
    return Boolean(patch.model || patch.size || patch.quality || patch.styleTemplateId);
}

/**
 * patch → 真正写进 `metadata` 的对象。
 *
 * 风格的「清空」在这里翻译成 `styleTemplateId: undefined`：`applyNodeConfigPatch` 是展开合并，
 * `undefined` 会把字段盖成空（等价于节点面板里的「清除」）。**不能写空串** ——
 * `getStyleTemplate("")` 虽然也查不到，但导出配置 / 跨集沿用那几条链路只判 `undefined` 与空串是否
 * 相等，留一个空串会让「有没有风格」出现两种假值。
 */
export function imageBatchMetadataPatch(patch: ImageBatchPatch): Partial<CanvasNodeData["metadata"]> {
    const next: Partial<CanvasNodeData["metadata"]> = {};
    if (patch.model) next.model = patch.model;
    if (patch.size) next.size = patch.size;
    if (patch.quality) next.quality = patch.quality;
    if (patch.styleTemplateId) {
        next.styleTemplateId = patch.styleTemplateId === IMAGE_BATCH_STYLE_CLEAR ? undefined : patch.styleTemplateId;
    }
    return next;
}
