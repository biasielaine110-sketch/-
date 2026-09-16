/**
 * AutoDL ComfyUI audio workflows (e.g. IndexTTS2)
 * Docs: https://autodl.art/docs/comfyui_api/
 * Schema: GET https://autodl.art/api/v1/comfyui/workflows/{workflow_id}
 *
 * indextts2-v1 body:
 *   prompt_text (required string)
 *   prompt_simple (required audio URL — speaker reference)
 *   emo_control_method, emo_ref_audio, emo_* vectors (optional)
 */

export const AUTODL_INDEXTTS_EMO_CONTROL_SAME_AS_VOICE = "与音色参考音频相同";
export const AUTODL_INDEXTTS_EMO_CONTROL_REF_AUDIO = "使用情感参考音频";
export const AUTODL_INDEXTTS_EMO_CONTROL_VECTOR = "使用情感向量控制";

/** Detect AutoDL ComfyUI TTS workflow ids (model name = workflow_id). */
export function isAutodlComfyAudioModel(model: string, baseUrl = ""): boolean {
    const name = String(model || "")
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    if (!name) return false;
    if (/indextts|index[_-]?tts/i.test(name)) return true;
    // Any non-empty workflow on autodl.art used as an audio channel.
    if (/autodl\.art/i.test(baseUrl)) return true;
    return false;
}

export function isAutodlIndexTtsWorkflow(model: string): boolean {
    const name = String(model || "")
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    return /indextts|index[_-]?tts/i.test(name);
}
