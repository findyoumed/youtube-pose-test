// [LOG: 20260328] Edge Runtime - YouTube InnerTube ANDROID + Invidious + URL Proxy
export const config = { runtime: 'edge' };

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

// YouTube InnerTube ANDROID 클라이언트 (PO 토큰 불필요, IP 차단 없음)
async function getYouTubeStreamViaInnerTube(videoId) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': '17.31.35',
            'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        },
        body: JSON.stringify({
            videoId,
            context: {
                client: {
                    clientName: 'ANDROID',
                    clientVersion: '17.31.35',
                    androidSdkVersion: 30,
                    hl: 'en',
                    gl: 'US'
                }
            }
        }),
        signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error(`InnerTube ${res.status}`);
    const data = await res.json();
    const formats = data.streamingData?.formats || [];
    // itag 18 = 360p mp4 combined (video+audio)
    const url = formats.find(f => f.itag === 18)?.url
             || formats.find(f => f.mimeType?.startsWith('video/mp4'))?.url
             || formats[0]?.url;
    if (!url) throw new Error('no format in streamingData');
    return url;
}

const INVIDIOUS_INSTANCES = [
    'https://yewtu.be',
    'https://inv.riverside.rocks',
    'https://invidious.privacydev.net',
    'https://vid.puffyan.us',
    'https://invidious.io'
];

async function tryInvidious(instance, videoId) {
    const r = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const s = d.formatStreams?.find(f => String(f.itag) === '18')
           || d.formatStreams?.find(f => String(f.itag) === '22')
           || d.formatStreams?.[0];
    if (!s?.url) throw new Error('no stream');
    return s.url;
}

async function getYouTubeStreamUrl(videoId) {
    // 1차: InnerTube ANDROID (공식 YouTube API, Edge IP에서 동작)
    try {
        const url = await getYouTubeStreamViaInnerTube(videoId);
        console.log('✅ InnerTube ANDROID 성공');
        return url;
    } catch (e) {
        console.error('⚠️ InnerTube 실패:', e.message);
    }

    // 2차: Invidious 병렬 시도 (Edge IP = AWS IP 아님)
    const tries = INVIDIOUS_INSTANCES.map(inst => tryInvidious(inst, videoId));
    const url = await Promise.any(tries).catch(() => null);
    if (url) console.log('✅ Invidious 성공');
    return url;
}

export default async function handler(req) {
    const { searchParams } = new URL(req.url);
    const videoId = searchParams.get('videoId');
    const proxyUrl = searchParams.get('url');

    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range'
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: cors });
    }

    // [Case 1] URL 프록시 (Google Drive, YouTube 스트림 등)
    if (proxyUrl) {
        const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0' };
        const range = req.headers.get('Range');
        if (range) upstreamHeaders['Range'] = range;

        const upstream = await fetch(proxyUrl, { headers: upstreamHeaders }).catch(e => {
            return new Response(`Proxy error: ${e.message}`, { status: 500, headers: cors });
        });
        if (upstream instanceof Response && !upstream.ok && upstream.status !== 206) {
            return upstream;
        }

        const respHeaders = {
            ...cors,
            'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
            'Accept-Ranges': 'bytes'
        };
        const cl = upstream.headers.get('content-length');
        if (cl) respHeaders['Content-Length'] = cl;
        const cr = upstream.headers.get('content-range');
        if (cr) respHeaders['Content-Range'] = cr;

        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    // [Case 2] YouTube videoId → InnerTube → Invidious → 직접 스트리밍
    if (videoId) {
        const id = extractYouTubeId(videoId);
        if (!id) return new Response('Invalid videoId', { status: 400, headers: cors });

        console.log('🎬 Resolving YouTube:', id);
        const streamUrl = await getYouTubeStreamUrl(id);

        if (!streamUrl) {
            return new Response('YouTube 스트림 URL 획득 실패 (InnerTube/Invidious 모두 실패)', { status: 502, headers: cors });
        }

        console.log('📡 Streaming via Edge:', streamUrl.substring(0, 80));
        const upstream = await fetch(streamUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).catch(e => {
            return new Response(`Stream error: ${e.message}`, { status: 500, headers: cors });
        });

        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                ...cors,
                'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
                'Accept-Ranges': 'bytes'
            }
        });
    }

    return new Response('url 또는 videoId 파라미터가 필요합니다', { status: 400, headers: cors });
}
