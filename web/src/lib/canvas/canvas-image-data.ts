export type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
    horizontalLines?: number[];
    verticalLines?: number[];
    /** Optional output aspect ratio like "1:1" | "16:9" | "9:16". Source is center-cropped before split. */
    aspectRatio?: string | null;
};

export type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export type ImageMergePiece = {
    row: number;
    column: number;
    dataUrl: string;
    /** Cover focus point in 0..1. Defaults to center (0.5). */
    offsetX?: number;
    offsetY?: number;
};

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const source = await loadImage(dataUrl);
    const cropped = params.aspectRatio ? cropImageToAspect(source, parseAspectRatio(params.aspectRatio)) : source;
    const image = cropped instanceof HTMLImageElement ? cropped : await canvasToImage(cropped);
    const xCuts = buildSplitCuts(params.verticalLines, image.width, Math.max(1, Math.floor(params.columns)));
    const yCuts = buildSplitCuts(params.horizontalLines, image.height, Math.max(1, Math.floor(params.rows)));
    const pieces: ImageSplitPiece[] = [];

    for (let row = 0; row < yCuts.length - 1; row += 1) {
        const sy = yCuts[row];
        const sh = yCuts[row + 1] - sy;
        for (let column = 0; column < xCuts.length - 1; column += 1) {
            const sx = xCuts[column];
            const sw = xCuts[column + 1] - sx;
            pieces.push({ row, column, dataUrl: drawCrop(image, sx, sy, sw, sh) });
        }
    }

    return pieces;
}

export type ImageMergeParams = {
    rows: number;
    columns: number;
    pieces: ImageMergePiece[];
    /** Optional output aspect ratio like "1:1" | "16:9" | "9:16". Final merge is center-cropped. */
    aspectRatio?: string | null;
};

export async function mergeDataUrls(params: ImageMergeParams) {
    const rows = Math.max(1, Math.floor(params.rows));
    const columns = Math.max(1, Math.floor(params.columns));
    if (params.pieces.length < 1) throw new Error("merge pieces incomplete");

    const loaded = await Promise.all(
        params.pieces.map(async (piece) => ({
            ...piece,
            image: await loadImage(piece.dataUrl),
        })),
    );

    const cellWidth = Math.max(...loaded.map((item) => item.image.width));
    const cellHeight = Math.max(...loaded.map((item) => item.image.height));
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * columns;
    canvas.height = cellHeight * rows;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("merge canvas unavailable");
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);

    loaded.forEach((piece) => {
        const column = Math.min(columns - 1, Math.max(0, piece.column));
        const row = Math.min(rows - 1, Math.max(0, piece.row));
        const x = column * cellWidth;
        const y = row * cellHeight;
        drawImageCover(context, piece.image, x, y, cellWidth, cellHeight, piece.offsetX, piece.offsetY);
    });

    const merged = canvas.toDataURL("image/png");
    const ratio = parseAspectRatio(params.aspectRatio);
    if (!ratio) return merged;

    const image = await loadImage(merged);
    const cropped = cropImageToAspect(image, ratio);
    if (cropped instanceof HTMLImageElement) return cropped.src;
    return cropped.toDataURL("image/png");
}

export function parseAspectRatio(value?: string | null) {
    if (!value || value === "original") return null;
    const [w, h] = value.split(":").map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return w / h;
}

export function resolveGridPreset(cells: 3 | 4 | 6 | 9, aspectRatio?: string | null): { rows: number; columns: number } {
    const ratio = parseAspectRatio(aspectRatio);
    const portrait = ratio != null && ratio < 1;
    if (cells === 3) return portrait ? { rows: 3, columns: 1 } : { rows: 1, columns: 3 };
    if (cells === 4) return { rows: 2, columns: 2 };
    if (cells === 6) return portrait ? { rows: 3, columns: 2 } : { rows: 2, columns: 3 };
    return { rows: 3, columns: 3 };
}

function drawImageCover(
    context: CanvasRenderingContext2D,
    image: CanvasImageSource & { width: number; height: number },
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    focusX = 0.5,
    focusY = 0.5,
) {
    const width = Math.max(1, image.width || 1);
    const height = Math.max(1, image.height || 1);
    const scale = Math.max(dw / width, dh / height);
    const sw = Math.min(width, dw / scale);
    const sh = Math.min(height, dh / scale);
    const ox = Math.min(1, Math.max(0, Number.isFinite(focusX) ? focusX : 0.5));
    const oy = Math.min(1, Math.max(0, Number.isFinite(focusY) ? focusY : 0.5));
    const sx = Math.min(Math.max(0, (width - sw) * ox), Math.max(0, width - sw));
    const sy = Math.min(Math.max(0, (height - sh) * oy), Math.max(0, height - sh));
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
}

function cropImageToAspect(image: HTMLImageElement, ratio: number | null) {
    if (!ratio) return image;
    const imageRatio = image.width / image.height;
    let sw = image.width;
    let sh = image.height;
    if (imageRatio > ratio) {
        sw = Math.round(image.height * ratio);
    } else {
        sh = Math.round(image.width / ratio);
    }
    const sx = Math.max(0, Math.floor((image.width - sw) / 2));
    const sy = Math.max(0, Math.floor((image.height - sh) / 2));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function canvasToImage(canvas: HTMLCanvasElement) {
    return loadImage(canvas.toDataURL("image/png"));
}

function buildSplitCuts(lines: number[] | undefined, size: number, count: number) {
    if (!lines?.length) return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
    return [0, ...lines.map((line) => Math.round(line * size)).filter((line) => line > 0 && line < size).sort((a, b) => a - b), size];
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL("image/png");
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams) {
    const image = await loadImage(dataUrl);
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResize(image, image.width, image.height, width, height, params.algorithm);
}

export type ImageAdjustParams = {
    /** Saturation percent. 100 = unchanged, 0 = grayscale, 200 = double. */
    saturation: number;
    /** Contrast percent. 100 = unchanged, 0 = flat, 200 = double. */
    contrast: number;
    /** Exposure percent. 100 = unchanged, <100 darker, >100 brighter. */
    exposure: number;
    /** Glow intensity 0..100. 0 = none, higher = stronger soft bloom on highlights. */
    glow: number;
};

export const DEFAULT_IMAGE_ADJUST_PARAMS: ImageAdjustParams = { saturation: 100, contrast: 100, exposure: 100, glow: 0 };

/** Apply saturation / contrast / exposure / glow and return a new PNG data URL. */
export async function adjustDataUrl(dataUrl: string, params: ImageAdjustParams) {
    const image = await loadImage(dataUrl);
    const width = image.width;
    const height = image.height;
    if (!width || !height) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;

    const saturation = clampPercent(params.saturation);
    const contrast = clampPercent(params.contrast);
    const exposure = clampPercent(params.exposure);
    const glow = Math.max(0, Math.min(100, Number(params.glow) || 0));

    // 1) Base tone pass: saturation / contrast / exposure via the CSS filter stack
    //    (exposure maps to brightness, which is the closest cheap approximation).
    const filterParts: string[] = [];
    if (saturation !== 100) filterParts.push(`saturate(${(saturation / 100).toFixed(3)})`);
    if (contrast !== 100) filterParts.push(`contrast(${(contrast / 100).toFixed(3)})`);
    if (exposure !== 100) filterParts.push(`brightness(${(exposure / 100).toFixed(3)})`);
    context.filter = filterParts.length ? filterParts.join(" ") : "none";
    context.drawImage(image, 0, 0, width, height);
    context.filter = "none";

    // 2) Glow pass: composite a blurred, brightened copy of the highlights on top
    //    using the "screen" blend mode to create a soft bloom without crushing blacks.
    if (glow > 0) {
        const intensity = glow / 100;
        const blurPx = Math.max(2, Math.round(Math.min(width, height) * 0.04 * (0.5 + intensity)));
        const glowCanvas = document.createElement("canvas");
        glowCanvas.width = width;
        glowCanvas.height = height;
        const glowCtx = glowCanvas.getContext("2d");
        if (glowCtx) {
            glowCtx.filter = `brightness(${(1 + intensity * 0.5).toFixed(3)}) blur(${blurPx}px)`;
            glowCtx.drawImage(canvas, 0, 0, width, height);
            glowCtx.filter = "none";
            context.save();
            context.globalAlpha = Math.min(1, intensity * 0.85);
            context.globalCompositeOperation = "screen";
            context.drawImage(glowCanvas, 0, 0, width, height);
            context.restore();
        }
    }

    const keepPng = /^data:image\/png/i.test(dataUrl) && canvasHasAlpha(context, width, height);
    return keepPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
}

function clampPercent(value: number) {
    const next = Number(value);
    if (!Number.isFinite(next)) return 100;
    return Math.max(0, Math.min(300, Math.round(next)));
}

/** Downscale image pixels by percent of natural size (100 = unchanged). Prefers JPEG to shrink file size. */
export async function resizeDataUrlByPercent(dataUrl: string, percent: number) {
    const image = await loadImage(dataUrl);
    const factor = Math.max(0.05, Math.min(1, (Number(percent) || 100) / 100));
    const width = Math.max(1, Math.round(image.width * factor));
    const height = Math.max(1, Math.round(image.height * factor));
    if (width >= image.width && height >= image.height) {
        return { dataUrl, width: image.width, height: image.height, changed: false as const };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { dataUrl, width: image.width, height: image.height, changed: false as const };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);

    const keepPng = /^data:image\/png/i.test(dataUrl) && canvasHasAlpha(context, width, height);
    const nextDataUrl = keepPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.88);
    return { dataUrl: nextDataUrl, width, height, changed: true as const };
}

function canvasHasAlpha(context: CanvasRenderingContext2D, width: number, height: number) {
    try {
        const sample = context.getImageData(0, 0, Math.min(width, 64), Math.min(height, 64)).data;
        for (let i = 3; i < sample.length; i += 4) {
            if (sample[i] < 250) return true;
        }
    } catch {
        return false;
    }
    return false;
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
        const nextWidth = sourceWidth * 2;
        const nextHeight = sourceHeight * 2;
        const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
        source = next;
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
    }

    return drawResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.src = dataUrl;
    });
}
