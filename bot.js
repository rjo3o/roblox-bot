const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ─── Configuration ───────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const UNIVERSE_ID     = process.env.ROBLOX_UNIVERSE_ID;
const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID;
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL_MINUTES || '5') * 60 * 1000;

// ─── Roblox API ───────────────────────────────────────────────────
async function getRobloxGameStats() {
  try {
    // Game details (visits, favorites, likes)
    const [gamesRes, votesRes, activePlayers] = await Promise.all([
      axios.get(`https://games.roblox.com/v1/games?universeIds=${UNIVERSE_ID}`),
      axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${UNIVERSE_ID}`),
      axios.get(`https://games.roblox.com/v1/games/${UNIVERSE_ID}/servers/Public?sortOrder=Asc&limit=100`)
        .catch(() => ({ data: { data: [] } }))
    ]);

    const game  = gamesRes.data.data[0];
    const votes = votesRes.data.data[0];

    // Count active players from public servers
    const servers = activePlayers.data.data || [];
    const playersOnline = servers.reduce((sum, s) => sum + (s.playing || 0), 0);

    return {
      name:          game.name,
      description:   game.description?.slice(0, 100) || '',
      visits:        game.visits,
      favoritedCount: game.favoritedCount,
      playing:       game.playing,         // Roblox official count
      playersOnline, // from servers list
      upVotes:       votes?.upVotes   || 0,
      downVotes:     votes?.downVotes || 0,
      maxPlayers:    game.maxPlayers,
      created:       game.created,
      updated:       game.updated,
      rootPlaceId:   game.rootPlaceId,
    };
  } catch (err) {
    console.error('Erreur API Roblox:', err.message);
    return null;
  }
}

// ─── Format numbers ────────────────────────────────────────────────
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

// ─── Build embed ───────────────────────────────────────────────────
function buildEmbed(stats) {
  const now = new Date();

  const embed = new EmbedBuilder()
    .setTitle(`🎮  ${stats.name}`)
    .setURL(`https://www.roblox.com/games/${stats.rootPlaceId}`)
    .setColor(0x00B06B)
    .setDescription(stats.description ? `> ${stats.description}` : '')
    .addFields(
      {
        name: '👥  Joueurs en ligne',
        value: `\`\`\`${formatNumber(stats.playing)}\`\`\``,
        inline: true,
      },
      {
        name: '🔭  Total visites',
        value: `\`\`\`${formatNumber(stats.visits)}\`\`\``,
        inline: true,
      },
      {
        name: '⭐  Favoris',
        value: `\`\`\`${formatNumber(stats.favoritedCount)}\`\`\``,
        inline: true,
      },
      {
        name: '👍  Likes',
        value: `\`\`\`${formatNumber(stats.upVotes)}\`\`\``,
        inline: true,
      },
      {
        name: '👎  Dislikes',
        value: `\`\`\`${formatNumber(stats.downVotes)}\`\`\``,
        inline: true,
      },
      {
        name: '📊  Taux d\'approbation',
        value: `\`\`\`${likePercent(stats.upVotes, stats.downVotes)}\`\`\``,
        inline: true,
      }
    )
    .setFooter({ text: `Mis à jour le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR')} • Roblox Stats Bot` })
    .setTimestamp();

  return embed;
}

// ─── Update stats message ──────────────────────────────────────────
let statsMessageId = null;

async function updateStats() {
  try {
    const channel = await client.channels.fetch(STATS_CHANNEL_ID);
    if (!channel) return console.error('Salon introuvable');

    const stats = await getRobloxGameStats();
    if (!stats) return console.error('Stats Roblox indisponibles');

    const embed = buildEmbed(stats);

    // Update bot activity
    client.user.setActivity(`${formatNumber(stats.playing)} joueurs en ligne`, {
      type: ActivityType.Watching
    });

    if (statsMessageId) {
      try {
        const msg = await channel.messages.fetch(statsMessageId);
        await msg.edit({ embeds: [embed] });
        console.log(`[${new Date().toLocaleTimeString()}] Stats mises à jour`);
        return;
      } catch {
        statsMessageId = null; // Message supprimé, on en recrée un
      }
    }

    // Chercher un message existant du bot dans le salon
    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    if (existing) {
      statsMessageId = existing.id;
      await existing.edit({ embeds: [embed] });
    } else {
      const sent = await channel.send({ embeds: [embed] });
      statsMessageId = sent.id;
    }

    console.log(`[${new Date().toLocaleTimeString()}] Stats publiées (ID: ${statsMessageId})`);
  } catch (err) {
    console.error('Erreur updateStats:', err.message);
  }
}

// ─── Events ────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Bot connecté : ${client.user.tag}`);
  console.log(`📡  Univers Roblox : ${UNIVERSE_ID}`);
  console.log(`📢  Salon stats    : ${STATS_CHANNEL_ID}`);
  console.log(`🔄  Intervalle     : ${UPDATE_INTERVAL / 60000} min\n`);

  await updateStats();
  setInterval(updateStats, UPDATE_INTERVAL);
});

client.on('error', err => console.error('Erreur Discord:', err));

client.login(DISCORD_TOKEN);
