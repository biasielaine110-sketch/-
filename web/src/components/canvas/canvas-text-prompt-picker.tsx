import { Dropdown, type MenuProps } from "antd";
import { BookMarked, Settings2 } from "lucide-react";
import type { CSSProperties } from "react";
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
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

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
                  onClick: () => onSelect(prompt),
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
                if (onOpenPreferences) onOpenPreferences();
                else openConfigDialog(false, "preferences");
            },
        },
    ];

    return (
        <Dropdown menu={{ items }} trigger={["click"]} placement="bottomRight">
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
    );
}
