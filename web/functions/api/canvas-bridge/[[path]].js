import { handleCanvasBridgeRequest } from "../../_lib/canvas-bridge.js";

export async function onRequest(context) {
    return handleCanvasBridgeRequest(context.request, context.env || {});
}
