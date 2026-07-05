import { Room, Client } from '@colyseus/core';
import {
  createTavlaGame, startNextGame, applyTavlaMove, autoTavlaMove, bestTavlaStep,
  shouldOfferDouble, shouldTakeDouble, DEFAULT_TAVLA_RULES,
} from '../../../packages/engine/src/tavla';
import type { TavlaGameState, TavlaRuleConfig } from '../../../packages/engine/src/tavla';
import { tavlaViewFor } from '../tavlaView';
import { verifyToken, settleMatch, isGameBanned, isChatBanned, keepSeatPresence, insertGift, deductDiamonds, canakBurst, fetchCanak, deductEntry } from '../supabase';

// 51/OKEY ile AYNI hediye katalogu (GiftCatalog client'ta ortak).
const GIFT_HOURS: Record<number, number> = { 1: 2, 2: 2, 3: 2, 4: 8, 5: 4, 6: 5, 7: 3, 8: 3, 9: 4, 10: 5, 11: 12, 12: 24 };
const GIFT_DIAMONDS: Record<number, number> = { 1: 5, 2: 8, 3: 6, 4: 25, 5: 15, 6: 18, 7: 12, 8: 10, 9: 14, 10: 16, 11: 35, 12: 60 };
const GIFT_NAMES: Record<number, string> = { 1: 'Çay', 2: 'Türk Kahvesi', 3: 'Limonata', 4: 'Semaver', 5: 'Pasta', 6: 'Baklava', 7: 'Lokum', 8: 'Dondurma', 9: 'Çikolata', 10: 'Meyve Tabağı', 11: 'Çiçek Buketi', 12: 'Altın Hediye Kesesi' };

/**
 * TAVLA masası (2 kişilik) — OkeyRoom/EllibirRoom ile AYNI sosyal/reconnect altyapısı
 * (chat/hediye/olaylar, onDrop→allowReconnection(180)→onReconnect, izleyici, sit),
 * motor olarak tavla engine. Bot turu ADIM ADIM oynar (client animasyonuna yer).
 * mode: 'solo' (1 insan + 1 bot) | 'duo' (2 insan).
 */
export class TavlaRoom extends Room {
  maxClients = 8;

  private game: TavlaGameState | null = null;
  private seats = new Map<string, number>();
  private spectators = new Set<string>();
  private spectatorNames = new Map<string, string>();
  private spectatorMeta = new Map<string, { gender: string; role: string }>();
  private seatMeta = new Map<number, { gender: string; role: string }>();
  private humanSeats: number[] = [];
  private seatUsers = new Map<number, string>();
  private seatNames = new Map<number, string>();
  private abandoned = new Set<number>();       // kopan insan koltukları (bot devralır)
  private startTimer: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private humanTimer: NodeJS.Timeout | null = null;
  private gameTimer: NodeJS.Timeout | null = null;
  private startAt = 0;
  private turnDeadlineAt = 0;
  private readonly START_MS = 7000;
  private readonly STEP_MS = 900;              // bot adım temposu (zar → hamle → hamle)
  private readonly GAME_END_MS = 7000;         // oyun sonu gösterimi → yeni oyun
  private readonly TURN_GRACE_MS = 6000;
  private bet = 0;
  private settled = false;
  private cfg: any = null;
  private rematchVotes = new Set<number>(); // maç sonu TEKRAR OYNA oyları (koltuk)
  private lastReconnectAt = new Map<string, number>();
  private takeoverPending = new Set<string>(); // TAKEOVER: zombiyi bilerek dusurduk, onDrop kalkanlari atlansin // STALE-DROP kalkani (wifi->mobil gecisi)
  private preLog: string[] = [];               // oyun kurulmadan önceki olaylar

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
            console.log(`[TavlaRoom._onLeave] CORE-STALE close (canlı ref açık, code=${code}) -> yok sayıldı sid=${client.sessionId}`);
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
              console.log(`[TavlaRoom.takeover] ayni oturum icin YENI baglanti -> zombi kapatiliyor sid=${client.sessionId}`);
              this.takeoverPending.add(client.sessionId);
              try { zombie.leave(4444); } catch { /* yoksay */ }
            }
          }
        } catch { /* emniyet */ }
        return origOnJoin(client, ...rest);
      };
    }
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2'];
    const mode = options?.mode === 'duo' ? 'duo' : 'solo';
    this.humanSeats = mode === 'duo' ? [0, 1] : [0];
    const botSeats = [0, 1].filter((s) => !this.humanSeats.includes(s));

    let parsed: any = null;
    try { parsed = typeof options?.rules === 'string' ? JSON.parse(options.rules) : options?.rules; }
    catch { parsed = null; }
    const rules: TavlaRuleConfig = {
      ...DEFAULT_TAVLA_RULES,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };

    this.bet = Number(options?.bet) || 0;
    this.cfg = { seed, names, botSeats, rules };
    this.refreshCanak(); // 🏺 çanak göstergesi (BÖLÜM 33)
    this.setMetadata({ game: 'tavla', mode, table: Number(options?.table) || 1, humans: this.humanSeats.length });

    // Oyun komutları: {t:'roll'} | {t:'move', from, die}  (from: 0-23, -1 = kırık)
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game) return;
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      const r = applyTavlaMove(this.game, seat, cmd);
      if (!r.ok) { client.send('moveError', { code: 'rule', message: r.error ?? '' }); return; }
      this.afterChange();
    });

    // TEKRAR OYNA (kullanıcı isteği): maç bitince oyuncular oy verir; bağlı TÜM insan
    // koltukları isteyince aynı ayarlarla YENİ MAÇ başlar (bot rakipte tek oy yeter).
    this.onMessage('rematch', (client) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game || !this.game.matchEnded) return;
      this.rematchVotes.add(seat);
      const connected = [...this.seats.values()];
      const all = connected.length > 0 && connected.every((s) => this.rematchVotes.has(s));
      if (!all) { this.pushViews(); return; } // oy listede görünsün (rakip bekleniyor…)
      this.rematchVotes.clear();
      this.settled = false;
      this.game = createTavlaGame({ ...this.cfg, seed: Date.now() % 2147483647 });
      this.canakGame = -1;   // yeni maç: gameNumber sayacı sıfırdan — patlama kontrolü kilitlenmesin
      this.refreshCanak();   // "tekrar oyna sonrası çanak eski kalıyor" fix'i
      deductEntry(this.seatUsers, this.bet).catch(() => {}); // PEŞİN BAHİS — yeni maç yeni giriş
      for (const [st, name] of this.seatNames) {
        const p = this.game.players[st];
        if (p && name) p.name = name;
      }
      this.game.matchLog.push('TEKRAR OYNA — yeni maç başladı');
      console.log('[TavlaRoom] rematch — yeni maç');
      this.afterChange();
    });

    // ── SOSYAL KATMAN: 51/OKEY ile birebir ──
    this.onMessage('chat', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      let text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      text = String(text).slice(0, 200).trim();
      if (!text) return;
      const name = this.seatNames.get(seat) ?? `Oyuncu ${seat + 1}`;
      const uid = this.seatUsers.get(seat);
      if (uid) {
        isChatBanned(uid).then((banned) => {
          if (banned) { client.send('chatBlocked', { reason: 'Konuşman yasaklı.' }); return; }
          this.broadcast('chat', { seat, name, text });
        }).catch(() => this.broadcast('chat', { seat, name, text }));
        return;
      }
      this.broadcast('chat', { seat, name, text });
    });

    this.onMessage('gift', async (client, raw) => {
      const fromSeat = this.seats.get(client.sessionId);
      if (fromSeat == null) return;
      const toSeat = Number(raw?.to_seat);
      const giftType = Number(raw?.gift_id);
      if (!Number.isInteger(toSeat) || toSeat < 0 || toSeat > 1) return;
      if (!Number.isInteger(giftType) || giftType < 1 || giftType > 12) return;
      const fromUid = this.seatUsers.get(fromSeat);
      const toUid = this.seatUsers.get(toSeat);
      if (fromUid) {
        const cost = GIFT_DIAMONDS[giftType] ?? 999;
        const ok = await deductDiamonds(fromUid, cost);
        if (!ok) { client.send('giftFailed', { reason: 'Yetersiz elmas' }); return; }
      }
      const fromName = this.seatNames.get(fromSeat) ?? `Oyuncu ${fromSeat + 1}`;
      const hours = GIFT_HOURS[giftType] ?? 2;
      const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
      if (fromUid && toUid) insertGift(fromUid, toUid, giftType, 'table', expiresAt).catch(() => {});
      else console.warn('[gift] KALICI KAYIT ATLANDI (uid yok) from=', fromSeat, fromUid ?? '-', 'to=', toSeat, toUid ?? '-');
      this.broadcast('giftSent', {
        from_seat: fromSeat, to_seat: toSeat, gift_id: giftType, from_name: fromName, expires_at: expiresAt,
      });
      this.logEvent(`${fromName}, ${this.nameOfSeat(toSeat)} için ${GIFT_NAMES[giftType] ?? 'hediye'} ısmarladı`);
      this.pushViews();
    });

    this.onMessage('sit', (client, raw) => {
      let msg: any = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
      this.trySit(client, msg?.seat, msg ?? {});
    });

    console.log(`[TavlaRoom] oluştu seed=${seed} mode=${mode} humans=${this.humanSeats}`);
  }

  async onAuth(_client: Client, options: any): Promise<any> {
    const uid = await verifyToken(options?.token);
    if (uid && (await isGameBanned(uid))) throw new Error('banned');
    return uid ?? true;
  }

  onJoin(client: Client, options: any) {
    const taken = new Set(this.seats.values());
    const spectate = options?.spectate === true || options?.spectate === 'true';
    const seat = spectate ? null : this.humanSeats.find((s) => !taken.has(s));
    if (seat == null) {
      this.spectators.add(client.sessionId);
      const specName = options?.playerName ? String(options.playerName) : 'İzleyici';
      this.spectatorNames.set(client.sessionId, specName);
      this.spectatorMeta.set(client.sessionId, { gender: options?.gender ? String(options.gender) : '', role: options?.role ? String(options.role) : 'normal' });
      this.logEvent(`${specName} izleyici olarak masaya katıldı`);
      client.send('seat', { seat: -1 });
      this.pushViews();
      return;
    }
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    if (options?.playerName) this.seatNames.set(seat, String(options.playerName));
    this.seatMeta.set(seat, { gender: options?.gender ? String(options.gender) : '', role: options?.role ? String(options.role) : 'normal' });
    client.send('seat', { seat });
    console.log(`[TavlaRoom.onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();
    this.pushViews();
  }

  private trySit(client: Client, rawSeat: any, options: any) {
    if (this.seats.has(client.sessionId)) return;
    if (this.game != null) { client.send('sitError', { reason: 'oyun başladı' }); return; }
    const taken = new Set(this.seats.values());
    const free = this.humanSeats.filter((s) => !taken.has(s));
    if (free.length === 0) { client.send('sitError', { reason: 'boş koltuk yok' }); return; }
    let seat: number;
    const wanted = Number(rawSeat);
    if (Number.isInteger(wanted) && free.includes(wanted)) seat = wanted;
    else if (free.length === 1) seat = free[0]!;
    else { client.send('sitError', { reason: 'koltuk seç' }); return; }

    this.spectators.delete(client.sessionId);
    this.seats.set(client.sessionId, seat);
    if (typeof (client as any).auth === 'string') this.seatUsers.set(seat, (client as any).auth);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    if (options?.playerName) this.seatNames.set(seat, String(options.playerName));
    this.seatMeta.set(seat, { gender: options?.gender ? String(options.gender) : '', role: options?.role ? String(options.role) : 'normal' });
    client.send('seat', { seat });
    this.startGameIfReady();
    this.pushViews();
  }

  private startGameIfReady() {
    if (this.game || this.startTimer || this.seats.size < this.humanSeats.length) return;
    this.startAt = Date.now();
    this.pushViews();
    const tick = setInterval(() => { if (!this.game) this.pushViews(); }, 1000);
    this.startTimer = setTimeout(() => {
      clearInterval(tick);
      this.startTimer = null;
      if (this.seats.size < this.humanSeats.length) { this.pushViews(); return; }
      this.game = createTavlaGame(this.cfg);
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players[seat];
        if (p && name) p.name = name;
      }
      if (this.preLog.length) { this.game.matchLog.unshift(...this.preLog); this.preLog = []; }
      console.log('[TavlaRoom] oyun başladı');
      deductEntry(this.seatUsers, this.bet).catch(() => {}); // PEŞİN BAHİS (kullanıcı modeli)
      this.afterChange();
    }, this.START_MS);
  }

  /* ── RECONNECT LIFECYCLE — 51/OKEY ile birebir (0.17: onDrop/onReconnect/onLeave) ── */

  async onDrop(client: Client) {
    const isTakeover = this.takeoverPending.delete(client.sessionId); // takeover dususu KALKAN-1'i atlar
    // KALKAN: wifi->mobil geciste SDK yeni baglantiyla COKTAN donduktan sonra eski
    // socketin gecikmis kapanisi ikinci bir onDrop tetikliyor; allowReconnection aninda
    // patlayip KOLTUGU SILIYORDU (log: onReconnect/onDrop ayni saniye -> EXPIRED -> 4002).
    if (!isTakeover && Date.now() - (this.lastReconnectAt.get(client.sessionId) ?? 0) < 3000) {
      console.log(`[TavlaRoom.onDrop] STALE drop (yeni baglanti canli) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[TavlaRoom.onDrop] sessionId=${client.sessionId} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) this.pushViews();
      return;
    }
    this.abandoned.add(seat);
    this.logEvent(`${this.nameOfSeat(seat)} bağlantısı koptu — bot devraldı (3 dk içinde dönebilir)`);
    this.afterChange();
    const uid = this.seatUsers.get(seat);
    const mode = (this.metadata as any)?.mode ?? 'solo';
    const tableNo = Number((this.metadata as any)?.table) || 1;
    let presenceTimer: NodeJS.Timeout | null = null;
    if (uid) {
      keepSeatPresence(uid, tableNo, 'tavla-' + mode);
      presenceTimer = setInterval(() => keepSeatPresence(uid, tableNo, 'tavla-' + mode), 50000);
    }
    const stop = () => { if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } };
    try {
      const back = await this.allowReconnection(client, 180);
      console.log(`[TavlaRoom.onDrop-SUCCESS] seat=${seat} geri döndü`);
      stop();
      this.abandoned.delete(seat);
      try { back.send('seat', { seat }); } catch { /* yoksay */ }
      this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü`);
      this.afterChange();
    } catch (e: any) {
      console.log(`[TavlaRoom.onDrop-EXPIRED] seat=${seat}: ${e?.message ?? e}`);
      stop();
      // KALKAN-2: pencere doldu dese de bu sessionId hala BAGLIYSA (yaris) koltuga dokunma.
      if (this.clients.some((c) => c.sessionId === client.sessionId)) {
        console.log(`[TavlaRoom.onDrop-EXPIRED] client CANLI -> koltuk korunuyor (stale)`);
        return;
      }
      this.cleanupSeat(client.sessionId, seat); // kalıcı bot (abandoned SET'te kalır)
      this.pushViews();
    }
  }

  onReconnect(client: Client) {
    this.lastReconnectAt.set(client.sessionId, Date.now());
    const seat = this.seats.get(client.sessionId);
    console.log(`[TavlaRoom.onReconnect] seat=${seat}`);
    if (seat == null) return;
    this.abandoned.delete(seat);
    try { client.send('seat', { seat }); } catch { /* yoksay */ }
    this.afterChange();
  }

  onLeave(client: Client, _code?: number) {
    // KALKAN-3: reconnect'ten hemen sonra ESKI socket kapanisi onLeave (4002 vb.) olarak da
    // dusebiliyor — kalkan-1 onDrop'u kesince ayni hayalet buradan sizip koltugu siliyordu.
    // KASITLI cikis (4000 consented) etkilenmez.
    if (_code !== 4000 && Date.now() - (this.lastReconnectAt.get(client.sessionId) ?? 0) < 5000) {
      console.log(`[TavlaRoom.onLeave] STALE leave (reconnect taze, code=${_code}) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[TavlaRoom.onLeave] sessionId=${client.sessionId} code=${_code}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) this.pushViews();
      return;
    }
    this.abandoned.add(seat); // kalıcı
    this.logEvent(`${this.nameOfSeat(seat)} oyundan çıktı — yerini bot aldı`);
    this.cleanupSeat(client.sessionId, seat);
    this.afterChange();
  }

  private cleanupSeat(sessionId: string, seat: number) {
    this.seats.delete(sessionId);
    this.seatUsers.delete(seat);
    this.seatNames.delete(seat);
    this.seatMeta.delete(seat);
    this.spectatorMeta.delete(sessionId);
  }

  private nameOfSeat(seat: number): string {
    return this.game?.players?.[seat]?.name ?? this.seatNames.get(seat) ?? 'Oyuncu';
  }

  private logEvent(msg: string) {
    if (this.game) this.game.matchLog.push(msg);
    else this.preLog.push(msg);
  }

  /* ── ÇANAK (BÖLÜM 33): MARS yapan İNSAN %3 şansla çanağı patlatır.
     Modal GARANTİSİ: patlama bilgisi SEQ'li olarak view'a da yazılır — broadcast kaçsa bile
     (yarış/yeniden bağlanma) client sonraki push'ta sequence artışını görüp modalı açar. ── */
  private canakGame = -1;        // oyun başına TEK kontrol
  private canakAmount = 0;       // gösterge (bellek kopyası; view'a gider)
  private canakSeq = 0;          // patlama sayacı (view garantisi)
  private canakWin: { seat: number; name: string; amount: number } | null = null;

  private refreshCanak() { fetchCanak('tavla').then((v) => { this.canakAmount = v; this.pushViews(); }).catch(() => {}); }

  private maybeCanak() {
    if (!this.game || this.canakGame === this.game.gameNumber) return;
    this.canakGame = this.game.gameNumber;
    const w = this.game.gameWinner;
    const uid = w >= 0 ? this.seatUsers.get(w) : undefined;
    // ⚠ TEST MODU (kullanıcı, 2026-07-04): MARS patlatma şansı GEÇİCİ %100 — canlı prova.
    // Prova bitince NORMAL değere dön: const MARS_P = 0.03;
    const MARS_P = 1.0; // TEST! normal: 0.03
    if (!uid || !this.game.mars || Math.random() >= MARS_P) { this.refreshCanak(); return; }
    canakBurst('tavla', uid, this.seatNames.get(w) ?? '').then((amt) => {
      if (amt <= 0 || !this.game) { this.refreshCanak(); return; }
      this.canakAmount = 0;
      const name = this.seatNames.get(w) ?? `Oyuncu ${w + 1}`;
      this.canakSeq += 1;
      this.canakWin = { seat: w, name, amount: amt };
      this.game.matchLog.push(`🏺 ÇANAK PATLADI! ${name} ${amt} çip kazandı!`);
      this.broadcast('canak', { seat: w, name, amount: amt, seq: this.canakSeq });
      this.pushViews();
    }).catch(() => {});
  }

  /* ── OYUN AKIŞI: her değişimden sonra tek yerden zamanla ── */

  private afterChange() {
    // SIRA ÖNEMLİ: önce zamanlayıcı (turnDeadlineAt) KURULUR, sonra push — aksi halde view
    // eski deadline ile gider (sayaç insan sırasında çıkmaz / yanlış koltukta görünür).
    if (!this.game) { this.pushViews(); return; }
    if (this.game.gameEnded || this.game.matchEnded) this.maybeCanak();
    if (this.game.matchEnded) {
      this.settleOnce(); this.clearTurnTimers(); this.turnDeadlineAt = 0;
      this.pushViews(); return;
    }
    if (this.game.gameEnded) {
      this.clearTurnTimers(); this.turnDeadlineAt = 0;
      if (!this.gameTimer) {
        this.gameTimer = setTimeout(() => {
          this.gameTimer = null;
          if (!this.game || this.game.matchEnded) return;
          startNextGame(this.game);
          this.afterChange();
        }, this.GAME_END_MS);
      }
      this.pushViews(); return;
    }
    this.scheduleTurn();
    this.pushViews();
  }

  private clearTurnTimers() {
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.humanTimer) { clearTimeout(this.humanTimer); this.humanTimer = null; }
  }

  private scheduleTurn() {
    if (!this.game || this.game.gameEnded || this.game.matchEnded) return;
    this.clearTurnTimers();

    // ── KATLAMA CEVABI BEKLENİYOR: cevap verecek olan rakip (teklif eden DEĞİL) ──
    if (this.game.pendingDouble >= 0) {
      const responder = 1 - this.game.pendingDouble;
      const rp = this.game.players[responder]!;
      const rBot = rp.isBot || this.abandoned.has(responder);
      if (rBot) {
        this.turnDeadlineAt = 0;
        this.botTimer = setTimeout(() => {
          this.botTimer = null;
          if (!this.game || this.game.pendingDouble < 0) { this.afterChange(); return; }
          const take = shouldTakeDouble(this.game, responder);
          applyTavlaMove(this.game, responder, { t: take ? 'takeDouble' : 'dropDouble' });
          this.afterChange();
        }, 1400);
      } else {
        const ms = 20000 + this.TURN_GRACE_MS; // insan cevap penceresi
        this.turnDeadlineAt = Date.now() + ms;
        this.humanTimer = setTimeout(() => {
          this.humanTimer = null;
          if (!this.game || this.game.pendingDouble < 0) { this.afterChange(); return; }
          autoTavlaMove(this.game, responder); // süre doldu → oto-KABUL
          this.logEvent(`${this.nameOfSeat(responder)} süresi doldu — katlama kabul sayıldı`);
          this.afterChange();
        }, ms);
      }
      return;
    }

    const turn = this.game.turn;
    const p = this.game.players[turn]!;
    const botLike = p.isBot || this.abandoned.has(turn);
    if (botLike) {
      this.turnDeadlineAt = 0;
      // Bot ADIM ADIM: önce (yerinde görürse) KATLAMA, sonra zar (görünür), sonra tek tek hamleler.
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        if (!this.game || this.game.gameEnded || this.game.turn !== turn) { this.afterChange(); return; }
        if (this.game.phase === 'roll') {
          if (shouldOfferDouble(this.game, turn)) applyTavlaMove(this.game, turn, { t: 'double' });
          else applyTavlaMove(this.game, turn, { t: 'roll' });
        } else {
          const s = bestTavlaStep(this.game, turn);
          if (s) applyTavlaMove(this.game, turn, { t: 'move', from: s.from, die: s.die });
          else autoTavlaMove(this.game, turn); // güvenlik (motor sıra geçirir)
        }
        this.afterChange();
      }, this.STEP_MS);
    } else {
      const ms = Math.max(8000, this.game.rules.turnTimerSeconds * 1000) + this.TURN_GRACE_MS;
      this.turnDeadlineAt = Date.now() + ms;
      this.humanTimer = setTimeout(() => {
        this.humanTimer = null;
        if (!this.game || this.game.gameEnded || this.game.turn !== turn) { this.afterChange(); return; }
        autoTavlaMove(this.game, turn);
        this.logEvent(`${this.nameOfSeat(turn)} süresi doldu — otomatik oynandı`);
        this.afterChange();
      }, ms);
    }
  }

  private settleOnce() {
    if (this.settled || !this.game) return;
    this.settled = true;
    const winnerSeat = this.game.matchScore[0]! >= this.game.rules.targetScore ? 0 : 1;
    settleMatch({
      seatUsers: this.seatUsers,
      winnerSeat,
      bet: this.bet,
      teamMode: false,
      totalSeats: 2, // tavla 1v1 — pot = 2×bet (bot bahsi sanal; ECONOMY §4)
      game: 'tavla', // çanak hedefi
    }).then(() => this.refreshCanak()) // settle çanağa ekledi → masa içi gösterge canlansın
      .catch((e) => console.error('[TavlaRoom.settle] hata:', e?.message));
  }

  /* ── GÖRÜNÜM ── */

  private pushViews() {
    const waiting = !this.game;
    const starting = waiting && this.seats.size >= this.humanSeats.length;
    const filled = new Set(this.seats.values());
    const seated = [0, 1].map((s) => ({
      seat: s,
      human: this.humanSeats.includes(s),
      filled: this.humanSeats.includes(s) ? filled.has(s) : true,
      name: this.humanSeats.includes(s) ? (this.seatNames.get(s) ?? null) : 'Bot',
    }));
    const specClients = this.clients.filter((c) => this.seats.get(c.sessionId) == null);
    const specList = specClients.map((c) => this.spectatorNames.get(c.sessionId) ?? 'İzleyici');
    const specRoles = specClients.map((c) => this.spectatorMeta.get(c.sessionId)?.role ?? 'normal');
    const specGenders = specClients.map((c) => this.spectatorMeta.get(c.sessionId)?.gender ?? '');
    const decorate = (v: any) => {
      if (Array.isArray(v.players))
        for (const s of v.players) {
          const m = this.seatMeta.get(s.seat);
          if (m) { s.role = m.role; s.gender = m.gender; }
          s.uid = this.seatUsers.get(s.seat) ?? ''; // profil tıklaması (public kimlik)
          s.abandoned = this.abandoned.has(s.seat);
          if (s.abandoned) s.isBot = true;
        }
      v.spectators = specList;
      v.spectatorRoles = specRoles;
      v.spectatorGenders = specGenders;
      v.waitingForPlayers = waiting;
      v.starting = starting;
      v.seated = seated;
      v.startMs = starting ? Math.max(0, this.START_MS - (Date.now() - this.startAt)) : 0;
      v.turnMs = this.turnDeadlineAt > 0 ? Math.max(0, this.turnDeadlineAt - Date.now()) : 0;
      v.preLog = waiting ? this.preLog.slice(-30) : [];
      v.rematchVotes = [...this.rematchVotes]; // maç sonu TEKRAR OYNA oy listesi
      v.canak = this.canakAmount;              // 🏺 çanak göstergesi
      // Patlama GARANTİSİ: seq artışını gören client modalı açar (broadcast kaçsa bile).
      v.canakSeq = this.canakSeq;
      v.canakWinSeat = this.canakWin?.seat ?? -1;
      v.canakWinName = this.canakWin?.name ?? '';
      v.canakWinAmount = this.canakWin?.amount ?? 0;
    };
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      const v: any = tavlaViewFor(this.game, seat == null ? -1 : seat);
      decorate(v);
      c.send('view', JSON.stringify(v));
    });
  }

  onDispose() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.gameTimer) clearTimeout(this.gameTimer);
    this.clearTurnTimers();
    console.log('[TavlaRoom] dispose');
  }
}
