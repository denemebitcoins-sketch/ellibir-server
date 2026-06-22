import { startServer } from './wsServer.js';

const port = Number(process.env.PORT ?? 2567);
startServer(port);
console.log(`51 otorite sunucu hazır → ws://localhost:${port}`);
console.log('İstemci bağlanınca koltuk 0 = insan, 1-3 = bot. Server-authoritative.');
