'use strict';

const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const kb = require('./keyboards');
const { haversine, formatDistance, sortByPrice } = require('./geo');

const { operatorLabel } = require('./operators');

const WELCOME_MESSAGE =
  `Welcome to 🚙 <b>EVLotBot</b>! Find available EV charging spots and get notified when they become available.\n\n` +
  `<b>Commands:</b>\n` +
  `🔍 Type in <b>name / address / postal code</b> to search\n` +
  `📍 /nearby — Find the 10 nearest charging spots\n` +
  `🔔 /subs — Subscriptions\n` +
  `ℹ️ /about — About this bot`;

const userCooldowns = new Map();
const COOLDOWN_MS = 2000;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID, 10);

function isRateLimited(chatId) {
  if (chatId === ADMIN_CHAT_ID) return false;
  const now = Date.now();
  const last = userCooldowns.get(chatId) ?? 0;
  if (now - last < COOLDOWN_MS) return true;
  userCooldowns.set(chatId, now);
  return false;
}

async function createBot(token) {
  const bot = new Telegraf(token);

  // Register commands with Telegram (only if token is valid)
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '👋 Welcome' },
      { command: 'nearby', description: '📍 Find nearest EV chargers' },
      { command: 'subs', description: '🔔 Subscriptions' },
      { command: 'about', description: 'ℹ️ About this bot' },
    ]);
    console.log('[bot] Commands registered with Telegram');
  } catch (err) {
    console.warn('[bot] Could not register commands with Telegram:', err.message);
  }

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(ctx => ctx.reply(WELCOME_MESSAGE, { parse_mode: 'HTML' }));

  // ── /subs ─────────────────────────────────────────────────────────────────
  bot.command('subs', ctx => {
    const subs = db.getSubscriptionsByChatId(ctx.chat.id);
    if (subs.length === 0) {
      return ctx.reply('You have no active subscriptions.\nType a name, address or postal code to search for a lot.');
    }
    const enriched = subs.map(sub => {
      const loc = sub.location_name || sub.lot_name.split('|||')[0];
      const op = operatorLabel(sub.operator || sub.lot_name.split('|||')[1] || '');
      return { ...sub, display: `${loc} | ${op} (${sub.charge_type})` };
    });
    return ctx.reply('Your subscriptions (tap to unsubscribe):', kb.subscriptionListKeyboard(enriched));
  });

  // ── /about ─────────────────────────────────────────────────────────────────
  bot.command('about', ctx => {
    return ctx.reply(
      `🚙 <b>EVLotBot</b> is a Telegram bot that helps you find available EV charging spots and notifies you when they become available.\n\n` +
      `You can view the source code and contribute on GitHub:\n` +
      `https://github.com/alwaysmod/EVLotBot`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  });

  // ── /nearby ────────────────────────────────────────────────────────────────
  bot.command('nearby', ctx => {
    return ctx.reply(
      '📍 <b>Share your location</b> to find the 10 nearest EV charging spots.\n\n' +
      'Tap the button below, or send your location manually.',
      {
        parse_mode: 'HTML',
        ...Markup.keyboard([
          [Markup.button.locationRequest('📍 Share my location')],
        ]).oneTime().resize(),
      }
    );
  });

  // ── Location message → nearest lots ───────────────────────────────────────
  bot.on('location', async ctx => {
    if (isRateLimited(ctx.chat.id)) return;
    const { latitude: lat, longitude: lon } = ctx.message.location;

    // Dismiss the custom keyboard immediately
    await ctx.reply('🔍 Searching nearby lots…', Markup.removeKeyboard());

    const lots = db.getNearestLots(lat, lon, 10);
    if (lots.length === 0) {
      return ctx.reply('😔 No EV charging lots found within 55 km of your location.');
    }

    const { text, options, mapUrl } = formatNearbyResults(lots, lat, lon, 'dist');
    return ctx.replyWithPhoto({ url: mapUrl }, { caption: text, ...options });
  });

  // ── Callback: sort-toggle for nearby results ───────────────────────────────
  bot.action(/^nearby_sort:(dist|price):(-?\d+\.\d+):(-?\d+\.\d+)$/, async ctx => {
    try {
      const sortMode = ctx.match[1];
      const lat = parseFloat(ctx.match[2]);
      const lon = parseFloat(ctx.match[3]);

      const lots = db.getNearestLots(lat, lon, 10);
      if (lots.length === 0) {
        return await ctx.answerCbQuery('No lots found.');
      }

      const { text, options } = formatNearbyResults(lots, lat, lon, sortMode);
      try {
        await ctx.editMessageCaption(text, options);
      } catch (err) {
        // Ignore "message is not modified" error if user taps the active sort button
        if (!err.message.includes('not modified') && !err.message.includes('message to edit not found')) {
          console.error('[bot] Error editing nearby results message:', err);
        }
      }
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('[bot] Error in nearby_sort callback:', err);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (e) { }
    }
  });

  // ── Admin commands ────────────────────────────────────────────────────────
  bot.command('admin', ctx => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;
    return ctx.reply(
      `<b>Admin commands</b>\n\n` +
      `/admin — List all admin commands\n` +
      `/adminsettings — View current subscription limits and total count\n` +
      `/adminsubs — List subscriptions grouped by lot\n` +
      `/setmaxsubs &lt;n&gt; — Set global subscription limit\n` +
      `/setmaxperuser &lt;n&gt; — Set per-user subscription limit`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('setmaxsubs', ctx => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;
    const arg = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(arg) || arg < 1) return ctx.reply('Usage: /setmaxsubs <number>');
    db.setSetting('max_subs_global', arg);
    return ctx.reply(`Global subscription limit set to ${arg}.`);
  });

  bot.command('setmaxperuser', ctx => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;
    const arg = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(arg) || arg < 1) return ctx.reply('Usage: /setmaxperuser <number>');
    db.setSetting('max_subs_per_user', arg);
    return ctx.reply(`Per-user subscription limit set to ${arg}.`);
  });

  bot.command('adminsubs', ctx => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;
    const rows = db.getSubscriptionsByLot();
    const total = db.getTotalSubscriptionCount();
    if (rows.length === 0) return ctx.reply('No active subscriptions.');
    const lines = [`<b>Subscriptions by lot</b> (total: ${total})\n`];
    for (const r of rows) {
      const loc = r.location_name || r.lot_name.split('|||')[0];
      const op = r.operator ? ` | ${operatorLabel(r.operator)}` : '';
      lines.push(`${r.cnt}× ${loc}${op} (${r.charge_type})`);
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('adminsettings', ctx => {
    if (ctx.chat.id !== ADMIN_CHAT_ID) return;
    const maxGlobal = db.getSetting('max_subs_global', 150);
    const maxPerUser = db.getSetting('max_subs_per_user', 3);
    const totalSubs = db.getTotalSubscriptionCount();
    return ctx.reply(
      `Admin settings:\n` +
      `• Global limit: ${maxGlobal} (current: ${totalSubs})\n` +
      `• Per-user limit: ${maxPerUser}`
    );
  });

  // ── Free-text search ───────────────────────────────────────────────────────
  bot.on('text', ctx => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    if (isRateLimited(ctx.chat.id)) return;
    const query = text.trim();
    const lots = db.searchLots(query);
    if (lots.length === 0) {
      return ctx.reply('No lots found. Try a different keyword.');
    }
    return ctx.reply('Select to view details:', kb.searchResultsKeyboard(lots, 'subscribe'));
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Edit the current callback-query message, using editMessageCaption for
   * photo messages and editMessageText for plain-text messages.
   */
  async function editMessage(ctx, text, options = {}) {
    const msg = ctx.callbackQuery?.message;
    if (msg?.photo) {
      return ctx.editMessageCaption(text, options);
    }
    return ctx.editMessageText(text, options);
  }

  function formatTimeAgo(unixSecs) {
    if (!unixSecs) return null;
    const diffSecs = Math.floor(Date.now() / 1000) - unixSecs;
    if (diffSecs < 60) return `${diffSecs}s ago`;
    if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
    if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
    return `${Math.floor(diffSecs / 86400)}d ago`;
  }

  function formatTime(unixSecs) {
    if (!unixSecs) return null;
    return new Date(unixSecs * 1000).toLocaleTimeString('en-SG', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore',
    });
  }

  /**
   * Build the nearby-results message text + reply options for a given sort mode.
   * @returns {{ text: string, options: object, mapUrl: string }}
   */
  function formatNearbyResults(lots, userLat, userLon, sortMode) {
    const sorted = sortMode === 'price' ? sortByPrice(lots) : lots;

    const MARKERS = [
      { emoji: '❤️', rgb: '255,0,0', name: 'red' },
      { emoji: '🩷', rgb: '226,112,179', name: 'pink' },
      { emoji: '🧡', rgb: '226,128,75', name: 'orange' },
      { emoji: '💛', rgb: '235,203,92', name: 'beige' },
      { emoji: '💚', rgb: '121,199,132', name: 'green' },
      { emoji: '🩵', rgb: '125,176,235', name: 'lightblue' },
      { emoji: '💙', rgb: '122,151,248', name: 'darkblue' },
      { emoji: '💜', rgb: '162,88,245', name: 'darkpurple' },
      { emoji: '🖤', rgb: '0,0,0', name: 'black' },
      { emoji: '🩶', rgb: '176,173,182', name: 'lightgray' },
      { emoji: '🤎', rgb: '145,98,88', name: 'darkred' }
    ];

    // Assign markers based on distance rank (original order) so colors stay
    // consistent when the user toggles between sort modes.
    const markerByLotId = new Map();
    lots.forEach((lot, i) => {
      markerByLotId.set(lot.id, MARKERS[(i + 1) % MARKERS.length]);
    });

    const lines = [`<b>Nearest EV charging spots</b> (tap a location for details)`];

    // Base OneMap Static Map URL (center on user, zoom 13 gives a good ~10km radius view)
    let mapUrl = `https://www.onemap.gov.sg/api/staticmap/getStaticImage?layerchosen=default&latitude=${userLat}&longitude=${userLon}&zoom=16&height=512&width=512`;
    const points = [];

    // Base OneMap Interactive AMM Map URL
    let ammUrl = `https://www.onemap.gov.sg/amm/amm.html?mapStyle=Default&zoomLevel=15&popupWidth=200`;
    const b64 = (str) => Buffer.from(encodeURIComponent(str)).toString('base64');

    // Add user marker as the first marker
    points.push(`[${userLat},${userLon},"${MARKERS[0].rgb}"]`);
    //ammUrl += `&marker=latLng:${userLat},${userLon}!iwt:${b64('<b>You are here</b>')}!colour:${MARKERS[0].name}`;
    ammUrl += `&marker=latLng:${userLat},${userLon}!iwt:${b64('<b>You are here</b>')}!icon:fa-star}`;

    sorted.forEach((lot, i) => {
      const dist = haversine(userLat, userLon, lot.latitude, lot.longitude);
      const distStr = formatDistance(dist);
      const name = lot.location_name || lot.name;

      let prices = [];
      if (lot.has_ac && lot.ac_price && !prices.includes(lot.ac_price)) prices.push(lot.ac_price);
      if (lot.has_dc && lot.dc_price && !prices.includes(lot.dc_price)) prices.push(lot.dc_price);
      let priceStr = prices.length > 0 ? prices.join(' / ') : 'Price N/A';

      const marker = markerByLotId.get(lot.id) || MARKERS[(i + 1) % MARKERS.length];
      lines.push(`${marker.emoji} ${i + 1}. <b>${name}</b> - ${distStr} - ${priceStr}`);

      // Add colored markers for the lot
      if (lot.latitude && lot.longitude) {
        points.push(`[${lot.latitude},${lot.longitude},"${marker.rgb}"]`);
        const opLabel = lot.operator ? operatorLabel(lot.operator) : 'Unknown';
        const popupText = `<b>${name}</b><br/>${opLabel} : ${priceStr}`;

        ammUrl += `&marker=latLng:${lot.latitude},${lot.longitude}!iwt:${b64(popupText)}`;
      }
    });

    if (points.length > 0) {
      mapUrl += `&points=${encodeURIComponent(points.join('|'))}`;
    }

    lines.unshift(`<a href="${ammUrl}">🗺️ Open in Interactive Map</a>\n🟥 = You are here.\n`);

    const globalLastUpdated = db.getLastUpdatedTime();
    if (globalLastUpdated) {
      lines.push(`\n🕐 <i>Last updated: ${formatTime(globalLastUpdated)} (${formatTimeAgo(globalLastUpdated)})</i>`);
    }

    return {
      text: lines.join('\n'),
      mapUrl,
      options: {
        parse_mode: 'HTML',
        ...kb.nearbyKeyboard(sorted, sortMode, userLat, userLon),
      },
    };
  }

  // ── Callback: user picks a venue from search results ─────────────────────
  bot.action(/^pick_venue:subscribe:(.+)$/, async ctx => {
    try {
      const param = ctx.match[1];
      let lotsAtVenue = [];
      let locationName = '';

      if (!param.startsWith('id:'))
        return await editMessage(ctx, `Invalid details. Please try again shortly.`, { parse_mode: 'HTML' });

      lotsAtVenue = db.getLotsByLotId(parseInt(param.slice(3), 10));
      locationName = lotsAtVenue[0]?.location_name || param;

      const lotsWithData = lotsAtVenue.filter(l => l.has_ac || l.has_dc);
      if (lotsWithData.length === 0)
        return await editMessage(ctx, `No charger data available for <b>${locationName}</b> yet. Please try again shortly.`, { parse_mode: 'HTML' });

      const lat = lotsAtVenue[0]?.latitude;
      const lon = lotsAtVenue[0]?.longitude;
      const mapsUrl = lat && lon ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : null;
      const lines = [`📍 <b>${locationName}</b>`];
      const address = lotsAtVenue[0]?.address;
      if (address) {
        const addressDisplay = mapsUrl ? `<a href="${mapsUrl}">${address}</a>` : address;
        lines.push(`🏢 ${addressDisplay}`);
      }
      lines.push('');

      const buttonRows = [];
      for (const lot of lotsWithData) {
        const opLabel = operatorLabel(lot.operator) || lot.location_name || lot.name;
        lines.push(`🔌 <b>${opLabel}</b>`);

        if (lot.has_ac) {
          const avail = lot.ac_available_count ?? 0;
          const acStr = lot.ac_total > 0
            ? (avail > 0 ? `✅ ${avail}/${lot.ac_total} available` : `❌ 0/${lot.ac_total} available`)
            : (lot.ac_available ? '✅ Available' : '❌ Unavailable');
          const acCost = lot.ac_price ? ` · ${lot.ac_price}` : '';
          lines.push(`  ⚡ AC — ${acStr}${acCost}`);
        }
        if (lot.has_dc) {
          const avail = lot.dc_available_count ?? 0;
          const dcStr = lot.dc_total > 0
            ? (avail > 0 ? `✅ ${avail}/${lot.dc_total} available` : `❌ 0/${lot.dc_total} available`)
            : (lot.dc_available ? '✅ Available' : '❌ Unavailable');
          const dcCost = lot.dc_price ? ` · ${lot.dc_price}` : '';
          lines.push(`  🔋 DC — ${dcStr}${dcCost}`);
        }
        lines.push('');

        const row = [];
        if (lot.has_ac && !lot.ac_available_count) row.push({ text: `⚡ ${opLabel} — AC`, style: 'success', callback_data: `subscribe:AC:id:${lot.id}` });
        if (lot.has_dc && !lot.dc_available_count) row.push({ text: `🔋 ${opLabel} — DC`, style: 'success', callback_data: `subscribe:DC:id:${lot.id}` });
        if (row.length) buttonRows.push(row);
      }

      const globalLastUpdated = db.getLastUpdatedTime();
      const timeStr = globalLastUpdated
        ? `${formatTime(globalLastUpdated)} (${formatTimeAgo(globalLastUpdated)})`
        : 'Unknown';
      lines.push(`🕐 <i>Last updated: ${timeStr}</i>`);
      lines.push('');
      if (buttonRows.length) {
        lines.push('Subscribe to alerts:');
        buttonRows.push([{ text: '❌ Cancel', style: 'danger', callback_data: 'cancel_sub' }]);
      }

      const caption = lines.join('\n');
      const replyOpts = {
        caption,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttonRows },
      };

      // Build a static map image for the location
      if (lat && lon) {
        const mapUrl =
          `https://www.onemap.gov.sg/api/staticmap/getStaticImage?layerchosen=default` +
          `&latitude=${lat}&longitude=${lon}&zoom=17&height=512&width=512` +
          `&points=${encodeURIComponent(`[${lat},${lon},"255,0,0"]`)}`;

        // Delete the original message and send a new photo with map + details
        try { await ctx.deleteMessage(); } catch (e) { /* ignore if already deleted */ }
        return await ctx.replyWithPhoto({ url: mapUrl }, replyOpts);
      }

      // Fallback: no coordinates — edit the existing message as text
      return await editMessage(ctx, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttonRows },
      });
    } catch (err) {
      console.error('[bot] Error in pick_venue callback:', err);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (e) { }
    }
  });

  // ── Callback: user picks AC or DC → subscribe immediately ────────────────
  bot.action(/^subscribe:(AC|DC):(.+)$/, async ctx => {
    try {
      if (isRateLimited(ctx.chat.id)) return ctx.answerCbQuery();
      const chargeType = ctx.match[1];
      const param = ctx.match[2];
      const lot = param.startsWith('id:')
        ? db.getLotById(parseInt(param.slice(3), 10))
        : db.getLotByName(param); // legacy fallback

      if (!lot)
        return await editMessage(ctx, 'Lot not found.');

      const locName = lot.location_name || lot.name;
      const opLabel = lot.operator ? operatorLabel(lot.operator) : null;

      const maxGlobal = db.getSetting('max_subs_global', 150);
      const maxPerUser = db.getSetting('max_subs_per_user', 3);

      if (ctx.chat.id !== ADMIN_CHAT_ID) {
        if (db.getTotalSubscriptionCount() >= maxGlobal) {
          return ctx.answerCbQuery('Subscription limit reached. Please try again later.', { show_alert: true });
        }
        if (db.getSubscriptionCountByChatId(ctx.chat.id) >= maxPerUser) {
          return ctx.answerCbQuery('You have reached the maximum number of subscriptions. Please remove existing ones first.', { show_alert: true });
        }
      }

      db.addSubscription(ctx.chat.id, lot.name, chargeType);

      const lines = [
        `Subscribed! You'll be notified when the charger becomes available.`,
        '',
        `<b>Location:</b> ${locName}`,
      ];
      if (opLabel) lines.push(`<b>Operator:</b> ${opLabel}`);
      lines.push(`<b>Type:</b> ${chargeType}`);
      lines.push('', 'Use /subs to manage your alerts.');

      await editMessage(ctx, lines.join('\n'), { parse_mode: 'HTML' });
      return ctx.answerCbQuery('Subscribed!');
    } catch (err) {
      console.error('[bot] Error in subscribe callback:', err);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (e) { }
    }
  });

  // ── Callback: cancel subscription flow ────────────────────────────────────
  bot.action('cancel_sub', async ctx => {
    try {
      await ctx.answerCbQuery('Cancelled.');
      try { await ctx.deleteMessage(); } catch (e) { /* ignore if already deleted */ }
    } catch (err) {
      console.error('[bot] Error in cancel_sub callback:', err);
      try { await ctx.answerCbQuery(); } catch (e) { }
    }
  });

  bot.action('cancel_unsub', async ctx => {
    try {
      return await editMessage(ctx, 'Cancelled.');
    } catch (err) {
      console.error('[bot] Error in cancel_unsub callback:', err);
      try { await ctx.answerCbQuery(); } catch (e) { }
    }
  });

  // ── Callback: unsubscribe ─────────────────────────────────────────────────
  bot.action(/^unsub:(AC|DC):(.+)$/, async ctx => {
    try {
      const chargeType = ctx.match[1];
      const param = ctx.match[2];
      const lot = param.startsWith('id:')
        ? db.getLotById(parseInt(param.slice(3), 10))
        : db.getLotByName(param); // legacy fallback

      const lotName = lot?.name || param;

      db.removeSubscription(ctx.chat.id, lotName, chargeType);

      const subs = db.getSubscriptionsByChatId(ctx.chat.id);
      const enriched = subs.map(sub => {
        const loc = sub.location_name || sub.lot_name.split('|||')[0];
        const op = operatorLabel(sub.operator || sub.lot_name.split('|||')[1] || '');
        return { ...sub, display: `${loc} | ${op} (${sub.charge_type})` };
      });
      const lines = [
        `Unsubscribed from <b>${chargeType}</b> alerts.`,
        '',
        `Your subscriptions (tap to unsubscribe):`,
      ];

      return await editMessage(ctx,
        subs.length > 0
          ? lines.join('\n')
          : `Unsubscribed from <b>${chargeType}</b> alerts.\n\nYou have no active subscriptions.`,
        {
          parse_mode: 'HTML',
          ...kb.subscriptionListKeyboard(enriched),
        }
      );
    } catch (err) {
      console.error('[bot] Error in unsub callback:', err);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (e) { }
    }
  });

  // Catch-all for unknown slash commands
  bot.on('text', ctx => {
    if (ctx.message.text.startsWith('/')) {
      ctx.reply('Unknown command. Use /subs to manage subscriptions, or type a name to search.');
    }
  });

  return bot;
}

module.exports = { createBot };
