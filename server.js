import express from "express";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";

var BLOCKED_MEDIA_HOSTS = [
    /(^|\.)youtube\.com$/i,
    /(^|\.)youtu\.be$/i,
    /(^|\.)youtube-nocookie\.com$/i,
    /(^|\.)googlevideo\.com$/i
];

function isBlockedMediaHost(hostname) {
    return BLOCKED_MEDIA_HOSTS.some(function (pattern) {
        return pattern.test(hostname || "");
    });
}

function normalizeDriveUrl(url) {
    if (!url.includes("drive.google.com")) {
        return url;
    }

    var match = url.match(/\/d\/([^/]+)/) || url.match(/id=([^&]+)/);
    if (match && match[1]) {
        return "https://drive.google.com/uc?export=download&id=" + match[1];
    }
    return url;
}

function parseProxyUrl(raw) {
    try {
        var parsed = new URL(normalizeDriveUrl(raw));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function sendJsonError(res, status, message) {
    res.status(status).json({ error: message });
}

var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);

var app = express();
var PORT = 3001;

app.use(express.static(__dirname));

app.get("/api/video-stream/:videoId", function (req, res) {
    sendJsonError(
        res,
        400,
        "YouTube videoId input is no longer supported. Use a downloadable video URL instead."
    );
});

app.get("/api/video-stream", function (req, res) {
    if (req.query.videoId) {
        sendJsonError(
            res,
            400,
            "YouTube videoId input is no longer supported. Use a downloadable video URL instead."
        );
        return;
    }

    var parsedUrl = parseProxyUrl(req.query.url);
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

        var parsedTarget = parseProxyUrl(targetUrl);
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

        var protocol = parsedTarget.protocol === "https:" ? https : http;
        var requestHeaders = { "User-Agent": "Mozilla/5.0" };
        if (req.headers.range) {
            requestHeaders.Range = req.headers.range;
        }

        protocol.get(targetUrl, { headers: requestHeaders }, function (proxyRes) {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                var nextUrl = proxyRes.headers.location;
                if (!nextUrl.startsWith("http")) {
                    var origin = new URL(targetUrl).origin;
                    nextUrl = origin + nextUrl;
                }
                console.log("Redirecting to:", nextUrl);
                fetchWithRedirect(nextUrl, depth + 1);
                return;
            }

            res.setHeader("Access-Control-Allow-Origin", "*");
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
            req.on("close", function () { proxyRes.destroy(); });
        }).on("error", function (err) {
            if (!res.headersSent) {
                sendJsonError(res, 500, err.message);
            }
        });
    }

    console.log("Proxying (Follow Redirects):", parsedUrl.toString());
    fetchWithRedirect(parsedUrl.toString(), 0);
});

app.listen(PORT, function () {
    console.log("=================================");
    console.log("Pose Test Server");
    console.log("http://localhost:" + PORT);
    console.log("=================================");
});
