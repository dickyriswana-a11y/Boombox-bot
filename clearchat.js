const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearchat')
    .setDescription('🧹 Hapus semua pesan di channel ini (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),   // hanya admin/mod

  async execute(interaction) {
    // konfirmasi awal
    await interaction.reply({ content: '⏳ Menghapus pesan…', ephemeral: true });

    let deleted = 0;
    let fetched;

    do {
      // Ambil max 100 pesan terbaru
      fetched = await interaction.channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;

      // Pisahkan pesan <= 14 hari (bisa bulkDelete) vs > 14 hari
      const younger = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
      const older   = fetched.filter(m => !younger.has(m.id));

      if (younger.size) {
        const del = await interaction.channel.bulkDelete(younger, true);
        deleted += del.size;
      }

      // Hapus yang lebih tua satu-satu (rate-limit friendly)
      for (const msg of older.values()) {
        await msg.delete().catch(() => null);
        deleted++;
      }
    } while (fetched.size >= 2); // loop sampai pesan habis

    await interaction.editReply({
      content: `✅ Berhasil menghapus **${deleted}** pesan di <#${interaction.channel.id}>.`
    });
  }
};