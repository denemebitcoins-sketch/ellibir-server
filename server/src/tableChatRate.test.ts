import { describe, expect, it } from 'vitest';
import { OkeyRoom } from './rooms/OkeyRoom';
import { EllibirRoom } from './rooms/EllibirRoom';
import { TavlaRoom } from './rooms/TavlaRoom';

// 19.11: masa içi sohbet flood koruması — 2,5 sn'de 1, dakikada en çok 8.
describe('masa sohbeti hız sınırı', () => {
  for (const [name, Room] of [['okey', OkeyRoom], ['51', EllibirRoom], ['tavla', TavlaRoom]] as const) {
    it(name, () => {
      const room: any = new (Room as any)();
      const t0 = Date.now();
      const ok = (dt: number) => {
        const real = Date.now; Date.now = () => t0 + dt;
        try { return room.chatRateOk('s1'); } finally { Date.now = real; }
      };
      expect(ok(0)).toBe(true);
      expect(ok(1000)).toBe(false);           // 2,5 sn dolmadan ikinci mesaj
      expect(ok(2600)).toBe(true);
      let sent = 2;
      for (let i = 2; i < 12; i++) if (ok(i * 2600)) sent++;
      expect(sent).toBe(8);                    // dakikada en çok 8
      expect(ok(61_000)).toBe(true);           // yeni dakika
      expect(room.chatRateOk('s2')).toBe(true); // başka oyuncu etkilenmez
    });
  }
});
