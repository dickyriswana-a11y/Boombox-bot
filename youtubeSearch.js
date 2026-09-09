// utils/youtubeSearch.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
        console.log('📦 [Search] Downloading yt-dlp...');
        try {
            const isWin = process.platform === 'win32';
            const url = isWin
                ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
                : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
            execSync(`curl -L "${url}" -o "${binPath}"`, { stdio: 'inherit', timeout: 120000 });
            if (!isWin) {
                execSync(`chmod +x "${binPath}"`, { stdio: 'inherit' });
            }
        } catch (err) {
            console.error('❌ Failed to download yt-dlp:', err.message);
            throw new Error('yt-dlp not available');
        }
    }
    return binPath;
}

function updateYtDlp(ytDlp) {
    try {
        console.log('🔄 [Search] Checking yt-dlp update...');
        const output = execSync(`"${ytDlp}" -U`, {
            encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024
        });
        const lastLines = output.trim().split(/\r?\n/).slice(-3).join(' | ');
        console.log(`📦 [Search] yt-dlp: ${lastLines || 'up to date'}`);
    } catch (err) {
        console.warn(`⚠️ [Search] yt-dlp auto-update skipped: ${err.message}`);
    }
}

let ytDlpUpdateChecked = false;

async function searchYouTube(query, maxResults = 10) {
    const ytDlp = getYtDlp();
    if (!ytDlpUpdateChecked) { updateYtDlp(ytDlp); ytDlpUpdateChecked = true; }
    const userAgent = getRandomUserAgent();
    
    const searchQuery = `ytsearch${maxResults}:${query}`;
    
    let raw = '';
    try {
        raw = execSync(
            `"${ytDlp}" --no-playlist --no-check-certificate --no-warnings ` +
            `--user-agent "${userAgent}" ` +
            `--js-runtimes node --remote-components ejs:github ` +
            `--extractor-args "youtube:player_client=web_embedded,tv" ` +
            `--print-json --flat-playlist "${searchQuery}"`,
            { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
    } catch (err) {
        console.error('❌ [Search] yt-dlp error:', err.message);
        throw new Error('Gagal mencari video di YouTube');
    }

    const lines = raw.trim().split('\n').filter(line => line.trim().startsWith('{'));
    const results = [];

    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            
            // 🔥 FIX: Thumbnail fallback jika tidak ada
            let thumbnail = data.thumbnail || null;
            if (!thumbnail && data.id) {
                thumbnail = `https://img.youtube.com/vi/${data.id}/maxresdefault.jpg`;
            }
            
            results.push({
                videoId: data.id,
                title: data.title || 'Unknown Title',
                duration: data.duration || 0,
                thumbnail: thumbnail,
                channelTitle: data.channel || data.uploader || 'Unknown Channel',
                viewCount: data.view_count || data.viewCount || 0,
                url: `https://youtube.com/watch?v=${data.id}`
            });
        } catch (parseErr) {
            console.warn('⚠️ [Search] Failed to parse:', parseErr.message);
        }
    }

    return results;
}

module.exports = { searchYouTube };