import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payloadWithinLimit, RoomMessageGuard } from './roomMessageGuard';

describe('room message abuse guard', () => {
  it('limits each session and channel independently and resets after the window', () => {
    const guard = new RoomMessageGuard();
    expect(guard.allow('a', 'cmd', 2, 1000, 10)).toBe(true);
    expect(guard.allow('a', 'cmd', 2, 1000, 20)).toBe(true);
    expect(guard.allow('a', 'cmd', 2, 1000, 30)).toBe(false);
    expect(guard.allow('a', 'chat', 1, 1000, 30)).toBe(true);
    expect(guard.allow('b', 'cmd', 2, 1000, 30)).toBe(true);
    expect(guard.allow('a', 'cmd', 2, 1000, 1010)).toBe(true);
  });

  it('forgets all buckets for a departed session and clears the room', () => {
    const guard = new RoomMessageGuard();
    guard.allow('a', 'cmd', 1, 1000, 1);
    guard.allow('a', 'chat', 1, 1000, 1);
    guard.allow('b', 'cmd', 1, 1000, 1);
    expect(guard.size).toBe(3);
    guard.forget('a');
    expect(guard.size).toBe(1);
    guard.clear();
    expect(guard.size).toBe(0);
  });

  it('rejects oversized and unserializable payloads', () => {
    expect(payloadWithinLimit('1234', 4)).toBe(true);
    expect(payloadWithinLimit('12345', 4)).toBe(false);
    expect(payloadWithinLimit({ t: 'roll' }, 64)).toBe(true);
    const circular: any = {}; circular.self = circular;
    expect(payloadWithinLimit(circular, 64)).toBe(false);
  });

  const repoRoot = path.resolve(process.cwd(), '..');
  const rooms = ['EllibirRoom.ts', 'OkeyRoom.ts', 'TavlaRoom.ts'];

  it.each(rooms)('%s applies command, chat and gift abuse controls', (name) => {
    const src = readFileSync(path.resolve(repoRoot, 'server/src/rooms', name), 'utf8');
    expect(src).toContain('new RoomMessageGuard()');
    expect(src).toContain("payloadWithinLimit(raw, 16 * 1024)");
    expect(src).toContain('payloadWithinLimit(raw, 1024)');
    expect(src).toContain('payloadWithinLimit(raw, 256)');
    expect(src).toContain('payloadWithinLimit(raw, 2048)');
    if (name !== 'TavlaRoom.ts') expect(src).toContain('payloadWithinLimit(raw, 512)');
    expect(src).toContain("this.messageGuard.allow(client.sessionId, 'cmd'");
    expect(src).toContain("this.messageGuard.allow(client.sessionId, 'chat'");
    expect(src).toContain("this.messageGuard.allow(client.sessionId, 'gift'");
    expect(src).toContain('this.giftBusy.has(client.sessionId)');
    expect(src).toContain('this.messageGuard.forget(sessionId)');
    expect(src).toContain('this.messageGuard.clear()');
    expect(src).not.toContain(".catch(() => this.broadcast('chat'");
  });

  it('serializes tavla rematch charging/start', () => {
    const src = readFileSync(path.resolve(repoRoot, 'server/src/rooms/TavlaRoom.ts'), 'utf8');
    expect(src).toContain('private rematchStarting = false;');
    expect(src).toMatch(/if \(!this\.game\?\.matchEnded \|\| this\.rematchStarting\) return;/);
    expect(src).toMatch(/this\.rematchStarting = true;[\s\S]*?finally\s*\{[\s\S]*?this\.rematchStarting = false;/);
  });

  it('starts a 51 rematch only after explicit seated-player votes and settlement', () => {
    const src = readFileSync(path.resolve(repoRoot, 'server/src/rooms/EllibirRoom.ts'), 'utf8');
    expect(src).toContain('private rematchVotes = new Set<number>();');
    expect(src).toContain("cmd?.t === 'ready' || cmd?.t === 'rematch'");
    expect(src).toContain('required.every((s) => this.rematchVotes.has(s))');
    expect(src).toContain('if (this.settlePromise) await this.settlePromise;');
    expect(src).toContain("if (this.game?.phase === 'matchEnded') void this.maybeStartRematch();");
    expect(src).not.toContain('setTimeout(() => this.newMatch()');
  });

  it('charges entry commission into canak at game start, then skips duplicate settlement canak', () => {
    const contracts = [
      ['TavlaRoom.ts', "'tavla'"],
      ['OkeyRoom.ts', "'okey'"],
      ['EllibirRoom.ts', "'51'"],
    ] as const;

    for (const [name, game] of contracts) {
      const src = readFileSync(path.resolve(repoRoot, 'server/src/rooms', name), 'utf8');
      expect(src).toContain('private entryCanakCharged = false');
      expect(src).toContain('entryHouseAmount({');
      expect(src).toContain(`deductEntry(entryUsers, this.bet, ${game}, entryHouse)`);
      expect(src).toContain('this.entryCanakCharged = true;');
      expect(src).toContain('entryHousePaid: this.entryCanakCharged');
    }
  });
});
