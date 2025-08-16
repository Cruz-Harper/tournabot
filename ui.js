const fs = require("fs");
const { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  StringSelectMenuBuilder, 
  ComponentType, 
  EmbedBuilder 
} = require("discord.js");

const fighters = fs.readFileSync("fighters.txt", "utf-8").split("\n").filter(Boolean);
const starterStages = ["Battlefield", "Final Destination", "Small Battlefield", "Town and City", "Hollow Bastion"];
const counterpickStages = ["Pokémon Stadium 2", "Smashville", "Kalos Pokémon League"];

module.exports = {
  async startMatch(client, channel, player1, player2, points, config, historyChannel) {
    if (!channel || !player1 || !player2) throw new Error("Missing players or channel.");

    // --- CHECK-IN ---
    const matchEmbed = new EmbedBuilder()
      .setTitle("🎮 Match Setup")
      .setDescription(`${player1} vs ${player2}\nClick ✅ to check in`)
      .setColor(0x00ff99)
      .setTimestamp();

    const checkinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`checkin_${player1.id}`).setLabel("✅ Check-in").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`checkin_${player2.id}`).setLabel("✅ Check-in").setStyle(ButtonStyle.Success)
    );

    const msg = await channel.send({ embeds: [matchEmbed], components: [checkinRow] });
    const checkedIn = new Set();

    const checkinCollector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 10 * 60 * 1000 });

    checkinCollector.on("collect", async i => {
      if (i.user.id !== player1.id && i.user.id !== player2.id) return i.reply({ content: "❌ Not part of this match.", ephemeral: true });
      if (checkedIn.has(i.user.id)) return i.reply({ content: "✅ Already checked in.", ephemeral: true });

      checkedIn.add(i.user.id);
      await i.update({ content: `${i.user.username} has checked in!`, embeds: [matchEmbed], components: [checkinRow] });

      if (checkedIn.size === 2) {
        checkinCollector.stop("completed");
      }
    });

    checkinCollector.on("end", async (_, reason) => {
      if (reason !== "completed") return channel.send("⏰ Match setup timed out. Aborting.");
      await characterSelection(client, channel, player1, player2, points, config, historyChannel);
    });
  }
};

// --- CHARACTER SELECTION ---
async function characterSelection(client, channel, player1, player2, points, config, historyChannel) {
  const createMenu = user => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`char_${user.id}`)
      .setPlaceholder("Select your character")
      .addOptions(fighters.map(f => ({ label: f, value: f })))
  );

  const embed = new EmbedBuilder().setTitle("🎮 Character Selection").setDescription("Pick your character!").setColor(0x00ff99);

  const msg1 = await channel.send({ content: `${player1}`, embeds: [embed], components: [createMenu(player1)] });
  const msg2 = await channel.send({ content: `${player2}`, embeds: [embed], components: [createMenu(player2)] });

  const selectedChars = {};
  const collector = channel.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30 * 1000 });

  collector.on("collect", async i => {
    if (i.user.id !== player1.id && i.user.id !== player2.id) return i.reply({ content: "❌ Not part of this match.", ephemeral: true });
    if (selectedChars[i.user.id]) return i.reply({ content: "✅ Already selected.", ephemeral: true });

    selectedChars[i.user.id] = i.values[0];
    await i.update({ content: `You selected **${i.values[0]}**`, components: [] });

    if (Object.keys(selectedChars).length === 2) collector.stop("completed");
  });

  collector.on("end", async (_, reason) => {
    if (!selectedChars[player1.id]) selectedChars[player1.id] = fighters[Math.floor(Math.random() * fighters.length)];
    if (!selectedChars[player2.id]) selectedChars[player2.id] = fighters[Math.floor(Math.random() * fighters.length)];
    await stageBan(client, channel, player1, player2, selectedChars, points, config, historyChannel);
  });
}

// --- STAGE BAN ---
async function stageBan(client, channel, player1, player2, selectedChars, points, config, historyChannel) {
  const bannedStages = [];
  const stages = [...starterStages, ...counterpickStages];

  for (let i = 0; i < 4; i++) {
    const currentPlayer = i % 2 === 0 ? player1 : player2;
    const embed = new EmbedBuilder().setTitle("🚫 Stage Ban").setDescription(`Select a stage to ban (${currentPlayer.username})`).setColor(0xff9900);
    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ban_${currentPlayer.id}_${i}`)
        .setPlaceholder("Ban a stage")
        .addOptions(stages.filter(s => !bannedStages.includes(s)).map(s => ({ label: s, value: s })))
    );
    const msg = await channel.send({ content: currentPlayer.toString(), embeds: [embed], components: [menu] });

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, max: 1, time: 20 * 1000 });

    collector.on("collect", async i => {
      bannedStages.push(i.values[0]);
      await i.update({ content: `Banned **${i.values[0]}**`, components: [] });
    });

    await new Promise(resolve => collector.on("end", () => {
      if (!bannedStages[i]) {
        const available = stages.filter(s => !bannedStages.includes(s));
        const randomBan = available[Math.floor(Math.random() * available.length)];
        bannedStages.push(randomBan);
        channel.send(`⌛ Auto-banned **${randomBan}** due to timeout.`);
      }
      resolve();
    }));
  }

  const availableStages = stages.filter(s => !bannedStages.includes(s));
  const stageChosen = availableStages[0]; 
  await channel.send(`✅ Starter stage selected: **${stageChosen}**`);

  await logMatch(client, channel, player1, player2, selectedChars, stageChosen, points, config, historyChannel);
}

// --- MATCH LOGGING ---
async function logMatch(client, channel, player1, player2, characters, stage, points, config, historyChannel) {
  const embed = new EmbedBuilder().setTitle("🏆 Report Match").setDescription("Select the winner").setColor(0x00ff99);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`winner_${player1.id}`).setLabel(player1.username).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`winner_${player2.id}`).setLabel(player2.username).setStyle(ButtonStyle.Success)
  );
  const msg = await channel.send({ embeds: [embed], components: [row] });

  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 10 * 60 * 1000 });

  collector.on("collect", async i => {
    const winnerId = i.customId.split("_")[1];
    const winner = winnerId === player1.id ? player1 : player2;
    const loser = winner === player1 ? player2 : player1;

    const winnerElo = points[winner.displayName] || 1200;
    const loserElo = points[loser.displayName] || 1200;
    const [newWinner, newLoser] = require("./main").calculateElo(winnerElo, loserElo);
    points[winner.displayName] = newWinner;
    points[loser.displayName] = newLoser;

    await i.update({ content: `✅ Match recorded. Winner: **${winner.username}**`, components: [] });

    if (historyChannel) {
      const historyEmbed = new EmbedBuilder()
        .setTitle("📜 Match History")
        .setDescription(`${winner} defeated ${loser}\n**Stage:** ${stage}\n**Characters:** ${winner} → ${characters[winner.id]}, ${loser} → ${characters[loser.id]}\n**ELO Change:** ${winnerElo} → ${newWinner}, ${loserElo} → ${newLoser}`)
        .setColor(0x00aeff)
        .setTimestamp();
      await historyChannel.send({ embeds: [historyEmbed] }).catch(() => {});
    }

    await require("./main").updateLeaderboard(channel.guild, points, config).catch(() => {});
  });

  collector.on("end", (_, reason) => {
    if (reason !== "limit") channel.send("⏰ Match reporting timed out.");
  });
}

