const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config.json');

// Koleksi semua command
const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

// Ambil setiap file command
for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`📦 [Command] Disiapkan untuk deploy: ${file}`);
    } else {
      console.warn(`⚠️ [Command] Format salah di file: ${file}`);
    }
  }
}

// Deploy menggunakan REST
const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`🚀 [Deploy] Mengirim ${commands.length} command ke Discord API...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('✅ [Deploy] Semua command berhasil didaftarkan ke Discord!');
  } catch (err) {
    console.error('❌ [Deploy] Gagal mendaftarkan command:', err);
  }
})();