import https from "https";
import http from "http";

const BLOCKED_MEDIA_HOSTS = [
    /(^|\.)youtube\.com$/i,
    /(^|\.)youtu\.be$/i,
    /(^|\.)youtube-nocookie\.com$/i,
    /(^|\.)googlevideo\.com$/i
];

function isBlockedMediaHost(hostname = "") {
    return BLOCKED_MEDIA_HOSTS.some((pattern) => pattern.test(hostname));
}

function normalizeDriveUrl(input) {
    if (!input.includes("drive.google.com")) {
        return input;
    }

    const match = input.match(/\/d\/([^/]+)/) || input.match(/id=([^&]+)/);
    if (match?.[1]) {
        return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
    return input;
}

function parseProxyUrl(raw) {
    try {
        const parsed = new URL(normalizeDriveUrl(raw));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function applyCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
}

function sendJsonError(res, status, message) {
    applyCors(res);
    res.status(status).json({ error: message });
}

export default function handler(req, res) {
    applyCors(res);

    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }

    if (req.query.videoId) {
        sendJsonError(
            res,
            400,
            "YouTube videoId input is no longer supported. Use a downloadable video URL instead."
        );
        return;
    }

    const parsedUrl = parseProxyUrl(req.query.url);
    if (!parsedUrl) {
        sendJsonError(res, 400, "Invalid url parameter.");
        return;
    }

    if (isBlockedMediaHost(parsedUrl.hostname)) {
        sendJsonError(
            res,
            400,
            "YouTube-hosted media cannot be proxied for analysis. Use a downloadable video source instead."
        );
        return;
    }

    function fetchWithRedirect(targetUrl, depth) {
        if (depth > 5) {
            sendJsonError(res, 500, "Too many redirects.");
            return;
        }

        const parsedTarget = parseProxyUrl(targetUrl);
        if (!parsedTarget) {
            sendJsonError(res, 400, "Invalid redirected url.");
            return;
        }
        if (isBlockedMediaHost(parsedTarget.hostname)) {
            sendJsonError(
                res,
                400,
                "The resolved media URL is hosted by YouTube and cannot be analyzed safely."
            );
            return;
        }

        const protocol = parsedTarget.protocol === "https:" ? https : http;
        const requestHeaders = { "User-Agent": "Mozilla/5.0" };
        if (req.headers.range) {
            requestHeaders.Range = req.headers.range;
        }

        protocol.get(targetUrl, { headers: requestHeaders }, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                let nextUrl = proxyRes.headers.location;
                if (!nextUrl.startsWith("http")) {
                    const origin = new URL(targetUrl).origin;
                    nextUrl = origin + nextUrl;
                }
                fetchWithRedirect(nextUrl, depth + 1);
                return;
            }

            res.status(proxyRes.statusCode || 200);
            res.setHeader("Content-Type", proxyRes.headers["content-type"] || "video/mp4");
            res.setHeader("Accept-Ranges", proxyRes.headers["accept-ranges"] || "bytes");
            if (proxyRes.headers["content-length"]) {
                res.setHeader("Content-Length", proxyRes.headers["content-length"]);
            }
            if (proxyRes.headers["content-range"]) {
                res.setHeader("Content-Range", proxyRes.headers["content-range"]);
            }

            proxyRes.pipe(res);
            req.on("close", () => { proxyRes.destroy(); });
        }).on("error", (error) => {
            if (!res.headersSent) {
                sendJsonError(res, 500, error.message);
            }
        });
    }

    fetchWithRedirect(parsedUrl.toString(), 0);
}
