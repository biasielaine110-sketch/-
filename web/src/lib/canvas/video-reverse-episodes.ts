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
 * 每秒剧本大约多少个字（把「时长」换成「字数」的唯一换算点）。
 *
 * 4.5 字/秒 ≈ 中文口播的常速（2 分钟 ≈ 540 字）：再快一点听着像快进，再慢一集就装不满。
 * 这个数同时喂给提示词（「约 N 字 / 集」）和切分器（累积到 N 秒就断开），两边必须是同一个值，
 * 否则模型按 A 写、我们按 B 切，最后一集要么爆长要么只剩两行。
 */
export const SCRIPT_CHARS_PER_SECOND = 4.5;

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

/**
 * 拆集提示词里那句「一集多少秒」。
 *
 * 2026-11-18 起「切集」这件事已经不归模型管（本地按字数切），所以这句话只负责**篇幅密度**：
 * 让它按「N 秒该怎么写」来安排镜头数与台词量，别提「拆成几集」。
 */
function episodeSecondsRule(seconds: number): string {
    return `篇幅密度 **${seconds} 秒 / 段**（硬要求：每 ${seconds} 秒的画面与台词大约 ${Math.round(seconds * SCRIPT_CHARS_PER_SECOND)} 字 —— 镜头数、台词量都按这个密度写。不要一段写满五分钟，也不要整篇只有两三句话）。`;
}

/**
 * 04 的输入要求（拼在提示词里）。
 *
 * 🔴 2026-11-18 改口径（用户）：「在执行 04 时，需要在对话窗口得到对话回话后，再将输出给到的内容
 *  按照约束的时长进行分段 复制到新的文本节点里……等 AI 对话给到结果后，再**自行**按照时长进行输出为
 *  1 个文本节点还是多个文本节点」。
 *
 * 所以提示词**不再要 JSON 分集**：模型只负责把原文改写成可直接开拍的剧本正文，切几集由本地
 * `splitScriptByDuration()` 按字数 / 秒数确定性算出来（模型数不清字数，让它自己切必然忽长忽短）。
 * 唯一要它配合的是**分场**：场与场之间空行，本地按空行累积到一集就断开，尽量不把一场戏劈成两半。
 */
export const EPISODE_SPLIT_OUTPUT_RULE =
    "输出格式（最高优先级硬要求）：**只输出剧本正文**——不要 JSON、不要 Markdown 代码块、不要「第1集」这类集号、不要任何解释或前言后语。\n" +
    "正文必须按**分场**写：每个场景第一行单独一行写「场景：地点 · 时间」，场景与场景之间空一行；场景内部再按「画面 / 台词」分段。\n" +
    "切集由我在拿到你的正文后按每集时长自动完成，你**不要**自己分集、也不要标注时长。";

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
    lines.push(`请用「${skill}」技能，把我下面这份剧本改写、续写成**可以直接开拍的连续剧本正文**：把叙述文字改写成剧本正文（场景、镜头、画面、台词），剧情按原文顺序推进，不跳段、不漏内容。`);
    lines.push(episodeSecondsRule(seconds));
    lines.push(
        `篇幅控制：这份正文会被我按每集 ${seconds} 秒自动切集，约 **${Math.round(seconds * SCRIPT_CHARS_PER_SECOND)} 字 / 集**。` +
            `所以每个场景都尽量在 ${seconds} 秒内闭合（约 ${Math.round(seconds * SCRIPT_CHARS_PER_SECOND)} 字），不要写出一个需要几集才演完的超长场景。`,
    );
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
 * 一段文字大概够演多少秒（`字数 / SCRIPT_CHARS_PER_SECOND`）。
 *
 * 汉字按 1 个字算；英文单词按 1.5、数字串按 0.5（念一个单词比念一个字慢，念「120」比念两个汉字快）。
 * 只是**估算**，用途是「累积到一集就断」，不参与任何精确计算。
 */
export function estimateScriptSeconds(text: string | null | undefined): number {
    const body = String(text ?? "");
    if (!body.trim()) return 0;
    const cjk = (body.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const latin = (body.match(/[A-Za-z]+/g) || []).length;
    const digits = (body.match(/\d+/g) || []).length;
    const units = cjk + latin * 1.5 + digits * 0.5;
    return Math.max(0, units / SCRIPT_CHARS_PER_SECOND);
}

/**
 * 把模型的回复变成**纯剧本正文**。
 *
 * 三种情况都要能吃：
 *  ① 正常：就是正文（提示词已经不要 JSON）→ 原样返回；
 *  ② 老口径 / 模型擅自 JSON：`{"episodes":[…]}` → 把各集 `script` 用空行拼回一份连续正文
 *     （拼完仍会被按时长重新切，模型给的分集边界不作为最终结果）；
 *  ③ 包了 ``` 代码块 / 前后带一句「好的，以下是…」→ 剥掉围栏，正文原样保留。
 */
export function extractScriptText(text: string | null | undefined): string {
    const body = stripFence(String(text ?? ""));
    if (!body) return "";
    const episodes = tryParseJsonEpisodes(body);
    if (episodes.length) return episodes.map((item) => item.script.trim()).filter(Boolean).join("\n\n");
    return body;
}

/**
 * 按「每集 N 秒」把正文切成 1 个或多个分集剧本（用户 2026-11-18：切几集由我们自己算）。
 *
 * 切法（都是**确定性**的，同样的输入永远得到同样的结果，探针能直接测）：
 *  ① 先按**空行**分块（一份剧本里「场景：…」之间本来就是空行）；整篇没有空行 → 按行分块；
 *  ② 某一块本身就超过一集的 115% → 按句子（。！？…；）再切小，避免「一句台词劈成两集」；
 *  ③ 逐块累加：**够一集（≥90%）就断**、加上下一块会超 115% 也断、
 *     碰到「第N集 / 场景： / 内景 / 外景 / INT. / EXT.」这类行**强制断**（天然剧情断点）；
 *  ④ 最后一块不足一集的 40%（且不止一块）→ 并进前一块，不留一个两三行的尾巴集。
 *
 * 返回的 `title` 默认「第N集」；正文里本来就有「第X集」标记的话，沿用那个编号。
 */
export function splitScriptByDuration(text: string | null | undefined, seconds: number | string | null | undefined): EpisodeDraft[] {
    const target = resolveEpisodeSeconds(seconds);
    const blocks = expandOversizedBlocks(toBlocks(extractScriptText(text)), target);
    if (!blocks.length) return [];

    const chunks: string[] = [];
    let current: string[] = [];
    let currentSeconds = 0;
    const flush = () => {
        const script = current.join("\n\n").trim();
        if (script) chunks.push(script);
        current = [];
        currentSeconds = 0;
    };
    for (const block of blocks) {
        const blockSeconds = estimateScriptSeconds(block);
        const boundary = SCRIPT_BOUNDARY_LINE.test(block);
        if (current.length && (boundary || currentSeconds >= target * 0.9 || currentSeconds + blockSeconds > target * 1.15)) flush();
        current.push(block);
        currentSeconds += blockSeconds;
        if (currentSeconds >= target) flush();
    }
    flush();
    if (chunks.length > 1) {
        const tail = chunks[chunks.length - 1];
        if (estimateScriptSeconds(tail) < target * 0.4) {
            chunks[chunks.length - 2] = `${chunks[chunks.length - 2]}\n\n${tail}`;
            chunks.pop();
        }
    }
    return chunks.map((script, index) => ({ title: buildEpisodeTitle(index, markerTitleOf(script)), script }));
}

/** 分块：空行优先（一份剧本里场景之间本来就空行），整篇没空行才退回按行。 */
function toBlocks(text: string): string[] {
    const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
    if (!body) return [];
    const byBlank = body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    if (byBlank.length > 1) return byBlank;
    return body.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 天然断点：分集标记 / 场景标题。
 * 命中这些行时**立刻结束上一集**——「第3集」「场景：医院走廊」后面接的必然是新的剧情单元。
 */
const SCRIPT_BOUNDARY_LINE =
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:【|\[)?\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*[集话章回]|场景\s*[:：]|内景|外景|INT\.|EXT\.)/;

/** 句末标点（切超长段落用；不用正则 lookbehind —— 老 Safari 不支持）。 */
const SENTENCE_END_CHARS = "。！？!?…；;";

function splitSentences(block: string): string[] {
    const out: string[] = [];
    let buffer = "";
    for (const char of block) {
        buffer += char;
        if (SENTENCE_END_CHARS.includes(char)) {
            if (buffer.trim()) out.push(buffer.trim());
            buffer = "";
        }
    }
    if (buffer.trim()) out.push(buffer.trim());
    return out;
}

/** 把远超一集的段落按句子拆小（否则一整章会被塞进一个节点）。 */
function expandOversizedBlocks(blocks: readonly string[], targetSeconds: number): string[] {
    const limit = targetSeconds * 1.15;
    /** 一句都超长（整段没标点）时的最后手段：按字数硬切，单块不超过一集。 */
    const maxChars = Math.max(1, Math.round(targetSeconds * SCRIPT_CHARS_PER_SECOND));
    const out: string[] = [];
    for (const block of blocks) {
        if (estimateScriptSeconds(block) <= limit) {
            out.push(block);
            continue;
        }
        let buffer = "";
        for (const sentence of splitSentences(block)) {
            const pieces = estimateScriptSeconds(sentence) > limit ? sliceByChars(sentence, maxChars) : [sentence];
            for (const piece of pieces) {
                const merged = buffer ? `${buffer}\n${piece}` : piece;
                if (buffer && estimateScriptSeconds(merged) > limit) {
                    out.push(buffer);
                    buffer = piece;
                    continue;
                }
                buffer = merged;
            }
        }
        if (buffer.trim()) out.push(buffer);
    }
    return out;
}

/** 按字数硬切（用 `Array.from` 遍历，避免把 emoji / 生僻字的代理对切成两半）。 */
function sliceByChars(text: string, maxChars: number): string[] {
    const chars = Array.from(String(text ?? ""));
    const out: string[] = [];
    for (let index = 0; index < chars.length; index += maxChars) {
        const piece = chars.slice(index, index + maxChars).join("").trim();
        if (piece) out.push(piece);
    }
    return out;
}

/** 正文开头的「第X集」标记（有就用它当标题，没有退回「第N集」）。 */
function markerTitleOf(script: string): string {
    const firstLine = String(script ?? "").split("\n")[0] || "";
    const match = firstLine.match(/第\s*([0-9一二三四五六七八九十百]+)\s*[集话章回]/);
    return match ? match[0].replace(/\s+/g, "") : "";
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
