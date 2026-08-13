import { describe, expect, it } from 'vitest';
import { normalizeRoomOption } from './supabase';

describe('room rule option normalization', () => {
  it('accepts one-hand and one-point match options', () => {
    expect(normalizeRoomOption(1, [1, 3, 5, 7, 9, 11], 11, 'hands')).toBe(1);
    expect(normalizeRoomOption('1', [1, 3, 5, 7], 5, 'target')).toBe(1);
  });

  it('falls back to the configured default for invalid non-strict options', () => {
    const old = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = '0';
    try {
      expect(normalizeRoomOption(2, [1, 3, 5], 5, 'hands')).toBe(5);
    } finally {
      if (old == null) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = old;
    }
  });
});
