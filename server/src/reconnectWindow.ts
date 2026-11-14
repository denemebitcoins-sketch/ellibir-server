/** Düşen oyuncunun koltuğunu geri alabileceği süre (sn). Canlı: 180 (istemci RECONNECT_WINDOW_SEC ile aynı).
 *  Yalnız testler kısaltır: RECONNECT_WINDOW_SEC ortam değişkeni (1..180). */
export function reconnectWindowSec(): number {
  const n = Math.floor(Number(process.env.RECONNECT_WINDOW_SEC));
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : 180;
}
