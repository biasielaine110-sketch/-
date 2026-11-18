import {
    scriptNameLockName,
    scriptRowAudioIds,
    setStoryScriptRowAudioIds,
    splitScriptAssetVariant,
    storyScriptAssetNameSimilarity,
    storyScriptCellText,
    STORY_SCRIPT_ASSET_MATCH_THRESHOLD,
    type StoryScriptRow,
    type StoryScriptRowAudioMap,
} from "@/constant/story-script";
import { isScriptAssetAlignSkipped } from "@/lib/canvas/script-asset-align";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/**
 * **台词音色对齐**：把「连到脚本节点的音频」按**这一镜有没有它的台词**挂进「声音」列
 * （`metadata.scriptRowAudios`），铺链路时那一段视频节点就只连这一段配音。
 *
 * 用户原话（2026-11-15）：「如果我链接了声音文件给脚本生成器，并按照资产图的提前锁定方式，
 * 即我把声音文件改名后链接到脚本生成器，他也需要根据该镜头是否有该角色的台词而把这个声音文件
 * 挂载进去，比如声音叫张曼的音色。那么如果脚本某个镜头张曼有说话的台词，那么就把这个挂载到
 * 那个声音的表格里。同时在铺视频节点的时候，也 @具体声音文件并描述为 张曼的音色参考。」
 *
 * 与「资产图对齐」（`script-asset-align.ts`）的分工与同构之处：
 *  - 同一个入口口径：连到脚本节点的素材 + 用户改过的标题；不联网、不建节点、幂等；
 *  - 差别在**命中判据**：图片看「表里哪个资产格写了这个名字」，音频看「哪一镜的台词是这个人说的」；
 *  - 落到不同字段：图片 → `scriptNameLocks`（名字锁，跨镜）；音频 → `scriptRowAudios`（逐镜，**只挂这一镜**）。
 *    音频不做名字锁：同一个人在不同镜头可能用不同音色（情绪 / 远近），锁死会抹掉这个选择。
 *
 * 三条边界（改这里之前先读）：
 *  ① **只挂不删**：并集写入，用户手动挂的、之前自动挂的都不动；要解绑就在格子里点 ×，
 *     解绑时把标题记进 `scriptAssetAlignSkip`，自动对齐从此绕开它（与图片同一份名单）。
 *  ② **匹配不上 ≠ 报错**：匹配不上的音频仍然按老口径当「整表音频」（每段视频都连，BGM / 全局旁白）。
 *     所以「没挂进声音列」不会让音频丢失，只是不精准。
 *  ③ **短名字必须完全同名**：`张曼` 与 `张曼丽` 是包含关系（0.9），拿 0.5 门槛会互相串音色，
 *     所以说话人 ≤ 3 字时要求归一后**逐字相等**。图片那边靠「分类守卫」规避同类问题，音频没有分类可用。
 */

/** 一段连到脚本节点的音频（对齐的输入；标题就是用户改的那个「角色名 / 音色名」）。 */
export type ScriptVoiceCandidate = { nodeId: string; title: string };

export type ScriptVoiceAlignMatch = {
    nodeId: string;
    /** 画布上这段音频的标题（用户起的名字）。 */
    title: string;
    /** 挂到了第几镜。 */
    shotNo: number;
    /** 这一镜里被认出来的说话人原文（提示用得上）。 */
    speaker: string;
};

export type ScriptVoiceAlignPlan = {
    /** 真挂上去的（镜号 + 音频），同一段音频在多镜说话会有多条。 */
    matches: ScriptVoiceAlignMatch[];
    /** 一个镜头都没对上的音频（= 按老口径继续当整表音频）。 */
    unmatched: Array<{ nodeId: string; title: string }>;
    /** 要合并进脚本节点 metadata 的补丁（只在真有新增时才有这个键）。 */
    metadata: Partial<CanvasNodeMetadata>;
    /** 这次新增的「镜 × 音频」挂载数（不含本来就挂好的）。 */
    newMountCount: number;
};

/** 台词里这些「冒号前的东西」不是说话人（音效 / 字幕 / 无）—— 别给它们配音色。 */
const VOICE_SPEAKER_STOPWORDS = new Set(["无", "空", "无台词", "没台词", "音效", "配乐", "音乐", "字幕", "环境音", "静音", "无声", "n/a", "na", "none", "null", "-", "—", "/"]);

/** 音色标题的后缀：`张曼的音色` / `张曼音色` / `张曼的配音` / `张曼 声音` 都归一到 `张曼`。 */
const VOICE_TITLE_SUFFIX = /(的)?(音色|配音|声音|语音|声线)$/;

/**
 * 从一镜的台词文本里抽出**说话人**。
 *
 * 认得的形态（模型给的表就是这么几种，`momanContentParts` 造的也是第一种）：
 *  - `张曼：“你来了。”`
 *  - `张曼: 你来了`
 *  - `张曼（冷笑）：“…”`（括号注释先剥掉）
 *  - `张曼：“…” 李四：“…”`（一句里两个人 → 两条）
 *  - 纯台词没有说话人（`你来了。` / `无`）→ 空数组（这一镜谁的话都不知道，不挂）
 *
 * 为什么按「冒号前 1~10 个非标点字符」扫而不是只取第一个冒号：一镜里两个人对话是常态，
 * 只取第一个会让第二个人的音色永远挂不上。
 */
export function parseScriptDialogueSpeakers(text: unknown): string[] {
    const raw = storyScriptCellText(text);
    if (!raw) return [];
    // 括号注释（情绪 / 语气）先剥掉，否则「张曼（冷笑）：」的说话人会带上括号内容。
    const cleaned = raw.replace(/[（(][^）)]*[）)]/g, "");
    const out: string[] = [];
    const seen = new Set<string>();
    // 冒号前：不含空白与各类标点；冒号支持中英文。
    const pattern = /([^\s：:，,。；;、！!？?“”"'‘’「」『』（）()\[\]【】《》<>~～]{1,10})\s*[：:]/g;
    for (const match of cleaned.matchAll(pattern)) {
        const speaker = scriptNameLockName(match[1]);
        if (!speaker) continue;
        if (VOICE_SPEAKER_STOPWORDS.has(speaker.toLowerCase())) continue;
        // 「镜头 3：」「第 2 段：」这种是时间码 / 分段标题，不是人。
        if (/^(镜头|第|时间|时长|景别|画面|备注|音效|旁白提示|OS|VO)\d*$/.test(speaker)) continue;
        const key = speaker.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(speaker);
    }
    return out;
}

/** 音色标题归一：去掉「的音色 / 的配音 / 声音…」这类后缀，剩下的就是角色名。 */
export function scriptVoiceBaseName(value: unknown): string {
    const name = scriptNameLockName(value);
    if (!name) return "";
    const stripped = name.replace(VOICE_TITLE_SUFFIX, "").trim();
    return stripped || name;
}

/**
 * 这段音频算不算这个说话人的音色。
 *
 * 两道判据，顺序不能反：
 *  ① 归一后**逐字相等** → 一定算（`张曼的音色` → `张曼`）；
 *  ② 说话人是**短名（≤ 3 字）**时到此为止 —— 短名之间靠包含关系（`张曼` ⊂ `张曼丽`）串音色，
 *     在配音上是灾难（整段台词用了错的人的声音），宁可挂不上让人手动挑；
 *  ③ 长一些的名字才允许模糊匹配（`奶茶店老板` vs `奶茶店老板（中年男）`）。
 */
export function isSameScriptVoiceByName(title: unknown, speaker: unknown): boolean {
    const base = scriptVoiceBaseName(title);
    const name = scriptNameLockName(speaker);
    if (!base || !name) return false;
    if (base.toLowerCase() === name.toLowerCase()) return true;
    /**
     * **音色跟人走，不跟衣服走**：角色格写 `叶辰@校服`、音频标题只叫 `叶辰`，是同一个人。
     * 所以模糊匹配一律按**本体**（`@` 前面那截）算 —— 不剥的话造型闸门
     * （`storyScriptAssetNameSimilarity`）会把它们判成两个资产，换装那一整段台词就挂不上音色。
     */
    const baseName = splitScriptAssetVariant(base).base || base;
    const speakerName = splitScriptAssetVariant(name).base || name;
    if (baseName.toLowerCase() === speakerName.toLowerCase()) return true;
    if (Array.from(speakerName).length <= 3) return false;
    return storyScriptAssetNameSimilarity(baseName, speakerName) >= STORY_SCRIPT_ASSET_MATCH_THRESHOLD;
}

/**
 * 算出「把连进来的音频按台词挂进声音列」的完整计划。纯函数：不读 store、不建节点。
 *
 * @param rows 当前分镜表（以**表里真实写了的台词**为准；表里没台词就不挂）。
 * @param skipNames 用户**亲手解绑过**的音频标题（与图片共用 `metadata.scriptAssetAlignSkip`）。
 */
export function planScriptVoiceAlignment(params: {
    scriptNode: CanvasNodeData;
    candidates: readonly ScriptVoiceCandidate[];
    rows: readonly StoryScriptRow[] | null | undefined;
    skipNames?: readonly string[] | null;
}): ScriptVoiceAlignPlan {
    const { scriptNode, candidates, rows, skipNames } = params;
    const empty: ScriptVoiceAlignPlan = { matches: [], unmatched: [], metadata: {}, newMountCount: 0 };
    const alive = (candidates || []).filter((item) => item?.nodeId && scriptNameLockName(item.title));
    if (!alive.length || !rows?.length) return empty;

    let nextAudios: StoryScriptRowAudioMap = (scriptNode.metadata?.scriptRowAudios || {}) as StoryScriptRowAudioMap;
    const matches: ScriptVoiceAlignMatch[] = [];
    const matchedIds = new Set<string>();
    let newMountCount = 0;

    rows.forEach((row, index) => {
        const shotNo = Number(row?.shot_no) || index + 1;
        const speakers = parseScriptDialogueSpeakers(row?.dialogue);
        if (!speakers.length) return;
        const current = scriptRowAudioIds(nextAudios, shotNo);
        const additions: string[] = [];
        for (const candidate of alive) {
            // 用户亲手解绑过这个标题 → 整段音频都不碰（否则 × 完又被挂回来，就是「解绑不掉」）。
            if (isScriptAssetAlignSkipped(skipNames, candidate.title)) continue;
            const speaker = speakers.find((name) => isSameScriptVoiceByName(candidate.title, name));
            if (!speaker) continue;
            matchedIds.add(candidate.nodeId);
            if (current.includes(candidate.nodeId) || additions.includes(candidate.nodeId)) continue;
            additions.push(candidate.nodeId);
            matches.push({ nodeId: candidate.nodeId, title: candidate.title, shotNo, speaker });
        }
        if (additions.length) {
            nextAudios = setStoryScriptRowAudioIds(nextAudios, shotNo, [...current, ...additions]);
            newMountCount += additions.length;
        }
    });

    const unmatched = alive.filter((item) => !matchedIds.has(item.nodeId)).map((item) => ({ nodeId: item.nodeId, title: item.title }));
    const metadata: Partial<CanvasNodeMetadata> = newMountCount ? { scriptRowAudios: nextAudios } : {};
    return { matches, unmatched, metadata, newMountCount };
}

/** 要不要动手：只有真的新增了挂载才写（保证幂等、不会自激）。 */
export function shouldApplyScriptVoiceAlignment(plan: ScriptVoiceAlignPlan): boolean {
    return plan.newMountCount > 0;
}

/**
 * 这条音频是不是「已经逐镜挂好了」= 它出现在任何一镜的声音列里。
 *
 * 铺链路用它把音频分成两拨（这是用户 2026-11-15 口径的落点）：
 *  - 出现在声音列 → **音色参考**，只连它被挂到的那几镜的视频节点；
 *  - 没出现 → 老口径「整表音频」（BGM / 全局旁白 / 还没对齐过的），每段都连。
 *
 * 判据只看 metadata、不看标题：用户手动把一条 BGM 挂到第 3 镜，它在这一镜就该只属于这一镜。
 */
export function isRowMountedAudio(metadata: CanvasNodeMetadata | undefined, audioNodeId: string): boolean {
    const map = metadata?.scriptRowAudios;
    if (!map || !audioNodeId) return false;
    for (const value of Object.values(map)) {
        if (Array.isArray(value) && value.includes(audioNodeId)) return true;
    }
    return false;
}
