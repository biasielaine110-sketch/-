/**
 * 「人物站位描述」（`blocking_detail`）→ 视频节点提示词里的「【人物站位】」块。
 *
 * 用户 2026-11-23 第 06 条：
 *  - 分镜表加一列「人物站位描述」（`blocking` 仍是最短的「谁在画面哪侧」，供站位图资产匹配）；
 *  - 铺视频链路时把这一格写进视频节点提示词，**位置在镜头内容的上面**；
 *  - 合并镜头铺出来的视频节点，要把这几镜的站位**整合**成一段，不要臃肿、不要重复冲突。
 *
 * 用户 2026-11-24 第 02 条（4 镜合 1 的实样还是拥挤）：句级去重对「换了措辞的同一份空间底子」
 * 无能为力（「木架床横置靠左墙…晨光从右侧窗缝斜射到泛黄墙面」→「木架床靠左墙…晨光从右窗斜照桌面」
 * Dice 只有 ~0.6，判不出重复）。所以合并时把句子分成两类区别对待：
 *  - **人物句**（含角色名 / 人称代词）：走位一镜一个样，照旧只做普通去重，**绝不**激进合并；
 *  - **环境句**（空间底子 / 家具 / 光线 / 机位）：相邻几镜是同一个房间，后面几镜只是换了措辞重写
 *    同一份底子 → 与「已保留的全部环境句」做二元组覆盖率判定，覆盖率过高的整句丢弃；
 *    真正的新东西（新道具、新机位、换场景）覆盖率低，自然留下来。
 *
 * 🔴 为什么合并要在前端确定性地做（而不是让模型再写一遍）：合并只是「同一场戏的站位底子
 * 各镜重复 + 个别人挪了位置」，句级去重就能收敛；再调一次模型既花钱又可能改坏已经写准的
 * 位置关系（谁在画面左、机位轴线）。这里的合并只做三件事：**去重 + 保留新增走位 + 超长截断**。
 */

/** 「【人物站位】」块标题（与「【资产锁定】」同款，视频窗口里一眼能分开）。 */
export const SCRIPT_BLOCKING_TITLE = "【人物站位】";

/** 合并选项：`characterNames` = 本段各镜出现过的角色名（`scriptRowCharacterNames` 收的，含造型原串）。 */
export type ScriptBlockingMergeOptions = {
    characterNames?: ReadonlyArray<unknown>;
};

/**
 * 合并后的正文上限（字符，不含标题）。
 *
 * 单镜样本约 230 字；多镜合并去重后通常 300–500 字。900 字是「还读得完」的上限，
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

/**
 * 环境句的「底子覆盖率」阈值：候选环境句的二元组有 ≥70% 已经出现在已保留的环境句里，
 * 就当成「换了措辞的同一份空间底子」丢掉（2026-11-24 实样里三镜的开场环境句覆盖率 ~0.8，
 * 而带新道具 / 新机位的句子只有 ~0.15–0.5，中间隔得很开）。
 */
const BLOCKING_ENV_COVER_THRESHOLD = 0.7;

/** 覆盖率判定的最短长度（归一化字符数）：太短的句子二元组太少，误判率高，交给普通去重。 */
const BLOCKING_ENV_COVER_MIN_CHARS = 14;

/** 没给角色名时的兜底人称：出现这些词的句子当人物句，不参与环境句的激进去重。 */
const BLOCKING_PRONOUN_PATTERN = /他们|她们|它们|两人|三人|四人|众人|大家|其他人|所有的人|所有人/;

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

/**
 * 站位合并用的角色名匹配键：名字原串（`叶辰（校服）`）+ 剥掉造型括号的裸名（`叶辰`）都要 ——
 * 站位句里写的是裸名（「叶辰坐在床沿」），只拿原串比对永远命中不了。
 */
function blockingCharacterNameKeys(names: ReadonlyArray<unknown> | undefined): string[] {
    const keys: string[] = [];
    for (const raw of names || []) {
        const name = typeof raw === "string" ? raw.trim() : "";
        if (!name) continue;
        for (const candidate of [name, name.replace(/[（(][^（）()]*[）)]/g, "").trim()]) {
            if (!candidate) continue;
            const normalized = normalizeBlockingSentence(candidate);
            // 剥完括号只剩 1 个字的裸名（「爸（旁白）」→「爸」）误伤率太高，不参与匹配。
            if (normalized.length >= 2 && !keys.includes(normalized)) keys.push(normalized);
        }
    }
    return keys;
}

/** 一句是不是「人物句」：点到角色名（裸名也算）或用了人称代词。 */
function isCharacterSentence(normalized: string, nameKeys: readonly string[]): boolean {
    if (nameKeys.some((key) => normalized.includes(key))) return true;
    return BLOCKING_PRONOUN_PATTERN.test(normalized);
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
 *
 * 2026-11-24 起环境句再加一层「底子覆盖率」去重（见文件头注释）：`characterNames` 给了就按
 * 角色名分句子，没给（探针 / 老调用）只靠人称代词兜底 —— 兜不到的句子按环境句处理，
 * 收紧的只是环境句，人物句口径与老版完全一致。
 */
export function mergeScriptBlockingTexts(
    texts: ReadonlyArray<unknown>,
    options?: ScriptBlockingMergeOptions,
): { text: string; shots: number } {
    // 先剥长相 / 穿着（用户 2026-11-25）：铺视频时的站位只讲位置与走位，长相衣服归资产图。
    const cleaned = texts
        .map(cellText)
        .map((text) => stripScriptBlockingAppearance(text))
        .filter((text) => Boolean(text) && text !== "无" && text !== "无。");
    if (!cleaned.length) return { text: "", shots: 0 };
    if (cleaned.length === 1) return { text: clampBlockingText(cleaned[0]), shots: 1 };

    const nameKeys = blockingCharacterNameKeys(options?.characterNames);
    const kept: string[] = [];
    const keptNormalized: string[] = [];
    // 已保留**环境句**的二元组并集：后面几镜的环境句拿它算覆盖率（人物句不进这个并集，
    // 否则含角色的环境句会把后镜的人物句也判成重复）。
    const envBigramUnion = new Set<string>();
    for (const text of cleaned) {
        for (const raw of text.split(BLOCKING_SENTENCE_SPLIT)) {
            const sentence = raw.trim();
            if (!sentence) continue;
            const normalized = normalizeBlockingSentence(sentence);
            if (!normalized) continue;
            if (isDuplicateSentence(sentence, normalized, keptNormalized)) continue;
            const isCharacter = isCharacterSentence(normalized, nameKeys);
            if (!isCharacter && normalized.length >= BLOCKING_ENV_COVER_MIN_CHARS) {
                const grams = bigrams(normalized);
                let hit = 0;
                grams.forEach((gram) => {
                    if (envBigramUnion.has(gram)) hit += 1;
                });
                // 底子覆盖率过高 = 换了措辞重写同一份空间底子 → 丢弃，不进保留集。
                if (grams.size && hit / grams.size >= BLOCKING_ENV_COVER_THRESHOLD) continue;
            }
            kept.push(sentence);
            keptNormalized.push(normalized);
            if (!isCharacter) for (const gram of bigrams(normalized)) envBigramUnion.add(gram);
        }
    }
    if (!kept.length) return { text: "", shots: cleaned.length };
    return { text: clampBlockingText(`${kept.join("。")}。`), shots: cleaned.length };
}

/**
 * 服饰 / 配饰词 —— 判断「这一句是不是在讲穿搭」。
 *
 * 用户 2026-11-25：人物站位里**不要再写长相和穿着**，因为视频提示词开头已经用
 * 「@图片N 锁定为XX」把角色资产图锁进去了；站位里再描述一遍，模型会两边各信一半
 * （资产图是黑西装、站位写白大褂），生成出来就是打架。
 */
const BLOCKING_CLOTHING_WORDS =
    /白大褂|大褂|白袍|长袍|道袍|袈裟|西装|西服|衬衫|衬衣|T恤|t恤|卫衣|毛衣|针织衫|毛衫|外套|夹克|风衣|大衣|棉袄|羽绒服|马甲|背心|吊带|连衣裙|半身裙|长裙|短裙|裙|长裤|短裤|牛仔裤|工装裤|运动裤|校服|便服|礼服|婚纱|旗袍|汉服|古装|制服|警服|军装|护士服|手术服|工作服|睡衣|浴袍|围裙|斗篷|披风|盔甲|皮衣|皮草|腰带|皮带|领带|领结|围巾|丝巾|披肩|手套|头盔|鸭舌帽|棒球帽|礼帽|帽子|帽|发带|发箍|发簪|发饰|头饰|耳环|耳钉|项链|吊坠|手链|手镯|戒指|手表|腕表|眼镜|墨镜|口罩|背包|书包|挎包|手提包|手袋|高跟鞋|皮鞋|靴|凉鞋|拖鞋|运动鞋|布鞋|衣服|衣物|着装|穿搭|打扮|妆容|浓妆|素颜/;

/** 外貌词 —— 只在「这句没有位置/动作」时才整句丢掉，避免误删「眼睛看向门口」这种走位。 */
const BLOCKING_APPEARANCE_WORDS =
    /头发|发型|长发|短发|寸头|板寸|光头|马尾|辫子|刘海|发际线|鬓角|卷发|直发|染发|银发|白发|花白|脸型|圆脸|方脸|长脸|鹅蛋脸|瓜子脸|国字脸|菱形脸|心形脸|下颌|颧骨|眼型|眼睛|双眼皮|单眼皮|内双|杏眼|丹凤眼|桃花眼|下垂眼|眼距|眼窝|浓眉|剑眉|柳叶眉|一字眉|断眉|眉毛|鼻梁|鼻头|鼻翼|鹰钩鼻|嘴型|薄唇|厚唇|唇形|嘴唇|肤色|皮肤|肤质|白皙|小麦色|古铜色|雀斑|痣|疤痕|酒窝|皱纹|鱼尾纹|身材|体型|身高|高挑|瘦高|矮胖|魁梧|纤细|清瘦|微胖|壮实|俊美|俊朗|清秀|秀气|美貌|漂亮|帅气|五官|长相|容貌|颜值/;

/** 位置 / 动作 / 空间词 —— 有它们就说明这句在讲走位，不能因为夹了个「眼镜」就整句删掉。 */
const BLOCKING_STAGING_WORDS =
    /站在|坐在|靠在|立在|蹲在|躺在|跪在|倚在|趴在|半靠|位于|处在|走|跑|转身|回头|抬头|低头|侧身|侧对|背对|正对|面向|朝向|手中|手里|右手|左手|双手|举|握|攥|扶|推|拉|抱|拎|提|按|撑|搭在|抬|垂|前倾|后仰|并排|一左一右|左前方|右后方|前景|后景|中景|画面左|画面右|画面中|门口|窗边|床头|桌边|墙角|床上|沙发上|门外|门内|走廊|机位|轴线|越肩|反打|景别|看|望|盯|笑|哭|听|说|问|递|接过|伸手/;

/**
 * 带触发词的穿搭短语：`穿深灰西装站在窗边` → 剥掉「穿深灰西装」。
 *
 * 右边界落在标点或位置/动作词上 —— 这样剥掉的是「衣服那一段」，后面「站在窗边」原样留下。
 * 🔴 右边界**不能只写裸「在」**：`穿着旧T恤仰躺在木架床上` 会在「仰躺**在**」处断开，
 * 把「仰躺」这个动作一起吃掉（实样里变成「在木架床上」）。所以姿态动词连单字也列上
 * （躺/坐/站/靠/蹲/跪/趴/倚/立），「在」只认「在门口 / 在窗边 …」这类位置短语。
 * `穿(?!过|越|梭|透|插|行|入)` 是为了不误伤「穿过人群」这种走位动作。
 */
const BLOCKING_CLOTHING_PHRASE =
    /(?:穿着|穿了|身穿|身着|换上|换着|套着|披着|裹着|一身|头戴|戴着|脚踩|脚蹬|穿(?!过|越|梭|透|插|行|入))[^，。；、]{0,26}?(?=[，。；、]|仰躺|平躺|斜躺|半躺|端坐|正坐|站在|坐在|靠在|立在|蹲在|躺在|跪在|倚在|趴在|位于|处在|走|跑|转身|回头|抬头|低头|侧身|侧对|背对|正对|面向|朝向|手里|手中|右手|左手|双手|举|握|攥|扶|推|拉|抱|拎|提|按|撑|搭|抬|垂|看|望|躺|坐|站|靠|蹲|跪|趴|倚|立|在(?:门口|窗边|门框|床边|桌边|墙边|走廊|画面|沙发|床上|床沿|地面|门外|门内|台上|车边)|$)/g;

/**
 * 从「人物站位描述」里剥掉**长相**与**穿着**（用户 2026-11-25）。
 *
 * 为什么要做这一层而不是只改提示词：① 存量分镜表已经生成好了，改提示词不会改历史内容；
 * ② 模型不一定 100% 遵守禁令。铺视频前统一过一遍，才保证「资产锁定 + 站位」不会同一个人两套衣服。
 *
 * 两步，都是为了**不误删走位**：
 * ① 有触发词的穿搭短语定向剥离（只剥衣服那一段，位置动作留下）；
 * ② 余下按分句判定：同时含「外貌/服饰词 + 位置动作词」的保留，只有外貌没有走位的整句丢弃。
 *
 * 洗完为空（整格都在讲长相衣服）→ 返回空串，调用方按「这一镜没写站位」处理。
 */
export function stripScriptBlockingAppearance(text: unknown): string {
    const source = String(text ?? "").trim();
    if (!source) return "";
    // ① 定向剥掉「穿XX / 一身XX / 戴着XX」这类短语。
    const body = source.replace(BLOCKING_CLOTHING_PHRASE, "");
    // ② 按分句丢「纯外观句」，保留分隔符，尽量不改原文版式。
    const tokens = body.split(/([，。；、])/);
    const kept: string[] = [];
    for (let index = 0; index < tokens.length; index += 2) {
        const segment = tokens[index].trim();
        if (!segment) continue;
        const separator = tokens[index + 1] || "";
        const mentionsAppearance = BLOCKING_CLOTHING_WORDS.test(segment) || BLOCKING_APPEARANCE_WORDS.test(segment);
        if (!mentionsAppearance) {
            kept.push(segment + separator);
            continue;
        }
        // 含外观词但同时在讲走位 → 再剥一次短语，剥不动就整句留着（位置信息比去掉一件衣服重要）。
        const trimmed = segment.replace(BLOCKING_CLOTHING_PHRASE, "").trim();
        if (trimmed && trimmed !== segment && !BLOCKING_APPEARANCE_WORDS.test(trimmed)) {
            kept.push(trimmed + separator);
            continue;
        }
        if (BLOCKING_STAGING_WORDS.test(segment)) kept.push(segment + separator);
    }
    const merged = kept
        .join("")
        .replace(/^[，。；、\s]+/, "")
        .replace(/[，、]\s*[，、]/g, "，")
        .replace(/([，、])\s*([。；])/g, "$2")
        .replace(/[，、]$/, "")
        .trim();
    return merged === "。" ? "" : merged;
}

/**
 * 视频节点提示词里的「【人物站位】」块。
 *
 * 空内容（这一镜没写 / 只有「无」）→ 空串，调用方原样返回提示词，老表铺出来的结果逐字不变。
 * 合并多镜时多一行括号说明「后出现的位置优先」—— 这是给视频模型读的冲突消解规则，
 * 也是「整合而不是拼接」的外显标记。
 */
export function buildScriptBlockingPrompt(blockingTexts: ReadonlyArray<unknown>, options?: ScriptBlockingMergeOptions): string {
    const { text, shots } = mergeScriptBlockingTexts(blockingTexts, options);
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
