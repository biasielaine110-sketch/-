/**
 * 04「剧集批量生成」的纯逻辑：**把一份剧本拆成多集**。
 *
 * 用户 2026-11-17 第 04 条口径：
 * 「在反推视频节点，加入 04 剧集批量生成选项……执行时先调用技能中的 **15秒-小说转剧本分镜** 技能
 *  进行拆分成不同时间长度的文本节点（按照我约束的 120 秒一集进行分集剧本，每拆出来一份 120 秒的
 *  文本内容就是一集，就输出到一个文本节点），输出的多个文本节点依次向下进行排列，然后再根据勾选的
 *  内容再开始生成分镜、一键生图、一键生视频」。
 *
 * 为什么要把「拼提示词 / 解析结果」放在这里而不是写在 `project.tsx`：
 *  ① 拆集是**一次模型调用 + 一次解析**，解析器必须能被探针直接测（JSON / 代码块 / 分集标记 /
 *     整段没有标记 → 单集兜底，这几种形态线上都会出现）；
 *  ② 「一集 = N 秒」这件事同时喂给提示词与脚本节点（`scriptTotalSeconds`），口径写在一处才不会漂。
 *
 * ⚠️ 本模块**不 import i18n / store**：探针在 Node 里直接 import，`@/i18n` 顶层读 localStorage 会崩。
 */

import { CANVAS_FREE_SPACE_GAP, canvasRectsOverlap, type CanvasFreeRect } from "@/lib/canvas/canvas-free-space";
import type { Position } from "@/types/canvas";

/** 每集时长的默认值（用户口径：120 秒一集）。 */
export const DEFAULT_EPISODE_SECONDS = 120;
/**
 * 每集时长可调范围。
 *
 * 上限刻意与 `SCRIPT_TOTAL_SECONDS_MAX`（300，脚本节点「成片总时长」的上限）对齐：
 * 04 每一集的时长同时就是那一集脚本节点的 `scriptTotalSeconds`，这里给 900 的话
 * `resolveScriptTotalSeconds` 会把它**静默夹成 300** —— 用户填 600、界面显示 600、
 * 实际按 300 规划镜头，还找不到原因。宁可填不进去，也不要静默改数。
 */
export const EPISODE_SECONDS_MIN = 15;
export const EPISODE_SECONDS_MAX = 300;

/**
 * 拆集用的技能（唯一来源）。
 *
 * 🔴 只给这一个精确名，不加宽松变体：`pickVideoReverseSkill` 是双向包含匹配（见 `video-reverse.ts`
 * 里那段「短名不认反向包含」的注释），加一个「小说转剧本」之类的泛名会跟别的技能串味。
 */
export const EPISODE_SPLIT_SKILL_HINTS = ["15秒-小说转剧本分镜"] as const;
export const EPISODE_SPLIT_SKILL_LABEL = EPISODE_SPLIT_SKILL_HINTS[0];

/** 每集时长的有效值：非法 / 空 → 120；超范围夹到区间内取整。 */
export function resolveEpisodeSeconds(raw: number | string | null | undefined): number {
    const value = Number(String(raw ?? "").trim());
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_EPISODE_SECONDS;
    return Math.min(EPISODE_SECONDS_MAX, Math.max(EPISODE_SECONDS_MIN, Math.round(value)));
}

/** 一集剧本的默认标题（`第1集`）。集号从 1 开始，与用户看到的顺序一致。 */
export function buildEpisodeTitle(index: number, raw?: string | null): string {
    const title = String(raw ?? "").trim();
    if (title) return title;
    return `第${Math.max(1, Math.round(index) + 1)}集`;
}

/** 拆集提示词里那句「一集多少秒」。 */
function episodeSecondsRule(seconds: number): string {
    return `每集时长 **${seconds} 秒**（这是硬要求：一集的剧本要正好够拍 ${seconds} 秒，镜头数与台词量都按 ${seconds} 秒规划，多一秒少一秒都要重新分配；不要把两集的内容塞进一集，也不要把一集拆成好几集）。`;
}

/**
 * 04 的输入要求（拼在提示词里）：只输出 JSON、按集切、保持剧情顺序。
 *
 * 为什么要**强制 JSON**：解析器要拿它去建 N 个文本节点，一旦模型写成「第一集……\n第二集……」
 * 那种散文，后面就得靠猜边界；JSON 是唯一能确定性对上的形态（解析器仍保留散文兜底，但那是备胎）。
 */
export const EPISODE_SPLIT_OUTPUT_RULE =
    "输出格式（最高优先级硬要求）：**只输出一个 JSON 对象**，不要 Markdown 代码块、不要解释、不要前言后语、不要写任何分析。结构必须是：\n" +
    '{"episodes":[{"title":"第1集","script":"这一集的剧本正文……"},{"title":"第2集","script":"……"}]}\n' +
    "约束：① `episodes` 至少 1 项，顺序就是剧情顺序；② `title` 用「第N集」（N 从 1 开始）；③ `script` 是**可以直接开拍的分集剧本正文**（场景 / 镜头 / 画面 / 台词 / 时长），字符串里的换行用 \\n 转义；④ 每集 `script` 的时长必须等于规定的每集时长，全部集数加起来覆盖整份剧本的剧情，不许漏、不许重复、不许改变剧情顺序与人物关系。";

/**
 * 拼发给 AI 的那段话（04）。
 *
 * 结构：语言规则 → 用哪个技能 → 干什么 → 每集时长 → 特殊要求 → 原文剧本 → 输出格式 → 语言规则（收口）。
 * 语言规则首尾各钉一次，与 01 / 02 / 03 同规格。
 */
export function buildEpisodeSplitPrompt(params: { script: string; episodeSeconds?: number | string; requirement?: string; skillLabel?: string; languageRule?: string }): string {
    const seconds = resolveEpisodeSeconds(params.episodeSeconds);
    const skill = String(params.skillLabel ?? "").trim() || EPISODE_SPLIT_SKILL_LABEL;
    const languageRule = String(params.languageRule ?? "").trim();
    const lines: string[] = [];
    if (languageRule) lines.push(languageRule);
    lines.push(`请用「${skill}」技能，把我下面这份剧本拆成**多集分集剧本**：一集一个 script 字段，集与集之间剧情连续、不重不漏。`);
    lines.push(`⚠️ 先按技能做「小说 → 剧本分镜」的转换（把叙述文字改写成可直接拍摄的剧本正文：场景、镜头、画面、台词），再把结果**按时间切集**。`);
    lines.push(episodeSecondsRule(seconds));
    const extra = String(params.requirement ?? "").trim();
    if (extra) lines.push(`特殊要求：${extra}`);
    lines.push(`原文剧本（可能很长，务必全部覆盖，不要只处理开头一段）：\n<<<\n${String(params.script ?? "").trim()}\n>>>`);
    lines.push(EPISODE_SPLIT_OUTPUT_RULE);
    if (languageRule) lines.push(languageRule);
    return lines.join("\n");
}

/** 剥掉模型偶尔加的 ```json … ``` 包裹。 */
function stripFence(text: string): string {
    const body = String(text || "").replace(/\r\n/g, "\n").trim();
    const fenced = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    return (fenced ? fenced[1] : body).trim();
}

/** 从一段文本里截出最外层的 JSON 对象 / 数组（前后夹了寒暄也能取到）。 */
function sliceJson(text: string): string {
    const objectStart = text.indexOf("{");
    const arrayStart = text.indexOf("[");
    const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
    if (start < 0) return "";
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end <= start) return "";
    return text.slice(start, end + 1);
}

export type EpisodeDraft = { title: string; script: string };

/**
 * 解析拆集结果。
 *
 * 三条路，按可靠性从高到低：
 *  ① **JSON**（首选形态，提示词强制要求）：`{"episodes":[…]}` / 直接数组 / 单对象带 `script`；
 *  ② **分集标记**（`第1集` / `【第一集】` / `## 第 2 集` 这类独占一行的标记）→ 按标记切块；
 *  ③ 都没有 → **整段当一集**（用户只写了短剧本 / 模型没照格式来，至少别把内容弄丢）。
 *
 * 空字符串里的 `script` 会被丢掉（模型有时给个空壳 item）；全部为空 → 返回空数组，由调用方报错。
 */
export function parseEpisodeSplitOutput(text: string | null | undefined): EpisodeDraft[] {
    const body = stripFence(String(text || ""));
    if (!body) return [];
    const parsed = tryParseJsonEpisodes(body);
    if (parsed.length) return parsed;
    const marked = splitByEpisodeMarkers(body);
    if (marked.length) return marked;
    return [{ title: buildEpisodeTitle(0), script: body }];
}

function coerceEpisodeItems(value: unknown): EpisodeDraft[] {
    if (!Array.isArray(value)) return [];
    const out: EpisodeDraft[] = [];
    for (const item of value) {
        if (typeof item === "string") {
            const script = item.trim();
            if (script) out.push({ title: buildEpisodeTitle(out.length), script });
            continue;
        }
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const script = String(record.script ?? record.content ?? record.text ?? record.body ?? "").trim();
        if (!script) continue;
        out.push({ title: buildEpisodeTitle(out.length, String(record.title ?? record.name ?? "")), script });
    }
    return out;
}

function tryParseJsonEpisodes(body: string): EpisodeDraft[] {
    const candidates = [body, sliceJson(body)].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (Array.isArray(parsed)) {
                const items = coerceEpisodeItems(parsed);
                if (items.length) return items;
                continue;
            }
            if (parsed && typeof parsed === "object") {
                const record = parsed as Record<string, unknown>;
                const list = record.episodes ?? record.episode ?? record.list ?? record.data ?? record.result;
                const items = coerceEpisodeItems(list);
                if (items.length) return items;
                // 单个对象直接带剧本（只有一集时会这么答）
                const single = coerceEpisodeItems([record]);
                if (single.length) return single;
            }
        } catch {
            // 不是 JSON：交给分集标记那条路
        }
    }
    return [];
}

/** 分集标记：独占一行、以「第N集 / 第N话 / 第N章」开头（允许 **粗体** / ## / 【】 包裹）。 */
const EPISODE_MARKER = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:【|\[)?\s*第\s*[0-9一二三四五六七八九十百]+\s*[集话章回]\s*(?:】|\])?\s*(?:\*\*)?\s*[:：]?\s*(.*)$/;

function splitByEpisodeMarkers(body: string): EpisodeDraft[] {
    const lines = body.split("\n");
    const blocks: Array<{ title: string; lines: string[] }> = [];
    for (const line of lines) {
        const match = line.match(EPISODE_MARKER);
        if (match) {
            const title = (match[0].match(/第\s*[0-9一二三四五六七八九十百]+\s*[集话章回]/) || [""])[0].replace(/\s+/g, "");
            blocks.push({ title: title || buildEpisodeTitle(blocks.length), lines: [] });
            const rest = (match[1] || "").trim();
            if (rest) blocks[blocks.length - 1].lines.push(rest);
            continue;
        }
        if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    }
    const out: EpisodeDraft[] = [];
    for (const block of blocks) {
        const script = block.lines.join("\n").trim();
        if (!script) continue;
        out.push({ title: buildEpisodeTitle(out.length, block.title), script });
    }
    return out;
}

/**
 * 拆集结果的**自检摘要**（写进进度 / 完成提示）。
 * 例：`3 集 · 每集 120 秒 · 字数 1.2k`。
 */
export function describeEpisodeSplit(episodes: readonly EpisodeDraft[], seconds: number): string {
    const count = episodes.length;
    const chars = episodes.reduce((sum, item) => sum + item.script.length, 0);
    const size = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
    return `${count} 集 · 每集 ${resolveEpisodeSeconds(seconds)} 秒 · 字数 ${size}`;
}

/** 一集的落位：文本节点（剧本）+ 脚本节点（分镜表）各一个中心点（`createCanvasNode` 的口径）。 */
export type EpisodeSlot = { text: Position; script: Position };

/**
 * 04 的落位：**文本节点一列纵向排下来**，每集右边跟一个脚本节点。
 *
 * 用户口径：「输出的多个文本节点 依次向下进行排列」—— 所以是**纵向列**，不是 02 / 03 那条横向链。
 *
 * 为什么要一个纯函数（而不是在 `project.tsx` 里写 `source.right + gap`）：
 *  - 用户可能在同一块画布上跑第二次 04，写死 `source.right` 会精确盖住上一轮那一列（2026-11-09 已踩过）；
 *  - 一列 8 集的竖向范围比单个节点高得多，只按「源节点高度」找空位挡不住右边别的内容；
 *  - 探针能直接测「不压已有节点 / 集与集不重叠 / 空画布上逐像素等于期望值」。
 *
 * 算法与 `lib/canvas/canvas-free-space.ts` 同一口径（整列一起往右让，不左右穿插）：
 * ① 文本列按**整列高度**找一个不压占位的 x；
 * ② 脚本列从文本列右侧开始，把刚排好的文本节点也算进占位再找 x —— 否则脚本列可能正好压在
 *    右边已有的图上；
 * ③ 竖向：第 i 集的文本 / 脚本都以同一行顶边对齐，行距 = 文本节点高度 + `gapY`。
 */
export function planEpisodeStackSlots(params: {
    /** 列左上角（通常取反推节点的右下角） */
    origin: { x: number; y: number };
    count: number;
    text: { width: number; height: number };
    script: { width: number; height: number };
    gapX?: number;
    gapY?: number;
    occupied?: readonly CanvasFreeRect[];
}): EpisodeSlot[] {
    const count = Math.max(0, Math.round(Number(params.count) || 0));
    if (!count) return [];
    const gapX = Math.max(0, params.gapX ?? CANVAS_FREE_SPACE_GAP);
    const gapY = Math.max(0, params.gapY ?? 36);
    const occupied = params.occupied || [];
    const top = Number(params.origin.y) || 0;
    const textWidth = Math.max(1, params.text.width);
    const textHeight = Math.max(1, params.text.height);
    const scriptWidth = Math.max(1, params.script.width);
    const scriptHeight = Math.max(1, params.script.height);
    const stackHeight = count * textHeight + (count - 1) * gapY;

    /** 从 `desiredX` 往右找第一个「这一列不压任何占位」的 x（64 次上限只是防脏数据死循环）。 */
    const findColumnX = (desiredX: number, width: number, height: number, pool: readonly CanvasFreeRect[]): number => {
        let x = Number(desiredX) || 0;
        for (let guard = 0; guard < 64; guard += 1) {
            const rect: CanvasFreeRect = { x, y: top, width, height };
            const hits = pool.filter((other) => canvasRectsOverlap(other, rect));
            if (!hits.length) return x;
            x = Math.max(...hits.map((other) => other.x + other.width)) + gapX;
        }
        return x;
    };

    const textX = findColumnX(params.origin.x, textWidth, stackHeight, occupied);
    const textRects: CanvasFreeRect[] = Array.from({ length: count }, (_, index) => ({
        x: textX,
        y: top + index * (textHeight + gapY),
        width: textWidth,
        height: textHeight,
    }));
    const scriptX = findColumnX(textX + textWidth + gapX, scriptWidth, stackHeight, [...occupied, ...textRects]);
    return textRects.map((rect, index) => ({
        text: { x: rect.x + textWidth / 2, y: rect.y + textHeight / 2 },
        script: { x: scriptX + scriptWidth / 2, y: top + index * (textHeight + gapY) + scriptHeight / 2 },
    }));
}
