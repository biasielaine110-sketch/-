import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Dropdown, type MenuProps } from "antd";
import { BookMarked, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConfigStore, type TextPromptEntry } from "@/stores/use-config-store";

type CanvasTextPromptPickerProps = {
    onSelect: (prompt: TextPromptEntry) => void;
    onOpenPreferences?: () => void;
    size?: "small" | "default";
    className?: string;
    buttonStyle?: CSSProperties;
};

export function CanvasTextPromptPicker({ onSelect, onOpenPreferences, size = "default", className, buttonStyle }: CanvasTextPromptPickerProps) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    useEffect(() => {
        if (!open) return;
        const close = (event: PointerEvent | KeyboardEvent) => {
            if (event instanceof KeyboardEvent) {
                if (event.key === "Escape") setOpen(false);
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (target && (rootRef.current?.contains(target) || target.closest(".ant-dropdown"))) return;
            setOpen(false);
        };
        // Canvas pan/transform swallows bubbling mousedown; close on capture instead.
        window.addEventListener("pointerdown", close, true);
        window.addEventListener("keydown", close);
        return () => {
            window.removeEventListener("pointerdown", close, true);
            window.removeEventListener("keydown", close);
        };
    }, [open]);

    const items: MenuProps["items"] = [
        ...(textPrompts.length
            ? textPrompts.map((prompt) => ({
                  key: prompt.id,
                  label: (
                      <div className="max-w-72">
                          <div className="truncate text-sm font-medium">{prompt.title}</div>
                          <div className="mt-0.5 line-clamp-2 text-xs opacity-60">{prompt.content}</div>
                      </div>
                  ),
                  onClick: () => {
                      onSelect(prompt);
                      setOpen(false);
                  },
              }))
            : [
                  {
                      key: "empty",
                      label: t("canvas.textPromptLibrary.empty"),
                      disabled: true,
                  },
              ]),
        { type: "divider" as const },
        {
            key: "manage",
            icon: <Settings2 className="size-3.5" />,
            label: t("canvas.textPromptLibrary.manage"),
            onClick: () => {
                setOpen(false);
                if (onOpenPreferences) onOpenPreferences();
                else openConfigDialog(false, "preferences");
            },
        },
    ];

    return (
        <span ref={rootRef} className="inline-flex">
            <Dropdown
                open={open}
                trigger={["click"]}
                placement="bottomRight"
                // Keep the library under the trigger (into the text node). Auto-flip
                // occasionally puts it above the node on a transformed canvas.
                autoAdjustOverflow={false}
                getPopupContainer={() => document.body}
                menu={{ items }}
                onOpenChange={setOpen}
            >
                <button
                    type="button"
                    className={
                        className ||
                        `inline-flex items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100 ${
                            size === "small" ? "h-7" : "h-8"
                        }`
                    }
                    style={buttonStyle}
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("canvas.textPromptLibrary.title")}
                    aria-label={t("canvas.textPromptLibrary.title")}
                >
                    <BookMarked className={size === "small" ? "size-3" : "size-3.5"} />
                    {t("canvas.textPromptLibrary.short")}
                </button>
            </Dropdown>
        </span>
    );
}
