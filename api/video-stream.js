// [LOG: 20260327_1112] YouTube Video Stream Proxy for Vercel - Redirect 방식
// Vercel 서버리스 환경: 스트림 직접 파이핑 대신 스트림 URL만 받아서 리다이렉트 처리
import ytdl from "@distube/ytdl-core";

export default async function handler(req, res) {
    const { videoId } = req.query;

    // CORS 헤더 먼저 설정 (OPTIONS 포함)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log("Getting info for:", videoUrl);

        // ytdl로 비디오 정보와 스트림 URL 가져오기
        const info = await ytdl.getInfo(videoUrl, {
            requestOptions: {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9",
                }
            }
        });

        // mp4 + 오디오+비디오 합성 포맷 (itag 18 = 360p, itag 22 = 720p)
        // Vercel 서버리스에서는 스트림 직접 파이핑이 타임아웃 위험 있음
        // 대신 스트림 URL로 리다이렉트해서 브라우저가 직접 가져가게 함
        const format = ytdl.chooseFormat(info.formats, {
            quality: [18, 22],
            filter: "audioandvideo"
        });

        if (!format || !format.url) {
            return res.status(500).json({ error: "No suitable format found" });
        }

        console.log("Redirecting to format:", format.qualityLabel, format.container);

        // 302 리다이렉트: 브라우저가 YouTube CDN에서 직접 가져감
        // 주의: 이 방식은 CORS 정책에 따라 브라우저에서 crossorigin 요청에 제한이 있을 수 있음
        res.setHeader("Cache-Control", "public, max-age=30");
        res.redirect(302, format.url);

    } catch (err) {
        console.error("Proxy error:", err.message, err.stack);
        return res.status(500).json({
            error: err.message,
            hint: "ytdl-core may be blocked by YouTube on this server IP"
        });
    }
}
