// Production CORS bypass for remote API / media fetches.
// Browser calls same-origin /api/proxy?target=<url>; this function fetches server-side.

export const config = {
    api: {
        bodyParser: false,
        responseLimit: false,
    },
    maxDuration: 60,
};

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
        res.end();
        return;
    }

    try {
        const requestUrl = new URL(req.url || "", "http://localhost");
        const target = requestUrl.searchParams.get("target");
        if (!target) {
            res.statusCode = 400;
            res.end("missing target");
            return;
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            res.statusCode = 400;
            res.end("invalid target");
            return;
        }

        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
            res.statusCode = 400;
            res.end("unsupported protocol");
            return;
        }

        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!value) continue;
            const lower = key.toLowerCase();
            if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(lower)) continue;
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
        headers.host = targetUrl.host;

        const method = req.method || "GET";
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readRequestBody(req) : undefined;

        const upstream = await fetch(targetUrl, {
            method,
            headers,
            body: body ? new Uint8Array(body) : undefined,
            signal: AbortSignal.timeout(55_000),
        });

        res.statusCode = upstream.status;
        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) return;
            res.setHeader(key, value);
        });

        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.end(buffer);
    } catch (error) {
        res.statusCode = 502;
        res.end(`proxy error: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer | undefined>}
 */
function readRequestBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
        req.on("error", () => resolve(undefined));
    });
}
