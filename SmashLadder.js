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
const K = 32; // ELO K-factor

// -------------------- ELO Functions --------------------
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function calculateElo(winnerRating, loserRating) {
  const expectedWin = expectedScore(winnerRating, loserRating);
  const expectedLose = expectedScore(loserRating, winnerRating);
  const newWinner = winnerRating + K * (1 - expectedWin);
  const newLoser = loserRating + K * (0 - expectedLose);
  return [Math.round(newWinner), Math.round(newLoser)];
}

// -------------------- Leaderboard Embed --------------------
function parsePointsFromEmbed(embed) {
  const points = {};
  if (!embed?.description) return points;
  const lines = embed.description.split('\n');
  for (const line of lines) {
    const match = line.match(/^\d+\.\s\*\*(.+?)\*\*\s—\s(\d+)\spts$/);
    if (match) points[match[1]] = parseInt(match[2]);
  }
  return points;
}

function buildPointsEmbed(points, guild, title = '📊 Points Leaderboard') {
  const members = guild.members?.cache || new Map();
  const entries = Object.entries(points)
    .map(([name, pts]) => {
      const member = members.find?.(m => m.displayName === name);
      return member ? { name: member.displayName, pts } : { name, pts };
    })
    .filter(Boolean)
    .sort((a, b) => b.pts - a.pts);
  const description = entries.map((entry, i) => `${i + 1}. **${entry.name}** — ${entry.pts} pts`).join('\n');
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x00aeff)
    .setDescription(description || '*No points yet.*')
    .setFooter({ text: 'ELO ratings are adaptive!' })
    .setTimestamp();
}

// -------------------- Config --------------------
async function fetchConfig(guild) {
  const defaultConfig = { pointsChannelId: null, pointsMessageId: null };
  const configChannel = guild.channels.cache.find(c => c.name === 'channel-id' && c.isTextBased());
  if (!configChannel) return defaultConfig;

  const messages = await configChannel.messages.fetch({ limit: 1 }).catch(() => null);
  if (!messages || messages.size === 0) return defaultConfig;

  const content = messages.first().content;
  const parts = content.split(',');
  if (parts.length < 2) return defaultConfig;

  return {
    pointsChannelId: parts[0].trim(),
    pointsMessageId: parts[1].trim(),
  };
}

async function saveConfig(guild, config) {
  let configChannel = guild.channels.cache.find(c => c.name === 'channel-id' && c.isTextBased());
  if (!configChannel) {
    configChannel = await guild.channels.create({
      name: 'channel-id',
      type: 0,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: ['ViewChannel'] }],
    });
  }

  const messages = await configChannel.messages.fetch({ limit: 10 }).catch(() => null);
  if (messages) for (const msg of messages.values()) await msg.delete().catch(() => {});

  const line = `${config.pointsChannelId},${config.pointsMessageId}`;
  await configChannel.send(line).catch(() => {});
}

// -------------------- Fetch/Update Leaderboard --------------------
async function fetchPoints(config, guild) {
  if (!config.pointsChannelId || !config.pointsMessageId) return {};
  const channel = guild.channels.cache.get(config.pointsChannelId);
  if (!channel?.isTextBased()) return {};
  const msg = await channel.messages.fetch(config.pointsMessageId).catch(() => null);
  if (!msg || msg.embeds.length === 0) return {};
  return parsePointsFromEmbed(msg.embeds[0]);
}

async function updateLeaderboard(guild, points, config) {
  if (!config.pointsChannelId || !config.pointsMessageId) return;
  const channel = guild.channels.cache.get(config.pointsChannelId);
  if (!channel?.isTextBased()) return;
  const msg = await channel.messages.fetch(config.pointsMessageId).catch(() => null);
  if (!msg) return;
  const embed = buildPointsEmbed(points, guild);
  await msg.edit({ content: `📊 Current ELO Ratings:`, embeds: [embed] }).catch(() => {});
  await saveConfig(guild, config);
}

// -------------------- Ensure History --------------------
async function ensureHistoryChannel(guild) {
  let historyChannel = guild.channels.cache.find(c => c.name === 'history' && c.isTextBased());
  if (!historyChannel) {
    historyChannel = await guild.channels.create({
      name: 'history',
      type: 0,
      permissionOverwrites: [{ id: guild.roles.everyone.id, allow: ['ViewChannel'] }]
    }).catch(() => null);
  }
  return historyChannel;
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
      const name = target.displayName;
      const score = points[name] || 1200;
      return message.reply({
        embeds: [new EmbedBuilder().setTitle(`📈 ${name}'s ELO`).setColor(0x00ff99).setDescription(`**${score}** pts`).setTimestamp()],
      });
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
      if (!target) return message.reply('❌ Invalid user.');
      const messages = await historyChannel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages || messages.size === 0) return message.reply('⚠️ No match history found.');

      const userEmbeds = messages.filter(msg => msg.embeds.length && msg.embeds[0].description?.includes(target.displayName));
      if (userEmbeds.size === 0) return message.reply('⚠️ No match history found for this user.');
      return message.reply({ embeds: userEmbeds.map(msg => msg.embeds[0]) });
    }

    case 'ping': return message.reply(`🏓 Pong! ${client.ws.ping}ms`);

    case 'help': {
      return message.reply({
        embeds: [new EmbedBuilder().setTitle('📘 Commands').setColor(0x8888ff).setDescription(`
\`,setchannel #channel\` — Set leaderboard channel
\`,startmatch @opponent\` — Start a match with UI
\`,getpoints [@user]\` — Show user's ELO
\`,history [@user]\` — Show match history of a user
\`,top\` — Show server leaderboard
\`,worldtop\` — Show global leaderboard
\`,ping\` — Bot ping
\`,help\` — This help message
      `)],
      });
    }

    default: return message.reply('❓ Unknown command. Use `,help`.');
  }
});

client.login(process.env.TOKEN5);

module.exports = { calculateElo, updateLeaderboard };

