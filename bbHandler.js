// commands/bbHandler.js
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  SeparatorBuilder, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { searchYouTube } = require('../utils/youtubeSearch');
const { processUrl } = require('../utils/boomboxProcessor');
const { isAllowedChannel } = require('../utils/boomboxCache');
const { getGuildSettings } = require('../utils/boomboxSettingsStore');
const { processingMessages } = require('../utils/sharedState');

const searchSessions = new Map();

function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViews(views) {
    if (!views) return 'N/A';
    if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
    if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
    return views.toString();
}

function getEmoji(index) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    return emojis[index] || '🎵';
}

function getThumbnail(video) {
    if (video.thumbnail && video.thumbnail.startsWith('http')) {
        return video.thumbnail;
    }
    if (video.videoId) {
        return `https://img.youtube.com/vi/${video.videoId}/maxresdefault.jpg`;
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
        return urlObj.origin + urlObj.pathname;
    } catch {
        return url.split('?')[0];
    }
}

async function showResult(message, sessionId) {
    const session = searchSessions.get(sessionId);
    if (!session) {
        const container = new ContainerBuilder()
            .setAccentColor(0xEF4444)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ❌ Sesi Kadaluarsa'),
                new TextDisplayBuilder().setContent('Silakan cari ulang dengan `!bb [query]`'),
            );
        return message.edit({ components: [container] });
    }

    const { results, currentIndex, total, query } = session;
    const video = results[currentIndex];
    const page = currentIndex + 1;
    const duration = video.duration ? formatDuration(video.duration) : 'N/A';
    const emoji = getEmoji(currentIndex);
    const thumbnail = getThumbnail(video);

    const container = new ContainerBuilder().setAccentColor(0x5865F2);

    if (thumbnail) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`## ${emoji} ${video.title}`),
                )
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail)),
        );
    } else {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${emoji} ${video.title}`),
        );
    }

    container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `📺 **Channel**\n> ${video.channelTitle || 'Unknown'}\n\n` +
                `⏱️ **Durasi**\n> ${duration}\n\n` +
                `👁️ **Views**\n> ${formatViews(video.viewCount)}`,
            ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`📄 **Hasil:** ${page} dari ${total}\n-# 🔍 Pencarian: "${query}"`),
        )
        .addActionRowComponents(
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`bb_prev_${sessionId}`)
                        .setLabel('◀ Prev')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentIndex === 0 && total === 1),
                    new ButtonBuilder()
                        .setCustomId(`bb_convert_${sessionId}`)
                        .setLabel('🎵 Convert')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`bb_next_${sessionId}`)
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentIndex === total - 1 && total === 1)
                ),
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`bb_info_${sessionId}`)
                        .setLabel(`📄 ${page}/${total}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                ),
        );

    await message.edit({ components: [container] });
}

async function handleBbCommand(message, query) {
    if (!query || query.length === 0) {
        return message.reply({
            content: '❌ Masukkan kata kunci pencarian.\nContoh: `!bb monolog`'
        });
    }

    if (!isAllowedChannel(message.guild.id, message.channel.id)) {
        return message.reply({
            content: '❌ Channel ini tidak diizinkan untuk menggunakan fitur ini.'
        });
    }

    const loadingContainer = new ContainerBuilder()
        .setAccentColor(0xF0B132)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## 🔍 Mencari...'),
            new TextDisplayBuilder().setContent(`\`${query}\`\n\n> Sedang mencari video di YouTube...`),
        );

    const processingMsg = await message.reply({
        components: [loadingContainer],
        flags: MessageFlags.IsComponentsV2,
    });

    try {
        const results = await searchYouTube(query, 10);
        
        if (!results || results.length === 0) {
            const noResultContainer = new ContainerBuilder()
                .setAccentColor(0xEF4444)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('## ❌ Tidak Ditemukan'),
                    new TextDisplayBuilder().setContent(`Tidak ada hasil untuk: \`${query}\``),
                );
            return processingMsg.edit({ components: [noResultContainer] });
        }

        const sessionId = message.author.id;
        searchSessions.set(sessionId, {
            query: query,
            results: results,
            currentIndex: 0,
            total: results.length,
            timestamp: Date.now(),
            messageId: processingMsg.id,
            channelId: message.channel.id
        });

        await showResult(processingMsg, sessionId);

    } catch (err) {
        console.error('❌ [BB] Error:', err.message);
        const errorContainer = new ContainerBuilder()
            .setAccentColor(0xEF4444)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ❌ Gagal Mencari'),
                new TextDisplayBuilder().setContent(`Terjadi kesalahan: ${err.message}`),
            );
        processingMsg.edit({ components: [errorContainer] });
    }
}

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    if (!customId || !customId.startsWith('bb_')) return;

    const parts = customId.split('_');
    const action = parts[1];
    const sessionId = parts.slice(2).join('_');
    const userId = interaction.user.id;

    if (sessionId !== userId) {
        return interaction.reply({
            content: '❌ Ini bukan sesi pencarian Anda. Silakan cari sendiri dengan `!bb [query]`.',
            ephemeral: true
        });
    }

    const session = searchSessions.get(sessionId);
    if (!session) {
        return interaction.reply({
            content: '❌ Sesi pencarian kadaluarsa. Silakan cari ulang dengan `!bb [query]`.',
            ephemeral: true
        });
    }

    if (action === 'prev') {
        session.currentIndex = (session.currentIndex - 1 + session.total) % session.total;
        searchSessions.set(sessionId, session);
        await interaction.deferUpdate();
        await showResult(interaction.message, sessionId);
        return;
    }

    if (action === 'next') {
        session.currentIndex = (session.currentIndex + 1) % session.total;
        searchSessions.set(sessionId, session);
        await interaction.deferUpdate();
        await showResult(interaction.message, sessionId);
        return;
    }

    if (action === 'convert') {
        const video = session.results[session.currentIndex];
        const videoId = video.videoId;
        const videoUrl = `https://youtube.com/watch?v=${videoId}`;
        const thumbnail = getThumbnail(video);

        const normalizedUrl = normalizeUrl(videoUrl);
        processingMessages.add(normalizedUrl);
        console.log(`🔒 [BB] Added to processingMessages: ${normalizedUrl}`);

        const processingContainer = new ContainerBuilder()
            .setAccentColor(0xF0B132)
            .addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ⏳ Memproses Audio...'),
                        new TextDisplayBuilder().setContent(
                            `> Sedang mengunduh dan mengupload audio...\nMohon tunggu sebentar.`,
                        ),
                    )
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail || interaction.client.user.displayAvatarURL({ extension: 'png', size: 256 }))),
            );

        await interaction.update({ components: [processingContainer] });

        const onProgress = async (stage, data = {}) => {
            const thumb = thumbnail || interaction.client.user.displayAvatarURL({ extension: 'png', size: 256 });
            let container;
            if (stage === 'analyzing') {
                container = new ContainerBuilder()
                    .setAccentColor(0x8B5CF6)
                    .addSectionComponents(
                        new SectionBuilder()
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## 🔍 Menganalisis Video...'),
                                new TextDisplayBuilder().setContent(
                                    `> Membaca informasi video untuk menentukan kualitas audio terbaik...\n\n` +
                                    '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                                    '*Tahap: Analisis durasi & perhitungan bitrate.*',
                                ),
                            )
                            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
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
                                    `> Audio sedang diunduh dan dikonversi ke MP3...` +
                                    qualityNote + '\n\n' +
                                    '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                                    '*Tahap: Mengunduh & konversi audio.*',
                                ),
                            )
                            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
                    );
            } else if (stage === 'compressing') {
                container = new ContainerBuilder()
                    .setAccentColor(0xFF6B35)
                    .addSectionComponents(
                        new SectionBuilder()
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## 🗜️ Mengompres Audio...'),
                                new TextDisplayBuilder().setContent(
                                    `> Audio masih melebihi 100 MB! Sedang mengompres agar muat diupload...\n\n` +
                                    '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                                    '*Tahap: Kompresi tambahan (turunkan bitrate).*',
                                ),
                            )
                            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
                    );
            } else if (stage === 'uploading') {
                container = new ContainerBuilder()
                    .setAccentColor(0x5865F2)
                    .addSectionComponents(
                        new SectionBuilder()
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## 📤 Mengupload Audio...'),
                                new TextDisplayBuilder().setContent(
                                    `> Audio siap! Sedang mengupload ke hosting...\n\n` +
                                    '```⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿  Mohon tunggu sebentar```\n' +
                                    '*Tahap: Mengupload ke server hosting.*',
                                ),
                            )
                            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
                    );
            }

            if (container) {
                await interaction.message.edit({ components: [container] }).catch(() => null);
            }
        };

        try {
            console.log(`🔄 [BB] Converting: ${videoUrl} (ID: ${videoId})`);
            const guildSettings = getGuildSettings(interaction.guild.id);
            const result = await processUrl(videoUrl, true, onProgress, guildSettings);
            console.log(`✅ [BB] Success: ${result.title}`);

            const resultThumb = result.thumbnail || thumbnail;

            const successContainer = new ContainerBuilder().setAccentColor(0x22C55E);

            if (resultThumb) {
                successContainer.addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## ✅ Audio Berhasil Diproses!'),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(resultThumb)),
                );
            } else {
                successContainer.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('## ✅ Audio Berhasil Diproses!'),
                );
            }

            successContainer
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `🎵 **Judul**\n> \`\`${result.title}\`\`\n\n` +
                        `⏱️ **Durasi:** ${formatDuration(result.duration)}\n` +
                        `👤 **Uploader:** ${result.uploader || 'Unknown'}\n` +
                        `🔊 **Bitrate:** ${result.bitrate || '128'}kbps`,
                    ),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `🔗 **Link Audio**\n> ${result.mp3Url}\n\n` +
                        `🎬 **YouTube**\n> [Klik disini](${videoUrl})`,
                    ),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('-# 🎧 AzesZ Boombox'),
                )
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('▶ Putar / Download')
                            .setStyle(ButtonStyle.Link)
                            .setURL(result.mp3Url)
                            .setEmoji('🎵'),
                        new ButtonBuilder()
                            .setLabel('🎬 YouTube')
                            .setStyle(ButtonStyle.Link)
                            .setURL(videoUrl)
                            .setEmoji('🔗')
                    ),
                );

            await interaction.message.edit({ components: [successContainer] });
            searchSessions.delete(sessionId);

        } catch (err) {
            console.error('❌ [BB Convert] Error:', err.message);
            console.error(err.stack);

            const errorContainer = new ContainerBuilder()
                .setAccentColor(0xEF4444)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('## ❌ Gagal Konversi'),
                    new TextDisplayBuilder().setContent(
                        `> Gagal memproses audio.\n\n` +
                        `📝 **Detail**\n\`\`\`\n${err.message.substring(0, 800)}\n\`\`\``,
                    ),
                );

            await interaction.message.edit({ components: [errorContainer] }).catch(() => null);
        } finally {
            processingMessages.delete(normalizedUrl);
            console.log(`🔓 [BB] Removed from processingMessages: ${normalizedUrl}`);
        }
        return;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [key, session] of searchSessions) {
        if (now - session.timestamp > 10 * 60 * 1000) {
            searchSessions.delete(key);
            console.log(`🧹 [BB] Session expired: ${key}`);
        }
    }
}, 60 * 1000);

module.exports = { handleBbCommand, handleButtonInteraction };
