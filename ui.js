// ui.js
const fs = require("fs");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder
} = require("discord.js");

// -------------------- Safety Helpers --------------------
const TEN_MIN = 10 * 60 * 1000;

function safeId(x) {
  return (x && x.id) || (x && x.user && x.user.id) || null;
}

function safeUsername(x, fallback = "Unknown") {
  // Prefer a human-friendly visible name for labels and text
  return (
    (x && x.displayName) ||
    (x && x.nickname) ||
    (x && x.user && x.user.username) ||
    (x && x.username) ||
    fallback
  );
}

function safeMention(x) {
  const id = safeId(x);
  return id ? `<@${id}>` : safeUsername(x);
}

function safeSend(channel, payload) {
  if (!channel || typeof channel.send !== "function") return Promise.resolve(null);
  return channel.send(payload).catch(() => null);
}

function chunk(arr, size = 25) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniqueStrings(arr) {
  return Array.from(new Set((arr || []).filter(Boolean).map(s => String(s))));
}

// -------------------- Data --------------------
let fighters = [];
try {
  fighters = fs
    .readFileSync("fighters.txt", "utf-8")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
} catch {
  fighters = []; // we'll handle empty list in UI
}

fighters = uniqueStrings(fighters);

const starterStages = [
  "Battlefield",
  "Final Destination",
  "Small Battlefield",
  "Town and City",
  "Hollow Bastion",
];

const counterpickStages = [
  "Pokémon Stadium 2",
  "Smashville",
  "Kalos Pokémon League",
];

// -------------------- Public API --------------------
module.exports = {
  /**
   * Starts a ranked set between two players.
   * @param {Client} client
   * @param {TextChannel} channel
   * @param {GuildMember|User} player1
   * @param {GuildMember|User} player2
   * @param {Object} points - ELO map keyed by display name
   * @param {Object} config - your config object
   * @param {TextChannel} historyChannel - #history
   */
  async startMatch(client, channel, player1, player2, points, config, historyChannel) {
    // Basic guards
    if (!client || !channel || !player1 || !player2) {
      throw new Error("Missing client/channel/players.");
    }
    const p1Id = safeId(player1);
    const p2Id = safeId(player2);
    if (!p1Id || !p2Id) throw new Error("Players must have valid IDs.");

    // Check-in UI
    const p1Name = safeUsername(player1, "Player 1");
    const p2Name = safeUsername(player2, "Player 2");

    const matchEmbed = new EmbedBuilder()
      .setTitle("🎮 Match Setup")
      .setDescription(`${safeMention(player1)} vs ${safeMention(player2)}\nClick ✅ to check in.`)
      .setColor(0x00ff99)
      .setTimestamp();

    const checkinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`checkin_${p1Id}`).setLabel(`✅ Check-in (${p1Name})`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`checkin_${p2Id}`).setLabel(`✅ Check-in (${p2Name})`).setStyle(ButtonStyle.Success)
    );

    const msg = await safeSend(channel, { embeds: [matchEmbed], components: [checkinRow] });
    if (!msg) return;

    const checkedIn = new Set();

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: TEN_MIN
    });

    collector.on("collect", async i => {
      const uid = i.user.id;
      if (uid !== p1Id && uid !== p2Id) {
        return i.reply({ content: "❌ You are not part of this match.", flags: 64 }).catch(() => {});
      }
      if (checkedIn.has(uid)) {
        return i.reply({ content: "✅ You’ve already checked in.", flags: 64 }).catch(() => {});
      }

      checkedIn.add(uid);

      // Update the original message components to reflect the check-in
      try {
        const newRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`checkin_${p1Id}`)
            .setLabel(`✅ Check-in (${p1Name})${checkedIn.has(p1Id) ? " — done" : ""}`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(checkedIn.has(p1Id)),
          new ButtonBuilder()
            .setCustomId(`checkin_${p2Id}`)
            .setLabel(`✅ Check-in (${p2Name})${checkedIn.has(p2Id) ? " — done" : ""}`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(checkedIn.has(p2Id))
        );
        await i.update({ embeds: [matchEmbed], components: [newRow] });
      } catch {
        // swallow
      }

      if (checkedIn.size === 2) {
        collector.stop("both_checked");
      }
    });

    collector.on("end", async (_collected, reason) => {
      try {
        await msg.edit({ components: [] }).catch(() => {});
      } catch {}

      if (reason !== "both_checked") {
        await safeSend(channel, "⏰ Match setup timed out.");
        return;
      }

      // Decide FT2 (BO3) or FT3 (BO5)
      const p1Key = safeUsername(player1);
      const p2Key = safeUsername(player2);
      const p1Elo = (points && points[p1Key]) || 1200;
      const p2Elo = (points && points[p2Key]) || 1200;
      const requiredWins = (p1Elo >= 1600 || p2Elo >= 1600) ? 3 : 2;

      const wins = { [p1Id]: 0, [p2Id]: 0 };
      await safeSend(channel, `🎮 **Set started:** ${safeMention(player1)} vs ${safeMention(player2)}\nFirst to **${requiredWins} wins**!`);

      await characterSelection(client, channel, player1, player2, points, config, historyChannel, wins, requiredWins, 1);
    });
  }
};

// -------------------- Character Selection --------------------
async function characterSelection(client, channel, player1, player2, points, config, historyChannel, wins, requiredWins, gameNumber) {
  // Defensive: empty roster
  if (!fighters.length) {
    await safeSend(channel, "⚠️ Fighters list is empty. Please populate `fighters.txt`.");
    return;
  }

  const p1Id = safeId(player1);
  const p2Id = safeId(player2);
  const p1Name = safeUsername(player1, "Player 1");
  const p2Name = safeUsername(player2, "Player 2");

  const makeCharRows = (user) => {
    const chunks = chunk(fighters, 25);
    return chunks.map((c, idx) =>
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`char_${safeId(user)}_${idx}`)
          .setPlaceholder(`Select your character (${safeUsername(user)})`)
          .addOptions(c.map(f => ({ label: String(f), value: String(f) })))
      )
    );
  };

  const embed = new EmbedBuilder()
    .setTitle(`🎮 Character Selection — Game ${gameNumber}`)
    .setDescription("Pick your character from the menus below.")
    .setColor(0x00ff99);

  const p1Msg = await safeSend(channel, { content: safeMention(player1), embeds: [embed], components: makeCharRows(player1) });
  const p2Msg = await safeSend(channel, { content: safeMention(player2), embeds: [embed], components: makeCharRows(player2) });

  if (!p1Msg || !p2Msg) return;

  const selected = {}; // id -> character

  const collector = channel.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: TEN_MIN
  });

  collector.on("collect", async i => {
    // Only allow either player to select
    if (i.user.id !== p1Id && i.user.id !== p2Id) {
      return i.reply({ content: "❌ You are not part of this match.", flags: 64 }).catch(() => {});
    }

    // Prevent double selection
    if (selected[i.user.id]) {
      return i.reply({ content: "✅ You already selected your character.", flags: 64 }).catch(() => {});
    }

    const choice = (i.values && i.values[0]) ? String(i.values[0]) : null;
    if (!choice) {
      return i.reply({ content: "⚠️ Invalid selection.", flags: 64 }).catch(() => {});
    }

    selected[i.user.id] = choice;

    // Disable ALL menus for that user
    try {
      await i.update({ content: `${safeMention(i.user)} selected **${choice}**.`, components: [] });
    } catch { /* ignore */ }

    // When both have chosen
    if (selected[p1Id] && selected[p2Id]) {
      collector.stop("both_chosen");
    }
  });

  collector.on("end", async (_collected, reason) => {
    try { await p1Msg.edit({ components: [] }).catch(() => {}); } catch {}
    try { await p2Msg.edit({ components: [] }).catch(() => {}); } catch {}

    if (reason !== "both_chosen") {
      await safeSend(channel, "⏰ Character selection timed out.");
      return;
    }

    if (gameNumber === 1) {
      await stageBanGame1(client, channel, player1, player2, selected, points, config, historyChannel, wins, requiredWins, gameNumber);
    } else {
      await counterpickFlow(client, channel, player1, player2, selected, points, config, historyChannel, wins, requiredWins, gameNumber);
    }
  });
}

// -------------------- Game 1 1-2-1 Bans --------------------
async function stageBanGame1(client, channel, player1, player2, characters, points, config, historyChannel, wins, requiredWins, gameNumber) {
  const starters = uniqueStrings(starterStages);
  if (!starters.length) {
    await safeSend(channel, "⚠️ No starter stages configured.");
    return;
  }

  const p1Id = safeId(player1);
  const p2Id = safeId(player2);
  const order = [p1Id, p2Id, p2Id, p1Id]; // 1-2-1 order
  const banned = [];

  for (let i = 0; i < order.length; i++) {
    const currentId = order[i];
    const currentPlayer = currentId === p1Id ? player1 : player2;

    const options = starters.filter(s => !banned.includes(s));
    if (!options.length) break;

    const embed = new EmbedBuilder()
      .setTitle(`🚫 Stage Ban (Game 1) — Step ${i + 1}/${order.length}`)
      .setDescription(`${safeMention(currentPlayer)}, ban one stage.`)
      .setColor(0xff9900);

    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`g1_ban_${currentId}_${i}`)
        .setPlaceholder("Ban a stage")
        .addOptions(options.map(s => ({ label: String(s), value: String(s) })))
    );

    const msg = await safeSend(channel, { embeds: [embed], components: [menu] });
    if (!msg) return;

    await new Promise((resolve) => {
      const c = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: TEN_MIN,
        max: 1
      });

      c.on("collect", async i => {
        if (i.user.id !== currentId) {
          return i.reply({ content: "❌ It's not your turn to ban.", flags: 64 }).catch(() => {});
        }
        const choice = (i.values && i.values[0]) ? String(i.values[0]) : null;
        if (!choice) {
          return i.reply({ content: "⚠️ Invalid selection.", flags: 64 }).catch(() => {});
        }
        banned.push(choice);
        try {
          await i.update({ content: `Banned **${choice}**.`, components: [] });
        } catch {}
        c.stop("done");
      });

      c.on("end", () => resolve());
    });
  }

  const remaining = starters.filter(s => !banned.includes(s));
  if (!remaining.length) {
    await safeSend(channel, "⚠️ All starter stages were banned somehow. Picking a random starter…");
    remaining.push(starters[Math.floor(Math.random() * starters.length)]);
  }

  const stageChosen = remaining[0];
  await safeSend(channel, `✅ **Starter stage selected:** **${stageChosen}**`);

  await logGameResult(client, channel, player1, player2, characters, stageChosen, points, config, historyChannel, wins, requiredWins, gameNumber);
}

// -------------------- Counterpick Flow (post-Game 1) --------------------
async function counterpickFlow(client, channel, player1, player2, characters, points, config, historyChannel, wins, requiredWins, gameNumber) {
  const p1Id = safeId(player1);
  const p2Id = safeId(player2);

  // Determine last game's winner/loser
  const totalGamesPlayed = wins[p1Id] + wins[p2Id];
  if (totalGamesPlayed < 1) {
    await safeSend(channel, "⚠️ Counterpick called before any games were played.");
    return;
  }
  // If equal wins before gameNumber was incremented, the *previous* winner is the one who just got the last increment.
  const lastWinner = wins[p1Id] > wins[p2Id] ? player1 : player2;
  const lastLoser = lastWinner === player1 ? player2 : player1;

  const stagePool = uniqueStrings([...starterStages, ...counterpickStages]);
  if (!stagePool.length) {
    await safeSend(channel, "⚠️ No counterpick stage pool configured.");
    return;
  }

  const banned = [];

  // Winner bans 2 stages
  for (let i = 0; i < 2; i++) {
    const options = stagePool.filter(s => !banned.includes(s));
    if (!options.length) break;

    const embed = new EmbedBuilder()
      .setTitle(`🚫 Counterpick Ban ${i + 1}/2`)
      .setDescription(`${safeMention(lastWinner)}, ban a stage.`)
      .setColor(0xff6600);

    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cp_ban_${safeId(lastWinner)}_${i}`)
        .setPlaceholder("Ban a stage")
        .addOptions(options.map(s => ({ label: String(s), value: String(s) })))
    );

    const msg = await safeSend(channel, { embeds: [embed], components: [menu] });
    if (!msg) return;

    await new Promise((resolve) => {
      const c = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: TEN_MIN,
        max: 1
      });

      c.on("collect", async i => {
        if (i.user.id !== safeId(lastWinner)) {
          return i.reply({ content: "❌ Only the previous game winner can ban.", flags: 64 }).catch(() => {});
        }
        const choice = (i.values && i.values[0]) ? String(i.values[0]) : null;
        if (!choice) {
          return i.reply({ content: "⚠️ Invalid selection.", flags: 64 }).catch(() => {});
        }
        banned.push(choice);
        try {
          await i.update({ content: `Banned **${choice}**.`, components: [] });
        } catch {}
        c.stop("done");
      });

      c.on("end", () => resolve());
    });
  }

  // Loser picks from remaining
  const remaining = stagePool.filter(s => !banned.includes(s));
  if (!remaining.length) {
    await safeSend(channel, "⚠️ All counterpick stages banned. Picking a random stage…");
    remaining.push(stagePool[Math.floor(Math.random() * stagePool.length)]);
  }

  const embed = new EmbedBuilder()
    .setTitle("🎲 Counterpick — Loser Chooses")
    .setDescription(`${safeMention(lastLoser)}, pick a stage from the remaining pool.`)
    .setColor(0xffcc00);

  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`cp_pick_${safeId(lastLoser)}`)
      .setPlaceholder("Pick a stage")
      .addOptions(remaining.map(s => ({ label: String(s), value: String(s) })))
  );

  const msg = await safeSend(channel, { embeds: [embed], components: [menu] });
  if (!msg) return;

  await new Promise((resolve) => {
    const c = msg.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: TEN_MIN,
      max: 1
    });

    c.on("collect", async i => {
      if (i.user.id !== safeId(lastLoser)) {
        return i.reply({ content: "❌ Only the previous game loser can pick the stage.", flags: 64 }).catch(() => {});
      }
      const chosen = (i.values && i.values[0]) ? String(i.values[0]) : null;
      if (!chosen) {
        return i.reply({ content: "⚠️ Invalid selection.", flags: 64 }).catch(() => {});
      }
      try {
        await i.update({ content: `✅ Counterpick stage: **${chosen}**`, components: [] });
      } catch {}
      c.stop("picked");
      // Go straight to game logging once picked
      logGameResult(client, channel, player1, player2, characters, chosen, points, config, historyChannel, wins, requiredWins, gameNumber)
        .catch(() => {});
      resolve();
    });

    c.on("end", () => resolve());
  });
}

// -------------------- Game Result + Set Progression --------------------
async function logGameResult(client, channel, player1, player2, characters, stage, points, config, historyChannel, wins, requiredWins, gameNumber) {
  const p1Id = safeId(player1);
  const p2Id = safeId(player2);

  const p1Label = safeUsername(player1, "Player 1");
  const p2Label = safeUsername(player2, "Player 2");

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Report Game ${gameNumber}`)
    .setDescription("Select the winner of this game.")
    .setColor(0x00ff99);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`winner_${p1Id}`)
      .setLabel(String(p1Label))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`winner_${p2Id}`)
      .setLabel(String(p2Label))
      .setStyle(ButtonStyle.Success)
  );

  const msg = await safeSend(channel, { embeds: [embed], components: [row] });
  if (!msg) return;

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: TEN_MIN,
    max: 1
  });

  collector.on("collect", async i => {
    const winnerId = String(i.customId.split("_")[1] || "");
    if (winnerId !== p1Id && winnerId !== p2Id) {
      return i.reply({ content: "❌ Invalid winner.", flags: 64 }).catch(() => {});
    }
    const winner = winnerId === p1Id ? player1 : player2;
    const loser = winnerId === p1Id ? player2 : player1;

    wins[winnerId] = (wins[winnerId] || 0) + 1;

    try {
      await i.update({ content: `✅ Game ${gameNumber} winner: **${safeUsername(winner)}**`, components: [] });
    } catch {}

    // Log to #history per-game
    try {
      if (historyChannel) {
        const gameEmbed = new EmbedBuilder()
          .setTitle("📜 Game Result")
          .setDescription(
            `${safeMention(winner)} defeated ${safeMention(loser)}\n` +
            `**Stage:** ${String(stage)}\n` +
            `**Characters:** ${safeUsername(player1)} → ${String(characters[p1Id]) || "??"}, ${safeUsername(player2)} → ${String(characters[p2Id]) || "??"}\n` +
            `**Score:** ${wins[p1Id] || 0} - ${wins[p2Id] || 0}`
          )
          .setColor(0x00aeff)
          .setTimestamp();
        await historyChannel.send({ embeds: [gameEmbed] }).catch(() => {});
      }
    } catch {}

    // Check set end
    if ((wins[winnerId] || 0) >= requiredWins) {
      // Update ELO on set completion
      try {
        const p1Key = safeUsername(player1);
        const p2Key = safeUsername(player2);
        const winnerKey = safeUsername(winner);
        const loserKey  = safeUsername(loser);

        const winnerElo = (points && points[winnerKey]) || 1200;
        const loserElo  = (points && points[loserKey])  || 1200;

        // Expect your main file exports these:
        const main = require("./SmashLadder"); // if your main exports functions from same file, adjust path/name
        const calc = main.calculateElo || ((a, b) => [a, b]); // fallback no-op
        const upd  = main.updateLeaderboard || (async () => {});

        const [newW, newL] = calc(winnerElo, loserElo);
        points[winnerKey] = newW;
        points[loserKey]  = newL;

        await safeSend(channel, `🏆 **Set Winner: ${safeMention(winner)}**\nFinal Score: ${wins[p1Id] || 0} - ${wins[p2Id] || 0}`);
        try { await upd(channel.guild, points, (main.fetchConfig ? await main.fetchConfig(channel.guild) : (main.config || {}))); } catch {}
      } catch {
        await safeSend(channel, "⚠️ Failed to update ELO; continuing.");
      }

      // Log final set to history
      try {
        if (historyChannel) {
          const setEmbed = new EmbedBuilder()
            .setTitle("🏁 Set Complete")
            .setDescription(
              `**Winner:** ${safeMention(winner)}\n` +
              `**Loser:** ${safeMention(loser)}\n` +
              `**Final Score:** ${wins[p1Id] || 0} - ${wins[p2Id] || 0}`
            )
            .setColor(0x44dd88)
            .setTimestamp();
          await historyChannel.send({ embeds: [setEmbed] }).catch(() => {});
        }
      } catch {}

      return; // set over
    }

    // Otherwise, proceed to next game: character re-select + counterpicks
    await characterSelection(client, channel, player1, player2, points, config, historyChannel, wins, requiredWins, gameNumber + 1);
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "limit") {
      await safeSend(channel, "⏰ Game reporting timed out.");
    }
  });
}


