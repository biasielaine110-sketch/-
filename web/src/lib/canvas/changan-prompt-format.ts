/**
 * 「《长安异闻录》格式」入口（用户 2026-11-23）。
 *
 * 把双击放大弹窗里的文本（分镜脚本 / 剧情描述 / 草稿提示词）转成
 * 14 章节的《长安异闻录》视频提示词标准模板。
 *
 * 与「编辑提示词」同属**内置指令**：不走技能库也不走词库（模板是用户点名的固定格式），
 * 模型恒跟偏好里的文本模型；跑在 `h3-optimize-runner` 的后台队列里（`kind: "changan"`），
 * 关掉弹窗也会按 `field` 写回节点。
 */

const CHANGAN_TEMPLATE = `# 《长安异闻录》视频提示词标准模板 /sd25-pe
【01｜PROJECT / MODE】
项目名称：
剧情节点：
时长：
画幅：
时代与时间：
场景：
生成模式：
【02｜DIRECTOR'S INTENT｜导演意图】
这一镜讲什么：
人物当前的目标是什么：
观众应该获得什么信息：
主要情绪变化：
镜头结束时必须落在哪个状态：
【03｜REFERENCE RESPONSIBILITY MAP｜资产责任映射】
{{Mixed 1}}＝场景资产。
负责建筑、空间、照明和环境。
{{Mixed 2}}＝人物A资产。
负责面容、服装、体型与身份。
{{Mixed 3}}＝人物B资产。
负责面容、服装、体型与身份。
{{Mixed 4}}＝道具资产。
负责唯一道具的外观、材质及尺寸。
{{Mixed 5}}＝上一镜尾帧。
负责初始站位、视线方向、动作及光照连续性。
【04｜BLOCKING FIRST｜空间与走位】
场景中固定建筑布局：
人物A初始位置：
人物B初始位置：
人物面对方向：
人物移动路线：
道具初始位置：
摄影交流轴线：
不得改变的空间关系：
【05｜DIALOGUE LEDGER｜对白总账】
L1｜人物A｜音频资产：
“完整对白。”
L2｜人物B｜音频资产：
“完整对白。”
每句执行一次。
无对白的镜头明确填写“无对白”。
【06｜PERFORMANCE ENGINE｜表演引擎】
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
【07｜SHOT TIMELINE｜镜头时间轴】
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
【08｜CAMERA / EDIT LANGUAGE｜摄影与剪辑】
镜头主视觉：
景别变化逻辑：
运动方式：
正反打关系：
180度轴线：
前景、中景、后景关系：
切镜动机：
结尾剪辑落点：
【09｜ACTION CAUSALITY｜动作因果】
动作前的状态：
动作执行顺序：
道具移动过程：
人物身体重心：
动作完成后的状态：
不得省略的物理过程：
【10｜LIGHTING / ART DIRECTION｜光线美术】
时代建筑：
服装与器物：
主光源：
光源方向：
环境明暗：
材质要求：
禁止出现的现代元素：
【11｜SOUND COMPILER｜声音设计】
人物声音绑定：
对白执行规则：
环境音：
动作音：
声音空间位置：
声音桥：
音乐要求：
禁止出现的声音：
【12｜EMOTIONAL CONTINUITY｜情绪连续】
承接上一镜的人物状态：
当前情绪变化：
关键心理转折：
结束时的人物状态：
下一镜应当继承的情绪：
【13｜NEGATIVE / RISK LOCK｜负面约束】
禁止换脸：
禁止人物位置错误：
禁止镜像翻转：
禁止人物倒走：
禁止道具瞬移：
禁止对白重复：
禁止情绪夸张：
禁止现代元素：
其他高风险问题：
【14｜FINAL QA / FINAL TARGET】
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
 */
export const CHANGAN_FORMAT_SYSTEM = `你是视频提示词格式化器。把用户给出的文本内容（剧情描述、分镜脚本、草稿提示词等）完整转换为下方《长安异闻录》视频提示词标准模板的格式。

规则：
1. 严格按模板的 14 个章节（【01】～【14】）与字段顺序输出，章节标题与字段名一字不改、一个不落。
2. 各字段的冒号后填写从用户文本中提取的内容；用户文本未提及的项按剧情合理补全，完全无法确定的填「无」。
3. 模板中的 {{Mixed 1}}～{{Mixed 5}} 资产占位符原样保留，不替换、不删除。
4. 【05】对白总账：从用户文本提取对白填入 L1/L2，没有对白时明确填写“无对白”；每句对白执行一次。
5. 【07】镜头时间轴：按用户文本的镜头数量输出对应小节（G01-S01、G01-S02……），并补上每个镜头的时间码。
6. 只输出转换后的模板正文本身：不要输出任何解释、说明、修改备注、开场白或代码围栏。
7. 第一行必须是模板标题行「# 《长安异闻录》视频提示词标准模板 /sd25-pe」，最后一行是「最终目标」的完整描述。

模板：
${CHANGAN_TEMPLATE}`;

/** 模板标题行锚点 —— 清洗时靠它把模型可能吐的开场白剪掉。 */
const CHANGAN_TITLE_NEEDLE = "《长安异闻录》视频提示词标准模板";

/**
 * 清洗模型输出：剥代码围栏 + 把开头锚定到模板标题行。
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
 */
export function finalizeChanganPrompt(raw: string, _original: string): string {
    let text = String(raw ?? "");
    // 剥代码围栏（```...``` 或 ```lang\n...\n```）
    const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/);
    if (fenced) text = fenced[1];
    text = text.trim();
    if (!text) return text;

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
        return text.trim();
    }

    // 标题没打全（比如漏了书名号）→ 退一步锚到第一个【0 章节行
    const sectionMatch = text.match(/【0\d/);
    if (sectionMatch && sectionMatch.index !== undefined && sectionMatch.index > 0) {
        const lineStart = text.lastIndexOf("\n", sectionMatch.index);
        text = lineStart === -1 ? text.slice(sectionMatch.index) : text.slice(lineStart + 1);
        return text.trim();
    }

    // 两级锚点都没命中 → 原样返回，绝不把输出清空
    return text;
}
