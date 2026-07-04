import { describe, it, expect } from 'vitest';
import {
  createTavlaGame, startNextGame, applyTavlaMove, autoTavlaMove, legalSteps, stepFor,
  playTavlaBotTurn, TavlaGameState,
} from '../src/tavla';

function totalCheckers(st: TavlaGameState, pl: number): number {
  let n = st.bar[pl]! + st.off[pl]!;
  for (let i = 0; i < 24; i++) {
    const c = pl === 0 ? st.points[i]! : -st.points[i]!;
    if (c > 0) n += c;
  }
  return n;
}

function fresh(seed = 42) {
  return createTavlaGame({ seed, names: ['Ben', 'Bot'], botSeats: [1] });
}

describe('tavla kurulum', () => {
  it('standart diziliş: her oyuncunun 15 pulu, doğru haneler', () => {
    const st = fresh();
    expect(totalCheckers(st, 0)).toBe(15);
    expect(totalCheckers(st, 1)).toBe(15);
    expect(st.points[23]).toBe(2);
    expect(st.points[12]).toBe(5);
    expect(st.points[7]).toBe(3);
    expect(st.points[5]).toBe(5);
    expect(st.points[0]).toBe(-2);
    expect(st.points[11]).toBe(-5);
    expect(st.points[16]).toBe(-3);
    expect(st.points[18]).toBe(-5);
  });

  it('başlama atışı: büyük atan başlar, eşitlik yok', () => {
    for (let s = 1; s < 30; s++) {
      const st = fresh(s);
      expect(st.openRoll[0]).not.toBe(st.openRoll[1]);
      expect(st.turn).toBe(st.openRoll[0]! > st.openRoll[1]! ? 0 : 1);
      expect(st.phase).toBe('roll');
    }
  });
});

describe('zar ve hamle', () => {
  it('çift zar 4 hamle verir, farklı zar 2', () => {
    let sawDouble = false, sawPlain = false;
    for (let s = 1; s < 60 && !(sawDouble && sawPlain); s++) {
      const st = fresh(s);
      const r = applyTavlaMove(st, st.turn, { t: 'roll' });
      expect(r.ok).toBe(true);
      if (st.phase !== 'move') continue; // hamlesiz atış (açılışta olmaz ama güvenli)
      if (st.dice[0] === st.dice[1]) { expect(st.movesLeft.length).toBe(4); sawDouble = true; }
      else { expect(st.movesLeft.length).toBe(2); sawPlain = true; }
    }
    expect(sawDouble && sawPlain).toBe(true);
  });

  it('sıra dışı hamle reddedilir', () => {
    const st = fresh();
    const other = 1 - st.turn;
    expect(applyTavlaMove(st, other, { t: 'roll' }).ok).toBe(false);
  });

  it('kapı (2+ rakip) geçilmez', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [5];
    // 23'ten 5 ile 18'e: orada 5 rakip pulu var → kapı
    expect(stepFor(st, 0, 23, 5)).toBeNull();
  });

  it('tek rakip pulu KIRILIR ve bar\'a gider', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [3];
    st.points[20] = -1; // blot
    const s = stepFor(st, 0, 23, 3)!;
    expect(s.hit).toBe(true);
    const r = applyTavlaMove(st, 0, { t: 'move', from: 23, die: 3 });
    expect(r.ok).toBe(true);
    expect(st.bar[1]).toBe(1);
    expect(st.points[20]).toBe(1);
  });

  it('kırık varken önce giriş zorunlu; giriş rakip evinden', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [3, 5];
    st.bar[0] = 1;
    expect(stepFor(st, 0, 12, 3)).toBeNull();          // tahta hamlesi yasak
    const entry = stepFor(st, 0, -1, 3)!;               // 24-3 = 21. hane
    expect(entry.to).toBe(21);
    const blocked = stepFor(st, 0, -1, 6);              // 24-6 = 18: rakip 5 pul → kapı
    expect(blocked).toBeNull();
  });
});

function clearBoard(st: TavlaGameState) {
  st.points.fill(0); st.bar = [0, 0]; st.off = [0, 0];
}

describe('toplama (bear-off)', () => {
  it('tüm pullar evde değilse toplanamaz', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [6];
    clearBoard(st);
    st.points[5] = 14; st.points[10] = 1; st.off[1] = 0; st.points[0] += 0;
    expect(stepFor(st, 0, 5, 6)).toBeNull();
  });

  it('tam sayı ile toplanır; büyük zarla yalnız en gerideki toplanır', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [6, 3];
    clearBoard(st);
    st.points[4] = 2; st.points[2] = 3; st.points[1] = 10;
    const exact = stepFor(st, 0, 2, 3)!;                // 3 zar → 2. hane (idx2) tam
    expect(exact.bearOff).toBe(true);
    const over = stepFor(st, 0, 4, 6)!;                 // 6 zar, en geride idx4 → toplanır
    expect(over.bearOff).toBe(true);
    const notBack = stepFor(st, 0, 2, 6);               // idx2, gerisinde idx4 dolu → olmaz
    expect(notBack).toBeNull();
  });

  it('oyun biter: normal 1 puan, rakip hiç toplamadıysa MARS 2 puan', () => {
    const st = fresh();
    st.turn = 0; st.phase = 'move'; st.movesLeft = [1];
    clearBoard(st);
    st.points[0] = 1; st.off[0] = 14; st.off[1] = 0; st.points[18] = -15;
    const r = applyTavlaMove(st, 0, { t: 'move', from: 0, die: 1 });
    expect(r.ok).toBe(true);
    expect(st.gameEnded).toBe(true);
    expect(st.mars).toBe(true);
    expect(st.matchScore[0]).toBe(2);
    expect(st.gameDeltas[st.gameDeltas.length - 1]).toEqual([2, 0]);
  });

  it('hedef puana ulaşınca maç biter', () => {
    const st = createTavlaGame({ seed: 7, rules: { targetScore: 1 } });
    st.turn = 0; st.phase = 'move'; st.movesLeft = [1];
    clearBoard(st);
    st.points[0] = 1; st.off[0] = 14; st.off[1] = 3; st.points[18] = -12;
    applyTavlaMove(st, 0, { t: 'move', from: 0, die: 1 });
    expect(st.mars).toBe(false);
    expect(st.matchEnded).toBe(true);
  });
});

describe('bot ve simülasyon', () => {
  it('autoTavlaMove turu bitirir', () => {
    const st = fresh(5);
    const t = st.turn;
    autoTavlaMove(st, t);
    expect(st.turn === 1 - t || st.gameEnded).toBe(true);
  });

  it('iki bot tam maçı hatasız bitirir; pul sayısı hep 15', () => {
    for (const seed of [11, 22, 33]) {
      const st = createTavlaGame({ seed, botSeats: [0, 1], rules: { targetScore: 3 } });
      let guard = 0;
      while (!st.matchEnded && guard++ < 5000) {
        if (st.gameEnded) { startNextGame(st); continue; }
        playTavlaBotTurn(st, st.turn);
        expect(totalCheckers(st, 0)).toBe(15);
        expect(totalCheckers(st, 1)).toBe(15);
      }
      expect(st.matchEnded).toBe(true);
      const target = 3;
      expect(Math.max(st.matchScore[0]!, st.matchScore[1]!)).toBeGreaterThanOrEqual(target);
    }
  });
});

describe('katlama küpü + teslim', () => {
  it('küp yalnız sıra sende + zar atmadan teklif edilir; rakip kabulünde ×2 ve sahiplik geçer', () => {
    const st = fresh(9);
    const t = st.turn, o = 1 - t;
    expect(applyTavlaMove(st, o, { t: 'double' }).ok).toBe(false); // sıra onda değil
    expect(applyTavlaMove(st, t, { t: 'double' }).ok).toBe(true);
    expect(st.pendingDouble).toBe(t);
    expect(applyTavlaMove(st, t, { t: 'roll' }).ok).toBe(false);   // cevap bekleniyor
    expect(applyTavlaMove(st, t, { t: 'takeDouble' }).ok).toBe(false); // cevabı rakip verir
    expect(applyTavlaMove(st, o, { t: 'takeDouble' }).ok).toBe(true);
    expect(st.cubeValue).toBe(2);
    expect(st.cubeOwner).toBe(o);
    expect(st.pendingDouble).toBe(-1);
    // Küp artık rakipte → teklif eden yeniden katlayamaz
    expect(applyTavlaMove(st, t, { t: 'double' }).ok).toBe(false);
  });

  it('katlama REDDİ teslim DEĞİL: oyun mevcut değerle sürer, küp reddedene geçer (kullanıcı kuralı)', () => {
    const st = fresh(10);
    const t = st.turn, o = 1 - t;
    applyTavlaMove(st, t, { t: 'double' });
    expect(applyTavlaMove(st, o, { t: 'dropDouble' }).ok).toBe(true);
    expect(st.gameEnded).toBe(false);          // RED = çekilme değil
    expect(st.cubeValue).toBe(1);              // değer katlanmadı
    expect(st.cubeOwner).toBe(o);              // küp reddedene geçti
    expect(st.pendingDouble).toBe(-1);
    expect(applyTavlaMove(st, t, { t: 'double' }).ok).toBe(false); // teklif eden tekrar teklifle taciz edemez
    expect(applyTavlaMove(st, t, { t: 'roll' }).ok).toBe(true);    // oyun aynen devam
  });

  it('kabul edilen küple normal bitiş ×küp; MARS ile ×2×küp', () => {
    const st = fresh(11);
    const t = st.turn, o = 1 - t;
    applyTavlaMove(st, t, { t: 'double' });
    applyTavlaMove(st, o, { t: 'takeDouble' });
    st.turn = 0; st.phase = 'move'; st.movesLeft = [1];
    clearBoard(st);
    st.points[0] = 1; st.off[0] = 14; st.off[1] = 0; st.points[18] = -15;
    applyTavlaMove(st, 0, { t: 'move', from: 0, die: 1 });
    expect(st.mars).toBe(true);
    expect(st.matchScore[0]).toBe(4); // mars 2 × küp 2
  });

  it('teslim ol: rakip küp değerince kazanır, mars sayılmaz', () => {
    const st = fresh(12);
    const t = st.turn;
    expect(applyTavlaMove(st, t, { t: 'resign' }).ok).toBe(true);
    expect(st.gameEnded).toBe(true);
    expect(st.gameWinner).toBe(1 - t);
    expect(st.matchScore[1 - t]).toBe(1);
    expect(st.mars).toBe(false);
  });

  it('yeni oyunda küp sıfırlanır; autoTavlaMove bekleyen teklifi oto-kabul eder', () => {
    const st = createTavlaGame({ seed: 13, rules: { targetScore: 5 } });
    const t = st.turn, o = 1 - t;
    applyTavlaMove(st, t, { t: 'double' });
    autoTavlaMove(st, o); // süre doldu senaryosu
    expect(st.cubeValue).toBe(2);
    applyTavlaMove(st, o, { t: 'resign' });
    expect(st.gameEnded).toBe(true);
    startNextGame(st);
    expect(st.cubeValue).toBe(1);
    expect(st.cubeOwner).toBe(-1);
    expect(st.pendingDouble).toBe(-1);
  });
});

describe('bot açılış bilgisi (tur-seviyesi arama)', () => {
  function freshMoveTurn(seat: number, dice: number[]) {
    const st = createTavlaGame({ seed: 77, botSeats: [0, 1] });
    st.turn = seat; st.phase = 'move';
    st.dice = [dice[0]!, dice[1]!];
    st.movesLeft = dice[0] === dice[1] ? [dice[0]!, dice[0]!, dice[0]!, dice[0]!] : [...dice];
    return st;
  }

  it('3-1 açılışı: 5-HANEYİ kapatır (8/5 6/5)', () => {
    const st = freshMoveTurn(0, [3, 1]);
    playTavlaBotTurn(st, 0);
    expect(st.points[4]).toBe(2); // seat0 5-hanesi = idx4
  });

  it('6-1 açılışı: BAR-HANEYİ kapatır (13/7 8/7)', () => {
    const st = freshMoveTurn(0, [6, 1]);
    playTavlaBotTurn(st, 0);
    expect(st.points[6]).toBe(2); // seat0 bar-hanesi = idx6
  });

  it('4-2 açılışı: 4-HANEYİ kapatır (8/4 6/4)', () => {
    const st = freshMoveTurn(0, [4, 2]);
    playTavlaBotTurn(st, 0);
    expect(st.points[3]).toBe(2);
  });

  it('5-3 açılışı: 3-HANEYİ kapatır (8/3 6/3)', () => {
    const st = freshMoveTurn(0, [5, 3]);
    playTavlaBotTurn(st, 0);
    expect(st.points[2]).toBe(2);
  });

  it('seat1 için de simetrik: 3-1 → kendi 5-hanesi (idx19)', () => {
    const st = freshMoveTurn(1, [3, 1]);
    playTavlaBotTurn(st, 1);
    expect(st.points[19]).toBe(-2);
  });

  it('zorunlu maksimum oynama: iki zar da oynanabiliyorsa ikisini de kullanır', () => {
    const st = freshMoveTurn(0, [2, 1]);
    playTavlaBotTurn(st, 0);
    expect(st.movesLeft.length).toBe(0);
    expect(st.turn).toBe(1); // sıra geçti
  });
});
