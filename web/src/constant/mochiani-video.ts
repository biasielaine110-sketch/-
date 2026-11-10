import type { CanvasNodeMetadata } from "@/types/canvas";

/**
 * 视频「引擎」哨兵值（用户 2026-11-10 第 01 / 02 条）。
 *
 * 需求原话：「在脚本编辑器添加视频模型选择的选项……在这个基础上需要可选择 MochiAni 生视频节点，
 * 选择后在后续的铺视频链路的时候都铺出的是 MochiAni 节点窗口进行替换视频节点窗口」。
 *
 * 落库位置刻意**不是** `scriptVideoModel`：那个字段装的是 `channelId::model`，全站都拿它去
 * 查渠道 / 拼请求体（`modelOptionLabel`、`resolveModelRequestConfig`…），塞一个哨兵进去会被当成
 * 一个不存在的模型名，到处静默回落。所以另开一个字段 `scriptVideoEngine`，值就是这里的哨兵：
 *
 *  - 空 = 普通视频节点（老行为，一个字节不变）；
 *  - `"mochiani"` = 铺链路时建 `CanvasNodeType.Mochiani` 窗口，模型 / 渠道 / 参数取偏好里的 MochiAni 配置。
 *
 * 两处入口共用它：脚本节点标题栏的「视频模型」选择器（01）与反推节点「生成设置」里的模型选择（02）。
 */
export const MOCHIANI_VIDEO_ENGINE = "mochiani";

/** 值是不是「走 MochiAni 生视频节点」——只认这一个哨兵，其它（含脏值）都算普通视频。 */
export function isMochianiVideoEngine(value?: string | null): boolean {
    return String(value || "").trim().toLowerCase() === MOCHIANI_VIDEO_ENGINE;
}

/**
 * 偏好里的 MochiAni 配置（`AiConfig.mochiani`，用户 2026-11-10 第 03 条）。
 *
 * 存的是「铺链路建 MochiAni 节点时要预填什么」：模型（`modelKey`）、渠道（MochiAni 的线路池，
 * 同一模型可能挂多条）、生成模式（`videoCategory`：11=全能参考 / 3=多参考图 / 1=首尾帧 / 9=文生视频）、
 * 画幅偏好，以及一组自由参数（`params`，桥把它原样带给 MochiAni 的 `editableParameters`）。
 *
 * ⚠️ 全是可选/可为空：空 = 节点窗口里显示「未选」，由用户在节点里自己挑；铺链路不会因此报错。
 */
export type MochianiPreference = {
    modelKey: string;
    channelId: string;
    /** MochiAni 的 `specific_type`，字符串存（Select 值就是字符串），空 = 不干预。 */
    videoCategory: string;
    /** 画幅偏好（`9:16` / `16:9` / `1:1` …），铺链路时还会被脚本节点自己的视频比例覆盖。 */
    aspectRatio: string;
    /** 自由参数：桥原样透传（`model_size` / `lable1` …）。 */
    params: Record<string, string>;
};

export const DEFAULT_MOCHIANI_PREFERENCE: MochianiPreference = {
    modelKey: "",
    channelId: "",
    videoCategory: "",
    aspectRatio: "9:16",
    params: {},
};

/** 生成模式候选（与 MochiAni 节点的 `DEFAULT_VIDEO_CATEGORY` 同一套口径，文案在 i18n 里）。 */
export const MOCHIANI_VIDEO_CATEGORY_OPTIONS = ["11", "3", "1", "9"] as const;

/** 画幅候选：与 MochiAni 节点窗口里那排 chip 一致。 */
export const MOCHIANI_ASPECT_RATIO_OPTIONS = ["9:16", "16:9", "1:1", "3:4", "4:3"] as const;

/**
 * 读偏好（逐字段回落默认值）。
 *
 * 配置是**浅合并**持久化的（`{...defaultConfig, ...persistedConfig}`），所以老配置里没有
 * `mochiani`、或者只有半个对象都是常态 —— 这里逐字段兜底，绝不直接展开成 `undefined`。
 */
export function resolveMochianiPreference(config?: { mochiani?: Partial<MochianiPreference> | null } | null): MochianiPreference {
    const saved = config?.mochiani || {};
    const params = saved.params && typeof saved.params === "object" ? saved.params : {};
    return {
        modelKey: String(saved.modelKey || "").trim(),
        channelId: String(saved.channelId || "").trim(),
        videoCategory: String(saved.videoCategory ?? "").trim(),
        aspectRatio: String(saved.aspectRatio || "").trim() || DEFAULT_MOCHIANI_PREFERENCE.aspectRatio,
        params: Object.fromEntries(Object.entries(params).filter(([, value]) => typeof value === "string" && value.trim()).map(([key, value]) => [key, String(value)])),
    };
}

/** 偏好里有没有真的填过东西（决定铺链路时要不要往节点里写 `mochianiConfig`）。 */
export function hasMochianiPreference(pref: MochianiPreference): boolean {
    return Boolean(pref.modelKey || pref.channelId || pref.videoCategory || Object.keys(pref.params).length);
}

/**
 * 偏好 + 本次覆盖（脚本节点的视频比例）→ 节点 `metadata.mochianiConfig`。
 *
 * 只写**有值**的键：空对象等于「节点保持默认」，MochiAni 面板会自己去桥里读模型目录，
 * 而不是被一个空 `modelKey` 卡成「模型已删除」。
 */
export function buildMochianiNodeConfig(pref: MochianiPreference, overrides?: { aspectRatio?: string }): NonNullable<CanvasNodeMetadata["mochianiConfig"]> {
    const aspectRatio = String(overrides?.aspectRatio || "").trim() || pref.aspectRatio || "";
    const category = Number(pref.videoCategory);
    return {
        ...(pref.modelKey ? { modelKey: pref.modelKey } : {}),
        ...(pref.channelId ? { channelId: pref.channelId } : {}),
        ...(Object.keys(pref.params).length ? { params: { ...pref.params } } : {}),
        // 0 / NaN = 不干预（沿用页面当前模式），别写成 0。
        ...(Number.isFinite(category) && category > 0 ? { videoCategory: category } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
    };
}
