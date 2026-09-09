const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const TMP_DIR = path.join(__dirname, '../data/tmp');
const MAX_CONCURRENT = 8;
const UPLOAD_DELAY = 3000;

const MAX_UPLOAD_BYTES   = 100 * 1024 * 1024;
const TARGET_UPLOAD_BYTES = 95 * 1024 * 1024;
const CLEANUP_MAX_AGE_MS = 20 * 60 * 1000;
const CLEANUP_INTERVAL   = 5 * 60 * 1000;
const MAX_DISK_MB        = 500;

const BITRATE_LADDER = [128, 96, 64, 48, 32];

const MAX_AUDIO_BITRATE = 128;
const MIN_AUDIO_BITRATE = 32;

function calculateOptimalBitrate(durationSec) {
    if (!durationSec || durationSec <= 0) return MAX_AUDIO_BITRATE;

    const safetyFactor = 0.95;
    const maxBitrateKbps = Math.floor(
        (TARGET_UPLOAD_BYTES * 8 * safetyFactor) / (durationSec * 1000)
    );

    const optimal = Math.max(MIN_AUDIO_BITRATE, Math.min(MAX_AUDIO_BITRATE, maxBitrateKbps));

    console.log(
        `🎯 [Bitrate] Durasi: ${durationSec}s → ` +
        `Target: ${optimal}kbps (raw max: ${maxBitrateKbps}kbps)`
    );

    return optimal;
}

function getVideoInfo(url) {
    const ytDlp = getYtDlp();
    const userAgent = getRandomUserAgent();

    const raw = execSync(
        `"${ytDlp}" ${YTDLP_FLAGS} --user-agent "${userAgent}" --dump-json --skip-download "${url}"`,
        { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const jsonLine = raw.trim().split('\n').find(l => l.trim().startsWith('{'));
    if (!jsonLine) throw new Error('Cannot parse video info');

    return JSON.parse(jsonLine);
}

const activeFiles = new Set();

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function markActive(filePath) {
    const resolved = path.resolve(filePath);
    activeFiles.add(resolved);
    console.log(`📌 [ActiveFile] Marked: ${path.basename(resolved)} (${activeFiles.size} active)`);
    return resolved;
}

function unmarkActive(filePath) {
    const resolved = path.resolve(filePath);
    activeFiles.delete(resolved);
    console.log(`📌 [ActiveFile] Unmarked: ${path.basename(resolved)} (${activeFiles.size} active)`);
}

function isActive(filePath) {
    return activeFiles.has(path.resolve(filePath));
}

const processQueue = [];
let activeProcesses = 0;
let lastUploadTime = 0;

function processQueueNext() {
    if (processQueue.length === 0 || activeProcesses >= MAX_CONCURRENT) return;

    const task = processQueue.shift();
    activeProcesses++;
    console.log(`📋 [Queue] Processing (${activeProcesses}/${MAX_CONCURRENT}), ${processQueue.length} waiting`);

    task().finally(() => {
        activeProcesses--;
        console.log(`✅ [Queue] Done (${activeProcesses}/${MAX_CONCURRENT}), ${processQueue.length} waiting`);
        processQueueNext();
    });
}

function enqueueProcess(task) {
    return new Promise((resolve, reject) => {
        processQueue.push(async () => {
            try {
                const now = Date.now();
                const timeSinceLast = now - lastUploadTime;
                if (timeSinceLast < UPLOAD_DELAY) {
                    const wait = UPLOAD_DELAY - timeSinceLast;
                    console.log(`⏳ [Queue] Waiting ${wait}ms before upload`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                }
                lastUploadTime = Date.now();

                const result = await task();
                resolve(result);
            } catch (err) {
                reject(err);
            }
        });
        processQueueNext();
    });
}

function ensureTmp() {
    if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    }
}

function autoCleanupTmp() {
    try {
        if (!fs.existsSync(TMP_DIR)) return;

        const files = fs.readdirSync(TMP_DIR);
        const now = Date.now();
        let deleted = 0;
        let freedMB = 0;

        for (const file of files) {
            const filePath = path.join(TMP_DIR, file);

            if (isActive(filePath)) continue;

            try {
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;

                if (age > CLEANUP_MAX_AGE_MS) {
                    const sizeMB = stats.size / 1024 / 1024;
                    fs.unlinkSync(filePath);
                    deleted++;
                    freedMB += sizeMB;
                }
            } catch { continue; }
        }

        if (deleted > 0) {
            console.log(`🧹 [Cleanup] Deleted ${deleted} old files, freed ${freedMB.toFixed(1)} MB`);
        }
    } catch (err) {
        console.warn('⚠️ [Cleanup] Failed:', err.message);
    }
}

function enforceDiskLimit() {
    try {
        if (!fs.existsSync(TMP_DIR)) return;

        const files = fs.readdirSync(TMP_DIR);
        let totalBytes = 0;
        const fileInfos = [];

        for (const file of files) {
            const filePath = path.join(TMP_DIR, file);
            if (isActive(filePath)) continue;
            try {
                const stats = fs.statSync(filePath);
                totalBytes += stats.size;
                fileInfos.push({ path: filePath, mtimeMs: stats.mtimeMs, size: stats.size });
            } catch { continue; }
        }

        const totalMB = totalBytes / 1024 / 1024;
        if (totalMB > MAX_DISK_MB) {
            console.log(`⚠️ [DiskLimit] TMP using ${totalMB.toFixed(1)} MB (limit: ${MAX_DISK_MB} MB), cleaning oldest...`);

            fileInfos.sort((a, b) => a.mtimeMs - b.mtimeMs);

            for (const info of fileInfos) {
                if (totalMB <= MAX_DISK_MB * 0.8) break;
                try {
                    fs.unlinkSync(info.path);
                    totalBytes -= info.size;
                    console.log(`🧹 [DiskLimit] Removed: ${path.basename(info.path)} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
                } catch { continue; }
            }
        }
    } catch (err) {
        console.warn('⚠️ [DiskLimit] Failed:', err.message);
    }
}

function runCleanup() {
    autoCleanupTmp();
    enforceDiskLimit();
}

setInterval(runCleanup, CLEANUP_INTERVAL);
runCleanup();

let FormData, fetch;

function loadDependencies() {
    try {
        FormData = require('form-data');
    } catch (err) {
        console.log('📦 [Boombox] Installing form-data...');
        try {
            execSync('npm install form-data --no-audit --no-fund', { stdio: 'inherit', timeout: 60000 });
            FormData = require('form-data');
        } catch (installErr) {
            console.error('❌ [Boombox] Failed to install form-data');
            throw new Error('form-data module required. Run: npm install form-data');
        }
    }

    try {
        fetch = (...args) => import('node-fetch').then(m => m.default(...args));
    } catch (err) {
        console.log('📦 [Boombox] Installing node-fetch...');
        try {
            execSync('npm install node-fetch --no-audit --no-fund', { stdio: 'inherit', timeout: 60000 });
            fetch = (...args) => import('node-fetch').then(m => m.default(...args));
        } catch (installErr) {
            console.error('❌ [Boombox] Failed to install node-fetch');
            if (global.fetch) {
                console.log('✅ [Boombox] Using global fetch');
                fetch = global.fetch;
            } else {
                throw new Error('node-fetch required. Run: npm install node-fetch');
            }
        }
    }
}

function getYtDlp() {
    const candidates = ['yt-dlp', 'yt-dlp.exe'];
    for (const bin of candidates) {
        try {
            execSync(`${bin} --version`, { stdio: 'pipe', timeout: 5000 });
            return bin;
        } catch { }
    }

    const binPath = path.join(process.cwd(), 'yt-dlp');

    if (!fs.existsSync(binPath)) {
        console.log('📦 [Boombox] Downloading yt-dlp...');
        try {
            const isWin = process.platform === 'win32';
            const url = isWin
                ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
                : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
            execSync(`curl -L "${url}" -o "${binPath}"`, { stdio: 'inherit', timeout: 120000 });

            if (!isWin) {
                execSync(`chmod +x "${binPath}"`, { stdio: 'inherit' });
            }

            console.log(`✅ [Boombox] yt-dlp downloaded to ${binPath}`);
        } catch (err) {
            console.error('❌ Failed to download yt-dlp:', err.message);
            throw new Error('yt-dlp not available. Install manually.');
        }
    }

    try {
        fs.accessSync(binPath, fs.constants.X_OK);
    } catch {
        console.log(`🔧 [Boombox] Fixing permission for ${binPath}...`);
        try {
            execSync(`chmod +x "${binPath}"`, { stdio: 'inherit' });
        } catch (err) {
            console.warn(`⚠️ [Boombox] Failed to chmod: ${err.message}`);
        }
    }

    return binPath;
}

function updateYtDlp(ytDlp) {
    // YouTube changes its delivery/authentication frequently. Keep the bundled
    // yt-dlp current when the host allows self-updating. Failure is non-fatal.
    try {
        console.log('🔄 [Boombox] Checking yt-dlp update...');
        const output = execSync(`"${ytDlp}" -U`, {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024
        });
        const lastLines = output.trim().split(/\r?\n/).slice(-3).join(' | ');
        console.log(`📦 [Boombox] yt-dlp: ${lastLines || 'up to date'}`);
    } catch (err) {
        console.warn(`⚠️ [Boombox] yt-dlp auto-update skipped: ${err.message}`);
    }
}

function detectPlatform(url) {
    if (/youtu\.?be|youtube\.com/i.test(url)) return 'youtube';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/spotify\.com|open\.spotify\.com|play\.spotify\.com/i.test(url)) return 'spotify';
    return 'unknown';
}

const YTDLP_FLAGS = '--no-playlist --no-check-certificate --no-warnings --js-runtimes node --remote-components ejs:github --extractor-args "youtube:player_client=web_embedded,tv"';

function getFileSizeMB(filePath) {
    try {
        return fs.statSync(filePath).size / 1024 / 1024;
    } catch {
        return 0;
    }
}

function compressAudio(inputPath, bitrateKbps, outputPath) {
    try {
        console.log(`🗜️ [Compress] Compressing to ${bitrateKbps}kbps...`);
        execSync(
            `ffmpeg -i "${inputPath}" -y -vn -acodec libmp3lame -b:a ${bitrateKbps}k "${outputPath}"`,
            { stdio: 'pipe', timeout: 300000 }
        );

        if (fs.existsSync(outputPath) && getFileSizeMB(outputPath) > 0) {
            const inputMB = getFileSizeMB(inputPath).toFixed(1);
            const outputMB = getFileSizeMB(outputPath).toFixed(1);
            console.log(`✅ [Compress] ${inputMB} MB → ${outputMB} MB (${bitrateKbps}kbps)`);
            return outputPath;
        }
    } catch (err) {
        console.warn(`⚠️ [Compress] Failed at ${bitrateKbps}kbps: ${err.message}`);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { }
    }
    return null;
}

function ensureUploadableSize(inputPath) {
    const fileSize = fs.statSync(inputPath).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

    if (fileSize <= MAX_UPLOAD_BYTES) {
        console.log(`📏 [Size] ${fileSizeMB} MB — within limit, no compression needed`);
        return inputPath;
    }

    console.log(`📏 [Size] ${fileSizeMB} MB — exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit, starting compression...`);

    let durationSec = 0;
    try {
        const probe = execSync(
            `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
            { encoding: 'utf8', timeout: 30000 }
        );
        durationSec = parseFloat(probe.trim()) || 0;
    } catch {
        console.warn('⚠️ [Compress] Cannot probe duration, will try all bitrates');
    }

    let targetBitrateKbps = null;
    if (durationSec > 0) {
        targetBitrateKbps = Math.floor((TARGET_UPLOAD_BYTES * 8) / (durationSec * 1000));
        console.log(`🎯 [Compress] Duration: ${durationSec.toFixed(0)}s → Target bitrate: ~${targetBitrateKbps}kbps`);
    }

    const ladder = [...BITRATE_LADDER].sort((a, b) => b - a);

    if (targetBitrateKbps) {
        if (!ladder.includes(targetBitrateKbps)) {
            ladder.push(targetBitrateKbps);
            ladder.sort((a, b) => b - a);
        }

        const smartLadder = ladder.filter(b => b <= targetBitrateKbps * 1.2);
        if (smartLadder.length > 0) {
            for (const bitrate of smartLadder) {
                const outputPath = inputPath.replace(/\.([^.]+)$/, `_compressed_${bitrate}k.$1`);
                const result = compressAudio(inputPath, bitrate, outputPath);
                if (result && fs.statSync(result).size <= MAX_UPLOAD_BYTES) {
                    safeDelete(inputPath);
                    return result;
                }
                if (result) safeDelete(result);
            }
        }
    }

    console.log(`🔄 [Compress] Smart ladder didn't work, trying all bitrates from lowest...`);
    const ascendingLadder = [...BITRATE_LADDER].sort((a, b) => a - b);

    for (const bitrate of ascendingLadder) {
        const outputPath = inputPath.replace(/\.([^.]+)$/, `_compressed_${bitrate}k.$1`);

        if (targetBitrateKbps && bitrate <= targetBitrateKbps * 1.2) continue;

        const result = compressAudio(inputPath, bitrate, outputPath);
        if (result && fs.statSync(result).size <= MAX_UPLOAD_BYTES) {
            safeDelete(inputPath);
            return result;
        }
        if (result) safeDelete(result);
    }

    const lastResort = inputPath.replace(/\.([^.]+)$/, `_compressed_32k.$1`);
    const lastResult = compressAudio(inputPath, 32, lastResort);
    if (lastResult) {
        const lastSize = fs.statSync(lastResult).size;
        if (lastSize <= MAX_UPLOAD_BYTES) {
            safeDelete(inputPath);
            return lastResult;
        }
        safeDelete(lastResult);
    }

    throw new Error(
        `Audio terlalu besar (${fileSizeMB} MB). ` +
        `Telah dicoba kompresi sampai 32kbps tetapi tetap melebihi batas upload 100 MB. ` +
        `Audio mungkin terlalu panjang untuk diproses.`
    );
}

function getNextLowerBitrate(currentBitrate) {
    const ladder = [128, 96, 64, 48, 32];
    const idx = ladder.indexOf(currentBitrate);
    if (idx === -1) {
        const lower = ladder.filter(b => b < currentBitrate);
        return lower.length > 0 ? lower[0] : null;
    }
    return idx < ladder.length - 1 ? ladder[idx + 1] : null;
}

let ytDlpUpdateChecked = false;

async function processYoutube(url, optimalBitrate = MAX_AUDIO_BITRATE, bitrateMode = 'auto') {
    const ytDlp = getYtDlp();
    if (!ytDlpUpdateChecked) { updateYtDlp(ytDlp); ytDlpUpdateChecked = true; }
    const userAgent = getRandomUserAgent();

    if (!fs.existsSync(ytDlp)) {
        throw new Error(`yt-dlp not found at: ${ytDlp}`);
    }

    const timestamp = Date.now();
    const outTpl = path.join(TMP_DIR, `${timestamp}_audio.%(ext)s`);

    let raw = '';
    try {
        raw = execSync(
            `"${ytDlp}" ${YTDLP_FLAGS} --user-agent "${userAgent}" --print-json -f "bestaudio" -o "${outTpl}" "${url}"`,
            { encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 }
        );
    } catch (err) {
        const stderr = err.stderr?.toString() ?? '';
        const errLine = stderr.split('\n').find(l => l.includes('ERROR:')) ?? err.message;
        throw new Error(`Failed to download audio: ${errLine}`);
    }

    let meta = {};
    try {
        const jsonLine = raw.trim().split('\n').find(l => l.trim().startsWith('{'));
        if (jsonLine) meta = JSON.parse(jsonLine);
    } catch { }

    const title = meta.title ?? 'Unknown Title';
    const duration = parseInt(meta.duration ?? 0);
    const thumbnail = meta.thumbnail ?? null;
    const uploader = meta.uploader ?? meta.channel ?? 'Unknown';

    const usedBitrate = bitrateMode === 'fixed'
        ? optimalBitrate
        : (duration > 0 ? calculateOptimalBitrate(duration) : optimalBitrate);

    const files = fs.readdirSync(TMP_DIR);
    const found = files.find(f => f.startsWith(`${timestamp}_audio`) && !f.endsWith('.part'));
    if (!found) throw new Error('Audio file not found.');

    const filePath = path.join(TMP_DIR, found);
    markActive(filePath);

    const ext = path.extname(filePath).toLowerCase();
    let mp3Path = filePath;

    const needsConversion = ext !== '.mp3' || usedBitrate < MAX_AUDIO_BITRATE;

    if (needsConversion) {
        const mp3File = filePath.replace(/\.[^.]+$/, '.mp3');
        console.log(`🔄 [Boombox] Converting to MP3 at ${usedBitrate}kbps: ${mp3File}`);
        try {
            execSync(
                `ffmpeg -i "${filePath}" -y -vn -acodec libmp3lame -b:a ${usedBitrate}k "${mp3File}"`,
                { stdio: 'pipe', timeout: 300000 }
            );
            unmarkActive(filePath);
            safeDelete(filePath);
            mp3Path = mp3File;
            markActive(mp3Path);
        } catch (convErr) {
            console.warn('⚠️ FFmpeg not available, using original file');
            if (ext !== '.mp3') {
                const renamed = filePath.replace(/\.[^.]+$/, '.mp3');
                fs.renameSync(filePath, renamed);
                unmarkActive(filePath);
                mp3Path = renamed;
                markActive(mp3Path);
            } else {
                mp3Path = filePath;
            }
        }
    } else {
        console.log(`✅ [Boombox] File already MP3 at good quality, no re-encode needed`);
    }

    const fileSizeMB = getFileSizeMB(mp3Path);
    console.log(`📏 [Boombox] Output: ${fileSizeMB.toFixed(1)} MB at ${usedBitrate}kbps (${formatDurationLog(duration)})`);

    return { title, duration, thumbnail, uploader, tmpFile: mp3Path, bitrate: usedBitrate };
}

async function processTiktok(url) {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
    const apiData = await fetchJson(apiUrl);

    if (!apiData?.data?.play) {
        throw new Error('Failed to get TikTok audio URL.');
    }

    const title = apiData.data.title ?? 'TikTok Audio';
    const thumbnail = apiData.data.cover ?? null;
    const duration = apiData.data.duration ?? 0;
    const uploader = apiData.data.author?.nickname ?? 'TikTok';
    const audioUrl = apiData.data.music ?? apiData.data.play;

    const usedBitrate = calculateOptimalBitrate(duration);

    const tmpFile = path.join(TMP_DIR, `${Date.now()}_tiktok.mp3`);
    await downloadRawFile(audioUrl, tmpFile);
    markActive(tmpFile);

    const fileSizeMB = getFileSizeMB(tmpFile);
    console.log(`📏 [TikTok] Downloaded: ${fileSizeMB.toFixed(1)} MB at ${usedBitrate}kbps (duration: ${formatDurationLog(duration)})`);

    return { title, duration, thumbnail, uploader, tmpFile, bitrate: usedBitrate };
}

async function processSpotify(url, optimalBitrate = MAX_AUDIO_BITRATE, bitrateMode = 'auto') {
    console.log(`🎵 [Spotify] Processing: ${url}`);

    let spotifyId = null;
    const cleanUrl = url.split('?')[0];

    const match = cleanUrl.match(/track\/([a-zA-Z0-9]{22})/);
    if (match) {
        spotifyId = match[1];
    } else {
        const idMatch = cleanUrl.match(/\/([a-zA-Z0-9]{22})(?:\?|$|&)/);
        if (idMatch) spotifyId = idMatch[1];
    }

    if (!spotifyId) {
        throw new Error(`Cannot extract Spotify ID from URL: ${url}`);
    }

    console.log(`🎵 [Spotify] ID: ${spotifyId}`);

    let trackName = '';
    let artistName = '';
    let thumbnailUrl = '';

    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${spotifyId}`;
        const oembedRes = await fetch(oembedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (oembedRes.ok) {
            const data = await oembedRes.json();
            const titleParts = data.title?.split(' by ') || [];
            if (titleParts.length >= 2) {
                trackName = titleParts[0].trim();
                artistName = titleParts[1].trim();
            } else {
                trackName = data.title || '';
            }
            thumbnailUrl = data.thumbnail_url || '';
        }
    } catch (err) {
        console.warn(`⚠️ [Spotify] oEmbed failed: ${err.message}`);
    }

    if (!trackName || trackName === '') {
        trackName = `Spotify ${spotifyId}`;
        artistName = 'Unknown';
        console.log(`⚠️ [Spotify] Using fallback: "${trackName}"`);
    }

    const searchQueries = [
        `${trackName} ${artistName} official audio`,
        `${trackName} ${artistName} audio`,
        `${trackName} ${artistName}`,
        `${trackName} audio`,
        `${trackName}`,
    ];

    const ytDlp = getYtDlp();
    if (!ytDlpUpdateChecked) { updateYtDlp(ytDlp); ytDlpUpdateChecked = true; }
    const timestamp = Date.now();
    const outTpl = path.join(TMP_DIR, `${timestamp}_spotify_audio.%(ext)s`);

    let raw = '';
    let lastError = null;

    for (const query of searchQueries) {
        try {
            const searchUrl = `ytsearch1:${query}`;
            console.log(`🔍 [Spotify] Searching: "${query}"`);
            raw = execSync(
                `"${ytDlp}" ${YTDLP_FLAGS} --user-agent "${getRandomUserAgent()}" --print-json -f "bestaudio" -o "${outTpl}" "${searchUrl}"`,
                { encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 }
            );
            if (raw && raw.trim().length > 0) break;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ [Spotify] Query failed: "${query}"`);
            continue;
        }
    }

    if (!raw || raw.trim().length === 0) {
        const stderr = lastError?.stderr?.toString() ?? '';
        const errLine = stderr.split('\n').find(l => l.includes('ERROR:')) || lastError?.message || 'Unknown error';
        throw new Error(`Failed to search Spotify: ${errLine}`);
    }

    let meta = {};
    try {
        const jsonLine = raw.trim().split('\n').find(l => l.trim().startsWith('{'));
        if (jsonLine) meta = JSON.parse(jsonLine);
    } catch { }

    const title = meta.title || trackName;
    const duration = parseInt(meta.duration ?? 0);
    const thumbnail = meta.thumbnail || thumbnailUrl || null;
    const uploader = meta.uploader || meta.channel || artistName;

    const usedBitrate = bitrateMode === 'fixed'
        ? optimalBitrate
        : (duration > 0 ? calculateOptimalBitrate(duration) : optimalBitrate);

    console.log(`✅ [Spotify] Found: ${title} - ${uploader} (${formatDurationLog(duration)}, ${usedBitrate}kbps)`);

    const files = fs.readdirSync(TMP_DIR);
    const found = files.find(f => f.startsWith(`${timestamp}_spotify_audio`) && !f.endsWith('.part'));
    if (!found) throw new Error('Audio file not found.');

    const filePath = path.join(TMP_DIR, found);
    markActive(filePath);

    const ext = path.extname(filePath).toLowerCase();
    let mp3Path = filePath;

    const needsConversion = ext !== '.mp3' || usedBitrate < MAX_AUDIO_BITRATE;

    if (needsConversion) {
        const mp3File = filePath.replace(/\.[^.]+$/, '.mp3');
        console.log(`🔄 [Boombox] Converting to MP3 at ${usedBitrate}kbps: ${mp3File}`);
        try {
            execSync(
                `ffmpeg -i "${filePath}" -y -vn -acodec libmp3lame -b:a ${usedBitrate}k "${mp3File}"`,
                { stdio: 'pipe', timeout: 300000 }
            );
            unmarkActive(filePath);
            safeDelete(filePath);
            mp3Path = mp3File;
            markActive(mp3Path);
        } catch (convErr) {
            console.warn('⚠️ FFmpeg not available, using original file');
            if (ext !== '.mp3') {
                const renamed = filePath.replace(/\.[^.]+$/, '.mp3');
                fs.renameSync(filePath, renamed);
                unmarkActive(filePath);
                mp3Path = renamed;
                markActive(mp3Path);
            } else {
                mp3Path = filePath;
            }
        }
    } else {
        console.log(`✅ [Boombox] File already MP3 at good quality, no re-encode needed`);
    }

    const fileSizeMB = getFileSizeMB(mp3Path);
    console.log(`📏 [Boombox] Output: ${fileSizeMB.toFixed(1)} MB at ${usedBitrate}kbps`);

    return { title, duration, thumbnail, uploader, tmpFile: mp3Path, bitrate: usedBitrate };
}

function fixUrl(url) {
    if (!url) return url;
    return url.replace(/^https:\/\//, 'http://');
}

async function uploadToTop4topAttempt(filePath) {
    loadDependencies();

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    console.log(`📤 [Top4top] Uploading: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    ];
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    const sessionRes = await fetch('https://top4top.io/', {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        }
    });

    const cookies = sessionRes.headers.raw()['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
    const html = await sessionRes.text();

    const hiddenFields = {};
    const hiddenRe = /<input[^>]*type=["']hidden["'][^>]*>/gi;
    let match;
    while ((match = hiddenRe.exec(html)) !== null) {
        const tag = match[0];
        const nameMatch = tag.match(/name=["']([^"']+)["']/i);
        const valueMatch = tag.match(/value=["']([^"']*)["']/i);
        if (nameMatch) {
            hiddenFields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
        }
    }

    console.log(`🔑 Hidden fields: ${Object.keys(hiddenFields).join(', ')}`);

    const form = new FormData();
    for (const [k, v] of Object.entries(hiddenFields)) {
        form.append(k, v);
    }
    form.append('file_0_', fs.createReadStream(filePath), {
        filename: fileName,
        contentType: 'audio/mpeg',
        knownLength: fileSize,
    });
    form.append('submitr', 'رفع الملفات');

    const uploadRes = await fetch('https://top4top.io/index.php', {
        method: 'POST',
        headers: {
            ...form.getHeaders(),
            'User-Agent': userAgent,
            'Cookie': cookies,
            'Referer': 'https://top4top.io/',
            'Origin': 'https://top4top.io',
        },
        body: form,
        redirect: 'manual',
    });

    let finalUrl = uploadRes.url;
    let finalHtml = await uploadRes.text();

    if (uploadRes.status >= 300 && uploadRes.status < 400 && uploadRes.headers.get('location')) {
        const location = uploadRes.headers.get('location');
        const redirectUrl = location.startsWith('http') ? location : `https://top4top.io${location}`;
        console.log(`↗️ Redirecting to: ${redirectUrl}`);

        const redirectRes = await fetch(redirectUrl, {
            headers: { 'User-Agent': userAgent, 'Cookie': cookies }
        });
        finalUrl = redirectRes.url;
        finalHtml = await redirectRes.text();
    }

    console.log(`📄 Final URL: ${finalUrl}`);

    const extractedUrl = tryExtractTop4topUrl(finalHtml) || tryExtractTop4topUrl(finalUrl);
    if (extractedUrl) {
        console.log(`✅ [Top4top] Success: ${extractedUrl}`);
        return extractedUrl;
    }

    const links = finalHtml.match(/https?:\/\/[a-z0-9]+\.top4top\.io\/[a-zA-Z0-9_/]+/gi) || [];
    const valid = links.find(l => l.includes('/m_') || l.includes('/p_'));
    if (valid) {
        console.log(`✅ [Top4top] Found via links: ${valid}`);
        return valid;
    }

    const textMatch = finalHtml.match(/(?:https?:\/\/[a-z0-9]+\.top4top\.io\/m_[a-zA-Z0-9_]+\.mp3)/i);
    if (textMatch) {
        console.log(`✅ [Top4top] Found via text: ${textMatch[0]}`);
        return textMatch[0];
    }

    throw new Error('Cannot find Top4top URL. Response HTML does not contain valid link.');
}

async function uploadToTop4top(filePath, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await uploadToTop4topAttempt(filePath);
        } catch (err) {
            console.warn(`⚠️ [Top4top] Attempt ${attempt}/${retries} failed: ${err.message}`);
            if (attempt === retries) throw err;
            const waitTime = 5000 * attempt;
            console.log(`⏳ [Top4top] Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

function tryExtractTop4topUrl(text) {
    if (!text) return null;

    const patterns = [
        /(https?:\/\/[a-z0-9]+\.top4top\.io\/m_[^\s"'<>&)]+)/i,
        /(https?:\/\/[a-z0-9]+\.top4top\.io\/p_[^\s"'<>&)]+)/i,
        /href=["'](https?:\/\/[a-z0-9]+\.top4top\.io\/(?:m_|p_)[^"']+)["']/i,
        /value=["'](https?:\/\/[a-z0-9]+\.top4top\.io\/(?:m_|p_)[^"']+)["']/i,
        /(https?:\/\/f\.top4top\.io\/m_[^\s"'<>&)]+)/i,
    ];

    for (const p of patterns) {
        const m = text.match(p);
        if (m) {
            const url = (m[1] || m[0]).trim();
            if (url.startsWith('http')) {
                return url.replace(/&amp;/g, '&');
            }
        }
    }
    return null;
}

async function uploadFile(filePath, onProgress = null) {
    const fileSize = fs.statSync(filePath).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

    console.log(`📏 [Upload] File size: ${fileSizeMB} MB`);

    markActive(filePath);

    try {
        if (onProgress) await onProgress('uploading');
        const url = await uploadToTop4top(filePath);
        return fixUrl(url);
    } finally {
        unmarkActive(filePath);
    }
}

function safeDelete(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🧹 [Delete] Removed: ${path.basename(filePath)}`);
        }
    } catch (err) {
        console.warn(`⚠️ [Delete] Failed to remove ${filePath}:`, err.message);
    }
}

function formatDurationLog(seconds) {
    if (!seconds) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}j ${m}m ${s}d`;
    if (m > 0) return `${m}m ${s}d`;
    return `${s}d`;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
            });
        }).on('error', reject);
    });
}

function downloadRawFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);

        function download(currentUrl) {
            const lib = currentUrl.startsWith('https') ? https : http;
            lib.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close();
                    return download(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    file.close();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        }
        download(url);
    });
}

const CACHE_PATH = path.join(__dirname, 'boombox_cache.json');

function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const data = fs.readFileSync(CACHE_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to load:', err.message);
    }
    return {};
}

function saveCache(url, data) {
    try {
        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        cache[normalizedUrl] = {
            title: data.title,
            thumbnail: data.thumbnail,
            mp3Url: data.mp3Url,
            requestedBy: data.requestedBy || 'unknown',
            platform: data.platform || 'unknown',
            bitrate: data.bitrate || null,
            cachedAt: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
        console.log(`💾 [Cache] Saved: ${normalizedUrl}`);
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to save:', err.message);
    }
}

function getCache(url) {
    try {
        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        if (cache[normalizedUrl]) {
            console.log(`📦 [Cache] Hit: ${normalizedUrl}`);
            return cache[normalizedUrl];
        }
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to get:', err.message);
    }
    return null;
}

function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            let videoId = urlObj.searchParams.get('v');
            if (!videoId) {
                const pathParts = urlObj.pathname.split('/');
                videoId = pathParts[pathParts.length - 1];
                if (videoId.includes('?')) {
                    videoId = videoId.split('?')[0];
                }
            }
            if (videoId && videoId.length === 11) {
                return `https://youtube.com/watch?v=${videoId}`;
            }
        }

        if (hostname.includes('tiktok.com')) {
            const match = url.match(/\/video\/(\d+)/);
            if (match) {
                return `https://tiktok.com/video/${match[1]}`;
            }
        }

        if (hostname.includes('spotify.com')) {
            const match = url.match(/\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
            if (match) {
                return `https://spotify.com/${match[1]}/${match[2]}`;
            }
        }

        return urlObj.origin + urlObj.pathname;
    } catch {
        return url.split('?')[0];
    }
}

async function processUrl(url, forceRegenerate = false, onProgress = null, guildSettings = null) {
    console.log(`🎯 [Boombox] Processing URL: ${url}`);
    ensureTmp();
    loadDependencies();

    if (!forceRegenerate) {
        const cached = getCache(url);
        if (cached) {
            console.log(`📦 [Cache] Found cached result for: ${url}`);
            return cached;
        }
    } else {
        console.log(`🔄 [Boombox] Force regenerate, skipping cache for: ${url}`);
    }

    const platform = detectPlatform(url);
    console.log(`📌 [Boombox] Platform: ${platform}`);

    if (platform === 'unknown') {
        throw new Error('URL not recognized. Only YouTube, TikTok, and Spotify supported.');
    }

    const bitrateMode = (guildSettings?.bitrate === 'auto' || !guildSettings?.bitrate || guildSettings.bitrate === 'auto')
        ? 'auto'
        : 'fixed';
    const fixedBitrate = bitrateMode === 'fixed'
        ? parseInt(guildSettings.bitrate)
        : MAX_AUDIO_BITRATE;
    const maxDurationMin = parseInt(guildSettings?.maxDuration) || 0;

    return enqueueProcess(async () => {
        let result;
        let tmpFile = null;
        let preBitrate = null;
        let preDuration = 0;

        try {
            if (onProgress) await onProgress('analyzing');

            if (platform === 'youtube') {
                try {
                    const info = getVideoInfo(url);
                    preDuration = parseInt(info.duration ?? 0);

                    if (maxDurationMin > 0 && preDuration > 0 && preDuration > maxDurationMin * 60) {
                        throw new Error(
                            `Video terlalu panjang (${formatDurationLog(preDuration)}). ` +
                            `Batas maksimal: **${maxDurationMin} menit**.\n` +
                            `💡 Ubah batas durasi di \`/boombox settings\`.`
                        );
                    }

                    preBitrate = bitrateMode === 'auto'
                        ? calculateOptimalBitrate(preDuration)
                        : fixedBitrate;
                    console.log(`🔍 [Analyze] YouTube: ${info.title} — ${formatDurationLog(preDuration)} → ${preBitrate}kbps (${bitrateMode})`);
                } catch (err) {
                    if (err.message.includes('terlalu panjang')) throw err;
                    console.warn(`⚠️ [Analyze] Cannot pre-fetch YouTube info: ${err.message}`);
                    preBitrate = bitrateMode === 'auto' ? MAX_AUDIO_BITRATE : fixedBitrate;
                }
            } else if (platform === 'spotify') {
                preBitrate = bitrateMode === 'auto' ? MAX_AUDIO_BITRATE : fixedBitrate;
                console.log(`🔍 [Analyze] Spotify: ${bitrateMode} mode, bitrate ${preBitrate}kbps`);
            } else {
                preBitrate = bitrateMode === 'auto' ? MAX_AUDIO_BITRATE : fixedBitrate;
                console.log(`🔍 [Analyze] TikTok: ${bitrateMode} mode, bitrate ${preBitrate}kbps`);
            }

            if (onProgress) await onProgress('downloading', { bitrate: preBitrate, duration: preDuration });

            switch (platform) {
                case 'youtube':
                    result = await processYoutube(url, preBitrate, bitrateMode);
                    break;
                case 'tiktok':
                    result = await processTiktok(url);
                    break;
                case 'spotify':
                    result = await processSpotify(url, preBitrate, bitrateMode);
                    break;
                default:
                    throw new Error('Unsupported platform');
            }
        } catch (err) {
            console.error(`❌ [Boombox] ${platform} error:`, err.message);
            throw new Error(`Failed to fetch audio: ${err.message}`);
        }

        tmpFile = result.tmpFile;
        let usedBitrate = result.bitrate || preBitrate || MAX_AUDIO_BITRATE;

        if (maxDurationMin > 0 && result.duration > 0 && result.duration > maxDurationMin * 60) {
            unmarkActive(tmpFile);
            safeDelete(tmpFile);
            throw new Error(
                `Video terlalu panjang (${formatDurationLog(result.duration)}). ` +
                `Batas maksimal: **${maxDurationMin} menit**.\n` +
                `💡 Ubah batas durasi di \`/boombox settings\`.`
            );
        }

        const fileSize = fs.statSync(tmpFile).size;
        const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

        if (fileSize > MAX_UPLOAD_BYTES) {
            console.log(`📏 [Size] ${fileSizeMB} MB — exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);

            if (bitrateMode === 'auto') {
                const nextLower = getNextLowerBitrate(usedBitrate);
                if (nextLower) {
                    console.log(`🗜️ [Compress] Trying one step lower: ${usedBitrate}kbps → ${nextLower}kbps`);
                    if (onProgress) await onProgress('compressing');

                    const compressedPath = tmpFile.replace(/\.([^.]+)$/, `_compressed_${nextLower}k.$1`);
                    const compressed = compressAudio(tmpFile, nextLower, compressedPath);

                    if (compressed && fs.statSync(compressed).size <= MAX_UPLOAD_BYTES) {
                        unmarkActive(tmpFile);
                        safeDelete(tmpFile);
                        tmpFile = compressed;
                        usedBitrate = nextLower;
                        markActive(tmpFile);
                        console.log(`✅ [Compress] ${fileSizeMB} MB → ${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1)} MB (${nextLower}kbps)`);
                    } else {
                        if (compressed) safeDelete(compressed);
                        unmarkActive(tmpFile);
                        safeDelete(tmpFile);
                        throw new Error(
                            `Audio melebihi batas upload **100 MB** (${fileSizeMB} MB) meskipun sudah dikompres ke ${nextLower}kbps.\n\n` +
                            `💡 **Solusi:**\n` +
                            `> • Turunkan bitrate secara manual di \`/boombox settings\`\n` +
                            `> • Atau gunakan mode **Auto** dan pastikan video tidak terlalu panjang`
                        );
                    }
                } else {
                    unmarkActive(tmpFile);
                    safeDelete(tmpFile);
                    throw new Error(
                        `Audio melebihi batas upload **100 MB** (${fileSizeMB} MB) pada bitrate minimum (32kbps).\n\n` +
                        `Video terlalu panjang untuk diproses. Durasi maksimal di 32kbps: ~6 jam.`
                    );
                }
            } else {
                unmarkActive(tmpFile);
                safeDelete(tmpFile);
                throw new Error(
                    `Audio melebihi batas upload **100 MB** (${fileSizeMB} MB) pada bitrate ${usedBitrate}kbps.\n\n` +
                    `💡 **Solusi:**\n` +
                    `> • Turunkan bitrate di \`/boombox settings\` (contoh: ${getNextLowerBitrate(usedBitrate) || 'lebih rendah'}kbps)\n` +
                    `> • Atau ubah ke mode **Auto** agar bot otomatis hitung bitrate optimal`
                );
            }
        } else {
            console.log(`📏 [Size] ${fileSizeMB} MB — within limit ✓`);
        }

        try {
            const mp3Url = await uploadFile(tmpFile, onProgress);

            const finalResult = {
                title: result.title,
                duration: result.duration,
                thumbnail: result.thumbnail,
                uploader: result.uploader,
                mp3Url: fixUrl(mp3Url),
                platform: platform,
                bitrate: usedBitrate,
            };

            saveCache(url, finalResult);
            return finalResult;

        } finally {
            unmarkActive(tmpFile);
            safeDelete(tmpFile);

            try {
                const tmpFiles = fs.readdirSync(TMP_DIR);
                for (const f of tmpFiles) {
                    if (f.includes('_compressed_')) {
                        const fp = path.join(TMP_DIR, f);
                        if (!isActive(fp)) safeDelete(fp);
                    }
                }
            } catch { }
        }
    });
}

module.exports = {
    processUrl,
    getCache,
    saveCache,
    loadCache,
    autoCleanupTmp
};