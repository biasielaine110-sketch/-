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
import { normalizeScriptShotsPerClip } from "@/constant/story-script";
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

/**
 * 反推可用的技能（用户 2026-11-12 第 02 条）：「需要能够切换技能，主要是切换这两个技能，
 * SS视频反推技能和视频反推-分镜提示词技能，默认选择使用视频反推-分镜提示词技能，需要切换再进行手动切换，
 * 仍然保持原执行 01，02，03 的相关规则和约束。」
 *
 * 🔴 **默认是「视频反推-分镜提示词」**（原口径），不是 SS —— 老节点没有这个字段，
 * `resolveVideoReverseSkillId` 必须回落到它，行为才与升级前一致。
 *
 * 🔴 每个技能**只给自己的精确名**，不加「视频反推」「分镜提示词」这类泛名：
 * `pickVideoReverseSkill` 是双向包含，泛名会让「选 A 却挑到 B」——
 *  - target「视频反推」会被 label「ss视频反推」包含 → 选了分镜提示词却跑 SS；
 *  - target「分镜提示词」会被 label「视频反推分镜提示词」包含 → 选了 SS 却跑分镜。
 * 切换控件存在的前提就是「选谁跑谁」，所以宁可挑不到报错，也不许串味。
 */
export const VIDEO_REVERSE_SKILL_OPTIONS = [
    {
        id: "storyboard" as const,
        label: "视频反推-分镜提示词",
        hints: ["视频反推-分镜提示词"] as const,
        hint: "默认 · 分镜提示词形态（原口径）",
    },
    {
        id: "ss" as const,
        label: "SS视频反推",
        hints: ["SS视频反推"] as const,
        hint: "SS 反推技能（「SS视频反推SS」也能命中）",
    },
];

export type VideoReverseSkillId = (typeof VIDEO_REVERSE_SKILL_OPTIONS)[number]["id"];

/** 默认技能：视频反推-分镜提示词。 */
export const DEFAULT_VIDEO_REVERSE_SKILL_ID: VideoReverseSkillId = "storyboard";

/** 取一个技能定义的辅助（`id` 认不出时给默认那一条）。 */
export function findVideoReverseSkillOption(id: string | null | undefined) {
    const wanted = String(id ?? "").trim();
    return VIDEO_REVERSE_SKILL_OPTIONS.find((item) => item.id === wanted) || VIDEO_REVERSE_SKILL_OPTIONS[0];
}

/** 把 metadata 上的技能 id 归一成白名单里的一个（缺省 / 脏值 → 默认「视频反推-分镜提示词」）。 */
export function resolveVideoReverseSkillId(raw: string | null | undefined): VideoReverseSkillId {
    return findVideoReverseSkillOption(raw).id;
}

/** 读节点 metadata 上的技能选择（UI 与执行器共用一份，别各写一遍回落）。 */
export function readReverseVideoSkill(metadata: { reverseVideoSkill?: string | null } | null | undefined) {
    return findVideoReverseSkillOption(resolveVideoReverseSkillId(metadata?.reverseVideoSkill));
}

/**
 * 反推（看片）用的**文本模型**（用户 2026-11-12 第 05 条：「反推视频的那个模型也需要能够选择」）。
 *
 * 只做「取字符串 + 去空白」这一件事：值是 `encodeChannelModel` 编出来的 `channelId::model`，
 * 有效性由 `ModelPicker` 与 `resolveModelRequestConfig` 去管，这里**不做渠道校验**
 * （纯逻辑模块没有渠道表，硬校验只会把「渠道暂时被禁用」误判成「没选」）。
 *
 * 空串 = 没选过 → 调用方回落内置默认（`gemini-3.8-flash` · toapis），所以老节点行为不变。
 */
export function readReverseVideoChatModel(metadata: { reverseVideoChatModel?: string | null } | null | undefined): string {
    return String(metadata?.reverseVideoChatModel || "").trim();
}

/**
 * 兼容旧引用：默认技能的 hints / label。
 * ⚠️ 新代码请走 `readReverseVideoSkill(metadata)` —— 这两个常量只代表**默认技能**，
 * 不再是「唯一的技能」。提示词里点名哪个技能，由 `buildVideoReversePrompt` 的 `skillLabel` 决定。
 */
export const VIDEO_REVERSE_SKILL_HINTS = VIDEO_REVERSE_SKILL_OPTIONS[0].hints;
export const VIDEO_REVERSE_SKILL_LABEL = VIDEO_REVERSE_SKILL_OPTIONS[0].label;

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
export function buildDefaultVideoReverseRequirement(imageMentions: readonly string[] = [], mode: VideoReverseMode = 2): string {
    /**
     * 2026-11-12 改口径（用户）：「需要的是**反推后，生成同类型的其他剧本**……现在感觉像是直接反推了一份给我，
     * 并不是重新生成的另外同类型的其他剧本。」
     *
     * 旧 head「写一份**同款风格**的剧本文案」是在暗示「把这条片的剧本复述出来」——「同款」既可读成
     * 「同类型」，也可读成「同一个」。要框定成后者之外的语义，就得把两个动作写清楚：
     * **先反推类型与写法（当样本看）→ 再另写一份全新的同类型剧本（内容换掉）**。
     *
     * 2026-11-12（第 04 条）再拆一档：这个「换个说法」的诉求现在**只属于 03**。02 要的就是复刻同款，
     * 所以 02 的默认文案必须直接说「复刻」，否则要求框与提示词里的创作口径互相打架（用户会看到
     * 框里写着「另写新剧本」、实际跑的是复刻 —— 谁也不知道以哪个为准）。
     */
    const head =
        mode === 2
            ? "根据我提供的视频，复刻一份同款剧本文案：人物、场景、事件顺序、台词、镜头都照它来"
            : "根据我提供的视频，反推出它的类型与写法，另外写一份同类型的全新剧本文案";
    const tail = "只要剧本正文，不要提示词、分析和任何注释";
    const mentions = Array.from(new Set((imageMentions || []).map((item) => String(item || "").trim()).filter(Boolean))).map((item) => (item.startsWith("@") ? item : `@${item}`));
    if (!mentions.length) return `${head}，${tail}`;
    return `${head}，同时使用${mentions.join("、")}作为文案中的道具，${tail}`;
}

/** 没有任何参考图时的默认文案（也用作输入框 placeholder）。02 是默认档，取它的口径。 */
export const DEFAULT_VIDEO_REVERSE_REQUIREMENT = buildDefaultVideoReverseRequirement([], 2);

/**
 * 「秒数」的默认值（用户 2026-11-09 口径：默认 30 秒、可手动改）。
 * 这个秒数是**成片总时长**：02 / 03 写剧本都按它规划镜头数与台词量（02 复刻原片时长、03 按它拆镜）。
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
 * 给出有效值 —— UI 显示的、和 02 / 03 搬给脚本节点的是同一份。
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
 * 归一化「目标视频参数」——窗口里选的那一档，也是 02 / 03 往脚本节点搬的那一份。
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
     * 02 / 03 的执行方案：**只认白名单里的 id**，认不出就整个丢掉（=「没选」，走默认判定）。
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
     * 「每 2 / 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条、2026-11-14 加 2 镜档）：
     * 只认档位白名单（2 / 3），其它一律丢掉（= 原行为 4 镜）。和 `scriptScheme` / `videoEngine`
     * 同理 —— 脏值不能留在元数据里冒充「用户开过」。
     */
    const shotsPerClip = normalizeScriptShotsPerClip(source.shotsPerClip);
    if (shotsPerClip) target.shotsPerClip = shotsPerClip;
    return target;
}

/** 读 metadata 上的目标参数，永远给出一个「秒数有值、其它可能为空」的对象（UI 直接拿去渲染）。 */
export function readReverseVideoTarget(metadata: { reverseVideoTarget?: Partial<CanvasReverseVideoTarget> | null } | null | undefined): CanvasReverseVideoTarget {
    return normalizeReverseVideoTarget(metadata?.reverseVideoTarget);
}

/**
 * 02 / 03 里那句「按 N 秒写」。
 *
 * 为什么必须进提示词而不是只给脚本生成器：模型默认会按「一条完整短片」写足一分钟；
 * 用户选 30 秒，产出的镜头数与台词量就必须是 30 秒的量。文案与剧本两头都要压，
 * 所以这句话在对话提示词里也出现一次（02 / 03 都走这条路，与是否建脚本节点无关）。
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
        hint: "视频链接发进 AI 对话 → 用「反推技能」里选的那个技能反推 → 结果写进文本节点",
    },
    {
        mode: 2 as const,
        no: "02",
        label: "反推视频复刻同款文案及视频",
        hint: "同 01，先弹窗填特殊要求（默认「复刻一份同款剧本文案…」）→ 剧本照原片复刻 → 再接脚本生成器执行一键视频（与 03 的执行流程完全一致）",
    },
    {
        mode: 3 as const,
        no: "03",
        label: "反推视频生成同类型文案及视频",
        hint: "同 02，唯一区别是剧本内容：把它当同类型样本、另写一个全新的故事（人物 / 场景 / 情节 / 台词全换）",
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
 * 在技能库里挑「当前选中的反推技能」。
 *
 * `hints` 来自 `VIDEO_REVERSE_SKILL_OPTIONS[?].hints`（节点上选哪条就用哪条的精确名），
 * 缺省 = 默认技能「视频反推-分镜提示词」。
 *
 * 排序：完全同名（2 分）> 名字互相包含且长度够（1 分）；同分时按 `hints` 里的先后。
 * 一个都命中不了就返回 `null`——调用方据此告诉用户「技能没装」，绝不静默跑（也绝不换成另一条技能）。
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
                // 「方向不对称」：技能名比目标长（`SS视频反推（优化版）`）→ 认；
                // 技能名比目标短超过 1/3（`视频反推` 这种泛名）→ **不认**。
                // 1/3 这个界是量出来的：`SS视频反推`(6) 认 `SS视频反推SS`(8) 的短写，
                // 而 `视频反推`(4) 想认 `ss视频反推`(6) / `ss视频反推ss`(8) 都会被挡住 ——
                // 否则用户在节点上选了 SS，旧技能（别名「视频反推」）也会被挑中，等于静默串味。
                const contains = label.includes(target) || (target.includes(label) && label.length * 3 > target.length * 2);
                const score = label === target ? 2 : contains ? 1 : 0;
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
    /**
     * 提示词里点名的技能名（用户 2026-11-12 第 02 条：节点可切换技能）。
     *
     * 传**实际挑中的技能名**（技能库里的 alias / name），缺省 = 默认技能「视频反推-分镜提示词」。
     * 只影响这三句「请用 X 技能…」的叫法，输出形态约束（只出正文 / 中文 / 时长）与
     * 创作口径（02 复刻同款、03 同类型新故事）一条不动。
     */
    skillLabel?: string;
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
 * **02 的创作口径：复刻同款**（用户 2026-11-12 第 04 条）。
 *
 * 用户原话：「02 跟 03 除了在输出的文案上其他完全跟 03 保持一致，即 02 的文案调整为输出**复刻同款**文案……
 * 02 跟 03 除了输出的剧本内容不一样，其他执行和约束完全一样，02 是复刻同款，03 是根据复刻内容重新输出
 * 一段同类型的但其他剧情的文案剧本内容。」
 *
 * 所以 02 / 03 的差别**只在这条创作口径**（以及下面那条尾钉）：
 *  - 02 = 把这条片本身写成剧本（人物 / 场景 / 事件 / 台词 / 镜头都照原片）；
 *  - 03 = 把它当同类型样本，另写一个故事（见 `VIDEO_REVERSE_NEW_STORY_RULE`）。
 * 其余全部共用：只输出正文、中文强制、时长、参考图当道具、连进对话、建脚本节点 + 一键视频、
 * 参考图挂道具并进跳过表 —— 一条都不许分叉。
 *
 * ⚠️ 与另外两条规则同规格：首尾各钉一次（尾部用 `VIDEO_REVERSE_COPY_STORY_ECHO`），且 **01 / 03 都不带**。
 */
export const VIDEO_REVERSE_COPY_STORY_RULE =
    "创作口径：这次要的是**复刻同款** —— 把这条视频本身写成一份可以直接开拍的剧本，**不要换剧情**。\n" +
    "① 先在你自己心里把它看明白（人物与身份、场景与服化道、道具、事件顺序与转折、台词口播、镜头景别与运镜、节奏），这一步**一个字的分析都不许写出来**。\n" +
    "② 再按原样写成剧本正文：同一批人物、同样的场景与道具、同样的事件顺序与转折、同样的台词、同样的镜头与运镜，逐场对齐。\n" +
    "③ 只允许在**不动剧情与镜数**的前提下把表述补全（口语补成可直接拍的画面描述，补上必要的动作 / 情绪 / 音效）；**不许加戏、不许删戏、不许改结局、不许换人物名字**。\n" +
    "④ 自检：照着这份剧本拍一遍，应该得到一条和原片几乎一样的片子。如果你写出来的是「另一条同类型的片子」，那就是写偏了。";

/**
 * 尾钉版（压缩成一句）：与 `VIDEO_REVERSE_NEW_STORY_ECHO` 对称 —— 长输出写到后半段最容易滑回
 * 「另编一个故事」，所以 02 的结尾必须把「复刻」再收一次口。
 */
export const VIDEO_REVERSE_COPY_STORY_ECHO = "再强调一次创作口径：这次是**复刻同款** —— 人物 / 场景 / 事件顺序 / 台词 / 镜头一律照原片来，写成一份可直接开拍的同款剧本，不许换剧情、不许加戏。";

/**
 * **03 的创作口径：这条视频是样本，不是要复刻的剧本**（用户 2026-11-12 报障）。
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
 * ⚠️ 与另外两条规则一样：首尾各钉一次（尾部用 `VIDEO_REVERSE_NEW_STORY_ECHO` 的压缩版），
 * 且**只给 03**（01 是纯反推、02 是复刻同款，都不带）。
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
 * 02 / 03 的**唯一输出物**：剧本正文（用户 2026-11-11 第 02 条）。
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
 * 2026-11-12（第 04 条）再把「同类型」这个定语**整个去掉**：02 是复刻、03 是新故事，两者共用的只是
 * 「形式」约束（只要正文、第一行就是正文、不许有分析 / 注释 / 前言后记），创作口径由各自的规则给。
 * 共用文案里留一个「同类型 / 同款」的定语，02 与 03 就必有一条是自相矛盾的 —— 模型会挑省力的那条读。
 */
export const VIDEO_REVERSE_SCRIPT_ONLY_RULE =
    "输出内容（最高优先级硬要求）：**只输出可以直接拿去用的剧本正文**——分镜/场景标题、镜头、画面、台词、音效、时长这些正文行，第一行就是正文本身。\n" +
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
export function buildVideoReversePrompt({ videoUrl, mode, requirement, targetSeconds, skillLabel }: VideoReversePromptInput): string {
    /**
     * 点名的技能（用户 2026-11-12 第 02 条「可切换技能」）：节点选哪个就写哪个。
     * 空 / 只有空白 → 默认技能；除名字外，三条命令的其余约束一字不动。
     */
    const skill = String(skillLabel ?? "").trim() || VIDEO_REVERSE_SKILL_LABEL;
    const lines: string[] = [];
    lines.push(VIDEO_REVERSE_LANGUAGE_RULE);
    if (mode === 1) {
        lines.push(`请用「${skill}」技能反推我接入的这条视频，输出可以直接拿去用的分镜提示词。`);
    } else {
        /**
         * 02 / 03 的核心口径（用户 2026-11-11 第 02 条）：**看片只在模型心里做，输出只要剧本**。
         * 以前写的是「在反推结果的基础上写一份同款文案」→ 模型先把反推结果整篇写出来，剧本被挤到后面截断。
         *
         * 2026-11-12 补一刀（用户）：「感觉像是直接反推了一份给我，并不是重新生成的另外同类型的其他剧本。」
         * 上一版只说了「看明白 → 写一份同款风格的剧本」，**没说清「样本」与「复刻」的区别** ——
         * 模型刚看懂原片，顺手就把它转写了。现在拆成两个显式动作：看片 = 提炼类型要素（只在心里）；
         * 写 = 另一个故事（`VIDEO_REVERSE_NEW_STORY_RULE`）。
         *
         * 2026-11-12（第 04 条）再按 mode 拆开：**02 = 复刻同款**（把这条片写成剧本）、
         * **03 = 同类型新故事**。两个分支只换「创作口径」这三行，其余（特殊要求 / 时长 / 链接 /
         * 语言规则 / 只输出正文 / 中文兜底 / 建脚本节点 + 一键视频 / 参考图挂道具）**完全共用**。
         * 别在这里给某一条加额外的形式约束 —— 那正是「02 与 03 悄悄分叉」的入口。
         */
        const copy = mode === 2;
        lines.push(
            copy
                ? `请先用「${skill}」技能把这条视频看明白（这一步**只在你自己心里做，不要输出任何过程**），然后**把这条视频复刻成一份同款剧本**——人物、场景、事件顺序、台词、镜头都照它来，不要另编剧情。`
                : `请先用「${skill}」技能把这条视频看明白（这一步**只在你自己心里做，不要输出任何过程**），然后**另外写一个同类型的新剧本**——不是把这条视频的剧情转写成剧本。`,
        );
        lines.push(copy ? VIDEO_REVERSE_COPY_STORY_RULE : VIDEO_REVERSE_NEW_STORY_RULE);
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
        // 创作口径的尾钉**按 mode 分开**：02 收「复刻」、03 收「另写一个故事」——长输出写到后半段最容易滑到另一边
        //（02 滑成另编故事、03 滑成转写原片），这两句各自堵各自的方向。
        lines.push(VIDEO_REVERSE_SCRIPT_ONLY_RULE);
        lines.push(mode === 2 ? VIDEO_REVERSE_COPY_STORY_ECHO : VIDEO_REVERSE_NEW_STORY_ECHO);
    }
    return lines.join("\n");
}
