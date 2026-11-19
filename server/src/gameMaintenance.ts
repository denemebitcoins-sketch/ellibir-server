// 19.11 OYUN BAKIM MODU: public.game_maintenance (yönetici panelinden/sitesinden açılıp kapanır).
// Bakımdaki oyunda YENİ masa açılmaz / bekleyen masaya oturulmaz; süren masa (oyun başlamış) bozulmaz,
// koltuğuna geri dönen (reconnect) etkilenmez. Yöneticiler her zaman girebilir (test).
// Sorgu 15 sn önbellekli; Supabase'e ulaşılamazsa oyun AÇIK sayılır (bakım yanlışlıkla herkesi kilitlemesin).

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const TTL_MS = 15_000;

export type MaintenanceKey = '101' | 'klasik' | 'bankolu' | '51' | 'ihale' | 'tavla';
export const MAINTENANCE_DEFAULT_MESSAGE = 'Bu oyun şu an bakımda, yakında tekrar aktif edilecek.';

let cache: { at: number; rows: Record<string, { on: boolean; msg: string }> } | null = null;
let inflight: Promise<void> | null = null;
const adminCache = new Map<string, { at: number; admin: boolean }>();

/** Testler için: önbelleği elle doldur/temizle. */
export function __setMaintenanceForTest(rows: Record<string, { on: boolean; msg?: string }> | null, admins: string[] = []) {
  cache = rows ? { at: Date.now() + 365 * 86400_000, rows: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { on: !!v.on, msg: v.msg ?? '' }])) } : null;
  adminCache.clear();
  for (const a of admins) adminCache.set(a, { at: Date.now() + 365 * 86400_000, admin: true });
}

export function okeyMaintenanceKey(variant: unknown): MaintenanceKey {
  return variant === 'yuzbir' ? '101' : variant === 'banko' ? 'bankolu' : 'klasik';
}

async function refresh(): Promise<void> {
  if (!URL || !SERVICE) { cache = { at: Date.now(), rows: {} }; return; }
  try {
    const r = await fetch(`${URL}/rest/v1/game_maintenance?select=game_key,maintenance,message`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) { cache = { at: Date.now(), rows: cache?.rows ?? {} }; return; } // tablo yoksa/erişilemezse açık say
    const rows: any[] = await r.json();
    const out: Record<string, { on: boolean; msg: string }> = {};
    for (const row of Array.isArray(rows) ? rows : []) out[String(row.game_key)] = { on: row.maintenance === true, msg: String(row.message ?? '') };
    cache = { at: Date.now(), rows: out };
  } catch (e: any) {
    console.warn('[maintenance] okunamadı:', e?.message);
    cache = { at: Date.now(), rows: cache?.rows ?? {} };
  }
}

async function rows(): Promise<Record<string, { on: boolean; msg: string }>> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    await inflight;
  }
  return cache?.rows ?? {};
}

async function isAdminUser(uid: string): Promise<boolean> {
  const hit = adminCache.get(uid);
  if (hit && Date.now() - hit.at < 60_000) return hit.admin;
  if (!URL || !SERVICE) return false;
  try {
    const r = await fetch(`${URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      signal: AbortSignal.timeout(4000),
    });
    const list: any[] = r.ok ? await r.json() : [];
    const admin = Array.isArray(list) && list[0]?.role === 'admin';
    adminCache.set(uid, { at: Date.now(), admin });
    return admin;
  } catch { return false; }
}

/** Bakımdaysa kullanıcıya gösterilecek mesaj; değilse (veya yöneticiyse) null. */
export async function maintenanceBlock(key: MaintenanceKey, uid: string | null | undefined): Promise<string | null> {
  const row = (await rows())[key];
  if (!row?.on) return null;
  if (uid && (await isAdminUser(uid))) return null;
  return row.msg?.trim() || MAINTENANCE_DEFAULT_MESSAGE;
}

/** 19.11: bot_population_begin_match 23505 (match_seats_active_identity_idx) → önceki maçı süren insanın uid'i.
 *  Bu oyuncu başka masada (botu oynuyor) hâlâ aktif maçta; bu masa onu beklerse sonsuz "hazır" döngüsü olur. */
export function busyHumanFromEntryError(message: unknown): string | null {
  const m = /match_seats_active_identity_idx|\(kind, participant_id\)=\(human, ([0-9a-f-]{36})\)/i.exec(String(message ?? ''));
  if (!m) return null;
  const id = /\(human, ([0-9a-f-]{36})\)/i.exec(String(message ?? ''));
  return id ? id[1] : null;
}
export const BUSY_ELSEWHERE_REASON = 'Önceki maçın başka masada hâlâ sürüyor (yerine bot oynuyor). O maç bitince yeni masaya oturabilirsin.';
