// Manager auth over REST. The session token is stored in localStorage so the
// manager stays logged in across visits. The live KDS still runs over WebSocket;
// this module only handles signup / login / restaurant setup.
const TOKEN_KEY = 'kds_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function request(path, { method = 'GET', body, authed = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (authed) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export async function signup(username, password) {
  const data = await request('/api/signup', { method: 'POST', body: { username, password } });
  setToken(data.token);
  return data; // { token, username, restaurant: null }
}

export async function login(username, password) {
  const data = await request('/api/login', { method: 'POST', body: { username, password } });
  setToken(data.token);
  return data; // { token, username, restaurant }
}

export async function createRestaurant(restaurantName) {
  const data = await request('/api/restaurant', { method: 'POST', body: { restaurantName }, authed: true });
  return data.restaurant; // { serviceId, pin, restaurantName }
}

// Validate the stored token and fetch this account's restaurant (or null). Clears a dead token.
export async function fetchRestaurant() {
  if (!getToken()) return null;
  try {
    const data = await request('/api/restaurant', { authed: true });
    return data.restaurant;
  } catch {
    clearToken();
    return null;
  }
}

// Returns the restaurant's menu as [{ name, cookSeconds }].
export async function fetchMenu() {
  const data = await request('/api/menu', { authed: true });
  return data.menu;
}

// Replaces the whole menu. Returns the saved (validated) menu.
export async function saveMenu(items) {
  const data = await request('/api/menu', { method: 'PUT', body: { items }, authed: true });
  return data.menu;
}

export async function logout() {
  if (getToken()) {
    try { await request('/api/logout', { method: 'POST', authed: true }); } catch { /* ignore */ }
  }
  clearToken();
}
