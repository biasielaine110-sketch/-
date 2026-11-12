/**
 * 聚算 Hub（`*.jusuanhub.com`）媒体协议层 —— 2026-11-12 接入 `qwen-image-2.1` / `minimax-h3`。
 *
 * 这一家不是 OpenAI 形状：两种媒体都是**异步 job**，而且参数名完全自成一派。
 * 契约来源不是 /docs/image、/docs/video 那两张通用页（门户里写着「本站暂未开放该类型的模型」，
 * 只有 endpoint 和「提交 → 查询 → 下载」三段），真正的字段表在门户的公开模型接口：
 *
 *   GET /api/models/{model}   →  { endpoint, contract{...}, requestFields[...] }
 *
 * 实测到的要点（改动前请先复核这个接口，别凭记忆改）：
 *
 *   qwen-image-2.1   POST /v1/images/generations
 *     · 必填 model / prompt（≤10000 字）
 *     · 画幅**只收 14 个白名单值**（7 比例 × 2 清晰度档），传别的直接 400；
 *       标准档 `1024x1024 … 896x1184`、超清档 `1536x2752 … 2752x1536`
 *     · 参考图 `input_image_urls`（0–10 张，公网 URL 或 `data:image`）；没有上传接口、
 *       也不收 `*_asset_id`（给了会 `asset_id_not_supported`）
 *     · steps 固定 8、guidance_scale 固定 1、imageCount 固定 1 —— 一个都别发
 *
 *   minimax-h3       POST /v1/media/generations
 *     · 必填 model / prompt（≤7000）/ **seconds（整数 5–15）** / **generationMode**
 *     · generationMode 四选一，且必须和素材精确匹配：
 *         t2v（无图）/ i2v（首帧 input_image_url）/ first_last_frame_video（+ end_image_url）
 *         / universal_reference_video（referenceInputs[] ≤9 图 + 1 视频 + 3 音频）
 *     · 可选 resolutionTier（544p|768p）、aspectRatio（16:9|1:1|21:9|3:4|4:3|9:16）
 *
 *   两者共用：`GET /v1/jobs/{jobId}` → 终态读 `outputs[].contentUrl`；
 *   🔴 **下载 contentUrl 也要带同一个 Bearer**，所以结果必须由前端取回二进制再转 dataURL，
 *      直接丢给 `<img src>` / `<video src>` 只会拿到 401。
 *
 * 这里只放**纯逻辑**（谓词 / 尺寸表 / 请求体 / 响应解析），不碰 axios —— 探针可以直接喂 JSON。
 * 真正的收发在 image.ts / video.ts 里，用它们各自已有的 aiApiUrl / aiHeaders。
 */

/** `https://yuanhuisuan.space.jusuanhub.com` 之类都算；也接受已带 `/v1` 的写法。 */
export function isJusuanhubMediaBaseUrl(baseUrl: string): boolean {
    const raw = String(baseUrl || "").trim();
    if (!raw) return false;
    try {
        const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
        return /(^|\.)jusuanhub\.com$/i.test(host);
    } catch {
        return /(^|\.)jusuanhub\.com(\/|:|$)/i.test(raw);
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 图片：qwen-image-2.1
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * 7 种比例 × 2 档清晰度。**这是白名单，不是可推算的公式**：上游对不认识的尺寸直接 400，
 * 所以只能查表 + 找最近比例，绝不能把任意 `WxH` 直接塞过去。
 *
 * 比例标签按「横 → 方 → 竖」排，`1:1` 放第一位是给「猜不出来时」当兜底的。
 */
export const JUSUANHUB_IMAGE_SIZE_TABLE = {
    standard: {
        "1:1": "1024x1024",
        "16:9": "1376x768",
        "4:3": "1184x896",
        "3:2": "1248x832",
        "9:16": "768x1376",
        "3:4": "896x1184",
        "2:3": "832x1248",
    },
    ultra: {
        "1:1": "2048x2048",
        "16:9": "2752x1536",
        "4:3": "2400x1792",
        "3:2": "2528x1696",
        "9:16": "1536x2752",
        "3:4": "1792x2400",
        "2:3": "1696x2528",
    },
} as const;

export type JusuanhubImageTier = keyof typeof JUSUANHUB_IMAGE_SIZE_TABLE;

/** 所有合法画幅（14 个），给探针 / 兜底校验用。 */
export function listJusuanhubImageSizes(): string[] {
    return [
        ...Object.values(JUSUANHUB_IMAGE_SIZE_TABLE.standard),
        ...Object.values(JUSUANHUB_IMAGE_SIZE_TABLE.ultra),
    ];
}

const JUSUANHUB_RATIO_PRESETS: Array<{ label: keyof (typeof JUSUANHUB_IMAGE_SIZE_TABLE)["standard"]; value: number }> = [
    { label: "1:1", value: 1 },
    { label: "16:9", value: 16 / 9 },
    { label: "4:3", value: 4 / 3 },
    { label: "3:2", value: 3 / 2 },
    { label: "9:16", value: 9 / 16 },
    { label: "3:4", value: 3 / 4 },
    { label: "2:3", value: 2 / 3 },
];

/** 把 `9:16` / `1024x1536` / `auto` / 空 都收成一个比例标签；认不出给 `1:1`。 */
export function resolveJusuanhubImageRatio(size: string): keyof (typeof JUSUANHUB_IMAGE_SIZE_TABLE)["standard"] {
    const raw = String(size || "").trim();
    if (!raw || /^(auto|adaptive|adaptive)$/i.test(raw)) return "1:1";
    const ratioMatch = raw.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    const sizeMatch = raw.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
    const pair = ratioMatch
        ? [Number(ratioMatch[1]), Number(ratioMatch[2])]
        : sizeMatch
          ? [Number(sizeMatch[1]), Number(sizeMatch[2])]
          : null;
    if (!pair || !(pair[0] > 0) || !(pair[1] > 0)) return "1:1";
    const ratio = pair[0] / pair[1];
    let best = JUSUANHUB_RATIO_PRESETS[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const preset of JUSUANHUB_RATIO_PRESETS) {
        const distance = Math.abs(Math.log(ratio) - Math.log(preset.value));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = preset;
        }
    }
    return best.label;
}

/**
 * 质量档 → 清晰度档。`QUALITY_BASE`（image.ts）里 1024 是 `低/标准`，2048 起才是 `中/高/HD/2K`，
 * 所以 ≥2048 一律进超清档（超清档短边 1536 起，正好对上 2K 的观感）。
 */
export function resolveJusuanhubImageTier(quality?: string): JusuanhubImageTier {
    const value = String(quality || "").trim().toLowerCase();
    if (!value) return "standard";
    if (/^(medium|hd|high|xhigh|max|2k|4k|1536|2048|2880|3328|3840)$/.test(value)) return "ultra";
    return "standard";
}

/** 最终发给上游的 `size`（只可能是那 14 个值之一）。 */
export function resolveJusuanhubImageSize(size: string, quality?: string): string {
    const tier = resolveJusuanhubImageTier(quality);
    const ratio = resolveJusuanhubImageRatio(size);
    return JUSUANHUB_IMAGE_SIZE_TABLE[tier][ratio];
}

export type JusuanhubImageRequestBody = {
    model: string;
    prompt: string;
    size: string;
    input_image_urls?: string[];
};

/**
 * 上游只收**公网 http(s) 地址**。`data:` / `blob:` 一律剔掉：这家 nginx 对请求体里的
 * `data:image` 直接 403（实测，1×1 的也一样），字面上「支持」但根本过不去。
 */
function publicHttpUrls(values: string[] | undefined, limit: number): string[] {
    return (values || [])
        .map((value) => String(value || "").trim())
        .filter((value) => /^https?:\/\//i.test(value))
        .slice(0, limit);
}

/**
 * 文生图 / 图生图共用一个请求体：有参考图就带 `input_image_urls`（数组），没有就是纯文生图。
 *
 * 不发 `imageCount` / `steps` / `guidance_scale`：上游把这三个写死成 1 / 8 / 1，
 * 发别的值（哪怕一样）只是在给 400 多开一个口子。
 */
export function buildJusuanhubImageRequestBody(input: {
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
    imageUrls?: string[];
}): JusuanhubImageRequestBody {
    const urls = publicHttpUrls(input.imageUrls, 10);
    return {
        model: String(input.model || "").trim(),
        prompt: String(input.prompt || ""),
        size: resolveJusuanhubImageSize(input.size || "", input.quality),
        ...(urls.length ? { input_image_urls: urls } : {}),
    };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 视频：minimax-h3
// ════════════════════════════════════════════════════════════════════════════════════════

/** 上游只收 5–15 秒的**整数**（枚举，不是区间），越界会被 400。 */
export const JUSUANHUB_VIDEO_MIN_SECONDS = 5;
export const JUSUANHUB_VIDEO_MAX_SECONDS = 15;

export function resolveJusuanhubVideoSeconds(value: string | number | undefined): number {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) return JUSUANHUB_VIDEO_MIN_SECONDS;
    return Math.min(JUSUANHUB_VIDEO_MAX_SECONDS, Math.max(JUSUANHUB_VIDEO_MIN_SECONDS, numeric));
}

const JUSUANHUB_VIDEO_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export type JusuanhubVideoAspect = (typeof JUSUANHUB_VIDEO_ASPECTS)[number];

/** 与 `normalizeVideoRatio` 同一套比例（含 21:9），但这里是本模块自足的，避免与 video.ts 循环引用。 */
export function resolveJusuanhubVideoAspect(size: string): JusuanhubVideoAspect {
    const raw = String(size || "").trim();
    if (!raw || /^auto$/i.test(raw) || /^adaptive$/i.test(raw)) return "16:9";
    if ((JUSUANHUB_VIDEO_ASPECTS as readonly string[]).includes(raw)) return raw as JusuanhubVideoAspect;
    const ratioMatch = raw.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    const sizeMatch = raw.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
    const pair = ratioMatch
        ? [Number(ratioMatch[1]), Number(ratioMatch[2])]
        : sizeMatch
          ? [Number(sizeMatch[1]), Number(sizeMatch[2])]
          : null;
    if (!pair || !(pair[0] > 0) || !(pair[1] > 0)) return "16:9";
    const ratio = pair[0] / pair[1];
    let best: JusuanhubVideoAspect = "16:9";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const aspect of JUSUANHUB_VIDEO_ASPECTS) {
        const [w, h] = aspect.split(":").map(Number);
        const distance = Math.abs(Math.log(ratio) - Math.log(w / h));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = aspect;
        }
    }
    return best;
}

/**
 * 清晰度只有 544p / 768p 两档：`vquality` 里 ≤600 的（480/544/576）进 544p，
 * 其余（720/768/900/1080/2K…）一律 768p —— 上游没有更高档，传 1080p 只会 400。
 */
export function resolveJusuanhubVideoResolutionTier(vquality: string): "544p" | "768p" {
    const raw = String(vquality || "").trim().toLowerCase();
    const numeric = Number(raw.replace(/p$/, ""));
    if (Number.isFinite(numeric) && numeric > 0 && numeric <= 600) return "544p";
    return "768p";
}

/**
 * 面板只该给这两档（列表顺序 = 面板顺序）。`value` 就是 `resolutionTier` 去掉 p。
 *
 * 544p 不是「缩水选项」而是正经一档：16:9 出 960×544、21:9 出 1280×544、9:16 出 544×960，
 * 出片快、适合先看构图再重跑。以前面板借用了 relay H3 的 `720/1080/2K`，三个值全被后端
 * 收成 768p —— 用户点 1080p 拿到的仍是 768p，等于在骗人。
 */
export const JUSUANHUB_VIDEO_RESOLUTION_OPTIONS = [
    { value: "544", label: "544p" },
    { value: "768", label: "768p" },
] as const;

/**
 * 画布上存的 `vquality` 是历史遗留的（可能有 480 / 720 / 1080 / 2k），
 * 一律收敛成这两档之一，否则面板会出现「一个都不选中」。
 */
export function normalizeJusuanhubVideoQuality(vquality: string): "544" | "768" {
    return resolveJusuanhubVideoResolutionTier(vquality) === "544p" ? "544" : "768";
}

export type JusuanhubVideoMode = "t2v" | "i2v" | "first_last_frame_video" | "universal_reference_video";

/**
 * 参考图数量 → generationMode。**上游要求「模式与素材精确匹配」，猜错会 400**：
 *   0 张 → t2v
 *   1 张 → i2v（首帧）—— 画布里「连一条图片到视频节点」就是这个意思
 *   ≥2 张 → universal_reference_video（全能参考，≤9 张）
 *
 * 为什么不给 2 张走 `first_last_frame_video`：本项目里连到视频节点的多张图是**角色/场景/道具参考**
 * （一键铺链路就是这么连的），把它们当成「首帧+尾帧」会直接改变出片内容。
 * 真要首尾帧，得先在节点上给出「谁是尾帧」的入口，否则这里没有可靠依据。
 */
export function resolveJusuanhubVideoMode(referenceCount: number): JusuanhubVideoMode {
    const count = Math.max(0, Math.floor(Number(referenceCount) || 0));
    if (count === 0) return "t2v";
    if (count === 1) return "i2v";
    return "universal_reference_video";
}

export type JusuanhubVideoRequestBody = {
    model: string;
    prompt: string;
    seconds: number;
    generationMode: JusuanhubVideoMode;
    aspectRatio: JusuanhubVideoAspect;
    resolutionTier: "544p" | "768p";
    input_image_url?: string;
    referenceInputs?: Array<{ role: "reference_image"; url: string }>;
};

export function buildJusuanhubVideoRequestBody(input: {
    model: string;
    prompt: string;
    seconds?: string | number;
    size?: string;
    vquality?: string;
    imageUrls?: string[];
}): JusuanhubVideoRequestBody {
    const urls = publicHttpUrls(input.imageUrls, 9);
    const generationMode = resolveJusuanhubVideoMode(urls.length);
    return {
        model: String(input.model || "").trim(),
        prompt: String(input.prompt || ""),
        seconds: resolveJusuanhubVideoSeconds(input.seconds),
        generationMode,
        aspectRatio: resolveJusuanhubVideoAspect(input.size || ""),
        resolutionTier: resolveJusuanhubVideoResolutionTier(input.vquality || ""),
        ...(generationMode === "i2v" && urls[0] ? { input_image_url: urls[0] } : {}),
        ...(generationMode === "universal_reference_video"
            ? { referenceInputs: urls.map((url) => ({ role: "reference_image" as const, url })) }
            : {}),
    };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 共用：job 提交响应 / 查询响应
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * 提交响应是 `{ jobId, status:"queued", retryAfterSeconds }`；兼容驼峰/下划线/包一层 `data`。
 * 注意它**不是** `{ id }`，所以通用 `unwrapVideoResponse` / `isAsyncImageTask` 都认不出来。
 */
export function readJusuanhubJobId(payload: unknown): string {
    const record = asRecord(payload) || {};
    const data = asRecord(record.data) || {};
    for (const candidate of [record.jobId, record.job_id, data.jobId, data.job_id, record.id, data.id]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
}

/** 提交时若上游直接给了结果（个别 publication 会同步返回），也能吃到。 */
export function readJusuanhubOutputUrls(payload: unknown): string[] {
    const record = asRecord(payload) || {};
    const outputs = Array.isArray(record.outputs) ? record.outputs : Array.isArray((asRecord(record.data) || {}).outputs) ? (asRecord(record.data) || {}).outputs : [];
    const urls: string[] = [];
    for (const item of outputs as unknown[]) {
        const output = asRecord(item);
        if (!output) {
            if (typeof item === "string" && item.trim()) urls.push(item.trim());
            continue;
        }
        for (const key of ["contentUrl", "content_url", "url", "downloadUrl", "download_url"]) {
            const value = output[key];
            if (typeof value === "string" && value.trim()) {
                urls.push(value.trim());
                break;
            }
        }
    }
    return urls;
}

export type JusuanhubJobState =
    | { status: "pending"; retryAfterSeconds?: number }
    | { status: "succeeded"; urls: string[] }
    | { status: "failed"; error: string };

const JUSUANHUB_PENDING_STATUS = new Set(["queued", "pending", "running", "processing", "scheduled", "in_progress", "waiting", "submitted"]);
const JUSUANHUB_SUCCESS_STATUS = new Set(["succeeded", "success", "completed", "complete", "done", "finished", "ok"]);
const JUSUANHUB_FAILURE_STATUS = new Set(["failed", "failure", "canceled", "cancelled", "expired", "error", "rejected"]);

/**
 * 查询响应：`{ id, status, outputs:[{ contentUrl }], error?, retryAfterSeconds? }`。
 * 状态词按「先认成功、再认失败、其余当排队」处理 —— 认不出来时宁可继续等，
 * 也不要因为多了个没见过的词就报「生成失败」。
 */
export function readJusuanhubJobState(payload: unknown): JusuanhubJobState {
    const record = asRecord(payload) || {};
    const data = asRecord(record.data) || record;
    const status = String(data.status || record.status || "").trim().toLowerCase();
    const urls = readJusuanhubOutputUrls(data);
    const retryRaw = Number(data.retryAfterSeconds ?? record.retryAfterSeconds);
    const retryAfterSeconds = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.min(30, retryRaw) : undefined;

    if (JUSUANHUB_SUCCESS_STATUS.has(status)) {
        return urls.length ? { status: "succeeded", urls } : { status: "failed", error: "任务成功但响应里没有 outputs[].contentUrl" };
    }
    if (JUSUANHUB_FAILURE_STATUS.has(status)) {
        const error = asRecord(data.error) || asRecord(record.error) || {};
        const message =
            firstString([error.message, error.code, data.failureReason, data.failure_reason, data.message, record.message]) ||
            "任务失败（上游未给原因）";
        return { status: "failed", error: message };
    }
    if (JUSUANHUB_PENDING_STATUS.has(status) || !status) return { status: "pending", retryAfterSeconds };
    // 没见过的状态词：当排队继续等，别误判成失败。
    return { status: "pending", retryAfterSeconds };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 共用：成片完整性速查（MP4 头尾）
// ════════════════════════════════════════════════════════════════════════════════════════

export type JusuanhubMp4Verdict = { ok: true } | { ok: false; reason: "empty" | "not_mp4" | "missing_moov" };

/**
 * 判断「拿到的字节到底是不是一条能播的 MP4」。
 *
 * 为什么必须查：Chrome 对「不是容器 / 容器残缺」一律只报
 * `PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`，
 * 排查时看不出到底是 401 的 JSON、代理的错误页，还是下载被截断。
 *
 * 判定依据是 MP4 的 box 结构，不是文件大小：
 *  · 第 4–8 字节必须是 `ftyp`（Lavf/x264 输出必有）；
 *  · 必须有 `moov`（描述轨道/时长的索引）。Lavf 默认先写 `mdat` 再写 `moov`，
 *    所以**被截断的下载恰恰缺 moov** —— 这一条正好对上那个 demuxer 报错。
 *  · `moov` 可能在头部（faststart，实测这家就是偏移 36）也可能在尾部，
 *    所以头尾各取一段来扫，别只查前 N 字节。
 */
export function inspectJusuanhubMp4(input: { size: number; head: Uint8Array; tail: Uint8Array }): JusuanhubMp4Verdict {
    if (!input.size || input.head.length < 12) return { ok: false, reason: "empty" };
    if (asciiAt(input.head, 4, "ftyp")) {
        if (containsAscii(input.head, "moov") || containsAscii(input.tail, "moov")) return { ok: true };
        return { ok: false, reason: "missing_moov" };
    }
    // 有的封装把 ftyp 放得很靠后（少见）；头里没有就再看尾。
    if (containsAscii(input.tail, "ftyp") && containsAscii(input.tail, "moov")) return { ok: true };
    return { ok: false, reason: "not_mp4" };
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i += 1) {
        if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
    if (bytes.length < text.length) return false;
    const first = text.charCodeAt(0);
    const last = bytes.length - text.length;
    for (let i = 0; i <= last; i += 1) {
        if (bytes[i] !== first) continue;
        if (asciiAt(bytes, i, text)) return true;
    }
    return false;
}

/**
 * 文本响应（401 的 JSON、代理的错误页）不可能是视频。
 * 用于把「存了个假的 video/mp4」当场拦下，而不是等用户点播放才炸。
 */
export function looksLikeTextPayload(input: { head: Uint8Array; contentType?: string }): boolean {
    const type = String(input.contentType || "").toLowerCase();
    if (type.includes("json") || type.startsWith("text/") || type.includes("html") || type.includes("xml")) return true;
    let i = 0;
    // 跳过 BOM 与空白，看第一个非空白字节是不是 `{` / `[` / `<`。
    while (i < input.head.length && i < 64) {
        const byte = input.head[i];
        if (byte === 0xef || byte === 0xbb || byte === 0xbf || byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00) {
            i += 1;
            continue;
        }
        return byte === 0x7b || byte === 0x5b || byte === 0x3c;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 共用：429 限流重试（纯逻辑；真正的收发在 jusuanhub-retry.ts）
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * 这一家的 429 含义很具体：**账户级排队/并发额度瞬时打满**，不是参数错、也不是 Key 错。
 * 门户的 `GET /v1/admission` 里能看到 `queued.maxUnits: 80` / `running.maxUnits: 24`，
 * 视频连着提几条很容易撞上；响应还会带 `Retry-After`（实测 `3`）。
 *
 * 所以「立刻失败」是最差的选择：等几秒重发**同一个 body**就能进队。代价是白等一个 job。
 */
export const JUSUANHUB_RETRY_MAX_ATTEMPTS = 4;
export const JUSUANHUB_RETRY_BASE_DELAY_MS = 3_000;
export const JUSUANHUB_RETRY_MAX_DELAY_MS = 30_000;

/**
 * 只重试「等一会儿就好」的状态码。
 * 502/504 也带 5xx，但那是上游真的炸了或网关超时，重试只会让用户多等一倍还没结果。
 */
export function isJusuanhubRetryableStatus(status: number): boolean {
    return status === 429;
}

/**
 * 解析 `Retry-After`：既接受 `3`（秒）也接受 HTTP-date；
 * 顺带认 `x-ratelimit-reset` 那类（常见是 epoch 秒）。认不出来就返回 undefined，交给调用方退避。
 */
export function readJusuanhubRetryAfterMs(headers: unknown, now = Date.now()): number | undefined {
    const record = asRecord(headers);
    if (!record) return undefined;
    let raw: unknown;
    for (const [key, value] of Object.entries(record)) {
        const name = key.toLowerCase();
        if (name === "retry-after" || name === "x-ratelimit-reset-after" || name === "x-ratelimit-reset") {
            raw = value;
            break;
        }
    }
    if (raw === undefined || raw === null) return undefined;
    const text = (Array.isArray(raw) ? String(raw[0] ?? "") : String(raw)).trim();
    if (!text) return undefined;
    let ms: number;
    if (/^\d+(\.\d+)?$/.test(text)) {
        const numeric = Number(text);
        // 秒数 vs epoch 秒：`retry-after: 3` 是秒，`1750000000` 是时间点。
        ms = numeric > 1e9 ? numeric * 1000 - now : numeric * 1000;
    } else {
        const at = Date.parse(text);
        if (!Number.isFinite(at)) return undefined;
        ms = at - now;
    }
    if (!Number.isFinite(ms)) return undefined;
    return Math.min(JUSUANHUB_RETRY_MAX_DELAY_MS, Math.max(0, ms));
}

/**
 * 第 `attempt` 次重试（0 起）前等多久。
 *
 * 取「服务端 hint」与「指数退避」的**较大值**：实测 `Retry-After: 3` 在连发几条时不够抢回额度，
 * 光信它就会进入「3 秒撞一次」的循环。抖动是**确定性**的（`attempt*173 % 400`）而不是随机数：
 * 一是让同批并发 job 错开同一毫秒重新撞墙，二是探针能断言出确切值。
 *
 * `baseMs` 只为探针留口子（传 1 就能在毫秒级验完重试环），生产一律用默认值。
 */
export function resolveJusuanhubRetryDelayMs(attempt: number, serverHintMs?: number, baseMs = JUSUANHUB_RETRY_BASE_DELAY_MS): number {
    const step = Math.max(0, Math.floor(Number(attempt) || 0));
    const hint = Number.isFinite(serverHintMs) && Number(serverHintMs) > 0 ? Number(serverHintMs) : 0;
    const base = Number.isFinite(baseMs) && Number(baseMs) > 0 ? Number(baseMs) : JUSUANHUB_RETRY_BASE_DELAY_MS;
    const backoff = base * Math.pow(2, step);
    const jitter = (step * 173) % 400;
    return Math.min(JUSUANHUB_RETRY_MAX_DELAY_MS, Math.max(hint, backoff) + jitter);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(values: unknown[]): string {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}
