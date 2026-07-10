// Colyseus core 0.17 reconnect path checks WebSocket.OPEN.
// ws-transport already uses ws; keep it as an explicit runtime dependency so reconnect
// cannot silently degrade when Colyseus changes its transitive dependency tree.
const NodeWebSocket = require('ws');
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = NodeWebSocket;
}
