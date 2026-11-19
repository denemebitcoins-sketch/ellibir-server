import { sendView, wantsCompressedViews } from '../viewWire';
import { busyHumanFromEntryError, BUSY_ELSEWHERE_REASON, maintenanceBlock, okeyMaintenanceKey } from '../gameMaintenance';
import { Room, Client } from '@colyseus/core';
import { ReadyGate, READY_START_MS } from '../readyGate';
import { populationMatchExtras } from '../populationExtras';
import { reconnectWindowSec } from '../reconnectWindow';
import { TABLE_BETS } from '../tableBets';
import { SeatPresenceLeases, hasOpenTransport, pendingReconnection } from '../seatPresenceLease';
import {
  createOkeyGame, startNextEl, applyOkeyMove, autoOkeyMove, playOkeyBotTurn,
  beginBankoPhase, resolveBankoPhase, botBankoDecide, DEFAULT_OKEY_RULES,
} from '../../../packages/engine/src/okey';
import type { OkeyGameState, OkeyRuleConfig } from '../../../packages/engine/src/okey';
import { okeyViewFor } from '../okeyView';
import { requireVerifiedUser, settleMatch, isGameBanned, isChatBanned, filterChatText, keepSeatPresence, deductDiamonds, canakBurst, fetchCanak, deductEntry, refundEntryOnce, normalizeRoomBet, normalizeRoomOption, authUserIdFromClient, resolveClientProfileMeta, entryHouseAmount, displayProfileRole } from '../supabase';
import type { MatchProgressionAward } from '../supabase';
import { payloadWithinLimit, RoomMessageGuard } from '../roomMessageGuard';
import { GIFT_DIAMONDS, GIFT_HOURS, GIFT_NAMES, normalizeGiftRequest, giftRecipientsAllowed } from '../gifts';
import { ExistingUserSeat, findExistingUserSeat, onlineHumanSeats, seatsWithoutLivePlayer, selectJoinSeat, selectSitSeat } from '../seatSelection';
import { okeyCanakChance } from '../canakPolicy';
import { hasLowestScoreTie, isOneRoundNoContest, shouldDeferEntryHouse } from '../noContest';
import { canUseReaction } from '../cosmetics';
import { allHumanStartingRoster } from '../matchRewardEligibility';
import { PopulationRoomSession } from '../botPopulation/roomSession';
import { PopulationStorage } from '../botPopulation/storage';
import { attachPopulationBinding, populationBetOption, requirePopulationClient, PopulationClientSupport, populationAdoptionPlan, handsInfo } from '../botPopulation/roomBinding';

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
  /** 'viewz' (sıkıştırılmış view) destekleyen oturumlar (reconnect aynı sessionId ile gelir). */
  private readonly zvSessions = new Set<string>();
  maxClients = 8;

  private game: OkeyGameState | null = null;
  private seats = new Map<string, number>();
  private spectators = new Set<string>();
  private spectatorNames = new Map<string, string>();
  private spectatorMeta = new Map<string, { gender: string; role: string; adminBadgeHidden: boolean }>();
  private seatMeta = new Map<number, { gender: string; role: string; adminBadgeHidden: boolean; nameStyle?: string }>();
  private humanSeats: number[] = [];
  private seatUsers = new Map<number, string>();
  private seatNames = new Map<number, string>();
  private adminBots = new Map<number, string>(); // YONETICININ ekledigi botlar: koltuk -> ad (test masalari)
  private abandoned = new Set<number>();       // kopan insan koltukları (bot devralır)
  private startTimer: NodeJS.Timeout | null = null;
  private startTick: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private humanTimer: NodeJS.Timeout | null = null;
  private elTimer: NodeJS.Timeout | null = null;
  private startAt = 0;
  private turnDeadlineAt = 0;
  private readonly START_MS = 7000;
  private startDelay = 7000;                    // bu geri sayımın toplam süresi (hazır sisteminde 3 sn)
  private readonly readyGate = new ReadyGate(() => this.onReadyTimeout());
  private readonly STEP_MS = 1100;             // bot tur temposu (client uçuş animasyonuna yer)
  private readonly EL_END_MS = 3500;           // el sonu gosterimi -> yeni el
  private readonly BANKO_PHASE_MS = 10000;      // banko SEÇİM listesi süresi
  private bankoTimer: NodeJS.Timeout | null = null;
  private bankoTick: NodeJS.Timeout | null = null;
  private bankoDeadlineAt = 0;
  private readonly TURN_GRACE_MS = 2000;       // 18.11: gizli tolerans 6→2 sn (ekrandaki sayaç gerçek süreyle başlar)
  private turnArmedSeat = -1;                    // 18.11: sıra başına TEK sayaç (taş çekmek sıfırlamaz)
  private bet = 0;
  private settled = false;
  private entryCanakCharged = false;
  private matchRewardsEligible = false;
  private settlePromise: Promise<void> | null = null;
  private matchStartedAt = '';                 // 18.11: maç başlangıcı (Kahve Saati penceresi buna göre)
  private matchProgressionKey = '';            // XP idempotency key (per authoritative match)
  private cfg: any = null;
  private rematchVotes = new Set<number>();
  private rematchStarting = false;
  private lastReconnectAt = new Map<string, number>();
  private takeoverPending = new Set<string>(); // TAKEOVER: zombiyi bilerek dusurduk, onDrop kalkanlari atlansin // STALE-DROP kalkani (wifi->mobil gecisi)
  private readonly messageGuard = new RoomMessageGuard();
  private readonly giftBusy = new Set<string>();
  private preLog: string[] = [];               // oyun kurulmadan önceki olaylar (izleyici katıldı vb.)
  private closingBotOnly = false;
  private population: PopulationRoomSession | null = null;
  private populationHeartbeat: NodeJS.Timeout | null = null;
  private populationAccepting = true;
  private entryStarting = false;
  private disposed = false;
  private readonly populationClients = new PopulationClientSupport();

  // Trusted server capability only, never supplied by client options/messages.
  bindPopulation(storage: PopulationStorage, owner: string, roomKey: string): PopulationRoomSession {
    if (!this.cfg || this.game || this.entryStarting || this.population || this.adminBots.size) throw new Error('population_bind_unavailable');
    const names = new Set<number>();
    let wasPlayable = true;
    const population = new PopulationRoomSession(storage, owner, roomKey, normalizeOkeyVariant(this.cfg.rules?.variant), this.bet, {
      canReserve: seat => this.populationAccepting && !this.disposed && !this.game && !this.entryStarting
        && ![...this.seats.values()].includes(seat) && !this.adminBots.has(seat),
      canRemove: () => !this.disposed && !this.game && !this.entryStarting && this.seats.size === 0,
      status: () => ({ phase: !this.game ? 'waiting' : this.game.matchEnded ? 'ended' : 'playing',
        humanSeats: [...this.seats.values()], occupiedSeats: [...this.occupiedSeats()], starting: this.entryStarting, disposed: this.disposed }),
      accepting: value => { this.populationAccepting = value; },
      chat: payload => this.broadcast('chat',payload),
      detached: seats => {
        for (const seat of seats) if (![...this.seats.values()].includes(seat)) this.seatNames.delete(seat);
        if (this.populationHeartbeat) { clearInterval(this.populationHeartbeat); this.populationHeartbeat = null; }
        this.population = null;
        this.populationAccepting = true;
        this.autoDispose = true;
        this.pushViews();
      },
      changed: () => {
        if (this.disposed) return;
        for (const seat of names) if (!population.has(seat)) {
          if (![...this.seats.values()].includes(seat) && !this.adminBots.has(seat)) this.seatNames.delete(seat);
          names.delete(seat);
        }
        for (const seat of population.seats()) { names.add(seat); this.seatNames.set(seat, population.name(seat)!); }
        const playable = this.populationCanPlay();
        const resumed = playable && !wasPlayable;
        wasPlayable = playable;
        if (!playable) this.pausePopulationTimers();
        if (!this.game) this.startGameIfReady();
        else if (resumed) {
          if (this.game.bankoPhase) this.scheduleBankoPhase();
          else this.afterChange();
        } else if (playable && this.game.matchEnded) this.settleOnce();
        this.pushViews();
      },
    });
    this.population = population;
    this.autoDispose = false;
    this.populationHeartbeat = setInterval(() => {
      void population.renew().catch((e: any) => console.warn('[population] lease renewal:', e?.message));
    }, 10000);
    this.populationHeartbeat.unref?.();
    return population;
  }

  private populationCanPlay(): boolean { return !this.disposed && (!this.population?.size || this.population.canPlay); }
  /** Server-only invite lookup. Never trust a requested room, seat or user ID from a client payload. */
  populationInviteSeat(uid: string): number {
    if (!uid || !this.population || !this.populationAccepting || !this.populationCanPlay() || this.game || this.entryStarting) return -1;
    if (!this.clients.some(c => authUserIdFromClient(c) === uid && this.seats.has(c.sessionId))) return -1;
    const occupied = this.occupiedSeats();
    return this.humanSeats.find(s => !occupied.has(s)) ?? -1;
  }
  populationAdoption(uid: string) {
    if (!uid || !this.cfg || this.population || this.disposed || this.game || this.entryStarting || this.startTimer
      || this.adminBots.size || !this.populationClients.ready(this.clients)) return null;
    if (!this.clients.some(c => authUserIdFromClient(c) === uid && this.seats.has(c.sessionId))
      || [...this.seats.values()].some(s => !this.seatUsers.get(s)) || this.occupiedSeats().size >= this.humanSeats.length) return null;
    return populationAdoptionPlan(normalizeOkeyVariant(this.cfg.rules?.variant), !!this.cfg.rules?.teamMode,
      Number((this.metadata as any)?.table), this.bet, handsInfo(this.cfg.rules?.totalEls, 'el'));
  }
  private occupiedSeats(): Set<number> {
    return new Set([...this.seats.values(), ...this.adminBots.keys(), ...(this.population?.blockedSeats() ?? [])]);
  }
  private pausePopulationTimers() {
    this.clearTurnTimers();
    this.turnDeadlineAt = 0;
    if (this.elTimer) { clearTimeout(this.elTimer); this.elTimer = null; }
    if (this.bankoTimer) { clearTimeout(this.bankoTimer); this.bankoTimer = null; }
    if (this.bankoTick) { clearInterval(this.bankoTick); this.bankoTick = null; }
    for (const timer of this.bankoBotTimers) clearTimeout(timer);
    this.bankoBotTimers = [];
    this.bankoDeadlineAt = 0;
  }

  static async onAuth(_token: string, options: any): Promise<any> {
    normalizeOkeyJoinOptions(options);
    const uid = await requireVerifiedUser(options?.token);
    if (uid && (await isGameBanned(uid))) throw new Error('banned');
    return uid ?? true;
  }

  /** 19.11 masa sohbeti flood koruması: kişi başı 2,5 sn'de 1, dakikada en fazla 8 mesaj. */
  private chatRateOk(sessionId: string): boolean {
    return this.messageGuard.allow(sessionId, 'chat', 1, 2500) && this.messageGuard.allow(sessionId, 'chatMin', 8, 60_000);
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
    this.humanSeats = onlineHumanSeats('okey');
    const botSeats: number[] = [];

    const { parsed, variant: requestedVariant } = normalizeOkeyJoinOptions(options);
    const rules: OkeyRuleConfig = {
      ...DEFAULT_OKEY_RULES,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      scoring: { ...DEFAULT_OKEY_RULES.scoring, ...(parsed?.scoring ?? {}) },
      yuzbir: { ...DEFAULT_OKEY_RULES.yuzbir, ...(parsed?.yuzbir ?? {}) },
    };
    rules.variant = requestedVariant;
    rules.totalEls = normalizeRoomOption(rules.totalEls, [1, 3, 5, 7, 9, 11], DEFAULT_OKEY_RULES.totalEls, 'okey_hands');
    rules.turnTimerSeconds = normalizeRoomOption(rules.turnTimerSeconds, [30, 45, 60], DEFAULT_OKEY_RULES.turnTimerSeconds, 'okey_turn');
    // Biriktirme modelleri (banko + 101): 0'dan başlanır, sabit el, en düşük kazanır (kullanıcı kuralı).
    if (rules.variant === 'yuzbir' || rules.variant === 'banko') rules.scoring.startScore = 0;
    // DÜZ OKEY kaçtan-düş: yalnız izinli basamaklar (20/24/28/30); dışındaysa 24'e çek.
    if (rules.variant === 'duz' && ![20, 24, 28, 30].includes(rules.scoring.startScore)) rules.scoring.startScore = 24;
    rules.teamMode = mode === 'duo';

    this.bet = populationBetOption(options) ?? normalizeRoomBet(options?.bet, TABLE_BETS, 'okey');
    this.cfg = { seed, names, botSeats, rules };
    attachPopulationBinding(options, this);
    this.setMetadata({ game: 'okey', mode, table: tableNo, variant: rules.variant, humans: this.humanSeats.length });
    this.refreshCanak(); // 🏺 çanak göstergesi (BÖLÜM 33)

    // Oyun komutları: {t:'draw',from} | {t:'discard',tileId} | {t:'finish',tileId} | {t:'gosterge'}
    this.onMessage('cmd', (client, raw) => {
      if (!this.populationCanPlay()) { client.send('moveError', { code: 'population_paused', message: 'Masa baglantisi yenileniyor.' }); return; }
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.game) return;
      if (!payloadWithinLimit(raw, 16 * 1024) || !this.messageGuard.allow(client.sessionId, 'cmd', 12, 1000)) {
        client.send('moveError', { code: 'rate_limited', message: 'Çok hızlı hamle gönderildi.' });
        return;
      }
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      if (cmd?.t === 'ready' || cmd?.t === 'rematch') {
        void this.handleReady(seat);
        return;
      }
      const r = applyOkeyMove(this.game, seat, cmd);
      if (!r.ok) { client.send('moveError', { code: 'rule', message: r.error ?? '' }); return; }
      this.maybeAccelerateBanko(); // insan kararı sonrası erken kapanış kontrolü
      if ((this.game as any).bankoPhase) { this.pushViews(); return; }
      this.afterChange();
    });

    const ready = (client: Client) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null || !this.messageGuard.allow(client.sessionId, 'ready', 2, 5000)) return;
      void this.handleReady(seat);
    };
    this.onMessage('ready', ready);
    this.onMessage('rematch', ready); // eski istemciler

    // ── SOSYAL KATMAN: 51 ile birebir ──
    this.onMessage('chat', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 1024) || !this.chatRateOk(client.sessionId)) {
        client.send('chatBlocked', { reason: 'Çok hızlı yazıyorsun, birkaç saniye bekle.' });
        return;
      }
      let text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      text = String(text).slice(0, 200).trim();
      if (!text) return;
      const name = this.seatNames.get(seat) ?? `Oyuncu ${seat + 1}`;
      const uid = this.seatUsers.get(seat);
      if (uid) {
        isChatBanned(uid).then(async (banned) => {
          if (banned) { client.send('chatBlocked', { reason: 'Konuşman yasaklı.' }); return; }
          const filtered = await filterChatText(text);
          this.broadcast('chat', { seat, name, text: filtered });
        }).catch(() => client.send('chatBlocked', { reason: 'Mesaj doğrulanamadı; tekrar dene.' }));
        return;
      }
      filterChatText(text)
        .then((filtered) => this.broadcast('chat', { seat, name, text: filtered }))
        .catch(() => client.send('chatBlocked', { reason: 'Mesaj doğrulanamadı; tekrar dene.' }));
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
        const gift = normalizeGiftRequest(raw, 3);
        if (!gift) { client.send('giftFailed', { reason: 'Hediye veya hedef geçersiz.' }); return; }
        const { giftId: giftType, targets } = gift;
        const recipientIds = targets.map(seat => this.seatUsers.get(seat));
        if (!await giftRecipientsAllowed(recipientIds) || targets.some((seat, i) => this.seatUsers.get(seat) !== recipientIds[i])) {
          client.send('giftFailed', { reason: 'Alıcı hediye kabul etmiyor veya tercih doğrulanamadı.' }); return;
        }
        const fromUid = this.seatUsers.get(fromSeat);
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
      void keepSeatPresence(this.seatUsers.get(seat), Number((this.metadata as any)?.table) || 1, this.presenceMode(), !away, !!this.game);
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
      // Bot ortak olsa bile mesajı ilet; eğer ortak insan değilse sadece gönderene echo gider.
      const partner = (seat + 2) % 4;
      for (const [sid, s] of this.seats) {
        if (s === partner || s === seat) {
          const c = this.clients.find((cl) => cl.sessionId === sid);
          if (c) c.send('quickChat', { seat, text });
        }
      }
    });

    // MASA REAKSİYONU: {kind} — masadaki TÜM insanlara (+ gönderene echo) broadcast.
    // State yok, kalıcılık yok: balon client'ta ~2.5sn yaşar. Türler client TableReactions ile birebir.
    this.onMessage('reaction', async (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (!payloadWithinLimit(raw, 128) || !this.messageGuard.allow(client.sessionId, 'reaction', 1, 5000)) return;
      let kind = typeof raw === 'string' ? raw : (raw?.kind ?? '');
      kind = String(kind).slice(0, 16).trim();
      if (!['clap', 'smile', 'wow', 'angry', 'giggle', 'angry_shout', 'tease_smirk', 'sad_shy'].includes(kind)) return;
      if (!await canUseReaction(this.seatUsers.get(seat), kind)) return;
      for (const c of this.clients) {
        if (this.seats.get(c.sessionId) != null) c.send('reaction', { seat, kind });
      }
    });

    // YONETICI bot yerlestirme (kullanici istegi): admin beklerken bos koltuga bot atar.
    this.onMessage('adminAddBot', (client, raw) => {
      if (this.population || this.entryStarting) return;
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (this.seatMeta.get(seat)?.role !== 'admin') { client.send('sitError', { reason: 'yetki yok' }); return; }
      if (this.game) { client.send('sitError', { reason: 'oyun başladı' }); return; }
      const target = Number(raw?.seat);
      if (!Number.isInteger(target) || !this.humanSeats.includes(target)) { client.send('sitError', { reason: 'geçersiz koltuk' }); return; }
      if ([...this.seats.values()].includes(target) || this.adminBots.has(target)) { client.send('sitError', { reason: 'koltuk dolu' }); return; }
      this.adminBots.set(target, 'Bot ' + (target + 1));
      this.seatNames.set(target, this.adminBots.get(target)!);
      this.logEvent(`Yönetici koltuk ${target + 1} için bot ekledi`);
      this.startGameIfReady();
      this.pushViews();
    });
    this.onMessage('adminRemoveBot', (client, raw) => {
      if (this.population || this.entryStarting) return;
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      if (this.seatMeta.get(seat)?.role !== 'admin') { client.send('sitError', { reason: 'yetki yok' }); return; }
      if (this.game) { client.send('sitError', { reason: 'oyun başladı' }); return; }
      const target = Number(raw?.seat);
      if (this.adminBots.delete(target)) {
        this.seatNames.delete(target);
        this.logEvent(`Yönetici koltuk ${target + 1} botunu kaldırdı`);
        this.cancelShortStartCountdown();
        this.pushViews();
      }
    });
    // 6.9 HAZIR sistemi: maç öncesi hazır + masa sahibinin atması
    this.onMessage('preReady', (client) => { if (this.messageGuard.allow(client.sessionId, 'preReady', 3, 5000)) this.handlePreReady(client); });
    this.onMessage('kick', (client, raw) => { if (payloadWithinLimit(raw, 256) && this.messageGuard.allow(client.sessionId, 'kick', 3, 5000)) this.handleKick(client, raw); });
    this.onMessage('sit', (client, raw) => {
      if (!payloadWithinLimit(raw, 2048) || !this.messageGuard.allow(client.sessionId, 'sit', 4, 5000)) return;
      let msg: any = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
      void this.trySit(client, msg?.seat, msg ?? {});
    });

    console.log(`[OkeyRoom] oluştu seed=${seed} mode=${mode} humans=${this.humanSeats}`);
  }

  async onJoin(client: Client, options: any) {
    // 19.11 BAKIM MODU: oyun başlamamış masaya yeni oturuş reddedilir (koltuğuna dönen + yönetici hariç).
    if (!this.game) {
      const mUid = authUserIdFromClient(client);
      if (!findExistingUserSeat(this.seats, this.seatUsers, mUid)) {
        const why = await maintenanceBlock(okeyMaintenanceKey(normalizeOkeyVariant(this.cfg?.rules?.variant)), mUid);
        if (why) throw new Error('maintenance:' + why);
      }
    }
    this.readyGate.observe(client.sessionId, options);
    if (wantsCompressedViews(options)) this.zvSessions.add(client.sessionId); // sıkıştırılmış view isteyen istemci
    requirePopulationClient(this.population, options);
    this.populationClients.observe(client, options, this.clients, this.seats.keys());
    const uid = authUserIdFromClient(client);
    const existing = findExistingUserSeat(this.seats, this.seatUsers, uid);
    if (existing && this.reclaimDroppedSeat(client, existing, options)) return;
    if (existing) {
      this.spectators.add(client.sessionId);
      const meta = await resolveClientProfileMeta(uid, options, 'İzleyici');
      this.spectatorNames.set(client.sessionId, meta.name);
      this.spectatorMeta.set(client.sessionId, { gender: meta.gender, role: meta.role, adminBadgeHidden: meta.adminBadgeHidden });
      this.logEvent(`${meta.name} izleyici olarak masaya katıldı`);
      client.send('seat', { seat: -1 });
      client.send('sitError', { reason: 'Bu hesap zaten masada; devam eden oyuna geri dön.' });
      console.warn(`[OkeyRoom.onJoin] ayni uid ikinci koltuga alinmadi uid=${uid} existingSeat=${existing.seat} newSid=${client.sessionId}`);
      this.pushViews();
      return;
    }
    const taken = this.occupiedSeats();
    const spectate = this.entryStarting || !!(this.population && (this.game || !uid))
      || options?.spectate === true || options?.spectate === 'true';
    const joinBan = this.kickBanReason(uid);
    const decision = selectJoinSeat(this.humanSeats, taken, spectate || !!joinBan, options?.requestedSeat);
    const seat = decision.seat;
    if (seat == null) {
      this.spectators.add(client.sessionId);
      const meta = await resolveClientProfileMeta(authUserIdFromClient(client), options, 'İzleyici');
      this.spectatorNames.set(client.sessionId, meta.name);
      this.spectatorMeta.set(client.sessionId, { gender: meta.gender, role: meta.role, adminBadgeHidden: meta.adminBadgeHidden });
      this.logEvent(`${meta.name} izleyici olarak masaya katıldı`);
      client.send('seat', { seat: -1 });
      if (joinBan) client.send('sitError', { reason: joinBan });
      if (decision.error) {
        client.send('sitError', {
          reason: decision.error === 'seat_unavailable' ? 'seçilen koltuk dolu' : 'geçersiz koltuk',
        });
      }
      this.pushViews();
      return;
    }
    this.seats.set(client.sessionId, seat);
    this.readyGate.noteSeated(seat);
    if (uid) this.seatUsers.set(seat, uid);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    const meta = await resolveClientProfileMeta(uid, options, `Oyuncu ${seat + 1}`);
    this.seatNames.set(seat, meta.name);
    this.seatMeta.set(seat, { gender: meta.gender, role: meta.role, adminBadgeHidden: meta.adminBadgeHidden, nameStyle: meta.nameStyle ?? '' });
    client.send('seat', { seat });
    console.log(`[OkeyRoom.onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.startGameIfReady();
    this.pushViews();
  }

  private async trySit(client: Client, rawSeat: any, options: any) {
    { const why = this.game ? null : await maintenanceBlock(okeyMaintenanceKey(normalizeOkeyVariant(this.cfg?.rules?.variant)), authUserIdFromClient(client)); if (why) { client.send('sitError', { reason: why }); return; } } // 19.11 bakım
    if (this.entryStarting || (this.population && !authUserIdFromClient(client))) {
      client.send('sitError', { reason: 'Masa su anda katilima uygun degil.' }); return;
    }
    if (this.seats.has(client.sessionId)) return;
    if (this.game != null) { client.send('sitError', { reason: 'oyun başladı' }); return; }
    { const ban = this.kickBanReason(authUserIdFromClient(client)); if (ban) { client.send('sitError', { reason: ban }); return; } }
    const uid = authUserIdFromClient(client);
    const existing = findExistingUserSeat(this.seats, this.seatUsers, uid);
    if (existing) {
      client.send('sitError', { reason: 'Bu hesap zaten masada; devam eden oyuna geri dön.' });
      this.pushViews();
      return;
    }
    const taken = this.occupiedSeats();
    const free = this.humanSeats.filter((s) => !taken.has(s));
    if (free.length === 0) { client.send('sitError', { reason: 'boş koltuk yok' }); return; }
    const decision = selectSitSeat(this.humanSeats, taken, rawSeat);
    if (decision.seat == null) {
      client.send('sitError', { reason: decision.error === 'seat_unavailable' ? 'Secilen koltuk dolu.' : 'Koltuk sec.' }); return;
    }
    const seat = decision.seat;

    this.spectators.delete(client.sessionId);
    this.spectatorNames.delete(client.sessionId);
    this.spectatorMeta.delete(client.sessionId);
    this.seats.set(client.sessionId, seat);
    this.readyGate.noteSeated(seat);
    if (uid) this.seatUsers.set(seat, uid);
    else console.warn('[join] koltuk UIDSIZ — token dogrulanamadi; bahis/elmas/hediye kaliciligi bu koltukta devre disi. seat=', seat);
    const meta = await resolveClientProfileMeta(uid, options, `Oyuncu ${seat + 1}`);
    this.seatNames.set(seat, meta.name);
    this.seatMeta.set(seat, { gender: meta.gender, role: meta.role, adminBadgeHidden: meta.adminBadgeHidden, nameStyle: meta.nameStyle ?? '' });
    client.send('seat', { seat });
    this.startGameIfReady();
    this.pushViews();
  }

  private startGameIfReady() {
    if (!this.populationAccepting || this.disposed || this.entryStarting || !this.populationCanPlay() || this.game || this.startTimer
      || this.seats.size + this.adminBots.size + (this.population?.size ?? 0) < this.humanSeats.length) return;
    if (!this.readyGateOpen()) { this.pushViews(); return; }
    this.startDelay = this.readyGateActive() ? READY_START_MS : this.START_MS;
    this.startAt = Date.now();
    this.pushViews();
    if (this.startTick) clearInterval(this.startTick);
    this.startTick = setInterval(() => { if (!this.game) this.pushViews(); }, 1000);
    this.startTimer = setTimeout(async () => {
      if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
      this.startTimer = null;
      if (!this.populationAccepting || this.disposed || this.entryStarting || !this.populationCanPlay() || this.game
        || this.seats.size + this.adminBots.size + (this.population?.size ?? 0) < this.humanSeats.length) { this.pushViews(); return; }
      this.entryStarting = true;
      this.readyGate.reset(); // oyun kuruluyor: hazır fazı biter
      try {
      const entryUsers = new Map(this.seatUsers);
      const rewardsEligible = allHumanStartingRoster(4, entryUsers, [...this.adminBots.keys(), ...(this.population?.seats() ?? [])]);
      const entryHouse = entryHouseAmount({
        bet: this.bet,
        totalSeats: 4,
        teamMode: !!this.cfg?.rules?.teamMode,
        gameVariant: this.cfg?.rules?.variant,
        realSeats: entryUsers.size,
      });
      const oneHandEntry = shouldDeferEntryHouse(this.cfg?.rules?.totalEls);
      const entry = this.population?.size ? await this.beginPopulationEntry(entryUsers)
        : await deductEntry(entryUsers, this.bet, oneHandEntry || !rewardsEligible ? undefined : 'okey', entryHouse);
      if (!entry.ok) { this.abortEntryStart(entry.failedSeats); return; }
      this.matchRewardsEligible = rewardsEligible;
      this.entryCanakCharged = !oneHandEntry;
      if (!oneHandEntry) this.refreshCanak();
      const banko = this.cfg?.rules?.variant === 'banko';
      this.cfg.botSeats = [...this.adminBots.keys(), ...(this.population?.seats() ?? [])];
      this.game = createOkeyGame({ ...this.cfg, dealFirst: !banko });
      this.matchStartedAt = new Date().toISOString(); // 18.11 Kahve Saati: maçın BAŞLADIĞI an belirler
      this.matchProgressionKey = `okey:${this.roomId}:${Date.now()}:${this.cfg?.seed ?? ''}`;
      for (const [seat, name] of this.seatNames) {
        const p = this.game.players[seat];
        if (p && name) p.name = name;
      }
      if (this.preLog.length) { this.game.matchLog.unshift(...this.preLog); this.preLog = []; }
      this.abandonUnattendedSeatsAtStart();
      this.settled = false;
      this.settlePromise = null;
      this.rematchVotes.clear();
      this.canakEl = -1;
      console.log('[OkeyRoom] oyun başladı' + (banko ? ' (banko: ilk el seçim fazı)' : ''));
      if (banko) this.enterBankoPhase();
      else this.afterChange();
      } catch (e: any) {
        console.error('[OkeyRoom] entry failed:', e?.message);
        // 19.11: oyuncunun önceki maçı başka masada sürüyor → onu izleyiciye al (aksi halde HAZIR→geri sayım→bekleme döngüsü)
        { const busy = busyHumanFromEntryError(e?.message);
          if (busy) for (const [sid, st] of [...this.seats.entries()]) if (this.seatUsers.get(st) === busy) this.standToSpectator(sid, st, 'readyTimeout', BUSY_ELSEWHERE_REASON); }
        if (!this.game && this.population?.activeMatch) {
          try { await this.population.finish(null); } catch (refundError: any) { console.error('[population] refund pending:', refundError?.message); }
        }
        if (!this.disposed) this.abortEntryStart([]);
      } finally { this.entryStarting = false; }
    }, this.startDelay);
  }

  private async beginPopulationEntry(humans: Map<number, string>): Promise<{ ok: boolean; failedSeats: number[] }> {
    if (!this.population || this.adminBots.size) throw new Error('population_roster_invalid');
    await this.population.begin(humans, !!this.cfg.rules?.teamMode);
    const unchanged = !this.disposed && humans.size === this.seatUsers.size
      && [...humans].every(([seat, uid]) => this.seatUsers.get(seat) === uid);
    if (!unchanged) { await this.population.finish(null); return { ok: false, failedSeats: [] }; }
    return { ok: true, failedSeats: [] };
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

  private presenceLeases = new SeatPresenceLeases();
  private presenceMode(): string { return 'okey-' + ((this.metadata as any)?.mode ?? 'solo'); }


  /* 19.11 KISA KOPMA TOLERANSI: düşen oyuncunun yerini bot HEMEN almaz. 12 sn içinde dönerse kimse fark etmez
     (masaya "koptu/döndü" yazılmaz, bot hamle yapmaz; sırası gelirse normal süre sayacı işler). 12 sn'yi geçerse
     eskisi gibi bot devralır. Oyun başlamadıysa (bekleme) davranış değişmez. */
  private dropGrace = new Map<number, ReturnType<typeof setTimeout>>();
  private static readonly DROP_GRACE_MS = 12_000;
  private startDropGrace(seat: number, sessionId: string, apply: () => void) {
    this.cancelDropGrace(seat);
    const t = setTimeout(() => {
      this.dropGrace.delete(seat);
      if (this.seats.get(sessionId) !== seat) return; // bu arada koltuk el değiştirdi / çıktı
      apply();
    }, OkeyRoom.DROP_GRACE_MS);
    (t as any).unref?.();
    this.dropGrace.set(seat, t);
  }
  /** true → bot henüz devralmamıştı (sessiz dönüş). */
  private cancelDropGrace(seat: number): boolean {
    const t = this.dropGrace.get(seat);
    if (!t) return false;
    clearTimeout(t);
    this.dropGrace.delete(seat);
    return true;
  }

  async onDrop(client: Client) {
    const isTakeover = this.takeoverPending.delete(client.sessionId); // takeover dususu KALKAN-1'i atlar
    // KALKAN: wifi->mobil geciste SDK yeni baglantiyla COKTAN donduktan sonra eski
    // socketin gecikmis kapanisi ikinci bir onDrop tetikliyor; allowReconnection aninda
    // patlayip KOLTUGU SILIYORDU (log: onReconnect/onDrop ayni saniye -> EXPIRED -> 4002).
    if (!isTakeover && this.clients.some(c => c !== client && c.sessionId === client.sessionId && hasOpenTransport(c))) {
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
    const dropSid = client.sessionId;
    const takeOver = () => {
      this.abandoned.add(seat);
      this.logEvent(`${this.nameOfSeat(seat)} bağlantısı koptu — bot devraldı (3 dk içinde dönebilir)`);
      this.afterChange();
    };
    if (this.game) this.startDropGrace(seat, dropSid, takeOver); else takeOver();
    const uid = this.seatUsers.get(seat);
    const mode = (this.metadata as any)?.mode ?? 'solo';
    const tableNo = Number((this.metadata as any)?.table) || 1;
    const reservation = this.presenceLeases.reserve(client.sessionId, uid, tableNo, this.presenceMode(), !!this.game);
    try {
      const back = await this.allowReconnection(client, reconnectWindowSec());
      console.log(`[OkeyRoom.onDrop-SUCCESS] seat=${seat} geri döndü`);
      if (!this.presenceLeases.owns(client.sessionId, reservation)) return;
      this.presenceLeases.restore(client.sessionId, uid, tableNo, this.presenceMode(), !!this.game);
      const quietBack = this.cancelDropGrace(seat);
      this.abandoned.delete(seat);
      try { back.send('seat', { seat }); } catch { /* yoksay */ }
      if (!quietBack) this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü`);
      this.afterChange();
    } catch (e: any) {
      console.log(`[OkeyRoom.onDrop-EXPIRED] seat=${seat}: ${e?.message ?? e}`);
      if (!this.presenceLeases.owns(client.sessionId, reservation)) return;
      if (this.cancelDropGrace(seat)) takeOver();
      this.presenceLeases.stop(client.sessionId);
      // KALKAN-2: pencere doldu dese de bu sessionId hala BAGLIYSA (yaris) koltuga dokunma.
      const live = this.clients.find(c => c.sessionId === client.sessionId && hasOpenTransport(c));
      if (live) {
        this.onReconnect(live);
        console.log(`[OkeyRoom.onDrop-EXPIRED] client CANLI -> koltuk korunuyor (stale)`);
        return;
      }
      this.cleanupSeat(client.sessionId, seat); // oyun başladıysa kalıcı bot; beklemede koltuk boşalır
      if (!this.game) this.abandoned.delete(seat);
      this.pushViews();
    }
  }

  onReconnect(client: Client) {
    const wasReserved = this.seats.has(client.sessionId);
    if (wasReserved) {
      const returningSeat = this.seats.get(client.sessionId)!;
      this.presenceLeases.restore(client.sessionId, this.seatUsers.get(returningSeat), Number((this.metadata as any)?.table) || 1, this.presenceMode(), !!this.game);
      const quiet = this.cancelDropGrace(returningSeat);
      if (!quiet) this.logEvent(`${this.nameOfSeat(returningSeat)} masaya geri dondu - kontrol oyuncuya gecti`);
    }
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
    if (_code !== 4000 && this.clients.some(c => c !== client && c.sessionId === client.sessionId && hasOpenTransport(c))) {
      console.log(`[OkeyRoom.onLeave] STALE leave (reconnect taze, code=${_code}) -> yok sayildi sid=${client.sessionId}`);
      return;
    }

    console.log(`[OkeyRoom.onLeave] sessionId=${client.sessionId} code=${_code}`);
    const seat = this.seats.get(client.sessionId);
    if (seat != null) this.cancelDropGrace(seat);
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
    if (this.seats.get(sessionId) !== seat) return;
    this.presenceLeases.stop(sessionId);
    const uid = this.seatUsers.get(seat);
    if (uid) this.presenceLeases.release(sessionId, uid, Number((this.metadata as any)?.table) || 1, this.presenceMode());
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
    this.readyGate.noteLeft(seat);
    if (!this.game) this.readyGate.reset();
    if (this.seats.size === 0) this.readyGate.clearBans(); // masa boşaldı → atma yasakları düşer
    this.cancelShortStartCountdown();
    if (this.game?.matchEnded) {
      this.abandoned.delete(seat);
      void this.maybeStartRematch();
    }
    this.scheduleBotOnlyClose();
  }

  /** Aynı doğrulanmış hesap, koltuğu 180 sn reconnect beklemesindeyken reconnect token'ı OLMADAN
   *  (yeni oturum: join retry'si yarıda kaldı, uygulama verisi silindi, başka cihaz) aynı masaya
   *  dönerse İZLEYİCİYE DÜŞÜRME: eski bekleme iptal edilir, koltuk yeni oturuma devredilir.
   *  Eski oturum hâlâ bağlı görünse bile (ağ değişimi / ölü soket) koltuk yeni oturuma geçer, eski 4001 ile kapanır.
   *  Yalnız İZLE ile gelindiyse izleyici olunur. */
  private reclaimDroppedSeat(client: Client, existing: ExistingUserSeat, options: any): boolean {
    if (options?.spectate === true || options?.spectate === 'true') return false;
    const oldSessionId = existing.sessionId;
    if (oldSessionId === client.sessionId) return false;
    // AĞ DEĞİŞİMİ / UYGULAMA YENİDEN AÇILIŞI: eski bağlantı sunucuda hâlâ açık görünebilir (ölü soket ~15 sn'de
    // sezilir). Aynı doğrulanmış hesap yeni oturumla geldiyse "son giren kazanır": koltuk yeni oturuma geçer,
    // eski bağlantı 4001 ile kapatılır. (Eskiden yeni giriş İZLEYİCİ oluyor, koltuk bota kalıyordu.)
    const live = this.clients.find(c => c.sessionId === oldSessionId);
    const hold = live ? null : pendingReconnection(this, oldSessionId);
    if (!live && !hold) return false;
    const seat = existing.seat;
    // Lease'i önce durdur: eski onDrop'un await'i reddedilince owns()=false görür ve koltuğa dokunmaz.
    this.presenceLeases.stop(oldSessionId);
    this.seats.delete(oldSessionId);
    this.seats.set(client.sessionId, seat);
    this.messageGuard.forget(oldSessionId);
    this.giftBusy.delete(oldSessionId);
    this.lastReconnectAt.delete(oldSessionId);
    this.takeoverPending.delete(oldSessionId);
    this.abandoned.delete(seat);
    if (hold) hold.reject(new Error('seat_reclaimed_by_new_session'));
    if (live) {
      console.log(`[OkeyRoom.onJoin] ayni uid yeni oturumla geldi, eski baglanti canli -> devralma old=${oldSessionId}`);
      try { live.leave(4001, 'Bu hesap baska bir baglantidan masaya girdi.'); } catch { /* yoksay */ }
    }
    this.presenceLeases.restore(client.sessionId, this.seatUsers.get(seat), Number((this.metadata as any)?.table) || 1, this.presenceMode(), !!this.game);
    console.log(`[OkeyRoom.onJoin] ayni uid yeni oturumla dondu -> koltuk ${seat} devredildi old=${oldSessionId} new=${client.sessionId}`);
    this.logEvent(`${this.nameOfSeat(seat)} masaya geri döndü — kontrol oyuncuya geçti`);
    client.send('seat', { seat });
    this.afterChange();
    return true;
  }

  /** Oyun kurulurken koltukta OYNAYABİLECEK bağlı insan yoksa (giriş ücreti alınırken kalktı ya da
   *  bekleme/rövanş sırasında düştü) koltuk HEMEN bota geçer; dönen oyuncuya onReconnect kontrolü verir. */
  private abandonUnattendedSeatsAtStart() {
    if (!this.game) return;
    const connected = new Set(this.clients.map((c) => c.sessionId));
    const bots = [...this.adminBots.keys(), ...(this.population?.seats() ?? [])];
    for (const seat of seatsWithoutLivePlayer(this.humanSeats, this.seats, connected, bots)) {
      this.cancelDropGrace(seat); // 19.11: tolerans sürüyorsa burada hemen bot devralır (çift kayıt yok)
      if (!this.abandoned.has(seat)) this.logEvent(`${this.nameOfSeat(seat)} masada değil — bot devraldı`);
      this.abandoned.add(seat);
    }
  }

  /* ── 6.9 HAZIR SİSTEMİ + MASADAN ATMA (readyGate.ts) ── */
  /** 18.11: maç bittiğinde masada oturan gerçek oyuncular (yarıda çıkan haftalık puan / Kahve Saati almaz). */
  private presentUserIds(): string[] {
    const out: string[] = [];
    for (const seat of this.seats.values()) { const uid = this.seatUsers.get(seat); if (uid) out.push(uid); }
    return out;
  }
  private readyGateActive(): boolean { return this.readyGate.active(this.seats.keys()); }
  private seatedHumanSeats(): number[] { return [...new Set(this.seats.values())]; }
  private tableIsFull(): boolean { return this.seats.size + this.adminBots.size + (this.population?.size ?? 0) >= this.humanSeats.length; }

  /** Geri sayım başlayabilir mi? Eski istemci varsa her zaman evet (otomatik başlangıç). */
  private readyGateOpen(): boolean {
    if (!this.readyGateActive()) { if (this.readyGate.inPhase) this.readyGate.reset(); return true; }
    const allReady = this.readyGate.allReady(this.seatedHumanSeats());
    const botSeats = [...(this.population?.seats() ?? []), ...this.adminBots.keys()];
    if (this.readyGate.enter()) {
      if (!allReady) {
        this.broadcast('tableFull', { timeoutMs: this.readyGate.msLeft() });
        this.logEvent('Masa doldu — oyun için herkes HAZIR demeli');
      }
      // Canlı botlar insan gibi birkaç saniyede HAZIR der (ekranda gri kalmasınlar).
      this.readyGate.scheduleBots(botSeats, () => this.pushViews());
    }
    if (allReady) for (const s of botSeats) this.readyGate.ready.add(s); // insanlar hazırsa botlar beklemez
    return allReady;
  }

  private handlePreReady(client: Client) {
    const seat = this.seats.get(client.sessionId);
    if (seat == null || this.game || this.entryStarting || this.startTimer) return;
    if (!this.readyGateActive() || !this.tableIsFull() || !this.readyGate.inPhase) {
      client.send('sitError', { reason: 'Masa dolmadan HAZIR denemez.' }); return;
    }
    if (this.readyGate.ready.has(seat)) return;
    this.readyGate.ready.add(seat);
    this.startGameIfReady();
    this.pushViews();
  }

  /** 20 sn doldu: HAZIR demeyenler izleyiciye düşer, hazırlar sıfırlanır. */
  private onReadyTimeout() {
    if (this.game || this.entryStarting || this.startTimer || this.disposed) return;
    if (!this.readyGateActive() || !this.tableIsFull()) { this.readyGate.reset(); this.pushViews(); return; }
    const lazy = [...this.seats.entries()].filter(([, s]) => !this.readyGate.ready.has(s));
    for (const [sid, s] of lazy) this.standToSpectator(sid, s, 'readyTimeout', 'Süresinde HAZIR demediğin için masadan kaldırıldın.');
    this.readyGate.reset();
    this.pushViews();
  }

  private standToSpectator(sessionId: string, seat: number, kind: string, reason: string) {
    const client = this.clients.find((c) => c.sessionId === sessionId);
    const name = this.seatNames.get(seat) ?? `Oyuncu ${seat + 1}`;
    const meta = this.seatMeta.get(seat);
    this.logEvent(`${name} masadan kaldırıldı`);
    this.cleanupSeat(sessionId, seat);
    if (!client) return;
    this.spectators.add(sessionId);
    this.spectatorNames.set(sessionId, name);
    if (meta) this.spectatorMeta.set(sessionId, { gender: meta.gender, role: meta.role, adminBadgeHidden: meta.adminBadgeHidden });
    client.send('seat', { seat: -1 });
    client.send(kind, { reason });
  }

  /** Masa sahibi, oyun başlamadan (bekleme/hazır fazı) bir oyuncuyu atar; atılan 10 dk oturamaz. */
  private handleKick(client: Client, raw: any) {
    const seat = this.seats.get(client.sessionId);
    if (seat == null) return;
    if (this.game || this.entryStarting || this.startTimer) { client.send('sitError', { reason: 'Oyun başlarken masadan çıkarılamaz.' }); return; }
    if (!this.readyGateActive()) return;
    if (this.readyGate.ownerSeat(this.seats.values()) !== seat) { client.send('sitError', { reason: 'Yalnız masa sahibi oyuncu çıkarabilir.' }); return; }
    let msg: any = raw;
    if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { msg = {}; } }
    const target = Number(msg?.seat);
    if (!Number.isInteger(target) || target === seat) return;
    const entry = [...this.seats.entries()].find(([, s]) => s === target);
    if (!entry) return;
    const uid = this.seatUsers.get(target);
    if (uid) this.readyGate.ban(uid);
    this.standToSpectator(entry[0], target, 'kicked', 'Masa sahibi seni masadan çıkardı. 1 dakika bu masaya oturamazsın.');
    this.readyGate.reset();
    this.pushViews();
  }

  private kickBanReason(uid: string | null | undefined): string | null {
    const ms = this.readyGate.banLeftMs(uid);
    return ms > 0 ? `Bu masadan çıkarıldın; ${Math.ceil(ms / 1000)} sn sonra tekrar oturabilirsin.` : null;
  }

  /** Geri sayım sürerken koltuk boşalırsa sayacı iptal et: sonra oturan oyuncu tam geri sayımla başlasın. */
  private cancelShortStartCountdown() {
    if (this.game || this.entryStarting || !this.startTimer) return;
    if (this.seats.size + this.adminBots.size + (this.population?.size ?? 0) >= this.humanSeats.length) return;
    clearTimeout(this.startTimer); this.startTimer = null;
    if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
    this.startAt = 0;
  }

  /** Gerçek oyuncu kalmadığında botların kendi kendine oynadığı zombi masayı lobby'den kaldır. */
  private scheduleBotOnlyClose() {
    if (this.population?.size && !this.population.isDisposed) return;
    if (this.closingBotOnly || this.seats.size > 0) return;
    this.closingBotOnly = true;
    setTimeout(() => {
      if (this.seats.size > 0) { this.closingBotOnly = false; return; }
      console.log('[OkeyRoom] gerçek oyuncu kalmadı -> oda kapatılıyor');
      void this.disconnect().catch((e: any) => console.warn('[OkeyRoom] bot-only close:', e?.message ?? e));
    }, 0);
  }

  private nameOfSeat(seat: number): string {
    return this.game?.players?.[seat]?.name ?? this.seatNames.get(seat) ?? 'Oyuncu';
  }

  private logEvent(msg: string) {
    if (this.game) this.game.matchLog.push(msg);
    else this.preLog.push(msg);
  }

  /* ── OYUN AKIŞI: her değişimden sonra tek yerden zamanla ── */

  /* ── ÇANAK: el bitiren insan yalniz ozel bitiste ortak politika sansiyla patlatir. ── */
  private canakEl = -1;          // el başına TEK kontrol
  private canakAmount = 0;       // gösterge (bellek kopyası; view'a gider)
  private canakSeq = 0;          // patlama sayacı (view garantisi — broadcast kaçsa da modal açılır)
  private canakWin: { seat: number; name: string; amount: number } | null = null;

  private refreshCanak() { fetchCanak('okey').then((v) => { this.canakAmount = v; this.pushViews(); }).catch(() => {}); }

  private maybeCanak() {
    if (!this.matchRewardsEligible) return;
    if (!this.game || this.canakEl === this.game.elNumber) return;
    this.canakEl = this.game.elNumber;
    // Ücretsiz/antrenman masası (bahis 0) çanağı PATLATAMAZ — sürpriz ekonomi sızıntısı olmaz.
    if (this.bet <= 0) { this.refreshCanak(); return; }
    const w = this.game.elWinner ?? -1;
    const fk = this.game.finishKind;
    const p = okeyCanakChance(fk);
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
    if (!this.populationCanPlay()) { this.pausePopulationTimers(); this.pushViews(); return; }
    if (this.game && (this.game.elEnded || this.game.matchEnded) && !this.isOneHandNoContest()) this.maybeCanak();
    // SIRA ÖNEMLİ: önce zamanlayıcı (turnDeadlineAt) KURULUR, sonra push edilir — aksi halde
    // view ESKİ deadline ile gider: insan sırasında turnMs=0 (sayaç hiç çıkmaz), bot sırasındaki
    // push önceki insanın kalıntı süresini taşır (sayaç yanlış koltukta görünür bug'ı).
    if (!this.game) { this.pushViews(); return; }
    if (this.game.matchEnded) {
      this.settleOnce(); this.clearTurnTimers(); this.turnDeadlineAt = 0; this.turnArmedSeat = -1;
      this.pushViews(); return;
    }
    if (this.game.elEnded) {
      this.clearTurnTimers(); this.turnDeadlineAt = 0; this.turnArmedSeat = -1;
      if ((this.game as any).bankoPhase) { this.pushViews(); return; } // faz sürüyor (kendi timer'ı var)
      if (!this.elTimer) {
        this.elTimer = setTimeout(() => {
          this.elTimer = null;
          if (!this.game || this.game.matchEnded || !this.populationCanPlay()) return;
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
    if (!this.populationCanPlay()) return;
    if (!this.game || this.game.elEnded || this.game.matchEnded) return;
    this.clearTurnTimers();
    const turn = this.game.turn;
    const p = this.game.players[turn]!;
    const botLike = p.isBot || this.abandoned.has(turn);
    if (botLike) {
      this.turnDeadlineAt = 0;
      this.turnArmedSeat = -1;
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        if (!this.populationCanPlay()) return;
        if (!this.game || this.game.elEnded || this.game.turn !== turn) { this.afterChange(); return; }
        playOkeyBotTurn(this.game, turn);
        this.afterChange();
      }, this.STEP_MS);
    } else {
      // Aynı oyuncunun sırası sürüyorsa (ör. taş çekti, şimdi atacak) sayaç SIFIRLANMAZ: kalan süreyle devam.
      const now = Date.now();
      if (this.turnArmedSeat !== turn || this.turnDeadlineAt <= now) {
        this.turnDeadlineAt = now + Math.max(8000, this.game.rules.turnTimerSeconds * 1000) + this.TURN_GRACE_MS;
        this.turnArmedSeat = turn;
      }
      const ms = Math.max(1, this.turnDeadlineAt - now);
      this.humanTimer = setTimeout(() => {
        this.humanTimer = null;
        if (!this.populationCanPlay()) return;
        if (!this.game || this.game.elEnded || this.game.turn !== turn) { this.afterChange(); return; }
        this.turnArmedSeat = -1;
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
    if (!this.populationCanPlay()) return;
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
    if (!this.game || !this.populationCanPlay()) return;
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
    this.scheduleBankoPhase();
  }

  // Resume scheduling without erasing choices that were already made before a pause.
  private scheduleBankoPhase() {
    if (!this.game?.bankoPhase || !this.populationCanPlay()) return;
    for (const timer of this.bankoBotTimers) clearTimeout(timer);
    this.bankoBotTimers = [];
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
        if (!this.game || !this.game.bankoPhase || !this.populationCanPlay()) return;
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
    if (!this.populationCanPlay()) { this.pausePopulationTimers(); return; }
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
    const winnerSeat = this.lowestScoreSeat();
    if (this.population?.hasMatch) {
      this.rematchVotes.clear();
      this.settlePromise = this.population.finish(this.isOneHandNoContest(winnerSeat) ? null : winnerSeat)
        .then(() => {
          this.pushViews();
          // 6.9: canlı botlu masada da gerçek oyuncu haftalık puan + Kahve Saati alır (botlar hariç)
          const pHands = Number(this.game?.rules?.totalEls) || 1;
          void populationMatchExtras(this.population?.lastMatch ?? null, pHands, undefined, this.presentUserIds(), this.matchStartedAt || undefined)
            .then((extras) => { if (extras.length) this.broadcast('matchExtras', { extras }); })
            .catch((e: any) => console.warn('[population] extras:', e?.message));
        })
        .catch((e: any) => { this.settled = false; console.error('[population] settlement pending:', e?.message); });
      return;
    }
    if (this.isOneHandNoContest(winnerSeat)) {
      this.rematchVotes.clear();
      const key = `okey:no-contest:${this.matchProgressionKey || this.roomId}`;
      this.logEvent('1 ellik maç sonuçsuz bitti — giriş ücretleri iade edildi');
      this.settlePromise = refundEntryOnce(this.seatUsers, this.bet, key, 'one_hand_no_contest')
        .then(() => this.refreshCanak())
        .catch((e) => console.error('[OkeyRoom.noContest] hata:', e?.message));
      return;
    }
    const openedSeats = new Set<number>();
    if (this.game.rules.variant === 'yuzbir')
      for (let s = 0; s < 4; s++) if (this.game.players[s]!.hasOpened) openedSeats.add(s);
    this.rematchVotes.clear();
    this.settlePromise = settleMatch({
      seatUsers: this.seatUsers,
      winnerSeat,
      bet: this.bet,
      teamMode: this.game.rules.teamMode,
      scores,
      totalSeats: 4,
      gameVariant: this.game.rules.variant,
      openedSeats,
      game: 'okey', // çanak hedefi (düz + banko ortak çanak)
      entryHousePaid: this.entryCanakCharged,
      matchRewardsEligible: this.matchRewardsEligible,
      progressionKey: this.matchProgressionKey,
      presentUserIds: this.presentUserIds(),
      startedAt: this.matchStartedAt || undefined,
      hands: this.game.rules.totalEls,
      onExtras: (extras) => this.broadcast('matchExtras', { extras }),
    }).then((awards) => { this.broadcastProgression(awards); return this.refreshCanak(); }) // maç sonu sonrası masa içi çanak göstergesi tazelensin
      .catch((e) => console.error('[OkeyRoom.settle] hata:', e?.message));
  }

  private lowestScoreSeat(): number {
    if (!this.game) return 0;
    let winnerSeat = 0;
    for (let s = 1; s < 4; s++) if (this.game.scores[s]! < this.game.scores[winnerSeat]!) winnerSeat = s;
    return winnerSeat;
  }

  private isOneHandNoContest(fallbackWinnerSeat?: number): boolean {
    if (!this.game) return false;
    const handWinnerSeat = this.game.rules.variant === 'yuzbir'
      && fallbackWinnerSeat != null
      && !hasLowestScoreTie(this.game.scores)
        ? fallbackWinnerSeat
        : this.game.elWinner;
    return isOneRoundNoContest({
      totalRounds: this.game.rules.totalEls,
      handWinnerSeat,
      scores: this.game.scores,
    });
  }

  private broadcastProgression(awards: MatchProgressionAward[] | void) {
    if (!Array.isArray(awards) || awards.length === 0) return;
    for (const a of awards) {
      if (!a || !a.userId || a.xp <= 0) continue;
      this.broadcast('progression', {
        seat: a.seat,
        user_id: a.userId,
        xp: a.xp,
        won: a.won,
        level_before: a.levelBefore,
        level_after: a.levelAfter,
      });
    }
  }

  private async handleReady(seat: number) {
    if (!this.game?.matchEnded || this.rematchStarting) return;
    if (!this.settled) this.settleOnce();
    this.rematchVotes.add(seat);
    this.pushViews();
    await this.maybeStartRematch();
  }

  private async maybeStartRematch() {
    if (!this.game?.matchEnded || this.rematchStarting) return;
    const occupied = new Set(this.seats.values());
    const required = this.humanSeats.filter((seat) => occupied.has(seat));
    if (required.length === 0 || !required.every((seat) => this.rematchVotes.has(seat))) return;

    this.rematchStarting = true;
    try {
      if (this.settlePromise) await this.settlePromise;
      await this.newMatch();
    } catch (e: any) {
      console.error('[OkeyRoom] hazır/yeni maç hata:', e?.message);
      this.pushViews();
    } finally {
      this.rematchStarting = false;
    }
  }

  private prepareRematchCountdown() {
    this.readyGate.seed(this.rematchVotes); // 6.9: maç sonu HAZIR oyu yeni maçın hazırıdır
    this.population?.resetMatch();
    this.rematchVotes.clear();
    this.clearTurnTimers();
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
    this.startAt = 0;
    this.preLog = ['Tüm hazır oyuncular onay verdi — yeni maç hazırlanıyor'];
    this.game = null;
    this.settled = false;
    this.settlePromise = null;
    this.entryCanakCharged = false;
    this.matchRewardsEligible = false;
    this.canakEl = -1;
    this.abandoned.clear();
    this.cfg.seed = Math.floor(Math.random() * 1_000_000_000);
    this.startGameIfReady();
    if (!this.startTimer && !this.game) this.pushViews();
  }

  private async newMatch() {
    this.prepareRematchCountdown();
  }

  /* ── GÖRÜNÜM ── */

  private pushViews() {
    const waiting = !this.game;
    // 18.11: 'starting' yalnız geri sayım GERÇEKTEN sürerken (Hazır fazında masa dolu ama sayaç yok → istemci HAZIR panelini çizer)
    const starting = waiting && this.seats.size + this.adminBots.size + (this.population?.size ?? 0) >= this.humanSeats.length && !!this.startTimer;
    const filled = new Set(this.seats.values());
    const seated = [0, 1, 2, 3].map((s) => ({
      seat: s,
      human: this.humanSeats.includes(s),
      filled: this.humanSeats.includes(s) ? (filled.has(s) || this.adminBots.has(s) || (this.population?.has(s) ?? false)) : true,
      name: this.humanSeats.includes(s) ? (this.seatNames.get(s) ?? null) : 'Bot',
      bot: this.adminBots.has(s) || undefined,
    }));
    for (const row of seated) this.population?.decorate(row);
    const specClients = this.clients.filter((c) => this.seats.get(c.sessionId) == null);
    const specList = specClients.map((c) => this.spectatorNames.get(c.sessionId) ?? 'İzleyici');
    const specRoles = specClients.map((c) => {
      const m = this.spectatorMeta.get(c.sessionId);
      return displayProfileRole(m?.role ?? 'normal', m?.adminBadgeHidden === true);
    });
    const specGenders = specClients.map((c) => this.spectatorMeta.get(c.sessionId)?.gender ?? '');
    const decorate = (v: any) => {
      if (Array.isArray(v.players))
        for (const s of v.players) {
          const m = this.seatMeta.get(s.seat);
          if (m) { s.role = m.role; s.gender = m.gender; s.admin_badge_hidden = m.adminBadgeHidden === true; s.name_style = m.nameStyle ?? ''; }
          s.uid = this.seatUsers.get(s.seat) ?? ''; // profil tıklaması (public kimlik)
          s.abandoned = this.abandoned.has(s.seat);
          if (s.abandoned) s.isBot = true;
          this.population?.decorate(s);
        }
      v.spectators = specList;
      v.spectatorRoles = specRoles;
      v.spectatorGenders = specGenders;
      v.waitingForPlayers = waiting;
      v.bet = this.bet; // masanın GERÇEK bahsi (izleyici/katılan kendi kayıtlı ayarını değil bunu görsün)
      if (waiting && this.cfg?.rules) {
        // Boş görünüm Tekli/0 el varsayılanı taşır → masanın gerçek ayarlarını yaz.
        const r: any = this.cfg.rules;
        v.teamMode = !!r.teamMode; v.totalEls = r.totalEls; v.variant = r.variant ?? v.variant;
        v.turnTimerSeconds = r.turnTimerSeconds ?? v.turnTimerSeconds;
        if (r.scoring?.startScore != null) v.startScore = r.scoring.startScore;
      }
      v.starting = starting;
      v.seated = seated;
      v.startMs = starting ? Math.max(0, this.startDelay - (Date.now() - this.startAt)) : 0;
      v.turnMs = this.turnDeadlineAt > 0 ? Math.max(0, this.turnDeadlineAt - Date.now() - this.TURN_GRACE_MS) : 0; // görünen sayaç: tolerans hariç
      v.bankoMs = this.bankoDeadlineAt > 0 ? Math.max(0, this.bankoDeadlineAt - Date.now()) : 0;
      v.canak = this.canakAmount; // 🏺 çanak göstergesi (bellek kopyası)
      v.canakSeq = this.canakSeq;
      v.canakWinSeat = this.canakWin?.seat ?? -1;
      v.canakWinName = this.canakWin?.name ?? '';
      v.canakWinAmount = this.canakWin?.amount ?? 0;
      v.preLog = waiting ? this.preLog.slice(-30) : [];
      v.rematchVotes = [...this.rematchVotes];
      v.readyGate = this.readyGateActive();
      v.readySeats = [...this.readyGate.ready];
      v.readyMs = this.readyGate.msLeft();
      v.ownerSeat = this.readyGate.ownerSeat(this.seats.values());
      v.startTotalMs = this.startDelay;
    };
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      const v: any = okeyViewFor(this.game, seat == null ? -1 : seat);
      decorate(v);
      sendView(c, JSON.stringify(v), this.zvSessions.has(c.sessionId));
    });
  }

  onDispose() {
    this.readyGate.dispose();
    this.disposed = true;
    if (this.populationHeartbeat) { clearInterval(this.populationHeartbeat); this.populationHeartbeat = null; }
    this.pausePopulationTimers();
    this.presenceLeases.dispose();
    this.messageGuard.clear();
    this.giftBusy.clear();
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.startTick) { clearInterval(this.startTick); this.startTick = null; }
    if (this.elTimer) clearTimeout(this.elTimer);
    if (this.bankoTimer) clearTimeout(this.bankoTimer);
    if (this.bankoTick) clearInterval(this.bankoTick);
    this.clearTurnTimers();
    console.log('[OkeyRoom] dispose');
    return this.population?.dispose();
  }
}
