import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyIhaleCommand, createIhaleGame, ihaleBotCommand, ihaleController } from '../../packages/engine/src/ihale';
import { ihaleClientView, ihaleRuntime } from './cardRoomRuntime';
import { IhaleRoom } from './rooms/IhaleRoom';
import { EllibirRoom } from './rooms/EllibirRoom';
import { DEFAULT_RULES } from '../../packages/engine/src/rules';

function playing() {
  let s = createIhaleGame({ seed: 4, rules: { totalHands: 1, teamMode: true } });
  s = applyIhaleCommand(s, { t: 'ihaleBid', revision: 0, bid: 13 }, 0);
  return applyIhaleCommand(s, { t: 'ihaleTrump', revision: 1, suit: 'S' }, 0);
}
afterEach(() => { vi.useRealTimers(); });
describe('Ihale shared room integration', () => {
  it('keeps all solo opponents private and never delegates control to an opposite seat', () => {
    let s = createIhaleGame({ seed: 4, rules: { teamMode: false, totalHands: 1 } });
    s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 13, revision: 0 }, 0);
    s = applyIhaleCommand(s, { t: 'ihaleTrump', suit: 'H', revision: 1 }, 0);
    for (let turn = 0; turn < 4; turn++) {
      expect(ihaleController(s)).toBe(turn);
      for (const viewer of [-1, 0, 1, 2, 3]) {
        const v = ihaleClientView(s, viewer);
        expect(v.ihale.dummyHand).toEqual([]); expect(v.ihale.bidderHand).toEqual([]);
        expect(v.ihale.scorePending).toBe(false); expect(v.yourTurn).toBe(viewer === turn);
        for (let hidden = 0; hidden < 4; hidden++) if (hidden !== viewer)
          for (const c of s.players[hidden].hand) expect(JSON.stringify(v)).not.toContain(`"${c.id}"`);
      }
      expect(() => applyIhaleCommand(s, ihaleBotCommand(s), (turn + 2) % 4)).toThrow('not_your_turn');
      s = applyIhaleCommand(s, ihaleBotCommand(s), turn);
    }
  });
  it('preserves individual auction calls in reconnect views without mutating old states', () => {
    const initial = createIhaleGame({ seed: 42, rules: { teamMode: true } });
    let s = initial;
    for (const bid of [7, 9, 0, 11])
      s = applyIhaleCommand(s, bid === 0 ? { t: 'ihalePass', revision: s.revision }
        : { t: 'ihaleBid', revision: s.revision, bid }, s.currentSeat);
    expect(initial.ihale.bids).toEqual([7, 0, 0, 0]);
    for (const seat of [-1, 0, 1, 2, 3]) {
      const view = ihaleClientView(s, seat);
      expect(view.ihale.bids).toEqual([7, 9, 0, 11]);
      expect(view.ihale.passed).toEqual([false, false, true, false]);
      view.ihale.bids[0] = 99;
      expect(s.ihale.bids[0]).toBe(7);
    }
  });
  it('collects a completed trick after 650 ms, not before', async () => {
    vi.useFakeTimers();
    const r: any = new IhaleRoom(); r.game = playing(); r.humanSeats = [0, 1, 2, 3];
    for (let n = 0; n < 4; n++) r.game = applyIhaleCommand(r.game, ihaleBotCommand(r.game), ihaleController(r.game));
    expect(r.game.ihale.phase).toBe('trickEnd');
    const running = r.runEngine();
    await vi.advanceTimersByTimeAsync(649);
    expect(r.game.ihale.trick).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.game.ihale.phase).toBe('play');
    expect(r.game.ihale.trick).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(r.STEP_MS);
    await running;
    r.onDispose();
  });
  it('uses exactly the 51 seat/social/lifecycle class', () => {
    expect(new IhaleRoom()).toBeInstanceOf(EllibirRoom);
    const r: any = new IhaleRoom(); expect(r.runtime).toBe(ihaleRuntime); expect(r.gameKey).toBe('ihale');
  });
  it('does not accept a client-chosen seed as the online deal', () => {
    const a: any = ihaleRuntime.create({ seed: 42, rules: { ...DEFAULT_RULES, teamMode: true, totalHands: 1 } });
    const b: any = ihaleRuntime.create({ seed: 42, rules: { ...DEFAULT_RULES, teamMode: true, totalHands: 1 } });
    expect(a.players.map((p: any) => p.hand)).not.toEqual(b.players.map((p: any) => p.hand));
    const view = ihaleClientView(a, 0);
    expect(view.seed).toBeUndefined(); expect(view.random).toBeUndefined();
    expect(view.ihale.seed).toBeUndefined();
  });
  it('never exposes private hands, including through spectator views', () => {
    const s = playing();
    for (const seat of [-1, 0, 1, 2, 3]) {
      const v = ihaleClientView(s, seat);
      expect(v.myHand).toHaveLength(seat < 0 ? 0 : 13);
      expect(v.ihale.dummyHand).toHaveLength(13);
      expect(v.seats.every((p: any) => p.hand === undefined)).toBe(true);
      const serialized = JSON.stringify(v);
      for (let hidden = 0; hidden < 4; hidden++)
        if (hidden !== seat && hidden !== 2 && !(seat === 2 && hidden === 0))
          for (const card of s.players[hidden].hand) expect(serialized).not.toContain(`"${card.id}"`);
    }
  });
  it('keeps dummy private until trump is selected and rejects its own controller', () => {
    const before = createIhaleGame({ seed: 4, rules: { teamMode: true } });
    expect(ihaleClientView(before, -1).ihale.dummyHand).toEqual([]);
    let s = playing();
    for (let n = 0; n < 2; n++) s = applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
    expect(ihaleClientView(s, 0).yourTurn).toBe(true);
    expect(ihaleClientView(s, 2).yourTurn).toBe(false);
    expect(() => ihaleRuntime.apply(s, ihaleBotCommand(s), 2)).toThrow('not_your_turn');
  });
  it.each([0, 1, 2, 3])('exposes bidder %i only to the dummy, while the dummy hand is public', bidder => {
    let s = createIhaleGame({ seed: 23, rules: { teamMode: true } });
    while (s.ihale.phase === 'bid') {
      const actor = s.currentSeat;
      s = applyIhaleCommand(s, actor === bidder
        ? { t: 'ihaleBid', revision: s.revision, bid: 13 }
        : !s.ihale.opened ? { t: 'ihaleBid', revision: s.revision, bid: 7 }
        : { t: 'ihalePass', revision: s.revision }, actor);
    }
    for (const viewer of [-1, 0, 1, 2, 3]) {
      expect(ihaleClientView(s, viewer).ihale.dummyHand).toEqual([]);
      expect(ihaleClientView(s, viewer).ihale.bidderHand).toEqual([]);
    }
    s = applyIhaleCommand(s, { t: 'ihaleTrump', revision: s.revision, suit: 'H' }, bidder);
    const partner = (bidder + 2) % 4;
    for (const viewer of [-1, 0, 1, 2, 3]) {
      const view = ihaleClientView(s, viewer);
      expect(view.ihale.dummySeat).toBe(partner);
      expect(view.ihale.dummyHand.map((c: any) => c.id)).toEqual(s.players[partner].hand.map(c => c.id));
      expect(view.ihale.bidderHand.map((c: any) => c.id)).toEqual(viewer === partner ? s.players[bidder].hand.map(c => c.id) : []);
      expect(view.myHand.map((c: any) => c.id)).toEqual(viewer < 0 ? [] : s.players[viewer].hand.map(c => c.id));
      const payload = JSON.stringify(view);
      for (const hidden of [0, 1, 2, 3].filter(seat => seat !== viewer && seat !== partner && !(viewer === partner && seat === bidder)))
        for (const card of s.players[hidden].hand) expect(payload).not.toContain(`"${card.id}"`);
    }
    for (let n = 0; n < 2; n++) s = applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
    expect(s.currentSeat).toBe(partner);
    expect(ihaleController(s)).toBe(bidder);
    expect(ihaleClientView(s, bidder).yourTurn).toBe(true);
    expect(ihaleClientView(s, partner).yourTurn).toBe(false);
    expect(() => applyIhaleCommand(s, ihaleBotCommand(s), partner)).toThrow('not_your_turn');
  });
  it('uses bidder connection for dummy bot takeover, not the dummy connection', () => {
    let s = playing();
    for (let n = 0; n < 2; n++) s = applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
    expect(ihaleRuntime.step(s, seat => seat === 0).moved).toBe(false);
    expect(ihaleRuntime.step(s, seat => seat === 2).moved).toBe(true);
  });
  it('preserves the same deadline on duplicate snapshots and grants time for a new revision', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r: any = new IhaleRoom(); r.game = playing(); r.game.rules.turnTimerSeconds = 40;
    r.pushViews(); const deadline = r.ihaleDeadline;
    vi.setSystemTime(110000); r.pushViews(); expect(r.ihaleDeadline).toBe(deadline);
    r.game = applyIhaleCommand(r.game, ihaleBotCommand(r.game), 0);
    r.pushViews(); expect(r.ihaleDeadline).toBe(150000);
  });
  it('times out the dummy decision through the bidder and keeps the turn order', async () => {
    vi.useFakeTimers();
    const r: any = new IhaleRoom(); r.game = playing(); r.humanSeats = [0, 1, 2, 3];
    for (let n = 0; n < 2; n++) r.game = applyIhaleCommand(r.game, ihaleBotCommand(r.game), ihaleController(r.game));
    r.pushViews(); r.runEngine = vi.fn(); r.armTurnTimeoutIfNeeded();
    await vi.advanceTimersByTimeAsync(45000);
    expect(r.forceBotSeat).toBe(0); expect(r.runEngine).toHaveBeenCalledOnce();
    const next = ihaleRuntime.step(r.game, seat => r.isHumanTurn(seat));
    expect(next.state.currentSeat).toBe(3);
    r.onDispose();
  });
  it('disposes bot-only Ihale rooms through the shared lifecycle', async () => {
    vi.useFakeTimers(); const r: any = new IhaleRoom(); r.seats.set('player', 0);
    r.disconnect = vi.fn().mockResolvedValue(undefined); r.cleanupSeat('player', 0);
    await vi.runAllTimersAsync(); expect(r.disconnect).toHaveBeenCalledOnce();
  });
});
