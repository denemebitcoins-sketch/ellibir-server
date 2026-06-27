import { Room, Client } from '@colyseus/core';
import { createGame, startNextHand, applySorguTimeout } from '../../../packages/engine/src/game';
import { DEFAULT_RULES } from '../../../packages/engine/src/rules';
import { clientViewFor, clientViewForSpectator, clearHandOrder, reconcileHandOrder } from '../clientView';
import { applyClientCommand, stepOnce, CmdError } from '../gameCommands';
import { verifyToken, settleMatch, isGameBanned, isChatBanned, keepSeatPresence } from '../supabase';

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
  private spectators = new Set<string>();      // sessionId → izleyici (koltuksuz, seat=-1)
  private humanSeats: number[] = [];
  private handEndTimer: NodeJS.Timeout | null = null;
  private matchEndTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private sorguTimer: NodeJS.Timeout | null = null;   // insan sorgu kararı zaman aşımı (→ VER)
  private sorguDeadlineAt = 0;                         // sorgu sayacının biteceği an (client geri sayımı)
  private readonly SORGU_MS = 15000;                  // RULES.md 1.11: SORGU_SURESI = 15 sn
  private turnTimer: NodeJS.Timeout | null = null;    // ANA TUR zaman aşımı (insan sırası → otomatik bot hamlesi)
  private forceBotSeat: number | null = null;         // bu koltuk için TEK adım bot zorla (süre aşımı/takılma)
  // İnsan tur süresi (turnTimerSeconds) + GRACE: client kendi autopilot'ını süre dolunca oynatır;
  // server bu kadar EKSTRA bekleyip (client bağlıysa o oynasın) sonra zorla bot oynatır. Böylece
  // bağlı-ama-AFK insanda client autopilot devreye girer; KOPMUŞ insanda server kurtarır (oyun donmaz).
  private readonly TURN_GRACE_MS = 6000;
  private readonly TURN_MIN_MS = 8000;                // rules süresi >0 ama çok küçükse taban
  private readonly TURN_NOLIMIT_SAFETY_MS = 90000;    // tur süresi KAPALI (0) iken yalnız anti-freeze tabanı
  private startAt = 0;                          // başlangıç geri sayımının başladığı an
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
    // İnsan koltukları + izleyici kapasitesi (toplam 8: ör. 4 koltuk + birkaç izleyici).
    // humanSeats sayımına DOKUNMAZ — startGameIfReady yalnız gerçek koltukları sayar.
    this.maxClients = 8;
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
    this.setMetadata({ mode, table: Number(options?.table) || 1, humans: this.humanSeats.length });

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

    // Oyun içi sohbet: koltuktaki insan mesaj yollar → masadaki herkese yayınla.
    // Konuşma-banlı (chat_banned_until > now) oyuncu engellenir (sunucu otoritesi).
    this.onMessage('chat', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      let text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      text = String(text).slice(0, 200).trim();
      if (!text) return;
      const name = this.seatNames.get(seat) ?? `Oyuncu ${seat + 1}`;
      const uid = this.seatUsers.get(seat);
      // Auth'lı oyuncu için chat-ban kontrolü (async; banlıysa yayınlama, gönderene bilgi ver).
      if (uid) {
        isChatBanned(uid).then((banned) => {
          if (banned) { client.send('chatBlocked', { reason: 'Konuşman yasaklı.' }); return; }
          this.broadcast('chat', { seat, name, text });
        }).catch(() => this.broadcast('chat', { seat, name, text }));
        return;
      }
      this.broadcast('chat', { seat, name, text });
    });

    // İzleyici/koltuksuz oyuncu boş koltuğa oturur. raw: { seat?, playerName? }.
    this.onMessage('sit', (client, raw) => {
      let msg: any = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
      this.trySit(client, msg?.seat, { playerName: msg?.playerName });
    });

    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  // Supabase kimliği: token geçerliyse userId döner; denemede token yoksa anon (true) izin.
  async onAuth(_client: Client, options: any): Promise<any> {
    const uid = await verifyToken(options?.token);
    // Oyundan-banlı kullanıcı → girişi reddet (client onError ile "askıya alındı" gösterir).
    if (uid && (await isGameBanned(uid))) {
      throw new Error('banned');
    }
    return uid ?? true;
  }

  onJoin(client: Client, options: any) {
    const taken = new Set(this.seats.values());
    // İZLE ile gelen (spectate:true) → koltuk boş OLSA BİLE oturtma; izleyici kalır.
    // Oturmak için sonradan 'sit' mesajı gönderilir. (HEMEN OYNA/davet-kabul spectate yollamaz → otomatik oturur.)
    const spectate = options?.spectate === true || options?.spectate === 'true';
    const seat = spectate ? null : this.humanSeats.find((s) => !taken.has(s));
    if (seat == null) {
      // Boş insan koltuğu yok (veya izleyici) → İZLEYİCİ olarak kabul (koltuksuz, seats Map'e konmaz).
      this.spectators.add(client.sessionId);
      client.send('seat', { seat: -1 });
      console.log(`[onJoin] izleyici, izleyici sayısı=${this.spectators.size}`);
      this.pushViews();
      return;
    }
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    if (options?.playerName) this.seatNames.set(seat, String(options.playerName));
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();   // tüm insanlar geldiyse oyunu BAŞLAT (kartları şimdi dağıt)
    this.pushViews();
  }

  /** İzleyiciyi/koltuksuzu boş bir koltuğa oturt ('sit' mesajı). Oyun başlamadan (game==null) izinli. */
  private trySit(client: Client, rawSeat: any, options: any) {
    if (this.seats.has(client.sessionId)) return; // zaten oturuyor
    if (this.game != null) { client.send('sitError', { reason: 'oyun başladı' }); return; }
    const taken = new Set(this.seats.values());
    const free = this.humanSeats.filter((s) => !taken.has(s));
    if (free.length === 0) { client.send('sitError', { reason: 'boş koltuk yok' }); return; }

    let seat: number;
    const wanted = Number(rawSeat);
    if (Number.isInteger(wanted) && free.includes(wanted)) {
      seat = wanted;
    } else if (free.length === 1) {
      seat = free[0]!;            // tek boş koltuk → otomatik otur
    } else {
      client.send('sitError', { reason: 'koltuk seç (raw.seat zorunlu)' }); return; // >1 boş, seçim yok
    }

    this.spectators.delete(client.sessionId);
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    if (options?.playerName) this.seatNames.set(seat, String(options.playerName));
    client.send('seat', { seat });
    console.log(`[sit] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();
    this.pushViews();
  }

  /// Tüm insan koltukları dolunca 7sn geri sayım → oyunu kur. Geri sayımda biri çıkarsa iptal.
  private startGameIfReady() {
    if (this.game || this.startTimer || this.seats.size < this.humanSeats.length) return;
    this.startAt = Date.now();
    this.pushViews(); // "oyun başlıyor" overlay (dolu ama henüz başlamadı)
    const tick = setInterval(() => { if (!this.game) this.pushViews(); }, 1000); // canlı geri sayım
    this.startTimer = setTimeout(() => {
      clearInterval(tick);
      this.startTimer = null;
      if (this.seats.size < this.humanSeats.length) { this.pushViews(); return; } // bu arada çıktı
      this.game = createGame(this.cfg);
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players.find((pl: any) => pl.seat === seat);
        if (p && name) p.name = name;
      }
      this.resetHandOrder();
      console.log(`[EllibirRoom] oyun başladı, players=${this.game?.players?.length}`);
      this.pushViews();
      this.runEngine();
    }, this.START_MS);
  }

  // ⚠ COLYSEUS 0.17 KOPMA LIFECYCLE (eski onLeave(consented) DEĞİL):
  //   • ANORMAL kopma (ağ/uygulama kapanması) → onDrop() — burada allowReconnection ile koltuğu tut.
  //   • Zamanında dönüş → onReconnect().
  //   • Reconnect olmazsa VEYA KASITLI çıkış (.leave()) → onLeave(client, code).
  //   (Eski kod onLeave(consented:boolean) idi → 0.17'de anormal kopma onDrop'a gidiyordu, onDrop
  //    tanımlı olmadığı için HİÇBİR ŞEY tetiklenmiyordu: bot devralmıyor, room zombie oynuyor,
  //    reconnect çakışıp 524 veriyordu. GERÇEK KÖK BUYDU.)

  /** ANORMAL kopma (0.17 onDrop): koltuğu HEMEN bota devret + 180s rezerve tut. */
  async onDrop(client: Client) {
    console.log(`[onDrop] TETİKLENDİ sessionId=${client.sessionId} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) { this.pushViews(); }
      return;
    }
    this.setAbandoned(seat, true);   // bot devralır (oyun DURMAZ)
    this.logEvent(`${this.nameOfSeat(seat)} bağlantısı koptu — bot devraldı (3 dk içinde dönebilir)`);
    this.runEngine();
    this.pushViews();
    // P2 SALON GÖRÜNÜRLÜĞÜ: koltuk REZERVE iken (180s) düşen oyuncunun presence satırını TAZE tut.
    const uid = this.seatUsers.get(seat);
    const mode = (this.metadata as any)?.mode ?? (this.humanSeats.length === 2 ? 'duo' : 'solo');
    const tableNo = Number((this.metadata as any)?.table) || 1;
    let presenceTimer: NodeJS.Timeout | null = null;
    if (uid) {
      keepSeatPresence(uid, tableNo, mode);
      presenceTimer = setInterval(() => keepSeatPresence(uid, tableNo, mode), 50000);
    }
    const stopPresenceKeepalive = () => { if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } };
    try {
      const back = await this.allowReconnection(client, 180);  // 3 dk pencere (uygulama kapansa/ağ değişse bile)
      stopPresenceKeepalive();
      this.setAbandoned(seat, false);   // KONTROL İADESİ → sıra/karar tekrar insana
      try { back.send('seat', { seat }); } catch { /* yoksay */ }
      this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü — kontrol oyuncuya geçti`);
      this.runEngine();
      this.pushViews();
    } catch {
      stopPresenceKeepalive();
      this.cleanupSeat(client.sessionId, seat);   // 3 dk geçti → bot KALICI devralır
    }
  }

  /** Zamanında reconnect (0.17 onReconnect): kontrolü insana geri ver (onDrop await'e ek garanti). */
  onReconnect(client: Client) {
    console.log(`[onReconnect] TETİKLENDİ sessionId=${client.sessionId} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) return;
    this.setAbandoned(seat, false);            // bot diskalifiye
    try { client.send('seat', { seat }); } catch { /* yoksay */ }
    this.runEngine();
    this.pushViews();
  }

  /** KASITLI çıkış (.leave()) ya da reconnect başarısız (0.17 onLeave(code)): koltuk KALICI bot. */
  onLeave(client: Client, _code?: number) {
    console.log(`[onLeave] TETİKLENDİ sessionId=${client.sessionId} code=${_code} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) { this.pushViews(); }
      return;
    }
    // ÇIK butonu (.leave()) → GERİ DÖNÜŞ YOK: koltuk kalıcı bot, sessionId temizlenir.
    this.setAbandoned(seat, true);
    this.logEvent(`${this.nameOfSeat(seat)} oyundan çıktı — yerini bot aldı`);
    this.cleanupSeat(client.sessionId, seat);
    this.runEngine();
    this.pushViews();
  }

  // El başı: tüm koltukların handOrder'ını temizle, sonra her insan koltuğunu o anki
  // el id'leriyle init et (reconcile boş sıradan → elin doğal sırası). El sonunda ayrı
  // temizlemeye gerek yok; sonraki el başında baştan kurulur.
  private resetHandOrder() {
    if (!this.game) return;
    clearHandOrder(this.game);
    for (const seat of this.humanSeats) {
      try { reconcileHandOrder(this.game, seat); } catch { /* yoksay */ }
    }
  }

  private nameOfSeat(seat: number): string {
    return this.game?.players?.find((p: any) => p.seat === seat)?.name ?? this.seatNames.get(seat) ?? 'Oyuncu';
  }

  private logEvent(msg: string) {
    if (this.game) this.game.matchLog = [...(this.game.matchLog ?? []), msg];
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
    // SÜRE AŞIMI ZORLAMASI: bu koltuk için TEK adım bot oynanacaksa "insan değil" say (stepOnce
    // bot hamlesi üretir). forceBotSeat süre aşımı timer'ında set edilir, adım sonrası temizlenir.
    if (this.forceBotSeat === seat) return false;
    const ab: number[] = Array.isArray(this.game?.abandoned) ? this.game.abandoned : [];
    return !ab.includes(seat);
  }

  // Bot/sorgu adımlarını TEK TEK, aralarında gecikmeyle oynat ve her adımı push et.
  private async runEngine() {
    if (this.busy) return;
    this.busy = true;
    this.clearTurnTimer(); // motor çalışırken tur timer'ı fire etmesin (loop sonunda yeniden kurulur)
    try {
      while (true) {
        if (!this.game) break;   // matchEnded/reset sonrası game NULL → motor durur (null crash önle)
        // ÖNCE bekle: bir önceki hamlenin (insanın ıskartası dahil) uçuş animasyonu bitsin,
        // sonra bot oynasın. Aksi halde sen atarken sıradaki bot kartın havadayken çekiyor.
        await new Promise((res) => setTimeout(res, this.STEP_MS));
        if (!this.game) break;   // bekleme sırasında game null olduysa (yarış) yine dur
        const r = stepOnce(this.game, (s) => this.isHumanTurn(s));
        if (!r.moved) {
          console.log(`[runEngine] DUR phase=${this.game.phase} currentSeat=${this.game.currentSeat} sorgu=${!!this.game.sorgu} humans=${this.humanSeats}`);
          break;
        }
        this.game = r.state;
        // SÜRE-AŞIMI ZORLAMASI: forceBotSeat'in turu (draw+action) bitip sıra BAŞKA koltuğa geçince
        // zorlamayı kaldır → o insan koltuğu sonraki turunda yine kontrolü alır (kalıcı bot DEĞİL).
        if (this.forceBotSeat != null && this.game.currentSeat !== this.forceBotSeat) this.forceBotSeat = null;
        this.pushViews();
      }
    } catch (e: any) {
      console.error('[runEngine] HATA:', e?.message, e?.stack);
    } finally {
      this.busy = false;
      this.forceBotSeat = null; // güvenlik: her runEngine sonunda zorlama temizlenir (sonsuz zorla yok)
    }
    this.checkHandEnd();
    // SORGU ZAMAN AŞIMI (RULES.md 1.11): karar bir İNSANDA bekliyorsa 15 sn sonra
    // otomatik VER (applySorguTimeout). AFK ile bedava "verme" istismarı kapanır,
    // "sorgu 0'da takılma" çözülür. Karar bot'taysa stepOnce zaten ilerletti.
    this.armSorguTimeoutIfNeeded();
    // ANA TUR ZAMAN AŞIMI: sıra bir İNSANDA (sorgu DIŞI) bekliyorsa, turnTimerSeconds+grace sonra
    // otomatik bot hamlesi oynat → oyun ASLA donmaz (kopmuş/AFK insanda da sıra ilerler).
    this.armTurnTimeoutIfNeeded();
    // TAKILMA GÜVENLİĞİ: oyun bitmediyse VE sıra hâlâ bot'taysa (insan sırası değil)
    // döngü beklenmedik şekilde durmuş demektir → non-blocking yeniden tetikle.
    // busy=false olduğundan tek adım daha çalışır; insan/handEnd'de kendiliğinden durur (sonsuz döngü yok).
    if (this.game) {
      const phase = this.game.phase;
      const playable = phase === 'draw' || phase === 'action';
      const botTurn = this.game.sorgu
        ? false // sorgu adımı stepOnce içinde zaten ele alınır; insan ise zaten DUR
        : playable && !this.isHumanTurn(this.game.currentSeat);
      if (botTurn) setImmediate(() => this.runEngine());
    }
  }

  private checkHandEnd() {
    if (!this.game) return;   // game null (reset/matchEnded sonrası) → okuma yok (crash önle)
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

  /** Aktif sorgu varsa kararın hangi koltukta olduğunu döndür (stepOnce ile aynı mantık). */
  private sorguDeciderSeat(): number | null {
    const sg = this.game?.sorgu;
    if (!sg) return null;
    if (sg.asama === 'ortakGorus') return sg.partnerSeat;
    if (sg.asama === 'cevap') return sg.sorulanSeat;
    return sg.askerSeat;
  }

  private clearSorguTimer() {
    if (this.sorguTimer) { clearTimeout(this.sorguTimer); this.sorguTimer = null; }
    this.sorguDeadlineAt = 0;
  }

  /**
   * SORGU ZAMAN AŞIMI: karar bir İNSAN koltuğunda bekliyorsa 15 sn sayaç kur;
   * dolunca applySorguTimeout (→ VER) uygula, yansıt, motoru ilerlet. Karar
   * bot'ta/terk'te ise stepOnce zaten otomatik yanıtladı → sayaç gereksiz.
   */
  private armSorguTimeoutIfNeeded() {
    this.clearSorguTimer();
    const decider = this.sorguDeciderSeat();
    if (decider == null || !this.game?.sorgu) return;
    const ab: number[] = Array.isArray(this.game?.abandoned) ? this.game.abandoned : [];
    if (!this.isHumanTurn(decider) || ab.includes(decider)) return; // bot/terk → stepOnce hallediyor
    this.sorguDeadlineAt = Date.now() + this.SORGU_MS;
    this.sorguTimer = setTimeout(() => {
      this.sorguTimer = null;
      if (!this.game?.sorgu) return;            // bu arada cevaplandıysa boşver
      try {
        this.game = applySorguTimeout(this.game); // RULES.md 1.11: varsayılan VER
        this.pushViews();
      } catch (e: any) {
        console.error('[sorguTimeout] hata:', e?.message);
        return;
      }
      this.runEngine();                          // VER sonrası akış (zorunlu alım vb.) ilerlesin
    }, this.SORGU_MS);
  }

  private clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
  }

  /**
   * Server tur zaman aşımı süresi (ms):
   *  - turnTimerSeconds > 0 → kullanıcı süresi + grace (client autopilot önce oynar), taban TURN_MIN_MS.
   *  - turnTimerSeconds == 0 (süre KAPALI) → oyunu süresizleştirme ama DONMAYI önle: uzun anti-freeze
   *    tabanı (90s). Bağlı oyuncu rahat düşünür; kopmuş/donmuş turda 90s sonra bot ilerletir.
   */
  private turnMs(): number {
    const sec = Number(this.game?.rules?.turnTimerSeconds);
    if (!Number.isFinite(sec) || sec <= 0) return this.TURN_NOLIMIT_SAFETY_MS;
    return Math.max(this.TURN_MIN_MS, sec * 1000 + this.TURN_GRACE_MS);
  }

  /**
   * ANA TUR ZAMAN AŞIMI: sıra BAĞLI bir insanda (sorgu DIŞI, oynanabilir faz) ise süre+grace
   * sonra TEK bot hamlesi zorla (forceBotSeat) → sıra ilerler, oyun donmaz. Sıra zaten bot/terk
   * ise (runEngine onları oynatır) timer GEREKSİZ. Sorgu varsa armSorguTimeoutIfNeeded ilgilenir.
   * Süre dolunca insan KOPMUŞSA bot devralır; AFK ama BAĞLIYSA client autopilot çoğu zaman daha
   * erken oynamış olur (grace bunun için) — ikisi de güvenli: kötü-niyetli "donma" mümkün değil.
   */
  private armTurnTimeoutIfNeeded() {
    this.clearTurnTimer();
    if (!this.game || this.game.sorgu) return;                 // sorgu → ayrı timer
    const phase = this.game.phase;
    if (phase !== 'draw' && phase !== 'action') return;        // yalnız oynanabilir fazlar
    const seat = this.game.currentSeat;
    if (!this.isHumanTurn(seat)) return;                        // bot/terk → runEngine zaten oynatır
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      // Bu arada insan oynadıysa / faz değiştiyse / sorgu açıldıysa boşver.
      if (!this.game || this.game.sorgu) return;
      const ph = this.game.phase;
      if ((ph !== 'draw' && ph !== 'action') || this.game.currentSeat !== seat) return;
      if (!this.isHumanTurn(seat)) return;                      // bu arada abandoned oldu → runEngine halleder
      console.log(`[turnTimeout] seat=${seat} süre doldu → bot hamlesi zorlanıyor`);
      this.forceBotSeat = seat;                                 // TEK tur bot (isHumanTurn false döner)
      // runEngine bot hamle(ler)ini oynatır ve bittiğinde forceBotSeat'i temizler (finally).
      this.runEngine();
    }, this.turnMs());
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
    this.resetHandOrder();
    console.log('[EllibirRoom] yeni maç başladı (aynı masa)');
    this.pushViews();
    this.runEngine();
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try { this.game = startNextHand(this.game); }
    catch (e: any) { console.error('[continueHand] hata:', e?.message); return; }
    this.resetHandOrder();
    this.pushViews();
    this.runEngine();
  }

  private pushViews() {
    // Oyun henüz başlamadıysa overlay + boş masa (emptyView).
    const waiting = !this.game;
    const starting = waiting && this.seats.size >= this.humanSeats.length; // dolu, 7sn geri sayım
    const filled = new Set(this.seats.values());
    // Beklerken masada oturanları göster: insan koltukları (dolu=oturdu, boş=bekleniyor) + botlar.
    const seated = [0, 1, 2, 3].map((s) => ({
      seat: s,
      human: this.humanSeats.includes(s),
      filled: this.humanSeats.includes(s) ? filled.has(s) : true,  // bot koltukları "dolu"
      name: this.humanSeats.includes(s) ? (this.seatNames.get(s) ?? null) : 'Bot',
    }));
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat == null) {
        // İzleyici: gizli el YOK, yalnız masadaki açık bilgi (sıra/skor/açık perler).
        const sv: any = clientViewForSpectator(this.game);
        sv.waitingForPlayers = waiting;
        sv.starting = starting;
        sv.seated = seated;
        sv.startMs = starting ? Math.max(0, this.START_MS - (Date.now() - this.startAt)) : 0;
        sv.sorguMs = this.sorguDeadlineAt ? Math.max(0, this.sorguDeadlineAt - Date.now()) : 0;
        c.send('view', JSON.stringify(sv));
        return;
      }
      const view: any = clientViewFor(this.game, seat);
      view.waitingForPlayers = waiting;
      view.starting = starting;
      view.seated = seated;   // bekleme ekranında masadaki oyuncular
      view.startMs = starting ? Math.max(0, this.START_MS - (Date.now() - this.startAt)) : 0; // geri sayım
      view.sorguMs = this.sorguDeadlineAt ? Math.max(0, this.sorguDeadlineAt - Date.now()) : 0; // sorgu geri sayımı
      c.send('view', JSON.stringify(view));
    });
  }

  onDispose() {
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
    if (this.matchEndTimer) clearTimeout(this.matchEndTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.clearSorguTimer();
    this.clearTurnTimer();
  }
}
