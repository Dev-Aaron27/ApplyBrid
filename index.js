// backend.js
import express from "express";
import fetch from "node-fetch";
import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ButtonBuilder, 
  ButtonStyle, 
  ActionRowBuilder, 
  EmbedBuilder, 
  Events 
} from "discord.js";
import cors from "cors";

const app = express();
app.use(express.json());

/** === CONFIG === **/
const DISCORD_CLIENT_ID = "1391134303718477944";
const DISCORD_CLIENT_SECRET = "RHtml2zr0gMn3xDnvEs3l_kzCWP3OyQL";
const BOT_TOKEN = "MTM5MTEzNDMwMzcxODQ3Nzk0NA.Gx24SG.MYzFuvJ6-HgtAX-x9plc2as0_KOqMYv5UPX7I8";
const REDIRECT_URI = "https://apply-bridgify.infy.uk/callback.html";

const STAFF_GUILD_ID = "1380214993018163260";
const STAFF_CHANNEL_ID = "1387525782888382516";

const APPROVE_ROLES_GUILD_ID = "1389985754666631198";

const blockedUsers = new Map();
const applications = new Map();

app.get("/", (req, res) => {
  res.send("Bot is online! " + new Date().toISOString());
});

app.use(cors({
  origin: "https://apply-bridgify.infy.uk",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

let APPROVE_ROLE_IDS_DYNAMIC = [];

client.once(Events.ClientReady, async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  try {
    const rolesGuild = await client.guilds.fetch(APPROVE_ROLES_GUILD_ID);
    const roles = await rolesGuild.roles.fetch();

    // Filter roles you want to assign on approval (exclude @everyone)
    APPROVE_ROLE_IDS_DYNAMIC = roles
      .filter(role => role.id !== rolesGuild.id)
      .map(role => role.id);

    console.log("Loaded approve roles from guild:", APPROVE_ROLE_IDS_DYNAMIC);
  } catch (err) {
    console.error("Failed to load roles from guild:", err);
  }
});

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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    if (!userRes.ok) return res.status(400).json({ message: "Failed to get user info" });
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

app.post("/apply", async (req, res) => {
  const { user_id, username, answers, access_token } = req.body;
  if (!user_id || !username || !answers) {
    return res.status(400).json({ message: "Missing application data" });
  }

  const blockedUntil = blockedUsers.get(user_id);
  if (blockedUntil && blockedUntil > Date.now()) {
    return res.status(403).json({ message: "You are blocked from applying for 30 days." });
  } else if (blockedUntil && blockedUntil <= Date.now()) {
    blockedUsers.delete(user_id);
  }

  applications.set(user_id, { username, answers, access_token, timestamp: Date.now() });

  try {
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID);
    if (!staffChannel) return res.status(500).json({ message: "Staff channel not found" });

    const embed = new EmbedBuilder()
      .setTitle("New Staff Application")
      .setColor("#5865F2")
      .addFields(
        { name: "Applicant", value: `<@${user_id}> (${username})`, inline: true },
        { name: "User ID", value: user_id, inline: true }
      )
      .setTimestamp();

    // Dynamically add all questions and answers (max 25 fields per embed)
    const entries = Object.entries(answers);
    entries.forEach(([key, value], index) => {
      if (index < 23) { // reserve space for applicant info fields
        embed.addFields({ name: `Q${index + 1}`, value: value || "N/A" });
      }
    });

    const approveBtn = new ButtonBuilder()
      .setCustomId(`approve_${user_id}`)
      .setLabel("APPROVE")
      .setStyle(ButtonStyle.Success);

    const denyBtn = new ButtonBuilder()
      .setCustomId(`deny_${user_id}`)
      .setLabel("DENY")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    await staffChannel.send({ embeds: [embed], components: [row] });

    res.status(200).json({ message: "Application sent to staff." });
  } catch (err) {
    console.error("Failed to send application message:", err);
    res.status(500).json({ message: "Failed to send application message." });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, userId] = interaction.customId.split("_");
  if (!["approve", "deny"].includes(action)) return;

  const guild = await client.guilds.fetch(STAFF_GUILD_ID);
  if (!guild) {
    const embed = new EmbedBuilder()
      .setColor("#f04747")
      .setDescription("❌ Guild not found.");
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  try {
    if (action === "approve") {
      const appData = applications.get(userId);
      if (!appData) {
        const embed = new EmbedBuilder()
          .setColor("#f04747")
          .setDescription("❌ Application data not found.");
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      await guild.members.add(userId, { accessToken: appData.access_token });

      const member = await guild.members.fetch(userId);
      if (!member) {
        const embed = new EmbedBuilder()
          .setColor("#f04747")
          .setDescription("❌ User not found in guild after adding.");
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      await member.roles.add(APPROVE_ROLE_IDS_DYNAMIC);

      try {
        await member.send({
          embeds: [new EmbedBuilder()
            .setColor("#43b581")
            .setTitle("Application Approved")
            .setDescription("🎉 Congratulations! Your staff application for Bridgif has been **approved**. You have been assigned your staff roles.")
          ]
        });
      } catch {}

      applications.delete(userId);

      const approveEmbed = new EmbedBuilder()
        .setColor("#43b581")
        .setDescription(`✅ Application APPROVED for <@${userId}>`);

      await interaction.update({ embeds: [approveEmbed], components: [] });

    } else if (action === "deny") {
      blockedUsers.set(userId, Date.now() + 30 * 24 * 60 * 60 * 1000);

      try {
        const user = await client.users.fetch(userId);
        await user.send({
          embeds: [new EmbedBuilder()
            .setColor("#f04747")
            .setTitle("Application Denied")
            .setDescription("❌ Your staff application for Bridgif has been **denied**. You are blocked from applying again for 30 days.")
          ]
        });
      } catch {}

      applications.delete(userId);

      const denyEmbed = new EmbedBuilder()
        .setColor("#f04747")
        .setDescription(`❌ Application DENIED for <@${userId}>`);

      await interaction.update({ embeds: [denyEmbed], components: [] });
    }
  } catch (err) {
    console.error(err);
    const errorEmbed = new EmbedBuilder()
      .setColor("#f04747")
      .setDescription("❌ Failed to process action.");
    interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

client.login(BOT_TOKEN);
