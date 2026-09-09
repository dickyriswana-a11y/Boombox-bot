// utils/checkPermissions.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function checkYtDlp() {
    const binPath = path.join(process.cwd(), 'yt-dlp');
    
    if (!fs.existsSync(binPath)) {
        console.log('❌ yt-dlp not found. Downloading...');
        return false;
    }
    
    try {
        fs.accessSync(binPath, fs.constants.X_OK);
        console.log('✅ yt-dlp has execute permission');
        return true;
    } catch {
        console.log('⚠️ yt-dlp missing execute permission. Fixing...');
        try {
            execSync(`chmod +x "${binPath}"`, { stdio: 'inherit' });
            console.log('✅ yt-dlp permission fixed');
            return true;
        } catch (err) {
            console.error('❌ Failed to fix permission:', err.message);
            return false;
        }
    }
}

function checkTmpFolder() {
    const tmpPath = path.join(__dirname, '../data/tmp');
    
    if (!fs.existsSync(tmpPath)) {
        console.log('📁 Creating tmp folder...');
        fs.mkdirSync(tmpPath, { recursive: true });
    }
    
    try {
        fs.accessSync(tmpPath, fs.constants.W_OK);
        console.log('✅ Tmp folder writable');
        return true;
    } catch {
        console.log('⚠️ Tmp folder not writable. Fixing...');
        try {
            fs.chmodSync(tmpPath, 0o777);
            console.log('✅ Tmp folder permission fixed');
            return true;
        } catch (err) {
            console.error('❌ Failed to fix tmp folder:', err.message);
            return false;
        }
    }
}

function checkAll() {
    console.log('🔧 [Permission Check] Starting...');
    const ytOk = checkYtDlp();
    const tmpOk = checkTmpFolder();
    
    if (ytOk && tmpOk) {
        console.log('✅ [Permission Check] All good!');
    } else {
        console.warn('⚠️ [Permission Check] Some issues found. Bot may not work properly.');
    }
}

module.exports = { checkYtDlp, checkTmpFolder, checkAll };

