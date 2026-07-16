import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const room = (name: string) => readFileSync(resolve(__dirname, `rooms/${name}`), 'utf8');

describe('post-match ready contract', () => {
  it.each(['EllibirRoom.ts', 'OkeyRoom.ts', 'TavlaRoom.ts'])('%s waits for explicit human readiness', (name) => {
    const source = room(name);
    expect(source).toMatch(/rematchVotes/);
    expect(source).toMatch(/required\.every\(\(.*\) => this\.rematchVotes\.has/);
    expect(source).toMatch(/seat_left_before_(?:new_match|rematch)/);
  });

  it('Okey and Tavla expose the new ready event while retaining old clients', () => {
    for (const name of ['OkeyRoom.ts', 'TavlaRoom.ts']) {
      const source = room(name);
      expect(source).toMatch(/onMessage\('ready'/);
      expect(source).toMatch(/onMessage\('rematch'/);
    }
  });
});
