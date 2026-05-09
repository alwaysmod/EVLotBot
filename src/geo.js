'use strict';

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine great-circle distance between two lat/lon points.
 * @returns {number} distance in kilometres
 */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Format a distance in km to a human-readable string.
 * Below 1 km, show metres; otherwise show km with one decimal.
 */
function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/**
 * Parse a numeric charging rate from a price_info string.
 * e.g. "$0.40/kWh" → 0.40,  "Free" → 0,  "S$0.55 per kWh" → 0.55
 * Returns Infinity for strings we cannot parse (sorts to the end).
 */
function parsePriceRate(priceInfo) {
  if (!priceInfo) return Infinity;
  const lower = priceInfo.toLowerCase().trim();
  if (lower === 'free' || lower === '$0' || lower === '0') return 0;
  // Match the first decimal/integer number in the string
  const match = lower.match(/[\d]+(?:\.\d+)?/);
  if (!match) return Infinity;
  return parseFloat(match[0]);
}

/**
 * Given a lot row (with ac_price / dc_price fields), return the cheapest
 * rate across available charger types.
 */
function cheapestRate(lot) {
  const rates = [];
  if (lot.has_ac && lot.ac_price != null) rates.push(parsePriceRate(lot.ac_price));
  if (lot.has_dc && lot.dc_price != null) rates.push(parsePriceRate(lot.dc_price));
  if (rates.length === 0) return Infinity;
  return Math.min(...rates);
}

/**
 * Sort an array of lot rows by cheapest charging rate (ascending).
 * Lots with no price info sort to the end.
 * Does NOT mutate the original array.
 */
function sortByPrice(lots) {
  return [...lots].sort((a, b) => cheapestRate(a) - cheapestRate(b));
}

module.exports = { haversine, formatDistance, sortByPrice };
