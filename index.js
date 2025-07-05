// backend.js
import express from "express";
const app = express();
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, Events } from "discord.js";

const app = express();
app.use(express.json());

/** === CONFIG === **/
const DISCORD_CLIENT_ID = "1391134303718477944";
const DISCORD_CLIENT_SECRET = "RHtml2zr0gMn3xDnvEs3l_kzCWP3OyQL";
const BOT_TOKEN = "MTM5MTEzNDMwMzcxODQ3Nzk0NA.Gx24SG.MYzFuvJ6-HgtAX-x9plc2as0_KOqMYv5UPX7I8";
const REDIRECT_URI = "https://applybrid.onrender.com/callback.html"; // Same as frontend redirect URI

const STAFF_GUILD_ID = "1389985754666631198"; // Bridgif server ID
const STAFF_CHANNEL_ID = "1387525782888382516"; // Staff applications channel

const APPROVE_ROLE_IDS = [
  "1390712301950075011",
  "1390712297101594636",
  "1390712312444489820"
];

// Data stores (replace with DB or persistent storage for production)
const blockedUsers = new Map(); // userId => blockUntil timestamp
const applications = new Map(); // userId => { username, answers, accessToken, timestamp }

app.get("/", (req, res) => {
  res.send("Bot is online! " + new Date().toISOString());
});


/** === Discord Client Setup === **/
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

/** === OAuth2 Token Exchange === **/
app.post("/oauth2/token", async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code || !redirect_uri) return res.status(400).json({ message: "Missing code or redirect_uri" });

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

    // Get user info
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) return res.status(400).json({ message: "Failed to get user info" });
    const user = await userRes.json();

    // Return user + tokens
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

/** === Application Submission === **/
app.post("/apply", async (req, res) => {
  const { user_id, username, answers, access_token } = req.body;
  if (!user_id || !username || !answers) return res.status(400).json({ message: "Missing application data" });

  // Check block status
  const blockedUntil = blockedUsers.get(user_id);
  if (blockedUntil && blockedUntil > Date.now()) {
    return res.status(403).json({ message: "You are blocked from applying for 30 days." });
  } else if (blockedUntil && blockedUntil <= Date.now()) {
    blockedUsers.delete(user_id);
  }

  // Save application with access token (required for forced guild add)
  applications.set(user_id, { username, answers, access_token, timestamp: Date.now() });

  try {
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID);
    if (!staffChannel) return res.status(500).json({ message: "Staff channel not found" });

    const embed = new EmbedBuilder()
      .setTitle("New Staff Application")
      .setColor("#5865F2")
      .addFields(
        { name: "Applicant", value: `<@${user_id}> (${username})`, inline: true },
        { name: "User ID", value: user_id, inline: true },
        { name: "Why join?", value: answers.q1 || "N/A" },
        { name: "Experience", value: answers.q2 || "N/A" },
        { name: "Time Dedication", value: answers.q3 || "N/A" },
      )
      .setTimestamp();

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

/** === Button Interaction Handling === **/
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, userId] = interaction.customId.split("_");
  if (!["approve", "deny"].includes(action)) return;

  // Ensure guild & member exist
  const guild = await client.guilds.fetch(STAFF_GUILD_ID);
  if (!guild) return interaction.reply({ content: "Guild not found", ephemeral: true });

  try {
    if (action === "approve") {
      const appData = applications.get(userId);
      if (!appData) return interaction.reply({ content: "Application data not found.", ephemeral: true });

      // Add member to guild using OAuth token
      await guild.members.add(userId, { accessToken: appData.access_token });

      // Assign roles
      const member = await guild.members.fetch(userId);
      if (!member) return interaction.reply({ content: "User not found in guild after adding.", ephemeral: true });

      await member.roles.add(APPROVE_ROLE_IDS);

      // DM approval message
      try {
        await member.send(`🎉 Congratulations! Your staff application for Bridgif has been **approved**. You have been assigned your staff roles.`);
      } catch {}

      applications.delete(userId);

      await interaction.update({ content: `✅ Application APPROVED for <@${userId}>`, components: [], embeds: [] });
    } else if (action === "deny") {
      // Block user for 30 days
      blockedUsers.set(userId, Date.now() + 30 * 24 * 60 * 60 * 1000);

      // DM denial
      try {
        const user = await client.users.fetch(userId);
        await user.send(`❌ Your staff application for Bridgif has been **denied**. You are blocked from applying again for 30 days.`);
      } catch {}

      applications.delete(userId);

      await interaction.update({ content: `❌ Application DENIED for <@${userId}>`, components: [], embeds: [] });
    }
  } catch (err) {
    console.error(err);
    interaction.reply({ content: "Failed to process action.", ephemeral: true });
  }
});

/** === Start Express Server & Discord Client === **/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

client.login(BOT_TOKEN);
