// commands/boomboxSetup.js
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ContainerBuilder, TextDisplayBuilder, SectionBuilder,
    SeparatorBuilder, ThumbnailBuilder,
    MessageFlags,
} = require('discord.js');
const {
    getAllowedChannels,
    addAllowedChannel,
    removeAllowedChannel,
} = require('../../utils/boomboxCache');
const {
    getGuildSettings,
    setGuildSettings,
    resetGuildSettings,
} = require('../../utils/boomboxSettingsStore');

const BOT_NAME = '🎧 AzesZ BOT';

function bitrateLabel(bitrate) {
    if (bitrate === 'auto') return '🤖 Auto';
    return `📌 ${bitrate} kbps`;
}

function bitrateDesc(bitrate) {
    const descs = {
        'auto': 'Bitrate Optimal.',
        '128': 'Kualitas terbaik.',
        '96': 'Kualitas bagus.',
        '64': 'Kualitas sedang.',
        '48': 'Kualitas rendah.',
        '32': 'Kualitas minimum.',
    };
    return descs[String(bitrate)] || '';
}

function maxDurationLabel(minutes) {
    if (!minutes || minutes === 0) return '♾️ Tanpa Batas';
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} Jam`;
    return `${minutes} Menit`;
}

//  SLASH COMMAND
module.exports = {
    data: new SlashCommandBuilder()
        .setName('boombox')
        .setDescription('⚙️ Kelola Boombox (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub
                .setName('tambah')
                .setDescription('Tambahkan channel untuk fitur Boombox')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel yang ingin ditambahkan').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('hapus')
                .setDescription('Hapus channel dari daftar Boombox')
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel yang ingin dihapus').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list').setDescription('Lihat semua channel Boombox yang aktif')
        )
        .addSubcommand(sub =>
            sub
                .setName('settings')
                .setDescription('⚙️ Atur bitrate & durasi maksimum audio')
                .addStringOption(opt =>
                    opt
                        .setName('bitrate')
                        .setDescription('Pilih mode bitrate audio')
                        .addChoices(
                            { name: 'Auto', value: 'auto' },
                            { name: '128 kbps', value: '128' },
                            { name: '96 kbps', value: '96' },
                            { name: '64 kbps', value: '64' },
                            { name: '48 kbps', value: '48' },
                            { name: '32 kbps', value: '32' },
                        )
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('max-durasi')
                        .setDescription('Maks durasi video dalam menit (0 = tanpa batas)')
                        .setMinValue(0)
                        .setMaxValue(9999)
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const botAvatar = interaction.client.user.displayAvatarURL({ extension: 'png', size: 256 });

        // ── TAMBAH CHANNEL
        if (sub === 'tambah') {
            const channel = interaction.options.getChannel('channel');
            addAllowedChannel(guildId, channel.id);

            const container = new ContainerBuilder().setAccentColor(0x22C55E)
                .addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## ✅ Channel Boombox Ditambahkan'),
                            new TextDisplayBuilder().setContent(
                                `Channel <#${channel.id}> berhasil ditambahkan.\n\n` +
                                `Bot akan otomatis mendeteksi URL di channel tersebut dan mengkonversinya ke audio.`,
                            ),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ${BOT_NAME}`),
                );

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, ephemeral: true });
        }

        // ── HAPUS CHANNEL ───────────────────────────────────────────────
        if (sub === 'hapus') {
            const channel = interaction.options.getChannel('channel');
            removeAllowedChannel(guildId, channel.id);

            const container = new ContainerBuilder().setAccentColor(0xEF4444)
                .addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## 🗑️ Channel Boombox Dihapus'),
                            new TextDisplayBuilder().setContent(
                                `Channel <#${channel.id}> dihapus dari daftar Boombox.`,
                            ),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ${BOT_NAME}`),
                );

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, ephemeral: true });
        }

        // ── LIST CHANNEL ────────────────────────────────────────────────
        if (sub === 'list') {
            const channels = getAllowedChannels(guildId);

            const container = new ContainerBuilder().setAccentColor(0x5865F2)
                .addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## 📋 Daftar Channel Boombox'),
                            new TextDisplayBuilder().setContent(
                                channels.length === 0
                                    ? 'Belum ada channel yang disetup.\nGunakan `/boombox tambah #channel` untuk menambahkan.'
                                    : channels.map((id, i) => `${i + 1}. <#${id}>`).join('\n'),
                            ),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ${BOT_NAME}`),
                );

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, ephemeral: true });
        }

        // ── SETTINGS ────────────────────────────────────────────────────
        if (sub === 'settings') {
            const bitrateInput = interaction.options.getString('bitrate');
            const maxDurationInput = interaction.options.getInteger('max-durasi');

            if (!bitrateInput && maxDurationInput === null) {
                const current = getGuildSettings(guildId);

                const container = new ContainerBuilder().setAccentColor(0x5865F2);

                container.addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## ⚙️ Pengaturan Boombox'),
                            new TextDisplayBuilder().setContent(
                                '> Pengaturan audio untuk server ini.\n' +
                                '> Gunakan `/boombox settings` untuk mengubah.',
                            ),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
                );

                container
                    .addSeparatorComponents(new SeparatorBuilder())
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `🔊 **Bitrate Audio**\n> ${bitrateLabel(current.bitrate)}\n` +
                            `> ${bitrateDesc(current.bitrate)}\n\n` +
                            `⏱️ **Maks Durasi Video**\n> ${maxDurationLabel(current.maxDuration)}\n` +
                            `> ${current.maxDuration > 0 ? `Video lebih dari ${current.maxDuration} menit akan ditolak.` : 'Semua durasi video diperbolehkan.'}`,
                        ),
                    )
                    .addSeparatorComponents(new SeparatorBuilder())
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            '💡 **Cara mengubah:**\n' +
                            '```\n/boombox settings bitrate:128 max-durasi:60\n```\n' +
                            'Kedua opsi bersifat opsional — isi yang ingin diubah saja.',
                        ),
                    )
                    .addSeparatorComponents(new SeparatorBuilder())
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`-# ${BOT_NAME}  |  /boombox settings`),
                    );

                return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, ephemeral: true });
            }

            const updates = {};
            const changes = [];

            if (bitrateInput) {
                updates.bitrate = bitrateInput === 'auto' ? 'auto' : parseInt(bitrateInput);
                changes.push(`🔊 Bitrate → **${bitrateLabel(updates.bitrate)}**`);
            }

            if (maxDurationInput !== null) {
                updates.maxDuration = maxDurationInput;
                changes.push(`⏱️ Maks Durasi → **${maxDurationLabel(maxDurationInput)}**`);
            }

            const updated = setGuildSettings(guildId, updates);

            const container = new ContainerBuilder().setAccentColor(0x22C55E);

            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ✅ Pengaturan Diperbarui'),
                        new TextDisplayBuilder().setContent(
                            changes.map(c => `> ${c}`).join('\n'),
                        ),
                    )
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(botAvatar)),
            );

            container
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `🔊 **Bitrate Audio**\n> ${bitrateLabel(updated.bitrate)}\n` +
                        `> ${bitrateDesc(updated.bitrate)}\n\n` +
                        `⏱️ **Maks Durasi Video**\n> ${maxDurationLabel(updated.maxDuration)}\n` +
                        `> ${updated.maxDuration > 0 ? `Video lebih dari ${updated.maxDuration} menit akan ditolak.` : 'Semua durasi video diperbolehkan.'}`,
                    ),
                )
                .addSeparatorComponents(new SeparatorBuilder())
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ${BOT_NAME}  |  /boombox settings`),
                );

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, ephemeral: true });
        }
    },
};
