import { Room, Client } from '@colyseus/core';
import { createGame, startNextHand } from '../../../packages/engine/src/game';
import { DEFAULT_RULES } from '../../../packages/engine/src/rules';
import { clientViewFor } from '../clientView';
import { applyClientCommand, stepOnce, CmdError } from '../gameCommands';
import { verifyToken, settleMatch } from '../supabase';

/**
 * Bir MASA = bir oda. Engine state odada bellekte. Client protokolü (openSelected,
 * play, isle, continue, move...) gameCommands ile engine Move'a çevrilir.
 * Bot/sorgu adımları TEK TEK, her biri GECİKMELİ ayrı "view" olarak push edilir →
 * botların çekip atması istemcide animasyonlu görünür (Edge "frames" modelinin karşılığı).
 */
export class EllibirRoom extends Room {
  maxClients = 1;

  private game: any;
  private seats = new Map<string, number>();   // sessionId → koltuk
  private humanSeats: number[] = [];
  private handEndTimer: NodeJS.Timeout | null = null;
  private busy = false;                        // runEngine yeniden-giriş kilidi
  private readonly STEP_MS = 850;              // bot adımları arası gecikme (animasyon)
  private cfg: any = null;                     // createGame opts (oyun tüm insanlar gelince kurulur)
  private seatUsers = new Map<number, string>(); // koltuk → Supabase userId (yalnız gerçek oyuncular)
  private bet = 0;                             // masa bahsi (maç sonu settle için)
  private settled = false;                     // çift settle koruması

  onCreate(options: any) {
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    const mode = options?.mode === 'duo' ? 'duo' : 'solo';

    // solo: 1 insan (seat 0) + 3 bot. duo (eşli): 2 insan PARTNER (seat 0,2) + 2 bot (seat 1,3).
    this.humanSeats = mode === 'duo' ? [0, 2] : [0];
    this.maxClients = this.humanSeats.length;
    const botSeats = [0, 1, 2, 3].filter((s) => !this.humanSeats.includes(s));

    // Client'tan gelen kural seti (RuleConfig JSON) — eksik/bozuk alanlar olabilir →
    // DEFAULT_RULES ile MERGE et ki state asla bozulmasın (yoksa emptyView dönerdi). duo → teamMode garanti.
    let parsed: any = null;
    try { parsed = typeof options?.rules === 'string' ? JSON.parse(options.rules) : options?.rules; }
    catch { parsed = null; }
    const rules: any = { ...DEFAULT_RULES, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    if (mode === 'duo') rules.teamMode = true;

    this.bet = Number(options?.bet) || 0;
    // Oyunu HEMEN kurma — tüm insan koltukları dolunca başlat (yoksa bekleyen oyuncu
    // bot'larla oynanmış bir el görür). Şimdilik sadece config sakla.
    this.cfg = { seed, playerNames: names, botSeats, rules };
    this.game = null;
    this.setMetadata({ mode, humans: this.humanSeats.length });

    // Tek mesaj kanalı: client'ın tüm komutları "cmd" (JSON string) olarak gelir.
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game) return;   // oyun henüz başlamadı (rakip bekleniyor)
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      try {
        const r = applyClientCommand(this.game, cmd, seat);
        this.game = r.state;
        this.pushViews();                       // insan hamlesi anında yansır
        if (!r.skipBots) this.runEngine();      // botlar gecikmeli oynar
        else this.checkHandEnd();
      } catch (e: any) {
        // CmdError (protokol) veya MoveError (motor kuralı) → kod+mesaj client'a; gerçek hata → log.
        if (e instanceof CmdError || e?.name === 'MoveError') {
          client.send('moveError', { code: e?.code ?? 'err', message: e?.message ?? '' });
        } else {
          console.error('[cmd] hata:', e?.message, e?.stack);
          client.send('moveError', { code: 'internal', message: e?.message ?? '' });
        }
      }
    });

    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  // Supabase kimliği: token geçerliyse userId döner; denemede token yoksa anon (true) izin.
  async onAuth(_client: Client, options: any): Promise<any> {
    const uid = await verifyToken(options?.token);
    return uid ?? true;
  }

  onJoin(client: Client, _options: any) {
    const taken = new Set(this.seats.values());
    const seat = this.humanSeats.find((s) => !taken.has(s)) ?? this.seats.size;
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();   // tüm insanlar geldiyse oyunu BAŞLAT (kartları şimdi dağıt)
    this.pushViews();
  }

  /// Tüm insan koltukları dolunca oyunu kur ve ilk bot adımlarını işlet.
  private startGameIfReady() {
    if (this.game || this.seats.size < this.humanSeats.length) return;
    this.game = createGame(this.cfg);
    console.log(`[EllibirRoom] oyun başladı, players=${this.game?.players?.length}`);
    this.runEngine();
  }

  async onLeave(client: Client, consented: boolean) {
    if (consented) { this.seats.delete(client.sessionId); return; }
    try {
      await this.allowReconnection(client, 90);
      this.pushViews();
    } catch {
      this.seats.delete(client.sessionId);  // bot devralır
      this.runEngine();
    }
  }

  // İnsan koltuğu mu? (bağlı olmasa bile) → o koltuk sırasında oyun BEKLER, bot oynamaz.
  // Böylece 2. oyuncu masaya gelene kadar onun koltuğunu bot çalmaz.
  private isHumanTurn(seat: number): boolean {
    return this.humanSeats.includes(seat);
  }

  // Bot/sorgu adımlarını TEK TEK, aralarında gecikmeyle oynat ve her adımı push et.
  private async runEngine() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        // ÖNCE bekle: bir önceki hamlenin (insanın ıskartası dahil) uçuş animasyonu bitsin,
        // sonra bot oynasın. Aksi halde sen atarken sıradaki bot kartın havadayken çekiyor.
        await new Promise((res) => setTimeout(res, this.STEP_MS));
        const r = stepOnce(this.game, (s) => this.isHumanTurn(s));
        if (!r.moved) {
          console.log(`[runEngine] DUR phase=${this.game.phase} currentSeat=${this.game.currentSeat} sorgu=${!!this.game.sorgu} humans=${this.humanSeats}`);
          break;
        }
        this.game = r.state;
        this.pushViews();
      }
    } catch (e: any) {
      console.error('[runEngine] HATA:', e?.message, e?.stack);
    } finally {
      this.busy = false;
    }
    this.checkHandEnd();
  }

  private checkHandEnd() {
    if (this.game.phase === 'handEnded') {
      console.log('[el bitti] 3sn sonra yeni el');
      if (this.handEndTimer) clearTimeout(this.handEndTimer);
      this.handEndTimer = setTimeout(() => this.continueHand(), 3000);
    }
    if (this.game.phase === 'matchEnded' && !this.settled) {
      this.settled = true;
      const r: any = this.game.rules ?? {};
      settleMatch({
        seatUsers: this.seatUsers,
        winnerSeat: Number(this.game.matchWinnerSeat),
        bet: this.bet,
        teamMode: !!r.teamMode,
      }).catch((e) => console.error('[settle] hata:', e?.message));
    }
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try { this.game = startNextHand(this.game); }
    catch (e: any) { console.error('[continueHand] hata:', e?.message); return; }
    this.pushViews();
    this.runEngine();
  }

  private pushViews() {
    // Oyun henüz başlamadıysa (duo'da 2. oyuncu beklenirken) overlay + boş masa (emptyView).
    const waiting = !this.game;
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat == null) return;
      const view: any = clientViewFor(this.game, seat);
      view.waitingForPlayers = waiting;
      c.send('view', JSON.stringify(view));
    });
  }

  onDispose() {
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
  }
}
