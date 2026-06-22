// Client (LocalNet/ServerNet) protokolü → engine Move çevirisi + sorgu/bot otomasyonu.
// Edge fonksiyonundaki referee mantığının birebir portu (DB/HTTP katmanı hariç).
import {
  applyMove, startNextHand, viewFor, legalExtendTargets,
  openingThreshold, pairsOpeningMin, canExtend, canRetrieveJoker,
} from '../../packages/engine/src/game';
import { bestOpening, bestPairOpening } from '../../packages/engine/src/insight';
import { solveHand } from '../../packages/engine/src/solver';
import { analyzeCards, meldPoints } from '../../packages/engine/src/melds';
import { HeuristicBot } from '../../packages/engine/src/bot';
import { sortHandOrder } from './clientView';

export class CmdError extends Error {
  constructor(public code: string, msg?: string) { super(msg ?? code); this.name = 'CmdError'; }
}

export interface CmdResult { state: any; skipBots: boolean; noop?: boolean; }

/** Tek client komutunu uygula. cors({error}) → throw CmdError; cors({noop}) → noop:true. */
export function applyClientCommand(state: any, cmd: any, seat: number): CmdResult {
  let skipBots = false;
  const turnGuard = () => { if (state.currentSeat !== seat) throw new CmdError('not_your_turn'); };

  if (cmd.t === 'continue') {
    if (state.phase !== 'handEnded') throw new CmdError('wrong_phase');
    state = startNextHand(state);

  } else if (cmd.t === 'newGame') {
    throw new CmdError('not_implemented');

  } else if (cmd.t === 'move') {
    if (!cmd.move || typeof cmd.move !== 'object') throw new CmdError('invalid_move');
    const mt = cmd.move.type;
    const isSorgu = mt === 'sor' || mt === 'sorguOrtakGorus' || mt === 'sorguCevap' || mt === 'sorguSonuc';
    if (!isSorgu && state.currentSeat !== seat) throw new CmdError('not_your_turn');
    state = applyMove(state, cmd.move);

  } else if (cmd.t === 'playJoker') {
    turnGuard();
    if (typeof cmd.meldId !== 'string' || typeof cmd.cardId !== 'string') throw new CmdError('invalid_move');
    state = applyMove(state, { type: 'extend', meldId: cmd.meldId, cardId: cmd.cardId, preferLeft: cmd.end === 'left' });

  } else if (cmd.t === 'openSelected') {
    turnGuard();
    if (!Array.isArray(cmd.cards)) throw new CmdError('invalid_move');
    const player = state.players?.find((p: any) => p.seat === seat);
    if (player?.hasOpened) state = applyMove(state, { type: 'meld', cards: cmd.cards });
    else state = applyMove(state, { type: 'open', melds: [cmd.cards] });

  } else if (cmd.t === 'play') {
    turnGuard();
    if (typeof cmd.meldId !== 'string' || typeof cmd.cardId !== 'string') throw new CmdError('invalid_move');
    const meld = state.melds?.find((m: any) => m.id === cmd.meldId);
    const player = state.players?.find((p: any) => p.seat === seat);
    const card = player?.hand?.find((c: any) => c.id === cmd.cardId);
    if (!meld || !card) throw new CmdError('invalid_move');
    if (canExtend(meld, card, state.rules) != null) {
      state = applyMove(state, { type: 'extend', meldId: cmd.meldId, cardId: cmd.cardId });
    } else if (canRetrieveJoker(meld, card, state.rules) != null) {
      state = applyMove(state, { type: 'retrieveJoker', meldId: cmd.meldId, cardId: cmd.cardId });
    } else throw new CmdError('illegal_play');

  } else if (cmd.t === 'extend') {
    turnGuard();
    if (typeof cmd.meldId !== 'string' || typeof cmd.cardId !== 'string') throw new CmdError('invalid_move');
    state = applyMove(state, { type: 'extend', meldId: cmd.meldId, cardId: cmd.cardId });

  } else if (cmd.t === 'isle') {
    turnGuard();
    if (typeof cmd.cardId !== 'string') throw new CmdError('invalid_move');
    const targets = legalExtendTargets(state, seat, cmd.cardId);
    if (targets.length === 0) throw new CmdError('no_legal_target');
    state = applyMove(state, { type: 'extend', meldId: targets[0], cardId: cmd.cardId });

  } else if (cmd.t === 'autoOpenSeri' || cmd.t === 'autoOpenCift') {
    turnGuard();
    const player = state.players?.find((p: any) => p.seat === seat);
    if (!player) throw new CmdError('invalid_move');
    // Açışa joker DAHİL — joker'e bağımlı seriler de sayılır (yoksa açış puanı düşüp açamıyordu).
    const handCards = player.hand ?? [];
    const isCift = cmd.t === 'autoOpenCift';
    if (!player.hasOpened) {
      if (isCift) {
        const plan = bestPairOpening(handCards, state.rules);
        if (plan.count >= pairsOpeningMin(state) && plan.pairs.length > 0) {
          state = applyMove(state, { type: 'openPairs', pairs: plan.pairs });
        } else throw new CmdError('insufficientOpen', 'Açış için yeterli puanın yok.');
      } else {
        const plan = bestOpening(handCards, state.rules);
        if (plan.points >= openingThreshold(state) && plan.melds.length > 0) {
          const melds = plan.melds.map((g: any[]) => g.map((c: any) => c.id));
          state = applyMove(state, { type: 'open', melds });
        } else throw new CmdError('insufficientOpen', 'Açış için yeterli puanın yok.');
      }
    } else {
      const solved = solveHand(handCards, state.rules, 'cards');
      let remaining = (player.hand ?? []).length;
      for (const meld of solved.melds) {
        if (meld.length >= remaining) break;
        try { state = applyMove(state, { type: 'meld', cards: meld.map((c: any) => c.id) }); remaining -= meld.length; }
        catch { break; }
      }
    }

  } else if (cmd.t === 'openExceptJoker') {
    turnGuard();
    const player = state.players?.find((p: any) => p.seat === seat);
    if (!player) throw new CmdError('invalid_move');
    if (player.hasOpened) return { state, skipBots: true, noop: true };
    const excludeId = cmd.cardId;
    const ex = (player.hand ?? []).find((c: any) => c.id === excludeId);
    if (!ex || !ex.joker) return { state, skipBots: true, noop: true };
    const orderedIds = sortHandOrder(player.hand, state.rules, 'seri');
    const byId = new Map((player.hand ?? []).map((c: any) => [c.id, c]));
    const ordered = orderedIds.map((id: string) => byId.get(id)).filter((c: any) => c && c.id !== excludeId);
    const groups: any[][] = [];
    let gi = 0;
    while (gi < ordered.length) {
      let bestLen = 0;
      for (let len = 3; gi + len <= ordered.length; len++) {
        if (analyzeCards(ordered.slice(gi, gi + len), state.rules)) bestLen = len; else break;
      }
      if (bestLen >= 3) { groups.push(ordered.slice(gi, gi + bestLen)); gi += bestLen; } else gi++;
    }
    const total = groups.reduce((s, g) => s + (meldPoints(g, state.rules) ?? 0), 0);
    if (groups.length === 0 || total < openingThreshold(state)) return { state, skipBots: true, noop: true };
    state = applyMove(state, { type: 'open', melds: groups.map((g) => g.map((c: any) => c.id)) });

  } else if (cmd.t === 'dizSeri' || cmd.t === 'dizCift') {
    state.dizModes = state.dizModes || {};
    state.dizModes[seat] = cmd.t === 'dizSeri' ? 'seri' : 'cift';
    skipBots = true;

  } else if (cmd.t === 'leave') {
    state.abandoned = Array.isArray(state.abandoned) ? state.abandoned : [];
    if (!state.abandoned.includes(seat)) state.abandoned.push(seat);
    state.abandonedAt = state.abandonedAt || {};
    state.abandonedAt[seat] = Date.now();

  } else if (cmd.t === 'rejoin') {
    if (state.phase === 'matchEnded') throw new CmdError('match_ended');
    state.abandoned = (state.abandoned || []).filter((s: number) => s !== seat);
    skipBots = true;

  } else {
    return { state, skipBots, noop: true };
  }
  return { state, skipBots };
}

const _bot = new HeuristicBot('normal');

/**
 * TEK motor adımı: bir sorgu yanıtı VEYA bir bot hamlesi uygula.
 * moved=false → bağlı insanın sırası / oynanacak bir şey yok (dur).
 * EllibirRoom bunu döngüde çağırıp her adımı GECİKMELİ ayrı view olarak push eder
 * (botların çekip atması istemcide animasyonlu görünür).
 */
export function stepOnce(state: any, isHumanTurn: (seat: number) => boolean): { state: any; moved: boolean } {
  const abandoned: number[] = Array.isArray(state.abandoned) ? state.abandoned : [];

  // SORGU: karar bir bot'ta/terk'te ise otomatik yanıtla.
  if (state.sorgu) {
    const sg = state.sorgu;
    const sorulanP = state.players?.find((p: any) => p.seat === sg.sorulanSeat);
    let decider: number; let moveObj: any;
    if (sg.asama === 'ortakGorus') {
      decider = sg.partnerSeat;
      moveObj = { type: 'sorguOrtakGorus', gorus: sorulanP?.hasOpened ? 'ver' : 'verme' };
    } else if (sg.asama === 'cevap') {
      decider = sg.sorulanSeat;
      const ver = sorulanP?.hasOpened || sg.partnerGorus === 'ver';
      moveObj = { type: 'sorguCevap', cevap: ver ? 'ver' : 'verme' };
    } else {
      decider = sg.askerSeat; moveObj = { type: 'sorguSonuc', al: false };
    }
    if (isHumanTurn(decider) && !abandoned.includes(decider)) return { state, moved: false };
    return { state: applyMove(state, moveObj), moved: true };
  }

  // Normal sıra: bot/terk koltuğu bir hamle yapar.
  if (state.phase === 'draw' || state.phase === 'action') {
    if (isHumanTurn(state.currentSeat) && !abandoned.includes(state.currentSeat)) return { state, moved: false };
    return { state: applyMove(state, _bot.nextMove(viewFor(state, state.currentSeat))), moved: true };
  }

  return { state, moved: false };
}
