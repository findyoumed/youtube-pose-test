// [LOG: 20260327_1246] YouTube Proxy Entry Point
// The client will now handle multiple fallbacks for better stability.

export default async function handler(req, res) {
    const { videoId } = req.query;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") return res.status(200).end();

    if (!videoId || videoId.length !== 11) {
        return res.status(400).json({ error: "Invalid video ID" });
    }

    // 서버 사이드에서는 Cobalt를 기본으로 시도하고, 
    // 실패하더라도 클라이언트에서 여러 인스턴스를 추가 시도하도록 설계됨.
    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        const cobaltResponse = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({ url: videoUrl, videoQuality: "720" })
        });

        const data = await cobaltResponse.json();

        if (data && data.url) {
            console.log(`✅ Cobalt success: ${videoId}`);
            return res.redirect(302, data.url);
        }
    } catch (e) {
        console.warn(`Cobalt failed in API: ${e.message}`);
    }

    // 만약 Cobalt가 실패하면 클라이언트에게 404를 내려주지 않고, 
    // 기본 Invidious 주소로 첫 번째 시도를 유도합니다.
    return res.redirect(302, `https://inv.tux.rs/latest_version?id=${videoId}&itag=18`);
}
