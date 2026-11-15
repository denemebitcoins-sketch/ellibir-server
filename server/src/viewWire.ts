import { deflateRawSync } from 'node:zlib';

/**
 * Masa görünümü (view) gönderimi. Yeni istemciler katılırken `zv: 1` bildirir; onlara view JSON'u
 * raw-deflate ile sıkıştırılıp 'viewz' (bytes) olarak gider (~4-6 kat küçük). Eski istemciler
 * (zv yok) hiçbir değişiklik görmeden 'view' (JSON string) almaya devam eder.
 */
export const VIEW_Z_MIN_CHARS = 256;

export function wantsCompressedViews(options: any): boolean {
  const v = options?.zv;
  return v === 1 || v === '1' || v === true;
}

export function encodeViewZ(json: string): Buffer {
  return deflateRawSync(Buffer.from(json, 'utf8'), { level: 6 });
}

export function sendView(client: { send: (t: string, m: any) => void; sendBytes?: (t: string, b: Buffer) => void },
                         json: string, compressed: boolean): void {
  if (compressed && json.length >= VIEW_Z_MIN_CHARS && typeof client.sendBytes === 'function') {
    client.sendBytes('viewz', encodeViewZ(json));
    return;
  }
  client.send('view', json);
}
