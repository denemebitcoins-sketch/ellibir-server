import { randomUUID } from 'node:crypto';
import { CharacterLease, CharacterRecord, PopulationGame, PopulationSnapshot, PopulationStorage } from './storage';
import { PopulationRoomSession } from './roomSession';

export interface PopulationTablePlan {
  key: string;
  game: PopulationGame;
  team: boolean;
  bet: number;
  table: number;
  kind: 'showcase' | 'waiting';
  waitingBots?: number;
}
export interface PopulationRoomProvider {
  inviteTarget?(uid: string): Promise<{ key: string; seat: number } | null>;
  heartbeat?(): Promise<void>;
  retired?(room: PopulationRoomSession): Promise<void>;
  /** Return null when an existing human room/another owner prevents provisioning. */
  open(plan: PopulationTablePlan, storage: PopulationStorage, owner: string): Promise<PopulationRoomSession | null>;
  /** Only called after retirement and when no seated human remains. */
  close(room: PopulationRoomSession): Promise<void>;
}
interface Managed { room: PopulationRoomSession; rotateAt: number; }
interface Lobby { lease: CharacterLease; rotateAt: number; }

/** No constructor/startup side effects. A trusted caller drives tick() explicitly.
 * SQL remains authoritative for capacity, seat ownership, bankroll and daily refill.
 */
export class PopulationDirector {
  private readonly managed = new Map<string, Managed>();
  private readonly lobby = new Map<string, Lobby>();
  private readonly cooldown = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private ticking: Promise<void> | null = null;
  private stopping = false;
  private readonly plans: PopulationTablePlan[];
  private errors: string[] = [];

  constructor(readonly storage: PopulationStorage, readonly owner: string, plans: readonly PopulationTablePlan[],
    private readonly provider: PopulationRoomProvider, private readonly lobbyTarget = 3,
    private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {
    if (!(storage instanceof PopulationStorage)) throw new Error('population_server_capability_required');
    if (!/^[0-9a-f-]{36}$/i.test(owner)) throw new Error('population_owner_invalid');
    if (!Number.isInteger(lobbyTarget) || lobbyTarget < 0 || lobbyTarget > 100) throw new Error('population_lobby_invalid');
    const keys = new Set<string>();
    const tables = new Set<string>();
    let required = lobbyTarget;
    this.plans = plans.map(p => {
      const size = p.game === 'tavla' ? 2 : 4;
      const identity = `${p.game}:${p.team}:${p.table}`;
      if (!['51', 'duz', 'banko', 'yuzbir', 'ihale', 'tavla'].includes(p.game) || typeof p.team !== 'boolean'
        || (p.game === 'tavla' && p.team) || !p.key || keys.has(p.key) || tables.has(identity)
        || !Number.isInteger(p.table) || p.table < 1 || !Number.isInteger(p.bet) || p.bet < 500 || p.bet > 5000 || p.bet % 500
        || !['showcase', 'waiting'].includes(p.kind)
        || (p.kind === 'waiting' && (!Number.isInteger(p.waitingBots) || p.waitingBots! < 1 || p.waitingBots! >= size)))
        throw new Error('population_plan_invalid');
      keys.add(p.key); tables.add(identity);
      required += p.kind === 'showcase' ? size : p.waitingBots!;
      return { ...p };
    });
    if (required > 100) throw new Error('population_plan_capacity');
  }

  status() {
    return { stopping: this.stopping, lobby: [...this.lobby.keys()],
      tables: [...this.managed].map(([key, m]) => ({ key, ...m.room.status(), bots: m.room.size, rotateAt: m.rotateAt })),
      errors: [...this.errors] };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.serial(() => this.reconcile()).finally(() => { this.ticking = null; });
    return this.ticking;
  }
  requestDrain(): Promise<void> { this.stopping = true; return this.serial(() => this.reconcile()); }
  private nextRotation() { return this.now() + 180000 + Math.floor(this.random() * 120001); }
  private rest(id: string) { this.cooldown.set(id, this.now() + 180000); }
  private leased(snapshot: PopulationSnapshot): Set<string> {
    return new Set(snapshot.leases.filter(l => l.active_match || Date.parse(l.expires_at) > Date.now()).map(l => l.character_id));
  }
  private candidates(snapshot: PopulationSnapshot, used: Set<string>, bet: number): CharacterRecord[] {
    const result = snapshot.characters.filter(c => c.enabled && !used.has(c.id)
      && (this.cooldown.get(c.id) ?? 0) <= this.now() && (c.chips >= bet || c.chips < 100000));
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  private async funded(character: CharacterRecord, bet: number): Promise<boolean> {
    if (character.chips < 100000) character.chips = (await this.storage.refill(character.id)).chips;
    return character.chips >= bet;
  }
  private note(key: string, error: unknown) {
    this.errors.push(`${key}: ${error instanceof Error ? error.message : 'population_operation_failed'}`);
    this.errors = this.errors.slice(-20);
  }
  private async retire(key: string, managed: Managed, used: Set<string>): Promise<boolean> {
    const ids = managed.room.seats().map(s => managed.room.characterId(s)!);
    if (!await managed.room.retire()) return false;
    for (const id of ids) { used.delete(id); this.rest(id); }
    await this.provider.retired?.(managed.room);
    if (!managed.room.status().humanSeats.length) await this.provider.close(managed.room);
    this.managed.delete(key);
    return true;
  }

  private async reconcile() {
    this.errors = [];
    await this.provider.heartbeat?.();
    const snapshot = await this.storage.snapshot();
    const running = !this.stopping && snapshot.control.mode === 'running';
    const used = this.leased(snapshot);
    for (const [id, until] of this.cooldown) if (until <= this.now()) this.cooldown.delete(id);

    for (const [id, item] of this.lobby) {
      try {
        if (!running || this.now() >= item.rotateAt || used.size > snapshot.control.max_active) {
          await this.storage.release(id, this.owner, item.lease.token);
          this.lobby.delete(id); used.delete(id); this.rest(id);
        } else item.lease = await this.storage.heartbeat(id, this.owner, item.lease.token);
      } catch (e) {
        // An expired/replaced lobby lease never remains a visible local participant.
        this.lobby.delete(id); this.rest(id); this.note('lobby', e);
      }
    }
    for (const [key, item] of this.managed) {
      const state = item.room.status();
      try {
        if (!running || state.disposed || item.room.isDisposed
          || (state.phase === 'ended' && state.humanSeats.length === 0)) {
          item.room.acceptNewMatches(false);
          await this.retire(key, item, used);
        } else item.room.acceptNewMatches(true);
      } catch (e) { this.note(key, e); }
    }
    if (!running) return;

    // Existing tables with waiting humans take precedence over empty showcase quotas.
    const plans = [...this.plans].sort((a, b) => Number(!!this.managed.get(b.key)?.room.status().humanSeats.length)
      - Number(!!this.managed.get(a.key)?.room.status().humanSeats.length));
    for (const plan of plans) {
      try {
        let item = this.managed.get(plan.key);
        if (!item) {
          if (used.size >= snapshot.control.max_active || !this.candidates(snapshot, used, plan.bet).length) continue;
          const room = await this.provider.open(plan, this.storage, this.owner);
          if (!room) continue;
          if (room.owner !== this.owner || room.game !== plan.game || room.bet !== plan.bet || room.room !== plan.key)
            throw new Error('population_room_contract');
          item = { room, rotateAt: this.nextRotation() };
          this.managed.set(plan.key, item);
        }
        const state = item.room.status();
        if (state.phase !== 'waiting' || state.starting || state.disposed || item.room.isDisposed) continue;
        if (!state.humanSeats.length) {
          for (const seat of item.room.seats()) {
            if (used.size <= snapshot.control.max_active) break;
            const id = item.room.characterId(seat)!;
            await item.room.remove(seat); used.delete(id); this.rest(id);
          }
        }
        if (!state.humanSeats.length && this.now() >= item.rotateAt) {
          const seats = item.room.seats();
          // Rotate one or two occupants instead of emptying every waiting table at once.
          const count = Math.min(seats.length, 1 + Math.floor(this.random() * 2));
          for (const seat of seats.slice(0, count)) {
            const id = item.room.characterId(seat)!;
            await item.room.remove(seat); used.delete(id); this.rest(id);
          }
          item.rotateAt = this.nextRotation();
        }
        const target = plan.kind === 'showcase' ? (plan.game === 'tavla' ? 2 : 4) : plan.waitingBots!;
        const candidates = this.candidates(snapshot, used, plan.bet);
        for (const character of candidates) {
          if (this.stopping || item.room.size >= target || used.size >= snapshot.control.max_active) break;
          const live = item.room.status();
          if (live.phase !== 'waiting' || live.starting || live.disposed) break;
          const size = plan.game === 'tavla' ? 2 : 4;
          const seat = Array.from({ length: size }, (_, i) => i).find(s => !live.occupiedSeats.includes(s));
          if (seat === undefined) break;
          if (!await this.funded(character, plan.bet)) continue;
          if (this.stopping) break;
          await item.room.reserve(character.id, seat); used.add(character.id);
        }
      } catch (e) { this.note(plan.key, e); }
    }
    for (const character of this.candidates(snapshot, used, 0)) {
      if (this.stopping || this.lobby.size >= this.lobbyTarget || used.size >= snapshot.control.max_active) break;
      try {
        await this.funded(character, 0);
        if (this.stopping) break;
        const lease = await this.storage.claim(character.id, this.owner, randomUUID());
        this.lobby.set(character.id, { lease, rotateAt: this.nextRotation() }); used.add(character.id);
      } catch (e) { this.note('lobby', e); }
    }
  }

  /** Trusted invite bridge only. The caller must authenticate and authorize the human inviter. */
  invite(characterId: string, key: string, seat: number): Promise<void> {
    return this.serial(async () => {
      const snapshot = await this.storage.snapshot();
      const item = this.managed.get(key);
      const state = item?.room.status();
      if (this.stopping || snapshot.control.mode !== 'running' || !item || !state || state.phase !== 'waiting'
        || state.starting || state.disposed || !state.humanSeats.length) throw new Error('population_invite_unavailable');
      if (item.room.characterId(seat) === characterId) return;
      if (!Number.isInteger(seat) || seat < 0 || seat >= (item.room.game === 'tavla' ? 2 : 4)
        || state.occupiedSeats.includes(seat)) throw new Error('population_seat_unavailable');
      const lobby = this.lobby.get(characterId);
      if (!lobby) throw new Error('population_character_not_invitable');
      const character = snapshot.characters.find(c => c.id === characterId && c.enabled);
      if (!character || character.chips < item.room.bet) throw new Error('insufficient_chips');
      // Release then claim cannot double-seat: SQL claims are exclusive. Failed transfers go
      // offline, not back into community under a stale lease. Atomic transfer can replace this.
      await this.storage.release(characterId, this.owner, lobby.lease.token);
      this.lobby.delete(characterId);
      await item.room.reserve(characterId, seat);
    });
  }
}
