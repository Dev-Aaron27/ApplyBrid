// backend.js
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  UserFlags
} from "discord.js";
import cors from "cors";
dotenv.config();

const app = express();
app.use(express.json());

/** === CONFIG === **/
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const REDIRECT_URI = "https://apply-bridgify.infy.uk/callback.html";

const STAFF_GUILD_ID = "1380214993018163260";
const STAFF_CHANNEL_ID = "1387525782888382516";
const MAIN_GUILD_ID = "1389985754666631198";

const STAFF_APPROVE_ROLE_IDS = [
  "1390712301950075011",
  "1390712312444489820",
  "1390712297101594636"
];

const blockedUsers = new Map();
const applications = new Map();

app.get("/", (req, res) => {
  res.send("Bot is online! " + new Date().toISOString());
});

app.use(
  cors({
    origin: "https://apply-bridgify.infy.uk",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

/** OAuth Token Exchange **/
app.post("/oauth2/token", async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code || !redirect_uri) {
    return res.status(400).json({ message: "Missing code or redirect_uri" });
  }

  try {
    const params = new URLSearchParams();
    params.append("client_id", DISCORD_CLIENT_ID);
    params.append("client_secret", DISCORD_CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", redirect_uri);
    params.append("scope", "identify guilds.join");

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Token exchange failed:", text);
      return res.status(400).json({ message: "Token exchange failed" });
    }
    const tokenData = await tokenRes.json();

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok)
      return res.status(400).json({ message: "Failed to get user info" });
    const user = await userRes.json();

    res.json({
      user,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/** Apply Route **/
app.post("/apply", async (req, res) => {
  const { user_id, username, answers, access_token } = req.body;
  if (!user_id || !username || !answers) {
    return res.status(400).json({ message: "Missing application data" });
  }

  const blockedUntil = blockedUsers.get(user_id);
  if (blockedUntil && blockedUntil > Date.now()) {
    return res
      .status(403)
      .json({ message: "You are blocked from applying for 30 days." });
  } else if (blockedUntil && blockedUntil <= Date.now()) {
    blockedUsers.delete(user_id);
  }

  applications.set(user_id, {
    username,
    answers,
    access_token,
    timestamp: Date.now()
  });

  try {
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID);
    if (!staffChannel)
      return res.status(500).json({ message: "Staff channel not found" });

    // Fetch Discord user
    const discordUser = await client.users.fetch(user_id, { force: true }).catch(() => null);

    // Fetch guild member info if they are in the main guild
    let guildMember = null;
    try {
      const guild = await client.guilds.fetch(MAIN_GUILD_ID);
      guildMember = await guild.members.fetch(user_id);
    } catch {}

    // User badges
    let badges = "None";
    if (discordUser?.flags) {
      badges = discordUser.flags
        .toArray()
        .map(flag => UserFlags[flag])
        .join(", ") || "None";
    }

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle("📋 New Staff Application")
      .setColor("#5865F2")
      .setThumbnail(
        discordUser?.displayAvatarURL({ size: 1024, dynamic: true }) || null
      )
      .addFields(
        { name: "🆔 User ID", value: user_id, inline: true },
        { name: "👤 Username", value: `${discordUser?.tag || username}`, inline: true },
        {
          name: "📅 Account Created",
          value: discordUser
            ? `<t:${Math.floor(discordUser.createdTimestamp / 1000)}:R>`
            : "N/A",
          inline: true
        },
        { name: "🏅 Badges", value: badges, inline: false }
      )
      .setTimestamp();

    // Guild info
    if (guildMember) {
      embed.addFields(
        {
          name: "🏠 Guild Nickname",
          value: guildMember.nickname || "None",
          inline: true
        },
        {
          name: "📅 Joined Server",
          value: `<t:${Math.floor(
            guildMember.joinedTimestamp / 1000
          )}:R>`,
          inline: true
        },
        {
          name: "🏷 Roles",
          value:
            guildMember.roles.cache
              .filter(r => r.id !== MAIN_GUILD_ID)
              .map(r => r.toString())
              .join(", ") || "None",
          inline: false
        }
      );
    }

    // Application answers
    embed.addFields({ name: "📝 Application Answers", value: "\u200B" });
    for (const [qKey, answer] of Object.entries(answers)) {
      embed.addFields({
        name: `Q${qKey.replace("q", "")}`,
        value: answer?.trim() || "N/A"
      });
    }

    // Buttons
    const approveBtn = new ButtonBuilder()
      .setCustomId(`approve_${user_id}`)
      .setLabel("✅ APPROVE")
      .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
      .setCustomId(`deny_${user_id}`)
      .setLabel("❌ DENY")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    await staffChannel.send({ embeds: [embed], components: [row] });

    res.status(200).json({ message: "Application sent to staff." });
  } catch (err) {
    console.error("Failed to send application message:", err);
    res
      .status(500)
      .json({ message: "Failed to send application message." });
  }
});

/** Interaction Handler **/
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  const [action, userId] = interaction.customId.split("_");
  if (!["approve", "deny"].includes(action)) return;

  const guild = await client.guilds.fetch(STAFF_GUILD_ID);
  if (!guild) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor("#f04747").setDescription("❌ Guild not found.")],
      ephemeral: true
    });
  }

  try {
    if (action === "approve") {
      const appData = applications.get(userId);
      if (!appData) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor("#f04747").setDescription("❌ Application data not found.")],
          ephemeral: true
        });
      }

      await guild.members.add(userId, { accessToken: appData.access_token });

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor("#f04747").setDescription("❌ User not found in staff guild after adding.")],
          ephemeral: true
        });
      }

      const mainGuild = await client.guilds.fetch(MAIN_GUILD_ID);
      const mainMember = await mainGuild.members.fetch(userId);
      await mainMember.roles.add(STAFF_APPROVE_ROLE_IDS);

      try {
        await mainMember.send({
          embeds: [
            new EmbedBuilder()
              .setColor("#43b581")
              .setTitle("Application Approved")
              .setDescription("🎉 Congratulations! Your staff application for Bridgif has been **approved**.")
          ]
        });
      } catch {}

      applications.delete(userId);
      await interaction.update({
        embeds: [new EmbedBuilder().setColor("#43b581").setDescription(`✅ Application APPROVED for <@${userId}>`)],
        components: []
      });
    }

    if (action === "deny") {
      blockedUsers.set(userId, Date.now() + 30 * 24 * 60 * 60 * 1000);

      try {
        const user = await client.users.fetch(userId);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor("#f04747")
              .setTitle("Application Denied")
              .setDescription("❌ You are blocked from applying again for 30 days.")
          ]
        });
      } catch {}

      applications.delete(userId);
      await interaction.update({
        embeds: [new EmbedBuilder().setColor("#f04747").setDescription(`❌ Application DENIED for <@${userId}>`)],
        components: []
      });
    }
  } catch (err) {
    console.error(err);
    interaction.reply({
      embeds: [new EmbedBuilder().setColor("#f04747").setDescription("❌ Failed to process action.")],
      ephemeral: true
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

client.login(BOT_TOKEN);
