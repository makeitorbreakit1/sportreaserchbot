'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const { usageSnapshot, flush } = require('./cache/cacheManager');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variable.');
  process.exit(1);
}

// Slash commands only need the Guilds intent → smallest possible memory footprint.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'))) {
  const cmd = require(`./commands/${file}`);
  if (cmd?.data && typeof cmd.execute === 'function') client.commands.set(cmd.data.name, cmd);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const body = [...client.commands.values()].map(c => c.data.toJSON());

  // 1. Wipe stale/cached Global Commands to eliminate duplicates
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log('Cleared cached global slash commands.');

  // 2. Register active commands to Guild (if specified) or Global
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`Registered ${body.length} slash commands to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log(`Registered ${body.length} global slash commands.`);
  }
}

client.once(Events.ClientReady, c => {
  const u = usageSnapshot('odds');
  console.log(`Logged in as ${c.user.tag} | Odds credits today ${u.daily.used}/${u.daily.limit}, month ${u.monthly.used}/${u.monthly.limit}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const payload = { content: '❌ Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// discord.js reconnects/resumes shards on its own; these hooks just make it visible in Railway logs.
client.on(Events.ShardDisconnect, (ev, id) => console.warn(`Shard ${id} disconnected (code ${ev.code}); auto-reconnecting…`));
client.on(Events.ShardReconnecting, id => console.log(`Shard ${id} reconnecting…`));
client.on(Events.ShardResume, id => console.log(`Shard ${id} resumed.`));
client.on(Events.ShardError, err => console.error('Shard error:', err.message));
client.on(Events.Error, err => console.error('Client error:', err.message));

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
// A truly unknown state → exit so Railway's restart policy brings up a clean container.
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); flush(); process.exit(1); });

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  flush();
  client.destroy().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => shutdown(s)));

async function loginWithRetry(maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { await client.login(DISCORD_TOKEN); return; } catch (err) {
      if (err.code === 'TokenInvalid') { console.error('Invalid DISCORD_TOKEN.'); process.exit(1); }
      const wait = Math.min(60000, 2 ** attempt * 1000);
      console.error(`Login failed (attempt ${attempt}/${maxAttempts}): ${err.message}. Retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  process.exit(1); // let Railway restart the container
}

(async () => {
  await registerCommands().catch(err => console.error('Command registration failed:', err.message));
  await loginWithRetry();
})();
