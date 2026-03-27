// [LOG: 20260327_1016] YouTube Pose Detection Test Server - yt-dlp 기반
import express from "express";
import { spawn } from "child_process";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname } from "path";

var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);

var app = express();
var PORT = 3000;

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
