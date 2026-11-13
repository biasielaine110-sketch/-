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

/** 某个视频模型下可选的档位（只需要 `value`，label 是弹窗的事）。 */
export type VideoBatchModelChoices = {
    resolutions: ReadonlyArray<{ value: string }>;
    sizes: ReadonlyArray<{ value: string }>;
};

export type VideoBatchPlanTarget = {
    id: string;
    /** 节点当前存的清晰度；空 = 从没选过（让模型自己的默认档接管）。 */
    vquality?: string;
};

export type VideoBatchPlanOptions = {
    /** 「不改模型」时这个节点用哪个模型算档位（已按 capability=video 解析过）。 */
    modelOf: (id: string) => string;
    /** 某个模型下可选的分辨率 / 比例。 */
    choicesForModel: (model: string) => VideoBatchModelChoices;
    /**
     * 切到这个模型后，旧档位不属于新模型族时拿什么兜底。
     *
     * 返回空串 = 清掉旧值（`vquality: ""` 在画布上等于「没选过」，提交时走模型默认），
     * 好过留一个面板里根本点不亮的假档位（例如 relay H3 节点上留着聚算的 768p）。
     */
    fallbackVqualityForModel?: (model: string) => string;
};

export type VideoBatchPlan = {
    applyIds: string[];
    skippedIds: string[];
    /**
     * **逐节点**的 patch。
     *
     * 不能所有节点共用一份：切模型时每个节点的旧 `vquality` 不一样，要不要兜底、兜到哪一档
     * 都得按新模型族分别算（见 `fallbackVqualityForModel`）。
     */
    patches: Map<string, VideoBatchPatch>;
};

/**
 * 算出「每个节点到底写什么」。
 *
 * 为什么要逐节点过滤而不是照写：档位是按模型族给的（relay H3 只有 720/1080/2K、聚算只有 544/768、
 * AutoDL H3 是 workflow 自己的枚举）。硬写就会出现「面板里显示 2K、提交时被收成 768p」这种骗人的状态。
 *
 * 🔴 支持性判断必须对**切换后的模型**算：用户常常同时改模型 + 分辨率，拿旧模型判断会把整批跳过。
 */
export function planVideoBatchPatches(targets: readonly VideoBatchPlanTarget[], patch: VideoBatchPatch, options: VideoBatchPlanOptions): VideoBatchPlan {
    const applyIds: string[] = [];
    const skippedIds: string[] = [];
    const patches = new Map<string, VideoBatchPatch>();
    for (const target of targets) {
        const model = patch.model || options.modelOf(target.id);
        const choices = options.choicesForModel(model);
        const supportsResolution = (value: string) => choices.resolutions.some((item) => item.value === value);
        const supportsSize = (value: string) => choices.sizes.some((item) => item.value === value);

        // 用户点名要的档位这个模型给不了 → 整个节点跳过（部分写入会让节点处于半新半旧的自相矛盾状态）。
        if (patch.vquality && !supportsResolution(patch.vquality)) {
            skippedIds.push(target.id);
            continue;
        }
        if (patch.size && !supportsSize(patch.size)) {
            skippedIds.push(target.id);
            continue;
        }

        const nodePatch: VideoBatchPatch = {};
        if (patch.model) nodePatch.model = patch.model;
        if (patch.vquality) nodePatch.vquality = patch.vquality;
        if (patch.size) nodePatch.size = patch.size;
        // 只换了模型、没点名分辨率：旧档位若不属于新模型族，顺手换成新族默认（或清空）。
        if (patch.model && !patch.vquality) {
            const current = String(target.vquality ?? "").trim();
            if (current && !supportsResolution(current)) {
                nodePatch.vquality = options.fallbackVqualityForModel?.(model) ?? "";
            }
        }

        if (!nodePatch.model && !nodePatch.vquality && !nodePatch.size) {
            skippedIds.push(target.id);
            continue;
        }
        applyIds.push(target.id);
        patches.set(target.id, nodePatch);
    }
    return { applyIds, skippedIds, patches };
}
