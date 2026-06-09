const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS managers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      manager_id TEXT NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      pin TEXT NOT NULL UNIQUE,
      restaurant_name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
      table_num TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      prioritized BOOLEAN NOT NULL DEFAULT false,
      cleared BOOLEAN NOT NULL DEFAULT false,
      cleared_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS ticket_items (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      mods TEXT NOT NULL DEFAULT '',
      done BOOLEAN NOT NULL DEFAULT false,
      tagged BOOLEAN NOT NULL DEFAULT false,
      position INTEGER NOT NULL
    );

    -- Append-only cook-time history. Deliberately has NO foreign keys, so it is
    -- never removed by the ticket purge, service cascade deletes, or End Service.
    -- One row is written every time an item is completed, across all services.
    CREATE TABLE IF NOT EXISTS cook_time_logs (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      item_name TEXT NOT NULL,
      fired_at BIGINT NOT NULL,
      completed_at BIGINT NOT NULL,
      queue_depth INTEGER NOT NULL,
      ticket_size INTEGER NOT NULL,
      hour_of_day INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );

    -- A restaurant's menu: each dish and its normal cook time, set by managers.
    -- This cook time is the baseline that drives when each item fires.
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cook_seconds INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );

    -- A modifier on a dish (e.g. "well done"), with how much it changes cook time.
    -- cook_delta_seconds can be negative (e.g. "rare" cooks faster).
    CREATE TABLE IF NOT EXISTS modifiers (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cook_delta_seconds INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  // One entry per dish name within a restaurant, matched case-insensitively.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS menu_items_service_name ON menu_items (service_id, lower(name));
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS modifiers_item_name ON modifiers (menu_item_id, lower(name));
  `);

  // When true, a ticket item for this dish must have at least one modifier chosen.
  await pool.query(`
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS requires_modifier BOOLEAN NOT NULL DEFAULT false;
  `);

  // For existing deployments without service_id on tickets
  await pool.query(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS service_id TEXT REFERENCES services(id) ON DELETE CASCADE;
  `);

  // Mode: 'quick' = anonymous PIN service, 'full' = account-based restaurant
  await pool.query(`
    ALTER TABLE services ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'quick';
    ALTER TABLE services ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES managers(id) ON DELETE CASCADE;
    ALTER TABLE services ADD COLUMN IF NOT EXISTS target_ticket_time INTEGER;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS services_manager_unique ON services(manager_id);
  `);

  // Cook-time measurement fields on each item.
  await pool.query(`
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS fired_at BIGINT;
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS completed_at BIGINT;
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS queue_depth_at_fire INTEGER;
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS ticket_size INTEGER;
  `);

  // Predicted fire time per item, and predicted ready time for the whole ticket.
  await pool.query(`
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS fire_at BIGINT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS predicted_ready_at BIGINT;
  `);

  // Modifiers chosen for a ticket item, stored as a JSON array of names.
  await pool.query(`
    ALTER TABLE ticket_items ADD COLUMN IF NOT EXISTS modifiers TEXT NOT NULL DEFAULT '[]';
  `);
}

async function generatePin() {
  for (let i = 0; i < 10; i++) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const { rows } = await pool.query('SELECT id FROM services WHERE pin = $1', [pin]);
    if (rows.length === 0) return pin;
  }
  throw new Error('Could not generate unique PIN');
}

async function fetchActiveTickets(serviceId) {
  const { rows: ticketRows } = await pool.query(
    'SELECT * FROM tickets WHERE cleared = false AND service_id = $1 ORDER BY created_at ASC',
    [serviceId]
  );
  return attachItems(ticketRows);
}

async function fetchClearedTickets(serviceId) {
  const { rows: ticketRows } = await pool.query(
    'SELECT * FROM tickets WHERE cleared = true AND service_id = $1 ORDER BY cleared_at DESC LIMIT 30',
    [serviceId]
  );
  return attachItems(ticketRows);
}

async function attachItems(ticketRows) {
  if (ticketRows.length === 0) return [];
  const ids = ticketRows.map((t) => t.id);
  const { rows: itemRows } = await pool.query(
    'SELECT * FROM ticket_items WHERE ticket_id = ANY($1) ORDER BY position ASC',
    [ids]
  );
  return ticketRows.map((t) => formatTicket(t, itemRows.filter((i) => i.ticket_id === t.id)));
}

// The modifiers column holds a JSON array of names; fall back to empty on bad data.
function parseModifiers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTicket(t, items) {
  return {
    id: t.id,
    table: t.table_num,
    createdAt: Number(t.created_at),
    prioritized: t.prioritized,
    predictedReadyAt: t.predicted_ready_at != null ? Number(t.predicted_ready_at) : null,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      mods: i.mods,
      modifiers: parseModifiers(i.modifiers),
      done: i.done,
      tagged: i.tagged,
      fireAt: i.fire_at != null ? Number(i.fire_at) : null,
    })),
  };
}

async function findManagerByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM managers WHERE username = $1', [username]);
  return rows[0] || null;
}

async function createManager(id, username, passwordHash) {
  await pool.query(
    'INSERT INTO managers (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)',
    [id, username, passwordHash, Date.now()]
  );
}

// Sessions: a random token row per login. Stateful, so logout/revocation is just a DELETE.
async function createSession(token, managerId) {
  await pool.query(
    'INSERT INTO sessions (token, manager_id, created_at) VALUES ($1, $2, $3)',
    [token, managerId, Date.now()]
  );
}

// Returns the manager_id for a valid token, or null
async function findSessionManager(token) {
  const { rows } = await pool.query('SELECT manager_id FROM sessions WHERE token = $1', [token]);
  return rows[0] ? rows[0].manager_id : null;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// Returns the restaurant linked to this account as { serviceId, pin, restaurantName }, or null
async function getManagerRestaurant(managerId) {
  const { rows } = await pool.query(
    'SELECT id, pin, restaurant_name FROM services WHERE manager_id = $1',
    [managerId]
  );
  if (rows.length === 0) return null;
  return { serviceId: rows[0].id, pin: rows[0].pin, restaurantName: rows[0].restaurant_name };
}

// Returns a restaurant's menu as [{ name, cookSeconds, modifiers: [{ name, cookDeltaSeconds }] }]
async function getMenu(serviceId) {
  const { rows: itemRows } = await pool.query(
    'SELECT id, name, cook_seconds, requires_modifier FROM menu_items WHERE service_id = $1 ORDER BY name ASC',
    [serviceId]
  );
  if (itemRows.length === 0) return [];
  const ids = itemRows.map((r) => r.id);
  const { rows: modRows } = await pool.query(
    'SELECT menu_item_id, name, cook_delta_seconds FROM modifiers WHERE menu_item_id = ANY($1) ORDER BY cook_delta_seconds ASC',
    [ids]
  );
  return itemRows.map((r) => ({
    name: r.name,
    cookSeconds: r.cook_seconds,
    requiresModifier: r.requires_modifier,
    modifiers: modRows
      .filter((m) => m.menu_item_id === r.id)
      .map((m) => ({ name: m.name, cookDeltaSeconds: m.cook_delta_seconds })),
  }));
}

// Replaces a restaurant's whole menu (items and their modifiers) in one transaction.
async function replaceMenu(serviceId, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM menu_items WHERE service_id = $1', [serviceId]); // cascade drops modifiers
    for (const item of items) {
      const itemId = crypto.randomUUID();
      await client.query(
        'INSERT INTO menu_items (id, service_id, name, cook_seconds, requires_modifier, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [itemId, serviceId, item.name, item.cookSeconds, !!item.requiresModifier, Date.now()]
      );
      for (const mod of item.modifiers || []) {
        await client.query(
          'INSERT INTO modifiers (id, menu_item_id, name, cook_delta_seconds, created_at) VALUES ($1, $2, $3, $4, $5)',
          [crypto.randomUUID(), itemId, mod.name, mod.cookDeltaSeconds, Date.now()]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  setup,
  generatePin,
  fetchActiveTickets,
  fetchClearedTickets,
  findManagerByUsername,
  createManager,
  getManagerRestaurant,
  createSession,
  findSessionManager,
  deleteSession,
  getMenu,
  replaceMenu,
  parseModifiers,
};
