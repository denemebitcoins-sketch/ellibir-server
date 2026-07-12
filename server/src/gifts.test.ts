import { describe, expect, it } from 'vitest';
import { normalizeGiftRequest } from './gifts';

describe('gift request contract', () => {
  it('keeps legacy single-target payloads compatible', () => {
    expect(normalizeGiftRequest({ to_seat: 2, gift_id: 4 }, 3)).toEqual({ giftId: 4, targets: [2] });
  });

  it('accepts one atomic, deduplicated multi-target payload', () => {
    expect(normalizeGiftRequest({ to_seats: [0, 2, 2, 3], gift_id: 8 }, 3))
      .toEqual({ giftId: 8, targets: [0, 2, 3] });
  });

  it('rejects invalid gifts, seats and oversized payloads', () => {
    expect(normalizeGiftRequest({ to_seats: [0, 4], gift_id: 1 }, 3)).toBeNull();
    expect(normalizeGiftRequest({ to_seats: [0, 1, 2], gift_id: 1 }, 1)).toBeNull();
    expect(normalizeGiftRequest({ to_seats: [0], gift_id: 13 }, 3)).toBeNull();
  });
});
