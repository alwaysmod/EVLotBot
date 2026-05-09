'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'lotnotify.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  // Migration 1: add operator column (original)
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='lots'`).get();
  let needsMigration = false;

  if (tableExists) {
    const columns = db.prepare(`PRAGMA table_info(lots)`).all().map(col => col.name);
    needsMigration = !columns.includes('operator');
  }

  if (needsMigration) {
    console.log('[db] Migrating lots table to add operator column...');
    db.exec(`
      ALTER TABLE lots RENAME TO lots_old;

      CREATE TABLE lots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE,
        location_name TEXT,
        address       TEXT,
        postal_code   TEXT,
        latitude      REAL,
        longitude     REAL,
        operator      TEXT,
        updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      INSERT INTO lots (id, name, location_name, address, postal_code, latitude, longitude, updated_at)
      SELECT id, name, name, address, postal_code, latitude, longitude, updated_at FROM lots_old;

      DROP TABLE lots_old;
    `);
  }

  // Migration 2: add location_name column and compound lot name keys
  if (tableExists) {
    const cols = db.prepare(`PRAGMA table_info(lots)`).all().map(c => c.name);
    if (!cols.includes('location_name')) {
      console.log('[db] Migrating lots to add location_name and compound operator keys...');

      db.exec(`ALTER TABLE lots ADD COLUMN location_name TEXT`);
      db.exec(`UPDATE lots SET location_name = name`);

      // Migrate availability_state lot_name BEFORE renaming lots
      db.exec(`
        UPDATE availability_state
        SET lot_name = lot_name || '|||' || (
          SELECT operator FROM lots WHERE lots.name = availability_state.lot_name AND operator IS NOT NULL LIMIT 1
        )
        WHERE lot_name NOT LIKE '%|||%'
          AND EXISTS (SELECT 1 FROM lots WHERE lots.name = availability_state.lot_name AND operator IS NOT NULL)
      `);

      // Migrate subscriptions lot_name BEFORE renaming lots
      db.exec(`
        UPDATE subscriptions
        SET lot_name = lot_name || '|||' || (
          SELECT operator FROM lots WHERE lots.name = subscriptions.lot_name AND operator IS NOT NULL LIMIT 1
        )
        WHERE lot_name NOT LIKE '%|||%'
          AND EXISTS (SELECT 1 FROM lots WHERE lots.name = subscriptions.lot_name AND operator IS NOT NULL)
      `);

      // Rename lots with operators to compound key format
      db.exec(`
        UPDATE lots
        SET name = name || '|||' || operator
        WHERE operator IS NOT NULL AND name NOT LIKE '%|||%'
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_lots_location_name ON lots(location_name)`);
    }
  }

  // Create tables (fresh DB or ensure they exist)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      location_name TEXT,
      address       TEXT,
      postal_code   TEXT,
      latitude      REAL,
      longitude     REAL,
      operator      TEXT,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL,
      lot_name    TEXT NOT NULL,
      charge_type TEXT NOT NULL CHECK(charge_type IN ('AC','DC')),
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(chat_id, lot_name, charge_type)
    );

    CREATE TABLE IF NOT EXISTS availability_state (
      lot_name        TEXT NOT NULL,
      charge_type     TEXT NOT NULL CHECK(charge_type IN ('AC','DC')),
      is_available    INTEGER NOT NULL DEFAULT 0,
      notified        INTEGER NOT NULL DEFAULT 0,
      last_checked    INTEGER NOT NULL DEFAULT (unixepoch()),
      available_count INTEGER NOT NULL DEFAULT 0,
      total_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (lot_name, charge_type)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subs_lot_type      ON subscriptions(lot_name, charge_type);
    CREATE INDEX IF NOT EXISTS idx_subs_chat          ON subscriptions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_lots_operator      ON lots(operator);
    CREATE INDEX IF NOT EXISTS idx_lots_location_name ON lots(location_name);
    CREATE INDEX IF NOT EXISTS idx_lots_name          ON lots(name);
    CREATE INDEX IF NOT EXISTS idx_lots_latlon        ON lots(latitude, longitude);
  `);

  // Migration 3: add count columns to availability_state on existing DBs
  const asCols = db.prepare(`PRAGMA table_info(availability_state)`).all().map(c => c.name);
  if (!asCols.includes('available_count')) {
    console.log('[db] Migrating availability_state to add count columns...');
    db.exec(`ALTER TABLE availability_state ADD COLUMN available_count INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE availability_state ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0`);
  }

  // Migration 4: add price_info column to availability_state
  if (!asCols.includes('price_info')) {
    console.log('[db] Migrating availability_state to add price_info column...');
    db.exec(`ALTER TABLE availability_state ADD COLUMN price_info TEXT`);
  }

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('max_subs_global',  '150')`).run();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('max_subs_per_user', '3')`).run();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const { TitleCaser } = require('../node_modules/@danielhaim/titlecaser/dist/titlecaser.module');
const titlecaser = new TitleCaser();
function toTitleCase(str) {
  if (!str) return str;
  return titlecaser.toTitleCase(str);
}

// ── Lot catalog ───────────────────────────────────────────────────────────────

const upsertLotStmt = () => getDb().prepare(`
  INSERT INTO lots (name, location_name, address, postal_code, latitude, longitude, operator, updated_at)
  VALUES (@name, @location_name, @address, @postal_code, @latitude, @longitude, @operator, unixepoch())
  ON CONFLICT(name) DO UPDATE SET
    location_name = excluded.location_name,
    address       = excluded.address,
    postal_code   = excluded.postal_code,
    latitude      = excluded.latitude,
    longitude     = excluded.longitude,
    operator      = excluded.operator,
    updated_at    = unixepoch()
`);

function upsertLot(lot) {
  upsertLotStmt().run({
    name: lot.name,
    location_name: toTitleCase(lot.locationName || lot.name),
    address: toTitleCase(lot.address) || null,
    postal_code: lot.postalCode || null,
    latitude: lot.latitude || null,
    longitude: lot.longitude || null,
    operator: lot.operator || null,
  });
}

function searchLots(query) {
  const exact = query.toLowerCase();
  const prefix = `${query}%`;
  const contain = `%${query}%`;
  return getDb()
    .prepare(`
      SELECT l.id, l.name, l.location_name, l.address, l.postal_code, l.operator,
             ac.is_available AS ac_available, ac.lot_name IS NOT NULL AS has_ac,
             dc.is_available AS dc_available, dc.lot_name IS NOT NULL AS has_dc,
             CASE
               WHEN lower(l.location_name) = ?             THEN 3
               WHEN lower(l.location_name) LIKE lower(?)   THEN 2
               ELSE 1
             END AS score
      FROM lots l
      LEFT JOIN availability_state ac ON l.name = ac.lot_name AND ac.charge_type = 'AC'
      LEFT JOIN availability_state dc ON l.name = dc.lot_name AND dc.charge_type = 'DC'
      WHERE l.location_name LIKE ? OR l.address LIKE ? OR l.postal_code LIKE ?
      ORDER BY score DESC, l.location_name
      LIMIT 20
    `)
    .all(exact, prefix, contain, contain, contain);
}

function getLotByName(name) {
  return getDb().prepare(`SELECT * FROM lots WHERE name = ?`).get(name);
}

function getLotById(id) {
  return getDb().prepare(`SELECT * FROM lots WHERE id = ?`).get(id) || null;
}

function getLotsByLotId(lotId) {
  return getDb()
    .prepare(`
      SELECT l.id, l.name, l.location_name, l.address, l.latitude, l.longitude, l.operator,
             ac.is_available AS ac_available, ac.lot_name IS NOT NULL AS has_ac,
             ac.available_count AS ac_available_count, ac.total_count AS ac_total, ac.price_info AS ac_price,
             dc.is_available AS dc_available, dc.lot_name IS NOT NULL AS has_dc,
             dc.available_count AS dc_available_count, dc.total_count AS dc_total, dc.price_info AS dc_price,
             MAX(ac.last_checked, dc.last_checked) AS last_checked
      FROM lots l
      LEFT JOIN availability_state ac ON l.name = ac.lot_name AND ac.charge_type = 'AC'
      LEFT JOIN availability_state dc ON l.name = dc.lot_name AND dc.charge_type = 'DC'
      WHERE l.location_name = (SELECT location_name FROM lots WHERE id = ?)
      ORDER BY l.operator, l.name
    `)
    .all(lotId);
}

/**
 * Return the `limit` closest lots to (lat, lon).
 *
 * Uses a flat-earth approximation (accurate to < 0.1 % within 50 km) so we
 * can do the distance calculation inside SQLite without trigonometry.
 * A ±0.5° bounding box (~55 km at Singapore's latitude) pre-filters rows
 * and keeps the query fast via the idx_lots_latlon index.
 *
 * One row per unique location_name is returned (the closest charger within
 * each venue is representative), with full availability data attached.
 */
function getNearestLots(lat, lon, limit = 10) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  // We deduplicate by location_name, keeping the row with the smallest dist_sq.
  // SQLite MIN() in a GROUP BY picks an arbitrary row for other columns, but
  // since all rows at the same venue share the same lat/lon this is fine.
  return getDb()
    .prepare(`
      SELECT
        l.id, l.name, l.location_name, l.address, l.latitude, l.longitude, l.operator,
        MAX(ac.is_available) AS ac_available, MAX(ac.lot_name IS NOT NULL) AS has_ac,
        MAX(ac.available_count) AS ac_available_count, MAX(ac.total_count) AS ac_total, MAX(ac.price_info) AS ac_price,
        MAX(dc.is_available) AS dc_available, MAX(dc.lot_name IS NOT NULL) AS has_dc,
        MAX(dc.available_count) AS dc_available_count, MAX(dc.total_count) AS dc_total, MAX(dc.price_info) AS dc_price,
        (
          (l.latitude  - @lat) * (l.latitude  - @lat) +
          (@cosLat * (l.longitude - @lon)) * (@cosLat * (l.longitude - @lon))
        ) AS dist_sq
      FROM lots l
      LEFT JOIN availability_state ac ON l.name = ac.lot_name AND ac.charge_type = 'AC'
      LEFT JOIN availability_state dc ON l.name = dc.lot_name AND dc.charge_type = 'DC'
      WHERE l.latitude  IS NOT NULL
        AND l.longitude IS NOT NULL
        AND l.latitude  BETWEEN @lat - 0.5 AND @lat + 0.5
        AND l.longitude BETWEEN @lon - 0.5 AND @lon + 0.5
      GROUP BY l.location_name
      ORDER BY dist_sq ASC
      LIMIT @limit
    `)
    .all({ lat, lon, cosLat, limit });
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

function addSubscription(chatId, lotName, chargeType) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO subscriptions (chat_id, lot_name, charge_type) VALUES (?, ?, ?)`)
    .run(chatId, lotName, chargeType);
}

function removeSubscription(chatId, lotName, chargeType) {
  getDb()
    .prepare(`DELETE FROM subscriptions WHERE chat_id = ? AND lot_name = ? AND charge_type = ?`)
    .run(chatId, lotName, chargeType);
}

function removeSubscriptionsForLot(lotName, chargeType) {
  getDb()
    .prepare(`DELETE FROM subscriptions WHERE lot_name = ? AND charge_type = ?`)
    .run(lotName, chargeType);
}

function getSubscriptionsByChatId(chatId) {
  return getDb()
    .prepare(`
      SELECT s.lot_name, s.charge_type,
             l.id AS lot_id, l.location_name, l.operator
      FROM subscriptions s
      LEFT JOIN lots l ON s.lot_name = l.name
      WHERE s.chat_id = ?
      ORDER BY l.location_name, l.operator, s.charge_type
    `)
    .all(chatId);
}

function getSubscribersForLot(lotName, chargeType) {
  return getDb()
    .prepare(`SELECT chat_id FROM subscriptions WHERE lot_name = ? AND charge_type = ?`)
    .all(lotName, chargeType)
    .map(r => r.chat_id);
}

// ── Availability state ────────────────────────────────────────────────────────

function deleteAvailabilityState(lotName, chargeType) {
  getDb()
    .prepare(`DELETE FROM availability_state WHERE lot_name = ? AND charge_type = ?`)
    .run(lotName, chargeType);
}

function getAvailabilityState(lotName, chargeType) {
  return getDb()
    .prepare(`SELECT is_available, notified FROM availability_state WHERE lot_name = ? AND charge_type = ?`)
    .get(lotName, chargeType) || null;
}

function upsertAvailabilityState(lotName, chargeType, isAvailable, availableCount = 0, totalCount = 0, priceInfo = null) {
  getDb()
    .prepare(`
      INSERT INTO availability_state (lot_name, charge_type, is_available, notified, last_checked, available_count, total_count, price_info)
      VALUES (?, ?, ?, 0, unixepoch(), ?, ?, ?)
      ON CONFLICT(lot_name, charge_type) DO UPDATE SET
        is_available    = excluded.is_available,
        last_checked    = unixepoch(),
        available_count = excluded.available_count,
        total_count     = excluded.total_count,
        price_info      = excluded.price_info
    `)
    .run(lotName, chargeType, isAvailable ? 1 : 0, availableCount, totalCount, priceInfo);
}

function markNotified(lotName, chargeType) {
  getDb()
    .prepare(`UPDATE availability_state SET notified = 1 WHERE lot_name = ? AND charge_type = ?`)
    .run(lotName, chargeType);
}

function resetNotified(lotName, chargeType) {
  getDb()
    .prepare(`UPDATE availability_state SET notified = 0 WHERE lot_name = ? AND charge_type = ?`)
    .run(lotName, chargeType);
}

// ── Transaction helper ────────────────────────────────────────────────────────

function runInTransaction(fn) {
  return getDb().transaction(fn)();
}

// ── Global settings ───────────────────────────────────────────────────────────

function setLastUpdatedTime(unixSecs) {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES ('last_updated_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(unixSecs));
}

function getLastUpdatedTime() {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'last_updated_time'`).get();
  return row ? parseInt(row.value, 10) : null;
}

function getSetting(key, defaultValue) {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  if (!row) return defaultValue;
  return typeof defaultValue === 'number' ? Number(row.value) : row.value;
}

function setSetting(key, value) {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, String(value));
}

function getTotalSubscriptionCount() {
  return getDb().prepare(`SELECT COUNT(*) AS cnt FROM subscriptions`).get().cnt;
}

function getSubscriptionCountByChatId(chatId) {
  return getDb().prepare(`SELECT COUNT(*) AS cnt FROM subscriptions WHERE chat_id = ?`).get(chatId).cnt;
}

function getSubscriptionsByLot() {
  return getDb().prepare(`
    SELECT s.lot_name, s.charge_type, COUNT(*) AS cnt,
           l.location_name, l.operator
    FROM subscriptions s
    LEFT JOIN lots l ON l.name = s.lot_name
    GROUP BY s.lot_name, s.charge_type
    ORDER BY cnt DESC, s.lot_name
  `).all();
}

module.exports = {
  toTitleCase,
  runInTransaction,
  upsertLot,
  searchLots,
  getLotByName,
  getLotById,
  getLotsByLotId,
  getNearestLots,
  addSubscription,
  removeSubscription,
  removeSubscriptionsForLot,
  getSubscriptionsByChatId,
  getSubscribersForLot,
  getAvailabilityState,
  deleteAvailabilityState,
  upsertAvailabilityState,
  markNotified,
  resetNotified,
  setLastUpdatedTime,
  getLastUpdatedTime,
  getSetting,
  setSetting,
  getTotalSubscriptionCount,
  getSubscriptionCountByChatId,
  getSubscriptionsByLot,
};
