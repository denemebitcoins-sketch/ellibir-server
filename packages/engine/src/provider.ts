import type { Move, PlayerView } from './types';

/**
 * Rakip hamle sağlayıcı soyutlaması.
 * Botlar bugün, Supabase Realtime oyuncuları yarın bu arayüzün arkasında durur;
 * UI yalnızca bu arayüzü bilir. Sağlayıcı her çağrıda TEK hamle döndürür;
 * oyun döngüsü sıra el değiştirene kadar tekrar çağırır.
 */
export interface MoveProvider {
  nextMove(view: PlayerView): Move | Promise<Move>;
}
