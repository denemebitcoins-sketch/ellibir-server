import type { GameState, HandResult, PenaltyBreakdown, SheetEntry } from './types';
import { handCardPenalty } from './melds';

/**
 * El sonu skorlaması — HİBRİT model, TEK FORMÜL, İSTİSNASIZ (RULES.md 1.7):
 *   ceza = taban × (bitirenÇiftMi?×) × (okeyleBitişMi?×) × (yiyenÇiftMi?×)
 * Taban: ödeyen AÇMIŞSA elinde kalan kart puanı (As 11, K/Q/J 10, okey 50);
 * AÇMAMIŞSA sabit KAFA_CEZASI. `katlamali` bayrağı çarpanları ETKİLEMEZ
 * (o bayrak Paket 6'da 1.8 açış-çıtası sistemi olarak tanımlanacak).
 *
 * EŞLİ (teamMode): bitirenin ortağı, durumu ne olursa olsun CEZA YEMEZ —
 * bitiş takım adınadır; diğer ödeyenler kendi tabanlarından hesaplanır.
 *
 * DESTE BİTTİ (winnerSeat=null) — bitiren yok, rakip okey/çift çarpanı YOK:
 *  - KESİN ÇİFT (isCift) → tabanı × CARPAN_YIYEN_CIFT; taban açmışsa elde kalan,
 *    açamamışsa kelle cezası (örn açık 31×2=62; kapalı 100×2=200);
 *  - açmış (çift değil) → elde kalan; kapalı → kelle cezası (100/200).
 */
export function computeHandResult(
  state: GameState,
  winnerSeat: number | null,
  handFinish: boolean,
  okeyFinish: boolean,
): HandResult {
  const { rules } = state;
  const pairFinish =
    winnerSeat !== null && state.players[winnerSeat]?.openMode === 'pairs';

  const breakdown: PenaltyBreakdown[] = [];
  const penalties = state.players.map(() => 0);

  const handPoints = (player: GameState['players'][number]): number =>
    player.hand.reduce((sum, c) => sum + handCardPenalty(c, rules), 0);

  // KELLE CEZASI (kullanıcı kuralı): kapalı oyuncunun tabanı — KAFA (hiç kimse
  // açmadı/çift yok) → 200; en az biri açtıysa/çiftse → 100. Bitiş şeklinden
  // (biri bitirdi / deste tükendi) ve moddan (tekli/eşli) BAĞIMSIZ tek kural.
  const anyCommitted = state.players.some((p) => p.hasOpened || p.isCift);
  const closedBase = anyCommitted ? 100 : rules.scoring.basePenalty; // 100 / 200 (KAFA)

  if (winnerSeat !== null) {
    const winnerTeam = rules.teamMode ? teamOf(winnerSeat) : null;
    for (const player of state.players) {
      if (player.seat === winnerSeat) continue;
      // EŞLİ: bitirenin ortağı ceza yemez (takım bitişi).
      if (winnerTeam !== null && teamOf(player.seat) === winnerTeam) continue;

      // HİBRİT taban: açık → elde kalan puanlar; kapalı → kelle cezası (100/200).
      const baseKind: PenaltyBreakdown['baseKind'] = player.hasOpened ? 'hand' : 'closed';
      const base = player.hasOpened ? handPoints(player) : closedBase;

      // Çarpanlar config'ten (RULES.md §4 CARPAN_*) — İSTİSNASIZ uygulanır.
      const multipliers: PenaltyBreakdown['multipliers'] = [];
      if (player.isCift) {
        multipliers.push({ label: 'çift', factor: rules.scoring.carpanYiyenCift });
      }
      if (okeyFinish) {
        multipliers.push({ label: 'okey', factor: rules.scoring.carpanOkeyBitis });
      }
      if (pairFinish) {
        multipliers.push({ label: 'çiftten', factor: rules.scoring.carpanBitirenCift });
      }
      const amount = multipliers.reduce((a, m) => a * m.factor, base);
      penalties[player.seat] = amount;
      breakdown.push({ seat: player.seat, baseKind, base, multipliers, amount });
    }
    penalties[winnerSeat] = rules.winnerHandPoints;
  } else {
    // DESTE BİTTİ — kazanan yok → rakip okey/çiftten çarpanı YOK; yalnız çift çarpanı.
    // KAFA kuralı burada da geçerli (wash KALDIRILDI — kullanıcı: "kimse açmadan
    // bitersen kelle başı 200"; biri açtıysa kapalılar 100).
    for (const player of state.players) {
      // AÇMIŞ → elde kalan; kapalı → kelle cezası (100/200).
      const baseKind: PenaltyBreakdown['baseKind'] =
        player.hasOpened ? 'hand' : 'closed';
      const base = player.hasOpened ? handPoints(player) : closedBase;
      const multipliers: PenaltyBreakdown['multipliers'] = player.isCift
        ? [{ label: 'çift', factor: rules.scoring.carpanYiyenCift }]
        : [];
      const amount = multipliers.reduce((a, m) => a * m.factor, base);
      penalties[player.seat] = amount;
      breakdown.push({ seat: player.seat, baseKind, base, multipliers, amount });
    }
  }

  return { winnerSeat, handFinish, pairFinish, okeyFinish, penalties, breakdown };
}

/** El sonucunu oyuncu toplamlarına uygular (yeni players dizisi döndürür). */
export function applyHandResult(state: GameState, result: HandResult): GameState['players'] {
  return state.players.map((player) => ({
    ...player,
    totalScore: player.totalScore + (result.penalties[player.seat] ?? 0),
  }));
}

/* ------------------------------------------------------------------ */
/* YAZBOZ (skor kâğıdı) yardımcıları                                    */
/* ------------------------------------------------------------------ */

/** Koltuk başına yazboz toplamları (toplamlar HER ZAMAN satırların toplamıdır). */
export function sheetTotals(sheet: readonly SheetEntry[], playerCount: number): number[] {
  const totals = new Array<number>(playerCount).fill(0);
  for (const e of sheet) totals[e.seat] = (totals[e.seat] ?? 0) + e.amount;
  return totals;
}

/** Eşli mod (çapraz eşler): takım = koltuk % 2. */
export function teamOf(seat: number): number {
  return seat % 2;
}

/** Takım sütunu toplamları (eşli yazboz; oynanış değişmez). */
export function sheetTeamTotals(sheet: readonly SheetEntry[]): [number, number] {
  const totals: [number, number] = [0, 0];
  for (const e of sheet) totals[teamOf(e.seat) as 0 | 1] += e.amount;
  return totals;
}