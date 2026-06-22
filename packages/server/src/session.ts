// NOT: motorun barrel'ı (index.ts `export *`) tsx/Node ESM altında namespace'i
// doldurmuyor; bu yüzden alt modüllerden DOĞRUDAN (relative) import ediyoruz.
// (İleride motora derleme/`exports` haritası eklenince barrel'a dönülebilir.)
import { createGame, applyMove, viewFor, startNextHand } from '../../engine/src/game';
import { HeuristicBot } from '../../engine/src/bot';
import type { GameState, Move, PlayerView } from '../../engine/src/types';
import type { RuleConfig } from '../../engine/src/rules';

export interface SessionOptions {
  seed?: number;
  /** Ağdaki gerçek oyuncuların oturduğu koltuklar (kalanlar bot). Vars.: [0]. */
  humanSeats?: number[];
  playerNames?: string[];
  rules?: RuleConfig;
}

/**
 * Otorite oyun oturumu — motoru (elli-bir-engine) sarar. AĞDAN BAĞIMSIZ:
 * Colyseus odası bunun ince bir kabuğudur. Bütün kural/doğrulama motordadır
 * (server-authoritative — istemci yalnız hamle önerir, motor kabul/ret eder).
 *
 * Bot koltukları otomatik oynar; insan koltuğunun sırası gelince DURUR ve
 * applyHumanMove() beklenir. El bitince handEnded'da durur (istemci skoru
 * görsün), continueNextHand() ile devam eder.
 *
 * Not: motor barrel'ından NAMESPACE import (E.*) kullanılır — `export *`
 * zincirindeki const'lar (DEFAULT_RULES) Node ESM'de adlı-import'la bağlanmaz.
 */
export class GameSession {
  private state: GameState;
  private readonly bots = new Map<number, HeuristicBot>();
  readonly humanSeats: ReadonlySet<number>;

  constructor(opts: SessionOptions = {}) {
    const playerCount = opts.rules?.playerCount ?? 4;
    const seats = Array.from({ length: playerCount }, (_, i) => i);
    this.humanSeats = new Set(opts.humanSeats ?? [0]);
    const botSeats = seats.filter((s) => !this.humanSeats.has(s));
    for (const s of botSeats) {
      this.bots.set(s, new HeuristicBot({ difficulty: 'normal', profile: 'dengeli' }));
    }
    this.state = createGame({
      seed: opts.seed,
      rules: opts.rules,
      botSeats,
      playerNames: opts.playerNames,
    });
    this.settle();
  }

  get phase(): GameState['phase'] {
    return this.state.phase;
  }
  get currentSeat(): number {
    return this.state.currentSeat;
  }
  get raw(): GameState {
    return this.state;
  }

  /** Bir koltuğun gördüğü açık-bilgi görünümü (istemciye bu gönderilir). */
  view(seat: number): PlayerView {
    return viewFor(this.state, seat);
  }

  /** Bir insan koltuğunun sırası bekleniyor mu? */
  awaitingHuman(): boolean {
    return (
      (this.state.phase === 'draw' || this.state.phase === 'action') &&
      this.humanSeats.has(this.state.currentSeat)
    );
  }

  /**
   * İnsan hamlesini uygula. Motor geçersizse MoveError fırlatır (otorite ret).
   * Ardından sonraki bot sıralarını otomatik oynatır.
   */
  applyHumanMove(seat: number, move: Move): void {
    if (!this.humanSeats.has(seat)) throw new Error(`Koltuk ${seat} insan değil`);
    if (this.state.currentSeat !== seat) throw new Error('Sıra sizde değil');
    if (this.state.phase !== 'draw' && this.state.phase !== 'action') {
      throw new Error(`Bu fazda hamle yapılamaz: ${this.state.phase}`);
    }
    this.state = applyMove(this.state, move);
    this.settle();
  }

  /** El sonu skor ekranından sonra sonraki eli başlat. */
  continueNextHand(): void {
    if (this.state.phase === 'handEnded') {
      this.state = startNextHand(this.state);
      this.settle();
    }
  }

  /** Bot sıralarını oynat; insan sırası / el sonu / maç sonunda durur. */
  private settle(): void {
    let guard = 0;
    while (this.state.phase === 'draw' || this.state.phase === 'action') {
      if (++guard > 10000) throw new Error('settle döngü koruması aşıldı');
      const seat = this.state.currentSeat;
      const bot = this.bots.get(seat);
      if (!bot) break; // insan koltuğu — dur ve hamle bekle
      const move = bot.nextMove(viewFor(this.state, seat));
      this.state = applyMove(this.state, move);
    }
  }
}
