'use strict';

const axios = require('axios');
const db = require('./db');
const { toTitleCase } = db;
const { operatorLabel } = require('./operators');

const LTA_BATCH_URL = 'https://datamall2.mytransport.sg/ltaodataservice/EVCBatch';
const LTA_ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY;

// ── Availability computation ──────────────────────────────────────────────────
// For a given array of chargingPoints (one operator's slice), compute:
//   - which charger types (AC/DC) are present
//   - how many evIds are available vs total, per type

function getChargerTypes(chargingPoints) {
  const types = new Set();
  for (const point of chargingPoints) {
    for (const plug of point.plugTypes || []) {
      if (plug.current === 'AC' || plug.current === 'DC') types.add(plug.current);
    }
  }
  return types;
}

// Returns { AC: { available: N, total: M }, DC: { available: N, total: M } }
function computeAvailabilityWithCounts(chargingPoints) {
  const result = {
    AC: { available: 0, total: 0 },
    DC: { available: 0, total: 0 },
  };
  for (const point of chargingPoints) {
    for (const plug of point.plugTypes || []) {
      const type = plug.current;
      if (type !== 'AC' && type !== 'DC') continue;
      for (const ev of plug.evIds || []) {
        result[type].total++;
        if (ev.status === '1') result[type].available++;
      }
    }
  }
  return result;
}

// Returns a formatted price string like "$0.67/kWh", a range "$0.67–$0.83/kWh",
// or null if no price data is found for the given charge type.
function getPriceInfo(chargingPoints, chargeType) {
  const priceEntries = []; // { raw: string, parsed: number }
  let priceType = null;
  for (const point of chargingPoints) {
    for (const plug of point.plugTypes || []) {
      if (plug.current !== chargeType) continue;
      if (plug.price) {
        const parsed = parseFloat(plug.price);
        if (!priceEntries.some(e => e.parsed === parsed)) {
          priceEntries.push({ raw: plug.price, parsed });
        }
        priceType = plug.priceType || priceType;
      }
    }
  }
  if (priceEntries.length === 0) return null;
  priceEntries.sort((a, b) => a.parsed - b.parsed);
  const stripTrailingZeros = s => parseFloat(s).toString();
  const priceStr = priceEntries.length > 1
    ? `$${stripTrailingZeros(priceEntries[0].raw)}–$${stripTrailingZeros(priceEntries[priceEntries.length - 1].raw)}`
    : `$${stripTrailingZeros(priceEntries[0].raw)}`;
  return priceType ? `${priceStr}/${priceType}` : priceStr;
}

// ── API fetch ─────────────────────────────────────────────────────────────────

async function fetchEVData() {
  const delays = [2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      const batchResp = await axios.get(LTA_BATCH_URL, {
        headers: { AccountKey: LTA_ACCOUNT_KEY, 'Accept-Encoding': 'gzip' },
        decompress: true,
        timeout: 15000,
      });
      const linkUrl = batchResp.data?.value?.[0]?.Link;
      if (!linkUrl) throw new Error('No Link field in EVCBatch response');
      const dataResp = await axios.get(linkUrl, {
        headers: { 'Accept-Encoding': 'gzip' },
        decompress: true,
        timeout: 30000,
      });
      return dataResp.data;
    } catch (err) {
      if (attempt >= delays.length) throw err;
      console.warn(`[poller] LTA fetch attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delays[attempt] / 1000}s…`);
      await new Promise(res => setTimeout(res, delays[attempt]));
    }
  }
}

// ── Notification dispatch ─────────────────────────────────────────────────────

async function dispatchNotifications(bot, lotName, locationName, address, operator, chargeType, positions = [], price = null, latitude = null, longitude = null) {
  const chatIds = db.getSubscribersForLot(lotName, chargeType);
  if (chatIds.length === 0) return;

  const displayLocation = toTitleCase(locationName || lotName);
  const displayAddress = toTitleCase(address) || 'N/A';
  const operatorDisplay = operator ? operatorLabel(operator) : null;

  const mapsUrl = latitude && longitude ? `https://www.google.com/maps?q=${latitude},${longitude}` : null;
  const addressLink = mapsUrl ? `<a href="${mapsUrl}">${displayAddress}</a>` : displayAddress;

  const message =
    `<b>⚡ EV Charger @ ${displayLocation} Available! ⚡</b>\n\n` +
    `📍 <b>Location:</b> ${displayLocation}\n` +
    `🏢 <b>Address:</b> ${addressLink}\n` +
    (operatorDisplay ? `🔌 <b>Operator:</b> ${operatorDisplay}\n` : '') +
    (positions.length ? `🅿️ <b>Position:</b> ${positions.join(', ')}\n` : '') +
    `⚡ <b>Type:</b> ${chargeType}\n` +
    `💰 <b>Cost:</b> ${price || 'N/A'}\n\n` +
    `The lot is now available. This alert has been unsubscribed.`;

  const BATCH_SIZE = 30;
  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    const batch = chatIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(chatId => bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }))
    );
    results.forEach((r, j) => {
      if (r.status === 'rejected')
        console.error(`[poller] Failed to notify chatId=${batch[j]}: ${r.reason?.message}`);
    });
    if (i + BATCH_SIZE < chatIds.length) await new Promise(res => setTimeout(res, 1000));
  }

  db.removeSubscriptionsForLot(lotName, chargeType);
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
// For each location, charging points are grouped by operator.
// Each (location, operator) pair is tracked as a separate lot entry.
// State machine per (lot, chargeType):
//   No prior state          → insert baseline, skip notification
//   0 → 1  (or notified=0)  → send notifications, mark notified=1
//   1 → 0                   → reset notified=0
//   no change               → update timestamp and counts only

async function runPollCycle(bot) {
  let evData;
  try {
    evData = await fetchEVData();
  } catch (err) {
    console.error('[poller] Failed to fetch EV data:', err.message);
    return;
  }

  if (evData.LastUpdatedTime) {
    // LTA timestamp is in SGT (UTC+8), e.g. "2024-09-15 23:30:00"
    const parsed = new Date(evData.LastUpdatedTime.replace(' ', 'T') + '+08:00');
    if (!isNaN(parsed)) db.setLastUpdatedTime(Math.floor(parsed.getTime() / 1000));
  }

  const locations = evData.evLocationsData || [];
  console.log(`[poller] Processing ${locations.length} locations`);

  // Collect pending notifications during the sync DB pass, dispatch after commit
  const pendingNotifications = [];

  db.runInTransaction(() => {
    for (const loc of locations) {
      const locName = loc.name || loc.address;
      if (!locName) continue;

      // Always register the location so it is searchable even with no charger data yet
      db.upsertLot({
        name: locName,
        locationName: locName,
        address: loc.address,
        postalCode: loc.postalCode,
        latitude: loc.latitude,
        longitude: loc.longtitude,
        operator: null,
      });

      // Group charging points by operator
      const byOperator = new Map();
      for (const point of loc.chargingPoints || []) {
        const opKey = point.operator || '__none__';
        if (!byOperator.has(opKey)) byOperator.set(opKey, []);
        byOperator.get(opKey).push(point);
      }

      for (const [opKey, points] of byOperator) {
        const operator = opKey === '__none__' ? null : opKey;
        const lotName = operator ? `${locName}|||${operator}` : locName;

        db.upsertLot({
          name: lotName,
          locationName: locName,
          address: loc.address,
          postalCode: loc.postalCode,
          latitude: loc.latitude,
          longitude: loc.longtitude, // API has typo "longtitude"
          operator: operator,
        });

        const chargerTypes = getChargerTypes(points);
        const avail = computeAvailabilityWithCounts(points);

        // Remove stale entries for charger types no longer at this operator/location
        for (const chargeType of ['AC', 'DC']) {
          if (!chargerTypes.has(chargeType)) {
            db.deleteAvailabilityState(lotName, chargeType);
          }
        }

        for (const chargeType of chargerTypes) {
          const counts = avail[chargeType];
          const isNowAvailable = counts.available > 0;
          const price = getPriceInfo(points, chargeType);
          const prev = db.getAvailabilityState(lotName, chargeType);

          if (!prev) {
            // First time: establish baseline, no notification
            db.upsertAvailabilityState(lotName, chargeType, isNowAvailable, counts.available, counts.total, price);
            continue;
          }

          const wasAvailable = prev.is_available === 1;
          const wasNotified = prev.notified === 1;

          if (isNowAvailable && (!wasAvailable || !wasNotified)) {
            db.upsertAvailabilityState(lotName, chargeType, true, counts.available, counts.total, price);
            db.markNotified(lotName, chargeType);
            const availablePoints = points.filter(p =>
              p.plugTypes?.some(pl =>
                pl.current === chargeType && pl.evIds?.some(ev => ev.status === '1')
              )
            );
            const positions = [...new Set(
              availablePoints.map(p => p.position).filter(Boolean),
            )];
            const availablePrice = getPriceInfo(availablePoints, chargeType);
            pendingNotifications.push({ lotName, locName, address: loc.address, operator, chargeType, positions, price: availablePrice, latitude: loc.latitude, longitude: loc.longtitude });
          } else if (!isNowAvailable && wasAvailable) {
            db.upsertAvailabilityState(lotName, chargeType, false, counts.available, counts.total, price);
            db.resetNotified(lotName, chargeType);
          } else {
            db.upsertAvailabilityState(lotName, chargeType, isNowAvailable, counts.available, counts.total, price);
          }
        }
      }
    }
  });

  // Dispatch notifications after the transaction commits
  for (const n of pendingNotifications) {
    await dispatchNotifications(bot, n.lotName, n.locName, n.address, n.operator, n.chargeType, n.positions, n.price, n.latitude, n.longitude);
  }
}

module.exports = { runPollCycle };
