import i18n from "@/i18n";
import { collectScriptAssetBindings, type ScriptAssetRole } from "@/constant/story-script";
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
 */
export function buildScriptAssetBindingPrompt(
    orderedAssetNodeIds: ReadonlyArray<string | undefined | null>,
    allNodes: CanvasNodeData[],
    assetNameOf: (assetNodeId: string) => string | undefined,
    assetRoleOf: (assetNodeId: string) => ScriptAssetRole | null,
) {
    // 先去重：`labelResourceNodes` 是按**数组元素**逐个计数编号的，同一个 id 出现两次会把它算成
    // 「图片1 + 图片2」两张不同的图。真实调用方给的是 `Set`（去重保序），这里再兜一层不亏。
    const seen = new Set<string>();
    const uniqueIds = orderedAssetNodeIds.filter((id): id is string => {
        if (typeof id !== "string" || !id || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    const imageRefs = labelResourceNodeIds(uniqueIds, allNodes).filter((reference) => reference.kind === "image");
    if (!imageRefs.length) return "";
    // 注意：不能用 `reference.title` —— 它是 `node.title || label`，没标题时会回落成「图片1」，
    // 于是拼出毫无信息量的 `图片1@图片1`。这里取**节点自己的标题**，空就是空，让下游整条丢掉。
    const nodeById = new Map(allNodes.map((node) => [node.id, node]));
    const bindings = collectScriptAssetBindings(
        imageRefs.map((reference) => ({
            nodeId: reference.nodeId,
            name: assetNameOf(reference.nodeId),
            title: nodeById.get(reference.nodeId)?.title,
            role: assetRoleOf(reference.nodeId),
        })),
    );
    if (!bindings.length) return "";
    const labelById = new Map(imageRefs.map((reference) => [reference.nodeId, reference.label]));
    const items = bindings
        .map((binding) => `${binding.name}@${labelById.get(binding.nodeId) || ""}`)
        .join(i18n.t("imageReferences.separator"));
    return i18n.t("canvas.scriptNode.assetBindingLine", { items });
}

/**
 * 把「资产绑定」那一行放到提示词**最上面**（原本没有提示词时就只留这一行）；空绑定 = 原样返回。
 *
 * 位置是用户拍板的：生图 / 视频窗口打开时，第一眼要看到「哪张图是谁」——
 * 放在末尾会被几百字的分镜提示词压到看不见，还得滚到底才找得到。
 */
export function withScriptAssetBinding(prompt: string | undefined, bindingLine: string) {
    const base = (prompt || "").trim();
    if (!bindingLine) return base;
    return base ? `${bindingLine}\n\n${base}` : bindingLine;
}
