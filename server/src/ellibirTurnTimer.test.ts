import { afterEach, describe, expect, it, vi } from 'vitest';
import { EllibirRoom } from './rooms/EllibirRoom';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// 19.11: 51'de sunucu süresi istemciyle aynı — sıra başına tek süre; taş çekmek süreyi yeniden başlatmaz.
describe('51 sıra süresi', () => {
  function setup() {
    vi.useFakeTimers();
    const room: any = new EllibirRoom();
    let seat = 0;
    room.gameKey = '51';
    room.game = { phase: 'draw', sorgu: null, handNumber: 1, rules: { turnTimerSeconds: 30 } };
    room.runtime = { controller: () => seat };
    room.isHumanTurn = () => true;
    room.populationCanPlay = () => true;
    room.runEngine = vi.fn();
    return { room, setSeat: (s: number) => { seat = s; } };
  }
  it('taş çekince süre baştan başlamaz, sıra değişince tam süre', () => {
    const { room, setSeat } = setup();
    room.armTurnTimeoutIfNeeded();
    const first = room.turnDeadlineAt;
    expect(first - Date.now()).toBe(36000);              // 30 sn + 6 sn gizli tolerans
    vi.advanceTimersByTime(20000);
    room.game.phase = 'action';                          // taş çekti
    room.armTurnTimeoutIfNeeded();
    expect(room.turnDeadlineAt).toBe(first);
    vi.advanceTimersByTime(15999);
    expect(room.runEngine).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(room.runEngine).toHaveBeenCalledOnce();       // asıl süre dolunca bir kez
    expect(room.forceBotSeat).toBe(0);
    setSeat(1); room.forceBotSeat = -1;
    room.armTurnTimeoutIfNeeded();
    expect(room.turnDeadlineAt - Date.now()).toBe(36000);
    room.clearTurnTimer();
  });
  it('sorgu ve yeni el süreyi yeniden başlatır', () => {
    const { room } = setup();
    room.armTurnTimeoutIfNeeded();
    vi.advanceTimersByTime(10000);
    room.game.sorgu = { by: 1 };
    room.armTurnTimeoutIfNeeded();
    room.game.sorgu = null;
    room.armTurnTimeoutIfNeeded();
    expect(room.turnDeadlineAt - Date.now()).toBe(36000);
    vi.advanceTimersByTime(10000);
    room.game.handNumber = 2;
    room.armTurnTimeoutIfNeeded();
    expect(room.turnDeadlineAt - Date.now()).toBe(36000);
    room.clearTurnTimer();
  });
});
