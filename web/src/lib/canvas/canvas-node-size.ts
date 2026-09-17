export const IMAGE_DISPLAY_SCALE_PERCENTS = [20, 40, 50, 70, 99, 100] as const;

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

/** Display size relative to the default fit size (100% = fitNodeSize of natural pixels). */
export function sizeFromDisplayScalePercent(naturalWidth: number, naturalHeight: number, percent: number, minSide = 48) {
    const base = fitNodeSize(naturalWidth, naturalHeight);
    const factor = Math.max(0.05, percent / 100);
    return {
        width: Math.max(minSide, Math.round(base.width * factor)),
        height: Math.max(minSide, Math.round(base.height * factor)),
    };
}

export function nearestDisplayScalePercent(nodeWidth: number, nodeHeight: number, naturalWidth: number, naturalHeight: number) {
    const base = fitNodeSize(naturalWidth, naturalHeight);
    const ratio = Math.max(nodeWidth / Math.max(1, base.width), nodeHeight / Math.max(1, base.height));
    const current = Math.round(ratio * 100);
    return IMAGE_DISPLAY_SCALE_PERCENTS.reduce((best, value) => (Math.abs(value - current) < Math.abs(best - current) ? value : best), IMAGE_DISPLAY_SCALE_PERCENTS[0]);
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
