import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '..');
const unityRoot = path.resolve(repoRoot, '..', '51-unity');

function readFromRepo(rel: string): string {
  return readFileSync(path.resolve(repoRoot, rel), 'utf8');
}

function readFromUnity(rel: string): string {
  return readFileSync(path.resolve(unityRoot, rel), 'utf8');
}

describe('reconnect contract smoke', () => {
  const roomFiles = [
    ['51', 'server/src/rooms/EllibirRoom.ts'],
    ['okey', 'server/src/rooms/OkeyRoom.ts'],
    ['tavla', 'server/src/rooms/TavlaRoom.ts'],
  ] as const;

  it.each(roomFiles)('%s room keeps the 180s reserved-seat reconnect flow', (_game, file) => {
    const src = readFromRepo(file);

    expect(src).toContain('allowReconnection(client, 180)');
    expect(src).toContain('keepSeatPresence');
    expect(src).toContain('reconnectionToken');
    expect(src).toContain('_onLeave');
    expect(src).toContain('STALE leave');
  });

  const unityNetFiles = [
    ['51', 'Assets/Meta/Net/ColyseusNet.cs'],
    ['okey', 'Assets/Meta/Net/OkeyNet.cs'],
    ['tavla', 'Assets/Meta/Net/TavlaNet.cs'],
  ] as const;

  it.each(unityNetFiles)('%s Unity net keeps token reconnect and never silently downgrades to spectator', (_game, file) => {
    const src = readFromUnity(file);

    expect(src).toContain('public const double RECONNECT_WINDOW_SEC = 180');
    expect(src).toContain('const int RC_TRIES = 30');
    expect(src).toContain('RaiseNetStatus("rejoin_failed")');
    expect(src).toContain('ReconnectionToken');
    expect(src).toContain('PlayerPrefs.SetString(RC_ROOM');
    expect(src).toContain('PlayerPrefs.SetString(RC_TOKEN');
  });
});
