const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

if (process.env.NODE_ENV !== 'production') { try { require('dotenv').config(); } catch(e) {} }

// ─── Config ────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID     = process.env.CLIENT_ID;

// ─── Fichier de stockage des configs par serveur ───────────────────
const CONFIG_FILE = path.join(__dirname, 'configs.json');

function loadConfigs() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
}

// configs = { [guildId]: { universeId, channelId, interval, messageId } }
let configs = loadConfigs();

// ─── Timers actifs par serveur ─────────────────────────────────────
const timers = {};

// ─── Commandes slash ───────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure le bot pour afficher les stats de ton jeu Roblox')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('universe_id')
        .setDescription('L\'Universe ID de ton jeu Roblox')
        .setRequired(true))
    .addChannelOption(opt =>
      opt.setName('salon')
        .setDescription('Le salon où poster les stats')
        .setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('intervalle')
        .setDescription('Fréquence de mise à jour en minutes (défaut: 5)')
        .setMinValue(1)
        .setMaxValue(60)
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Affiche les stats de ton jeu Roblox maintenant'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Arrête les mises à jour automatiques des stats')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Affiche la configuration actuelle du bot sur ce serveur'),
].map(cmd => cmd.toJSON());

// ─── Enregistrement des commandes slash ───────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('📋  Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅  Commandes slash enregistrées !');
  } catch (err) {
    console.error('Erreur enregistrement commandes:', err.message);
  }
}

// ─── Roblox API ───────────────────────────────────────────────────
// FIX : utilise apis.roblox.com (non bloqué) + headers pour contourner Cloudflare
async function getRobloxGameStats(universeId) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.roblox.com/',
      'Accept': 'application/json',
    };

    const [gamesRes, votesRes] = await Promise.all([
      // Endpoint officiel non protégé par Cloudflare
      axios.get(`https://apis.roblox.com/universes/v1/universes/${universeId}`, { headers }),
      // Votes avec headers pour réduire les blocages
      axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`, { headers })
        .catch(() => ({ data: { data: [] } })),
    ]);

    const game  = gamesRes.data;
    const votes = votesRes.data.data?.[0];

    if (!game || !game.name) return null;

    return {
      name:           game.name,
      description:    game.description?.slice(0, 150) || '',
      visits:         game.visits,
      favoritedCount: game.favoritedCount,
      playing:        game.playing,
      playersOnline:  game.playing,
      upVotes:        votes?.upVotes   || 0,
      downVotes:      votes?.downVotes || 0,
      maxPlayers:     game.maxPlayers,
      updated:        game.updated,
      rootPlaceId:    game.rootPlaceId,
      thumbnailUrl:   null,
    };
  } catch (err) {
    console.error(`Erreur API Roblox (${universeId}):`, err.response?.status, err.message);
    return null;
  }
}

// ─── Format ────────────────────────────────────────────────────────
function formatNumber(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function likePercent(up, down) {
  const total = up + down;
  if (!total) return '—';
  return Math.round((up / total) * 100) + '%';
}

// ─── Embed ─────────────────────────────────────────────────────────
function buildEmbed(stats) {
  const now = new Date();
  return new EmbedBuilder()
    .setTitle(`🎮  ${stats.name}`)
    .setURL(`https://www.roblox.com/games/${stats.rootPlaceId}`)
    .setColor(0x00B06B)
    .setDescription(stats.description ? `> ${stats.description}` : '')
    .addFields(
      { name: '👥  Joueurs en ligne',    value: `\`\`\`${formatNumber(stats.playing)}\`\`\``,           inline: true },
      { name: '🔭  Total visites',       value: `\`\`\`${formatNumber(stats.visits)}\`\`\``,            inline: true },
      { name: '⭐  Favoris',             value: `\`\`\`${formatNumber(stats.favoritedCount)}\`\`\``,    inline: true },
      { name: '👍  Likes',               value: `\`\`\`${formatNumber(stats.upVotes)}\`\`\``,           inline: true },
      { name: '👎  Dislikes',            value: `\`\`\`${formatNumber(stats.downVotes)}\`\`\``,         inline: true },
      { name: '📊  Taux d\'approbation', value: `\`\`\`${likePercent(stats.upVotes, stats.downVotes)}\`\`\``, inline: true },
    )
    .setFooter({ text: `Mis à jour le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR')} • Roblox Stats Bot` })
    .setTimestamp();
}

// ─── Mise à jour des stats d'un serveur ───────────────────────────
async function updateStatsForGuild(guildId) {
  const cfg = configs[guildId];
  if (!cfg) return;

  try {
    const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel) {
      console.warn(`[${guildId}] Salon introuvable, arrêt.`);
      stopGuild(guildId);
      return;
    }

    const stats = await getRobloxGameStats(cfg.universeId);
    if (!stats) return console.warn(`[${guildId}] Stats Roblox indisponibles`);

    const embed = buildEmbed(stats);

    client.user.setActivity(`${formatNumber(stats.playing)} joueurs en ligne`, {
      type: ActivityType.Watching
    });

    if (cfg.messageId) {
      try {
        const msg = await channel.messages.fetch(cfg.messageId);
        await msg.edit({ embeds: [embed] });
        console.log(`[${new Date().toLocaleTimeString()}] [${guildId}] Stats mises à jour`);
        return;
      } catch {
        configs[guildId].messageId = null;
      }
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    if (existing) {
      configs[guildId].messageId = existing.id;
      await existing.edit({ embeds: [embed] });
    } else {
      const sent = await channel.send({ embeds: [embed] });
      configs[guildId].messageId = sent.id;
    }

    saveConfigs(configs);
    console.log(`[${new Date().toLocaleTimeString()}] [${guildId}] Stats publiées`);

  } catch (err) {
    console.error(`[${guildId}] Erreur updateStats:`, err.message);
  }
}

// ─── Démarrer/arrêter le timer d'un serveur ───────────────────────
function startGuild(guildId) {
  stopGuild(guildId);
  const cfg = configs[guildId];
  if (!cfg) return;

  updateStatsForGuild(guildId);
  timers[guildId] = setInterval(() => updateStatsForGuild(guildId), cfg.interval * 60 * 1000);
  console.log(`▶️  [${guildId}] Timer démarré (${cfg.interval} min)`);
}

function stopGuild(guildId) {
  if (timers[guildId]) {
    clearInterval(timers[guildId]);
    delete timers[guildId];
    console.log(`⏹️  [${guildId}] Timer arrêté`);
  }
}

// ─── Client Discord ────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// FIX : 'ready' renommé en 'clientReady' pour Discord.js v15
client.once('clientReady', async () => {
  console.log(`\n✅  Bot connecté : ${client.user.tag}`);
  console.log(`🌍  Présent sur ${client.guilds.cache.size} serveur(s)\n`);

  await registerCommands();

  for (const guildId of Object.keys(configs)) {
    console.log(`🔄  Reprise du timer pour le serveur ${guildId}`);
    startGuild(guildId);
  }
});

// ─── Gestion des commandes slash ──────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId } = interaction;

  // ── /setup ──────────────────────────────────────────────────────
  if (commandName === 'setup') {
    // FIX : ephemeral remplacé par MessageFlags.Ephemeral
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const universeId = interaction.options.getString('universe_id');
    const channel    = interaction.options.getChannel('salon');
    const interval   = interaction.options.getInteger('intervalle') || 5;

    const stats = await getRobloxGameStats(universeId);
    if (!stats) {
      return interaction.editReply({
        content: '❌ Universe ID invalide ou jeu introuvable. Vérifie l\'ID de ton jeu Roblox.',
      });
    }

    configs[guildId] = {
      universeId,
      channelId: channel.id,
      interval,
      messageId: null,
    };
    saveConfigs(configs);

    startGuild(guildId);

    const embed = new EmbedBuilder()
      .setTitle('✅  Bot configuré avec succès !')
      .setColor(0x00B06B)
      .addFields(
        { name: '🎮  Jeu détecté',      value: `**${stats.name}**`,       inline: false },
        { name: '📢  Salon',            value: `<#${channel.id}>`,         inline: true  },
        { name: '🔄  Intervalle',       value: `${interval} minute(s)`,    inline: true  },
        { name: '🆔  Universe ID',      value: `\`${universeId}\``,        inline: true  },
      )
      .setFooter({ text: 'Les stats vont apparaître dans le salon dans quelques secondes !' });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /stats ──────────────────────────────────────────────────────
  if (commandName === 'stats') {
    const cfg = configs[guildId];
    if (!cfg) {
      return interaction.reply({
        content: '❌ Le bot n\'est pas encore configuré sur ce serveur. Utilise `/setup` d\'abord.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    const stats = await getRobloxGameStats(cfg.universeId);
    if (!stats) {
      return interaction.editReply({ content: '❌ Impossible de récupérer les stats Roblox pour le moment.' });
    }

    return interaction.editReply({ embeds: [buildEmbed(stats)] });
  }

  // ── /stop ───────────────────────────────────────────────────────
  if (commandName === 'stop') {
    if (!configs[guildId]) {
      return interaction.reply({
        content: '❌ Le bot n\'est pas configuré sur ce serveur.',
        flags: MessageFlags.Ephemeral,
      });
    }

    stopGuild(guildId);
    delete configs[guildId];
    saveConfigs(configs);

    return interaction.reply({
      content: '⏹️  Les mises à jour automatiques ont été arrêtées et la configuration supprimée.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /config ─────────────────────────────────────────────────────
  if (commandName === 'config') {
    const cfg = configs[guildId];
    if (!cfg) {
      return interaction.reply({
        content: '❌ Aucune configuration trouvée. Utilise `/setup` pour démarrer.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('⚙️  Configuration actuelle')
      .setColor(0x5865F2)
      .addFields(
        { name: '🆔  Universe ID',  value: `\`${cfg.universeId}\``,               inline: true },
        { name: '📢  Salon',        value: `<#${cfg.channelId}>`,                  inline: true },
        { name: '🔄  Intervalle',   value: `${cfg.interval} minute(s)`,            inline: true },
        { name: '▶️  Timer actif',  value: timers[guildId] ? '✅ Oui' : '❌ Non',  inline: true },
      );

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
});

client.on('error', err => console.error('Erreur Discord:', err));

client.login(DISCORD_TOKEN);
