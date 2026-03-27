// [LOG: 20260327_1345] Universal Video/CORS Proxy
import fetch from "node-fetch";

export default async function handler(req, res) {
    const { videoId, url } = req.query;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

    // [Case 1] 일반 URL 프록시 (Google Drive 등 CORS 해결용)
    if (url) {
        try {
            console.log(`📡 Proxying URL: ${url}`);
            const response = await fetch(url, {
                headers: { "User-Agent": "Mozilla/5.0" }
            });

            if (!response.ok) throw new Error(`Remote server responded with ${response.status}`);

            // 헤더 복사 (Content-Type 등)
            res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp4");

            // 스트림 파이핑 (Vercel 지원 한도 내)
            return response.body.pipe(res);
        } catch (e) {
            console.error("Proxy error:", e.message);
            return res.status(500).json({ error: "Failed to proxy video", details: e.message });
        }
    }

    // [Case 2] 기존 YouTube Proxy 로직 (ID 기반)
    if (videoId && videoId.length === 11) {
        // ... (기존 Cobalt/Invidious 로직 유지)
        const cobaltResponse = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, videoQuality: "720" })
        });
        const data = await cobaltResponse.json();
        if (data && data.url) return res.redirect(302, data.url);
        return res.redirect(302, `https://inv.tux.rs/latest_version?id=${videoId}&itag=18`);
    }

    return res.status(400).json({ error: "No valid URL or videoId provided" });
}
