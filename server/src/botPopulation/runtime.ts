import { randomUUID } from 'node:crypto';
import { PopulationStorage } from './storage';
import { PopulationDirector, PopulationRoomProvider, PopulationTablePlan } from './director';
import { ColyseusPopulationProvider } from './colyseusProvider';

export function defaultPopulationPlans(): PopulationTablePlan[] {
  const games = ['51','duz','banko','yuzbir','ihale','tavla'] as const;
  return [
    ...games.map(game => ({ key: `${game}:solo:2`, game, team: false, table: 2, bet: 500,
      kind: 'waiting' as const, waitingBots: game === 'tavla' ? 1 : 2 })),
    { key: 'ihale:team:1', game: 'ihale', team: true, table: 1, bet: 500, kind: 'showcase' },
    { key: 'tavla:solo:1', game: 'tavla', team: false, table: 1, bet: 500, kind: 'showcase' },
  ];
}

export class PopulationRuntime {
  private director: PopulationDirector | null = null;
  private provider: PopulationRoomProvider | null = null;
  private pending: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seeded = false;
  private stopped = false;
  private error = '';
  private lastTick = '';
  constructor(readonly storage = new PopulationStorage(), readonly owner = randomUUID(),
    private readonly providerFactory: () => PopulationRoomProvider = () => new ColyseusPopulationProvider()) {}

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { await this.pending; } catch { }
    await this.director?.requestDrain();
  }
  status() { return { last_tick: this.lastTick, error: this.error, director: this.director?.status() ?? null }; }
  async invite(uid: string, character: string): Promise<void> {
    if (this.stopped) throw new Error('population_stopping');
    if (!uid || !/^b0700000-0000-4000-8000-\d{12}$/.test(character)) throw new Error('population_invite_invalid');
    await this.tick();
    const target = await this.provider?.inviteTarget?.(uid);
    if (!target || !this.director) throw new Error('population_invite_unavailable');
    await this.director.invite(character,target.key,target.seat);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async update() {
    try {
      if (!this.seeded) { await this.storage.seed(); this.seeded = true; }
      const progression = await this.storage.processProgression();
      const snapshot = await this.storage.snapshot();
      if (snapshot.control.mode !== 'running') await this.storage.recoverExpired();
      if (snapshot.control.mode === 'running' && !this.director) {
        this.provider = this.providerFactory();
        this.director = new PopulationDirector(this.storage, this.owner, defaultPopulationPlans(), this.provider, 3);
      }
      if (this.director) await this.director.tick();
      const state = this.director?.status();
      if (snapshot.control.mode !== 'running' && (!state || (!state.tables.length && !state.lobby.length))) {
        this.director = null;
        this.provider = null;
        if (snapshot.control.mode === 'draining')
          await this.storage.completeDrain();
      }
      this.lastTick = new Date().toISOString(); this.error = '';
      await this.storage.health(this.owner, true, '', { tables: state?.tables.length ?? 0,
        lobby: state?.lobby.length ?? 0, progression_pending: progression.pending,
        errors: [...(state?.errors ?? []).map(() => 'population_operation_failed'),
          ...(progression.failed ? ['population_progression_retry'] : [])] });
    } catch (error) {
      // Do not echo HTTP bodies or credentials to an admin-facing health record.
      this.error = 'population_runtime_failed';
      try { await this.storage.health(this.owner, false, this.error, {}); } catch { /* database may be unavailable */ }
      throw error;
    }
  }
}
