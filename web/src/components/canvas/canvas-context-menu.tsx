import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, FolderPlus, Info, Plus, Trash2, Unlink2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import {
    IMAGE_QUICK_TOOLS_STORAGE_KEY,
    buildImageToolbarTools,
    defaultImageQuickToolIds,
    readImageQuickToolsConfig,
    type ImageQuickToolId,
    type ImageToolHandlers,
} from "@/components/canvas/canvas-image-toolbar-tools";

type ContextMenuTool = {
    id: string;
    label: string;
    icon: ReactNode;
    active?: boolean;
    danger?: boolean;
    onClick: () => void;
};

export function CanvasNodeContextMenu({
    menu,
    node,
    imageHandlers,
    onClose,
    onDuplicate,
    onDelete,
    onInfo,
    onDownload,
    onSaveAsset,
}: {
    menu: ContextMenuState;
    node?: CanvasNodeData | null;
    imageHandlers?: ImageToolHandlers | null;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onInfo?: (node: CanvasNodeData) => void;
    onDownload?: (node: CanvasNodeData) => void;
    onSaveAsset?: (node: CanvasNodeData) => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [quickImageToolIds, setQuickImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const hasImage = Boolean(node && node.type === CanvasNodeType.Image && node.metadata?.content);

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(IMAGE_QUICK_TOOLS_STORAGE_KEY);
            if (!stored) return;
            const parsed = JSON.parse(stored) as unknown;
            setQuickImageToolIds(readImageQuickToolsConfig(parsed).ids);
        } catch {
            // ignore invalid localStorage payload
        }
    }, [menu]);

    const tools = useMemo<ContextMenuTool[]>(() => {
        if (menu.type !== "node" || !node) {
            return [
                {
                    id: "delete",
                    label: t(menu.type === "connection" ? "canvas.controls.disconnect" : "canvas.controls.delete"),
                    icon: menu.type === "connection" ? <Unlink2 className="size-4" /> : <Trash2 className="size-4" />,
                    danger: true,
                    onClick: onDelete,
                },
            ];
        }

        if (!hasImage || !imageHandlers) {
            return [
                { id: "duplicate", label: t("canvas.controls.duplicate"), icon: <Plus className="size-4" />, onClick: onDuplicate },
                { id: "delete", label: t("canvas.controls.delete"), icon: <Trash2 className="size-4" />, danger: true, onClick: onDelete },
            ];
        }

        const quickSet = new Set(quickImageToolIds);
        const runAndClose = (action: () => void) => {
            action();
            onClose();
        };

        const imageTools = buildImageToolbarTools(node, imageHandlers)
            .filter((tool) => quickSet.has(tool.id as ImageQuickToolId))
            .map((tool) => ({
                id: tool.id,
                label: tool.label,
                icon: tool.icon,
                active: tool.active,
                onClick: () => runAndClose(tool.onClick),
            }));

        const baseTools: ContextMenuTool[] = [
            ...(onInfo && quickSet.has("info")
                ? [
                      {
                          id: "info",
                          label: t("canvas.nodeToolbar.info"),
                          icon: <Info className="size-4" />,
                          onClick: () => runAndClose(() => onInfo(node)),
                      },
                  ]
                : []),
            ...(onDownload && quickSet.has("download")
                ? [
                      {
                          id: "download",
                          label: t("common.download"),
                          icon: <Download className="size-4" />,
                          onClick: () => runAndClose(() => onDownload(node)),
                      },
                  ]
                : []),
            ...(onSaveAsset && quickSet.has("saveAsset")
                ? [
                      {
                          id: "saveAsset",
                          label: t("canvas.nodeToolbar.saveAsset"),
                          icon: <FolderPlus className="size-4" />,
                          onClick: () => runAndClose(() => onSaveAsset(node)),
                      },
                  ]
                : []),
            ...imageTools,
            {
                id: "duplicate",
                label: t("canvas.controls.duplicate"),
                icon: <Plus className="size-4" />,
                onClick: () => runAndClose(onDuplicate),
            },
            {
                id: "delete",
                label: t("canvas.controls.delete"),
                icon: <Trash2 className="size-4" />,
                danger: true,
                onClick: () => runAndClose(onDelete),
            },
        ];

        return baseTools;
    }, [hasImage, imageHandlers, menu.type, node, onClose, onDelete, onDownload, onDuplicate, onInfo, onSaveAsset, quickImageToolIds, t]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-canvas-node-context-menu],.ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            data-canvas-node-context-menu
            className="fixed z-[80] max-h-[min(70vh,520px)] min-w-48 overflow-y-auto rounded-xl border py-1 shadow-2xl thin-scrollbar"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {tools.map((tool) => (
                <MenuButton key={tool.id} icon={tool.icon} label={tool.label} active={tool.active} danger={tool.danger} onClick={tool.onClick} />
            ))}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false, active = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; active?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80 [&_svg]:size-4 ${active ? "opacity-100" : ""}`}
            style={{ color: danger ? "#f87171" : theme.node.text, background: active ? `${theme.node.fill}` : undefined }}
            onClick={onClick}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
