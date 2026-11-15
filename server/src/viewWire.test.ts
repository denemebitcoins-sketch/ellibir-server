import { describe, expect, it, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { encodeViewZ, sendView, wantsCompressedViews, VIEW_Z_MIN_CHARS } from './viewWire';
import { clientViewFor } from './clientView';
import { createGame } from '../../packages/engine/src/game';

describe('view sıkıştırma (viewz)', () => {
  it('yalnız zv bildiren istemciyi sıkıştırılmış sayar', () => {
    expect(wantsCompressedViews({ zv: 1 })).toBe(true);
    expect(wantsCompressedViews({ zv: '1' })).toBe(true);
    expect(wantsCompressedViews({})).toBe(false);
    expect(wantsCompressedViews(undefined)).toBe(false);
  });
  it('eski istemciye her zaman JSON string view gönderir', () => {
    const c = { send: vi.fn(), sendBytes: vi.fn() };
    const json = JSON.stringify({ a: 'x'.repeat(2000) });
    sendView(c, json, false);
    expect(c.send).toHaveBeenCalledWith('view', json);
    expect(c.sendBytes).not.toHaveBeenCalled();
  });
  it('yeni istemciye deflate bytes gönderir ve birebir geri açılır', () => {
    const c = { send: vi.fn(), sendBytes: vi.fn() };
    const view = clientViewFor(createGame({ seed: 12345 }) as any, 0);
    const json = JSON.stringify(view);
    expect(json.length).toBeGreaterThan(VIEW_Z_MIN_CHARS);
    sendView(c, json, true);
    expect(c.send).not.toHaveBeenCalled();
    const [type, bytes] = c.sendBytes.mock.calls[0];
    expect(type).toBe('viewz');
    expect(inflateRawSync(bytes).toString('utf8')).toBe(json);
    const ratio = json.length / bytes.length;
    console.log(`[viewz] json=${json.length}B z=${bytes.length}B oran=${ratio.toFixed(1)}x`);
    expect(ratio).toBeGreaterThan(2.5);
  });
  it('kısa mesajı sıkıştırmadan gönderir', () => {
    const c = { send: vi.fn(), sendBytes: vi.fn() };
    sendView(c, '{"a":1}', true);
    expect(c.send).toHaveBeenCalledWith('view', '{"a":1}');
    expect(encodeViewZ('{"a":1}').length).toBeGreaterThan(0);
  });
});
