import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '..');
const unityRoot = path.resolve(repoRoot, '..', '51-unity');

function serverSource(rel: string): string {
  return readFileSync(path.resolve(repoRoot, rel), 'utf8');
}

function unitySource(rel: string): string {
  return readFileSync(path.resolve(unityRoot, rel), 'utf8');
}

describe('admin online bot-fill contract', () => {
  const rooms = [
    ['51', 'server/src/rooms/EllibirRoom.ts'],
    ['okey', 'server/src/rooms/OkeyRoom.ts'],
    ['tavla', 'server/src/rooms/TavlaRoom.ts'],
  ] as const;

  it.each(rooms)('%s accepts bot fill only from a seated admin before the match starts', (_game, file) => {
    const src = serverSource(file);

    expect(src).toContain("this.onMessage('adminAddBot'");
    expect(src).toContain("this.onMessage('adminRemoveBot'");
    expect(src).toContain("this.seatMeta.get(seat)?.role !== 'admin'");
    expect(src).toContain("reason: 'oyun başladı'");
    expect(src).toContain('this.adminBots.set(target');
    expect(src).toContain('this.startGameIfReady()');
  });

  const unityClients = [
    ['51', 'Assets/Meta/Net/ColyseusNet.cs', 'Assets/Scripts/GameClient.cs'],
    ['okey', 'Assets/Meta/Net/OkeyNet.cs', 'Assets/Meta/OkeyGameClient.cs'],
    ['tavla', 'Assets/Meta/Net/TavlaNet.cs', 'Assets/Meta/TavlaGameClient.cs'],
  ] as const;

  it.each(unityClients)('%s exposes + BOT only through the admin network channel', (_game, netFile, uiFile) => {
    const net = unitySource(netFile);
    const ui = unitySource(uiFile);

    expect(net).toContain('AdminAddBot(int seat)');
    expect(net).toContain('SendAdminBot("adminAddBot", seat)');
    expect(net).toContain('MyRole() != "admin"');
    expect(ui).toContain('adminBotTools');
    expect(ui).toContain('"+ BOT"');
    expect(ui).toContain('AdminAddBot(targetSeat)');
  });
});
