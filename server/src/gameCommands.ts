// Client (LocalNet/ServerNet) protokolü → engine Move çevirisi + sorgu/bot otomasyonu.
// Edge fonksiyonundaki referee mantığının birebir portu (DB/HTTP katmanı hariç).
import {
  applyMove, startNextHand, viewFor, legalExtendTargets,
  openingThreshold, pairsOpeningMin, canExtend, canRetrieveJoker,
} from '../../packages/engine/src/game';
import { bestOpening, bestPairOpening } from '../../packages/engine/src/insight';
import { solveHand } from '../../packages/engine/src/solver';
import { analyzeCards, meldPoints } from '../../packages/engine/src/melds';
import { partitionSelectedMelds } from '../../packages/engine/src/solver';
import { HeuristicBot } from '../../packages/engine/src/bot';
import { sortHandOrder, reconcileHandOrder } from './clientView';

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
    if (player?.hasOpened) {
      // Açıktan sonra: seçili kartlar TEK yeni perde indirilir (engine meld doğrular).
      state = applyMove(state, { type: 'meld', cards: cmd.cards });
    } else {
      // AÇIŞ: seçili kart id'leri ÇOKLU geçerli per/küt grubuna BÖLÜNÜR (client PartitionMelds
      // karşılığı). Tek grup olarak göndermek (eski hata) seri+küt karışık seçimi geçersiz
      // kılıp engine'i reddettiriyordu (client 101 puan görse de). Her grup ayrı meld açılır.
      const byId = new Map((player?.hand ?? []).map((c: any) => [c.id, c]));
      const selCards = (cmd.cards as string[]).map((id) => byId.get(id)).filter(Boolean);
      if (selCards.length !== cmd.cards.length) throw new CmdError('invalid_move', 'Seçili kart elde değil.');
      const groups = partitionSelectedMelds(selCards, state.rules);
      if (!groups) {
        throw new CmdError('insufficientOpen', 'Seçili kartlar geçerli per/küt gruplarına bölünemedi.');
      }
      state = applyMove(state, { type: 'open', melds: groups.map((g) => g.map((c: any) => c.id)) });
    }

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
    // SADECE görsel sıralama (dizModes). Çift OLMAK kurallıdır (çiftle açma / pickup /
    // sorgu) — "çift diz" demek çift YAPMAZ; isCift'e dokunulmaz.
    const mode = cmd.t === 'dizSeri' ? 'seri' : 'cift';
    state.dizModes = state.dizModes || {};
    state.dizModes[seat] = mode;
    // handOrder'ı GERÇEKTEN gruplu sıraya getir: artık clientView her view'da re-sort
    // YAPMAZ; el sırası handOrder'ı izler. Bir kez gruplanır, sonra korunur (çekilen sona).
    try {
      const player = state.players?.find((p: any) => p.seat === seat);
      if (player && Array.isArray(player.hand)) {
        const grouped = sortHandOrder(player.hand, state.rules, mode);
        const ids = new Set(player.hand.map((c: any) => c.id));
        if (grouped.length === player.hand.length && grouped.every((id: string) => ids.has(id))) {
          state.handOrder = state.handOrder || {};
          state.handOrder[seat] = grouped;
        }
      }
    } catch { /* sırasız bırak */ }
    skipBots = true;

  } else if (cmd.t === 'leave') {
    state.abandoned = Array.isArray(state.abandoned) ? state.abandoned : [];
    if (!state.abandoned.includes(seat)) state.abandoned.push(seat);
    state.abandonedAt = state.abandonedAt || {};
    state.abandonedAt[seat] = Date.now();

  } else if (cmd.t === 'rejoin') {
    if (state.phase === 'matchEnded') throw new CmdError('match_ended');
    // 3 dk geçtiyse koltuk geri alınamaz (Edge ile parite).
    const at = state.abandonedAt?.[seat];
    if (at && Date.now() - at > 180000) throw new CmdError('reconnect_timeout');
    state.abandoned = (state.abandoned || []).filter((s: number) => s !== seat);
    skipBots = true;

  } else {
    return { state, skipBots, noop: true };
  }
  // Her hamleden sonra acting seat'in handOrder'ını reconcile et: çekilen/alınan YENİ
  // kart EN SONA eklenir, oynanan kartlar düşer, mevcut dizilim korunur (C# ReconcileOrder).
  // (dizSeri/dizCift zaten handOrder'ı gruplu yazdı; reconcile sırayı bozmaz, sadece doğrular.)
  try { reconcileHandOrder(state, seat); } catch { /* yoksay */ }
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
  // Kararı BOT'un kendi mantığı (HeuristicBot.nextMove → sorguVer) verir; burada
  // hardcoded 'verme' YOK (eski kod hasOpened değilse hep 'verme' diyordu — KÖK BUG).
  if (state.sorgu) {
    const sg = state.sorgu;
    let decider: number;
    if (sg.asama === 'ortakGorus') decider = sg.partnerSeat;
    else if (sg.asama === 'cevap') decider = sg.sorulanSeat;
    else decider = sg.askerSeat;
    if (isHumanTurn(decider) && !abandoned.includes(decider)) return { state, moved: false };
    // Karar koltuğunun gözünden bot kararını üret (insan değilse).
    const view = viewFor(state, decider);
    try {
      return { state: applyMove(state, _bot.nextMove(view)), moved: true };
    } catch (e: any) {
      console.error('[stepOnce] sorgu bot hatası asama=%s seat=%d: %s', sg.asama, decider, e?.message);
      // Güvenli fallback: oyunu kilitleme — eski deterministik davranış.
      const sorulanP = state.players?.find((p: any) => p.seat === sg.sorulanSeat);
      const fb =
        sg.asama === 'ortakGorus' ? { type: 'sorguOrtakGorus', gorus: sorulanP?.hasOpened ? 'ver' : 'verme' }
        : sg.asama === 'cevap' ? { type: 'sorguCevap', cevap: (sorulanP?.hasOpened || sg.partnerGorus === 'ver') ? 'ver' : 'verme' }
        : { type: 'sorguSonuc', al: false };
      try { return { state: applyMove(state, fb), moved: true }; }
      catch { return { state, moved: false }; }
    }
  }

  // Normal sıra: bot/terk koltuğu bir hamle yapar.
  if (state.phase === 'draw' || state.phase === 'action') {
    if (isHumanTurn(state.currentSeat) && !abandoned.includes(state.currentSeat)) return { state, moved: false };
    const seat = state.currentSeat;
    const view = viewFor(state, seat);
    // TAKILMA GÜVENLİĞİ: bot hamlesi/uygulaması exception fırlatırsa oyun DONMASIN —
    // güvenli bir fallback hamleyle ilerle. Aksi halde runEngine try-catch'e düşüp döngü ölürdü.
    try {
      return { state: applyMove(state, _bot.nextMove(view)), moved: true };
    } catch (e: any) {
      console.error('[stepOnce] bot hamlesi hatası seat=%d phase=%s: %s', seat, state.phase, e?.message);
      const fb = safeFallbackMove(state, view);
      if (fb) {
        try { return { state: applyMove(state, fb), moved: true }; }
        catch (e2: any) { console.error('[stepOnce] fallback de başarısız: %s', e2?.message); }
      }
      // Hiçbir güvenli hamle uygulanamadı → moved:false (sonsuz döngüye girme).
      return { state, moved: false };
    }
  }

  return { state, moved: false };
}

/**
 * Bot hamlesi patladığında oyunu ilerletecek EN GÜVENLİ hamle.
 * draw fazında destedem çek; action fazında zorunlu kart hariç legal ilk ıskarta.
 * (Kuralları değiştirmez; yalnız motorun KESİN kabul edeceği bir hamle seçer.)
 */
function safeFallbackMove(state: any, view: any): any | null {
  if (state.phase === 'draw') return { type: 'drawStock' };
  if (state.phase === 'action') {
    const zorunluId = view?.pickup?.zorunlu ? view.pickup.cardId : null;
    const hand: any[] = Array.isArray(view?.hand) ? view.hand : [];
    // Joker olmayan, zorunlu olmayan ilk kart; yoksa zorunlu olmayan ilk kart.
    const cand = hand.find((c) => !c.joker && c.id !== zorunluId)
      ?? hand.find((c) => c.id !== zorunluId);
    if (cand) return { type: 'discard', cardId: cand.id };
  }
  return null;
}
