import { Innertube } from 'youtubei.js';
import express from "express";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";

// 모듈 레벨 캐시 (warm request에서 재사용)
var ytInstance = null;
async function getInnertube() {
    if (!ytInstance) ytInstance = await Innertube.create({ retrieve_player: true });
    return ytInstance;
}

function extractYouTubeId(input) {
    var patterns = [
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /shorts\/([A-Za-z0-9_-]{11})/,
        /embed\/([A-Za-z0-9_-]{11})/,
        /^([A-Za-z0-9_-]{11})$/
    ];
    for (var p of patterns) {
        var m = input.match(p);
        if (m) return m[1];
    }
    return null;
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

app.get("/api/video-stream", async function (req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");

    if (req.method === "OPTIONS") { res.status(200).end(); return; }

    // [Case 1] YouTube videoId → youtubei.js
    if (req.query.videoId) {
        var id = extractYouTubeId(req.query.videoId);
        if (!id) { sendJsonError(res, 400, "Invalid videoId"); return; }

        try {
            console.log("🎬 youtubei.js resolving:", id);
            var yt = await getInnertube();
            var info = await yt.getBasicInfo(id, 'WEB');
            var formats = [
                ...(info.streaming_data?.formats || []),
                ...(info.streaming_data?.adaptive_formats || [])
            ];

            var format = formats.find(function(f) { return f.itag === 18; })
                      || formats.find(function(f) { return f.mime_type?.includes('video/mp4') && f.has_audio && f.has_video; })
                      || formats[0];

            if (!format) throw new Error("No suitable format found");

            var streamUrl = format.decipher(yt.session.player);
            console.log("✅ youtubei.js 성공, streaming:", streamUrl.substring(0, 80));

            https.get(streamUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://www.youtube.com/",
                    "Accept": "*/*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Dest": "video"
                }
            }, function(upstream) {
                res.status(upstream.statusCode || 200);
                res.setHeader("Content-Type", upstream.headers["content-type"] || "video/mp4");
                res.setHeader("Accept-Ranges", "bytes");
                if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
                upstream.pipe(res);
                req.on("close", function() { upstream.destroy(); });
            }).on("error", function(e) {
                if (!res.headersSent) sendJsonError(res, 500, e.message);
            });

        } catch(e) {
            console.error("❌ youtubei.js 실패:", e.message);
            if (!res.headersSent) sendJsonError(res, 502, e.message);
        }
        return;
    }

    // [Case 2] URL 프록시 (Google Drive 등)
    var parsedUrl = parseProxyUrl(req.query.url);
    if (!parsedUrl) {
        sendJsonError(res, 400, "videoId 또는 url 파라미터가 필요합니다.");
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
    console.log("Pose Test Server (youtubei.js)");
    console.log("http://localhost:" + PORT);
    console.log("=================================");
});
