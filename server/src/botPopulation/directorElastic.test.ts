import { describe, expect, it } from 'vitest';
import { PopulationDirector, PopulationRoomProvider, PopulationTablePlan, MAX_EXTRA_TABLES_PER_GAME } from './director';
import { PopulationStorage, PopulationRpc } from './storage';
import { defaultPopulationPlans, POPULATION_LOBBY_BASE } from './runtime';

// 20.11 ESNEK NÜFUS: dolu oyunlara ek bot masası, online'a göre büyüyen lobi, taban 20.
const OWNER = '00000000-0000-4000-8000-0000000000aa';
const uuid = (i: number) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function fakeStorage(maxActive = 100) {
  const characters = Array.from({ length: 100 }, (_, i) => ({ id: uuid(i), name: 'Bot' + i, gender: 'e', cosmetic_vip: false,
    avatar_key: null, chips: 200000, initial_chips: 200000, enabled: true, last_refill_day: null }));
  const leases = new Map<string, any>();
  const rpc: PopulationRpc = async (name, a: any) => {
    switch (name) {
      case 'bot_population_snapshot': return { control: { mode: 'running', max_active: maxActive, revision: 1 },
        characters: characters.map(c => ({ ...c })), leases: [...leases.values()] };
      case 'bot_population_claim': {
        const l = { character_id: a.p_character, owner_id: OWNER, token: a.p_token, expires_at: new Date(Date.now() + 45000).toISOString(),
          entered_at: new Date().toISOString(), room_key: a.p_room ?? null, seat: a.p_seat ?? null, game: a.p_game ?? null, bet: a.p_bet ?? null, active_match: null };
        leases.set(a.p_character, l); return l;
      }
      case 'bot_population_heartbeat': return leases.get(a.p_character);
      case 'bot_population_release': leases.delete(a.p_character); return true;
      case 'bot_population_refill': return { chips: 200000 };
      default: return true;
    }
  };
  return { storage: new PopulationStorage(rpc, { lite: false }), leases };
}

class FakeRoom {
  occ = new Map<number, string>(); humans: number[] = []; phase: 'waiting' | 'playing' | 'ended' = 'waiting'; disposed = false;
  constructor(readonly room: string, readonly game: any, readonly bet: number, private readonly storage: PopulationStorage) {}
  owner = OWNER;
  get size() { return this.occ.size; }
  get isDisposed() { return this.disposed; }
  status() { return { phase: this.phase, starting: false, disposed: this.disposed, humanSeats: [...this.humans],
    occupiedSeats: [...this.occ.keys(), ...this.humans] }; }
  seats() { return [...this.occ.keys()]; }
  characterId(s: number) { return this.occ.get(s); }
  async reserve(id: string, seat: number) {
    await this.storage.claim(id, OWNER, '30000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0'),
      { room: this.room, seat, game: this.game, bet: this.bet });
    this.occ.set(seat, id);
  }
  async remove(seat: number) { this.occ.delete(seat); }
  async retire() { this.occ.clear(); return true; }
  acceptNewMatches() {}
}
class FakeProvider implements PopulationRoomProvider {
  rooms = new Map<string, FakeRoom>();
  async open(plan: PopulationTablePlan, storage: PopulationStorage) {
    const r = new FakeRoom(plan.key, plan.game, plan.bet, storage); this.rooms.set(plan.key, r); return r as any;
  }
  async close(room: any) { this.rooms.delete(room.room); }
}
const botsAtTables = (p: FakeProvider) => [...p.rooms.values()].reduce((n, r) => n + r.size, 0);

describe('elastic bot population', () => {
  it('base: 6 waiting tables (13 bots) + 7 lobby = 20', async () => {
    const { storage, leases } = fakeStorage();
    const provider = new FakeProvider();
    const d = new PopulationDirector(storage, OWNER, defaultPopulationPlans(), provider, POPULATION_LOBBY_BASE);
    await d.tick();
    expect(provider.rooms.size).toBe(6);
    expect(botsAtTables(provider)).toBe(13);
    expect(d.status().lobby).toHaveLength(7);
    expect(leases.size).toBe(20);
    expect(d.status().target_active).toBe(20);
  });

  it('opens another 51 bot table when a player sits at the only one, up to the per-game limit', async () => {
    const { storage } = fakeStorage();
    const provider = new FakeProvider();
    const d = new PopulationDirector(storage, OWNER, defaultPopulationPlans(), provider, POPULATION_LOBBY_BASE);
    await d.tick();
    for (let round = 1; round <= MAX_EXTRA_TABLES_PER_GAME + 2; round++) {
      // Her turda 51'in tüm masalarına birer oyuncu oturur.
      for (const r of provider.rooms.values()) if (r.game === '51' && !r.humans.length) { r.humans = [3]; r.phase = 'playing'; }
      await d.tick();
    }
    const tables51 = [...provider.rooms.values()].filter(r => r.game === '51');
    expect(tables51).toHaveLength(1 + MAX_EXTRA_TABLES_PER_GAME);
    expect(tables51.every(r => r.size === 3)).toBe(true);
    // Diğer oyunlar etkilenmez.
    expect([...provider.rooms.values()].filter(r => r.game === 'tavla')).toHaveLength(1);
  });

  it('keeps exactly one free table per game and does not stack extras while a free one exists', async () => {
    const { storage } = fakeStorage();
    const provider = new FakeProvider();
    const d = new PopulationDirector(storage, OWNER, defaultPopulationPlans(), provider, POPULATION_LOBBY_BASE);
    await d.tick();
    const base = provider.rooms.get('tavla:waiting')!; base.humans = [1]; base.phase = 'playing';
    await d.tick(); await d.tick(); await d.tick();
    const tavla = [...provider.rooms.values()].filter(r => r.game === 'tavla');
    expect(tavla).toHaveLength(2);
    expect(tavla.filter(r => !r.humans.length)).toHaveLength(1);
  });

  it('grows the lobby with online players (+1 per 3) and respects the admin ceiling', async () => {
    const { storage, leases } = fakeStorage(25);
    const provider = new FakeProvider();
    const d = new PopulationDirector(storage, OWNER, defaultPopulationPlans(), provider, POPULATION_LOBBY_BASE);
    d.setOnline(9); await d.tick();
    expect(d.status().target_active).toBe(23);
    expect(leases.size).toBe(23);
    d.setOnline(60); await d.tick();
    expect(leases.size).toBeLessThanOrEqual(25); // admin limiti tavan
  });

  it('extra tables close again after players leave (idle rotation), back to one per game', async () => {
    const { storage } = fakeStorage();
    const provider = new FakeProvider();
    let t = 1_000_000;
    const d = new PopulationDirector(storage, OWNER, defaultPopulationPlans(), provider, POPULATION_LOBBY_BASE, () => t, () => 0.5);
    await d.tick();
    for (let i = 0; i < 3; i++) {
      for (const r of provider.rooms.values()) if (r.game === 'duz' && !r.humans.length) { r.humans = [3]; r.phase = 'playing'; }
      await d.tick();
    }
    expect([...provider.rooms.values()].filter(r => r.game === 'duz').length).toBeGreaterThan(1);
    // Herkes kalkar; masalar boş bekler. 5+ dk sonra boş ek masalar emekli olur ve geri gelmez.
    for (const r of provider.rooms.values()) if (r.game === 'duz') { r.humans = []; r.phase = 'waiting'; }
    for (let i = 0; i < 6; i++) { t += 6 * 60_000; await d.tick(); }
    expect([...provider.rooms.values()].filter(r => r.game === 'duz').length).toBeLessThanOrEqual(1);
    expect(d.status().extra_tables.filter(k => k.startsWith('duz:')).length).toBeLessThanOrEqual(1);
  });
});
