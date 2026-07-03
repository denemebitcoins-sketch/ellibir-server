import type { OkeyColor, OkeyRank, OkeyTile, TileIdentity } from './types';
import { OKEY_COLORS } from './types';
import { identityOf } from './deck';

/**
 * OKEY el doğrulama.
 *  - SERİ: aynı renk ardışık ≥3; 1 hem başta (1-2-3) hem 13'ten sonra (12-13-1) kullanılır,
 *    13-1-2 GEÇERSİZ (pozisyon ekseni 1..14; pos14 = rank 1).
 *  - KÜT: aynı sayı, FARKLI renkler, 3-4 taş.
 *  - ÇİFT: aynı renk + aynı sayı iki taş.
 *  - OKEY taşı joker (her taş yerine), SAHTE OKEY okeyin gerçek kimliğiyle oynanır.
 *
 * Bitiş kontrolü multiset + geri-izleme ile yapılır: aynı taştan iki kopyanın iki ayrı
 * peride kullanılması (maske/ilk-kopya tuzaklarına düşmeden) doğru çalışır.
 */

const key = (c: OkeyColor, r: number) => `${c}${r}`;

interface HandCounts {
  counts: Map<string, number>; // renk+sayı → adet (sahte okey, okey kimliğine sayılır)
  wilds: number;               // gerçek okey adedi (joker)
  total: number;               // gerçek (joker olmayan) taş adedi
}

export function countIdentities(hand: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): HandCounts {
  const counts = new Map<string, number>();
  let wilds = 0, total = 0;
  for (const t of hand) {
    const id = identityOf(t, okeyColor, okeyRank);
    if (id.wild) { wilds++; continue; }
    counts.set(key(id.color, id.rank), (counts.get(key(id.color, id.rank)) ?? 0) + 1);
    total++;
  }
  return { counts, wilds, total };
}

/** pos (1..14) → o pozisyonda gereken sayı (pos14 = 1). */
const rankAtPos = (pos: number): number => (pos === 14 ? 1 : pos);

/** 14 taş, seri/küt karışımına TAM bölünebiliyor mu (geri-izleme). */
export function canFinishMelds(hand: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  if (hand.length !== 14) return false;
  const h = countIdentities(hand, okeyColor, okeyRank);

  const solve = (wilds: number, remaining: number): boolean => {
    if (remaining === 0) return wilds === 0; // açıkta joker kaldıysa el bitmemiştir
    // Çapa: kalan ilk kimlik (deterministik sıra) — her grup çapayı içermek zorunda.
    let anchorK: string | null = null;
    for (const c of OKEY_COLORS) {
      for (let r = 1; r <= 13 && anchorK == null; r++)
        if ((h.counts.get(key(c, r)) ?? 0) > 0) anchorK = key(c, r);
      if (anchorK != null) break;
    }
    if (anchorK == null) return false; // remaining>0 ama sayaç boş (olmamalı)
    const anchorColor = anchorK[0] as OkeyColor;
    const anchorRank = parseInt(anchorK.slice(1), 10) as OkeyRank;

    const take = (k: string, n: number) => h.counts.set(k, (h.counts.get(k) ?? 0) - n);
    const give = (k: string, n: number) => h.counts.set(k, (h.counts.get(k) ?? 0) + n);

    // ── KÜT adayları: çapanın sayısında, çapa dahil renk alt-kümeleri + joker dolgu ──
    const others = OKEY_COLORS.filter((c) => c !== anchorColor && (h.counts.get(key(c, anchorRank)) ?? 0) > 0);
    for (let subset = 0; subset < (1 << others.length); subset++) {
      const chosen: OkeyColor[] = [anchorColor];
      for (let b = 0; b < others.length; b++) if (subset & (1 << b)) chosen.push(others[b]!);
      for (let size = 3; size <= 4; size++) {
        const jokerUse = size - chosen.length;
        if (jokerUse < 0 || jokerUse > wilds) continue;
        for (const c of chosen) take(key(c, anchorRank), 1);
        if (solve(wilds - jokerUse, remaining - chosen.length)) return true;
        for (const c of chosen) give(key(c, anchorRank), 1);
      }
    }

    // ── SERİ adayları: çapanın renginde, çapa pozisyonunu içeren pencereler ──
    const anchorPositions = anchorRank === 1 ? [1, 14] : [anchorRank];
    for (const ap of anchorPositions) {
      for (let len = 3; len <= 14; len++) {
        for (let start = Math.max(1, ap - len + 1); start <= ap; start++) {
          const end = start + len - 1;
          if (end > 14) continue;
          // Pencereyi doldur: pozisyondaki gerçek taş varsa kullan, yoksa joker.
          const used: string[] = [];
          let jokerNeed = 0, ok = true;
          for (let pos = start; pos <= end; pos++) {
            const k = key(anchorColor, rankAtPos(pos));
            if ((h.counts.get(k) ?? 0) > 0) { take(k, 1); used.push(k); }
            else jokerNeed++;
          }
          // Çapa pencerede GERÇEKTEN kullanıldı mı (joker yerine geçmiş olmasın)?
          if (!used.includes(anchorK)) ok = false;
          if (ok && jokerNeed <= wilds && solve(wilds - jokerNeed, remaining - used.length)) return true;
          for (const k of used) give(k, 1);
        }
      }
    }
    return false;
  };

  return solve(h.wilds, h.total);
}

/** 14 taş 7 ÇİFTE bölünebiliyor mu. Okey (joker) eşi olmayan tek taşı tamamlar;
 *  iki joker kendi aralarında da çift olur. Sahte okey, okey kimliğiyle eşleşir. */
export function canFinishPairs(hand: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  if (hand.length !== 14) return false;
  const h = countIdentities(hand, okeyColor, okeyRank);
  let singles = 0;
  for (const n of h.counts.values()) if (n % 2 === 1) singles++;
  // Her tek taş bir jokerle eşleşmeli; artan jokerler çifter çifter birbirini tutar.
  return singles <= h.wilds && (h.wilds - singles) % 2 === 0;
}

export interface FinishCheck {
  canMelds: boolean;
  canPairs: boolean;
}

export function checkFinish(hand: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): FinishCheck {
  return {
    canMelds: canFinishMelds(hand, okeyColor, okeyRank),
    canPairs: canFinishPairs(hand, okeyColor, okeyRank),
  };
}

/* ── Tekil grup doğrulama (istemci ön-kontrol / test için) ───────────────── */

export function isValidSet(tiles: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  if (tiles.length < 3 || tiles.length > 4) return false;
  const ids = tiles.map((t) => identityOf(t, okeyColor, okeyRank));
  const reals = ids.filter((i) => !i.wild);
  if (reals.length === 0) return false;
  const rank = reals[0]!.rank;
  if (!reals.every((r) => r.rank === rank)) return false;
  const colors = new Set(reals.map((r) => r.color));
  return colors.size === reals.length; // renk tekrarı yasak; jokerler kalan renkleri tutar (≤4 zaten)
}

export function isValidRun(tiles: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  if (tiles.length < 3 || tiles.length > 14) return false;
  const ids = tiles.map((t) => identityOf(t, okeyColor, okeyRank));
  const reals = ids.filter((i) => !i.wild);
  if (reals.length === 0) return false;
  const color = reals[0]!.color;
  if (!reals.every((r) => r.color === color)) return false;
  const wilds = ids.length - reals.length;
  // Rank 1'ler pos1/pos14 seçimli → tüm kombinasyonları dene (adet ≤2).
  const ones = reals.filter((r) => r.rank === 1).length;
  const rest = reals.filter((r) => r.rank !== 1).map((r) => r.rank as number);
  const oneChoices: number[][] = ones === 0 ? [[]] : ones === 1 ? [[1], [14]] : [[1, 14]];
  for (const oc of oneChoices) {
    const pos = [...rest, ...oc].sort((a, b) => a - b);
    if (new Set(pos).size !== pos.length) continue;   // aynı pozisyon iki kez
    const span = pos[pos.length - 1]! - pos[0]! + 1;
    if (span > tiles.length) continue;                 // boşluklar jokerlere sığmıyor
    const gapWilds = span - pos.length;                // iç boşluk
    const extWilds = tiles.length - span;              // uçlara taşan joker
    if (gapWilds > wilds) continue;
    // Uç uzatmaları 1..14 sınırında kalmalı.
    let fit = false;
    for (let left = 0; left <= extWilds; left++) {
      const start = pos[0]! - left, end = pos[pos.length - 1]! + (extWilds - left);
      if (start >= 1 && end <= 14) { fit = true; break; }
    }
    if (fit && gapWilds + extWilds === wilds) return true;
  }
  return false;
}

export function isValidPair(tiles: readonly OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  if (tiles.length !== 2) return false;
  const a = identityOf(tiles[0]!, okeyColor, okeyRank);
  const b = identityOf(tiles[1]!, okeyColor, okeyRank);
  if (a.wild || b.wild) return true; // joker her taşla (ve diğer jokerle) çift olur
  return a.color === b.color && a.rank === b.rank;
}

/* ── KAPSAMA-MAKSİMUM GRUPLAMA (C# OkeyMelds.BestGrouping birebir portu) ──────
   SIRALA/skorlama için: eldeki taşlardan en çok taşı kapsayan geçerli seri/küt
   kümesini bulur (skip-anchor + memo; okey boşluğa ORTAYA girer, pos ekseni 1..14). */

export function bestGrouping(hand: OkeyTile[], okeyColor: OkeyColor, okeyRank: OkeyRank): OkeyTile[][] {
  const counts = new Map<string, number>();
  const pools = new Map<string, OkeyTile[]>();
  const wildPool: OkeyTile[] = [];
  const key = (c: OkeyColor, r: number) => c + ':' + r;
  for (const t of hand) {
    const id = identityOf(t, okeyColor, okeyRank);
    if (id.wild) { wildPool.push(t); continue; }
    const k = key(id.color, id.rank);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k)!.push(t);
  }
  const get = (k: string) => counts.get(k) ?? 0;
  const take = (k: string) => counts.set(k, get(k) - 1);
  const give = (k: string) => counts.set(k, get(k) + 1);

  const memo = new Map<string, { cov: number; groups: string[][] }>();
  const stateKey = (w: number): string => {
    let sb = '';
    for (const c of OKEY_COLORS)
      for (let r = 1; r <= 13; r++) {
        const n = get(key(c, r));
        if (n > 0) sb += c + r + ':' + n + ',';
      }
    return sb + '|' + w;
  };

  const solve = (w: number): { cov: number; groups: string[][] } => {
    let anchorK: string | null = null;
    let ac: OkeyColor = 'R';
    let ar = 0;
    for (const c of OKEY_COLORS) {
      for (let r = 1; r <= 13; r++)
        if (get(key(c, r)) > 0) { anchorK = key(c, r); ac = c; ar = r; break; }
      if (anchorK) break;
    }
    if (!anchorK) return { cov: 0, groups: [] };
    const sk = stateKey(w);
    const hit = memo.get(sk);
    if (hit) return hit;

    // 1) Çapanın bu kopyası boşta kalabilir.
    take(anchorK);
    let best = solve(w);
    give(anchorK);

    // 2) KÜT adayları.
    const others = OKEY_COLORS.filter((c) => c !== ac && get(key(c, ar)) > 0);
    for (let subset = 0; subset < (1 << others.length); subset++) {
      const chosen: OkeyColor[] = [ac];
      for (let b = 0; b < others.length; b++) if (subset & (1 << b)) chosen.push(others[b]!);
      for (let size = 3; size <= 4; size++) {
        const ju = size - chosen.length;
        if (ju < 0 || ju > w) continue;
        for (const c of chosen) take(key(c, ar));
        const sub = solve(w - ju);
        for (const c of chosen) give(key(c, ar));
        if (sub.cov + size > best.cov) {
          const grp: string[] = chosen.map((c) => key(c, ar));
          for (let x = 0; x < ju; x++) grp.push('W');
          best = { cov: sub.cov + size, groups: [...sub.groups, grp] };
        }
      }
    }

    // 3) SERİ adayları (çapa pozisyonunu içeren pencereler).
    const apos = ar === 1 ? [1, 14] : [ar];
    for (const ap of apos) {
      for (let len = 3; len <= 14; len++) {
        for (let start = Math.max(1, ap - len + 1); start <= ap; start++) {
          const end = start + len - 1;
          if (end > 14) continue;
          const used: string[] = [];
          const grpDesc: string[] = [];
          let need = 0;
          for (let pos = start; pos <= end; pos++) {
            const k = key(ac, rankAtPos(pos));
            if (get(k) > 0) { take(k); used.push(k); grpDesc.push(k); }
            else { need++; grpDesc.push('W'); }
          }
          if (used.includes(anchorK) && need <= w) {
            const sub = solve(w - need);
            if (sub.cov + len > best.cov) best = { cov: sub.cov + len, groups: [...sub.groups, grpDesc] };
          }
          for (const k of used) give(k);
        }
      }
    }

    memo.set(sk, best);
    return best;
  };

  const picked = solve(wildPool.length);
  const result: OkeyTile[][] = [];
  for (const grp of picked.groups) {
    const real: OkeyTile[] = [];
    for (const k of grp) real.push(k === 'W' ? wildPool.pop()! : pools.get(k)!.pop()!);
    result.push(real);
  }
  return result;
}
