import { DRAFT_DIR_PLACEHOLDER, DRAFT_ROOT_PLACEHOLDER } from "@/lib/canvas/jianying-draft";

/**
 * 剪映草稿「直写」：不下载 zip，直接把草稿文件夹写进用户的 `com.lveditor.draft`。
 *
 * ## 为什么需要「一次性授权 + 手工粘一次路径」
 * 浏览器沙箱**不能**往任意绝对路径写文件；唯一合法的口子是 File System Access API
 * （`showDirectoryPicker`），它给的是**句柄**，拿不到真实绝对路径。而剪映的
 * `draft_content.json` / `draft_meta_info.json` 里 `path` / `draft_fold_path` / `draft_root_path`
 * **必须是绝对路径**（写相对路径剪映直接判草稿损坏）。
 *
 * 所以：目录靠句柄写，路径靠用户粘一次（剪映 → 全局设置 → 草稿位置 里显示的那条）。
 * 两者都存起来，之后每次导出都是一键 —— 不再有 zip、解压、install.bat。
 *
 * ## 兼容性
 * 只有 Chromium 系（Chrome / Edge 86+）有 `showDirectoryPicker`，且必须 https / localhost。
 * 不支持时上层自动退回「下载 zip + install.bat」那条老路（见 `supportsJianyingDirectWrite`）。
 *
 * ## 覆盖语义
 * 草稿文件夹名由 `jianyingDraftFolderName(节点标题)` 决定 —— `节点名_MMDD`（例：`约会_1107`）。
 * 同一天再导出同一个节点就是覆盖（不会把草稿箱塞满）；换一天导出是新草稿。
 * 名字**撞上已有草稿**时上层会弹一个框，让用户选「覆盖」还是「换个名字」（见 `jianyingDraftFolderExists`）。
 */

/** 直写时要落盘的一个文件；`name` 可以带 `materials/` 这类子目录前缀。 */
export type JianyingDraftFile = { name: string; data: Blob | string };

const DB_NAME = "infinite-atelier-fs";
const DB_STORE = "handles";
const DB_KEY = "jianying-draft-root";
const PATH_STORAGE_KEY = "infinite-atelier:jianying-draft-root-path";

/** 草稿根目录（`com.lveditor.draft` 那层）在 Windows 上的默认位置 —— 用户名那一节只能用户自己填。 */
export const JIANYING_DRAFT_ROOT_HINT = "C:\\Users\\<你的用户名>\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft";

type PickerWindow = Window & {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "write" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
};

/** `queryPermission` / `requestPermission` 不在 lib.dom 的类型里（File System Access 的扩展）。 */
type PermissionHandle = FileSystemDirectoryHandle & {
    queryPermission?: (descriptor?: { mode?: "read" | "write" | "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (descriptor?: { mode?: "read" | "write" | "readwrite" }) => Promise<PermissionState>;
};

export function supportsJianyingDirectWrite() {
    if (typeof window === "undefined") return false;
    return typeof (window as PickerWindow).showDirectoryPicker === "function";
}

// ── IndexedDB：把目录句柄存下来（FileSystemDirectoryHandle 可结构化克隆）──────────────────

function openFsDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, 1);
        } catch {
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

function runStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
    return openFsDb().then(
        (db) =>
            new Promise<T | null>((resolve) => {
                if (!db) {
                    resolve(null);
                    return;
                }
                try {
                    const transaction = db.transaction(DB_STORE, mode);
                    const request = run(transaction.objectStore(DB_STORE));
                    request.onsuccess = () => resolve((request.result as T) ?? null);
                    request.onerror = () => resolve(null);
                    transaction.oncomplete = () => db.close();
                } catch {
                    // 句柄在部分浏览器里不可克隆（DataCloneError）→ 当次会话内仍可用，只是不持久
                    resolve(null);
                    db.close();
                }
            }),
    );
}

export function readStoredJianyingRoot() {
    return runStore<FileSystemDirectoryHandle>("readonly", (store) => store.get(DB_KEY));
}

export function storeJianyingRoot(handle: FileSystemDirectoryHandle | null) {
    return handle ? runStore<IDBValidKey>("readwrite", (store) => store.put(handle, DB_KEY)) : runStore<undefined>("readwrite", (store) => store.delete(DB_KEY));
}

// ── 根目录绝对路径（字符串，剪映 JSON 要用）──────────────────────────────────────────────

export function loadJianyingRootPath() {
    try {
        return localStorage.getItem(PATH_STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

export function saveJianyingRootPath(path: string) {
    try {
        if (path) localStorage.setItem(PATH_STORAGE_KEY, path);
        else localStorage.removeItem(PATH_STORAGE_KEY);
    } catch {
        /* 隐私模式写不进 localStorage，不影响本次导出 */
    }
}

/** 拼 Windows 绝对路径：`C:\a\b` + `c` → `C:\a\b\c`（末尾多余分隔符先削掉）。 */
export function joinDraftPath(rootPath: string, ...segments: string[]) {
    const base = String(rootPath || "")
        .trim()
        .replace(/[\\/]+$/, "");
    return [base, ...segments.map((segment) => String(segment || "").replace(/^[\\/]+/, ""))].filter(Boolean).join("\\");
}

/**
 * 用户粘进来的路径基本可用吗？（只做**轻校验**，不做强制 —— 路径可能是网络盘 / 自定义位置）
 * 挡掉的两类：环境变量（`%LOCALAPPDATA%` 剪映不认）、相对写法。
 */
export function looksLikeAbsoluteDraftRoot(path: string) {
    const value = String(path || "").trim();
    if (!value) return false;
    if (value.includes("%")) return false;
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

// ── 选目录 / 权限 ────────────────────────────────────────────────────────────────────────

/**
 * 让用户选一次草稿根目录。用户点取消返回 `null`（不抛错，调用方保持原状）。
 * `id` 让浏览器记住上次停在哪 —— 第二次导出基本是「点两下」。
 */
export async function pickJianyingDraftRoot(): Promise<FileSystemDirectoryHandle | null> {
    const picker = typeof window === "undefined" ? undefined : (window as PickerWindow).showDirectoryPicker;
    if (!picker) throw new Error("unsupported-file-system-access");
    try {
        return (await picker.call(window, { id: "jianying-draft-root", mode: "readwrite" })) ?? null;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
    }
}

/** 句柄还写着吗？没授权就现场要一次（必须在用户点击的手势里调用）。 */
export async function ensureJianyingWritePermission(handle: FileSystemDirectoryHandle) {
    const candidate = handle as PermissionHandle;
    // 没有权限 API 的实现：直接交给写操作自己失败，比在这里误判「没授权」好
    if (typeof candidate.queryPermission !== "function") return true;
    const descriptor = { mode: "readwrite" as const };
    try {
        if ((await candidate.queryPermission(descriptor)) === "granted") return true;
        if (typeof candidate.requestPermission !== "function") return false;
        return (await candidate.requestPermission(descriptor)) === "granted";
    } catch {
        return false;
    }
}

// ── 落盘 ────────────────────────────────────────────────────────────────────────────────

/** 清掉 Windows 文件夹名里不允许出现的字符（含控制字符），并削掉结尾的点（`mkdir` 会失败）。 */
export function cleanWindowsPathSegment(value: string) {
    return String(value || "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.+$/, "")
        .trim();
}

/**
 * 草稿文件夹名：`节点名_MMDD`（例：`约会_1107`）。
 *
 * 日期取**本地时间**。同一天对同一个节点反复导出落在同一个文件夹里 → 天然是「覆盖上次」；
 * 换一天再导出就是一份新草稿，不会把昨天那版盖掉。
 *
 * ⚠️ 与 `jianying-draft.ts: asciiDraftFolderName` 刻意不同：这里**保留中文**。
 * 那条路（下载 zip + install.bat）必须全 ASCII，是因为 `.bat` 由浏览器按 UTF-8 写出、cmd 默认
 * 代码页不是 UTF-8，`set "NAME=中文"` 会乱码；而这条是 File System Access 直写，名字由浏览器
 * 按 UTF-8 交给系统，不经过 cmd 代码页，中文安全 —— 用户要的就是「约会_1107」这种可读的名字。
 */
export function jianyingDraftFolderName(draftName: string, at: Date = new Date()) {
    const base = cleanWindowsPathSegment(draftName).slice(0, 40) || "canvas-draft";
    const month = String(at.getMonth() + 1).padStart(2, "0");
    const day = String(at.getDate()).padStart(2, "0");
    return `${base}_${month}${day}`;
}

/**
 * 草稿根目录里已经有这一点名的文件夹了吗？
 *
 * 用 `getDirectoryHandle`（**不带** `create`）探一下：`NotFoundError` 就是没有。
 * 其他错误（没授权 / 名字非法）一律当「不存在」—— 让后面真正的写盘那步报原始错误，
 * 比在这里擅自判定「已存在」弹一个假的重名框好。
 */
export async function jianyingDraftFolderExists(root: FileSystemDirectoryHandle, folderName: string) {
    const name = String(folderName || "").trim();
    if (!name) return false;
    try {
        await root.getDirectoryHandle(name);
        return true;
    } catch {
        // `NotFoundError` = 没有这个文件夹；其他错误（未授权 / 名字非法）也当「没有」——
        // 让后面真正写盘那步报原始错误，比在这里擅自弹一个假的重名框好。
        return false;
    }
}

/** 给「换个名字」预填一个当前没被占用的名字：`约会_1106-2`、`-3`…… 最多试 30 个。 */
export async function suggestAvailableDraftFolderName(root: FileSystemDirectoryHandle, folderName: string) {
    for (let index = 2; index <= 30; index += 1) {
        const candidate = `${folderName}-${index}`;
        if (!(await jianyingDraftFolderExists(root, candidate))) return candidate;
    }
    return `${folderName}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * 把占位符换成真实路径。
 *
 * ⚠️ 入参是 `JSON.stringify` **之后的文本**：JSON 里反斜杠已经写成 `\\`，所以替换值也要转义成
 * `\\`（与 `install.bat` 里 `%ESCAPED:\=\\%` 同一口径）。少这一步，剪映读到的路径里会缺转义，
 * 表现为「素材全部离线」。
 */
export function resolveJianyingPlaceholders(json: string, draftDirPath: string, rootPath: string) {
    const escape = (value: string) => String(value || "").replace(/\\/g, "\\\\");
    return json.split(DRAFT_DIR_PLACEHOLDER).join(escape(draftDirPath)).split(DRAFT_ROOT_PLACEHOLDER).join(escape(rootPath));
}

/**
 * 写出整个草稿文件夹。
 *
 * 先 `removeEntry(recursive)` 再重建 —— xcopy 那条路是 `/Y` 覆盖但仍会残留上次多出来的素材，
 * 这里直接清空，保证「剪映看到的 = 这次导出的」。
 */
export async function writeJianyingDraft(root: FileSystemDirectoryHandle, folderName: string, files: JianyingDraftFile[]) {
    try {
        await root.removeEntry(folderName, { recursive: true });
    } catch {
        /* 不存在就算了 —— 首次导出必然走到这里 */
    }
    const folder = await root.getDirectoryHandle(folderName, { create: true });
    for (const file of files) {
        const segments = String(file.name || "")
            .split("/")
            .filter(Boolean);
        if (!segments.length) continue;
        let directory = folder;
        for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: true });
        const handle = await directory.getFileHandle(segments[segments.length - 1], { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(file.data);
        } finally {
            await writable.close();
        }
    }
    return joinDraftPath(folderName);
}
