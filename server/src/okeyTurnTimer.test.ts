import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOkeyGame } from '../../packages/engine/src/okey';
import { OkeyRoom } from './rooms/OkeyRoom';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('101/Okey sıra sayacı (18.11)', () => {
  it('aynı oyuncunun sırasında ara hamle sayacı sıfırlamaz; görünen süre toleranssız başlar', () => {
    vi.useFakeTimers();
    const room: any = new OkeyRoom();
    room.game = createOkeyGame({ seed: 3, rules: { variant: 'yuzbir', turnTimerSeconds: 30 } } as any);
    for (const p of room.game.players) p.isBot = false;
    room.pushViews = vi.fn();
    room.scheduleTurn();
    const first = room.turnDeadlineAt;
    expect(first - Date.now()).toBe(32000);                 // 30 sn + 2 sn gizli tolerans
    vi.advanceTimersByTime(10000);
    room.scheduleTurn();                                     // ör. taş çekti → afterChange → scheduleTurn
    expect(room.turnDeadlineAt).toBe(first);                 // SIFIRLANMADI
    room.game.turn = (room.game.turn + 1) % 4;               // sıra başkasına geçti
    room.scheduleTurn();
    expect(room.turnDeadlineAt - Date.now()).toBe(32000);    // yeni oyuncuya tam süre
    room.clearTurnTimers();
  });
});
