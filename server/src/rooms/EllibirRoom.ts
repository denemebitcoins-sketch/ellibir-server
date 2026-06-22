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
  private matchEndTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private readonly MATCH_END_MS = 10000;       // maç sonu → yeni maç geri sayımı
  private readonly START_MS = 7000;            // masa dolunca → oyun başlangıç geri sayımı
  private busy = false;                        // runEngine yeniden-giriş kilidi
  private readonly STEP_MS = 850;              // bot adımları arası gecikme (animasyon)
  private cfg: any = null;                     // createGame opts (oyun tüm insanlar gelince kurulur)
  private seatUsers = new Map<number, string>(); // koltuk → Supabase userId (yalnız gerçek oyuncular)
  private seatNames = new Map<number, string>(); // koltuk → görünen ad (her oyuncu kendi adını yollar)
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

  onJoin(client: Client, options: any) {
    const taken = new Set(this.seats.values());
    const seat = this.humanSeats.find((s) => !taken.has(s)) ?? this.seats.size;
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    if (options?.playerName) this.seatNames.set(seat, String(options.playerName));
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();   // tüm insanlar geldiyse oyunu BAŞLAT (kartları şimdi dağıt)
    this.pushViews();
  }

  /// Tüm insan koltukları dolunca 7sn geri sayım → oyunu kur. Geri sayımda biri çıkarsa iptal.
  private startGameIfReady() {
    if (this.game || this.startTimer || this.seats.size < this.humanSeats.length) return;
    this.pushViews(); // "oyun başlıyor" overlay (dolu ama henüz başlamadı)
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.seats.size < this.humanSeats.length) { this.pushViews(); return; } // bu arada çıktı
      this.game = createGame(this.cfg);
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players.find((pl: any) => pl.seat === seat);
        if (p && name) p.name = name;
      }
      console.log(`[EllibirRoom] oyun başladı, players=${this.game?.players?.length}`);
      this.pushViews();
      this.runEngine();
    }, this.START_MS);
  }

  async onLeave(client: Client, consented: boolean) {
    const seat = this.seats.get(client.sessionId);
    if (seat == null) return;
    // Koltuğu HEMEN bot'a devret → oyun DURMAZ (1. oyuncu beklemede kalmaz).
    this.setAbandoned(seat, true);
    this.runEngine();
    this.pushViews();
    if (consented) { this.cleanupSeat(client.sessionId, seat); return; }
    try {
      await this.allowReconnection(client, 180);  // 3 dk içinde dönerse (uygulama kapansa bile) koltuğu geri al
      this.setAbandoned(seat, false);
      this.runEngine();
      this.pushViews();
    } catch {
      this.cleanupSeat(client.sessionId, seat);   // 3 dk geçti → bot kalıcı devralır
    }
  }

  private cleanupSeat(sessionId: string, seat: number) {
    this.seats.delete(sessionId);
    this.seatUsers.delete(seat);
    this.seatNames.delete(seat);
  }

  // Bir koltuğu terk(abandoned) olarak işaretle/kaldır (state'e yansır → bot devralır/bırakır).
  private setAbandoned(seat: number, on: boolean) {
    if (!this.game) return;
    const arr = new Set<number>(Array.isArray(this.game.abandoned) ? this.game.abandoned : []);
    if (on) arr.add(seat); else arr.delete(seat);
    this.game.abandoned = [...arr];
  }

  // O koltukta KARAR verecek bağlı insan var mı? Terk edilmiş koltuk → bot oynar.
  private isHumanTurn(seat: number): boolean {
    if (!this.humanSeats.includes(seat)) return false;
    const ab: number[] = Array.isArray(this.game?.abandoned) ? this.game.abandoned : [];
    return !ab.includes(seat);
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
      // Masa KAPANMAZ: 10sn (yazboz+kazanan gösterilir) sonra AYNI ayarla yeni maç.
      if (this.matchEndTimer) clearTimeout(this.matchEndTimer);
      this.matchEndTimer = setTimeout(() => this.newMatch(), this.MATCH_END_MS);
    }
  }

  /// Aynı masada yeni maç: kartlar toplanır, yazboz/olaylar sıfırlanır, masa ayarı korunur.
  /// Oyuncu eksikse (biri çıktıysa) bekleme moduna geçer (game=null → "rakip bekleniyor").
  private newMatch() {
    if (this.seats.size < this.humanSeats.length) { this.game = null; this.pushViews(); return; }
    this.game = createGame({ ...this.cfg, seed: Math.floor(Math.random() * 1_000_000_000) });
    for (const [seat, name] of this.seatNames) {
      const p = this.game.players.find((pl: any) => pl.seat === seat);
      if (p && name) p.name = name;
    }
    this.settled = false;
    console.log('[EllibirRoom] yeni maç başladı (aynı masa)');
    this.pushViews();
    this.runEngine();
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try { this.game = startNextHand(this.game); }
    catch (e: any) { console.error('[continueHand] hata:', e?.message); return; }
    this.pushViews();
    this.runEngine();
  }

  private pushViews() {
    // Oyun henüz başlamadıysa overlay + boş masa (emptyView).
    const waiting = !this.game;
    const starting = waiting && this.seats.size >= this.humanSeats.length; // dolu, 7sn geri sayım
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat == null) return;
      const view: any = clientViewFor(this.game, seat);
      view.waitingForPlayers = waiting;
      view.starting = starting;
      c.send('view', JSON.stringify(view));
    });
  }

  onDispose() {
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
    if (this.matchEndTimer) clearTimeout(this.matchEndTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
  }
}
