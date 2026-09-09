const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/boombox_cache.json');
const CONFIG_FILE = path.join(__dirname, '../data/boombox_config.json');

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);

    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/watch?v=${v}` : url;
    }

    if (u.hostname === 'youtu.be') {
      const videoId = u.pathname.replace('/', '');
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (u.hostname.includes('tiktok.com')) {
      return `${u.origin}${u.pathname}`;
    }

    return url;
  } catch {
    return url;
  }
}

// ── Cache API
function getCache(originalUrl) {
  const key = normalizeUrl(originalUrl);
  const cache = readJSON(CACHE_FILE, {});
  return cache[key] ?? null;
}

function saveCache(originalUrl, data) {
  const key = normalizeUrl(originalUrl);
  const cache = readJSON(CACHE_FILE, {});
  cache[key] = { ...data, cachedAt: new Date().toISOString() };
  writeJSON(CACHE_FILE, cache);
}

function getAllowedChannels(guildId) {
  const config = readJSON(CONFIG_FILE, {});
  return config[guildId] ?? [];
}

function addAllowedChannel(guildId, channelId) {
  const config = readJSON(CONFIG_FILE, {});
  if (!config[guildId]) config[guildId] = [];
  if (!config[guildId].includes(channelId)) {
    config[guildId].push(channelId);
  }
  writeJSON(CONFIG_FILE, config);
}

function removeAllowedChannel(guildId, channelId) {
  const config = readJSON(CONFIG_FILE, {});
  if (!config[guildId]) return;
  config[guildId] = config[guildId].filter(id => id !== channelId);
  writeJSON(CONFIG_FILE, config);
}

function isAllowedChannel(guildId, channelId) {
  return getAllowedChannels(guildId).includes(channelId);
}

module.exports = {
  getCache,
  saveCache,
  getAllowedChannels,
  addAllowedChannel,
  removeAllowedChannel,
  isAllowedChannel,
  normalizeUrl,
};
