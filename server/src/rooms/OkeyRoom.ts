import { Room, Client } from '@colyseus/core';
import {
  createOkeyGame, startNextEl, applyOkeyMove, autoOkeyMove, playOkeyBotTurn,
  beginBankoPhase, resolveBankoPhase, botBankoDecide, DEFAULT_OKEY_RULES,
} from '../../../packages/engine/src/okey';
import type { OkeyGameState, OkeyRuleConfig } from '../../../packages/engine/src/okey';
import { okeyViewFor } from '../okeyView';
import { requireVerifiedUser, settleMatch, isGameBanned, isChatBanned, keepSeatPresence, deductDiamonds, canakBurst, fetchCanak, deductEntry, refundEntry, normalizeRoomBet, authUserIdFromClient, resolveClientProfileMeta } from '../supabase';
import { payloadWithinLimit, RoomMessageGuard } from '../roomMessageGuard';

// 51 ile AYNI hediye katalogu (GiftCatalog client'ta ortak).
const GIFT_HOURS: Record<number, number> = { 1: 2, 2: 2, 3: 2, 4: 8, 5: 4, 6: 5, 7: 3, 8: 3, 9: 4, 10: 5, 11: 12, 12: 24 };
const GIFT_DIAMONDS: Record<number, number> = { 1: 5, 2: 8, 3: 6, 4: 25, 5: 15, 6: 18, 7: 12, 8: 10, 9: 14, 10: 16, 11: 35, 12: 60 };
const GIFT_NAMES: Record<number, string> = { 1: 'Çay', 2: 'Türk Kahvesi', 3: 'Limonata', 4: 'Semaver', 5: 'Pasta', 6: 'Baklava', 7: 'Lokum', 8: 'Dondurma', 9: 'Çikolata', 10: 'Meyve Tabağı', 11: 'Çiçek Buketi', 12: 'Altın Hediye Kesesi' };

type OkeyVariant = OkeyRuleConfig['variant'];

function parseOkeyRulesOption(options: any): any {
  try {
    const raw = options?.rules;
    if (typeof raw === 'string' && raw.trim().length > 0) return JSON.parse(raw);
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // Eski client bozuk/eksik JSON yollarsa varsayılan düz masaya düşer.
  }
  return null;
}

function normalizeOkeyVariant(raw: any): OkeyVariant {
  return raw === 'banko' ? 'banko' : raw === 'yuzbir' ? 'yuzbir' : 'duz';
}

export function normalizeOkeyJoinOptions(options: any): { parsed: any; variant: OkeyVariant } {
  const parsed = parseOkeyRulesOption(options);
  // Geriye uyumluluk: eski build'ler varyantı sadece rules.variant içinde gönderiyordu.
  const variant = normalizeOkeyVariant(options?.variant ?? parsed?.variant);
  if (options && typeof options === 'object') options.variant = variant;
  return { parsed, variant };
}

/**
 * OKEY masası — EllibirRoom ile AYNI sosyal/reconnect altyapısı (chat/hediye/quickChat/olaylar,
 * onDrop→allowReconnection(180)→onReconnect, izleyici, sit), motor olarak okey engine.
 * mode: 'solo' (1 insan + 3 bot) | 'duo' (eşli: 0&2 insan) | 'quad' (4 insan).
 */
export class OkeyRoom extends Room {
  maxClients = 8;

  private game: OkeyGameState | null = null;
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
  private startTick: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private humanTimer: NodeJS.Timeout | null = null;
  private elTimer: NodeJS.Timeout | null = null;
  private startAt = 0;
  private turnDeadlineAt = 0;
  private readonly START_MS = 7000;
  private readonly STEP_MS = 1100;             // bot tur temposu (client uçuş animasyonuna yer)
  private readonly EL_END_MS = 7000;           // el sonu gösterimi → yeni el
  private readonly BANKO_PHASE_MS = 10000;      // banko SEÇİM listesi süresi
  private bankoTimer: NodeJS.Timeout | null = null;
  private bankoTick: NodeJS.Timeout | null = null;
  private bankoDeadlineAt = 0;
  private readonly TURN_GRACE_MS = 6000;
  private bet = 0;
  private settled = false;
  private cfg: any = null;
  private lastReconnectAt = new Map<string, number>();
  private takeoverPending = new Set<string>(); // TAKEOVER: zombiyi bilerek dusurduk, onDrop kalkanlari atlansin // STALE-DROP kalkani (wifi->mobil gecisi)
  private readonly messageGuard = new RoomMessageGuard();
  private readonly giftBusy = new Set<string>();
  private preLog: string[] = [];               // oyun kurulmadan önceki olaylar (izleyici katıldı vb.)

  static async onAuth(_token: string, options: any): Promise<any> {
    normalizeOkeyJoinOptions(options);
    const uid = await requireVerifiedUser(options?.token);
    if (uid && (await isGameBanned(uid))) throw new Error('banned');
    return uid ?? true;
  }

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
            console.log(`[OkeyRoom._onLeave] CORE-STALE close (canlı ref açık, code=${code}) -> yok sayıldı sid=${client.sessionId}`);
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
              console.log(`[OkeyRoom.takeover] ayni oturum icin YENI baglanti -> zombi kapatiliyor sid=${client.sessionId}`);
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
    const mode = options?.mode === 'duo' ? 'duo' : options?.mode === 'quad' ? 'quad' : 'solo';
    const tableNo = Number(options?.table) || 1;
    const botTestTable = tableNo === 1 && mode !== 'quad';
    this.humanSeats = botTestTable
      ? (mode === 'duo' ? [0, 2] : [0])
      : [0, 1, 2, 3];
    const botSeats = [0, 1, 2, 3].filter((s) => !this.humanSeats.includes(s));

    const { parsed, variant: requestedVariant } = normalizeOkeyJoinOptions(options);
    const rules: OkeyRuleConfig = {
      ...DEFAULT_OKEY_RULES,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      scoring: { ...DEFAULT_OKEY_RULES.scoring, ...(parsed?.scoring ?? {}) },
      yuzbir: { ...DEFAULT_OKEY_RULES.yuzbir, ...(parsed?.yuzbir ?? {}) },
    };
    rules.variant = requestedVariant;
    if (rules.variant === 'yuzbir' && parsed?.scoring?.startScore == null) rules.scoring.startScore = 0;
    rules.teamMode = mode === 'duo';

    this.bet = normalizeRoomBet(options?.bet, [500, 1000, 2500, 5000], 'okey');
    this.cfg = { seed, names, botSeats, rules };
    this.setMetadata({ game: 'okey', mode, table: tableNo, variant: rules.variant, humans: this.humanSeats.length });
    this.refreshCanak(); // 🏺 çanak göstergesi (BÖLÜM 33)

    // Oyun komutları: {t:'draw',from} | {t:'discard',tileId} | {t:'finish',tileId} | {t:'gosterge'}
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game) return;
      if (!payloadWithinLimit(raw, 16 * 1024) || !this.messageGuard.allow(client.sessionId, 'cmd', 12, 1000)) {
        client.send('moveError', { code: 'rate_limited', message: 'Çok hızlı hamle gönderildi.' });
        return;
      }
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      const r = applyOkeyMove(this.game, seat, cmd);
      if (!r.ok) { client.send('moveError', { code: 'rule', message: r.error ?? '' }); return; }
      this.maybeAccelerateBanko(); // insan kararı sonrası erken kapanış kontrolü
      if ((this.game as any).bankoPhase) { this.pushViews(); return; }
      this.afterChange();
    });

    // ── SOSYAL KATMAN: 51 ile birebir ──
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
      if (uid) {
        isChatBanned(uid).then((banned) => {
          if (banned) { client.send('chatBlocked', { reason: 'Konuşman yasaklı.' }); return; }
          this.broadcast('chat', { seat, name, text });
        }).catch(() => client.send('chatBlocked', { reason: 'Mesaj doğrulanamadı; tekrar dene.' }));
        return;
      }
      this.broadcast('chat', { seat, name, text });
    });

    this.onMessage('gift', async (client, raw) => {
      const fromSeat = this.seats.get(client.sessionId);
      if (fromSeat == null) return;
      if (!payloadWithinLimit(raw, 1024) || !this.messageGuard.allow(client.sessionId, 'gift', 1, 1000) || this.giftBusy.has(client.sessionId)) {
        client.send('giftFailed', { reason: 'Hediye işlemi sürüyor; biraz bekle.' });
        return;
      }
      this.giftBusy.add(client.sessionId);
      try {
        const toSeat = Number(raw?.to_seat);
        const giftType = Number(raw?.gift_id);
        if (!Number.isInteger(toSeat) || toSeat < 0 || toSeat > 3) return;
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
        // HEDİYE O MASAYA ÖZEL (kullanıcı kararı 2026-07-05): Supabase kalıcılığı KALDIRILDI — yalnız broadcast.
        this.broadcast('giftSent', {
          from_seat: fromSeat, to_seat: toSeat, gift_id: giftType, from_name: fromName, expires_at: expiresAt,
        });
        this.logEvent(`${fromName}, ${this.nameOfSeat(toSeat)} için ${GIFT_NAMES[giftType] ?? 'hediye'} ısmarladı`);
        this.pushViews();
      } finally { this.giftBusy.delete(client.sessionId); }
    });

    // Client arka plana düştü / koltuğu koruyarak menüye döndü: bağlantı fiziksel olarak
    // açık kalsa bile masa donmasın; reconnect/geri dönüşte kontrol tekrar insana geçer.
    this.onMessage('away', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 256) || !this.messageGuard.allow(client.sessionId, 'away', 6, 3000)) return;
      const away = raw?.away !== false;
      if (away) {
        if (!this.abandoned.has(seat)) this.logEvent(`${this.nameOfSeat(seat)} masadan uzaklaştı — bot devraldı`);
        this.abandoned.add(seat);
      } else if (this.abandoned.delete(seat)) {
        this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü`);
      }
      this.afterChange();
    });

    // ORTAK quick-chat (yalnız eşli): sadece ortağa + gönderene.
    this.onMessage('quickChat', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 512) || !this.messageGuard.allow(client.sessionId, 'quickChat', 4, 4000)) return;
      let text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      text = String(text).slice(0, 120).trim();
      if (!text) return;
      if (!this.cfg?.rules?.teamMode) return;
      const hs = this.humanSeats;
      const partner = (hs.length >= 2 && hs.includes(seat)) ? (seat + 2) % 4 : null;
      if (partner == null) return;
      for (const [sid, s] of this.seats) {
        if (s === partner || s === seat) {
          const c = this.clients.find((cl) => cl.sessionId === sid);
          if (c) c.send('quickChat', { seat, text });
        }
      }
    });

    this.onMessage('sit', (client, raw) => {
      if (!payloadWithinLimit(raw, 2048) || !this.messageGuard.allow(client.sessionId, 'sit', 4, 5000)) return;
      let msg: any = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
      void this.trySit(client, msg?.seat, msg ?? {});
    });

    console.log(`[OkeyRoom] oluştu seed=${seed} mode=${mode} humans=${this.humanSeats}`);
  }

  async onJoin(client: Client, options: any) {
    const taken = new Set(this.seats.values());
    const spectate = options?.spectate === true || options?.spectate === 'true';
    const seat = spectate ? null : this.humanSeats.find((s) => !taken.has(s));
    if (seat == null) {
      this.spectators.add(client.sessionId);
      const meta = await resolveClientProfileMeta(authUserIdFromClient(client), options, 'İzleyici');
      this.spectatorNames.set(client.sessionId, meta.name);
      this.spectatorMeta.set(client.sessionId, { gender: meta.gender, role: meta.role });
      this.logEvent(`${meta.name} izleyici olarak masaya katıldı`);
      client.send('seat', { seat: -1 });
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
    console.log(`[OkeyRoom.onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();
    this.pushViews();
  }

  private async trySit(client: Client, rawSeat: any, options: any) {
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
    this.startGameIfReady();
    this.pushViews();
  }

  private startGameIfReady() {
    if (this.game || this.startTimer || this.seats.size < this.humanSeats.length) return;
    this.startAt = Date.now();
    this.pushViews();
    if (this.startTick) clearInterval(this.startTick);
    this.startTick = setInterval(() => { if (!this.game) this.pushViews(); }, 1000);
    this.startTimer = setTimeout(async () => {
      if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
      this.startTimer = null;
      if (this.seats.size < this.humanSeats.length) { this.pushViews(); return; }
      const entryUsers = new Map(this.seatUsers);
      const entry = await deductEntry(entryUsers, this.bet);
      if (!entry.ok) { this.abortEntryStart(entry.failedSeats); return; }
      if (this.seats.size < this.humanSeats.length) {
        await refundEntry(entryUsers, this.bet, 'seat_left_before_start');
        this.pushViews();
        return;
      }
      const banko = this.cfg?.rules?.variant === 'banko';
      this.game = createOkeyGame({ ...this.cfg, dealFirst: !banko });
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players[seat];
        if (p && name) p.name = name;
      }
      if (this.preLog.length) { this.game.matchLog.unshift(...this.preLog); this.preLog = []; }
      console.log('[OkeyRoom] oyun başladı' + (banko ? ' (banko: ilk el seçim fazı)' : ''));
      if (banko) this.enterBankoPhase();
      else this.afterChange();
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

  /* ── RECONNECT LIFECYCLE — 51 ile birebir (0.17: onDrop/onReconnect/onLeave) ── */

  async onDrop(client: Client) {
    const isTakeover = this.takeoverPending.delete(client.sessionId); // takeover dususu KALKAN-1'i atlar
    // KALKAN: wifi->mobil geciste SDK yeni baglantiyla COKTAN donduktan sonra eski
    // socketin gecikmis kapanisi ikinci bir onDrop tetikliyor; allowReconnection aninda
    // patlayip KOLTUGU SILIYORDU (log: onReconnect/onDrop ayni saniye -> EXPIRED -> 4002).
    if (!isTakeover && Date.now() - (this.lastReconnectAt.get(client.sessionId) ?? 0) < 3000) {
      console.log(`[OkeyRoom.onDrop] STALE drop (yeni baglanti canli) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[OkeyRoom.onDrop] sessionId=${client.sessionId} seat=${this.seats.get(client.sessionId)}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) this.pushViews();
      this.spectatorNames.delete(client.sessionId);
      this.spectatorMeta.delete(client.sessionId);
      this.messageGuard.forget(client.sessionId);
      this.giftBusy.delete(client.sessionId);
      this.lastReconnectAt.delete(client.sessionId);
      this.takeoverPending.delete(client.sessionId);
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
      keepSeatPresence(uid, tableNo, 'okey-' + mode);
      presenceTimer = setInterval(() => keepSeatPresence(uid, tableNo, 'okey-' + mode), 50000);
    }
    const stop = () => { if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; } };
    try {
      const back = await this.allowReconnection(client, 180);
      console.log(`[OkeyRoom.onDrop-SUCCESS] seat=${seat} geri döndü`);
      stop();
      this.abandoned.delete(seat);
      try { back.send('seat', { seat }); } catch { /* yoksay */ }
      this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü`);
      this.afterChange();
    } catch (e: any) {
      console.log(`[OkeyRoom.onDrop-EXPIRED] seat=${seat}: ${e?.message ?? e}`);
      stop();
      // KALKAN-2: pencere doldu dese de bu sessionId hala BAGLIYSA (yaris) koltuga dokunma.
      if (this.clients.some((c) => c.sessionId === client.sessionId)) {
        console.log(`[OkeyRoom.onDrop-EXPIRED] client CANLI -> koltuk korunuyor (stale)`);
        return;
      }
      this.cleanupSeat(client.sessionId, seat); // oyun başladıysa kalıcı bot; beklemede koltuk boşalır
      if (!this.game) this.abandoned.delete(seat);
      this.pushViews();
    }
  }

  onReconnect(client: Client) {
    this.lastReconnectAt.set(client.sessionId, Date.now());
    const seat = this.seats.get(client.sessionId);
    console.log(`[OkeyRoom.onReconnect] seat=${seat}`);
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
      console.log(`[OkeyRoom.onLeave] STALE leave (reconnect taze, code=${_code}) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[OkeyRoom.onLeave] sessionId=${client.sessionId} code=${_code}`);
    const seat = this.seats.get(client.sessionId);
    if (seat == null) {
      if (this.spectators.delete(client.sessionId)) this.pushViews();
      this.spectatorNames.delete(client.sessionId);
      this.spectatorMeta.delete(client.sessionId);
      this.messageGuard.forget(client.sessionId);
      this.giftBusy.delete(client.sessionId);
      this.lastReconnectAt.delete(client.sessionId);
      this.takeoverPending.delete(client.sessionId);
      return;
    }
    if (!this.game) {
      this.abandoned.delete(seat);
      this.cleanupSeat(client.sessionId, seat);
      this.pushViews();
      return;
    }
    this.abandoned.add(seat); // kalıcı
    this.logEvent(`${this.nameOfSeat(seat)} oyundan çıktı — yerini bot aldı`);
    this.cleanupSeat(client.sessionId, seat);
    this.afterChange();
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
  }

  private nameOfSeat(seat: number): string {
    return this.game?.players?.[seat]?.name ?? this.seatNames.get(seat) ?? 'Oyuncu';
  }

  private logEvent(msg: string) {
    if (this.game) this.game.matchLog.push(msg);
    else this.preLog.push(msg);
  }

  /* ── OYUN AKIŞI: her değişimden sonra tek yerden zamanla ── */

  /* ── ÇANAK (BÖLÜM 33): el bitiren İNSAN, bitiş türüne göre şansla çanağı patlatır.
     okey %3 · çift %5 · çift+okey %8. Patlayan tutarın tamamı bitirene; çanak sıfırlanır. ── */
  private canakEl = -1;          // el başına TEK kontrol
  private canakAmount = 0;       // gösterge (bellek kopyası; view'a gider)
  private canakSeq = 0;          // patlama sayacı (view garantisi — broadcast kaçsa da modal açılır)
  private canakWin: { seat: number; name: string; amount: number } | null = null;

  private refreshCanak() { fetchCanak('okey').then((v) => { this.canakAmount = v; this.pushViews(); }).catch(() => {}); }

  private maybeCanak() {
    if (!this.game || this.canakEl === this.game.elNumber) return;
    this.canakEl = this.game.elNumber;
    const w = this.game.elWinner ?? -1;
    const fk = this.game.finishKind;
    const p = fk === 'pairsOkey' ? 0.08 : fk === 'pairs' ? 0.05 : fk === 'okey' ? 0.03 : 0;
    const uid = w >= 0 ? this.seatUsers.get(w) : undefined;
    if (!uid || p <= 0 || Math.random() >= p) { this.refreshCanak(); return; }
    canakBurst('okey', uid, this.nameOfSeat(w)).then((amt) => {
      if (amt <= 0 || !this.game) { this.refreshCanak(); return; }
      this.canakAmount = 0;
      const name = this.nameOfSeat(w);
      this.canakSeq += 1;
      this.canakWin = { seat: w, name, amount: amt };
      this.game.matchLog.push(`🏺 ÇANAK PATLADI! ${name} ${amt} çip kazandı!`);
      this.broadcast('canak', { seat: w, name, amount: amt, seq: this.canakSeq });
      this.pushViews();
    }).catch(() => {});
  }

  private afterChange() {
    if (this.game && (this.game.elEnded || this.game.matchEnded)) this.maybeCanak();
    // SIRA ÖNEMLİ: önce zamanlayıcı (turnDeadlineAt) KURULUR, sonra push edilir — aksi halde
    // view ESKİ deadline ile gider: insan sırasında turnMs=0 (sayaç hiç çıkmaz), bot sırasındaki
    // push önceki insanın kalıntı süresini taşır (sayaç yanlış koltukta görünür bug'ı).
    if (!this.game) { this.pushViews(); return; }
    if (this.game.matchEnded) {
      this.settleOnce(); this.clearTurnTimers(); this.turnDeadlineAt = 0;
      this.pushViews(); return;
    }
    if (this.game.elEnded) {
      this.clearTurnTimers(); this.turnDeadlineAt = 0;
      if ((this.game as any).bankoPhase) { this.pushViews(); return; } // faz sürüyor (kendi timer'ı var)
      if (!this.elTimer) {
        this.elTimer = setTimeout(() => {
          this.elTimer = null;
          if (!this.game || this.game.matchEnded) return;
          if (this.game.rules.variant === 'banko') { this.enterBankoPhase(); return; }
          startNextEl(this.game);
          this.afterChange();
        }, this.EL_END_MS);
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
    if (!this.game || this.game.elEnded || this.game.matchEnded) return;
    this.clearTurnTimers();
    const turn = this.game.turn;
    const p = this.game.players[turn]!;
    const botLike = p.isBot || this.abandoned.has(turn);
    if (botLike) {
      this.turnDeadlineAt = 0;
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        if (!this.game || this.game.elEnded || this.game.turn !== turn) { this.afterChange(); return; }
        playOkeyBotTurn(this.game, turn);
        this.afterChange();
      }, this.STEP_MS);
    } else {
      const ms = Math.max(8000, this.game.rules.turnTimerSeconds * 1000) + this.TURN_GRACE_MS;
      this.turnDeadlineAt = Date.now() + ms;
      this.humanTimer = setTimeout(() => {
        this.humanTimer = null;
        if (!this.game || this.game.elEnded || this.game.turn !== turn) { this.afterChange(); return; }
        autoOkeyMove(this.game, turn);
        this.logEvent(`${this.nameOfSeat(turn)} süresi doldu — otomatik oynandı`);
        this.afterChange();
      }, ms);
    }
  }

  /** BANKO SEÇİM FAZI: 5sn liste — kararlar canlı push'lanır; süre bitince kararsız PAS. */
  private bankoBotTimers: NodeJS.Timeout[] = [];

  /** SEÇİM FAZI erken kapanışı: bağlı TÜM insanlar kararlıysa süreyi 3sn'e indir.
   *  HER karar yolundan çağrılır — eski hali yalnız cmd handler'daydı; hakkını geçmiş elde
   *  kullanan oyuncu HİÇ komut göndermediği için 2. el ve sonrası hızlandırma çalışmıyordu. */
  private maybeAccelerateBanko() {
    if (!this.game || !(this.game as any).bankoPhase || !this.bankoTimer) return;
    const humans = [...this.seats.values()];
    if (humans.length === 0) return;
    const allDecided = humans.every((s2) => (this.game as any).bankoChoice[s2] !== -1);
    if (!allDecided) return;
    const kalanMs = Math.max(0, this.bankoDeadlineAt - Date.now());
    const closeMs = Math.min(kalanMs, 3000);
    if (closeMs >= kalanMs) return; // zaten 3sn altı
    clearTimeout(this.bankoTimer);
    this.bankoDeadlineAt = Date.now() + closeMs;
    this.bankoTimer = setTimeout(() => this.finishBankoPhase(), closeMs);
  }

  private enterBankoPhase() {
    if (!this.game) return;
    // HERKES hakkını kullandıysa liste HİÇ çıkmaz — el direkt başlar (kullanıcı kuralı).
    // (Son el mecburiyeti bu kontrolden ETKİLENMEZ: mecburiyet hakkı DURANLARA yazılır;
    //  hak kalmadıysa zaten gösterilecek karar yok.)
    const anyRight = [0, 1, 2, 3].some((s) => !this.game!.bankoUsed[s]);
    if (!anyRight) {
      beginBankoPhase(this.game);
      resolveBankoPhase(this.game);
      startNextEl(this.game);
      this.afterChange();
      return;
    }
    beginBankoPhase(this.game);
    this.bankoDeadlineAt = Date.now() + this.BANKO_PHASE_MS;
    this.pushViews();
    if (this.bankoTimer) clearTimeout(this.bankoTimer);
    this.bankoTimer = setTimeout(() => this.finishBankoPhase(), this.BANKO_PHASE_MS);
    // BOT KARARLARI: 0.8-2.5sn rastgele gecikmeyle listeye CANLI düşer (%35 banko / %65 pas motor'da).
    for (let si = 0; si < 4; si++) {
      const pl = this.game.players[si]!;
      if (!pl.isBot && !this.abandoned.has(si)) continue;
      if (this.game.bankoChoice[si] !== -1) continue;
      const delay = 800 + Math.floor(Math.random() * 1700);
      this.bankoBotTimers.push(setTimeout(() => {
        if (!this.game || !this.game.bankoPhase) return;
        botBankoDecide(this.game, si);
        this.pushViews();
      }, delay));
    }
    if (this.bankoTick) clearInterval(this.bankoTick);
    this.bankoTick = setInterval(() => this.pushViews(), 1000); // geri sayım canlı
    // İnsanların HEPSİ zaten kararlıysa (hak yanmış → otomatik PAS kilidi) süre BAŞTAN 3sn'e iner
    // — eski akışta bu oyuncular hiç komut göndermediği için 2. el+ hızlandırma çalışmıyordu.
    this.maybeAccelerateBanko();
  }

  private finishBankoPhase() {
    if (this.bankoTimer) { clearTimeout(this.bankoTimer); this.bankoTimer = null; }
    if (this.bankoTick) { clearInterval(this.bankoTick); this.bankoTick = null; }
    for (const t of this.bankoBotTimers) clearTimeout(t);
    this.bankoBotTimers = [];
    this.bankoDeadlineAt = 0;
    if (!this.game) return;
    // Emniyet: erken kapanış bot gecikmesini kestiyse kalan botlar ŞİMDİ karar versin.
    for (let si = 0; si < 4; si++)
      if (this.game.players[si]!.isBot && this.game.bankoChoice[si] === -1) botBankoDecide(this.game, si);
    resolveBankoPhase(this.game);
    startNextEl(this.game);
    this.afterChange();
  }

  private settleOnce() {
    if (this.settled || !this.game) return;
    this.settled = true;
    const scores = new Map<number, number>();
    for (let s = 0; s < 4; s++) scores.set(s, this.game.scores[s]!);
    const openedSeats = new Set<number>();
    if (this.game.rules.variant === 'yuzbir')
      for (let s = 0; s < 4; s++) if (this.game.players[s]!.hasOpened) openedSeats.add(s);
    let winnerSeat = 0;
    for (let s = 1; s < 4; s++) if (this.game.scores[s]! < this.game.scores[winnerSeat]!) winnerSeat = s;
    settleMatch({
      seatUsers: this.seatUsers,
      winnerSeat,
      bet: this.bet,
      teamMode: this.game.rules.teamMode,
      scores,
      totalSeats: 4,
      gameVariant: this.game.rules.variant,
      openedSeats,
      game: 'okey', // çanak hedefi (düz + banko ortak çanak)
    }).then(() => this.refreshCanak()) // settle çanağa ekledi → masa içi gösterge canlansın
      .catch((e) => console.error('[OkeyRoom.settle] hata:', e?.message));
  }

  /* ── GÖRÜNÜM ── */

  private pushViews() {
    const waiting = !this.game;
    const starting = waiting && this.seats.size >= this.humanSeats.length;
    const filled = new Set(this.seats.values());
    const seated = [0, 1, 2, 3].map((s) => ({
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
      v.bankoMs = this.bankoDeadlineAt > 0 ? Math.max(0, this.bankoDeadlineAt - Date.now()) : 0;
      v.canak = this.canakAmount; // 🏺 çanak göstergesi (bellek kopyası)
      v.canakSeq = this.canakSeq;
      v.canakWinSeat = this.canakWin?.seat ?? -1;
      v.canakWinName = this.canakWin?.name ?? '';
      v.canakWinAmount = this.canakWin?.amount ?? 0;
      v.preLog = waiting ? this.preLog.slice(-30) : [];
    };
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      const v: any = okeyViewFor(this.game, seat == null ? -1 : seat);
      decorate(v);
      c.send('view', JSON.stringify(v));
    });
  }

  onDispose() {
    this.messageGuard.clear();
    this.giftBusy.clear();
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
    if (this.elTimer) clearTimeout(this.elTimer);
    if (this.bankoTimer) clearTimeout(this.bankoTimer);
    if (this.bankoTick) clearInterval(this.bankoTick);
    this.clearTurnTimers();
    console.log('[OkeyRoom] dispose');
  }
}
