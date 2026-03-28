// [LOG: 20260327_1016] YouTube Pose Detection Test Server - yt-dlp 기반
import express from "express";
import { spawn } from "child_process";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";

// [YouTube 헬퍼] Invidious를 통한 직접 스트림 URL 획득
var INVIDIOUS_INSTANCES = [
    "https://inv.tux.rs",
    "https://invidious.nerdvpn.de",
    "https://yt.cdaut.de",
    "https://invidious.slipfox.xyz"
];

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

function fetchJson(url) {
    return new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { reject(new Error("timeout")); }, 5000);
        https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, function(r) {
            var data = "";
            r.on("data", function(d) { data += d; });
            r.on("end", function() {
                clearTimeout(timeout);
                if (r.statusCode !== 200) return reject(new Error(String(r.statusCode)));
                try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
            });
        }).on("error", function(e) { clearTimeout(timeout); reject(e); });
    });
}

function getYouTubeStreamUrlLocal(videoId) {
    var promises = INVIDIOUS_INSTANCES.map(function(instance) {
        return fetchJson(instance + "/api/v1/videos/" + videoId).then(function(data) {
            var streams = data.formatStreams || [];
            var stream = streams.find(function(f) { return String(f.itag) === "18"; })
                      || streams.find(function(f) { return String(f.itag) === "22"; })
                      || streams[0];
            if (!stream || !stream.url) throw new Error("no stream url");
            return stream.url;
        });
    });
    return Promise.any(promises).catch(function() { return null; });
}

var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);

var app = express();
var PORT = 3001;

app.use(express.static(__dirname));

// yt-dlp로 스트림 URL 획득
function getStreamUrl(videoId) {
    return new Promise(function (resolve, reject) {
        var videoUrl = "https://www.youtube.com/watch?v=" + videoId;

        // 18 = 360p mp4(video+audio), 없으면 video-only 최저해상도 mp4
        var ytdlp = spawn("python", [
            "-m", "yt_dlp",
            "-f", "18/bestvideo[height<=480][ext=mp4]/bestvideo[height<=480]/best[height<=480]",
            "--no-playlist",
            "-g",
            videoUrl
        ]);

        var stdout = "";
        var stderr = "";

        ytdlp.stdout.on("data", function (d) { stdout += d.toString(); });
        ytdlp.stderr.on("data", function (d) { stderr += d.toString(); });

        ytdlp.on("close", function (code) {
            if (code !== 0 || !stdout.trim()) {
                reject(new Error("yt-dlp 실패: " + stderr.slice(0, 300)));
                return;
            }
            // -g가 두 줄(video+audio adaptive)을 반환할 때는 첫 줄(video)만 사용
            var url = stdout.trim().split("\n")[0];
            resolve(url);
        });
    });
}

// YouTube 영상 프록시 엔드포인트 (Legacy 정규식 매칭)
app.get("/api/video-stream/:videoId", function (req, res) {
    var videoId = req.params.videoId;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        res.status(400).json({ error: "Invalid video ID" });
        return;
    }
    handleYouTubeProxy(videoId, res, req);
});

// [LOG: 20260327_1350] 리다이렉트를 추적하는 범용 프록시
app.get("/api/video-stream", function (req, res) {
    // [Case: YouTube videoId] Invidious를 통해 직접 스트림 URL 획득 후 redirect
    var videoId = req.query.videoId;
    if (videoId) {
        var id = extractYouTubeId(videoId);
        if (!id) return res.status(400).json({ error: "Invalid YouTube videoId" });
        console.log("🎬 Resolving YouTube via Invidious:", id);
        getYouTubeStreamUrlLocal(id).then(function(streamUrl) {
            if (streamUrl) {
                console.log("✅ Invidious 성공, redirect:", streamUrl.substring(0, 80) + "...");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Cache-Control", "no-store");
                return res.redirect(302, streamUrl);
            }
            console.log("⚠️ Invidious 실패 → yt-dlp fallback...");
            handleYouTubeProxy(id, res, req);
        }).catch(function(err) {
            console.log("⚠️ Invidious 오류:", err.message, "→ yt-dlp fallback...");
            handleYouTubeProxy(id, res, req);
        });
        return;
    }

    var url = req.query.url;
    if (!url) return res.status(400).json({ error: "No URL provided" });

    if (url.includes("drive.google.com")) {
        var match = url.match(/\/d\/([^/]+)/) || url.match(/id=([^&]+)/);
        if (match && match[1]) url = "https://drive.google.com/uc?export=download&id=" + match[1];
    }

    console.log("Proxying (Follow Redirects):", url);

    function fetchWithRedirect(targetUrl, depth) {
        if (depth > 5) {
            res.status(500).json({ error: "Too many redirects" });
            return;
        }

        var protocol = targetUrl.startsWith("https") ? https : http;
        protocol.get(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        }, function (proxyRes) {
            // 리다이렉트 처리 (301, 302)
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                var nextUrl = proxyRes.headers.location;
                if (!nextUrl.startsWith("http")) { // 상대 경로 처리
                    var origin = new URL(targetUrl).origin;
                    nextUrl = origin + nextUrl;
                }
                console.log("Redirecting to:", nextUrl);
                fetchWithRedirect(nextUrl, depth + 1);
                return;
            }

            // 최종 응답 파이핑
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", proxyRes.headers["content-type"] || "video/mp4");
            if (proxyRes.headers["content-length"]) res.setHeader("Content-Length", proxyRes.headers["content-length"]);
            if (proxyRes.headers["accept-ranges"]) res.setHeader("Accept-Ranges", proxyRes.headers["accept-ranges"]);

            proxyRes.pipe(res);
            req.on("close", function () { proxyRes.destroy(); });
        }).on("error", function (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message });
        });
    }

    fetchWithRedirect(url, 0);
});

// 기존 YouTube 로직 모듈화
function handleYouTubeProxy(videoId, res, req) {
    getStreamUrl(videoId).then(function (streamUrl) {
        var protocol = streamUrl.startsWith("https") ? https : http;
        protocol.get(streamUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.youtube.com/",
                "Origin": "https://www.youtube.com"
            }
        }, function (proxyRes) {
            res.setHeader("Content-Type", proxyRes.headers["content-type"] || "video/mp4");
            res.setHeader("Access-Control-Allow-Origin", "*");
            proxyRes.pipe(res);
            req.on("close", function () { proxyRes.destroy(); });
        });
    }).catch(function (err) {
        res.status(500).json({ error: err.message });
    });
}

app.listen(PORT, function () {
    console.log("=================================");
    console.log("YouTube Pose Test Server (yt-dlp)");
    console.log("http://localhost:" + PORT);
    console.log("=================================");
});
