import { Innertube, Platform, UniversalCache } from 'youtubei.js';
import { Readable } from 'stream';
import express from "express";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";

// 모듈 레벨 캐시 (warm request에서 재사용)
var ytInstance = null;
var evaluatorInstalled = false;
var YT_DOWNLOAD_CLIENTS = ['ANDROID', 'TV', 'IOS', 'WEB'];

function installYoutubeJsEvaluator() {
    if (evaluatorInstalled) return;

    Platform.shim.eval = async function (data, env) {
        var properties = [];

        if (env.n) {
            properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
        }

        if (env.sig) {
            properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
        }

        if (properties.length === 0) {
            return {};
        }

        var code = `${data.output}\nreturn { ${properties.join(', ')} }`;
        return new Function(code)();
    };

    evaluatorInstalled = true;
}

async function getInnertube() {
    installYoutubeJsEvaluator();
    if (!ytInstance) {
        ytInstance = await Innertube.create({
            retrieve_player: true,
            cache: new UniversalCache(false)
        });
    }
    return ytInstance;
}

async function getYouTubeDownloadStream(videoId) {
    var yt = await getInnertube();
    var lastError = null;

    for (const client of YT_DOWNLOAD_CLIENTS) {
        try {
            console.log(`🎬 youtubei.js downloading: ${videoId} via ${client}`);
            const stream = await yt.download(videoId, {
                type: 'video+audio',
                quality: '360p',
                format: 'mp4',
                client
            });
            console.log(`✅ youtubei.js 스트림 획득: ${client}`);
            return { stream, client };
        } catch (error) {
            lastError = error;
            console.error(`⚠️ youtubei.js client ${client} 실패:`, error?.message || String(error));
        }
    }

    throw lastError || new Error("No YouTube client could fetch a playable stream.");
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
var PORT = Number(process.env.PORT || 3001);

app.use(express.static(__dirname));

app.get("/health", function (_req, res) {
    res.status(200).json({ ok: true });
});

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
            const { stream, client } = await getYouTubeDownloadStream(id);
            console.log(`📡 youtubei.js piping via ${client}`);

            res.status(200);
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Accept-Ranges", "bytes");
            Readable.fromWeb(stream).pipe(res);
            req.on("close", function() { res.destroy(); });

        } catch(e) {
            var message = e?.message || String(e);
            console.error("❌ youtubei.js 실패:", e);
            if (!res.headersSent) sendJsonError(res, 502, message);
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

app.get("/api/youtube-url", async function (req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") { res.status(200).end(); return; }

    var videoId = req.query.videoId;
    if (!videoId) { sendJsonError(res, 400, "videoId required"); return; }

    var id = extractYouTubeId(videoId);
    if (!id) { sendJsonError(res, 400, "Invalid videoId"); return; }

    var yt = await getInnertube();
    var lastError = null;

    for (const client of YT_DOWNLOAD_CLIENTS) {
        try {
            console.log(`🔍 youtube-url: ${id} via ${client}`);
            const info = await yt.getBasicInfo(id, client);
            const formats = [
                ...(info.streaming_data?.formats || []),
                ...(info.streaming_data?.adaptive_formats || [])
            ];
            const format = formats.find(f => f.itag === 18)
                        || formats.find(f => f.mime_type?.startsWith("video/mp4"));
            if (!format) throw new Error("No suitable format");
            const url = format.decipher(yt.session.player);
            const mimeType = (format.mime_type || "video/mp4").split(";")[0].trim();
            console.log(`✅ URL extracted via ${client}`);
            res.status(200).json({ url, mimeType });
            return;
        } catch (err) {
            lastError = err;
            console.error(`⚠️ ${client}:`, err?.message);
        }
    }

    sendJsonError(res, 502, lastError?.message || "URL extraction failed");
});

app.listen(PORT, "0.0.0.0", function () {
    console.log("=================================");
    console.log("Pose Test Server (youtubei.js)");
    console.log("http://0.0.0.0:" + PORT);
    console.log("=================================");
});
