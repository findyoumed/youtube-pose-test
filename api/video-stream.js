// [LOG: 20260328] Universal Video/CORS Proxy + YouTube via Invidious
import fetch from "node-fetch";

function extractYouTubeId(input) {
    const patterns = [
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /shorts\/([A-Za-z0-9_-]{11})/,
        /embed\/([A-Za-z0-9_-]{11})/,
        /^([A-Za-z0-9_-]{11})$/
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m) return m[1];
    }
    return null;
}

const INVIDIOUS_INSTANCES = [
    "https://inv.tux.rs",
    "https://invidious.nerdvpn.de",
    "https://yt.cdaut.de",
    "https://invidious.slipfox.xyz"
];

async function getYouTubeStreamUrl(videoId) {
    const tryInstance = async (instance) => {
        const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        // formatStreams = muxed video+audio (직접 재생 가능)
        // itag 18 = 360p MP4, itag 22 = 720p MP4
        const stream = data.formatStreams?.find(f => String(f.itag) === "18")
                    || data.formatStreams?.find(f => String(f.itag) === "22")
                    || data.formatStreams?.[0];
        if (!stream?.url) throw new Error("no stream url");
        return stream.url;
    };
    return Promise.any(INVIDIOUS_INSTANCES.map(tryInstance)).catch(() => null);
}

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

            res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp4");
            return response.body.pipe(res);
        } catch (e) {
            console.error("Proxy error:", e.message);
            return res.status(500).json({ error: "Failed to proxy video", details: e.message });
        }
    }

    // [Case 2] YouTube (Invidious JSON API → redirect to direct stream URL)
    if (videoId) {
        const id = extractYouTubeId(videoId);
        if (!id) return res.status(400).json({ error: "유효하지 않은 YouTube videoId입니다" });

        console.log(`🎬 Resolving YouTube: ${id}`);
        const streamUrl = await getYouTubeStreamUrl(id);

        if (!streamUrl) {
            return res.status(502).json({ error: "모든 Invidious 인스턴스에서 영상 URL을 가져오지 못했습니다" });
        }

        console.log(`✅ Redirecting to: ${streamUrl.substring(0, 80)}...`);
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, streamUrl);
    }

    return res.status(400).json({ error: "url 또는 videoId 파라미터가 필요합니다" });
}
