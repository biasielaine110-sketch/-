/**
 * 「《长安异闻录》格式」入口（用户 2026-11-23）。
 *
 * 把双击放大弹窗里的文本（分镜脚本 / 剧情描述 / 草稿提示词）转成
 * 13 章节的《长安异闻录》视频提示词标准模板。
 *
 * 与「编辑提示词」同属**内置指令**：不走技能库也不走词库（模板是用户点名的固定格式），
 * 模型恒跟偏好里的文本模型；跑在 `h3-optimize-runner` 的后台队列里（`kind: "changan"`），
 * 关掉弹窗也会按 `field` 写回节点。
 *
 * 用户 2026-11-23 晚间补充（第 02 条）：视频节点提示词开头的**「【资产锁定】」块**
 * （`@图片N锁定为…` / `@图片N：…` 那几行）**不参与格式转换** —— 发送前摘出来、
 * 转完原样接回最前面（`splitChanganAssetLockBlock` + `finalizeChanganPrompt`）。
 */

const CHANGAN_TEMPLATE = `# 《长安异闻录》视频提示词标准模板 /sd25-pe
【01｜PROJECT / MODE】
剧情节点：
时长：
时代与时间：
场景：
生成模式：
【02｜DIRECTOR'S INTENT｜导演意图】
这一镜讲什么：
人物当前的目标是什么：
观众应该获得什么信息：
主要情绪变化：
镜头结束时必须落在哪个状态：
【03｜BLOCKING FIRST｜空间与走位】
场景中固定建筑布局：
人物A初始位置：
人物B初始位置：
人物面对方向：
人物移动路线：
道具初始位置：
摄影交流轴线：
不得改变的空间关系：
【04｜DIALOGUE LEDGER｜对白总账】
L1｜人物A｜音频资产：
“完整对白。”
L2｜人物B｜音频资产：
“完整对白。”
每句执行一次。
无对白的镜头明确填写“无对白”。
【05｜PERFORMANCE ENGINE｜表演引擎】
人物A：
目标：
阻碍：
策略：
情绪起点：
微表情：
身体动作：
情绪落点：
人物B：
目标：
阻碍：
策略：
情绪起点：
微表情：
身体动作：
情绪落点：
【06｜SHOT TIMELINE｜镜头时间轴】
G01-S01｜00:00–00
景别：
焦段：
机位：
摄影运动：
画面内容：
人物动作：
对白编号：
情绪变化：
与下一镜衔接方式：
G01-S02｜00–00
景别：
焦段：
机位：
摄影运动：
画面内容：
人物动作：
对白编号：
情绪变化：
与下一镜衔接方式：
【07｜CAMERA / EDIT LANGUAGE｜摄影与剪辑】
镜头主视觉：
景别变化逻辑：
运动方式：
正反打关系：
180度轴线：
前景、中景、后景关系：
切镜动机：
结尾剪辑落点：
【08｜ACTION CAUSALITY｜动作因果】
动作前的状态：
动作执行顺序：
道具移动过程：
人物身体重心：
动作完成后的状态：
不得省略的物理过程：
【09｜LIGHTING / ART DIRECTION｜光线美术】
时代建筑：
服装与器物：
主光源：
光源方向：
环境明暗：
材质要求：
禁止出现的现代元素：
【10｜SOUND COMPILER｜声音设计】
人物声音绑定：
对白执行规则：
环境音：
动作音：
声音空间位置：
声音桥：
音乐要求：
禁止出现的声音：
【11｜EMOTIONAL CONTINUITY｜情绪连续】
承接上一镜的人物状态：
当前情绪变化：
关键心理转折：
结束时的人物状态：
下一镜应当继承的情绪：
【12｜NEGATIVE / RISK LOCK｜负面约束】
禁止换脸：
禁止人物位置错误：
禁止镜像翻转：
禁止人物倒走：
禁止道具瞬移：
禁止对白重复：
禁止情绪夸张：
禁止现代元素：
其他高风险问题：
【13｜FINAL QA / FINAL TARGET】
检查人物身份：
检查空间关系：
检查动作连续：
检查对白与声音：
检查摄影轴线：
检查真实光线：
检查情绪递进：
检查最终剪辑落点：
最终目标：
用一段话完整描述生成视频从开场到结束的结果。`;

/**
 * 发给模型的 system 指令 = 转换规则 + 完整模板正文。
 *
 * 「只输出模板正文」写得这么死是有原因的：这条链路的输出要直接回填节点输入框，
 * 模型多一句「好的，以下是转换结果：」就会污染提示词。
 *
 * 第 4 条是兜底：正常链路里「【资产锁定】」块在发送前就被摘掉了（见
 * `splitChanganAssetLockBlock`），模型根本看不到；万一哪条入口忘了摘，
 * 这条规则保证模型至少不会把它转掉、删掉。
 */
export const CHANGAN_FORMAT_SYSTEM = `你是视频提示词格式化器。把用户给出的文本内容（剧情描述、分镜脚本、草稿提示词等）完整转换为下方《长安异闻录》视频提示词标准模板的格式。

规则：
1. 严格按模板的 13 个章节（【01】～【13】）与字段顺序输出，章节标题与字段名一字不改、一个不落。
2. 各字段的冒号后填写从用户文本中提取的内容；用户文本未提及的项按剧情合理补全，完全无法确定的填「无」。
3. 用户文本若以「【资产锁定】」块开头（各行以 @图片N / @参考音频N 开头的锁定行），该块**原样保留**在输出最前面，一字不改、一行不删、不转成模板字段；格式转换只针对它之外的正文内容。
4. 【04】对白总账：从用户文本提取对白填入 L1/L2，没有对白时明确填写“无对白”；每句对白执行一次。
5. 【06】镜头时间轴：按用户文本的镜头数量输出对应小节（G01-S01、G01-S02……），并补上每个镜头的时间码。
6. 只输出转换后的模板正文本身：不要输出任何解释、说明、修改备注、开场白或代码围栏。
7. 正文第一行必须是模板标题行「# 《长安异闻录》视频提示词标准模板 /sd25-pe」（【资产锁定】块若保留则在其之前），最后一行是「最终目标」的完整描述。

模板：
${CHANGAN_TEMPLATE}`;

/** 模板标题行锚点 —— 清洗时靠它把模型可能吐的开场白剪掉。 */
const CHANGAN_TITLE_NEEDLE = "《长安异闻录》视频提示词标准模板";

/** 「【资产锁定】」块的标题行（2026-11-23 晚间起统一成这个写法）。 */
export const ASSET_LOCK_TITLE = "【资产锁定】";
/** 兼容旧节点：第四套（导演）早先把标题写成 `- **资产锁定：**`。 */
const LEGACY_ASSET_LOCK_TITLE = "- **资产锁定：**";

/**
 * 一条锁定条目行：`@图片N` / `@参考音频 N` 开头（ chip 标签原文，带不带空格都认）。
 *
 * 🔴 显式块内的条目**只认这个开头**、不要求行里有「锁定」—— 第四套（导演）的道具行
 * 是「@图片5：奥迪轿车参考。」，压根没有「锁定」二字，按「锁定」筛会把道具漏进 rest
 * 让模型把它转成模板字段。
 */
const ASSET_LOCK_ENTRY = /^\s*@(图片\s*\d|参考音频\s*\d)/;

export type ChanganAssetLockSplit = {
    /** 「【资产锁定】」块原文（含标题行）；没有锁定块时为空串 */
    lock: string;
    /** 锁定块之外的正文（已 trim）；整段只有锁定块时为空串 */
    rest: string;
};

/**
 * 把文本拆成「【资产锁定】」块与其余正文（用户 2026-11-23 晚间第 02 条）。
 *
 * 「长安异闻录格式」按钮**只转换锁定块之外的正文**：锁定块发送前摘出来、
 * 转完原样接回最前面。这样模型既不会把 `@图片N锁定为…` 那几行转成模板字段，
 * 也不会把引用 chip 的标签（`@图片N` 逐字对应缩略图 chip）改写坏。
 *
 * 识别口径：
 *  1. 显式标题：首行是「【资产锁定】」（或旧写法 `- **资产锁定：**`），其后**连续**的
 *     `@xxx…锁定…` 行都算块内容；遇到空行或第一个非 `@…锁定` 行即止。
 *  2. 隐式兜底：没有标题行、但**开头**就是连续的 `@…锁定…` 行（加了标题之前的旧视频节点）
 *     —— 同样整块摘出，免得旧节点的锁定行被转掉。
 *  3. 其余情况（正文里零散出现的 @ 引用、没有锁定语义）一律不动，整段算 rest。
 */
export function splitChanganAssetLockBlock(text: string): ChanganAssetLockSplit {
    const source = String(text ?? "");
    const lines = source.split("\n");

    const isTitleLine = (line: string) => {
        const trimmed = line.trim();
        return trimmed === ASSET_LOCK_TITLE || trimmed === LEGACY_ASSET_LOCK_TITLE || trimmed === "资产锁定：" || trimmed === "**资产锁定：**";
    };

    let headerIndex = -1;
    let implicit = false;
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (!trimmed) {
            // 标题之前的空行无所谓；没找到标题就继续找
            continue;
        }
        if (isTitleLine(lines[index])) {
            headerIndex = index;
            break;
        }
        if (ASSET_LOCK_ENTRY.test(lines[index]) && lines[index].includes("锁定")) {
            // 开头直接是锁定行（加了标题之前的旧视频节点没有标题行）——
            // 隐式兜底要求行里带「锁定」，免得正文第一行恰好是 @图片N 的普通引用被误摘。
            headerIndex = index;
            implicit = true;
            break;
        }
        // 第一个既不是标题也不是锁定行的非空行 → 后面不用再找
        break;
    }
    if (headerIndex === -1) return { lock: "", rest: source.trim() };

    // 从标题（或首个锁定行）往下收连续的锁定条目行；标题与条目之间允许空行
    let end = headerIndex;
    for (let index = headerIndex + (implicit ? 0 : 1); index < lines.length; index += 1) {
        const line = lines[index];
        if (ASSET_LOCK_ENTRY.test(line)) {
            end = index;
            continue;
        }
        if (!line.trim() && index < lines.length - 1) {
            // 空行先记着：后面紧跟锁定行则吞掉，否则到块尾为止
            continue;
        }
        break;
    }
    const lock = lines.slice(headerIndex, end + 1).join("\n").trim();
    const rest = lines.slice(end + 1).join("\n").trim();
    return { lock, rest };
}

/**
 * 清洗模型输出：剥代码围栏 + 把开头锚定到模板标题行 + **接回「【资产锁定】」块**。
 *
 * 与 `finalizeEditedPrompt` 的关键区别：**不做「只留原文没有的行」查重** ——
 * 这条是格式转换，输出的模板标题行、章节标题几乎都不在原文里，照那套清洗
 * 会把模板骨架删掉。这里的口径只有三条：
 *  1. 剥 ``` 围栏；
 *  2. 找到模板标题行就从那里截起（模型爱先客套一句「好的，以下是转换结果：」）；
 *  3. 标题行没找到时退而求其次锚到第一个【章节行】，再不行就原样返回。
 *
 * 尾部不做激进裁剪：模板末行是「最终目标」的一段话，没有可靠的机器边界，
 * 靠 system 指令约束（模型多吐尾巴比误删正文好补救）。
 *
 * 接回锁定块：从 `original`（发送前的完整原文）里摘出「【资产锁定】」块，
 * 原样拼在转换结果最前面 —— 单节点弹窗与多选批量两条入口都走这里，
 * 所以两条入口都必须把**完整原文**作为第二个参数传进来。
 */
export function finalizeChanganPrompt(raw: string, original: string): string {
    const { lock } = splitChanganAssetLockBlock(original);
    let text = String(raw ?? "");
    // 剥代码围栏（```...``` 或 ```lang\n...\n```）
    const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/);
    if (fenced) text = fenced[1];
    text = text.trim();
    if (!text) return lock;

    // 锚到模板标题行（从该行行首截起，丢掉前面的开场白）。
    // 注意：标题行可能就是第一行（比如刚剥完围栏），此时 lastIndexOf("\n") 是 -1，
    // 绝不能从 needle 处截 —— 那会把「# 」前缀削掉。
    const titleIndex = text.indexOf(CHANGAN_TITLE_NEEDLE);
    if (titleIndex > 0) {
        const lineStart = text.lastIndexOf("\n", titleIndex);
        const line = lineStart === -1 ? text : text.slice(lineStart + 1);
        // 标题与行首之间只允许出现 markdown 标题前缀（#～######）或空白；
        // 同行还带了别的客套话才从 needle 处截起。
        const prefix = line.slice(0, line.indexOf(CHANGAN_TITLE_NEEDLE));
        text = /^#{0,6}\s*$/.test(prefix.trim()) || prefix.trim() === "" ? line : line.slice(line.indexOf(CHANGAN_TITLE_NEEDLE));
        return lock ? `${lock}\n\n${text.trim()}` : text.trim();
    }

    // 标题没打全（比如漏了书名号）→ 退一步锚到第一个【0 章节行
    const sectionMatch = text.match(/【0\d/);
    if (sectionMatch && sectionMatch.index !== undefined && sectionMatch.index > 0) {
        const lineStart = text.lastIndexOf("\n", sectionMatch.index);
        text = lineStart === -1 ? text.slice(sectionMatch.index) : text.slice(lineStart + 1);
        return lock ? `${lock}\n\n${text.trim()}` : text.trim();
    }

    // 两级锚点都没命中 → 原样返回，绝不把输出清空
    return lock ? `${lock}\n\n${text}` : text;
}
