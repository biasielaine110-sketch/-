export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    /** Fallback when the full-size blob is missing but a persisted thumb remains. */
    thumbnailStorageKey?: string;
};
