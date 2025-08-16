require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const prefix = ',';
const K = 32; // Fixed K-factor
const lastWinTime = {}; // cooldown storage
const CREATOR_ID = "1364776113922117695"; // Creator's Discord ID

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

// -------------------- Points Parsing/Building --------------------
function parsePointsFromEmbed(embed) {
  const points = {};
  if (!embed || !embed.description) return points;

  const lines = embed.description.split('\n');
  for (const line of lines) {
    const match = line.match(/^\d+\.\s\*\*(.+?)\*\*\s—\s(\d+)\spts$/);
    if (match) {
      const name = match[1];
      const pts = parseInt(match[2]);
      if (!isNaN(pts)) points[name] = pts;
    }
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

// -------------------- Config Fetch/Save --------------------
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
  await configChannel.send(line);
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
  const channel = guild.channels.cache.get(config.pointsChannelId);
  if (!channel?.isTextBased()) return;

  const msg = await channel.messages.fetch(config.pointsMessageId).catch(() => null);
  if (!msg) return;

  const embed = buildPointsEmbed(points, guild);
  await msg.edit({ content: `📊 Current ELO Ratings:`, embeds: [embed] });
  await saveConfig(guild, config);
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

  switch (cmd.toLowerCase()) {
    case 'setchannel': {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
      const chan = message.mentions.channels.first();
      if (!chan?.isTextBased()) return message.reply('❌ Mention a valid text channel.');
      const embed = buildPointsEmbed(points, guild);
      const msg = await chan.send({ content: `📊 Current ELO Ratings:`, embeds: [embed] });
      config.pointsChannelId = chan.id;
      config.pointsMessageId = msg.id;
      await saveConfig(guild, config);
      return message.reply('✅ Points channel set.');
    }

   case 'win': {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
  if (!mention || !args[1]) return message.reply('❌ Use `,win @winner @loser` format.');

  const winnerMember = mention;
  const loserMember = message.guild.members.cache.get(args[1].replace(/\D/g, ''));
  if (!loserMember) return message.reply('❌ Invalid loser.');

  const winner = winnerMember.displayName;
  const loser = loserMember.displayName;

  if (winner === loser) return message.reply('❌ Winner and loser cannot be the same person.');

  const key = `${guild.id}-${winnerMember.id}`;
  const now = Date.now();
  const cooldown = 10 * 60 * 1000; // 10 minutes

  // Only enforce cooldown if NOT creator
  if (message.author.id !== CREATOR_ID) {
    if (lastWinTime[key] && now - lastWinTime[key] < cooldown) {
      return message.reply(`❌ ${winner} must wait ${Math.ceil((cooldown - (now - lastWinTime[key])) / 60000)} minutes before recording another win.`);
    }
    lastWinTime[key] = now;
  }

  const winnerRating = points[winner] || 1200;
  const loserRating = points[loser] || 1200;

  const [newWinner, newLoser] = calculateElo(winnerRating, loserRating);
  points[winner] = newWinner;
  points[loser] = newLoser;

  await updateLeaderboard(guild, points, config);
  return message.reply(`✅ Updated ELO: **${winner}**: ${newWinner}, **${loser}**: ${newLoser}`);
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

    // Hidden creator-only command
    case 'masterreset': {
      if (message.author.id !== CREATOR_ID) return;
      for (const g of client.guilds.cache.values()) {
        const cfg = await fetchConfig(g);
        const emptyPoints = {};
        await updateLeaderboard(g, emptyPoints, cfg);
      }
      for (const key in lastWinTime) delete lastWinTime[key];
      return message.reply("✅ Master reset complete — all servers cleared.");
    }

    // Admin-only server reset
    case 'serverreset': {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
      const emptyPoints = {};
      await updateLeaderboard(guild, emptyPoints, config);
      for (const key in lastWinTime) {
        if (key.startsWith(`${guild.id}-`)) delete lastWinTime[key];
      }
      return message.reply(`✅ Server reset complete — leaderboard and cooldowns cleared for **${guild.name}**.`);
    }

    case 'ping': return message.reply(`🏓 Pong! ${client.ws.ping}ms`);

    case 'help': {
      return message.reply({
        embeds: [new EmbedBuilder().setTitle('📘 Commands').setColor(0x8888ff).setDescription(`
\`,win @winner @loser\` — Update ELO
\`,setchannel #channel\` — Set leaderboard channel
\`,getpoints [@user]\` — Show user's ELO
\`,top\` — Show server leaderboard
\`,worldtop\` — Show global leaderboard
\`,serverreset\` — Reset leaderboard for this server (Admins only)
\`,ping\` — Bot ping
\`,help\` — This help message
        `)],
      });
    }

    default: return message.reply('❓ Unknown command. Use `,help`.');
  }
});

client.login(process.env.TOKEN5);
