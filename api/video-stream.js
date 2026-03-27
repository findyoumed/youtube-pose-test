// [LOG: 20260327_1127] YouTube Video Stream Proxy with Cookie support
import ytdl from "@distube/ytdl-core";

export default async function handler(req, res) {
    const { videoId } = req.query;
    const userCookie = req.headers["x-youtube-cookie"] || "";

    // CORS 헤더 설정
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "x-youtube-cookie, content-type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // ytdl 옵션 설정: 사용자가 제공한 쿠키 포함
        const requestOptions = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            }
        };

        if (userCookie) {
            requestOptions.headers["Cookie"] = userCookie;
            console.log("Using provided user cookie for video:", videoId);
        } else {
            console.log("No cookie provided, may be blocked by YouTube bot detection.");
        }

        // 비디오 정보 가져오기
        const info = await ytdl.getInfo(videoUrl, { requestOptions });

        // 화질 선택 (360p mp4 itag 18 우선)
        const format = ytdl.chooseFormat(info.formats, {
            quality: [18, 22],
            filter: "audioandvideo"
        });

        if (!format || !format.url) {
            throw new Error("No suitable format found");
        }

        // 302 리다이렉트 (Vercel 타임아웃 방지)
        res.setHeader("Cache-Control", "public, max-age=30");
        res.redirect(302, format.url);

    } catch (err) {
        console.error("Proxy error:", err.message);

        let errorMessage = err.message;
        let hint = "Try updating your YouTube cookie in the application settings.";

        if (err.message.includes("Sign in to confirm")) {
            errorMessage = "YouTube bot detection triggered. Please provide a fresh login cookie.";
        }

        return res.status(500).json({
            error: errorMessage,
            hint: hint
        });
    }
}
