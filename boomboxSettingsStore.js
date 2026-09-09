// utils/boomboxSettingsStore.js
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'boombox_settings.json');

const DEFAULT_SETTINGS = {
    bitrate: 'auto',  
    maxDuration: 0,   
};

function loadAllSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        }
    } catch (err) {
        console.warn('⚠️ [Settings] Failed to load:', err.message);
    }
    return {};
}

function getGuildSettings(guildId) {
    const all = loadAllSettings();
    return { ...DEFAULT_SETTINGS, ...(all[guildId] || {}) };
}

function setGuildSettings(guildId, updates) {
    const all = loadAllSettings();
    all[guildId] = { ...DEFAULT_SETTINGS, ...(all[guildId] || {}), ...updates };
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(all, null, 2));
        console.log(`💾 [Settings] Updated for guild ${guildId}:`, JSON.stringify(updates));
    } catch (err) {
        console.warn('⚠️ [Settings] Failed to save:', err.message);
    }
    return all[guildId];
}

function resetGuildSettings(guildId) {
    const all = loadAllSettings();
    all[guildId] = { ...DEFAULT_SETTINGS };
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(all, null, 2));
        console.log(`🔄 [Settings] Reset for guild ${guildId}`);
    } catch (err) {
        console.warn('⚠️ [Settings] Failed to reset:', err.message);
    }
    return all[guildId];
}

function resolveBitrate(settings) {
    if (!settings || settings.bitrate === 'auto') return null;
    const num = parseInt(settings.bitrate);
    return [128, 96, 64, 48, 32].includes(num) ? num : null;
}

module.exports = {
    loadAllSettings,
    getGuildSettings,
    setGuildSettings,
    resetGuildSettings,
    resolveBitrate,
    DEFAULT_SETTINGS,
    SETTINGS_PATH,
};
