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

        // 1. Cobalt API에 영상 주소 요청
        // Cobalt는 오픈소스 유튜브 우회 서비스로, 직접적인 스트리밍 주소를 반환합니다.
        const cobaltResponse = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                url: videoUrl,
                videoQuality: "360", // 분석용이므로 저화질(빠름) 선호
                downloadMode: "base64" // metadata only
            })
        });

        const data = await cobaltResponse.json();

        // Cobalt가 직접적인 다운로드/스트림 URL을 반환함
        if (data && data.url) {
            console.log(`✅ Cobalt success for ${videoId}: ${data.url.substring(0, 50)}...`);

            // 2. 클라이언트에게 302 리다이렉트로 전달 (서버 부하 0)
            res.setHeader("Cache-Control", "public, max-age=60");
            return res.redirect(302, data.url);
        } else {
            throw new Error(data.text || "Cobalt API failed to provide URL");
        }

    } catch (err) {
        console.error("Proxy error:", err.message);

        // 에러 발생 시 fallback: 사용자에게 직접적인 오류 메시지 전달
        return res.status(500).json({
            error: "유튜브 우회 서버가 일시적으로 응답하지 않습니다.",
            details: err.message
        });
    }
}
