import type { Card, CardId, Meld, Move, PlayerView, Rank, Suit } from './types';
import type { MoveProvider } from './provider';
import { canExtend, canRetrieveJoker, canTakeDiscardView } from './game';
import { analyzePair, handCardPenalty } from './melds';
import { analyzeHand, bestOpening, bestPairOpening } from './insight';
import { solveHand } from './solver';

export type BotDifficulty = 'kolay' | 'normal' | 'zor';

/**
 * Oyun stili profili (RULES.md §3.5) — beceriden BAĞIMSIZ ikinci eksen:
 *  garantici : erken açar, riski söndürür (baraj kovalamaz).
 *  dengeli   : taban davranış (eşikte açar) — geriye dönük varsayılan.
 *  avci      : geç açar, baraj kovalar; ÖZELLİKLE gerideyken 111+ hedefler.
 * Karar puan durumuna duyarlıdır: gerideyse baraj kovalar, öndeyse erken
 * açıp kapatır ("puan geçir ↔ barajla düşür" gerilimi).
 */
export type BotProfile = 'garantici' | 'dengeli' | 'avci';

export interface BotOptions {
  difficulty?: BotDifficulty;
  profile?: BotProfile;
}

/**
 * Sezgisel bot — iki eksen:
 *  BECERİ (difficulty): kolay geç/hafızasız · normal izler · zor çift stratejisi.
 *  STİL (profile): garantici/dengeli/avci açış iştahı + baraj kovalama.
 * Tüm botlar oyuncuyla AYNI motor doğrulamasından geçer (ayrıcalık yok) ve
 * yalnızca PlayerView (açık bilgi) görür.
 */
export class HeuristicBot implements MoveProvider {
  private readonly difficulty: BotDifficulty;
  private readonly profile: BotProfile;

  constructor(arg: BotDifficulty | BotOptions = 'normal') {
    if (typeof arg === 'string') {
      this.difficulty = arg;
      this.profile = 'dengeli';
    } else {
      this.difficulty = arg.difficulty ?? 'normal';
      this.profile = arg.profile ?? 'dengeli';
    }
  }

  nextMove(view: PlayerView): Move {
    // SORGU açıksa ve karar bana düşüyorsa yanıtla (ortak görüş / cevap / sonuç).
    const sg = view.sorgu;
    if (sg) {
      // AKILLI karar: açmış oyuncu verir (bedeli yok); ortak "ver" dediyse verir; aksi halde
      // (açmamış + ortak yok/verme) çift olup engeller. → mantıklı, hep-verme değil.
      if (sg.asama === 'ortakGorus' && sg.partnerSeat === view.seat) {
        const sorulan = view.players.find((p) => p.seat === sg.sorulanSeat);
        return { type: 'sorguOrtakGorus', gorus: sorulan?.hasOpened ? 'ver' : 'verme' };
      }
      if (sg.asama === 'cevap' && sg.sorulanSeat === view.seat) {
        return { type: 'sorguCevap', cevap: this.sorguVer(view, sg) ? 'ver' : 'verme' };
      }
      if (sg.asama === 'sonuc' && sg.askerSeat === view.seat) return { type: 'sorguSonuc', al: false };
    }
    if (view.phase === 'draw') return this.chooseDraw(view);
    return this.chooseAction(view);
  }

  /**
   * SORGU 'cevap' kararı — MATEMATİKSEL/DETERMİNİSTİK (sezgisel değil).
   * "Kağıdı verirsem rakip alır; vermezsem ÇİFT olurum." Çift olmak el içinde
   * dezavantaj (açış/atış kısıtı) olduğundan ancak çift olmaya GÜCÜM yeterse
   * (karşılık verecek çiftim + deste + puan baskısı) verme; aksi halde ver.
   *
   *  - Açmışsam → ver (çift olmanın bedeli yok, kağıt salt rakibe yarar).
   *  - Ortak 'ver' dediyse → ver (ortak otoritesi).
   *  - Aksi halde puanla: eldeki çift sayısı + deste sağlığı + puan baskısı +
   *    el gücü eşikli toplanır; skor < 0 ise çift olmayı göze al → verme.
   */
  private sorguVer(view: PlayerView, sg: NonNullable<PlayerView['sorgu']>): boolean {
    if (view.hasOpened) return true;
    if (sg.partnerGorus === 'ver') return true;

    // (a) ÇİFT gücü: çift olursam karşılık verecek özdeş çiftim var mı?
    const insight = analyzeHand(view.hand, view.rules);
    const pairs = insight.pairCount;

    // (b) DESTE sağlığı: bol kağıt → eksik çiftleri tamamlama şansı yüksek.
    const stockHealthy = view.stockCount > view.players.length * 4;

    // (c) PUAN baskısı: çok gerideysem (ezel/baraj riski) çift olup direnmeye değer.
    const behind = this.behind(view);

    // (d) EL gücü: açış potansiyelim varsa riski göze alabilirim (güçlü el).
    const openPts = bestOpening(view.hand, view.rules).points;
    const strongHand = openPts >= view.currentOpeningMin * 0.6 || view.hand.length >= 6;

    // ÇİFT olmaya GÜCÜM var mı? Yeterli çift (≥3) YOKSA çift olamam → VER.
    // (Çift olmak el içinde dezavantaj; sadece sağlam çift altyapısı varken göze alınır.)
    if (pairs < 3) return true;

    // ≥3 çiftim var: ancak deste/puan/el de destekliyorsa çift olmaya değer (verme); aksi halde yine ver.
    let score = 0;
    if (stockHealthy) score += 1;  // deste bol → eksik çift bulunur
    if (behind) score += 1;        // gerideyim → barajı/ezeli göze al
    if (strongHand) score += 1;    // güçlü el → riski kaldırır
    if (view.hand.length <= 3) score -= 1; // el bitiyor → çift olup takılma

    // score güçlüyse (≥2) ÇİFT OL (verme=false); aksi halde VER (true).
    return score < 2;
  }

  /* ---------------------- profil / puan duyarlılığı ---------------------- */

  /** Puanım rakiplerin ortalamasından KÖTÜ (yüksek) mü — yani geride miyim? */
  private behind(view: PlayerView): boolean {
    const others = view.players.filter((p) => p.seat !== view.seat);
    if (others.length === 0) return false;
    const me = view.players.find((p) => p.seat === view.seat)?.totalScore ?? 0;
    const avg = others.reduce((s, p) => s + p.totalScore, 0) / others.length;
    return me > avg; // düşük puan iyidir; yüksekse geridesin
  }

  /**
   * Bu botun AÇMAK için beklediği puan hedefi (etkin sınırla birlikte).
   * garantici taban; avci baraj eşiğini (111) kovalar — gerideyse ya da
   * deste hâlâ bolken; deste tükenirken tabana iner ("kapı kapanmadan aç").
   */
  private openTarget(view: PlayerView): number {
    const base = view.currentOpeningMin + (this.difficulty === 'kolay' ? 9 : 0);
    if (this.profile === 'avci') {
      const stockHealthy = view.stockCount > view.players.length * 4;
      const chase = this.behind(view) || stockHealthy;
      const barajMin = view.rules.barajTokens.enabled
        ? view.rules.barajTokens.seriBarajBaslangic
        : base;
      return chase ? Math.max(base, barajMin) : base;
    }
    // garantici ve dengeli tabanı hedefler (garantici erken açış için ek tampon yok).
    return base;
  }

  /* ---------------------------- çekiş ---------------------------- */

  private chooseDraw(view: PlayerView): Move {
    // Yerden alma KURALI: kart ancak bu tur hemen kullanılabilecekse
    // alınabilir — oyuncuyla AYNI motor doğrulaması (ayrıcalık yok).
    const top = view.discardTop;
    if (!top || !canTakeDiscardView(view)) return { type: 'drawStock' };

    if (!view.hasOpened) {
      // Aldıktan sonra GERÇEKTEN açacağından emin ol (tryOpen ile aynı plan
      // ve aynı hedef) — yoksa al-at döngüsünde deste hiç erimez.
      const plan = bestOpening([...view.hand, top], view.rules);
      const pairPlan = bestPairOpening([...view.hand, top], view.rules);
      const willOpen =
        plan.points >= this.openTarget(view) ||
        (this.difficulty === 'zor' && pairPlan.count >= view.currentPairsMin);
      if (!willOpen) return { type: 'drawStock' };
    } else {
      // AÇIK oyuncu: kartı SOMUT kullanamayacaksa alma (al→kullanamadan→geri
      // bırak→tekrar al SONSUZ DÖNGÜSÜNÜ önler; chooseAction ile aynı karar).
      if (!this.openedPickupUse(view, top)) return { type: 'drawStock' };
    }
    return { type: 'pickupDiscard' };
  }

  /**
   * AÇIK oyuncu denemedeki kartı (ya da alacağı kartı) somut bir hamleyle
   * kullanabilir mi? handlePickup ile AYNI mantık — chooseDraw'un alım
   * kararıyla chooseAction'ın kullanım kararı asla ayrışmamalı (döngü riski).
   */
  private openedPickupUse(view: PlayerView, card: Card): Move | null {
    const hand = view.hand.some((c) => c.id === card.id)
      ? view.hand
      : [...view.hand, card];

    if (view.openMode === 'pairs') {
      const mate = hand.find(
        (c) => c.id !== card.id && analyzePair([card, c], view.rules) !== null,
      );
      if (mate && hand.length - 2 >= 1) return { type: 'meld', cards: [card.id, mate.id] };
      if (!view.ciftIslekUsed) {
        const target = view.melds.find((m) => canExtend(m, card, view.rules));
        if (target && hand.length > 2) {
          return { type: 'extend', meldId: target.id, cardId: card.id };
        }
        const jokerMeld = view.melds.find((m) => canRetrieveJoker(m, card, view.rules));
        if (jokerMeld) return { type: 'retrieveJoker', meldId: jokerMeld.id, cardId: card.id };
      }
      return null;
    }

    const solved = solveHand(hand, view.rules, 'cards');
    const layWithCard = solved.melds.find(
      (m) => m.some((c) => c.id === card.id) && m.length < hand.length,
    );
    if (layWithCard) return { type: 'meld', cards: layWithCard.map((c) => c.id) };
    const target = view.melds.find((m) => canExtend(m, card, view.rules));
    if (target && hand.length > 2) return { type: 'extend', meldId: target.id, cardId: card.id };
    const jokerMeld = view.melds.find((m) => canRetrieveJoker(m, card, view.rules));
    if (jokerMeld) return { type: 'retrieveJoker', meldId: jokerMeld.id, cardId: card.id };
    return null;
  }

  /* ---------------------------- eylem ---------------------------- */

  private chooseAction(view: PlayerView): Move {
    const { hand, rules } = view;

    // DENEME ALIMI önceliği: AÇIK oyuncu alınan kartı kullanmadan devam
    // edemez (motor kuralı) — önce onu kullan, kullanılamıyorsa GERİ BIRAK.
    const pickupMove = this.handlePickup(view);
    if (pickupMove) return pickupMove;

    if (!view.hasOpened) {
      if (this.difficulty === 'zor') {
        const pairOpen = this.tryOpenPairs(view);
        if (pairOpen) return pairOpen;
      }
      const open = this.tryOpen(view);
      if (open) return open;
      return this.chooseDiscard(view);
    }

    if (view.openMode === 'pairs') {
      // Çift modunda: eldeki özdeş çiftleri indir, sonra at.
      const pair = this.findIdenticalPair(hand, rules);
      if (pair && hand.length - 2 >= 1) {
        return { type: 'meld', cards: pair };
      }
      return this.chooseDiscard(view);
    }

    // 1) Yeni perler.
    const solved = solveHand(hand, rules, 'cards');
    const layable = solved.melds.find((m) => m.length < hand.length);
    if (layable) {
      return { type: 'meld', cards: layable.map((c) => c.id) };
    }

    // 2) Joker geri al — yalnızca hemen kullanabileceksek.
    const retrieve = this.tryRetrieveJoker(view);
    if (retrieve) return retrieve;

    // 3) Masadaki perleri işle — yüksek puanlı kartları boşalt.
    if (hand.length > 1) {
      const planned = new Set(solved.melds.flat().map((c) => c.id));
      const extendables = hand
        .filter((c) => !planned.has(c.id))
        .sort((a, b) => handCardPenalty(b, rules) - handCardPenalty(a, rules));
      for (const card of extendables) {
        const target = view.melds.find((m) => canExtend(m, card, rules));
        if (target) return { type: 'extend', meldId: target.id, cardId: card.id };
      }
    }

    return this.chooseDiscard(view);
  }

  /**
   * Denemedeki kartın güvenli akıbeti. null → normal akış devam etsin.
   * Açık olmayan bot için open/openPairs akışı zaten kartı taahhüt eder;
   * açamayacaksa (plan draw'da doğrulanmıştı ama masa değişmiş olabilir)
   * geri bırakmak en güvenlisidir (bot asla "çift düşerek" taahhüt etmez).
   */
  private handlePickup(view: PlayerView): Move | null {
    const pk = view.pickup;
    if (!pk || pk.committed) return null;
    // Henüz sormadıysa kağıdı SOR (canSor koşullarını taklit: alan ve atan çift DEĞİL).
    // Atanın çift olup olmadığını öğrenmek doğal strateji; sorgu döngüsünü görünür kılar.
    if (!pk.sorguUsed && !pk.zorunlu && !view.isCift && view.hand.length > 2) {
      const n = view.players.length;
      const atan = view.players.find((p) => p.seat === (view.seat - 1 + n) % n);
      if (atan && !atan.isCift) return { type: 'sor' };
    }
    const card = view.hand.find((c) => c.id === pk.cardId);
    if (!card) return null;

    if (!view.hasOpened) {
      // Açış planı hâlâ geçerli mi? (chooseDraw ile aynı ölçüler.)
      const willOpen =
        bestOpening(view.hand, view.rules).points >= this.openTarget(view) ||
        (this.difficulty === 'zor' &&
          bestPairOpening(view.hand, view.rules).count >= view.currentPairsMin);
      return willOpen || pk.zorunlu ? null : { type: 'cancelPickup' };
    }

    // AÇIK oyuncu: kartı HEMEN kullan; kullanılamıyorsa GERİ BIRAK
    // (zorunluysa null → normal akış kartı taşır, sonra atış kuralı işler).
    const use = this.openedPickupUse(view, card);
    if (use) return use;
    return pk.zorunlu ? null : { type: 'cancelPickup' };
  }

  /* ---------------------------- açışlar ---------------------------- */

  private tryOpen(view: PlayerView): Move | null {
    const { hand, rules } = view;
    // Profil + beceri hedefi; her hâlükârda ETKİN sınırın altına inilemez.
    const target = Math.max(this.openTarget(view), view.currentOpeningMin);

    // UI'daki SERİ AÇ ile AYNI plan fonksiyonu (ayrıcalıklı yol yok).
    const plan = bestOpening(hand, rules);
    if (plan.points < target) return null;
    return { type: 'open', melds: plan.melds.map((m) => m.map((c) => c.id)) };
  }

  /** Zor seviye: yeterli çift varsa çiftle açar (katlamalı çıtası dahil). */
  private tryOpenPairs(view: PlayerView): Move | null {
    const { hand, rules } = view;
    if (!rules.pairs.enabled) return null;
    const plan = bestPairOpening(hand, rules);
    if (plan.count < view.currentPairsMin) return null;
    return { type: 'openPairs', pairs: plan.pairs };
  }

  private pairPlanActive(view: PlayerView): boolean {
    if (view.hasOpened) return view.openMode === 'pairs';
    if (!view.rules.pairs.enabled) return false;
    const insight = analyzeHand(view.hand, view.rules);
    return insight.pairCount >= view.currentPairsMin - 1;
  }

  private findIdenticalPair(hand: readonly Card[], rules: PlayerView['rules']): CardId[] | null {
    return bestPairOpening(hand, rules).pairs[0] ?? null;
  }

  /* ---------------------------- joker ---------------------------- */

  private tryRetrieveJoker(view: PlayerView): Move | null {
    const { hand, rules } = view;
    if (hand.length <= 1) return null;
    for (const meld of view.melds) {
      if (!meld.cards.some((c) => c.joker)) continue;
      for (const card of hand) {
        if (!canRetrieveJoker(meld, card, rules)) continue;
        if (this.jokerWouldBeUsable(view, meld, card)) {
          return { type: 'retrieveJoker', meldId: meld.id, cardId: card.id };
        }
      }
    }
    return null;
  }

  private jokerWouldBeUsable(view: PlayerView, sourceMeld: Meld, replacement: Card): boolean {
    const joker = sourceMeld.cards.find((c) => c.joker);
    if (!joker) return false;
    const newHand = view.hand.filter((c) => c.id !== replacement.id).concat(joker);
    const updatedMelds = view.melds.map((m) =>
      m.id === sourceMeld.id
        ? { ...m, cards: m.cards.map((c) => (c.id === joker.id ? replacement : c)) }
        : m,
    );
    if (updatedMelds.some((m) => canExtend(m, joker, view.rules))) return true;
    const before = solveHand(view.hand, view.rules, 'cards');
    const after = solveHand(newHand, view.rules, 'cards');
    return after.cardCount > before.cardCount;
  }

  /* ---------------------------- atış ---------------------------- */

  /**
   * Rakiplerin yerden aldığı kartlara benzer kartları atmaktan kaçınır
   * (normal/zor): aynı sayı ya da aynı renkte ±2 komşu "tehlikeli" sayılır.
   */
  private dangerousFor(view: PlayerView): (card: Card) => boolean {
    // garantici riski söndürür: beceriden bağımsız hep güvenli atış arar.
    // kolay (garantici değilse) hafızasızdır.
    if (this.difficulty === 'kolay' && this.profile !== 'garantici') return () => false;
    const takenIds = view.recentEvents
      .filter(
        (e) =>
          (e.type === 'pickupCommit' || e.type === 'pickupLocked') &&
          e.seat !== view.seat &&
          e.cardId,
      )
      .map((e) => e.cardId!);
    if (takenIds.length === 0) return () => false;

    // Alınan kartların kimliğini açık yığın geçmişinden bilemeyiz; id'den
    // rank/suit çöz (kart id'leri "S5-0" formatındadır, joker hariç).
    const taken: Array<{ suit: Suit; rank: Rank }> = [];
    for (const id of takenIds) {
      const m = /^([SHDC])(\d+)-/.exec(id);
      if (m) taken.push({ suit: m[1] as Suit, rank: Number(m[2]) as Rank });
    }
    return (card: Card) => {
      if (card.joker) return false;
      return taken.some(
        (t) =>
          t.rank === card.rank ||
          (t.suit === card.suit && Math.abs(t.rank - card.rank) <= 2),
      );
    };
  }

  private chooseDiscard(view: PlayerView): Move {
    const { rules } = view;
    // Sorguda VER çıktıysa alınan kart ATILAMAZ (zorunlu) — atış adaylarından çıkar.
    const filtered = view.pickup?.zorunlu
      ? view.hand.filter((c) => c.id !== view.pickup!.cardId)
      : view.hand;
    const hand = filtered.length > 0 ? filtered : view.hand; // boş kalırsa orijinale dön (güvenlik)
    const solved = solveHand(hand, rules, 'cards');
    const planned = new Set(solved.melds.flat().map((c) => c.id));

    // Kısmi yapılar da (çift / komşu kartlar) tutulmaya değer.
    const useful = new Set<CardId>(planned);
    for (const a of hand) {
      if (a.joker) {
        useful.add(a.id);
        continue;
      }
      for (const b of hand) {
        if (a.id === b.id || b.joker) continue;
        const pair = a.rank === b.rank; // küt ortağı ya da özdeş çift adayı
        const near = a.suit === b.suit && Math.abs(a.rank - b.rank) <= 2 && a.rank !== b.rank;
        if (pair || near) {
          useful.add(a.id);
          break;
        }
      }
    }

    const dangerous = this.dangerousFor(view);
    const pick = (cards: Card[]): Card | undefined =>
      cards.sort((a, b) => handCardPenalty(b, rules) - handCardPenalty(a, rules))[0];

    const disposable = hand.filter((c) => !useful.has(c.id));
    const safeDisposable = disposable.filter((c) => !dangerous(c));
    const semiDisposable = hand.filter((c) => !planned.has(c.id) && !c.joker);
    const safeSemi = semiDisposable.filter((c) => !dangerous(c));

    const chosen =
      pick(safeDisposable) ??
      pick(disposable) ??
      pick(safeSemi) ??
      pick(semiDisposable) ??
      pick(hand.filter((c) => !c.joker)) ??
      hand[hand.length - 1]!;

    return { type: 'discard', cardId: chosen.id };
  }
}
