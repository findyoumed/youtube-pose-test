import { Innertube, Platform, UniversalCache } from 'youtubei.js';
import { Readable } from 'stream';
import https from 'https';
import http from 'http';

// 모듈 레벨 캐시 (warm request에서 재사용)
let ytInstance = null;
let evaluatorInstalled = false;
const YT_DOWNLOAD_CLIENTS = ['ANDROID', 'TV', 'IOS', 'WEB'];

function installYoutubeJsEvaluator() {
    if (evaluatorInstalled) return;

    Platform.shim.eval = async (data, env) => {
        const properties = [];

        if (env.n) {
            properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
        }

        if (env.sig) {
            properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
        }

        if (properties.length === 0) {
            return {};
        }

        const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
        return new Function(code)();
    };

    evaluatorInstalled = true;
}

async function getInnertube() {
    installYoutubeJsEvaluator();
    if (!ytInstance) {
        ytInstance = await Innertube.create({
            retrieve_player: true,
            cache: new UniversalCache(false)
        });
    }
    return ytInstance;
}

async function getYouTubeDownloadStream(videoId) {
    const yt = await getInnertube();
    let lastError = null;

    for (const client of YT_DOWNLOAD_CLIENTS) {
        try {
            console.log(`🎬 youtubei.js downloading: ${videoId} via ${client}`);
            const stream = await yt.download(videoId, {
                type: 'video+audio',
                quality: '360p',
                format: 'mp4',
                client
            });
            console.log(`✅ youtubei.js 스트림 획득: ${client}`);
            return { stream, client };
        } catch (error) {
            lastError = error;
            console.error(`⚠️ youtubei.js client ${client} 실패:`, error?.message || String(error));
        }
    }

    throw lastError || new Error('No YouTube client could fetch a playable stream.');
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
            const { stream, client } = await getYouTubeDownloadStream(id);
            console.log(`📡 youtubei.js piping via ${client}`);

            res.status(200);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            Readable.fromWeb(stream).pipe(res);
            req.on('close', () => res.destroy());

        } catch (e) {
            const message = e?.message || String(e);
            console.error('❌ youtubei.js 실패:', e);
            if (!res.headersSent) res.status(502).json({ error: message });
        }
        return;
    }

    res.status(400).json({ error: 'videoId 또는 url 파라미터가 필요합니다' });
}
