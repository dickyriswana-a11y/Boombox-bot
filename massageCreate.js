// events/messageCreate.js
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder,
  SeparatorBuilder, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { isAllowedChannel } = require('../utils/boomboxCache');
const { processUrl } = require('../utils/boomboxProcessor');
const { handleBbCommand } = require('../commands/bbHandler');
const { getGuildSettings } = require('../utils/boomboxSettingsStore');
const { processingMessages } = require('../utils/sharedState');
const path = require('path');
const fs = require('fs');

const URL_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/gi,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]+/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]+/gi,
  /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[^\s]+\/video\/[0-9]+/gi,
  /(?:https?:\/\/)?(?:vm\.|vt\.)?tiktok\.com\/[a-zA-Z0-9]+/gi,
  /(?:https?:\/\/)?(?:open\.|play\.)?spotify\.com\/(?:track|playlist|album|episode)\/[a-zA-Z0-9]+/gi,
];

const CACHE_PATH = path.join(__dirname, '../utils/boombox_cache.json');
const BOT_NAME = '🎧 AzesZ BOT';

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
        return urlObj.origin + urlObj.pathname;
    } catch {
        return url.split('?')[0];
    }
}

function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        }
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to load:', err.message);
    }
    return {};
}

function getCacheDirect(url) {
    try {
        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        return cache[normalizedUrl] || null;
    } catch (err) {
        return null;
    }
}

function extractUrl(content) {
  for (const pattern of URL_PATTERNS) {
    pattern.lastIndex = 0;
    const match = content.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(isoString) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(isoString)) + ' WIB';
}

function getHostLabel(url) {
  if (!url) return '🔗 Link Audio';
  if (url.includes('top4top.io')) return '🎵 Top4Top';
  if (url.includes('catbox.moe')) return '📦 Catbox';
  if (url.includes('litterbox') || url.includes('litter.catbox')) return '🗑️ Litterbox';
  if (url.includes('gofile.io')) return '📁 GoFile';
  return '🔗 Link Audio';
}

function detectPlatform(url) {
  if (/youtu\.?be|youtube\.com/i.test(url)) return 'YouTube';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/spotify\.com|open\.spotify\.com|play\.spotify\.com/i.test(url)) return 'Spotify';
  return 'Unknown';
}

function buildAudioButton(audioUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('▶  Putar / Download Audio')
      .setStyle(ButtonStyle.Link)
      .setURL(audioUrl)
      .setEmoji('🎵')
  );
}

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot || !message.guild) return;
    if (!isAllowedChannel(message.guild.id, message.channel.id)) return;

    const content = message.content;

    if (content.toLowerCase().startsWith('!bb ')) {
        const query = content.slice(4).trim();
        await handleBbCommand(message, query);
        return;
    }

    if (content.toLowerCase().startsWith('!requlang')) {
        return;
    }

    const url = extractUrl(content);
    if (!url) return;

    const normalized = normalizeUrl(url);
    
    if (processingMessages.has(normalized)) {
        console.log(`⏳ [Boombox] Skipping double processing for: ${normalized}`);
        return;
    }

    const platform = detectPlatform(url);
    console.log(`🎵 [Boombox] ${platform} URL: ${url}`);

    const botAvatar = message.client.user.displayAvatarURL({ extension: 'png', size: 256 });

    // ═══════════════════════════════════════════════════════════════════
    //  CACHE HIT
    // ═══════════════════════════════════════════════════════════════════
    const cached = getCacheDirect(url);
    if (cached) {
        console.log(`📦 [Cache] Serving cached: ${url}`);
        const hostLabel = getHostLabel(cached.mp3Url);

        const cacheContainer = new ContainerBuilder().setAccentColor(0xF59E0B);

        if (cached.thumbnail) {
            cacheContainer.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## 📦 Audio Dari Cache'),
                        new TextDisplayBuilder().setContent(
                            '> Audio ini sudah pernah diproses sebelumnya.\n' +
                            '> Gunakan `!Requlang [URL]` jika audio tidak bisa diputar. 🔄',
                        ),
                    )
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(cached.thumbnail)),
            );
        } else {
            cacheContainer.addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 📦 Audio Dari Cache'),
                new TextDisplayBuilder().setContent(
                    '> Audio ini sudah pernah diproses sebelumnya.\n' +
                    '> Gunakan `!Requlang [URL]` jika audio tidak bisa diputar. 🔄',
                ),
            );
        }

        cacheContainer
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `🎵 **Judul**\n> \`\`${cached.title}\`\`\n\n` +
                    `${hostLabel}\n> ${cached.mp3Url}\n\n` +
                    `👤 **Diproses oleh:** ${cached.requestedBy || 'Tidak diketahui'}\n` +
                    `🕐 **Tanggal Proses:** ${formatDate(cached.cachedAt)}`,
                ),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# By • ${BOT_NAME}  |  Gunakan link di atas untuk memutar audio`),
            )
            .addActionRowComponents(buildAudioButton(cached.mp3Url));

        return message.reply({ components: [cacheContainer], flags: MessageFlags.IsComponentsV2 });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PROSES BARU
    // ═══════════════════════════════════════════════════════════════════
    processingMessages.add(normalized);

    const ts = Math.floor(Date.now() / 1000);
    const processingContainer = new ContainerBuilder()
      .setAccentColor(0xF0B132)
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## ⏳ Sedang Memproses Audio...'),
            new TextDisplayBuilder().setContent(
              '> URL terdeteksi! Sedang mengunduh dan mengupload audio...\n\n' +
              '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
              '*Biasanya memerlukan waktu **20–60 detik** tergantung panjang video.*',
            ),
          )
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username} • <t:${ts}:R>`),
      );

    const processingMsg = await message.reply({
        components: [processingContainer],
        flags: MessageFlags.IsComponentsV2,
    });

    if (!processingMsg) {
        processingMessages.delete(normalized);
        return;
    }

    const onProgress = async (stage, data = {}) => {
      const tsNow = Math.floor(Date.now() / 1000);
      let container;

      if (stage === 'analyzing') {
        container = new ContainerBuilder()
          .setAccentColor(0x8B5CF6)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🔍 Menganalisis Video...'),
                new TextDisplayBuilder().setContent(
                  '> Membaca informasi video untuk menentukan kualitas audio terbaik...\n\n' +
                  '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                  '*Tahap: Analisis durasi & perhitungan bitrate.*',
                ),
              )
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username} • <t:${tsNow}:R>`),
          );
      } else if (stage === 'downloading') {
        const bitrateLabel = data.bitrate ? `${data.bitrate}kbps` : 'optimal';
        const durationLabel = data.duration ? formatDuration(data.duration) : '';
        const qualityNote = data.bitrate && data.bitrate < 128
          ? `\n> ⚙️ Bitrate disesuaikan ke **${data.bitrate}kbps** agar muat upload (video ${durationLabel}).`
          : `\n> ⚙️ Kualitas audio: **${bitrateLabel}** (kualitas terbaik).`;

        container = new ContainerBuilder()
          .setAccentColor(0xF0B132)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ⏳ Mengunduh Audio...'),
                new TextDisplayBuilder().setContent(
                  '> Audio sedang diunduh dan dikonversi ke MP3...' +
                  qualityNote + '\n\n' +
                  '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                  '*Tahap: Mengunduh & konversi audio.*',
                ),
              )
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username} • <t:${tsNow}:R>`),
          );
      } else if (stage === 'compressing') {
        container = new ContainerBuilder()
          .setAccentColor(0xFF6B35)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🗜️ Mengompres Audio...'),
                new TextDisplayBuilder().setContent(
                  '> Audio masih melebihi 100 MB! Sedang mengompres agar muat diupload...\n\n' +
                  '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                  '*Tahap: Kompresi tambahan (turunkan bitrate).*',
                ),
              )
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username} • <t:${tsNow}:R>`),
          );
      } else if (stage === 'uploading') {
        container = new ContainerBuilder()
          .setAccentColor(0x5865F2)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 📤 Mengupload Audio...'),
                new TextDisplayBuilder().setContent(
                  '> Audio siap! Sedang mengupload ke hosting...\n\n' +
                  '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                  '*Tahap: Mengupload ke server hosting.*',
                ),
              )
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username} • <t:${tsNow}:R>`),
          );
      }

      if (container) {
        await processingMsg.edit({ components: [container] }).catch(() => null);
      }
    };

    try {
        console.log(`🔄 [Boombox] Processing ${platform}: ${url}`);
        const guildSettings = getGuildSettings(message.guild.id);
        const result = await processUrl(url, false, onProgress, guildSettings);
        console.log(`✅ [Boombox] Success: ${result.title}`);

        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        cache[normalizedUrl] = {
            title: result.title,
            thumbnail: result.thumbnail,
            mp3Url: result.mp3Url,
            requestedBy: message.author.username,
            platform: platform,
            cachedAt: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

        const hostLabel = getHostLabel(result.mp3Url);

        const successContainer = new ContainerBuilder().setAccentColor(0x22C55E);

        if (result.thumbnail) {
            successContainer.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ✅ Audio Berhasil Diproses!'),
                        new TextDisplayBuilder().setContent(
                            '> Audio siap diputar! Klik tombol di bawah atau salin link-nya.',
                        ),
                    )
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(result.thumbnail)),
            );
        } else {
            successContainer.addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ✅ Audio Berhasil Diproses!'),
                new TextDisplayBuilder().setContent(
                    '> Audio siap diputar! Klik tombol di bawah atau salin link-nya.',
                ),
            );
        }

        successContainer
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `🎵 **Judul**\n> \`\`${result.title}\`\`\n\n` +
                    `⏱️ **Durasi:** ${formatDuration(result.duration)}\n` +
                    `📌 **Platform:** ${platform}\n` +
                    `👤 **Uploader:** ${result.uploader || 'Unknown'}\n` +
                    `🔊 **Bitrate:** ${result.bitrate || '128'}kbps`,
                ),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${hostLabel}\n> ${result.mp3Url}`,
                ),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `-# By • ${BOT_NAME}  |  ${platform} → ${getHostLabel(result.mp3Url).replace(/^.{2}/, '').trim()}`,
                ),
            )
            .addActionRowComponents(buildAudioButton(result.mp3Url));

        await processingMsg.edit({ components: [successContainer] });

    } catch (err) {
        console.error(`❌ [Boombox] Error:`, err.message);

        const errorContainer = new ContainerBuilder()
            .setAccentColor(0xEF4444)
            .addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ❌ Gagal Memproses Audio'),
                        new TextDisplayBuilder().setContent(
                            '> Terjadi kesalahan saat memproses URL.',
                        ),
                    )
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `📌 **Platform:** ${platform}\n` +
                    `🔗 **URL:** ${url}\n\n` +
                    `📝 **Detail**\n\`\`\`\n${err.message.substring(0, 800)}\n\`\`\``,
                ),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# Diminta oleh ${message.author.username}`),
            );

        await processingMsg.edit({ components: [errorContainer] }).catch(() => null);
    } finally {
        processingMessages.delete(normalized);
    }
  },
};
