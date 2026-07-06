import { describe, expect, it } from 'vitest';
import { clientViewFor, clientViewForSpectator } from './clientView';
import { okeyViewFor } from './okeyView';
import { tavlaViewFor } from './tavlaView';
import { VIEW_VERSION } from './viewContract';

describe('view DTO contract', () => {
  it('adds the shared DTO version to all empty views', () => {
    expect((clientViewFor(null as any, 0) as any).viewVersion).toBe(VIEW_VERSION);
    expect((clientViewForSpectator(null as any) as any).viewVersion).toBe(VIEW_VERSION);
    expect((okeyViewFor(null, 0) as any).viewVersion).toBe(VIEW_VERSION);
    expect((tavlaViewFor(null, 0) as any).viewVersion).toBe(VIEW_VERSION);
  });

  it('keeps spectator defaults explicit', () => {
    expect((clientViewFor(null as any, -1) as any).spectator).toBe(true);
    expect((okeyViewFor(null, -1) as any).spectator).toBe(true);
    expect((tavlaViewFor(null, -1) as any).spectator).toBe(true);
  });

  it('keeps Tavla offer fields absent-safe', () => {
    const view = tavlaViewFor(null, 0) as any;
    expect(view.pendingDouble).toBe(-1);
    expect(view.pendingResign).toBe(-1);
    expect(view.turn).toBe(-1);
    expect(view.gameWinner).toBe(-1);
  });

  it('keeps collection fields as arrays for Unity JsonUtility DTOs', () => {
    const ellibir = clientViewFor(null as any, 0) as any;
    const okey = okeyViewFor(null, 0) as any;
    const tavla = tavlaViewFor(null, 0) as any;

    expect(Array.isArray(ellibir.myHand)).toBe(true);
    expect(Array.isArray(ellibir.seats)).toBe(true);
    expect(Array.isArray(ellibir.logMessages)).toBe(true);

    expect(Array.isArray(okey.scores)).toBe(true);
    expect(Array.isArray(okey.myHand)).toBe(true);
    expect(Array.isArray(okey.logMessages)).toBe(true);

    expect(Array.isArray(tavla.points)).toBe(true);
    expect(Array.isArray(tavla.movesLeft)).toBe(true);
    expect(Array.isArray(tavla.logMessages)).toBe(true);
  });
});
