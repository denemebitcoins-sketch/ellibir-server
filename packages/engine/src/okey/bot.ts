import type { OkeyGameState } from './game';
import {
  applyOkeyMove,
  bestYuzbirMeldOpening,
  bestYuzbirPairOpening,
  canTakeYuzbirLeft,
  canExtendYuzbirMeldWithTile,
  isYuzbirIslekDiscard,
  canLayAllRemaining,
  yuzbirOpeningMin,
  yuzbirPairOpeningMin,
} from './game';
import type { OkeyTile } from './types';
import { identityOf, isOkeyTile } from './deck';
import { bestGrouping, canFinishMelds, canFinishPairs, type OkeyGroupingCache } from './melds';
import { OkeyBotKnowledge } from './knowledge';

/**
 * Public-information policy, mirrored in Unity OkeyBot.cs.
 * Evaluate the hand AFTER discarding; a left draw must improve that hand.
 * 101 uses the rule engine's own extension/penalty checks, not a second rule set.
 */

function synergy(hand: readonly OkeyTile[], tile: OkeyTile, state: OkeyGameState, knowledge: OkeyBotKnowledge): number {
  const id = identityOf(tile, state.okeyColor, state.okeyRank);
  if (id.wild) return 1000; // okey elde tutulur
  let score = 0;
  for (const other of hand) {
    if (other.id === tile.id) continue;
    score += knowledge.connection(tile, other);
  }
  return score;
}

function handValue(hand: readonly OkeyTile[], state: OkeyGameState, cache: OkeyGroupingCache, knowledge: OkeyBotKnowledge): number {
  const groups = bestGrouping([...hand], state.okeyColor, state.okeyRank, state.rules.variant !== 'yuzbir', false, cache);
  const covered = new Set(groups.flat().map(t => t.id));
  const loose = hand.filter(t => !covered.has(t.id));
  let score = covered.size * 1000 + loose.reduce((sum, t) => sum + synergy(loose, t, state, knowledge), 0);
  // Pair and meld plans are alternatives, never overlapping contributions.
  if (state.rules.variant !== 'yuzbir') {
    const counts = new Map<string, number>();
    let wilds = 0;
    for (const t of hand) {
      const id = identityOf(t, state.okeyColor, state.okeyRank);
      if (id.wild) wilds++;
      else counts.set(`${id.color}${id.rank}`, (counts.get(`${id.color}${id.rank}`) ?? 0) + 1);
    }
    let pairs = 0, singles = 0;
    for (const count of counts.values()) { pairs += Math.floor(count / 2); singles += count % 2; }
    const matched = Math.min(singles, wilds);
    pairs += matched + Math.floor((wilds - matched) / 2);
    score = Math.max(score, pairs * 2000);
  }
  if (state.rules.variant === 'banko' || state.rules.variant === 'yuzbir')
    score -= loose.reduce((sum, t) => sum + identityOf(t, state.okeyColor, state.okeyRank).rank, 0);
  return score;
}

function chooseDiscard(hand: readonly OkeyTile[], state: OkeyGameState, cache: OkeyGroupingCache, knowledge: OkeyBotKnowledge): OkeyTile | null {
  let choices = hand.filter(t => !isOkeyTile(t, state.okeyColor, state.okeyRank));
  if (!choices.length) choices = [...hand];
  if (state.rules.variant === 'yuzbir' && (state.rules.yuzbir.islekDiscardPenalty ?? 101) > 0) {
    const safe = choices.filter(t => !isYuzbirIslekDiscard(state, t));
    if (safe.length) choices = safe;
  }
  let best: OkeyTile | null = null, bestScore = -Infinity;
  for (const tile of choices) {
    const score = handValue(hand.filter(t => t.id !== tile.id), state, cache, knowledge) - knowledge.discardRisk(tile);
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  return best;
}

export function chooseOkeyBotDiscard(state: OkeyGameState, seat: number, cache: OkeyGroupingCache = new Map()): OkeyTile | null {
  const hand = state.players[seat]!.hand;
  return chooseDiscard(hand, state, cache, new OkeyBotKnowledge(state, seat, hand));
}

export function shouldTakeOkeyLeft(state: OkeyGameState, seat: number, tile: OkeyTile, cache: OkeyGroupingCache = new Map()): boolean {
  if (state.rules.variant === 'yuzbir') return canTakeYuzbirLeft(state, seat, tile);
  const hand = state.players[seat]!.hand;
  const augmented = [...hand, tile];
  const knowledge = new OkeyBotKnowledge(state, seat, augmented);
  const discard = chooseDiscard(augmented, state, cache, knowledge);
  if (!discard) return false;
  const incoming = identityOf(tile, state.okeyColor, state.okeyRank);
  const outgoing = identityOf(discard, state.okeyColor, state.okeyRank);
  if (incoming.wild === outgoing.wild && incoming.color === outgoing.color && incoming.rank === outgoing.rank)
    return false;
  return handValue(augmented.filter(t => t.id !== discard.id), state, cache, knowledge) > handValue(hand, state, cache, knowledge);
}

function tryOpenYuzbir(state: OkeyGameState, seat: number, cache: OkeyGroupingCache): boolean {
  const p = state.players[seat]!;
  const pending = p.yuzbirPendingLeftTileId;
  const usable = (groups: string[][]) => groups.length > 0 &&
    groups.reduce((sum, g) => sum + g.length, 0) < p.hand.length &&
    (!pending || groups.some(g => g.includes(pending)));
  const pair = bestYuzbirPairOpening(state, seat);
  if ((!p.hasOpened || p.openMode === 'pairs' || state.openMelds.some(m => m.kind === 'pair')) &&
      (p.hasOpened || pair.count >= yuzbirPairOpeningMin(state)) && usable(pair.pairs) &&
      applyOkeyMove(state, seat, { t: 'openPairs', pairs: pair.pairs }).ok) return true;
  if (p.openMode === 'pairs') return false;
  const meld = bestYuzbirMeldOpening(state, seat, cache);
  return (p.hasOpened || meld.points >= yuzbirOpeningMin(state)) && usable(meld.groups) &&
    applyOkeyMove(state, seat, { t: 'open', groups: meld.groups }).ok;
}

function tryExtendYuzbir(state: OkeyGameState, seat: number): boolean {
  const p = state.players[seat]!;
  if (!p.hasOpened || p.hand.length <= 1) return false;
  const pending = p.yuzbirPendingLeftTileId;
  // Natural tiles first: rescue a joker before spending one on an endpoint.
  const candidates = [...p.hand].sort((a, b) =>
    Number(isOkeyTile(a, state.okeyColor, state.okeyRank)) - Number(isOkeyTile(b, state.okeyColor, state.okeyRank)));
  for (const tile of candidates) {
    if (pending && tile.id !== pending) continue;
    for (const meld of state.openMelds) {
      if (!canExtendYuzbirMeldWithTile(state, meld, tile)) continue;
      if (applyOkeyMove(state, seat, { t: 'extend', meldId: meld.id, tileId: tile.id }).ok) return true;
    }
  }
  return false;
}

/** Find a legal complete-hand finish before spending a turn opening or discarding. */
export function findOkeyBotFinish(state: OkeyGameState, seat: number, cache: OkeyGroupingCache = new Map()): string | null {
  const p = state.players[seat]!;
  const yuzbir = state.rules.variant === 'yuzbir';
  if (yuzbir ? !!p.yuzbirPendingLeftTileId || p.hand.length <= 1 : p.hand.length !== 15) return null;
  const canMeld = yuzbir && (!p.hasOpened || p.openMode !== 'pairs') &&
    bestGrouping(p.hand, state.okeyColor, state.okeyRank, false, false, cache).flat().length >= p.hand.length - 1;
  const canPair = yuzbir && (!p.hasOpened || p.openMode === 'pairs') && p.hand.length % 2 === 1 &&
    bestYuzbirPairOpening(state, seat).count * 2 >= p.hand.length - 1;
  if (yuzbir && !canMeld && !canPair) return null;
  // Prefer an okey finish when both complete-hand options are available.
  const tryOrder = [...p.hand].sort((a, b) =>
    (isOkeyTile(b, state.okeyColor, state.okeyRank) ? 1 : 0) - (isOkeyTile(a, state.okeyColor, state.okeyRank) ? 1 : 0));
  for (const t of tryOrder) {
    const remaining = p.hand.filter((x) => x.id !== t.id);
    if (yuzbir) {
      const melds = canMeld &&
        bestGrouping(remaining, state.okeyColor, state.okeyRank, false, false, cache).flat().length === remaining.length;
      const pairs = canPair && canLayAllRemaining(remaining, state, 'pairs');
      if (melds || pairs) return t.id;
      continue;
    }
    if (canFinishMelds(remaining, state.okeyColor, state.okeyRank, state.rules.variant !== 'yuzbir') ||
        canFinishPairs(remaining, state.okeyColor, state.okeyRank)) return t.id;
  }
  return null;
}

/** Botun tam turu: (gerekirse çek) → bitir ya da at. */
export function playOkeyBotTurn(state: OkeyGameState, seat: number): void {
  if (state.elEnded || state.matchEnded || state.turn !== seat) return;
  const p = state.players[seat]!;
  const cache: OkeyGroupingCache = new Map();

  if (state.phase === 'draw') {
    const leftTop = state.discards[(seat + 3) % 4]!.slice(-1)[0];
    let from: 'pile' | 'left' = 'pile';
    if (leftTop) {
      if (shouldTakeOkeyLeft(state, seat, leftTop, cache)) from = 'left';
    }
    const draw = applyOkeyMove(state, seat, { t: 'draw', from });
    if (!draw.ok && from === 'left' && state.phase === 'draw')
      applyOkeyMove(state, seat, { t: 'draw', from: 'pile' });
    if (state.elEnded) return;
    if ((state.phase as string) !== 'discard') return;
  }

  if (state.rules.variant === 'yuzbir' && state.phase === 'discard') {
    if (p.yuzbirPendingLeftTileId && !tryOpenYuzbir(state, seat, cache) && !tryExtendYuzbir(state, seat)) {
      if (!applyOkeyMove(state, seat, { t: 'returnLeft' }).ok) return;
      if (!applyOkeyMove(state, seat, { t: 'draw', from: 'pile' }).ok || state.elEnded) return;
    }
    const ready = findOkeyBotFinish(state, seat, cache);
    if (ready && applyOkeyMove(state, seat, { t: 'finish', tileId: ready }).ok) return;
    // Bound joker replacement chains as well as ordinary (hand-shrinking) actions.
    for (let actions = 0; actions < 32 && p.hand.length > 1; actions++)
      if (!tryOpenYuzbir(state, seat, cache) && !tryExtendYuzbir(state, seat)) break;
  }

  const finishId = findOkeyBotFinish(state, seat, cache);
  if (finishId && applyOkeyMove(state, seat, { t: 'finish', tileId: finishId }).ok) return;

  const worst = chooseOkeyBotDiscard(state, seat, cache);
  if (worst) applyOkeyMove(state, seat, { t: 'discard', tileId: worst.id });
}
