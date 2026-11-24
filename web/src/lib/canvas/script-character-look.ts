import { resolveScriptAssetRole, splitScriptAssetVariant } from "@/constant/story-script";

/**
 * 脚本生成器 · 角色外貌差异化（确定性外貌锚点）。
 *
 * ## 为什么要有这一层
 *
 * 用户 2026-11-24 报障：「分镜表里出来的角色总是千篇一律，多个剧本的角色基本长一个样」。
 * 根因不在生图侧 —— 生图拿到的提示词就是分镜表「角色与角色描述」那一格的原文
 * （见 `collectScriptAssetPromptCandidates`），而那一格是脚本模型写的**人物小传**：
 * 身份、性格、穿着写得很足，外貌只有「清俊」「白皙」「五官精致」这类高频模板词。
 * 生图模型对这类词的先验极强 —— 写「更帅一点」没用，全是同一张脸。
 *
 * 所以这里在**生图拼装**这一层补一段「能被画出来的参数」：脸型轮廓、眉眼、鼻唇、体型、
 * 一个辨识特征。挂在资产描述之后、词库版式之前（见 `applyScriptAssetDirectDecorations` 的顺序）。
 *
 * ## 三条铁律
 *
 * ① **确定性**：取值只依赖 `稳定哈希(盐 + 角色基础名 + 维度)`，不用 `Math.random`、不看时间。
 *    同一个角色重新生图、跨镜头、跨集都是同一张脸；不同角色才会不同。
 * ② **哈希键是「基础名」**：`叶辰@校服` 与 `叶辰@便服` 必须共用一张脸，所以喂进去的是
 *    `splitScriptAssetVariant(title).base`，不是完整标题（造型不换脸）。
 * ③ **不覆盖用户写的描述**：描述里已经写了某个维度（「圆脸」「厚唇」）就跳过那个维度，
 *    锚点只补空缺。这条和 `withScriptAssetVariantHint`（造型词已写就不动）是同一个哲学。
 *    只有 `strong` 档才会清掉描述里的**笼统审美形容词**（「五官精致」「长相俊美」），
 *    因为它们不是可画参数、只会把所有人都拉回同一张平均脸。
 *
 * ## 幂等
 *
 * 块头固定是 `【外貌锚点】`，正文里已经出现就直接原样返回 —— 不能靠
 * `appendScriptAssetPromptSuffix` 的「含整段尾缀」判断（锚点每张图都不一样，永远不命中）。
 */

export type ScriptCharacterLookLevel = "off" | "light" | "standard" | "strong";

/** 档位顺序（工具栏那颗按钮点一下切下一档，走这个顺序）。 */
export const SCRIPT_CHARACTER_LOOK_LEVELS: ScriptCharacterLookLevel[] = ["off", "light", "standard", "strong"];

/**
 * 默认档位 = **轻度**（用户 2026-11-24 口径）。
 *
 * 轻度只补 2 个维度、且只补描述里没写的维度，属于「加了也不会冲突」的最小改动；
 * `undefined`（老画布从没设过这一档）也按轻度算 —— 用户希望打开就能看到差别，
 * 而不是先去某个弹窗里把开关打开。要完全回到老行为就显式选「关闭」。
 */
export const DEFAULT_SCRIPT_CHARACTER_LOOK_LEVEL: ScriptCharacterLookLevel = "light";

/** 注入块的固定开头（幂等判据）。 */
export const SCRIPT_CHARACTER_LOOK_MARKER = "【外貌锚点】";

/** 每个档位补几个维度（顺序见 `LOOK_DIMENSION_ORDER`，从最能拉开差异的脸型开始）。 */
const LOOK_DIMENSION_COUNT: Record<Exclude<ScriptCharacterLookLevel, "off">, number> = {
    light: 2,
    standard: 4,
    strong: 6,
};

/**
 * 维度顺序：脸型 → 眼睛 → 鼻子 → 嘴唇 → 体型 → 辨识特征。
 *
 * 前两个（脸型、眼睛）是「一眼就能分出不同人」的维度，所以轻度档就拿这两个；
 * 辨识特征放最后 —— 它是锦上添花，但也是最能防止「同一张脸换个发型」的一项。
 */
const LOOK_DIMENSION_ORDER = ["faceShape", "eyes", "nose", "mouth", "build", "mark"] as const;

type LookDimension = (typeof LOOK_DIMENSION_ORDER)[number];

/** 维度中文名（写进提示词）。 */
const LOOK_DIMENSION_LABEL: Record<LookDimension, string> = {
    faceShape: "脸型轮廓",
    eyes: "眼睛",
    nose: "鼻子",
    mouth: "嘴唇",
    build: "体型",
    mark: "辨识特征",
};

/**
 * 素材池。
 *
 * 口径：**全是可画的具体形态，不是形容程度的词**。
 * 「鼻梁高挺」比「鼻子好看」有用，「下颌偏方、咬肌明显」比「轮廓硬朗」有用。
 * 每池 8~12 项，够 8 个角色左右大概率不撞同一项（真撞了还有其它维度兜着）。
 */
const LOOK_POOLS: Record<LookDimension, string[]> = {
    faceShape: [
        "鹅蛋脸，额头与下颌过渡柔和",
        "方脸，下颌角明显、咬肌略宽",
        "长脸，面中偏长、下颌偏窄",
        "圆脸，面颊饱满、下巴短",
        "菱形脸，颧骨突出、额头与下巴偏窄",
        "心形脸，额头宽、下巴尖",
        "国字脸，下颌方正、腮部宽",
        "窄长脸，脸长是脸宽的一点四倍左右",
    ],
    eyes: [
        "内双，眼尾略微上挑",
        "外双，眼型偏圆、黑眼珠露出多",
        "单眼皮，眼裂细长",
        "下垂眼，眼尾低于眼头",
        "眼距偏宽，山根略平",
        "眼窝较深，眉骨突出",
        "卧蚕明显，笑起来眼下有肉感",
        "内双偏窄，眼神偏冷",
    ],
    nose: [
        "鼻梁高而直，鼻头小巧",
        "鼻梁偏低，鼻头圆润有肉",
        "鹰钩鼻，鼻尖略向下勾",
        "鼻头肉感，鼻翼偏宽",
        "鼻梁中段有一处骨节",
        "鼻小柱后缩，侧面偏平",
        "鼻子短，鼻孔略外露",
        "鼻梁直但鼻头大",
    ],
    mouth: [
        "薄唇，唇线清晰",
        "厚唇，唇峰明显",
        "上唇薄、下唇厚",
        "嘴角天然下垂，不笑时显严肃",
        "唇形偏小，唇珠明显",
        "嘴角上扬，天生带笑意",
        "唇色偏淡，唇纹浅",
        "人中偏短，上唇微翘",
    ],
    build: [
        "身材清瘦，肩窄",
        "身形高挑，四肢偏长",
        "肩宽背厚，体格结实",
        "中等身高，体态略含胸",
        "骨架小，显得比实际年龄小",
        "偏壮，脖子略粗",
        "瘦但肩平，站姿挺直",
        "微胖，腰腹有肉",
    ],
    mark: [
        "左眉有一道断眉",
        "左侧鼻梁中段有一颗小痣",
        "眼下有淡淡的泪沟",
        "右颊有一道浅疤",
        "笑起来有单侧酒窝",
        "发际线偏高，额头显大",
        "颧骨下方略微凹陷",
        "下巴中间有一道浅沟",
        "耳朵略外扩（招风耳）",
        "眼角有细纹，显疲态",
        "唇边有一颗小痣",
        "眉尾稀疏，眉形不完整",
    ],
};

/**
 * 「描述里已经写了这个维度」的检测词。
 *
 * 命中任意一个 → 该维度**跳过**（用户写的描述优先，锚点不覆盖）。
 * 宁可跳过也不要冲突：描述写「圆脸」、锚点又给「方脸」，模型会两边各取一半，出来更怪。
 */
const LOOK_DIMENSION_HINTS: Record<LookDimension, string[]> = {
    faceShape: ["脸型", "鹅蛋脸", "方脸", "圆脸", "长脸", "瓜子脸", "国字脸", "菱形脸", "心形脸", "下颌", "颧骨", "脸廓"],
    eyes: ["眼型", "单眼皮", "双眼皮", "内双", "外双", "杏眼", "丹凤眼", "桃花眼", "下垂眼", "眼距", "眼窝"],
    nose: ["鼻梁", "鼻头", "鼻翼", "鹰钩鼻", "山根"],
    mouth: ["唇", "嘴", "人中"],
    build: ["身材", "体型", "身高", "魁梧", "瘦削", "清瘦", "高挑", "壮实", "纤细", "匀称", "微胖", "骨架"],
    mark: ["痣", "疤", "雀斑", "断眉", "酒窝", "发际线", "眼袋", "喉结", "皱纹", "招风耳"],
};

/**
 * 笼统审美形容词 —— 只有 `strong` 档会从描述里清掉。
 *
 * 这些词不是「错」，而是**没有信息量且高度趋同**：生图模型看到「五官精致」就画同一张脸，
 * 写十个角色就有十个一样的人。清掉之后剩下来的（身份、年龄、穿着）才是真正该保留的设定。
 */
const VAGUE_BEAUTY_WORDS = [
    "五官精致",
    "五官深邃",
    "五官立体",
    "五官端正",
    "长相俊美",
    "长相清俊",
    "长相清秀",
    "容貌俊美",
    "容貌出众",
    "容貌姣好",
    "面容姣好",
    "眉清目秀",
    "剑眉星目",
    "肤白貌美",
    "皮肤白皙",
    "肌肤白皙",
    "肤如凝脂",
    "颜值极高",
    "颜值出众",
    "气质出众",
    "气质不凡",
    "英俊潇洒",
    "风度翩翩",
    "貌美如花",
    "倾国倾城",
    "惊为天人",
];

/** 角色块末尾固定的负面清单（`services/api/image.ts` 没有独立 negative 字段，只能写进正文）。 */
export const SCRIPT_CHARACTER_LOOK_NEGATIVE =
    "禁止：网感网红脸、过度磨皮、韩式半永久眉、统一锥子脸、塑料感皮肤、AI 平均脸。";

/** 档位归一化：脏值 / 空 → 默认档（轻度）。 */
export function normalizeScriptCharacterLookLevel(value: unknown): ScriptCharacterLookLevel {
    const text = String(value ?? "").trim().toLowerCase();
    return (SCRIPT_CHARACTER_LOOK_LEVELS as string[]).includes(text) ? (text as ScriptCharacterLookLevel) : DEFAULT_SCRIPT_CHARACTER_LOOK_LEVEL;
}

/** 工具栏那颗按钮点一下的下一档（关闭 → 轻度 → 标准 → 强制 → 关闭）。 */
export function nextScriptCharacterLookLevel(value: unknown): ScriptCharacterLookLevel {
    const current = normalizeScriptCharacterLookLevel(value);
    const index = SCRIPT_CHARACTER_LOOK_LEVELS.indexOf(current);
    return SCRIPT_CHARACTER_LOOK_LEVELS[(index + 1) % SCRIPT_CHARACTER_LOOK_LEVELS.length];
}

/**
 * FNV-1a 32 位稳定哈希。
 *
 * 不用 `Math.random`：同一个角色每次生图必须抽到同一组锚点，否则视频里会换人。
 * 也不用 `Date.now()` / 自增 id：跨会话、跨设备打开同一份画布要一致。
 */
function stableHash(text: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** 从池子里按 `盐 + 角色名 + 维度` 稳定取一项。 */
function pickFromPool(pool: readonly string[], salt: string, baseName: string, dimension: LookDimension): string {
    if (!pool.length) return "";
    const index = stableHash(`${salt}|${baseName}|${dimension}`) % pool.length;
    return pool[index];
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 清掉描述里的笼统审美词（`strong` 档专用）。
 *
 * 删干净但**不删坏句子**：词后可能跟一个「的」一起删；连续标点归一成一个「，」；
 * 首尾标点（以及删完留下的孤零零的「的」）一起去掉。删到只剩标点或一两个字时，
 * 说明这一格基本全靠形容词撑着 —— 那就**不删**（宁可留着，也不能删出一个空单元格）。
 */
export function stripVagueBeautyWords(description: string): string {
    const text = String(description ?? "");
    if (!text.trim()) return text;
    const pattern = new RegExp(`(?:${VAGUE_BEAUTY_WORDS.map(escapeRegExp).join("|")})的?`, "g");
    const stripped = text
        .replace(pattern, "")
        .replace(/[，,。；;、]{2,}/g, "，")
        .replace(/[（(]\s*[)）]/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s，,。；;、的]+|[\s，,。；;、]+$/g, "")
        .trim();
    if (!stripped) return text;
    // 剩下不到 2 个实义字 = 这一段除了审美词什么都没写，删了只会更糟。
    if (stripped.replace(/[\s，,。；;、的]/g, "").length < 2) return text;
    return stripped;
}

/** 这一段描述里哪些维度已经被写过了。 */
function resolveCoveredDimensions(description: string): Set<LookDimension> {
    const text = String(description ?? "");
    const covered = new Set<LookDimension>();
    if (!text.trim()) return covered;
    for (const dimension of LOOK_DIMENSION_ORDER) {
        if (LOOK_DIMENSION_HINTS[dimension].some((hint) => text.includes(hint))) covered.add(dimension);
    }
    return covered;
}

/**
 * 生成某个角色的「外貌锚点」段；不该生成时返回空串。
 *
 * @param title       资产标题（可以带 `@造型`，内部只取基础名做哈希）。
 * @param description 分镜表里那一格的原文（用来判断哪些维度已经有了、以及 `strong` 档的清理范围）。
 * @param salt        稳定盐（调用方传**脚本节点 id**：同一条链路的所有入口共用一个盐，
 *                    否则「一键直接生图」和「一键批量生成」会给同一角色抽出两张脸）。
 * @param level       档位，`off` → 空串。
 */
export function buildScriptCharacterLookBlock(input: {
    title: string;
    description?: string;
    salt?: string;
    level?: unknown;
}): string {
    const level = normalizeScriptCharacterLookLevel(input.level);
    if (level === "off") return "";
    const variant = splitScriptAssetVariant(input.title);
    const baseName = String(variant.base || input.title || "").trim();
    if (!baseName) return "";
    const salt = String(input.salt ?? "");
    const description = String(input.description ?? "");
    const covered = resolveCoveredDimensions(description);
    const wanted = LOOK_DIMENSION_COUNT[level];
    const lines: string[] = [];
    for (const dimension of LOOK_DIMENSION_ORDER) {
        if (lines.length >= wanted) break;
        if (covered.has(dimension)) continue;
        const picked = pickFromPool(LOOK_POOLS[dimension], salt, baseName, dimension);
        if (!picked) continue;
        lines.push(`- ${LOOK_DIMENSION_LABEL[dimension]}：${picked}`);
    }
    if (!lines.length) return "";
    const force = level === "strong";
    return [
        SCRIPT_CHARACTER_LOOK_MARKER,
        force ? "以下为硬性外貌参数，同一角色固定不变（跨镜头、跨集不得改写）：" : "以下为该角色的固定外貌参数，只补上文中没有提到的部分：",
        ...lines,
        force ? "与上文中笼统的外貌形容冲突时，以本节为准；年龄、身份、造型、服装仍以角色描述为准。" : "年龄、身份、造型、服装仍以角色描述为准，本节不得改动这些设定。",
        SCRIPT_CHARACTER_LOOK_NEGATIVE,
    ].join("\n");
}

/** `applyScriptCharacterLook` 的选项。 */
export type ScriptCharacterLookOptions = {
    /** 档位（`undefined` = 轻度）。 */
    lookLevel?: unknown;
    /** 稳定盐，建议传脚本节点 id。 */
    lookSalt?: string;
};

type LookableAsset = { role: unknown; title: string; prompt: string };

/**
 * 给一批资产里的**角色**追加外貌锚点（其它分类原样返回）。
 *
 * 只改 `prompt` 文本，不改 `title` —— 资产锁 / 挂载 / 去重全都按 title 走，
 * 所以这一层对画布结构零影响。
 *
 * 幂等：`prompt` 里已经有 `【外貌锚点】` 就跳过（同一批重算、或用户手动粘过）。
 */
export function applyScriptCharacterLook<T extends LookableAsset>(items: readonly T[], options?: ScriptCharacterLookOptions): T[] {
    if (!items.length) return items.slice();
    const level = normalizeScriptCharacterLookLevel(options?.lookLevel);
    if (level === "off") return items.slice();
    const salt = String(options?.lookSalt ?? "");
    return items.map((item) => {
        if (resolveScriptAssetRole(item.role) !== "character") return item;
        const body = String(item.prompt ?? "");
        if (!body.trim() || body.includes(SCRIPT_CHARACTER_LOOK_MARKER)) return item;
        const description = level === "strong" ? stripVagueBeautyWords(body) : body;
        const block = buildScriptCharacterLookBlock({ title: item.title, description, salt, level });
        if (!block) return item;
        return { ...item, prompt: `${description.trim()}\n\n${block}` };
    });
}
