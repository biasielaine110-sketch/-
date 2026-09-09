import { useEffect, useRef, useState } from "react";
import { Button, Modal, Slider, Tooltip } from "antd";
import { Aperture, Camera, Grid2x2, Grid3x3, LayoutGrid, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type PanoramaCapturePayload = {
    dataUrl: string;
    kind: "view" | "grid4" | "grid6" | "grid9";
    label: string;
};

type Props = {
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onCapture: (payload: PanoramaCapturePayload) => void;
};

type ViewPose = { yaw: number; pitch: number };

export function CanvasNodePanoramaDialog({ dataUrl, open, onClose, onCapture }: Props) {
    const { t } = useTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const sphereRef = useRef<THREE.Mesh | null>(null);
    const frameRef = useRef<number | null>(null);
    const [ready, setReady] = useState(false);
    const [fov, setFov] = useState(75);
    const [busy, setBusy] = useState<"view" | "grid4" | "grid6" | "grid9" | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        const host = hostRef.current;
        if (!host) return;

        setReady(false);
        setError("");
        setBusy(null);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
        camera.position.set(0, 0, 0.01);
        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 1);
        host.innerHTML = "";
        host.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableZoom = true;
        controls.enablePan = false;
        controls.rotateSpeed = -0.35;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 0.01;
        controls.maxDistance = 0.01;
        controls.target.set(0, 0, 0);

        const geometry = new THREE.SphereGeometry(500, 64, 40);
        geometry.scale(-1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ color: 0x222222 });
        const sphere = new THREE.Mesh(geometry, material);
        scene.add(sphere);

        sceneRef.current = scene;
        cameraRef.current = camera;
        rendererRef.current = renderer;
        controlsRef.current = controls;
        sphereRef.current = sphere;

        const resize = () => {
            const width = Math.max(1, host.clientWidth);
            const height = Math.max(1, host.clientHeight);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(host);

        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin("anonymous");
        loader.load(
            dataUrl,
            (texture) => {
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.mapping = THREE.EquirectangularReflectionMapping;
                material.map = texture;
                material.color = new THREE.Color(0xffffff);
                material.needsUpdate = true;
                setReady(true);
            },
            undefined,
            () => setError(t("canvas.editors.panoramaLoadFailed")),
        );

        const tick = () => {
            controls.update();
            renderer.render(scene, camera);
            frameRef.current = requestAnimationFrame(tick);
        };
        tick();

        return () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            observer.disconnect();
            controls.dispose();
            geometry.dispose();
            material.map?.dispose();
            material.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
            rendererRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
            controlsRef.current = null;
            sphereRef.current = null;
        };
    }, [dataUrl, open, t]);

    useEffect(() => {
        const camera = cameraRef.current;
        if (!camera) return;
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }, [fov]);

    const captureCurrentView = async () => {
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (!renderer || !scene || !camera) return;
        setBusy("view");
        try {
            controlsRef.current?.update();
            renderer.render(scene, camera);
            const dataUrlOut = renderer.domElement.toDataURL("image/png");
            onCapture({ dataUrl: dataUrlOut, kind: "view", label: t("canvas.editors.panoramaShotView") });
        } finally {
            setBusy(null);
        }
    };

    const captureGrid = async (cells: 4 | 6 | 9) => {
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!renderer || !scene || !camera || !controls) return;
        setBusy(cells === 4 ? "grid4" : cells === 6 ? "grid6" : "grid9");
        try {
            const layout = cells === 4 ? { rows: 2, columns: 2 } : cells === 6 ? { rows: 2, columns: 3 } : { rows: 3, columns: 3 };
            const poses = buildRandomGridPoses(cells);
            const cellWidth = 640;
            const cellHeight = 640;
            const shots: string[] = [];
            const previousTarget = controls.target.clone();
            const previousPosition = camera.position.clone();
            const previousFov = camera.fov;

            camera.fov = Math.min(90, Math.max(55, fov));
            camera.aspect = 1;
            camera.updateProjectionMatrix();

            for (const pose of poses) {
                applyCameraPose(camera, controls, pose);
                controls.update();
                const shot = renderOffscreen(scene, camera, cellWidth, cellHeight);
                shots.push(shot);
            }

            camera.position.copy(previousPosition);
            controls.target.copy(previousTarget);
            camera.fov = previousFov;
            camera.aspect = Math.max(1, renderer.domElement.clientWidth) / Math.max(1, renderer.domElement.clientHeight);
            camera.updateProjectionMatrix();
            controls.update();

            const gridDataUrl = await stitchGrid(shots, layout.rows, layout.columns, cellWidth, cellHeight);
            onCapture({
                dataUrl: gridDataUrl,
                kind: cells === 4 ? "grid4" : cells === 6 ? "grid6" : "grid9",
                label: t("canvas.editors.panoramaShotGrid", { count: cells }),
            });
        } catch (captureError) {
            setError(captureError instanceof Error ? captureError.message : t("canvas.editors.panoramaCaptureFailed"));
        } finally {
            setBusy(null);
        }
    };

    const resetView = () => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!camera || !controls) return;
        camera.position.set(0, 0, 0.01);
        controls.target.set(0, 0, 0);
        controls.update();
        setFov(75);
    };

    return (
        <Modal
            open={open && Boolean(dataUrl)}
            onCancel={onClose}
            footer={null}
            width="min(98vw, 1280px)"
            centered
            destroyOnHidden
            title={null}
            styles={{ body: { padding: 12, height: "min(92vh, 900px)" } }}
            zIndex={4100}
            getContainer={() => document.body}
            mask={{ closable: true }}
        >
            <div className="flex h-full flex-col gap-3" data-canvas-no-zoom data-canvas-shortcuts-ignore onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="mr-2 text-lg font-semibold">{t("canvas.editors.panoramaTitle")}</h2>
                    <span className="text-xs opacity-55">{t("canvas.editors.panoramaHint")}</span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Tooltip title={t("canvas.editors.panoramaReset")}>
                            <Button icon={<RotateCcw className="size-4" />} onClick={resetView} disabled={!ready} />
                        </Tooltip>
                        <Button type="primary" icon={<Camera className="size-4" />} loading={busy === "view"} disabled={!ready || Boolean(busy)} onClick={() => void captureCurrentView()}>
                            {t("canvas.editors.panoramaCaptureView")}
                        </Button>
                        <Button icon={<Grid2x2 className="size-4" />} loading={busy === "grid4"} disabled={!ready || Boolean(busy)} onClick={() => void captureGrid(4)}>
                            {t("canvas.editors.panoramaCaptureGrid", { count: 4 })}
                        </Button>
                        <Button icon={<LayoutGrid className="size-4" />} loading={busy === "grid6"} disabled={!ready || Boolean(busy)} onClick={() => void captureGrid(6)}>
                            {t("canvas.editors.panoramaCaptureGrid", { count: 6 })}
                        </Button>
                        <Button icon={<Grid3x3 className="size-4" />} loading={busy === "grid9"} disabled={!ready || Boolean(busy)} onClick={() => void captureGrid(9)}>
                            {t("canvas.editors.panoramaCaptureGrid", { count: 9 })}
                        </Button>
                        <Button icon={<X className="size-4" />} onClick={onClose}>
                            {t("canvas.editors.cancel")}
                        </Button>
                    </div>
                </div>

                <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-black/10 bg-black dark:border-white/10">
                    <div ref={hostRef} className="absolute inset-0 [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:touch-none" />
                    {!ready && !error ? (
                        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/70">
                            <span className="inline-flex items-center gap-2">
                                <Aperture className="size-4 animate-spin" />
                                {t("canvas.editors.loading")}
                            </span>
                        </div>
                    ) : null}
                    {error ? <div className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-lg bg-black/70 px-3 py-1.5 text-xs text-red-300">{error}</div> : null}
                </div>

                <div className="flex items-center gap-3 px-1">
                    <span className="shrink-0 text-xs font-medium opacity-65">{t("canvas.editors.panoramaFov")}</span>
                    <Slider className="min-w-0 flex-1" min={40} max={100} step={1} value={fov} disabled={!ready} onChange={setFov} />
                    <span className="w-12 text-right text-xs font-semibold tabular-nums opacity-70">{fov}°</span>
                </div>
            </div>
        </Modal>
    );
}

function buildRandomGridPoses(cells: 4 | 6 | 9): ViewPose[] {
    const layout = cells === 4 ? { rows: 2, columns: 2 } : cells === 6 ? { rows: 2, columns: 3 } : { rows: 3, columns: 3 };
    const baseYaw = Math.random() * Math.PI * 2;
    const poses: ViewPose[] = [];
    for (let row = 0; row < layout.rows; row += 1) {
        for (let column = 0; column < layout.columns; column += 1) {
            const yawStep = (Math.PI * 2) / layout.columns;
            const pitchSpan = THREE.MathUtils.degToRad(50);
            const yaw = baseYaw + column * yawStep + (Math.random() - 0.5) * yawStep * 0.35;
            const pitchCenter = ((row + 0.5) / layout.rows - 0.5) * -2 * pitchSpan;
            const pitch = THREE.MathUtils.clamp(pitchCenter + (Math.random() - 0.5) * THREE.MathUtils.degToRad(12), THREE.MathUtils.degToRad(-70), THREE.MathUtils.degToRad(70));
            poses.push({ yaw, pitch });
        }
    }
    return poses;
}

function applyCameraPose(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: ViewPose) {
    const radius = 0.01;
    const x = radius * Math.sin(pose.yaw) * Math.cos(pose.pitch);
    const y = radius * Math.sin(pose.pitch);
    const z = radius * Math.cos(pose.yaw) * Math.cos(pose.pitch);
    camera.position.set(x, y, z);
    controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
}

function renderOffscreen(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 1);
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL("image/png");
    renderer.dispose();
    renderer.forceContextLoss();
    return dataUrl;
}

async function stitchGrid(shots: string[], rows: number, columns: number, cellWidth: number, cellHeight: number) {
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * columns;
    canvas.height = cellHeight * rows;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("stitch failed");
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const images = await Promise.all(shots.map(loadImage));
    images.forEach((image, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        context.drawImage(image, column * cellWidth, row * cellHeight, cellWidth, cellHeight);
    });
    return canvas.toDataURL("image/png");
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image load failed"));
        image.src = src;
    });
}
