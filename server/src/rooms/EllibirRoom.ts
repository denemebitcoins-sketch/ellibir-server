import { Room, Client } from '@colyseus/core';
import { createGame, startNextHand, applySorguTimeout } from '../../../packages/engine/src/game';
import { DEFAULT_RULES } from '../../../packages/engine/src/rules';
import { clientViewFor, clientViewForSpectator, clearHandOrder, reconcileHandOrder } from '../clientView';
import { applyClientCommand, stepOnce, CmdError } from '../gameCommands';
import { requireVerifiedUser, settleMatch, isGameBanned, isChatBanned, keepSeatPresence, deductDiamonds, canakBurst, fetchCanak, deductEntry, refundEntry, normalizeRoomBet, authUserIdFromClient, resolveClientProfileMeta } from '../supabase';
import { payloadWithinLimit, RoomMessageGuard } from '../roomMessageGuard';
import { GIFT_DIAMONDS, GIFT_HOURS, GIFT_NAMES, normalizeGiftRequest } from '../gifts';
import { selectJoinSeat } from '../seatSelection';
import { ellibirCanakChance } from '../canakPolicy';

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
  private spectatorNames = new Map<string, string>(); // sessionId → izleyici görünen ad (yazboz paneli için)
  private spectatorMeta = new Map<string, { gender: string; role: string }>(); // izleyici cinsiyet/rol (isim rengi/rozet için)
  private seatMeta = new Map<number, { gender: string; role: string }>();        // koltuk → cinsiyet/rol (yazboz sol panel zengin gösterim)
  private humanSeats: number[] = [];
  private handEndTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private startTick: NodeJS.Timeout | null = null;
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
  private readonly START_MS = 7000;            // masa dolunca → oyun başlangıç geri sayımı
  private busy = false;                        // runEngine yeniden-giriş kilidi
  private readonly STEP_MS = 850;              // bot adımları arası gecikme (animasyon)
  private cfg: any = null;                     // createGame opts (oyun tüm insanlar gelince kurulur)
  private seatUsers = new Map<number, string>(); // koltuk → Supabase userId (yalnız gerçek oyuncular)
  private seatNames = new Map<number, string>(); // koltuk → görünen ad (her oyuncu kendi adını yollar)
  private bet = 0;                             // masa bahsi (maç sonu settle için)
  private settled = false;                     // çift settle koruması
  private settlePromise: Promise<void> | null = null;
  private rematchVotes = new Set<number>();    // maç sonu TEKRAR OYNA diyen insan koltukları
  private rematchStarting = false;             // çift ücret/yeni-maç başlangıcı koruması

  private lastReconnectAt = new Map<string, number>();
  private takeoverPending = new Set<string>(); // TAKEOVER: zombiyi bilerek dusurduk, onDrop kalkanlari atlansin // STALE-DROP kalkanı (wifi→mobil geçişi)
  private readonly messageGuard = new RoomMessageGuard();
  private readonly giftBusy = new Set<string>();
  private closingBotOnly = false;

  onCreate(options: any) {
    // ÇEKİRDEK-SEVİYE STALE-CLOSE KALKANI: reconnect sonrası ESKİ socket kapanışı çekirdekte
    // CANLI client'a eşlenip clients listesinden düşürüyor, oda boşalınca DISPOSE oluyordu
    // (hook'ta yutmak yetmiyor — silme hook'tan ÖNCE). KESİN AYRAÇ: mevcut transport (client.ref)
    // hâlâ AÇIKSA (readyState===1) kapanış eski sokete aittir → çekirdek akışı tamamen atlanır.
    {
      const origOnLeave = (this as any)._onLeave.bind(this);
      (this as any)._onLeave = async (client: any, code?: number) => {
        try {
          const rs = client?.ref?.readyState;
          // OPEN(1) VEYA CONNECTING(0): reconnect el sıkışması sürerken gelen kapanış da eski sokete ait
          // (07:51:53 vakası: yeni ref daha açılmadan stale close geldi, oda dispose oldu).
          if (code !== 4000 && code !== 4444 && (rs === 0 || rs === 1)) { // 4444 = TAKEOVER (bilinçli zombi kapatma)
            console.log(`[EllibirRoom._onLeave] CORE-STALE close (canlı ref açık, code=${code}) -> yok sayıldı sid=${client.sessionId}`);
            return;
          }
        } catch { /* emniyet */ }
        return origOnLeave(client, code);
      };
    }
    // SESSION TAKEOVER (AAA reconnect): ayni oturum icin YENI baglanti gelirse (wifi<->mobil
    // flapping'inde eski baglanti zombi kalip ping'lere cevap verebiliyor) zombi ANINDA
    // kapatilir (4444) -> onDrop -> allowReconnection -> yeni gelen <1sn'de koltuga oturur.
    // (Cekirdek aksi halde zombinin olmesini 15sn bekliyor ya da MAY_TRY_RECONNECT donduruyor.)
    {
      const origOnJoin = (this as any)._onJoin.bind(this);
      (this as any)._onJoin = async (client: any, ...rest: any[]) => {
        try {
          const connOpts = rest[rest.length - 1];
          const token = connOpts?.reconnectionToken;
          if (token) {
            const zombie: any = (this.clients as any).getById?.(client.sessionId);
            if (zombie && zombie !== client && zombie.reconnectionToken === token) {
              console.log(`[EllibirRoom.takeover] ayni oturum icin YENI baglanti -> zombi kapatiliyor sid=${client.sessionId}`);
              this.takeoverPending.add(client.sessionId);
              try { zombie.leave(4444); } catch { /* yoksay */ }
            }
          }
        } catch { /* emniyet */ }
        return origOnJoin(client, ...rest);
      };
    }
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    const mode = options?.mode === 'duo' ? 'duo' : options?.mode === 'duo3' ? 'duo3' : 'solo';
    const tableNo = Number(options?.table) || 1;

    // Masa 1 kontrollü botlu test masasıdır. Masa 2-10 gerçek online test/çıkış içindir:
    // tekli de eşli de 4 insan bekler, oyun başladıktan sonra düşen koltuğu bot devralır.
    const botTestTable = tableNo === 1;
    this.humanSeats = botTestTable
      ? (mode === 'duo' ? [0, 2] : mode === 'duo3' ? [0, 1, 2] : [0])
      : [0, 1, 2, 3];
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
    rules.teamMode = mode === 'duo' || mode === 'duo3'; // takım: 0&2 / 1&3

    this.bet = normalizeRoomBet(options?.bet, [100, 250, 500, 1000, 2500, 5000], 'elliBir');
    this.refreshCanak(); // 🏺 çanak göstergesi (BÖLÜM 33)
    // Oyunu HEMEN kurma — tüm insan koltukları dolunca başlat (yoksa bekleyen oyuncu
    // bot'larla oynanmış bir el görür). Şimdilik sadece config sakla.
    this.cfg = { seed, playerNames: names, botSeats, rules };
    this.game = null;
    this.setMetadata({ mode, table: tableNo, humans: this.humanSeats.length });

    // Tek mesaj kanalı: client'ın tüm komutları "cmd" (JSON string) olarak gelir.
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game) return;   // oyun henüz başlamadı (rakip bekleniyor)
      if (!payloadWithinLimit(raw, 16 * 1024) || !this.messageGuard.allow(client.sessionId, 'cmd', 12, 1000)) {
        client.send('moveError', { code: 'rate_limited', message: 'Çok hızlı hamle gönderildi.' });
        return;
      }
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      if (cmd?.t === 'ready' || cmd?.t === 'rematch') {
        void this.handleRematch(seat);
        return;
      }
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
      if (!payloadWithinLimit(raw, 1024) || !this.messageGuard.allow(client.sessionId, 'chat', 4, 5000)) {
        client.send('chatBlocked', { reason: 'Çok hızlı mesaj gönderiyorsun.' });
        return;
      }
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
        }).catch(() => client.send('chatBlocked', { reason: 'Mesaj doğrulanamadı; tekrar dene.' }));
        return;
      }
      this.broadcast('chat', { seat, name, text });
    });

    // Oyun-içi HEDİYE: {to_seats, gift_id}. Tek istek, tek atomik bakiye kesintisi.
    this.onMessage('gift', async (client, raw) => {
      const fromSeat = this.seats.get(client.sessionId);
      if (fromSeat == null) return;
      if (!payloadWithinLimit(raw, 1024) || !this.messageGuard.allow(client.sessionId, 'gift', 1, 1000) || this.giftBusy.has(client.sessionId)) {
        client.send('giftFailed', { reason: 'Hediye işlemi sürüyor; biraz bekle.' });
        return;
      }
      this.giftBusy.add(client.sessionId);
      try {
        const gift = normalizeGiftRequest(raw, 3);
        if (!gift) { client.send('giftFailed', { reason: 'Hediye veya hedef geçersiz.' }); return; }
        const { giftId: giftType, targets } = gift;
        const fromUid = this.seatUsers.get(fromSeat);
        // SERVER-SIDE ELMAS: gönderenden düş (hile önleme). Yetersizse hediye İPTAL + gönderene bilgi.
        if (fromUid) {
          const cost = (GIFT_DIAMONDS[giftType] ?? 999) * targets.length;
          const ok = await deductDiamonds(fromUid, cost);
          if (!ok) { client.send('giftFailed', { reason: 'Yetersiz elmas' }); return; }
        }
        const fromName = this.seatNames.get(fromSeat) ?? `Oyuncu ${fromSeat + 1}`;
        const hours = GIFT_HOURS[giftType] ?? 2;
        const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
        // HEDİYE O MASAYA ÖZEL (kullanıcı kararı 2026-07-05): Supabase kalıcılığı KALDIRILDI — yalnız broadcast.
        for (const toSeat of targets) {
          this.broadcast('giftSent', {
            from_seat: fromSeat, to_seat: toSeat, gift_id: giftType, from_name: fromName, expires_at: expiresAt,
          });
          this.logEvent(`${fromName}, ${this.nameOfSeat(toSeat)} için ${GIFT_NAMES[giftType] ?? 'hediye'} ısmarladı`);
        }
      } finally { this.giftBusy.delete(client.sessionId); }
    });

    // Client arka plana düştü / koltuğu koruyarak menüye döndü: bağlantı fiziksel olarak
    // açık kalsa bile masa donmasın; reconnect/geri dönüşte kontrol tekrar insana geçer.
    this.onMessage('away', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 256) || !this.messageGuard.allow(client.sessionId, 'away', 6, 3000)) return;
      const away = raw?.away !== false;
      const ab: number[] = Array.isArray(this.game?.abandoned) ? this.game.abandoned : [];
      if (away) {
        if (!ab.includes(seat)) this.logEvent(`${this.nameOfSeat(seat)} masadan uzaklaştı — bot devraldı`);
        this.setAbandoned(seat, true);
      } else if (ab.includes(seat)) {
        this.setAbandoned(seat, false);
        this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü`);
      }
      this.runEngine();
      this.pushViews();
    });

    // ORTAK quick-chat (yalnız eşli): {text}. Sadece ORTAĞA (+ gönderene echo) — masaya DEĞİL.
    this.onMessage('quickChat', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 512) || !this.messageGuard.allow(client.sessionId, 'quickChat', 4, 4000)) return;
      let text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      text = String(text).slice(0, 120).trim();
      if (!text) return;
      if (!this.game?.rules?.teamMode) return;
      const hs = this.humanSeats;
      // Ortak = takım arkadaşı (seat+2)%4 → duo (0↔2, 1↔3) ve duo3 için de doğru. Yalnız EŞLİ (≥2 insan).
      const partner = (hs.length >= 2 && hs.includes(seat)) ? (seat + 2) % 4 : null;
      if (partner == null) return; // yalnız eşli + ortak koltuğu var (bot ortak → mesaj gösterilmez)
      for (const [sid, s] of this.seats) {
        if (s === partner || s === seat) {
          const c = this.clients.find((cl) => cl.sessionId === sid);
          if (c) c.send('quickChat', { seat, text });
        }
      }
    });

    // İzleyici/koltuksuz oyuncu boş koltuğa oturur. raw: { seat?, playerName? }.
    this.onMessage('sit', (client, raw) => {
      if (!payloadWithinLimit(raw, 2048) || !this.messageGuard.allow(client.sessionId, 'sit', 4, 5000)) return;
      let msg: any = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
      void this.trySit(client, msg?.seat, msg ?? {});
    });

    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  // Supabase kimliği: token geçerliyse userId döner; denemede token yoksa anon (true) izin.
  async onAuth(_client: Client, options: any): Promise<any> {
    const uid = await requireVerifiedUser(options?.token);
    // Oyundan-banlı kullanıcı → girişi reddet (client onError ile "askıya alındı" gösterir).
    if (uid && (await isGameBanned(uid))) {
      throw new Error('banned');
    }
    return uid ?? true;
  }

  async onJoin(client: Client, options: any) {
    const taken = new Set(this.seats.values());
    // İZLE ile gelen (spectate:true) → koltuk boş OLSA BİLE oturtma; izleyici kalır.
    // Oturmak için sonradan 'sit' mesajı gönderilir. (HEMEN OYNA/davet-kabul spectate yollamaz → otomatik oturur.)
    const spectate = options?.spectate === true || options?.spectate === 'true';
    const decision = selectJoinSeat(this.humanSeats, taken, spectate, options?.requestedSeat);
    const seat = decision.seat;
    if (seat == null) {
      // Boş insan koltuğu yok (veya izleyici) → İZLEYİCİ olarak kabul (koltuksuz, seats Map'e konmaz).
      this.spectators.add(client.sessionId);
      const meta = await resolveClientProfileMeta(authUserIdFromClient(client), options, 'İzleyici');
      this.spectatorNames.set(client.sessionId, meta.name);
      this.spectatorMeta.set(client.sessionId, { gender: meta.gender, role: meta.role });
      this.logEvent(`${meta.name} izleyici olarak masaya katıldı`); // client farklı renk verir
      client.send('seat', { seat: -1 });
      if (decision.error) {
        client.send('sitError', {
          reason: decision.error === 'seat_unavailable' ? 'seçilen koltuk dolu' : 'geçersiz koltuk',
        });
      }
      console.log(`[onJoin] izleyici, izleyici sayısı=${this.spectators.size}`);
      this.pushViews();
      return;
    }
    this.seats.set(client.sessionId, seat);
    const uid = authUserIdFromClient(client);
    if (uid) this.seatUsers.set(seat, uid);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    const meta = await resolveClientProfileMeta(uid, options, `Oyuncu ${seat + 1}`);
    this.seatNames.set(seat, meta.name);
    this.seatMeta.set(seat, { gender: meta.gender, role: meta.role });
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();   // tüm insanlar geldiyse oyunu BAŞLAT (kartları şimdi dağıt)
    this.pushViews();
  }

  /** İzleyiciyi/koltuksuzu boş bir koltuğa oturt ('sit' mesajı). Oyun başlamadan (game==null) izinli. */
  private async trySit(client: Client, rawSeat: any, options: any) {
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
    this.spectatorNames.delete(client.sessionId);
    this.spectatorMeta.delete(client.sessionId);
    this.seats.set(client.sessionId, seat);
    const uid = authUserIdFromClient(client);
    if (uid) this.seatUsers.set(seat, uid);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    const meta = await resolveClientProfileMeta(uid, options, `Oyuncu ${seat + 1}`);
    this.seatNames.set(seat, meta.name);
    this.seatMeta.set(seat, { gender: meta.gender, role: meta.role });
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
    if (this.startTick) clearInterval(this.startTick);
    this.startTick = setInterval(() => { if (!this.game) this.pushViews(); }, 1000); // canlı geri sayım
    this.startTimer = setTimeout(async () => {
      if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
      this.startTimer = null;
      if (this.seats.size < this.humanSeats.length) { this.pushViews(); return; } // bu arada çıktı
      const entryUsers = new Map(this.seatUsers);
      const entry = await deductEntry(entryUsers, this.bet);
      if (!entry.ok) { this.abortEntryStart(entry.failedSeats); return; }
      if (this.seats.size < this.humanSeats.length) {
        await refundEntry(entryUsers, this.bet, 'seat_left_before_start');
        this.pushViews();
        return;
      }
      this.game = createGame(this.cfg);
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players.find((pl: any) => pl.seat === seat);
        if (p && name) p.name = name;
      }
      this.resetHandOrder();
      console.log(`[EllibirRoom] oyun başladı, players=${this.game?.players?.length}`);
      this.settled = false;
      this.pushViews();
      this.runEngine();
    }, this.START_MS);
  }

  private abortEntryStart(failedSeats: number[]) {
    this.startAt = 0;
    const reason = failedSeats.length
      ? `Giriş ücreti alınamadı (koltuk ${failedSeats.map((s) => s + 1).join(', ')})`
      : 'Giriş ücreti alınamadı';
    this.logEvent(reason);
    this.broadcast('sitError', { reason });
    this.pushViews();
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
    const isTakeover = this.takeoverPending.delete(client.sessionId); // takeover dususu KALKAN-1'i atlar
    // KALKAN: wifi→mobil geçişinde SDK yeni bağlantıyla ÇOKTAN döndükten sonra eski
    // socket'in gecikmiş kapanışı ikinci bir onDrop tetikliyor; allowReconnection anında
    // patlayıp KOLTUĞU SİLİYORDU (log: onReconnect ↔ onDrop aynı saniye → EXPIRED → 4002).
    if (!isTakeover && Date.now() - (this.lastReconnectAt.get(client.sessionId) ?? 0) < 3000) {
      console.log(`[EllibirRoom.onDrop] STALE drop (yeni bağlantı canlı) → yok sayıldı sid=${client.sessionId}`);
      return;
    }

    console.log(`[onDrop] TETİKLENDİ sessionId=${client.sessionId} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) { this.pushViews(); }
      this.spectatorNames.delete(client.sessionId);
      this.spectatorMeta.delete(client.sessionId);
      this.messageGuard.forget(client.sessionId);
      this.giftBusy.delete(client.sessionId);
      this.lastReconnectAt.delete(client.sessionId);
      this.takeoverPending.delete(client.sessionId);
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
      console.log(`[onDrop] allowReconnection(180) BEKLENİYOR seat=${seat}`);
      const back = await this.allowReconnection(client, 180);  // 3 dk pencere (uygulama kapansa/ağ değişse bile)
      console.log(`[onDrop-SUCCESS] seat=${seat} oyuncu GERİ DÖNDÜ (allowReconnection çözüldü)`);
      stopPresenceKeepalive();
      this.setAbandoned(seat, false);   // KONTROL İADESİ → sıra/karar tekrar insana
      try { back.send('seat', { seat }); } catch { /* yoksay */ }
      this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü — kontrol oyuncuya geçti`);
      this.runEngine();
      this.pushViews();
    } catch (e: any) {
      console.log(`[onDrop-EXPIRED] seat=${seat} reconnect penceresi DOLDU/iptal: ${e?.message ?? e}`);
      stopPresenceKeepalive();
      // KALKAN-2: pencere 'doldu' dese de bu sessionId hâlâ BAĞLIYSA (yarış) koltuğa dokunma.
      if (this.clients.some((c) => c.sessionId === client.sessionId)) {
        console.log(`[EllibirRoom.onDrop-EXPIRED] client CANLI → koltuk korunuyor (stale)`);
        return;
      }
      this.cleanupSeat(client.sessionId, seat);   // 3 dk geçti → bot KALICI devralır
    }
  }

  /** Zamanında reconnect (0.17 onReconnect): kontrolü insana geri ver (onDrop await'e ek garanti). */
  onReconnect(client: Client) {
    this.lastReconnectAt.set(client.sessionId, Date.now());
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
    // KALKAN-3: reconnect'ten hemen sonra ESKI socket kapanisi onLeave (4002 vb.) olarak da
    // dusebiliyor — kalkan-1 onDrop'u kesince ayni hayalet buradan sizip koltugu siliyordu.
    // KASITLI cikis (4000 consented) etkilenmez.
    if (_code !== 4000 && Date.now() - (this.lastReconnectAt.get(client.sessionId) ?? 0) < 5000) {
      console.log(`[EllibirRoom.onLeave] STALE leave (reconnect taze, code=${_code}) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[onLeave] TETİKLENDİ sessionId=${client.sessionId} code=${_code} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) { this.pushViews(); }
      this.spectatorNames.delete(client.sessionId);
      this.spectatorMeta.delete(client.sessionId);
      this.messageGuard.forget(client.sessionId);
      this.giftBusy.delete(client.sessionId);
      this.lastReconnectAt.delete(client.sessionId);
      this.takeoverPending.delete(client.sessionId);
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
    // KÜLT KURAL: her el KARIŞIK başlar, çekilen kart hep EN SAĞA gelir, kendiliğinden per OLMAZ.
    // dizMode önceki elden taşınıyordu (immutable state spread'leri koruyor) → yeni el otomatik dizili
    // geliyordu. El başında sıfırla; oyuncu el içinde SERİ/ÇİFT DİZ'e basarsa sticky dizilim yine çalışır.
    (this.game as any).dizModes = {};
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
    this.messageGuard.forget(sessionId);
    this.giftBusy.delete(sessionId);
    this.lastReconnectAt.delete(sessionId);
    this.takeoverPending.delete(sessionId);
    this.seats.delete(sessionId);
    this.seatUsers.delete(seat);
    this.seatNames.delete(seat);
    this.seatMeta.delete(seat);
    this.spectatorMeta.delete(sessionId);
    this.rematchVotes.delete(seat);
    // Mac sonucunda bekleyen bir oyuncu hazirken digeri cikarsa, kalan oyu yeniden
    // degerlendir. Eksik gercek oyunculu masa newMatch icinde lobby beklemesine doner.
    if (this.game?.phase === 'matchEnded') void this.maybeStartRematch();
    this.scheduleBotOnlyClose();
  }

  /** Gerçek oyuncu kalmadığında botların kendi kendine oynadığı zombi masayı lobby'den kaldır. */
  private scheduleBotOnlyClose() {
    if (this.closingBotOnly || this.seats.size > 0) return;
    this.closingBotOnly = true;
    setTimeout(() => {
      if (this.seats.size > 0) { this.closingBotOnly = false; return; }
      console.log('[EllibirRoom] gerçek oyuncu kalmadı -> oda kapatılıyor');
      void this.disconnect().catch((e: any) => console.warn('[EllibirRoom] bot-only close:', e?.message ?? e));
    }, 0);
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

  /* ── ÇANAK: eli bitiren insan yalniz ozel bitiste ortak politika sansiyla patlatir. ── */
  private canakHand = -1;
  private canakAmount = 0;
  private canakSeq = 0;          // patlama sayacı (view garantisi — broadcast kaçsa da modal açılır)
  private canakWin: { seat: number; name: string; amount: number } | null = null;

  private refreshCanak() { fetchCanak('51').then((v) => { this.canakAmount = v; this.pushViews(); }).catch(() => {}); }

  private maybeCanak() {
    const hr: any = this.game?.lastHandResult;
    if (!this.game || !hr) return;
    const handNo = Number(this.game.handNumber ?? 0);
    if (this.canakHand === handNo) return;
    this.canakHand = handNo;
    const w = hr.winnerSeat;
    const uid = w != null && w >= 0 ? this.seatUsers.get(w) : undefined;
    const p = ellibirCanakChance(Boolean(hr.okeyFinish), Boolean(hr.pairFinish));
    if (!uid || p <= 0 || Math.random() >= p) { this.refreshCanak(); return; }
    canakBurst('51', uid, this.seatNames.get(w) ?? '').then((amt) => {
      if (amt <= 0 || !this.game) { this.refreshCanak(); return; }
      this.canakAmount = 0;
      const name = this.seatNames.get(w) ?? `Oyuncu ${w + 1}`;
      this.canakSeq += 1;
      this.canakWin = { seat: w, name, amount: amt };
      this.logEvent(`🏺 ÇANAK PATLADI! ${name} ${amt} çip kazandı!`);
      this.broadcast('canak', { seat: w, name, amount: amt, seq: this.canakSeq });
      this.pushViews();
    }).catch(() => {});
  }

  private checkHandEnd() {
    if (!this.game) return;   // game null (reset/matchEnded sonrası) → okuma yok (crash önle)
    if (this.game.phase === 'handEnded') {
      console.log('[el bitti] 3sn sonra yeni el');
      this.maybeCanak();
      if (this.handEndTimer) clearTimeout(this.handEndTimer);
      this.handEndTimer = setTimeout(() => this.continueHand(), 3000);
    }
    if (this.game.phase === 'matchEnded' && !this.settled) {
      this.settled = true;
      this.rematchVotes.clear();
      this.maybeCanak(); // son el matchEnded'e atlar — çanak kontrolü kaçmasın
      const r: any = this.game.rules ?? {};
      this.settlePromise = settleMatch({
        seatUsers: this.seatUsers,
        winnerSeat: Number(this.game.matchWinnerSeat),
        bet: this.bet,
        teamMode: !!r.teamMode,
        scores: new Map(this.game.players.map((p: any) => [p.seat, p.totalScore])), // kademeli sıralama için
        game: '51', // çanak hedefi
      }).then(() => this.refreshCanak()) // settle çanağa ekledi → masa içi gösterge canlansın
        .catch((e) => console.error('[settle] hata:', e?.message));
    }
  }

  /** Maç sonu yalnız açık onayla yeniden başlar. Botlar hazır sayılır; gerçek masada
   *  oturan tüm insanlar TEKRAR OYNA demeden yeni giriş ücreti kesilmez. */
  private async handleRematch(seat: number) {
    if (!this.game || this.game.phase !== 'matchEnded' || this.rematchStarting) return;
    // Son hamlenin view'ı istemciye settle kurulmadan hemen önce ulaşabilir. İlk oy
    // bu dar aralıkta gelirse sonuçlandırmayı burada senkron biçimde başlat.
    if (!this.settled) this.checkHandEnd();
    this.rematchVotes.add(seat);
    this.pushViews();

    await this.maybeStartRematch();
  }

  private async maybeStartRematch() {
    if (!this.game || this.game.phase !== 'matchEnded' || this.rematchStarting) return;

    const occupied = new Set(this.seats.values());
    const required = this.humanSeats.filter((s) => occupied.has(s));
    if (required.length === 0 || !required.every((s) => this.rematchVotes.has(s))) return;

    this.rematchStarting = true;
    try {
      if (this.settlePromise) await this.settlePromise;
      this.rematchVotes.clear();
      await this.newMatch();
    } catch (e: any) {
      console.error('[EllibirRoom] rematch hata:', e?.message);
      this.pushViews();
    } finally {
      this.rematchStarting = false;
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
  private async newMatch() {
    this.rematchVotes.clear();
    if (this.seats.size < this.humanSeats.length) { this.game = null; this.pushViews(); return; }
    const entryUsers = new Map(this.seatUsers);
    const entry = await deductEntry(entryUsers, this.bet);
    if (!entry.ok) { this.abortEntryStart(entry.failedSeats); return; }
    if (this.seats.size < this.humanSeats.length) {
      await refundEntry(entryUsers, this.bet, 'seat_left_before_new_match');
      this.game = null;
      this.pushViews();
      return;
    }
    this.game = createGame({ ...this.cfg, seed: Math.floor(Math.random() * 1_000_000_000) });
    for (const [seat, name] of this.seatNames) {
      const p = this.game.players.find((pl: any) => pl.seat === seat);
      if (p && name) p.name = name;
    }
    this.settled = false;
    this.settlePromise = null;
    this.canakHand = -1;   // yeni maç: el sayacı sıfırdan — patlama kontrolü kilitlenmesin
    this.refreshCanak();
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
    // AKTİF izleyiciler: koltuksuz (seat yok) bağlı client'lar → adları (çıkan izleyici otomatik düşer).
    const specClients = this.clients.filter((c) => this.seats.get(c.sessionId) == null);
    const specList = specClients.map((c) => this.spectatorNames.get(c.sessionId) ?? 'İzleyici');
    const specRoles = specClients.map((c) => this.spectatorMeta.get(c.sessionId)?.role ?? 'normal');
    const specGenders = specClients.map((c) => this.spectatorMeta.get(c.sessionId)?.gender ?? '');
    // Koltuk listesine cinsiyet/rol + UID enjekte et (isim rengi/rozet + masa-içi MiniProfile:
    // profil kartından MESAJ/ARKADAŞ akışı uid ister — okey/tavla ile parite).
    const decorate = (arr: any) => { if (Array.isArray(arr)) for (const s of arr) { const m = this.seatMeta.get(s.seat); if (m) { s.role = m.role; s.gender = m.gender; } s.uid = this.seatUsers.get(s.seat) ?? ''; } };
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat == null) {
        // İzleyici: gizli el YOK, yalnız masadaki açık bilgi (sıra/skor/açık perler).
        const sv: any = clientViewForSpectator(this.game);
        decorate(sv.seats);
        sv.spectators = specList;
        sv.spectatorRoles = specRoles;
        sv.spectatorGenders = specGenders;
        sv.waitingForPlayers = waiting;
        sv.starting = starting;
        sv.seated = seated;
        sv.startMs = starting ? Math.max(0, this.START_MS - (Date.now() - this.startAt)) : 0;
        sv.sorguMs = this.sorguDeadlineAt ? Math.max(0, this.sorguDeadlineAt - Date.now()) : 0;
        sv.canak = this.canakAmount; // 🏺 çanak göstergesi
        sv.canakSeq = this.canakSeq;
        sv.canakWinSeat = this.canakWin?.seat ?? -1;
        sv.canakWinName = this.canakWin?.name ?? '';
        sv.canakWinAmount = this.canakWin?.amount ?? 0;
        sv.rematchVotes = [...this.rematchVotes];
        c.send('view', JSON.stringify(sv));
        return;
      }
      const view: any = clientViewFor(this.game, seat);
      decorate(view.seats);
      view.spectators = specList;
      view.spectatorRoles = specRoles;
      view.spectatorGenders = specGenders;
      view.waitingForPlayers = waiting;
      view.starting = starting;
      view.seated = seated;   // bekleme ekranında masadaki oyuncular
      view.startMs = starting ? Math.max(0, this.START_MS - (Date.now() - this.startAt)) : 0; // geri sayım
      view.sorguMs = this.sorguDeadlineAt ? Math.max(0, this.sorguDeadlineAt - Date.now()) : 0; // sorgu geri sayımı
      view.canak = this.canakAmount; // 🏺 çanak göstergesi
      view.canakSeq = this.canakSeq;
      view.canakWinSeat = this.canakWin?.seat ?? -1;
      view.canakWinName = this.canakWin?.name ?? '';
      view.canakWinAmount = this.canakWin?.amount ?? 0;
      view.rematchVotes = [...this.rematchVotes];
      c.send('view', JSON.stringify(view));
    });
  }

  onDispose() {
    this.messageGuard.clear();
    this.giftBusy.clear();
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
    this.clearSorguTimer();
    this.clearTurnTimer();
  }
}
