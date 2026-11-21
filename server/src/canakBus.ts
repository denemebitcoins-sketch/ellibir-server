// 21.11 ÇANAK HABERİ: patlama anında O AN AÇIK OLAN TÜM MASALARA (Okey/Tavla/51 odaları) anlık haber.
// Lobide/menüde olan oyunculara gitmez (kullanıcı kararı). Tek sunucu süreci içinde olay yolu.
import { EventEmitter } from 'events';

export interface CanakNews {
  game: string;      // '51' | 'okey' | 'tavla' (çanak anahtarı)
  gameLbl: string;   // görünen ad
  uid: string;       // patlatan
  name: string;
  amount: number;
  postId: number;    // Kahvehane resmi gönderisi (0 = yok/bakımda) → "Tebrik et" bunu beğenir
}

export const canakBus = new EventEmitter();
canakBus.setMaxListeners(0); // her oda bir dinleyici

/** Odada kullanılacak kısa yardımcı: dinleyiciyi bağlar, çözmek için fonksiyon döner. */
export function onCanakNews(fn: (n: CanakNews) => void): () => void {
  const h = (n: CanakNews) => { try { fn(n); } catch (e: any) { console.error('[canakBus] dinleyici:', e?.message); } };
  canakBus.on('burst', h);
  return () => canakBus.off('burst', h);
}

/** Sayıyı Türkçe binlik ayraçla yazar (1250000 → 1.250.000). */
export function fmtChips(n: number): string {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
