import type { OkeyGameState } from '../../packages/engine/src/okey';

/**
 * OKEY istemci görünümü (otoriter): kendi elin AÇIK, rakiplerin yalnız TAŞ SAYISI.
 * Atık yığınları/gösterge/kalan herkese açık. El bitince kazananın eli HERKESE açılır
 * (client "nasıl bitti" mini-ıstakasını çizer). 51 clientView ile aynı ilkeler.
 */

const mapTile = (t: any) => t == null ? null : { id: t.id ?? '', fake: !!t.fake, color: t.fake ? '' : t.color, rank: t.fake ? 0 : t.rank };

export function okeyViewFor(state: OkeyGameState | null, seat: number): Record<string, unknown> {
  if (!state) return emptyOkeyView(seat);
  const me = state.players.find((p) => p.seat === seat);
  return {
    game: 'okey',
    seat,
    spectator: seat < 0,
    elNumber: state.elNumber,
    totalEls: state.rules.totalEls,
    teamMode: state.rules.teamMode,
    dealerSeat: state.dealerSeat,
    turn: state.turn,
    phase: state.phase,
    elEnded: state.elEnded,
    matchEnded: state.matchEnded,
    elWinner: state.elWinner ?? -2,
    finishKind: state.finishKind ?? '',
    scores: state.scores,
    startScore: state.rules.scoring.startScore,
    turnTimerSeconds: state.rules.turnTimerSeconds,
    gosterge: mapTile(state.gosterge),
    okeyColor: state.okeyColor,
    okeyRank: state.okeyRank,
    stockCount: state.stock.length,
    myHand: seat >= 0 && me ? me.hand.map(mapTile) : [],
    // Unity JsonUtility iç içe dizi desteklemez → koltuk başına DÜZ alanlar.
    disc0: state.discards[0]!.map(mapTile),
    disc1: state.discards[1]!.map(mapTile),
    disc2: state.discards[2]!.map(mapTile),
    disc3: state.discards[3]!.map(mapTile),
    players: state.players.map((p) => ({
      seat: p.seat, name: p.name, isBot: p.isBot,
      tileCount: p.hand.length, showedGosterge: p.showedGosterge,
    })),
    // El bitti → kazananın eli HERKESE açık (bitiş gösterimi).
    winnerHand: state.elEnded && state.elWinner != null && state.elWinner >= 0
      ? state.players.find((p) => p.seat === state.elWinner)!.hand.map(mapTile) : [],
    logMessages: state.matchLog.slice(-60),
  };
}

export function emptyOkeyView(seat: number): Record<string, unknown> {
  return {
    game: 'okey', seat, spectator: seat < 0,
    elNumber: 0, totalEls: 0, teamMode: false, dealerSeat: 0,
    turn: -1, phase: 'draw', elEnded: false, matchEnded: false, elWinner: -2, finishKind: '',
    scores: [0, 0, 0, 0], startScore: 0, turnTimerSeconds: 30,
    gosterge: null, okeyColor: 'R', okeyRank: 1, stockCount: 0,
    myHand: [], disc0: [], disc1: [], disc2: [], disc3: [], players: [], winnerHand: [], logMessages: [],
  };
}
