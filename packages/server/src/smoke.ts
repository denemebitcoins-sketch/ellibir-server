import { HeuristicBot } from '../../engine/src/bot';
import { GameSession } from './session.js';

/**
 * Ağsız duman testi: GameSession'ı (otorite oturum) bir maç boyunca sürer.
 * İnsan koltuğunu bir bot taklit eder (istemci yerine) — böylece applyHumanMove
 * + continueNextHand API'si uçtan uca doğrulanır. Hamleler MOTOR tarafından
 * doğrulanır; oturum kabuğu sadece sı/faz akışını yönetir.
 */
function run(seed: number): void {
  const session = new GameSession({ seed, humanSeats: [0] });
  const client = new HeuristicBot({ difficulty: 'zor', profile: 'avci' });

  let guard = 0;
  let humanMoves = 0;
  while (session.phase !== 'matchEnded') {
    if (++guard > 40000) throw new Error(`Maç bitmedi (seed ${seed})`);

    if (session.phase === 'handEnded') {
      session.continueNextHand();
      continue;
    }

    // settle() yalnız insan sırasında durur.
    const seat = session.currentSeat;
    if (!session.awaitingHuman() || seat !== 0) {
      throw new Error(`Beklenmeyen duraklama: faz=${session.phase} koltuk=${seat}`);
    }
    const move = client.nextMove(session.view(seat));
    session.applyHumanMove(seat, move);
    humanMoves++;
  }

  const winner = session.raw.matchWinnerSeat;
  if (winner === null) throw new Error(`Maç bitti ama kazanan yok (seed ${seed})`);
  const scores = session.raw.players.map((p) => p.totalScore);
  const min = Math.min(...scores);
  if (scores[winner] !== min) {
    throw new Error(`Kazanan en düşük skor değil (seed ${seed}): ${JSON.stringify(scores)}`);
  }
  console.log(
    `seed ${seed}: OK · kazanan koltuk ${winner} · skorlar [${scores.join(', ')}] · insan hamlesi ${humanMoves}`,
  );
}

const seeds = [1234, 99, 7, 50050, 313, 8888, 1, 42];
for (const s of seeds) run(s);
console.log(`\n✅ ${seeds.length} maç GameSession üzerinden çökmesiz tamamlandı (otorite akış doğrulandı).`);
