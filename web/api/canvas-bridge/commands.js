import { handleCanvasBridge } from "../canvas-bridge.js";

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req, res) {
    await handleCanvasBridge(req, res);
}
