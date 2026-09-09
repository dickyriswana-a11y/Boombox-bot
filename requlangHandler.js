const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder,
  SeparatorBuilder, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { isAllowedChannel } = require('../utils/boomboxCache');
const { processUrl } = require('../utils/boomboxProcessor');
const { getGuildSettings } = require('../utils/boomboxSettingsStore');
const path = require('path');
const fs = require('fs');

const URL_REGEX = /https?:\/\/[^\s]+/i;
const CACHE_PATH = path.join(__dirname, '../utils/boombox_cache.json');
const BOT_NAME = '🎧 AzesZ BOT';

function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
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

function saveCacheData(url, data) {
    try {
        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        cache[normalizedUrl] = {
            title: data.title || 'Unknown Title',
            thumbnail: data.thumbnail || null,
            mp3Url: data.mp3Url || null,
            requestedBy: data.requestedBy || 'unknown',
            platform: data.platform || 'unknown',
            cachedAt: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
        console.log(`💾 [Cache] Saved: ${normalizedUrl} | by: ${data.requestedBy}`);
        return true;
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to save:', err.message);
        return false;
    }
}

function deleteCache(url) {
    try {
        const cache = loadCache();
        const normalizedUrl = normalizeUrl(url);
        if (cache[normalizedUrl]) {
            delete cache[normalizedUrl];
            fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
            console.log(`🗑️ [Cache] Deleted: ${normalizedUrl}`);
            return true;
        }
    } catch (err) {
        console.warn('⚠️ [Cache] Failed to delete:', err.message);
    }
    return false;
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
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
    if (!message.content.toLowerCase().startsWith('!requlang')) return;
    if (!isAllowedChannel(message.guild.id, message.channel.id)) return;

    const urlMatch = message.content.match(URL_REGEX);
    if (!urlMatch) {
      const botAvatar = message.client.user.displayAvatarURL({ extension: 'png', size: 256 });
      const container = new ContainerBuilder()
        .setAccentColor(0xEF4444)
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('## ❌ Format Perintah Salah'),
              new TextDisplayBuilder().setContent(
                '**Cara penggunaan:**\n' +
                '```\n!Requlang [URL]\n```\n' +
                '**Contoh:**\n' +
                '```\n!Requlang https://youtu.be/xxxxx\n```',
              ),
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# By • ${BOT_NAME}`),
        );

      return message.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    const url = urlMatch[0];
    const platform = detectPlatform(url);
    console.log(`🔄 [Requlang] ${platform} URL: ${url}`);

    deleteCache(url);

    const botAvatar = message.client.user.displayAvatarURL({ extension: 'png', size: 256 });
    const ts = Math.floor(Date.now() / 1000);

    const processingContainer = new ContainerBuilder()
      .setAccentColor(0xF0B132)
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## 🔄 Memproses Ulang Audio...'),
            new TextDisplayBuilder().setContent(
              '> Mengabaikan cache dan memproses audio dari awal.\n\n' +
              '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
              '*Biasanya memerlukan waktu **20–60 detik**.*',
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

    if (!processingMsg) return;

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
      console.log(`🔄 [Requlang] Re-processing ${platform}: ${url}`);
      const guildSettings = getGuildSettings(message.guild.id);
      const result = await processUrl(url, true, onProgress, guildSettings);
      console.log(`✅ [Requlang] Success: ${result.title}`);

      saveCacheData(url, {
        title: result.title,
        thumbnail: result.thumbnail,
        mp3Url: result.mp3Url,
        requestedBy: message.author.username,
        platform: platform,
      });

      const hostLabel = getHostLabel(result.mp3Url);

      // ── Container sukses (layout vertikal luas) ───────────────────
      const successContainer = new ContainerBuilder().setAccentColor(0x22C55E);

      if (result.thumbnail) {
        successContainer.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('## 🔄 Audio Berhasil Diperbarui!'),
              new TextDisplayBuilder().setContent(
                '> Audio baru berhasil digenerate! Klik tombol di bawah atau salin link-nya.',
              ),
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(result.thumbnail)),
        );
      } else {
        successContainer.addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## 🔄 Audio Berhasil Diperbarui!'),
          new TextDisplayBuilder().setContent(
            '> Audio baru berhasil digenerate! Klik tombol di bawah atau salin link-nya.',
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
      console.error(`❌ [Requlang] Error:`, err.message);

      const errorContainer = new ContainerBuilder()
        .setAccentColor(0xEF4444)
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('## ❌ Gagal Memproses Ulang'),
              new TextDisplayBuilder().setContent(
                '> Terjadi kesalahan saat memproses ulang audio.',
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
    }
  }
};
