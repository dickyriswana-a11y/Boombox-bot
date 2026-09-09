console.log('🚀 [AzesZ Boombox] Memulai proses inisialisasi...');

const fs = require('fs');
const path = require('path');

const { ensurePackagesInstalled } = require('./utils/autoInstall');

ensurePackagesInstalled([
  '@distube/ytdl-core',
]);

process.on('unhandledRejection', err => {
  console.error('❌ [Global] Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', err => {
  console.error('❌ [Global] Uncaught Exception:', err);
});

const { Client, Collection, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const config = require('./config.json');

const { handleButtonInteraction } = require('./commands/bbHandler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

client.commands = new Collection();
client.pendingRequests = new Map();

console.log('✅ [Init] Module dan client Discord berhasil di-load.');

const commandsArray = [];
const foldersPath = path.join(__dirname, 'commands');

if (fs.existsSync(foldersPath)) {
  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    if (!fs.statSync(path.join(foldersPath, folder)).isDirectory()) continue;
    
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
          client.commands.set(command.data.name, command);
          commandsArray.push(command.data.toJSON());
          console.log(`✅ [Command] Berhasil dimuat: ${file}`);
        } else {
          console.warn(`⚠️ [Command] Format salah di: ${file}`);
        }
      } catch (err) {
        console.error(`❌ [Command] Gagal load ${file}:`, err);
      }
    }
  }

  if (commandsArray.length > 0) {
    const rest = new REST({ version: '10' }).setToken(config.token);
    rest.put(Routes.applicationCommands(config.clientId), { body: commandsArray })
      .then(() => console.log('📤 [Deploy] Slash commands berhasil di-deploy!'))
      .catch(err => console.error('❌ [Deploy] Gagal deploy commands:', err));
  }
} else {
  console.log('ℹ️ [Init] Folder commands tidak ditemukan.');
}

const eventsPath = path.join(__dirname, 'events');

if (fs.existsSync(eventsPath)) {
  const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    try {
      const event = require(filePath);
      const eventType = event.once ? 'once' : 'on';
      client[eventType](event.name, (...args) => event.execute(...args, client));
      console.log(`✅ [Event] Berhasil dimuat: ${file}`);
    } catch (err) {
      console.error(`❌ [Event] Gagal load ${file}:`, err);
    }
  }
} else {
  console.log('ℹ️ [Init] Folder events tidak ditemukan.');
}

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(`❌ [Autocomplete] Gagal pada: ${interaction.commandName}`, err);
      await interaction.respond([]).catch(() => null);
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
      return interaction.reply({ 
        content: '❌ Command tidak ditemukan.', 
        ephemeral: true 
      }).catch(() => null);
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`❌ [Exec] Gagal eksekusi: ${interaction.commandName}`, err);
      
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: `❌ Terjadi error: ${err.message || 'Unknown error'}`, 
          ephemeral: true 
        }).catch(() => null);
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.followUp({ 
          content: `❌ Terjadi error: ${err.message || 'Unknown error'}`, 
          ephemeral: true 
        }).catch(() => null);
      }
    }
  }
});

client.login(config.token)
  .then(() => console.log('🔐 [Login] Bot berhasil login ke Discord!'))
  .catch(err => console.error('❌ [Login] Gagal login ke Discord:', err));