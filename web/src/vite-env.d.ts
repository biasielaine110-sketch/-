/// <reference types="vite/client" />

type FileSystemHandlePermissionDescriptor = {
    mode?: "read" | "readwrite";
};

interface FileSystemHandle {
    readonly kind: "file" | "directory";
    readonly name: string;
    getParent?: () => Promise<FileSystemDirectoryHandle | null>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
    readonly kind: "directory";
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemFileHandle extends FileSystemHandle {
    readonly kind: "file";
    getFile(): Promise<File>;
    createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string): Promise<void>;
    seek(position: number): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
}

interface SaveFilePickerOptions {
    suggestedName?: string;
    /** Remember last-used directory for this picker id across visits. */
    id?: string;
    /** Prefer opening next to an existing file/directory handle (e.g. bound draft). */
    startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
    types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
    }>;
    excludeAcceptAllOption?: boolean;
}

interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}
