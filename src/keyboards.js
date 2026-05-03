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

// Confirm or cancel a subscription (uses lot id throughout — avoids name-length issues)
function confirmSubscribeKeyboard(lotId, chargeType) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', style: 'success', callback_data: `confirm_sub:${chargeType}:id:${lotId}` },
          { text: '❌ Cancel',  style: 'danger',  callback_data: 'cancel_sub' },
        ],
        [{ text: '🔙 Back', callback_data: `pick_venue:subscribe:id:${lotId}` }],
      ],
    },
  };
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

module.exports = {
  searchResultsKeyboard,
  confirmSubscribeKeyboard,
  subscriptionListKeyboard
};