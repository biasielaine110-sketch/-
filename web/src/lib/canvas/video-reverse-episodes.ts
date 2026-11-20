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
 * 一个「片段」的固定时长（秒）—— 用户 2026-11-18 第 5 轮口径：
 * 「时长按照输出的段落去拆分，每个段落 15 秒，即 90 秒就是 6 个段落，120 秒就是 8 个段落的内容」。
 *
 * 于是「一集几段」是**确定的整数**：`round(每集秒数 / 15)`，不再按字数估。
 * 模型侧也按这个粒度写（一片段 = 15 秒 = 一条完整叙事节拍），两边同一个常量。
 */
export const EPISODE_SEGMENT_SECONDS = 15;

/** 一集里应该有幾個片段（120 秒 = 8、90 秒 = 6、15 秒 = 1）。 */
export function segmentsPerEpisode(seconds: number | string | null | undefined): number {
    return Math.max(1, Math.round(resolveEpisodeSeconds(seconds) / EPISODE_SEGMENT_SECONDS));
}

/**
 * 拆集用的技能（唯一来源）。
 *
 * 🔴 只给这一个精确名，不加宽松变体：`pickVideoReverseSkill` 是双向包含匹配（见 `video-reverse.ts`
 * 里那段「短名不认反向包含」的注释），加一个「小说转剧本」之类的泛名会跟别的技能串味。
 */
export const EPISODE_SPLIT_SKILL_HINTS = ["15秒-小说转剧本分镜"] as const;
export const EPISODE_SPLIT_SKILL_LABEL = EPISODE_SPLIT_SKILL_HINTS[0];

/**
 * 04 弹窗「特殊要求」的**默认文案**（用户 2026-11-18 第 9 轮：「弹出得窗口 特殊要求这里 默认填入
 * 每集结尾留钩子」）。
 *
 * 为什么值得有个默认值：04 是批量拆集，一拆就是好几集连播；不给钩子的剧本每集都在同一口气上停住，
 * 观众没有理由点下一集。这句话会原样进 `buildEpisodeSplitPrompt` 的「特殊要求：」那一段，
 * 用户可以改 / 清空（清空 = 完全不要这条约束）。
 */
export const EPISODE_DEFAULT_REQUIREMENT = "每集结尾留钩子";

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
    const perEpisode = segmentsPerEpisode(seconds);
    return `段落密度 **${EPISODE_SEGMENT_SECONDS} 秒 / 1 个片段**（硬要求：一个片段 = 一条完整叙事节拍，镜头时间码从 0 秒起、合计不超过 ${EPISODE_SEGMENT_SECONDS} 秒。我会把 **${perEpisode} 个片段**拼成 ${seconds} 秒一集，所以整份正文要按 ${EPISODE_SEGMENT_SECONDS} 秒的整数倍铺开——不要一个片段里塞三个场景，也不要一个场景拆成五六个片段）。`;
}

/**
 * 片段正文的**固定格式**（用户 2026-11-18 第 5 轮给的实样，逐字段照抄，不许增删）。
 *
 * 本地切集只认 `【片段编号】` 那一行当块边界 —— 这套字段缺一个、顺序换一处，
 * 切出来的集就会错位，所以模板必须原样进提示词，不在这里做任何「美化」。
 */
export const EPISODE_SEGMENT_TEMPLATE = `## 【片段编号】1 | 【片段时长】${EPISODE_SEGMENT_SECONDS}秒
【场景】〖场景01〗内景·地点 - 时间（日/夜）
【画面基础】时间 · 内景/外景 · 地点，机位朝向
【人物】本片段出场人物
【道具】关键道具（重要道具可带一句状态说明）
【全局画风】画风 / 画质 / 表演与节奏的硬约束（每个片段都写全）
【负向词】不要出现的东西（畸形、字幕、水印、重复人物……）
【镜头1】：0秒 - 3.5秒
画面描述：景别 + 机位 + 运镜 + 这一镜里发生了什么
音效：…
台词：无（有台词写成「第X秒 角色-[说话方式]，语气：…，语速：…："台词"」）
字幕：无
运镜：…
镜头结束状态：这一镜定格的画面
【镜头2】：3.5秒 - 7秒
画面描述：…
音效：…
台词：无
字幕：无
运镜：…
镜头结束状态：…
---`;

/**
 * 04 的输入要求（拼在提示词里）。
 *
 * 🔴 2026-11-18 改口径（用户）：「在执行 04 时，需要在对话窗口得到对话回话后，再将输出给到的内容
 *  按照约束的时长进行分段 复制到新的文本节点里……等 AI 对话给到结果后，再**自行**按照时长进行输出为
 *  1 个文本节点还是多个文本节点」。
 *
 * 第 5 轮再收一次：**片段格式固定**（`EPISODE_SEGMENT_TEMPLATE`）+ **每段 15 秒**，
 * 于是「一集 = N 个片段」可以直接数出来，不用再按字数估。
 * 所以提示词不要 JSON 分集，只要它按格式铺满片段；切集由本地 `splitScriptByDuration()` 数片段完成。
 */
export const EPISODE_SPLIT_OUTPUT_RULE =
    "输出格式（最高优先级硬要求）：**只输出片段正文**——不要 JSON、不要 Markdown 代码块、不要任何解释或前言后语（不要写「好的，以下是剧本」这类话）。\n" +
    "每个片段严格按下面这套字段逐行输出，字段名一个字都不许改、一项都不许省、顺序不许调换：\n" +
    `${EPISODE_SEGMENT_TEMPLATE}\n` +
    `硬规则：① 【片段编号】从 1 开始连续递增；② 每个片段固定 ${EPISODE_SEGMENT_SECONDS} 秒，镜头时间码从 0 秒起、不得越过 ${EPISODE_SEGMENT_SECONDS} 秒；③ 片段与片段之间用单独一行 --- 分隔；④ 【镜头N】可以有 2～5 个，时间码必须首尾相接、不许重叠；⑤ 切集由我在拿到正文后按每集时长自动完成，你**不要**自己分集、不要写「第几集」、不要标总时长；⑥ 🔴 同一个人在不同片段里**换了衣服 / 造型**（家里的便服、学校的校服、正式场合的西服、睡衣、礼服……）时，【人物】里的名字后面必须用 \`@造型\` 标出来：\`叶辰@便服\` / \`叶辰@校服\` / \`叶辰@西服\`；整部戏没换过造型的人只写名字、不要加 \`@\`。造型词只用两三个字、全篇统一，不要写成 \`叶辰（校服版）\`、\`穿校服的叶辰\` 这类不带 \`@\` 的写法 —— 名字一样就是同一个人同一套衣服，后面会被套成第一套。`;

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
    lines.push(`请用「${skill}」技能，把我下面这份剧本改写、续写成**可以直接开拍的连续片段正文**：把叙述文字改写成片段（场景、镜头、画面、台词），剧情按原文顺序推进，不跳段、不漏内容。`);
    lines.push(episodeSecondsRule(seconds));
    lines.push(
        `篇幅控制：这份正文会被我按每集 ${seconds} 秒自动切集 = **${segmentsPerEpisode(seconds)} 个片段 / 集**（每个片段 ${EPISODE_SEGMENT_SECONDS} 秒）。` +
            `所以请按 ${EPISODE_SEGMENT_SECONDS} 秒一个片段均匀往下铺，不要写出需要好几集才演完的超长片段，也不要一个片段里只有一句台词。`,
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

export type EpisodeDraft = {
    title: string;
    script: string;
    /**
     * 这一集**实际**多少秒（用户 2026-11-18 第 10 轮 01 条）。
     *
     * 拆集是按 `【片段编号】` 数段落的：够 `segmentsPerEpisode(seconds)` 段就是标准集（90 / 120 秒），
     * 但整份正文的段数往往不是整数倍 —— 最后一集只剩 3 段（45 秒）时，它**就是 45 秒**，
     * 不能还按 90 秒去出分镜表（那样模型会给 24 镜，实际只有 3 段内容，后面铺视频必然空转）。
     * 所以每集把自己的秒数带出来：`scriptTotalSeconds`、band 高度、进度文案全按这个数走。
     */
    seconds?: number;
};

/**
 * 这一集的实际秒数：优先用 `seconds`（数段落数出来的），没有才退回调用方给的目标秒数。
 *
 * 只有 `splitByCharBudget` 那条兜底路径可能给不出精确段落数（技能没按格式输出、按字数估的），
 * 那里已经按 15 秒取整过，所以这里不需要再算。
 */
export function resolveEpisodeDraftSeconds(
    draft: { seconds?: number } | null | undefined,
    fallback: number | string | null | undefined,
): number {
    const own = Number(draft?.seconds);
    if (Number.isFinite(own) && own > 0) return Math.min(EPISODE_SECONDS_MAX, Math.max(EPISODE_SECONDS_MIN, Math.round(own)));
    return resolveEpisodeSeconds(fallback);
}

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
 * 片段化口径（用户 2026-11-18 第 5 轮）：模型必须按 `EPISODE_SEGMENT_TEMPLATE` 逐字段输出，
 * **一个片段固定 15 秒**；切集就是「数片段」—— `segmentsPerEpisode(seconds)` 个片段拼成一集
 * （120 秒 = 8 段、90 秒 = 6 段），全程确定性，探针能直接测。
 *
 * 老的「按字数估 + 空行分块」那套保留成**兜底**（`splitByCharBudget`）：技能不按格式输出时
 * 也不能空手而归。
 */
/** 片段块边界：`## 【片段编号】1 | 【片段时长】15秒`（允许前面带 # / ** / 缩进）。 */
const SEGMENT_HEADER_LINE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*【\s*片段编号\s*】/;
/** 片段编号（模型漏写就按出现顺序补）。 */
const SEGMENT_NUMBER = /【\s*片段编号\s*】\s*(\d+)/;
/** 片段时长：`【片段时长】14秒`；读不到就当一段 15 秒。 */
const SEGMENT_SECONDS = /【\s*片段时长\s*】\s*(\d+(?:\.\d+)?)\s*秒/;
/** 纯分隔行（`---` / `___` / `***`）。 */
const SEGMENT_RULE_LINE = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;

export type ScriptSegment = {
    /** 原文里的片段编号（`【片段编号】N`；漏写时按出现顺序补） */
    index: number;
    /** 这一段多少秒（读 `【片段时长】`，读不到 = 15） */
    seconds: number;
    /** 这一段完整正文：含 `## 【片段编号】…` 头行与全部字段，**不含**结尾那条 `---` */
    script: string;
};

/**
 * 把模型回复切成**片段块**（用户 2026-11-18 第 5 轮给的格式：
 * `## 【片段编号】1 | 【片段时长】15秒` + 【场景】/【画面基础】/【人物】/【道具】/【全局画风】/
 * 【负向词】/【镜头N】…/ `---`）。
 *
 * 一个片段 = 从 `【片段编号】` 那一行起、到下一个 `【片段编号】` 之前的一整块。
 * 🔴 **第一个标记之前的内容全部丢掉**：那只会是「好的，以下是剧本」这类前言，
 * 而用户要求「输出到文本节点的内容只要这种格式」。
 * 找不到任何标记 → 返回 `[]`，由调用方退回按字数切（老文本 / 技能不听话时不能直接切不出来）。
 */
export function splitScriptSegments(text: string | null | undefined): ScriptSegment[] {
    const body = extractScriptText(text);
    if (!body) return [];
    const blocks: string[][] = [];
    let current: string[] | null = null;
    for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
        if (SEGMENT_HEADER_LINE.test(line)) {
            current = [line];
            blocks.push(current);
            continue;
        }
        if (current) current.push(line);
    }
    return blocks
        .map((blockLines, order) => {
            /** 去掉块尾的分隔线：拼集时由 `---` 统一补，否则一集里会出现两条挨着的 `---`。 */
            const kept = [...blockLines];
            while (kept.length > 1 && SEGMENT_RULE_LINE.test(kept[kept.length - 1] || "")) kept.pop();
            const script = kept.join("\n").trim();
            const header = kept[0] || "";
            const numberMatch = header.match(SEGMENT_NUMBER);
            const secondsMatch = header.match(SEGMENT_SECONDS);
            return {
                index: numberMatch ? Number(numberMatch[1]) : order + 1,
                seconds: secondsMatch ? Math.max(1, Number(secondsMatch[1])) : EPISODE_SEGMENT_SECONDS,
                script,
            };
        })
        .filter((segment) => Boolean(segment.script));
}

/**
 * 按「一集 = `segmentsPerEpisode(seconds)` 个片段」聚合（用户口径：120 秒 = 8 段、90 秒 = 6 段）。
 *
 * 满段即断，**不看字数、也不合并尾巴** —— 用户给的是硬换算式（120 秒就是 8 段），
 * 这里再「凑整」会把 10 段拼成一集（= 150 秒），反而对不上他填的时长。
 * 片段时长由模型写在 `【片段时长】` 里，数段数比数字数可靠。
 *
 * 🔴 尾集（用户 2026-11-18 第 10 轮 01 条）：整份正文的段数不是每集段数的整数倍时，
 * 最后一集就只剩几段 —— 它的 `seconds` **按实际段数算**（3 段 = 45 秒），
 * 绝不能再按「每集 90 秒」去规划镜数，否则那 3 段内容会被摊成 24 镜的空表。
 */
function groupSegmentsIntoEpisodes(segments: readonly ScriptSegment[], target: number): EpisodeDraft[] {
    const perEpisode = Math.max(1, Math.round(target / EPISODE_SEGMENT_SECONDS));
    const groups: ScriptSegment[][] = [];
    let current: ScriptSegment[] = [];
    const flush = () => {
        if (current.length) groups.push(current);
        current = [];
    };
    for (const segment of segments) {
        current.push(segment);
        if (current.length >= perEpisode) flush();
    }
    flush();
    return groups.map((group, index) => ({
        title: buildEpisodeTitle(index),
        script: group.map((segment) => segment.script).join("\n\n---\n\n"),
        seconds: group.reduce((sum, segment) => sum + Math.max(1, Number(segment.seconds) || EPISODE_SEGMENT_SECONDS), 0),
    }));
}

export function splitScriptByDuration(text: string | null | undefined, seconds: number | string | null | undefined): EpisodeDraft[] {
    const target = resolveEpisodeSeconds(seconds);
    /** ① 有 `【片段编号】` 标记 → 按**段数**切（现行口径：120 秒 = 8 段）。 */
    const segments = splitScriptSegments(text);
    if (segments.length) return groupSegmentsIntoEpisodes(segments, target);
    /** ② 没有标记（老文本 / 技能没按格式输出）→ 退回按字数估的兜底，绝不空手而归。 */
    return splitByCharBudget(text, target);
}

/** 字数兜底：原先那套「空行分块 → 超长按句切 → 累积到 90% 断」的确定性切法。 */
function splitByCharBudget(text: string | null | undefined, target: number): EpisodeDraft[] {
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
    return chunks.map((script, index) => ({
        title: buildEpisodeTitle(index, markerTitleOf(script)),
        script,
        /**
         * 兜底路径没有 `【片段编号】` 可数，只能按字数估完再**取到 15 秒的整数倍**：
         * 后面所有环节（脚本节点成片总时长、band 高度）都按「15 秒一段」理解这一集，
         * 给个 43 秒这种数只会让镜数估算和段落数两头都不对。
         */
        seconds: Math.max(
            EPISODE_SEGMENT_SECONDS,
            Math.round(estimateScriptSeconds(script) / EPISODE_SEGMENT_SECONDS) * EPISODE_SEGMENT_SECONDS,
        ),
    }));
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
 * 例：`3 集 · 每集 120 秒（8 段×15 秒）· 字数 1.2k`；
 * 尾集不足时：`3 集 · 标准 120 秒，实际 120 / 120 / 45 秒（8 / 8 / 3 段，尾集按实际出表）· 字数 1.2k`。
 */
export function describeEpisodeSplit(episodes: readonly EpisodeDraft[], seconds: number): string {
    const target = resolveEpisodeSeconds(seconds);
    const count = episodes.length;
    const chars = episodes.reduce((sum, item) => sum + item.script.length, 0);
    const size = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
    const perEpisode = episodes.map((item) => resolveEpisodeDraftSeconds(item, target));
    const uniform = perEpisode.every((value) => value === perEpisode[0]);
    if (uniform) {
        return `${count} 集 · 每集 ${perEpisode[0]} 秒（${segmentsPerEpisode(perEpisode[0])} 段 × ${EPISODE_SEGMENT_SECONDS} 秒）· 字数 ${size}`;
    }
    const segments = perEpisode.map((value) => segmentsPerEpisode(value));
    return `${count} 集 · 标准 ${target} 秒，实际 ${perEpisode.join(" / ")} 秒（${segments.join(" / ")} 段，尾集按实际段落出表）· 字数 ${size}`;
}

/** 一集的落位：文本节点（剧本）+ 脚本节点（分镜表）各一个中心点（`createCanvasNode` 的口径）。 */
export type EpisodeSlot = {
    text: Position;
    script: Position;
    /**
     * 「一集一条横带」的坐标（只在传了 `band` 时有）。
     * `baseX` 是**整批共用**的一个值（列线锁死），`top` / `height` 只描述本集自己的纵向区间。
     */
    band?: { top: number; height: number; baseX: number };
};

/**
 * 🔴 04 多集排布的「带宽」与「带间距」（用户 2026-11-18 第 9 轮：
 * 「一次出 3、5 集的时候，就全挤到一起了……生出的图也是全是乱放的」）。
 *
 * 老算法按「文本节点高度 + 36px」排集（= 516px 一集），但一集铺出来的链路是
 * `镜头数 × (240 + 72) - 72` —— 90 秒 = 24 镜 = **7416px**。516px 的间距配上 7416px 的竖带，
 * 后一集必然压进前一集的链路占位里，`findFreeColumnX` 只能整条往右推 `laneWidth + 48 = 1244px`，
 * 5 集就是 5 条斜排的长条 = 用户看到的「乱放」。资产图同一机制往**左**让，所以图也错位。
 *
 * 所以落位单位从「节点」换成「集」：每集一条横带（band），带宽 = 文本列 + 脚本列 + 整条链路，
 * 带间距按**链路真实高度**预留；下一集的 y = 上一集 band 底 + `EPISODE_BAND_GAP_Y`，
 * 而**列线（baseX）全批共用一个值** —— 铺链路时不再需要逐节点找空地，也就没有互相推挤。
 *
 * 🔴 2026-11-20 20:05 用户：「不同集数的上下间隔差得太远了，在现在基础上缩小一半」——
 * 带间距 240 → **120**（纯空白那一层减半，链路容量一个像素都不动）。
 */
export const EPISODE_BAND_GAP_Y = 120;
/** 链路一行的高度 / 行距 —— 与 `handleBuildScriptPipeline` 的 `rowHeight` / `gapY` 同口径。 */
export const EPISODE_LANE_ROW_HEIGHT = 240;
export const EPISODE_LANE_ROW_GAP_Y = 72;
/**
 * 脚本列预留宽度 = 脚本节点自适应宽度的上限（`canvas-script-node-content.tsx` 的
 * `AUTO_SIZE_MAX_WIDTH = 2200`）。按上限留，链路就永远不会压在本集脚本节点上；
 * 代价是脚本节点只有 1520 宽时会留出一段空白 —— 这段空白是「列线不漂移」的票价。
 */
export const EPISODE_SCRIPT_COLUMN_WIDTH = 2_200;
/** 链路整体预留宽度（文本 340 + 48 + 图 340 + 48 + 视频 420，再给 Mochiani 的 560 留余量）。 */
export const EPISODE_LANE_WIDTH = 1_400;
/** 预估镜数的冗余行：模型偶尔多给一两镜，多留 2 行（624px）比事后挪节点便宜得多。 */
export const EPISODE_BAND_ROW_SLACK = 2;
/**
 * 🔴 拆段这一刻（分镜表还没出）每集只按预估链路高度的 **1/6** 预留纵向空间。
 *
 * 用户 2026-11-19 20:37：「拆不同集数文本的时候，这两个间隔也太大了，让不同集数的间隔缩小 3 分之 2」。
 * 根因是第一趟按「90 秒 = 24 镜 + 2 行冗余 = 8040px」整条预留，可这时候画布上只有文本 + 脚本
 * 两个节点，剩下 7000 多像素全是白的。第二趟（表出来后）会按真实镜数重排，所以这里保守留 1/3
 * 既把间距压到 1/3，也不至于等真铺链路时把下一集顶穿。
 *
 * 🔴 2026-11-20 20:05 用户：「拆出来的其他集数的文本节点和脚本生成器，间隔在现在基础上缩小一半，
 * 现在不同集数的上下间隔差得太远了」—— 1/3 → **1/6**（配合 `EPISODE_BAND_GAP_Y` 240 → 120，
 * 首趟两集之间从「3360 + 240 = 3600px」压到「1800 + 120 = 1920px」≈ 一半）。
 * 第一趟只是**占位估计**，分镜表出来后第二趟会按真实镜数重排，所以再压一档不会顶穿链路。
 */
export const EPISODE_BAND_ESTIMATE_RATIO = 1 / 6;
/**
 * 「本批不铺图、也不铺视频」时的预留行数。
 *
 * 只拆段 / 只出分镜时链路永远不会出现，若仍按真实镜数预留，用户看到的就是两集之间几千像素
 * 的纯空白（同一张截图）。留 1 行 = `max(1 行链路, 脚本节点高)`，集间距回到「脚本高 + 带间距」。
 */
export const EPISODE_BAND_COMPACT_ROWS = 1;

/** 「一集一条横带」的参数；不传这个就没有 band，走老的紧凑竖排（单集 / 兼容路径）。 */
export type EpisodeBandOptions = {
    /** 每集预计镜头数（按「每集秒数」确定性估算），用来算 band 高度 */
    rowsPerEpisode: readonly number[];
    /** 链路一行的高度与行距；不传用 `EPISODE_LANE_ROW_HEIGHT` / `EPISODE_LANE_ROW_GAP_Y` */
    row?: { height: number; gapY: number };
    /** 脚本列预留宽度；不传用 `EPISODE_SCRIPT_COLUMN_WIDTH` */
    scriptColumnWidth?: number;
    /** 整条链路预留宽度；不传用 `EPISODE_LANE_WIDTH` */
    laneWidth?: number;
};

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
 *
 * 🔴 传了 `band` 时改走「一集一条横带」（见 `EPISODE_BAND_GAP_Y`）：整条带（文本 + 脚本 + 链路）
 * 当成**一个矩形**只做一次 `findColumnX`，因此全批共用同一个 `baseX`；竖向按每集链路真实高度预留。
 * 这条分支只影响 04 的落位，老调用（单集 / 探针）不传 `band`，行为逐像素不变。
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
    /** 传了就走「一集一条横带」，`gapY` 同时变成**带间距**（建议传 `EPISODE_BAND_GAP_Y`） */
    band?: EpisodeBandOptions;
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

    /**
     * 🔴 「一集一条横带」：竖向按**链路真实高度**排，横向整批只定一次 x。
     *
     * 高度 = `max(镜头数 × (行高 + 行距) - 行距, 脚本节点高)` —— 与 `handleBuildScriptPipeline`
     * 算 `laneHeight` 的公式逐字同源；两处只要有一处改口径，band 就会和链路对不上。
     */
    if (params.band) {
        const rowsPerEpisode = params.band.rowsPerEpisode;
        const rowHeight = Math.max(1, params.band.row?.height ?? EPISODE_LANE_ROW_HEIGHT);
        const rowGapY = Math.max(0, params.band.row?.gapY ?? EPISODE_LANE_ROW_GAP_Y);
        const scriptColumnWidth = Math.max(scriptWidth, params.band.scriptColumnWidth ?? EPISODE_SCRIPT_COLUMN_WIDTH);
        const laneWidth = Math.max(1, params.band.laneWidth ?? EPISODE_LANE_WIDTH);
        const heights = Array.from({ length: count }, (_, index) => {
            const rows = Math.max(0, Math.round(Number(rowsPerEpisode[index]) || 0));
            const laneHeight = rows > 0 ? rows * (rowHeight + rowGapY) - rowGapY : 0;
            return Math.max(laneHeight, scriptHeight);
        });
        const stackHeight = heights.reduce((sum, height) => sum + height, 0) + (count - 1) * gapY;
        const bandWidth = textWidth + gapX + scriptColumnWidth + 64 + laneWidth;
        // 整条带当一个矩形找列：一次定下全批共用的 x，列线天然对齐（没有「逐节点找空地」就没有阶梯）。
        const bandX = findColumnX(params.origin.x, bandWidth, stackHeight, occupied);
        const scriptX = bandX + textWidth + gapX;
        const baseX = scriptX + scriptColumnWidth + 64;
        const slots: EpisodeSlot[] = [];
        let cursor = top;
        for (let index = 0; index < count; index += 1) {
            slots.push({
                text: { x: bandX + textWidth / 2, y: cursor + textHeight / 2 },
                script: { x: scriptX + scriptWidth / 2, y: cursor + scriptHeight / 2 },
                band: { top: cursor, height: heights[index], baseX },
            });
            cursor += heights[index] + gapY;
        }
        return slots;
    }

    const stackHeight = count * textHeight + (count - 1) * gapY;
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
