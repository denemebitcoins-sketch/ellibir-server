import { pipCount } from '../../packages/engine/src/tavla';
import type { TavlaGameState } from '../../packages/engine/src/tavla';

/**
 * TAVLA istemci görünümü (otoriter). Tavlada GİZLİ BİLGİ YOK → tüm tahta herkese açık;
 * client kendi C# mirror motoruyla hamle vurgularını yerel hesaplar.
 * Unity JsonUtility iç içe dizi desteklemez → düz int[] alanlar.
 */
export function tavlaViewFor(state: TavlaGameState | null, seat: number): Record<string, unknown> {
  if (!state) return emptyTavlaView(seat);
  return {
    game: 'tavla',
    seat,
    spectator: seat < 0,
    gameNumber: state.gameNumber,
    targetScore: state.rules.targetScore,
    turnTimerSeconds: state.rules.turnTimerSeconds,
    turn: state.turn,
    phase: state.phase,                      // 'roll' | 'move'
    points: state.points,                    // 24 işaretli hane (+ seat0, − seat1)
    bar0: state.bar[0], bar1: state.bar[1],
    off0: state.off[0], off1: state.off[1],
    dice: state.dice,                        // [d1, d2]
    movesLeft: state.movesLeft,              // kalan zar değerleri
    openRoll: state.openRoll,                // başlama atışı (gösterim)
    gameEnded: state.gameEnded,
    matchEnded: state.matchEnded,
    gameWinner: state.gameWinner,
    mars: state.mars,
    endReason: state.endReason ?? '',
    // KATLAMA KÜPÜ + pip sayaçları
    cubeValue: state.cubeValue,
    cubeOwner: state.cubeOwner,
    pendingDouble: state.pendingDouble,
    pendingResign: state.pendingResign,
    pip0: pipCount(state, 0), pip1: pipCount(state, 1),
    matchScore: state.matchScore,            // [s0, s1]
    players: state.players.map((p) => ({ seat: p.seat, name: p.name, isBot: p.isBot })),
    logMessages: state.matchLog.slice(-60),
    // YAZBOZ: oyun başına puan (düz dizi: oyun*2).
    sheetFlat: ([] as number[]).concat(...state.gameDeltas),
    sheetCount: state.gameDeltas.length,
  };
}

export function emptyTavlaView(seat: number): Record<string, unknown> {
  return {
    game: 'tavla', seat, spectator: seat < 0,
    gameNumber: 0, targetScore: 5, turnTimerSeconds: 45,
    turn: -1, phase: 'roll',
    points: new Array(24).fill(0), bar0: 0, bar1: 0, off0: 0, off1: 0,
    dice: [0, 0], movesLeft: [], openRoll: [0, 0],
    gameEnded: false, matchEnded: false, gameWinner: -1, mars: false, endReason: '',
    cubeValue: 1, cubeOwner: -1, pendingDouble: -1, pendingResign: -1, pip0: 0, pip1: 0,
    matchScore: [0, 0], players: [], logMessages: [],
    sheetFlat: [], sheetCount: 0,
  };
}
