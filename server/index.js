require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
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
} = require('./db');
const { predictCookSeconds } = require('./predict');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clientDist = path.join(__dirname, '../client/dist');
app.use(express.json());
app.use(express.static(clientDist));
app.get('/health', (_req, res) => res.sendStatus(200));

// --- Manager auth (REST) ---------------------------------------------------
// Auth and restaurant setup are request/response, so they live on REST.
// The live KDS stays on WebSocket. A restaurant created here is just a normal
// service with a PIN, and managers and staff enter it via the existing
// WebSocket join flow.

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token.' });
  const managerId = await findSessionManager(token);
  if (!managerId) return res.status(401).json({ error: 'Invalid or expired session.' });
  req.managerId = managerId;
  req.token = token;
  next();
}

// Create a session: a random opaque token stored server-side, returned to the client.
async function issueToken(managerId) {
  const token = crypto.randomBytes(32).toString('hex');
  await createSession(token, managerId);
  return token;
}

app.post('/api/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be 3+ characters and password 6+ characters.' });
  }
  if (await findManagerByUsername(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  await createManager(id, username, passwordHash);
  res.json({ token: await issueToken(id), username, restaurant: null });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const manager = await findManagerByUsername(username);
  if (!manager || !(await bcrypt.compare(password, manager.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const restaurant = await getManagerRestaurant(manager.id);
  res.json({ token: await issueToken(manager.id), username, restaurant });
});

app.post('/api/logout', auth, async (req, res) => {
  await deleteSession(req.token);
  res.json({ ok: true });
});

app.get('/api/restaurant', auth, async (req, res) => {
  res.json({ restaurant: await getManagerRestaurant(req.managerId) });
});

app.post('/api/restaurant', auth, async (req, res) => {
  const name = String(req.body.restaurantName || '').trim();
  if (!name) return res.status(400).json({ error: 'Restaurant name is required.' });
  // One-to-one: if this account already has a restaurant, return it instead of creating another.
  const existing = await getManagerRestaurant(req.managerId);
  if (existing) return res.json({ restaurant: existing });
  const id = crypto.randomUUID();
  const pin = await generatePin();
  await pool.query(
    'INSERT INTO services (id, pin, restaurant_name, created_at, mode, manager_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, pin, name, Date.now(), 'full', req.managerId]
  );
  res.json({ restaurant: { serviceId: id, pin, restaurantName: name } });
});

// Returns predicted cook seconds per item from cook-time history.
// Body: { items: ["Burger", ...], hour?: 0-23 }. Defaults hour to the server's current hour.
app.post('/predict/baseline', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const hour = Number.isInteger(req.body.hour) ? req.body.hour : new Date().getHours();
  const predictions = await predictCookSeconds(items, hour);
  res.json({ predictions });
});

// SPA catch-all: must stay last so it doesn't swallow /api routes
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

// serviceId -> Set<WebSocket>
const rooms = new Map();

function addToRoom(serviceId, ws) {
  if (!rooms.has(serviceId)) rooms.set(serviceId, new Set());
  rooms.get(serviceId).add(ws);
}

function removeFromRoom(ws) {
  if (!ws.serviceId) return;
  const room = rooms.get(ws.serviceId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(ws.serviceId);
}

function broadcast(serviceId, type, payload) {
  const room = rooms.get(serviceId);
  if (!room) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of room) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, payload }));
}

const CLEARED_TICKET_PURGE_MS = 7 * 24 * 60 * 60 * 1000;

// Every hour, purge cleared tickets older than 7 days. Services survive indefinitely.
setInterval(async () => {
  await pool.query(
    'DELETE FROM tickets WHERE cleared = true AND cleared_at < $1',
    [Date.now() - CLEARED_TICKET_PURGE_MS]
  );
}, 60 * 60 * 1000);

async function getTicket(ticketId) {
  const { rows: ticketRows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (ticketRows.length === 0) return null;
  const { rows: itemRows } = await pool.query(
    'SELECT * FROM ticket_items WHERE ticket_id = $1 ORDER BY position ASC',
    [ticketId]
  );
  const t = ticketRows[0];
  return {
    id: t.id,
    table: t.table_num,
    createdAt: Number(t.created_at),
    prioritized: t.prioritized,
    predictedReadyAt: t.predicted_ready_at != null ? Number(t.predicted_ready_at) : null,
    items: itemRows.map((i) => ({
      id: i.id, name: i.name, quantity: i.quantity, mods: i.mods, done: i.done, tagged: i.tagged,
      fireAt: i.fire_at != null ? Number(i.fire_at) : null,
    })),
  };
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type, payload = {} } = msg;

    switch (type) {
      case 'lookup_service': {
        const { rows } = await pool.query('SELECT restaurant_name FROM services WHERE pin = $1', [payload.pin]);
        if (rows.length === 0) { send(ws, 'service_error', { message: 'Invalid PIN. Please try again.' }); return; }
        send(ws, 'service_found', { restaurantName: rows[0].restaurant_name });
        break;
      }

      case 'create_service': {
        const name = String(payload.restaurantName || '').trim();
        if (!name) return;
        const id = crypto.randomUUID();
        const pin = await generatePin();
        const now = Date.now();
        await pool.query(
          'INSERT INTO services (id, pin, restaurant_name, created_at) VALUES ($1, $2, $3, $4)',
          [id, pin, name, now]
        );
        ws.serviceId = id;
        addToRoom(id, ws);
        send(ws, 'service_created', { serviceId: id, pin, restaurantName: name, mode: 'quick' });
        send(ws, 'init', { tickets: [], clearedTickets: [] });
        break;
      }

      case 'join_service': {
        const { rows } = await pool.query('SELECT id, restaurant_name, mode FROM services WHERE pin = $1', [payload.pin]);
        if (rows.length === 0) { send(ws, 'service_error', { message: 'Invalid PIN. Please try again.' }); return; }
        const { id, restaurant_name, mode } = rows[0];
        ws.serviceId = id;
        addToRoom(id, ws);
        const [tickets, clearedTickets] = await Promise.all([fetchActiveTickets(id), fetchClearedTickets(id)]);
        send(ws, 'service_joined', { serviceId: id, restaurantName: restaurant_name, mode });
        send(ws, 'init', { tickets, clearedTickets });
        break;
      }

      // Sent automatically by the client after a reconnect
      case 'rejoin_service': {
        const { rows } = await pool.query('SELECT id FROM services WHERE id = $1', [payload.serviceId]);
        if (rows.length === 0) { send(ws, 'service_ended', {}); return; }
        ws.serviceId = payload.serviceId;
        addToRoom(payload.serviceId, ws);
        const [tickets, clearedTickets] = await Promise.all([
          fetchActiveTickets(payload.serviceId),
          fetchClearedTickets(payload.serviceId),
        ]);
        send(ws, 'init', { tickets, clearedTickets });
        break;
      }

      case 'create_ticket': {
        const serviceId = ws.serviceId;
        const { table, items } = payload;
        if (!serviceId || !table || !Array.isArray(items) || items.length === 0) return;
        const ticketId = crypto.randomUUID();
        const now = Date.now();

        // Queue depth at fire = unfinished items already on the board for this
        // service, measured before this ticket is added.
        const { rows: qd } = await pool.query(
          `SELECT COUNT(*)::int AS depth
             FROM ticket_items ti
             JOIN tickets t ON t.id = ti.ticket_id
            WHERE t.service_id = $1 AND t.cleared = false AND ti.done = false`,
          [serviceId]
        );
        const queueDepth = qd[0].depth;

        const mappedItems = items.map((item, position) => ({
          id: crypto.randomUUID(),
          name: String(item.name).trim(),
          quantity: parseInt(item.quantity, 10) || 1,
          mods: item.mods ? String(item.mods).trim() : '',
          position,
          fireAt: null,
        }));
        const ticketSize = mappedItems.length;

        // Account-based restaurants schedule fires: predict each item's cook time, pick one
        // ready moment for the whole ticket, then back each item's fire off that target.
        const { rows: svc } = await pool.query('SELECT mode FROM services WHERE id = $1', [serviceId]);
        let predictedReadyAt = null;
        if (svc.length > 0 && svc[0].mode === 'full') {
          const predictions = await predictCookSeconds(mappedItems.map((i) => i.name), new Date(now).getHours());
          const maxCook = Math.max(...mappedItems.map((i) => predictions[i.name]));
          predictedReadyAt = now + maxCook * 1000;
          for (const item of mappedItems) {
            item.fireAt = predictedReadyAt - predictions[item.name] * 1000;
          }
        }

        await pool.query(
          'INSERT INTO tickets (id, service_id, table_num, created_at, prioritized, cleared, predicted_ready_at) VALUES ($1, $2, $3, $4, false, false, $5)',
          [ticketId, serviceId, String(table), now, predictedReadyAt]
        );
        // Items are considered fired when the ticket hits the board.
        for (const item of mappedItems) {
          await pool.query(
            'INSERT INTO ticket_items (id, ticket_id, name, quantity, mods, done, tagged, position, fired_at, queue_depth_at_fire, ticket_size, fire_at) VALUES ($1, $2, $3, $4, $5, false, false, $6, $7, $8, $9, $10)',
            [item.id, ticketId, item.name, item.quantity, item.mods, item.position, now, queueDepth, ticketSize, item.fireAt]
          );
        }
        broadcast(serviceId, 'ticket_created', {
          id: ticketId,
          table: String(table),
          createdAt: now,
          prioritized: false,
          predictedReadyAt,
          items: mappedItems.map((i) => ({ ...i, done: false, tagged: false })),
        });
        break;
      }

      case 'toggle_item': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        const { rows } = await pool.query(
          'SELECT done, name, fired_at, queue_depth_at_fire, ticket_size FROM ticket_items WHERE id = $1',
          [payload.itemId]
        );
        if (rows.length === 0) return;
        const item = rows[0];
        const completing = !item.done;

        if (completing) {
          const completedAt = Date.now();
          await pool.query(
            'UPDATE ticket_items SET done = true, completed_at = $1 WHERE id = $2',
            [completedAt, payload.itemId]
          );
          // An item with no fired_at has no measurable cook time, so don't log it.
          if (item.fired_at != null) {
            const firedAt = Number(item.fired_at);
            const d = new Date(firedAt);
            await pool.query(
              `INSERT INTO cook_time_logs
                 (id, item_id, item_name, fired_at, completed_at, queue_depth, ticket_size, hour_of_day, day_of_week, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                crypto.randomUUID(), payload.itemId, item.name, firedAt, completedAt,
                item.queue_depth_at_fire ?? 0, item.ticket_size ?? 1,
                d.getHours(), d.getDay(), completedAt,
              ]
            );
          }
        } else {
          // Un-bumping a single item: clear its completion and drop its stray log row.
          await pool.query(
            'UPDATE ticket_items SET done = false, completed_at = NULL WHERE id = $1',
            [payload.itemId]
          );
          await pool.query('DELETE FROM cook_time_logs WHERE item_id = $1', [payload.itemId]);
        }

        const ticket = await getTicket(payload.ticketId);
        if (ticket) broadcast(serviceId, 'ticket_updated', ticket);
        break;
      }

      case 'prioritize_ticket': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        const { rows } = await pool.query('SELECT prioritized FROM tickets WHERE id = $1', [payload.ticketId]);
        if (rows.length === 0) return;
        await pool.query('UPDATE tickets SET prioritized = $1 WHERE id = $2', [!rows[0].prioritized, payload.ticketId]);
        const ticket = await getTicket(payload.ticketId);
        if (ticket) broadcast(serviceId, 'ticket_updated', ticket);
        break;
      }

      case 'tag_item': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        const { rows } = await pool.query('SELECT tagged FROM ticket_items WHERE id = $1', [payload.itemId]);
        if (rows.length === 0) return;
        await pool.query('UPDATE ticket_items SET tagged = $1 WHERE id = $2', [!rows[0].tagged, payload.itemId]);
        const ticket = await getTicket(payload.ticketId);
        if (ticket) broadcast(serviceId, 'ticket_updated', ticket);
        break;
      }

      case 'clear_ticket': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        const clearedAt = Date.now();
        await pool.query('UPDATE tickets SET cleared = true, cleared_at = $1 WHERE id = $2', [clearedAt, payload.ticketId]);
        const ticket = await getTicket(payload.ticketId);
        if (ticket) broadcast(serviceId, 'ticket_cleared', ticket);
        break;
      }

      case 'unbump_ticket': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        await pool.query('UPDATE tickets SET cleared = false, cleared_at = NULL WHERE id = $1', [payload.ticketId]);
        // Reopening the ticket un-completes its items, so drop their training rows too.
        await pool.query(
          'DELETE FROM cook_time_logs WHERE item_id IN (SELECT id FROM ticket_items WHERE ticket_id = $1)',
          [payload.ticketId]
        );
        await pool.query('UPDATE ticket_items SET done = false, completed_at = NULL WHERE ticket_id = $1', [payload.ticketId]);
        const ticket = await getTicket(payload.ticketId);
        if (ticket) broadcast(serviceId, 'ticket_unbumped', ticket);
        break;
      }

      case 'end_service': {
        const serviceId = ws.serviceId;
        if (!serviceId) return;
        await pool.query('DELETE FROM services WHERE id = $1', [serviceId]);
        broadcast(serviceId, 'service_ended', {});
        break;
      }
    }
  });

  ws.on('close', () => removeFromRoom(ws));
});

const PORT = process.env.PORT || 3001;

setup()
  .then(() => server.listen(PORT, () => console.log(`KDS server listening on port ${PORT}`)))
  .catch((err) => { console.error('DB setup failed:', err); process.exit(1); });
