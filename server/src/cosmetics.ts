import type { Request } from 'express';
import { rpcService, verifyToken } from './supabase';

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type CosmeticCategory = 'profile_frame' | 'emoji_pack' | 'name_style' | 'ui_theme';
type CosmeticDef = {
  id: string;
  category: CosmeticCategory;
  priceDiamonds: number;
  default?: boolean;
  reactions?: string[];
};

const DEFAULT_PROFILE_FRAME = 'profile_frame_default';
const GOLD_TEAL_FRAME = 'profile_frame_gold_teal_v1';
const MIMIK_PACK_1 = 'emoji_pack_mimik_1';

/** İsim stilleri (masa kartı + çevrimiçi liste + sohbet). Giriş 250, orta 600, üst 1200 elmas. */
export const NAME_STYLE_IDS = [
  'name_style_silver', 'name_style_copper', 'name_style_fire', 'name_style_ice',
  'name_style_gold_shimmer', 'name_style_rainbow',
] as const;
const NAME_STYLE_PRICES: Record<string, number> = {
  name_style_silver: 250, name_style_copper: 250, name_style_fire: 250, name_style_ice: 250,
  name_style_gold_shimmer: 600, name_style_rainbow: 1200,
};
/** Elmasla açılan arayüz temaları (Grafit + Gece Mavisi ücretsiz, istemcide). */
const UI_THEME_PRICES: Record<string, number> = {
  ui_theme_zumrut: 150, ui_theme_sutlu_kahve: 150, ui_theme_bordo_kadife: 150,
};

/** Görünüme/odalara gidecek stil kimliği: yalnız katalogdaki değerler, aksi halde ''. */
export function normalizeNameStyle(raw: unknown): string {
  const id = String(raw ?? '').trim();
  return (NAME_STYLE_IDS as readonly string[]).includes(id) ? id : '';
}

const DEFAULT_REACTIONS = new Set(['clap', 'smile', 'wow', 'angry']);
const COSMETICS: Record<string, CosmeticDef> = {
  [DEFAULT_PROFILE_FRAME]: { id: DEFAULT_PROFILE_FRAME, category: 'profile_frame', priceDiamonds: 0, default: true },
  [GOLD_TEAL_FRAME]: { id: GOLD_TEAL_FRAME, category: 'profile_frame', priceDiamonds: 120 },
  [MIMIK_PACK_1]: {
    id: MIMIK_PACK_1,
    category: 'emoji_pack',
    priceDiamonds: 180,
    reactions: ['giggle', 'angry_shout', 'tease_smirk', 'sad_shy'],
  },
};
for (const [id, price] of Object.entries(NAME_STYLE_PRICES)) COSMETICS[id] = { id, category: 'name_style', priceDiamonds: price };
for (const [id, price] of Object.entries(UI_THEME_PRICES)) COSMETICS[id] = { id, category: 'ui_theme', priceDiamonds: price };

const REACTION_PACK = new Map<string, string>();
for (const item of Object.values(COSMETICS)) {
  for (const kind of item.reactions ?? []) REACTION_PACK.set(kind, item.id);
}

const ownershipCache = new Map<string, { expires: number; owned: boolean }>();
const roleCache = new Map<string, { expires: number; role: string }>();
const CACHE_MS = 60_000;

function authHeader(req: Request): string {
  return String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
}

function serviceHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    ...(extra ?? {}),
  };
}

function requireServer(): void {
  if (!URL || !SERVICE) throw new Error('server_not_configured');
}

async function requireUser(req: Request): Promise<string> {
  const uid = await verifyToken(authHeader(req));
  if (!uid) throw new Error('auth_required');
  return uid;
}

function normalizeCosmeticId(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 80);
}

function knownCosmetic(id: string): CosmeticDef {
  const item = COSMETICS[id];
  if (!item) throw new Error('cosmetic_invalid');
  return item;
}

async function profileRole(userId: string): Promise<string> {
  const cached = roleCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.role;
  requireServer();
  const r = await fetch(`${URL}/rest/v1/profiles?id=eq.${userId}&select=role&limit=1`, {
    headers: serviceHeaders(),
  });
  if (!r.ok) return 'normal';
  const rows: any = await r.json();
  const role = String(Array.isArray(rows) && rows[0]?.role ? rows[0].role : 'normal').toLowerCase();
  roleCache.set(userId, { expires: Date.now() + CACHE_MS, role });
  return role;
}

export async function ownsCosmetic(userId: string | null | undefined, cosmeticId: string): Promise<boolean> {
  try {
    const item = COSMETICS[cosmeticId];
    if (!item) return false;
    if (item.default) return true;
    if (!userId) return false;
    const role = await profileRole(userId);
    if (role === 'admin') return true;

    const key = `${userId}:${cosmeticId}`;
    const cached = ownershipCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.owned;
    requireServer();
    const r = await fetch(
      `${URL}/rest/v1/cosmetic_ownerships?user_id=eq.${userId}&cosmetic_id=eq.${encodeURIComponent(cosmeticId)}&select=cosmetic_id&limit=1`,
      { headers: serviceHeaders() },
    );
    let owned = false;
    if (r.ok) {
      const rows: any = await r.json();
      owned = Array.isArray(rows) && rows.length > 0;
    }
    ownershipCache.set(key, { expires: Date.now() + CACHE_MS, owned });
    return owned;
  } catch (e: any) {
    console.error('[cosmetics] ownsCosmetic:', e?.message);
    return false;
  }
}

export async function canUseReaction(userId: string | null | undefined, kind: string): Promise<boolean> {
  const normalized = String(kind ?? '').trim();
  if (DEFAULT_REACTIONS.has(normalized)) return true;
  const pack = REACTION_PACK.get(normalized);
  return !!pack && await ownsCosmetic(userId, pack);
}

export async function cosmeticInventory(req: Request): Promise<Record<string, unknown>> {
  requireServer();
  const userId = await requireUser(req);
  const [ownedResponse, profileResponse] = await Promise.all([
    fetch(`${URL}/rest/v1/cosmetic_ownerships?user_id=eq.${userId}&select=cosmetic_id,category,acquired_at&order=acquired_at.asc`, {
      headers: serviceHeaders(),
    }),
    fetch(`${URL}/rest/v1/profiles?id=eq.${userId}&select=diamonds,equipped_profile_frame,equipped_name_style,role&limit=1`, {
      headers: serviceHeaders(),
    }),
  ]);
  if (!ownedResponse.ok) throw new Error(`inventory_http_${ownedResponse.status}`);
  if (!profileResponse.ok) throw new Error(`profile_http_${profileResponse.status}`);
  const ownedRows: any = await ownedResponse.json();
  const profiles: any = await profileResponse.json();
  const profile = Array.isArray(profiles) && profiles.length ? profiles[0] : {};
  const owned = new Set<string>([DEFAULT_PROFILE_FRAME]);
  if (String(profile?.role ?? '').toLowerCase() === 'admin') {
    for (const id of Object.keys(COSMETICS)) owned.add(id);
  }
  for (const row of Array.isArray(ownedRows) ? ownedRows : []) {
    if (typeof row?.cosmetic_id === 'string') owned.add(row.cosmetic_id);
  }
  return {
    ok: true,
    owned: [...owned],
    diamonds: Number(profile?.diamonds ?? 0),
    equipped_profile_frame: profile?.equipped_profile_frame || DEFAULT_PROFILE_FRAME,
    equipped_name_style: normalizeNameStyle(profile?.equipped_name_style),
  };
}

export async function purchaseCosmetic(req: Request): Promise<Record<string, unknown>> {
  requireServer();
  const userId = await requireUser(req);
  const id = normalizeCosmeticId(req.body?.cosmetic_id);
  const item = knownCosmetic(id);
  if (item.default) return await cosmeticInventory(req);
  const result = await rpcService('cosmetic_purchase', {
    p_user_id: userId,
    p_cosmetic_id: item.id,
    p_category: item.category,
    p_diamond_cost: item.priceDiamonds,
  });
  if (result?.ok !== true) return { ok: false, error: result?.error ?? 'purchase_failed', diamonds: result?.diamonds };
  ownershipCache.delete(`${userId}:${item.id}`);
  return { ok: true, cosmetic_id: item.id, diamonds: result.diamonds, already_owned: result.already_owned === true };
}

export async function equipCosmetic(req: Request): Promise<Record<string, unknown>> {
  requireServer();
  const userId = await requireUser(req);
  // İsim stili: kategori 'name_style' ile '' (standart) da gönderilebilir.
  if (String(req.body?.category ?? '') === 'name_style') {
    const styleId = normalizeCosmeticId(req.body?.cosmetic_id);
    if (styleId && knownCosmetic(styleId).category !== 'name_style') throw new Error('cosmetic_not_equippable');
    const r = await rpcService('equip_name_style', { p_user_id: userId, p_cosmetic_id: styleId });
    if (r?.ok !== true) return { ok: false, error: r?.error ?? 'equip_failed' };
    return { ok: true, equipped_name_style: normalizeNameStyle(r.equipped_name_style) };
  }
  const id = normalizeCosmeticId(req.body?.cosmetic_id) || DEFAULT_PROFILE_FRAME;
  const item = knownCosmetic(id);
  if (item.category === 'name_style') {
    const r = await rpcService('equip_name_style', { p_user_id: userId, p_cosmetic_id: item.id });
    if (r?.ok !== true) return { ok: false, error: r?.error ?? 'equip_failed' };
    return { ok: true, equipped_name_style: normalizeNameStyle(r.equipped_name_style) };
  }
  if (item.category !== 'profile_frame') throw new Error('cosmetic_not_equippable');
  const result = await rpcService('equip_profile_frame', {
    p_user_id: userId,
    p_cosmetic_id: item.id,
  });
  if (result?.ok !== true) return { ok: false, error: result?.error ?? 'equip_failed' };
  return { ok: true, equipped_profile_frame: result.equipped_profile_frame || DEFAULT_PROFILE_FRAME };
}

export const _test = { COSMETICS, DEFAULT_REACTIONS, REACTION_PACK };
