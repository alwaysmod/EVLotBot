'use strict';

// Pick a venue from search results — one button per unique location_name
function searchResultsKeyboard(lots, action) {
  const seen = new Set();
  const rows = [];
  for (const lot of lots) {
    const locationName = lot.location_name || lot.name;
    if (seen.has(locationName)) continue;
    seen.add(locationName);
    // Use lot id in callback — avoids length issues with long location names
    rows.push([{ text: `📍 ${locationName}`, callback_data: `pick_venue:${action}:id:${lot.id}` }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

// List subscriptions with unsubscribe buttons.
// Each sub must have: display (button label), charge_type, lot_id (DB id)
function subscriptionListKeyboard(subscriptions) {
  const rows = subscriptions.map(sub => [{
    text: `🔕 ${sub.display}`,
    callback_data: `unsub:${sub.charge_type}:id:${sub.lot_id}`,
  }]);

  rows.push([{ text: '❌ Cancel', style: 'danger', callback_data: 'cancel_unsub' }]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

/**
 * Build an inline keyboard for the /nearby results message.
 *
 * @param {object[]} lots    - Array of lot rows (already sorted for display)
 * @param {string}   sortMode - 'dist' | 'price'
 * @param {number}   lat     - User latitude  (encoded in sort-toggle callbacks)
 * @param {number}   lon     - User longitude (encoded in sort-toggle callbacks)
 */
function nearbyKeyboard(lots, sortMode, lat, lon) {
  const latStr = lat.toFixed(6);
  const lonStr = lon.toFixed(6);

  // Sort toggle row
  const distLabel = sortMode === 'dist' ? '📏 Distance ✓' : '📏 Distance';
  const priceLabel = sortMode === 'price' ? '💰 Price ✓' : '💰 Price';
  const toggleRow = [
    { text: distLabel, callback_data: `nearby_sort:dist:${latStr}:${lonStr}` },
    { text: priceLabel, callback_data: `nearby_sort:price:${latStr}:${lonStr}` },
  ];

  // One button per lot → reuse existing pick_venue detail flow
  const lotRows = lots.map(lot => [{
    text: `📍 ${lot.location_name || lot.name}`,
    callback_data: `pick_venue:subscribe:id:${lot.id}`,
  }]);

  return {
    reply_markup: {
      inline_keyboard: [toggleRow, ...lotRows],
    },
  };
}

module.exports = {
  searchResultsKeyboard,
  subscriptionListKeyboard,
  nearbyKeyboard,
};