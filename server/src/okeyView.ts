import { elMultOf } from '../../packages/engine/src/okey';
import type { OkeyGameState } from '../../packages/engine/src/okey';
import { VIEW_VERSION } from './viewContract';

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
    viewVersion: VIEW_VERSION,
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
    // BANKO varyantı
    variant: state.rules.variant ?? 'duz',
    elMult: state.rules.variant === 'banko' ? elMultOf(state) : 0,
    bankoUsed: state.bankoUsed ?? [false, false, false, false],
    bankoPending: state.bankoPending ?? [false, false, false, false],
    bankoPhase: state.bankoPhase ?? false,
    bankoChoice: state.bankoChoice ?? [-1, -1, -1, -1],
    bankoThisEl: state.bankoThisEl ?? [false, false, false, false],
    // SEÇİM FAZINDA dağıtılacak elin dağıtıcısı (startNextEl elNumber>1'de döndürür; 15 taş ona
    // gider — stratejik bilgi, listede gösterilir).
    bankoDealer: state.elNumber >= 1 ? (state.dealerSeat + 1) % 4 : state.dealerSeat,
    sheetBankoFlat: ([] as number[]).concat(...(state.bankoRows ?? [])),
    myHand: seat >= 0 && me ? me.hand.map(mapTile) : [],
    // GÖSTERGE butonu koşulu (kullanıcı: ilk taş atıldıktan sonra buton GÖRÜNMESİN):
    myShowedGosterge: !!(me && me.showedGosterge),
    myDiscardCount: me ? me.discardCount : 0,
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
    // YAZBOZ: el başına puan değişimi (düz dizi: el*4) — 51 yazboz tablosunun okey karşılığı.
    sheetFlat: ([] as number[]).concat(...state.elDeltas),
    sheetCount: state.elDeltas.length,
  };
}

export function emptyOkeyView(seat: number): Record<string, unknown> {
  return {
    viewVersion: VIEW_VERSION,
    game: 'okey', seat, spectator: seat < 0,
    elNumber: 0, totalEls: 0, teamMode: false, dealerSeat: 0,
    turn: -1, phase: 'draw', elEnded: false, matchEnded: false, elWinner: -2, finishKind: '',
    scores: [0, 0, 0, 0], startScore: 0, turnTimerSeconds: 30,
    gosterge: null, okeyColor: 'R', okeyRank: 1, stockCount: 0,
    variant: 'duz', elMult: 0, bankoUsed: [false, false, false, false], bankoPending: [false, false, false, false], bankoThisEl: [false, false, false, false], bankoPhase: false, bankoChoice: [-1, -1, -1, -1], bankoDealer: 0, sheetBankoFlat: [],
    myHand: [], myShowedGosterge: false, myDiscardCount: 0,
    disc0: [], disc1: [], disc2: [], disc3: [], players: [], winnerHand: [], logMessages: [],
    sheetFlat: [], sheetCount: 0,
  };
}
