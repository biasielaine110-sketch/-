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
 * 所以这里在**生图拼装**这一层补一段「能被画出来的参数」：脸型、眼型、眉型、鼻型、嘴型、
 * 发型、体型、一个辨识特征。挂在资产描述之后、词库版式之前（见 `applyScriptAssetDirectDecorations` 的顺序）。
 *
 * ## 四档的区分度（用户 2026-11-24 晚：「这几个不同程度出来的效果需要区分大一些」）
 *
 * 旧做法是「同一批形状，轻度取 2 个、标准取 4 个、强制取 6 个」—— 标准档是轻度档的超集，
 * 用户点按钮只看到「多了两行字」，脸的差别很小。现在**每档同时换两样东西**：
 *   ① 换维度组合（轻度只碰轮廓与眼睛；标准把五官+发型全给；强制再叠体型与辨识特征）；
 *   ② 换素材池（soft 温和措辞 / normal 明确形态 / bold 鲜明骨相）。
 * 于是切一档 = 换一版明显更有个性的脸，而不是在原来那张脸上加注。
 * 同一档位内部仍然完全确定（跨镜头、跨集、重新生图都是同一张脸）。
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

/**
 * 维度全序：脸型 → 眼型 → 眉型 → 鼻型 → 嘴型 → 发型 → 体型 → 辨识特征。
 *
 * 前两个（脸型、眼型）是「一眼就能分出不同人」的维度，轻度档就拿这两个；
 * 中间五项（眼眉鼻嘴发）是用户点名要区分的一组；体型与辨识特征放最后 ——
 * 辨识特征是防「同一张脸换个发型」的最后一道，只在强制档给。
 */
const LOOK_DIMENSION_ORDER = ["faceShape", "eyes", "brow", "nose", "mouth", "hair", "build", "mark"] as const;

type LookDimension = (typeof LOOK_DIMENSION_ORDER)[number];

/** 维度中文名（写进提示词）。 */
const LOOK_DIMENSION_LABEL: Record<LookDimension, string> = {
    faceShape: "脸型轮廓",
    eyes: "眼型",
    brow: "眉型",
    nose: "鼻型",
    mouth: "嘴型",
    hair: "发型",
    build: "体型",
    mark: "辨识特征",
};

/** 素材池的三档措辞强度。 */
type LookPoolTier = "soft" | "normal" | "bold";

/**
 * 档位 → 补哪几个维度（顺序即写入顺序，也是「补满」时的优先顺序）。
 *
 * 轻度 2 项 / 标准 6 项 / 强制 8 项，**不是简单的包含关系**：轻度是「轮廓 + 眼睛」，
 * 标准直接跳到「五官 + 发型」全给（用户 2026-11-24 晚点名：眼型 / 眉型 / 嘴型 / 鼻型 / 发型），
 * 强制再把体型与辨识特征叠上。维度组合不同 → 出来的脸不是同一张「加了几笔」的脸。
 */
const LOOK_LEVEL_DIMENSIONS: Record<Exclude<ScriptCharacterLookLevel, "off">, LookDimension[]> = {
    light: ["faceShape", "eyes"],
    standard: ["faceShape", "eyes", "brow", "nose", "mouth", "hair"],
    strong: ["faceShape", "eyes", "brow", "nose", "mouth", "hair", "build", "mark"],
};

/**
 * 档位 → 素材池。
 *
 * 🔴 这条是「区分度」的第二个开关：三档**不共用同一批形状**。
 * soft 只给倾向（「脸型略方」），normal 给明确形态（「方脸，下颌角明显」），
 * bold 给鲜明骨相（「短宽脸，面宽大于脸长，下颌角接近直角」）。
 */
const LOOK_LEVEL_POOL: Record<Exclude<ScriptCharacterLookLevel, "off">, LookPoolTier> = {
    light: "soft",
    standard: "normal",
    strong: "bold",
};

/**
 * 素材池。
 *
 * 口径：**全是可画的具体形态，不是形容程度的词**。
 * 「鼻梁高挺」比「鼻子好看」有用，「下颌偏方、咬肌明显」比「轮廓硬朗」有用。
 * 每池 6~12 项，够一部剧的角色大概率不撞同一项（真撞了还有其它维度兜着）。
 */
const LOOK_POOLS: Record<LookDimension, { soft?: string[]; normal: string[]; bold?: string[] }> = {
    faceShape: {
        soft: [
            "脸型略偏鹅蛋形，线条柔和",
            "脸型略方，下颌有一点点棱角",
            "脸型偏长，面中稍长",
            "脸型偏圆，面颊略带肉感",
            "脸型略窄，额头偏窄",
            "脸型略偏心形，下巴偏尖",
        ],
        normal: [
            "鹅蛋脸，额头与下颌过渡柔和",
            "方脸，下颌角明显、咬肌略宽",
            "长脸，面中偏长、下颌偏窄",
            "圆脸，面颊饱满、下巴短",
            "菱形脸，颧骨突出、额头与下巴偏窄",
            "心形脸，额头宽、下巴尖",
            "国字脸，下颌方正、腮部宽",
            "窄长脸，脸长是脸宽的一点四倍左右",
        ],
        bold: [
            "长方脸，下颌骨宽厚、腮线硬朗，太阳穴略凹",
            "短宽脸，面宽大于脸长，下颌角接近直角",
            "极窄长脸，面颊凹陷、颧骨平，脸长接近脸宽两倍",
            "菱形骨相，颧骨高且外扩，太阳穴与面颊都往里凹",
            "上宽下窄，额头宽平、下颌急剧收窄成尖下巴",
            "下宽上窄，腮部外扩、额头偏窄，正面呈梯形",
            "圆钝脸，面颊厚、下颌线几乎看不出棱角",
            "方中带圆，下颌方正但面颊有肉、两颊横向偏宽",
        ],
    },
    eyes: {
        soft: [
            "眼睛偏杏眼，眼神平和",
            "眼睛略细长，眼尾微微上扬",
            "眼睛偏圆，黑眼珠露出较多",
            "单眼皮，眼裂不算宽",
            "内双，眼皮上有浅浅一道褶",
            "眼尾略下垂，看人时显温和",
        ],
        normal: [
            "内双，眼尾略微上挑",
            "外双，眼型偏圆、黑眼珠露出多",
            "单眼皮，眼裂细长",
            "下垂眼，眼尾低于眼头",
            "眼距偏宽，山根略平",
            "眼窝较深，眉骨突出",
            "卧蚕明显，笑起来眼下有肉感",
            "内双偏窄，眼神偏冷",
        ],
        bold: [
            "细长眯眼，眼裂极窄，睁眼时几乎看不到双眼皮褶皱",
            "圆睁大眼，黑眼珠偏小、眼白露出多，正圆眼型",
            "三角眼，眼头窄、眼尾下垂，外眼角明显低于内眼角",
            "吊梢眼，眼尾高高上扬，眼裂外端尖细",
            "深眼窝，眉骨高突、上眼睑压在眼珠上，眼神沉",
            "肿眼泡，上眼睑厚，双眼皮被压成一条细缝",
            "眼距极宽，两眼间距超过一只眼的宽度，山根低平",
            "眼距极窄，内眼角几乎连在一起，目光锐利",
        ],
    },
    brow: {
        normal: [
            "粗平眉，眉峰不明显",
            "剑眉，眉尾上扬、眉骨有棱",
            "柳叶眉，眉形细长、眉峰柔和",
            "一字眉，眉头眉尾高度差不多",
            "眉峰靠外，眉尾略散",
            "挑眉，眉尾明显高于眉头",
            "眉间距窄，两眉略往中间压",
            "眉形偏淡，眉尾稀疏",
        ],
        bold: [
            "浓粗眉，眉毛压到眼皮上方，眉骨明显凸起",
            "极细眉，整条眉毛细成一条线、眉尾几乎消失",
            "倒八字眉，眉头高、眉尾往下压，天生愁相",
            "上扬剑眉，眉尾几乎立起，眉骨突出",
            "断眉，左侧眉毛中段缺一道口子",
            "眉间距极宽，两眉之间空出大半只眼的宽度",
            "眉间距极窄，眉头几乎连成一条，眉压眼",
            "野眉，眉形完全没修、眉毛横向外扩",
        ],
    },
    nose: {
        normal: [
            "鼻梁高而直，鼻头小巧",
            "鼻梁偏低，鼻头圆润有肉",
            "鹰钩鼻，鼻尖略向下勾",
            "鼻头肉感，鼻翼偏宽",
            "鼻梁中段有一处骨节",
            "鼻小柱后缩，侧面偏平",
            "鼻子短，鼻孔略外露",
            "鼻梁直但鼻头大",
        ],
        bold: [
            "鹰钩鼻，鼻梁中段凸起、鼻尖明显下勾，侧面折角大",
            "塌鼻，山根几乎贴平、鼻背凹陷，正面看不到鼻梁线",
            "蒜头鼻，鼻头大而圆、鼻翼外扩，鼻头宽过眼距",
            "鼻骨歪斜，鼻梁中段向一侧偏，鼻尖不正",
            "极窄鼻，鼻背细成一条，鼻翼紧贴鼻小柱",
            "高直鼻，鼻根从眉间起、鼻背笔直，鼻长占脸比例偏大",
            "短翘鼻，鼻子短、鼻尖上翘露出鼻孔",
            "多节鼻，鼻背有两处明显骨节，侧面起伏",
        ],
    },
    mouth: {
        normal: [
            "薄唇，唇线清晰",
            "厚唇，唇峰明显",
            "上唇薄、下唇厚",
            "嘴角天然下垂，不笑时显严肃",
            "唇形偏小，唇珠明显",
            "嘴角上扬，天生带笑意",
            "唇色偏淡，唇纹浅",
            "人中偏短，上唇微翘",
        ],
        bold: [
            "薄唇，唇线极锐，嘴宽偏窄，不笑时几乎是一条横线",
            "厚唇外翻，上下唇都厚、唇峰不明显，嘴部体积大",
            "嘴角明显下垂，唇形倒 U，天生苦相",
            "嘴角上扬成弓形，不笑也像在笑，唇珠突出",
            "大嘴，嘴角接近下颌角，笑时能看到后槽牙",
            "小嘴，嘴宽不到鼻翼两倍，唇形聚拢",
            "上唇极薄、下唇极厚，比例悬殊，说话时下唇外翻",
            "唇形不对称，一侧嘴角偏高、一侧偏低",
        ],
    },
    hair: {
        normal: [
            "短发，发质偏硬、自然偏分",
            "及肩直发，发量中等、中分",
            "短发，发量偏少、发际线略高",
            "厚发，短发向后梳、露出额头",
            "及肩卷发，发尾蓬松、侧分",
            "长发，平时扎起，鬓角碎发多",
            "头发细软，容易贴头皮",
            "厚重刘海，齐眉、把额头盖住",
        ],
        bold: [
            "板寸，发质极硬，头型线条完全露出",
            "发量极大、及腰长，发尾厚重蓬松",
            "发质细软，头发紧贴头皮、发缝分明",
            "满头发卷（羊毛卷），小卷密集、头围显大",
            "两侧推短、顶部留长，发际线剃出硬边",
            "自然卷且毛躁，头发整体蓬起、轮廓不规整",
            "背头，发丝全部向后贴，露出完整额头与发际线",
            "中分长直发，头发垂到胸前、发缝笔直",
        ],
    },
    build: {
        normal: [
            "身材清瘦，肩窄",
            "身形高挑，四肢偏长",
            "肩宽背厚，体格结实",
            "中等身高，体态略含胸",
            "骨架小，显得比实际年龄小",
            "偏壮，脖子略粗",
            "瘦但肩平，站姿挺直",
            "微胖，腰腹有肉",
        ],
        bold: [
            "极瘦，锁骨与喉结突出，肩窄到撑不起外套",
            "高大魁梧，肩宽过常人，脖子粗、手掌大",
            "矮壮，身高偏矮但肩背厚实",
            "高瘦，四肢过长、手指细长，站姿略驼",
            "壮硕，胸背厚、上臂粗，脖子短",
            "瘦削，脸颊与手腕都能看出骨形",
            "微胖，腰腹明显、下颌有肉",
            "匀称偏瘦，肩平背直、体型轻",
        ],
    },
    mark: {
        normal: [
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
        bold: [
            "左眉中段一道断眉，缺口很明显",
            "左鼻梁偏上位置有一颗小痣",
            "右颊一道浅疤，从颧骨斜着向下",
            "笑时只有右侧一个酒窝",
            "招风耳，双耳明显外扩",
            "下巴正中一道浅沟（美人沟）",
            "左眼下方一颗泪痣",
            "脖子左侧一块浅色胎记",
        ],
    },
};

/**
 * 「描述里已经写了这个维度」的检测词。
 *
 * 命中任意一个 → 该维度**跳过**（用户写的描述优先，锚点不覆盖）。
 * 宁可跳过也不要冲突：描述写「圆脸」、锚点又给「方脸」，模型会两边各取一半，出来更怪。
 */
const LOOK_DIMENSION_HINTS: Record<LookDimension, string[]> = {
    faceShape: ["脸型", "鹅蛋脸", "方脸", "圆脸", "长脸", "瓜子脸", "国字脸", "菱形脸", "心形脸", "下颌", "颧骨", "脸廓"],
    eyes: ["眼型", "单眼皮", "双眼皮", "内双", "外双", "杏眼", "丹凤眼", "桃花眼", "下垂眼", "眼距", "眼窝", "眼裂"],
    brow: ["眉型", "眉形", "眉毛", "剑眉", "柳叶眉", "一字眉", "挑眉", "断眉", "眉峰", "眉尾", "眉间"],
    nose: ["鼻梁", "鼻头", "鼻翼", "鹰钩鼻", "山根", "鼻背", "鼻尖"],
    mouth: ["唇", "嘴", "人中"],
    hair: ["发型", "短发", "长发", "寸头", "板寸", "马尾", "盘发", "辫", "刘海", "卷发", "直发", "发质", "发量", "发缝", "背头"],
    build: ["身材", "体型", "身高", "魁梧", "瘦削", "清瘦", "高挑", "壮实", "纤细", "匀称", "微胖", "骨架"],
    mark: ["痣", "疤", "雀斑", "断眉", "酒窝", "发际线", "眼袋", "喉结", "皱纹", "招风耳", "胎记", "美人沟"],
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
    "清俊",
    "俊美",
    "俊朗",
    "清秀",
    "俊秀",
    "秀气",
    "白皙",
    "白净",
    "容貌俊美",
    "容貌出众",
    "容貌姣好",
    "面容姣好",
    "眉清目秀",
    "眉目清朗",
    "眉目如画",
    "眉眼精致",
    "明眸皓齿",
    "唇红齿白",
    "面如冠玉",
    "面若桃花",
    "五官秀气",
    "相貌堂堂",
    "仪表堂堂",
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

/** 从池子里按 `盐 + 角色名 + 维度` 稳定取一项（池子由档位决定，同一维度三档是不同批形状）。 */
function pickFromPool(pool: readonly string[], salt: string, baseName: string, dimension: LookDimension): string {
    if (!pool.length) return "";
    const index = mixHash(stableHash(`${salt}|${baseName}|${dimension}`)) % pool.length;
    return pool[index];
}

/**
 * FNV-1a 的**收尾混淆**（murmur3 的 fmix32）。
 *
 * 🔴 少了这一步会撞脸：FNV-1a 对短中文串的**低位**几乎没有熵，直接 `% 8` 取池子下标时，
 * 「叶辰」「周砚」这种同长度不同字的名字会落到同一个下标 —— 实样里两个角色的六项一模一样。
 * 这就是用户最初报的「多个角色长一个样」在锚点层的复现，靠这步打散。
 */
function mixHash(hash: number): number {
    let value = hash >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35) >>> 0;
    value ^= value >>> 16;
    return value >>> 0;
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
        // 清词之后会留下「—— ，」这种连接符 + 落单标点（「清俊（28 岁）—— 五官精致、眉目清朗，穿白大褂」）。
        // 只清中文破折号 / 连接号，不碰 ASCII 连字符（年龄区间、尺码里还要用）。
        .replace(/[—–]{1,}\s*[，,、。；;]?/g, "")
        .replace(/[，,。；;、]{2,}/g, "，")
        .replace(/\s+([，,。；;、])/g, "$1")
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
 * 档位 → 引导句。三档的**语气强度**也不同：
 * 轻度是「补充」、标准是「固定不变的五官与发型」、强制是「硬性参数、冲突以本节为准」。
 * 模型对提示词里语气的反应很明显：同一批形状，用「补充」写出来会画得比「硬性」淡。
 */
const LOOK_LEVEL_INTRO: Record<Exclude<ScriptCharacterLookLevel, "off">, string> = {
    light: "以下为该角色的固定外貌参数（在上文基础上补充，不覆盖已写内容）：",
    standard: "以下为该角色固定不变的五官与发型参数，同一角色跨镜头、跨集、换装都不得改写：",
    strong: "以下为该角色的硬性外貌参数，八项都要画出来；与上文任何笼统的外貌形容冲突时以本节为准，年龄、身份、服装以及疤 / 痣等剧情设定仍以描述为准：",
};

/** 档位 → 收尾句（解释这一档的边界，顺便再强调一次不能简化）。 */
const LOOK_LEVEL_OUTRO: Record<Exclude<ScriptCharacterLookLevel, "off">, string> = {
    light: "年龄、身份、造型、服装仍以角色描述为准，本节不得改动这些设定。",
    standard: "同一角色换装（校服 / 便服 / 礼服）时只改服装与打理方式，眼型、眉型、鼻型、嘴型与发质发量不得变。",
    strong: "以上各项为硬性参数：不得简化、不得替换成笼统的审美说法，也不得与同片其它角色共用同一套形状组合。",
};

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
    const tier = LOOK_LEVEL_POOL[level];
    const primary = LOOK_LEVEL_DIMENSIONS[level];
    /**
     * 强制档**不跳过**已写维度：它是「覆盖上文的审美形容」这一档，跳过就等于什么也没做
     * （用户词库里的模板句几乎每句都带「眉」「唇」，一跳过就只剩两三项）。
     * 唯一例外是「辨识特征」—— 疤 / 痣是剧情设定，覆盖会穿帮。
     */
    const skipCovered = level !== "strong";
    // 轻度 / 标准档被用户原文占掉的维度，用后面的维度补满，保证档位之间的「信息量」稳定。
    const order = [...primary, ...LOOK_DIMENSION_ORDER.filter((dimension) => !primary.includes(dimension))];
    const lines: string[] = [];
    for (const dimension of order) {
        if (lines.length >= primary.length) break;
        if (skipCovered && covered.has(dimension)) continue;
        if (!skipCovered && dimension === "mark" && covered.has("mark")) continue;
        const pools = LOOK_POOLS[dimension];
        const picked = pickFromPool(pools[tier] || pools.normal, salt, baseName, dimension);
        if (!picked) continue;
        lines.push(`- ${LOOK_DIMENSION_LABEL[dimension]}：${picked}`);
    }
    if (!lines.length) return "";
    return [SCRIPT_CHARACTER_LOOK_MARKER, LOOK_LEVEL_INTRO[level], ...lines, LOOK_LEVEL_OUTRO[level], SCRIPT_CHARACTER_LOOK_NEGATIVE].join("\n");
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
