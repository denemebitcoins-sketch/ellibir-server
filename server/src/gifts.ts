export const GIFT_HOURS: Record<number, number> = {
  1: 2, 2: 2, 3: 2, 4: 8, 5: 4, 6: 5, 7: 3, 8: 3, 9: 4, 10: 5, 11: 12, 12: 24,
};

export const GIFT_DIAMONDS: Record<number, number> = {
  1: 5, 2: 8, 3: 6, 4: 25, 5: 15, 6: 18, 7: 12, 8: 10, 9: 14, 10: 16, 11: 35, 12: 60,
};

export const GIFT_NAMES: Record<number, string> = {
  1: 'Çay', 2: 'Türk Kahvesi', 3: 'Limonata', 4: 'Semaver', 5: 'Pasta', 6: 'Baklava',
  7: 'Lokum', 8: 'Dondurma', 9: 'Çikolata', 10: 'Meyve Tabağı', 11: 'Çiçek Buketi', 12: 'Altın Hediye Kesesi',
};

export interface GiftRequest {
  giftId: number;
  targets: number[];
}

/** Legacy to_seat ve yeni atomik to_seats payload'larini tek kontrata cevirir. */
export function normalizeGiftRequest(raw: any, maxSeat: number): GiftRequest | null {
  const giftId = Number(raw?.gift_id);
  if (!Number.isInteger(giftId) || giftId < 1 || giftId > 12) return null;

  const source = Array.isArray(raw?.to_seats) ? raw.to_seats : [raw?.to_seat];
  const maxTargets = maxSeat + 1;
  if (source.length < 1 || source.length > maxTargets) return null;

  const parsed = source.map((value: unknown) => Number(value));
  if (parsed.some((seat: number) => !Number.isInteger(seat) || seat < 0 || seat > maxSeat)) return null;

  const targets = [...new Set<number>(parsed)];
  return targets.length > 0 ? { giftId, targets } : null;
}
