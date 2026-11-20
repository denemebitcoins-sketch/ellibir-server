import { rpcService } from '../supabase';
import { initialCharacters, CharacterSeed } from './characters';

export type PopulationMode = 'off' | 'running' | 'draining';
export type PopulationGame = '51' | 'duz' | 'banko' | 'yuzbir' | 'ihale' | 'tavla';
export interface PopulationControl { mode: PopulationMode; max_active: number; revision: number; }
export interface CharacterRecord extends CharacterSeed { chips: number; enabled: boolean; last_refill_day: string | null; }
export interface CharacterLease {
  character_id: string;
  owner_id: string;
  token: string;
  expires_at: string;
  entered_at: string;
  room_key: string | null;
  seat: number | null;
  game: PopulationGame | null;
  bet: number | null;
  active_match: string | null;
}
export interface PopulationSnapshot { control: PopulationControl; characters: CharacterRecord[]; leases: CharacterLease[]; }
export interface PopulationRoomLease {
  room_key: string;
  game: PopulationGame;
  team_mode: boolean;
  table_no: number;
  bet: number;
  owner_id: string;
  token: string;
  expires_at: string;
  room_id: string | null;
  previous_room_id: string | null;
}
export type PopulationParticipant = { seat: number; kind: 'human'; id: string }
  | { seat: number; kind: 'bot'; id: string; token: string };
export interface PopulationMatch {
  match_key: string;
  owner_id: string;
  room_key: string;
  game: PopulationGame;
  bet: number;
  team_mode: boolean;
  roster: PopulationParticipant[];
  state: 'active' | 'settled' | 'refunded';
  winner_seat: number | null;
  house_amount: number;
}
export type PopulationRpc = (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

/** No startup side effects: seed/control/claims require explicit orchestration.
 * The same RPC contract runs against local SQL in tests, never a fake human account.
 */
export interface PopulationStorageOptions {
  /** Hafif okumalar (snapshot_lite/control_state). Varsayılan: yalnız gerçek Supabase çağrısında açık. */
  lite?: boolean;
  /** Karakterlerin sabit alanlarının (isim/cinsiyet/avatar/VIP) tam listeden tazelenme aralığı. */
  fullRefreshMs?: number;
  now?: () => number;
}
type LiteSnapshot = { control: PopulationControl; chips: [string, number, boolean, string | null][]; leases: CharacterLease[] };
const isLite = (v: any): v is LiteSnapshot => !!v && typeof v === 'object' && !!v.control && Array.isArray(v.chips) && Array.isArray(v.leases);

export class PopulationStorage {
  private lite: boolean;
  private readonly fullRefreshMs: number;
  private readonly now: () => number;
  private roster: Map<string, CharacterRecord> | null = null;
  private rosterAt = 0;

  constructor(private readonly call: PopulationRpc = rpcService, options: PopulationStorageOptions = {}) {
    this.lite = options.lite ?? call === rpcService;
    this.fullRefreshMs = options.fullRefreshMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** 20.11 EGRESS: her turda 100 karakterin tüm alanlarını çekmek günde ~275 MB dışarı veri yapıyordu.
   *  Artık turda yalnız [id, chips, enabled, last_refill_day] + kiralar gelir; sabit alanlar 10 dk'da bir
   *  (ya da bilinmeyen karakter görülünce) tam listeden tazelenir. Dönen nesneler her çağrıda YENİ
   *  kopyalardır (çağıranlar chips'i yerinde değiştiriyor). Hafif fonksiyon yoksa eski tam okumaya düşer. */
  async snapshot(): Promise<PopulationSnapshot> {
    if (!this.lite) return this.call('bot_population_snapshot', {});
    let lite: unknown;
    try { lite = await this.call('bot_population_snapshot_lite', {}); }
    catch (e: any) {
      if (!/_http_404|PGRST202|does not exist|could not find/i.test(String(e?.message ?? e))) throw e;
      lite = null;
    }
    if (!isLite(lite)) { this.lite = false; return this.call('bot_population_snapshot', {}); }
    const stale = !this.roster || this.now() - this.rosterAt >= this.fullRefreshMs
      || lite.chips.some(([id]) => !this.roster!.has(id));
    if (stale) {
      const full: PopulationSnapshot = await this.call('bot_population_snapshot', {});
      this.roster = new Map(full.characters.map(c => [c.id, { ...c }]));
      this.rosterAt = this.now();
      // Tam okuma zaten en taze veri: doğrudan onu (kopya olarak) döndür.
      return { control: full.control, characters: full.characters.map(c => ({ ...c })), leases: full.leases };
    }
    const characters = lite.chips.map(([id, chips, enabled, last_refill_day]) =>
      ({ ...this.roster!.get(id)!, chips: Number(chips), enabled, last_refill_day }));
    return { control: lite.control, characters, leases: lite.leases };
  }

  /** Yalnız mod/limit (runtime turu). Hafif fonksiyon yoksa snapshot'tan okunur. */
  async controlState(): Promise<PopulationControl> {
    if (this.lite) {
      try {
        const c = await this.call('bot_population_control_state', {});
        if (c && typeof c === 'object' && typeof c.mode === 'string') return c;
      } catch (e: any) {
        if (!/_http_404|PGRST202|does not exist|could not find/i.test(String(e?.message ?? e))) throw e;
      }
    }
    return (await this.snapshot()).control;
  }

  seed(): Promise<{ ok: boolean; added: number }> {
    return this.call('bot_population_seed', { p_characters: initialCharacters() });
  }
  control(expectedRevision: number, mode: PopulationMode, maxActive: number, actor: string): Promise<PopulationControl> {
    return this.call('bot_population_control', {
      p_expected_revision: expectedRevision, p_mode: mode, p_max_active: maxActive, p_actor: actor,
    });
  }
  claim(character: string, owner: string, token: string,
    target?: { room: string; seat: number; game: PopulationGame; bet: number }): Promise<CharacterLease> {
    return this.call('bot_population_claim', { p_character: character, p_owner: owner, p_token: token,
      p_room: target?.room ?? null, p_seat: target?.seat ?? null, p_game: target?.game ?? null, p_bet: target?.bet ?? null });
  }
  heartbeat(character: string, owner: string, token: string): Promise<CharacterLease> {
    return this.call('bot_population_heartbeat', { p_character: character, p_owner: owner, p_token: token });
  }
  release(character: string, owner: string, token: string): Promise<boolean> {
    return this.call('bot_population_release', { p_character: character, p_owner: owner, p_token: token });
  }
  refill(character: string): Promise<{ ok: boolean; refilled: boolean; chips: number }> {
    return this.call('bot_population_refill', { p_character: character });
  }
  beginMatch(match: string, owner: string, room: string, game: PopulationGame, bet: number,
    team: boolean, roster: PopulationParticipant[]): Promise<PopulationMatch> {
    return this.call('bot_population_begin_match', { p_match: match, p_owner: owner, p_room: room,
      p_game: game, p_bet: bet, p_team: team, p_roster: roster });
  }
  finishMatch(match: string, owner: string, winner: number | null): Promise<PopulationMatch> {
    return this.call('bot_population_finish_match', { p_match: match, p_owner: owner, p_winner: winner });
  }
  /** 19.11: maçtan kalıcı ayrılan insanın aktif-kimlik kilidini kaldırır (hesaplaşmaya dokunmaz). */
  releaseHuman(match: string, owner: string, user: string): Promise<boolean> {
    return this.call('bot_population_release_human', { p_match: match, p_owner: owner, p_user: user });
  }
  match(match: string): Promise<PopulationMatch | null> {
    return this.call('bot_population_get_match', { p_match: match });
  }
  claimRoom(room: string, owner: string, token: string, game: PopulationGame, team: boolean, table: number, bet: number): Promise<PopulationRoomLease> {
    return this.call('bot_population_claim_room', { p_room: room, p_owner: owner, p_token: token, p_game: game,
      p_team: team, p_table: table, p_bet: bet });
  }
  publishRoom(room: string, owner: string, token: string, roomId: string): Promise<PopulationRoomLease> {
    return this.call('bot_population_publish_room', { p_room: room, p_owner: owner, p_token: token, p_room_id: roomId });
  }
  /** Devralınan masanın gerçek el/puan etiketi (salon). Eski veritabanında fonksiyon yoksa sessizce geçilir. */
  async setRoomInfo(room: string, owner: string, token: string, info: string | null): Promise<boolean> {
    try { return !!(await this.call('bot_population_set_room_info', { p_room: room, p_owner: owner, p_token: token, p_info: info })); }
    catch { return false; }
  }
  heartbeatRoom(room: string, owner: string, token: string): Promise<PopulationRoomLease> {
    return this.call('bot_population_heartbeat_room', { p_room: room, p_owner: owner, p_token: token });
  }
  releaseRoom(room: string, owner: string, token: string): Promise<boolean> {
    return this.call('bot_population_release_room', { p_room: room, p_owner: owner, p_token: token });
  }
  rooms(): Promise<PopulationRoomLease[]> { return this.call('bot_population_get_rooms', {}); }
  adminReport(): Promise<any> { return this.call('bot_population_admin_report', {}); }
  completeDrain(): Promise<boolean> { return this.call('bot_population_complete_drain', {}); }
  recoverExpired(): Promise<number> { return this.call('bot_population_recover_expired', {}); }
  processProgression(): Promise<{processed:number;failed:number;pending:number}> {
    return this.call('bot_population_process_progression', {});
  }
  processSocial(): Promise<{emitted:number}> { return this.call('bot_population_process_social', {}, 3000); }
  health(owner: string, ready: boolean, error: string, details: Record<string, unknown>): Promise<boolean> {
    return this.call('bot_population_runtime_health', { p_owner: owner, p_ready: ready, p_error: error, p_details: details });
  }
}
