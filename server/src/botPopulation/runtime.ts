import { TABLE_BET_MIN } from '../tableBets';
import { randomUUID } from 'node:crypto';
import { PopulationStorage } from './storage';
import { PopulationDirector, PopulationRoomProvider, PopulationTablePlan } from './director';
import { ColyseusPopulationProvider } from './colyseusProvider';

export function defaultPopulationPlans(): PopulationTablePlan[] {
  const games = ['51','duz','banko','yuzbir','ihale','tavla'] as const;
  const tablePool = Array.from({length: 8}, (_, i) => i + 1);
  return [
    ...games.map(game => ({ key: `${game}:waiting`, game, team: false, table: 2, tablePool, bet: TABLE_BET_MIN,
      kind: 'waiting' as const, waitingBots: game === 'tavla' ? 1 : game === '51' || game === 'duz' ? 3 : 2 })),
  ];
}

/** Botlar aktifken (running/draining) yönetici döngü sıklığı. */
export const POPULATION_ACTIVE_TICK_MS = 10_000;
/** Botlar KAPALI (off) iken: sadece mod kontrolü + sağlık kaydı, 10 dakikada bir.
 *  Admin panelinden açma komutu ve rapor isteği döngüyü anında tetikler (gecikme yok). */
export const POPULATION_IDLE_TICK_MS = 600_000;
/** Bot açıkken bu kadar tur (≈1 dk) hiç bot çıkmazsa yönetici yeniden kurulur. */
export const POPULATION_STUCK_TICKS = 6;

export class PopulationRuntime {
  private idle = false;
  private idleMaintained = false;
  /** 19.11 BEKÇİ: bot açık ama hiç masa/lobi botu yoksa art arda kaç tur geçti (deploy sonrası takılma). */
  private stuckTicks = 0;
  private lastProgressionPending = 0;
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
    this.schedule(0);
  }
  /** Bir sonraki turu kur: kapalıyken 10 dk, aktifken 10 sn (setInterval yerine kendini yeniden kuran zincir). */
  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => {}).finally(() => {
        if (!this.stopped && !this.timer) this.schedule(this.idle ? POPULATION_IDLE_TICK_MS : POPULATION_ACTIVE_TICK_MS);
      });
    }, ms);
    this.timer.unref?.();
  }
  get isIdle() { return this.idle; }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { await this.pending; } catch { }
    await this.director?.requestDrain();
  }
  status() { return { last_tick: this.lastTick, error: this.error, director: this.director?.status() ?? null }; }
  async invite(uid: string, character: string): Promise<void> {
    if (this.stopped) throw new Error('population_stopping');
    if (!uid || !/^b0700000-0000-4000-8000-\d{12}$/.test(character)) throw new Error('population_invite_invalid');
    await this.tick();
    if (!this.director) throw new Error('population_invite_unavailable');
    await this.director.inviteHuman(uid, character);
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
      // KAPALI + bakım zaten yapıldıysa: yalnız modu oku ve sağlık yaz (2 istek). İlerleme/sosyal/kurtarma
      // işleri botlar kapalıyken yapılacak bir şey üretmez; açılınca tam tura geçilir.
      if (this.idle && this.idleMaintained && !this.director) {
        const light = await this.storage.snapshot();
        if (light.control.mode === 'off') {
          this.lastTick = new Date().toISOString(); this.error = '';
          await this.storage.health(this.owner, true, '', { tables: 0, lobby: 0,
            progression_pending: this.lastProgressionPending, target_active: 0,
            active_limit: light.control.max_active, capacity_limited: false, idle: true, errors: [] });
          return;
        }
      }
      const progression = await this.storage.processProgression();
      const snapshot = await this.storage.snapshot();
      await this.storage.recoverExpired();
      if (snapshot.control.mode === 'running' && !this.director) {
        this.provider = this.providerFactory();
        this.director = new PopulationDirector(this.storage, this.owner, defaultPopulationPlans(), this.provider, 3);
      }
      if (this.director) await this.director.tick();
      // 19.11 BEKÇİ: deploy sonrası eski sürecin kiraları yüzünden yönetici boş kalabiliyordu; elle
      // kapat-aç gerekiyordu. Mod açık + hedef > 0 iken ~1 dk boyunca hiç bot yoksa aynısını kendisi yapar.
      if (this.director && snapshot.control.mode === 'running') {
        const st = this.director.status();
        const empty = st.target_active > 0 && st.active_limit > 0 && !st.tables.length && !st.lobby.length;
        this.stuckTicks = empty ? this.stuckTicks + 1 : 0;
        if (this.stuckTicks >= POPULATION_STUCK_TICKS) {
          console.warn('[population] bot yöneticisi boş kaldı → yeniden kuruluyor');
          this.stuckTicks = 0;
          try { await this.director.requestDrain(); } catch { /* kira kurtarma toparlar */ }
          this.director = null; this.provider = null;
          await this.storage.recoverExpired();
          return this.update();
        }
      } else this.stuckTicks = 0;
      let socialError = false;
      try { await this.storage.processSocial(); } catch { socialError = true; }
      const state = this.director?.status();
      if (snapshot.control.mode !== 'running' && (!state || (!state.tables.length && !state.lobby.length))) {
        this.director = null;
        this.provider = null;
        if (snapshot.control.mode === 'draining')
          await this.storage.completeDrain();
      }
      const wasIdle = this.idle;
      this.idle = snapshot.control.mode === 'off' && !this.director;
      this.idleMaintained = this.idle;
      this.lastProgressionPending = progression.pending;
      // Kapalıdan aktife geçildiyse (admin komutu) 10 dk beklemeden hızlı tura dön.
      if (wasIdle && !this.idle && !this.stopped) this.schedule(POPULATION_ACTIVE_TICK_MS);
      this.lastTick = new Date().toISOString(); this.error = '';
      await this.storage.health(this.owner, true, '', { tables: state?.tables.length ?? 0,
        lobby: state?.lobby.length ?? 0, progression_pending: progression.pending,
        target_active: state?.target_active ?? 0, active_limit: snapshot.control.max_active,
        capacity_limited: state?.capacity_limited ?? false,
        errors: [...(state?.errors ?? []).map(() => 'population_operation_failed'),
          ...(socialError ? ['population_social_retry'] : []),
          ...(progression.failed ? ['population_progression_retry'] : [])] });
    } catch (error) {
      // Do not echo HTTP bodies or credentials to an admin-facing health record.
      this.error = 'population_runtime_failed';
      try { await this.storage.health(this.owner, false, this.error, {}); } catch { /* database may be unavailable */ }
      throw error;
    }
  }
}
