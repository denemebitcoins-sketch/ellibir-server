import { describe, expect, it } from 'vitest';
import {
  buildOkeyDeck, dealOkey, nextRank, identityOf, isOkeyTile,
  canFinishMelds, canFinishPairs, isValidRun, isValidSet, isValidPair,
  createOkeyGame, applyOkeyMove, elMultOf, beginBankoPhase, resolveBankoPhase, startNextEl, autoOkeyMove, playOkeyBotTurn,
} from '../src/okey';
import type { NormalOkeyTile, OkeyColor, OkeyRank, OkeyTile } from '../src/okey';

let seq = 0;
/** Test taşı üretici (benzersiz id). */
function t(color: OkeyColor, rank: number): NormalOkeyTile {
  return { id: `${color}${rank}-t${seq++}`, fake: false, color, rank: rank as OkeyRank };
}
function fake(n = 0): OkeyTile {
  return { id: `FAKE-t${n}-${seq++}`, fake: true };
}

// Testlerde varsayılan: gösterge K12 → okey K13 (siyah 13). Joker = K13.
const OC: OkeyColor = 'K';
const OR: OkeyRank = 13;

describe('deste ve gösterge', () => {
  it('106 taş: 104 normal + 2 sahte; renk/sayı başına 2 kopya', () => {
    const d = buildOkeyDeck();
    expect(d.length).toBe(106);
    expect(d.filter((x) => x.fake).length).toBe(2);
    const key = (x: any) => `${x.color}${x.rank}`;
    const counts = new Map<string, number>();
    for (const x of d) if (!x.fake) counts.set(key(x), (counts.get(key(x)) ?? 0) + 1);
    expect(counts.size).toBe(52);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('okey = göstergenin bir üstü; 13 → 1 döner', () => {
    expect(nextRank(12 as OkeyRank)).toBe(13);
    expect(nextRank(13 as OkeyRank)).toBe(1);
  });

  it('dağıtım: dağıtıcı 15, diğerleri 14; gösterge sahte olamaz; toplam korunur', () => {
    const r = dealOkey(42, 2);
    expect(r.hands[2]!.length).toBe(15);
    expect(r.hands[0]!.length).toBe(14);
    expect(r.gosterge.fake).toBe(false);
    const total = r.hands.flat().length + r.stock.length + 1;
    expect(total).toBe(106);
    expect(r.okeyColor).toBe(r.gosterge.color);
    expect(r.okeyRank).toBe(nextRank(r.gosterge.rank));
  });

  it('sahte okey, okeyin kimliğine bürünür; okey taşı jokerdir', () => {
    const f = fake();
    const id = identityOf(f, OC, OR);
    expect(id.wild).toBe(false);
    expect(id.color).toBe(OC);
    expect(id.rank).toBe(OR);
    expect(isOkeyTile(t('K', 13), OC, OR)).toBe(true);
    expect(identityOf(t('K', 13), OC, OR).wild).toBe(true);
  });
});

describe('per doğrulama', () => {
  it('seri: 1-2-3 geçerli, 12-13-1 geçerli, 13-1-2 GEÇERSİZ', () => {
    expect(isValidRun([t('R', 1), t('R', 2), t('R', 3)], OC, OR)).toBe(true);
    expect(isValidRun([t('R', 12), t('R', 13), t('R', 1)], OC, OR)).toBe(true);
    expect(isValidRun([t('R', 13), t('R', 1), t('R', 2)], OC, OR)).toBe(false);
  });

  it('seri: renk karışamaz; okey boşluğu doldurur', () => {
    expect(isValidRun([t('R', 5), t('Y', 6), t('R', 7)], OC, OR)).toBe(false);
    expect(isValidRun([t('R', 5), t('K', 13), t('R', 7)], OC, OR)).toBe(true); // K13 = okey → 6 yerine
  });

  it('küt: 3-4 farklı renk aynı sayı; renk tekrarı ve 5 taş geçersiz', () => {
    expect(isValidSet([t('R', 9), t('Y', 9), t('B', 9)], OC, OR)).toBe(true);
    expect(isValidSet([t('R', 9), t('Y', 9), t('B', 9), t('K', 9)], OC, OR)).toBe(true);
    expect(isValidSet([t('R', 9), t('R', 9), t('B', 9)], OC, OR)).toBe(false);
    expect(isValidSet([t('R', 9), t('Y', 9), t('B', 9), t('K', 9), t('R', 9)], OC, OR)).toBe(false);
  });

  it('çift: aynı renk+sayı; okey eş yerine geçer; sahte okey = okey kimliği', () => {
    expect(isValidPair([t('B', 4), t('B', 4)], OC, OR)).toBe(true);
    expect(isValidPair([t('B', 4), t('Y', 4)], OC, OR)).toBe(false);
    expect(isValidPair([t('B', 4), t('K', 13)], OC, OR)).toBe(true);  // okey joker
    expect(isValidPair([fake(), fake()], OC, OR)).toBe(true);          // iki sahte = iki K13 kimliği
  });
});

describe('el bitirme (14 taş)', () => {
  it('seri+küt karışımı tam bölünme', () => {
    const hand = [
      t('R', 1), t('R', 2), t('R', 3),           // seri
      t('Y', 7), t('B', 7), t('K', 7),            // küt
      t('B', 9), t('B', 10), t('B', 11), t('B', 12), // seri 4
      t('Y', 1), t('K', 1), t('B', 1), t('R', 1),    // küt 4 (1'ler)
    ];
    expect(canFinishMelds(hand, OC, OR)).toBe(true);
  });

  it('AYNI taşın iki kopyası iki ayrı peride kullanılabilir (R5+R5)', () => {
    const hand = [
      t('R', 3), t('R', 4), t('R', 5),   // seri 1: R5 (1. kopya)
      t('R', 5), t('R', 6), t('R', 7),   // seri 2: R5 (2. kopya)
      t('Y', 2), t('B', 2), t('K', 2),
      t('Y', 8), t('B', 8), t('K', 8),
      t('Y', 9), t('B', 9),              // eksik — bilerek bozuk
    ];
    expect(canFinishMelds(hand, OC, OR)).toBe(false); // son ikili per değil
    const hand2 = [...hand.slice(0, 12), t('Y', 9), t('B', 9)];
    expect(canFinishMelds(hand2, OC, OR)).toBe(false);
    const hand3 = [...hand.slice(0, 12), t('K', 9), ...[t('Y', 9)]];
    expect(canFinishMelds(hand3, OC, OR)).toBe(false);
    // 12 taşlık çekirdek + geçerli 3'lü olsaydı: 15 olur; onun yerine çekirdeğe K9 Y9 M9 koyup 15'e taşmadan 14 kur:
    const ok = [
      t('R', 3), t('R', 4), t('R', 5),
      t('R', 5), t('R', 6), t('R', 7),
      t('Y', 2), t('B', 2), t('K', 2),
      t('Y', 8), t('B', 8),
      t('Y', 9), t('B', 9), t('Y', 10), // Y8-Y9-Y10 seri + M8-M9 ÇİFT DEĞİL → bozuk
    ];
    expect(canFinishMelds(ok, OC, OR)).toBe(false);
    const ok2 = [
      t('R', 3), t('R', 4), t('R', 5),
      t('R', 5), t('R', 6), t('R', 7),
      t('Y', 2), t('B', 2), t('K', 2),
      t('Y', 8), t('Y', 9), t('Y', 10),
      t('B', 12), t('B', 12), // son ikili per değil → false
    ];
    expect(canFinishMelds(ok2, OC, OR)).toBe(false);
    const ok3 = [
      t('R', 3), t('R', 4), t('R', 5),
      t('R', 5), t('R', 6), t('R', 7),
      t('Y', 2), t('B', 2), t('K', 2),
      t('Y', 8), t('Y', 9), t('Y', 10), t('Y', 11), t('Y', 12),
    ];
    expect(canFinishMelds(ok3, OC, OR)).toBe(true); // 3+3+3+5
  });

  it('okey joker olarak boşluk doldurur; açıkta joker kalırsa el bitmez', () => {
    const hand = [
      t('R', 1), t('R', 2), t('K', 13),  // K13 okey → R3 yerine
      t('Y', 7), t('B', 7), t('K', 7),
      t('B', 9), t('B', 10), t('B', 11),
      t('Y', 4), t('K', 4), t('R', 4),
      t('B', 5), t('Y', 5),
    ];
    // S geçersiz renk kodu değil — Y/M/K/R kullanıyoruz; son ikili zaten bozuk.
    expect(canFinishMelds(hand.slice(0, 12).concat([t('Y', 5), t('B', 5)]), OC, OR)).toBe(false);
    // 2. okey mevcut bir küte 4. taş (B4) olarak eklenir + B12 seriyi 4'ler → el BİTER.
    const good = hand.slice(0, 12).concat([t('K', 13), t('B', 12)]);
    expect(canFinishMelds(good, OC, OR)).toBe(true);
    const good2 = [
      t('R', 1), t('R', 2), t('K', 13),
      t('Y', 7), t('B', 7), t('K', 7),
      t('B', 9), t('B', 10), t('B', 11),
      t('Y', 4), t('K', 4), t('R', 4), t('B', 4),
      t('R', 8),
    ];
    expect(canFinishMelds(good2, OC, OR)).toBe(false); // R8 tek
  });

  it('7 çift bitişi: saf çiftler + okey tek tamamlar + sahte okey', () => {
    const pure = [
      t('R', 2), t('R', 2), t('Y', 5), t('Y', 5), t('B', 8), t('B', 8),
      t('K', 3), t('K', 3), t('R', 11), t('R', 11), t('Y', 13), t('Y', 13),
      t('B', 6), t('B', 6),
    ];
    expect(canFinishPairs(pure, OC, OR)).toBe(true);

    const withOkey = pure.slice(0, 13).concat([t('K', 13)]); // son M6'nın eşi yerine okey
    expect(canFinishPairs(withOkey, OC, OR)).toBe(true);

    const withFake = pure.slice(0, 12).concat([fake(), fake()]); // iki sahte = K13 çifti
    expect(canFinishPairs(withFake, OC, OR)).toBe(true);

    const broken = pure.slice(0, 13).concat([t('B', 7)]); // eşsiz taş, joker yok
    expect(canFinishPairs(broken, OC, OR)).toBe(false);
  });
});

describe('oyun akışı', () => {
  it('dağıtıcı çekmeden atar; sıra saat tersine döner; sol atık alınabilir', () => {
    const g = createOkeyGame({ seed: 7, dealerSeat: 0 });
    expect(g.turn).toBe(0);
    expect(g.phase).toBe('discard');
    expect(g.players[0]!.hand.length).toBe(15);

    const first = g.players[0]!.hand[0]!;
    expect(applyOkeyMove(g, 1, { t: 'draw', from: 'pile' }).ok).toBe(false); // sıra 0'da
    expect(applyOkeyMove(g, 0, { t: 'discard', tileId: first.id }).ok).toBe(true);
    expect(g.turn).toBe(1);
    expect(g.phase).toBe('draw');

    // 1 numaralı oyuncu SOL komşusunun (0) attığını alabilir.
    const r = applyOkeyMove(g, 1, { t: 'draw', from: 'left' });
    expect(r.ok).toBe(true);
    expect(g.players[1]!.hand.some((x) => x.id === first.id)).toBe(true);
    expect(g.discards[0]!.length).toBe(0);
  });

  it('geçersiz bitiş reddedilir; puanlar değişmez', () => {
    const g = createOkeyGame({ seed: 11, dealerSeat: 0 });
    const anyTile = g.players[0]!.hand[3]!;
    const r = applyOkeyMove(g, 0, { t: 'finish', tileId: anyTile.id });
    // Rastgele elde bitme olasılığı pratikte sıfır — hata bekliyoruz.
    expect(r.ok).toBe(false);
    expect(g.scores.every((s) => s === g.rules.scoring.startScore)).toBe(true);
  });

  it('kurgu bitiş (kahve usulü): düz → kazanan -100 düşer, rakipler +100; okey atarak 2x; eşli’de ortak muaf', () => {
    const g = createOkeyGame({ seed: 13, dealerSeat: 0 });
    // Eli elle kur: 0'ın eline bitmiş 14 + atılacak 1 taş koy.
    const win14 = [
      t('R', 1), t('R', 2), t('R', 3),
      t('Y', 7), t('B', 7), t('K', 7),
      t('B', 9), t('B', 10), t('B', 11), t('B', 12),
      t('Y', 4), t('K', 4), t('R', 4), t('B', 4),
    ];
    const throwaway = t('Y', 11);
    g.players[0]!.hand = [...win14, throwaway];
    const r = applyOkeyMove(g, 0, { t: 'finish', tileId: throwaway.id });
    expect(r.ok).toBe(true);
    expect(g.elEnded).toBe(true);
    expect(g.elWinner).toBe(0);
    expect(g.finishKind).toBe('normal');
    expect(g.scores[0]).toBe(400); // 500 - 100 (kazanan düşer)
    expect(g.scores[1]).toBe(600); // 500 + 100 ceza
    expect(g.scores[2]).toBe(600);
    expect(g.scores[3]).toBe(600);

    // OKEY atarak (yeni el kur, okeyi son taş olarak at) — eşli modda.
    const g2 = createOkeyGame({ seed: 17, dealerSeat: 0, rules: { teamMode: true } });
    const okeyTile: NormalOkeyTile = { id: 'OKEYTEST', fake: false, color: g2.okeyColor, rank: g2.okeyRank };
    g2.players[0]!.hand = [...win14.map((x) => ({ ...x, id: x.id + 'b' })), okeyTile];
    const r2 = applyOkeyMove(g2, 0, { t: 'finish', tileId: okeyTile.id });
    expect(r2.ok).toBe(true);
    expect(g2.finishKind).toBe('okey');
    expect(g2.scores[0]).toBe(300); // 500 - 200 (okey atarak 2x düşer)
    expect(g2.scores[2]).toBe(500); // ortak muaf (ceza yemez, düşmez de)
    expect(g2.scores[1]).toBe(700); // +200 ceza
    expect(g2.scores[3]).toBe(700);
  });

  it('gösterge gösterme: teki eldeyken, ilk atıştan önce — KENDİ puanından 50 düşer', () => {
    const g = createOkeyGame({ seed: 19, dealerSeat: 0 });
    const gTek: NormalOkeyTile = { id: 'GTEK', fake: false, color: g.gosterge.color, rank: g.gosterge.rank };
    g.players[1]!.hand[0] = gTek;
    expect(applyOkeyMove(g, 1, { t: 'gosterge' }).ok).toBe(true);
    expect(applyOkeyMove(g, 1, { t: 'gosterge' }).ok).toBe(false); // ikinci kez yok
    expect(g.scores[1]).toBe(450); // 500 - 50 (kendi puanından düşer)
    expect(g.scores[0]).toBe(500); // rakipler etkilenmez
    expect(g.scores[2]).toBe(500);
    expect(g.scores[3]).toBe(500);
  });

  it('DÜŞME: 0’a inen maçı HEMEN kazanır (el tavanı beklenmez)', () => {
    const g = createOkeyGame({ seed: 31, dealerSeat: 0, rules: { totalEls: 99, scoring: { startScore: 100 } as any } });
    const win14 = [
      t('R', 1), t('R', 2), t('R', 3),
      t('Y', 7), t('B', 7), t('K', 7),
      t('B', 9), t('B', 10), t('B', 11), t('B', 12),
      t('Y', 4), t('K', 4), t('R', 4), t('B', 4),
    ];
    const throwaway = t('Y', 11);
    g.players[0]!.hand = [...win14, throwaway];
    expect(applyOkeyMove(g, 0, { t: 'finish', tileId: throwaway.id }).ok).toBe(true);
    expect(g.scores[0]).toBe(0);       // 100 - 100 → sıfıra indi
    expect(g.matchEnded).toBe(true);    // maç hemen biter
    expect(g.matchLog[g.matchLog.length - 1]).toContain('sıfıra indi');
  });

  it('deste bitince el berabere; el sayısı ilerler', () => {
    const g = createOkeyGame({ seed: 23, dealerSeat: 0, rules: { totalEls: 1 } });
    g.stock = []; // desteyi bitir
    const anyT = g.players[0]!.hand[0]!;
    expect(applyOkeyMove(g, 0, { t: 'discard', tileId: anyT.id }).ok).toBe(true);
    expect(g.elEnded).toBe(true);
    expect(g.elWinner).toBe(-1);
    expect(g.matchEnded).toBe(true); // totalEls=1
  });

  it('autoMove: çek + okey-dışı at; sıra ilerler', () => {
    const g = createOkeyGame({ seed: 29, dealerSeat: 0 });
    autoOkeyMove(g, 0); // dağıtıcı: direkt atar
    expect(g.turn).toBe(1);
    autoOkeyMove(g, 1); // çek + at
    expect(g.turn).toBe(2);
    expect(g.players[1]!.hand.length).toBe(14);
  });

  it('SİMÜLASYON: 4 bot, seed sabit — el mutlaka sonlanır, state tutarlı', () => {
    const g = createOkeyGame({ seed: 1234, botSeats: [0, 1, 2, 3], rules: { totalEls: 3 } });
    let guard = 0;
    while (!g.matchEnded && guard++ < 5000) {
      if (g.elEnded) { startNextEl(g); continue; }
      playOkeyBotTurn(g, g.turn);
    }
    expect(guard).toBeLessThan(5000);
    expect(g.matchEnded).toBe(true);
    // Taş muhasebesi: her el sonunda toplam 106 korunmuş olmalı (son el üzerinden kontrol).
    const inHands = g.players.reduce((n, p) => n + p.hand.length, 0);
    const inDiscards = g.discards.reduce((n, d) => n + d.length, 0);
    expect(inHands + inDiscards + g.stock.length + 1 + (g.elWinner != null && g.elWinner >= 0 ? 1 : 0))
      .toBeGreaterThanOrEqual(105); // gösterge +1; kazanan bitiş taşı ortada (+1)
  });
});

describe('BANKO v3: açık SEÇİM FAZI (el dağıtılmadan, herkes görür)', () => {
  function bankoGame(seed = 42) {
    return createOkeyGame({
      seed, botSeats: [1, 2, 3],
      rules: { variant: 'banko', totalEls: 5 } as any,
      dealFirst: false, // banko odası: ilk el SEÇİM FAZINDAN sonra dağıtılır
    } as any);
  }

  it('ilk el: faz açılır, botlar anında PAS, ben BANKO diyebilirim; el faz kapanınca dağıtılır', () => {
    const st = bankoGame(11);
    expect(st.elNumber).toBe(0); // henüz dağıtılmadı
    beginBankoPhase(st);
    expect(st.bankoPhase).toBe(true);
    expect(st.bankoChoice[1]).toBe(0); // bot PAS
    expect(st.bankoChoice[0]).toBe(-1); // ben kararsız
    expect(applyOkeyMove(st, 0, { t: 'banko' } as any).ok).toBe(true);
    expect(st.bankoChoice[0]).toBe(1);
    expect(st.bankoUsed[0]).toBe(true);       // hak anında yandı
    expect(applyOkeyMove(st, 0, { t: 'pas' } as any).ok).toBe(false); // BANKO geri alınmaz
    // faz sırasında normal hamle yasak
    expect(applyOkeyMove(st, 0, { t: 'draw', from: 'pile' } as any).ok).toBe(false);
    resolveBankoPhase(st);
    startNextEl(st);
    expect(st.elNumber).toBe(1);
    expect(st.bankoThisEl[0]).toBe(true);     // seçim ele işledi
    expect(st.players[0]!.hand.length).toBeGreaterThan(0); // el DAĞITILDI
  });

  it('faz dışında banko/pas reddedilir; hak yoksa fazda da reddedilir', () => {
    const st = bankoGame(12);
    expect(applyOkeyMove(st, 0, { t: 'banko' } as any).ok).toBe(false); // faz kapalı
    beginBankoPhase(st);
    applyOkeyMove(st, 0, { t: 'banko' } as any);
    resolveBankoPhase(st); startNextEl(st);
    st.elEnded = true; st.elWinner = -1;
    beginBankoPhase(st); // 2. el fazı
    expect(st.bankoChoice[0]).toBe(0); // hak yandı → PAS kilitli
    expect(applyOkeyMove(st, 0, { t: 'banko' } as any).ok).toBe(false);
  });

  it('PAS liste kapanana dek BANKOya yükseltilebilir; kararsız resolve ile PAS olur', () => {
    const st = bankoGame(13);
    beginBankoPhase(st);
    expect(applyOkeyMove(st, 0, { t: 'pas' } as any).ok).toBe(true);
    expect(st.bankoChoice[0]).toBe(0);
    expect(applyOkeyMove(st, 0, { t: 'banko' } as any).ok).toBe(true); // yükseltme
    expect(st.bankoChoice[0]).toBe(1);
    // yeni oyun: kararsız kalan resolve'da PAS
    const st2 = bankoGame(14);
    beginBankoPhase(st2);
    resolveBankoPhase(st2);
    expect(st2.bankoChoice[0]).toBe(0);
    expect(st2.bankoPending[0]).toBe(false);
  });

  it('mecburiyet YALNIZ SON elde, hakkı duran HERKESE (bot dahil); ara ellerde ASLA', () => {
    const st = bankoGame(15); // botSeats [1,2,3]
    (st as any).elNumber = 1; // ara el → force YOK (eskiden burada patlıyordu: eş hakkı yanıyordu)
    beginBankoPhase(st);
    expect(st.bankoChoice[0]).toBe(-1);
    expect(st.bankoUsed.some(Boolean)).toBe(false);
    resolveBankoPhase(st);
    (st as any).elNumber = st.rules.totalEls - 1; // dağıtılacak = SON el
    beginBankoPhase(st);
    expect(st.bankoUsed.every(Boolean)).toBe(true); // bot dahil herkes
    expect(st.bankoChoice.every((c) => c === 1)).toBe(true);
  });
});
