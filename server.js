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

app.use(express.static("public"));

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

// YouTube 영상 프록시 엔드포인트
app.get("/api/video-stream/:videoId", function (req, res) {
    var videoId = req.params.videoId;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        res.status(400).json({ error: "Invalid video ID" });
        return;
    }

    console.log("Proxy request for:", videoId);

    getStreamUrl(videoId).then(function (streamUrl) {
        console.log("DEBUG: Got stream URL, proxying...");

        var protocol = streamUrl.startsWith("https") ? https : http;

        protocol.get(streamUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://www.youtube.com/",
                "Origin": "https://www.youtube.com"
            }
        }, function (proxyRes) {
            res.setHeader("Content-Type", proxyRes.headers["content-type"] || "video/mp4");
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Cache-Control", "public, max-age=60");

            if (proxyRes.headers["content-length"]) {
                res.setHeader("Content-Length", proxyRes.headers["content-length"]);
            }

            proxyRes.pipe(res);

            req.on("close", function () {
                proxyRes.destroy();
            });

        }).on("error", function (err) {
            console.error("Proxy stream error:", err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "Stream failed: " + err.message });
            }
        });

    }).catch(function (err) {
        console.error("!!! PROXY ERROR !!!", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    });
});

app.listen(PORT, function () {
    console.log("=================================");
    console.log("YouTube Pose Test Server (yt-dlp)");
    console.log("http://localhost:" + PORT);
    console.log("=================================");
});
