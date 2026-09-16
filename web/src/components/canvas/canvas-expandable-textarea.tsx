import type { CSSProperties, TextareaHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasTextEditDialog } from "./use-canvas-text-edit-dialog";

type CanvasExpandableTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
    value: string;
    onChange: (value: string) => void;
    editTitle?: string;
    enableDoubleClickEdit?: boolean;
};

/** Plain textarea that opens the shared text-edit dialog on double-click. */
export function CanvasExpandableTextarea({
    value,
    onChange,
    editTitle,
    enableDoubleClickEdit = true,
    placeholder,
    className,
    style,
    onDoubleClick,
    onMouseDown,
    ...props
}: CanvasExpandableTextareaProps) {
    const { t } = useTranslation();
    const textEdit = useCanvasTextEditDialog({
        value,
        onChange,
        title: editTitle || t("canvas.nodeToolbar.editTextTitle"),
        placeholder: typeof placeholder === "string" ? placeholder : undefined,
    });

    return (
        <>
            <textarea
                {...props}
                value={value}
                placeholder={placeholder}
                className={className}
                style={style as CSSProperties}
                data-canvas-text-input
                data-canvas-shortcuts-ignore
                onChange={(event) => onChange(event.target.value)}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    onMouseDown?.(event);
                }}
                onDoubleClick={(event) => {
                    if (enableDoubleClickEdit) textEdit.handleDoubleClick(event);
                    else onDoubleClick?.(event);
                }}
            />
            {enableDoubleClickEdit ? textEdit.dialog : null}
        </>
    );
}
