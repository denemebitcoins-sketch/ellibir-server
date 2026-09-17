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
export type PopulationRpc = (name: string, args: Record<string, unknown>) => Promise<any>;

/** No startup side effects: seed/control/claims require explicit orchestration.
 * The same RPC contract runs against local SQL in tests, never a fake human account.
 */
export class PopulationStorage {
  constructor(private readonly call: PopulationRpc = rpcService) {}

  seed(): Promise<{ ok: boolean; added: number }> {
    return this.call('bot_population_seed', { p_characters: initialCharacters() });
  }
  snapshot(): Promise<PopulationSnapshot> { return this.call('bot_population_snapshot', {}); }
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
  health(owner: string, ready: boolean, error: string, details: Record<string, unknown>): Promise<boolean> {
    return this.call('bot_population_runtime_health', { p_owner: owner, p_ready: ready, p_error: error, p_details: details });
  }
}
