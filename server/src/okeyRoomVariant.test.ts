import { describe, expect, it } from 'vitest';
import { normalizeOkeyJoinOptions } from './rooms/OkeyRoom';

describe('OkeyRoom variant compatibility', () => {
  it('promotes legacy rules.variant banko into matchmaking variant', () => {
    const options: any = { mode: 'solo', table: 1, rules: '{"variant":"banko","totalEls":9}' };

    const normalized = normalizeOkeyJoinOptions(options);

    expect(normalized.variant).toBe('banko');
    expect(options.variant).toBe('banko');
  });

  it('keeps top-level variant as the source of truth for newer clients', () => {
    const options: any = { mode: 'solo', table: 1, variant: 'yuzbir', rules: '{"variant":"banko"}' };

    const normalized = normalizeOkeyJoinOptions(options);

    expect(normalized.variant).toBe('yuzbir');
    expect(options.variant).toBe('yuzbir');
  });
});
