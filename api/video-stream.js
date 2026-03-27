// [LOG: 20260327_1036] YouTube Video Stream Proxy for Vercel
import ytdl from "@distube/ytdl-core";

export default async function handler(req, res) {
    // query에서 videoId를 가져오거나 경로에서 가져오도록 vercel.json에서 설정됨
    const { videoId } = req.query;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // head 요청 등에 대응하기 위해 기본 헤더 설정
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "public, max-age=60");

        if (req.method === "OPTIONS") {
            return res.status(200).end();
        }

        // ytdl을 사용하여 360p(itag 18) 또는 적절한 mp4 스트림 가져오기
        // Vercel은 실행 시간 제한이 있으므로 너무 고화질은 피함 (18번은 보통 360p mp4)
        const stream = ytdl(videoUrl, {
            filter: format => format.container === "mp4" && format.hasVideo && format.hasAudio,
            quality: "highest", // filter를 통해 해상도 제한 가능
            requestOptions: {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                }
            }
        });

        stream.on("info", (info, format) => {
            console.log(`Streaming: ${info.videoDetails.title} (${format.qualityLabel})`);
        });

        stream.on("error", (err) => {
            console.error("ytdl stream error:", err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "Streaming failed" });
            }
        });

        // 클라이언트에 파이핑
        stream.pipe(res);

        // 연결 종료 시 스트림 정리
        req.on("close", () => {
            if (stream.destroy) stream.destroy();
        });

    } catch (err) {
        console.error("Proxy error:", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
}
