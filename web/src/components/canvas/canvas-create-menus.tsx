import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GripVertical, ImageIcon, List, Music2, Settings2, Video, X, Grid2x2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import { mergeOrderedIds, reorderIds, sortByOrder } from "@/lib/canvas/menu-order";
import { listNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type ConnectionHandle, type Position } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

export function ConnectionCreateMenu({
    pending,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Merge) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.fromNode")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title={t("canvas.createMenu.text")} description={t("canvas.createMenu.textDescription")} onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title={t("canvas.createMenu.image")} onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title={t("canvas.createMenu.video")} onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title={t("canvas.createMenu.audio")} onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title={t("canvas.createMenu.config")} description={t("canvas.createMenu.configDescription")} onClick={() => onCreate(CanvasNodeType.Config)} />
                <ConnectionCreateOption theme={theme} icon={<Grid2x2 className="size-5" />} title={t("canvas.nodeTypes.merge")} description={t("canvas.mergeNode.hint")} onClick={() => onCreate(CanvasNodeType.Merge)} />
            </div>
        </div>
    );
}

export function ConnectionCreateOption({
    theme,
    icon,
    title,
    description,
    onClick,
    dragHandle,
    suppressClick = false,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    icon: React.ReactNode;
    title: string;
    description?: string;
    onClick?: () => void;
    dragHandle?: ReactNode;
    suppressClick?: boolean;
}) {
    return (
        <div className="flex items-stretch gap-0.5">
            {dragHandle}
            <button
                type="button"
                className="flex h-16 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
                style={{ color: theme.node.text }}
                onClick={(event) => {
                    if (suppressClick) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                    }
                    onClick?.();
                }}
                onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
            >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                    {icon}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                    {description ? (
                        <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                            {description}
                        </span>
                    ) : null}
                </span>
            </button>
        </div>
    );
}

export function NodeCreateMenu({ position, onCreate, onClose }: { position: Position; onCreate: (type: string) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const menuRef = useRef<HTMLDivElement>(null);
    const suppressClickRef = useRef(false);
    const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nodeCreateMenuOrder = useConfigStore((state) => state.config.nodeCreateMenuOrder);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const definitions = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false);
    const defaultOrder = definitions.map((def) => def.type);
    const order = useMemo(() => mergeOrderedIds(nodeCreateMenuOrder || [], defaultOrder), [defaultOrder.join("|"), nodeCreateMenuOrder]);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);

    const orderedDefinitions = useMemo(
        () =>
            sortByOrder(
                definitions.map((def) => ({ id: def.type, def })),
                order,
            ).map((item) => item.def),
        [definitions, order],
    );

    // Close automatically when clicking outside the menu.
    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [onClose]);

    useEffect(
        () => () => {
            if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
        },
        [],
    );

    const armClickSuppress = () => {
        suppressClickRef.current = true;
        if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = setTimeout(() => {
            suppressClickRef.current = false;
            suppressTimerRef.current = null;
        }, 250);
    };

    const clearDrag = () => {
        setDraggingId(null);
        setDragOverId(null);
    };

    const persistOrder = (next: string[]) => {
        updateConfig("nodeCreateMenuOrder", next);
    };

    return (
        <div
            ref={menuRef}
            className="absolute z-[120] max-h-[70vh] w-[300px] overflow-y-auto rounded-[18px] border p-3 shadow-2xl backdrop-blur thin-scrollbar"
            data-canvas-no-zoom
            style={{ left: position.x, top: position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.select")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    <X className="size-4" />
                </button>
            </div>
            <div className="mb-2 px-1 text-[11px] opacity-45">{t("canvas.createMenu.reorderHint")}</div>
            <div className="grid gap-1">
                {orderedDefinitions.map((def) => (
                    <div
                        key={def.type}
                        className={`rounded-2xl ${draggingId === def.type ? "opacity-45" : ""} ${dragOverId === def.type && draggingId && draggingId !== def.type ? "ring-1 ring-sky-400/70" : ""}`}
                        onDragOver={(event) => {
                            if (!draggingId) return;
                            event.preventDefault();
                            setDragOverId(def.type);
                        }}
                        onDrop={(event) => {
                            if (!draggingId) return;
                            event.preventDefault();
                            event.stopPropagation();
                            armClickSuppress();
                            persistOrder(reorderIds(order, draggingId, def.type));
                            clearDrag();
                        }}
                    >
                        <ConnectionCreateOption
                            theme={theme}
                            icon={def.icon}
                            title={def.title}
                            description={def.description}
                            suppressClick={Boolean(draggingId) || suppressClickRef.current}
                            onClick={() => {
                                if (draggingId || suppressClickRef.current) return;
                                onCreate(def.type);
                            }}
                            dragHandle={
                                <span
                                    draggable
                                    className="inline-flex shrink-0 cursor-grab items-center self-stretch px-2 opacity-45 transition hover:opacity-90 active:cursor-grabbing"
                                    style={{ color: theme.node.muted }}
                                    title={t("canvas.createMenu.dragHandle")}
                                    aria-label={t("canvas.createMenu.dragHandle")}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onDragStart={(event) => {
                                        event.stopPropagation();
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData("text/plain", def.type);
                                        setDraggingId(def.type);
                                    }}
                                    onDragEnd={() => {
                                        armClickSuppress();
                                        clearDrag();
                                    }}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                    }}
                                >
                                    <GripVertical className="size-4" />
                                </span>
                            }
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
