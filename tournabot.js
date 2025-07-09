// stuff my code needs ig
const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, EmbedBuilder, REST, Routes, ActivityType } = require('discord.js');
const { createCanvas } = require('canvas');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

client.on('ready', () => {
  client.user.setActivity('esports', { type: ActivityType.Competing });
  console.log(`✅ Status set: Competing in esports`);
});

client.on('guildCreate', async (guild) => {
  // Try to find a text channel the bot can send messages in
  const channel = guild.channels.cache.find(
    ch =>
      ch.type === 0 && // text channels only
      ch.permissionsFor(guild.members.me).has(['ViewChannel', 'SendMessages'])
  );

  const welcomeMessage = `🎉 Yo, thanks for adding me to **${guild.name}**!\nType \`/startbracket\` to run your first tournament!`;

  if (channel) {
    try {
      await channel.send(welcomeMessage);
      console.log(`📥 Sent welcome message in ${guild.name}`);
    } catch (err) {
      console.warn(`⚠️ Tried to send in ${channel.name}, but failed:`, err.message);
    }
  } else {
    console.log(`⚠️ No suitable channel found in ${guild.name}. Trying to DM the owner...`);
    try {
      const owner = await guild.fetchOwner();
      await owner.send(welcomeMessage);
      console.log(`📩 Sent welcome DM to ${owner.user.tag}`);
    } catch (err) {
      console.warn(`❌ Couldn't DM the owner of ${guild.name}:`, err.message);
    }
  }
});

const TOKEN2 = process.env.TOKEN2;
const CLIENT_ID = process.env.CLIENT_ID;

// --- Express keep-alive server ---
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Tournabot is running!');
});

app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});


const userBracketState = new Map();
const brackets = new Map();
const checkIns = new Map();

function shuffleArray(array) {
  return array.map(a => [Math.random(), a]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
}

async function drawBracketImage(players, matchups, round, losersMatchups, grandFinalsMatch) {
  const width = 600;
  const numRows = (matchups ? matchups.length : 0) + (losersMatchups ? losersMatchups.length : 0) + (grandFinalsMatch ? 1 : 0);
  const height = Math.max(250, numRows * 40 + 80);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#23272a';
  ctx.fillRect(0, 0, width, height);

  ctx.font = '20px Sans';
  ctx.fillStyle = '#fff';
  ctx.fillText(`Winners Bracket - Round ${round}`, 20, 30);

  let y = 60;
  if (matchups) {
    matchups.forEach((match, i) => {
      ctx.fillStyle = '#7289da';
      ctx.fillRect(20, y - 20, 460, 32);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${match[0]?.username || 'TBD'} vs ${match[1]?.username || 'BYE'}`, 30, y);
      y += 40;
    });
  }
  if (losersMatchups && losersMatchups.length > 0) {
    ctx.fillStyle = '#fff';
    ctx.fillText(`Losers Bracket`, 20, y + 10);
    y += 40;
    losersMatchups.forEach((match, i) => {
      ctx.fillStyle = '#da7272';
      ctx.fillRect(20, y - 20, 460, 32);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${match[0]?.username || 'TBD'} vs ${match[1]?.username || 'BYE'}`, 30, y);
      y += 40;
    });
  }
  if (grandFinalsMatch) {
    ctx.fillStyle = '#fff';
    ctx.fillText('Grand Finals', 20, y + 10);
    y += 40;
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(20, y - 20, 460, 32);
    ctx.fillStyle = '#000';
    ctx.fillText(`${grandFinalsMatch[0]?.username || 'TBD'} vs ${grandFinalsMatch[1]?.username || 'TBD'}`, 30, y);
  }

  return canvas.toBuffer();
}

function generateMatchups(players) {
  const matchups = [];
  for (let i = 0; i < players.length; i += 2) {
    matchups.push([players[i], players[i + 1] || { username: 'BYE' }]);
  }
  return matchups;
}

// ==== DOUBLE ELIMINATION STATE HELPERS ====
function ensureDoubleElimState(bracket) {
  if (!bracket.losersBracket) bracket.losersBracket = [];
  if (!bracket.losersMatchups) bracket.losersMatchups = [];
  if (!bracket.losersCurrentMatchIndex) bracket.losersCurrentMatchIndex = 0;
  if (!bracket.losersRound) bracket.losersRound = 0;
  if (!bracket.finalStage) bracket.finalStage = false;
}

// ==== CHECK-IN HANDLERS ====
// Utility for unique match keys
function getMatchKey(match, round, bracket, losersBracket, grandFinals) {
  return `${bracket.channelId || bracket._channelId || 'unknown'}-${round}-${match[0]?.id || 'bye'}-${match[1]?.id || 'bye'}-${losersBracket ? 'L' : grandFinals ? 'GF' : 'W'}`;
}

async function startCheckIn(match, channel, bracket, losersBracket = false, grandFinals = false) {
  const [p1, p2] = match;
  if (!p1 || !p2 || p1.username === 'BYE') return resolveMatch(p2, match, channel, bracket, losersBracket, grandFinals);
  if (p2.username === 'BYE') return resolveMatch(p1, match, channel, bracket, losersBracket, grandFinals);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`checkin_${p1.id}`).setLabel('Check In').setStyle(ButtonStyle.Success)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`checkin_${p2.id}`).setLabel('Check In').setStyle(ButtonStyle.Success)
  );

  try {
    const user1 = await client.users.fetch(p1.id);
    await user1.send({ content: `You're up vs ${p2.username}! Click below to check in:`, components: [row1] });
  } catch (e) {}
  try {
    const user2 = await client.users.fetch(p2.id);
    await user2.send({ content: `You're up vs ${p1.username}! Click below to check in:`, components: [row2] });
  } catch (e) {}

  // Store check-in state for this match
  const matchKey = getMatchKey(match, bracket.round, bracket, losersBracket, grandFinals);
  checkIns.set(matchKey, {
    p1: false, p2: false, match, startTime: Date.now(), channelId: channel.id, losersBracket, grandFinals
  });
  setTimeout(() => handleCheckInTimeout(p1, p2, match, channel, bracket, losersBracket, grandFinals), 5 * 60 * 1000);
}

async function handleCheckInTimeout(p1, p2, match, channel, bracket, losersBracket = false, grandFinals = false) {
  const matchKey = getMatchKey(match, bracket.round, bracket, losersBracket, grandFinals);
  const result = checkIns.get(matchKey);
  if (!result) return;
  if (result.p1 && result.p2) return;
  if (result.p1) return resolveMatch(p1, match, channel, bracket, losersBracket, grandFinals);
  if (result.p2) return resolveMatch(p2, match, channel, bracket, losersBracket, grandFinals);
  checkIns.delete(matchKey);
  const ch = await client.channels.fetch(channel.id);
  ch.send(`⚠️ Match between ${p1.username} and ${p2.username} skipped due to no check-in.`);
  if (grandFinals) {
    bracket.finalStage = true;
  } else if (losersBracket) {
    bracket.losersCurrentMatchIndex++;
    runNextMatch(bracket, ch, true);
  } else {
    bracket.currentMatchIndex++;
    runNextMatch(bracket, ch);
  }
}

function resolveMatch(winner, match, channel, bracket, losersBracket = false, grandFinals = false) {
  if (!winner) {
    if (grandFinals) {
      channel.send(`🏆 Grand Finals could not be completed. No winner.`);
    }
    return;
  }
  const loser = match[0].id === winner.id ? match[1] : match[0];
  match.winner = winner;
  match.loser = loser;
  bracket.results.push({ round: bracket.round, match, winner, loser, losersBracket, grandFinals });
  channel.send(`✅ ${winner.username} wins the match against ${loser.username}`);
  if (grandFinals) {
    channel.send(`🏆 The tournament is over! Grand Finals Winner: **${winner.username}**`);
    bracket.finalStage = true;
    return;
  }
  if (losersBracket) {
    bracket.losersCurrentMatchIndex++;
    runNextMatch(bracket, channel, true);
  } else {
    bracket.currentMatchIndex++;
    runNextMatch(bracket, channel);
  }
}

// ==== ALL MATCHES IN ROUND START AT ONCE ====
function runNextMatch(bracket, channel, losersBracket = false) {
  if (bracket.format === 'double_elim') ensureDoubleElimState(bracket);

  // Helper: Start all matches in a set, but only those not completed
  function startMatches(matches, round, isLosers, isGrand) {
    for (const match of matches) {
      if (!match.winner) {
        startCheckIn(match, channel, bracket, isLosers, isGrand);
      }
    }
  }

  // LOSERS BRACKET FLOW
  if (bracket.format === 'double_elim' && losersBracket) {
    if (bracket.losersCurrentMatchIndex >= bracket.losersMatchups.length) {
      const unresolved = bracket.losersMatchups.find(m => !m.winner);
      if (unresolved) {
        channel.send(`⏳ Waiting for a match between ${unresolved[0]?.username} and ${unresolved[1]?.username || 'BYE'} to finish in Losers Bracket.`);
        return;
      }
      const lWinners = bracket.losersMatchups.map(m => m.winner).filter(Boolean);
      if (lWinners.length === 1 && bracket.winnersBracketWinner) {
        bracket.grandFinalsMatch = [bracket.winnersBracketWinner, lWinners[0]];
        bracket.finalStage = false;
        channel.send(`🔥 **GRAND FINALS**: ${bracket.winnersBracketWinner.username} (Winners Bracket) vs ${lWinners[0].username} (Losers Bracket)!`);
        startCheckIn(bracket.grandFinalsMatch, channel, bracket, false, true);
        return;
      }
      if (lWinners.length === 0) {
        bracket.losersMatchups = [];
      } else {
        bracket.losersMatchups = generateMatchups(lWinners);
        bracket.losersCurrentMatchIndex = 0;
        bracket.losersRound++;
        channel.send(`📢 Starting Losers Round ${bracket.losersRound}!`);
        startMatches(bracket.losersMatchups, bracket.losersRound, true, false);
      }
    } else {
      // Start all matches in this losers round at once!
      startMatches(bracket.losersMatchups, bracket.losersRound, true, false);
    }
    return;
  }

  // WINNERS BRACKET FLOW
  if (bracket.currentMatchIndex >= bracket.matchups.length) {
    const unresolved = bracket.matchups.find(m => !m.winner);
    if (unresolved) {
      channel.send(`⏳ Waiting for a match between ${unresolved[0]?.username} and ${unresolved[1]?.username || 'BYE'} to finish.`);
      return;
    }
    const winners = bracket.matchups.map(m => m.winner).filter(Boolean);
    const losers = bracket.matchups.map(m => m.loser).filter(Boolean);
    // WINNERS BRACKET FINISHED?
    if (winners.length === 1) {
      bracket.winnersBracketWinner = winners[0];
      if (bracket.format === 'double_elim') {
        if (!bracket.losersMatchups || bracket.losersMatchups.length === 0) {
          bracket.losersMatchups = generateMatchups(losers);
          bracket.losersCurrentMatchIndex = 0;
          bracket.losersRound = 1;
          channel.send('📢 Moving to Losers Bracket!');
          startMatches(bracket.losersMatchups, bracket.losersRound, true, false);
        } else if (bracket.losersMatchups.length === 1 && bracket.losersMatchups[0].winner) {
          // Grand Finals
          bracket.grandFinalsMatch = [winners[0], bracket.losersMatchups[0].winner];
          bracket.finalStage = false;
          channel.send(`🔥 **GRAND FINALS**: ${winners[0].username} (Winners Bracket) vs ${bracket.losersMatchups[0].winner.username} (Losers Bracket)!`);
          startCheckIn(bracket.grandFinalsMatch, channel, bracket, false, true);
        } else {
          channel.send('Waiting for Losers Bracket to finish.');
        }
        return;
      } else {
        channel.send(`🏆 The tournament is over! Winner: **${winners[0].username}**`);
        return;
      }
    } else {
      bracket.matchups = generateMatchups(winners);
      bracket.round++;
      bracket.currentMatchIndex = 0;
      channel.send(`📢 Starting Winners Round ${bracket.round}!`);
      startMatches(bracket.matchups, bracket.round, false, false);
    }
    return;
  } else {
    // Start all matches at once in this winners round!
    startMatches(bracket.matchups, bracket.round, false, false);
  }
}

// ========== MAIN INTERACTION HANDLER ==========
client.on('interactionCreate', async interaction => {
  // Handle Button Interactions
  if (interaction.isButton()) {
    const customId = interaction.customId;
    const userId = interaction.user.id;

    if (customId.startsWith('checkin_')) {
      const checkinId = customId.split('_')[1];
      let found = false;
      for (const [key, data] of checkIns.entries()) {
        if (key.includes(checkinId)) {
          data[checkinId === data.match[0].id ? 'p1' : 'p2'] = true;
          await interaction.reply({ content: '✅ Check-in successful!', ephemeral: true });
          found = true;
          break;
        }
      }
      if (!found) {
        await interaction.reply({ content: '❌ Match not found or already started.', ephemeral: true });
      }
      return;
    }

    if (customId === 'single_elim' || customId === 'double_elim') {
      const state = userBracketState.get(userId);
      if (!state || state.channelId !== interaction.channel.id) return;
      const bracket = {
        players: [],
        matchups: [],
        round: 1,
        currentMatchIndex: 0,
        format: customId,
        results: [],
        losersBracket: [],
        losersMatchups: [],
        losersCurrentMatchIndex: 0,
        losersRound: 0,
        grandFinalsMatch: null,
        finalStage: false,
        winnersBracketWinner: null,
        channelId: interaction.channel.id
      };
      brackets.set(interaction.channel.id, bracket);
      await interaction.update({ content: 'Bracket created! Players can now /join.', components: [] });
      return;
    }
  }

  // Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    const displayName = interaction.member?.nickname || interaction.member?.user?.globalName || interaction.user.globalName || interaction.user.username;
    const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);

    switch (interaction.commandName) {
      case 'startbracket': {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('single_elim').setLabel('Single Elimination').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('double_elim').setLabel('Double Elimination').setStyle(ButtonStyle.Secondary)
        );
        userBracketState.set(interaction.user.id, { step: 1, channelId: interaction.channel.id });
        await interaction.reply({ content: 'Choose elimination format:', components: [row] });
        break;
      }
      case 'join': {
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket) return interaction.reply('No active bracket.');
        if (bracket.started) return interaction.reply('The tournament has already started. You cannot join now.');
        const player = { id: interaction.user.id, username: displayName };
        if (bracket.players.find(p => p.id === player.id)) return interaction.reply('You already joined.');
        bracket.players.push(player);
        await interaction.reply(`${displayName} joined the tournament.`);
        break;
      }
      case 'leave': {
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket) return interaction.reply('No active bracket.');
        const playerId = interaction.user.id;
        const before = bracket.players.length;
        bracket.players = bracket.players.filter(p => p.id !== playerId);
        if (before === bracket.players.length) return interaction.reply('You are not in the bracket.');
        await interaction.reply(`${displayName} left the tournament.`);
        break;
      }
      case 'start': {
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket || bracket.players.length < 2) return interaction.reply('Not enough players to start.');
        bracket.started = true;
        bracket.players = shuffleArray(bracket.players);
        bracket.matchups = generateMatchups(bracket.players);
        bracket.currentMatchIndex = 0;
        bracket.round = 1;
        bracket.results = [];
        bracket.losersBracket = [];
        bracket.losersMatchups = [];
        bracket.losersCurrentMatchIndex = 0;
        bracket.losersRound = 0;
        bracket.grandFinalsMatch = null;
        bracket.finalStage = false;
        bracket.winnersBracketWinner = null;
        await interaction.reply('🎮 Tournament starting!');
        runNextMatch(bracket, interaction.channel);
        break;
      }
      case 'bracket': {
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket) return interaction.reply('No active bracket.');
        const buf = await drawBracketImage(
          bracket.players,
          bracket.matchups || [],
          bracket.round || 1,
          bracket.losersMatchups,
          bracket.grandFinalsMatch
        );
        await interaction.reply({
          files: [{ attachment: buf, name: 'bracket.png' }]
        });
        break;
      }
      case 'logwin': {
        const winner = interaction.options.getUser('winner');
        const loser = interaction.options.getUser('loser');
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket) return interaction.reply({ content: '❌ No active bracket in this channel.', ephemeral: true });

        // Find the current match in winners or losers bracket or grand finals
        let match, winnerPlayer, loserPlayer, losersBracket = false, grandFinals = false;
        if (bracket.grandFinalsMatch && !bracket.finalStage) {
          match = bracket.grandFinalsMatch;
          grandFinals = true;
        } else if (bracket.matchups && bracket.currentMatchIndex < bracket.matchups.length) {
          match = bracket.matchups.find(m => m.some(p => p && (p.id === winner.id || p.id === loser.id)) && !m.winner);
        } else if (bracket.losersMatchups && bracket.losersCurrentMatchIndex < bracket.losersMatchups.length) {
          match = bracket.losersMatchups.find(m => m.some(p => p && (p.id === winner.id || p.id === loser.id)) && !m.winner);
          losersBracket = true;
        }
        if (!match) return interaction.reply({ content: '❌ No active match to log.', ephemeral: true });

        winnerPlayer = match.find(p => p && p.id === winner.id);
        loserPlayer = match.find(p => p && p.id === loser.id);
        if (!winnerPlayer || !loserPlayer) {
          return interaction.reply({ content: '❌ Those users are not in the current match.', ephemeral: true });
        }

        // Check if both players checked in
        const matchKey = getMatchKey(match, bracket.round, bracket, losersBracket, grandFinals);
        const checkinState = checkIns.get(matchKey);
        if (!checkinState || !checkinState.p1 || !checkinState.p2) {
          return interaction.reply({ content: '❌ Both players must check in before the match can be logged.', ephemeral: true });
        }

        // Send confirmation buttons
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('confirm_win').setLabel('✅ Confirm Win').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('decline_win').setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: `🏁 ${winner.username} claims a win against ${loser.username}.\nBoth players must confirm below.`,
          components: [row],
          ephemeral: false
        });

        const filter = i => [winner.id, loser.id].includes(i.user.id) && ['confirm_win', 'decline_win'].includes(i.customId);
        const confirmed = new Set();

        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60_000 });

        collector.on('collect', async i => {
          if (i.customId === 'decline_win') {
            collector.stop('declined');
            await i.reply({ content: '❌ Match report was declined.', ephemeral: true });
            return;
          }
          confirmed.add(i.user.id);
          await i.reply({ content: '✅ Confirmation received.', ephemeral: true });
          if (confirmed.has(winner.id) && confirmed.has(loser.id)) {
            if (grandFinals) {
              resolveMatch(winnerPlayer, match, interaction.channel, bracket, false, true);
            } else if (losersBracket) {
              resolveMatch(winnerPlayer, match, interaction.channel, bracket, true, false);
            } else {
              resolveMatch(winnerPlayer, match, interaction.channel, bracket, false, false);
            }
            collector.stop('confirmed');
            await interaction.followUp({ content: `✅ Both players confirmed: ${winner.username} defeated ${loser.username}.` });
          }
        });

        collector.on('end', (collected, reason) => {
          if (reason === 'time') {
            interaction.followUp({ content: '⌛ Match confirmation timed out. Please try again.' });
          }
        });

        break;
      }
      case 'about': {
        await interaction.reply("I am a tournament bot created by `@qmqz2`. I am used to smoothly and easily host tournaments for any game without the hassle of doing a million things. I'm in early development, DM qmqz2 for bugs/feedback/feature requests!");
        break;
      }
      case 'ping': {
        await interaction.reply("Pong! I'm alive! Ping: " + client.ws.ping)
        break;
      }
      case 'support': {
        await interaction.reply("https://discord.gg/f2rMKaQvP9")
        break;
      }
      case 'stopbracket': {
        const bracket = brackets.get(interaction.channel.id);
        if (!bracket) {
          await interaction.reply({ content: '❌ There is no active bracket in this channel to stop.', ephemeral: true });
          return;
        }

        brackets.delete(interaction.channel.id);

        // Also clear check-ins related to this bracket
        for (const key of checkIns.keys()) {
          if (key.startsWith(`${interaction.channel.id}-`)) {
            checkIns.delete(key);
          }
        }

        await interaction.reply('🛑 The bracket has been stopped and all data for this channel has been cleared.');
        break;
      }
      case 'commands': {
        const embed = new EmbedBuilder()
          .setTitle('Available Commands')
          .setColor(0x00AE86)
          .setDescription(
            `/startbracket – Start a new tournament bracket and choose format (single or double elimination).\n` +
            `/join – Join the current tournament in this channel.\n` +
            `/leave – Leave the current tournament before it starts.\n` +
            `/start – Begin the tournament.\n` +
            `/bracket – Show the current bracket image.\n` +
            `/logwin – Log a win (for manual override).\n`+
            `/support – Get a link to our support server.\n`+
            `/bracket – Get a PNG image of the current tournament's bracket.`
          );
        await interaction.reply({ embeds: [embed] });
        break;
      }
    }
  }
});

// ========== COMMAND REGISTRATION ==========
const commands = [
  new SlashCommandBuilder().setName('startbracket').setDescription('Start a new tournament bracket.'),
  new SlashCommandBuilder().setName('join').setDescription('Join the current tournament.'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the current tournament.'),
  new SlashCommandBuilder().setName('start').setDescription('Begin the tournament.'),
  new SlashCommandBuilder().setName('bracket').setDescription('Show the current bracket.'),
  new SlashCommandBuilder().setName('logwin').setDescription('Log a win.')
    .addUserOption(option =>
      option.setName('winner').setDescription('Who won the match?').setRequired(true))
    .addUserOption(option =>
      option.setName('loser').setDescription('Who lost the match?').setRequired(true)),
  new SlashCommandBuilder().setName('about').setDescription('About the bot.'),
  new SlashCommandBuilder().setName('ping').setDescription('Ping the bot.'),
  new SlashCommandBuilder().setName('commands').setDescription('Show available commands.'),
  new SlashCommandBuilder().setName('support').setDescription('A link to our support server.'),
  new SlashCommandBuilder().setName('stopbracket').setDescription('Stops and deletes the current bracket')
];

const rest = new REST({ version: '10' }).setToken(TOKEN2);
(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

client.login(TOKEN2);
