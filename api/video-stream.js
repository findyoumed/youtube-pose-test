import { Innertube } from 'youtubei.js';
import https from 'https';
import http from 'http';

// 모듈 레벨 캐시 (warm request에서 재사용)
let ytInstance = null;

async function getInnertube() {
    if (!ytInstance) {
        ytInstance = await Innertube.create({ retrieve_player: true });
    }
    return ytInstance;
}

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

function normalizeDriveUrl(input) {
    if (!input.includes('drive.google.com')) return input;
    const match = input.match(/\/d\/([^/]+)/) || input.match(/id=([^&]+)/);
    if (match?.[1]) return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    return input;
}

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
}

export default async function handler(req, res) {
    applyCors(res);
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { videoId, url } = req.query;

    // [Case 1] URL 프록시 (Google Drive 등)
    if (url) {
        const targetUrl = normalizeDriveUrl(url);
        try { new URL(targetUrl); } catch { res.status(400).json({ error: 'Invalid url' }); return; }

        function fetchWithRedirect(target, depth) {
            if (depth > 5) { res.status(500).json({ error: 'Too many redirects' }); return; }
            const protocol = target.startsWith('https') ? https : http;
            const reqHeaders = { 'User-Agent': 'Mozilla/5.0' };
            if (req.headers.range) reqHeaders.Range = req.headers.range;
            protocol.get(target, { headers: reqHeaders }, (proxyRes) => {
                if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                    let next = proxyRes.headers.location;
                    if (!next.startsWith('http')) next = new URL(target).origin + next;
                    fetchWithRedirect(next, depth + 1);
                    return;
                }
                res.status(proxyRes.statusCode || 200);
                res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
                res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges'] || 'bytes');
                if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
                if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
                proxyRes.pipe(res);
                req.on('close', () => proxyRes.destroy());
            }).on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
        }
        fetchWithRedirect(targetUrl, 0);
        return;
    }

    // [Case 2] YouTube videoId → youtubei.js
    if (videoId) {
        const id = extractYouTubeId(videoId);
        if (!id) { res.status(400).json({ error: 'Invalid videoId' }); return; }

        try {
            console.log('🎬 youtubei.js resolving:', id);
            const yt = await getInnertube();

            // WEB 클라이언트 (로컬/서버 모두 작동 확인)
            const info = await yt.getBasicInfo(id, 'WEB');
            const formats = [
                ...(info.streaming_data?.formats || []),
                ...(info.streaming_data?.adaptive_formats || [])
            ];

            // itag 18 = 360p mp4 (video+audio combined) 우선
            const format = formats.find(f => f.itag === 18)
                        || formats.find(f => f.mime_type?.includes('video/mp4') && f.has_audio && f.has_video)
                        || formats[0];

            if (!format) throw new Error('No suitable format found');

            // signatureCipher + nsig 자동 복호화
            const streamUrl = format.decipher(yt.session.player);
            console.log('✅ youtubei.js 성공, streaming...');

            // 스트리밍 프록시 (첫 바이트 전송 후 Vercel timeout 미적용)
            https.get(streamUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.youtube.com/',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'video'
                }
            }, (upstream) => {
                res.status(upstream.statusCode || 200);
                res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
                res.setHeader('Accept-Ranges', 'bytes');
                if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
                upstream.pipe(res);
                req.on('close', () => upstream.destroy());
            }).on('error', (e) => {
                if (!res.headersSent) res.status(500).json({ error: e.message });
            });

        } catch (e) {
            console.error('❌ youtubei.js 실패:', e.message);
            if (!res.headersSent) res.status(502).json({ error: e.message });
        }
        return;
    }

    res.status(400).json({ error: 'videoId 또는 url 파라미터가 필요합니다' });
}
