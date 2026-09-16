import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyIhaleCommand, createIhaleGame, ihaleBotCommand, ihaleController } from '../../packages/engine/src/ihale';
import { IhaleRoom } from './rooms/IhaleRoom';
import { EllibirRoom } from './rooms/EllibirRoom';

function playing(dummy = false) {
  let s = createIhaleGame({ seed: 4, rules: { totalHands: 5, teamMode: true, turnTimerSeconds: 40 } });
  s = applyIhaleCommand(s, { t: 'ihaleBid', revision: 0, bid: 13 }, 0);
  s = applyIhaleCommand(s, { t: 'ihaleTrump', revision: 1, suit: 'S' }, 0);
  if (dummy) for (let n = 0; n < 2; n++) s = applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
  return s;
}
function room(dummy = false): any {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const r: any = new IhaleRoom(); r.game = playing(dummy); r.humanSeats = [0, 1, 2, 3];
  r.seats.set('me', 0); r.ihalePilotClients.add('me');
  r.pushViews();
  return r;
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Ihale persistent automatic control', () => {
  it('keeps legacy clients on recoverable one-move timeout handling', async () => {
    const r = room(); r.runEngine = vi.fn(); r.ihalePilotClients.clear();
    for (let miss = 0; miss < 4; miss++) {
      r.forceBotSeat = null; r.ihaleDeadline = Date.now() + 40000;
      r.armTurnTimeoutIfNeeded(); await vi.advanceTimersByTimeAsync(40000);
      expect(r.forceBotSeat).toBe(0);
      expect(r.ihaleAutoPilot.has(0)).toBe(false);
    }
    r.forceBotSeat = null;
    expect(r.isHumanTurn(0)).toBe(true); r.onDispose();
  });

  it.each([false, true])('switches after three misses on the controller, dummy=%s', async dummy => {
    const r = room(dummy); r.runEngine = vi.fn();
    for (let miss = 1; miss <= 3; miss++) {
      r.forceBotSeat = null;
      r.ihaleDeadline = Date.now() + 40000;
      r.armTurnTimeoutIfNeeded();
      await vi.advanceTimersByTimeAsync(40000);
      expect(r.ihaleTimeoutStreak.get(0)).toBe(miss);
      expect(r.ihaleTimeoutStreak.has(2)).toBe(false);
      expect(r.ihaleAutoPilot.has(0)).toBe(miss === 3);
      expect(r.forceBotSeat).toBe(0);
    }
    r.forceBotSeat = null;
    expect(r.isHumanTurn(0)).toBe(false);
    expect(r.isHumanTurn(1)).toBe(true);
    const next = r.runtime.step(r.game, (seat: number) => r.isHumanTurn(seat));
    expect(next.moved).toBe(true);
    expect(next.state.currentSeat).toBe(dummy ? 3 : 1);
    r.game = playing(); r.pushViews();
    expect(r.ihaleAutoPilot.has(0)).toBe(true);
    r.onDispose();
  });

  it('resumes immediately and cancels a queued automatic move without permitting clock extension', async () => {
    const r = room(true); const client: any = { send: vi.fn() };
    r.ihaleAutoPilot.add(0); r.ihaleTimeoutStreak.set(0, 3); r.forceBotSeat = 0;
    const revision = r.game.revision;
    const running = r.runEngine();
    await vi.advanceTimersByTimeAsync(400);
    expect(r.handleIhaleControl(client, { t: 'ihaleResume' }, 0)).toBe(true);
    const deadline = r.ihaleDeadline;
    expect(deadline).toBe(Date.now() + 40000);
    expect(r.ihaleAutoPilot.has(0)).toBe(false);
    expect(r.ihaleTimeoutStreak.has(0)).toBe(false);
    expect(r.forceBotSeat).toBe(null);
    await vi.advanceTimersByTimeAsync(450); await running;
    expect(r.game.revision).toBe(revision);
    r.handleIhaleControl(client, { t: 'ihaleResume' }, 0);
    expect(r.ihaleDeadline).toBe(deadline);
    expect(r.isHumanTurn(0)).toBe(true);
    r.onDispose();
  });

  it('does not give another player control, extend their turn, or clear a disconnected seat', () => {
    const r = room(); r.runEngine = vi.fn(); const client: any = { send: vi.fn() };
    r.ihaleAutoPilot.add(1); r.game.abandoned = [1];
    const deadline = r.ihaleDeadline;
    r.handleIhaleControl(client, { t: 'ihaleResume', seat: 1 }, 0);
    expect(r.ihaleAutoPilot.has(1)).toBe(true);
    r.handleIhaleControl(client, { t: 'ihaleResume' }, 1);
    expect(r.ihaleAutoPilot.has(1)).toBe(false);
    expect(r.ihaleDeadline).toBe(deadline);
    expect(r.isHumanTurn(1)).toBe(false);
    r.onDispose();
  });

  it('sends private pilot state in reconnect snapshots without converting the human to a bot', () => {
    const r = room(); r.ihaleAutoPilot.add(0); r.ihaleTimeoutStreak.set(0, 3);
    const me: any = { sessionId: 'me', send: vi.fn() };
    const other: any = { sessionId: 'other', send: vi.fn() };
    r.clients.push(me, other); r.seats.set('me', 0); r.seats.set('other', 1);
    r.pushViews();
    const own = JSON.parse(me.send.mock.calls.find((c: any[]) => c[0] === 'view')[1]);
    const opponent = JSON.parse(other.send.mock.calls.find((c: any[]) => c[0] === 'view')[1]);
    expect(own.ihale.autoPilot).toBe(true); expect(own.ihale.timeoutStreak).toBe(3);
    expect(own.yourTurn).toBe(false); expect(own.seats[0].isBot).toBe(false);
    expect(opponent.ihale.autoPilot).toBe(false); expect(opponent.ihale.timeoutStreak).toBe(0);
    expect(r.handleIhaleControl(me, ihaleBotCommand(r.game), 0)).toBe(true);
    expect(me.send).toHaveBeenCalledWith('moveError', expect.objectContaining({ code: 'autopilot_active' }));
    r.onDispose();
  });

  it('resets the streak only for a legal manual command through the real message handler', () => {
    vi.useFakeTimers();
    const r: any = new IhaleRoom(); const handlers = new Map<string, Function>();
    r.onMessage = (name: string, callback: Function) => handlers.set(name, callback);
    r.setMetadata = vi.fn(); r.refreshCanak = vi.fn(); r.runEngine = vi.fn();
    r.onCreate({ mode: 'duo', bet: 500 });
    r.game = playing(); r.seats.set('me', 0); r.ihaleTimeoutStreak.set(0, 2);
    const client: any = { sessionId: 'me', send: vi.fn() };
    handlers.get('cmd')!(client, { t: 'ihalePlay', cardId: 'missing', revision: r.game.revision });
    expect(r.ihaleTimeoutStreak.get(0)).toBe(2);
    handlers.get('cmd')!(client, ihaleBotCommand(r.game));
    expect(r.ihaleTimeoutStreak.has(0)).toBe(false);
    r.onDispose();
  });

  it('clears automatic control for a new match', () => {
    const r = room(); r.cfg = {}; r.startGameIfReady = vi.fn(); r.pushViews = vi.fn();
    r.ihaleAutoPilot.add(0); r.ihaleTimeoutStreak.set(0, 3);
    r.prepareRematchCountdown();
    expect(r.ihaleAutoPilot.size).toBe(0); expect(r.ihaleTimeoutStreak.size).toBe(0);
    r.onDispose();
  });

  it('leaves the 51 control protocol unchanged', () => {
    const r: any = new EllibirRoom();
    expect(r.handleIhaleControl({ send: vi.fn() }, { t: 'ihaleResume' }, 0)).toBe(false);
    expect(r.ihaleAutoPilot.size).toBe(0); r.onDispose();
  });
});
