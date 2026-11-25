import i18n from "@/i18n";
import { collectScriptAssetBindings, formatScriptAssetDisplayName, splitScriptAssetVariant, type ScriptAssetRole } from "@/constant/story-script";
import { labelResourceNodeIds } from "@/lib/canvas/canvas-resource-references";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 分镜表「一键铺链」的资产绑定文案：把某一个画布节点（图片节点 / 视频节点）**连到的图片资产**
 * 拼成一行提示词，写进该节点的提示词里 —— 形如：
 *
 *     资产绑定：张三@图片1、客厅@图片2
 *
 * 解决两件事（用户诉求「链接的图片资产要在图片和视频的文本输入框里锁定，即张三锁定@图片1」）：
 * 1. **写明每张参考图是什么资产**：光有 `图片1 / 图片2` 看不出哪张是张三；
 * 2. **写成真正的引用**：`图片1` 是引用 chip 的标签，提示词输入框（`CanvasPromptChipInput`）
 *    的 `parseTokens` 按标签**子串**匹配再换成缩略图 chip —— 标签必须逐字一致，否则这段文字
 *    只会退化成纯文本。`@` 本身只是为了读起来像引用，匹配并不依赖它。
 *
 * `orderedAssetNodeIds` 必须是**写连线的顺序**（也就是提示词输入框里 `getMentionResourceNodes`
 * 遍历 connections 的顺序；`Set` 保序正好可以直接用），否则编号错位、chip 会对错图。
 * 编号由 `labelResourceNodeIds` 复用渲染层的同一个计数器算出来，保证与输入框一致。
 *
 * 名字取不到（表里没有资产名、资产图也没有标题）的整条丢掉，不写 `图片1=` 这种空绑定。
 *
 * 2026-11-15 起**音频也进这一行**（用户：「铺视频节点的时候也 @具体声音文件并描述为 张曼的音色参考」）：
 * 音频条目写成 `张曼的音色参考@参考音频 1` —— 标签同样取 `labelResourceNodeIds` 的
 * `参考音频 N` 原文（chip 才认得出），前面挂一句「谁的音色参考」，让模型知道这段音轨该给谁配音。
 */
export function buildScriptAssetBindingPrompt(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
) {
    const items = collectScriptAssetPromptItems(orderedAssetNodeIds, allNodes, assetNameOf, assetRoleOf);
    if (!items.length) return "";
    const joined = items
        .map((item) => {
            const labels = item.labels.map((label, index) => (index ? `@${label}` : label)).join(i18n.t("imageReferences.separator"));
            return `${scriptAssetBindingName(item)}@${labels}`;
        })
        .join(i18n.t("imageReferences.separator"));
    return i18n.t("canvas.scriptNode.assetBindingLine", { items: joined });
}

/**
 * 第一套（内置）铺**视频**链路用的「图在前、锁名在后」绑定行（用户 2026-11-22，当日两次迭代）：
 *
 *     @图片1锁定为张园长人物参考，锁定角色面容、发型、服装、体型与温和神态。
 *     @图片2锁定为幼儿园一楼走廊场景参考，锁定场景布局，空间，光影氛围。
 *
 * 与老的单行 `资产绑定：张园长@图片1、…` 的差别：
 *  - **图片 chip 在前**：`@图片N` 在输入框里渲染成缩略图，用户要「具体的资产图片放在资产名的前面进行锁定」；
 *  - **每个资产单独一行**（2026-11-22 晚间改：不再连成一段），条目之间用换行分隔；
 *  - **按资产分类写死锁定内容**（与第四套「资产锁定」块同思路）：人物补「人物参考」+ 锁面容发型
 *    服装体型神态；场景补「场景参考」+ 锁布局空间光影；站位图 / 道具沿用各自的写法；音频照旧
 *    「谁的音色参考」。
 *
 * ⚠️ `@图片N` 依旧是引用 chip 的标签原文，逐字一致才会渲染成缩略图 —— 别在这里改写编号格式。
 * ⚠️ 只用于**视频节点**（生图窗口仍用老的单行 `资产绑定`），所有 8 套执行方案统一走这里。
 */
export function buildScriptAssetNameLockPrompt(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
    voiceOf?: ScriptAssetVoiceLookup,
) {
    const items = collectScriptAssetPromptItems(orderedAssetNodeIds, allNodes, assetNameOf, assetRoleOf);
    if (!items.length) return "";
    return items.map((item) => `${item.labels.map((label) => `@${label}`).join("、")}锁定为${scriptAssetNameLockText(item, voiceOf)}`).join("\n");
}

/**
 * 角色音色查表（用户 2026-11-23 第 04 条）：给一个资产名，返回这一镜「角色音色描述」格里的文字。
 * 查不到返回空串 / undefined —— 一律不追加任何文字（老表铺出来的提示词逐字不变）。
 */
export type ScriptAssetVoiceLookup = (name: string) => string | undefined;

/** 把音色描述拼进人物锁定行：`…与温和神态` → `…与温和神态，音色：中年女声，语速偏慢。` */
function withVoiceText(text: string, voice: string | undefined | null) {
    const spoken = String(voice || "")
        .replace(/[。.；;]+$/, "")
        .trim();
    if (!spoken) return text;
    return `${text.replace(/[。.]+$/, "")}，音色：${spoken}。`;
}

/** 一行「@图片N锁定为<什么>」的文案：按资产分类写死锁定内容（用户 2026-11-22 晚间给的两行模版）。 */
function scriptAssetNameLockText(item: ScriptAssetPromptItem, voiceOf?: ScriptAssetVoiceLookup) {
    const name = item.name;
    switch (item.role) {
        case "audio":
            // 音色参考：`@参考音频 1锁定为张曼的音色参考。`（2026-11-15 口径不变）
            return `${scriptAssetBindingName(item)}。`;
        case "character":
            // `张园长人物参考，锁定角色面容、发型、服装、体型与温和神态。`
            // 名字本身已带「人物 / 角色」→ 不再叠一层，否则「李曼人物人物参考」。
            // 2026-11-23 起再接一句角色音色（表里「角色音色描述」那一格，按角色名查）。
            return withVoiceText(
                /(人物|角色)$/.test(name)
                    ? `${name}参考，锁定角色面容、发型、服装、体型与温和神态。`
                    : `${name}人物参考，锁定角色面容、发型、服装、体型与温和神态。`,
                voiceOf?.(name),
            );
        case "scene":
            // `幼儿园一楼走廊场景参考，锁定场景布局，空间，光影氛围。`
            return /场景$/.test(name)
                ? `${name}参考，锁定场景布局，空间，光影氛围。`
                : `${name}场景参考，锁定场景布局，空间，光影氛围。`;
        case "blocking":
            // 站位图沿用老写法，只套进新句式。
            return /站位/.test(name) ? `${name}。锁定人物的站位关系。` : `${name}站位图。锁定人物的站位关系。`;
        default:
            // 道具 / 载具（`奥迪轿车参考。`）与没分类的图（镜头图等）。
            return `${name}参考。`;
    }
}

/**
 * 一条「锁定为<什么>」的待渲染条目（三个渲染器共用同一个收集结果）。
 *
 * `labels` 是这一条名下的**所有** `@图片N` 标签（保序）：同一个资产名挂了多张图时它们会合成
 * 一条（用户 2026-11-24 第 01 条：一格 3 张《五年高考三年模拟》铺出 3 行一字不差的
 * 「@图片N锁定为《五年高考三年模拟》参考」，看着像 3 个资产，其实同一个）——
 * 渲染成 `@图片1、@图片2、@图片3锁定为《五年高考三年模拟》参考。`，一图一 chip 都还在，
 * 但模型能看出这几张是**同一个资产**的参考，而不是三件东西。
 */
type ScriptAssetPromptItem = { name: string; labels: string[]; role: ScriptAssetRole | null; kind: "image" | "audio" };

/**
 * 绑定文案里「资产那一半」怎么写：
 *  - 图片：原样（`张三` → `张三@图片1`）；
 *  - 音频：补成「谁的音色参考」（`张曼` / `张曼的音色` → 都是 `张曼的音色参考`，
 *    已经写了「参考」的不重复叠加）。
 */
function scriptAssetBindingName(item: ScriptAssetPromptItem) {
    if (item.kind !== "audio") return item.name;
    const base = item.name.trim();
    if (/参考$/.test(base)) return base;
    if (/音色$/.test(base)) return `${base}参考`;
    return `${base}的音色参考`;
}

/**
 * 两个渲染器（老的单行「资产绑定」/ 第四套的「资产锁定」块）共用的收集逻辑：
 * 去重保序 → 只留图片与音频 → 名字回落 → 编号按连线顺序。
 *
 * ⚠️ 分类在这一层**按 kind 强制**：音频节点在 `scriptAssetRoles` 里可能没标（`resolveScriptAssetRole`
 * 的缺省是「角色」），照抄会把音轨写成「张曼人物参考，锁定面容、发型、服装、体型」。所以音频一律
 * 按 `audio` 处理，不看上游分类。
 */
function collectScriptAssetPromptItems(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
): ScriptAssetPromptItem[] {
    // 先去重：`labelResourceNodes` 是按**数组元素**逐个计数编号的，同一个 id 出现两次会把它算成
    // 「图片1 + 图片2」两张不同的图。真实调用方给的是 `Set`（去重保序），这里再兜一层不亏。
    const seen = new Set<string>();
    const uniqueIds = orderedAssetNodeIds.filter((id): id is string => {
        if (typeof id !== "string" || !id || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    const refs = labelResourceNodeIds(uniqueIds, allNodes).filter((reference) => reference.kind === "image" || reference.kind === "audio");
    if (!refs.length) return [];
    // 注意：不能用 `reference.title` —— 它是 `node.title || label`，没标题时会回落成「图片1」，
    // 于是拼出毫无信息量的 `图片1@图片1`。这里取**节点自己的标题**，空就是空，让下游整条丢掉。
    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const bindings = collectScriptAssetBindings(
        refs.map((reference) => ({
            nodeId: reference.nodeId,
            name: assetNameOf(reference.nodeId),
            title: nodeById.get(reference.nodeId)?.title,
            role: reference.kind === "audio" ? ("audio" as ScriptAssetRole) : assetRoleOf(reference.nodeId),
        })),
    );
    const refById = new Map(refs.map((reference) => [reference.nodeId, reference]));
    const items: ScriptAssetPromptItem[] = [];
    const itemByKey = new Map<string, ScriptAssetPromptItem>();
    for (const binding of bindings) {
        const reference = refById.get(binding.nodeId);
        if (!reference?.label) continue;
        // 🔴 名字**只在这一层**归一成显示写法（`小满@园服` / `小满(园服)` → `小满（园服）`）：
        // 三个渲染器（视频锁定行 / 生图绑定行 / 导演锁定块）都从这里取名字，
        // 免得左侧 chip 是 `小满（园服）`、右侧写成 `小满@园服`，模型当成两套衣服。
        const name = formatScriptAssetDisplayName(binding.name);
        const kind = reference.kind === "audio" ? ("audio" as const) : ("image" as const);
        // 同名同分类同媒介的多张图合成一条（见 ScriptAssetPromptItem 的注释）：
        // 「同一资产重复生成 / 一格挂了好几张同资产图」不再铺成 N 行一模一样的锁定句。
        const key = `${kind}|${binding.role ?? ""}|${name}`;
        const existing = itemByKey.get(key);
        if (existing) {
            if (!existing.labels.includes(reference.label)) existing.labels.push(reference.label);
            continue;
        }
        const item: ScriptAssetPromptItem = { name, labels: [reference.label], role: binding.role, kind };
        itemByKey.set(key, item);
        items.push(item);
    }
    return items;
}

/**
 * 第四套（影视分镜导演）铺链路用的**资产锁定块**（用户 2026-10-27 给的模版）：
 *
 * ```
 * - **资产锁定：**
 * @图片1：李曼人物参考，锁定面容、发型、服装、体型。
 * @图片2：林舟人物参考，锁定面容、发型、服装、体型。
 * @图片3：奶茶店门口场景参考，锁定空间结构、陈设与光线。
 * @图片4：角色站位图。锁定人物的站位关系。
 * @图片5：奥迪轿车参考。
 * ```
 *
 * 与老的单行 `资产绑定：李曼@图片1、…` 的差别：编号在前（`@图片1：…`）、一图一行、
 * 每行按**资产分类**写死该锁什么（人物锁面容发型服装体型 / 场景锁空间结构陈设光线 /
 * 站位图锁站位关系 / 其余道具只写「XX参考。」）。
 *
 * ⚠️ `@图片N` 依旧是**引用 chip 的标签原文**，逐字一致才会渲染成缩略图 —— 别在这里改写编号格式。
 * ⚠️ 只在第四套生效（其它三套保持老的单行 `资产绑定`，一个字节不变）。
 */
export function buildScriptAssetLockPrompt(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
    voiceOf?: ScriptAssetVoiceLookup,
) {
    const items = collectScriptAssetPromptItems(orderedAssetNodeIds, allNodes, assetNameOf, assetRoleOf);
    if (!items.length) return "";
    return ["- **资产锁定：**", ...items.map((item) => `@${item.labels.join("、@")}：${scriptAssetLockText(item, voiceOf)}`)].join("\n");
}

/** 一行「锁什么」的文案：按资产分类写死，用户 2026-10-27 拍的五种写法（+ 2026-11-15 的音色）。 */
function scriptAssetLockText(item: ScriptAssetPromptItem, voiceOf?: ScriptAssetVoiceLookup) {
    const name = item.name;
    switch (item.role) {
        case "audio":
            // 音色参考：`@参考音频 1：张曼的音色参考。`（用户 2026-11-15 的原话口径）
            return `${scriptAssetBindingName(item)}。`;
        case "character":
            // 名字本身已经带「人物 / 角色」（「李曼人物」）→ 不再叠一层，否则「李曼人物人物参考」。
            // 2026-11-23 起再接一句角色音色（与 `buildScriptAssetNameLockPrompt` 同口径）。
            return withVoiceText(
                /(人物|角色)$/.test(name) ? `${name}参考，锁定面容、发型、服装、体型。` : `${name}人物参考，锁定面容、发型、服装、体型。`,
                voiceOf?.(name),
            );
        case "scene":
            return /场景$/.test(name) ? `${name}参考，锁定空间结构、陈设与光线。` : `${name}场景参考，锁定空间结构、陈设与光线。`;
        case "blocking":
            return /站位/.test(name) ? "角色站位图。锁定人物的站位关系。" : `${name}站位图。锁定人物的站位关系。`;
        default:
            // 道具 / 载具（`奥迪轿车参考。`）与没分类的图（镜头图等）。
            return `${name}参考。`;
    }
}

/**
 * 把「资产绑定 / 资产锁定」那一块放到提示词**最上面**（原本没有提示词时就只留这一块）；空绑定 = 原样返回。
 *
 * 位置是用户拍板的：生图 / 视频窗口打开时，第一眼要看到「哪张图是谁」——
 * 放在末尾会被几百字的分镜提示词压到看不见，还得滚到底才找得到。
 * 参数可以是单行（老的四套之外的 `资产绑定：…`），也可以是第四套那种多行 `- **资产锁定：**` 块。
 */
export function withScriptAssetBinding(prompt: string | undefined, bindingLine: string) {
    const base = (prompt || "").trim();
    if (!bindingLine) return base;
    return base ? `${bindingLine}\n\n${base}` : bindingLine;
}

/**
 * 视频节点专用的装配（用户 2026-11-23 晚间第 01 条）：铺视频链路时，资产锁定块**最前面
 * 单独一行加标题「【资产锁定】」**：
 *
 * ```
 * 【资产锁定】
 * @图片1锁定为张园长人物参考，锁定角色面容、发型、服装、体型与温和神态。
 * @图片2锁定为幼儿园一楼走廊场景参考，锁定场景布局，空间，光影氛围。
 *
 * （正文提示词……）
 * ```
 *
 * 两个原因让它必须与 `withScriptAssetBinding` 分开：
 *  1. **只用于视频节点** —— 生图窗口的 `资产绑定：…` 单行不加这个标题；
 *  2. 第四套（导演）的锁定块自带旧标题行 `- **资产锁定：**`，这里把它**替换**成
 *     「【资产锁定】」，否则视频窗口会出现两行标题。「长安异闻录格式」按钮靠
 *     「【资产锁定】」这个标题识别不参与转换的块（`splitChanganAssetLockBlock`），
 *     两种写法归一之后识别口径只有一个。
 */
export function withVideoAssetLockBinding(prompt: string | undefined, bindingLine: string) {
    const base = (prompt || "").trim();
    if (!bindingLine) return base;
    const lines = bindingLine.split("\n");
    if (lines[0]?.trim() === "- **资产锁定：**") lines[0] = "【资产锁定】";
    const block = lines[0]?.trim() === "【资产锁定】" ? lines.join("\n") : ["【资产锁定】", ...lines].join("\n");
    return base ? `${block}\n\n${base}` : block;
}

/**
 * 正文内联角色锁定表：`角色名 → 图片N`（用户 2026-11-25 第 01 条）。
 *
 * 诉求原话：「多镜头连续片段」里的内容，具体的角色后面要**再次锁定资产图**，锁的是图片几，
 * 要参考顶部「资产锁定」单元里这个角色锁的图片几 ——
 * 把「男青年（便服） 席地坐在茶几前」写成「男青年（便服）（锁定@图片1 ）席地坐在茶几前」。
 *
 * 为什么顶部已经有锁定块还要在正文里再锁一次：合并段一条提示词动辄几百字，模型写
 * 「男青年席地坐在茶几前」时离顶上的锁定块已经隔了好几镜，「这个男青年是哪张图」得自己往回找。
 * 贴着名字标一次，人物和参考图的对应关系就是局部可见的。
 *
 * 🔴 编号必须与锁定块**同源**：这里直接复用锁定块的收集器 `collectScriptAssetPromptItems`，
 * 所以 `@图片N`、输入框 chip 顺序、锁定块文案三处永远是同一套编号（不要另算一次计数器）。
 *
 * 只收 `role === "character"`：场景（`客厅`）/ 道具（`《五年高考三年模拟》`）名字在正文里
 * 出现得更随意，贴着名字塞锁定号只会把句子撑乱；它们本来就在锁定块里有一行。
 */
export function buildScriptCharacterLockMap(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
): Map<string, string> {
    const items = collectScriptAssetPromptItems(orderedAssetNodeIds, allNodes, assetNameOf, assetRoleOf);
    const locks = new Map<string, string>();
    for (const item of items) {
        if (item.kind !== "image" || item.role !== "character") continue;
        const label = item.labels[0];
        if (!item.name || !label) continue;
        // 同名挂了多张图时正文里只标第一张 —— 与锁定块那一行 `@图片1、@图片2…` 的第一个编号一致。
        if (!locks.has(item.name)) locks.set(item.name, label);
    }
    return locks;
}

/**
 * 把角色名改成「名字 + `（锁定@图片N）`」（用户 2026-11-25 第 01 条，见 `buildScriptCharacterLockMap`）。
 *
 * 匹配规则（都是为了不把提示词改坏）：
 *  - **全名优先**：`男青年（便服）` 先于本名 `男青年` 参与匹配，否则会拼出
 *    `男青年（锁定@图片1）（便服）` 这种把造型和锁定挤在一起的写法；
 *  - **本名兜底**：正文里只写了 `男青年`（站位描述常这样）而资产名是 `男青年（便服）` 时，
 *    按本名补一个 `（锁定@图片1）`；但同一个本名对应**多个造型**（便服 / 校服）时不补 ——
 *    分不清该锁哪套衣服，宁可只标到全名出现的那些地方；
 *  - **名字后面已经是括号 / 冒号就不动**：`妈妈（小声）：…`、`张三：台词` 这类是语气注释与说话人标记，
 *    插进去会变成 `妈妈（锁定@图片3）（小声）`；已经写过 `（锁定@图片N）` 的自然也被这条挡住（不重复注入）；
 *  - **同一行同一个角色只标一次**：一句话里提三次不必标三次；换行重新计数，
 *    这样「镜头内容」和紧跟其后的「人物站位」各标一次，正文和站位都不丢锁定。
 *
 * 空锁定表 / 空提示词 → **原样返回**（一个字节不变），老链路（没连角色资产）不受影响。
 */
export function withScriptCharacterAssetLocks(prompt: string | undefined, locks: ReadonlyMap<string, string>): string {
    const body = prompt || "";
    if (!body || !locks.size) return body;
    // 一个「匹配名」如果对应了两个不同的编号（两个角色同名、或全名正好是别人的本名），
    // 说明这个名字分不清是谁 → 整条丢掉，不猜。
    const labelByName = new Map<string, string | null>();
    const addName = (name: string, label: string) => {
        const existing = labelByName.get(name);
        if (existing === undefined) labelByName.set(name, label);
        else if (existing !== label) labelByName.set(name, null);
    };
    const baseCount = new Map<string, number>();
    const baseOf = new Map<string, string>();
    for (const [name, label] of locks) {
        addName(name, label);
        const variant = splitScriptAssetVariant(name);
        const base = variant.variant ? variant.base : "";
        if (base && base !== name) {
            baseCount.set(base, (baseCount.get(base) || 0) + 1);
            baseOf.set(name, base);
        }
    }
    for (const [name, label] of locks) {
        const base = baseOf.get(name);
        if (base && baseCount.get(base) === 1) addName(base, label);
    }
    // 最长名优先：`苏晚晴` 必须先于 `苏晚` 参与匹配，否则长名会被短名撕成两截。
    const ordered = [...labelByName.entries()]
        .filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === "string")
        .map(([name, label]) => ({ name, label }))
        .sort((a, b) => Array.from(b.name).length - Array.from(a.name).length);
    if (!ordered.length) return body;
    let out = "";
    let index = 0;
    // 当前行已经标过的编号（换行清空）：同一行同一个角色只标一次。
    let markedInLine = new Set<string>();
    while (index < body.length) {
        const char = body.charAt(index);
        if (char === "\n") {
            markedInLine = new Set<string>();
            out += char;
            index += 1;
            continue;
        }
        const hit = ordered.find((candidate) => body.startsWith(candidate.name, index));
        if (!hit) {
            out += char;
            index += 1;
            continue;
        }
        const next = body.charAt(index + hit.name.length);
        const isLabelPosition = next === "（" || next === "(" || next === "：" || next === ":";
        if (isLabelPosition || markedInLine.has(hit.label)) {
            out += hit.name;
            index += hit.name.length;
            continue;
        }
        out += `${hit.name}（锁定@${hit.label}）`;
        markedInLine.add(hit.label);
        index += hit.name.length;
    }
    return out;
}

/** 场景名比对用的归一：抹掉空白与标点（`男主公寓客厅` ≡ `男主公寓·客厅`），只比字面。 */
const SCENE_TEXT_NOISE = /[\s，,。．.；;：:、！!？?（）()［］[\]【】《》〈〉“”"'‘’\-—－·]/g;

function normalizeSceneText(value: string): string {
    return value.replace(SCENE_TEXT_NOISE, "").toLowerCase();
}

/**
 * 站位开头「不像场景短语」的信号（用户 2026-11-25 第 04 条）：
 * 有冒号 = 人物句（`叶辰：画面左`）；有走位动词 = 已经写成动作句（`叶辰站在门口`）。
 * 这类开头**绝不**拿场景名去替换，否则会把人物和位置一起吃掉。
 */
const SCENE_HEAD_UNSAFE =
    /：|:|站在|坐在|靠在|立在|蹲在|躺在|跪在|倚在|趴在|走到|走向|转身|回头|抬头|低头|侧身|背向|面向|手里|手中|双手/;

/** `【人物站位】` 抬头行（站位块可能整块传进来，只处理抬头下面的正文）。 */
const SCENE_HEADER_LINE = /^(\s*【人物站位】[^\n]*\n)/;

/**
 * 正文（人物站位）内联场景锁定表：`场景名 → 图片N`（用户 2026-11-25 第 04 条）。
 *
 * 诉求原话：「人物站位里关于场景名的内容，要按资产锁定里的场景名统一 —— 资产锁定写的是
 * 男主公寓客厅，站位写的是现代公寓客厅，冲突了会让画面跟资产图对不上」，并且站位里也要锁图：
 * `男主公寓客厅（锁定@图片3）`。
 *
 * 与 `buildScriptCharacterLockMap` **同源**：同一个收集器 `collectScriptAssetPromptItems`，
 * 所以编号和顶部「资产锁定」单元逐字一致。
 *
 * 🔴 只收 `role === "scene"`：资产没标分类时 `resolveScriptAssetRole` 会回落成 `character`，
 * 这时候**不动站位**（宁可保持原样，也不猜哪张图是场景）。
 */
export function buildScriptSceneLockMap(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
): Map<string, string> {
    const items = collectScriptAssetPromptItems(orderedAssetNodeIds, allNodes, assetNameOf, assetRoleOf);
    const locks = new Map<string, string>();
    for (const item of items) {
        if (item.kind !== "image" || item.role !== "scene") continue;
        const label = item.labels[0];
        if (!item.name || !label) continue;
        // 同名挂了多张场景图 → 只标第一张，与锁定块那一行的第一个编号一致。
        if (!locks.has(item.name)) locks.set(item.name, label);
    }
    return locks;
}

/**
 * 给站位开头的场景名挑一个场景资产（本段可能连了客厅 + 卧室两间）。
 *
 * 顺序：① 开头**逐字包含**某个场景名 → 就是它（长名优先，`男主公寓客厅` 先于 `公寓`）；
 * ② 否则按「共享字数」最多的那个（`现代公寓客厅` vs `男主公寓客厅` 共享 4 字）；
 * ③ 共享不到 2 个字（或只有一张场景图）→ 用连线顺序里的第一张。
 */
function pickSceneLock(headText: string, sceneLocks: ReadonlyMap<string, string>): { name: string; label: string } | null {
    const entries = [...sceneLocks.entries()].filter(([name, label]) => Boolean(name) && Boolean(label));
    if (!entries.length) return null;
    const normalizedHead = normalizeSceneText(headText);
    const byLength = [...entries].sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);
    for (const [name, label] of byLength) {
        const normalizedName = normalizeSceneText(name);
        if (normalizedName && normalizedHead.includes(normalizedName)) return { name, label };
    }
    let best: { name: string; label: string; score: number } | null = null;
    for (const [name, label] of entries) {
        const normalizedName = normalizeSceneText(name);
        if (!normalizedName) continue;
        let score = 0;
        for (const char of new Set(Array.from(normalizedName))) {
            if (normalizedHead.includes(char)) score += 1;
        }
        if (!best || score > best.score) best = { name, label, score };
    }
    if (best && best.score >= 2) return { name: best.name, label: best.label };
    return { name: entries[0][0], label: entries[0][1] };
}

/**
 * 把站位正文开头的场景名统一成**资产锁定的场景名**，并紧跟一个 `（锁定@图片N）`
 * （用户 2026-11-25 第 04 条，见 `buildScriptSceneLockMap`）。
 *
 * 只改**第一分句**（第一个逗号/句号/分号之前那一段）—— 格式骨架就是
 * `<场景类型>，<日/夜>，<家具与朝向>；<光源>。`，场景名固定在开头；后面的家具、光线、走位一个字不动。
 *
 * 判定与保命规则：
 *  - 开头已经包含资产场景名 → 保留原文（`男主公寓客厅内景` 只补锁，不把「内景」吃掉）；
 *  - 开头是**别的**场景名（`现代公寓客厅`）→ 整段换成资产名 + 锁定标记；
 *  - 开头有冒号 / 走位动词 / 角色名 / 超过 30 字 → 说明这一格没按骨架写（直接是人物句），**不动**；
 *  - 开头已经是 `（锁定@图片N）` → 不重复注入。
 *  - 正文后面再出现同一个旧场景名（`回到现代公寓客厅`）→ 统一成资产名，但不再标锁。
 *
 * 空锁定表 / 空站位的 → **原样返回**（一个字节不变），没连场景资产的链路完全不受影响。
 */
export function withScriptSceneAssetLock(
    text: string | undefined,
    sceneLocks: ReadonlyMap<string, string>,
    characterNames?: ReadonlyArray<string>,
): string {
    const body = text || "";
    if (!body || !sceneLocks.size) return body;
    // 整块传进来时（`【人物站位】\n…`）抬头原样保留，只处理下面的正文。
    const headerMatch = body.match(SCENE_HEADER_LINE);
    const header = headerMatch ? headerMatch[1] : "";
    const content = header ? body.slice(header.length) : body;
    const locked = lockSceneInBlocking(content, sceneLocks, characterNames);
    return header + locked;
}

function lockSceneInBlocking(
    content: string,
    sceneLocks: ReadonlyMap<string, string>,
    characterNames?: ReadonlyArray<string>,
): string {
    // 第一分句：到第一个逗号 / 句号 / 分号 / 换行。
    const headMatch = content.match(/^[^，,。；;\n]+/);
    if (!headMatch) return content;
    const headText = headMatch[0].trim();
    if (!headText || headText.length > 30) return content;
    if (/（锁定@/.test(headText)) return content;
    if (SCENE_HEAD_UNSAFE.test(headText)) return content;
    if (characterNames?.some((name) => Boolean(name) && headText.includes(name))) return content;
    const chosen = pickSceneLock(headText, sceneLocks);
    if (!chosen) return content;
    const { name, label } = chosen;
    // 开头已经写了资产场景名：保留原文里的其它信息（`男主公寓客厅内景`），只在名字后补锁。
    const first = headText.includes(name)
        ? headText.replace(name, `${name}（锁定@${label}）`)
        : `${name}（锁定@${label}）`;
    // 后面再出现旧场景名（换了措辞的那句）→ 统一成资产名，不再重复标锁。
    const rest = content.slice(headMatch[0].length).split(headText).join(name);
    return first + rest;
}
