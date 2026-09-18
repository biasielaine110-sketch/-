import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { Unlink2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

type ConnectionPathProps = {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    selected: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
    onDelete: () => void;
};

function connectionGeometryEqual(a: CanvasNodeData, b: CanvasNodeData) {
    return a.id === b.id && a.position.x === b.position.x && a.position.y === b.position.y && a.width === b.width && a.height === b.height;
}

/** Ignore unstable parent lambdas — handlers only close over connection id + setState. */
function connectionPathPropsEqual(prev: ConnectionPathProps, next: ConnectionPathProps) {
    return (
        prev.connection.id === next.connection.id &&
        prev.active === next.active &&
        prev.selected === next.selected &&
        connectionGeometryEqual(prev.from, next.from) &&
        connectionGeometryEqual(prev.to, next.to)
    );
}

export const ConnectionPath = memo(function ConnectionPath({ connection, from, to, active, selected, onSelect, onContextMenu, onDelete }: ConnectionPathProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
    const midpointX = (startX + endX) / 2;
    const midpointY = (startY + endY) / 2;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onDelete();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
            {selected ? (
                <foreignObject x={midpointX - 16} y={midpointY - 16} width="32" height="32" style={{ overflow: "visible", pointerEvents: "all" }}>
                    <button
                        type="button"
                        data-canvas-no-zoom
                        className="grid size-8 place-items-center rounded-full border shadow-lg transition hover:scale-105"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.activeStroke, color: theme.node.activeStroke }}
                        title={t("canvas.controls.disconnect")}
                        aria-label={t("canvas.controls.disconnect")}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete();
                        }}
                    >
                        <Unlink2 className="size-4" />
                    </button>
                </foreignObject>
            ) : null}
        </g>
    );
}, connectionPathPropsEqual);

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
