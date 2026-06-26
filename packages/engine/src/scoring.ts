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
 *  - kimse taahhütte değilse (açan yok, çift yok) → puansız;
 *  - KESİN ÇİFT (isCift) → tabanı × CARPAN_YIYEN_CIFT; taban açmışsa elde kalan,
 *    açamamışsa KAFA_CEZASI (örn açık 31×2=62; kapalı 200×2=400);
 *  - açmış (çift değil) → elde kalan; taahhütsüz → STOCK_OUT_PENALTY.
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

  if (winnerSeat !== null) {
    const winnerTeam = rules.teamMode ? teamOf(winnerSeat) : null;
    for (const player of state.players) {
      if (player.seat === winnerSeat) continue;
      // EŞLİ: bitirenin ortağı ceza yemez (takım bitişi).
      if (winnerTeam !== null && teamOf(player.seat) === winnerTeam) continue;

      // HİBRİT taban: açık → elde kalan puanlar; kapalı → sabit ceza.
      const baseKind: PenaltyBreakdown['baseKind'] = player.hasOpened ? 'hand' : 'closed';
      const base = player.hasOpened ? handPoints(player) : rules.scoring.basePenalty;

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
    // DESTE BİTTİ — RULES.md 1.7 (C5).
    const anyCommitted = state.players.some((p) => p.hasOpened || p.isCift);
    if (anyCommitted) {
      for (const player of state.players) {
        // KESİN ÇİFT (isCift): el nasıl biterse bitsin çift-yiyen çarpanını öder.
        //  - AÇMIŞ çift  → (elde kalan) × CARPAN_YIYEN_CIFT  (örn 31×2).
        //  - AÇAMAMIŞ çift → KAFA_CEZASI(200) × CARPAN_YIYEN_CIFT = 400.
        // (Bitiren yoktur → rakip okey/çift çarpanı YOKTUR; yalnız kendi çift çarpanı.)
        // Açmış (çift olmayan) → elde kalan; taahhütsüz → STOCK_OUT_PENALTY.
        const baseKind: PenaltyBreakdown['baseKind'] =
          player.hasOpened ? 'hand' : 'closed';
        const base = player.hasOpened
          ? handPoints(player)
          : player.isCift
            ? rules.scoring.basePenalty
            : rules.scoring.stockOutPenalty;
        const multipliers: PenaltyBreakdown['multipliers'] = player.isCift
          ? [{ label: 'çift', factor: rules.scoring.carpanYiyenCift }]
          : [];
        const amount = multipliers.reduce((a, m) => a * m.factor, base);
        penalties[player.seat] = amount;
        breakdown.push({ seat: player.seat, baseKind, base, multipliers, amount });
      }
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