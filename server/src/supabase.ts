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
    return true;
  } catch (e: any) {
    console.error(`[supabase] RPC ${fn}:`, e?.message);
    return false;
  }
}

/** PEŞİN BAHİS GİRİŞİ: maç fiilen BAŞLARKEN her gerçek oturandan bahsi kes (odalar çağırır).
 *  Kaçan/düşen zaten ödemiş olur; settle yalnız ödeme yapar. */
export async function deductEntry(seatUsers: Map<number, string>, bet: number): Promise<void> {
  if (!supabaseConfigured() || bet <= 0) return;
  for (const [, uid] of seatUsers) await rpc('deduct_chips', { p_user_id: uid, p_amount: bet });
  console.log(`[entry] PESIN bahis kesildi: ${seatUsers.size} oyuncu × ${bet}`);
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
  await rpc('add_chips', { p_user_id: uid, p_amount: amt });
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
export async function settleMatch(opts: {
  seatUsers: Map<number, string>;
  winnerSeat: number;
  bet: number;
  teamMode: boolean;
  scores?: Map<number, number>; // koltuk → maç toplam skoru (51: DÜŞÜK kazanır) — kademeli tekli için
  totalSeats?: number;          // masa koltuk sayısı (tavla 2, diğerleri 4) — bot bahisleri SANAL pota girer
  game?: string;                // çanak hedefi: '51' | 'okey' | 'tavla' (komisyonun %50'si birikir)
}): Promise<void> {
  const { seatUsers, winnerSeat, bet, teamMode, scores } = opts;
  if (!supabaseConfigured() || !Number.isFinite(winnerSeat) || bet <= 0) return;

  // KADEMELİ TEKLİ (kararlaştırılan model): 4 gerçek oyuncu + skorlar → sıralamaya göre dağıt.
  //   Havuz 4E. 1.→3.20E, 2.→0.70E, 3-4→0, ev→0.10E. Net: 1.+2.20E, 2.−0.30E, 3-4 −E.
  //   (Sıralama: en DÜŞÜK skor 1., en yüksek 4.)
  // ── PEŞİN BAHİS MODELİ (2026-07-04, kullanıcı): bahis MAÇ BAŞINDA kesilir (odalar
  //    deductEntry çağırır). Settle YALNIZ ÖDEME yapar — kazanan BRÜT alır (bahis iadesi
  //    içinde), kaybedene EK KESİNTİ YOK. Kaçan/düşen de peşin ödediği için ayrıca cezalanmaz.
  //    Eski model (kaybedenden settle'da kesinti) win ekranıyla ("+9.000 aldım ama +4.000
  //    yazıyor") ve kullanıcı zihin modeliyle çelişiyordu. ──
  if (!teamMode && seatUsers.size === 4 && scores) {
    const ranked = [...seatUsers.entries()].sort((a, b) => (scores.get(a[0]) ?? 0) - (scores.get(b[0]) ?? 0));
    const E = bet;
    const [first, second, third, fourth] = ranked.map((r) => r[1]);
    await rpc('add_chips', { p_user_id: first,  p_amount: Math.round(3.2 * E) }); // brüt (peşin E ödendi → net +2.2E)
    await rpc('add_chips', { p_user_id: second, p_amount: Math.round(0.7 * E) }); // iade (net −0.3E)
    // 3.-4. ödeme yok (peşinleri masada kaldı → net −E)
    await rpc('record_match_stats', { p_user_id: first,  p_won: true,  p_winnings: Math.round(2.2 * E) });
    for (const uid of [second, third, fourth]) await rpc('record_match_stats', { p_user_id: uid, p_won: false, p_winnings: 0 });
    // ÇANAK: ev payının (0.1E) yarısı çanağa, yarısı yanar (ECONOMY §4 CanakPct=%50).
    if (opts.game) await canakAdd(opts.game, Math.floor(0.1 * E * 0.5));
    console.log(`[settle] tekli KADEMELİ 4-kisi E=${E} sira=${ranked.map((r) => r[0])}`);
    return;
  }

  const teamOf = (s: number) => s % 2;
  const isWinner = (s: number) => (teamMode ? teamOf(s) === teamOf(winnerSeat) : s === winnerSeat);

  const winners: string[] = [];
  const losers: string[] = [];
  for (const [seat, uid] of seatUsers) (isWinner(seat) ? winners : losers).push(uid);
  if (winners.length === 0 && losers.length === 0) return;

  // EKONOMİ (ECONOMY.md §4): pot = KOLTUK×bet; bot bahisleri SANAL pota girer (sink korunur).
  // PEŞİN model: kazanan taraf üyesi BRÜT perWinner alır (net = perWinner − peşin bet);
  // kaybedene EK kesinti yok (peşini masada kaldı).
  const seats = opts.totalSeats ?? 4;
  const winSide = teamMode ? 2 : 1;                // kazanan taraf üye sayısı (bot dahil)
  const pot = seats * bet;
  const prizePool = pot - Math.floor(pot * 0.1);   // %10 komisyon
  const perWinner = Math.floor(prizePool / winSide);

  for (const uid of winners) await rpc('add_chips', { p_user_id: uid, p_amount: perWinner });

  // ÇANAK: komisyonun %50'si ilgili oyunun çanağına birikir (kalan %50 yakılır — ECONOMY §4).
  if (opts.game) await canakAdd(opts.game, Math.floor((pot - prizePool) * 0.5));

  // İSTATİSTİK: oynanan maç (matches) HER gerçek oyuncuda +1; galibiyet (wins) yalnız
  // kazananlarda +1. Ayrıca kazanan serisi (cur_streak/best_streak) ve toplam kazanç
  // (total_won) güncellenir. Bot koltukları seatUsers'ta YOK → yalnız insanlar sayılır.
  // record_match_stats RPC tek atomik UPDATE yapar (winrate = wins/matches buradan doğru çıkar).
  for (const uid of winners)
    await rpc('record_match_stats', { p_user_id: uid, p_won: true,  p_winnings: Math.max(0, perWinner - bet) });
  for (const uid of losers)
    await rpc('record_match_stats', { p_user_id: uid, p_won: false, p_winnings: 0 });

  console.log(`[settle] PESIN winners=${winners.length} losers=${losers.length} seats=${seats} pot=${pot} perWinner(brut)=${perWinner}`);
}
