import { WebSocket } from 'ws';
import { startServer } from './wsServer.js';
import type { ClientView } from './clientView.js';

/**
 * WS taşıma duman testi: sunucuyu başlat, bir istemci bağla, basit bir
 * strateji (çek → ilk kartı at) ile birkaç tur oyna. Amaç ZEKÂ değil, AĞ
 * GİDİŞ-DÖNÜŞÜNÜ + ClientView DTO'sunu doğrulamak (motor + bot mantığı zaten
 * GameSession duman testinde kanıtlı). Botlar diğer koltukları oynar.
 */
const PORT = 2599;
const MAX_ACTIONS = 60;

function main(): void {
  const wss = startServer(PORT);
  const ws = new WebSocket(`ws://localhost:${PORT}`);

  let actions = 0;
  let views = 0;
  let sawHandEnd = false;
  let errors = 0;

  const finish = (msg: string, code: number) => {
    try { ws.close(); } catch { /* yoksay */ }
    wss.close(() => process.exit(code));
    // close geri çağrısı gecikirse zorla
    setTimeout(() => process.exit(code), 500);
    console.log(msg);
  };

  ws.on('open', () => console.log(`bağlandı → ws://localhost:${PORT}`));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as
      | { t: 'view'; view: ClientView }
      | { t: 'error'; message: string };

    if (msg.t === 'error') {
      errors++;
      console.log(`  (sunucu reddi: ${msg.message})`);
      return; // ardından view de gelir
    }
    if (msg.t !== 'view') return;

    views++;
    const v = msg.view;

    if (v.phase === 'matchEnded') {
      finish(
        `\n✅ WS uçtan uca OK · view=${views} insanHamlesi=${actions} elSonuGörüldü=${sawHandEnd} ` +
          `red=${errors} · kazanan koltuk=${v.matchWinnerSeat}`,
        0,
      );
      return;
    }

    if (v.phase === 'handEnded') {
      sawHandEnd = true;
      ws.send(JSON.stringify({ t: 'continue' }));
      return;
    }

    if (actions >= MAX_ACTIONS) {
      finish(
        `\n✅ WS uçtan uca OK (${MAX_ACTIONS} hamle sınırına ulaşıldı) · view=${views} ` +
          `elSonuGörüldü=${sawHandEnd} red=${errors} · el ${v.handNumber}/${v.totalHands} stok=${v.stockCount}`,
        0,
      );
      return;
    }

    if (!v.yourTurn) {
      // settle() bot sıralarını çoktan oynattı; insan değilse ve faz oyun-içiyse
      // burada durmamalı. Güvenlik: yoksay.
      return;
    }

    // Basit istemci: çek → at.
    if (v.phase === 'draw') {
      ws.send(JSON.stringify({ t: 'move', move: { type: 'drawStock' } }));
      actions++;
    } else if (v.phase === 'action') {
      // Eldeki HERHANGİ bir kartı at (turu bitirir). Joker'i en sona bırak.
      const card = v.myHand.find((c) => !c.joker) ?? v.myHand[0];
      if (!card) {
        finish('HATA: elde kart yok ama action fazı', 1);
        return;
      }
      ws.send(JSON.stringify({ t: 'move', move: { type: 'discard', cardId: card.id } }));
      actions++;
    }
  });

  ws.on('error', (e) => finish(`HATA (ws): ${String(e)}`, 1));

  setTimeout(() => finish('HATA: zaman aşımı (maç ilerlemedi)', 1), 20000);
}

main();
