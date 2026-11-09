import { Clapperboard } from "lucide-react";

/**
 * 右下角的「MochiAni」入口 —— 只负责**在画布上新建一个节点**，不再开弹窗。
 *
 * 为什么改成建节点：弹窗带遮罩，打开以后整块画布点不动、拉不动、缩放不了，
 * 用户只能先关掉它才能干别的。做成节点（`CanvasNodeType.Mochiani`）以后，
 * 它就是一个普通的画布窗口：可以拖、可以缩放、可以只留一半在视口里，
 * 同时画布本身照常可操作。内容区在 `canvas-mochiani-node-content.tsx`。
 */
export function CanvasMochianiPanel({ onCreateNode }: { onCreateNode: () => void }) {
    return (
        <button
            type="button"
            onClick={onCreateNode}
            title="在画布上新建一个「MochiAni 生视频」窗口节点（选模型/渠道、写提示词、传参考图，用 MochiAni 灵点生成并落回画布）"
            className="absolute bottom-24 right-6 z-30 flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium shadow-lg transition hover:brightness-110"
            style={{ background: "rgba(24,24,27,0.92)", borderColor: "rgba(255,255,255,0.16)", color: "#fafafa", backdropFilter: "blur(8px)" }}
        >
            <Clapperboard size={15} />
            新建 MochiAni 节点
        </button>
    );
}
