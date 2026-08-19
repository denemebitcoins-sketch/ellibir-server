import { describe, expect, it } from 'vitest';
import { applyChatWordFilter, normalizeChatFilterText } from './supabase';

describe('central chat filter helpers', () => {
  it('normalizes Turkish dotted/dotless i for admin-entered terms', () => {
    expect(normalizeChatFilterText(' İĞRENÇ ')).toBe('iğrenç');
    expect(normalizeChatFilterText('ISRAR')).toBe('ısrar');
  });

  it('filters whole words without censoring harmless inner matches', () => {
    const words = [{ term: 'kötü', match_mode: 'word' as const, active: true }];

    expect(applyChatWordFilter('bu kötü oldu', words)).toBe('bu *** oldu');
    expect(applyChatWordFilter('kötülük başka kelime', words)).toBe('kötülük başka kelime');
  });

  it('supports contains mode for explicit roots or fragments', () => {
    const words = [{ term: 'spam', match_mode: 'contains' as const, active: true }];

    expect(applyChatWordFilter('SPAMCI spamladı', words)).toBe('***CI ***ladı');
  });
});
