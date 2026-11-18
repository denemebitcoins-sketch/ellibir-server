import { rpcService, MatchExtras, callMatchExtras } from './supabase';
import type { PopulationMatch } from './botPopulation/storage';

/**
 * 6.9 (kullanıcı kararı 18.11): gerçek oyuncu canlı botlu (population) masada oynadığında da
 * Haftanın Kahvecisi puanı + Kayıpsız Kahve Saati iadesi/bonusu normal masadaki gibi işlenir.
 * Botlar ASLA gönderilmez (match_extras ayrıca 'bot:%' kullanıcıyı reddeder) → listeye girmezler.
 * Kazanç bot sisteminin kendi ödeme kuralıyla hesaplanır: (koltuk × bahis − komisyon) / (eşli ise 2).
 * Yalnız gerçek sonuçlanan (settled) maç; iade/sonuçsuz maç puan vermez. match_key+kullanıcı ile idempotent.
 */
export async function populationMatchExtras(match: PopulationMatch | null, hands: number,
  rpc: (fn: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<any> = rpcService,
  presentUserIds?: Iterable<string>, startedAt?: string): Promise<MatchExtras[]> {
  const present = presentUserIds ? new Set(presentUserIds) : null; // 18.11: yarıda çıkan puan almaz
  if (!match || match.state !== 'settled' || match.winner_seat == null || !(match.bet > 0)) return [];
  const count = match.roster.length;
  const winner = match.winner_seat;
  const prize = Math.floor((count * match.bet - Number(match.house_amount ?? 0)) / (match.team_mode ? 2 : 1));
  const out: MatchExtras[] = [];
  for (const p of match.roster) {
    if (p.kind !== 'human' || !p.id) continue;
    if (present && !present.has(p.id)) continue;
    const won = p.seat === winner || (match.team_mode && p.seat % 2 === winner % 2);
    const net = won ? Math.max(0, prize - match.bet) : 0;
    try {
      const r = await callMatchExtras({
        p_user: p.id, p_game: match.game, p_hands: Math.max(1, Math.floor(hands || 1)),
        p_won: won, p_bet: match.bet, p_net: net, p_key: match.match_key,
        ...(startedAt ? { p_started_at: startedAt } : {}),
      }, rpc);
      if (r && r.ok) out.push({ seat: p.seat, userId: p.id, points: Number(r.points ?? 0), double: !!r.double, capped: !!r.capped,
        coffeeKind: r.coffee_kind ?? null, coffeeAmount: Number(r.coffee_amount ?? 0) });
    } catch (e: any) { console.warn('[population] match_extras:', e?.message); }
  }
  return out;
}
