// Thin WebSocket wrapper: named events, exponential-backoff reconnection, auto-rejoin
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const handlers = new Map(); // event type -> Set<callback>
let socket = null;
let reconnectDelay = 1000;
let _serviceId = null; // remembered so we can rejoin after a reconnect

function connect() {
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    reconnectDelay = 1000;
    dispatch('connect');
    if (_serviceId) send('rejoin_service', { serviceId: _serviceId });
  };

  socket.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    dispatch(type, payload);
  };

  socket.onclose = () => {
    dispatch('disconnect');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  socket.onerror = () => socket.close();
}

function dispatch(type, payload) {
  handlers.get(type)?.forEach((cb) => cb(payload));
}

export function on(type, cb) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(cb);
}

export function off(type, cb) {
  handlers.get(type)?.delete(cb);
}

export function send(type, payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

// Called by App when the user enters a service so reconnects can auto-rejoin
export function setServiceId(id) { _serviceId = id; }
export function clearServiceId() { _serviceId = null; }

connect();
