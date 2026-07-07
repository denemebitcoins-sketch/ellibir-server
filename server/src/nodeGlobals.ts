// Colyseus core 0.17 reconnect path checks `WebSocket.OPEN`.
// Node does not expose WebSocket globally in all runtimes, while ws-transport uses `ws`.
try {
  const NodeWebSocket = require('ws');
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = NodeWebSocket;
  }
} catch {
  // If ws resolution ever changes, keep startup alive; reconnect tests will reveal it.
}
