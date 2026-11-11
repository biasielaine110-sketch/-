/**
 * 「反推视频」命令集合的纯逻辑：挑技能 + 拼提示词。
 *
 * 为什么单独抽出来：
 *  ① 技能是**用户自己装的**（本地技能包 / 文档技能），id 是 nanoid，名字还可能被备注名覆盖，
 *     所以只能按「名字像不像」去挑，且**挑不到必须硬失败**——静默不带技能跑，模型会自由发挥，用户还以为反推过了。
 *  ② 三个命令只有「要不要特殊要求 / 要不要接着跑一键视频」的差别，提示词口径写在一处才不会漂。
 */

import type { CanvasReverseVideoTarget } from "@/types/canvas";
import { SCRIPT_SCHEME_IDS, type ScriptSchemeId } from "@/constant/script-scheme";
import { SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT } from "@/constant/story-script";
import { isMochianiVideoEngine, MOCHIANI_VIDEO_ENGINE } from "@/constant/mochiani-video";
/** 三条命令。数字即用户看到的 01 / 02 / 03。 */
export type VideoReverseMode = 1 | 2 | 3;

export type VideoReverseResult = {
    ok: boolean;
    error?: string;
    chatNodeId?: string;
    textNodeId?: string;
    scriptNodeId?: string;
};

/** 反推用的技能名（按优先级）。用户口径是「视频反推-分镜提示词」。 */
export const VIDEO_REVERSE_SKILL_HINTS = ["视频反推-分镜提示词", "视频反推分镜提示词", "视频反推", "分镜提示词"] as const;

/**
 * 02 / 03 要求框的默认文案骨架。
 *
 * 2026-11-11 第 02 条改口径（用户）：「执行 02、03 的时候，直接给我输出反推出来的同类型的剧本内容，
 * 别生成乱七八糟的注释和解释。」
 * 旧骨架是「反推该视频**提示词**及文案」 —— 要求框里点名要提示词，模型当然会把整张分镜提示词表吐出来，
 * 把输出预算吃掉、剧本被截断。现在默认只要剧本正文，与 `VIDEO_REVERSE_SCRIPT_ONLY_RULE` 同口径
 * （两处口径打架 = 模型二选一，常常选错那一头）。
 *
 * 为什么拆成「前半句 + 参考图子句 + 后半句」三段：**参考图数量是变量**。
 *  - 一张参考图都没连：不许出现 `@图片1` —— 模型找不到对应图片，只会瞎猜一件道具；
 *  - 连了 N 张：逐张点名，标签必须与 `sendChatMessage` 里的 mention 编号**逐字一致**
 *    （`imageReferenceLabel(index)`：从 1 开始、按连线顺序数），否则那段文字只会退化成纯文本。
 *
 * ⚠️ 标签由调用方传进来，本模块**不 import i18n**：它是纯逻辑模块，探针直接 import，
 * 而 `@/i18n` 的模块顶层会读 `localStorage`，在 Node 里会直接崩。
 */
export function buildDefaultVideoReverseRequirement(imageMentions: readonly string[] = []): string {
    /**
     * 2026-11-12 改口径（用户）：「需要的是**反推后，生成同类型的其他剧本**……现在感觉像是直接反推了一份给我，
     * 并不是重新生成的另外同类型的其他剧本。」
     *
     * 旧 head「写一份**同款风格**的剧本文案」是在暗示「把这条片的剧本复述出来」——「同款」既可读成
     * 「同类型」，也可读成「同一个」。要框定成后者之外的语义，就得把两个动作写清楚：
     * **先反推类型与写法（当样本看）→ 再另写一份全新的同类型剧本（内容换掉）**。
     */
    const head = "根据我提供的视频，反推出它的类型与写法，另外写一份同类型的全新剧本文案";
    const tail = "只要剧本正文，不要提示词、分析和任何注释";
    const mentions = Array.from(new Set((imageMentions || []).map((item) => String(item || "").trim()).filter(Boolean))).map((item) => (item.startsWith("@") ? item : `@${item}`));
    if (!mentions.length) return `${head}，${tail}`;
    return `${head}，同时使用${mentions.join("、")}作为文案中的道具，${tail}`;
}

/** 没有任何参考图时的默认文案（也用作输入框 placeholder）。 */
export const DEFAULT_VIDEO_REVERSE_REQUIREMENT = buildDefaultVideoReverseRequirement();

/**
 * 「秒数」的默认值（用户 2026-11-09 口径：默认 30 秒、可手动改）。
 * 这个秒数是**成片总时长**：02 写文案按它规划台词量，03 生剧本按它规划镜数。
 */
export const DEFAULT_REVERSE_VIDEO_SECONDS = 30;
/** 秒数可调范围。上限放宽到 5 分钟：长视频脚本也有人用，但再长就不该用这套「分镜反推」了。 */
export const REVERSE_VIDEO_SECONDS_MIN = 5;
export const REVERSE_VIDEO_SECONDS_MAX = 300;

/**
 * 反推视频窗口的**默认出片参数**（用户 2026-11-11 第 02 条）：
 * 「比例默认选 16x9，视频模型跟随偏好的视频模型，分辨率也优先 720p。」
 *
 * 为什么是「默认值」而不是「归一化时写死」：写进 metadata 就变成「用户已经选过」，
 * 比例 / 分辨率就再也没法表达「我不改、按默认走」，老节点也会被无端改写。
 * 所以 metadata 里空着，**读取时**由 `resolveReverseVideoSize / resolveReverseVideoQuality`
 * 给出有效值 —— UI 显示的和 03 搬给脚本节点的是同一份。
 */
export const DEFAULT_REVERSE_VIDEO_SIZE = "16:9";
export const DEFAULT_REVERSE_VIDEO_QUALITY = "720";

/** 分辨率档位白名单（与 `QUALITY_OPTIONS` / 视频节点的 `vquality` 同一套）。 */
export const REVERSE_VIDEO_QUALITIES = ["480", "720", "1080", "2k"] as const;

/**
 * 有效比例：窗口里选过就用它（含 `auto` 与用户手输的 `21:9` 这类自定义值），
 * 没选过 → `16:9`。
 */
export function resolveReverseVideoSize(target: Partial<CanvasReverseVideoTarget> | null | undefined): string {
    return String(target?.size ?? "").trim() || DEFAULT_REVERSE_VIDEO_SIZE;
}

/**
 * 有效分辨率：只认白名单档位（`Select` 只有这几项，脏值不能送去生成），
 * 没选过 / 脏值 → `720`（用户口径：「分辨率也是优先 720p」）。
 */
export function resolveReverseVideoQuality(target: Partial<CanvasReverseVideoTarget> | null | undefined): string {
    const quality = String(target?.quality ?? "").trim();
    return (REVERSE_VIDEO_QUALITIES as readonly string[]).includes(quality) ? quality : DEFAULT_REVERSE_VIDEO_QUALITY;
}

/**
 * 归一化「目标视频参数」——窗口里选的那一档，也是 03 往脚本节点搬的那一份。
 *
 * 为什么要有这一步：UI 控件给什么值的都有（`InputNumber` 给 number 或 null、`Select` 允许清空、
 * 风格选择器回调 `undefined`），直接塞进 metadata 会出现 `"30"` / `30` / `null` 三种形态，
 * 下游一处按字符串判、一处按数字判就会静默失效。
 *
 * 口径：
 *  - 空串 / 空白 / null → 返回空对象里的对应键直接**丢掉**（= 跟随全局，语义上等价于没设）；
 *  - `seconds` 夹到 [5, 300] 的整数，非法值 → 回落默认 30。
 */
export function normalizeReverseVideoTarget(raw: Partial<CanvasReverseVideoTarget> | null | undefined): CanvasReverseVideoTarget {
    const source = raw || {};
    const text = (value: unknown) => String(value ?? "").trim();
    const target: CanvasReverseVideoTarget = {};
    const styleTemplateId = text(source.styleTemplateId);
    if (styleTemplateId) target.styleTemplateId = styleTemplateId;
    const model = text(source.model);
    if (model) target.model = model;
    const size = text(source.size);
    if (size) target.size = size;
    const quality = text(source.quality);
    if (quality) target.quality = quality;
    const seconds = Number(source.seconds);
    target.seconds = String(Number.isFinite(seconds) && seconds > 0 ? Math.min(REVERSE_VIDEO_SECONDS_MAX, Math.max(REVERSE_VIDEO_SECONDS_MIN, Math.round(seconds))) : DEFAULT_REVERSE_VIDEO_SECONDS);
    /**
     * 03 的执行方案：**只认白名单里的 id**，认不出就整个丢掉（=「没选」，走默认判定）。
     *
     * 🔴 这里绝不能像 `resolveScriptSchemeId` 那样把空串 / 脏值归一成 `builtin`：
     * `buildScriptSchemeSeed` 的退让条件是「元数据里已经有方案」，一旦写进 `"builtin"`，
     * 默认的第四套（影视分镜导演）就再也不会自动套用了 —— 等于把默认行为悄悄改回内置。
     */
    const scriptScheme = text(source.scriptScheme);
    if (scriptScheme && (SCRIPT_SCHEME_IDS as readonly string[]).includes(scriptScheme)) target.scriptScheme = scriptScheme as ScriptSchemeId;
    /**
     * 生视频引擎（用户 2026-11-10 第 02 条）：只认 `"mochiani"` 这一个哨兵，其它一律丢掉
     * （= 普通视频节点）。和 `scriptScheme` 同理，脏值不能留在元数据里假装「用户选过」。
     */
    if (isMochianiVideoEngine(text(source.videoEngine))) target.videoEngine = MOCHIANI_VIDEO_ENGINE;
    /**
     * 「每 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条）：只认 `3`，其它一律丢掉
     *（= 原行为 4 镜）。和 `scriptScheme` / `videoEngine` 同理 —— 脏值不能留在元数据里冒充「用户开过」。
     */
    if (Number(source.shotsPerClip) === SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT) target.shotsPerClip = SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT;
    return target;
}

/** 读 metadata 上的目标参数，永远给出一个「秒数有值、其它可能为空」的对象（UI 直接拿去渲染）。 */
export function readReverseVideoTarget(metadata: { reverseVideoTarget?: Partial<CanvasReverseVideoTarget> | null } | null | undefined): CanvasReverseVideoTarget {
    return normalizeReverseVideoTarget(metadata?.reverseVideoTarget);
}

/**
 * 02 / 03 里那句「按 N 秒写」。
 *
 * 为什么必须进提示词而不是只给脚本生成器：02 只要文案（不建脚本节点），模型默认会按
 * 「一条完整短片」写足一分钟；用户选 30 秒，产出的镜头数与台词量就必须是 30 秒的量。
 * 文案与剧本两头都要压，所以这句话在对话提示词里也出现一次。
 */
export function buildReverseTargetSecondsHint(seconds: number | string | undefined): string {
    const value = Number(seconds);
    const total = Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_REVERSE_VIDEO_SECONDS;
    const shots = Math.max(1, Math.round((total / 15) * 4));
    return `成片时长：整条片子按 ${total} 秒写 —— 镜头数量与台词量都按 ${total} 秒规划（参考「每 15 秒 4 镜」的节律，${total} 秒约 ${shots} 个镜头），不要写成 1 分钟的长片，也不要拆成一堆 1~2 秒的碎镜。`;
}

export const VIDEO_REVERSE_MODES = [
    {
        mode: 1 as const,
        no: "01",
        label: "反推视频",
        hint: "视频链接发进 AI 对话 → 用「视频反推-分镜提示词」反推 → 结果写进文本节点",
    },
    {
        mode: 2 as const,
        no: "02",
        label: "反推视频生成同类型文案",
        hint: "同 01，先弹窗填特殊要求（默认「反推出它的类型与写法，另写一份同类型的全新剧本…」），输出同类型的新剧本",
    },
    {
        mode: 3 as const,
        no: "03",
        label: "反推视频生成同类型文案及视频",
        hint: "同 02，再把文本节点接到脚本生成器并执行「一键视频」——剧本按上面选的秒数写，生视频用上面选的模型 / 比例 / 分辨率 / 风格",
    },
] as const;

export type VideoReverseSkillLike = {
    id: string;
    /** 技能原名 */
    name?: string;
    /** 用户备注名（展示优先） */
    alias?: string;
};

/** 归一化技能名：去掉分隔符 / 括号 / 空白，统一小写，避免「视频反推 - 分镜提示词」这种写法匹配不上。 */
export function normalizeSkillLabel(raw: string | undefined | null) {
    return String(raw || "")
        .toLowerCase()
        .replace(/[\s\-_—–·•/\\（）()【】[\]]+/g, "");
}

/**
 * 在技能库里挑「视频反推-分镜提示词」。
 *
 * 排序：完全同名（2 分）> 名字互相包含（1 分）；同分时按 `hints` 里的先后。
 * 一个都命中不了就返回 `null`——调用方据此告诉用户「技能没装」，绝不静默跑。
 */
export function pickVideoReverseSkill(skills: readonly VideoReverseSkillLike[], hints: readonly string[] = VIDEO_REVERSE_SKILL_HINTS): { id: string; name: string } | null {
    const wanted = hints.map((hint) => normalizeSkillLabel(hint)).filter(Boolean);
    if (!wanted.length) return null;
    let best: { id: string; name: string; rank: number; score: number } | null = null;
    for (const skill of skills || []) {
        if (!skill?.id) continue;
        const labels = [skill.alias, skill.name].map((value) => normalizeSkillLabel(value)).filter((label) => label.length >= 2);
        if (!labels.length) continue;
        for (let rank = 0; rank < wanted.length; rank++) {
            const target = wanted[rank];
            for (const label of labels) {
                const score = label === target ? 2 : label.includes(target) || target.includes(label) ? 1 : 0;
                if (!score) continue;
                const better = !best || score > best.score || (score === best.score && rank < best.rank);
                if (better) {
                    best = { id: skill.id, name: String(skill.alias || skill.name || skill.id), rank, score };
                }
            }
        }
    }
    return best ? { id: best.id, name: best.name } : null;
}

export type VideoReversePromptInput = {
    /** 接入的视频地址（画布视频节点 `metadata.content`） */
    videoUrl?: string;
    mode: VideoReverseMode;
    /** 02 / 03 的特殊要求 */
    requirement?: string;
    /**
     * 02 / 03 的**成片总时长（秒）**：来自节点「生成设置」里的秒数（默认 30）。
     * 01 忽略它 —— 01 是反推眼前这条视频，它的时长由视频本身决定，写个数字只会让模型改镜头数。
     */
    targetSeconds?: number | string;
};

const isRemoteUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * 三条命令（01 / 02 / 03）**共用**一句输出语言硬要求：全文简体中文。
 *
 * 为什么必须写死：模型会跟着视频本身的语言 / 技能模板里的英文示例走，明明是中文需求，反推出来却是
 * 一整段英文分镜提示词，或者中文里夹着英文的「镜头描述」。这条不是「建议」而是硬要求，且三条命令
 * 只留一份文案 —— 三处各写一句必然漂。
 *
 * 2026-11-09 用户口径「强化」之后补的三件事：
 *  ① 写明**优先级**：技能正文（用户自己装的技能包）里的英文模板 / 英文示例不算数，格式照抄、语言必须是中文 ——
 *     否则模型把「模板是英文」当成「输出该用英文」的依据；
 *  ② 把**字段名 / 小节标题**单独点名：反推表头是最容易被漏掉的地方（`Shot 1 / Shot Size: Medium / Camera: Dolly`），
 *     只写「不要英文句子」管不到它；
 *  ③ 加一句**自查**：让模型在输出前把「成句的英文」改掉，比事后补救便宜。
 * 专有名词放行（品牌、模型名、影片名），否则「Seedance」这类词会被硬翻成看不懂的中文。
 *
 * ⚠️ 这段文案在 `buildVideoReversePrompt` 里**首尾各钉一次**（模型对开头 / 结尾的指令最敏感），
 * 但只在这里写一份 —— 同一句话复制两份必然漂。`needsChineseRewrite` 是最后一道兜底（见下）。
 */
export const VIDEO_REVERSE_LANGUAGE_RULE = "输出语言：全文必须使用简体中文（这是最高优先级硬要求，优先于技能正文里的任何格式模板 / 示例 / 英文占位；模板的格式照抄，语言必须换成中文）。分镜表的字段名与小节标题（镜头 / 景别 / 运镜 / 画面 / 台词 / 时长 / 音效…）一律用中文，不要保留英文标题、英文括号注释或中英对照；不要出现英文句子、英文段落或中英混排的说明。专有名词 / 品牌 / 模型名可保留原文（如 Seedance、GPT）。写完后自查一遍：只要还有成句的英文，就改写成中文再输出。";

/**
 * 检测「没按要求用中文」——`runVideoReverse` 拿到回复后据此决定要不要让模型重写一遍。
 *
 * 为什么要有这层：提示词再硬也只是「请求」，用户装的技能包正文如果整篇英文（模板 + 示例 + 字段名），
 * 模型仍会照抄。这一步是**确定性兜底**：只有在明显跑偏时才多打一次模型（正常输出一次都不会触发）。
 *
 * 判定口径（宁漏不误伤 —— 误判会白花一次 token 和一轮等待）：
 *  - 汉字数 < 英文词数 × 0.5 且英文词 ≥ 20 才算跑偏。正常中文文案里汉字数约是英文词数的 1.5 倍以上，
 *    夹几个 `Seedance` / `GPT` / `@图片1` 根本到不了这个比值；
 *  - 中文正文里偶尔带一段英文提示词（引用原片台词之类）也不会触发，那是「夹一句」不是「整篇不是中文」。
 */
export function needsChineseRewrite(text: string | undefined | null): boolean {
    const body = String(text || "");
    if (!body.trim()) return false;
    const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
    const latinWords = (body.match(/[A-Za-z]{2,}/g) || []).length;
    // 英文词太少：`OK` / `H.264` / 几个品牌名，怎么都不算「整篇不是中文」
    if (latinWords < 20) return false;
    return cjk < latinWords * 0.5;
}

/**
 * 重写指令：把上一轮的结果**只换语言、不动内容**重出一遍。
 *
 * 「原样保留内容与结构」必须写死：不然模型会顺手把镜头改少、把文案重写一遍 —— 用户要的是同一份东西的中文版。
 */
export const VIDEO_REVERSE_REWRITE_PROMPT = "上一次的输出没有按要求使用简体中文。请把刚才那份结果原样保留内容与结构，整篇改写成简体中文重新输出一遍：字段名、小节标题、说明文字全部用中文，镜头数量与顺序不许增删，不要再解释、也不要写任何前言后语。";


/**
 * 02 / 03 的「创作口径」：这条视频是**样本**，不是要复刻的剧本（用户 2026-11-12 报障）。
 *
 * 报障原话：「需要的是 反推后，生成同类型的其他的剧本……现在经过上次修改确实是只给我剧本内容了，
 * 但是感觉像是直接反推了一份给我，并不是重新生成的另外同类型的其他剧本。」
 *
 * 真因：上一版主指令写的是「把这条视频看明白 → 写一份**同款风格**的剧本」。模型刚看懂原片，
 * 最省力的做法就是把它转写成剧本 —— 「同类型」于是退化成「同一条」。这不是模型偷懒，
 * 而是**没告诉它「样本」与「复刻」的区别**，也没给一条它能自己判定的验收标准。
 *
 * 所以这条同时干三件事：① 定义「看片」的产出物是**类型要素**（只在心里，不输出）；
 * ② 定义「写作」的产出物是**另一个故事**（哪些必须换掉，逐项点名）；
 * ③ 给一条可自检的判据（并排看应该像「同一赛道的另一支片子」）。
 *
 * ⚠️ 与另外两条规则一样：首尾各钉一次（尾部用 `VIDEO_REVERSE_NEW_STORY_ECHO` 的压缩版），且 **01 绝不带**。
 */
export const VIDEO_REVERSE_NEW_STORY_RULE =
    "创作口径（最容易做错的一条）：我提供的视频只是**同类型的样本**，不是要你复刻的剧本。\n" +
    "① 先在心里把它拆成**类型要素**：题材类型、叙事结构、节奏与反转位置、爽点 / 钩子机制、人物功能位（谁承担什么作用，不是谁叫什么名字）、镜头语法 —— 这一步只在你自己心里做，**一个字的分析都不许写出来**。\n" +
    "② 再用这套类型要素**另外写一个全新的剧本**：人物姓名与身份、场景地点、具体事件、冲突与结局、台词，一律换成新的；只保留同类型的套路、结构与节奏。\n" +
    "③ **严禁把原片转写成剧本**：不许沿用原片的人物关系、事件顺序、关键台词、标志性道具与布景。如果你的输出读起来就是这条视频的文字版，那就是做错了。\n" +
    "④ 自检：把你的剧本和这条视频并排放，应该像「同一赛道的另一支片子」，而不是「这条片的分镜转写」。";

/**
 * 尾钉版（压缩成一句）：模型对**结尾**指令最敏感，而中间还夹着「特殊要求 / 时长 / 视频链接」三段
 * 容易被当成局部约束的内容。完整规则只在开头钉一次，结尾钉这一句即可（不把提示词撑太长）。
 */
export const VIDEO_REVERSE_NEW_STORY_ECHO = "再强调一次创作口径：这条视频只是同类型样本 —— 你必须写**另一个故事**的剧本（人物 / 场景 / 情节 / 台词全新），不许把原片的内容转写成剧本。";

/**
 * 02 / 03 的**唯一输出物**：同类型剧本正文（用户 2026-11-11 第 02 条）。
 *
 * 报障原话：「执行 92、03 的时候，输出的反推出来的同类型剧本，输出文本的时候总给我出一堆没用的
 * 注释内容，导致我想要的同类型剧本都生成不完，请直接给我输出反推出来的同类型的剧本内容，
 * 别生成乱七八糟的注释和解释。」
 *
 * 为什么会「生成不完」：模型把「反推过程 + 分镜提示词表 + 参数说明 + 剧本」全写一遍，
 * 输出被前面的分析吃掉，剧本写到一半就到上限了。所以这一条不只是「少写废话」，
 * 而是**把输出预算全部让给剧本**：分析在模型心里做，不许写出来。
 *
 * ⚠️ 与 `VIDEO_REVERSE_LANGUAGE_RULE` 一样，这段在 `buildVideoReversePrompt` 里首尾各钉一次、只写一份。
 * 2026-11-12 只把「同款」改成「同类型」：旧词同时暗示「同类型」和「同一条」，是这次报障的诱因之一。
 */
export const VIDEO_REVERSE_SCRIPT_ONLY_RULE =
    "输出内容（最高优先级硬要求）：**只输出可以直接拿去用的同类型剧本正文**——分镜/场景标题、镜头、画面、台词、音效、时长这些正文行，第一行就是正文本身。\n" +
    "以下内容一律不许出现在输出里（哪怕只有一句）：① 反推过程、看片分析、风格总结、分镜思路；② 分镜提示词表、参数说明、制作建议、运镜/景别术语解释；③ 任何前言（「好的」「以下是」「根据您提供的视频」）、后记（「希望对你有帮助」「如需调整请告诉我」）、注释 / 备注 / 括号补充 / 免责声明 / 本章说明；④ 用 `---` 或空行隔开的「分析与正文」两段式结构。\n" +
    "内容较长时**优先保证剧本正文完整**：先删掉一切非正文内容再输出，不要为了写分析而把剧本截断。";

/**
 * 02 / 03 拿到回复后的**确定性清洗**（提示词是「请求」，这一步是「保证」）。
 *
 * 只做三件极其保守的事，绝不删正文：
 *  1. 整个回复被 ```…``` 包起来 → 去掉包裹（否则文本节点 / 脚本解析器会当成代码块）；
 *  2. 开头的寒暄 / 说明（「好的」「以下是」「根据您提供的视频…」）—— 只在**还没出现正文**时删，
 *     且只删单行 ≤50 字、明显是客套的行；
 *  3. 结尾的「注：…」「希望对你有帮助」「如需调整…」这类纯后记行。
 *
 * 🔴 只用于 02 / 03（输出物=剧本）。01 是纯反推结果，不能被清洗 —— 那张分镜提示词表里
 * 本来就会有「说明」「注意」这类正常内容。
 */
export function cleanVideoReverseScriptOutput(text: string | undefined | null): string {
    let body = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!body) return "";
    // ① 整体代码块包裹
    const fenced = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    if (fenced) body = fenced[1].trim();
    const lines = body.split("\n");
    /** 开头客套 / 说明：只在正文出现之前删，且只认单行短句，避免吃掉真的剧本行。 */
    const isPreamble = (line: string) => {
        const value = line.trim();
        if (!value || value.length > 50) return false;
        return (
            /^(好的|收到|明白|了解|没问题)[，,。！!：:\s]/.test(value) ||
            /^以下(是|为)/.test(value) ||
            /^(下面|接下来)(是|给|我)/.test(value) ||
            /^我(将|会|先|来)/.test(value) ||
            /^(根据|按照)(你|您)?(提供|的|要求)/.test(value) ||
            /^(说明|注释|备注|提示|注意)[：:]/.test(value) ||
            /^[-—=*]{3,}$/.test(value)
        );
    };
    /** 结尾后记：从后往前删连续命中行。 */
    const isFarewell = (line: string) => {
        const value = line.trim();
        if (!value) return true;
        return (
            /^(注|备注|说明|提示|注意)[：:]/.test(value) ||
            /^[（(]\s*(注|说明|备注)/.test(value) ||
            /^(以上|综上|总结)/.test(value) ||
            /^希望(这|本|以上|对你)/.test(value) ||
            /^如需|^如果(你|您)(还)?需要|^需要我/.test(value)
        );
    };
    let start = 0;
    while (start < lines.length && isPreamble(lines[start])) start += 1;
    let end = lines.length - 1;
    while (end > start && isFarewell(lines[end])) end -= 1;
    return lines.slice(start, end + 1).join("\n").trim();
}

/**
 * 发给 AI 对话窗口的那句话。
 *
 * ⚠️ 视频本身是**通过连线**进对话的（`sendChatMessage` 会把它当视频输入：原生 video_url，或抽帧成图片），
 * 文本里的「视频链接」只是给用户和模型一个可读的引用；本地 `blob:` 地址模型打不开，
 * 所以要显式说明「看连线传入的内容」，别让模型去 fetch 一个它拿不到的链接。
 *
 * ⚠️ 语言硬要求**首尾各钉一次**（开头先声明、结尾再收口）：模型对首尾指令最敏感，中段还夹着
 * 「特殊要求」「视频链接」这些容易被当成局部约束的内容，只放一处经常被技能正文的英文示例盖过去。
 */
export function buildVideoReversePrompt({ videoUrl, mode, requirement, targetSeconds }: VideoReversePromptInput): string {
    const lines: string[] = [];
    lines.push(VIDEO_REVERSE_LANGUAGE_RULE);
    if (mode === 1) {
        lines.push("请用「视频反推-分镜提示词」技能反推我接入的这条视频，输出可以直接拿去用的分镜提示词。");
    } else {
        /**
         * 02 / 03 的核心口径（用户 2026-11-11 第 02 条）：**看片只在模型心里做，输出只要剧本**。
         * 以前写的是「在反推结果的基础上写一份同款文案」→ 模型先把反推结果整篇写出来，剧本被挤到后面截断。
         *
         * 2026-11-12 补一刀（用户）：「感觉像是直接反推了一份给我，并不是重新生成的另外同类型的其他剧本。」
         * 上一版只说了「看明白 → 写一份同款风格的剧本」，**没说清「样本」与「复刻」的区别** ——
         * 模型刚看懂原片，顺手就把它转写了。所以现在拆成两个显式动作：
         * ① 看片 = 提炼**类型要素**（只在心里）；② 写 = **另一个故事**（见 `VIDEO_REVERSE_NEW_STORY_RULE`）。
         * 顺序不能反：先立「样本」口径，再立「只输出正文」口径 —— 后者只约束形式，管不住「写的是不是同一个故事」。
         */
        lines.push("请先用「视频反推-分镜提示词」技能把这条视频看明白（这一步**只在你自己心里做，不要输出任何过程**），然后**另外写一个同类型的新剧本**——不是把这条视频的剧情转写成剧本。");
        lines.push(VIDEO_REVERSE_NEW_STORY_RULE);
        lines.push(VIDEO_REVERSE_SCRIPT_ONLY_RULE);
    }
    const extra = (requirement || "").trim();
    if (mode !== 1 && extra) lines.push(`特殊要求：${extra}`);
    // 时长只对 02 / 03 有意义：01 是照原片反推，镜头数由视频本身决定。
    if (mode !== 1) lines.push(buildReverseTargetSecondsHint(targetSeconds));
    const url = (videoUrl || "").trim();
    if (isRemoteUrl(url)) lines.push(`视频链接：${url}`);
    else lines.push("视频已通过画布连线接入（本地/临时地址，模型打不开链接），请按连线传入的视频内容反推。");
    lines.push(VIDEO_REVERSE_LANGUAGE_RULE);
    if (mode === 1) {
        lines.push("只输出结果正文，不要解释你的分析过程，也不要写与结果无关的寒暄。");
    } else {
        // 尾钉一次：模型对结尾指令最敏感，而上面还夹着「特殊要求」「时长」「视频链接」三段易被当局部约束的内容。
        // 2026-11-12 起「样本而非复刻」也在尾部收口一遍（压缩成一句）—— 长输出写到后半段最容易滑回「转写原片」。
        lines.push(VIDEO_REVERSE_SCRIPT_ONLY_RULE);
        lines.push(VIDEO_REVERSE_NEW_STORY_ECHO);
    }
    return lines.join("\n");
}
