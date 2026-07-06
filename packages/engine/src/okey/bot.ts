import type { OkeyGameState } from './game';
import {
  applyOkeyMove,
  bestYuzbirMeldOpening,
  bestYuzbirPairOpening,
  yuzbirOpeningMin,
  yuzbirPairOpeningMin,
} from './game';
import type { OkeyTile } from './types';
import { identityOf, isOkeyTile } from './deck';
import { canFinishMelds, canFinishPairs } from './melds';

/**
 * BASİT OKEY BOTU (v1 sezgisel):
 *  1) Bitirebiliyorsa bitirir (her atılabilir taşı dener).
 *  2) Sol atık işine yarıyorsa (sinerji artırıyorsa) onu alır, yoksa ortadan çeker.
 *  3) En düşük sinerjili taşı atar; okeyi ASLA atmaz (bitiş hariç).
 * Sinerji: aynı kimlikten eş + aynı renkte ±1/±2 komşu + aynı sayıda farklı renk sayısı.
 */

function synergy(hand: readonly OkeyTile[], tile: OkeyTile, state: OkeyGameState): number {
  const id = identityOf(tile, state.okeyColor, state.okeyRank);
  if (id.wild) return 1000; // okey elde tutulur
  let score = 0;
  for (const other of hand) {
    if (other.id === tile.id) continue;
    const o = identityOf(other, state.okeyColor, state.okeyRank);
    if (o.wild) continue;
    if (o.color === id.color && o.rank === id.rank) score += 6;           // çift/kopya
    else if (o.color === id.color && Math.abs(o.rank - id.rank) === 1) score += 4; // bitişik seri
    else if (o.color === id.color && Math.abs(o.rank - id.rank) === 2) score += 2; // atlamalı seri
    else if (o.rank === id.rank) score += 3;                               // küt adayı
    // 1-13 komşuluğu (12-13-1): 1 ile 13 bitişik sayılır.
    else if (o.color === id.color && ((o.rank === 13 && id.rank === 1) || (o.rank === 1 && id.rank === 13))) score += 4;
  }
  return score;
}

/** Elden bitirilebilecek taşı bul (atılınca kalan 14 geçerli olan). */
function findFinishTile(state: OkeyGameState, seat: number): string | null {
  const p = state.players[seat]!;
  if (p.hand.length !== 15) return null;
  // Önce okey-dışı taşları dene (okey atarak bitiş daha değerliyse onu tercih etmek
  // yerine v1'de garanti bitişi seçiyoruz; okey atılırsa zaten daha çok puan).
  const tryOrder = [...p.hand].sort((a, b) =>
    (isOkeyTile(b, state.okeyColor, state.okeyRank) ? 1 : 0) - (isOkeyTile(a, state.okeyColor, state.okeyRank) ? 1 : 0));
  for (const t of tryOrder) {
    const remaining = p.hand.filter((x) => x.id !== t.id);
    if (canFinishMelds(remaining, state.okeyColor, state.okeyRank) ||
        canFinishPairs(remaining, state.okeyColor, state.okeyRank)) return t.id;
  }
  return null;
}

/** Botun tam turu: (gerekirse çek) → bitir ya da at. */
export function playOkeyBotTurn(state: OkeyGameState, seat: number): void {
  if (state.elEnded || state.matchEnded || state.turn !== seat) return;
  const p = state.players[seat]!;

  if (state.phase === 'draw') {
    // Sol atık sinerjisi ortalamanın üstündeyse al, değilse ortadan çek.
    const leftTop = state.discards[(seat + 3) % 4]!.slice(-1)[0];
    let from: 'pile' | 'left' = 'pile';
    if (leftTop) {
      const gain = synergy(p.hand, leftTop, state);
      if (gain >= 6 || isOkeyTile(leftTop, state.okeyColor, state.okeyRank)) from = 'left';
    }
    applyOkeyMove(state, seat, { t: 'draw', from });
    if (state.elEnded) return;
  }

  if (state.rules.variant === 'yuzbir' && !p.hasOpened && state.phase === 'discard') {
    const pair = bestYuzbirPairOpening(state, seat);
    if (pair.count >= yuzbirPairOpeningMin(state))
      applyOkeyMove(state, seat, { t: 'openPairs', pairs: pair.pairs });
    else {
      const meld = bestYuzbirMeldOpening(state, seat);
      if (meld.points >= yuzbirOpeningMin(state))
        applyOkeyMove(state, seat, { t: 'open', groups: meld.groups });
    }
  }

  const finishId = findFinishTile(state, seat);
  if (finishId) { applyOkeyMove(state, seat, { t: 'finish', tileId: finishId }); return; }

  // En düşük sinerjili taşı at (okey 1000 → asla seçilmez).
  let worst: OkeyTile | null = null;
  let worstScore = Number.MAX_SAFE_INTEGER;
  for (const t of p.hand) {
    const s = synergy(p.hand, t, state);
    if (s < worstScore) { worstScore = s; worst = t; }
  }
  if (worst) applyOkeyMove(state, seat, { t: 'discard', tileId: worst.id });
}
