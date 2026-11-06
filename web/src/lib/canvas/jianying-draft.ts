import { roundSeconds } from "@/lib/canvas/video-merge";

/**
 * 剪映（国内版专业版）草稿生成。
 *
 * ## 为什么是「生成文件」而不是「调接口」
 * 剪映没有任何官方 API。社区唯一稳定的做法是直接写 `draft_content.json` +
 * `draft_meta_info.json`（pyJianYingDraft 走的就是这条路）。结构照 5.9 的模板：
 * `version: 360000` / `new_version: "95.0.0"`。
 *
 * ## 6.0+ 的加密只挡一半
 * 剪映 6.0 起会把 `draft_content.json` 存成 AES 二进制（文件不再以 `{` 开头），
 * 所以「读已有草稿当模板」失效了。但**写入明文草稿仍然能被打开**（打开时剪映自己再加密存回去）——
 * pyJianYingDraft 官方声明「兼容除模板模式外的所有功能」，社区实测到 10.8 仍可。
 *
 * ## 绝对路径只能交给本地脚本补
 * 草稿里的 `path` / `draft_fold_path` 必须是本机绝对路径，而浏览器拿不到用户磁盘路径。
 * 所以这里统一写占位符 {@link DRAFT_DIR_PLACEHOLDER}，由随包下发的 `install.bat` 在
 * 用户机器上替换成真实路径（并转义成 JSON 需要的 `\\`）。
 */

/** 草稿目录占位符 —— 只会出现在字符串值里，由 install.bat 替换。 */
export const DRAFT_DIR_PLACEHOLDER = "__DRAFT_DIR__";
/** 草稿根目录（`com.lveditor.draft` 那层）占位符 —— `draft_root_path` 专用。 */
export const DRAFT_ROOT_PLACEHOLDER = "__DRAFT_ROOT__";
/** 剪映 5.9 的草稿版本号；新版打开后会自己升级。 */
export const JIANYING_DRAFT_VERSION = 360000;
const JIANYING_APP_VERSION = "5.9.0";

const MICRO = 1_000_000;

export type JianyingDraftClip = {
    /** `materials/` 下的文件名，含扩展名。 */
    fileName: string;
    kind: "video" | "image";
    /** 素材总长（微秒）—— 图片用它的展示时长。 */
    sourceDurationUs: number;
    /** 取用区间（微秒）。 */
    inUs: number;
    outUs: number;
    width: number;
    height: number;
    hasAudio: boolean;
};

export type JianyingDraftInput = {
    name: string;
    canvasWidth: number;
    canvasHeight: number;
    clips: JianyingDraftClip[];
    /** 有封面就带上 —— 7.0+ 收紧了封面校验，缺封面更容易被判成损坏。 */
    coverFileName?: string;
    /** 单位秒；不传就取当前时间。 */
    createdAt?: number;
};

export type JianyingDraftBundle = {
    draftContent: Record<string, unknown>;
    draftMetaInfo: Record<string, unknown>;
    installScript: string;
    readme: string;
    /** 草稿总时长（秒），用于 toast / 清单。 */
    totalSeconds: number;
};

export function secondsToMicro(seconds: number) {
    return Math.max(0, Math.round((Number(seconds) || 0) * MICRO));
}

function randomId() {
    const cryptoApi = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const value = Math.floor(Math.random() * 16);
        return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
    });
}

function platform(os: string) {
    return {
        app_id: 6301,
        app_source: "lv",
        app_version: JIANYING_APP_VERSION,
        device_id: "",
        hard_disk_id: "",
        mac_address: "",
        os,
        os_version: os === "mac" ? "14.0" : "10.0.22631",
    };
}

function mediaPath(fileName: string) {
    return `${DRAFT_DIR_PLACEHOLDER}\\materials\\${fileName}`;
}

function buildVideoMaterial(clip: JianyingDraftClip) {
    const isImage = clip.kind === "image";
    return {
        aigc_type: "none",
        audio_fade: null,
        category_id: "",
        category_name: "local",
        check_flag: 63487,
        crop: {
            lower_left_x: 0.0,
            lower_left_y: 1.0,
            lower_right_x: 1.0,
            lower_right_y: 1.0,
            upper_left_x: 0.0,
            upper_left_y: 0.0,
            upper_right_x: 1.0,
            upper_right_y: 0.0,
        },
        crop_ratio: "free",
        crop_scale: 1.0,
        duration: clip.sourceDurationUs,
        height: clip.height,
        has_audio: isImage ? false : clip.hasAudio,
        id: randomId(),
        intensifies_audio: false,
        is_placeholder: false,
        is_unified_beauty_mode: false,
        local_id: "",
        local_material_id: "",
        material_id: "",
        material_name: clip.fileName,
        material_url: "",
        matting: {
            flag: 0,
            has_use_quick_brush: false,
            has_use_quick_eraser: false,
            interactiveTime: [],
            path: "",
            strokes: [],
        },
        media_path: "",
        object_locked: null,
        origin_material_id: "",
        path: mediaPath(clip.fileName),
        picture_from: "none",
        picture_set_category_id: "",
        picture_set_category_name: "",
        request_id: "",
        reverse_intensifies_audio: false,
        reverse_path: "",
        smart_motion: null,
        source: 0,
        source_platform: 0,
        stable: null,
        type: isImage ? "photo" : "video",
        video_algorithm: {
            algorithms: [],
            complement_frame_config: null,
            deflicker: null,
            gameplay_configs: [],
            motion_blur_config: null,
            noise_reduction: null,
            path: "",
            quality_enhance: null,
            super_resolution: null,
            time_range: null,
        },
        width: clip.width,
    };
}

/**
 * 每个片段在剪映里都必须挂一组「伴随素材」（速度 / 背景画布 / 声道映射 / 人声分离），
 * 缺了它们时间线能显示但预览与导出会出问题。这里一次性建好并返回 refs。
 */
function buildCompanionMaterials() {
    return {
        speed: { curve_speed: null, id: randomId(), mode: 0, speed: 1.0, type: "speed" },
        canvas: {
            album_image: "",
            blur: 0.0,
            color: "",
            id: randomId(),
            image: "",
            image_id: "",
            image_name: "",
            source_platform: 0,
            team_id: "",
            type: "canvas_color",
        },
        soundChannelMapping: { audio_channel_mapping: 0, id: randomId(), is_config_open: false, type: "none" },
        vocalSeparation: { choice: 0, id: randomId(), production_path: "", removed_sounds: [], target_type: "none", type: "vocal_separation" },
    };
}

function buildSegment(clip: JianyingDraftClip, materialId: string, targetStartUs: number, renderIndex: number) {
    const duration = Math.max(1, clip.outUs - clip.inUs);
    const companions = buildCompanionMaterials();
    return {
        segment: {
            caption_info: null,
            cartoon: false,
            clip: {
                alpha: 1.0,
                flip: { horizontal: false, vertical: false },
                rotation: 0.0,
                scale: { x: 1.0, y: 1.0 },
                transform: { x: 0.0, y: 0.0 },
            },
            common_keyframes: [],
            enable_adjust: true,
            enable_color_correct_adjust: false,
            enable_color_curves: true,
            enable_color_match_adjust: false,
            enable_color_wheels: true,
            enable_lut: true,
            enable_smart_color_adjust: false,
            extra_material_refs: [companions.speed.id, companions.canvas.id, companions.soundChannelMapping.id, companions.vocalSeparation.id],
            group_id: "",
            hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
            id: randomId(),
            intensifies_audio: false,
            is_placeholder: false,
            is_tone_modify: false,
            keyframe_refs: [],
            last_nonzero_volume: 1.0,
            material_id: materialId,
            render_index: renderIndex,
            responsive_layout: { enable: false, horizontal_pos_layout: 0, size_layout: 0, target_follow: "", vertical_pos_layout: 0 },
            reverse: false,
            source_timerange: { duration, start: Math.max(0, clip.inUs) },
            speed: 1.0,
            target_timerange: { duration, start: Math.max(0, targetStartUs) },
            template_id: "",
            template_scene: "default",
            track_attribute: 0,
            track_render_index: 0,
            uniform_scale: { on: true, value: 1.0 },
            visible: true,
            volume: 1.0,
        },
        companions,
    };
}

/**
 * 生成 `draft_content.json` 的内容。
 *
 * 时间线只有一条 video 轨，片段首尾相接（上一段的 `target_timerange.start + duration`
 * 就是下一段的起点）—— 这正是「按顺序排好、按 in/out 裁好」要的结果。
 */
export function buildJianyingDraftContent(input: JianyingDraftInput) {
    const videos: unknown[] = [];
    const speeds: unknown[] = [];
    const canvases: unknown[] = [];
    const soundChannelMappings: unknown[] = [];
    const vocalSeparations: unknown[] = [];
    const segments: unknown[] = [];

    let cursor = 0;
    input.clips.forEach((clip, index) => {
        const material = buildVideoMaterial(clip);
        const built = buildSegment(clip, material.id, cursor, index);
        videos.push(material);
        speeds.push(built.companions.speed);
        canvases.push(built.companions.canvas);
        soundChannelMappings.push(built.companions.soundChannelMapping);
        vocalSeparations.push(built.companions.vocalSeparation);
        segments.push(built.segment);
        cursor += Math.max(1, clip.outUs - clip.inUs);
    });

    const nowMicro = secondsToMicro(input.createdAt ?? Date.now() / 1000);

    return {
        canvas_config: { height: input.canvasHeight, ratio: "original", width: input.canvasWidth },
        color_space: 0,
        config: {
            adjust_max_index: 1,
            attachment_info: [],
            combination_max_index: 1,
            export_range: null,
            extract_audio_last_index: 1,
            lyrics_recognition_id: "",
            lyrics_sync: true,
            lyrics_taskinfo: [],
            maintrack_adsorb: true,
            material_save_mode: 0,
            multi_language_current: "none",
            multi_language_list: [],
            multi_language_main: "none",
            multi_language_mode: "none",
            original_sound_last_index: 1,
            record_audio_last_index: 1,
            sticker_max_index: 1,
            subtitle_keywords_config: null,
            subtitle_recognition_id: "",
            subtitle_sync: true,
            subtitle_taskinfo: [],
            system_font_list: [],
            video_mute: false,
            zoom_info_params: null,
        },
        cover: null,
        create_time: nowMicro,
        duration: Math.max(1, cursor),
        extra_info: null,
        fps: 30.0,
        free_render_index_mode_on: false,
        group_container: null,
        id: randomId(),
        keyframe_graph_list: [],
        keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
        last_modified_platform: platform("windows"),
        lyrics_effects: [],
        materials: {
            audio_effects: [],
            audio_fades: [],
            audio_keyframes: [],
            audio_track_indexes: [],
            audios: [],
            beats: [],
            canvases,
            chroma_key_materials: [],
            common_mask: [],
            effects: [],
            filters: [],
            hsl: [],
            material_animations: [],
            placeholders: [],
            relation_videos: [],
            sound_channel_mappings: soundChannelMappings,
            speeds,
            stickers: [],
            text_templates: [],
            texts: [],
            transitions: [],
            video_effects: [],
            video_trackings: [],
            videos,
            vocal_beautifys: [],
            vocal_separations: vocalSeparations,
        },
        mutable_config: null,
        name: input.name,
        new_version: "95.0.0",
        platform: platform("windows"),
        relationships: [],
        render_index_track_mode_on: false,
        retouch_cover: null,
        source: "default",
        static_cover_image_path: input.coverFileName ? `${DRAFT_DIR_PLACEHOLDER}\\${input.coverFileName}` : "",
        time_marks: null,
        tracks: [
            {
                attribute: 0,
                flag: 0,
                id: randomId(),
                is_default_name: true,
                name: "",
                segments,
                type: "video",
            },
        ],
        uneven_animation_template_info: { composition: "", content: "", order: "", subtype: "", template_id: "" },
        update_time: nowMicro,
        version: JIANYING_DRAFT_VERSION,
    };
}

/**
 * 生成 `draft_meta_info.json`。
 *
 * 这个文件的路径字段是「草稿列表能不能看到它」的关键：`draft_fold_path` 必须是草稿目录本身、
 * `draft_root_path` 是它的上一层，`draft_json_file` 指向 `draft_content.json`。
 */
export function buildJianyingMetaInfo(input: JianyingDraftInput, totalSeconds: number) {
    const nowMicro = secondsToMicro(input.createdAt ?? Date.now() / 1000);
    return {
        draft_cloud_capcut_purchase_info: "",
        draft_cloud_last_action_download: false,
        draft_cloud_materials: [],
        draft_cloud_purchase_info: "",
        draft_cloud_template_id: "",
        draft_cloud_tutorial_info: "",
        draft_cloud_videocut_purchase_info: "",
        draft_cover: input.coverFileName ? `${DRAFT_DIR_PLACEHOLDER}\\draft_cover.jpg` : "",
        draft_fold_path: DRAFT_DIR_PLACEHOLDER,
        draft_id: randomId(),
        draft_is_ai_shorts: false,
        draft_is_invisible: false,
        draft_json_file: `${DRAFT_DIR_PLACEHOLDER}\\draft_content.json`,
        draft_name: input.name,
        draft_new_version: "",
        draft_removable_storage_device: "",
        draft_root_path: DRAFT_ROOT_PLACEHOLDER,
        draft_timeline_materials_size_: 0,
        draft_type: "",
        tm_draft_cloud_completed: "",
        tm_draft_cloud_modified: 0,
        tm_draft_create: nowMicro,
        tm_draft_modified: nowMicro,
        tm_duration: secondsToMicro(totalSeconds),
        tm_materials_size_: 0,
    };
}

/**
 * 草稿**文件夹名**（不是草稿显示名）必须全 ASCII。
 *
 * `install.bat` 是由浏览器按 UTF-8 写出的纯文本，cmd 默认代码页不是 UTF-8 —— 里面的中文会变成
 * 乱码，`set "NAME=..."` 与 `xcopy` 的目标路径一起崩掉，表现为「双击没反应 / 说找不到路径」。
 * 所以文件夹名只保留 ASCII 可读部分，另加 4 位随机后缀避免覆盖上一次导出的同名草稿；
 * 真正的中文名留在 `draft_meta_info.json` 的 `draft_name` 里，剪映列表显示的是它。
 */
function asciiDraftFolderName(draftName: string) {
    const cleaned = String(draftName || "")
        .replace(/[^A-Za-z0-9 _-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${cleaned || "canvas-draft"}-${suffix}`;
}

/**
 * 随包下发的安装脚本。
 *
 * 干四件事：找到剪映草稿根目录 → 把当前文件夹复制进去 → 把 {@link DRAFT_DIR_PLACEHOLDER}
 * 换成真实绝对路径（并转义成 `\\`）→ 提示重启剪映。
 *
 * 刻意**全英文 + 全 ASCII**：`.bat` 由浏览器以 UTF-8 写入，中文在不带 BOM 的 cmd 里会乱码。
 */
export function buildJianyingInstallScript(draftName: string) {
    const folderName = asciiDraftFolderName(draftName);
    return [
        "@echo off",
        "setlocal",
        `title Install JianYing draft - ${folderName}`,
        `set "NAME=${folderName}"`,
        'set "PKG=%~dp0"',
        'set "ROOT=%LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft"',
        'if exist "%ROOT%\\" goto :found',
        'set "ROOT=%LOCALAPPDATA%\\CapCut\\User Data\\Projects\\com.lveditor.draft"',
        'if exist "%ROOT%\\" goto :found',
        "echo.",
        "echo [ERROR] Draft folder not found.",
        "echo Expected: %LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft",
        "echo Start JianYing once, close it, then run this file again.",
        "echo.",
        "pause",
        "exit /b 1",
        ":found",
        'set "TARGET=%ROOT%\\%NAME%"',
        'if exist "%TARGET%\\" rd /s /q "%TARGET%"',
        'xcopy "%PKG%*" "%TARGET%" /E /I /Y /Q >nul',
        'set "ESCAPED=%TARGET%"',
        'set "ESCAPED=%ESCAPED:\\=\\\\%"',
        'set "ESCAPED_ROOT=%ROOT%"',
        'set "ESCAPED_ROOT=%ESCAPED_ROOT:\\=\\\\%"',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=\'%ESCAPED%\'; $r=\'%ESCAPED_ROOT%\'; Get-ChildItem -LiteralPath \'%TARGET%\' -Filter *.json | ForEach-Object { $c=[IO.File]::ReadAllText($_.FullName); $c=$c.Replace(\'__DRAFT_DIR__\',$p); $c=$c.Replace(\'__DRAFT_ROOT__\',$r); [IO.File]::WriteAllText($_.FullName,$c,(New-Object System.Text.UTF8Encoding $false)) }"',
        "echo.",
        "echo Done. Draft installed to:",
        "echo %TARGET%",
        "echo Restart JianYing and open the draft from the list.",
        "echo.",
        "pause",
        "",
    ].join("\r\n");
}

/** 包内说明。剪映版本一变就可能失效，所以同时给出「手工兜底」的做法。 */
export function buildJianyingReadme(input: JianyingDraftInput, totalSeconds: number) {
    return [
        `剪映草稿：${input.name}`,
        "",
        "一、一键安装（推荐）",
        "  1. 双击同目录下的 install.bat（Windows）。",
        "  2. 看到 Done 后重启剪映，草稿箱里就会出现这个工程。",
        "  3. 脚本会把本文件夹复制到剪映草稿目录，并把 JSON 里的占位路径换成真实绝对路径。",
        "",
        "二、手工安装（脚本失败时）",
        "  1. 把整个文件夹复制到：",
        "     %LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\",
        "  2. 用文本编辑器打开 draft_content.json 与 draft_meta_info.json，",
        "     把其中所有 __DRAFT_DIR__ 替换成这个文件夹的真实绝对路径，",
        "     注意路径分隔符要写成两个反斜杠（\\\\）。",
        "  3. 重启剪映。",
        "",
        "三、时间线",
        `  · 片段数：${input.clips.length}`,
        `  · 总时长：${roundSeconds(totalSeconds)} 秒`,
        `  · 画布：${input.canvasWidth} × ${input.canvasHeight}`,
        "  · 顺序与裁剪都已按画布里的设置写好；素材是原文件，没有重新编码。",
        "",
        "四、说明",
        "  · materials/ 目录里就是各段原片，文件名前缀是它们在时间线上的顺序。",
        "  · 剪映 6.0 起会加密自己的草稿文件；本包写入的是明文草稿，剪映打开后会自动接管。",
        "  · 若剪映提示「草稿损坏」，多半是这个版本对格式更严格：",
        "    可以改用「导入素材」把 materials/ 里的文件按顺序拖进时间线。",
        "",
        "五、时间线清单",
        ...input.clips.map((clip, index) => {
            const length = roundSeconds((clip.outUs - clip.inUs) / MICRO);
            return `  ${String(index + 1).padStart(2, "0")}. ${clip.fileName}  取用 ${roundSeconds(clip.inUs / MICRO)}s - ${roundSeconds(clip.outUs / MICRO)}s（${length}s）`;
        }),
        "",
    ].join("\r\n");
}

export function buildJianyingBundle(input: JianyingDraftInput): JianyingDraftBundle {
    const totalSeconds = input.clips.reduce((sum, clip) => sum + (clip.outUs - clip.inUs) / MICRO, 0);
    return {
        draftContent: buildJianyingDraftContent(input),
        draftMetaInfo: buildJianyingMetaInfo(input, totalSeconds),
        installScript: buildJianyingInstallScript(input.name),
        readme: buildJianyingReadme(input, totalSeconds),
        totalSeconds: roundSeconds(totalSeconds),
    };
}
