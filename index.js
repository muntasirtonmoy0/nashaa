require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const fs = require("fs");
const ms = require("ms");

/* =========================================================
   1. VISUAL ASSETS (BANNERS & ICONS)
   - Replace placeholders with valid direct image/GIF URLs (https://...).
========================================================= */
const BANNER = "YOUR_BANNER_IMAGE_URL_HERE";
const THUMBNAIL = "YOUR_THUMBNAIL_IMAGE_URL_HERE";

/* =========================================================
   2. SERVER CHANNEL IDS
   - Right-click each target channel in Discord (with Developer Mode ON)
     and click "Copy Channel ID".
========================================================= */
const WELCOME_CHANNEL_ID = "YOUR_WELCOME_CHANNEL_ID";
const GOODBYE_CHANNEL_ID = "YOUR_GOODBYE_CHANNEL_ID";
const BOOST_CHANNEL_ID = "YOUR_BOOST_ANNOUNCEMENT_CHANNEL_ID";
const LEVEL_CHANNEL_ID = "YOUR_LEVEL_UP_NOTIFICATION_CHANNEL_ID";
const INVITE_LOG_CHANNEL_ID = "YOUR_INVITE_LOG_CHANNEL_ID";
const TICKET_LOG_CHANNEL_ID = "YOUR_TICKET_TRANSCRIPTS_CHANNEL_ID";
const JOIN_TO_CREATE_CHANNEL_ID = "YOUR_JOIN_TO_CREATE_VOICE_CHANNEL_ID";
const activeTempVoiceChannels = new Set();

/* =========================================================
   3. AUTOMOD & AUDIT LOG CONFIGURATION
========================================================= */
// Channel where deleted/edited messages & automod security alerts are logged
const AUDIT_LOG_CHANNEL_ID = "YOUR_AUDIT_LOG_CHANNEL_ID"; 

// Set to a Channel ID if you want automod to monitor ONLY that channel.
// Leave as null to monitor all channels across the server.
const MONITORED_CHANNEL_ID = null; 

// Invite link detection pattern
const DISCORD_INVITE_REGEX = /(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/[a-zA-Z0-9_-]+/i;

/* =========================================================
   4. TIERED AUTOMOD LOADER
========================================================= */
const DEFAULT_BAD_WORDS = { warn: [], mute: [], ban: [] };

function loadBadWords() {
  try {
    if (!fs.existsSync("./bad_words.json")) {
      fs.writeFileSync("./bad_words.json", JSON.stringify(DEFAULT_BAD_WORDS, null, 2));
      return DEFAULT_BAD_WORDS;
    }
    const raw = fs.readFileSync("./bad_words.json", "utf8").trim();
    return raw ? JSON.parse(raw) : DEFAULT_BAD_WORDS;
  } catch (err) {
    console.error("[AUTOMOD] Error reading bad_words.json:", err);
    return DEFAULT_BAD_WORDS;
  }
}

let badWordsDB = loadBadWords();
console.log(`[AUTOMOD LOADED] Warn: ${badWordsDB.warn?.length || 0} | Mute: ${badWordsDB.mute?.length || 0} | Ban: ${badWordsDB.ban?.length || 0}`);

function issueAutoWarning(userId, reason) {
  if (!warnings[userId]) warnings[userId] = [];
  warnings[userId].push({
    reason: `[AutoMod] ${reason}`,
    date: Date.now()
  });
  saveWarnings();
}

function findMatchedTerm(content, wordList) {
  if (!Array.isArray(wordList)) return null;
  const lower = content.toLowerCase();

  for (const term of wordList) {
    const cleanTerm = term.toLowerCase().trim();
    if (!cleanTerm) continue;

    if (cleanTerm.includes(" ")) {
      if (lower.includes(cleanTerm)) return term;
    } else {
      const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(^|[^a-zA-Z0-9_])${escaped}(?=[^a-zA-Z0-9_]|$)`, "i");
      if (regex.test(lower)) return term;
    }
  }
  return null;
}

/* =========================================================
   5. ANTI-NUKE CONFIGURATION
========================================================= */
// Channel where emergency alerts will be posted if nuke thresholds are exceeded
const ANTI_NUKE_LOG_CHANNEL_ID = "YOUR_STAFF_OR_SECURITY_LOG_CHANNEL_ID";
const nukeTracker = new Map();

const NUKE_LIMITS = {
  CHANNEL_DELETE: 2, // Max channel deletions within 10s
  ROLE_DELETE: 2,    // Max role deletions within 10s
  MEMBER_BAN: 3,     // Max bans issued within 10s
  WINDOW_MS: 10000   // 10-second rolling window
};

function recordNukeAction(userId, actionType) {
  const now = Date.now();
  if (!nukeTracker.has(userId)) {
    nukeTracker.set(userId, { channelDeletes: [], roleDeletes: [], memberBans: [] });
  }

  const userData = nukeTracker.get(userId);
  const timestamps = userData[actionType];

  const validTimestamps = timestamps.filter(t => now - t < NUKE_LIMITS.WINDOW_MS);
  validTimestamps.push(now);
  userData[actionType] = validTimestamps;

  return validTimestamps.length;
}

async function triggerNukeDefense(guild, executor, actionName, count) {
  if (!executor || executor.id === OWNER_ID || executor.id === client.user.id) return;

  try {
    await guild.members.ban(executor.id, {
      reason: `[ANTI-NUKE] Exceeded ${actionName} threshold (${count} actions within 10s)`
    });

    console.warn(`[ANTI-NUKE ACTIVATED] Banned ${executor.tag} (${executor.id}) for mass ${actionName}.`);

    const alertEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle("🚨 EMERGENCY: SERVER NUKE ATTEMPT NEUTRALIZED")
      .setDescription(
        `**Malicious Account:** ${executor} (\`${executor.id}\`)\n` +
        `**Violated Action:** ${actionName}\n` +
        `**Velocity:** \`${count}\` actions within 10 seconds\n` +
        `**System Response:** 🔨 **Permanent Ban Issued Instantly**`
      )
      .setImage(BANNER)
      .setFooter({ text: "Server Core Shield" })
      .setTimestamp();

    const logChannel = guild.channels.cache.get(ANTI_NUKE_LOG_CHANNEL_ID);
    if (logChannel) {
      await logChannel.send({ content: `<@${OWNER_ID}> ⚠️ **URGENT SECURITY ALERT**`, embeds: [alertEmbed] }).catch(() => {});
    }

    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      await owner.send({
        content: `🚨 **SECURITY ALERT:** Anti-Nuke detected and banned **${executor.tag}** for mass ${actionName} on **${guild.name}**!`,
        embeds: [alertEmbed]
      }).catch(() => {});
    }
  } catch (err) {
    console.error("Anti-nuke defense execution failed (check bot role hierarchy):", err);
  }
}

/* =========================================================
   6. ACCESS CONTROL & PERMISSIONS
========================================================= */
// User ID of the primary server owner (Has root bypass & permission to use owner commands)
const OWNER_ID = "YOUR_DISCORD_USER_ID_HERE";

// Array of User IDs or Role IDs granted staff moderation authority
const STAFF_USER_IDS = [
  "STAFF_USER_OR_ROLE_ID_1",
  "STAFF_USER_OR_ROLE_ID_2"
];

function isStaff(member) {
  if (!member) return false;
  return (
    member.id === OWNER_ID ||
    STAFF_USER_IDS.includes(member.id) ||
    member.roles.cache.some(r => STAFF_USER_IDS.includes(r.id)) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

// Local JSON Database Initializers
if (!fs.existsSync("./warnings.json")) fs.writeFileSync("./warnings.json", "{}");
if (!fs.existsSync("./levels.json")) fs.writeFileSync("./levels.json", "{}");
if (!fs.existsSync("./mutes.json")) fs.writeFileSync("./mutes.json", "{}");
if (!fs.existsSync("./bans.json")) fs.writeFileSync("./bans.json", "{}");
if (!fs.existsSync("./giveaways.json")) fs.writeFileSync("./giveaways.json", "[]");

let warnings = JSON.parse(fs.readFileSync("./warnings.json", "utf8"));
let levels = JSON.parse(fs.readFileSync("./levels.json", "utf8"));
let mutes = JSON.parse(fs.readFileSync("./mutes.json", "utf8"));
let bans = JSON.parse(fs.readFileSync("./bans.json", "utf8"));
let activeGiveaways = JSON.parse(fs.readFileSync("./giveaways.json", "utf8"));

function saveWarnings() {
  fs.writeFileSync("./warnings.json", JSON.stringify(warnings, null, 2));
}

function saveLevels() {
  fs.writeFileSync("./levels.json", JSON.stringify(levels, null, 2));
}

function saveMutes() {
  fs.writeFileSync("./mutes.json", JSON.stringify(mutes, null, 2));
}

function saveBans() {
  fs.writeFileSync("./bans.json", JSON.stringify(bans, null, 2));
}

function saveGiveaways() { 
  fs.writeFileSync("./giveaways.json", JSON.stringify(activeGiveaways, null, 2));
}

/* =========================================================
   7. INVITES SYSTEM
========================================================= */
if (!fs.existsSync("./invites.json")) {
  fs.writeFileSync("./invites.json", "{}");
}

let invites = JSON.parse(fs.readFileSync("./invites.json", "utf8"));

function createInviteData() {
  return {
    total: 0,
    current: 0,
    left: 0,
    fake: 0,
    history: []
  };
}

function getInvite(userId) {
  if (!invites[userId]) {
    invites[userId] = createInviteData();
  }
  return invites[userId];
}

for (const userId in invites) {
  invites[userId] = {
    ...createInviteData(),
    ...invites[userId]
  };

  if (!Array.isArray(invites[userId].history)) {
    invites[userId].history = [];
  }

  invites[userId].total = invites[userId].total || 0;
  invites[userId].current = invites[userId].current || 0;
  invites[userId].left = invites[userId].left || 0;
  invites[userId].fake = invites[userId].fake || 0;
}

function saveInvites() {
  fs.writeFileSync("./invites.json", JSON.stringify(invites, null, 2));
}

/* =========================================================
   8. CLIENT SETUP
========================================================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ],
  partials: [
    Partials.GuildMember,
    Partials.User,
    Partials.Message, 
    Partials.Channel 
  ]
});

const inviteCache = new Map();

/* =========================================================
   9. SLASH COMMAND DEFINITIONS
========================================================= */
const commands = [
  new SlashCommandBuilder()
    .setName("leveladd")
    .setDescription("Add levels to a user (Owner Only)")
    .addUserOption(o => o.setName("user").setDescription("The target user").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount of levels to add").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user temporarily or permanently (Owner Only)")
    .addUserOption(o => o.setName("user").setDescription("The user to ban").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Ban duration (e.g. perm, 1h, 7d)").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for ban").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by their ID (Owner Only)")
    .addStringOption(o => o.setName("user_id").setDescription("The user's ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warnlist")
    .setDescription("View warnings for a user")
    .addUserOption(o => o.setName("user").setDescription("The user to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a user")
    .addUserOption(o => o.setName("user").setDescription("The user to warn").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for warning").setRequired(false)),

  new SlashCommandBuilder()
    .setName("removewarn")
    .setDescription("Remove a specific warning from a user")
    .addUserOption(o => o.setName("user").setDescription("The target user").setRequired(true))
    .addIntegerOption(o => o.setName("number").setDescription("The warning number to remove").setRequired(true)),

  new SlashCommandBuilder()
    .setName("clearwarn")
    .setDescription("Clear all warnings for a user")
    .addUserOption(o => o.setName("user").setDescription("The target user").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mutehistory")
    .setDescription("View mute history of a user")
    .addUserOption(o => o.setName("user").setDescription("The user to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute/timeout a user")
    .addUserOption(o => o.setName("user").setDescription("The user to mute").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason for mute").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a user")
    .addUserOption(o => o.setName("user").setDescription("The user to unmute").setRequired(true)),

  new SlashCommandBuilder()
    .setName("banhistory")
    .setDescription("View ban history of a user")
    .addUserOption(o => o.setName("user").setDescription("The user to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Check level and XP progress")
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("invitedashboard")
    .setDescription("View full invite statistics dashboard")
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("invite")
    .setDescription("Check invite statistics")
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .addStringOption(o => o.setName("duration").setDescription("Duration (e.g. 10m, 2h, 1d)").setRequired(true))
    .addIntegerOption(o => o.setName("winners").setDescription("Number of winners").setRequired(true))
    .addStringOption(o => o.setName("prize").setDescription("Prize to give away").setRequired(true)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway winner")
    .addStringOption(o => o.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("View server rules"),

  new SlashCommandBuilder()
    .setName("grules")
    .setDescription("View in-game rules"),

  new SlashCommandBuilder()
    .setName("punishments")
    .setDescription("View server punishment guidelines"),

  new SlashCommandBuilder()
    .setName("tac")
    .setDescription("View server terms and conditions"),

  new SlashCommandBuilder()
    .setName("howgay")
    .setDescription("Calculate fun affinity percentage meter")
    .addUserOption(o => o.setName("user").setDescription("User to check (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Send the support ticket creation panel"),

  new SlashCommandBuilder()
    .setName("tictactoe")
    .setDescription("Play Tic Tac Toe")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("Choose game mode")
        .setRequired(true)
        .addChoices(
          { name: "Singleplayer (vs Hard Bot)", value: "s" },
          { name: "Multiplayer (vs Friend)", value: "m" }
        )
    )
    .addUserOption(o => o.setName("opponent").setDescription("Mention player (Multiplayer only)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("wordle")
    .setDescription("Play a game of Wordle"),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("Play Guess the Number (1 - 10000)"),

  new SlashCommandBuilder()
    .setName("snake")
    .setDescription("Play the classic Snake arcade game"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("View all available commands, categories, and syntax instructions")
    .addStringOption(o =>
      o.setName("category")
        .setDescription("Filter commands by category")
        .setRequired(false)
        .addChoices(
          { name: "🌐 General & Server Info", value: "info" },
          { name: "📊 Levels & Invites", value: "stats" },
          { name: "🎮 Mini-Games & Fun", value: "games" },
          { name: "🛡️ Staff & Moderation", value: "mod" }
        )
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View server rankings for Levels, Invites, and Clean Standing")
    .addStringOption(o =>
      o.setName("type")
        .setDescription("Choose leaderboard type")
        .setRequired(false)
        .addChoices(
          { name: "⭐ Levels & XP", value: "levels" },
          { name: "📨 Top Inviters", value: "invites" },
          { name: "🛡️ Clean Standing (Zero Violations)", value: "honor" }
        )
    ),   
];

/* =========================================================
   10. READY EVENT
========================================================= */
client.once("ready", async () => {
  console.log(`${client.user.tag} is online!`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("Registering application (/) commands to the server...");
    
    // REPLACE THIS GUILD ID WITH YOUR TARGET GUILD/SERVER ID
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, "YOUR_GUILD_ID_HERE"),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log("Application (/) commands successfully registered!");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  // Cache invites
  client.guilds.cache.forEach(async (guild) => {
    const guildInvites = await guild.invites.fetch().catch(() => {});
    if (!guildInvites) return;

    const cache = new Map();
    guildInvites.forEach((inv) => {
      cache.set(inv.code, inv.uses);
    });

    inviteCache.set(guild.id, cache);
  });

  /* Background Giveaway Checker */
  setInterval(async () => {
    const now = Date.now();

    for (let gw of activeGiveaways) {
      if (!gw.ended && now >= gw.endsAt) {
        gw.ended = true;
        saveGiveaways();

        try {
          const channel = await client.channels.fetch(gw.channelId).catch(() => null);
          if (!channel) continue;

          const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
          if (!msg) continue;

          let winners = [];
          const pool = [...gw.entries];

          while (winners.length < gw.winnerCount && pool.length > 0) {
            const randIdx = Math.floor(Math.random() * pool.length);
            winners.push(pool.splice(randIdx, 1)[0]);
          }

          const winnersFormatted = winners.length > 0
            ? winners.map((id) => `├── <@${id}>`).join("\n")
            : "├── *No valid entries*";

          const endedEmbed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle("🏆 GIVEAWAY ENDED 🏆")
            .setDescription(
              `🏆 **Prize:** ${gw.prize}\n\n` +
              `🎉 **Winners:**\n${winnersFormatted}\n\n` +
              `👑 **Hosted by:** <@${gw.hostId}>`
            )
            .setFooter({ text: `Total Entries: ${gw.entries.length}` })
            .setTimestamp();

          const endedButton = new ButtonBuilder()
            .setCustomId("giveaway_ended")
            .setLabel("Giveaway Ended")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

          const endedRow = new ActionRowBuilder().addComponents(endedButton);

          await msg.edit({ embeds: [endedEmbed], components: [endedRow] }).catch(() => {});

          if (winners.length > 0) {
            channel.send(`🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(", ")}! You won **${gw.prize}**!`).catch(() => {});
          } else {
            channel.send("❌ Giveaway ended with no entries.").catch(() => {});
          }
        } catch (err) {
          console.error("Error ending giveaway:", err);
        }
      }
    }
  }, 10000);

});

/* =========================================================
   11. PASSIVE XP & TIERED AUTOMOD
========================================================= */
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const bypass = isStaff(member);

  if (MONITORED_CHANNEL_ID && message.channel.id !== MONITORED_CHANNEL_ID) {
    return;
  }

  /* --- 1. SERVER INVITE / PROMOTION FILTER --- */
  if (!bypass && DISCORD_INVITE_REGEX.test(message.content)) {
    await message.delete().catch(() => {});
    issueAutoWarning(message.author.id, "Unauthorized server invite or promotion link");

    const alertMsg = await message.channel.send(
      `⚠️ ${message.author}, **server invites and self-promotions are not allowed!** A formal warning has been issued.`
    ).catch(() => {});
    setTimeout(() => alertMsg?.delete().catch(() => {}), 6000);

    const auditChan = message.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
    if (auditChan) {
      const logEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("🚨 AutoMod • Server Promotion Blocked")
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: "👤 Offender", value: `${message.author} (\`${message.author.id}\`)`, inline: true },
          { name: "📍 Channel", value: `${message.channel}`, inline: true },
          { name: "⚠️ Total Warnings", value: `\`${warnings[message.author.id]?.length || 1}\``, inline: true },
          { name: "💬 Content", value: `\`\`\`\n${message.content.slice(0, 1000)}\n\`\`\``, inline: false }
        )
        .setFooter({ text: "Security Core Shield" })
        .setTimestamp();

      await auditChan.send({ embeds: [logEmbed] }).catch(() => {});
    }
    return;
  }

  /* --- 2. TIERED PROFANITY & VERBAL ABUSE FILTER --- */
  if (!bypass) {
    const banTerm = findMatchedTerm(message.content, badWordsDB.ban);
    const muteTerm = findMatchedTerm(message.content, badWordsDB.mute);
    const warnTerm = findMatchedTerm(message.content, badWordsDB.warn);

    // TIER 3: DIRECT BAN
    if (banTerm) {
      await message.delete().catch(() => {});

      if (!bans[message.author.id]) bans[message.author.id] = { history: [] };
      bans[message.author.id].history.push({
        action: "AutoMod Permanent Ban",
        moderator: "AutoMod",
        reason: `Extreme verbal violation: "${banTerm}"`,
        duration: "Permanent",
        date: Date.now()
      });
      saveBans();

      await message.guild.members.ban(message.author.id, {
        reason: `[AutoMod Tier 3] Prohibited language: "${banTerm}"`
      }).catch(console.error);

      await message.channel.send(
        `🚨 ${message.author} has been **permanently banned** for severe verbal violations.`
      ).catch(() => {});

      const auditChan = message.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
      if (auditChan) {
        const logEmbed = new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle("🔨 AutoMod • Member Banned (Tier 3)")
          .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: "👤 Offender", value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
            { name: "📍 Channel", value: `${message.channel}`, inline: true },
            { name: "🚩 Trigger Word", value: `\`${banTerm}\``, inline: true },
            { name: "⚖️ Penalty", value: "`Permanent Ban`", inline: true },
            { name: "💬 Message Content", value: `\`\`\`\n${message.content.slice(0, 1000)}\n\`\`\``, inline: false }
          )
          .setFooter({ text: "Automated Enforcement" })
          .setTimestamp();

        await auditChan.send({ embeds: [logEmbed] }).catch(() => {});
      }
      return;
    }

    // TIER 2: ESCALATING MUTE
    if (muteTerm) {
      await message.delete().catch(() => {});

      if (!mutes[message.author.id]) mutes[message.author.id] = { history: [] };
      const priorMutes = mutes[message.author.id].history.length;

      const muteHours = Math.min(2 * Math.pow(2, priorMutes), 24);
      const muteDurationMs = muteHours * 60 * 60 * 1000;

      mutes[message.author.id].history.push({
        action: `AutoMod Mute (${muteHours}h)`,
        moderator: "AutoMod",
        reason: `Moderate profanity: "${muteTerm}"`,
        duration: `${muteHours}h`,
        date: Date.now()
      });
      saveMutes();

      if (member) {
        await member.timeout(muteDurationMs, `[AutoMod Tier 2] Prohibited language: "${muteTerm}"`).catch(console.error);
      }

      const alertMsg = await message.channel.send(
        `🔇 ${message.author} has been timed out for **${muteHours} hour(s)** for inappropriate language.`
      ).catch(() => {});
      setTimeout(() => alertMsg?.delete().catch(() => {}), 6000);

      const auditChan = message.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
      if (auditChan) {
        const logEmbed = new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle("🔇 AutoMod • Member Muted (Tier 2)")
          .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: "👤 Offender", value: `${message.author} (\`${message.author.id}\`)`, inline: true },
            { name: "📍 Channel", value: `${message.channel}`, inline: true },
            { name: "🚩 Trigger Word", value: `\`${muteTerm}\``, inline: true },
            { name: "⏳ Duration", value: `\`${muteHours} Hours\` (Offense #${priorMutes + 1})`, inline: true },
            { name: "💬 Message Content", value: `\`\`\`\n${message.content.slice(0, 1000)}\n\`\`\``, inline: false }
          )
          .setFooter({ text: "Automated Enforcement" })
          .setTimestamp();

        await auditChan.send({ embeds: [logEmbed] }).catch(() => {});
      }
      return;
    }

    // TIER 1: AUTOMATIC WARNING
    if (warnTerm) {
      await message.delete().catch(() => {});
      issueAutoWarning(message.author.id, `Mild profanity (Keyword: "${warnTerm}")`);

      const totalWarnings = warnings[message.author.id]?.length || 1;

      let escalationNotice = "";
      if (totalWarnings >= 3 && member) {
        await member.timeout(60 * 60 * 1000, "[AutoMod Escalation] Reached 3+ active warnings").catch(() => {});
        escalationNotice = "\n🚨 **Threshold Reached:** You have accumulated 3+ warnings and received an automatic 1-hour timeout.";
      }

      const alertMsg = await message.channel.send(
        `⚠️ ${message.author}, inappropriate language is not allowed. A formal warning has been issued. (Warning #${totalWarnings})${escalationNotice}`
      ).catch(() => {});
      setTimeout(() => alertMsg?.delete().catch(() => {}), 6000);

      const auditChan = message.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
      if (auditChan) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("⚠️ AutoMod • Member Warned (Tier 1)")
          .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: "👤 Offender", value: `${message.author} (\`${message.author.id}\`)`, inline: true },
            { name: "📍 Channel", value: `${message.channel}`, inline: true },
            { name: "🚩 Trigger Word", value: `\`${warnTerm}\``, inline: true },
            { name: "⚠️ Total Warnings", value: `\`${totalWarnings}\``, inline: true },
            { name: "💬 Message Content", value: `\`\`\`\n${message.content.slice(0, 1000)}\n\`\`\``, inline: false }
          )
          .setFooter({ text: "Automated Enforcement" })
          .setTimestamp();

        await auditChan.send({ embeds: [logEmbed] }).catch(() => {});
      }
      return;
    }
  }

  /* --- 3. PASSIVE LEVELING XP --- */
  const userId = message.author.id;
  if (!levels[userId]) {
    levels[userId] = { xp: 0, level: 1 };
  }

  levels[userId].xp += 10;
  const neededXP = levels[userId].level * 100;

  if (levels[userId].xp >= neededXP) {
    levels[userId].xp -= neededXP;
    levels[userId].level++;

    const levelChannel = client.channels.cache.get(LEVEL_CHANNEL_ID);
    if (levelChannel) {
      levelChannel.send(
        `🎉 Congratulations ${message.author}! You have reached level **${levels[userId].level}**! Keep going!`
      ).catch(() => {});
    }
  }

  saveLevels();
});

/* =========================================================
   12. SLASH COMMAND INTERACTIONS
========================================================= */
client.on("interactionCreate", async (interaction) => {

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    const member = interaction.member;

    function noPerm() {
      return interaction.reply({
        content: "❌ You don't have permission to do this.",
        ephemeral: true
      });
    }

    /* --- LEVELADD (OWNER ONLY) --- */
    if (commandName === "leveladd") {
      if (interaction.user.id !== OWNER_ID) return noPerm();

      const target = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      const userId = target.id;

      if (!levels[userId]) {
        levels[userId] = { xp: 0, level: 1 };
      }

      levels[userId].level += amount;
      saveLevels();

      return interaction.reply(
        `✅ ${target.tag} has been given **${amount} levels**! Now level **${levels[userId].level}**.`
      );
    }

    /* --- BAN (OWNER ONLY) --- */
    if (commandName === "ban") {
      if (interaction.user.id !== OWNER_ID) return noPerm();

      const targetUser = interaction.options.getUser("user");
      const duration = interaction.options.getString("duration");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.reply({ content: "❌ Member not found in this server.", ephemeral: true });

      if (!bans[targetUser.id]) {
        bans[targetUser.id] = { history: [] };
      }

      if (duration.toLowerCase() === "perm" || duration.toLowerCase() === "permanent") {
        bans[targetUser.id].history.push({
          action: "Permanent Ban",
          moderator: interaction.user.tag,
          reason,
          duration: "Permanent",
          date: Date.now()
        });

        saveBans();
        await targetMember.ban({ reason });

        return interaction.reply(
          `🔨 ${targetUser.tag} permanently banned.\nReason: ${reason}`
        );
      }

      const durationMs = ms(duration);
      if (!durationMs) return interaction.reply({ content: "❌ Use formats like: 1h, 1d, 7d, 30d.", ephemeral: true });

      bans[targetUser.id].history.push({
        action: "Temp Ban",
        moderator: interaction.user.tag,
        reason,
        duration,
        expires: Date.now() + durationMs,
        date: Date.now()
      });

      saveBans();
      await targetMember.ban({ reason: `${reason} | Temp Ban` });

      interaction.reply(
        `🔨 ${targetUser.tag} banned for ${duration}`
      );

      setTimeout(async () => {
        try {
          await interaction.guild.members.unban(targetUser.id);
          if (!bans[targetUser.id]) return;

          bans[targetUser.id].history.push({
            action: "Auto Unban (Expired)",
            moderator: "System",
            date: Date.now()
          });

          saveBans();
          interaction.channel.send(
            `🔓 ${targetUser.tag}'s temporary ban has expired.`
          );
        } catch {}
      }, durationMs);
      return;
    }

    /* --- UNBAN (OWNER ONLY) --- */
    if (commandName === "unban") {
      if (interaction.user.id !== OWNER_ID) return noPerm();

      const userId = interaction.options.getString("user_id");

      try {
        await interaction.guild.members.unban(userId);

        if (!bans[userId]) {
          bans[userId] = { history: [] };
        }

        bans[userId].history.push({
          action: "Manual Unban",
          moderator: interaction.user.tag,
          date: Date.now()
        });

        saveBans();
        return interaction.reply(`🔓 User ${userId} has been unbanned.`);
      } catch {
        return interaction.reply({ content: "❌ Failed to unban user. Make sure the ID is valid.", ephemeral: true });
      }
    }

    /* --- WARNLIST --- */
    if (commandName === "warnlist") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const warns = warnings[target.id] || [];

      if (warns.length === 0) {
        return interaction.reply(`✅ ${target.tag} has no warnings.`);
      }

      const list = warns
        .map((w, i) => {
          const date = new Date(w.date).toLocaleDateString();
          return `**${i + 1}.** ${w.reason}\n📅 ${date}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("⚠️ Warning History")
        .setDescription(`👤 ${target.tag}\n\n${list}`)
        .setFooter({ text: `Total: ${warns.length}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- WARN --- */
    if (commandName === "warn") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const reason = interaction.options.getString("reason") || "No reason provided";

      if (!warnings[target.id]) warnings[target.id] = [];

      warnings[target.id].push({
        reason,
        date: Date.now()
      });

      saveWarnings();
      return interaction.reply(
        `⚠️ ${target.tag} warned.\nReason: ${reason}`
      );
    }

    /* --- REMOVEWARN --- */
    if (commandName === "removewarn") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const num = interaction.options.getInteger("number");
      const warns = warnings[target.id] || [];

      if (num < 1 || num > warns.length) {
        return interaction.reply({ content: "❌ Invalid warning number.", ephemeral: true });
      }

      warns.splice(num - 1, 1);
      warnings[target.id] = warns;
      saveWarnings();

      return interaction.reply(
        `✅ Removed warning #${num} from ${target.tag}`
      );
    }

    /* --- CLEARWARN --- */
    if (commandName === "clearwarn") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      warnings[target.id] = [];
      saveWarnings();

      return interaction.reply(
        `✅ Cleared all warnings for ${target.tag}`
      );
    }

    /* --- MUTEHISTORY --- */
    if (commandName === "mutehistory") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const data = mutes[target.id];

      if (!data || !data.history.length) {
        return interaction.reply(`✅ ${target.tag} has no mute history.`);
      }

      const text = data.history
        .map((m, i) => {
          const date = new Date(m.date).toLocaleDateString();
          return `**${i + 1}. ${m.action}**\n👮 ${m.moderator}\n📌 ${m.reason || "N/A"}\n📅 ${date}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle("🔇 Mute History")
        .setDescription(`👤 ${target.tag}\n\n${text}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- MUTE --- */
    if (commandName === "mute") {
      if (!isStaff(member)) return noPerm();

      const targetUser = interaction.options.getUser("user");
      const reason = interaction.options.getString("reason") || "No reason provided";
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.reply({ content: "❌ Target member not found.", ephemeral: true });

      await targetMember.timeout(28 * 24 * 60 * 60 * 1000, reason).catch(() => null);

      if (!mutes[targetUser.id]) {
        mutes[targetUser.id] = { history: [] };
      }

      mutes[targetUser.id].history.push({
        action: "Mute",
        moderator: interaction.user.tag,
        reason,
        date: Date.now()
      });

      saveMutes();
      return interaction.reply(
        `🔇 ${targetUser.tag} has been muted.\nReason: ${reason}`
      );
    }

    /* --- UNMUTE --- */
    if (commandName === "unmute") {
      if (!isStaff(member)) return noPerm();

      const targetUser = interaction.options.getUser("user");
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) return interaction.reply({ content: "❌ Target member not found.", ephemeral: true });

      await targetMember.timeout(null).catch(() => null);

      if (!mutes[targetUser.id]) {
        mutes[targetUser.id] = { history: [] };
      }

      mutes[targetUser.id].history.push({
        action: "Unmute",
        moderator: interaction.user.tag,
        date: Date.now()
      });

      saveMutes();
      return interaction.reply(`🔊 ${targetUser.tag} has been unmuted.`);
    }

    /* --- BANHISTORY --- */
    if (commandName === "banhistory") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const data = bans[target.id];

      if (!data || !data.history.length) {
        return interaction.reply(`✅ ${target.tag} has no ban history.`);
      }

      const text = data.history
        .map((b, i) => {
          const date = new Date(b.date).toLocaleDateString();
          return `**${i + 1}. ${b.action}**\n👮 ${b.moderator}\n📌 ${b.reason || "N/A"}\n⏳ ${b.duration || "N/A"}\n📅 ${date}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("⚖️ Ban History")
        .setDescription(`👤 ${target.tag}\n\n${text}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- HELP MENU COMMAND --- */
    if (commandName === "help") {
      const selectedCategory = interaction.options.getString("category") || "overview";

      function getHelpEmbed(cat) {
        if (cat === "info") {
          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("🌐 Server & General Commands")
            .setDescription(
              "• **`/rules`**\n" +
              "  └ View the official Discord server rules.\n\n" +
              "• **`/grules`**\n" +
              "  └ Read in-game gameplay restrictions and allowed modifications.\n\n" +
              "• **`/punishments`**\n" +
              "  └ View punishment ladders and enforcement guidelines.\n\n" +
              "• **`/tac`**\n" +
              "  └ Read server terms, conditions, and guidelines.\n\n" +
              "• **`/help [category]`**\n" +
              "  └ Open this interactive command directory."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: General & Information" })
            .setTimestamp();
        }

        if (cat === "stats") {
          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("📊 Levels, Invites & Ranking")
            .setDescription(
              "• **`/level [user]`**\n" +
              "  └ Check current chat level, XP progress, and visual status bar.\n\n" +
              "• **`/leaderboard [type]`**\n" +
              "  └ View top 10 rankings for **Levels**, **Top Inviters**, or **Clean Standing**.\n\n" +
              "• **`/invite [user]`**\n" +
              "  └ View quick overview of your real, fake, and left invites.\n\n" +
              "• **`/invitedashboard [user]`**\n" +
              "  └ Display complete invite analytics, efficiency ratings, and tracked joins."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: Levels & Invites" })
            .setTimestamp();
        }

        if (cat === "games") {
          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("🎮 Mini-Games & Arcade")
            .setDescription(
              "• **`/snake`**\n" +
              "  └ Play the retro button-controlled Snake arcade game.\n\n" +
              "• **`/tictactoe [mode] [opponent]`**\n" +
              "  └ Play Tic Tac Toe against an unbeatable AI or challenge a friend.\n\n" +
              "• **`/wordle`**\n" +
              "  └ Guess the secret 5-letter word within 6 tries.\n\n" +
              "• **`/guess`**\n" +
              "  └ Guess the hidden number between 1 and 10,000.\n\n" +
              "• **`/howgay [user]`**\n" +
              "  └ Fun meter calculating random rainbow score."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: Mini-Games & Fun" })
            .setTimestamp();
        }

        if (cat === "mod") {
          return new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🛡️ Staff & Moderation Commands")
            .setDescription(
              "• **`/warn [user] [reason]`** — Issue a server warning.\n" +
              "• **`/warnlist [user]`** — Inspect all active warnings on a user.\n" +
              "• **`/removewarn [user] [number]`** — Delete a specific warning index.\n" +
              "• **`/clearwarn [user]`** — Clear all warning records for a user.\n" +
              "• **`/mute [user] [reason]`** — Timeout a member for 28 days.\n" +
              "• **`/unmute [user]`** — Remove active timeout from a member.\n" +
              "• **`/mutehistory [user]`** — Inspect full past timeout logs.\n" +
              "• **`/banhistory [user]`** — Inspect past temporary/permanent ban logs.\n" +
              "• **`/gstart [duration] [winners] [prize]`** — Host persistent giveaway.\n" +
              "• **`/greroll [message_id]`** — Reroll giveaway winner from stored entries.\n" +
              "• **`/ban [user] [duration] [reason]`** — *(Owner Only)* Temp/perm ban.\n" +
              "• **`/unban [user_id]`** — *(Owner Only)* Revoke a server ban by user ID.\n" +
              "• **`/leveladd [user] [amount]`** — *(Owner Only)* Award bonus chat levels."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: Staff Moderation (Restricted)" })
            .setTimestamp();
        }

        return new EmbedBuilder()
          .setColor(0x8600FF)
          .setAuthor({ name: "Server Bot Directory", iconURL: THUMBNAIL })
          .setTitle("📖 Command Directory")
          .setDescription(
            "Welcome to the official server command manual.\n" +
            "Select a module from the dropdown menu below to inspect commands, parameters, and usage.\n\n" +
            "**Directory Modules:**\n" +
            "• **🌐 General & Server** — Rules, guidelines, and terms\n" +
            "• **📊 Levels & Invites** — Level progress, invite tracking, and leaderboards\n" +
            "• **🎮 Mini-Games** — Snake, TicTacToe, Wordle, and Guess games\n" +
            "• **🛡️ Staff Operations** — Full moderation suite and giveaway system"
          )
          .setImage(BANNER)
          .setFooter({ text: "Use the dropdown below to browse" })
          .setTimestamp();
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId("help_menu")
        .setPlaceholder("Select a command module to inspect")
        .addOptions([
          { label: "Overview", description: "Main directory page", emoji: "📖", value: "overview" },
          { label: "General & Server Info", description: "Server rules and guidelines", emoji: "🌐", value: "info" },
          { label: "Levels & Invites", description: "Level cards, invite stats, and leaderboards", emoji: "📊", value: "stats" },
          { label: "Mini-Games & Fun", description: "Snake, TicTacToe, Wordle, and Guess", emoji: "🎮", value: "games" },
          { label: "Staff & Moderation", description: "Warns, mutes, bans, and giveaways", emoji: "🛡️", value: "mod" }
        ]);

      const selectRow = new ActionRowBuilder().addComponents(menu);

      const helpMessage = await interaction.reply({
        embeds: [getHelpEmbed(selectedCategory)],
        components: [selectRow],
        fetchReply: true
      });

      const collector = helpMessage.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time: 5 * 60 * 1000
      });

      collector.on("collect", async (i) => {
        if (i.isStringSelectMenu() && i.customId === "help_menu") {
          const selected = i.values[0];
          await i.update({
            embeds: [getHelpEmbed(selected)],
            components: [selectRow]
          }).catch(() => {});
        }
      });

      collector.on("end", async () => {
        const disabledRow = new ActionRowBuilder().addComponents(
          menu.setDisabled(true)
        );
        await helpMessage.edit({ components: [disabledRow] }).catch(() => {});
      });

      return;
    }     

    /* --- LEVEL --- */
    if (commandName === "level") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const userId = targetUser.id;

      if (!levels[userId]) {
        levels[userId] = { xp: 0, level: 1 };
      }

      const userXP = levels[userId].xp;
      const userLevel = levels[userId].level;
      const neededXP = userLevel * 100;

      const percent = Math.min(10, Math.max(0, Math.floor((userXP / neededXP) * 10)));
      const filledBar = "█".repeat(percent);
      const emptyBar = "░".repeat(10 - percent);
      const progressBar = `${filledBar}${emptyBar}`;

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📊 Level Info")
        .setDescription(
          `👤 User: **${targetUser.tag}**\n` +
          `⭐ Level: **${userLevel}**\n` +
          `⚡ XP: **${userXP}/${neededXP}**\n\n` +
          `📈 Progress:\n${progressBar}`
        );

      return interaction.reply({ embeds: [embed] });
    }

    /* --- INVITE DASHBOARD --- */
    if (commandName === "invitedashboard") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const data = getInvite(targetUser.id);
      const totalHistory = data.history.length;

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📊 Invite Dashboard")
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `👤 **User:** ${targetUser.tag}\n\n` +
          `✅ **Total Invites:** ${data.total}\n` +
          `✨ **Current Invites:** ${data.current}\n` +
          `⚠️ **Left Invites:** ${data.left}\n` +
          `❌ **Fake Invites:** ${data.fake}\n\n` +
          `📜 **Total Joins Tracked:** ${totalHistory}`
        )
        .addFields(
          {
            name: "📋 Breakdown",
            value:
              `Real Invites: ${data.current}\n` +
              `Fake Invites: ${data.fake}\n` +
              `Left Users: ${data.left}`
          },
          {
            name: "📈 Efficiency",
            value:
              data.total > 0
                ? `${Math.floor((data.current / data.total) * 100)}% Real Invites`
                : "0% Real Invites"
          }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- INVITE CHECK --- */
    if (commandName === "invite") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const data = getInvite(targetUser.id);

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📨 Invite Overview")
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `👤 **User:** ${targetUser.tag}\n\n` +
          `✅ **Total Invites:** ${data.total}\n` +
          `✨ **Current Invites:** ${data.current}\n` +
          `❌ **Left Invites:** ${data.left}\n` +
          `⚠️ **Fake Invites:** ${data.fake}`
        )
        .setFooter({ text: "Use /invitedashboard for full stats view" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- PERSISTENT GIVEAWAY START --- */
    if (commandName === "gstart") {
      if (!isStaff(member)) return noPerm();

      const timeInput = interaction.options.getString("duration");
      const winnerCount = interaction.options.getInteger("winners");
      const prize = interaction.options.getString("prize");

      const durationMs = ms(timeInput);
      if (!durationMs || durationMs < 5000) {
        return interaction.reply({ content: "❌ Invalid duration! Use formats like `1m`, `30m`, `2h`, `1d`.", ephemeral: true });
      }

      const endTimestamp = Math.floor((Date.now() + durationMs) / 1000);
      const endsAt = Date.now() + durationMs;

      const giveawayEmbed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("🎉 SERVER GIVEAWAY 🎉")
        .setDescription(
          `🎁 **Prize:** ${prize}\n` +
          `👑 **Hosted by:** ${interaction.user}\n` +
          `👥 **Winners:** **${winnerCount}**\n` +
          `⏳ **Ends:** <t:${endTimestamp}:R> (<t:${endTimestamp}:f>)\n\n` +
          `Click the **🎉 Enter** button below to participate!`
        )
        .setImage(BANNER)
        .setFooter({ text: `Entries: 0 | Ends at` })
        .setTimestamp(endsAt);

      const enterButton = new ButtonBuilder()
        .setCustomId("giveaway_enter")
        .setLabel("Enter (0)")
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(enterButton);

      const giveawayMsg = await interaction.reply({
        embeds: [giveawayEmbed],
        components: [row],
        fetchReply: true
      });

      activeGiveaways.push({
        messageId: giveawayMsg.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        hostId: interaction.user.id,
        prize,
        winnerCount,
        endsAt,
        ended: false,
        entries: []
      });
      saveGiveaways();
      return;
    }

    /* --- PERSISTENT GIVEAWAY REROLL --- */
    if (commandName === "greroll") {
      if (!isStaff(member)) return noPerm();

      const targetId = interaction.options.getString("message_id");
      const gw = activeGiveaways.find((g) => g.messageId === targetId);

      if (!gw) {
        return interaction.reply({ content: "❌ Could not find a giveaway with that message ID!", ephemeral: true });
      }

      if (!gw.ended) {
        return interaction.reply({ content: "❌ That giveaway is still active and hasn't ended yet!", ephemeral: true });
      }

      if (!gw.entries || gw.entries.length === 0) {
        return interaction.reply({ content: "❌ Cannot reroll: There were no valid entries in that giveaway.", ephemeral: true });
      }

      const newWinner = gw.entries[Math.floor(Math.random() * gw.entries.length)];

      return interaction.reply({
        content: `🎉 **New Winner Rerolled!** Congratulations <@${newWinner}>! You won **${gw.prize}**!`
      });
    }

    /* --- RULES --- */
    if (commandName === "rules") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📜 Server Rules")
        .setDescription(`
# 📜 Server Rules
━━━━━━━━━━━━━━
## 💬 **1. Chat Rules**
Keep chat friendly, clean, and respectful. Toxicity, harassment, discrimination, spam, and NSFW are strictly prohibited.

## 🎮 **2. Fair Play**
No cheating, exploiting, or taking unfair advantage over other community members.

## 🛡️ **3. Discord Terms**
Follow Discord's Terms of Service and Community Guidelines at all times.

## ⚖️ **4. Moderation**
Staff decisions are final. Use common sense.
        `)
        .setThumbnail(THUMBNAIL)
        .setImage(BANNER)
        .setFooter({ text: "Server Rules" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- GRULES --- */
    if (commandName === "grules") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("⚔️ In-Game Rules")
        .setDescription(`
# **In-Game Rules**
━━━━━━━━━━━━━━━━━━━━━━━━
• No hacked clients, movement mods, or auto-clickers.
• No exploiting, duplicating items, or bug abuse.
• No IRL trading or scamming players.
• Report all bugs directly to server staff.
• Respect server limits and keep farming automated machines clean.
        `)
        .setImage(BANNER)
        .setFooter({ text: "In-Game Rules" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- PUNISHMENTS --- */
    if (commandName === "punishments") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("⚖️ Punishment System")
        .setDescription(`
# **Punishment Ladder**
━━━━━━━━━━━━━━━━━━━━━━━━
1. **Warning** — First-time or minor offenses.
2. **Mute / Timeout** — Repeated chat disruptions or mild toxicity.
3. **Kick / Temp Ban** — Severe violations or repeated infractions.
4. **Permanent Ban** — Malicious exploits, severe harassment, or intentional disruption.

*Staff reserve the right to elevate penalties based on severity and context.*
        `)
        .setImage(BANNER)
        .setFooter({ text: "Punishment System" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- TAC --- */
    if (commandName === "tac") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📋 Terms and Conditions")
        .setDescription(`
# **Terms and Conditions**
━━━━━━━━━━━━━━━━━━━━━━
By interacting with this server and our services, you agree to comply with our community standards. 

• **Account Responsibility:** You are solely responsible for actions performed from your account.
• **Modifications:** Server rules, roles, and systems may adapt over time for server health.
• **Agreement:** Continuous stay within this Discord community constitutes acceptance of these terms.
        `)
        .setImage(BANNER)
        .setFooter({ text: "Terms and Conditions" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- HOWGAY --- */
    if (commandName === "howgay") {
      const user = interaction.options.getUser("user") || interaction.user;
      const gayPercent = Math.floor(Math.random() * 101);

      const filled = "▰".repeat(Math.floor(gayPercent / 10));
      const empty = "▱".repeat(10 - Math.floor(gayPercent / 10));

      const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle("🏳️‍🌈 Fun-O-Meter")
        .setDescription(
          `**Target:** ${user}\n\n` +
          `**Rating:** ${gayPercent}%\n` +
          `${filled}${empty}\n\n` +
          `*This is just for fun! Results are completely random.*`
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- TICKET PANEL --- */
    if (commandName === "panel") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("🎟️ Server Support Ticket System")
        .setDescription(
          "Select a ticket type from the dropdown menu below.\n\n" +
          "❓ **General Support**\n" +
          "🛡️ **Player Reports**\n" +
          "⚖️ **Punishment Appeals**"
        )
        .setImage(BANNER)
        .setThumbnail(THUMBNAIL)
        .setFooter({ text: "Support Center" });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_menu")
        .setPlaceholder("Select a ticket type")
        .addOptions([
          {
            label: "General Support",
            description: "Need help from staff",
            emoji: "❓",
            value: "support"
          },
          {
            label: "Player Report",
            description: "Report a rule violator",
            emoji: "🛡️",
            value: "report"
          },
          {
            label: "Punishment Appeal",
            description: "Appeal your punishment",
            emoji: "⚖️",
            value: "appeal"
          }
        ]);

      const row = new ActionRowBuilder().addComponents(menu);

      return interaction.reply({ embeds: [embed], components: [row] });
    }

    /* --- TIC TAC TOE --- */
    if (commandName === "tictactoe") {
      const type = interaction.options.getString("mode");
      let player1 = interaction.user;
      let player2 = null;
      let isBotGame = type === "s";

      if (isBotGame) {
        player2 = { id: "bot", username: "Bot AI", tag: "Bot AI" };
      } else {
        player2 = interaction.options.getUser("opponent");
        if (!player2 || player2.bot || player2.id === player1.id) {
          return interaction.reply({ content: "❌ Please mention a valid player to challenge!", ephemeral: true });
        }
      }

      let board = Array(9).fill(null);
      let turn = player1.id;

      function makeRows() {
        const rows = [];
        for (let i = 0; i < 3; i++) {
          const row = new ActionRowBuilder();
          for (let j = 0; j < 3; j++) {
            const index = i * 3 + j;
            const style = board[index] === "❌" ? ButtonStyle.Danger : board[index] === "⭕" ? ButtonStyle.Success : ButtonStyle.Secondary;
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`ttt_${index}`)
                .setLabel(board[index] || "➖")
                .setStyle(style)
                .setDisabled(board[index] !== null)
            );
          }
          rows.push(row);
        }
        return rows;
      }

      function checkWin() {
        const lines = [
          [0, 1, 2], [3, 4, 5], [6, 7, 8],
          [0, 3, 6], [1, 4, 7], [2, 5, 8],
          [0, 4, 8], [2, 4, 6]
        ];
        for (const line of lines) {
          if (board[line[0]] && board[line[0]] === board[line[1]] && board[line[0]] === board[line[2]]) {
            return board[line[0]];
          }
        }
        return board.includes(null) ? null : "tie";
      }

      function evaluateBoard(b) {
        const lines = [
          [0, 1, 2], [3, 4, 5], [6, 7, 8],
          [0, 3, 6], [1, 4, 7], [2, 5, 8],
          [0, 4, 8], [2, 4, 6]
        ];
        for (const line of lines) {
          if (b[line[0]] && b[line[0]] === b[line[1]] && b[line[0]] === b[line[2]]) {
            return b[line[0]] === "⭕" ? 10 : -10;
          }
        }
        return 0;
      }

      function minimax(tempBoard, depth, isMax) {
        let score = evaluateBoard(tempBoard);
        if (score === 10) return score - depth;
        if (score === -10) return score + depth;
        if (!tempBoard.includes(null)) return 0;

        if (isMax) {
          let best = -1000;
          for (let i = 0; i < 9; i++) {
            if (tempBoard[i] === null) {
              tempBoard[i] = "⭕";
              best = Math.max(best, minimax(tempBoard, depth + 1, false));
              tempBoard[i] = null;
            }
          }
          return best;
        } else {
          let best = 1000;
          for (let i = 0; i < 9; i++) {
            if (tempBoard[i] === null) {
              tempBoard[i] = "❌";
              best = Math.min(best, minimax(tempBoard, depth + 1, true));
              tempBoard[i] = null;
            }
          }
          return best;
        }
      }

      function findBestMove() {
        let bestVal = -1000;
        let bestMove = -1;
        for (let i = 0; i < 9; i++) {
          if (board[i] === null) {
            board[i] = "⭕";
            let moveVal = minimax(board, 0, false);
            board[i] = null;
            if (moveVal > bestVal) {
              bestMove = i;
              bestVal = moveVal;
            }
          }
        }
        return bestMove;
      }

      const gameMessage = await interaction.reply({
        content: `❌ **${player1} (X)** vs ⭕ **${isBotGame ? player2.username : player2} (O)**\n\n🎯 Current Turn: <@${turn}>\n⏳ *You have 15 minutes to make a move!*`,
        components: makeRows(),
        fetchReply: true
      });

      const collector = gameMessage.createMessageComponentCollector({
        filter: (i) => i.user.id === player1.id || i.user.id === (isBotGame ? "" : player2.id),
        time: 15 * 60 * 1000
      });

      collector.on("collect", async (i) => {
        if (i.user.id !== turn) {
          return i.reply({ content: "❌ It is not your turn!", ephemeral: true });
        }

        const index = parseInt(i.customId.split("_")[1]);
        board[index] = turn === player1.id ? "❌" : "⭕";

        let status = checkWin();

        if (status) {
          collector.stop(status);
          await i.deferUpdate().catch(() => {});
          return;
        }

        turn = turn === player1.id ? player2.id : player1.id;

        if (isBotGame && turn === "bot") {
          const botMove = findBestMove();
          if (botMove !== -1) {
            board[botMove] = "⭕";
            status = checkWin();
            if (status) {
              collector.stop(status);
              await i.deferUpdate().catch(() => {});
              return;
            }
            turn = player1.id;
          }
        }

        collector.resetTimer({ time: 15 * 60 * 1000 });

        await i.update({
          content: `❌ **${player1.username}** vs ⭕ **${isBotGame ? player2.username : player2.username}**\n\n🎯 Current Turn: <@${turn}>\n⏳ *15 minutes remaining for this turn!*`,
          components: makeRows()
        }).catch(() => {});
      });

      collector.on("end", async (collected, reason) => {
        const disabledRows = makeRows().map(row => {
          row.components.forEach(btn => btn.setDisabled(true));
          return row;
        });

        if (reason === "❌") {
          await gameMessage.edit({ content: `🎉 **Game Over!** ${player1} (X) won the match!`, components: disabledRows }).catch(() => {});
        } else if (reason === "⭕") {
          await gameMessage.edit({ content: `🎉 **Game Over!** ${isBotGame ? player2.username : player2} (O) won the match!`, components: disabledRows }).catch(() => {});
        } else if (reason === "tie") {
          await gameMessage.edit({ content: `🤝 **Game Over!** It's a draw!`, components: disabledRows }).catch(() => {});
        } else {
          await gameMessage.edit({ content: `⚠️ **Game Over!** Match timed out.`, components: disabledRows }).catch(() => {});
        }
      });
      return;
    }

    /* --- WORDLE --- */
    if (commandName === "wordle") {
      const words = ["apple", "beach", "craft", "drive", "elder", "flame", "grape", "house", "image", "juice", "knife", "lemon", "melon", "night", "ocean", "paper", "queen", "river", "stone", "tiger", "unity", "vocal", "whale", "youth", "zebra"];
      const targetWord = words[Math.floor(Math.random() * words.length)];
      let attempts = 0;
      let maxAttempts = 6;
      let gameBoard = [];

      const startEmbed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("📝 Wordle Game Initialized!")
        .setDescription(`I've picked a secret **5-letter word**. You have **6 tries** to guess it!\n\nType your 5-letter guesses in this channel.`)
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.reply({ embeds: [startEmbed] });

      const collector = interaction.channel.createMessageCollector({
        filter: (m) => m.author.id === interaction.user.id,
        time: 15 * 60 * 1000
      });

      collector.on("collect", async (m) => {
        const guess = m.content.toLowerCase().trim();

        if (guess.length !== 5) {
          return m.reply("⚠️ Your guess must be exactly **5 letters** long!").then(msg => setTimeout(() => msg.delete().catch(() => {}), 3000));
        }

        attempts++;
        let remainingLetters = targetWord;

        let trackingMatches = Array(5).fill("⬛");
        for (let i = 0; i < 5; i++) {
          if (guess[i] === targetWord[i]) {
            trackingMatches[i] = "🟩";
            remainingLetters = remainingLetters.replace(guess[i], "");
          }
        }

        for (let i = 0; i < 5; i++) {
          if (trackingMatches[i] !== "🟩" && remainingLetters.includes(guess[i])) {
            trackingMatches[i] = "🟨";
            remainingLetters = remainingLetters.replace(guess[i], "");
          }
        }

        gameBoard.push(trackingMatches.join("") + `  |  **${guess.toUpperCase()}**`);
        collector.resetTimer({ time: 15 * 60 * 1000 });

        const statusEmbed = new EmbedBuilder()
          .setColor(0x8600FF)
          .setTitle("📝 Wordle Tracker")
          .setDescription(gameBoard.join("\n") + "\n\n⏳ *15 minutes left for your next guess.*")
          .setFooter({ text: `Attempt ${attempts}/${maxAttempts}` })
          .setTimestamp();

        await m.reply({ embeds: [statusEmbed] }).catch(() => {});

        if (guess === targetWord) {
          collector.stop("win");
        } else if (attempts >= maxAttempts) {
          collector.stop("lose");
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "win") {
          interaction.channel.send(`🎉 Congratulations ${interaction.user}! You guessed the secret word **${targetWord.toUpperCase()}** in ${attempts} tries!`);
        } else if (reason === "lose") {
          interaction.channel.send(`❌ Game Over ${interaction.user}! The secret word was **${targetWord.toUpperCase()}**.`);
        } else {
          interaction.channel.send(`⚠️ ${interaction.user}, your Wordle session timed out.`);
        }
      });
      return;
    }

    /* --- GUESS THE NUMBER --- */
    if (commandName === "guess") {
      const targetNumber = Math.floor(Math.random() * 10000) + 1;
      let attempts = 0;

      const startEmbed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("🔢 Guess the Number!")
        .setDescription("I have picked a secret number between **1 and 10000**.\n\nType your guesses directly into this channel!")
        .setFooter({ text: `Player: ${interaction.user.username}` })
        .setTimestamp();

      await interaction.reply({ embeds: [startEmbed] });

      const collector = interaction.channel.createMessageCollector({
        filter: (m) => m.author.id === interaction.user.id,
        time: 15 * 60 * 1000
      });

      collector.on("collect", async (m) => {
        const guess = parseInt(m.content.trim());
        if (isNaN(guess)) return;

        attempts++;
        collector.resetTimer({ time: 15 * 60 * 1000 });

        if (guess === targetNumber) {
          collector.stop("win");
        } else if (guess > targetNumber) {
          await m.reply(`🔻 **${guess}** is **too high**! Try lower. *(Attempt: ${attempts})*`).catch(() => {});
        } else {
          await m.reply(`🔺 **${guess}** is **too low**! Try higher. *(Attempt: ${attempts})*`).catch(() => {});
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "win") {
          interaction.channel.send(`🎉 **Congratulations ${interaction.user}!** You found the correct number **${targetNumber}** in **${attempts}** attempts!`);
        } else {
          interaction.channel.send(`⚠️ ${interaction.user}, session timed out. The secret number was **${targetNumber}**.`);
        }
      });
      return;
    }

    /* --- SNAKE --- */
    if (commandName === "snake") {
      const width = 5;
      const height = 5;
      let score = 0;

      let snake = [{ x: 2, y: 2 }];
      let apple = { x: 0, y: 0 };

      function generateApple() {
        while (true) {
          const randX = Math.floor(Math.random() * width);
          const randY = Math.floor(Math.random() * height);
          if (!snake.some(segment => segment.x === randX && segment.y === randY)) {
            apple = { x: randX, y: randY };
            break;
          }
        }
      }
      generateApple();

      function drawBoard() {
        let boardString = "";
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (snake[0].x === x && snake[0].y === y) {
              boardString += "🟩";
            } else if (snake.some(segment => segment.x === x && segment.y === y)) {
              boardString += "🟢";
            } else if (apple.x === x && apple.y === y) {
              boardString += "🍎";
            } else {
              boardString += "⬛";
            }
          }
          boardString += "\n";
        }
        return boardString;
      }

      const gameEmbed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("🐍 Retro Snake Game")
        .setDescription(drawBoard())
        .addFields({ name: "🏆 Score", value: `**${score}**`, inline: true })
        .setFooter({ text: "Use buttons below to control the snake!" })
        .setTimestamp();

      const controlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("snake_up").setEmoji("⬆️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("snake_down").setEmoji("⬇️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("snake_left").setEmoji("⬅️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("snake_right").setEmoji("➡️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("snake_stop").setEmoji("🛑").setStyle(ButtonStyle.Danger)
      );

      const gameMessage = await interaction.reply({
        embeds: [gameEmbed],
        components: [controlRow],
        fetchReply: true
      });

      const collector = gameMessage.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time: 15 * 60 * 1000
      });

      collector.on("collect", async (i) => {
        let moveX = 0;
        let moveY = 0;

        if (i.customId === "snake_stop") {
          collector.stop("stopped");
          await i.deferUpdate().catch(() => {});
          return;
        }

        if (i.customId === "snake_up") moveY = -1;
        if (i.customId === "snake_down") moveY = 1;
        if (i.customId === "snake_left") moveX = -1;
        if (i.customId === "snake_right") moveX = 1;

        const newHead = { x: snake[0].x + moveX, y: snake[0].y + moveY };

        if (newHead.x < 0 || newHead.x >= width || newHead.y < 0 || newHead.y >= height) {
          collector.stop("dead");
          await i.deferUpdate().catch(() => {});
          return;
        }

        if (snake.some(segment => segment.x === newHead.x && segment.y === newHead.y)) {
          collector.stop("dead");
          await i.deferUpdate().catch(() => {});
          return;
        }

        snake.unshift(newHead);

        if (newHead.x === apple.x && newHead.y === apple.y) {
          score += 10;
          if (snake.length >= width * height) {
            collector.stop("win");
            await i.deferUpdate().catch(() => {});
            return;
          }
          generateApple();
        } else {
          snake.pop();
        }

        collector.resetTimer({ time: 15 * 60 * 1000 });

        const updatedEmbed = EmbedBuilder.from(gameEmbed)
          .setDescription(drawBoard())
          .setFields({ name: "🏆 Score", value: `**${score}**`, inline: true });

        await i.update({
          embeds: [updatedEmbed],
          components: [controlRow]
        }).catch(() => {});
      });

      collector.on("end", async (collected, reason) => {
        const disabledRow = new ActionRowBuilder().addComponents(
          controlRow.components.map(button => ButtonBuilder.from(button).setDisabled(true))
        );

        const finalEmbed = new EmbedBuilder()
          .setColor(reason === "win" ? 0x57F287 : 0xED4245)
          .setTitle(reason === "win" ? "👑 Flawless Victory!" : "💀 Game Over!")
          .addFields({ name: "Final Score", value: `**${score}** points`, inline: true })
          .setTimestamp();

        if (reason === "dead") {
          finalEmbed.setDescription(`You hit a wall or crashed into your tail!\n\n**Final Grid:**\n${drawBoard()}`);
        } else if (reason === "stopped") {
          finalEmbed.setDescription(`Game was ended manually.\n\n**Final Grid:**\n${drawBoard()}`);
        } else if (reason === "win") {
          finalEmbed.setDescription("Impressive! You filled the entire snake grid!");
        } else {
          finalEmbed.setDescription("Game timed out due to inactivity.");
        }

        await gameMessage.edit({
          embeds: [finalEmbed],
          components: [disabledRow]
        }).catch(() => {});
      });
      return;
    }

    /* --- MULTI-CATEGORY LEADERBOARD SYSTEM --- */
    if (commandName === "leaderboard") {
      const selectedType = interaction.options.getString("type") || "levels";

      function buildLeaderboardEmbed(type) {
        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

        if (type === "levels") {
          const sortedLevels = Object.entries(levels)
            .sort(([, a], [, b]) => (b.level - a.level) || (b.xp - a.xp))
            .slice(0, 10);

          const desc = sortedLevels.length > 0
            ? sortedLevels.map(([id, d], i) => `${medals[i]} <@${id}> • **Level ${d.level}** \`(${d.xp} XP)\``).join("\n")
            : "*No active leveling records found.*";

          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("⭐ Level Leaderboard")
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              desc + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "💬 *Chat in text channels to earn XP and climb the rankings!*"
            )
            .setImage(BANNER)
            .setFooter({ text: "Level Rankings" })
            .setTimestamp();
        }

        if (type === "invites") {
          const sortedInvites = Object.entries(invites)
            .filter(([, d]) => (d.current || 0) > 0)
            .sort(([, a], [, b]) => (b.current || 0) - (a.current || 0))
            .slice(0, 10);

          const desc = sortedInvites.length > 0
            ? sortedInvites.map(([id, d], i) => `${medals[i]} <@${id}> • **${d.current}** Invites \`(${d.total || 0} Total / ${d.fake || 0} Fake)\``).join("\n")
            : "*No tracked invites found.*";

          return new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("📨 Invite Leaderboard")
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              desc + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "👥 *Invite members to the server to climb the rankings!*"
            )
            .setImage(BANNER)
            .setFooter({ text: "Invite Rankings" })
            .setTimestamp();
        }

        if (type === "honor") {
          const cleanUsers = Object.entries(levels)
            .filter(([id]) => {
              const hasWarns = warnings[id] && warnings[id].length > 0;
              const hasMutes = mutes[id] && mutes[id].history && mutes[id].history.length > 0;
              const hasBans = bans[id] && bans[id].history && bans[id].history.length > 0;
              return !hasWarns && !hasMutes && !hasBans;
            })
            .sort(([, a], [, b]) => (b.level - a.level) || (b.xp - a.xp))
            .slice(0, 10);

          const desc = cleanUsers.length > 0
            ? cleanUsers.map(([id, d], i) => `${medals[i]} <@${id}> • **Level ${d.level}** — 🛡️ \`Spotless Record\``).join("\n")
            : "*No qualifying clean-standing members found.*";

          return new EmbedBuilder()
            .setColor(0x3BA55C)
            .setTitle("🛡️ Honor Roll (Zero Violations)")
            .setDescription(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              desc + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "✨ *Awarded to active users with **0 warnings, 0 mutes, and 0 bans**!*"
            )
            .setImage(BANNER)
            .setFooter({ text: "Clean Standing" })
            .setTimestamp();
        }
      }

      function buildActionRow(current) {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("lb_levels")
            .setLabel("Levels")
            .setEmoji("⭐")
            .setStyle(current === "levels" ? ButtonStyle.Primary : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("lb_invites")
            .setLabel("Invites")
            .setEmoji("📨")
            .setStyle(current === "invites" ? ButtonStyle.Primary : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("lb_honor")
            .setLabel("Clean Standing")
            .setEmoji("🛡️")
            .setStyle(current === "honor" ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );
      }

      const initialEmbed = buildLeaderboardEmbed(selectedType);
      const initialRow = buildActionRow(selectedType);

      const replyMsg = await interaction.reply({
        embeds: [initialEmbed],
        components: [initialRow],
        fetchReply: true
      });

      const collector = replyMsg.createMessageComponentCollector({
        filter: (i) => i.customId.startsWith("lb_"),
        time: 5 * 60 * 1000
      });

      collector.on("collect", async (btnInt) => {
        const category = btnInt.customId.replace("lb_", "");
        await btnInt.update({
          embeds: [buildLeaderboardEmbed(category)],
          components: [buildActionRow(category)]
        }).catch(() => {});
      });

      collector.on("end", async () => {
        const disabledRow = new ActionRowBuilder().addComponents(
          initialRow.components.map(b => ButtonBuilder.from(b).setDisabled(true))
        );
        await replyMsg.edit({ components: [disabledRow] }).catch(() => {});
      });

      return;
    }     

  }

  /* =========================================================
     13. SELECT MENU TICKETS
  ========================================================= */
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket_menu") {
      const type = interaction.values[0];

      const permissionOverwrites = [
        {
          id: interaction.guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageChannels
          ]
        }
      ];

      for (const id of STAFF_USER_IDS) {
        const target = interaction.guild.roles.cache.get(id) || interaction.guild.members.cache.get(id);
        if (target) {
          permissionOverwrites.push({
            id: target.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
              PermissionsBitField.Flags.AttachFiles
            ]
          });
        }
      }

      const channel = await interaction.guild.channels.create({
        name: `${type}-${interaction.user.username}`,
        type: ChannelType.GuildText,
        topic: `Ticket Opener: ${interaction.user.id} | Status: Unclaimed`,
        permissionOverwrites
      });

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("🎫 Support Ticket")
        .setDescription(
          `Hello ${interaction.user}!\n\n` +
          `**Category:** \`${type.toUpperCase()}\`\n` +
          `**Status:** 🟡 Unclaimed\n\n` +
          `Please explain your query in detail.\nA staff member will assist you shortly.`
        )
        .setImage(BANNER)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("claim_ticket")
          .setLabel("Claim Ticket")
          .setEmoji("🙋‍♂️")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("close_ticket")
          .setLabel("Close Ticket")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({
        content: `${interaction.user} Welcome! Staff will be with you shortly.`,
        embeds: [embed],
        components: [row]
      });

      return interaction.reply({
        content: `✅ Ticket created: ${channel}`,
        ephemeral: true
      });
    }
  }

  /* =========================================================
     14. BUTTON INTERACTIONS
  ========================================================= */
  if (interaction.isButton()) {

    /* --- CLAIM TICKET (STAFF ONLY) --- */
    if (interaction.customId === "claim_ticket") {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: "❌ Only server staff can claim tickets!", ephemeral: true });
      }

      if (interaction.channel.topic?.includes("Status: Claimed")) {
        return interaction.reply({ content: "⚠️ This ticket has already been claimed!", ephemeral: true });
      }

      const originalTopic = interaction.channel.topic || "";
      await interaction.channel.setTopic(`${originalTopic.replace("Status: Unclaimed", "")} | Status: Claimed by ${interaction.user.tag}`);

      const claimButton = new ButtonBuilder()
        .setCustomId("claimed_btn")
        .setLabel(`Claimed by ${interaction.user.username}`)
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

      const closeButton = new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close Ticket")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Danger);

      const updatedRow = new ActionRowBuilder().addComponents(claimButton, closeButton);
      await interaction.update({ components: [updatedRow] }).catch(() => {});

      return interaction.channel.send({
        content: `📌 **Ticket Claimed!** ${interaction.user} is now handling this ticket.`
      });
    }

    /* --- CLOSE TICKET WITH ADVANCED HTML TRANSCRIPT --- */
    if (interaction.customId === "close_ticket") {
      await interaction.reply({
        content: "📑 Generating transcript and closing ticket in **5 seconds**...",
        ephemeral: true
      });

      const fetchedMessages = await interaction.channel.messages.fetch({ limit: 100 });
      const sortedMessages = Array.from(fetchedMessages.values()).reverse();

      const ticketCreatedAt = interaction.channel.createdAt || new Date();
      const ticketClosedAt = new Date();
      const ticketId = interaction.channel.name.match(/\d+/)?.[0] || interaction.channel.id.slice(-4);

      const openerMatch = interaction.channel.topic?.match(/Ticket Opener: (\d+)/);
      const openerId = openerMatch ? openerMatch[1] : interaction.user.id;
      const openerUser = await client.users.fetch(openerId).catch(() => interaction.user);

      function escapeHtml(text) {
        if (!text) return "";
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      let messagesHtml = "";
      sortedMessages.forEach((m) => {
        const timeFormatted = new Date(m.createdTimestamp).toLocaleString("en-GB", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }).replace(",", "");

        const avatarUrl = m.author.displayAvatarURL({ extension: "png", size: 128, forceStatic: false });
        let contentHtml = escapeHtml(m.content)
          .replace(/\n/g, "<br>")
          .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@User</span>');

        const isBot = m.author.bot;
        const appBadge = isBot ? '<span class="app-badge">APP</span>' : '';

        let embedsHtml = "";
        if (m.embeds.length > 0) {
          m.embeds.forEach((emb) => {
            const embedColor = emb.hexColor || "#5865f2";
            embedsHtml += `
              <div class="chat-embed" style="border-left-color: ${embedColor};">
                ${emb.title ? `<div class="embed-title">${escapeHtml(emb.title)}</div>` : ""}
                ${emb.description ? `<div class="embed-desc">${escapeHtml(emb.description).replace(/\n/g, "<br>")}</div>` : ""}
              </div>
            `;
          });
        }

        let attachmentsHtml = "";
        if (m.attachments.size > 0) {
          m.attachments.forEach((att) => {
            const isImage = att.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(att.name);
            if (isImage) {
              attachmentsHtml += `
                <div class="attachment-img">
                  <a href="${att.url}" target="_blank">
                    <img src="${att.url}" alt="${escapeHtml(att.name)}" />
                  </a>
                </div>
              `;
            } else {
              attachmentsHtml += `
                <div class="attachment-file">
                  <a href="${att.url}" target="_blank">📁 ${escapeHtml(att.name)}</a>
                </div>
              `;
            }
          });
        }

        messagesHtml += `
          <div class="chat-message">
            <img class="msg-avatar" src="${avatarUrl}" alt="${escapeHtml(m.author.username)}" />
            <div class="msg-body">
              <div class="msg-header">
                <span class="msg-author">${escapeHtml(m.author.username)}</span>
                ${appBadge}
                <span class="msg-timestamp">${timeFormatted}</span>
              </div>
              ${contentHtml ? `<div class="msg-text">${contentHtml}</div>` : ""}
              ${embedsHtml}
              ${attachmentsHtml}
            </div>
          </div>
        `;
      });

      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>#${escapeHtml(interaction.channel.name)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #313338;
      color: #dbdee1;
      font-family: 'gg sans', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 15px;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .top-bar {
      height: 48px;
      background: #2b2d31;
      border-bottom: 1px solid #1f2023;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .top-title {
      font-weight: 600;
      color: #f2f3f5;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .top-title span.tag { color: #80848e; }
    .content-area {
      max-width: 1000px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 16px;
      flex: 1;
    }
    .welcome-card {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #3f4147;
    }
    .welcome-card h1 {
      font-size: 28px;
      color: #f2f3f5;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .welcome-card p {
      color: #949ba4;
      font-size: 14px;
    }
    .chat-message {
      display: flex;
      gap: 16px;
      padding: 6px 8px;
      margin-bottom: 6px;
      border-radius: 4px;
      transition: background 0.1s;
    }
    .chat-message:hover {
      background-color: #2e3035;
    }
    .msg-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #1e1f22;
    }
    .msg-body {
      flex: 1;
      overflow: hidden;
    }
    .msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .msg-author {
      font-weight: 600;
      color: #f2f3f5;
      font-size: 15px;
    }
    .app-badge {
      background: #5865f2;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      text-transform: uppercase;
    }
    .msg-timestamp {
      font-size: 12px;
      color: #949ba4;
    }
    .msg-text {
      color: #dbdee1;
      line-height: 1.4;
      word-break: break-word;
    }
    .mention {
      background: rgba(88, 101, 242, 0.2);
      color: #c9cdfb;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 500;
    }
    .chat-embed {
      margin-top: 8px;
      background: #2b2d31;
      border-radius: 4px;
      border-left: 4px solid #5865f2;
      padding: 12px 16px;
      max-width: 520px;
    }
    .embed-title {
      font-weight: 700;
      color: #f2f3f5;
      margin-bottom: 6px;
    }
    .embed-desc {
      color: #dbdee1;
      font-size: 13px;
      line-height: 1.4;
    }
    .attachment-img img {
      max-width: 100%;
      max-height: 350px;
      border-radius: 8px;
      margin-top: 8px;
      display: block;
    }
    .attachment-file a {
      display: inline-block;
      margin-top: 6px;
      padding: 8px 12px;
      background: #2b2d31;
      color: #00a8fc;
      border-radius: 4px;
      text-decoration: none;
      font-size: 13px;
    }
    .transcript-footer {
      background: #232428;
      text-align: center;
      padding: 16px;
      color: #949ba4;
      font-size: 13px;
      border-top: 1px solid #1e1f22;
    }
    @media (max-width: 768px) {
      .content-area { padding: 16px 8px; }
      .welcome-card h1 { font-size: 22px; }
      .chat-message { gap: 10px; }
      .msg-avatar { width: 34px; height: 34px; }
      .chat-embed { max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="top-title"><span class="tag">#</span> ${escapeHtml(interaction.channel.name)}</div>
    <div style="font-size: 13px; color: #949ba4;">Ticket Archive</div>
  </div>

  <div class="content-area">
    <div class="welcome-card">
      <h1>Welcome to #${escapeHtml(interaction.channel.name)}!</h1>
      <p>This is the start of the #${escapeHtml(interaction.channel.name)} channel transcript.</p>
    </div>

    ${messagesHtml}
  </div>

  <div class="transcript-footer">
    This transcript was generated on ${new Date().toUTCString()}
  </div>
</body>
</html>`;

      const transcriptBuffer = Buffer.from(htmlContent, "utf-8");
      const transcriptFile = new AttachmentBuilder(transcriptBuffer, {
        name: `transcript-${interaction.channel.name}.html`
      });

      const logChannel = client.channels.cache.get(TICKET_LOG_CHANNEL_ID);
      let transcriptUrl = null;

      if (logChannel) {
        const uploadedMsg = await logChannel.send({ files: [transcriptFile] }).catch(console.error);
        transcriptUrl = uploadedMsg?.attachments?.first()?.url || null;

        const logEmbed = new EmbedBuilder()
          .setColor(0x2B2D31)
          .setTitle(`Ticket #${ticketId} Closed`)
          .addFields(
            { name: "🆔 ID", value: `\`${ticketId}\``, inline: true },
            { name: "🌐 Guild", value: interaction.guild.name, inline: true },
            { name: "👤 Creator", value: `${openerUser}`, inline: true },
            { name: "🔒 Closed By", value: `${interaction.user}`, inline: true },
            { name: "🕒 Created At", value: `<t:${Math.floor(ticketCreatedAt.getTime() / 1000)}:f>`, inline: true },
            { name: "🕒 Closed At", value: `<t:${Math.floor(ticketClosedAt.getTime() / 1000)}:f>`, inline: true },
            { name: "# Channel ID", value: `\`${interaction.channel.id}\``, inline: false },
            {
              name: "📜 Transcript",
              value: transcriptUrl ? `[Click to view transcript](${transcriptUrl})` : "*Archived as file*",
              inline: false
            }
          )
          .setFooter({ text: "Ticket System" })
          .setTimestamp();

        const row = new ActionRowBuilder();
        if (transcriptUrl) {
          row.addComponents(
            new ButtonBuilder()
              .setLabel("Transcript")
              .setStyle(ButtonStyle.Link)
              .setEmoji("📜")
              .setURL(transcriptUrl)
          );
        }

        await uploadedMsg.edit({ embeds: [logEmbed], components: row.components.length ? [row] : [] }).catch(() => {});
      }

      if (openerUser) {
        const dmEmbed = new EmbedBuilder()
          .setColor(0x2B2D31)
          .setTitle(`Ticket #${ticketId} Closed`)
          .setDescription(`Your ticket **#${interaction.channel.name}** in **${interaction.guild.name}** has been closed.`)
          .addFields(
            { name: "🔒 Closed By", value: `${interaction.user}`, inline: true },
            { name: "🕒 Closed At", value: `<t:${Math.floor(ticketClosedAt.getTime() / 1000)}:f>`, inline: true },
            {
              name: "📜 Transcript",
              value: transcriptUrl ? `[Click to view transcript](${transcriptUrl})` : "*Attached below*",
              inline: false
            }
          )
          .setFooter({ text: "Ticket System" })
          .setTimestamp();

        const dmRow = new ActionRowBuilder();
        if (transcriptUrl) {
          dmRow.addComponents(
            new ButtonBuilder()
              .setLabel("Transcript")
              .setStyle(ButtonStyle.Link)
              .setEmoji("📜")
              .setURL(transcriptUrl)
          );
        }

        const dmAttachment = new AttachmentBuilder(transcriptBuffer, {
          name: `transcript-${interaction.channel.name}.html`
        });

        await openerUser.send({
          embeds: [dmEmbed],
          components: dmRow.components.length ? [dmRow] : [],
          files: [dmAttachment]
        }).catch(() => {});
      }

      setTimeout(() => {
        interaction.channel.delete().catch(() => {});
      }, 5000);
      return;
    }

    /* --- GIVEAWAY ENTER BUTTON --- */
    if (interaction.customId === "giveaway_enter") {
      const gw = activeGiveaways.find((g) => g.messageId === interaction.message.id);
      if (!gw || gw.ended) {
        return interaction.reply({ content: "❌ This giveaway has ended.", ephemeral: true });
      }

      const userId = interaction.user.id;
      if (gw.entries.includes(userId)) {
        gw.entries = gw.entries.filter((id) => id !== userId);
        await interaction.reply({ content: "❌ You left the giveaway.", ephemeral: true });
      } else {
        gw.entries.push(userId);
        await interaction.reply({ content: "✅ You entered the giveaway! Good luck!", ephemeral: true });
      }

      saveGiveaways();

      const updatedButton = new ButtonBuilder()
        .setCustomId("giveaway_enter")
        .setLabel(`Enter (${gw.entries.length})`)
        .setEmoji("🎉")
        .setStyle(ButtonStyle.Success);

      const updatedRow = new ActionRowBuilder().addComponents(updatedButton);
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setFooter({ text: `Entries: ${gw.entries.length} | Ends at` });

      return interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] }).catch(() => {});
    }
  }
});

/* =========================================================
   15. INVITE TRACKING: MEMBER JOIN
========================================================= */
client.on("guildMemberAdd", async (member) => {
  const guildInvites = await member.guild.invites.fetch().catch(() => {});
  if (!guildInvites) return;

  const cached = inviteCache.get(member.guild.id);
  let usedInvite = null;

  guildInvites.forEach((inv) => {
    const oldUses = cached?.get(inv.code) || 0;
    if (inv.uses > oldUses) {
      usedInvite = inv;
    }
  });

  const newCache = new Map();
  guildInvites.forEach((inv) => {
    newCache.set(inv.code, inv.uses);
  });
  inviteCache.set(member.guild.id, newCache);

  if (!usedInvite || !usedInvite.inviter) return;

  const inviterId = usedInvite.inviter.id;

  if (!invites[inviterId]) {
    invites[inviterId] = createInviteData();
  }

  const data = invites[inviterId];
  const accountAge = Date.now() - member.user.createdTimestamp;
  const isFake = accountAge < 7 * 24 * 60 * 60 * 1000;

  data.total = (data.total || 0) + 1;

  if (isFake) {
    data.fake = (data.fake || 0) + 1;
  } else {
    data.current = (data.current || 0) + 1;
  }

  if (!Array.isArray(data.history)) {
    data.history = [];
  }

  data.history.push({
    user: member.id,
    inviter: inviterId,
    time: Date.now(),
    type: isFake ? "fake" : "real"
  });

  const logChannel = client.channels.cache.get(INVITE_LOG_CHANNEL_ID);
