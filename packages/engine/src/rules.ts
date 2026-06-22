/**
 * TÜM oyun kuralları burada yaşar. Bileşenlerde / UI'da asla kural sabiti
 * kullanılmaz; ev kuralları değişeceği için her parametre buradan okunur.
 * Masa başında HERKES aynı konfigürasyonla oynar (maç başında motora verilir).
 */

/**
 * BARAJ JETONLARI (ödül): yüksek puanla açmak baraj kazandırır; her baraj
 * oyuncunun toplamına anında `value` (negatif) puan işler.
 */
export interface BarajTokenConfig {
  enabled: boolean;
  /**
   * SERI_BARAJ_BASLANGIC (RULES.md 1.5): merdiven SINIRSIZDIR —
   * barajSayisi = floor((açılışPuanı - başlangıç) / adım) + 1 (puan ≥ başlangıç ise).
   * Açarın 81/101 olması merdiveni ETKİLEMEZ.
   */
  seriBarajBaslangic: number;
  /** Merdiven adımı (her +adım puanda +1 baraj). */
  seriBarajAdim: number;
  /** Çift açışında çift sayısı eşiğe ULAŞIRSA (+1 her eşik): [5,6,7]. */
  pairThresholds: number[];
  /** Baraj başına puan etkisi (negatif = kazanç). */
  value: number;
}

export interface PairsConfig {
  /** Çift (özdeş kart) oyunu aktif mi? */
  enabled: boolean;
  /** Çiftle açmak için gereken çift sayısı. */
  pairsToOpen: number;
  /** Bir çiftte en fazla kaç joker (joker eksik eşi tutar). */
  maxJokersPerPair: number;
}

/**
 * CEZA / PUANLAMA MODELİ — HİBRİT (RULES.md 1.7, tek formül):
 *   ceza = taban × (bitirenÇiftMi?×) × (okeyleBitişMi?×) × (yiyenÇiftMi?×)
 * Taban: ödeyen AÇMIŞSA elinde kalan kart puanı; AÇMAMIŞSA KAFA_CEZASI.
 * Örn: açık + elde 34p, okeyle bitiş → 34×2=68; kapalı çift, okey → 200×2×2=800.
 */
export interface ScoringConfig {
  /** KAFA_CEZASI: el kapalıyken ödenen sabit taban. */
  basePenalty: number;
  /** STOCK_OUT_PENALTY: deste bitti + taahhütlü el — taahhütsüzlerin tabanı.
   *  (Motora Paket 4 / C5 ile bağlanacak.) */
  stockOutPenalty: number;
  /** CARPAN_BITIREN_CIFT: bitiren çiftçiyse çarpan. */
  carpanBitirenCift: number;
  /** CARPAN_OKEY_BITIS: son atılan kart okeyse çarpan (role bakmaz). */
  carpanOkeyBitis: number;
  /** CARPAN_YIYEN_CIFT: ceza yiyen çiftçiyse çarpan. */
  carpanYiyenCift: number;
}

/** İŞLEK kart: masadaki bir peri işleyebilen (ya da joker kurtaran) el kartı. */
export interface IslekConfig {
  /** yardımlı: işlek kartlar elde kırmızı noktayla işaretlenir. */
  indicatorsEnabled: boolean;
  /** İşlek kart atana ceza yazılır mı? */
  penaltyEnabled: boolean;
  /** İşlek kart atma cezası (ayarlanacak; +50 yer tutucu). */
  penaltyPoints: number;
}

export interface RuleConfig {
  /** Oyuncu sayısı. */
  playerCount: number;
  /** Standart 52'lik deste sayısı. */
  deckCount: number;
  /** Toplam joker sayısı. */
  jokerCount: number;
  /** Normal el kart sayısı. */
  handSize: number;
  /** Dağıtıcıya fazladan verilen kart (15. kart) — dağıtıcı atarak başlar. */
  dealerExtraCards: number;

  /** Per açma alt sınırı (temel): tek turda en az bu kadar puan. */
  openingMinPoints: number;
  /**
   * DİNAMİK YÜKSELME: masada ÇİFT açan biri varsa, henüz açmamış herkes
   * için per açma sınırı bu değere çıkar (her tur canlı değerlendirilir).
   */
  openingMinPointsAfterPairOpen: number;

  /** Seri (RUN) için en az kart sayısı. */
  minRunLength: number;
  /** Küt (SET) için en az / en çok kart sayısı. */
  minSetSize: number;
  maxSetSize: number;

  // NOT (RULES.md 1.3): per başına yapay okey sınırı YOKTUR — okey herhangi
  // bir kartın yerine geçer; geçerlilik yalnız set/run tanımından gelir.

  /** As puanı — As YALNIZ üstten oynar (Q-K-A; A-2-3 yoktur) ve her zaman 11'dir. */
  acePoints: number;
  /** J / Q / K puanı. */
  facePoints: number;
  /** Elde kalan jokerin ceza puanı. */
  jokerHandPenalty: number;

  /** K-A-2 gibi başa dönen seriler (wrap-around) geçerli mi? */
  allowWraparound: boolean;

  /** katlamalı/katlamasız: ×2 çarpanları uygulanır mı?
   *  (Paket 6'da RULES.md 1.8 çıta sistemi olarak yeniden tanımlanacak.) */
  katlamali: boolean;

  /** Eli bitirene yazılan puan (0 ya da eksi bonus). */
  winnerHandPoints: number;

  /** Toplam el sayısı ("El x/11"). */
  totalHands: number;

  /** Baraj jetonları (yüksek açış ödülü). */
  barajTokens: BarajTokenConfig;

  /**
   * Çift oyunu: oyuncu per yerine pairsToOpen çiftle de açabilir.
   * Açış modu (per/çift) o el boyunca kilitlenir; çift açan yalnızca çift
   * indirir, per işleyemez.
   */
  pairs: PairsConfig;

  /** İşlek kart göstergesi ve cezası. */
  islek: IslekConfig;

  /** Ceza modeli (sabit birim / el sayma). */
  scoring: ScoringConfig;

  /**
   * EŞLİ mod yer tutucusu (2v2 çapraz eşler): oynanış HENÜZ değişmez;
   * yalnız yazboz sütunları takım bazında toplanır (teamOf = koltuk % 2).
   */
  teamMode: boolean;

  // RULES.md 1.7: deste bitince el biter (deste karılması YOKTUR; eleme YOKTUR).

  /** Tur süresi (saniye) — masa ayarı; TUR_SURELERI seçeneklerinden biri. */
  turnTimerSeconds: number;
  /** TUR_SURELERI: masa kurulumunda seçilebilir tur süreleri. */
  turSecenekleri: number[];
  /** EL_SAYILARI: masa kurulumunda seçilebilir el sayıları. */
  elSecenekleri: number[];
  /** OTOPILOT_ESIGI: bu kadar ARDIŞIK TUR zaman aşımı → bot devralır. */
  otopilotEsigi: number;

  /** Çok oyunculu sabitleri (motor davranışına faz 3'te bağlanır). */
  /** BOT_DEVRALMA_SN: kopan oyuncunun yerini botun alma süresi. */
  botDevralmaSn: number;
  /** DONUS_PENCERESI_SN: kopanın koltuğunu geri alabileceği pencere. */
  donusPenceresiSn: number;
  /** SORGU_SURESI: sorgu kararı başına ayrı sayaç (tur sayacı durur). */
  sorguSuresi: number;
  /** SORGU_VARSAYILAN: cevapsızlıkta uygulanan karar. */
  sorguVarsayilan: 'VER' | 'VERME';

  /** Ekonomi sabitleri — YALNIZ ANAHTAR (faz 4'te motora/servise bağlanır). */
  ekonomi: {
    /** KOMISYON_ORANI: kasadan silinen pay. */
    komisyonOrani: number;
    /** CANAK_PAYI: komisyondan çanağa akan pay (kalibre edilecek). */
    canakPayi: number | null;
    /** SALON_SARTI: salon erişimi için tamamlanmış oyun şartı (kalibre). */
    salonSarti: number | null;
    /** BASLANGIC_CIPI: yeni oyuncu çipi (kalibre). */
    baslangicCipi: number | null;
  };
}

export const DEFAULT_RULES: RuleConfig = {
  playerCount: 4,
  deckCount: 2,
  // RULES.md 1.1: 2×52 + 2 okey = 106 kart.
  jokerCount: 2,
  handSize: 14,
  dealerExtraCards: 1,

  openingMinPoints: 81,
  openingMinPointsAfterPairOpen: 101,

  minRunLength: 3,
  minSetSize: 3,
  maxSetSize: 4,

  acePoints: 11,
  facePoints: 10,
  // RULES.md 1.7 OKEY_EL_PUANI: elde kalan okey 50 sayılır (çarpanlara tabi).
  jokerHandPenalty: 50,

  allowWraparound: false,

  katlamali: true,
  winnerHandPoints: 0,

  totalHands: 11,

  barajTokens: {
    enabled: true,
    seriBarajBaslangic: 111,
    seriBarajAdim: 10,
    pairThresholds: [5, 6, 7],
    value: -100,
  },

  pairs: {
    enabled: true,
    pairsToOpen: 5,
    maxJokersPerPair: 1,
  },

  islek: {
    indicatorsEnabled: true,
    penaltyEnabled: true,
    penaltyPoints: 50,
  },

  scoring: {
    basePenalty: 200,
    stockOutPenalty: 200,
    carpanBitirenCift: 2,
    carpanOkeyBitis: 2,
    carpanYiyenCift: 2,
  },

  teamMode: false,

  // RULES.md 1.9: 60 sn KALDIRILDI; seçenekler 25/20/15, şimdilik varsayılan 20.
  turnTimerSeconds: 20,
  turSecenekleri: [25, 20, 15],
  elSecenekleri: [3, 5, 7, 9, 11],
  otopilotEsigi: 3,

  botDevralmaSn: 10,
  donusPenceresiSn: 180,
  sorguSuresi: 15,
  sorguVarsayilan: 'VER',

  ekonomi: {
    komisyonOrani: 0.1,
    canakPayi: null,
    salonSarti: null,
    baslangicCipi: null,
  },
};

/** Kuralları kısmen ezerek yeni bir konfigürasyon üretir. */
export function makeRules(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    ...DEFAULT_RULES,
    ...overrides,
    barajTokens: { ...DEFAULT_RULES.barajTokens, ...(overrides.barajTokens ?? {}) },
    pairs: { ...DEFAULT_RULES.pairs, ...(overrides.pairs ?? {}) },
    islek: { ...DEFAULT_RULES.islek, ...(overrides.islek ?? {}) },
    scoring: { ...DEFAULT_RULES.scoring, ...(overrides.scoring ?? {}) },
    ekonomi: { ...DEFAULT_RULES.ekonomi, ...(overrides.ekonomi ?? {}) },
  };
}
