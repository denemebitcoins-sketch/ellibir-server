import { randomUUID } from 'node:crypto';
import { matchMaker, Room } from '@colyseus/core';
import { PopulationRoomProvider, PopulationTablePlan } from './director';
import { PopulationRoomBinding } from './roomBinding';
import { PopulationRoomSession } from './roomSession';
import { PopulationRoomLease, PopulationStorage } from './storage';

interface Held {
  lease: PopulationRoomLease;
  storage: PopulationStorage;
  room?: Room;
  binding?: PopulationRoomBinding;
  released?: boolean;
  cleanupOnly?: boolean;
  adopted?: boolean;
}

/** Real local Colyseus rooms; SQL reserves logical tables across process incarnations.
 * No constructor/startup side effects. The director owns this provider's tick lifecycle.
 */
export class ColyseusPopulationProvider implements PopulationRoomProvider {
  private readonly held = new Map<string, Held>();
  private readonly pending = new Map<string, string>();
  private readonly previousTable = new Map<string, number>();

  constructor(private readonly random: () => number = Math.random) {}

  async inviteTarget(uid: string): Promise<{key: string; seat: number} | null> {
    for (const [key, held] of this.held) {
      if (held.released || held.cleanupOnly || !held.room || !held.binding?.session || held.binding.session.isDisposed) continue;
      if (held.binding.session.size && !held.binding.session.canPlay) continue;
      const seat = (held.room as any).populationInviteSeat?.(uid);
      if (Number.isInteger(seat) && seat >= 0) return {key,seat};
    }
    return null;
  }

  async adopt(uid: string, storage: PopulationStorage, owner: string, maxBet: number): Promise<PopulationRoomSession | null> {
    for (const listing of await matchMaker.query()) {
      const room: any = matchMaker.getLocalRoomById(listing.roomId);
      const plan: PopulationTablePlan | null = room?.populationAdoption?.(uid) ?? null;
      if (!plan || plan.bet > maxBet || this.held.has(plan.key)) continue;
      // Ordinary rooms are untouched unless a seated, compatible human explicitly invites.
      if ((await storage.rooms()).some(h => h.room_key === plan.key)) continue;
      const valid = () => {
        if (matchMaker.getLocalRoomById(listing.roomId) !== room) return false;
        const current = room.populationAdoption?.(uid);
        return current && current.key === plan.key && current.bet === plan.bet && current.game === plan.game
          && current.team === plan.team && current.table === plan.table;
      };
      if (!valid()) continue;
      const token = randomUUID();
      let held: Held | undefined;
      try {
        let lease: PopulationRoomLease;
        try { lease = await storage.claimRoom(plan.key, owner, token, plan.game, plan.team, plan.table, plan.bet); }
        catch (error) {
          const recorded = (await storage.rooms()).find(h => h.room_key === plan.key);
          if (!recorded || recorded.owner_id !== owner || recorded.token !== token) throw error;
          lease = recorded;
        }
        held = {lease, storage, room, cleanupOnly: true, adopted: true};
        this.held.set(plan.key, held);
        if (!valid()) return null;
        try { held.lease = await storage.publishRoom(plan.key, owner, token, room.roomId); }
        catch (error) {
          const recorded = (await storage.rooms()).find(h => h.room_key === plan.key);
          if (!recorded || recorded.owner_id !== owner || recorded.token !== token || recorded.room_id !== room.roomId) throw error;
          held.lease = recorded;
        }
        // The player may leave, another client may join, or entry may start during either RPC.
        // Bind only after the final synchronous eligibility check; never replace the room/game.
        if (!valid()) return null;
        held.binding = new PopulationRoomBinding(storage, owner, plan.key, plan.bet);
        held.binding.attach(room);
        held.cleanupOnly = false;
        held.binding.session!.acceptNewMatches(true);
        return held.binding.session!;
      } finally {
        if (held?.cleanupOnly) {
          await this.release(held);
          this.held.delete(plan.key);
        }
      }
    }
    return null;
  }

  async open(plan: PopulationTablePlan, storage: PopulationStorage, owner: string): Promise<PopulationRoomSession | null> {
    if (!plan.tablePool) return this.openAtTable(plan, storage, owner);
    // The quota key stays stable across table moves, so another worker cannot provision
    // a second copy of this game quota. Existing/uncertain leases must be recovered in place.
    const hosts = await storage.rooms();
    const existing = this.held.get(plan.key)?.lease ?? hosts.find(h => h.room_key === plan.key);
    if (existing) return this.openAtTable({...plan, table: existing.table_no}, storage, owner);
    const tables = plan.tablePool.filter(n => n !== this.previousTable.get(plan.key));
    for (let i = tables.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [tables[i], tables[j]] = [tables[j], tables[i]];
    }
    for (const table of tables) {
      if (hosts.some(h => h.game === plan.game && h.team_mode === plan.team && h.table_no === table)) continue;
      const name = plan.game === '51' ? 'ellibir' : plan.game === 'ihale' ? 'ihale' : plan.game === 'tavla' ? 'tavla' : 'okey';
      const filters = {name, mode: plan.team ? 'duo' : 'solo', table,
        ...(name === 'okey' ? {variant: plan.game} : {})};
      if ((await matchMaker.query(filters)).length) continue;
      const session = await this.openAtTable({...plan, table}, storage, owner);
      if (session) return session;
      // A competing owner may have claimed the quota, even on a different table.
      if ((await storage.rooms()).some(h => h.room_key === plan.key)) return null;
    }
    return null;
  }

  private async openAtTable(plan: PopulationTablePlan, storage: PopulationStorage, owner: string): Promise<PopulationRoomSession | null> {
    let held = this.held.get(plan.key);
    if (!held) {
      const token = this.pending.get(plan.key) ?? randomUUID();
      this.pending.set(plan.key, token);
      let lease: PopulationRoomLease;
      try { lease = await storage.claimRoom(plan.key, owner, token, plan.game, plan.team, plan.table, plan.bet); }
      catch (error) {
        const hosts = await storage.rooms();
        const recorded = hosts.find(h => h.room_key === plan.key);
        if (!recorded || recorded.owner_id !== owner || recorded.token !== token) {
          this.pending.delete(plan.key);
          if (recorded || hosts.some(h => h.game === plan.game && h.team_mode === plan.team && h.table_no === plan.table)) return null;
          throw error;
        }
        lease = recorded;
      }
      held = { lease, storage }; this.held.set(plan.key, held); this.pending.delete(plan.key);
    }
    if (held.lease.owner_id !== owner || held.storage !== storage) throw new Error('population_provider_owner');
    const name = plan.game === '51' ? 'ellibir' : plan.game === 'ihale' ? 'ihale' : plan.game === 'tavla' ? 'tavla' : 'okey';
    const mode = plan.team ? 'duo' : 'solo';
    const filters: any = { name, mode, table: plan.table };
    if (name === 'okey') filters.variant = plan.game;

    // The prior authority has expired and SQL already refunded its orphan escrow.
    // Close only that exact recorded room, never an unrelated human-created room.
    if (held.lease.previous_room_id && held.lease.previous_room_id !== held.room?.roomId) {
      const old = await matchMaker.getRoomById(held.lease.previous_room_id);
      if (old) await matchMaker.remoteRoomCall(old.roomId, 'disconnect');
    }
    if (!held.room) {
      if ((await matchMaker.query(filters)).length) {
        await this.release(held); this.held.delete(plan.key); return null;
      }
      held.binding = new PopulationRoomBinding(storage, owner, plan.key, plan.bet);
      const listing = await matchMaker.handleCreateRoom(name, {
        mode, table: plan.table, bet: plan.bet,
        ...(name === 'okey' ? { variant: plan.game, rules: { variant: plan.game } } : {}),
        _populationBinding: held.binding,
      });
      held.room = matchMaker.getLocalRoomById(listing.roomId);
      if (!held.room || !held.binding.session) throw new Error('population_room_binding_missing');
      // A human joinOrCreate may have raced our provisioning. Never displace their table.
      if ((await matchMaker.query(filters)).some(r => r.roomId !== held!.room!.roomId)) {
        await held.binding.session.retire(); await this.release(held);
        if (!held.binding.session.status().humanSeats.length) await held.room.disconnect();
        this.held.delete(plan.key); return null;
      }
    }
    try { held.lease = await storage.publishRoom(plan.key, owner, held.lease.token, held.room.roomId); }
    catch (error) {
      const recorded = (await storage.rooms()).find(h => h.room_key === plan.key);
      if (!recorded || recorded.owner_id !== owner || recorded.token !== held.lease.token || recorded.room_id !== held.room.roomId) throw error;
      held.lease = recorded;
    }
    const session = held.binding!.session!;
    session.acceptNewMatches(true);
    return session;
  }

  async heartbeat(): Promise<void> {
    let firstError: unknown;
    for (const [key, held] of this.held) {
      if (held.released) continue;
      try {
        if (held.cleanupOnly) {
          await this.release(held); this.held.delete(key); continue;
        }
        held.lease = await held.storage.heartbeatRoom(key, held.lease.owner_id, held.lease.token);
        held.binding?.session?.setAuthority(true);
      } catch (error) {
        if (held.cleanupOnly) { firstError ??= error; continue; }
        held.binding?.session?.setAuthority(false);
        firstError ??= error;
        try {
          const recorded = (await held.storage.rooms()).find(h => h.room_key === key);
          const lost = !recorded || recorded.owner_id !== held.lease.owner_id || recorded.token !== held.lease.token
            || Date.parse(recorded.expires_at) <= Date.now();
          if (lost) {
            // Authority is gone, not a normal graceful drain. Refund from the immutable receipt
            // (idempotently if another worker already recovered it), then close the old transport.
            await held.binding?.session?.dispose();
            await held.room?.disconnect();
            await this.release(held);
            this.held.delete(key);
          }
        } catch { /* retain ownership record and retry cleanup; never allocate over it */ }
      }
    }
    if (firstError) throw firstError;
  }

  private async release(held: Held): Promise<void> {
    if (held.released) return;
    const { room_key, owner_id, token } = held.lease;
    try { await held.storage.releaseRoom(room_key, owner_id, token); }
    catch (error) {
      const recorded = (await held.storage.rooms()).find(h => h.room_key === room_key);
      if (recorded?.owner_id === owner_id && recorded.token === token) throw error;
    }
    held.released = true;
  }
  async retired(session: PopulationRoomSession): Promise<void> {
    const held = this.held.get(session.room);
    if (!held || held.binding?.session !== session) return;
    this.previousTable.set(session.room, held.lease.table_no);
    await this.release(held);
    if (session.status().humanSeats.length || (held.adopted && held.room?.clients.length)) this.held.delete(session.room);
  }
  async close(session: PopulationRoomSession): Promise<void> {
    const held = this.held.get(session.room);
    if (!held || held.binding?.session !== session) return;
    if (!session.status().humanSeats.length) await held.room?.disconnect();
    await this.release(held);
    this.held.delete(session.room);
  }
}
