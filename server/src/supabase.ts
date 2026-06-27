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
    if (row?.banned === true) return true; // geriye-dönük basit bayrak
    const until = row?.game_banned_until;
    if (!until) return false;
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
    if (!r.ok) return false;
    const rows: any = await r.json();
    const until = Array.isArray(rows) && rows.length > 0 ? rows[0]?.chat_banned_until : null;
    if (!until) return false;
    const t = Date.parse(until);
    return Number.isFinite(t) && t > Date.now();
  } catch (e: any) {
    console.error('[supabase] isChatBanned:', e?.message);
    return false;
  }
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
      table_mode: mode === 'duo' ? 'duo' : 'solo',
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
    return true;
  } catch (e: any) {
    console.error(`[supabase] RPC ${fn}:`, e?.message);
    return false;
  }
}

/**
 * Maç sonu çip dağıtımı. seatUsers: koltuk→userId (yalnız gerçek oyuncular; bot koltuğu yok).
 * winnerSeat: motorun belirlediği kazanan koltuk. bet: masa bahsi.
 * Model: her gerçek oyuncu bet kadar koyar (pot). Kazanan pot'u alır, %10 komisyon kesilir.
 * Eşli (teamMode): kazananın TAKIM ARKADAŞI da kazanan sayılır (pot ikiye bölünür).
 */
export async function settleMatch(opts: {
  seatUsers: Map<number, string>;
  winnerSeat: number;
  bet: number;
  teamMode: boolean;
}): Promise<void> {
  const { seatUsers, winnerSeat, bet, teamMode } = opts;
  if (!supabaseConfigured() || !Number.isFinite(winnerSeat) || bet <= 0) return;

  const teamOf = (s: number) => s % 2;
  const isWinner = (s: number) => (teamMode ? teamOf(s) === teamOf(winnerSeat) : s === winnerSeat);

  const winners: string[] = [];
  const losers: string[] = [];
  for (const [seat, uid] of seatUsers) (isWinner(seat) ? winners : losers).push(uid);
  if (winners.length === 0) return;

  // Pot = tüm gerçek oyuncuların bahsi; kaybedenlerden kes, kazananlara (komisyon sonrası) böl.
  const pot = (winners.length + losers.length) * bet;
  const prizePool = pot - Math.floor(pot * 0.1); // %10 komisyon
  const perWinner = Math.floor(prizePool / winners.length);

  for (const uid of losers) await rpc('deduct_chips', { p_user_id: uid, p_amount: bet });
  for (const uid of winners) await rpc('add_chips', { p_user_id: uid, p_amount: perWinner - bet > 0 ? perWinner - bet : perWinner });

  // İSTATİSTİK: oynanan maç (matches) HER gerçek oyuncuda +1; galibiyet (wins) yalnız
  // kazananlarda +1. Ayrıca kazanan serisi (cur_streak/best_streak) ve toplam kazanç
  // (total_won) güncellenir. Bot koltukları seatUsers'ta YOK → yalnız insanlar sayılır.
  // record_match_stats RPC tek atomik UPDATE yapar (winrate = wins/matches buradan doğru çıkar).
  for (const uid of winners)
    await rpc('record_match_stats', { p_user_id: uid, p_won: true,  p_winnings: perWinner - bet > 0 ? perWinner - bet : 0 });
  for (const uid of losers)
    await rpc('record_match_stats', { p_user_id: uid, p_won: false, p_winnings: 0 });

  console.log(`[settle] winners=${winners.length} losers=${losers.length} pot=${pot} perWinner=${perWinner}`);
}
