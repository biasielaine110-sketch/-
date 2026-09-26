import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZipStreaming } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";

function scrubImportedProject(project: CanvasProject): CanvasProject {
    return JSON.parse(JSON.stringify(project, (_key, value) => (typeof value === "string" && value.startsWith("blob:") ? "" : value))) as CanvasProject;
}

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => {
        navigate(`/canvas/${id}`);
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const warnLarge = file.size > 200 * 1024 * 1024;
        if (warnLarge) {
            const sizeMb = Math.round(file.size / 1024 / 1024);
            message.loading({ content: t("canvas.importingLarge", { size: sizeMb }), key: "import", duration: 0 });
        }
        try {
            // Pass 1: stream the archive and only extract the manifest (projects.json) that maps each
            // media entry's path -> { storageKey, mimeType }. Media bytes are skipped without being
            // retained, so even a multi-hundred-MB zip costs little memory here.
            const mediaItemsByPath = new Map<string, { storageKey: string; mimeType: string }>();
            let manifestText = "";
            await readZipStreaming(file, (name, blob) => {
                if (name === "projects.json") void blob.text().then((text) => (manifestText = text));
                // Skip media entries during the manifest pass.
            });
            if (!manifestText) throw new Error("missing projects.json");
            const data = JSON.parse(manifestText) as CanvasExportFile;
            for (const project of data.projects) {
                for (const item of project.files) mediaItemsByPath.set(item.path, { storageKey: item.storageKey, mimeType: item.mimeType });
            }

            // Pass 2: stream again, persisting each media blob to storage as it is decompressed, with
            // bounded concurrency. Peak memory stays near a single media entry rather than the whole zip.
            const mediaWrites: Array<Promise<void>> = [];
            await readZipStreaming(file, async (name, blob) => {
                if (name === "projects.json") return;
                const item = mediaItemsByPath.get(name);
                if (!item) return;
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                mediaWrites.push(
                    (async () => {
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    })().catch(() => undefined),
                );
                if (mediaWrites.length >= 8) await Promise.all(mediaWrites.splice(0, 8));
            });
            await Promise.all(mediaWrites);

            data.projects.forEach((item) => importProject(scrubImportedProject(item.project)));
            message.destroy("import");
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.destroy("import");
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
