// Colyseus ↔ Supabase köprüsü: kimlik doğrulama (auth token → userId) + çip ekonomisi (RPC).
// Edge fonksiyonundaki db.ts + settleMatch mantığının REST karşılığı (Node fetch, ek bağımlılık yok).
//
// Gerekli ortam değişkenleri (Render → Environment):
//   SUPABASE_URL                  https://<proj>.supabase.co
//   SUPABASE_ANON_KEY             (auth token doğrulama için)
//   SUPABASE_SERVICE_ROLE_KEY     (çip RPC + rooms yazma için; GİZLİ)

const URL = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const supabaseConfigured = (): boolean => !!(URL && SERVICE);
export const authVerificationConfigured = (): boolean => !!(URL && ANON);

export function onlineAuthRequired(): boolean {
  const flag = String(process.env.AUTH_REQUIRED ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return false;
  if (['1', 'true', 'on', 'yes'].includes(flag)) return true;
  return authVerificationConfigured();
}

/** Auth token → userId (null = geçersiz/anon). Supabase GoTrue /auth/v1/user. */
export async function verifyToken(token: string | null | undefined): Promise<string | null> {
  if (!token || !URL || !ANON) return null;
  try {
    const r = await fetch(`${URL}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u: any = await r.json();
    return typeof u?.id === 'string' ? u.id : null;
  } catch (e: any) {
    console.error('[supabase] verifyToken:', e?.message);
    return null;
  }
}

/** Production'da kimliksiz oda girişi ekonomi bypass'ına dönüşmesin. */
export async function requireVerifiedUser(token: string | null | undefined): Promise<string | null> {
  const uid = await verifyToken(token);
  if (!uid && onlineAuthRequired()) throw new Error('auth_required');
  return uid;
}

/** Client'tan gelen bahis değerini izinli masa bahislerine kilitle. */
export function normalizeRoomBet(raw: unknown, allowed: readonly number[], label: string): number {
  const hasRaw = raw != null && String(raw).trim() !== '';
  const strict = onlineAuthRequired();
  if (!hasRaw) {
    if (strict) throw new Error(`${label}_bet_required`);
    return 0;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) {
    if (strict) throw new Error(`${label}_bet_invalid`);
    return 0;
  }
  if (!allowed.includes(n)) {
    if (strict) throw new Error(`${label}_bet_not_allowed`);
    return n;
  }
  return n;
}

/** Client'tan gelen masa kuralı seçimini izinli listeye kilitle. */
export function normalizeRoomOption(raw: unknown, allowed: readonly number[], fallback: number, label: string): number {
  const n = Math.floor(Number(raw));
  if (Number.isFinite(n) && allowed.includes(n)) return n;
  if (onlineAuthRequired()) throw new Error(`${label}_option_not_allowed`);
  return fallback;
}

export function safeClientRole(raw: unknown): string {
  const v = String(raw ?? 'normal').trim().toLowerCase();
  return v === 'vip' ? 'vip' : 'normal';
}

export function safeClientGender(raw: unknown): string {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'k' || v === 'e' ? v : '';
}

export function safeClientName(raw: unknown, fallback: string): string {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
  return n || fallback;
}

export type ClientProfileMeta = { name: string; gender: string; role: string; adminBadgeHidden: boolean };

export function authUserIdFromClient(client: any): string | null {
  const auth = client?.auth;
  if (typeof auth === 'string' && auth) return auth;
  if (auth && typeof auth.uid === 'string' && auth.uid) return auth.uid;
  return null;
}

function vipActive(raw: unknown): boolean {
  if (!raw) return false;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) && t > Date.now();
}

function trustedProfileRole(row: any): string {
  const role = String(row?.role ?? 'normal').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'moderator') return 'moderator';
  if (role === 'vip' || vipActive(row?.vip_until)) return 'vip';
  return 'normal';
}

export function displayProfileRole(role: string, adminBadgeHidden: boolean): string {
  return role === 'admin' && adminBadgeHidden ? 'admin_hidden' : role;
}

export async function resolveClientProfileMeta(
  userId: string | null | undefined,
  options: any,
  fallbackName: string,
): Promise<ClientProfileMeta> {
  const fallback: ClientProfileMeta = {
    name: safeClientName(options?.playerName, fallbackName),
    gender: safeClientGender(options?.gender),
    role: userId && supabaseConfigured() ? 'normal' : safeClientRole(options?.role),
    adminBadgeHidden: false,
  };
  if (!userId || !supabaseConfigured()) return fallback;
  try {
    const r = await fetch(
      `${URL}/rest/v1/profiles?id=eq.${userId}&select=name,gender,role,vip_until,admin_badge_hidden`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    if (!r.ok) return fallback;
    const rows: any = await r.json();
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!row) return fallback;
    const role = trustedProfileRole(row);
    return {
      name: safeClientName(row?.name, fallback.name),
      gender: safeClientGender(row?.gender),
      role,
      adminBadgeHidden: role === 'admin' && row?.admin_badge_hidden === true,
    };
  } catch (e: any) {
    console.error('[supabase] resolveClientProfileMeta:', e?.message);
    return fallback;
  }
}

/** Kullanıcı banlı mı? profiles.banned okur (service-role). Hata/yoksa false (girişi engelleme). */
export async function isBanned(userId: string | null | undefined): Promise<boolean> {
  if (!userId || !supabaseConfigured()) return false;
  try {
    const r = await fetch(
      `${URL}/rest/v1/profiles?id=eq.${userId}&select=banned`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    if (!r.ok) return false;
    const rows: any = await r.json();
    return Array.isArray(rows) && rows.length > 0 && rows[0]?.banned === true;
  } catch (e: any) {
    console.error('[supabase] isBanned:', e?.message);
    return false;
  }
}

/**
 * Oyundan-ban (game-ban) aktif mi? profiles.game_banned_until > now() ise true.
 * Süreli/türlü ban sisteminin OYUN tarafı kontrolü (chat-ban oyuna girişi engellemez).
 * Geriye-dönük: eski profiles.banned=true de hâlâ engeller.
 */
export async function isGameBanned(userId: string | null | undefined): Promise<boolean> {
  if (!userId || !supabaseConfigured()) return false;
  try {
    const r = await fetch(
      `${URL}/rest/v1/profiles?id=eq.${userId}&select=banned,game_banned_until`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    if (!r.ok) return false;
    const rows: any = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const row = rows[0];
    const until = row?.game_banned_until;
    if (!until) return row?.banned === true; // typed süre yoksa geriye-dönük basit bayrak
    const t = Date.parse(until);
    return Number.isFinite(t) && t > Date.now();
  } catch (e: any) {
    console.error('[supabase] isGameBanned:', e?.message);
    return false;
  }
}

/** Konuşma-ban (chat-ban) aktif mi? profiles.chat_banned_until > now() ise true. */
export async function isChatBanned(userId: string | null | undefined): Promise<boolean> {
  if (!userId || !supabaseConfigured()) return false;
  try {
    const r = await fetch(
      `${URL}/rest/v1/profiles?id=eq.${userId}&select=chat_banned_until`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    if (!r.ok) throw new Error(`chat_ban_http_${r.status}`);
    const rows: any = await r.json();
    const until = Array.isArray(rows) && rows.length > 0 ? rows[0]?.chat_banned_until : null;
    if (!until) return false;
    const t = Date.parse(until);
    return Number.isFinite(t) && t > Date.now();
  } catch (e: any) {
    console.error('[supabase] isChatBanned:', e?.message);
    throw e;
  }
}

export type ChatFilterWord = { term: string; match_mode?: 'word' | 'contains'; active?: boolean };

let chatFilterCache: { expires: number; words: ChatFilterWord[] } = { expires: 0, words: [] };

const CHAT_FILTER_TTL_MS = 60_000;
const CHAT_WORD_CHARS = '0-9A-Za-zÇĞİÖŞÜçğıöşü_';

export function normalizeChatFilterText(value: unknown): string {
  return String(value ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLocaleLowerCase('tr-TR')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyChatWordFilter(text: string, words: ChatFilterWord[]): string {
  let out = String(text ?? '');
  if (!out || !Array.isArray(words) || words.length === 0) return out;

  for (const word of words) {
    if (word?.active === false) continue;
    const term = normalizeChatFilterText(word?.term);
    if (term.length < 2) continue;
    const escaped = escapeRegExp(term);
    const mode = word?.match_mode === 'contains' ? 'contains' : 'word';
    const pattern = mode === 'contains'
      ? new RegExp(escaped, 'giu')
      : new RegExp(`(^|[^${CHAT_WORD_CHARS}])(${escaped})(?=$|[^${CHAT_WORD_CHARS}])`, 'giu');
    out = out.replace(pattern, mode === 'contains' ? '***' : '$1***');
  }

  return out;
}

async function fetchChatFilterWords(): Promise<ChatFilterWord[]> {
  if (!supabaseConfigured()) return [];
  const now = Date.now();
  if (chatFilterCache.expires > now) return chatFilterCache.words;
  try {
    const r = await fetch(
      `${URL}/rest/v1/chat_banned_words?active=eq.true&select=term,match_mode,active&order=term.asc`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    if (!r.ok) throw new Error(`chat_filter_http_${r.status}`);
    const rows = (await r.json()) as ChatFilterWord[];
    chatFilterCache = {
      expires: now + CHAT_FILTER_TTL_MS,
      words: Array.isArray(rows) ? rows : [],
    };
  } catch (e: any) {
    console.error('[supabase] chat filter fetch:', e?.message);
    chatFilterCache.expires = now + 10_000;
  }
  return chatFilterCache.words;
}

export async function filterChatText(text: string): Promise<string> {
  const words = await fetchChatFilterWords();
  return applyChatWordFilter(text, words);
}

/**
 * DÜŞEN/REZERVE koltuğun salon görünürlüğü (P2): oyuncu kopunca client heartbeat'i durur →
 * 60s sonra presence satırı salon listesinden düşer → koltuk "boş/OTUR" görünür. Server, koltuk
 * REZERVE (abandoned, 180s) olduğu sürece bu kullanıcının presence satırını TAZE tutar: yalnız
 * last_seen + status + table_no PATCH'lenir (isim/avatar/rol/cinsiyet KORUNUR — full upsert değil).
 * Böylece salon koltuğu DOLU gösterir; kimse oturamaz (server zaten koltuğu rezervde tutar).
 */
export async function keepSeatPresence(
  userId: string | null | undefined,
  tableNo: number,
  mode: string,
): Promise<void> {
  if (!userId || !supabaseConfigured()) return;
  try {
    const body = JSON.stringify({
      status: 'masada',
      table_no: tableNo,
      table_mode: mode.startsWith('okey-') || mode.startsWith('tavla-')
        ? mode
        : mode === 'duo' ? 'duo' : 'solo',
      table_started: true,   // REZERVE = oyun DEVAM → salon koltuğu BOT (düşen oyuncunun kendisi dahil
                             //   kimse OTUR görüp oturamaz; sadece İZLE).
      last_seen: new Date().toISOString(),
    });
    await fetch(`${URL}/rest/v1/presence?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body,
    });
  } catch (e: any) {
    console.error('[supabase] keepSeatPresence:', e?.message);
  }
}

/** Bir Postgres RPC'yi service-role ile çağır (add_chips / deduct_chips). */
export async function rpc(fn: string, args: Record<string, unknown>): Promise<boolean> {
  if (!supabaseConfigured()) { console.warn(`[supabase] RPC ${fn} atlandı (env yok)`); return false; }
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) { console.error(`[supabase] RPC ${fn} hata ${r.status}:`, await r.text()); return false; }
    const body = (await r.text()).trim().toLowerCase();
    if (body === 'false') {
      console.error(`[supabase] RPC ${fn} false döndü`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[supabase] RPC ${fn}:`, e?.message);
    return false;
  }
}

/** Service-role RPC with parsed JSON response; used by verified monetization callbacks. */
export async function rpcService(fn: string, args: Record<string, unknown>): Promise<any> {
  if (!supabaseConfigured()) throw new Error('supabase_not_configured');
  const response = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${fn}_http_${response.status}:${text.slice(0, 240)}`);
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

/** PEŞİN BAHİS GİRİŞİ: maç fiilen BAŞLARKEN her gerçek oturandan bahsi kes (odalar çağırır).
 *  Kaçan/düşen zaten ödemiş olur; settle yalnız ödeme yapar. */
export type EntryDeductResult = { ok: true; failedSeats: [] } | { ok: false; failedSeats: number[] };

export function entryHouseAmount(opts: {
  bet: number;
  totalSeats?: number;
  teamMode?: boolean;
  gameVariant?: string;
  realSeats?: number;
}): number {
  const bet = Math.max(0, Math.floor(opts.bet));
  if (bet <= 0) return 0;
  const totalSeats = Math.max(1, opts.totalSeats ?? 4);
  // Pot = totalSeats × bet; komisyon her zaman potun %10'u.
  return Math.floor(totalSeats * bet * 0.1);
}

export function entryCanakShare(houseAmount: number): number {
  return Math.floor(Math.max(0, Math.floor(houseAmount)) * 0.5);
}

export async function deductEntry(
  seatUsers: Map<number, string>,
  bet: number,
  canakGame?: string,
  houseAmount = 0,
): Promise<EntryDeductResult> {
  if (!supabaseConfigured() || bet <= 0) return { ok: true, failedSeats: [] };
  const charged: Array<[number, string]> = [];
  const failedSeats: number[] = [];
  for (const [seat, uid] of seatUsers) {
    const ok = await rpc('deduct_chips', { p_user_id: uid, p_amount: bet });
    if (!ok) {
      failedSeats.push(seat);
      break;
    }
    charged.push([seat, uid]);
  }
  if (failedSeats.length > 0) {
    for (const [, uid] of charged) {
      const refunded = await rpc('add_chips', { p_user_id: uid, p_amount: bet });
      if (!refunded) console.error(`[entry] iade başarısız uid=${uid} amount=${bet}`);
    }
    console.error(`[entry] bahis kesilemedi; maç başlatılmadı. failedSeats=${failedSeats.join(',')}`);
    return { ok: false, failedSeats };
  }
  const canakAmount = canakGame ? entryCanakShare(houseAmount) : 0;
  if (canakGame && canakAmount > 0) {
    const total = await canakAdd(canakGame, canakAmount);
    if (total == null) {
      for (const [, uid] of charged) {
        const refunded = await rpc('add_chips', { p_user_id: uid, p_amount: bet });
        if (!refunded) console.error(`[entry] çanak hatası sonrası iade başarısız uid=${uid} amount=${bet}`);
      }
      console.error(`[entry] çanak payı eklenemedi; maç başlatılmadı. game=${canakGame} amount=${canakAmount}`);
      return { ok: false, failedSeats: [...seatUsers.keys()] };
    }
    console.log(`[entry] canak payı eklendi game=${canakGame} amount=${canakAmount} total=${total}`);
  }
  console.log(`[entry] PESIN bahis kesildi: ${seatUsers.size} oyuncu × ${bet}`);
  return { ok: true, failedSeats: [] };
}

export async function refundEntry(seatUsers: Map<number, string>, bet: number, reason = 'entry_abort'): Promise<void> {
  if (!supabaseConfigured() || bet <= 0) return;
  for (const [, uid] of seatUsers) {
    const ok = await rpc('add_chips', { p_user_id: uid, p_amount: bet });
    if (!ok) console.error(`[entry] iade başarısız uid=${uid} amount=${bet} reason=${reason}`);
  }
  if (seatUsers.size > 0) console.log(`[entry] bahis iade edildi: ${seatUsers.size} oyuncu × ${bet} reason=${reason}`);
}

export async function refundEntryOnce(
  seatUsers: Map<number, string>,
  bet: number,
  refundKey: string,
  reason = 'one_hand_no_contest',
): Promise<void> {
  if (!supabaseConfigured() || bet <= 0 || seatUsers.size === 0) return;
  const key = String(refundKey ?? '').trim();
  if (!key) throw new Error('refund_key_required');
  const userIds = [...seatUsers.values()].filter((uid) => typeof uid === 'string' && uid.trim().length > 0);
  if (userIds.length === 0) return;
  const result = await rpcService('refund_match_entry_once', {
    p_refund_key: key,
    p_reason: reason,
    p_user_ids: userIds,
    p_amount: Math.floor(bet),
  });
  if (result?.ok !== true) throw new Error(`refund_match_entry_once_failed:${result?.error ?? 'unknown'}`);
  const marker = result?.already_refunded ? 'zaten işlendi' : `${Number(result?.refunded_count ?? 0)} oyuncu`;
  console.log(`[entry] tek seferlik bahis iadesi: ${marker} × ${bet} reason=${reason} key=${key}`);
}

/* ── ÇANAK (ilerleyen jackpot; BÖLÜM 33) ─────────────────────────────────────
   Oyun başına 1 çanak ('51'/'okey'/'tavla'). Komisyonun %50'si birikir; patlatma
   şansları odalarda. RPC'ler atomik (canak_add/canak_take) ve service-role-only. */

/** Değer döndüren RPC (rpc() bool döner; çanak tutar okur). Hata → null. */
async function rpcValue(fn: string, args: Record<string, unknown>): Promise<number | null> {
  if (!supabaseConfigured()) return null;
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) { console.error(`[supabase] RPC ${fn} hata ${r.status}:`, await r.text()); return null; }
    const v = Number(await r.text());
    return Number.isFinite(v) ? v : null;
  } catch (e: any) { console.error(`[supabase] RPC ${fn}:`, e?.message); return null; }
}

/** Çanağa ekle; yeni toplamı döner (hata → null). */
export async function canakAdd(game: string, amount: number): Promise<number | null> {
  if (amount <= 0) return null;
  return rpcValue('canak_add', { p_game: game, p_amount: Math.floor(amount) });
}

/** Çanağın güncel tutarını oku (gösterge için). */
export async function fetchCanak(game: string): Promise<number> {
  if (!supabaseConfigured()) return 0;
  try {
    const r = await fetch(`${URL}/rest/v1/canak?game=eq.${game}&select=amount&limit=1`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (!r.ok) return 0;
    const arr = (await r.json()) as Array<{ amount: number }>;
    return arr?.[0]?.amount ?? 0;
  } catch { return 0; }
}

/** ÇANAK PATLAT: tutarı atomik sıfırla + bitiren İNSANA çip yaz + GEÇMİŞE kaydet (BÖLÜM 34)
 *  + TOPLULUK sohbetine sistem duyurusu düşür. Patlayan tutarı döner (0 = boş/başarısız). */
export async function canakBurst(game: string, uid: string, name = ''): Promise<number> {
  if (!uid) return 0;
  // 24 SAAT KURALI (kullanıcı): aynı kişi 24 saat içinde İKİNCİ kez patlatamaz.
  try {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = await fetch(`${URL}/rest/v1/canak_events?user_id=eq.${uid}&created_at=gt.${cutoff}&select=id&limit=1`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (r.ok) {
      const arr = (await r.json()) as unknown[];
      if (Array.isArray(arr) && arr.length > 0) {
        console.log(`[canak] 24h kurali: uid=${uid} bugun zaten patlatti — atlandi`);
        return 0;
      }
    }
  } catch { /* kontrol başarısızsa patlatmayı engelleme */ }
  const amt = await rpcValue('canak_take', { p_game: game });
  if (!amt || amt <= 0) return 0;
  const paid = await rpc('add_chips', { p_user_id: uid, p_amount: amt });
  if (!paid) {
    const restored = await canakAdd(game, amt);
    console.error(`[canak] ödeme başarısız; çanak geri eklendi game=${game} uid=${uid} tutar=${amt} restored=${restored ?? 'null'}`);
    return 0;
  }
  console.log(`[canak] PATLADI game=${game} uid=${uid} tutar=${amt}`);
  const gameLbl = game === '51' ? '51' : game.toUpperCase();
  const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  // Geçmiş kaydı (canak_events) — ekrandaki GEÇMİŞ sekmesi + "son patlatma" bilgisi.
  fetch(`${URL}/rest/v1/canak_events`, {
    method: 'POST', headers: svc,
    body: JSON.stringify({ game, user_id: uid, name, amount: amt }),
  }).catch((e) => console.error('[canak] event kaydı:', e?.message));
  // Topluluk (lobby_chat) sistem duyurusu — herkes görsün (FOMO motoru).
  fetch(`${URL}/rest/v1/lobby_chat`, {
    method: 'POST', headers: svc,
    body: JSON.stringify({
      user_id: uid, name: '🏺 ÇANAK', role: 'normal',
      text: `${name || 'Bir oyuncu'}, ${gameLbl} çanağını patlattı: +${amt} çip! 🎉`,
    }),
  }).catch((e) => console.error('[canak] lobi duyurusu:', e?.message));
  return amt;
}

/** Oyun-içi hediye kaydı (service-role INSERT) — alıcının yanında SÜRELİ görünür (her masaya taşınır). */
export async function insertGift(
  fromUser: string,
  toUser: string,
  giftType: number,
  scope: string,
  expiresAtISO: string,
): Promise<void> {
  if (!supabaseConfigured()) return;
  try {
    const r = await fetch(`${URL}/rest/v1/gifts`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        from_user: fromUser,
        to_user: toUser,
        gift_type: giftType,
        scope,
        expires_at: expiresAtISO,
      }),
    });
    // ⚠ r.ok kontrolü ŞART: eski kod HTTP hatasını yutuyordu → "ısmarladım ama
    // başka oyunda yok" sınıfı sorunlar hiç iz bırakmadan kayboluyordu.
    if (!r.ok) console.error('[supabase] insertGift HTTP', r.status, await r.text());
    else console.log(`[gift] kalıcı kayıt: ${fromUser.slice(0, 8)}→${toUser.slice(0, 8)} tip=${giftType}`);
  } catch (e: any) {
    console.error('[supabase] insertGift:', e?.message);
  }
}

/** Hediye için elmas düş (SECURITY DEFINER RPC deduct_diamonds). Yetersizse false → hediye iptal. */
export async function deductDiamonds(userId: string, amount: number): Promise<boolean> {
  if (!supabaseConfigured() || !userId || amount <= 0) return false;
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/deduct_diamonds`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId, p_amount: amount }),
    });
    if (!r.ok) { console.error('[supabase] deductDiamonds RPC', r.status, await r.text()); return false; }
    return (await r.text()).trim() === 'true';
  } catch (e: any) {
    console.error('[supabase] deductDiamonds:', e?.message);
    return false;
  }
}

/**
 * Maç sonu çip dağıtımı. seatUsers: koltuk→userId (yalnız gerçek oyuncular; bot koltuğu yok).
 * winnerSeat: motorun belirlediği kazanan koltuk. bet: masa bahsi.
 * Model: her gerçek oyuncu bet kadar koyar (pot). Kazanan pot'u alır, %10 komisyon kesilir.
 * Eşli (teamMode): kazananın TAKIM ARKADAŞI da kazanan sayılır (pot ikiye bölünür).
 */
/** GÜNLÜK GÖREV kancası: settle'da her gerçek oyuncu için 'play', kazananlar için ek 'win'.
 *  Fire-and-forget — görev hatası settle'ı asla etkilemez. */
function questMatchEvent(uid: string, won: boolean, game?: string): void {
  if (!uid || !supabaseConfigured()) return;
  void rpc('quest_event_for', { p_user_id: uid, p_kind: 'play', p_game: game ?? null })
    .catch((e) => console.warn('[quest] play:', e?.message));
  if (won)
    void rpc('quest_event_for', { p_user_id: uid, p_kind: 'win', p_game: game ?? null })
      .catch((e) => console.warn('[quest] win:', e?.message));
}

export function matchProgressionBaseXp(opts: {
  won: boolean;
  realSeats: number;
  totalSeats?: number;
  teamMode?: boolean;
  game?: string;
}): number {
  let xp = 25; // completed online match
  if (opts.won) xp += 35;
  if ((opts.realSeats ?? 0) >= Math.min(opts.totalSeats ?? 4, 4)) xp += 10; // full human table bonus
  else if ((opts.realSeats ?? 0) >= 2) xp += 5; // at least real opposition / teammate
  if (opts.teamMode) xp += 5;
  if (opts.game === 'tavla') xp += 5; // shorter 1v1 matches still feel worthwhile
  return xp;
}

export type MatchProgressionAward = {
  seat: number;
  userId: string;
  xp: number;
  won: boolean;
  levelBefore: number;
  levelAfter: number;
};

async function grantMatchProgression(uid: string, won: boolean, opts: {
  progressionKey?: string;
  game?: string;
  gameVariant?: string;
  bet: number;
  winnerSeat: number;
  teamMode: boolean;
  totalSeats?: number;
  realSeats: number;
}): Promise<Omit<MatchProgressionAward, 'seat'> | null> {
  if (!uid || !supabaseConfigured()) return null;
  if (!opts.progressionKey) {
    console.warn('[progression] progressionKey yok; XP atlandi');
    return null;
  }
  const baseXp = matchProgressionBaseXp({
    won,
    realSeats: opts.realSeats,
    totalSeats: opts.totalSeats,
    teamMode: opts.teamMode,
    game: opts.game,
  });
  try {
    const result = await rpcService('grant_account_xp', {
      p_user_id: uid,
      p_source: 'match',
      p_event_key: opts.progressionKey,
      p_base_xp: baseXp,
      p_game: opts.game ?? null,
      p_context: {
        won,
        bet: opts.bet,
        winnerSeat: opts.winnerSeat,
        teamMode: opts.teamMode,
        totalSeats: opts.totalSeats ?? 4,
        realSeats: opts.realSeats,
        variant: opts.gameVariant ?? null,
      },
    });
    if (result?.ok !== true) {
      console.warn(`[progression] XP yazilamadi uid=${uid.slice(0, 8)} key=${opts.progressionKey} result=${JSON.stringify(result)}`);
      return null;
    }
    const xp = Math.max(0, Math.floor(Number(result?.xp_awarded ?? 0)));
    if (xp <= 0) return null;
    return {
      userId: uid,
      xp,
      won,
      levelBefore: Math.max(1, Math.floor(Number(result?.level_before ?? 1))),
      levelAfter: Math.max(1, Math.floor(Number(result?.level_after ?? 1))),
    };
  } catch (e: any) {
    console.warn(`[progression] XP RPC hata uid=${uid.slice(0, 8)} key=${opts.progressionKey}:`, e?.message);
    return null;
  }
}

export async function settleMatch(opts: {
  seatUsers: Map<number, string>;
  winnerSeat: number;
  bet: number;
  teamMode: boolean;
  scores?: Map<number, number>; // koltuk → maç toplam skoru (51: DÜŞÜK kazanır) — kademeli tekli için
  totalSeats?: number;          // masa koltuk sayısı (tavla 2, diğerleri 4) — bot bahisleri SANAL pota girer
  game?: string;                // çanak hedefi: '51' | 'okey' | 'tavla' (komisyonun %50'si birikir)
  gameVariant?: string;          // okey: 'duz' | 'banko' | 'yuzbir'
  openedSeats?: Iterable<number>; // legacy: eski final-el açan filtresi; 101 payout artık toplam maç sıralamasını esas alır
  entryHousePaid?: boolean;       // komisyon/çanak payı maç başında işlendi; settle tekrar eklemesin
  progressionKey?: string;        // XP idempotency key for this authoritative match
}): Promise<MatchProgressionAward[]> {
  const { seatUsers, winnerSeat, bet, teamMode } = opts;
  if (!supabaseConfigured() || !Number.isFinite(winnerSeat)) return [];

  // Tek hesap / tek cüzdan: pot = totalSeats × bet; %10 komisyon (çanağın yarısı + yanma),
  // kalanın tamamı kazanan tarafa gider. Eşli modda kazanan takım arasında eşit bölünür.
  // 101 tekli de dahil tüm oyunlar için aynı model geçerlidir — winnerSeat otoritedir.

  const teamOf = (s: number) => s % 2;
  const isWinner = (s: number) => (teamMode ? teamOf(s) === teamOf(winnerSeat) : s === winnerSeat);

  const winners: Array<{ seat: number; uid: string }> = [];
  const losers: Array<{ seat: number; uid: string }> = [];
  for (const [seat, uid] of seatUsers) (isWinner(seat) ? winners : losers).push({ seat, uid });
  if (winners.length === 0 && losers.length === 0) return [];

  // EKONOMİ (ECONOMY.md §4): pot = KOLTUK×bet; bot bahisleri SANAL pota girer (sink korunur).
  // PEŞİN model: kazanan taraf üyesi BRÜT perWinner alır (net = perWinner − peşin bet);
  // kaybedene EK kesinti yok (peşini masada kaldı).
  const seats = opts.totalSeats ?? 4;
  const winSide = teamMode ? 2 : 1;                // kazanan taraf üye sayısı (bot dahil)
  const economyBet = Math.max(0, Math.floor(bet));
  const pot = seats * economyBet;
  const prizePool = pot - Math.floor(pot * 0.1);   // %10 komisyon
  const perWinner = economyBet > 0 ? Math.floor(prizePool / winSide) : 0;

  if (economyBet > 0)
    for (const { uid } of winners) await rpc('add_chips', { p_user_id: uid, p_amount: perWinner });

  // ÇANAK: komisyonun %50'si ilgili oyunun çanağına birikir (kalan %50 yakılır — ECONOMY §4).
  if (economyBet > 0 && opts.game && !opts.entryHousePaid) await canakAdd(opts.game, entryCanakShare(pot - prizePool));

  // İSTATİSTİK: oynanan maç (matches) HER gerçek oyuncuda +1; galibiyet (wins) yalnız
  // kazananlarda +1. Ayrıca kazanan serisi (cur_streak/best_streak) ve toplam kazanç
  // (total_won) güncellenir. Bot koltukları seatUsers'ta YOK → yalnız insanlar sayılır.
  // record_match_stats RPC tek atomik UPDATE yapar (winrate = wins/matches buradan doğru çıkar).
  for (const { uid } of winners)
    await rpc('record_match_stats', { p_user_id: uid, p_won: true,  p_winnings: Math.max(0, perWinner - economyBet) });
  for (const { uid } of losers)
    await rpc('record_match_stats', { p_user_id: uid, p_won: false, p_winnings: 0 });
  for (const { uid } of winners) questMatchEvent(uid, true, opts.game);
  for (const { uid } of losers) questMatchEvent(uid, false, opts.game);
  const progressionAwards: MatchProgressionAward[] = [];
  for (const { seat, uid } of winners) {
    const award = await grantMatchProgression(uid, true, {
      progressionKey: opts.progressionKey,
      game: opts.game,
      gameVariant: opts.gameVariant,
      bet: economyBet,
      winnerSeat,
      teamMode,
      totalSeats: seats,
      realSeats: winners.length + losers.length,
    });
    if (award) progressionAwards.push({ ...award, seat });
  }
  for (const { seat, uid } of losers) {
    const award = await grantMatchProgression(uid, false, {
      progressionKey: opts.progressionKey,
      game: opts.game,
      gameVariant: opts.gameVariant,
      bet: economyBet,
      winnerSeat,
      teamMode,
      totalSeats: seats,
      realSeats: winners.length + losers.length,
    });
    if (award) progressionAwards.push({ ...award, seat });
  }

  console.log(`[settle] PESIN winners=${winners.length} losers=${losers.length} seats=${seats} pot=${pot} perWinner(brut)=${perWinner}`);
  return progressionAwards;
}
