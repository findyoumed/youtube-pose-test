// [LOG: 20260328] Universal Video/CORS Proxy + YouTube (ytdl-core + Invidious + Piped + Cobalt)
import fetch from "node-fetch";
import ytdl from "@distube/ytdl-core";

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
    "https://yewtu.be",
    "https://invidious.io",
    "https://inv.riverside.rocks",
    "https://invidious.privacydev.net",
    "https://vid.puffyan.us"
];

async function tryInvidious(instance, videoId) {
    const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const stream = data.formatStreams?.find(f => String(f.itag) === "18")
                || data.formatStreams?.find(f => String(f.itag) === "22")
                || data.formatStreams?.[0];
    if (!stream?.url) throw new Error("no stream url");
    return stream.url;
}

async function getYouTubeUrlViaPiped(videoId) {
    const res = await fetch(`https://pipedapi.kavin.rocks/streams/${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const s = data.videoStreams?.find(s => s.quality === "360p" && s.mimeType?.includes("mp4"))
            || data.videoStreams?.find(s => s.mimeType?.includes("mp4"))
            || data.videoStreams?.[0];
    if (!s?.url) throw new Error("no stream url");
    return s.url;
}

async function getYouTubeUrlViaCobalt(videoId) {
    try {
        const res = await fetch("https://api.cobalt.tools/", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                videoQuality: "360"
            }),
            signal: AbortSignal.timeout(3000)
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (["redirect", "stream", "tunnel"].includes(data.status) && data.url) {
            return data.url;
        }
        return null;
    } catch {
        return null;
    }
}

async function resolveYouTubeViaYtdl(videoId) {
    const info = await ytdl.getInfo(videoId);
    const formats = info.formats;
    // itag 18 (360p mp4 combined) 우선, 없으면 audioandvideo mp4, 없으면 video-only mp4
    const format = formats.find(f => f.itag === 18)
                || formats.find(f => f.hasVideo && f.hasAudio && f.container === "mp4")
                || formats.find(f => f.hasVideo && f.container === "mp4");
    if (!format?.url) throw new Error("no format found");
    console.log(`✅ ytdl-core 성공: itag=${format.itag} ${format.qualityLabel || ""}`);
    return format.url;
}

async function resolveYouTubeUrl(videoId) {
    // 1차: ytdl-core (YouTube InnerTube API 직접)
    try {
        const url = await resolveYouTubeViaYtdl(videoId);
        if (url) return url;
    } catch (e) {
        console.log("⚠️ ytdl-core 실패:", e.message.substring(0, 100));
    }

    // 2차: Invidious 5개 + Piped 병렬 시도 (4초 타임아웃)
    const tries = [
        ...INVIDIOUS_INSTANCES.map(inst => tryInvidious(inst, videoId)),
        getYouTubeUrlViaPiped(videoId)
    ];
    const url = await Promise.any(tries).catch(() => null);
    if (url) return url;

    // 3차: Cobalt fallback (3초 타임아웃)
    console.log("⚠️ Invidious+Piped 모두 실패 → Cobalt fallback...");
    return getYouTubeUrlViaCobalt(videoId);
}

export default async function handler(req, res) {
    const { videoId, url } = req.query;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    if (req.method === "OPTIONS") return res.status(200).end();

    // [Case 1] URL 프록시 (Google Drive, YouTube 스트림 등) - Range 지원
    if (url) {
        try {
            console.log(`📡 Proxying URL: ${url.substring(0, 80)}...`);
            const upstreamHeaders = { "User-Agent": "Mozilla/5.0" };
            if (req.headers.range) {
                upstreamHeaders["Range"] = req.headers.range;
            }

            const response = await fetch(url, { headers: upstreamHeaders });

            if (!response.ok && response.status !== 206) {
                throw new Error(`Upstream responded with ${response.status}`);
            }

            res.status(response.status);
            res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp4");
            const cl = response.headers.get("content-length");
            if (cl) res.setHeader("Content-Length", cl);
            const cr = response.headers.get("content-range");
            if (cr) res.setHeader("Content-Range", cr);
            res.setHeader("Accept-Ranges", response.headers.get("accept-ranges") || "bytes");

            return response.body.pipe(res);
        } catch (e) {
            console.error("Proxy error:", e.message);
            return res.status(500).json({ error: "Failed to proxy video", details: e.message });
        }
    }

    // [Case 2] YouTube: URL 획득 후 자체 프록시로 redirect (CORS 보장)
    if (videoId) {
        const id = extractYouTubeId(videoId);
        if (!id) return res.status(400).json({ error: "유효하지 않은 YouTube videoId입니다" });

        console.log(`🎬 Resolving YouTube: ${id}`);
        const streamUrl = await resolveYouTubeUrl(id);

        if (!streamUrl) {
            return res.status(502).json({ error: "YouTube 스트림 URL 획득 실패 (Invidious/Piped/Cobalt 모두 실패)" });
        }

        // 외부 URL이 아닌 자체 프록시로 redirect → CORS 완전 보장
        console.log(`✅ Proxying via self: ${streamUrl.substring(0, 80)}...`);
        const selfProxy = `/api/video-stream?url=${encodeURIComponent(streamUrl)}`;
        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, selfProxy);
    }

    return res.status(400).json({ error: "url 또는 videoId 파라미터가 필요합니다" });
}
