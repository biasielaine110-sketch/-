import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { CanvasTextEditDialog, type CanvasTextEditDialogH3Optimize, type CanvasTextEditDialogPromptEdit, type CanvasTextEditDialogViolationOptimize } from "./canvas-text-edit-dialog";

type UseCanvasTextEditDialogOptions = {
    value: string;
    onChange?: (content: string) => void;
    title?: string;
    placeholder?: string;
    fontSize?: number;
    readOnly?: boolean;
    onFontSizeChange?: (fontSize: number) => void;
    /** 「h3 提示词优化」配置（图片 / 视频节点提示词弹窗才传）。 */
    h3Optimize?: CanvasTextEditDialogH3Optimize | null;
    /** 「违规优化」配置（同样只在图片 / 视频节点提示词弹窗里传）。 */
    violationOptimize?: CanvasTextEditDialogViolationOptimize | null;
    /** 「编辑提示词」配置（按用户反馈增量改，同样只在图片 / 视频节点提示词弹窗里传）。 */
    promptEdit?: CanvasTextEditDialogPromptEdit | null;
};

/** Shared double-click → popup text editor for any text field. */
export function useCanvasTextEditDialog({
    value,
    onChange,
    title,
    placeholder,
    fontSize,
    readOnly = false,
    onFontSizeChange,
    h3Optimize = null,
    violationOptimize = null,
    promptEdit = null,
}: UseCanvasTextEditDialogOptions): {
    open: boolean;
    openEditor: () => void;
    closeEditor: () => void;
    handleDoubleClick: (event: ReactMouseEvent) => void;
    dialog: ReactNode;
} {
    const [open, setOpen] = useState(false);
    const openEditor = () => setOpen(true);
    const closeEditor = () => setOpen(false);

    const handleDoubleClick = (event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openEditor();
    };

    const dialog = (
        <CanvasTextEditDialog
            open={open}
            value={value}
            title={title}
            placeholder={placeholder}
            fontSize={fontSize}
            readOnly={readOnly}
            onFontSizeChange={onFontSizeChange}
            h3Optimize={h3Optimize}
            violationOptimize={violationOptimize}
            promptEdit={promptEdit}
            onClose={closeEditor}
            onSave={readOnly ? undefined : onChange}
        />
    );

    return { open, openEditor, closeEditor, handleDoubleClick, dialog };
}
