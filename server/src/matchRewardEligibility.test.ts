import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allHumanStartingRoster } from './matchRewardEligibility';
import { EllibirRoom } from './rooms/EllibirRoom';
import { IhaleRoom } from './rooms/IhaleRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';
import { DEFAULT_RULES } from '../../packages/engine/src/rules';
import { DEFAULT_OKEY_RULES } from '../../packages/engine/src/okey';
import { DEFAULT_TAVLA_RULES } from '../../packages/engine/src/tavla';
import { deductEntry, canakBurst, settleMatch } from './supabase';

vi.mock('./supabase', async importOriginal => ({
  ...await importOriginal<typeof import('./supabase')>(),
  deductEntry: vi.fn(async () => ({ ok: true, failedSeats: [] })),
  canakBurst: vi.fn(async () => 0),
  settleMatch: vi.fn(async () => []),
}));

const cases = [
  { name: '51', Type: EllibirRoom, count: 4, rules: DEFAULT_RULES, game: '51' },
  { name: 'Ihale', Type: IhaleRoom, count: 4, rules: DEFAULT_RULES, game: 'ihale' },
  ...(['duz', 'banko', 'yuzbir'] as const).map(variant => ({
    name: variant, Type: OkeyRoom, count: 4, rules: { ...DEFAULT_OKEY_RULES, variant }, game: 'okey',
  })),
  { name: 'Tavla', Type: TavlaRoom, count: 2, rules: DEFAULT_TAVLA_RULES, game: 'tavla' },
];

function makeRoom(c: typeof cases[number], bots: number, oneHand = false): any {
  const r: any = new c.Type();
  r.cfg = { seed: 19, playerNames: ['Arzu', 'Mithat', 'Samet', 'Zeynep'], botSeats: [],
    rules: { ...c.rules, totalHands: oneHand ? 1 : 3, totalEls: oneHand ? 1 : 3 } };
  r.bet = 1000;
  r.humanSeats = Array.from({ length: c.count }, (_, i) => i);
  for (const seat of r.humanSeats) {
    r.seatNames.set(seat, r.cfg.playerNames[seat]);
    if (seat >= c.count - bots) r.adminBots.set(seat, r.cfg.playerNames[seat]);
    else { r.seats.set(`session-${seat}`, seat); r.seatUsers.set(seat, `human-${seat}`); }
  }
  for (const method of ['pushViews', 'runEngine', 'afterChange', 'enterBankoPhase', 'refreshCanak', 'broadcast'])
    r[method] = vi.fn();
  return r;
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('immutable starting roster reward policy', () => {
  it('requires distinct authenticated identities at every seat, never names', () => {
    const users = new Map([[0, 'B_actual-human'], [1, 'another-human']]);
    expect(allHumanStartingRoster(2, users, [])).toBe(true);
    expect(allHumanStartingRoster(2, users, [1])).toBe(false);
    expect(allHumanStartingRoster(2, new Map([[0, 'same'], [1, 'same']]), [])).toBe(false);
    expect(allHumanStartingRoster(2, new Map([[0, 'a'], [2, 'b']]), [])).toBe(false);
    expect(allHumanStartingRoster(2, new Map([[0, 'a'], [1, ' ']]), [])).toBe(false);
    expect(allHumanStartingRoster(4, users, [])).toBe(false);
    expect(allHumanStartingRoster(0, new Map(), [])).toBe(false);
  });

  describe.each(cases)('$name room', c => {
    it.each([0, 1, c.count])('captures %i starting bots before entry, independent of visible names', async bots => {
      const r = makeRoom(c, bots);
      expect(r.matchRewardsEligible).toBe(false);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      expect(r.game).toBeTruthy();
      expect(r.matchRewardsEligible).toBe(bots === 0);
      expect(deductEntry).toHaveBeenCalledWith(expect.any(Map), 1000, bots === 0 ? c.game : undefined, c.count * 100);
      expect(r.cfg.botSeats).toHaveLength(bots);
      // Later population swaps/reconnect metadata cannot promote an ineligible match.
      r.adminBots.clear();
      r.seatUsers.clear();
      expect(r.matchRewardsEligible).toBe(bots === 0);
    });

    it('resets eligibility for the rematch and captures its changed roster', async () => {
      const r = makeRoom(c, 0);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      r.seats.delete(`session-${c.count - 1}`);
      r.seatUsers.delete(c.count - 1);
      r.adminBots.set(c.count - 1, 'Mithat');
      r.prepareRematchCountdown();
      expect(r.matchRewardsEligible).toBe(false);
      await vi.advanceTimersByTimeAsync(7000);
      expect(r.game).toBeTruthy();
      expect(r.matchRewardsEligible).toBe(false);
      expect(vi.mocked(deductEntry).mock.calls.at(-1)?.[2]).toBeUndefined();
    });

    it('does not grant eligibility or create a match after an entry failure', async () => {
      vi.mocked(deductEntry).mockResolvedValueOnce({ ok: false, failedSeats: [0] });
      const r = makeRoom(c, 0);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      expect(r.game).toBeFalsy();
      expect(r.matchRewardsEligible).toBe(false);
    });

    it.each([false, true])('gates jackpot burst after takeover, initially eligible=%s', async eligible => {
      const r = makeRoom(c, eligible ? 0 : 1);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      if (r.setAbandoned) r.setAbandoned(1, true); else r.abandoned.add(1);
      r.game.lastHandResult = { winnerSeat: 0, okeyFinish: true, pairFinish: false };
      r.game.elWinner = 0; r.game.finishKind = 'okey';
      r.game.gameWinner = 0; r.game.mars = true;
      vi.spyOn(Math, 'random').mockReturnValue(0);
      r.maybeCanak();
      expect(canakBurst).toHaveBeenCalledTimes(eligible && c.name !== 'Ihale' ? 1 : 0);
      expect(r.matchRewardsEligible).toBe(eligible);
    });

    it.each([false, true])('passes captured eligibility into settlement, eligible=%s', async eligible => {
      const r = makeRoom(c, eligible ? 0 : 1);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      if (r.setAbandoned) r.setAbandoned(1, true); else r.abandoned.add(1);
      r.game.matchEnded = true; r.game.phase = 'matchEnded';
      r.game.matchWinnerSeat = 0; r.game.matchWinner = 0;
      if (r.checkHandEnd) r.checkHandEnd(); else r.settleOnce();
      await r.settlePromise;
      expect(settleMatch).toHaveBeenCalledWith(expect.objectContaining({ matchRewardsEligible: eligible }));
    });

    if (c.name !== 'Tavla') it('still defers one-hand entry contributions for an all-human roster', async () => {
      const r = makeRoom(c, 0, true);
      r.startGameIfReady();
      await vi.advanceTimersByTimeAsync(7000);
      expect(r.matchRewardsEligible).toBe(true);
      expect(r.entryCanakCharged).toBe(false);
      expect(vi.mocked(deductEntry).mock.calls.at(-1)?.[2]).toBeUndefined();
    });
  });
});
