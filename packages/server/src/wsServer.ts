import { WebSocketServer, type WebSocket } from 'ws';
import { GameSession } from './session.js';
import { toClientView } from './clientView.js';
import { groupIntoMelds, groupIntoPairs, arrangeHand } from './grouping.js';
import { canSor, legalExtendTargets } from '../../engine/src/game';
import { bestOpening, bestPairOpening } from '../../engine/src/insight';

/**
 * İnce WebSocket katmanı — her bağlantıya botlara karşı bir GameSession
 * (koltuk 0 = insan) verir. Bütün doğrulama motorda (server-authoritative).
 * Protokol (JSON):
 *   istemci→sunucu: {t:'move', move:Move} | {t:'continue'}
 *   sunucu→istemci: {t:'view', view:ClientView} | {t:'error', message}
 * (Oda/eşleştirme/yeniden-bağlanma gerçek çok-oyuncu fazında Colyseus ile.)
 */
export function startServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket) => {
    const seat = 0;
    const session = new GameSession({ humanSeats: [seat] });

    const send = (obj: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    let dizMode: 'none' | 'seri' | 'cift' = 'none';
    const pushView = () => {
      const view = session.view(seat);
      let order = view.hand;
      let gaps: number[] = [];
      if (dizMode !== 'none') {
        const a = arrangeHand(view.hand, session.raw.rules, dizMode);
        order = a.order;
        gaps = a.gapAfter;
      }
      send({
        t: 'view',
        view: toClientView(view, session.raw.matchWinnerSeat ?? -1, canSor(session.raw, seat), order, gaps),
      });
    };

    pushView();

    ws.on('message', (data) => {
      let msg: {
        t?: string;
        move?: import('../../engine/src/types').Move;
        cards?: string[];
        meldId?: string;
        cardId?: string;
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        const rules = session.raw.rules;
        const pick = (ids: string[] | undefined) => {
          const set = new Set(ids ?? []);
          return session.view(seat).hand.filter((c) => set.has(c.id));
        };
        switch (msg.t) {
          case 'move':
            if (msg.move) session.applyHumanMove(seat, msg.move);
            break;
          case 'continue':
            session.continueNextHand();
            break;
          case 'dizSeri':
            dizMode = 'seri';
            break;
          case 'dizCift':
            dizMode = 'cift';
            break;
          case 'openSelected': {
            const g = groupIntoMelds(pick(msg.cards), rules);
            if (!g) throw new Error('Seçili kartlar geçerli açış (seri/küt) oluşturmuyor');
            session.applyHumanMove(seat, { type: 'open', melds: g });
            break;
          }
          case 'openPairsSelected': {
            const g = groupIntoPairs(pick(msg.cards), rules);
            if (!g) throw new Error('Seçili kartlar geçerli çiftler oluşturmuyor');
            session.applyHumanMove(seat, { type: 'openPairs', pairs: g });
            break;
          }
          case 'meldSelected': {
            const g = groupIntoMelds(pick(msg.cards), rules);
            if (!g) throw new Error('Seçili kartlar geçerli per oluşturmuyor');
            for (const grp of g) session.applyHumanMove(seat, { type: 'meld', cards: grp });
            break;
          }
          case 'extend':
            if (msg.meldId && msg.cardId)
              session.applyHumanMove(seat, { type: 'extend', meldId: msg.meldId, cardId: msg.cardId });
            break;
          // SERİ AÇ (RN autoOpenSeri): açmadıysam en iyi seri/küt açışı; açtıysam indir.
          case 'autoOpenSeri': {
            const hand = session.view(seat).hand;
            const plan = bestOpening(hand, rules);
            if (plan.melds.length === 0) throw new Error('Açılacak/indirilecek seri-küt yok');
            const ids = plan.melds.map((g) => g.map((c) => c.id));
            if (!session.raw.players[seat]!.hasOpened) {
              session.applyHumanMove(seat, { type: 'open', melds: ids });
            } else {
              for (const g of ids) session.applyHumanMove(seat, { type: 'meld', cards: g });
            }
            break;
          }
          // ÇİFT AÇ (RN autoOpenCift): açmadıysam çiftle açış; açtıysam çift indir.
          case 'autoOpenCift': {
            const hand = session.view(seat).hand;
            const plan = bestPairOpening(hand, rules);
            if (plan.pairs.length === 0) throw new Error('Açılacak/indirilecek çift yok');
            if (!session.raw.players[seat]!.hasOpened) {
              session.applyHumanMove(seat, { type: 'openPairs', pairs: plan.pairs });
            } else {
              for (const p of plan.pairs) session.applyHumanMove(seat, { type: 'meld', cards: p });
            }
            break;
          }
          // İŞLE: seçili tek kartı masadaki yasal bir pere ekle (extend).
          case 'isle': {
            if (!msg.cardId) break;
            const targets = legalExtendTargets(session.raw, seat, msg.cardId);
            if (targets.length === 0) throw new Error('Bu kart hiçbir pere işlenemiyor');
            session.applyHumanMove(seat, { type: 'extend', meldId: targets[0]!, cardId: msg.cardId });
            break;
          }
          default:
            return;
        }
        pushView();
      } catch (e) {
        send({ t: 'error', message: e instanceof Error ? e.message : 'bilinmeyen hata' });
        pushView(); // istemci geçerli duruma geri senkronlanır
      }
    });
  });

  return wss;
}
