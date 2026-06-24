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
  console.log(`[settle] winners=${winners.length} losers=${losers.length} pot=${pot} perWinner=${perWinner}`);
}
