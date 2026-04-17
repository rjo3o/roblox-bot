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
// On essaie d'abord l'API directe, puis un proxy communautaire si bloqué
const ROBLOX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.roblox.com/',
};

async function tryFetch(url, options = {}) {
  const res = await axios.get(url, { headers: ROBLOX_HEADERS, timeout: 10000, ...options });
  return res.data;
}

async function fetchGameData(universeId) {
  // 1er essai : API directe Roblox
  try {
    const data = await tryFetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    const game = data?.data?.[0];
    if (game) { console.log(`[API] Direct OK`); return game; }
  } catch (err) {
    console.warn(`[API] Direct bloqué (${err.response?.status || err.message}), essai proxy...`);
  }

  // 2e essai : proxy RoPro (proxy public communautaire Roblox)
  try {
    const data = await tryFetch(`https://games.roproxy.com/v1/games?universeIds=${universeId}`);
    const game = data?.data?.[0];
    if (game) { console.log(`[API] Proxy RoPro OK`); return game; }
  } catch (err) {
    console.warn(`[API] Proxy RoPro échoué (${err.response?.status || err.message})`);
  }

  // 3e essai : proxy Polytoria
  try {
    const data = await tryFetch(`https://games.rbxproxy.com/v1/games?universeIds=${universeId}`);
    const game = data?.data?.[0];
    if (game) { console.log(`[API] Proxy rbxproxy OK`); return game; }
  } catch (err) {
    console.warn(`[API] Proxy rbxproxy échoué (${err.response?.status || err.message})`);
  }

  return null;
}

async function fetchVotes(universeId) {
  // NOTE: games.roblox.com/v1/games/votes est instable / déprécié.
  // On tente plusieurs proxies mais on renvoie null proprement si tout échoue.
  const urls = [
    `https://games.roproxy.com/v1/games/votes?universeIds=${universeId}`,
    `https://games.rbxproxy.com/v1/games/votes?universeIds=${universeId}`,
    `https://games.roblox.com/v1/games/votes?universeIds=${universeId}`,
  ];
  for (const url of urls) {
    try {
      const data = await tryFetch(url);
      const votes = data?.data?.[0];
      if (votes) return votes;
    } catch {}
  }
  console.warn(`[API] Votes indisponibles pour ${universeId} (endpoint déprécié)`);
  return null;  // On ne plante pas, on retourne null
}

async function getRobloxGameStats(universeId) {
  try {
    // Promise.allSettled au lieu de Promise.all → les votes peuvent échouer sans tout casser
    const [gameResult, votesResult] = await Promise.allSettled([
      fetchGameData(universeId),
      fetchVotes(universeId),
    ]);

    const game  = gameResult.status  === 'fulfilled' ? gameResult.value  : null;
    const votes = votesResult.status === 'fulfilled' ? votesResult.value : null;

    if (!game) {
      console.error(`Erreur API Roblox (${universeId}): aucun jeu trouvé (tous les proxies ont échoué)`);
      return null;
    }

    return {
      name:           game.name,
      description:    game.description?.slice(0, 150) || '',
      visits:         game.visits,
      favoritedCount: game.favoritedCount,
      playing:        game.playing,
      playersOnline:  game.playing,
      votesAvailable: !!votes,
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
  const embed = new EmbedBuilder()
    .setTitle(`🎮  ${stats.name}`)
    .setURL(`https://www.roblox.com/games/${stats.rootPlaceId}`)
    .setColor(0x00B06B)
    .addFields(
      { name: '👥  Joueurs en ligne', value: `**${formatNumber(stats.playing)}**`,       inline: true },
      { name: '🔭  Total visites',    value: `**${formatNumber(stats.visits)}**`,         inline: true },
      { name: '⭐  Favoris',          value: `**${formatNumber(stats.favoritedCount)}**`, inline: true },
      { name: '👍  Likes',    value: stats.votesAvailable ? `**${formatNumber(stats.upVotes)}**`   : '`N/A`', inline: true },
      { name: '👎  Dislikes', value: stats.votesAvailable ? `**${formatNumber(stats.downVotes)}**` : '`N/A`', inline: true },
      { name: '📊  Approbation', value: stats.votesAvailable ? `**${likePercent(stats.upVotes, stats.downVotes)}**` : '`N/A`', inline: true },
    )
    .setFooter({ text: `Mis à jour le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR')} • Roblox Stats Bot` })
    .setTimestamp();

  // IMPORTANT: setDescription('') fait planter l'API Discord (erreur 50035)
  // On ne l'appelle que si la description est non-vide
  if (stats.description && stats.description.trim().length > 0) {
    embed.setDescription(`> ${stats.description}`);
  }

  return embed;
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
    // Log détaillé : on affiche le code d'erreur Discord + les erreurs par champ si disponibles
    const discordErrors = err.rawError?.errors ? JSON.stringify(err.rawError.errors, null, 2) : '';
    console.error(`[${guildId}] Erreur updateStats: ${err.message}${discordErrors ? '\nDétails: ' + discordErrors : ''}`);
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
        content: '❌ Universe ID invalide. Assure-toi d\'utiliser l\'**Universe ID** (pas le Place ID). Va sur create.roblox.com → ton jeu → URL → le numéro après /experiences/ = Universe ID. Si l\'ID est correct, l\'API Roblox est peut-être bloquée depuis cet hébergeur.',
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
