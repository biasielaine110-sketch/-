/**
 * 「人物站位描述」（`blocking_detail`）→ 视频节点提示词里的「【人物站位】」块。
 *
 * 用户 2026-11-23 第 06 条：
 *  - 分镜表加一列「人物站位描述」（`blocking` 仍是最短的「谁在画面哪侧」，供站位图资产匹配）；
 *  - 铺视频链路时把这一格写进视频节点提示词，**位置在镜头内容的上面**；
 *  - 合并镜头铺出来的视频节点，要把这几镜的站位**整合**成一段，不要臃肿、不要重复冲突。
 *
 * 🔴 为什么合并要在前端确定性地做（而不是让模型再写一遍）：合并只是「同一场戏的站位底子
 * 各镜重复 + 个别人挪了位置」，句级去重就能收敛；再调一次模型既花钱又可能改坏已经写准的
 * 位置关系（谁在画面左、机位轴线）。这里的合并只做三件事：**去重 + 保留新增走位 + 超长截断**。
 */

/** 「【人物站位】」块标题（与「【资产锁定】」同款，视频窗口里一眼能分开）。 */
export const SCRIPT_BLOCKING_TITLE = "【人物站位】";

/**
 * 合并后的正文上限（字符，不含标题）。
 *
 * 单镜样本约 230 字；三镜合并去重后通常 300–450 字。900 字是「还读得完」的上限，
 * 超过就按句截断 —— 视频提示词里塞三千字站位，运镜指令会被淹掉。
 */
const MERGED_BLOCKING_MAX_CHARS = 900;

/** 句级切分：句号 / 分号 / 叹号 / 问号 / 换行（切完统一用「。」重连）。 */
const BLOCKING_SENTENCE_SPLIT = /[。；;！!？?\n]+/;

/** 归一化用的字符（与去重判据同一套：空白与标点全部抹掉，只比字面）。 */
const BLOCKING_PUNCTUATION = /[\s，,。．.；;：:、！!？?（）()［］[\]“”"'‘’《》〈〉【】\-—－·]/g;

/** 近似判定的 Dice 阈值：0.86 能吃掉「同一句话换了两个词」，又不会把「换了个位置」判成重复。 */
const BLOCKING_SIMILARITY_THRESHOLD = 0.86;

/** 只在这两个判据上做「包含即重复」（句子太短时包含关系不可靠，会误删独立信息）。 */
const BLOCKING_CONTAINMENT_MIN_LENGTH = 10;

function cellText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join("。");
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(cellText).filter(Boolean).join("。");
    return "";
}

function normalizeBlockingSentence(text: string): string {
    return text.replace(BLOCKING_PUNCTUATION, "").toLowerCase();
}

function bigrams(text: string): Set<string> {
    const out = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
    return out;
}

/** Dice 相似度（字符二元组）：中文短句上比编辑距离稳，也不用引第三方库。 */
function blockingSimilarity(left: string, right: string): number {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const a = bigrams(left);
    const b = bigrams(right);
    if (!a.size || !b.size) return 0;
    let hit = 0;
    a.forEach((gram) => {
        if (b.has(gram)) hit += 1;
    });
    return (2 * hit) / (a.size + b.size);
}

/** 一句是否与该镜已收的句子重复（完全相同 / 互相包含 / 高度相似都算）。 */
function isDuplicateSentence(candidate: string, normalized: string, kept: readonly string[]): boolean {
    return kept.some((existing) => {
        if (existing === normalized) return true;
        if (normalized.length >= BLOCKING_CONTAINMENT_MIN_LENGTH && existing.length >= BLOCKING_CONTAINMENT_MIN_LENGTH) {
            if (existing.includes(normalized) || normalized.includes(existing)) return true;
        }
        return blockingSimilarity(existing, normalized) >= BLOCKING_SIMILARITY_THRESHOLD;
    });
}

/** 按句截断到上限（保留到最后一个完整句号，绝不半句收尾）。 */
function clampBlockingText(text: string): string {
    if (text.length <= MERGED_BLOCKING_MAX_CHARS) return text;
    const slice = text.slice(0, MERGED_BLOCKING_MAX_CHARS);
    const cut = slice.lastIndexOf("。");
    return cut > 0 ? slice.slice(0, cut + 1) : `${slice}。`;
}

/**
 * 多镜站位合并：逐句收，重复 / 近重复的句子只留第一次出现的那句。
 *
 * 顺序即时间顺序（第 1 镜 → 第 N 镜）：第一镜的句子通常包含整个空间底子（家具朝向、光源、
 * 门在哪、机位轴线），后面几镜重复写的同一句会被吃掉；只有**真的改了走位**的句子留下来，
 * 于是「医生原本在画面左 → 第三镜走到右侧窗边」两条都在，不会互相覆盖。
 */
export function mergeScriptBlockingTexts(texts: ReadonlyArray<unknown>): { text: string; shots: number } {
    const cleaned = texts.map(cellText).map((text) => text.trim()).filter((text) => Boolean(text) && text !== "无" && text !== "无。");
    if (!cleaned.length) return { text: "", shots: 0 };
    if (cleaned.length === 1) return { text: clampBlockingText(cleaned[0]), shots: 1 };

    const kept: string[] = [];
    const keptNormalized: string[] = [];
    for (const text of cleaned) {
        for (const raw of text.split(BLOCKING_SENTENCE_SPLIT)) {
            const sentence = raw.trim();
            if (!sentence) continue;
            const normalized = normalizeBlockingSentence(sentence);
            if (!normalized) continue;
            if (isDuplicateSentence(sentence, normalized, keptNormalized)) continue;
            kept.push(sentence);
            keptNormalized.push(normalized);
        }
    }
    if (!kept.length) return { text: "", shots: cleaned.length };
    return { text: clampBlockingText(`${kept.join("。")}。`), shots: cleaned.length };
}

/**
 * 视频节点提示词里的「【人物站位】」块。
 *
 * 空内容（这一镜没写 / 只有「无」）→ 空串，调用方原样返回提示词，老表铺出来的结果逐字不变。
 * 合并多镜时多一行括号说明「后出现的位置优先」—— 这是给视频模型读的冲突消解规则，
 * 也是「整合而不是拼接」的外显标记。
 */
export function buildScriptBlockingPrompt(blockingTexts: ReadonlyArray<unknown>): string {
    const { text, shots } = mergeScriptBlockingTexts(blockingTexts);
    if (!text) return "";
    const head = shots > 1 ? `${SCRIPT_BLOCKING_TITLE}\n（合并 ${shots} 镜的连续站位；同一人物后出现的位置以靠后的为准）` : SCRIPT_BLOCKING_TITLE;
    return `${head}\n${text}`;
}

/** 把站位块放到提示词**最上面**（之后资产锁定块还会再叠到它上面，于是顺序是 资产锁定 → 站位 → 镜头内容）。 */
export function withScriptBlockingBlock(prompt: string | undefined, block: string): string {
    const base = String(prompt || "").trim();
    if (!block) return base;
    return base ? `${block}\n\n${base}` : block;
}
