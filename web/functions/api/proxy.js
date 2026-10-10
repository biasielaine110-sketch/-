import { handleProxy } from "../_lib/proxy.js";

export async function onRequest(context) {
    return handleProxy(context.request);
}
