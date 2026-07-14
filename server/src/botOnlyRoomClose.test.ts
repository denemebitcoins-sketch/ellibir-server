import { afterEach, describe, expect, it, vi } from 'vitest';
import { EllibirRoom } from './rooms/EllibirRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';

const rooms = [
  ['51', EllibirRoom],
  ['Okey', OkeyRoom],
  ['Tavla', TavlaRoom],
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('bot-only room lifecycle', () => {
  it.each(rooms)('%s closes after the final real seat is removed', async (_name, RoomType) => {
    vi.useFakeTimers();
    const room: any = new RoomType();
    room.seats.set('only-player', 0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    room.disconnect = disconnect;

    room.cleanupSeat('only-player', 0);
    expect(room.seats.size).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(rooms)('%s stays open while another real seat remains', async (_name, RoomType) => {
    vi.useFakeTimers();
    const room: any = new RoomType();
    room.seats.set('leaving-player', 0);
    room.seats.set('remaining-player', 1);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    room.disconnect = disconnect;

    room.cleanupSeat('leaving-player', 0);
    await vi.runAllTimersAsync();

    expect(room.seats.size).toBe(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each(rooms)('%s cancels bot-only close when a real seat returns in the same tick', async (_name, RoomType) => {
    vi.useFakeTimers();
    const room: any = new RoomType();
    room.seats.set('leaving-player', 0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    room.disconnect = disconnect;

    room.cleanupSeat('leaving-player', 0);
    room.seats.set('returning-player', 0);
    await vi.runAllTimersAsync();

    expect(disconnect).not.toHaveBeenCalled();
    expect(room.closingBotOnly).toBe(false);
  });
});
