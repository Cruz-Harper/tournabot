require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const ui = require('./ui.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const prefix = ',';
const K = 32; 
const CREATOR_ID = "1364776113922117695";

// -------------------- ELO Functions --------------------
function expectedScore(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function calculateElo(winnerRating, loserRating) {
  const newWinner = winnerRating + K * (1 - expectedScore(winnerRating, loserRating));
  const newLoser = loserRating + K * (0 - expectedScore(loserRating, winnerRating));
  return [Math.round(newWinner), Math.round(newLoser)];
}

// -------------------- Points --------------------
function parsePointsFromEmbed(embed) {
  const points = {};
  if (!embed?.description) return points;
  for (const line of embed.description.split('\n')) {
    const match = line.match(/^\d+\.\s\*\*(.+?)\*\*\s—\s(\d+)\spts$/);
    if (match) points[match[1]] = parseInt(match[2]);
  }
  return points;
}

function buildPointsEmbed(points, guild, title = '📊 Points Leaderboard') {
  const members = guild.members?.cache || new Map();
  const entries = Object.entries(points)
    .map(([name, pts]) => ({ name: members.find?.(m => m.displayName === name)?.displayName || name, pts }))
    .sort((a, b) => b.pts - a.pts);
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x00aeff)
    .setDescription(entries.map((e, i) => `${i + 1}. **${e.name}** — ${e.pts} pts`).join('\n') || '*No points yet.*')
    .setFooter({ text: 'ELO ratings are adaptive!' })
    .setTimestamp();
}

// -------------------- Config --------------------
async function fetchConfig(guild) {
  const defaultConfig = { pointsChannelId: null, pointsMessageId: null };
  const configChannel = guild.channels.cache.find(c => c.name === 'channel-id' && c.isTextBased());
  if (!configChannel) return defaultConfig;
  const msg = (await configChannel.messages.fetch({ limit: 1 }).catch(() => null))?.first();
  if (!msg) return defaultConfig;
  const [chanId, msgId] = msg.content.split(',').map(s => s.trim());
  return { pointsChannelId: chanId || null, pointsMessageId: msgId || null };
}

async function saveConfig(guild, config) {
  let configChannel = guild.channels.cache.find(c => c.name === 'channel-id' && c.isTextBased());
  if (!configChannel) {
    configChannel = await guild.channels.create({
      name: 'channel-id',
      type: 0,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }]
    });
  }
  const messages = await configChannel.messages.fetch({ limit: 10 }).catch(() => new Map());
  for (const m of messages.values()) await m.delete().catch(() => {});
  await configChannel.send(`${config.pointsChannelId},${config.pointsMessageId}`).catch(() => {});
}

async function fetchPoints(config, guild) {
  if (!config.pointsChannelId || !config.pointsMessageId) return {};
  const channel = guild.channels.cache.get(config.pointsChannelId);
  const msg = await channel?.messages.fetch(config.pointsMessageId).catch(() => null);
  return msg?.embeds?.[0] ? parsePointsFromEmbed(msg.embeds[0]) : {};
}

async function updateLeaderboard(guild, points, config) {
  const channel = guild.channels.cache.get(config.pointsChannelId);
  if (!channel?.isTextBased()) return;
  const msg = await channel.messages.fetch(config.pointsMessageId).catch(() => null);
  if (!msg) return;
  const embed = buildPointsEmbed(points, guild);
  await msg.edit({ content: `📊 Current ELO Ratings:`, embeds: [embed] }).catch(() => {});
  await saveConfig(guild, config);
}

// -------------------- History --------------------
async function ensureHistoryChannel(guild) {
  let ch = guild.channels.cache.find(c => c.name === 'history' && c.isTextBased());
  if (!ch) {
    ch = await guild.channels.create({
      name: 'history',
      type: 0,
      permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel] }]
    }).catch(() => null);
  }
  return ch;
}

// -------------------- Ready --------------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => {});
    await guild.members.fetch().catch(() => {});
    const config = await fetchConfig(guild);
    const points = await fetchPoints(config, guild);
    await updateLeaderboard(guild, points, config);
    await ensureHistoryChannel(guild);
  }
});

// -------------------- Commands --------------------
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;
  const [cmd, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  const mention = message.mentions.members.first();
  const guild = message.guild;
  const config = await fetchConfig(guild);
  const points = await fetchPoints(config, guild);
  const historyChannel = await ensureHistoryChannel(guild);

  switch (cmd.toLowerCase()) {
    case 'setchannel': {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
      const chan = message.mentions.channels.first();
      if (!chan?.isTextBased()) return message.reply('❌ Mention a valid text channel.');
      const embed = buildPointsEmbed(points, guild);
      const msg = await chan.send({ content: `📊 Current ELO Ratings:`, embeds: [embed] }).catch(() => {});
      config.pointsChannelId = chan.id;
      config.pointsMessageId = msg?.id || null;
      await saveConfig(guild, config);
      return message.reply('✅ Points channel set.');
    }

    case 'startmatch': {
      if (!mention) return message.reply("❌ Mention your opponent. Example: `,startmatch @opponent`");
      if (mention.id === message.member.id) return message.reply("❌ You cannot play against yourself.");
      await ui.startMatch(client, message.channel, message.member, mention, points, config, historyChannel);
      break;
    }

    case 'getpoints': {
      const target = mention || message.member;
      const score = points[target.displayName] || 1200;
      return message.reply({ embeds: [new EmbedBuilder().setTitle(`📈 ${target.displayName}'s ELO`).setColor(0x00ff99).setDescription(`**${score}** pts`).setTimestamp()] });
    }

    case 'top': return message.reply({ embeds: [buildPointsEmbed(points, guild)] });

    case 'worldtop': {
      const worldPoints = {};
      for (const g of client.guilds.cache.values()) {
        const cfg = await fetchConfig(g);
        const pts = await fetchPoints(cfg, g);
        for (const [name, score] of Object.entries(pts)) {
          worldPoints[`${name} (${g.name})`] = Math.max(worldPoints[`${name} (${g.name})`] || 0, score);
        }
      }
      const embed = buildPointsEmbed(worldPoints, { members: { cache: [] } }, '🌎 World Leaderboard');
      return message.reply({ embeds: [embed] });
    }

    case 'history': {
      const target = mention || message.member;
      const msgs = await historyChannel.messages.fetch({ limit: 100 }).catch(() => new Map());
      const userEmbeds = msgs.filter(m => m.embeds?.[0]?.description?.includes(target.displayName));
      if (!userEmbeds.size) return message.reply('⚠️ No match history found for this user.');
      return message.reply({ embeds: userEmbeds.map(m => m.embeds[0]) });
    }

    case 'ping': return message.reply(`🏓 Pong! ${client.ws.ping}ms`);

    case 'help': return message.reply({
      embeds: [new EmbedBuilder().setTitle('📘 Commands').setColor(0x8888ff).setDescription(`
\`,setchannel #channel\` — Set leaderboard channel
\`,startmatch @opponent\` — Start a match with UI
\`,getpoints [@user]\` — Show user's ELO
\`,history [@user]\` — Show match history of a user
\`,top\` — Show server leaderboard
\`,worldtop\` — Show global leaderboard
\`,ping\` — Bot ping
\`,help\` — This help message
      `)]
    });

    default: return message.reply('❓ Unknown command. Use `,help`.');
  }
});

client.login(process.env.TOKEN5);
