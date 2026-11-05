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
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  AuditLogEvent,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const fs = require("fs");
const ms = require("ms");

/* =========================
   IMAGES
========================= */
const BANNER =
  "https://cdn.discordapp.com/attachments/1508843787064185103/1509148139024547891/1000016350-ezremove.gif?ex=6a181f3a&is=6a16cdba&hm=e14c4ae7628e82a918334f96f5f5db5401a2f474801519145a2194f0bd0ae53e&";

const THUMBNAIL =
  "https://cdn.discordapp.com/attachments/1508843787064185103/1509148049375498260/1000016387-ezremove.gif?ex=6a181f25&is=6a16cda5&hm=f50b3cd0602727d2db53802bfb335d2e24757b2f79f355ea07f7668b801ed60f&";

/* =========================
   CHANNEL IDS
========================= */
const WELCOME_CHANNEL_ID = "1504121883841270032";
const GOODBYE_CHANNEL_ID = "1504122077966368919";
const BOOST_CHANNEL_ID = "1509893252168421556";
const LEVEL_CHANNEL_ID = "1506091937726333081";
const INVITE_LOG_CHANNEL_ID = "1513142091860017152";
const TICKET_LOG_CHANNEL_ID = "1549056747132551330";
const JOIN_TO_CREATE_CHANNEL_ID = "1549457451844378705";
const activeTempVoiceChannels = new Set();
const tempVoiceOwners = new Map();

/* =========================
   AUTOMOD & AUDIT LOG CONFIG
========================= */
// Channel where all security & audit embeds will be sent
const AUDIT_LOG_CHANNEL_ID = "1560522955358871592"; 

// If you want to restrict automod to ONE specific channel, put its ID here.
// Set to null to protect all channels across the server.
const MONITORED_CHANNEL_ID = null; 

// Invite link detection pattern
const DISCORD_INVITE_REGEX = /(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/[a-zA-Z0-9_-]+/i;

/* =========================
   TIERED AUTOMOD LOADER
========================= */
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

// Helper function to issue automatic warnings
function issueAutoWarning(userId, reason) {
  if (!warnings[userId]) warnings[userId] = [];
  warnings[userId].push({
    reason: `[AutoMod] ${reason}`,
    date: Date.now()
  });
  saveWarnings();
}

// Matches single words (with symbols like @, *) and multi-word combinations safely
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

/* =========================
   ANTI-NUKE CONFIGURATION
========================= */
const ANTI_NUKE_LOG_CHANNEL_ID = "1551051405639426168"; // Set to your staff log or emergency alert channel
const nukeTracker = new Map();

// Limits allowed within a 10-second rolling window
const NUKE_LIMITS = {
  CHANNEL_DELETE: 2, // Max channel deletions before auto-ban
  ROLE_DELETE: 2,    // Max role deletions before auto-ban
  MEMBER_BAN: 3,     // Max bans issued before auto-ban
  WINDOW_MS: 10000   // 10-second interval
};

function recordNukeAction(userId, actionType) {
  const now = Date.now();
  if (!nukeTracker.has(userId)) {
    nukeTracker.set(userId, { channelDeletes: [], roleDeletes: [], memberBans: [] });
  }

  const userData = nukeTracker.get(userId);
  const timestamps = userData[actionType];

  // Purge actions older than the 10-second window
  const validTimestamps = timestamps.filter(t => now - t < NUKE_LIMITS.WINDOW_MS);
  validTimestamps.push(now);
  userData[actionType] = validTimestamps;

  return validTimestamps.length;
}

async function triggerNukeDefense(guild, executor, actionName, count) {
  // Never punish the server owner or the bot itself
  if (!executor || executor.id === OWNER_ID || executor.id === client.user.id) return;

  try {
    // 1. Immediately ban the rogue moderator
    await guild.members.ban(executor.id, {
      reason: `[ETERNAL ANTI-NUKE] Exceeded ${actionName} threshold (${count} actions within 10s)`
    });

    console.warn(`[ANTI-NUKE ACTIVATED] Banned ${executor.tag} (${executor.id}) for mass ${actionName}.`);

    // 2. Dispatch Emergency Alert Embed to the Staff Log Channel
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
      .setFooter({ text: "Eternal SMP Core Shield" })
      .setTimestamp();

    const logChannel = guild.channels.cache.get(ANTI_NUKE_LOG_CHANNEL_ID);
    if (logChannel) {
      await logChannel.send({ content: `<@${OWNER_ID}> ⚠️ **URGENT SECURITY ALERT**`, embeds: [alertEmbed] }).catch(() => {});
    }

    // 3. Direct Message the Server Owner
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

/* =========================
   MODERATION SYSTEM
========================= */
const OWNER_ID = "1354755206528630894";

const STAFF_USER_IDS = [
  "1504160922376081480",
  "1548718895173730407",
  "1529537332112261344",
  "1272908975813165114",
  "1500677494934737050",
  "1306625186354692228",
  "1427534146019921981"
];

function isStaff(member) {
  if (!member) return false;
  return (
    member.id === OWNER_ID ||
    STAFF_USER_IDS.includes(member.id) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

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

/* =========================
   INVITES SYSTEM
========================= */
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

/* ===================================================
   MESSAGES STATS & AFK SYSTEM STORAGE
=================================================== */
let messageStats = loadJSON("./messages.json", {});
let afkData = loadJSON("./afk.json", {});

function saveMessageStats() {
  fs.writeFileSync("./messages.json", JSON.stringify(messageStats, null, 2));
}

function saveAfkData() {
  fs.writeFileSync("./afk.json", JSON.stringify(afkData, null, 2));
}

// Automatically tracks and resets daily, weekly, and monthly message counters
function trackUserMessage(userId) {
  const now = new Date();
  if (!messageStats[userId]) {
    messageStats[userId] = {
      allTime: 0,
      today: 0,
      weekly: 0,
      monthly: 0,
      lastDaily: now.toDateString(),
      lastWeekly: getWeekNumber(now),
      lastMonthly: now.getMonth()
    };
  }

  const u = messageStats[userId];

  // Daily reset check
  if (u.lastDaily !== now.toDateString()) {
    u.today = 0;
    u.lastDaily = now.toDateString();
  }

  // Weekly reset check
  if (u.lastWeekly !== getWeekNumber(now)) {
    u.weekly = 0;
    u.lastWeekly = getWeekNumber(now);
  }

  // Monthly reset check
  if (u.lastMonthly !== now.getMonth()) {
    u.monthly = 0;
    u.lastMonthly = now.getMonth();
  }

  u.allTime = (u.allTime || 0) + 1;
  u.today = (u.today || 0) + 1;
  u.weekly = (u.weekly || 0) + 1;
  u.monthly = (u.monthly || 0) + 1;

  saveMessageStats();
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

// Calculate countdown to next daily/weekly/monthly resets
function getResetTimers() {
  const now = new Date();

  // Next daily: midnight
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const hoursLeftDaily = Math.max(0, Math.round((tomorrow - now) / 3600000));

  // Next weekly: Sunday midnight
  const endOfWeek = new Date(now);
  const day = now.getDay();
  const diff = (7 - day) % 7 || 7;
  endOfWeek.setDate(now.getDate() + diff);
  endOfWeek.setHours(0, 0, 0, 0);
  const daysLeftWeekly = Math.max(0, Math.ceil((endOfWeek - now) / 86400000));

  // Next monthly: 1st of next month
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysLeftMonthly = Math.max(0, Math.ceil((nextMonth - now) / 86400000));

  return { daily: `${hoursLeftDaily}h`, weekly: `${daysLeftWeekly}d`, monthly: `${daysLeftMonthly}d` };
}

/* =========================
   DISCORD CLIENT
========================= */
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

/* =========================
   SLASH COMMAND DEFINITIONS
========================= */
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
    .setName("pay")
    .setDescription("View Eternal SMP payment methods"),

  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("View Eternal SMP server rules"),

  new SlashCommandBuilder()
    .setName("grules")
    .setDescription("View Minecraft in-game rules"),

  new SlashCommandBuilder()
    .setName("punishments")
    .setDescription("View server punishment guidelines"),

  new SlashCommandBuilder()
    .setName("tac")
    .setDescription("View Eternal SMP store terms and conditions"),
    
  new SlashCommandBuilder()
    .setName("messages")
    .setDescription("View detailed message activity statistics")
    .addUserOption(o => o.setName("user").setDescription("Target user (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Set an AFK status with automated mention tracking")
    .addStringOption(o => o.setName("reason").setDescription("Reason for going AFK").setRequired(false)),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("View server ranks and perks"),

  new SlashCommandBuilder()
    .setName("spawner")
    .setDescription("View spawner shop and pricing"),

  new SlashCommandBuilder()
    .setName("howgay")
    .setDescription("Calculate gay percentage meter")
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
    .setName("ip")
    .setDescription("View Eternal SMP connection details, ports, and links"),  

 new SlashCommandBuilder()
    .setName("help")
    .setDescription("View all available commands, categories, and syntax instructions")
    .addStringOption(o =>
      o.setName("category")
        .setDescription("Filter commands by category")
        .setRequired(false)
        .addChoices(
          { name: "🌐 General & Server Info", value: "info" },
          { name: "🛒 Store & Economy", value: "store" },
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

/* =========================
   READY EVENT
========================= */
client.once("ready", async () => {
  console.log(`${client.user.tag} is online!`);

  // Register Slash Commands Instantly to Your Server
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("Registering application (/) commands to the server...");
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, "1504100985197301802"),
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

  /* =========================
     BACKGROUND GIVEAWAY CHECKER
  ========================= */
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
  }, 10000); // Scans every 10 seconds

});

/* =========================
   PASSIVE XP & TIERED AUTOMOD
========================= */
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const bypass = isStaff(member);

  /* --- 1. TRACK MESSAGE STATS --- */
  trackUserMessage(message.author.id);

  /* --- 2. AFK SYSTEM: CLEAR AFK UPON TALKING --- */
  if (afkData[message.author.id]?.isAfk) {
    const data = afkData[message.author.id];
    delete afkData[message.author.id];
    saveAfkData();

    const welcomeMsg = await message.reply(`👋 Welcome back ${message.author}, I have removed your AFK status.`).catch(() => {});
    setTimeout(() => welcomeMsg?.delete().catch(() => {}), 6000);

    // If user was pinged while AFK, send Mention History to their DM (Image 8 style)
    if (data.mentions && data.mentions.length > 0) {
      const mentionList = data.mentions.slice(0, 10).map((m, i) => {
        return `**${i + 1}.** **${m.author}** mentioned you:\n> ${m.content}\n[Jump to Message](${m.url})`;
      }).join("\n\n");

      const mentionEmbed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle(`Mention History for ${message.author.username}`)
        .setDescription(mentionList)
        .setFooter({ text: `Total Mentions: ${data.mentions.length} | Today` })
        .setTimestamp();

      await message.author.send({ embeds: [mentionEmbed] }).catch(() => {});
    }
  }

  /* --- 3. AFK SYSTEM: DETECT PINGS TO AFK USERS --- */
  if (message.mentions.users.size > 0) {
    message.mentions.users.forEach(async (target) => {
      if (target.id !== message.author.id && afkData[target.id]?.isAfk) {
        const afkEntry = afkData[target.id];

        // Notify chat
        message.reply(`💤 **${target.displayName || target.username}** is currently AFK: ${afkEntry.reason}`).catch(() => {});

        // Log mention for later DM summary
        if (!afkEntry.mentions) afkEntry.mentions = [];
        afkEntry.mentions.push({
          author: message.author.tag,
          content: message.cleanContent.slice(0, 300),
          url: message.url,
          timestamp: Date.now()
        });
        saveAfkData();
      }
    });
  }

  /* --- 4. AUTOMOD FILTERS (TIER 1, 2, 3 & INVITES) --- */
  if (!bypass) {
    if (DISCORD_INVITE_REGEX.test(message.content)) {
      await message.delete().catch(() => {});
      issueAutoWarning(message.author.id, "Unauthorized server invite or promotion link");
      return;
    }

    const banTerm = findMatchedTerm(message.content, badWordsDB.ban);
    if (banTerm) {
      await message.delete().catch(() => {});
      await message.guild.members.ban(message.author.id, { reason: `[AutoMod Tier 3] Prohibited: "${banTerm}"` }).catch(() => {});
      return;
    }

    const muteTerm = findMatchedTerm(message.content, badWordsDB.mute);
    if (muteTerm) {
      await message.delete().catch(() => {});
      await member?.timeout(2 * 3600000, `[AutoMod Tier 2] Prohibited: "${muteTerm}"`).catch(() => {});
      return;
    }

    const warnTerm = findMatchedTerm(message.content, badWordsDB.warn);
    if (warnTerm) {
      await message.delete().catch(() => {});
      issueAutoWarning(message.author.id, `Mild profanity: "${warnTerm}"`);
      return;
    }
  }

  /* --- 5. PASSIVE CHAT XP & AESTHETIC LEVEL-UP CARD (IMAGE 4) --- */
  const userId = message.author.id;
  if (!levels[userId]) {
    levels[userId] = { xp: 0, level: 1 };
  }

  levels[userId].xp += 10;
  const neededXP = levels[userId].level * 100;

  if (levels[userId].xp >= neededXP) {
    levels[userId].xp -= neededXP;
    levels[userId].level++;
    saveLevels();

    const levelChannel = client.channels.cache.get(LEVEL_CHANNEL_ID) || message.channel;
    if (levelChannel) {
      // Formatted directly after Image 4 aesthetic
      const levelUpEmbed = new EmbedBuilder()
        .setColor(0x00A8FC)
        .setTitle("🎉 LEVEL UP!")
        .setDescription(
          "🌸 **A NEW DECREE** 🌸\n\n" +
          "**CONGRATULATIONS** 🧑‍🌾\n" +
          `**${message.member?.displayName || message.author.username}!** YOU REACHED **LEVEL ${levels[userId].level}** 💧\n\n` +
          "🕊️ **KEEP STRIVING 〜**\n" +
          "**GREATNESS AWAITS**\n" +
          "**AT THE NEXT STEP OF 〜**\n" +
          "**YOUR PATH 〜 <3.** 🕊️"
        )
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }));

      await levelChannel.send({
        content: `${message.author}`,
        embeds: [levelUpEmbed]
      }).catch(() => {});
    }
  } else {
    saveLevels();
  }
});


/* =========================
   SLASH COMMANDS & INTERACTIONS
========================= */
client.on("interactionCreate", async (interaction) => {

  /* =========================
     CHAT INPUT COMMANDS
  ========================= */
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
        `<a:verify_a:1508071382704193616> ${target.tag} has been given **${amount} levels**! Now level **${levels[userId].level}**`
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
          `<a:verify_a:1508071382704193616> ${targetUser.tag} permanently banned.\nReason: ${reason}`
        );
      }

      const durationMs = ms(duration);
      if (!durationMs) return interaction.reply({ content: "❌ Use: 1h, 1d, 7d, 30d, etc.", ephemeral: true });

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
        `<a:verify_a:1508071382704193616> ${targetUser.tag} banned for ${duration}`
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
            `<a:verify_a:1508071382704193616> ${targetUser.tag}'s temporary ban expired.`
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
        return interaction.reply(`<a:verify_a:1508071382704193616> User ${userId} has been unbanned.`);
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
        return interaction.reply(`<a:verify_a:1508071382704193616> ${target.tag} has no warnings.`);
      }

      const list = warns
        .map((w, i) => {
          const date = new Date(w.date).toLocaleDateString();
          return `**${i + 1}.** ${w.reason}\n📅 ${date}`;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:disclaimer_a:1507787788526026852> Warning History")
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
        `<a:disclaimer_a:1507787788526026852> ${target.tag} warned.\nReason: ${reason}`
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
        `<a:verify_a:1508071382704193616> Removed warning #${num} from ${target.tag}`
      );
    }

    /* --- CLEARWARN --- */
    if (commandName === "clearwarn") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      warnings[target.id] = [];
      saveWarnings();

      return interaction.reply(
        `<a:verify_a:1508071382704193616> Cleared all warnings for ${target.tag}`
      );
    }

    /* --- MUTEHISTORY --- */
    if (commandName === "mutehistory") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const data = mutes[target.id];

      if (!data || !data.history.length) {
        return interaction.reply(`<a:verify_a:1508071382704193616> ${target.tag} has no mute history.`);
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
        `<a:verify_a:1508071382704193616> ${targetUser.tag} has been muted.\nReason: ${reason}`
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
      return interaction.reply(`<a:verify_a:1508071382704193616> ${targetUser.tag} has been unmuted.`);
    }

    /* --- BANHISTORY --- */
    if (commandName === "banhistory") {
      if (!isStaff(member)) return noPerm();

      const target = interaction.options.getUser("user");
      const data = bans[target.id];

      if (!data || !data.history.length) {
        return interaction.reply(`<a:verify_a:1508071382704193616> ${target.tag} has no ban history.`);
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
            .setTitle("🌐 Eternal SMP • Server & General Commands")
            .setDescription(
              "• **`/ip`**\n" +
              "  └ Display Java & Bedrock server connection details, ports, and website links.\n\n" +
              "• **`/rules`**\n" +
              "  └ View the official Discord server rules and conduct policy.\n\n" +
              "• **`/grules`**\n" +
              "  └ Read Minecraft in-game gameplay restrictions and allowed modifications.\n\n" +
              "• **`/punishments`**\n" +
              "  └ View punishment ladders and enforcement guidelines.\n\n" +
              "• **`/tac`**\n" +
              "  └ Read Eternal SMP store terms, conditions, and delivery policies.\n\n" +
              "• **`/help [category]`**\n" +
              "  └ Open this interactive command directory."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: General & Information" })
            .setTimestamp();
        }

        if (cat === "store") {
          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("🛒 Eternal SMP • Store & Purchase Commands")
            .setDescription(
              "• **`/rank`**\n" +
              "  └ Browse donor ranks (Knight, Hydra, Emperor, Phoenix, Booster) and kits.\n\n" +
              "• **`/spawner`**\n" +
              "  └ View prices and catalog for basic, combat, advanced, and special spawners.\n\n" +
              "• **`/pay`**\n" +
              "  └ Display manual payment numbers for bKash, Nagad, and Litecoin (LTC).\n\n" +
              "• **`/panel`**\n" +
              "  └ Deploy the interactive support ticket dropdown panel for members."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: Store & Purchases" })
            .setTimestamp();
        }

        if (cat === "stats") {
          return new EmbedBuilder()
            .setColor(0x8600FF)
            .setTitle("📊 Eternal SMP • Levels, Invites & Ranking")
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
            .setTitle("🎮 Eternal SMP • Mini-Games & Arcade")
            .setDescription(
              "• **`/snake`**\n" +
              "  └ Play the retro button-controlled Snake arcade game in Discord.\n\n" +
              "• **`/tictactoe [mode] [opponent]`**\n" +
              "  └ Play Tic Tac Toe against an unbeatable AI or challenge a friend.\n\n" +
              "• **`/wordle`**\n" +
              "  └ Guess the secret 5-letter word within 6 tries.\n\n" +
              "• **`/guess`**\n" +
              "  └ Guess the hidden number between 1 and 10,000.\n\n" +
              "• **`/howgay [user]`**\n" +
              "  └ Fun meter calculating random rainbow affinity score."
            )
            .setImage(BANNER)
            .setFooter({ text: "Category: Mini-Games & Fun" })
            .setTimestamp();
        }

        if (cat === "mod") {
          return new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🛡️ Eternal SMP • Staff & Moderation Commands")
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

        // Default Overview Embed
        return new EmbedBuilder()
          .setColor(0x8600FF)
          .setAuthor({ name: "Eternal SMP • Bot Directory", iconURL: THUMBNAIL })
          .setTitle("📖 Eternal SMP Command Directory")
          .setDescription(
            "Welcome to the official **Eternal SMP** command manual.\n" +
            "Select a module from the dropdown menu below or click the quick-category buttons to inspect commands, parameters, and usage.\n\n" +
            "**Directory Modules:**\n" +
            "• **🌐 General & Server** — IP, rules, guidelines, and terms\n" +
            "• **🛒 Store & Shop** — Ranks, spawner shop, tickets, and payment\n" +
            "• **📊 Levels & Invites** — Level progress, invite tracking, and leaderboards\n" +
            "• **🎮 Mini-Games** — Snake, TicTacToe, Wordle, and Guess games\n" +
            "• **🛡️ Staff Operations** — Full moderation suite and giveaway system"
          )
          .setImage(BANNER)
          .setFooter({ text: "Use the dropdown or buttons below to browse" })
          .setTimestamp();
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId("help_menu")
        .setPlaceholder("Select a command module to inspect")
        .addOptions([
          { label: "Overview", description: "Main directory page", emoji: "📖", value: "overview" },
          { label: "General & Server Info", description: "IP, server rules, and official links", emoji: "🌐", value: "info" },
          { label: "Store & Economy", description: "Ranks, spawners, payments, and tickets", emoji: "🛒", value: "store" },
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
          `<a:verify_a:1508071382704193616> **Total Invites:** ${data.total}\n` +
          `<:tik:1518250029695893525> **Current Invites:** ${data.current}\n` +
          `<a:disclaimer_a:1507787788526026852> **Left Invites:** ${data.left}\n` +
          `<:incorrect:1518250261502754989> **Fake Invites:** ${data.fake}\n\n` +
          `📜 **Total Joins Tracked:** ${totalHistory}`
        )
        .addFields(
          {
            name: "<a:magic_book:1507790392945410299> Breakdown",
            value:
              `<:tik:1518250029695893525> Real Invites: ${data.current}\n` +
              `<a:disclaimer_a:1507787788526026852> Fake Invites: ${data.fake}\n` +
              `<:incorrect:1518250261502754989> Left Users: ${data.left}`
          },
          {
            name: "<:umm_really:1517961187998961806> Efficiency",
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
          `<a:verify_a:1508071382704193616> **Total Invites:** ${data.total}\n` +
          `<:tik:1518250029695893525> **Current Invites:** ${data.current}\n` +
          `<:incorrect:1518250261502754989> **Left Invites:** ${data.left}\n` +
          `<a:disclaimer_a:1507787788526026852> **Fake Invites:** ${data.fake}`
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
        .setTitle("🎉 ETERNAL SMP • GIVEAWAY 🎉")
        .setDescription(
          `<:money:1507752623971893470> **Prize:** ${prize}\n` +
          `<a:twinkle_twinkle:1507788149030392000> **Hosted by:** ${interaction.user}\n` +
          `<a:twinkle_twinkle:1507788149030392000> **Winners:** **${winnerCount}**\n` +
          `<a:magic_book:1507790392945410299> **Ends:** <t:${endTimestamp}:R> (<t:${endTimestamp}:f>)\n\n` +
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

      // Saves giveaway data permanently to disk
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
        return interaction.reply({ content: "❌ Could not find an active or saved giveaway with that message ID!", ephemeral: true });
      }

      if (!gw.ended) {
        return interaction.reply({ content: "❌ That giveaway is still active and hasn't ended yet!", ephemeral: true });
      }

      if (!gw.entries || gw.entries.length === 0) {
        return interaction.reply({ content: "❌ Cannot reroll: There were no valid entries in that giveaway.", ephemeral: true });
      }

      // Select a random entrant from the saved entries pool
      const newWinner = gw.entries[Math.floor(Math.random() * gw.entries.length)];

      return interaction.reply({
        content: `🎉 **New Winner Rerolled!** Congratulations <@${newWinner}>! You won **${gw.prize}**!`
      });
    }

/* --- SERVER IP & CONNECTION DETAILS --- */
    if (commandName === "ip") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setAuthor({
          name: "Eternal SMP • Server Connection",
          iconURL: interaction.guild.iconURL() || THUMBNAIL
        })
        .setTitle("<a:fire_a0:1507790340067950794> Join the Realm of Eternal SMP")
        .setDescription(
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "### 💻 Java Edition (PC)\n" +
          "**Server IP:**\n" +
          "```play.eternal-smp.pro```\n" +
          "**Port:**\n" +
          "```12003```\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "### 📱 Bedrock Edition (PE / Console / Win10)\n" +
          "**Server IP:**\n" +
          "```play.eternal-smp.pro:12003```\n" +
          "**Port:**\n" +
          "```12003```\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "### 🌐 Official Links\n" +
          "• **Website:** [ETERNAL SMP WEBSITE](https://www.eternal-smp.pro/)\n" +
          "• **Store:** [ETERNAL SMP STORE](https://www.eternal-smp.pro/shop.html)\n" +
          "• **Leaderboard:** [ETERNAL SMP LEADERBOARD](https://www.eternal-smp.pro/leaderboard.html)\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        )
        .setImage(BANNER)
        .setFooter({ text: "Compatible with Minecraft 1.20 - 26.2" })
        .setTimestamp();

      // Clickable external web link buttons
      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Official Website")
          .setStyle(ButtonStyle.Link)
          .setEmoji("🌐")
          .setURL("https://www.eternal-smp.pro/"),
        new ButtonBuilder()
          .setLabel("Webstore")
          .setStyle(ButtonStyle.Link)
          .setEmoji("🛒")
          .setURL("https://www.eternal-smp.pro/shop.html"),
        new ButtonBuilder()
          .setLabel("Gallery")
          .setStyle(ButtonStyle.Link)
          .setEmoji("🏞️")
          .setURL("https://www.eternal-smp.pro/gallery.html")
      );

      return interaction.reply({ embeds: [embed], components: [linkRow] });
    }      
      
    /* --- PAY --- */
    if (commandName === "pay") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("💰 Eternal SMP Payment Methods")
        .setDescription(
          "**<a:arrow:1507782135212150845> Bkash 1 (Personal → Personal):** 01741644334\n\n" +
          "**<a:arrow:1507782135212150845> Bkash 2 (Agent / Personal → Personal):** 01768166414\n\n" +
          "<:shoppie:1507809836421873725> Send screenshot in support ticket after payment!"
        )
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP Store" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- RULES --- */
    if (commandName === "rules") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:magic_book:1507790392945410299> Eternal SMP — Official Server Rules")
        .setDescription(`
# <a:magic_book:1507790392945410299> Eternal SMP — Official Server Rules

━━━━━━━━━━━━━━

## <a:chats:1507788455558512691> **1. Chat Rules**
<a:red_arrow:1507787736554410126> Keep the chat clean, friendly, and respectful. Toxicity, harassment, hate speech, discrimination, excessive swearing, spam, or inappropriate behavior is strictly prohibited.

━━━━━━━━━━━━━━

## <a:sweaty_gamer:1507788395714445515> **2. Fair Gameplay**
<a:red_arrow:1507787736554410126> Using cheats, hacks, x-ray, auto-clickers, exploits, dupes, modified clients, or any unfair advantages is not allowed. Play fairly and respect the survival experience.

━━━━━━━━━━━━━━

## <a:disclaimer_a:1507787788526026852> **3. Banned Farms & Lag Machines**
<a:red_arrow:1507787736554410126> Do not build farms, redstone machines, chunk loaders, or structures that may cause excessive lag or harm server performance. Staff may remove lag-causing builds without warning.

━━━━━━━━━━━━━━

## <a:announcement_a:1507790462210281482> **4. Proper Channel Usage**
<a:red_arrow:1507787736554410126> Use channels correctly and avoid unnecessary spam, advertising, or disruptive behavior. Keep conversations meaningful and respectful.

━━━━━━━━━━━━━━

## <a:disclaimer_a:1507787788526026852> **5. No Begging**
<a:red_arrow:1507787736554410126> Do not beg for ranks, items, money, permissions, staff roles, or special treatment from staff or players.

━━━━━━━━━━━━━━

## <a:disclaimer_a:1507787788526026852> **6. Follow Discord Guidelines**
<a:red_arrow:1507787736554410126> All members must follow the official Discord Community Guidelines and Terms of Service at all times.

━━━━━━━━━━━━━━

## <a:announcement_a:1507790462210281482> **7. Voice Chat Rules**
<a:red_arrow:1507787736554410126> Keep VC conversations friendly and appropriate. Mic spam, earrape, excessive background noise, harassment, or disturbing others is not allowed.

━━━━━━━━━━━━━━

## <a:moneyyyy:1507792459974054118> **8. No Real Money Trading**
<a:red_arrow:1507787736554410126> Trading in-game items, accounts, or services for real money outside the official server store is strictly prohibited.

━━━━━━━━━━━━━━

## <a:store_a:1507788568322375690> **9. Store & Rank Purchase Policy**
<a:red_arrow:1507787736554410126> All purchases made through the official server store are final.
<a:red_arrow:1507787736554410126> Purchased ranks, kits, or items will be delivered after successful payment verification.
<a:red_arrow:1507787736554410126> Sharing or abusing paid perks may result in punishment or removal of perks.
<a:red_arrow:1507787736554410126> Chargebacks or fraudulent payments will result in a permanent blacklist from the server and store.

━━━━━━━━━━━━━━

## <a:disclaimer_a:1507787788526026852> **10. Refund Policy**
<a:red_arrow:1507787736554410126> No refunds will be given after ranks, items, or perks are delivered.
<a:red_arrow:1507787736554410126> Accidental purchases are the buyer’s responsibility.
<a:red_arrow:1507787736554410126> Breaking server rules after purchasing does NOT make you eligible for a refund.
<a:red_arrow:1507787736554410126> If you experience delivery issues, contact staff with valid proof.

━━━━━━━━━━━━━━

## <a:disclaimer_a:1507787788526026852> **11. Punishment System**
<a:red_arrow:1507787736554410126> Warning
<a:red_arrow:1507787736554410126> Mute
<a:red_arrow:1507787736554410126> Kick
<a:red_arrow:1507787736554410126> Temporary Ban
<a:red_arrow:1507787736554410126> Permanent Ban

<a:red_arrow:1507787736554410126> Severe violations such as hacking, duping, scamming, or chargebacks may result in immediate permanent punishment without warning.

━━━━━━━━━━━━━━

## <a:announcement_a:1507790462210281482> **12. Use Common Sense**
<a:red_arrow:1507787736554410126> Not every situation can be covered by rules. Use common sense and respect staff decisions to help maintain a positive and fair community.

━━━━━━━━━━━━━━

# **<a:twinkle_twinkle:1507788149030392000> Welcome to Eternal SMP <a:twinkle_twinkle:1507788149030392000>**
`)
        .setThumbnail(THUMBNAIL)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP Rules" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- GRULES --- */
    if (commandName === "grules") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:disclaimer_a:1507787788526026852> Eternal SMP • In-Game Rules")
        .setDescription(` 
# **<a:disclaimer_a:1507787788526026852> Minecraft Server Rules**
━━━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> No More Than 3 Accounts Per Player
<a:red_arrow:1507787736554410126> No Hacked Clients
<a:red_arrow:1507787736554410126> No Movement Mods
<a:red_arrow:1507787736554410126> No Inventory Mods
<a:red_arrow:1507787736554410126> No Health Indicators
<a:red_arrow:1507787736554410126> No Radar
<a:red_arrow:1507787736554410126> No Freecam
<a:red_arrow:1507787736554410126> No ESP
<a:red_arrow:1507787736554410126> No Auto Place / Easy Place
<a:red_arrow:1507787736554410126> No Macros or Scripts
<a:red_arrow:1507787736554410126> No Auto Clickers
<a:red_arrow:1507787736554410126> No Mouse Tweaks / Scrollers
<a:red_arrow:1507787736554410126> No Crafting Modifications
<a:red_arrow:1507787736554410126> No Bug Abuse
<a:red_arrow:1507787736554410126> No Attempted Duplication
<a:red_arrow:1507787736554410126> No Item Duplication
<a:red_arrow:1507787736554410126> No IRL Trading
<a:red_arrow:1507787736554410126> No External Gambling
<a:red_arrow:1507787736554410126> No Cross-Server Trading
<a:red_arrow:1507787736554410126> No Staff Impersonation
<a:red_arrow:1507787736554410126> No Finding or Using the Server Seed
<a:red_arrow:1507787736554410126> No Voice Chat Spam
<a:red_arrow:1507787736554410126> Report All Bugs, Glitches & Cheaters
<a:red_arrow:1507787736554410126> No Auto Totem

━━━━━━━━━━━━━━━━━━━━━━━━
# **<a:magic_book:1507790392945410299> Chat Rules**
━━━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> No Spamming
<a:red_arrow:1507787736554410126> No Encouraging Others to Spam
<a:red_arrow:1507787736554410126> No Harassment
<a:red_arrow:1507787736554410126> No Discrimination or Hate Speech
<a:red_arrow:1507787736554410126> No Death Threats
<a:red_arrow:1507787736554410126> No Sharing Personal Information
<a:red_arrow:1507787736554410126> No Pretending to Be Staff
<a:red_arrow:1507787736554410126> No Ban Evasion
<a:red_arrow:1507787736554410126> Use Common Sense
`)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP In-Game Rules" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- PUNISHMENTS --- */
    if (commandName === "punishments") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("⚖️ Eternal SMP • Punishment System")
        .setDescription(`
━━━━━━━━━━━━━━━━━━━━━━━━
# **<a:announcement_a:1507790462210281482> Punishment System**
━━━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Most violations will result in a Warning first.

<a:red_arrow:1507787736554410126> Repeated violations may result in Mutes, Jail, Position Freeze, Inventory Clears, Temporary Bans, or Permanent Bans.

━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Chat Spam
Warning → Mute → Temporary Ban

<a:red_arrow:1507787736554410126> Harassment, Toxicity & Hate Speech
Warning → Mute → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Staff Impersonation
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Ban Evasion
Permanent Ban

<a:red_arrow:1507787736554410126> IRL Trading
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> External Gambling
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Cross-Server Trading
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Using More Than 3 Accounts
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Bug Abuse
Warning → Inventory Clear → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Attempted Duplication
Warning → Inventory Clear → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Item Duplication
Inventory Clear → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Auto Totem, Macros, Scripts & Auto Clickers
Warning → Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Hacked Clients, ESP, Freecam, Radar & Similar Cheats
Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Server Seed Finding or Usage
Temporary Ban → Permanent Ban

<a:red_arrow:1507787736554410126> Severe Exploits Affecting the Economy
Inventory Clear → Temporary Ban → Permanent Ban

━━━━━━━━━━━━━━━━━━━━━━━━
# **<a:disclaimer_a:1507787788526026852> Final Notice**
━━━━━━━━━━━━━━━━━━━━━━━━

<a:arrow:1507782135212150845> Staff may issue harsher punishments immediately for severe offenses.

<a:arrow:1507782135212150845> Punishments are based on evidence, severity, and previous violations.

<a:arrow:1507782135212150845> Use common sense and respect staff decisions. Staff decision will be considered as the final desicion.

━━━━━━━━━━━━━━
`)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP In-Game Rules" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- TAC --- */
    if (commandName === "tac") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setDescription(`
━━━━━━━━━━━━━━━━━━━━━━
**<:shoppie:1507809836421873725> Eternal SMP • Store Terms**
━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Purchasing any Rank, Package, Crate, or Digital Item from the Eternal SMP Store means you agree to all terms and conditions listed below.

━━━━━━━━━━━━━━━━━━━━━━
**<a:announcement_a:1507790462210281482> Legal Disclaimer**
━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Eternal SMP is an independent Minecraft community and is not affiliated with, endorsed by, or associated with Mojang Studios, Microsoft, or Minecraft.

<a:red_arrow:1507787736554410126> All purchases are voluntary contributions made to support the server, community, and future development.

━━━━━━━━━━━━━━━━━━━━━━
**<a:moneyyyy:1507792459974054118> Payments & Purchases**
━━━━━━━━━━━━━━━━━━━━━━

<a:arrow:1507782135212150845> Digital Products
All ranks, packages, perks, crates, and items are digital content delivered in-game. No physical products will be shipped.

<a:arrow:1507782135212150845> Server Support
Payments help fund server hosting, protection, maintenance, development, updates, performance improvements, and community events.

<a:arrow:1507782135212150845> No Refund Policy
All purchases are final and non-refundable once payment has been successfully completed and rewards are delivered.

<a:arrow:1507782135212150845> Fraud & Chargebacks
Any chargeback, payment dispute, or fraudulent transaction may result in permanent suspension from Eternal SMP, including loss of all purchased items and store access.

━━━━━━━━━━━━━━━━━━━━━━
**<a:crown_a:1507791684208033842> Ranks & Perks**
━━━━━━━━━━━━━━━━━━━━━━

<a:arrow:1507782135212150845> Rank Duration
Ranks may be permanent, seasonal, or subscription-based depending on the product description in the store.

<a:arrow:1507782135212150845> Perk Balancing
To maintain fair gameplay and server balance, rank perks, commands, or bonuses may be adjusted, modified, or removed at any time without prior notice.

<a:arrow:1507782135212150845> Rule Violations
Breaking server or Discord rules may result in warnings, suspensions, permanent bans, or removal of purchased perks without refund.

━━━━━━━━━━━━━━━━━━━━━━
**<a:online:1507791786943447173> Server Availability**
━━━━━━━━━━━━━━━━━━━━━━

<a:arrow:1507782135212150845> Maintenance & Downtime
The server may occasionally experience downtime due to maintenance, updates, technical issues, or unexpected outages. Downtime does not qualify for refunds or compensation.

<a:arrow:1507782135212150845> Server Changes
Eternal SMP reserves the right to modify gameplay systems, economy features, ranks, plugins, worlds, or server mechanics at any time to improve the community experience.

━━━━━━━━━━━━━━━━━━━━━━
**<a:disclaimer_a:1507787788526026852> Account Responsibility**
━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Players are fully responsible for the security and ownership of their Minecraft and Discord accounts.

<a:red_arrow:1507787736554410126> Eternal SMP is not responsible for lost, stolen, hacked, or shared accounts.

━━━━━━━━━━━━━━━━━━━━━━
**<a:disclaimer_a:1507787788526026852> Item Loss Policy**
━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> Some items, kits, or rewards may be limited or non-renewable.

<a:red_arrow:1507787736554410126> Lost items caused by death, PvP, clearing inventories, glitches, or player mistakes will generally not be restored unless approved by staff under exceptional circumstances.

━━━━━━━━━━━━━━━━━━━━━━
**<:damn:1507752860643885076> Agreement**
━━━━━━━━━━━━━━━━━━━━━━

<a:red_arrow:1507787736554410126> By completing a purchase from the Eternal SMP Store, you confirm that you have read, understood, and accepted all Store Terms and Server Rules.

━━━━━━━━━━━━━━━━━━━━━━
**<a:fire_a0:1507790340067950794> Thank You for Supporting Eternal SMP
Your support helps keep the server alive, balanced, and growing for the entire community. <a:fire_a0:1507790340067950794>**
━━━━━━━━━━━━━━━━━━━━━━
`)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP Store Terms" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    /* --- RANK --- */
    if (commandName === "rank") {
      const embed1 = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:fire_a0:1507790340067950794> ETERNAL SMP • Rank List")
        .setDescription(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**<:shield_0:1507754792334790757> KNIGHT <:shield_0:1507754792334790757>** 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<a:moneyyyy:1507792459974054118> In-game Money: 250K  
<a:red_arrow:1507787736554410126> 4 SetHomes  
<a:red_arrow:1507787736554410126> KNIGHT ARMOR (Daimond Vanilla Max Enchants) 
<a:red_arrow:1507787736554410126> KNIGHT TOOLS (Daimond Vanilla Max Enchants)
<a:red_arrow:1507787736554410126> 3 Shulker Boxes
<a:red_arrow:1507787736554410126> 64 Golden Apple + 9 GOD Apple  
<a:red_arrow:1507787736554410126> Common Trims Collection
<a:red_arrow:1507787736554410126> 2 Common Spawners / 4 Common Keys
<a:red_arrow:1507787736554410126> 10k Claim Blocks
⚡ Commands  
/ptime /near /hat  

**<a:moneyyyy:1507792459974054118> PRICE – 120৳**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**<a:twinkle_twinkle:1507788149030392000> HYDRA <a:twinkle_twinkle:1507788149030392000>**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<a:moneyyyy:1507792459974054118> In-game Money: 500K Money  
<a:red_arrow:1507787736554410126> 5 SetHomes  
<a:red_arrow:1507787736554410126> HYDRA ARMOR (Netherite Vanilla Max Enchants) 
<a:red_arrow:1507787736554410126> HYDRA TOOLS (Netherite Vanilla Max Enchants)  
<a:red_arrow:1507787736554410126> 5 Shulker Boxes 
<a:red_arrow:1507787736554410126> 96 Golden Apple + 10 GOD Apple  
<a:red_arrow:1507787736554410126> Uncommon Trims Collection
<a:red_arrow:1507787736554410126> 2 Uncommon Spawners / 6 Common Keys 
<a:red_arrow:1507787736554410126> 15k Claim Blocks

⚡ KNIGHT Commands + 
/workbench /echest /back /nick 

**<a:moneyyyy:1507792459974054118> PRICE – 220৳**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**<a:fire_a0:1507790340067950794> EMPEROR <a:fire_a0:1507790340067950794>**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<a:moneyyyy:1507792459974054118> In-game Money: 750K Money  
<a:red_arrow:1507787736554410126> 6 SetHomes  
<a:red_arrow:1507787736554410126> EMPEROR GEAR (Vanilla Max Enchants)
<a:red_arrow:1507787736554410126> EMPEROR MACE (Wind Burst & Density)
<a:red_arrow:1507787736554410126> 6 Shulker  
<a:red_arrow:1507787736554410126> 128 Golden Apple + 16 GOD Apple
<a:red_arrow:1507787736554410126> Rare Trims Collection
<a:red_arrow:1507787736554410126> 2 Rare Spawners / 2 OP Keys
<a:red_arrow:1507787736554410126> 20k Claim Blocks

⚡ HYDRA Commands +  
/disposal /smithingtable /loom /repair hand

**<a:moneyyyy:1507792459974054118> PRICE – 320৳**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**<a:symbol_eternity:1507813262756937871> PHOENIX <a:symbol_eternity:1507813262756937871>** 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<a:moneyyyy:1507792459974054118> In-game Money: 1.5M Money  
<a:red_arrow:1507787736554410126> 8 SetHomes  
<a:red_arrow:1507787736554410126> Elytra ×1   
<a:red_arrow:1507787736554410126> Full Max-Custom Gear
<a:red_arrow:1507787736554410126> ETERNAL SWORD (Custom Enchants)
<a:red_arrow:1507787736554410126> ETERNAL PICKAXE (Custom Enchants)
<a:red_arrow:1507787736554410126> ETERNAL MACE (Custom Enchants)
<a:red_arrow:1507787736554410126> ETERNAL SPEAR (Custom Enchants)
<a:red_arrow:1507787736554410126> 8 Shulker  
<a:red_arrow:1507787736554410126> 192 Golden Apple + 20 GOD Apple  
<a:red_arrow:1507787736554410126> Legendary Trims Collection
<a:red_arrow:1507787736554410126> 2 Advance Spawners / 2 ETERNAL Keys
<a:red_arrow:1507787736554410126> 30k Claim Blocks

⚡ EMPEROR Commands +  
/heal /night /anvil

**<a:moneyyyy:1507792459974054118> PRICE – 420৳**
      `);

      const embed2 = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:booster:1507826062489424093> BOOSTER SPECIAL RANK <a:booster:1507826062489424093>")
        .setDescription(`
<a:moneyyyy:1507792459974054118> In-game Money: 500K Money  
<a:red_arrow:1507787736554410126> 4 SetHomes   
<a:red_arrow:1507787736554410126> Custom BOOSTER ARMOR (Diamond Vanilla Max Enchant)
<a:red_arrow:1507787736554410126> BOOSTER TOOLS (Netherite VAnilla Max Enchant)
<a:red_arrow:1507787736554410126> 4 Shulker  
<a:red_arrow:1507787736554410126> 70 Golden Apple + 7 GOD Apple  
<a:red_arrow:1507787736554410126> 2 Uncommon Spawner / 4 Common Keys
<a:red_arrow:1507787736554410126> 15k Claim Blocks

⚡ KNIGHT Commands +  
/echest /back

**<a:moneyyyy:1507792459974054118> PRICE – 2 Server Boost**
      `)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP Rank System" })
        .setTimestamp();

      return interaction.reply({ embeds: [embed1, embed2] });
    }

    /* --- SPAWNER --- */
    if (commandName === "spawner") {
      const embed = new EmbedBuilder()
        .setColor(0x8600FF)
        .setTitle("<a:magic_book:1507790392945410299> ETERNAL SMP • Spawner Shop")
        .setDescription(`
━━━━━━━━━━━━━━━━━━━━━━

**<a:chikku_a:1507790277853843676> BASIC SPAWNERS – 20৳ (Per Piece)**

<a:arrow:1507782135212150845> Pig
<a:arrow:1507782135212150845> Cow
<a:arrow:1507782135212150845> Chicken
<a:arrow:1507782135212150845> Sheep

━━━━━━━━━━━━━━━━━━━━━━

**<a:fire_a0:1507790340067950794> COMBAT SPAWNERS – 30৳ (Per Piece)**

<a:arrow:1507782135212150845> Zombie
<a:arrow:1507782135212150845> Spider
<a:arrow:1507782135212150845> Skeleton
<a:arrow:1507782135212150845> Guardian

━━━━━━━━━━━━━━━━━━━━━━

**<a:enderman_dance:1507790630984749299> ADVANCED SPAWNERS – 40৳ (Per Piece)**

<a:arrow:1507782135212150845> Enderman
<a:arrow:1507782135212150845> Slime
<a:arrow:1507782135212150845> Magma Cube
<a:arrow:1507782135212150845> Creeper
<a:arrow:1507782135212150845> Blaze
<a:arrow:1507782135212150845> Zombified Piglin (Gold Farming)

━━━━━━━━━━━━━━━━━━━━━━

**<a:twinkle_twinkle:1507788149030392000> SPECIAL SPAWNERS – 50৳ (Per Piece)**

<a:arrow:1507782135212150845> Iron Golem (Iron Farming)
<a:arrow:1507782135212150845> Ghast (Ghast Tears & Gunpowder)
<a:arrow:1507782135212150845> Breeze (Breeze Rod)
<a:arrow:1507782135212150845> Wither Skeleton (Wither Skulls & Coal)
<a:arrow:1507782135212150845> Shulker

━━━━━━━━━━━━━━━━━━━━━━

**<a:disclaimer_a:1507787788526026852> Balance Notice**

<a:red_arrow:1507787736554410126> High-tier spawners are limited and may be adjusted for server balance.

━━━━━━━━━━━━━━━━━━━━━━

**<a:note_a:1507787693990609007> Note:**

<a:red_arrow:1507787736554410126> Spawner list & prices may change anytime for balance
<a:red_arrow:1507787736554410126> Some spawners may be limited

━━━━━━━━━━━━━━━━━━━━━━

**<a:store_a:1507788568322375690> How to Buy:**

<a:red_arrow:1507787736554410126> Open a ticket in the support channel
<a:red_arrow:1507787736554410126> Tell staff which spawner you want
`)
        .setImage(BANNER)
        .setFooter({ text: "Eternal SMP Spawner Shop" })
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
        .setTitle("🏳️‍🌈 Gay-O-Meter")
        .setDescription(
          `**Target:** ${user}\n\n` +
          `**Gay Level:** ${gayPercent}%\n` +
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
        .setTitle("🎟️ Eternal SMP Ticket System")
        .setDescription(
          "Select a ticket type from the dropdown menu below.\n\n" +
          "<a:moneyyyy:1507792459974054118> Purchase Support\n" +
          "❓ General Support\n" +
          "<a:disclaimer_a:1507787788526026852> Player Reports\n" +
          "<a:disclaimer_a:1507787788526026852> Ban Appeals"
        )
        .setImage(BANNER)
        .setThumbnail(THUMBNAIL)
        .setFooter({ text: "Eternal SMP Support Center" });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_menu")
        .setPlaceholder("Select a ticket type")
        .addOptions([
          {
            label: "Purchase Support",
            description: "Buy ranks, crates, spawners",
            emoji: "<a:moneyyyy:1507792459974054118>",
            value: "purchase"
          },
          {
            label: "General Support",
            description: "Need help from staff",
            emoji: "❓",
            value: "support"
          },
          {
            label: "Player Report",
            description: "Report a player",
            emoji: "<a:disclaimer_a:1507787788526026852>",
            value: "report"
          },
          {
            label: "Ban Appeal",
            description: "Appeal your punishment",
            emoji: "<a:disclaimer_a:1507787788526026852>",
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
        player2 = { id: "bot", username: "Eternal Bot", tag: "Eternal Bot" };
      } else {
        player2 = interaction.options.getUser("opponent");
        if (!player2 || player2.bot || player2.id === player1.id) {
          return interaction.reply({ content: "<:incorrect:1518250261502754989> Please mention a valid player to challenge!", ephemeral: true });
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
          return i.reply({ content: "<:incorrect:1518250261502754989> It is not your turn!", ephemeral: true });
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
          await gameMessage.edit({ content: `<a:twinkle_twinkle:1507788149030392000> **Game Over!** ${player1} (X) won the match!`, components: disabledRows }).catch(() => {});
        } else if (reason === "⭕") {
          await gameMessage.edit({ content: `<a:twinkle_twinkle:1507788149030392000> **Game Over!** ${isBotGame ? player2.username : player2} (O) won the match!`, components: disabledRows }).catch(() => {});
        } else if (reason === "tie") {
          await gameMessage.edit({ content: `<:yummm:1509900502924529684> **Game Over!** It's a tie match!`, components: disabledRows }).catch(() => {});
        } else {
          await gameMessage.edit({ content: `<a:disclaimer_a:1507787788526026852> **Game Over!** Game timed out because a player took longer than 15 minutes to move.`, components: disabledRows }).catch(() => {});
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
        .setTitle("<a:magic_book:1507790392945410299> Wordle Game Initialized!")
        .setDescription(`I've picked a secret **5-letter word**. You have **6 tries** to guess it right!\n\n⏳ You have **15 minutes** to submit each guess. Type your 5-letter words below!`)
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
          return m.reply("<a:disclaimer_a:1507787788526026852> Your guess must be exactly **5 letters** long!").then(msg => setTimeout(() => msg.delete().catch(() => {}), 3000));
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
          .setTitle("<a:magic_book:1507790392945410299> Wordle Tracker")
          .setDescription(gameBoard.join("\n") + "\n\n⏳ *Timer reset! 15 minutes left for your next guess.*")
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
          interaction.channel.send(`<a:twinkle_twinkle:1507788149030392000> Congratulations ${interaction.user}! You guessed the correct word **${targetWord.toUpperCase()}** in ${attempts} tries!`);
        } else if (reason === "lose") {
          interaction.channel.send(`<:incorrect:1518250261502754989> Game Over ${interaction.user}! You've run out of tries. The secret word was **${targetWord.toUpperCase()}**.`);
        } else {
          interaction.channel.send(`<a:disclaimer_a:1507787788526026852> ${interaction.user}, your Wordle session timed out because you took longer than 15 minutes to guess.`);
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
        .setTitle("<a:arrow:1507782135212150845> Guess the Number!")
        .setDescription("I have chosen a secret number between **1 and 10000**.\n\nType your guesses directly into this channel. You have **15 minutes** to submit each guess!")
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
          await m.reply(`<a:red_arrow:1507787736554410126> **${guess}** is **too high**! Try a lower number. *(Attempt: ${attempts})*`).catch(() => {});
        } else {
          await m.reply(`<a:red_arrow:1507787736554410126> **${guess}** is **too low**! Try a higher number. *(Attempt: ${attempts})*`).catch(() => {});
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "win") {
          interaction.channel.send(`<a:twinkle_twinkle:1507788149030392000> **Congratulations ${interaction.user}!** You guessed the correct number **${targetNumber}** in **${attempts}** attempts!`);
        } else {
          interaction.channel.send(`<a:disclaimer_a:1507787788526026852> ${interaction.user}, your Guess the Number session timed out because you took longer than 15 minutes. The secret number was **${targetNumber}**.`);
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
        .setFooter({ text: "Click the buttons below to control your snake!" })
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
          .setTitle(reason === "win" ? "<a:crown_a:1507791684208033842> Flawless Victory!" : "<:blue_shit:1508551560945209415> Game Over!")
          .addFields({ name: "<a:magic_book:1507790392945410299> Final Score", value: `**${score}** points`, inline: true })
          .setTimestamp();

        if (reason === "dead") {
          finalEmbed.setDescription(`You crashed into a wall or bit your own tail!\n\n**Final Grid:**\n${drawBoard()}`);
        } else if (reason === "stopped") {
          finalEmbed.setDescription(`The game was manually ended by the user.\n\n**Final Grid:**\n${drawBoard()}`);
        } else if (reason === "win") {
          finalEmbed.setDescription("Incredible! You have completely filled up the snake arena grid!");
        } else {
          finalEmbed.setDescription("The match timed out due to 15 minutes of inactivity.");
        }

        await gameMessage.edit({
          embeds: [finalEmbed],
          components: [disabledRow]
        }).catch(() => {});
      });
      return;
    }

/* --- MESSAGES STATS (MATCHES IMAGE 1) --- */
    if (commandName === "messages") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      const stats = messageStats[targetUser.id] || { allTime: 0, monthly: 0, weekly: 0, today: 0 };
      const resets = getResetTimers();

      const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle(`${targetMember?.displayName || targetUser.username}'s Messages`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
        .setDescription(
          "❯ **Message Statistics**\n\n" +
          `**All Time** • \`${(stats.allTime || 0).toLocaleString()}\` messages\n` +
          `**This Month** • \`${(stats.monthly || 0).toLocaleString()}\` messages\n` +
          `**This Week** • \`${(stats.weekly || 0).toLocaleString()}\` messages\n` +
          `**Today** • \`${(stats.today || 0).toLocaleString()}\` messages\n\n` +
          "✦ **Next Reset**\n" +
          `Daily: \`${resets.daily}\` • Weekly: \`${resets.weekly}\` • Monthly: \`${resets.monthly}\`\n\n` +
          `*Your message statistics • <t:${Math.floor(Date.now() / 1000)}:R>*`
        );

      return interaction.reply({ embeds: [embed] });
    }
      
 /* --- AFK STATUS (MATCHES IMAGE 7) --- */
    if (commandName === "afk") {
      const reason = interaction.options.getString("reason") || "I am afk :)";

      afkData[interaction.user.id] = {
        isAfk: true,
        reason,
        since: Date.now(),
        mentions: []
      };
      saveAfkData();

      return interaction.reply({
        content: `You are now AFK for: **${reason}**`
      });
    }     
      
 /* --- REAL-TIME LEADERBOARD (MATCHES IMAGES 2 & 3) --- */
    if (commandName === "leaderboard") {
      function generateLeaderboardEmbed(mode) {
        const medals = ["#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10"];
        let listText = "";
        let userStandingText = "";

        if (mode === "daily") {
          const sorted = Object.entries(messageStats)
            .filter(([, d]) => (d.today || 0) > 0)
            .sort(([, a], [, b]) => (b.today || 0) - (a.today || 0));

          const top10 = sorted.slice(0, 10);
          listText = top10.length > 0
            ? top10.map(([id, d], i) => `${medals[i]} <@${id}> • **${(d.today || 0).toLocaleString()} Messages**`).join("\n\n")
            : "*No chat messages recorded today.*";

          const rankIdx = sorted.findIndex(([id]) => id === interaction.user.id);
          const userCount = messageStats[interaction.user.id]?.today || 0;
          const userRank = rankIdx !== -1 ? rankIdx + 1 : sorted.length + 1;
          userStandingText = `⭐ **Your Standing: #${userRank} of ${Math.max(sorted.length, 1)}** ${interaction.user} • **${userCount.toLocaleString()} Messages**`;

        } else {
          // Default: XP & Levels
          const sorted = Object.entries(levels)
            .sort(([, a], [, b]) => (b.level - a.level) || (b.xp - a.xp));

          const top10 = sorted.slice(0, 10);
          listText = top10.length > 0
            ? top10.map(([id, d], i) => `${medals[i]} <@${id}> • **Level ${d.level}** • **${(d.xp || 0).toLocaleString()} XP**`).join("\n\n")
            : "*No leveling data registered yet.*";

          const rankIdx = sorted.findIndex(([id]) => id === interaction.user.id);
          const userLvl = levels[interaction.user.id]?.level || 1;
          const userXp = levels[interaction.user.id]?.xp || 0;
          const userRank = rankIdx !== -1 ? rankIdx + 1 : sorted.length + 1;
          userStandingText = `⭐ **Your Standing: #${userRank} of ${Math.max(sorted.length, 1)}** ${interaction.user} • **Level ${userLvl} • ${userXp.toLocaleString()} XP**`;
        }

        return new EmbedBuilder()
          .setColor(0x00A8FC)
          .setTitle(mode === "daily" ? "💬 Daily Chat Leaderboard" : "XP & Level Leaderboard")
          .setDescription(
            "*The rankings are being updated in real-time!*\n\n" +
            listText + "\n\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            userStandingText
          )
          .setFooter({ text: "Page 1/1 | Eternal Real-Time Leaderboard" })
          .setTimestamp();
      }

      function getButtons(active) {
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("lb_levels")
              .setLabel("Top XP & Levels")
              .setEmoji("🏆")
              .setStyle(active === "levels" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId("lb_daily")
              .setLabel("Daily Chat (Today)")
              .setEmoji("💬")
              .setStyle(active === "daily" ? ButtonStyle.Primary : ButtonStyle.Secondary)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("lb_invites")
              .setLabel("Top Invites")
              .setEmoji("📨")
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId("lb_refresh")
              .setLabel("Refresh")
              .setEmoji("🔄")
              .setStyle(ButtonStyle.Secondary)
          )
        ];
      }

      let currentMode = "levels";
      const replyMsg = await interaction.reply({
        embeds: [generateLeaderboardEmbed(currentMode)],
        components: getButtons(currentMode),
        fetchReply: true
      });

      const collector = replyMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time: 5 * 60 * 1000
      });

      collector.on("collect", async (i) => {
        if (i.customId === "lb_levels") currentMode = "levels";
        if (i.customId === "lb_daily") currentMode = "daily";
        // lb_refresh just re-renders with currentMode

        await i.update({
          embeds: [generateLeaderboardEmbed(currentMode)],
          components: getButtons(currentMode)
        }).catch(() => {});
      });

      collector.on("end", async () => {
        const disabledRows = getButtons(currentMode).map(row => {
          row.components.forEach(btn => btn.setDisabled(true));
          return row;
        });
        await replyMsg.edit({ components: disabledRows }).catch(() => {});
      });

      return;
    }
      
/* =========================
      SELECT MENU TICKETS
  ========================= */
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket_menu") {
      const type = interaction.values[0];

      // Base overwrites: Hide from @everyone, allow ticket opener and the bot
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

      // Safely add staff roles/members ONLY if they exist in the server cache
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
        .setTitle("🎫 Eternal SMP Support Ticket")
        .setDescription(
          `Hello ${interaction.user}!\n\n` +
          `**Category:** \`${type.toUpperCase()}\`\n` +
          `**Status:** 🟡 Unclaimed\n\n` +
          `Please describe your issue or inquiry in detail.\nA staff member will assist you shortly.`
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
        content: `${interaction.user} Welcome! Staff will be with you soon.`,
        embeds: [embed],
        components: [row]
      });

      return interaction.reply({
        content: `<a:verify_a:1508071382704193616> Ticket created: ${channel}`,
        ephemeral: true
      });
    }
  }

  /* =========================
      BUTTON INTERACTIONS
  ========================= */
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
    <div style="font-size: 13px; color: #949ba4;">Eternal SMP Archive</div>
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
          .setFooter({ text: "Powered by Eternal SMP" })
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
          .setFooter({ text: "Powered by Eternal SMP" })
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
        await interaction.reply({ content: "<:incorrect:1518250261502754989> You left the giveaway.", ephemeral: true });
      } else {
        gw.entries.push(userId);
        await interaction.reply({ content: "<:tik:1518250029695893525> You entered the giveaway! Good luck!", ephemeral: true });
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

    /* --- PAYMENT BUTTONS --- */
    if (interaction.customId === "pay_bkash") {
      const embed = new EmbedBuilder()
        .setColor(0xE2136E)
        .setTitle("📱 bKash Payment Details")
        .setDescription(
          "**Number (Personal):**\n```01741644334```\n" +
          "**Number (Agent / Personal):**\n```01768166414```\n\n" +
          "Send payment to the number above, then submit your **TrxID** or screenshot in a ticket to confirm."
        )
        .setFooter({ text: "Powered by Eternal SMP" });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === "pay_nagad") {
      const embed = new EmbedBuilder()
        .setColor(0xF7941D)
        .setTitle("📱 Nagad Payment Details")
        .setDescription(
          "**Number (Personal):**\n```01741644334```\n\n" +
          "Send payment to the number above, then submit your **TrxID** or screenshot in a ticket to confirm."
        )
        .setFooter({ text: "Powered by Eternal SMP" });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === "pay_ltc") {
      const embed = new EmbedBuilder()
        .setColor(0x345D9D)
        .setTitle("⚡ Litecoin (LTC) Payment Details")
        .setDescription(
          "**LTC Address:**\n```ltc1qplaceholderaddresshere```\n\n" +
          "Send exact amount, then submit your transaction hash or screenshot in a ticket to confirm."
        )
        .setFooter({ text: "Powered by Eternal SMP" });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

/* =========================
   INVITE TRACKING
========================= */
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
  if (logChannel) {
    const inviterUser = client.users.cache.get(inviterId) || `<@${inviterId}>`;
    logChannel.send(
      `👤 ${inviterUser} invited **${member.user.tag}** (${member}) to the server and now has **${data.current}** invite(s)! ${isFake ? "<a:disclaimer_a:1507787788526026852> *(Suspected Fake Account)*" : ""}`
    ).catch(console.error);
  }

  saveInvites();
});

/* =========================
   INVITE TRACKING REMOVE
========================= */
client.on("guildMemberRemove", async (member) => {
  const memberId = member.id || member.user?.id;
  if (!memberId) return;

  for (const inviterId in invites) {
    if (!invites[inviterId]) continue;

    const data = invites[inviterId];
    if (!Array.isArray(data.history)) continue;

    const index = data.history.findIndex(
      h => String(h.user) === String(memberId)
    );

    if (index !== -1) {
      const record = data.history[index];

      if (record.type === "real") {
        data.current = Math.max(0, (data.current || 0) - 1);
        data.left = (data.left || 0) + 1;
      }

      if (record.type === "fake") {
        data.fake = Math.max(0, (data.fake || 0) - 1);
        data.left = (data.left || 0) + 1;
      }

      const logChannel = client.channels.cache.get(INVITE_LOG_CHANNEL_ID);
      if (logChannel) {
        const username = member.user?.tag || member.displayName || "An unknown user";
        logChannel.send(
          `<:incorrect:1518250261502754989> **${username}** left the server. They were invited by <@${inviterId}>, whose remaining invite count is now **${data.current}**.`
        ).catch(console.error);
      }

      data.history.splice(index, 1);
      break;
    }
  }

  saveInvites();
});

/* =========================
   WELCOME
========================= */
client.on("guildMemberAdd", async (member) => {
  const channel = await client.channels
    .fetch(WELCOME_CHANNEL_ID)
    .catch(() => null);

  if (!channel) return;

  await channel.send(`welcome, ${member}!`);

  const memberCount = member.guild.memberCount;

  const embed = new EmbedBuilder()
    .setColor(0x8600FF)
    .setAuthor({
      name: member.user.username,
      iconURL: member.user.displayAvatarURL()
    })
    .setTitle("🎉 Welcome to Eternal SMP!")
    .setDescription(
      `DONT FORGET TO CHECK OUT!\n\n` +
      `💬 **[Chats](https://discord.com/channels/1504100985197301802/1504100985646350485)**\n` +
      `🎭 **[Roles](https://discord.com/channels/1504100985197301802/1504127493131469000)**\n` +
      `📜 **[Rules](https://discord.com/channels/1504100985197301802/1504100985646350480)**\n` +
      `📢 **[Announcements](https://discord.com/channels/1504100985197301802/1504100985646350481)**\n` +
      `⚖️ **[In Game Rules](https://discord.com/channels/1504100985197301802/1504100986086490157)**\n` +
      `⚖️ **[Punishment System](https://discord.com/channels/1504100985197301802/1508164377860116561)**\n` +
      `📖 **[Terms And Condition](https://discord.com/channels/1504100985197301802/1506543092126191726)**\n` +
      `🎫 **[Ticket](https://discord.com/channels/1504100985197301802/1504121282822934670)**\n\n` +
      `✨ We hope you enjoy your stay!`
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setImage(BANNER)
    .setFooter({
      text: `you are our ${memberCount}th member!`
    })
    .setTimestamp();

  channel.send({ embeds: [embed] }).catch(() => {});
});

/* =========================
   GOODBYE
========================= */
client.on("guildMemberRemove", async (member) => {
  console.log(`${member.user.tag} left the server`);

  const channel = await client.channels
    .fetch(GOODBYE_CHANNEL_ID)
    .catch(console.error);

  if (!channel) return;

  channel.send({
    content: `oh no... bye, ${member.user.username}`
  }).catch(console.error);

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setAuthor({
      name: member.user.username,
      iconURL: member.user.displayAvatarURL({ dynamic: true })
    })
    .setTitle("👋 Goodbye from Eternal SMP, We had a good time with you.")
    .setDescription(
      `${member.user.username} has left Eternal SMP...\n\n` +
      "💔 We're sad to see you go\n" +
      "🎮 Hope you enjoyed your time here\n" +
      "🌍 You're always welcome back!"
    )
    .setThumbnail(
      member.user.displayAvatarURL({ dynamic: true })
    )
    .setImage(BANNER)
    .setFooter({
      text: `we now have ${member.guild.memberCount} members...`
    })
    .setTimestamp();

  channel.send({
    embeds: [embed]
  }).catch(console.error);
});

/* =========================
   SERVER BOOST MESSAGE
========================= */
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (
    !oldMember.premiumSince &&
    newMember.premiumSince
  ) {
    const channel = await client.channels
      .fetch(BOOST_CHANNEL_ID)
      .catch(() => null);

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xFF73FA)
      .setTitle("🚀 New Server Boost!")
      .setDescription(
        `💖 Thank you so much ${newMember} for boosting **Eternal SMP**!\n\n` +
        `Your support helps us improve the server, unlock new perks, and keep the community growing stronger every day.\n\n` +
        `✨ We truly appreciate your support and generosity!\n\n` +
        `🔥 Enjoy your booster perks and thank you for being part of Eternal SMP!`
      )
      .setThumbnail(
        newMember.user.displayAvatarURL({ dynamic: true })
      )
      .setImage(BANNER)
      .setFooter({
        text: "Eternal SMP Booster System"
      })
      .setTimestamp();

    channel.send({
      content: `🎉 ${newMember} just boosted the server!`,
      embeds: [embed]
    });
  }
});

/* =========================
   JOIN TO CREATE / TEMP VOICE
========================= */
client.on("voiceStateUpdate", async (oldState, newState) => {
  const { member, guild } = newState;

  // 1. User joins the "Join to Create" channel
  if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
    try {
      const parentCategory = newState.channel.parent;

      // Creates the voice channel right under the creator channel
      const tempChannel = await guild.channels.create({
        name: `🔊・${member.displayName}'s VC`,
        type: ChannelType.GuildVoice,
        parent: parentCategory || null,
        position: newState.channel.rawPosition + 1,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel]
          },
          {
            id: member.id,
            allow: [
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.ManageChannels,
              PermissionsBitField.Flags.MoveMembers,
              PermissionsBitField.Flags.MuteMembers
            ]
          }
        ]
      });

      // Track channel ID
      activeTempVoiceChannels.add(tempChannel.id);

      // Move member into their newly created temporary channel
      await newState.setChannel(tempChannel);
    } catch (err) {
      console.error("Error creating temporary voice channel:", err);
    }
  }

  // 2. Member leaves a temporary voice channel -> Delete if empty
  if (oldState.channelId && activeTempVoiceChannels.has(oldState.channelId)) {
    const channel = oldState.channel;
    if (channel && channel.members.size === 0) {
      activeTempVoiceChannels.delete(channel.id);
      await channel.delete().catch(() => {});
    }
  }
});

/* =========================
   ANTI-NUKE EVENT LISTENERS
========================= */

// 1. Mass Channel Deletion Detection
client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;

  try {
    const fetchedLogs = await channel.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.ChannelDelete
    });
    const entry = fetchedLogs.entries.first();
    if (!entry || !entry.executor) return;

    // Confirm the deletion happened within the last 5 seconds
    if (Date.now() - entry.createdTimestamp > 5000) return;

    const count = recordNukeAction(entry.executor.id, "channelDeletes");
    if (count >= NUKE_LIMITS.CHANNEL_DELETE) {
      await triggerNukeDefense(channel.guild, entry.executor, "Channel Deletions", count);
    }
  } catch (err) {
    console.error("Error inspecting channelDelete audit log:", err);
  }
});

// 2. Mass Role Deletion Detection
client.on("roleDelete", async (role) => {
  if (!role.guild) return;

  try {
    const fetchedLogs = await role.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleDelete
    });
    const entry = fetchedLogs.entries.first();
    if (!entry || !entry.executor) return;

    if (Date.now() - entry.createdTimestamp > 5000) return;

    const count = recordNukeAction(entry.executor.id, "roleDeletes");
    if (count >= NUKE_LIMITS.ROLE_DELETE) {
      await triggerNukeDefense(role.guild, entry.executor, "Role Deletions", count);
    }
  } catch (err) {
    console.error("Error inspecting roleDelete audit log:", err);
  }
});

// 3. Mass Member Ban Detection
client.on("guildBanAdd", async (ban) => {
  try {
    const fetchedLogs = await ban.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberBanAdd
    });
    const entry = fetchedLogs.entries.first();
    if (!entry || !entry.executor) return;

    if (Date.now() - entry.createdTimestamp > 5000) return;

    const count = recordNukeAction(entry.executor.id, "memberBans");
    if (count >= NUKE_LIMITS.MEMBER_BAN) {
      await triggerNukeDefense(ban.guild, entry.executor, "Mass Member Bans", count);
    }
  } catch (err) {
    console.error("Error inspecting guildBanAdd audit log:", err);
  }
});

/* =========================
   AUDIT LOGS: MESSAGE DELETE
========================= */
client.on("messageDelete", async (message) => {
  if (!message.guild || message.author?.bot) return;

  // Filter for specific channel if configured
  if (MONITORED_CHANNEL_ID && message.channel.id !== MONITORED_CHANNEL_ID) return;

  const logChannel = message.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
  if (!logChannel) return;

  const content = message.content ? message.content.slice(0, 1000) : "*No text content (Embed or Attachment only)*";
  const attachments = message.attachments.size > 0
    ? message.attachments.map((a) => a.url).join("\n")
    : null;

  const deleteEmbed = new EmbedBuilder()
    .setColor(0xED4245)
    .setAuthor({
      name: message.author?.tag || "Unknown User",
      iconURL: message.author?.displayAvatarURL({ dynamic: true })
    })
    .setTitle("🗑️ Message Deleted")
    .setDescription(
      `**Author:** ${message.author || "Unknown"} (\`${message.author?.id || "N/A"}\`)\n` +
      `**Channel:** ${message.channel} (\`${message.channel.id}\`)\n\n` +
      `**Content:**\n\`\`\`\n${content}\n\`\`\`` +
      (attachments ? `\n**Attachments:**\n${attachments}` : "")
    )
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp();

  await logChannel.send({ embeds: [deleteEmbed] }).catch(() => {});
});

/* =========================
   AUDIT LOGS: MESSAGE EDIT
========================= */
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;

  // Filter for specific channel if configured
  if (MONITORED_CHANNEL_ID && newMessage.channel.id !== MONITORED_CHANNEL_ID) return;

  // Ignore system updates (e.g., Discord generating link previews)
  if (oldMessage.content === newMessage.content) return;

  const logChannel = newMessage.guild.channels.cache.get(AUDIT_LOG_CHANNEL_ID);
  if (!logChannel) return;

  const oldText = oldMessage.content ? oldMessage.content.slice(0, 900) : "*Original content uncached*";
  const newText = newMessage.content ? newMessage.content.slice(0, 900) : "*Empty content*";

  const editEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({
      name: newMessage.author.tag,
      iconURL: newMessage.author.displayAvatarURL({ dynamic: true })
    })
    .setTitle("✏️ Message Edited")
    .setDescription(
      `**Author:** ${newMessage.author} (\`${newMessage.author.id}\`)\n` +
      `**Channel:** ${newMessage.channel} (\`${newMessage.channel.id}\`)\n` +
      `**Jump to Message:** [Click Here](${newMessage.url})\n\n` +
      `**Before:**\n\`\`\`\n${oldText}\n\`\`\`\n` +
      `**After:**\n\`\`\`\n${newText}\n\`\`\``
    )
    .setFooter({ text: `Message ID: ${newMessage.id}` })
    .setTimestamp();

  await logChannel.send({ embeds: [editEmbed] }).catch(() => {});
});

/* =========================
   LOGIN
========================= */
client.login(process.env.DISCORD_TOKEN);
