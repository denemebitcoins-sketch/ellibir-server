import type { RuleConfig } from './rules';

/** Kart türleri: S=Maça, H=Kupa, D=Karo, C=Sinek. */
export type Suit = 'S' | 'H' | 'D' | 'C';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/** 1=As, 11=Vale, 12=Kız, 13=Papaz. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export type CardId = string;

export interface NormalCard {
  id: CardId;
  joker: false;
  suit: Suit;
  rank: Rank;
}

export interface JokerCard {
  id: CardId;
  joker: true;
}

export type Card = NormalCard | JokerCard;

export type MeldType = 'set' | 'run' | 'pair';

/** Açış modu: per (51+ puan) ya da çift — el boyunca kilitlenir. */
export type OpenMode = 'melds' | 'pairs';

/** Bir jokerin perde içinde temsil ettiği kart(lar). */
export interface JokerSlot {
  jokerId: CardId;
  /** Temsil edilen rank. Seri için kesin; küt için rank sabit. */
  rank: Rank;
  /** Geçerli kabul edilen suit'ler (küt'te eksik renkler, seride tek renk). */
  suits: Suit[];
}

/** Masaya açılmış bir perde (meld). */
export interface Meld {
  id: string;
  ownerSeat: number;
  type: MeldType;
  /** Seri için soldan sağa sıralı; küt için serbest sıra. */
  cards: Card[];
}

/** Bir perdenin doğrulama/analiz sonucu. */
export interface MeldAnalysis {
  type: MeldType;
  /** Kanonik sıra (seri için pozisyon sırasında). */
  cards: Card[];
  points: number;
  jokers: JokerSlot[];
}

export type Phase =
  | 'draw' // sırası gelen oyuncu kart çekmeli
  | 'action' // çekti; açabilir/işleyebilir, sonra atmalı
  | 'handEnded' // el bitti, skor ekranı
  | 'matchEnded'; // 11 el tamamlandı

export interface PlayerState {
  seat: number;
  name: string;
  isBot: boolean;
  hand: Card[];
  hasOpened: boolean;
  /** Açış modu — açana kadar null, sonra el boyunca sabit. */
  openMode: OpenMode | null;
  /**
   * ÇİFT statüsü (el başına): çiftle açarak YA DA solundakinin attığını
   * açmadan alarak kazanılır. Çift oyuncu yalnız çiftle açabilir; masada
   * çift varken açma sınırı yükselir; bitiremezse 2 kat öder.
   */
  isCift: boolean;
  /** Açtığı tur (elden bitme tespiti için). */
  openedOnTurn: number | null;
  /** Açış anındaki SABİT değer — perlemeyle değişmez (rozet bunu gösterir). */
  openingValue?: number;   // seri açışı toplam puanı
  openingPairs?: number;   // çift açışı çift adedi
  totalScore: number;
  /** Maç boyunca kazanılan baraj jetonu sayısı (yüksek açış ödülü). */
  barajTokens: number;
}

/**
 * Ödeyen başına itemize ceza dökümü:
 * "elde 34p ×2 (okey) = 68" ya da "el kapalı 200 ×2 (çift) ×2 (okey) = 800".
 */
export interface PenaltyBreakdown {
  seat: number;
  /** 'hand' = açmıştı, elde kalan puanlar; 'closed' = el kapalı sabit taban. */
  baseKind: 'hand' | 'closed';
  base: number;
  multipliers: Array<{ label: string; factor: number }>;
  amount: number;
}

export interface HandResult {
  /** Eli bitiren koltuk; berabere (deste bitti) ise null. */
  winnerSeat: number | null;
  /** Elden bitme (hiç açmadan tek seferde bitirme) mi? */
  handFinish: boolean;
  /** Çiftten bitme mi (kazanan çift modunda açmıştı)? */
  pairFinish: boolean;
  /** Okey atma: son atılan kart joker miydi? */
  okeyFinish: boolean;
  /** Koltuk → bu elde yazılan ceza puanı. */
  penalties: number[];
  /** İtemize döküm (çarpan etiketleriyle). */
  breakdown: PenaltyBreakdown[];
}

/** Yazboz satırı: her puan hareketi AYRI kayıt (ceza / baraj / işlek). */
export interface SheetEntry {
  hand: number;
  seat: number;
  kind: 'penalty' | 'baraj' | 'islek';
  amount: number;
  /** Ceza için çarpan dökümü. */
  breakdown?: PenaltyBreakdown;
}

export interface GameState {
  rules: RuleConfig;
  seed: number;
  /** 1 tabanlı el numarası (El x/11). */
  handNumber: number;
  dealerSeat: number;
  currentSeat: number;
  phase: Phase;
  turnCount: number;
  players: PlayerState[];
  melds: Meld[];
  stock: Card[];
  /** Son eleman = açık yığının üstü. */
  discard: Card[];
  /** Aktif DENEME ALIMI (RULES.md 1.6) — yalnız alan oyuncu görür. */
  pickup: PickupState | null;
  /** Aktif SORGU (RULES.md 1.11) — cevap bekleyen kağıt sorma. */
  sorgu: SorguState | null;
  /** Açmış ÇİFTÇİNİN bu turki tek işlek hakkı kullanıldı mı (RULES.md 1.4). */
  ciftIslekUsed: boolean;
  /**
   * KATLAMALI çıtalar (RULES.md 1.8) — el içinde yapılan en yüksek açışlar;
   * yalnız katlamalı modda eşikleri yükseltir, el başında sıfırlanır.
   * Seri ve çift AYRI yarışlardır.
   */
  enYuksekSeriAcisi: number | null;
  enYuksekCiftAcisi: number | null;
  /** Son hamlelerin açık kaydı (en yeni sonda, sınırlı uzunluk). */
  log: PublicEvent[];
  /** Yazboz: maç boyu tüm puan hareketleri (toplamlar bundan türetilebilir). */
  sheet: SheetEntry[];
  lastHandResult: HandResult | null;
  /** Maç bitti mi, kazanan koltuk. */
  matchWinnerSeat: number | null;
  /**
   * Açış GERİ ALMA penceresi: açış commit edilmeden ÖNCEKİ state. Yalnız
   * açan oyuncunun aynı turunda (kart atılmadan) cancelOpen ile geri dönülür.
   * Kart atılınca (turn ilerleyince) anlamını yitirir.
   */
  openSnapshot?: GameState | null;
  /**
   * GÖSTERGE (kullanıcı kuralı): destenin en alt kartı, AÇIK gösterilir (1 tane, yalnız İLK EL).
   * Çift giden oyuncu, ilk el KART ÇEKMEDEN göstergenin eşini göstererek hak kazanır;
   * 4+ çifti varken elinden bir kart verip göstergeyi alır ve DİREKT ÇİFT olur.
   * Kart çeken / yerden alan koltuğun hakkı kilitlenir. İlk el bitince gösterge kapanır.
   */
  gostergeKart?: Card | null;
  /** Eşini gösterip hak kazanan koltuklar. */
  gostergeShown?: number[];
  /** Kart çekip/yerden alıp hakkı KİLİTLENEN koltuklar (artık gösteremez). */
  gostergeLocked?: number[];
  /** Gösterge bir oyuncu tarafından alındı mı (alınınca biter). */
  gostergeTaken?: boolean;
  /**
   * MAÇ LOGU (kullanıcı): tüm maç boyu (tüm eller) biriken olay mesajları (Türkçe, dinamik:
   * puan/çift/çarpan/ceza dahil). El geçişinde KORUNUR; yalnız yeni maç başında sıfırlanır.
   */
  matchLog?: string[];
  /**
   * (SUNUCU-yalnız, motor kuralını ETKİLEMEZ) Koltuk başına oyuncunun kart-id
   * DİZİLİM sırası. clientView el'i bu sıraya göre döndürür → çekilen kart SONA
   * gider, seri/çift diz gruplu sıra korunur. El başında temizlenir; her hamleden
   * sonra reconcile edilir (mevcut sıra + yeni kartlar sona). C# HandOrder portu.
   */
  handOrder?: Record<number, string[]>;
}

/**
 * DENEME ALIMI durumu (RULES.md 1.6): ıskartadan alınan kart taahhüt
 * edilene ya da geri bırakılana kadar "denemede"dir.
 */
export interface PickupState {
  cardId: CardId;
  /** Alan oyuncu alım ANINDA açık mıydı (açıksa kartı kullanmadan devam edemez). */
  wasOpened: boolean;
  /** İlk gerçek hamle yapıldı mı (sonrası GERİ BIRAK / SOR yok). */
  committed: boolean;
  /** Sorguda VER çıktı: kart ALINMAK ZORUNDA, geri bırakılamaz. */
  zorunlu: boolean;
  /** Bu alım için SOR hakkı kullanıldı mı (alım başına tek sorgu). */
  sorguUsed: boolean;
}

/** SORGU durumu (RULES.md 1.11). */
export interface SorguState {
  /** Kartı alıp soran (deneme modundaki) koltuk. */
  askerSeat: number;
  /** Kartı atan, cevap verecek koltuk. */
  sorulanSeat: number;
  cardId: CardId;
  /**
   * 'ortakGorus': (yalnız EŞLİ) sorulanın ortağı önce görüş bildirir;
   * 'cevap': sorulan Ver/Verme seçer (eşlide ortağın görüşünü görerek);
   * 'sonuc': VERME çıktı, asker Yine de Al / Geri Bırak seçer.
   */
  asama: 'ortakGorus' | 'cevap' | 'sonuc';
  /** Sorulanın ORTAĞI (eşli; ortakGorus aşamasında görüş verir). */
  partnerSeat?: number;
  /** Ortağın görüşü — sorulana gösterilir, BAĞLAYICI DEĞİL (sorulan özgür karar verir). */
  partnerGorus?: 'ver' | 'verme' | null;
}

export type Move =
  | { type: 'drawStock' }
  /** DENEME ALIMI (1.6): sol komşunun attığı kilitsiz kartı denemeye al. */
  | { type: 'pickupDiscard' }
  /** KİLİTLİ alım (1.4): çiftin attığı kartı al — ATOMİK, alan ÇİFT olur/kalır. */
  | { type: 'pickupLocked' }
  /** GERİ BIRAK (1.6): denemedeki kart ıskartanın üstüne aynen döner. */
  | { type: 'cancelPickup' }
  /** AÇIŞI GERİ AL: bu turda yapılan açışı (kart atılmadan) iptal eder, eli geri verir. */
  | { type: 'cancelOpen' }
  /** SOR (1.11): denemedeki kart için atana kağıt sor. */
  | { type: 'sor' }
  /** (Eşli) Ortağın görüşü — yalnız sorulanın ortağı oynar; sorulana iletilir, bağlayıcı değil. */
  | { type: 'sorguOrtakGorus'; gorus: 'ver' | 'verme' }
  /** Sorgu cevabı — yalnız sorulan koltuk oynayabilir. */
  | { type: 'sorguCevap'; cevap: 'ver' | 'verme' }
  /** VERME sonrası asker kararı: yine de al (ÇİFT olur) ya da geri bırak. */
  | { type: 'sorguSonuc'; al: boolean }
  /** İlk açış: perdeler toplamı openingMinPoints'i geçmeli. */
  | { type: 'open'; melds: CardId[][] }
  /** Çiftle açış: en az pairsToOpen geçerli çift. */
  | { type: 'openPairs'; pairs: CardId[][] }
  /** Açıldıktan sonra yeni perde indirme. */
  | { type: 'meld'; cards: CardId[] }
  /** Masadaki bir perdeye tek kart ekleme. */
  | { type: 'extend'; meldId: string; cardId: CardId }
  /** Jokeri temsil ettiği gerçek kartla değiştirip ele alma. */
  | { type: 'retrieveJoker'; meldId: string; cardId: CardId }
  | { type: 'discard'; cardId: CardId }
  /** GÖSTERGE GÖSTER: ilk el, kart çekmeden, göstergenin eşini (cardId) göstererek hak kazan. */
  | { type: 'gostergeGoster'; cardId: CardId }
  /** GÖSTERGE AL: 4+ çiftle, elden cardId ver → göstergeyi al, DİREKT ÇİFT ol. */
  | { type: 'gostergeAl'; cardId: CardId };

export type MoveType = Move['type'];

/** Herkese açık hamle kaydı (bot hafızası ve eylem bantları için). */
export interface PublicEvent {
  seat: number;
  /**
   * pickupCommit: deneme alımı TAAHHÜT edildi — alım ancak bu anda
   * kamuya açıklanır (deneme rakiplere asla görünmez, RULES.md 1.6).
   */
  type: MoveType | 'pickupCommit';
  /** Atılan ya da yerden alınan kart — zaten herkese açık bilgidir. */
  cardId?: CardId;
  /** Atılan kart işlekti ve ceza yazıldı. */
  islek?: boolean;
}

/** Bir oyuncunun görebildiği (sansürlenmiş) durum — sunucuya taşınmaya hazır. */
export interface PlayerView {
  seat: number;
  rules: RuleConfig;
  handNumber: number;
  phase: Phase;
  currentSeat: number;
  hand: Card[];
  hasOpened: boolean;
  openMode: OpenMode | null;
  isCift: boolean;
  /** Açmış çiftçinin bu turki tek işlek hakkı kullanıldı mı. */
  ciftIslekUsed: boolean;
  /** Şu anki etkin per açma sınırı (çift 101'i ve katlamalı çıtası dahil). */
  currentOpeningMin: number;
  /** Şu anki etkin çift açma adedi (katlamalıda son çift açışı +1 olabilir). */
  currentPairsMin: number;
  melds: Meld[];
  discardTop: Card | null;
  discardCount: number;
  stockCount: number;
  /** KENDİ deneme alımım (başkalarınınki ASLA görünmez — RULES.md 1.6). */
  pickup: PickupState | null;
  /** Aktif sorgu — yalnız taraflara (asker/sorulan) görünür. */
  sorgu: SorguState | null;
  /** Iskartanın üstü kilitli mi (atan kesin çift). */
  discardLocked: boolean;
  /** Üst kartı denemeye alabilir miyim (sol-komşu + kilit kuralları). */
  canPickupTop: boolean;
  /** Kilitli üst kartı (çift olarak/çift kalarak) atomik alabilir miyim. */
  canPickupLockedTop: boolean;
  /** ÇİFTÇİ ayrıcalığı: yerde duran atılmış kartlar (kim attığı YOK). */
  discardPileForCift: Card[] | null;
  /** Son hamlelerin açık kaydı (bot hafızası için). */
  recentEvents: PublicEvent[];
  /** MAÇ LOGU (tüm maç boyu olay mesajları, Türkçe + dinamik). Oyun olayları penceresi için. */
  matchLog?: string[];
  /** GÖSTERGE (açık) kartı — ilk el deste dibinde. null = gösterge yok/kapandı. */
  gostergeKart?: Card | null;
  /** Bu oyuncu göstergenin eşini gösterip hak kazandı mı. */
  gostergeShown?: boolean;
  /** Bu oyuncu ŞU AN göstergeyi GÖSTEREBİLİR mi (ilk el, çekmeden, elinde eşi var, kilitsiz). */
  gostergeCanShow?: boolean;
  /** Bu oyuncu ŞU AN göstergeyi ALABİLİR mi (hak kazandı + 4+ çift + çekme fazı). */
  gostergeCanTake?: boolean;
  players: Array<{
    seat: number;
    name: string;
    isBot: boolean;
    handCount: number;
    hasOpened: boolean;
    openMode: OpenMode | null;
    isCift: boolean;
    totalScore: number;
    barajTokens: number;
  }>;
}

export class MoveError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoveError';
  }
}
