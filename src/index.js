'use strict';

require('dotenv').config();

const cron = require('node-cron');
const { createBot } = require('./bot');
const { runPollCycle } = require('./poller');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable is required');
  process.exit(1);
}

const POLL_INTERVAL = 5; // minutes

async function main() {
  const bot = await createBot(BOT_TOKEN);

  // Run an initial poll on startup to populate the lots catalog and establish
  // baseline availability states. No notifications are sent on this first run.
  runPollCycle(bot)
    .then(() => console.log('[startup] Initial poll complete'))
    .catch(err => console.error('[startup] Initial poll failed:', err.message));

  // Schedule recurring polls
  cron.schedule(`*/${POLL_INTERVAL} * * * *`, async () => {
    console.log(`[cron] Poll cycle starting at ${new Date().toISOString()}`);
    await runPollCycle(bot);
  });

  bot.launch()
    .then(() => console.log('[bot] LotBot is running'))
    .catch(err => {
      console.error('[bot] Failed to launch:', err.message);
      process.exit(1);
    });

  // Set up shutdown handlers
  process.once('SIGINT',  () => { console.log('Shutting down...'); bot.stop('SIGINT'); });
  process.once('SIGTERM', () => { console.log('Shutting down...'); bot.stop('SIGTERM'); });
}

main().catch(err => {
  console.error('Failed to start application:', err.message);
  process.exit(1);
});
