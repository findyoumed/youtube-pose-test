// [LOG: 20260327_1235] Cobalt API-based YouTube Proxy
// No more local ytdl-core needed on server, bypassing Vercel IP blocks

export default async function handler(req, res) {
    const { videoId } = req.query;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") return res.status(200).end();

    if (!videoId || videoId.length !== 11) {
        return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`Processing videoId: ${videoId}`);

        // 1. Cobalt API 요청 (가장 안정적인 방식)
        // 불필요한 옵션을 제거하여 성공률을 높임
        try {
            const cobaltResponse = await fetch("https://api.cobalt.tools/api/json", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                body: JSON.stringify({
                    url: videoUrl,
                    videoQuality: "720" // 기본값에 가까운 설정
                })
            });

            const data = await cobaltResponse.json();

            if (data && data.url) {
                console.log(`✅ Cobalt Success: ${videoId}`);
                res.setHeader("Cache-Control", "public, max-age=300");
                return res.redirect(302, data.url);
            } else {
                console.warn(`⚠️ Cobalt failed for ${videoId}: ${JSON.stringify(data)}`);
            }
        } catch (cobaltErr) {
            console.error("❌ Cobalt API error:", cobaltErr.message);
        }

        // 2. Fallback: Invidious Public Instance (Cobalt 실패 시)
        console.log(`🔄 Trying Fallback (Invidious) for ${videoId}`);
        const invidiousUrl = `https://yewtu.be/latest_version?id=${videoId}&itag=18`;

        // Invidious 최신 버전 주소로 바로 리다이렉트
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.redirect(302, invidiousUrl);

    } catch (err) {
        console.error("Critical Proxy error:", err.message);
        return res.status(500).json({
            error: "서버 오류가 발생했습니다.",
            details: err.message
        });
    }
}
