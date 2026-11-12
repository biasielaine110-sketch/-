/**
 * 右键「批量设置视频参数」的纯逻辑（2026-11-13 用户要求：选中多个视频窗口，右键批量切换模型 / 分辨率 / 比例）。
 *
 * 只做三件不需要 React 的事：挑出该改哪些节点、把用户改过的字段拼成 patch、按「该节点自己的档位」筛掉不支持的。
 * 档位本身（哪些分辨率 / 比例可选）不在这里算 —— 那是 `video-settings-panel.tsx` 的
 * `videoResolutionChoicesFor` / `videoSizeChoicesFor`，单一来源，别在批量里另抄一份。
 */
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** 批量设置里的「不修改」：空串即不动这个字段（绝不能被当成合法值写进节点）。 */
export const VIDEO_BATCH_UNCHANGED = "";

/** 真正写到节点 metadata 上的字段（只这三个，且都有值才写）。 */
export type VideoBatchPatch = { model?: string; vquality?: string; size?: string };

export type VideoBatchPatchInput = {
    /** 目标模型（`channelId::modelName`）；空 = 不改模型。 */
    model?: string;
    /** 清晰度档位（`vquality`）；空 = 不改。 */
    vquality?: string;
    /** 画面比例（`size`，如 `16:9`）；空 = 不改。 */
    size?: string;
};

/**
 * 选区里真正能被批量设置的节点：**只认视频节点**。
 *
 * 图片 / 文本混选是常态（用户框选一片画布），所以不能拿「选区大小」当目标数，
 * 也不能对非视频节点写 `vquality`（图片节点的 `size` 是像素尺寸，写 `16:9` 会直接坏掉）。
 * 正在生成的节点跳过：生成中途改参数不会影响已经在飞的那一条，只会让「跑完再生成」看起来像没生效。
 */
export function collectVideoBatchTargets(
    nodes: readonly CanvasNodeData[],
    ids: Iterable<string>,
    options?: { isGenerating?: (id: string) => boolean },
): { ids: string[]; skippedGenerating: number } {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const targets: string[] = [];
    let skippedGenerating = 0;
    for (const id of ids) {
        const node = byId.get(id);
        if (!node || node.type !== CanvasNodeType.Video) continue;
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
 * `vquality: ""` 在画布上等于「没选过」，写进去会把节点从「544p」悄悄变回默认档。
 */
export function buildVideoBatchPatch(input: VideoBatchPatchInput): VideoBatchPatch {
    const patch: VideoBatchPatch = {};
    const model = String(input.model ?? "").trim();
    if (model) patch.model = model;
    const vquality = String(input.vquality ?? "").trim();
    if (vquality) patch.vquality = vquality;
    const size = String(input.size ?? "").trim();
    if (size) patch.size = size;
    return patch;
}

/** patch 里有没有东西可写（三个字段全空 = 用户什么都没选）。 */
export function hasVideoBatchChange(patch: VideoBatchPatch): boolean {
    return Boolean(patch.model || patch.vquality || patch.size);
}

/**
 * 合并多份档位列表（**并集**，按首次出现的顺序）。
 *
 * 混选时各节点模型族不同，档位表也不一样（relay 有 2K、聚算只有 544/768…）。
 * 弹窗里给出并集，让用户至少能选到「一部分节点支持」的值；真正落盘前再用
 * `planVideoBatchSettings` 按节点自己的档位筛一遍，不支持的节点会被明确跳过。
 */
export function unionChoices(lists: ReadonlyArray<ReadonlyArray<{ value: string; label: string }>>): Array<{ value: string; label: string }> {
    const seen = new Map<string, string>();
    for (const list of lists) {
        for (const item of list) {
            if (!seen.has(item.value)) seen.set(item.value, item.label);
        }
    }
    return Array.from(seen, ([value, label]) => ({ value, label }));
}

/**
 * 按「这个节点自己支持的档位」过滤。
 *
 * 为什么要过滤而不是照写：档位是按模型族给的（relay H3 只有 720/1080/2K、聚算只有 544/768、
 * AutoDL H3 是 workflow 自己的枚举）。混选里的节点模型各不相同，硬写就会出现
 * 「面板里显示 2K、提交时被收成 768p」这种骗人的状态。
 */
export function planVideoBatchSettings(
    targetIds: readonly string[],
    patch: VideoBatchPatch,
    isSupported: (id: string) => boolean,
): { applyIds: string[]; skippedIds: string[] } {
    const applyIds: string[] = [];
    const skippedIds: string[] = [];
    for (const id of targetIds) (isSupported(id) ? applyIds : skippedIds).push(id);
    return { applyIds, skippedIds };
}
