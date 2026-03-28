import { Innertube, Platform, UniversalCache } from 'youtubei.js';

let ytInstance = null;
let evaluatorInstalled = false;
const YT_CLIENTS = ['ANDROID', 'TV', 'IOS', 'WEB'];

function installEvaluator() {
    if (evaluatorInstalled) return;
    Platform.shim.eval = async (data, env) => {
        const properties = [];
        if (env.n) properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
        if (env.sig) properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
        if (properties.length === 0) return {};
        const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
        return new Function(code)();
    };
    evaluatorInstalled = true;
}

async function getInnertube() {
    installEvaluator();
    if (!ytInstance) {
        ytInstance = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false) });
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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { videoId } = req.query;
    if (!videoId) { res.status(400).json({ error: 'videoId required' }); return; }

    const id = extractYouTubeId(videoId);
    if (!id) { res.status(400).json({ error: 'Invalid videoId' }); return; }

    let lastError = null;
    const yt = await getInnertube();

    for (const client of YT_CLIENTS) {
        try {
            console.log(`🔍 youtube-url: ${id} via ${client}`);
            const info = await yt.getBasicInfo(id, client);
            const formats = [
                ...(info.streaming_data?.formats || []),
                ...(info.streaming_data?.adaptive_formats || [])
            ];

            // itag 18 = 360p mp4 video+audio combined
            const format = formats.find(f => f.itag === 18)
                        || formats.find(f => f.mime_type?.startsWith('video/mp4'));

            if (!format) throw new Error('No suitable format');

            const url = format.decipher(yt.session.player);
            const mimeType = (format.mime_type || 'video/mp4').split(';')[0].trim();

            console.log(`✅ URL extracted via ${client}`);
            res.status(200).json({ url, mimeType });
            return;
        } catch (err) {
            lastError = err;
            console.error(`⚠️ ${client}:`, err?.message);
        }
    }

    res.status(502).json({ error: lastError?.message || 'URL extraction failed' });
}
