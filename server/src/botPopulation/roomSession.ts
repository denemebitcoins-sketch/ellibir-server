import { randomUUID } from 'node:crypto';
import { PopulationTableChat } from './tableChat';
import { CharacterLease, CharacterRecord, PopulationGame, PopulationMatch, PopulationParticipant, PopulationStorage } from './storage';

export interface PopulationRoomHost {
  canReserve(seat: number): boolean;
  canRemove(seat: number): boolean;
  changed(): void;
  status(): PopulationRoomStatus;
  accepting(value: boolean): void;
  detached(seats: number[]): void;
  chat?(payload: {seat:number;name:string;text:string;uid:string;isSystemBot:true}): void;
}
export interface PopulationRoomStatus {
  phase: 'waiting' | 'playing' | 'ended';
  humanSeats: number[];
  occupiedSeats: number[];
  starting: boolean;
  disposed: boolean;
}
interface Occupant { character: CharacterRecord; lease: CharacterLease; }

/** Server-process capability only: never construct from client join options.
 * Holds no game AI. Existing room engines consume its explicit bot seat identities.
 */
export class PopulationRoomSession {
  private readonly occupants = new Map<number, Occupant>();
  private readonly pendingSeats = new Set<number>();
  private fenced = false;
  private authorityFenced = false;
  private disposed = false;
  private renewing: Promise<void> | null = null;
  private entry: Promise<PopulationMatch> | null = null;
  private pendingMatch: string | null = null;
  private current: PopulationMatch | null = null;
  private readonly retiringSeats = new Set<number>();
  private readonly social = new PopulationTableChat();

  constructor(readonly storage: PopulationStorage, readonly owner: string, readonly room: string,
    readonly game: PopulationGame, readonly bet: number, private readonly host: PopulationRoomHost) {
    if (!(storage instanceof PopulationStorage)) throw new Error('population_server_capability_required');
    if (!Number.isInteger(bet) || bet < 500 || bet > 5000 || bet % 500 !== 0) throw new Error('population_bet_invalid');
  }

  get size() { return this.occupants.size; }
  get activeMatch() { return this.current?.state === 'active'; }
  get hasMatch() { return this.current !== null; }
  get isDisposed() { return this.disposed; }
  get canPlay() {
    return !this.disposed && !this.fenced && !this.authorityFenced && this.size > 0
      && [...this.occupants.values()].every(o => Date.parse(o.lease.expires_at) > Date.now());
  }
  seats(): number[] { return [...this.occupants.keys()]; }
  blockedSeats(): number[] { return [...new Set([...this.seats(), ...this.pendingSeats])]; }
  has(seat: number) { return this.occupants.has(seat); }
  name(seat: number) { return this.occupants.get(seat)?.character.name; }
  characterId(seat: number) { return this.occupants.get(seat)?.character.id; }
  status(): PopulationRoomStatus { return this.host.status(); }
  acceptNewMatches(value: boolean): void { this.host.accepting(value); }
  setAuthority(available: boolean): void {
    if (this.authorityFenced === !available) return;
    this.authorityFenced = !available;
    this.host.changed();
  }

  /** Graceful drain never refunds an ongoing game or interrupts an in-flight entry. */
  async retire(): Promise<boolean> {
    this.host.accepting(false);
    const status = this.host.status();
    if ((!status.disposed && status.phase === 'playing') || status.starting || this.entry || this.pendingSeats.size || this.activeMatch || this.pendingMatch)
      return false;
    for (const seat of this.seats()) this.retiringSeats.add(seat);
    await this.dispose();
    this.host.detached([...this.retiringSeats]);
    this.retiringSeats.clear();
    return true;
  }

  async reserve(characterId: string, seat: number): Promise<void> {
    const count = this.game === 'tavla' ? 2 : 4;
    if (this.disposed || this.authorityFenced || this.entry || this.activeMatch || !Number.isInteger(seat) || seat < 0 || seat >= count
      || this.blockedSeats().includes(seat) || !this.host.canReserve(seat)) throw new Error('population_seat_unavailable');
    this.pendingSeats.add(seat);
    let lease: CharacterLease | null = null;
    try {
      const snapshot = await this.storage.snapshot();
      const character = snapshot.characters.find(c => c.id === characterId && c.enabled);
      if (!character) throw new Error('character_unavailable');
      lease = await this.storage.claim(characterId, this.owner, randomUUID(), { room: this.room, seat, game: this.game, bet: this.bet });
      if (this.disposed || this.entry || this.activeMatch || !this.host.canReserve(seat)) throw new Error('population_seat_changed');
      this.occupants.set(seat, { character, lease });
    } catch (error) {
      if (lease) await this.releaseLease(characterId, lease.token);
      throw error;
    } finally { this.pendingSeats.delete(seat); this.host.changed(); }
  }

  async remove(seat: number): Promise<void> {
    if (this.entry || this.activeMatch || this.pendingSeats.has(seat) || !this.host.canRemove(seat))
      throw new Error('population_seat_pinned');
    const o = this.occupants.get(seat);
    if (!o) return;
    this.pendingSeats.add(seat);
    try {
      await this.releaseLease(o.character.id, o.lease.token);
      this.occupants.delete(seat);
    } finally { this.pendingSeats.delete(seat); this.host.changed(); }
  }

  /** Public display metadata only: no lease tokens, owner IDs or private bot hands. */
  decorate(row: any): void {
    const o = this.occupants.get(row.seat);
    if (!o) return;
    Object.assign(row, { name: o.character.name, uid: `bot:${o.character.id}`, isBot: true, isSystemBot: true,
      populationBotId: o.character.id, chips: o.character.chips, gender: o.character.gender,
      role: o.character.cosmetic_vip ? 'vip' : 'normal', avatarKey: o.character.avatar_key });
  }

  renew(): Promise<void> {
    if (this.renewing) return this.renewing;
    this.renewing = this.renewAll().finally(() => { this.renewing = null; });
    return this.renewing;
  }
  private async renewAll() {
    if (this.disposed) return;
    try {
      for (const o of this.occupants.values()) o.lease = await this.storage.heartbeat(o.character.id, this.owner, o.lease.token);
      this.fenced = false;
    } catch (error) { this.fenced = true; throw error; }
    finally { this.host.changed(); }
  }

  begin(humans: ReadonlyMap<number, string>, team: boolean): Promise<PopulationMatch> {
    if (this.entry) return this.entry;
    if (!this.canPlay || this.pendingSeats.size || this.activeMatch) return Promise.reject(new Error('population_not_ready'));
    const roster: PopulationParticipant[] = [...humans].map(([seat, id]) => ({ seat, kind: 'human', id }));
    for (const [seat, o] of this.occupants) roster.push({ seat, kind: 'bot', id: o.character.id, token: o.lease.token });
    this.entry = this.beginRecorded(roster, team).finally(() => { this.entry = null; });
    return this.entry;
  }
  private async beginRecorded(roster: PopulationParticipant[], team: boolean): Promise<PopulationMatch> {
    // Reconcile an uncertain prior response before issuing another debit with a new key.
    if (this.pendingMatch) {
      const prior = await this.storage.match(this.pendingMatch);
      if (prior?.state === 'active') await this.storage.finishMatch(prior.match_key, this.owner, null);
      this.pendingMatch = null;
    }
    const key = `population:${randomUUID()}`;
    this.pendingMatch = key;
    try { this.current = await this.storage.beginMatch(key, this.owner, this.room, this.game, this.bet, team, roster); }
    catch (error) {
      // A lost HTTP reply is not proof that the transaction failed.
      const committed = await this.storage.match(key);
      if (!committed || committed.state !== 'active') { this.pendingMatch = null; throw error; }
      this.current = committed;
    }
    this.pendingMatch = null;
    for (const o of this.occupants.values()) o.character.chips -= this.bet;
    this.say('start');
    return this.current;
  }

  async finish(winner: number | null): Promise<void> {
    if (!this.current) throw new Error('population_match_missing');
    const key = this.current.match_key;
    try { this.current = await this.storage.finishMatch(key, this.owner, winner); }
    catch (error) {
      const committed = await this.storage.match(key);
      if (!committed || committed.state === 'active' || committed.winner_seat !== winner) throw error;
      this.current = committed;
    }
    if (winner !== null) this.say('finish');
    const snapshot = await this.storage.snapshot();
    for (const o of this.occupants.values()) {
      const character = snapshot.characters.find(c => c.id === o.character.id);
      if (character) o.character = character;
      const lease = snapshot.leases.find(l => l.character_id === o.character.id && l.token === o.lease.token);
      if (lease) o.lease = lease;
    }
  }

  resetMatch(): void {
    if (this.activeMatch || this.entry || this.pendingMatch) throw new Error('population_match_not_settled');
    this.current = null;
  }
  private say(event: 'start'|'finish') {
    if (!this.current || this.disposed || !this.canPlay) return;
    const text = this.social.message(this.current.match_key,event,this.host.status().humanSeats.length>0);
    const seats=this.seats();
    if (!text || !seats.length) return;
    const seat=seats[Math.floor(Math.random()*seats.length)],o=this.occupants.get(seat)!;
    try { this.host.chat?.({seat,name:o.character.name,text,uid:`bot:${o.character.id}`,isSystemBot:true}); }
    catch { /* Social feedback must not fail settlement or entry. */ }
  }

  private async releaseLease(character: string, token: string): Promise<void> {
    try { await this.storage.release(character, this.owner, token); }
    catch (error) {
      const lease = (await this.storage.snapshot()).leases.find(l => l.character_id === character);
      // Lost release replies can be followed by another owner's legitimate claim.
      // Forget only our obsolete local ownership; never release that newer lease.
      if (lease?.owner_id === this.owner && lease.token === token) throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.entry) { try { await this.entry; } catch { /* reconcile uncertain receipt below */ } }
    if (this.pendingMatch) {
      const prior = await this.storage.match(this.pendingMatch);
      if (prior?.state === 'active') await this.storage.finishMatch(prior.match_key, this.owner, null);
      this.pendingMatch = null;
    }
    if (this.activeMatch) await this.finish(null);
    for (const [seat, o] of this.occupants) {
      await this.releaseLease(o.character.id, o.lease.token);
      this.occupants.delete(seat);
    }
  }
}
